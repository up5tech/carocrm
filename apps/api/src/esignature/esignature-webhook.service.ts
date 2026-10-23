import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ESignatureCredentialVault } from './esignature-credential-vault.js';
import { ESIGNATURE_ARTIFACT_JOB,ESIGNATURE_WEBHOOK_PROCESS_JOB } from './esignature-jobs.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { mapProviderEvent, normalizeProviderEventType } from './esignature-status-mapper.js';
import type { ProviderWebhookNotification } from './providers/signature-provider.port.js';
import { SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import { rawBodyHash } from './providers/signature-provider-signature.js';
import { SignatureAuditRepository } from './signature-audit.repository.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';
import { SignatureProviderEventRepository } from './signature-provider-event.repository.js';
import { SignatureRecipientRepository } from './signature-recipient.repository.js';
import { SignatureRequestRepository } from './signature-request.repository.js';
import { SignatureWebhookInboxRepository } from './signature-webhook-inbox.repository.js';

/**
 * Phase 19-ES.11 — DocuSign Connect intake and processing
 * (`PLAN_Phase_19_ESignature.md` §8.3, §10, §12.1, §16, §18 `19-ES.11`).
 *
 * The HTTP handler does three things and nothing more: verify the delivery, persist it durably, and
 * acknowledge. Everything that could change a contract's state happens in `processDelivery`, from a
 * job, under the module's system authority — so a slow or failing projection can never make the
 * provider hold a connection open, and an unverified payload can never reach a transition.
 *
 * The order inside `ingest` is the security posture:
 *
 *  1. The module's `webhooks` feature must be effective; a closed module has no live endpoint.
 *  2. The public id resolves a connection. An unknown endpoint records nothing, so an attacker cannot
 *     fill the inbox by guessing paths.
 *  3. The adapter verifies the account HMAC over the exact bytes **before** a field is parsed. A
 *     verified-but-misrouted account is refused as `account_mismatch`.
 *  4. The delivery is written to `signature_webhook_inbox` with its verification result. The unique
 *     dedup key makes a redelivery a no-op.
 *  5. Only then is a job enqueued. If the queue is down the delivery is still durable; the operator
 *     queue can process it, and the provider still receives a success acknowledgement.
 *
 * `processDelivery` treats the inbox row as the unit of work. It appends one normalized event, applies
 * the event through the pure ES.12 mapper, and marks both the event and the delivery. A failure is
 * retryable with a bounded attempt count, then dead-lettered with a safe reason — never silenced.
 */

export const MAX_PROCESSING_ATTEMPTS = 5;

export interface WebhookIngestInput {
  readonly publicId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  readonly rawBody: Uint8Array;
}

export interface WebhookIngestResult {
  readonly status: 'accepted' | 'duplicate' | 'rejected' | 'refused';
  readonly httpStatus: 202 | 401 | 404 | 413;
  readonly inboxId: string | null;
  readonly reason: string | null;
}

export interface WebhookProcessResult {
  readonly status: 'processed' | 'ignored' | 'duplicate' | 'retryable' | 'dead_letter' | 'already_processed';
  readonly outcome: string;
  readonly requestId: string | null;
}

@Injectable()
export class ESignatureWebhookService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignatureCredentialVault) private readonly vault: ESignatureCredentialVault,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
    @Inject(SignatureWebhookInboxRepository) private readonly inbox: SignatureWebhookInboxRepository,
    @Inject(SignatureProviderEventRepository) private readonly events: SignatureProviderEventRepository,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
    @Inject(SignatureRecipientRepository) private readonly recipients: SignatureRecipientRepository,
    @Inject(SignatureAuditRepository) private readonly audit: SignatureAuditRepository,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Verify, persist and acknowledge. Never applies anything. */
  async ingest(input: WebhookIngestInput): Promise<WebhookIngestResult> {
    const settingsView = await this.settings.read();
    if (settingsView.settings.enabled !== true || settingsView.effective.webhooks !== true) {
      return { status: 'refused', httpStatus: 404, inboxId: null, reason: 'webhooks_disabled', };
    }

    const connection = await this.connections.findByPublicId(input.publicId);
    if (connection === undefined) {
      return { status: 'refused', httpStatus: 404, inboxId: null, reason: 'unknown_endpoint' };
    }

    const adapter = this.providers.resolve(connection.providerKey);
    if (adapter?.verifyAndParseWebhook === undefined) {
      return { status: 'refused', httpStatus: 404, inboxId: null, reason: 'provider_unsupported' };
    }

    let signingSecret: string | null = null;
    try {
      signingSecret = await this.vault.read({ connectionId: connection.id, kind: 'webhook_secret' });
    } catch {
      // An unreadable vault is the same operational answer as no secret: the delivery cannot be
      // verified, and the inbox will say so. It must not make the endpoint throw.
      signingSecret = null;
    }

    const notification = await adapter.verifyAndParseWebhook({
      providerKey: connection.providerKey,
      connectionId: connection.id,
      expectedAccountId: connection.accountId,
      rawBody: input.rawBody,
      headers: input.headers,
      contentType: input.contentType,
      signingSecret,
      requireSignature: settingsView.settings.webhooks.requireHmac,
      maxPayloadBytes: settingsView.settings.webhooks.maxPayloadBytes,
    });

    const payloadHash = rawBodyHash(input.rawBody);
    const dedupKey = this.dedupKey(connection.id, connection.providerKey, notification, payloadHash);
    const purgeAfter =
      settingsView.settings.retention.webhookPayloadDays > 0
        ? new Date(Date.now() + settingsView.settings.retention.webhookPayloadDays * 86_400_000)
        : null;

    const accepted = await this.inbox.accept({
      providerKey: connection.providerKey,
      dedupKey,
      payloadHash,
      contentLength: input.rawBody.byteLength,
      signatureStatus: notification.verified ? (settingsView.settings.webhooks.requireHmac ? 'verified' : 'not_required') : 'invalid',
      payloadMinimized: notification.verified
        ? {
            ...notification.minimized,
            providerEventId: notification.providerEventId,
            occurredAt: notification.occurredAt,
          }
        : {},
      connectionId: connection.id,
      routingPublicId: input.publicId,
      providerAccountId: notification.providerAccountId ?? connection.accountId,
      providerEnvelopeId: notification.providerEnvelopeId,
      contentType: input.contentType,
      correlationId: this.scope.requestId === 'unknown' ? null : this.scope.requestId,
      purgeAfter,
    });

    await this.connections.recordWebhookReceived(connection.id).catch(() => undefined);

    if (!notification.verified) {
      if (accepted.created) {
        await this.inbox.markState(accepted.delivery.id, 'ignored', {
          from: ['received'],
          errorSafe: notification.refusalReason ?? 'invalid_signature',
        });
        await this.audit.append({
          action: 'provider.event_rejected',
          connectionId: connection.id,
          actor: { type: 'system' },
          outcome: 'refused',
          reasonSafe: notification.refusalReason ?? 'invalid_signature',
          correlationId: accepted.delivery.correlationId,
        });
      }
      const status = notification.refusalReason === 'too_large' ? 413 : 401;
      return { status: 'rejected', httpStatus: status, inboxId: accepted.delivery.id, reason: notification.refusalReason };
    }

    if (!accepted.created) {
      return { status: 'duplicate', httpStatus: 202, inboxId: accepted.delivery.id, reason: 'duplicate_delivery' };
    }

    await this.enqueue(ESIGNATURE_WEBHOOK_PROCESS_JOB, { inboxId: accepted.delivery.id });
    return { status: 'accepted', httpStatus: 202, inboxId: accepted.delivery.id, reason: null };
  }

  /**
   * Apply one durably accepted delivery.
   *
   * Idempotent: an inbox row already past `received`/`retryable` is answered, not reprocessed. Every
   * write for one delivery runs in one transaction, so a projection cannot apply while the event row
   * it belongs to is rolled back.
   */
  async processDelivery(inboxId: string): Promise<WebhookProcessResult> {
    const delivery = await this.inbox.findById(inboxId);
    if (delivery === undefined) throw new ValidationError(`No webhook delivery "${inboxId}".`, { inboxId });
    if (delivery.state !== 'received' && delivery.state !== 'retryable') {
      return { status: 'already_processed', outcome: delivery.state, requestId: null };
    }
    if (delivery.signatureStatus === 'invalid') {
      await this.inbox.markState(delivery.id, 'ignored', { from: ['received', 'retryable'], errorSafe: 'unverified' });
      return { status: 'ignored', outcome: 'unverified', requestId: null };
    }

    const connection = delivery.connectionId === null ? undefined : await this.connections.findById(delivery.connectionId);
    if (connection === undefined || delivery.providerEnvelopeId === null) {
      await this.inbox.markState(delivery.id, 'ignored', { from: ['received', 'retryable'], errorSafe: 'unknown_envelope' });
      return { status: 'ignored', outcome: 'unknown_envelope', requestId: null };
    }

    const request = await this.requests.findByEnvelope(connection.id, delivery.providerEnvelopeId);
    if (request === undefined) {
      // The envelope is preserved as evidence with no request binding: an unknown envelope is an
      // operator question, not a delivery to drop (plan §10.4).
      const appended = await this.events.append({
        connectionId: connection.id,
        requestId: null,
        providerKey: delivery.providerKey,
        providerAccountId: delivery.providerAccountId,
        providerEnvelopeId: delivery.providerEnvelopeId,
        providerEventId: providerEventIdOf(delivery.payloadMinimized),
        eventTypeNormalized: normalizeFromInbox(delivery.payloadMinimized),
        providerEventTypeRaw: rawEventTypeOf(delivery.payloadMinimized),
        recipientProviderId: String(delivery.payloadMinimized['recipientId'] ?? '') || null,
        providerOccurredAt: dateOf(delivery.payloadMinimized['occurredAt']),
        eventData: delivery.payloadMinimized,
        signatureVerificationStatus: delivery.signatureStatus,
        correlationId: delivery.correlationId,
        purgeAfter: delivery.purgeAfter === null ? null : new Date(delivery.purgeAfter),
      });
      if (appended.created) await this.events.markProcessed(appended.event.id, 'ignored', 'unknown_envelope');
      await this.inbox.markState(delivery.id, 'ignored', { from: ['received', 'retryable'], errorSafe: 'unknown_envelope' });
      return { status: 'ignored', outcome: 'unknown_envelope', requestId: null };
    }

    try {
      const result = await runInTransaction(this.database.db, async () => {
        const eventTypeNormalized = delivery.payloadMinimized['eventType'] === undefined
          ? 'unmapped'
          : normalizeFromInbox(delivery.payloadMinimized);
        const occurredAt = dateOf(delivery.payloadMinimized['occurredAt']);
        const recipientProviderId = stringOfInbox(delivery.payloadMinimized['recipientId']);
        const recipientStatusRaw = stringOfInbox(delivery.payloadMinimized['recipientStatus']);

        const appended = await this.events.append({
          connectionId: connection.id,
          requestId: request.id,
          providerKey: delivery.providerKey,
          providerAccountId: delivery.providerAccountId,
          providerEnvelopeId: delivery.providerEnvelopeId,
          providerEventId: providerEventIdOf(delivery.payloadMinimized),
          eventTypeNormalized,
          providerEventTypeRaw: rawEventTypeOf(delivery.payloadMinimized),
          recipientProviderId,
          providerOccurredAt: occurredAt,
          eventData: delivery.payloadMinimized,
          signatureVerificationStatus: delivery.signatureStatus,
          correlationId: delivery.correlationId,
          purgeAfter: delivery.purgeAfter === null ? null : new Date(delivery.purgeAfter),
        });
        if (!appended.created) {
          await this.inbox.markState(delivery.id, 'duplicate', { from: ['received', 'retryable'], errorSafe: 'duplicate_event' });
          return { status: 'duplicate' as const, outcome: 'duplicate_event', requestId: request.id, completed: false };
        }

        const current = await this.requests.requireById(request.id);
        const recipientRows = await this.recipients.listForRequest(request.id);
        const mapping = mapProviderEvent({
          current: current.status,
          eventTypeNormalized,
          recipientStatusRaw,
          recipientProviderId,
          recipients: recipientRows.map((row) => ({
            id: row.id,
            providerRecipientId: row.providerRecipientId,
            recipientType: row.recipientType,
            status: row.status,
          })),
        });

        let recipientChanged = false;
        if (mapping.recipient !== null) {
          const applied = await this.recipients.applyStatus(mapping.recipient.recipientId, {
            status: mapping.recipient.status,
            providerStatusRaw: recipientStatusRaw,
            eventId: appended.event.id,
            ...(occurredAt === null ? {} : { occurredAt }),
          });
          recipientChanged = applied.changed;
        }

        let moved = current;
        for (const target of mapping.envelopeChain) {
          moved = await this.requests.transition(request.id, {
            expectedVersion: moved.version,
            to: target,
            origin: 'provider',
            providerStatusRaw: rawEventTypeOf(delivery.payloadMinimized),
            ...(occurredAt === null ? {} : { occurredAt }),
          });
        }
        const envelopeMoved = mapping.envelopeChain.length > 0;

        const processingStatus =
          mapping.outcome === 'unmapped'
            ? 'unmapped'
            : envelopeMoved || recipientChanged
              ? 'applied'
              : 'ignored';
        await this.events.markProcessed(appended.event.id, processingStatus);
        await this.inbox.markState(delivery.id, processingStatus === 'applied' ? 'processed' : 'ignored', {
          from: ['received', 'retryable'],
        });
        await this.audit.append({
          action: 'provider.event_accepted',
          requestId: request.id,
          connectionId: connection.id,
          actor: { type: 'system' },
          outcome: processingStatus === 'unmapped' || processingStatus === 'ignored' ? 'refused' : 'ok',
          reasonSafe: processingStatus === 'applied' ? null : mapping.outcome,
          detail: {
            eventType: eventTypeNormalized,
            outcome: mapping.outcome,
            status: moved.status,
          },
          correlationId: delivery.correlationId,
        });

        return {
          status: (processingStatus === 'applied' ? 'processed' : 'ignored') as 'processed' | 'ignored',
          outcome: mapping.outcome,
          requestId: request.id,
          completed: moved.status === 'completed',
        };
      });

      if (result.completed === true) {
        const settingsView = await this.settings.read();
        if (settingsView.effective.artifacts === true) {
          await this.enqueue(ESIGNATURE_ARTIFACT_JOB, { requestId: request.id });
        }
      }
      return { status: result.status, outcome: result.outcome, requestId: result.requestId };
    } catch (error) {
      return this.recordFailure(delivery.id, request.id, delivery.attemptCount + 1, error);
    }
  }

  /** The operator queue's retry: re-run a delivery that failed transiently. */
  async processPending(limit = 25): Promise<{ processed: number; retryable: number; deadLetter: number }> {
    const rows = await this.database.db
      .selectFrom('signature_webhook_inbox')
      .select('id')
      .where('state', 'in', ['received', 'retryable'])
      .where('signature_status', 'in', ['verified', 'not_required'])
      .orderBy('received_at', 'asc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    let processed = 0;
    let retryable = 0;
    let deadLetter = 0;
    for (const row of rows) {
      const result = await this.processDelivery(row.id);
      if (result.status === 'processed' || result.status === 'ignored' || result.status === 'duplicate') processed += 1;
      else if (result.status === 'dead_letter') deadLetter += 1;
      else retryable += 1;
    }
    return { processed, retryable, deadLetter };
  }

  private async recordFailure(inboxId: string, requestId: string, attempt: number, error: unknown): Promise<WebhookProcessResult> {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Webhook processing failed.';
    const deadLetter = attempt >= MAX_PROCESSING_ATTEMPTS;
    await this.inbox.markState(inboxId, deadLetter ? 'dead_letter' : 'retryable', {
      errorSafe: message,
      from: ['received', 'retryable'],
    });
    await this.audit.append({
      action: 'provider.event_rejected',
      requestId,
      actor: { type: 'system' },
      outcome: 'refused',
      reasonSafe: deadLetter ? 'dead_letter' : 'retryable_failure',
      detail: { attempt },
    });
    return { status: deadLetter ? 'dead_letter' : 'retryable', outcome: 'failed', requestId };
  }

  private dedupKey(connectionId: string, providerKey: string, notification: ProviderWebhookNotification, payloadHash: string): string {
    if (notification.providerEventId !== null && notification.providerEventId.trim() !== '') {
      return `${providerKey}:${connectionId}:event:${notification.providerEventId.trim().slice(0, 180)}`;
    }
    return [
      providerKey,
      connectionId,
      notification.providerEnvelopeId?.trim() || 'no-envelope',
      notification.eventTypeRaw?.trim() || 'no-type',
      payloadHash,
    ].join(':');
  }

  private async enqueue(job: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.jobs.enqueue({ job, data });
    } catch {
      // The inbox is the durable record. A queue outage leaves the delivery for the operator sweep and
      // must not turn a durably accepted delivery into an HTTP failure (plan §10.1.6).
    }
  }
}

function normalizeFromInbox(payload: Record<string, unknown>): string {
  return normalizeProviderEventType(rawEventTypeOf(payload));
}

function rawEventTypeOf(payload: Record<string, unknown>): string | null {
  return stringOfInbox(payload['eventType']);
}

function providerEventIdOf(payload: Record<string, unknown>): string | null {
  return stringOfInbox(payload['providerEventId']);
}

function stringOfInbox(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
