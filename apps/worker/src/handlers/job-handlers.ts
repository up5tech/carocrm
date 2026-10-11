import { randomUUID } from 'node:crypto';

import type { Logger } from '@carocrm/core/logger/index.js';
import type { FileStorage } from '@carocrm/files';
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
 * - handler receives `{ userId?, data?, progress(), log(), shouldStop() }` where `data` is the
 *   BullMQ payload `data` object and the three functions write to this execution's `jobs` row
 *   (progress bar, `job_logs` lines, cooperative cancellation) — plan §24;
 * - return `{ status: 'completed', result? }` on success;
 * - return `{ status: 'cancelled' }` when `shouldStop()` said yes — the attempt is not retried;
 * - return `{ status: 'failed', message }` or throw to trigger a retry (3 attempts,
 *   exponential backoff); a retry gets its own `jobs` row, an API-submitted job keeps its one row.
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
  /** Storage used to delete abandoned upload parts; omit to skip that job entirely. */
  storage?: FileStorage;
  uploadExpiryHours?: number;
}

export interface UploadCleanupDeps extends SystemJobDeps {
  storage: FileStorage;
  expiryHours: number;
}

export const DEFAULT_UPLOAD_EXPIRY_HOURS = 24;
export const DEFAULT_UPLOAD_BATCH = 200;



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
    context.progress(20, `removing outbox events older than ${String(days)} days`);
    const result = await deps.db.query(CLEANUP_OUTBOX_SQL, [days]);
    const deleted = countDeleted(result.rows.length, result.rowCount);
    context.log(`removed ${String(deleted)} outbox events`, 'info');
    deps.log.info({ deleted, days }, 'outbox cleanup finished');
    return { status: 'completed', message: `Removed ${String(deleted)} outbox events`, result: { deleted, days } };
  };
}

export function pruneSessionsJob(deps: SystemJobDeps): JobHandler {
  return async (context: JobContext) => {
    const days = retentionDays(context.data, 'retentionDays', DEFAULT_SESSION_RETENTION_DAYS);
    context.progress(20, `pruning sessions older than ${String(days)} days`);
    const result = await deps.db.query(PRUNE_SESSIONS_SQL, [days]);
    const deleted = countDeleted(result.rows.length, result.rowCount);
    deps.log.info({ deleted, days }, 'session pruning finished');
    return { status: 'completed', message: `Removed ${String(deleted)} sessions`, result: { deleted, days } };
  };
}

export const DEFAULT_REMINDER_BATCH = 100;
/** Activities whose reminder is due but not yet delivered (PLAN §27). */
export const REMINDER_SCAN_SQL = `
  SELECT id,
         entity_type,
         name,
         COALESCE(NULLIF(attrs->>'assignedUserId', ''), created_by_id) AS recipient_id,
         (attrs->>'dateStart')::timestamptz AS date_start
    FROM entity_records
   WHERE entity_type IN ('Task', 'Call', 'Meeting')
     AND deleted_at IS NULL
     AND attrs->>'reminder' = 'true'
     AND jsonb_typeof(attrs->'dateStart') = 'string'
     AND attrs->>'dateStart' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
     AND (attrs->>'reminderSentAt' IS NULL)
     AND COALESCE(attrs->>'status', '') NOT IN ('Completed', 'Canceled', 'Deferred', 'Held', 'Not Held')
     AND (attrs->>'dateStart')::timestamptz
           - make_interval(mins => CASE WHEN attrs->>'reminderTime' ~ '^-?[0-9]+$'
                                        THEN (attrs->>'reminderTime')::int ELSE 0 END) <= now()
     AND (attrs->>'dateStart')::timestamptz >= now() - interval '24 hours'
   ORDER BY (attrs->>'dateStart')::timestamptz
   LIMIT $1
`;

export const REMINDER_INSERT_SQL = `
  INSERT INTO notifications (id, type, user_id, data, is_read, created_at)
  VALUES ($1, 'Reminder', $2, $3, FALSE, now())
`;

/** Idempotency marker; the extra predicate keeps a concurrent worker from double-firing. */
export const REMINDER_MARK_SQL = `
  UPDATE entity_records
     SET attrs = jsonb_set(attrs, '{reminderSentAt}', to_jsonb(now()::text))
   WHERE id = $1
     AND attrs->>'reminderSentAt' IS NULL
     AND attrs->>'reminder' = 'true'
  RETURNING id
`;

/**
 * Delivers activity reminders as in-app notifications. EspoCRM's email/popup transports
 * are not implemented here; the notification row is the delivery seam (PLAN §26/§27).
 */
export function sendRemindersJob(deps: SystemJobDeps): JobHandler {
  return async (context: JobContext) => {
    const limit = retentionDays(context.data, 'batchSize', DEFAULT_REMINDER_BATCH);
    const found = await deps.db.query(REMINDER_SCAN_SQL, [limit]);
    const rows = found.rows as Array<Record<string, unknown>>;
    context.log(`scanned ${String(rows.length)} due reminders`, 'info');
    let delivered = 0;
    let stopped = false;

    for (const [index, row] of rows.entries()) {
      if (await context.shouldStop()) {
        stopped = true;
        context.log(`cancelled after ${String(delivered)} of ${String(rows.length)} deliveries`, 'warn');
        break;
      }
      if (rows.length > 1) context.progress(Math.round(((index + 1) / rows.length) * 100));
      const recipient = row['recipient_id'];
      const activityId = row['id'];
      if (typeof recipient !== 'string' || recipient === '' || typeof activityId !== 'string') continue;
      const data = JSON.stringify({
        activityId,
        activityType: String(row['entity_type'] ?? ''),
        activityName: row['name'] === null || row['name'] === undefined ? null : String(row['name']),
        dateStart: row['date_start'] instanceof Date ? row['date_start'].toISOString() : String(row['date_start'] ?? ''),
      });
      await deps.db.query(REMINDER_INSERT_SQL, [randomUUID(), recipient, data]);
      const marked = await deps.db.query(REMINDER_MARK_SQL, [activityId]);
      const updated = marked.rows.length > 0 || (marked.rowCount ?? 0) > 0;
      if (updated) delivered += 1;
    }

    deps.log.info({ scanned: rows.length, delivered }, 'activity reminders delivered');
    if (stopped) {
      return { status: 'cancelled', message: `Delivered ${String(delivered)} reminders before cancelling` };
    }
    return {
      status: 'completed',
      message: `Delivered ${String(delivered)} reminders`,
      result: { scanned: rows.length, delivered },
    };
  };
}

/** Registers the kernel jobs. Modules register theirs alongside this call. */
export const EXPIRED_UPLOADS_SQL = `
  SELECT id, storage_prefix, parts
    FROM file_uploads
   WHERE status = 'open'
     AND expires_at < $1
   ORDER BY expires_at
   LIMIT $2
`;

export const ABANDON_UPLOAD_SQL = `
  UPDATE file_uploads
     SET status = 'aborted', modified_at = now()
   WHERE id = $1
     AND status = 'open'
   RETURNING id
`;

/**
 * Abandons chunked uploads whose client never completed and deletes their part files, so an
 * interrupted upload cannot leave bytes on the storage forever (PLAN §25). Idempotent: the row is
 * claimed before its parts are removed, and deleting a missing part is fine.
 *
 * `expiryHours` is a grace window *after* `expires_at`: the reservation deadline the API stamps at
 * init, plus this window. A client that is still assembling inside the window can complete; once
 * it passes, the parts go and the row is marked aborted.
 */
export function cleanupUploadsJob(deps: UploadCleanupDeps): JobHandler {
  return async (context: JobContext) => {
    const expiryHours = retentionDays(context.data, 'expiryHours', deps.expiryHours);
    const batch = retentionDays(context.data, 'batchSize', DEFAULT_UPLOAD_BATCH);
    const cutoff = new Date(Date.now() - expiryHours * 3_600_000);
    context.progress(10, `uploads reserved before ${cutoff.toISOString()}`);

    const found = await deps.db.query(EXPIRED_UPLOADS_SQL, [cutoff, batch]);
    let uploads = 0;
    let parts = 0;
    for (const row of found.rows as Array<Record<string, unknown>>) {
      const id = String(row['id'] ?? '');
      const prefix = String(row['storage_prefix'] ?? '');
      if (id === '' || prefix === '') continue;
      const claimed = await deps.db.query(ABANDON_UPLOAD_SQL, [id]);
      if ((claimed.rowCount ?? 0) === 0) continue;
      const indexes = partIndexes(row['parts']);
      for (const index of indexes) {
        await deps.storage.delete(`${prefix}/part-${String(index).padStart(6, '0')}`).catch(() => undefined);
      }
      parts += indexes.length;
      uploads += 1;
      context.log(`abandoned upload ${id} (${String(indexes.length)} parts)`, 'info');
    }

    deps.log.info({ uploads, parts, cutoff: cutoff.toISOString() }, 'upload cleanup finished');
    return { status: 'completed', message: `Abandoned ${String(uploads)} uploads`, result: { uploads, parts } };
  };
}

function partIndexes(value: unknown): number[] {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (typeof raw !== 'object' || raw === null) return [];
  return Object.keys(raw as Record<string, unknown>)
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function registerSystemJobs(registry: JobRegistry, deps: SystemJobDeps): void {
  registry.register('system.noop', noopJob());
  registry.register('system.cleanupOutbox', cleanupOutboxJob(deps));
  registry.register('system.pruneSessions', pruneSessionsJob(deps));
  registry.register('system.sendReminders', sendRemindersJob(deps));
  // Only installed when the process can reach the attachment storage.
  const storage = deps.storage;
  if (storage !== undefined) {
    registry.register('system.cleanupUploads', cleanupUploadsJob({
      db: deps.db,
      log: deps.log,
      storage,
      expiryHours: deps.uploadExpiryHours ?? DEFAULT_UPLOAD_EXPIRY_HOURS,
    }));
  }
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
