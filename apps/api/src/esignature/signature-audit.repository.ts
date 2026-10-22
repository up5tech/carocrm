import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { AUDIT_ACTIONS, type ESignatureAuditAction } from './esignature-domain.js';

/**
 * Phase 19-ES.2 — the lifecycle audit trail
 * (`PLAN_Phase_19_ESignature.md` §6.6, §12.13).
 *
 * The kernel `audit_log` records changes to CRM *records*. The actions this module cares about are
 * not record edits: a request was reviewed, a send was confirmed, an embedded view was created, an
 * artifact was downloaded, a connection was re-authorized. Those need their own append-only trail,
 * and the action names come from a declared list so a typo cannot invent an unaudited action.
 *
 * **Append-only, in code.** There is no update or delete on this table. The only thing an operator can
 * do to an audit entry is read it — which is what makes "the module cannot hide what it did" a
 * property rather than a promise. Retention of audit rows is deliberately outside a timer (plan
 * §12.1: evidence is not telemetry).
 *
 * Redaction is enforced here, once, so a later phase cannot forget it: a detail value whose key looks
 * like a credential, a token, a URL or a document body is dropped, and long strings are truncated.
 * The plan's §12.13 list — tokens, signer access codes, signature URLs, document bytes — is what that
 * guard implements.
 */

export interface SignatureAuditEntry {
  readonly id: string;
  readonly requestId: string | null;
  readonly connectionId: string | null;
  readonly recipientId: string | null;
  readonly documentId: string | null;
  readonly action: ESignatureAuditAction;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly targetEntityType: string | null;
  readonly targetId: string | null;
  readonly outcome: 'ok' | 'refused';
  readonly reasonSafe: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface AuditInput {
  action: ESignatureAuditAction;
  requestId?: string | null;
  connectionId?: string | null | undefined;
  recipientId?: string | null | undefined;
  documentId?: string | null | undefined;
  actor?: { type: 'user' | 'system'; id?: string | undefined; name?: string | undefined };
  target?: { entityType?: string | undefined; id?: string | undefined };
  outcome?: 'ok' | 'refused';
  reasonSafe?: string | null;
  detail?: Record<string, unknown>;
  correlationId?: string | null;
}

/**
 * The words that make a value unauditable (plan §12.13): a secret, a token, a URL, a body, raw
 * content. A key is judged **by segment**, so `clientSecret`, `signature-url` and `rawPayload` are
 * all refused while `documentOrder` and `recipientEmail` survive.
 */
const FORBIDDEN_SEGMENT = /^(secret|clientsecret|refreshtoken|accesstoken|token|password|passwd|authorization|auth|cookie|apikey|key|secretkey|signature|url|uri|href|endpoint|body|bytes|content|payload|raw|material)$/;

/** A digest is the opposite of the content it summarizes: it is evidence and it is safe to keep. */
const HASH_SHAPED = /(hash|digest)/i;

function isForbiddenKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (HASH_SHAPED.test(normalized)) return false;
  return normalized.split(/[^a-z0-9]+/).some((segment) => FORBIDDEN_SEGMENT.test(segment));
}

/** A value this long is not a diagnostic; it is content that should never have reached an audit row. */
const MAX_VALUE_LENGTH = 500;

@Injectable()
export class SignatureAuditRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /** Append one entry. There is no other write verb on this table. */
  async append(input: AuditInput): Promise<SignatureAuditEntry> {
    if (!(AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
      throw new ValidationError(`"${String(input.action)}" is not a declared signature audit action.`, {
        action: input.action,
        declared: [...AUDIT_ACTIONS],
      });
    }
    const now = new Date();
    const actor = input.actor ?? { type: 'system' as const };
    const row = await this.db
      .insertInto('signature_audit_entries')
      .values({
        id: randomUUID(),
        request_id: input.requestId ?? null,
        connection_id: input.connectionId ?? null,
        recipient_id: input.recipientId ?? null,
        document_id: input.documentId ?? null,
        action: input.action,
        actor_type: actor.type,
        actor_id: actor.id ?? null,
        actor_name: actor.name?.slice(0, 200) ?? null,
        target_entity_type: input.target?.entityType ?? null,
        target_id: input.target?.id ?? null,
        outcome: input.outcome ?? 'ok',
        reason_safe: input.reasonSafe?.trim().slice(0, MAX_VALUE_LENGTH) || null,
        detail: JSON.stringify(redactDetail(input.detail ?? {})),
        correlation_id: input.correlationId?.trim().slice(0, 120) || null,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntry(row);
  }

  async listForRequest(requestId: string, options: { limit?: number } = {}): Promise<SignatureAuditEntry[]> {
    const rows = await this.db
      .selectFrom('signature_audit_entries')
      .selectAll()
      .where('request_id', '=', requestId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clamp(options.limit, 200))
      .execute();
    return rows.map((row) => toEntry(row));
  }

  async listForConnection(connectionId: string, options: { limit?: number } = {}): Promise<SignatureAuditEntry[]> {
    const rows = await this.db
      .selectFrom('signature_audit_entries')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clamp(options.limit, 200))
      .execute();
    return rows.map((row) => toEntry(row));
  }

  /** The event/audit timeline for the detail view (plan §13.4), read without touching either table. */
  async countFor(requestId: string): Promise<number> {
    const row = await this.db
      .selectFrom('signature_audit_entries')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('request_id', '=', requestId)
      .executeTakeFirst();
    return Number.parseInt(String(row?.n ?? '0'), 10) || 0;
  }
}

/**
 * Drop anything that looks like a credential, a URL, a body or raw content, at any depth.
 *
 * The key is what decides, not the value: a signer's email under `email` is legitimate evidence, the
 * same string under `signatureUrl` is a bearer credential and must never be recorded.
 */
export function redactDetail(detail: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === '__proto__' || key === 'constructor') continue;
    if (isForbiddenKey(key)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_VALUE_LENGTH);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 50).map((item) => (item !== null && typeof item === 'object' ? redactDetail(item as Record<string, unknown>, depth + 1) : item));
      continue;
    }
    if (typeof value === 'object') {
      out[key] = redactDetail(value as Record<string, unknown>, depth + 1);
      continue;
    }
    // A function, symbol or bigint is not a diagnostic, and recording its string form is how a
    // stack trace ends up in an audit row.
    out[key] = String(typeof value);
  }
  return out;
}

function toEntry(row: {
  id: string;
  request_id: string | null;
  connection_id: string | null;
  recipient_id: string | null;
  document_id: string | null;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  target_entity_type: string | null;
  target_id: string | null;
  outcome: string;
  reason_safe: string | null;
  detail: unknown;
  correlation_id: string | null;
  created_at: Date;
}): SignatureAuditEntry {
  return {
    id: row.id,
    requestId: row.request_id,
    connectionId: row.connection_id,
    recipientId: row.recipient_id,
    documentId: row.document_id,
    action: row.action as ESignatureAuditAction,
    actorType: row.actor_type as 'user' | 'system',
    actorId: row.actor_id,
    actorName: row.actor_name,
    targetEntityType: row.target_entity_type,
    targetId: row.target_id,
    outcome: row.outcome as 'ok' | 'refused',
    reasonSafe: row.reason_safe,
    detail: row.detail !== null && typeof row.detail === 'object' && !Array.isArray(row.detail) ? (row.detail as Record<string, unknown>) : {},
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}

function clamp(value: number | undefined, max: number): number {
  const limit = Math.trunc(value ?? 50);
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(limit, max);
}
