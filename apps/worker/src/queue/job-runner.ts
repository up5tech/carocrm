import { randomUUID } from 'node:crypto';

import { runWithRequestContext } from '@carocrm/core/context/index.js';
import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobLogLevel, JobRegistry, JobRunResult } from '@carocrm/jobs';

import { errorMessage, truncate } from '../db.js';
import type { JobPayload } from './job-payload.js';
import type { JobRepository } from './job-repository.js';

/**
 * Executes one job attempt and keeps the durable `jobs` row current (PLAN §24: progress, logs,
 * cancellation).
 *
 * A job submitted through the Jobs API already owns a `pending` row; the first attempt adopts it so
 * the Admin UI, its progress and its log lines all point at one record. Scheduled runs and later
 * attempts create their own row, which keeps the per-attempt dead-letter trail.
 */
export type JobRunOutcome =
  | { status: 'completed'; jobRowId: string; result: Record<string, unknown> }
  | { status: 'cancelled'; jobRowId: string | null; message: string }
  | { status: 'failed'; jobRowId: string | null; message: string; retry: boolean };

export interface JobRunRequest {
  payload: JobPayload;
  /** BullMQ job id (optional so direct calls / tests can omit it). */
  queueJobId?: string | undefined;
  /** 1-based attempt counter. */
  attempt: number;
  maxAttempts: number;
}

export interface JobRunnerDeps {
  registry: JobRegistry;
  repo: JobRepository;
  log: Logger;
  /** Clock injection keeps the progress throttle testable. */
  now?: () => number;
}

const PROGRESS_MIN_INTERVAL_MS = 400;
const CANCEL_POLL_MS = 1_000;

export async function runJob(deps: JobRunnerDeps, request: JobRunRequest): Promise<JobRunOutcome> {
  const { payload } = request;
  const handler = deps.registry.get(payload.job);

  if (handler === undefined) {
    const message = `No job handler registered for "${payload.job}". Registered: ${deps.registry.list().join(', ')}`;
    deps.log.error({ job: payload.job }, message);
    return { status: 'failed', jobRowId: null, message, retry: false };
  }

  const queueJobId = request.queueJobId === '' ? null : (request.queueJobId ?? null);
  const row = await openRow(deps, request, queueJobId);
  if (row.cancelled) {
    return { status: 'cancelled', jobRowId: row.id, message: 'Job was cancelled before it started.' };
  }

  const meta: Record<string, unknown> = {
    jobRowId: row.id,
    job: payload.job,
    queueJobId,
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
    // Carried from the HTTP request that enqueued the job; a scheduled/worker-created job has none.
    correlationId: payload.correlationId ?? null,
    scheduleId: payload.scheduleId ?? null,
    scheduledForMs: payload.scheduledForMs ?? null,
  };

  const tracker = createTracker(deps, row.id, meta);
  const context: JobContext = {
    data: payload.data,
    ...(payload.scheduleId === undefined ? {} : { scheduleId: payload.scheduleId }),
    ...(payload.scheduledForMs === undefined ? {} : { scheduledForMs: payload.scheduledForMs }),
    ...userIdContext(payload),
    progress: (percent, message) => tracker.progress(percent, message),
    log: (message, level) => tracker.log(message, level),
    shouldStop: () => tracker.shouldStop(),
  };

  let runResult: JobRunResult;
  try {
    // Every log line the handler writes inherits the request id from the enqueue, so an operator can
    // move from the HTTP request to the job's logs without guessing by timestamp (22.21).
    runResult = await runWithRequestContext(
      {
        requestId: payload.correlationId ?? `job:${row.id}`,
        ...(typeof payload.data['userId'] === 'string' ? { userId: payload.data['userId'] } : {}),
      },
      () => handler(context),
    );
  } catch (error: unknown) {
    const message = truncate(errorMessage(error));
    await deps.repo.markFinished(row.id, 'failed', { ...meta, reason: 'handler_threw' }, tracker.lastMessage, message);
    deps.log.error({ ...meta, error: message }, 'job attempt failed');
    return { status: 'failed', jobRowId: row.id, message, retry: true };
  }

  if (runResult.status === 'cancelled') {
    const message = runResult.message ?? 'Job was cancelled.';
    await deps.repo.markFinished(row.id, 'cancelled', { ...meta }, message, null);
    deps.log.warn({ ...meta, message }, 'job cancelled');
    return { status: 'cancelled', jobRowId: row.id, message };
  }

  if (runResult.status === 'completed') {
    // An admin cancel that arrived while the handler was finishing is reported, not hidden.
    const stopAsked = await tracker.cancelRequestedNow();
    if (stopAsked) {
      const message = runResult.message ?? 'Cancellation was requested during the final step.';
      await deps.repo.markFinished(row.id, 'cancelled', { ...meta, ...resultOf(runResult) }, message, null);
      deps.log.warn({ ...meta, message }, 'job cancelled');
      return { status: 'cancelled', jobRowId: row.id, message };
    }
    const result: Record<string, unknown> = {
      ...meta,
      status: runResult.status,
      ...(runResult.message === undefined ? {} : { message: runResult.message }),
      ...(runResult.result === undefined ? {} : { result: runResult.result }),
    };
    await deps.repo.markFinished(row.id, 'completed', result, runResult.message ?? tracker.lastMessage, null);
    deps.log.info({ ...meta, message: runResult.message ?? null }, 'job completed');
    return { status: 'completed', jobRowId: row.id, result: runResult.result ?? {} };
  }

  const message = runResult.message ?? `Job "${payload.job}" reported status "${runResult.status}".`;
  await deps.repo.markFinished(row.id, 'failed', { ...meta, reason: 'handler_returned_failed' }, tracker.lastMessage, message);
  deps.log.error({ ...meta, message }, 'job attempt reported failure');
  return { status: 'failed', jobRowId: row.id, message, retry: true };
}

function userIdContext(payload: JobPayload): { userId?: string } {
  const userId = payload.data['userId'];
  return typeof userId === 'string' && userId !== '' ? { userId } : {};
}

function resultOf(runResult: JobRunResult): Record<string, unknown> {
  return runResult.result === undefined ? {} : { result: runResult.result };
}

/** Resolves the row this attempt writes to: adopt the API's pending row, else own a fresh one. */
async function openRow(
  deps: JobRunnerDeps,
  request: JobRunRequest,
  queueJobId: string | null,
): Promise<{ id: string; cancelled: boolean }> {
  const { payload } = request;
  const provided = payload.jobRowId;

  if (provided !== undefined) {
    if (await deps.repo.adoptPending(provided, queueJobId, request.attempt, request.maxAttempts)) {
      return { id: provided, cancelled: false };
    }
    if (await deps.repo.isCancelRequested(provided)) return { id: provided, cancelled: true };
  }

  const id = randomUUID();
  await deps.repo.insertRunning({
    id,
    job: payload.job,
    data: payload.data,
    schedulingType: payload.scheduleId === undefined ? null : 'cron',
    startedAt: new Date(),
    queueJobId,
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
  });
  return { id, cancelled: false };
}

interface AttemptTracker {
  progress(percent: number, message?: string): void;
  log(message: string, level?: JobLogLevel): void;
  shouldStop(): Promise<boolean>;
  cancelRequestedNow(): Promise<boolean>;
  readonly lastMessage: string | null;
}

function createTracker(deps: JobRunnerDeps, rowId: string, meta: Record<string, unknown>): AttemptTracker {
  const now = deps.now ?? (() => Date.now());
  let lastPercent: number | null = null;
  let lastMessage: string | null = null;
  let lastWriteAt = 0;
  let cancelCache: { at: number; value: boolean } = { at: 0, value: false };

  const flush = (percent: number, message: string | null): void => {
    lastPercent = percent;
    lastMessage = message ?? lastMessage;
    lastWriteAt = now();
    void deps.repo.updateProgress(rowId, percent, message).catch((error: unknown) => {
      deps.log.warn({ ...meta, error: errorMessage(error) }, 'job progress update failed');
    });
  };

  return {
    get lastMessage(): string | null {
      return lastMessage;
    },
    progress(percent: number, message?: string): void {
      const clamped = Math.max(0, Math.min(100, Math.trunc(percent)));
      if (lastPercent === clamped && (message === undefined || now() - lastWriteAt < PROGRESS_MIN_INTERVAL_MS)) {
        if (message !== undefined) lastMessage = message;
        return;
      }
      flush(clamped, message ?? null);
    },
    log(message: string, level: JobLogLevel = 'info'): void {
      const text = truncate(message, 2_000);
      lastMessage = text;
      void deps.repo.appendLog(rowId, level, text).catch((error: unknown) => {
        deps.log.warn({ ...meta, error: errorMessage(error) }, 'job log write failed');
      });
      deps.log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ ...meta, message: text }, 'job log');
    },
    async shouldStop(): Promise<boolean> {
      const at = now();
      if (at - cancelCache.at < CANCEL_POLL_MS) return cancelCache.value;
      const value = await deps.repo.isCancelRequested(rowId);
      cancelCache = { at, value };
      return value;
    },
    async cancelRequestedNow(): Promise<boolean> {
      const value = await deps.repo.isCancelRequested(rowId);
      cancelCache = { at: now(), value };
      return value;
    },
  };
}
