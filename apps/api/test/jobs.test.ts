import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `j${Date.now().toString(36)}`;
const scheduleId = `agentTest${runId}`;

let ctx: ApiContext;
let adminToken = '';
let scratch: Queue | undefined;
const jobIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function codeOf(body: Record<string, unknown>): string {
  return String(((body['error'] ?? {}) as { code?: string }).code ?? '');
}

/** Validation text lives on `error.message`; `details` carries the offending value. */
function messageOf(body: Record<string, unknown>): string {
  const error = (body['error'] ?? {}) as { message?: string; details?: Record<string, unknown> };
  return String(error.details?.['reason'] ?? error.message ?? '');
}

async function runJob(job: string, data: Record<string, unknown> = {}): Promise<CallResult> {
  const res = await call('POST', '/api/v1/Job', adminToken, { jobName: job, data });
  const id = res.body['id'];
  if (typeof id === 'string') jobIds.push(id);
  return res;
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
});

afterAll(async () => {
  // Remove the test rows this suite created, then drop the scratch queue (AGENTS.md §3.3).
  for (const id of jobIds) {
    await ctx.database.db.deleteFrom('jobs').where('id', '=', id).execute();
  }
  await ctx.database.db.deleteFrom('scheduled_jobs').where('id', '=', scheduleId).execute();
  if (scratch) {
    await scratch.obliterate({ force: true }).catch(() => undefined);
    await scratch.close().catch(() => undefined);
  }
  await shutdownApi();
});

describe('one-off jobs (PLAN §24)', () => {
  it('submits a job, records the durable row and links the queue entry', async () => {
    const res = await runJob('system.noop', { marker: runId });
    expect(res.status).toBe(201);
    expect(res.body['status']).toBe('pending');
    expect(res.body['job']).toBe('system.noop');
    expect(res.body['queueJobId']).toBeTruthy();
    expect(res.body['attempt']).toBe(1);
    expect(res.body['maxAttempts']).toBe(3);
    expect(res.body['progress']).toBe(0);

    scratch = new Queue(ctx.config.jobQueueName, {
      connection: new Redis(ctx.config.redisUrl, { maxRetriesPerRequest: null }),
    });
    expect(await scratch.getWaitingCount()).toBeGreaterThanOrEqual(1);

    const single = await call('GET', `/api/v1/Job/${String(res.body['id'])}`, adminToken);
    expect(single.status).toBe(200);
    expect(single.body['data']).toEqual({ marker: runId });
  });

  it('lists jobs with the queue state and filters by status', async () => {
    const list = await call('GET', '/api/v1/Job?status=pending&limit=50', adminToken);
    expect(list.status).toBe(200);
    const rows = list.body['list'] as { status: string; job: string }[];
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(rows.some((row) => row.job === 'system.noop')).toBe(true);
    expect(typeof list.body['total']).toBe('number');
    expect(list.body['queue']).toBeTypeOf('object');

    const bad = await call('GET', '/api/v1/Job?status=nope', adminToken);
    expect(bad.status).toBe(422);
  });

  it('rejects a job name the worker registry could never hold', async () => {
    const res = await call('POST', '/api/v1/Job', adminToken, { jobName: 'cleanup' });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    expect(messageOf(res.body)).toContain('<module>.<action>');
  });

  it('rejects oversized job data', async () => {
    const res = await call('POST', '/api/v1/Job', adminToken, { jobName: 'system.noop', data: { blob: 'x'.repeat(40_000) } });
    expect(res.status).toBe(422);
    expect(messageOf(res.body)).toContain('too large');
  });

  it('cancels a waiting job and leaves terminal jobs alone', async () => {
    const created = await runJob('system.noop', { cancel: runId });
    const id = String(created.body['id']);

    const cancelled = await call('POST', `/api/v1/Job/${id}/action/cancel`, adminToken);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body['status']).toBe('cancelled');
    expect(cancelled.body['cancelRequested']).toBe(true);
    expect(cancelled.body['finishedAt']).toBeTruthy();

    // A second cancel is a no-op, not an error.
    const again = await call('POST', `/api/v1/Job/${id}/action/cancel`, adminToken);
    expect(again.body['status']).toBe('cancelled');

    const unknown = await call('POST', '/api/v1/Job/00000000-0000-4000-8000-000000000000/action/cancel', adminToken);
    expect(unknown.status).toBe(404);
  });

  it('serves progress and log lines written by a worker attempt', async () => {
    const created = await runJob('system.noop', {});
    const id = String(created.body['id']);

    await ctx.database.db
      .updateTable('jobs')
      .set({ status: 'running', progress: 40, message: 'halfway', started_at: new Date() })
      .where('id', '=', id)
      .execute();
    await ctx.database.db
      .insertInto('job_logs')
      .values([
        { job_id: id, level: 'info', message: 'scanned 3 rows', created_at: new Date() },
        { job_id: id, level: 'warn', message: 'retrying batch 2', created_at: new Date() },
      ])
      .execute();

    const job = await call('GET', `/api/v1/Job/${id}`, adminToken);
    expect(job.body['progress']).toBe(40);
    expect(job.body['message']).toBe('halfway');

    const logs = await call('GET', `/api/v1/Job/${id}/log`, adminToken);
    expect(logs.status).toBe(200);
    const lines = logs.body['lines'] as { level: string; message: string }[];
    expect(lines.map((line) => line.message)).toEqual(['scanned 3 rows', 'retrying batch 2']);
    expect(lines[1]?.level).toBe('warn');
  });

  it('is admin-only', async () => {
    const user = await createTestUser(ctx, { userName: `nojobs${runId}` });
    const denied = await call('POST', '/api/v1/Job', user.token, { jobName: 'system.noop' });
    expect(denied.status).toBe(403);
    expect(codeOf(denied.body)).toBe('AUTHORIZATION_DENIED');
    const deniedList = await call('GET', '/api/v1/Job', user.token);
    expect(deniedList.status).toBe(403);
  });
});

describe('scheduled jobs (PLAN §24)', () => {
  it('stores a cron schedule as metadata and lists it back', async () => {
    const upsert = await call('POST', '/api/v1/ScheduledJob', adminToken, {
      id: scheduleId,
      job: 'system.cleanupOutbox',
      scheduling: '15 * * * *',
      data: { retentionDays: 3 },
    });
    expect(upsert.status).toBe(200);
    expect(upsert.body['scheduling']).toBe('15 * * * *');
    expect(upsert.body['enabled']).toBe(true);
    expect(upsert.body['data']).toEqual({ retentionDays: 3 });

    const list = await call('GET', '/api/v1/ScheduledJob', adminToken);
    const rows = list.body['list'] as { id: string }[];
    expect(rows.some((row) => row.id === scheduleId)).toBe(true);
  });

  it('refuses an expression the scheduler cannot parse', async () => {
    const res = await call('POST', '/api/v1/ScheduledJob', adminToken, { id: `${scheduleId}Bad`, job: 'system.noop', scheduling: '99 * * * *' });
    expect(res.status).toBe(422);
    expect(messageOf(res.body)).toContain('cron expression');
  });

  it('previews the next runs of an expression', async () => {
    const res = await call('POST', '/api/v1/ScheduledJob/action/preview', adminToken, { scheduling: '0 * * * *' });
    expect(res.status).toBe(200);
    expect(res.body['valid']).toBe(true);
    expect(res.body['next']).toHaveLength(3);

    const invalid = await call('POST', '/api/v1/ScheduledJob/action/preview', adminToken, { scheduling: 'not a cron' });
    expect(invalid.body['valid']).toBe(false);
  });

  it('disables and re-enables a schedule', async () => {
    const disabled = await call('POST', `/api/v1/ScheduledJob/${scheduleId}/disable`, adminToken);
    expect(disabled.status).toBe(200);
    expect(disabled.body['enabled']).toBe(false);

    const enabled = await call('POST', `/api/v1/ScheduledJob/${scheduleId}/enable`, adminToken);
    expect(enabled.body['enabled']).toBe(true);

    const missing = await call('POST', '/api/v1/ScheduledJob/agentTestMissing/enable', adminToken);
    expect(missing.status).toBe(404);
  });

  it('runs a schedule now as a one-off job row', async () => {
    const res = await call('POST', `/api/v1/ScheduledJob/${scheduleId}/action/runNow`, adminToken);
    expect(res.status).toBe(200);
    const id = String(res.body['id']);
    jobIds.push(id);
    expect(res.body['job']).toBe('system.cleanupOutbox');
    expect(res.body['schedulingType']).toBe('cron');
    expect(res.body['data']).toEqual({ retentionDays: 3 });

    const schedule = await call('GET', '/api/v1/ScheduledJob', adminToken);
    const row = (schedule.body['list'] as { id: string; lastRunAt: string | null }[]).find((item) => item.id === scheduleId);
    expect(row?.lastRunAt).toBeTruthy();
  });

  it('is not reachable through the generic record controller', async () => {
    const res = await call('GET', '/api/v1/Job', adminToken);
    expect(res.status).toBe(200);
    const unknown = await call('GET', '/api/v1/ScheduledJob/agentTestMissing', adminToken);
    expect([404, 400]).toContain(unknown.status);
  });
});
