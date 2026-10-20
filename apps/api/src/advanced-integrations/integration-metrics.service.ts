import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-INT.26 — the module's metrics
 * (`PLAN_Phase_19_Advanced_Integrations.md` §16.1; `19-INT.26`).
 *
 * The platform has **no metrics or telemetry facility** (the compatibility document says so
 * plainly), and building one is not this module's job. So the metrics here are **derived**: they
 * are computed from the module's own tables — the same tables the operator already trusts — and
 * exposed as a JSON document for an administrator's diagnostic endpoint.
 *
 * The plan's rules are followed exactly:
 *
 *  - **No high-cardinality labels.** A metric is keyed by a provider key, a status, an error code
 *    or a state — never by a contact id, a token or a URL. A label that carries a record id would
 *    make the document both useless as a metric and dangerous to store.
 *  - **The counters are the ones the plan lists**: connections by provider and status, runs by
 *    outcome and duration, records by outcome, provider errors by code, webhook deliveries by
 *    verdict, the circuit state, the cursor age and the reauthorization backlog.
 *  - **Cost and quota are only reported where the vendor supplies reliable data.** No provider in
 *    this release publishes a quota, so the section says so rather than inventing a number.
 */

/** The metrics document. */
export interface IntegrationMetrics {
  readonly generatedAt: string;
  readonly connections: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byProvider: readonly { readonly providerKey: string; readonly total: number; readonly connected: number }[];
    readonly needingReauthorization: number;
    readonly enabled: number;
  };
  readonly syncRuns: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly last24h: number;
    readonly failedLast24h: number;
    readonly averageDurationSeconds: number | null;
    readonly backlog: number;
  };
  readonly records: {
    readonly scanned: number;
    readonly applied: number;
    readonly skipped: number;
    readonly failed: number;
    readonly conflictsOpen: number;
  };
  readonly providerErrors: readonly { readonly code: string; readonly count: number }[];
  readonly webhooks: {
    readonly total: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly duplicates: number;
    readonly processed: number;
    readonly failed: number;
    readonly averageProcessingSeconds: number | null;
  };
  /**
   * The circuit breakers, keyed by **provider** rather than by connection.
   *
   * A connection id is a high-cardinality label, and the plan asks the metrics to avoid those.
   */
  readonly circuits: readonly {
    readonly providerKey: string;
    readonly state: string;
    readonly failureCount: number;
  }[];
  readonly cursors: {
    readonly tracked: number;
    readonly resetRequired: number;
    readonly oldestAgeSeconds: number | null;
  };
  readonly deadLetters: { readonly open: number; readonly total: number };
  readonly enrichment: { readonly pending: number; readonly accepted: number; readonly rejected: number };
  /**
   * The vendor-supplied cost and quota figures.
   *
   * Empty in this release: no delivered provider publishes a reliable quota or cost figure, and
   * the plan says to report it only where the vendor does.
   */
  readonly providerCost: { readonly available: boolean; readonly note: string };
}

@Injectable()
export class IntegrationMetricsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** The metrics document. */
  async metrics(): Promise<IntegrationMetrics> {
    const [
      connectionRows,
      providerRows,
      runRows,
      operationRows,
      webhookRows,
      conflictRows,
      cursorRows,
      deadLetterRows,
      enrichmentRows,
      errorRows,
      circuitRows,
      connectionProviderRows,
    ] = await Promise.all([
      sql<{ status: string; total: string }>`
        select status, count(*)::text as total from integration_connections
        where deleted_at is null group by status
      `.execute(this.database.db),
      sql<{ provider_key: string; total: string; connected: string }>`
        select provider_key, count(*)::text as total,
               count(*) filter (where status in ('connected', 'degraded'))::text as connected
        from integration_connections where deleted_at is null group by provider_key order by provider_key
      `.execute(this.database.db),
      sql<{ status: string; total: string }>`
        select status, count(*)::text as total from integration_sync_runs group by status
      `.execute(this.database.db),
      sql<{ status: string; total: string }>`
        select status, count(*)::text as total from integration_sync_operations group by status
      `.execute(this.database.db),
      sql<{ status: string; total: string; avg_seconds: string | null }>`
        select status, count(*)::text as total,
               avg(extract(epoch from (processed_at - received_at)))::text as avg_seconds
        from integration_webhook_deliveries group by status
      `.execute(this.database.db),
      sql<{ total: string }>`
        select count(*)::text as total from integration_conflicts where resolved_at is null
      `.execute(this.database.db),
      sql<{ total: string; reset: string; oldest: Date | null }>`
        select count(*)::text as total,
               count(*) filter (where reset_required)::text as reset,
               min(updated_at) as oldest
        from integration_sync_checkpoints
      `.execute(this.database.db),
      sql<{ status: string; total: string }>`
        select status, count(*)::text as total from integration_dead_letters group by status
      `.execute(this.database.db),
      sql<{ status: string; total: string }>`
        select status, count(*)::text as total from integration_enrichment_results group by status
      `.execute(this.database.db),
      sql<{ error_code: string | null; total: string }>`
        select error_code, count(*)::text as total from integration_sync_operations
        where error_code is not null group by error_code order by count(*) desc limit 20
      `.execute(this.database.db),
      sql<{ key: string; state: string; failure_count: number }>`
        select key, state, failure_count from integration_circuit_states order by key
      `.execute(this.database.db),
      sql<{ id: string; provider_key: string }>`
        select id, provider_key from integration_connections
      `.execute(this.database.db),
    ]);

    const byStatus = (rows: readonly { status: string; total: string }[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of rows) out[row.status] = Number(row.total);
      return out;
    };

    const runByStatus = byStatus(runRows.rows);
    const operationByStatus = byStatus(operationRows.rows);
    const webhookByStatus = byStatus(webhookRows.rows);
    const deadLetterByStatus = byStatus(deadLetterRows.rows);
    const enrichmentByStatus = byStatus(enrichmentRows.rows);

    const [runWindow, failedWindow, durationRow, backlogRow, connectionTotal, enabledRow, reauthRow] =
      await Promise.all([
        sql<{ total: string }>`
          select count(*)::text as total from integration_sync_runs where created_at > now() - interval '24 hours'
        `.execute(this.database.db),
        sql<{ total: string }>`
          select count(*)::text as total from integration_sync_runs
          where status = 'failed' and created_at > now() - interval '24 hours'
        `.execute(this.database.db),
        sql<{ avg_seconds: string | null }>`
          select avg(extract(epoch from (finished_at - started_at)))::text as avg_seconds
          from integration_sync_runs where finished_at is not null and started_at is not null
        `.execute(this.database.db),
        sql<{ total: string }>`
          select count(*)::text as total from integration_sync_runs where status in ('queued', 'running')
        `.execute(this.database.db),
        sql<{ total: string }>`
          select count(*)::text as total from integration_connections where deleted_at is null
        `.execute(this.database.db),
        sql<{ total: string }>`
          select count(*)::text as total from integration_connections where deleted_at is null and enabled
        `.execute(this.database.db),
        sql<{ total: string }>`
          select count(*)::text as total from integration_connections
          where deleted_at is null and status = 'reauthorization_required'
        `.execute(this.database.db),
      ]);

    // The circuit's key carries a connection id, which is a **high-cardinality label**. The metric
    // reports the provider instead, so the document stays a metric and not an inventory of ids.
    const providerOfConnection = new Map<string, string>(
      connectionProviderRows.rows.map((row) => [row.id, row.provider_key] as const),
    );
    const circuits = circuitRows.rows.map((row) => {
      const connectionId = row.key.startsWith('conn:') ? row.key.slice('conn:'.length) : '';
      return {
        providerKey: providerOfConnection.get(connectionId) ?? 'unknown',
        state: row.state,
        failureCount: row.failure_count,
      };
    });

    const cursorRow = cursorRows.rows[0];
    const webhookAvg = webhookRows.rows
      .map((row) => row.avg_seconds)
      .filter((value): value is string => value !== null)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    return {
      generatedAt: new Date().toISOString(),
      connections: {
        total: Number(connectionTotal.rows[0]?.total ?? '0'),
        byStatus: byStatus(connectionRows.rows),
        byProvider: providerRows.rows.map((row) => ({
          providerKey: row.provider_key,
          total: Number(row.total),
          connected: Number(row.connected),
        })),
        needingReauthorization: Number(reauthRow.rows[0]?.total ?? '0'),
        enabled: Number(enabledRow.rows[0]?.total ?? '0'),
      },
      syncRuns: {
        byStatus: runByStatus,
        last24h: Number(runWindow.rows[0]?.total ?? '0'),
        failedLast24h: Number(failedWindow.rows[0]?.total ?? '0'),
        averageDurationSeconds: durationRow.rows[0]?.avg_seconds === null || durationRow.rows[0]?.avg_seconds === undefined
          ? null
          : Number(durationRow.rows[0]?.avg_seconds),
        backlog: Number(backlogRow.rows[0]?.total ?? '0'),
      },
      records: {
        scanned: operationByStatus['applied'] ?? 0,
        applied: operationByStatus['applied'] ?? 0,
        skipped: operationByStatus['skipped'] ?? 0,
        failed: operationByStatus['failed'] ?? 0,
        conflictsOpen: Number(conflictRows.rows[0]?.total ?? '0'),
      },
      providerErrors: errorRows.rows.map((row) => ({
        code: row.error_code ?? 'UNKNOWN',
        count: Number(row.total),
      })),
      webhooks: {
        total: Object.values(webhookByStatus).reduce((sum, value) => sum + value, 0),
        accepted: webhookByStatus['received'] ?? 0,
        rejected: webhookByStatus['rejected'] ?? 0,
        duplicates: webhookByStatus['duplicate'] ?? 0,
        processed: webhookByStatus['processed'] ?? 0,
        failed: webhookByStatus['failed'] ?? 0,
        averageProcessingSeconds:
          webhookAvg.length === 0
            ? null
            : webhookAvg.reduce((sum, value) => sum + value, 0) / webhookAvg.length,
      },
      circuits,
      cursors: {
        tracked: Number(cursorRow?.total ?? '0'),
        resetRequired: Number(cursorRow?.reset ?? '0'),
        oldestAgeSeconds:
          cursorRow?.oldest === null || cursorRow?.oldest === undefined
            ? null
            : Math.max(0, Math.round((Date.now() - cursorRow.oldest.getTime()) / 1000)),
      },
      deadLetters: {
        open: deadLetterByStatus['open'] ?? 0,
        total: Object.values(deadLetterByStatus).reduce((sum, value) => sum + value, 0),
      },
      enrichment: {
        pending: enrichmentByStatus['pending'] ?? 0,
        accepted: enrichmentByStatus['accepted'] ?? 0,
        rejected: enrichmentByStatus['rejected'] ?? 0,
      },
      providerCost: {
        available: false,
        note: 'No delivered connector publishes a reliable provider quota or cost figure, so none is reported.',
      },
    };
  }
}
