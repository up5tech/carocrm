import { createHash, randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { canonicalJson } from './esignature-snapshot.js';

/**
 * Phase 19-ES.2 — the normalized provider event history
 * (`PLAN_Phase_19_ESignature.md` §6.5, §10.1, §10.3).
 *
 * Append-only, and it is the answer to "what did the provider actually tell us, in what order". Two
 * properties make the later phases safe:
 *
 * - **One row per event, structurally.** `dedup_key` is unique in the database, so a replayed
 *   delivery — the normal case when a provider retries after a slow acknowledgement — cannot create a
 *   second transition, artifact or notification. The caller learns `created: false` and the existing
 *   row, rather than guessing whether it had already been seen.
 * - **History is never the projection.** `processing_status` says what this platform did with the
 *   event; the event's own content is immutable. An event that cannot be applied is kept and
 *   dead-lettered with a safe reason, because the operator has to see what arrived (plan §10.3).
 *
 * `append` only ever writes the event's own columns, and `markProcessed` only the processing
 * bookkeeping. Nothing in this file can change what an event said.
 */

export const EVENT_PROCESSING_STATUSES = ['pending', 'applied', 'ignored', 'duplicate', 'unmapped', 'failed', 'dead_letter'] as const;
export type ESignatureEventProcessingStatus = (typeof EVENT_PROCESSING_STATUSES)[number];

export const VERIFICATION_STATUSES = ['verified', 'invalid', 'not_required'] as const;
export type ESignatureVerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface SignatureProviderEvent {
  readonly id: string;
  readonly connectionId: string | null;
  readonly requestId: string | null;
  readonly providerKey: string;
  readonly providerAccountId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly dedupKey: string;
  readonly providerEventId: string | null;
  readonly eventTypeNormalized: string;
  readonly providerEventTypeRaw: string | null;
  readonly recipientProviderId: string | null;
  readonly providerOccurredAt: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly payloadHash: string;
  readonly eventData: Readonly<Record<string, unknown>>;
  readonly signatureVerificationStatus: ESignatureVerificationStatus;
  readonly processingStatus: ESignatureEventProcessingStatus;
  readonly attemptCount: number;
  readonly lastProcessingErrorSafe: string | null;
  readonly correlationId: string | null;
  readonly purgeAfter: string | null;
  readonly createdAt: string;
}

export interface AppendEventInput {
  connectionId?: string | null;
  requestId?: string | null;
  providerKey: string;
  providerAccountId?: string | null;
  providerEnvelopeId?: string | null;
  providerEventId?: string | null;
  /** The normalized name, or `unmapped`. An unknown event is preserved, never treated as success. */
  eventTypeNormalized: string;
  providerEventTypeRaw?: string | null;
  recipientProviderId?: string | null;
  providerOccurredAt?: Date | null;
  /** The minimized event, not the raw body (plan §12.1). */
  eventData: Record<string, unknown>;
  signatureVerificationStatus: ESignatureVerificationStatus;
  correlationId?: string | null;
  purgeAfter?: Date | null;
  receivedAt?: Date;
}

@Injectable()
export class SignatureProviderEventRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * Append an event, or return the row that already carries its dedup key.
   *
   * The insert is `on conflict do nothing` followed by a read: one round trip decides whether this
   * delivery is new, and a concurrent duplicate of the same event loses cleanly instead of writing
   * twice (plan §10.3).
   */
  async append(input: AppendEventInput): Promise<{ event: SignatureProviderEvent; created: boolean }> {
    const payloadHash = payloadDigest(input.eventData);
    const accountScope = (input.providerAccountId ?? input.connectionId ?? '').trim();
    const dedupKey = input.providerEventId !== undefined && input.providerEventId !== null && input.providerEventId.trim() !== ''
      ? buildEventDedupKey(input.providerKey, `${accountScope}|${input.providerEventId}`)
      : buildEventDedupKey(input.providerKey, `${accountScope}|${input.providerEnvelopeId ?? ''}|${input.eventTypeNormalized}|${payloadHash}`);
    const receivedAt = input.receivedAt ?? new Date();
    const id = randomUUID();

    await this.db
      .insertInto('signature_provider_events')
      .values({
        id,
        connection_id: input.connectionId ?? null,
        request_id: input.requestId ?? null,
        provider_key: input.providerKey,
        provider_account_id: input.providerAccountId ?? null,
        provider_envelope_id: input.providerEnvelopeId ?? null,
        dedup_key: dedupKey,
        provider_event_id: input.providerEventId ?? null,
        event_type_normalized: input.eventTypeNormalized,
        provider_event_type_raw: input.providerEventTypeRaw ?? null,
        recipient_provider_id: input.recipientProviderId ?? null,
        provider_occurred_at: input.providerOccurredAt ?? null,
        received_at: receivedAt,
        payload_hash: payloadHash,
        event_data: JSON.stringify(input.eventData),
        signature_verification_status: input.signatureVerificationStatus,
        processing_status: 'pending',
        attempt_count: 0,
        correlation_id: input.correlationId ?? null,
        purge_after: input.purgeAfter ?? null,
        created_at: receivedAt,
      })
      .onConflict((oc) => oc.column('dedup_key').doNothing())
      .execute();

    const existing = await this.findByDedupKey(dedupKey);
    if (existing === undefined) throw new ValidationError('The provider event could not be recorded.', { dedupKey });
    return { event: existing, created: existing.id === id };
  }

  async findByDedupKey(dedupKey: string): Promise<SignatureProviderEvent | undefined> {
    const row = await this.db.selectFrom('signature_provider_events').selectAll().where('dedup_key', '=', dedupKey).executeTakeFirst();
    return row === undefined ? undefined : toEvent(row);
  }

  async findById(id: string): Promise<SignatureProviderEvent | undefined> {
    const row = await this.db.selectFrom('signature_provider_events').selectAll().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toEvent(row);
  }

  /** The event timeline for the detail view (plan §13.4). */
  async listForRequest(requestId: string, options: { limit?: number } = {}): Promise<SignatureProviderEvent[]> {
    const rows = await this.db
      .selectFrom('signature_provider_events')
      .selectAll()
      .where('request_id', '=', requestId)
      .orderBy('provider_occurred_at', 'desc')
      .orderBy('received_at', 'desc')
      .limit(clamp(options.limit, 300))
      .execute();
    return rows.map((row) => toEvent(row));
  }

  /**
   * Bind an event to the request it belongs to.
   *
   * An event whose envelope the CRM has never seen stays unlinked: it is still evidence, and the
   * operator's "unknown envelope" queue is what surfaces it (plan §17.1).
   */
  async linkRequest(id: string, requestId: string): Promise<void> {
    await this.db
      .updateTable('signature_provider_events')
      .set({ request_id: requestId })
      .where('id', '=', id)
      .where('request_id', 'is', null)
      .execute();
  }

  /** The processing bookkeeping — never the event's content. */
  async markProcessed(id: string, status: ESignatureEventProcessingStatus, errorSafe?: string | null): Promise<void> {
    if (!(EVENT_PROCESSING_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError('Unknown provider event processing status.', { status });
    }
    await this.db
      .updateTable('signature_provider_events')
      .set({
        processing_status: status,
        processed_at: new Date(),
        attempt_count: sql<number>`attempt_count + 1`,
        last_processing_error_safe: errorSafe?.slice(0, 500) ?? null,
      })
      .where('id', '=', id)
      .execute();
  }

  async findUnprocessed(limit = 50): Promise<SignatureProviderEvent[]> {
    const rows = await this.db
      .selectFrom('signature_provider_events')
      .selectAll()
      .where('processing_status', 'in', ['pending', 'failed'])
      .orderBy('received_at', 'asc')
      .limit(clamp(limit, 200))
      .execute();
    return rows.map((row) => toEvent(row));
  }
}

/**
 * The deterministic dedup key.
 *
 * Where DocuSign supplies an event id, that is the key. Where it does not, the key is built from the
 * verified fields plus the payload hash — which is what plan §10.1.5 asks for, and why the hash alone
 * is never treated as semantic identity: two genuinely distinct events with an identical body would
 * collapse into one row, so the envelope and the type are part of the key.
 *
 * The caller also scopes the key by provider account (or connection), because an envelope id is unique
 * within an account rather than globally: the same id under two connections is two events.
 */
export function buildEventDedupKey(providerKey: string, discriminator: string): string {
  const trimmed = discriminator.trim();
  if (trimmed === '') throw new ValidationError('A provider event needs a deduplication key source.');
  return `${providerKey}:${trimmed.slice(0, 240)}`;
}

/** SHA-256 over the canonical form of the stored payload. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function toEvent(row: {
  id: string;
  connection_id: string | null;
  request_id: string | null;
  provider_key: string;
  provider_account_id: string | null;
  provider_envelope_id: string | null;
  dedup_key: string;
  provider_event_id: string | null;
  event_type_normalized: string;
  provider_event_type_raw: string | null;
  recipient_provider_id: string | null;
  provider_occurred_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
  payload_hash: string;
  event_data: unknown;
  signature_verification_status: string;
  processing_status: string;
  attempt_count: number;
  last_processing_error_safe: string | null;
  correlation_id: string | null;
  purge_after: Date | null;
  created_at: Date;
}): SignatureProviderEvent {
  return {
    id: row.id,
    connectionId: row.connection_id,
    requestId: row.request_id,
    providerKey: row.provider_key,
    providerAccountId: row.provider_account_id,
    providerEnvelopeId: row.provider_envelope_id,
    dedupKey: row.dedup_key,
    providerEventId: row.provider_event_id,
    eventTypeNormalized: row.event_type_normalized,
    providerEventTypeRaw: row.provider_event_type_raw,
    recipientProviderId: row.recipient_provider_id,
    providerOccurredAt: iso(row.provider_occurred_at),
    receivedAt: row.received_at.toISOString(),
    processedAt: iso(row.processed_at),
    payloadHash: row.payload_hash,
    eventData: row.event_data !== null && typeof row.event_data === 'object' && !Array.isArray(row.event_data) ? (row.event_data as Record<string, unknown>) : {},
    signatureVerificationStatus: row.signature_verification_status as ESignatureVerificationStatus,
    processingStatus: row.processing_status as ESignatureEventProcessingStatus,
    attemptCount: row.attempt_count,
    lastProcessingErrorSafe: row.last_processing_error_safe,
    correlationId: row.correlation_id,
    purgeAfter: iso(row.purge_after),
    createdAt: row.created_at.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function clamp(value: number | undefined, max: number): number {
  const limit = Math.trunc(value ?? 50);
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(limit, max);
}
