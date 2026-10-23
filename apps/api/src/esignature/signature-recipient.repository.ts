import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx, runInTransaction } from '../entity/tx-context.js';
import { RECIPIENT_TYPES, type SignatureRecipientType } from './esignature-domain.js';
import { assertEditable } from './esignature-state-machine.js';
import { canRecipientMove, type SignatureRecipientStatus } from './esignature-state-machine.js';
import { SignatureRequestRepository } from './signature-request.repository.js';

/**
 * Phase 19-ES.2 — the recipient projection
 * (`PLAN_Phase_19_ESignature.md` §6.4, §4.4, §4.7, §10.3).
 *
 * Two facts the rest of the module depends on are enforced here:
 *
 * - **A recipient row is a snapshot of what was submitted.** `name` and `email` are copied from the
 *   Contact (or typed for an external signer) and never re-read: a Contact's email changing six
 *   months later must not rewrite who was asked to sign (plan §6.4).
 * - **The projection is monotonic.** `applyStatus` moves a signer forward only, and an event whose id
 *   the row already carries is a no-op with `changed: false`. That is what makes a replayed or
 *   out-of-order Connect delivery harmless without the caller having to be careful (plan §10.3).
 *
 * A signer completing is *not* the envelope completing — that inference lives in ES.12's aggregate,
 * and this file deliberately exposes only the per-signer truth.
 */

export interface SignatureRecipient {
  readonly id: string;
  readonly requestId: string;
  readonly providerRecipientId: string | null;
  readonly recipientType: SignatureRecipientType;
  readonly crmContactId: string | null;
  readonly name: string;
  readonly email: string;
  readonly roleName: string | null;
  readonly routingOrder: number;
  readonly status: SignatureRecipientStatus;
  readonly providerStatusRaw: string | null;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly viewedAt: string | null;
  readonly completedAt: string | null;
  readonly declinedAt: string | null;
  readonly declineReasonSafe: string | null;
  readonly authenticationMethod: string | null;
  readonly lastStatusEventId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly deleted: boolean;
}

export interface RecipientInput {
  name: string;
  email: string;
  recipientType?: SignatureRecipientType | undefined;
  crmContactId?: string | null | undefined;
  roleName?: string | null | undefined;
  routingOrder: number;
  authenticationMethod?: string | null | undefined;
}

@Injectable()
export class SignatureRecipientRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
  ) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * Replace the draft's recipients.
   *
   * Only a draft has editable recipients (plan §8.2), and the whole set is replaced rather than
   * patched: a partial edit could leave two signers in one routing slot or an orphan CC behind, and
   * "the set the sender reviewed" is a property of the draft as a whole.
   */
  async replaceForDraft(requestId: string, recipients: readonly RecipientInput[], actorId?: string): Promise<SignatureRecipient[]> {
    const request = await this.requests.requireById(requestId);
    assertEditable(request.status, 'configure recipients');
    if (recipients.length === 0) throw new ValidationError('A signature request needs at least one recipient.');

    const normalized = recipients.map((recipient) => normalizeRecipient(recipient));
    const seenRoles = new Set<string>();
    for (const recipient of normalized) {
      if (recipient.roleName !== null) {
        if (seenRoles.has(recipient.roleName)) {
          throw new ValidationError(`Two recipients fill the template role "${recipient.roleName}".`, {
            code: 'RECIPIENT_NOT_AUTHORIZED',
            roleName: recipient.roleName,
          });
        }
        seenRoles.add(recipient.roleName);
      }
    }

    const now = new Date();
    // `runInTransaction` reuses the ambient transaction when a caller already opened one, instead of
    // issuing a second BEGIN (apps/api/src/entity/tx-context.ts).
    return runInTransaction(this.database.db, async (tx) => {
      // Soft delete keeps the evidence of who *was* asked, which matters once the request is sent;
      // a draft's abandoned recipient is history rather than a hole in the record.
      await tx
        .updateTable('signature_recipients')
        .set({ deleted_at: now, modified_at: now })
        .where('request_id', '=', requestId)
        .where('deleted_at', 'is', null)
        .execute();
      const created: SignatureRecipient[] = [];
      for (const recipient of normalized) {
        const id = randomUUID();
        const row = await tx
          .insertInto('signature_recipients')
          .values({
            id,
            request_id: requestId,
            recipient_type: recipient.recipientType,
            crm_contact_id: recipient.crmContactId,
            name: recipient.name,
            email: recipient.email,
            role_name: recipient.roleName,
            routing_order: recipient.routingOrder,
            status: 'pending',
            authentication_method: recipient.authenticationMethod,
            created_at: now,
            modified_at: now,
            created_by_id: actorId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        created.push(toRecipient(row));
      }
      // Bumping the request's version is what invalidates a concurrent edit of the same draft: a
      // reviewer looking at the old recipient set cannot save over the new one.
      await tx
        .updateTable('signature_requests')
        .set({ version: request.version + 1, modified_at: now })
        .where('id', '=', requestId)
        .where('version', '=', request.version)
        .execute();
      return created.sort((left, right) => left.routingOrder - right.routingOrder || left.id.localeCompare(right.id));
    });
  }

  async listForRequest(requestId: string): Promise<SignatureRecipient[]> {
    const rows = await this.db
      .selectFrom('signature_recipients')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('deleted_at', 'is', null)
      .orderBy('routing_order', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => toRecipient(row));
  }

  /** The provider's recipient id for a signer, recorded when the envelope is prepared (ES.9). */
  async attachProviderId(recipientId: string, providerRecipientId: string): Promise<SignatureRecipient> {
    const row = await this.db
      .updateTable('signature_recipients')
      .set({ provider_recipient_id: providerRecipientId.trim(), modified_at: new Date() })
      .where('id', '=', recipientId)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecipient(row);
  }

  /**
   * Apply a signer status from provider evidence.
   *
   * Idempotent by the event id, and monotonic by the rank table: a duplicate, an older event, or an
   * attempt to move a finished signer backwards all return `changed: false` and touch nothing. The
   * caller decides what a `false` means for the envelope; this file never does.
   */
  async applyStatus(
    recipientId: string,
    input: {
      status: SignatureRecipientStatus;
      providerStatusRaw?: string | null;
      /** The provider event that carries this status; a repeat of the same event is a no-op. */
      eventId?: string | null;
      occurredAt?: Date;
      declineReasonSafe?: string | null;
    },
  ): Promise<{ recipient: SignatureRecipient; changed: boolean }> {
    const current = await this.findById(recipientId);
    if (current === undefined) throw new ValidationError(`No signature recipient "${recipientId}".`, { recipientId });
    if (input.eventId !== undefined && input.eventId !== null && current.lastStatusEventId === input.eventId) {
      return { recipient: current, changed: false };
    }
    if (!canRecipientMove(current.status, input.status)) return { recipient: current, changed: false };

    const at = input.occurredAt ?? new Date();
    const row = await this.db
      .updateTable('signature_recipients')
      .set({
        status: input.status,
        provider_status_raw: input.providerStatusRaw ?? current.providerStatusRaw,
        last_status_event_id: input.eventId ?? current.lastStatusEventId,
        modified_at: at,
        ...(input.status === 'sent' ? { sent_at: at } : {}),
        ...(input.status === 'delivered' ? { delivered_at: at } : {}),
        ...(input.status === 'viewed' ? { viewed_at: at } : {}),
        ...(input.status === 'signed' || input.status === 'completed' ? { completed_at: at } : {}),
        ...(input.status === 'declined' ? { declined_at: at, decline_reason_safe: input.declineReasonSafe?.slice(0, 500) ?? null } : {}),
      })
      .where('id', '=', recipientId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { recipient: toRecipient(row), changed: true };
  }

  async findById(id: string): Promise<SignatureRecipient | undefined> {
    const row = await this.db.selectFrom('signature_recipients').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  }

  /** A recipient the caller named, or a refusal. */
  async requireById(id: string): Promise<SignatureRecipient> {
    const found = await this.findById(id);
    if (found === undefined) throw new ValidationError(`No signature recipient "${id}".`, { recipientId: id });
    return found;
  }

  async findByProviderId(requestId: string, providerRecipientId: string): Promise<SignatureRecipient | undefined> {
    const row = await this.db
      .selectFrom('signature_recipients')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('provider_recipient_id', '=', providerRecipientId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  }

  /** The signer-progress summary the list and detail views show (plan §13.2, §13.4). */
  async progress(requestId: string): Promise<{ total: number; outstanding: number; completed: number; declined: number; signers: number }> {
    const rows = await this.db
      .selectFrom('signature_recipients')
      .select(['status', 'recipient_type', (eb) => eb.fn.countAll<string>().as('n')])
      .where('request_id', '=', requestId)
      .where('deleted_at', 'is', null)
      .groupBy(['status', 'recipient_type'])
      .execute();
    return summarizeProgress(rows);
  }

  /**
   * The progress summary for a page of requests, in one query.
   *
   * The list screen shows "2 of 3 signers" without one follow-up query per row (plan §13.2). A
   * request with no recipients is absent from the map and rendered as zero.
   */
  async progressForRequests(requestIds: readonly string[]): Promise<Map<string, { total: number; outstanding: number; completed: number; declined: number; signers: number }>> {
    const out = new Map<string, { total: number; outstanding: number; completed: number; declined: number; signers: number }>();
    if (requestIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('signature_recipients')
      .select(['request_id', 'status', 'recipient_type', (eb) => eb.fn.countAll<string>().as('n')])
      .where('request_id', 'in', [...requestIds])
      .where('deleted_at', 'is', null)
      .groupBy(['request_id', 'status', 'recipient_type'])
      .execute();
    const grouped = new Map<string, { status: string; recipient_type: string; n: string }[]>();
    for (const row of rows) {
      const list = grouped.get(row.request_id) ?? [];
      list.push({ status: row.status, recipient_type: row.recipient_type, n: row.n });
      grouped.set(row.request_id, list);
    }
    for (const [requestId, entries] of grouped) out.set(requestId, summarizeProgress(entries));
    return out;
  }

  /**
   * The recipient a signing link may be generated for (plan §4.6).
   *
   * Matching is by the persisted row, never by a name or email a caller passes: an embedded view for
   * someone who is not part of the request is `RECIPIENT_NOT_AUTHORIZED`, and that refusal is the
   * requirement §17.2 scenario 13 pins down.
   */
  async assertMatches(requestId: string, recipientId: string): Promise<SignatureRecipient> {
    const found = await this.findById(recipientId);
    if (found === undefined || found.requestId !== requestId) {
      throw new ValidationError('That recipient is not part of this signature request.', { code: 'RECIPIENT_NOT_AUTHORIZED' });
    }
    return found;
  }
}

function normalizeRecipient(input: RecipientInput): {
  name: string;
  email: string;
  recipientType: SignatureRecipientType;
  crmContactId: string | null;
  roleName: string | null;
  routingOrder: number;
  authenticationMethod: string | null;
} {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name === '') throw new ValidationError('A recipient needs a name.');
  // A deliberately plain shape check: the sender affirms the identity in the review step (plan §4.4),
  // and this only refuses what cannot be an address at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ValidationError('A recipient needs a valid email address.', { email: input.email.trim() });
  const recipientType = input.recipientType ?? 'signer';
  if (!(RECIPIENT_TYPES as readonly string[]).includes(recipientType)) {
    throw new ValidationError('Unknown recipient type.', { recipientType, allowed: [...RECIPIENT_TYPES] });
  }
  const routingOrder = Math.trunc(input.routingOrder);
  if (!Number.isFinite(routingOrder) || routingOrder < 1 || routingOrder > 99) {
    throw new ValidationError('A recipient routing order is between 1 and 99.', { routingOrder: input.routingOrder });
  }
  return {
    name: name.slice(0, 200),
    email: email.slice(0, 320),
    recipientType,
    crmContactId: input.crmContactId?.trim() || null,
    roleName: input.roleName?.trim() || null,
    routingOrder,
    authenticationMethod: input.authenticationMethod?.trim().slice(0, 60) || null,
  };
}

function summarizeProgress(rows: readonly { status: string; recipient_type: string; n: string }[]): {
  total: number;
  outstanding: number;
  completed: number;
  declined: number;
  signers: number;
} {
  let total = 0;
  let completed = 0;
  let declined = 0;
  let signers = 0;
  for (const row of rows) {
    const n = Number.parseInt(row.n, 10) || 0;
    total += n;
    if (row.recipient_type === 'signer') {
      signers += n;
      if (row.status === 'completed' || row.status === 'signed') completed += n;
    }
    if (row.status === 'declined') declined += n;
  }
  return { total, outstanding: total - completed - declined, completed, declined, signers };
}

function toRecipient(row: {
  id: string;  request_id: string;
  provider_recipient_id: string | null;
  recipient_type: string;
  crm_contact_id: string | null;
  name: string;
  email: string;
  role_name: string | null;
  routing_order: number;
  status: string;
  provider_status_raw: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  viewed_at: Date | null;
  completed_at: Date | null;
  declined_at: Date | null;
  decline_reason_safe: string | null;
  authentication_method: string | null;
  last_status_event_id: string | null;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}): SignatureRecipient {
  return {
    id: row.id,
    requestId: row.request_id,
    providerRecipientId: row.provider_recipient_id,
    recipientType: row.recipient_type as SignatureRecipientType,
    crmContactId: row.crm_contact_id,
    name: row.name,
    email: row.email,
    roleName: row.role_name,
    routingOrder: row.routing_order,
    status: row.status as SignatureRecipientStatus,
    providerStatusRaw: row.provider_status_raw,
    sentAt: iso(row.sent_at),
    deliveredAt: iso(row.delivered_at),
    viewedAt: iso(row.viewed_at),
    completedAt: iso(row.completed_at),
    declinedAt: iso(row.declined_at),
    declineReasonSafe: row.decline_reason_safe,
    authenticationMethod: row.authentication_method,
    lastStatusEventId: row.last_status_event_id,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    deleted: row.deleted_at !== null,
  };
}

function iso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
