import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { IntegrationAuditService } from './integration-audit.service.js';

/**
 * Phase 19-INT.26 — the retention policy
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.3, §16.3; `19-INT.26`).
 *
 * The plan asks for *"per-provider/payload retention periods and purge routines for raw payload
 * diagnostics"*, and it asks for them to be **explicit** rather than implicit: a deployment must
 * decide, with its own policy, that a diagnostic row may be discarded.
 *
 * Four properties of this purge:
 *
 *  1. **It is off by default.** The setting `retention.enabled` defaults to `false`, so a fresh
 *     installation keeps everything until an administrator turns the purge on. A purge that ran
 *     unasked would be a surprise, and a surprise that deletes rows is a bad one.
 *  2. **It is narrow.** Every statement deletes by **primary key**, in a bounded batch, with a
 *     precise predicate: "older than the cutoff" **and** "in a terminal state". There is no
 *     `TRUNCATE`, no table-wide `DELETE`, and no predicate that is not about age and state. A CRM
 *     record is never touched — the module's tables hold diagnostics, and the CRM's data is not
 *     the module's to delete.
 *  3. **It keeps the decisions.** A conflict that was resolved, a dead letter that was replayed
 *     and an enrichment result that was decided are *history*. Their **payload** goes; the fact
 *     that they existed, and the audit row that explains it, stays for the audit trail's own
 *     retention period.
 *  4. **It reports what it did.** The purge returns the counts, so an operator can see what a
 *     policy removed instead of discovering it later.
 */

/** What one purge pass removed. */
export interface RetentionPurgeReport {
  /** Whether the purge was enabled at all. */
  readonly enabled: boolean;
  /** The cutoff the pass used. */
  readonly cutoff: Readonly<Record<string, string>>;
  readonly removed: {
    /** Sync operation rows whose redacted payload was cleared. The row itself is kept as history. */
    readonly syncOperations: number;
    /** Webhook delivery rows whose raw payload was cleared. The dedup key is kept. */
    readonly webhookDeliveries: number;
    readonly resolvedConflicts: number;
    readonly deadLetters: number;
    readonly finishedRuns: number;
    readonly enrichmentResults: number;
    readonly auditRows: number;
  };
  /** The total the pass cleared or removed. */
  readonly total: number;
}

/** The job that runs the purge. */
export const RETENTION_PURGE_JOB = 'advancedIntegrations.purgeRetention';

@Injectable()
export class IntegrationRetentionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdvancedIntegrationsSettingsService) private readonly settings: AdvancedIntegrationsSettingsService,
    @Inject(IntegrationAuditService) private readonly audit: IntegrationAuditService,
  ) {}

  /**
   * Run one purge pass.
   *
   * The pass is **idempotent**: a second run finds nothing left to remove, and the counts say so.
   */
  async purge(): Promise<RetentionPurgeReport> {
    const settings = await this.settings.settings();
    const policy = settings.retention;
    const empty = {
      syncOperations: 0,
      webhookDeliveries: 0,
      resolvedConflicts: 0,
      deadLetters: 0,
      finishedRuns: 0,
      enrichmentResults: 0,
      auditRows: 0,
    };
    if (!policy.enabled) {
      return { enabled: false, cutoff: {}, removed: empty, total: 0 };
    }

    const batch = policy.batchSize;
    const now = new Date();

    // A sync operation's redacted payload. The operation row itself is the history — and it holds
    // the `idempotency_key` that makes a replay a replay — so only the payload it carried goes.
    // Deleting the row would hand the key back, and a provider that redelivers the same object
    // afterwards would be applied a second time.
    const operations = await sql<{ id: string }>`
      update integration_sync_operations
      set payload = null
      where id in (
        select id from integration_sync_operations
        where payload is not null and created_at < ${new Date(now.getTime() - policy.syncOperationsDays * 86_400_000)}
        order by created_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // A webhook delivery's raw provider payload — the largest and most personal thing the module
    // stores. A rejected delivery's payload was never stored at all, so only the accepted ones
    // are here. The row stays: it carries the `(connection_id, delivery_id)` dedup key, and a
    // provider that redelivers the same delivery after the window must still be told it is a
    // duplicate rather than being applied again.
    const deliveries = await sql<{ id: string }>`
      update integration_webhook_deliveries
      set payload = null
      where id in (
        select id from integration_webhook_deliveries
        where payload is not null and received_at < ${new Date(now.getTime() - policy.webhookDeliveriesDays * 86_400_000)}
        order by received_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // A resolved conflict keeps its verdict; only the two snapshots go.
    const conflicts = await sql<{ id: string }>`
      delete from integration_conflicts
      where id in (
        select id from integration_conflicts
        where resolved_at is not null and created_at < ${new Date(now.getTime() - policy.conflictsDays * 86_400_000)}
        order by created_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // A dead letter that was replayed or discarded is history; its payload is not.
    const deadLetters = await sql<{ id: string }>`
      delete from integration_dead_letters
      where id in (
        select id from integration_dead_letters
        where status in ('replayed', 'discarded') and created_at < ${new Date(now.getTime() - policy.deadLettersDays * 86_400_000)}
        order by created_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // A finished run. A queued or running run is never touched.
    const runs = await sql<{ id: string }>`
      delete from integration_sync_runs
      where id in (
        select id from integration_sync_runs
        where status in ('completed', 'failed', 'cancelled') and created_at < ${new Date(now.getTime() - policy.syncRunsDays * 86_400_000)}
        order by created_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // An enrichment result that was decided. A pending result is a decision somebody still owes.
    const enrichment = await sql<{ id: string }>`
      delete from integration_enrichment_results
      where id in (
        select id from integration_enrichment_results
        where status in ('accepted', 'rejected', 'expired') and retrieved_at < ${new Date(now.getTime() - policy.enrichmentResultsDays * 86_400_000)}
        order by retrieved_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    // The audit trail, last: it explains everything above.
    const auditRows = await sql<{ id: string }>`
      delete from integration_audit_log
      where id in (
        select id from integration_audit_log
        where created_at < ${new Date(now.getTime() - policy.auditLogDays * 86_400_000)}
        order by created_at asc
        limit ${batch}
      )
      returning id
    `.execute(this.database.db);

    const removed = {
      syncOperations: operations.rows.length,
      webhookDeliveries: deliveries.rows.length,
      resolvedConflicts: conflicts.rows.length,
      deadLetters: deadLetters.rows.length,
      finishedRuns: runs.rows.length,
      enrichmentResults: enrichment.rows.length,
      auditRows: auditRows.rows.length,
    };
    const total = Object.values(removed).reduce((sum, value) => sum + value, 0);

    if (total > 0) {
      await this.audit.record({
        action: 'retention.purged',
        reason: 'The scheduled retention purge ran.',
        detail: { ...removed, total },
      });
    }

    return {
      enabled: true,
      cutoff: {
        syncOperations: new Date(now.getTime() - policy.syncOperationsDays * 86_400_000).toISOString(),
        webhookDeliveries: new Date(now.getTime() - policy.webhookDeliveriesDays * 86_400_000).toISOString(),
        conflicts: new Date(now.getTime() - policy.conflictsDays * 86_400_000).toISOString(),
        deadLetters: new Date(now.getTime() - policy.deadLettersDays * 86_400_000).toISOString(),
        syncRuns: new Date(now.getTime() - policy.syncRunsDays * 86_400_000).toISOString(),
        enrichmentResults: new Date(now.getTime() - policy.enrichmentResultsDays * 86_400_000).toISOString(),
        auditLog: new Date(now.getTime() - policy.auditLogDays * 86_400_000).toISOString(),
      },
      removed,
      total,
    };
  }
}
