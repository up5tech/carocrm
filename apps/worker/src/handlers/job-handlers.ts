import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler } from '@carocrm/jobs';
import { JobRegistry } from '@carocrm/jobs';

import type { Queryable } from '../db.js';

/**
 * ============================ JOB HANDLER REGISTRY ============================
 *
 * This registry map is the extension point for background work. A module (or a future
 * `modules/<name>` package) contributes a named job by calling `register(name, handler)`
 * before the worker starts consuming — nothing else has to change:
 *
 * ```ts
 * // apps/worker/src/app.ts (composition root) — or from a module barrel:
 * registerInvoicingJobs(registry, { db, log });
 * //   registry.register('invoicing.generate', async ({ data, userId }) => {
 * //     ...work...
 * //     return { status: 'completed', result: { count: 12 } };
 * //   });
 * ```
 *
 * Contract (see `packages/jobs`):
 * - handler receives `{ userId?, data? }` where `data` is the BullMQ payload `data` object;
 * - return `{ status: 'completed', result? }` on success;
 * - return `{ status: 'failed', message }` or throw to trigger a retry (3 attempts,
 *   exponential backoff); every attempt is recorded as its own `jobs` table row.
 *
 * Names use `<module>.<action>`; `system.*` belongs to the kernel.
 * A schedule can be attached to any registered job by inserting a `scheduled_jobs` row
 * (`id`, `job` = the registered name, `scheduling` = cron, `target` = JSON data).
 * =============================================================================
 */

export const DEFAULT_OUTBOX_RETENTION_DAYS = 7;
export const DEFAULT_SESSION_RETENTION_DAYS = 30;

export interface SystemJobDeps {
  db: Queryable;
  log: Logger;
}

export const CLEANUP_OUTBOX_SQL = `
  DELETE FROM outbox_events
   WHERE status IN ('processed', 'failed')
     AND created_at < now() - make_interval(days => $1::int)
  RETURNING id
`;

export const PRUNE_SESSIONS_SQL = `
  DELETE FROM user_sessions
   WHERE (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1::int))
      OR (expired_at IS NOT NULL AND expired_at < now() - make_interval(days => $1::int))
  RETURNING id
`;

export function noopJob(): JobHandler {
  return async () => ({
    status: 'completed',
    message: 'noop',
    result: { ok: true, at: new Date().toISOString() },
  });
}

export function cleanupOutboxJob(deps: SystemJobDeps): JobHandler {
  return async (context: JobContext) => {
    const days = retentionDays(context.data, 'retentionDays', DEFAULT_OUTBOX_RETENTION_DAYS);
    const result = await deps.db.query(CLEANUP_OUTBOX_SQL, [days]);
    const deleted = countDeleted(result.rows.length, result.rowCount);
    deps.log.info({ deleted, days }, 'outbox cleanup finished');
    return { status: 'completed', message: `Removed ${String(deleted)} outbox events`, result: { deleted, days } };
  };
}

export function pruneSessionsJob(deps: SystemJobDeps): JobHandler {
  return async (context: JobContext) => {
    const days = retentionDays(context.data, 'retentionDays', DEFAULT_SESSION_RETENTION_DAYS);
    const result = await deps.db.query(PRUNE_SESSIONS_SQL, [days]);
    const deleted = countDeleted(result.rows.length, result.rowCount);
    deps.log.info({ deleted, days }, 'session pruning finished');
    return { status: 'completed', message: `Removed ${String(deleted)} sessions`, result: { deleted, days } };
  };
}

/** Registers the kernel jobs. Modules register theirs alongside this call. */
export function registerSystemJobs(registry: JobRegistry, deps: SystemJobDeps): void {
  registry.register('system.noop', noopJob());
  registry.register('system.cleanupOutbox', cleanupOutboxJob(deps));
  registry.register('system.pruneSessions', pruneSessionsJob(deps));
}

export function createSystemJobRegistry(deps: SystemJobDeps): JobRegistry {
  const registry = new JobRegistry();
  registerSystemJobs(registry, deps);
  return registry;
}

/** Reads an integer override from the job data, falling back to the documented default. */
export function retentionDays(
  data: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  if (data === undefined) return fallback;
  const candidate = data[key];
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    try {
      const parsed = Number(candidate);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function countDeleted(rowsDeleted: number, rowCount: number | null): number {
  if (rowCount !== null && rowCount >= 0) return rowCount;
  return rowsDeleted;
}
