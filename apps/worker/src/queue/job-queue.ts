import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobQueuePort } from '@carocrm/jobs';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { errorMessage, type Queryable } from '../db.js';
import { isValidCron } from '../schedule/cron.js';
import { buildJobPayload } from './job-payload.js';

/**
 * BullMQ producer + `JobQueuePort` implementation (so API/modules can enqueue through the
 * `@carocrm/jobs` contract instead of importing BullMQ).
 *
 * `schedule()` / `unschedule()` intentionally write to the `scheduled_jobs` table instead of
 * creating BullMQ repeatable jobs: the table is the source of truth the worker's scheduler
 * polls (30s), which keeps schedules visible to the Admin UI and survives a Redis flush.
 */
export interface EnqueueScheduledInput {
  jobId: string;
  job: string;
  data: Record<string, unknown>;
  scheduleId: string;
  scheduledForMs: number;
}

export interface JobQueueOptions {
  queueName: string;
  connection: Redis;
  db: Queryable;
  log: Logger;
  attempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const UPSERT_SCHEDULE_SQL = `
  INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled, created_at, modified_at)
  VALUES ($1, $2, $3, $4::jsonb, TRUE, now(), now())
  ON CONFLICT (id) DO UPDATE
     SET job = EXCLUDED.job,
         scheduling = EXCLUDED.scheduling,
         target = EXCLUDED.target,
         enabled = TRUE,
         modified_at = now()
`;

export const DISABLE_SCHEDULE_SQL = `
  UPDATE scheduled_jobs
     SET enabled = FALSE, modified_at = now()
   WHERE id = $1
`;

export class BullMqJobQueue implements JobQueuePort {
  readonly queue: Queue;

  constructor(private readonly options: JobQueueOptions) {
    this.queue = new Queue(options.queueName, {
      connection: options.connection,
      defaultJobOptions: {
        attempts: options.attempts,
        backoff: { type: 'exponential', delay: options.backoffBaseMs },
        // The `jobs` table is the durable record; Redis only has to keep enough history to
        // inspect a stuck queue, so completed jobs are trimmed quickly.
        removeOnComplete: { age: 600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  get queueName(): string {
    return this.options.queueName;
  }

  async enqueue(job: string, data: Record<string, unknown> = {}): Promise<string> {
    const added = await this.queue.add(job, buildJobPayload({ job, data }));
    return String(added.id ?? '');
  }

  /** Scheduler entry point: deterministic `jobId` gives Redis-level deduplication. */
  async enqueueScheduled(input: EnqueueScheduledInput): Promise<string> {
    const added = await this.queue.add(
      input.job,
      buildJobPayload({
        job: input.job,
        data: input.data,
        scheduleId: input.scheduleId,
        scheduledForMs: input.scheduledForMs,
      }),
      { jobId: input.jobId },
    );
    return String(added.id ?? '');
  }

  async schedule(id: string, job: string, cron: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!isValidCron(cron)) {
      throw new Error(`Cannot schedule job "${job}": "${cron}" is not a valid cron expression.`);
    }
    await this.options.db.query(UPSERT_SCHEDULE_SQL, [id, job, cron.trim(), JSON.stringify(data)]);
    this.options.log.info({ scheduleId: id, job, cron }, 'schedule stored in scheduled_jobs');
  }

  /** Keeps history: schedules are disabled rather than deleted. */
  async unschedule(id: string): Promise<void> {
    await this.options.db.query(DISABLE_SCHEDULE_SQL, [id]);
    this.options.log.info({ scheduleId: id }, 'schedule disabled');
  }

  async counts(): Promise<Record<string, number>> {
    try {
      return (await this.queue.getJobCounts()) as unknown as Record<string, number>;
    } catch (error: unknown) {
      this.options.log.warn({ error: errorMessage(error) }, 'failed to read queue job counts');
      return {};
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
