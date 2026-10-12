import { randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { SelectQueryBuilder } from 'kysely';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import type { Database } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { isValidCronExpression } from './cron.js';
import type { JobView, ScheduleView } from './job.views.js';
import { toJobView, toScheduleView } from './job.views.js';
import { JobQueueService } from './job-queue.service.js';

const JOB_NAME = /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/;
const JOB_ID = /^[0-9a-fA-F-]{16,64}$/;
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PAYLOAD_CHARS = 32_000;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface JobListQuery {
  status: string | undefined;
  job: string | undefined;
  offset: number;
  limit: number;
}

/**
 * Background job administration (PLAN §24): submit one-off jobs, watch progress and logs, cancel
 * them, and manage cron schedules. Postgres (`jobs`, `job_logs`, `scheduled_jobs`) is the durable
 * record; Redis only carries the queue.
 */
@Injectable()
export class JobsService {
  private readonly attempts: number;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(CONFIG_TOKEN) config: AppConfig,
  ) {
    this.attempts = config.jobAttempts;
  }

  async enqueue(input: { job: string; data: Record<string, unknown>; id?: string | undefined }): Promise<JobView> {
    const job = requireJobName(input.job);
    const data = requirePayload(input.data);
    const id = input.id === undefined ? randomUUID() : requireJobId(input.id);

    const clash = await this.database.db.selectFrom('jobs').select('id').where('id', '=', id).executeTakeFirst();
    if (clash) throw new DuplicateRecordError(`Job "${id}" already exists.`);

    await this.insertPending(id, job, data, null);
    const queueJobId = await this.queue.enqueue({ job, data, jobRowId: id });
    await this.database.db.updateTable('jobs').set({ queue_job_id: queueJobId }).where('id', '=', id).execute();
    return this.get(id);
  }

  async list(query: JobListQuery): Promise<{ list: JobView[]; total: number; offset: number; count: number }> {
    const rows = await withFilters(
      this.database.db.selectFrom('jobs').selectAll(),
      query,
    )
      .orderBy('created_at', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();

    const counted = await withFilters(this.database.db.selectFrom('jobs').selectAll(), query)
      .clearSelect()
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirst();

    return {
      list: rows.map(toJobView),
      total: Number(counted?.total ?? 0),
      offset: query.offset,
      count: rows.length,
    };
  }

  async get(id: string): Promise<JobView> {
    const row = await this.database.db.selectFrom('jobs').selectAll().where('id', '=', requireJobId(id)).executeTakeFirst();
    if (!row) throw new NotFoundError(`Job "${id}" does not exist.`);
    return toJobView(row);
  }

  async logs(id: string): Promise<{ jobId: string; lines: { seq: string; level: string; message: string; createdAt: string }[] }> {
    const jobId = requireJobId(id);
    const job = await this.database.db.selectFrom('jobs').select('id').where('id', '=', jobId).executeTakeFirst();
    if (!job) throw new NotFoundError(`Job "${jobId}" does not exist.`);

    const rows = await this.database.db
      .selectFrom('job_logs')
      .selectAll()
      .where('job_id', '=', jobId)
      .orderBy('seq', 'asc')
      .limit(500)
      .execute();

    return {
      jobId,
      lines: rows.map((line) => ({ seq: String(line.seq), level: line.level, message: line.message, createdAt: line.created_at.toISOString() })),
    };
  }

  /**
   * Cancels a job (PLAN §24). A waiting queue entry is removed outright; a running attempt is
   * flagged `cancel_requested` and stops through `context.shouldStop()`. Terminal jobs are untouched.
   */
  async cancel(id: string): Promise<JobView> {
    const jobId = requireJobId(id);
    const row = await this.database.db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
    if (!row) throw new NotFoundError(`Job "${jobId}" does not exist.`);
    if (TERMINAL_STATUSES.has(row.status)) return toJobView(row);

    const removedFromQueue = await this.queue.remove(row.queue_job_id);
    if (row.status === 'pending' || removedFromQueue) {
      await this.database.db
        .updateTable('jobs')
        .set({ status: 'cancelled', finished_at: new Date(), message: 'Cancelled before it started.', cancel_requested: true })
        .where('id', '=', jobId)
        .where('status', 'in', ['pending', 'running'])
        .execute();
    } else {
      await this.database.db.updateTable('jobs').set({ cancel_requested: true }).where('id', '=', jobId).execute();
    }
    return this.get(jobId);
  }

  async queueCounts(): Promise<Record<string, number>> {
    return this.queue.counts();
  }

  // ---------------------------------------------------------------- schedules

  async listSchedules(): Promise<{ list: ScheduleView[] }> {
    const rows = await this.database.db.selectFrom('scheduled_jobs').selectAll().orderBy('id', 'asc').execute();
    return { list: rows.map(toScheduleView) };
  }

  async upsertSchedule(input: {
    id: string;
    job: string;
    scheduling: string;
    data?: Record<string, unknown> | undefined;
    enabled?: boolean | undefined;
  }): Promise<ScheduleView> {
    const id = requireScheduleId(input.id);
    const job = requireJobName(input.job);
    const scheduling = requireCron(input.scheduling);
    const data = requirePayload(input.data ?? {});
    const enabled = input.enabled !== false;

    await this.database.db
      .insertInto('scheduled_jobs')
      .values({ id, job, scheduling, target: JSON.stringify(data), enabled, last_run_at: null, created_at: new Date(), modified_at: new Date() })
      .onConflict((oc) => oc.column('id').doUpdateSet({ job, scheduling, target: JSON.stringify(data), enabled, modified_at: new Date() }))
      .execute();

    const row = await this.database.db.selectFrom('scheduled_jobs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError(`Schedule "${id}" does not exist.`);
    return toScheduleView(row);
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleView> {
    const scheduleId = requireScheduleId(id);
    const updated = await this.database.db
      .updateTable('scheduled_jobs')
      .set({ enabled, modified_at: new Date() })
      .where('id', '=', scheduleId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new NotFoundError(`Schedule "${scheduleId}" does not exist.`);
    const row = await this.database.db.selectFrom('scheduled_jobs').selectAll().where('id', '=', scheduleId).executeTakeFirst();
    if (!row) throw new NotFoundError(`Schedule "${scheduleId}" does not exist.`);
    return toScheduleView(row);
  }

  async removeSchedule(id: string): Promise<void> {
    const scheduleId = requireScheduleId(id);
    const removed = await this.database.db.deleteFrom('scheduled_jobs').where('id', '=', scheduleId).returning('id').executeTakeFirst();
    if (!removed) throw new NotFoundError(`Schedule "${scheduleId}" does not exist.`);
  }

  /** Runs a schedule immediately, outside its cron boundary (PLAN §24 "one-off" of a scheduled job). */
  async runScheduleNow(id: string): Promise<JobView> {
    const scheduleId = requireScheduleId(id);
    const schedule = await this.database.db.selectFrom('scheduled_jobs').selectAll().where('id', '=', scheduleId).executeTakeFirst();
    if (!schedule) throw new NotFoundError(`Schedule "${scheduleId}" does not exist.`);

    const data = asObject(schedule.target);
    const jobId = randomUUID();
    await this.insertPending(jobId, schedule.job, data, 'cron');
    const queueJobId = await this.queue.enqueue({ job: schedule.job, data, jobRowId: jobId });
    await this.database.db.updateTable('jobs').set({ queue_job_id: queueJobId }).where('id', '=', jobId).execute();
    await this.database.db
      .updateTable('scheduled_jobs')
      .set({ last_run_at: new Date(), modified_at: new Date() })
      .where('id', '=', scheduleId)
      .execute();

    return this.get(jobId);
  }

  private async insertPending(id: string, job: string, data: Record<string, unknown>, schedulingType: string | null): Promise<void> {
    await this.database.db
      .insertInto('jobs')
      .values({
        id,
        job,
        status: 'pending',
        scheduling_type: schedulingType,
        created_at: new Date(),
        started_at: null,
        finished_at: null,
        target: JSON.stringify(data),
        result: null,
        progress: 0,
        message: null,
        last_error: null,
        queue_job_id: null,
        attempt: 1,
        max_attempts: this.attempts,
        cancel_requested: false,
      })
      .execute();
  }
}

function withFilters<T>(builder: SelectQueryBuilder<Database, 'jobs', T>, query: JobListQuery): SelectQueryBuilder<Database, 'jobs', T> {
  let result = builder;
  if (query.status !== undefined) result = result.where('status', '=', query.status);
  if (query.job !== undefined) result = result.where('job', '=', query.job);
  return result;
}

function requireJobName(value: string): string {
  if (!JOB_NAME.test(value)) {
    throw new ValidationError(`Invalid job name "${value}". Use "<module>.<action>", e.g. "system.cleanupOutbox".`, { job: value });
  }
  return value;
}

function requireJobId(value: string): string {
  if (!JOB_ID.test(value)) throw new ValidationError(`Invalid job id "${value}".`, { id: value });
  return value;
}

function requireScheduleId(value: string): string {
  if (!SCHEDULE_ID.test(value)) throw new ValidationError(`Invalid schedule id "${value}". Use letters, digits, "_" or "-".`, { id: value });
  return value;
}

function requireCron(value: string): string {
  const cron = value.trim();
  if (!isValidCronExpression(cron)) {
    throw new ValidationError(`"${value}" is not a valid cron expression. Use 5 fields, e.g. "0 * * * *".`, { scheduling: value });
  }
  return cron;
}

function requirePayload(value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  if (text.length > MAX_PAYLOAD_CHARS) {
    throw new ValidationError(`Job data is too large (${String(text.length)} characters; max ${String(MAX_PAYLOAD_CHARS)}).`, { size: text.length });
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
