import { Inject, Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { type RequestAccessScope, requestAccessSql } from './signature-request.repository.js';

/**
 * Phase 19-ES.20 — the recovery read model (`PLAN_Phase_19_ESignature.md` §14, §16, §18).
 *
 * Every request list here is filtered by the same record-scope predicate the request list uses, so
 * an operator with `connectionRead` but a narrow `SignatureRequest` scope never learns that a
 * request outside that scope exists. Rows deliberately omit the request name, the source record and
 * every recipient field: a workbench row is an id, a status, a timing and a sanitized failure code,
 * and the detail page remains the place where ACL decides what may be read.
 */

export type RecoveryKind = 'failed' | 'stuck' | 'sendUnknown' | 'reconciliation';

export interface RecoveryRequestRow {
  readonly id: string;
  readonly status: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly modifiedAt: string;
  readonly lastProviderSyncAt: string | null;
  readonly expiresAt: string | null;
  readonly failureCategory: string | null;
  readonly failureCode: string | null;
  readonly failureMessageSafe: string | null;
  readonly ageHours: number;
  /** `false` for `provider_error`: recovery there is a deliberate send, never reconciliation. */
  readonly reconcileAllowed: boolean;
}

export interface RecoveryRequestList {
  readonly items: readonly RecoveryRequestRow[];
  readonly count: number;
}

export interface FailedJobRow {
  readonly id: string;
  readonly job: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly targets: { readonly requestId: string | null; readonly inboxId: string | null };
}

export interface FailedJobList {
  readonly items: readonly FailedJobRow[];
  readonly count: number;
}

const SENDING_STUCK_MINUTES = 15;

interface RequestRow {
  readonly id: string;
  readonly status: string;
  readonly connection_id: string | null;
  readonly provider_envelope_id: string | null;
  readonly created_at: Date;
  readonly sent_at: Date | null;
  readonly modified_at: Date;
  readonly last_provider_sync_at: Date | null;
  readonly expires_at: Date | null;
  readonly failure_category: string | null;
  readonly failure_code: string | null;
  readonly failure_message_safe: string | null;
}

@Injectable()
export class SignatureOperationsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  async requests(
    kind: RecoveryKind,
    scope: RequestAccessScope,
    options: { readonly limit: number; readonly staleAfterHours: number },
  ): Promise<RecoveryRequestList> {
    const condition = kindCondition(kind, options.staleAfterHours);
    const access = requestAccessSql(scope, 'q') ?? sql<boolean>`true`;
    const counted = await sql<{ total: number }>`
      select count(*)::int as total
      from signature_requests q
      where q.deleted_at is null and ${condition} and ${access}
    `.execute(this.db);
    const rows = await sql<RequestRow>`
      select q.id, q.status, q.connection_id, q.provider_envelope_id,
             q.created_at, q.sent_at, q.modified_at, q.last_provider_sync_at, q.expires_at,
             q.failure_category, q.failure_code, q.failure_message_safe
      from signature_requests q
      where q.deleted_at is null and ${condition} and ${access}
      order by q.modified_at asc
      limit ${Math.min(Math.max(options.limit, 1), 100)}
    `.execute(this.db);
    return {
      items: rows.rows.map((row) => toRecoveryRow(row)),
      count: counted.rows[0]?.total ?? 0,
    };
  }

  /** One grouped read for the connection table: request counts per connection and status. */
  async requestCountsByConnection(): Promise<Map<string, Record<string, number>>> {
    const rows = await sql<{ connection_id: string; status: string; count: number }>`
      select connection_id, status, count(*)::int as count
      from signature_requests
      where deleted_at is null and connection_id is not null
      group by connection_id, status
    `.execute(this.db);
    const out = new Map<string, Record<string, number>>();
    for (const row of rows.rows) {
      const entry = out.get(row.connection_id) ?? {};
      entry[row.status] = row.count;
      out.set(row.connection_id, entry);
    }
    return out;
  }

  /** One grouped read for the connection table: webhook backlog per connection. */
  async webhookCountsByConnection(): Promise<
    Map<string, { pending: number; retryable: number; deadLetter: number; invalid: number; lastReceivedAt: string | null }>
  > {
    const rows = await sql<{
      connection_id: string;
      pending: number;
      retryable: number;
      dead_letter: number;
      invalid: number;
      last_received_at: Date | null;
    }>`
      select connection_id,
             count(*) filter (where state in ('received', 'retryable'))::int as pending,
             count(*) filter (where state = 'retryable')::int as retryable,
             count(*) filter (where state = 'dead_letter')::int as dead_letter,
             count(*) filter (where signature_status = 'invalid')::int as invalid,
             max(received_at) as last_received_at
      from signature_webhook_inbox
      where connection_id is not null
      group by connection_id
    `.execute(this.db);
    const out = new Map<
      string,
      { pending: number; retryable: number; deadLetter: number; invalid: number; lastReceivedAt: string | null }
    >();
    for (const row of rows.rows) {
      out.set(row.connection_id, {
        pending: row.pending,
        retryable: row.retryable,
        deadLetter: row.dead_letter,
        invalid: row.invalid,
        lastReceivedAt: row.last_received_at?.toISOString() ?? null,
      });
    }
    return out;
  }

  /**
   * Failed ESignature background jobs.
   *
   * Only this module's job names are read, and only the two payload keys this module itself writes
   * are returned. A job row's `target` is otherwise untyped JSON; echoing it would make the
   * workbench a display surface for whatever any future job happened to put there.
   */
  async failedJobs(limit: number): Promise<FailedJobList> {    const bounded = Math.min(Math.max(limit, 1), 100);
    const counted = await sql<{ total: number }>`
      select count(*)::int as total from jobs where job like 'esignature.%' and status = 'failed'
    `.execute(this.db);
    const rows = await sql<{
      id: string;
      job: string;
      status: string;
      attempt: number;
      max_attempts: number;
      last_error: string | null;
      created_at: Date;
      finished_at: Date | null;
      target: unknown;
    }>`
      select id, job, status, attempt, max_attempts, last_error, created_at, finished_at, target
      from jobs
      where job like 'esignature.%' and status = 'failed'
      order by coalesce(finished_at, created_at) desc
      limit ${bounded}
    `.execute(this.db);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        job: row.job,
        status: row.status,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        lastError: row.last_error === null ? null : row.last_error.slice(0, 500),
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
        targets: {
          requestId: safeTargetString(row.target, 'requestId'),
          inboxId: safeTargetString(row.target, 'inboxId'),
        },
      })),
      count: counted.rows[0]?.total ?? 0,
    };
  }
}

function kindCondition(kind: RecoveryKind, staleAfterHours: number): RawBuilder<boolean> {
  switch (kind) {
    case 'failed':
      return sql<boolean>`q.status = 'provider_error'`;
    case 'sendUnknown':
      return sql<boolean>`q.status = 'send_unknown'`;
    case 'reconciliation':
      return sql<boolean>`q.status = 'reconciliation_required'`;
    case 'stuck':
      return sql<boolean>`(
        (q.status = 'sending' and q.modified_at <= now() - (${SENDING_STUCK_MINUTES} * interval '1 minute'))
        or (
          q.status in ('sent', 'delivered', 'partially_signed')
          and (
            q.expires_at < now()
            or coalesce(q.last_provider_sync_at, q.sent_at, q.modified_at)
               <= now() - (${staleAfterHours} * interval '1 hour')
          )
        )
      )`;
  }
}

function toRecoveryRow(row: RequestRow): RecoveryRequestRow {
  const reference =
    row.status === 'sent' || row.status === 'delivered' || row.status === 'partially_signed'
      ? (row.last_provider_sync_at ?? row.sent_at ?? row.modified_at)
      : row.modified_at;
  const ageHours = Math.max(0, (Date.now() - reference.getTime()) / 3_600_000);
  return {
    id: row.id,
    status: row.status,
    connectionId: row.connection_id,
    providerEnvelopeId: row.provider_envelope_id,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    modifiedAt: row.modified_at.toISOString(),
    lastProviderSyncAt: row.last_provider_sync_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    failureCategory: row.failure_category,
    failureCode: row.failure_code,
    failureMessageSafe: row.failure_message_safe,
    ageHours: Math.round(ageHours * 10) / 10,
    // Reconciliation is allowed on every recovery state except a definite send refusal. A failed
    // send needs the deliberate recover→send path, which this workbench never performs.
    reconcileAllowed: row.status !== 'provider_error',
  };
}

function safeTargetString(target: unknown, key: string): string | null {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
  const value = (target as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
