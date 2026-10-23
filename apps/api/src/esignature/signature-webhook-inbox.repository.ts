import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { canonicalJson } from './esignature-snapshot.js';

/**
 * Phase 19-ES.2 — the webhook inbox: the durable receipt, before anything is decided
 * (`PLAN_Phase_19_ESignature.md` §10.1, §8.3, §10.3).
 *
 * The intake rule is that the HTTP handler does almost nothing: verify, persist, acknowledge. This
 * table is where "persist" lands, and its shape encodes the rest of §10.1 —
 *
 * - **`dedup_key` is unique.** A redelivered POST becomes `created: false` on the existing row, so a
 *   duplicate delivery can never become a second state transition, artifact or notification.
 * - **The verification result is recorded with the delivery.** Whether the signature verified is a
 *   fact about the receipt, captured before any payload field was trusted (plan §10.2). An invalid
 *   delivery is still stored — as evidence of an attempt — and it changes nothing.
 * - **Only a minimized body is kept.** Not the raw bytes: the raw body exists only long enough to
 *   verify the signature over it, and what is stored is the small set of fields the projection needs,
 *   plus a hash of the whole. `purge_after` is the deadline the retention setting stamps; the dedup
 *   key and the verification result stay (plan §12.1).
 *
 * Like the event history, this table is append-only to application code: `accept` and `markState` are
 * the only verbs, and `markState` touches only processing columns.
 */

export const INBOX_STATES = ['received', 'processing', 'processed', 'ignored', 'duplicate', 'retryable', 'dead_letter'] as const;
export type ESignatureInboxState = (typeof INBOX_STATES)[number];

export interface SignatureWebhookDelivery {
  readonly id: string;
  readonly connectionId: string | null;
  readonly routingPublicId: string | null;
  readonly providerKey: string;
  readonly providerAccountId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly dedupKey: string;
  readonly payloadHash: string;
  readonly contentLength: number;
  readonly signatureStatus: 'verified' | 'invalid' | 'not_required';
  readonly contentType: string | null;
  readonly payloadMinimized: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
  readonly state: ESignatureInboxState;
  readonly processedAt: string | null;
  readonly attemptCount: number;
  readonly lastErrorSafe: string | null;
  readonly correlationId: string | null;
  readonly purgeAfter: string | null;
}

export interface AcceptDeliveryInput {
  providerKey: string;
  dedupKey: string;
  payloadHash: string;
  contentLength: number;
  signatureStatus: 'verified' | 'invalid' | 'not_required';
  payloadMinimized: Record<string, unknown>;
  connectionId?: string | null;
  routingPublicId?: string | null;
  providerAccountId?: string | null;
  providerEnvelopeId?: string | null;
  contentType?: string | null;
  correlationId?: string | null;
  purgeAfter?: Date | null;
  receivedAt?: Date;
}

export interface WebhookInboxDiagnostics {
  readonly total: number;
  readonly countsByState: Record<ESignatureInboxState, number>;
  readonly signatureStatus: { readonly verified: number; readonly invalid: number; readonly notRequired: number };
  readonly lastReceivedAt: string | null;
  readonly oldestPendingAt: string | null;
  readonly oldestPendingState: 'received' | 'retryable' | null;
}

@Injectable()
export class SignatureWebhookInboxRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * Durable acceptance of one delivery.
   *
   * Returns the stored row and whether this call created it. A `created: false` answer is how the
   * caller knows it is a redelivery and must not enqueue the same work again — the ack still returns
   * success, because the delivery *is* durably accepted, by whoever got here first (plan §10.1.6).
   */
  async accept(input: AcceptDeliveryInput): Promise<{ delivery: SignatureWebhookDelivery; created: boolean }> {
    const id = randomUUID();
    const receivedAt = input.receivedAt ?? new Date();
    await this.db
      .insertInto('signature_webhook_inbox')
      .values({
        id,
        connection_id: input.connectionId ?? null,
        routing_public_id: input.routingPublicId ?? null,
        provider_key: input.providerKey,
        provider_account_id: input.providerAccountId ?? null,
        provider_envelope_id: input.providerEnvelopeId ?? null,
        dedup_key: input.dedupKey,
        payload_hash: input.payloadHash,
        content_length: Math.max(0, Math.trunc(input.contentLength)),
        signature_status: input.signatureStatus,
        content_type: input.contentType ?? null,
        payload_minimized: JSON.stringify(input.payloadMinimized),
        received_at: receivedAt,
        state: 'received',
        attempt_count: 0,
        correlation_id: input.correlationId ?? null,
        purge_after: input.purgeAfter ?? null,
      })
      .onConflict((oc) => oc.column('dedup_key').doNothing())
      .execute();

    const stored = await this.findByDedupKey(input.dedupKey);
    // A missing row here is not possible under the unique index; the guard is for the caller that
    // would otherwise acknowledge a delivery it did not store.
    if (stored === undefined) throw new Error('The webhook delivery was not durably accepted.');
    return { delivery: stored, created: stored.id === id };
  }

  async findByDedupKey(dedupKey: string): Promise<SignatureWebhookDelivery | undefined> {
    const row = await this.db.selectFrom('signature_webhook_inbox').selectAll().where('dedup_key', '=', dedupKey).executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  }

  async findById(id: string): Promise<SignatureWebhookDelivery | undefined> {
    const row = await this.db.selectFrom('signature_webhook_inbox').selectAll().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  }

  /** Move a receipt through its processing life. Only bookkeeping columns change. */
  async markState(
    id: string,
    state: ESignatureInboxState,
    options: { errorSafe?: string | null; from?: readonly ESignatureInboxState[] } = {},
  ): Promise<boolean> {
    let update = this.db
      .updateTable('signature_webhook_inbox')
      .set({
        state,
        processed_at: state === 'processed' || state === 'ignored' || state === 'dead_letter' ? new Date() : null,
        attempt_count: sql<number>`attempt_count + 1`,
        last_error_safe: options.errorSafe?.slice(0, 500) ?? null,
      })
      .where('id', '=', id);
    if (options.from !== undefined && options.from.length > 0) update = update.where('state', 'in', options.from);
    const result = await update.executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** The operator queue: what arrived and could not be applied (plan §16, §20). */
  async listProblemDeliveries(limit = 50): Promise<SignatureWebhookDelivery[]> {
    return this.listByState(['retryable', 'dead_letter'], limit);
  }

  /** One bounded page of deliveries in the named states, oldest first — the workbench's view. */
  async listByState(states: readonly ESignatureInboxState[], limit = 50): Promise<SignatureWebhookDelivery[]> {
    if (states.length === 0) return [];
    const rows = await this.db
      .selectFrom('signature_webhook_inbox')
      .selectAll()
      .where('state', 'in', [...states])
      .orderBy('received_at', 'asc')
      .limit(clamp(limit, 200))
      .execute();
    return rows.map((row) => toDelivery(row));
  }

  /**
   * Reset a failed receipt for one operator-requested retry.
   *
   * Only a retryable or dead-letter receipt with a verified (or intentionally unrequired) signature
   * qualifies; an invalid one is evidence of a rejected POST and can never be applied. The attempt
   * counter is reset because a manual retry is a fresh, bounded attempt — without that, the very next
   * failure would immediately dead-letter again. Returns whether this call won the state race.
   */
  async resetForRetry(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('signature_webhook_inbox')
      .set({ state: 'retryable', attempt_count: 0, processed_at: null, last_error_safe: null })
      .where('id', '=', id)
      .where('state', 'in', ['retryable', 'dead_letter'])
      .where('signature_status', 'in', ['verified', 'not_required'])
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Counters and ages for the webhook diagnostics view; optionally narrowed to one connection. */
  async diagnostics(connectionId?: string): Promise<WebhookInboxDiagnostics> {
    const states = await (connectionId === undefined
      ? this.db.selectFrom('signature_webhook_inbox').select('state')
      : this.db.selectFrom('signature_webhook_inbox').select('state').where('connection_id', '=', connectionId))
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy('state')
      .execute();
    const signatures = await (connectionId === undefined
      ? this.db.selectFrom('signature_webhook_inbox').select('signature_status')
      : this.db
          .selectFrom('signature_webhook_inbox')
          .select('signature_status')
          .where('connection_id', '=', connectionId))
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy('signature_status')
      .execute();
    const total = await (connectionId === undefined
      ? this.db.selectFrom('signature_webhook_inbox').select((eb) => eb.fn.countAll<string>().as('n'))
      : this.db
          .selectFrom('signature_webhook_inbox')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('connection_id', '=', connectionId))
      .executeTakeFirst();
    const last = await (connectionId === undefined
      ? this.db.selectFrom('signature_webhook_inbox').select('received_at')
      : this.db.selectFrom('signature_webhook_inbox').select('received_at').where('connection_id', '=', connectionId))
      .orderBy('received_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const oldestPending = await (connectionId === undefined
      ? this.db
          .selectFrom('signature_webhook_inbox')
          .select(['received_at', 'state'])
          .where('state', 'in', ['received', 'retryable'])
      : this.db
          .selectFrom('signature_webhook_inbox')
          .select(['received_at', 'state'])
          .where('state', 'in', ['received', 'retryable'])
          .where('connection_id', '=', connectionId))
      .orderBy('received_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    const countsByState = Object.fromEntries(INBOX_STATES.map((state) => [state, 0])) as Record<ESignatureInboxState, number>;
    for (const row of states) {
      if ((INBOX_STATES as readonly string[]).includes(row.state)) {
        countsByState[row.state as ESignatureInboxState] = Number.parseInt(row.n, 10) || 0;
      }
    }
    const signatureStatus = { verified: 0, invalid: 0, notRequired: 0 };
    for (const row of signatures) {
      const count = Number.parseInt(row.n, 10) || 0;
      if (row.signature_status === 'verified') signatureStatus.verified = count;
      else if (row.signature_status === 'invalid') signatureStatus.invalid = count;
      else if (row.signature_status === 'not_required') signatureStatus.notRequired = count;
    }
    return {
      total: Number.parseInt(total?.n ?? '0', 10) || 0,
      countsByState,
      signatureStatus,
      lastReceivedAt: last === undefined ? null : last.received_at.toISOString(),
      oldestPendingAt: oldestPending === undefined ? null : oldestPending.received_at.toISOString(),
      oldestPendingState:
        oldestPending === undefined
          ? null
          : oldestPending.state === 'received' || oldestPending.state === 'retryable'
            ? oldestPending.state
            : null,
    };
  }

  async countsByState(): Promise<Record<ESignatureInboxState, number>> {
    const rows = await this.db
      .selectFrom('signature_webhook_inbox')
      .select(['state', (eb) => eb.fn.countAll<string>().as('n')])
      .groupBy('state')
      .execute();
    const out = Object.fromEntries(INBOX_STATES.map((state) => [state, 0])) as Record<ESignatureInboxState, number>;
    for (const row of rows) {
      if ((INBOX_STATES as readonly string[]).includes(row.state)) {
        out[row.state as ESignatureInboxState] = Number.parseInt(row.n, 10) || 0;
      }
    }
    return out;
  }
}

/**
 * The dedup key for a delivery whose event has no provider id.
 *
 * Deterministic over the fields that identify the delivery — provider, envelope, event type and the
 * body hash — so the same POST twice maps to one row while two different events for one envelope do
 * not collapse together (plan §10.1.4).
 */
export function deliveryDedupKey(input: {
  providerKey: string;
  providerEnvelopeId?: string | null;
  eventType?: string | null;
  body: unknown;
}): string {
  const hash = createHash('sha256').update(canonicalJson(input.body)).digest('hex');
  return [input.providerKey, input.providerEnvelopeId?.trim() || 'no-envelope', input.eventType?.trim() || 'no-type', hash].join(':');
}

export function payloadHashOf(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function toDelivery(row: {
  id: string;
  connection_id: string | null;
  routing_public_id: string | null;
  provider_key: string;
  provider_account_id: string | null;
  provider_envelope_id: string | null;
  dedup_key: string;
  payload_hash: string;
  content_length: number;
  signature_status: string;
  content_type: string | null;
  payload_minimized: unknown;
  received_at: Date;
  state: string;
  processed_at: Date | null;
  attempt_count: number;
  last_error_safe: string | null;
  correlation_id: string | null;
  purge_after: Date | null;
}): SignatureWebhookDelivery {
  return {
    id: row.id,
    connectionId: row.connection_id,
    routingPublicId: row.routing_public_id,
    providerKey: row.provider_key,
    providerAccountId: row.provider_account_id,
    providerEnvelopeId: row.provider_envelope_id,
    dedupKey: row.dedup_key,
    payloadHash: row.payload_hash,
    contentLength: row.content_length,
    signatureStatus: row.signature_status as SignatureWebhookDelivery['signatureStatus'],
    contentType: row.content_type,
    payloadMinimized:
      row.payload_minimized !== null && typeof row.payload_minimized === 'object' && !Array.isArray(row.payload_minimized)
        ? (row.payload_minimized as Record<string, unknown>)
        : {},
    receivedAt: row.received_at.toISOString(),
    state: row.state as ESignatureInboxState,
    processedAt: iso(row.processed_at),
    attemptCount: row.attempt_count,
    lastErrorSafe: row.last_error_safe,
    correlationId: row.correlation_id,
    purgeAfter: iso(row.purge_after),
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
