import { randomUUID } from 'node:crypto';

import { ConcurrencyConflictError, DuplicateRecordError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { PROVIDER_KEY_DOCUSIGN, REQUEST_STATUSES, type SignatureRequestStatus } from './esignature-domain.js';
import type { OutgoingSnapshotData, SnapshotEnvelope } from './esignature-snapshot.js';
import { readSnapshot } from './esignature-snapshot.js';
import {
  assertEditable,
  assertTransition,
  type TransitionOrigin,
} from './esignature-state-machine.js';

/**
 * Phase 19-ES.2 — the signature request repository
 * (`PLAN_Phase_19_ESignature.md` §6.2, §4.3, §4.7, §8.2; `19-ES.2` acceptance
 * "request state transitions are unit-tested", "provider envelope IDs unique in the appropriate
 * connection/account context").
 *
 * Three invariants live in this file, because it is the only write path these rows have:
 *
 * 1. **The state machine is the only door.** `transition` is the only way a status changes, and it
 *    asks the state machine who is allowed to cause the move. A `PATCH /api/v1/:entity` does not
 *    exist for this table — that was the audit's reason for keeping it out of `entity_records`.
 * 2. **Concurrent writers lose explicitly.** Every guarded change carries the version the caller
 *    read, and the update is `where version = $expected`. A stale preview therefore cannot send,
 *    void or confirm over a newer state, and the loser gets `CONCURRENCY_CONFLICT` rather than a
 *    silent overwrite (plan §11.2).
 * 3. **A send attempt is one row's worth of intent.** `send_attempt_id` is claimed atomically and is
 *    unique in the database, so a retry of a request whose response was lost cannot quietly create a
 *    second envelope (plan §4.3, §16). The value the caller passes is a correlation token, not a
 *    provider id.
 *
 * Server-owned columns — `status`, `provider_envelope_id`, `provider_status_raw`, the terminal
 * timestamps, the digests, `version` — are refused by `updateDraft` by name. A caller edits what it
 * is preparing, never what the provider decided.
 */

export interface SignatureRequest {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: SignatureRequestStatus;
  readonly providerKey: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly providerStatusRaw: string | null;
  readonly sourceEntityType: string | null;
  readonly sourceRecordId: string | null;
  readonly subject: string | null;
  readonly message: string | null;
  readonly emailBlurb: string | null;
  readonly createdById: string | null;
  readonly assignedUserId: string | null;
  readonly teamIds: readonly string[];
  readonly preparedById: string | null;
  readonly approvedById: string | null;
  readonly sentById: string | null;
  readonly preparedAt: string | null;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly declinedAt: string | null;
  readonly voidedAt: string | null;
  readonly expiredAt: string | null;
  readonly expiresAt: string | null;
  readonly approvalRequired: boolean;
  readonly approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  readonly approvalReason: string | null;
  readonly approvedAt: string | null;
  readonly approvedDigest: string | null;
  readonly sendAttemptId: string | null;
  readonly outgoingSnapshot: SnapshotEnvelope<OutgoingSnapshotData> | null;
  readonly outgoingDigest: string | null;
  readonly lastReconciledAt: string | null;
  readonly lastProviderSyncAt: string | null;
  readonly failureCategory: string | null;
  readonly failureCode: string | null;
  readonly failureMessageSafe: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly deleted: boolean;
}

/** The columns a caller may never set through a draft edit (plan §8.2). */
const SERVER_OWNED_FIELDS = [
  'status',
  'providerEnvelopeId',
  'providerStatusRaw',
  'sendAttemptId',
  'outgoingSnapshot',
  'outgoingDigest',
  'approvedDigest',
  'version',
  'sentAt',
  'completedAt',
  'declinedAt',
  'voidedAt',
  'expiredAt',
  'lastReconciledAt',
  'lastProviderSyncAt',
] as const;

export interface RequestDraftInput {
  name: string;
  description?: string;
  providerKey?: string;
  connectionId?: string | null;
  sourceEntityType?: string | null;
  sourceRecordId?: string | null;
  subject?: string | null;
  message?: string | null;
  emailBlurb?: string | null;
  expiresAt?: string | null;
  approvalRequired?: boolean;
  createdById?: string;
  assignedUserId?: string | null;
  teamIds?: readonly string[];
  id?: string;
}

export interface RequestListFilters {
  statuses?: readonly SignatureRequestStatus[];
  connectionId?: string;
  sourceEntityType?: string;
  sourceRecordId?: string;
  createdById?: string;
  assignedUserId?: string;
  approvalStatus?: SignatureRequest['approvalStatus'];
  needsAttention?: boolean;
  sentFrom?: Date;
  sentTo?: Date;
  completedFrom?: Date;
  completedTo?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class SignatureRequestRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  async findById(id: string, options: { includeDeleted?: boolean } = {}): Promise<SignatureRequest | undefined> {
    let query = this.db.selectFrom('signature_requests').selectAll().where('id', '=', id);
    if (options.includeDeleted !== true) query = query.where('deleted_at', 'is', null);
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : toRequest(row);
  }

  async requireById(id: string): Promise<SignatureRequest> {
    const found = await this.findById(id);
    if (found === undefined) throw new ValidationError(`No signature request "${id}".`, { id });
    return found;
  }

  async findByEnvelope(connectionId: string, providerEnvelopeId: string): Promise<SignatureRequest | undefined> {
    const row = await this.db
      .selectFrom('signature_requests')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('provider_envelope_id', '=', providerEnvelopeId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toRequest(row);
  }

  async list(filters: RequestListFilters = {}): Promise<{ list: SignatureRequest[]; total: number }> {
    const limit = clampLimit(filters.limit);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    let query = this.db.selectFrom('signature_requests').where('deleted_at', 'is', null);
    let count = this.db.selectFrom('signature_requests').where('deleted_at', 'is', null);

    if (filters.statuses !== undefined && filters.statuses.length > 0) {
      query = query.where('status', 'in', filters.statuses);
      count = count.where('status', 'in', filters.statuses);
    }
    if (filters.connectionId !== undefined) {
      query = query.where('connection_id', '=', filters.connectionId);
      count = count.where('connection_id', '=', filters.connectionId);
    }
    if (filters.sourceEntityType !== undefined) {
      query = query.where('source_entity_type', '=', filters.sourceEntityType);
      count = count.where('source_entity_type', '=', filters.sourceEntityType);
    }
    if (filters.sourceRecordId !== undefined) {
      query = query.where('source_record_id', '=', filters.sourceRecordId);
      count = count.where('source_record_id', '=', filters.sourceRecordId);
    }
    if (filters.createdById !== undefined) {
      query = query.where('created_by_id', '=', filters.createdById);
      count = count.where('created_by_id', '=', filters.createdById);
    }
    if (filters.assignedUserId !== undefined) {
      query = query.where('assigned_user_id', '=', filters.assignedUserId);
      count = count.where('assigned_user_id', '=', filters.assignedUserId);
    }
    if (filters.approvalStatus !== undefined) {
      query = query.where('approval_status', '=', filters.approvalStatus);
      count = count.where('approval_status', '=', filters.approvalStatus);
    }
    if (filters.needsAttention === true) {
      const attention = ['send_unknown', 'provider_error', 'reconciliation_required'] as const;
      query = query.where('status', 'in', attention);
      count = count.where('status', 'in', attention);
    }
    if (filters.sentFrom !== undefined) {
      query = query.where('sent_at', '>=', filters.sentFrom);
      count = count.where('sent_at', '>=', filters.sentFrom);
    }
    if (filters.sentTo !== undefined) {
      query = query.where('sent_at', '<=', filters.sentTo);
      count = count.where('sent_at', '<=', filters.sentTo);
    }
    if (filters.completedFrom !== undefined) {
      query = query.where('completed_at', '>=', filters.completedFrom);
      count = count.where('completed_at', '>=', filters.completedFrom);
    }
    if (filters.completedTo !== undefined) {
      query = query.where('completed_at', '<=', filters.completedTo);
      count = count.where('completed_at', '<=', filters.completedTo);
    }

    const counted = await count
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    const rows = await query
      .selectAll()
      .orderBy('modified_at', 'desc')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset)
      .execute();
    return { list: rows.map((row) => toRequest(row)), total: Number.parseInt(String(counted?.n ?? '0'), 10) || 0 };
  }

  /**
   * Create a local draft.
   *
   * A draft has no envelope and no provider call (plan §4.3), so `connectionId` may be null and
   * `provider_envelope_id` is never settable here.
   */
  async createDraft(input: RequestDraftInput): Promise<SignatureRequest> {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A signature request needs a name.');
    const providerKey = input.providerKey ?? PROVIDER_KEY_DOCUSIGN;
    if (providerKey !== PROVIDER_KEY_DOCUSIGN) {
      throw new ValidationError('The first release addresses one signature provider.', { providerKey });
    }
    if (input.sourceEntityType !== undefined && input.sourceEntityType !== null) validateEntityName(input.sourceEntityType);
    if (input.sourceRecordId !== undefined && input.sourceRecordId !== null && input.sourceRecordId.trim() === '') {
      throw new ValidationError('A source record id cannot be blank.');
    }
    if ((input.sourceEntityType === null || input.sourceEntityType === undefined) !== (input.sourceRecordId === null || input.sourceRecordId === undefined)) {
      throw new ValidationError('A linked source record needs both its entity type and its id.');
    }
    const id = input.id ?? randomUUID();
    const now = new Date();
    const row = await this.db
      .insertInto('signature_requests')
      .values({
        id,
        name,
        description: input.description?.trim() || null,
        status: 'draft',
        provider_key: providerKey,
        connection_id: input.connectionId ?? null,
        source_entity_type: input.sourceEntityType ?? null,
        source_record_id: input.sourceRecordId?.trim() || null,
        subject: input.subject?.trim() || null,
        message: input.message?.trim() || null,
        email_blurb: input.emailBlurb?.trim() || null,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
        approval_required: input.approvalRequired === true,
        approval_status: input.approvalRequired === true ? 'pending' : 'not_required',
        created_by_id: input.createdById ?? null,
        assigned_user_id: input.assignedUserId ?? null,
        team_ids: JSON.stringify([...(input.teamIds ?? [])]),
        version: 1,
        created_at: now,
        modified_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRequest(row);
  }

  /**
   * Edit a draft's own content.
   *
   * The state guard is first: after a request has been prepared or sent, generic edits are refused
   * outright, because plan §1.2 forbids a silent change to what was sent. A server-owned column named
   * in the patch is refused rather than ignored — a caller that believes it can set `status` should
   * hear that immediately.
   */
  async updateDraft(
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<SignatureRequest, 'name' | 'description' | 'subject' | 'message' | 'emailBlurb' | 'expiresAt' | 'connectionId' | 'sourceEntityType' | 'sourceRecordId' | 'assignedUserId' | 'teamIds'>> &
      Record<string, unknown>,
    actorId?: string,
  ): Promise<SignatureRequest> {
    for (const field of SERVER_OWNED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        throw new ValidationError(`"${field}" is set by the platform, not by a draft edit.`, { field, code: 'SIGNATURE_REQUEST_INVALID_STATE' });
      }
    }
    const current = await this.requireById(id);
    assertEditable(current.status, 'update');
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    if (patch.sourceEntityType !== undefined && patch.sourceEntityType !== null) validateEntityName(patch.sourceEntityType);

    const row = await this.db
      .updateTable('signature_requests')
      .set({
        ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
        ...(patch.description !== undefined ? { description: asStringOrNull(patch.description) } : {}),
        ...(patch.subject !== undefined ? { subject: asStringOrNull(patch.subject) } : {}),
        ...(patch.message !== undefined ? { message: asStringOrNull(patch.message) } : {}),
        ...(patch.emailBlurb !== undefined ? { email_blurb: asStringOrNull(patch.emailBlurb) } : {}),
        ...(patch.connectionId !== undefined ? { connection_id: asStringOrNull(patch.connectionId) } : {}),
        ...(patch.sourceEntityType !== undefined ? { source_entity_type: asStringOrNull(patch.sourceEntityType) } : {}),
        ...(patch.sourceRecordId !== undefined ? { source_record_id: asStringOrNull(patch.sourceRecordId) } : {}),
        ...(patch.assignedUserId !== undefined ? { assigned_user_id: asStringOrNull(patch.assignedUserId) } : {}),
        ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt === null ? null : new Date(String(patch.expiresAt)) } : {}),
        ...(patch.teamIds !== undefined ? { team_ids: JSON.stringify(Array.isArray(patch.teamIds) ? patch.teamIds.map(String) : []) } : {}),
        version: current.version + 1,
        modified_at: new Date(),
        ...(actorId !== undefined ? { modified_by_id: actorId } : {}),
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /**
   * Move the request through the state machine.
   *
   * `origin` says who is causing the move and it is not decoration: a CRM command cannot enter a
   * provider-owned state, and a terminal state cannot be re-opened except by reconciliation
   * (plan §1.2, §4.7). The write is version-checked, and the state's own timestamp is stamped by the
   * table below rather than trusted from the caller — a client that sends `completedAt` gets the
   * database's clock.
   */
  async transition(
    id: string,
    input: {
      expectedVersion: number;
      to: SignatureRequestStatus;
      origin: TransitionOrigin;
      actorId?: string;
      providerStatusRaw?: string | null;
      failure?: { category: string; code: string; messageSafe: string } | null;
      /** The reconciliation path's own timestamp; `undefined` means now. */
      occurredAt?: Date;
    },
  ): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    assertTransition(current.status, input.to, input.origin);
    if (current.version !== input.expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    const at = input.occurredAt ?? new Date();

    const row = await this.db
      .updateTable('signature_requests')
      .set({
        status: input.to,
        version: current.version + 1,
        modified_at: at,
        ...(input.actorId !== undefined ? { modified_by_id: input.actorId } : {}),
        ...(input.to === 'sent' ? { sent_at: at } : {}),
        ...(input.to === 'completed' ? { completed_at: at } : {}),
        ...(input.to === 'declined' ? { declined_at: at } : {}),
        ...(input.to === 'voided' ? { voided_at: at } : {}),
        ...(input.to === 'expired' ? { expired_at: at } : {}),
        ...(input.origin === 'provider' ? { provider_status_raw: input.providerStatusRaw ?? null, last_provider_sync_at: at } : {}),
        ...(input.origin === 'reconciliation' ? { last_reconciled_at: at } : {}),
        ...(input.failure === null ? { failure_category: null, failure_code: null, failure_message_safe: null } : {}),
        ...(input.failure !== undefined && input.failure !== null
          ? { failure_category: input.failure.category, failure_code: input.failure.code, failure_message_safe: input.failure.messageSafe.slice(0, 500) }
          : {}),
        // The actor who performed the send is recorded when the request leaves the CRM, not when the
        // provider answers: they are different people's decisions.
        ...(input.to === 'sending' ? { sent_by_id: input.actorId ?? current.sentById } : {}),
      })
      .where('id', '=', id)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /**
   * Claim the correlation token for one deliberate send.
   *
   * The unique index does the work: an attempt id already on any row is refused, which is the
   * structural answer to "the response was lost, may I try again" (plan §4.3). The caller must
   * generate a fresh token per *user action*, and reuse the same one when retrying the same action.
   */
  async claimSendAttempt(
    id: string,
    expectedVersion: number,
    sendAttemptId: string,
    envelope: SnapshotEnvelope<OutgoingSnapshotData>,
  ): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    // The unique index is the guarantee; this read turns a collision into the stable answer instead
    // of letting a driver error escape (plan §4.3: one deliberate action, one effective send).
    const taken = await this.db
      .selectFrom('signature_requests')
      .select('id')
      .where('send_attempt_id', '=', sendAttemptId)
      .where('id', '!=', id)
      .executeTakeFirst();
    if (taken !== undefined) {
      throw new DuplicateRecordError('That send attempt has already been used for another request.', {
        code: 'PROVIDER_OUTCOME_UNKNOWN',
        request: taken.id,
      });
    }
    if (current.sendAttemptId !== null && current.sendAttemptId !== sendAttemptId) {
      throw new ValidationError('This request already carries a send attempt.', {
        code: 'PROVIDER_OUTCOME_UNKNOWN',
        request: current.id,
        existingAttempt: current.sendAttemptId,
      });
    }
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    const row = await this.db
      .updateTable('signature_requests')
      .set({
        send_attempt_id: sendAttemptId,
        outgoing_snapshot: JSON.stringify(envelope),
        outgoing_digest: envelope.digest,
        version: current.version + 1,
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /** Record what the provider answered, once the envelope exists (plan §4.3). */
  async attachProviderEnvelope(
    id: string,
    expectedVersion: number,
    providerEnvelopeId: string,
    providerStatusRaw?: string,
  ): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    const envelope = providerEnvelopeId.trim();
    if (envelope === '') throw new ValidationError('The provider returned no envelope id.');
    // Uniqueness is scoped to the account, and the connection is what carries the account: an
    // envelope id recorded against no connection could not be interpreted at all (plan §6.2).
    if (current.connectionId === null) {
      throw new ValidationError('A signature request must name its provider connection before an envelope is recorded.', {
        code: 'PROVIDER_NOT_CONNECTED',
        requestId: id,
      });
    }
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    // A DocuSign envelope id is unique **within the connection**, not globally: the same id under a
    // different account is a different envelope (plan §6.2), so that is the scope of the check.
    const clash = await this.findByEnvelope(current.connectionId, envelope);
    if (clash !== undefined && clash.id !== id) {
      throw new DuplicateRecordError('That provider envelope is already recorded for another request on this connection.', {
        code: 'SIGNATURE_REQUEST_INVALID_STATE',
        connectionId: current.connectionId,
        existingRequest: clash.id,
      });
    }
    const row = await this.db
      .updateTable('signature_requests')
      .set({
        provider_envelope_id: envelope,
        provider_status_raw: providerStatusRaw ?? current.providerStatusRaw,
        last_provider_sync_at: new Date(),
        version: current.version + 1,
        modified_at: new Date(),
      })
      // The partial unique index on (connection_id, provider_envelope_id) is the real guard; this
      // predicate only makes the conflict legible instead of a driver error.
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /**
   * Bind an approval to the exact reviewed snapshot (plan §11.2, §17).
   *
   * The digest is stored beside the decision, so a later change to a document, a recipient or the
   * policy invalidates the approval by not matching, rather than by anyone remembering to revoke it.
   */
  async recordApproval(
    id: string,
    expectedVersion: number,
    decision: { approverId: string; status: 'approved' | 'rejected'; reason?: string; reviewedDigest: string },
  ): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    if (decision.reviewedDigest !== current.outgoingDigest && current.outgoingDigest !== null) {
      throw new ValidationError('The reviewed snapshot no longer matches the request.', {
        code: 'SIGNATURE_REQUEST_INVALID_STATE',
      });
    }
    const row = await this.db
      .updateTable('signature_requests')
      .set({
        approval_status: decision.status,
        approved_by_id: decision.approverId,
        approved_at: new Date(),
        approved_digest: decision.status === 'approved' ? decision.reviewedDigest : null,
        approval_reason: decision.reason?.slice(0, 500) ?? null,
        version: current.version + 1,
        modified_at: new Date(),
        modified_by_id: decision.approverId,
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /** The preparation stamp, set when the draft is reviewed and its snapshot captured (ES.8). */
  async markPrepared(id: string, expectedVersion: number, actorId: string): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureRequest', id);
    const row = await this.db
      .updateTable('signature_requests')
      .set({
        prepared_by_id: actorId,
        prepared_at: new Date(),
        version: current.version + 1,
        modified_at: new Date(),
        modified_by_id: actorId,
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureRequest', id);
    return toRequest(row);
  }

  /** Soft delete. A sent request is never removed: it is evidence of what was signed. */
  async softDelete(id: string, actorId?: string): Promise<SignatureRequest> {
    const current = await this.requireById(id);
    if (current.status !== 'draft' && current.status !== 'ready_to_send' && current.status !== 'pending_approval') {
      throw new ValidationError('A signature request that has been sent cannot be deleted; void it instead.', {
        code: 'SIGNATURE_REQUEST_INVALID_STATE',
        status: current.status,
      });
    }
    const row = await this.db
      .updateTable('signature_requests')
      .set({ deleted_at: new Date(), modified_at: new Date(), ...(actorId !== undefined ? { modified_by_id: actorId } : {}) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRequest(row);
  }

  /** Requests still waiting on a signer, for the operator queue (plan §14). */
  async outstandingIds(limit = 200): Promise<string[]> {
    const rows = await this.db
      .selectFrom('signature_requests')
      .select('id')
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['sent', 'delivered', 'partially_signed'])
      .orderBy('sent_at', 'asc')
      .limit(clampLimit(limit))
      .execute();
    return rows.map((row) => row.id);
  }

  /** The count the health view reports for a connection. */
  async countByStatus(connectionId: string): Promise<Partial<Record<SignatureRequestStatus, number>>> {
    const rows = await this.db
      .selectFrom('signature_requests')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('connection_id', '=', connectionId)
      .where('deleted_at', 'is', null)
      .groupBy('status')
      .execute();
    const out: Partial<Record<SignatureRequestStatus, number>> = {};
    for (const row of rows) {
      if ((REQUEST_STATUSES as readonly string[]).includes(row.status)) {
        out[row.status as SignatureRequestStatus] = Number.parseInt(row.n, 10) || 0;
      }
    }
    return out;
  }

  /**
   * Whether a connection may be deactivated or disconnected right now.
   *
   * A connection with an envelope still in flight is refused: the projection would stop receiving
   * the events that finish it (plan §21.12).
   */
  async hasOpenRequestsForConnection(connectionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('signature_requests')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['sending', 'send_unknown', 'sent', 'delivered', 'partially_signed', 'pending_approval'])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}

function toRequest(row: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  provider_key: string;
  connection_id: string | null;
  provider_envelope_id: string | null;
  provider_status_raw: string | null;
  source_entity_type: string | null;
  source_record_id: string | null;
  subject: string | null;
  message: string | null;
  email_blurb: string | null;
  created_by_id: string | null;
  assigned_user_id: string | null;
  team_ids: unknown;
  prepared_by_id: string | null;
  approved_by_id: string | null;
  sent_by_id: string | null;
  prepared_at: Date | null;
  sent_at: Date | null;
  completed_at: Date | null;
  declined_at: Date | null;
  voided_at: Date | null;
  expired_at: Date | null;
  expires_at: Date | null;
  approval_required: boolean;
  approval_status: string;
  approval_reason: string | null;
  approved_at: Date | null;
  approved_digest: string | null;
  send_attempt_id: string | null;
  outgoing_snapshot: unknown;
  outgoing_digest: string | null;
  last_reconciled_at: Date | null;
  last_provider_sync_at: Date | null;
  failure_category: string | null;
  failure_code: string | null;
  failure_message_safe: string | null;
  version: number;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}): SignatureRequest {
  // A stored snapshot is verified rather than trusted: a row whose digest does not match its payload
  // is a reconciliation case, and handing out the payload anyway would be guessing (plan §4.3).
  let snapshot: SnapshotEnvelope<OutgoingSnapshotData> | null = null;
  if (row.outgoing_snapshot !== null && row.outgoing_snapshot !== undefined) {
    snapshot = readSnapshot<OutgoingSnapshotData>(row.outgoing_snapshot);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as SignatureRequestStatus,
    providerKey: row.provider_key,
    connectionId: row.connection_id,
    providerEnvelopeId: row.provider_envelope_id,
    providerStatusRaw: row.provider_status_raw,
    sourceEntityType: row.source_entity_type,
    sourceRecordId: row.source_record_id,
    subject: row.subject,
    message: row.message,
    emailBlurb: row.email_blurb,
    createdById: row.created_by_id,
    assignedUserId: row.assigned_user_id,
    teamIds: Array.isArray(row.team_ids) ? (row.team_ids as string[]).filter((s) => typeof s === 'string') : [],
    preparedById: row.prepared_by_id,
    approvedById: row.approved_by_id,
    sentById: row.sent_by_id,
    preparedAt: iso(row.prepared_at),
    sentAt: iso(row.sent_at),
    completedAt: iso(row.completed_at),
    declinedAt: iso(row.declined_at),
    voidedAt: iso(row.voided_at),
    expiredAt: iso(row.expired_at),
    expiresAt: iso(row.expires_at),
    approvalRequired: row.approval_required,
    approvalStatus: row.approval_status as SignatureRequest['approvalStatus'],
    approvalReason: row.approval_reason,
    approvedAt: iso(row.approved_at),
    approvedDigest: row.approved_digest,
    sendAttemptId: row.send_attempt_id,
    outgoingSnapshot: snapshot,
    outgoingDigest: row.outgoing_digest,
    lastReconciledAt: iso(row.last_reconciled_at),
    lastProviderSyncAt: iso(row.last_provider_sync_at),
    failureCategory: row.failure_category,
    failureCode: row.failure_code,
    failureMessageSafe: row.failure_message_safe,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    deleted: row.deleted_at !== null,
  };
}

/**
 * A metadata entity name, validated before it is stored.
 *
 * The pair is later checked against the metadata registry (ES.6); this is the first, cheap refusal of
 * anything that could only be an injected identifier (AGENTS.md §5.2).
 */
function validateEntityName(value: string): void {
  if (!/^[A-Z][A-Za-z0-9]{1,62}$/.test(value)) {
    throw new ValidationError('A source entity type is a metadata entity name.', { sourceEntityType: value });
  }
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function iso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function clampLimit(value: number | undefined): number {
  const limit = Math.trunc(value ?? 100);
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(limit, 500);
}
