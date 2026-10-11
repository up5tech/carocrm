import type { Logger } from '@carocrm/core/logger/index.js';

import {
  errorMessage,
  type Queryable,
  type Row,
  rowDate,
  rowRecord,
  rowString,
} from '../db.js';
import { scheduledJobId } from '../queue/job-payload.js';
import { cronBoundary, isDue } from './cron.js';

/**
 * Cron scheduler: reloads `scheduled_jobs` every tick (spec: 30s), computes the current cron
 * boundary with cron-parser, and enqueues the job into BullMQ with a deterministic jobId
 * `${scheduleId}:${boundaryMs}` so overlapping ticks / several worker instances deduplicate.
 *
 * The DB claim (`last_run_at`) happens before the enqueue: a schedule only fires once per
 * boundary even with concurrent workers, and the claim is rolled back if Redis is unreachable
 * so the next tick retries the same boundary.
 */
export interface ScheduleRow {
  id: string;
  job: string;
  cron: string;
  data: Record<string, unknown>;
  lastRunAtMs: number | null;
}

export interface ScheduledJobEnqueue {
  enqueueScheduled(input: {
    jobId: string;
    job: string;
    data: Record<string, unknown>;
    scheduleId: string;
    scheduledForMs: number;
  }): Promise<string>;
}

export const SELECT_ENABLED_SCHEDULES_SQL = `
  SELECT id, job, scheduling, target, last_run_at
    FROM scheduled_jobs
   WHERE enabled = TRUE
   ORDER BY id
`;

export const CLAIM_SCHEDULE_RUN_SQL = `
  UPDATE scheduled_jobs
     SET last_run_at = $2, modified_at = now()
   WHERE id = $1
     AND (last_run_at IS NULL OR last_run_at < $2)
  RETURNING id
`;

export const RELEASE_SCHEDULE_RUN_SQL = `
  UPDATE scheduled_jobs
     SET last_run_at = $2, modified_at = now()
   WHERE id = $1
`;

export function mapScheduleRow(row: Row): ScheduleRow {
  const lastRunAt = rowDate(row, 'last_run_at');
  return {
    id: rowString(row, 'id'),
    job: rowString(row, 'job'),
    cron: rowString(row, 'scheduling'),
    data: rowRecord(row, 'target'),
    lastRunAtMs: lastRunAt === null ? null : lastRunAt.getTime(),
  };
}

export interface SchedulerOptions {
  db: Queryable;
  enqueue: ScheduledJobEnqueue;
  log: Logger;
  intervalMs: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.log.info({ intervalMs: this.options.intervalMs }, 'scheduler started');
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (inFlight !== undefined) await inFlight;
    this.inFlight = undefined;
    this.options.log.info('scheduler stopped');
  }

  /** One reload + fire cycle. Returns the number of schedules that fired. */
  async tick(now: Date = new Date()): Promise<number> {
    const result = await this.options.db.query(SELECT_ENABLED_SCHEDULES_SQL);
    let fired = 0;
    for (const row of result.rows.map((item) => mapScheduleRow(item))) {
      const didFire = await this.fireIfDue(row, now);
      if (didFire) fired += 1;
    }
    if (fired > 0) this.options.log.info({ fired }, 'scheduler enqueued jobs');
    return fired;
  }

  private async fireIfDue(row: ScheduleRow, now: Date): Promise<boolean> {
    const log = this.options.log;
    let boundaryMs: number;
    try {
      boundaryMs = cronBoundary(row.cron, now).previousMs;
    } catch (error: unknown) {
      log.error({ scheduleId: row.id, cron: row.cron, error: errorMessage(error) }, 'invalid cron expression, skipping');
      return false;
    }

    if (!isDue(row.lastRunAtMs, boundaryMs)) return false;
    const boundaryDate = new Date(boundaryMs);

    try {
      const claimed = await this.options.db.query(CLAIM_SCHEDULE_RUN_SQL, [row.id, boundaryDate]);
      if ((claimed.rowCount ?? 0) === 0) {
        log.debug({ scheduleId: row.id }, 'schedule already claimed by another worker');
        return false;
      }

      try {
        const queueJobId = await this.options.enqueue.enqueueScheduled({
          jobId: scheduledJobId(row.id, boundaryMs),
          job: row.job,
          data: row.data,
          scheduleId: row.id,
          scheduledForMs: boundaryMs,
        });
        log.info(
          { scheduleId: row.id, job: row.job, scheduledFor: boundaryDate.toISOString(), queueJobId },
          'scheduled job enqueued',
        );
      } catch (error: unknown) {
        await this.options.db.query(RELEASE_SCHEDULE_RUN_SQL, [
          row.id,
          row.lastRunAtMs === null ? null : new Date(row.lastRunAtMs),
        ]);
        throw error;
      }
      return true;
    } catch (error: unknown) {
      log.error({ scheduleId: row.id, job: row.job, error: errorMessage(error) }, 'failed to fire schedule');
      return false;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    const startedAt = Date.now();
    try {
      await this.tick();
    } catch (error: unknown) {
      this.options.log.error({ error: errorMessage(error) }, 'scheduler cycle failed');
    }
    const wait = Math.max(0, this.options.intervalMs - (Date.now() - startedAt));
    this.scheduleNext(wait);
  }
}
