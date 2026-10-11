import type { JobsTable, ScheduledJobsTable } from '../database/database.service.js';

export interface JobView {
  id: string;
  job: string;
  status: string;
  schedulingType: string | null;
  attempt: number;
  maxAttempts: number;
  progress: number;
  message: string | null;
  lastError: string | null;
  cancelRequested: boolean;
  queueJobId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  data: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export interface ScheduleView {
  id: string;
  job: string;
  scheduling: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  modifiedAt: string;
  data: Record<string, unknown>;
}

function objectOf(value: unknown): Record<string, unknown> {
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

export function toJobView(row: JobsTable): JobView {
  return {
    id: row.id,
    job: row.job,
    status: row.status,
    schedulingType: row.scheduling_type,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    progress: row.progress ?? 0,
    message: row.message,
    lastError: row.last_error,
    cancelRequested: row.cancel_requested,
    queueJobId: row.queue_job_id,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    data: objectOf(row.target),
    result: row.result === null ? null : objectOf(row.result),
  };
}

export function toScheduleView(row: ScheduledJobsTable): ScheduleView {
  return {
    id: row.id,
    job: row.job,
    scheduling: row.scheduling,
    enabled: row.enabled,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    data: objectOf(row.target),
  };
}
