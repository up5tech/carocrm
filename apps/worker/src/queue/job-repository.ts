import type { JobStatus } from '@carocrm/jobs';

import type { Queryable } from '../db.js';

/**
 * `jobs` table bookkeeping: one row per execution attempt, `running` -> `completed` /
 * `failed` with `started_at`, `finished_at` and `result`.
 */
export interface JobRecordRow {
  id: string;
  job: string;
  data: Record<string, unknown>;
  schedulingType: string | null;
  startedAt: Date;
}

export const INSERT_RUNNING_SQL = `
  INSERT INTO jobs (id, job, status, scheduling_type, created_at, started_at, target, result)
  VALUES ($1, $2, 'running', $3, now(), $4, $5::jsonb, NULL)
`;

export const MARK_FINISHED_SQL = `
  UPDATE jobs
     SET status = $2,
         finished_at = now(),
         result = $3::jsonb
   WHERE id = $1
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
    ]);
  }

  async markFinished(
    id: string,
    status: Extract<JobStatus, 'completed' | 'failed'>,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(MARK_FINISHED_SQL, [id, status, JSON.stringify(result)]);
  }
}
