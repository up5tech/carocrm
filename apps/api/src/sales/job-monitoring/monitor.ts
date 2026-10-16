import { Inject, Injectable } from '@nestjs/common';

import { JobsService } from '../../jobs/jobs.service.js';

/**
 * Phase 19-S.18 — job monitoring for the background work Sales runs (§10.1, §16.2).
 *
 * The kernel owns `jobs`, `job_logs` and `scheduled_jobs` and already serves them at
 * `/api/v1/Job` and `/api/v1/ScheduledJob` (with the admin UI in `AdminJobsPage`). This service only
 * answers the operator's Sales-shaped question — "did the nightly billing run work?" — by reading
 * the same durable records for the jobs this module registers. It starts nothing and cancels nothing:
 * those stay on the generic routes, where their permissions live.
 */
export const SALES_JOB_NAMES: readonly string[] = [
  'sales.expireQuotes',
  'sales.markOverdueInvoices',
  'sales.generateSubscriptionInvoices',
];

const RECENT_RUNS = 10;

@Injectable()
export class SalesJobMonitorService {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  /** The last attempts of every Sales job, its schedules, and the live queue depth. */
  async overview(): Promise<Record<string, unknown>> {
    const runs = await Promise.all(
      SALES_JOB_NAMES.map(async (job) => {
        const { list, total } = await this.jobs.list({ job, status: undefined, offset: 0, limit: RECENT_RUNS });
        return {
          job,
          total,
          recent: list.map((row) => ({
            id: row.id,
            status: row.status,
            attempt: row.attempt,
            maxAttempts: row.maxAttempts,
            progress: row.progress,
            message: row.message,
            lastError: row.lastError,
            result: row.result,
            createdAt: row.createdAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
          })),
        };
      }),
    );
    const { list: schedules } = await this.jobs.listSchedules();
    return {
      runs,
      schedules: schedules
        .filter((schedule) => SALES_JOB_NAMES.includes(schedule.job))
        .map((schedule) => ({
          id: schedule.id,
          job: schedule.job,
          scheduling: schedule.scheduling,
          enabled: schedule.enabled,
          lastRunAt: schedule.lastRunAt,
        })),
      queue: await this.jobs.queueCounts(),
    };
  }
}
