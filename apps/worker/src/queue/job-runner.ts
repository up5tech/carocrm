import { randomUUID } from 'node:crypto';

import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobRegistry, JobRunResult } from '@carocrm/jobs';

import { errorMessage, truncate } from '../db.js';
import type { JobPayload } from './job-payload.js';
import type { JobRepository } from './job-repository.js';

/**
 * Executes one job attempt: registers a `jobs` row (`running`) before the handler runs and
 * closes it with `completed` / `failed`. Everything that can go wrong is recorded, and the
 * outcome tells the BullMQ consumer whether the attempt should be retried.
 */
export type JobRunOutcome =
  | { status: 'completed'; jobRowId: string; result: Record<string, unknown> }
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
}

export async function runJob(deps: JobRunnerDeps, request: JobRunRequest): Promise<JobRunOutcome> {
  const { payload } = request;
  const handler = deps.registry.get(payload.job);

  if (handler === undefined) {
    const message = `No job handler registered for "${payload.job}". Registered: ${deps.registry.list().join(', ')}`;
    deps.log.error({ job: payload.job }, message);
    return { status: 'failed', jobRowId: null, message, retry: false };
  }

  const jobRowId = randomUUID();
  await deps.repo.insertRunning({
    id: jobRowId,
    job: payload.job,
    data: payload.data,
    schedulingType: payload.scheduleId === undefined ? null : 'cron',
    startedAt: new Date(),
  });

  const meta: Record<string, unknown> = {
    jobRowId,
    job: payload.job,
    queueJobId: request.queueJobId ?? null,
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
    scheduleId: payload.scheduleId ?? null,
    scheduledForMs: payload.scheduledForMs ?? null,
  };

  let runResult: JobRunResult;
  try {
    runResult = await handler({ data: payload.data, ...userIdContext(payload) });
  } catch (error: unknown) {
    const message = truncate(errorMessage(error));
    await deps.repo.markFinished(jobRowId, 'failed', { ...meta, message, reason: 'handler_threw' });
    deps.log.error({ ...meta, error: message }, 'job attempt failed');
    return { status: 'failed', jobRowId, message, retry: true };
  }

  if (runResult.status === 'completed') {
    const result: Record<string, unknown> = {
      ...meta,
      status: runResult.status,
      ...(runResult.message === undefined ? {} : { message: runResult.message }),
      ...(runResult.result === undefined ? {} : { result: runResult.result }),
    };
    await deps.repo.markFinished(jobRowId, 'completed', result);
    deps.log.info({ ...meta, message: runResult.message ?? null }, 'job completed');
    return { status: 'completed', jobRowId, result: runResult.result ?? {} };
  }

  const message = runResult.message ?? `Job "${payload.job}" reported status "${runResult.status}".`;
  await deps.repo.markFinished(jobRowId, 'failed', {
    ...meta,
    message,
    reason: 'handler_returned_failed',
  });
  deps.log.error({ ...meta, message }, 'job attempt reported failure');
  return { status: 'failed', jobRowId, message, retry: true };
}

function userIdContext(payload: JobPayload): { userId?: string } {
  const userId = payload.data['userId'];
  return typeof userId === 'string' && userId !== '' ? { userId } : {};
}
