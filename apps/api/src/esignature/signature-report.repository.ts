import { Inject, Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import {
  likePattern,
  type RequestAccessScope,
  requestAccessSql,
} from './signature-request.repository.js';

/**
 * Phase 19-ES.19 — the read model behind the operational reports and the ESignature dashlet
 * (`PLAN_Phase_19_ESignature.md` §14, §18 `19-ES.19`).
 *
 * Every query starts from the same record-scope predicate the request list uses
 * (`requestAccessSql`), so a report can only ever aggregate rows the caller could open. The
 * projection is deliberately aggregate-shaped: counts, rates, durations and opaque ids. No query
 * here selects a recipient name, an email address, a document name, a subject line, a signing URL
 * or a token — the acceptance criterion "aggregate results do not leak inaccessible record details"
 * is met by never loading the detail in the first place.
 *
 * Time windows are bound parameters. Which timestamp a window applies to is a property of each
 * question, documented on the method:
 *
 *  - status snapshot and volume — requests **created** in the window;
 *  - outcome rates — the cohort **sent** in the window, so the denominator is a stable population;
 *  - time to completion — requests **completed** in the window;
 *  - current queues (approvals, waiting recipients, exceptions) — no window: they answer "now".
 */

export interface SignatureReportScope {
  readonly access: RequestAccessScope | undefined;
  /** `null` means all time. */
  readonly from: Date | null;
  readonly to: Date;
  readonly recipient?: string | undefined;
}

export interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export interface CompletionStats {
  readonly completed: number;
  readonly averageHours: number | null;
  readonly medianHours: number | null;
  readonly p90Hours: number | null;
}

export interface ApprovalQueueStats {
  readonly pending: number;
  readonly olderThan24Hours: number;
  readonly olderThan3Days: number;
  readonly oldestRequestedAt: string | null;
}

export interface WaitingRecipientStats {
  readonly requestsWaiting: number;
  readonly recipientsWaiting: number;
  readonly byStatus: readonly StatusCount[];
  readonly oldestSentAt: string | null;
}

export interface ExceptionStats {
  readonly total: number;
  readonly byStatus: readonly StatusCount[];
  readonly byFailureCategory: readonly { readonly category: string; readonly count: number }[];
  readonly oldestModifiedAt: string | null;
}

export interface VolumeStats {
  readonly total: number;
  readonly bySource: readonly { readonly sourceEntityType: string | null; readonly count: number }[];
  readonly byOwner: readonly { readonly ownerUserId: string | null; readonly count: number }[];
}

interface CountRow {
  readonly status: string;
  readonly count: number;
}

interface WaitingRow {
  readonly status: string | null;
  readonly recipients: number;
  readonly requests: number;
  readonly oldest: Date | null;
}

interface ExceptionRow {
  readonly status: string;
  readonly category: string;
  readonly count: number;
  readonly oldest: Date | null;
}

@Injectable()
export class SignatureReportRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /** Current status distribution of requests created in the window. */
  async statusCounts(scope: SignatureReportScope): Promise<StatusCount[]> {
    const rows = await sql<CountRow>`
      select q.status as status, count(*)::int as count
      from signature_requests q
      where q.deleted_at is null
        and q.created_at <= ${scope.to}
        and ${createdFrom(scope)}
        and ${access(scope)}
      group by q.status
      order by count desc, q.status asc
    `.execute(this.db);
    return rows.rows.map((row) => ({ status: row.status, count: row.count }));
  }

  /** The status a sent cohort ended in; the denominator of every outcome rate. */
  async sentCohort(scope: SignatureReportScope): Promise<StatusCount[]> {
    const rows = await sql<CountRow>`
      select q.status as status, count(*)::int as count
      from signature_requests q
      where q.deleted_at is null
        and q.sent_at is not null
        and q.sent_at <= ${scope.to}
        and ${sentFrom(scope)}
        and ${access(scope)}
      group by q.status
      order by count desc, q.status asc
    `.execute(this.db);
    return rows.rows.map((row) => ({ status: row.status, count: row.count }));
  }

  /** Completed requests' sent→completed duration, in hours. */
  async completionStats(scope: SignatureReportScope): Promise<CompletionStats> {
    const rows = await sql<{
      completed: number;
      average_hours: number | null;
      median_hours: number | null;
      p90_hours: number | null;
    }>`
      select count(*)::int as completed,
             avg(extract(epoch from (q.completed_at - q.sent_at)) / 3600.0)::float8 as average_hours,
             (percentile_cont(0.5) within group (order by extract(epoch from (q.completed_at - q.sent_at)) / 3600.0))::float8 as median_hours,
             (percentile_cont(0.9) within group (order by extract(epoch from (q.completed_at - q.sent_at)) / 3600.0))::float8 as p90_hours
      from signature_requests q
      where q.deleted_at is null
        and q.status = 'completed'
        and q.sent_at is not null
        and q.completed_at is not null
        and q.completed_at >= q.sent_at
        and q.completed_at <= ${scope.to}
        and ${completedFrom(scope)}
        and ${access(scope)}
    `.execute(this.db);
    const row = rows.rows[0];
    return {
      completed: row?.completed ?? 0,
      averageHours: row?.average_hours ?? null,
      medianHours: row?.median_hours ?? null,
      p90Hours: row?.p90_hours ?? null,
    };
  }

  /** The current approval queue, aged from the moment the decision was requested. */
  async approvalQueue(scope: SignatureReportScope): Promise<ApprovalQueueStats> {
    const rows = await sql<{
      pending: number;
      older_than_24h: number;
      older_than_3d: number;
      oldest: Date | null;
    }>`
      select count(*)::int as pending,
             count(*) filter (where q.approval_requested_at < now() - interval '24 hours')::int as older_than_24h,
             count(*) filter (where q.approval_requested_at < now() - interval '3 days')::int as older_than_3d,
             min(q.approval_requested_at) as oldest
      from signature_requests q
      where q.deleted_at is null
        and q.status = 'pending_approval'
        and q.approval_status = 'pending'
        and ${access(scope)}
    `.execute(this.db);
    const row = rows.rows[0];
    return {
      pending: row?.pending ?? 0,
      olderThan24Hours: row?.older_than_24h ?? 0,
      olderThan3Days: row?.older_than_3d ?? 0,
      oldestRequestedAt: iso(row?.oldest ?? null),
    };
  }

  /**
   * Outstanding recipients on envelopes that are still in flight.
   *
   * "Outstanding" is the recipient statuses that still need a signature or a view (pending, sent,
   * delivered, viewed); a request is counted once even when several of its recipients are waiting.
   * The optional `recipient` term narrows both counts inside the caller's scope.
   */
  async waitingRecipients(scope: SignatureReportScope): Promise<WaitingRecipientStats> {
    const pattern = likePattern(scope.recipient);
    const recipientClause =
      pattern === undefined
        ? sql<boolean>`true`
        : sql<boolean>`(r.name ilike ${pattern} or r.email ilike ${pattern})`;
    const rows = await sql<WaitingRow>`
      select r.status as status,
             count(*)::int as recipients,
             count(distinct r.request_id)::int as requests,
             min(r.sent_at) as oldest
      from signature_recipients r
      join signature_requests q on q.id = r.request_id
      where r.deleted_at is null
        and q.deleted_at is null
        and q.status in ('sent', 'delivered', 'partially_signed')
        and r.status in ('pending', 'sent', 'delivered', 'viewed')
        and ${recipientClause}
        and ${access(scope)}
      group by grouping sets ((r.status), ())
    `.execute(this.db);
    let requestsWaiting = 0;
    let recipientsWaiting = 0;
    let oldest: Date | null = null;
    const byStatus: StatusCount[] = [];
    for (const row of rows.rows) {
      if (row.status === null) {
        requestsWaiting = row.requests;
        recipientsWaiting = row.recipients;
        oldest = row.oldest;
      } else {
        byStatus.push({ status: row.status, count: row.recipients });
      }
    }
    byStatus.sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
    return {
      requestsWaiting,
      recipientsWaiting,
      byStatus,
      oldestSentAt: iso(oldest),
    };
  }

  /** The current exception queue: ambiguous sends, provider failures and drift needing reconciliation. */
  async exceptionStats(scope: SignatureReportScope): Promise<ExceptionStats> {
    const rows = await sql<ExceptionRow>`
      select q.status as status,
             coalesce(q.failure_category, 'none') as category,
             count(*)::int as count,
             min(q.modified_at) as oldest
      from signature_requests q
      where q.deleted_at is null
        and q.status in ('send_unknown', 'provider_error', 'reconciliation_required')
        and ${access(scope)}
      group by q.status, coalesce(q.failure_category, 'none')
    `.execute(this.db);
    const byStatus = new Map<string, number>();
    const byCategory = new Map<string, number>();
    let total = 0;
    let oldest: Date | null = null;
    for (const row of rows.rows) {
      total += row.count;
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count);
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.count);
      if (row.oldest !== null && (oldest === null || row.oldest < oldest)) oldest = row.oldest;
    }
    return {
      total,
      byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })).sort(byCountDesc),
      byFailureCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort(byCountDesc),
      oldestModifiedAt: iso(oldest),
    };
  }

  /** Requests created in the window, grouped by the CRM source module and by their owner. */
  async volume(scope: SignatureReportScope): Promise<VolumeStats> {
    const totals = await sql<{ total: number }>`
      select count(*)::int as total
      from signature_requests q
      where q.deleted_at is null
        and q.created_at <= ${scope.to}
        and ${createdFrom(scope)}
        and ${access(scope)}
    `.execute(this.db);
    const sources = await sql<{ source: string | null; count: number }>`
      select q.source_entity_type as source, count(*)::int as count
      from signature_requests q
      where q.deleted_at is null
        and q.created_at <= ${scope.to}
        and ${createdFrom(scope)}
        and ${access(scope)}
      group by q.source_entity_type
      order by count desc, q.source_entity_type asc nulls last
      limit 50
    `.execute(this.db);
    const owners = await sql<{ owner: string | null; count: number }>`
      select q.assigned_user_id as owner, count(*)::int as count
      from signature_requests q
      where q.deleted_at is null
        and q.created_at <= ${scope.to}
        and ${createdFrom(scope)}
        and ${access(scope)}
      group by q.assigned_user_id
      order by count desc, q.assigned_user_id asc nulls last
      limit 50
    `.execute(this.db);
    return {
      total: totals.rows[0]?.total ?? 0,
      bySource: sources.rows.map((row) => ({ sourceEntityType: row.source, count: row.count })),
      byOwner: owners.rows.map((row) => ({ ownerUserId: row.owner, count: row.count })),
    };
  }
}

function createdFrom(scope: SignatureReportScope): RawBuilder<boolean> {
  return scope.from === null ? sql<boolean>`true` : sql<boolean>`q.created_at >= ${scope.from}`;
}

function sentFrom(scope: SignatureReportScope): RawBuilder<boolean> {
  return scope.from === null ? sql<boolean>`true` : sql<boolean>`q.sent_at >= ${scope.from}`;
}

function completedFrom(scope: SignatureReportScope): RawBuilder<boolean> {
  return scope.from === null ? sql<boolean>`true` : sql<boolean>`q.completed_at >= ${scope.from}`;
}

function access(scope: SignatureReportScope): RawBuilder<boolean> {
  return requestAccessSql(scope.access, 'q') ?? sql<boolean>`true`;
}

function iso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function byCountDesc(
  left: { readonly count: number },
  right: { readonly count: number },
): number {
  return right.count - left.count;
}
