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

/**
 * Phase 23.7 — job metadata is an operator-facing artifact and can carry a credential the caller
 * put in `data` (a provider key, a SMTP password, an OAuth token). The worker still receives the
 * original payload; only the admin API view is redacted. The match is deliberately broad, and a
 * depth bound keeps a hostile cyclic/oversized payload from turning a read into a traversal.
 */
const SENSITIVE_KEY = /(?:password|secret|token|api[_-]?key|authorization|cookie|credential)/i;
const MAX_REDACT_DEPTH = 8;

export function redactJobValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[REDACTED:too-deep]';
  if (Array.isArray(value)) return value.map((item) => redactJobValue(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactJobValue(item, depth + 1);
  }
  return output;
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
    data: redactJobValue(objectOf(row.target)) as Record<string, unknown>,
    result: row.result === null ? null : (redactJobValue(objectOf(row.result)) as Record<string, unknown>),
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
    data: redactJobValue(objectOf(row.target)) as Record<string, unknown>,
  };
}
