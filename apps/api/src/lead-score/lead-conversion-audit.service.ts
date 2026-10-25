import { RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ConversionResultView, OperationRecord } from './lead-conversion.service.js';
import { LeadConversionService } from './lead-conversion.service.js';
import {
  leadScoreConversionInFlightError,
  leadScoreConversionNeedsRecoveryError,
  leadScoreModuleDisabledError,
} from './lead-score-errors.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import { CONVERSION_STATUSES,type ConversionStatus } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.13 — the other half of the operation record: reading it, recovering it, and closing it
 * (plan §7.8, §8.3, §11.4, §14.3; audit §11 `LS.13`; contract §10, §11).
 *
 * Three jobs, all behind `conversionAuditRead` for the reads and `conversionRecover` for the writes:
 *
 *  - **show** what happened. A row is readable through this service and nowhere else: the entity is
 *    `read: 'no'` on purpose, and the capability is a synthetic resource rather than that entity's own read, so
 *    granting it does not open the generic record API (contract §13.2).
 *  - **retry** an attempt that a transient failure or a crash left behind — never by inventing a new plan, and
 *    never before the accounting in contract §10.3 proves that nothing a first attempt wrote is unaccounted for.
 *  - **close** a row a human decides not to retry, so the operations list stops asking.
 *
 * The Lead's label in a row is shown only when the caller may read that Lead; the operation itself is the
 * audit subject, so the row is visible to whoever holds the right, but it never becomes a way to read a Lead.
 */
export interface OperationView {
  readonly operationId: string;
  readonly operationKey: string;
  readonly leadId: string;
  readonly leadLabel: string | null;
  readonly status: ConversionStatus;
  readonly requestedTargets: readonly string[];
  readonly requestedAt: string | null;
  readonly confirmedAt: string | null;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
  readonly createdAccountId: string | null;
  readonly createdContactId: string | null;
  readonly createdOpportunityId: string | null;
  readonly linkedAccountId: string | null;
  readonly linkedContactId: string | null;
  readonly linkedOpportunityId: string | null;
  readonly stale: boolean;
  readonly canRetry: boolean;
  readonly canClose: boolean;
}

export interface OperationListView {
  readonly total: number;
  readonly limit: number;
  readonly items: readonly OperationView[];
}

export interface RecoveryView {
  readonly started: boolean;
  readonly skipped: 'disabled' | 'nothingStale' | null;
  readonly scanned: number;
  readonly retryable: readonly string[];
  readonly review: readonly string[];
}

/** A selected row as the service reads it: the store keeps a `name` column and `attrs`, the service uses `data`. */
interface SelectedRow {
  readonly id: string;
  readonly attrs: Record<string, unknown>;
}

function recordOf(row: SelectedRow): OperationRecord {
  return { id: row.id, data: row.attrs };
}

const OPERATION_ENTITY = 'LeadConversionOperation';

@Injectable()
export class LeadConversionAuditService {
  constructor(
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadConversionService) private readonly conversion: LeadConversionService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Bounded list of operations, newest first, optionally by state and by "older than N minutes". */
  async operations(query: { readonly status?: ConversionStatus | undefined; readonly staleAfterMinutes?: number | undefined; readonly limit: number }): Promise<OperationListView> {
    await this.assertReadable();
    const cutoff = query.staleAfterMinutes === undefined ? null : new Date(Date.now() - query.staleAfterMinutes * 60_000).toISOString();
    const rows = await sql<SelectedRow>`
      select id, attrs from entity_records
       where entity_type = ${OPERATION_ENTITY} and deleted_at is null
         ${query.status === undefined ? sql`` : sql`and attrs->>'status' = ${query.status}`}
         ${cutoff === null ? sql`` : sql`and attrs->>'status' = 'processing' and attrs->>'requestedAt' < ${cutoff}`}
       order by attrs->>'requestedAt' desc
       limit ${query.limit}
    `.execute(this.database.db);
    const records = rows.rows.map(recordOf);
    const labels = await this.leadLabels(records);
    const now = Date.now();
    return {
      total: records.length,
      limit: query.limit,
      items: records.map((record) => viewOf(record, labels.get(String(record.data['sourceLeadId'] ?? '')) ?? null, now)),
    };
  }

  /** One operation, by id. A missing id is a 404 and says nothing about whether it ever existed. */
  async operation(operationId: string): Promise<OperationView> {
    await this.assertReadable();
    const row = await this.conversion.operationById(operationId);
    if (row === undefined) throw new RecordNotFoundError(OPERATION_ENTITY, operationId);
    const labels = await this.leadLabels([row]);
    return viewOf(row, labels.get(String(row.data['sourceLeadId'] ?? '')) ?? null, Date.now());
  }

  /**
   * Re-run an attempt, after proving that a retry cannot duplicate anything (contract §10.2–§10.3).
   *
   * The retry keeps the operation's key: it is a retry *of that attempt*, and a new key would make the
   * duplicate-target question unanswerable. If the accounting is not clean the row becomes `needs_review` — the
   * honest answer when the module cannot prove what exists — and nothing is written to a record.
   */
  async retry(operationId: string): Promise<ConversionResultView> {
    await this.gate.assertOperation('conversionRetry');
    const row = await this.conversion.operationById(operationId);
    if (row === undefined) throw new RecordNotFoundError(OPERATION_ENTITY, operationId);
    const status = statusOf(row.data['status']);
    if (status !== 'failed_retryable' && status !== 'needs_review') {
      throw new ValidationError('Only a retryable or reviewable operation can be retried.', { operationId, state: status });
    }
    const accounting = await this.account(row);
    if (!accounting.safeToRetry) {
      await this.conversion.settle(operationId, 'needs_review', accounting.code ?? 'inconsistent', null);
      throw leadScoreConversionNeedsRecoveryError(operationId, accounting.code ?? 'inconsistent');
    }
    if (!(await this.conversion.reclaim(operationId))) throw leadScoreConversionInFlightError(operationId);
    const claimed = await this.conversion.operationById(operationId);
    if (claimed === undefined) throw new RecordNotFoundError(OPERATION_ENTITY, operationId);
    return this.conversion.resume(claimed);
  }

  /** Mark a reviewable row as finally failed. The row keeps its history; the state says a human decided. */
  async close(operationId: string, reason: string | null): Promise<OperationView> {
    await this.gate.assertOperation('conversionRetry');
    const row = await this.conversion.operationById(operationId);
    if (row === undefined) throw new RecordNotFoundError(OPERATION_ENTITY, operationId);
    const status = statusOf(row.data['status']);
    if (status !== 'needs_review') throw new ValidationError('Only an operation awaiting review can be closed.', { operationId, state: status });
    await this.conversion.settle(operationId, 'failed_final', stringOf(row.data['failureCode']) ?? 'closed_by_operator', {
      decision: reason ?? 'closed_by_operator',
    });
    const closed = await this.conversion.operationById(operationId);
    if (closed === undefined) throw new RecordNotFoundError(OPERATION_ENTITY, operationId);
    const labels = await this.leadLabels([closed]);
    return viewOf(closed, labels.get(String(closed.data['sourceLeadId'] ?? '')) ?? null, Date.now());
  }

  /**
   * The stuck-row scan (contract §11.2).
   *
   * Off by default. It settles `processing` rows older than the threshold and **never touches a record**: a row
   * with no target ids and a Lead that is not converted is `failed_retryable`; anything the module cannot prove
   * becomes `needs_review`. It never re-runs a conversion — a retry is an administrator's explicit act.
   */
  async recoverStuck(): Promise<RecoveryView> {
    await this.gate.assertOperation('conversionRetry');
    const recovery = (await this.settings.settings()).conversion.recovery;
    if (recovery.enabled !== true) return { started: false, skipped: 'disabled', scanned: 0, retryable: [], review: [] };

    const cutoff = new Date(Date.now() - recovery.staleAfterMinutes * 60_000).toISOString();
    const rows = await sql<SelectedRow>`
      select id, attrs from entity_records
       where entity_type = ${OPERATION_ENTITY} and deleted_at is null
         and attrs->>'status' = 'processing'
         and attrs->>'requestedAt' is not null
         and attrs->>'requestedAt' < ${cutoff}
       order by attrs->>'requestedAt' asc
       limit ${recovery.limit}
    `.execute(this.database.db);
    if (rows.rows.length === 0) return { started: true, skipped: 'nothingStale', scanned: 0, retryable: [], review: [] };

    const retryable: string[] = [];
    const review: string[] = [];
    for (let index = 0; index < rows.rows.length; index += recovery.chunkSize) {
      for (const row of rows.rows.slice(index, index + recovery.chunkSize)) {
        const accounting = await this.account(recordOf(row));
        if (accounting.safeToRetry) {
          await this.conversion.settle(row.id, 'failed_retryable', 'interrupted', null);
          retryable.push(row.id);
        } else {
          await this.conversion.settle(row.id, 'needs_review', accounting.code ?? 'inconsistent', null);
          review.push(row.id);
        }
      }
    }
    return { started: true, skipped: null, scanned: rows.rows.length, retryable, review };
  }

  /**
   * The accounting of contract §10.3, as code.
   *
   * A retry may only run when the attempt provably wrote nothing: no recorded target id, no missing target, and
   * a Lead that is not converted. Everything else is a question for a person, because the module cannot tell a
   * half-applied operation from one that never started (and T2's transaction is built so the first cannot
   * happen — this is the check that would catch it if that ever changed).
   */
  private async account(row: OperationRecord): Promise<{ safeToRetry: boolean; code: string | null }> {
    const ids = ['createdAccountId', 'createdContactId', 'createdOpportunityId', 'linkedAccountId', 'linkedContactId', 'linkedOpportunityId']
      .map((field) => stringOf(row.data[field]))
      .filter((id): id is string => id !== null);
    if (ids.length > 0) {
      const found = await sql<{ count: number }>`select count(*)::int as count from entity_records where id in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}) and deleted_at is null`.execute(this.database.db);
      if (Number(found.rows[0]?.count ?? 0) !== ids.length) return { safeToRetry: false, code: 'target_missing' };
      // A row that names targets is only ever settled by hand, even when they all exist.
      return { safeToRetry: false, code: 'inconsistent' };
    }
    const leadId = String(row.data['sourceLeadId'] ?? '');
    const leads = await sql<{ attrs: Record<string, unknown> }>`
      select attrs from entity_records where id = ${leadId} and entity_type = 'Lead' and deleted_at is null limit 1
    `.execute(this.database.db);
    const lead = leads.rows[0];
    if (lead === undefined) return { safeToRetry: false, code: 'target_missing' };
    if (lead.attrs['status'] === 'Converted' || stringOf(lead.attrs['conversionOperationId']) !== null) {
      return { safeToRetry: false, code: 'inconsistent' };
    }
    return { safeToRetry: true, code: null };
  }

  /** Reading operations needs the module on and the audit right; both are checked here, not only at the route. */
  private async assertReadable(): Promise<void> {
    if ((await this.settings.enabled()) !== true) throw leadScoreModuleDisabledError('enabled');
    await this.permissions.assert('conversionAuditRead');
  }

  /** Lead labels for a bounded page of operations, and only for the Leads this caller may read. */
  private async leadLabels(rows: readonly OperationRecord[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(rows.map((row) => String(row.data['sourceLeadId'] ?? '')).filter((id) => id !== ''))];
    const labels = new Map<string, string | null>();
    if (ids.length === 0) return labels;
    const leads = await sql<{ id: string; name: string | null; assigned_user_id: string | null; created_by_id: string | null; team_ids: unknown; attrs: Record<string, unknown> }>`
      select id, name, assigned_user_id, created_by_id, team_ids, attrs from entity_records
       where entity_type = 'Lead' and id in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}) and deleted_at is null
    `.execute(this.database.db);
    for (const lead of leads.rows) {
      const decision = await this.acl.canAccessRecord('Lead', 'read', {
        id: lead.id,
        ...(lead.assigned_user_id === null ? {} : { assignedUserId: lead.assigned_user_id }),
        ...(lead.created_by_id === null ? {} : { createdById: lead.created_by_id }),
        teams: Array.isArray(lead.team_ids) ? lead.team_ids.filter((entry): entry is string => typeof entry === 'string') : [],
        data: lead.attrs,
      });
      labels.set(lead.id, decision.allowed ? (lead.name ?? null) : null);
    }
    return labels;
  }
}

/** One row as the operations screen reads it. `stale` is computed, not stored: a row is stale when it is old. */
function viewOf(row: OperationRecord, leadLabel: string | null, now: number): OperationView {
  const status = statusOf(row.data['status']);
  const requestedAt = instantOf(row.data['requestedAt']);
  const stale = status === 'processing' && requestedAt !== null && now - Date.parse(requestedAt) > 60 * 60_000;
  return {
    operationId: row.id,
    operationKey: String(row.data['operationKey'] ?? ''),
    leadId: String(row.data['sourceLeadId'] ?? ''),
    leadLabel,
    status,
    requestedTargets: Array.isArray(row.data['requestedTargets']) ? row.data['requestedTargets'].map((entry) => String(entry)) : [],
    requestedAt,
    confirmedAt: instantOf(row.data['confirmedAt']),
    completedAt: instantOf(row.data['completedAt']),
    failureCode: stringOf(row.data['failureCode']),
    createdAccountId: stringOf(row.data['createdAccountId']),
    createdContactId: stringOf(row.data['createdContactId']),
    createdOpportunityId: stringOf(row.data['createdOpportunityId']),
    linkedAccountId: stringOf(row.data['linkedAccountId']),
    linkedContactId: stringOf(row.data['linkedContactId']),
    linkedOpportunityId: stringOf(row.data['linkedOpportunityId']),
    stale,
    canRetry: status === 'failed_retryable' || status === 'needs_review',
    canClose: status === 'needs_review',
  };
}

function statusOf(value: unknown): ConversionStatus {
  return (CONVERSION_STATUSES as readonly string[]).includes(String(value)) ? (value as ConversionStatus) : 'processing';
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function instantOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}
