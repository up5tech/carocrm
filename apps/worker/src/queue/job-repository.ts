import type { JobStatus } from '@carocrm/jobs';

import type { Queryable } from '../db.js';

/**
 * `jobs` table bookkeeping: one row per execution. A job submitted through the Jobs API already
 * has a `pending` row, which the first attempt adopts (PLAN §24 progress/logs/cancellation all
 * hang off that row id); scheduled and retried runs insert their own row.
 */
export interface JobRecordRow {
  id: string;
  job: string;
  data: Record<string, unknown>;
  schedulingType: string | null;
  startedAt: Date;
  queueJobId: string | null;
  attempt: number;
  maxAttempts: number;
}

export const INSERT_RUNNING_SQL = `
  INSERT INTO jobs (id, job, status, scheduling_type, created_at, started_at, target, result,
                    queue_job_id, attempt, max_attempts, progress)
  VALUES ($1, $2, 'running', $3, now(), $4, $5::jsonb, NULL, $6, $7, $8, 0)
`;

/** Only a `pending` row created by the API can be adopted, so a cancel in between is respected. */
export const ADOPT_PENDING_SQL = `
  UPDATE jobs
     SET status = 'running',
         started_at = now(),
         queue_job_id = COALESCE($2, queue_job_id),
         attempt = $3,
         max_attempts = $4,
         progress = COALESCE(progress, 0)
   WHERE id = $1
     AND status = 'pending'
     AND cancel_requested = FALSE
  RETURNING id
`;

export const MARK_FINISHED_SQL = `
  UPDATE jobs
     SET status = $2,
         finished_at = now(),
         result = $3::jsonb,
         message = $4,
         last_error = $5,
         progress = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN COALESCE(progress, 100) ELSE progress END
   WHERE id = $1
`;

export const UPDATE_PROGRESS_SQL = `
  UPDATE jobs
     SET progress = $2,
         message = COALESCE($3, message)
   WHERE id = $1
     AND status = 'running'
`;

export const APPEND_LOG_SQL = `
  INSERT INTO job_logs (job_id, level, message)
  VALUES ($1, $2, $3)
`;

export const CANCEL_REQUESTED_SQL = `
  SELECT cancel_requested FROM jobs WHERE id = $1
`;

export class JobRepository {
  constructor(private readonly db: Queryable) {}

  async insertRunning(row: JobRecordRow): Promise<void> {
    await this.db.query(INSERT_RUNNING_SQL, [
      row.id,
      row.job,
      row.schedulingType,
      row.startedAt,
      JSON.stringify(row.data),
      row.queueJobId,
      row.attempt,
      row.maxAttempts,
    ]);
  }

  /** True when the `pending` row created by the API could be taken over by this attempt. */
  async adoptPending(id: string, queueJobId: string | null, attempt: number, maxAttempts: number): Promise<boolean> {
    const result = await this.db.query(ADOPT_PENDING_SQL, [id, queueJobId, attempt, maxAttempts]);
    return result.rows.length > 0;
  }

  async markFinished(
    id: string,
    status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>,
    result: Record<string, unknown>,
    message: string | null,
    lastError: string | null,
  ): Promise<void> {
    await this.db.query(MARK_FINISHED_SQL, [id, status, JSON.stringify(result), message, lastError]);
  }

  async updateProgress(id: string, progress: number, message: string | null): Promise<void> {
    await this.db.query(UPDATE_PROGRESS_SQL, [id, progress, message]);
  }

  async appendLog(id: string, level: string, message: string): Promise<void> {
    await this.db.query(APPEND_LOG_SQL, [id, level, message]);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const result = await this.db.query(CANCEL_REQUESTED_SQL, [id]);
    return result.rows[0]?.['cancel_requested'] === true;
  }
}
