import type { JobContext, JobRunResult } from '@carocrm/jobs';
import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import { FakeDb } from '../testing/fake-db.js';
import { createTestLogger } from '../testing/test-logger.js';
import type { JobPayload } from './job-payload.js';
import { INSERT_RUNNING_SQL, JobRepository, MARK_FINISHED_SQL } from './job-repository.js';
import { type JobRunOutcome,runJob } from './job-runner.js';

const INSERT_FRAGMENT = 'insert into jobs';
const FINISH_FRAGMENT = 'update jobs';

type FailedOutcome = Extract<JobRunOutcome, { status: 'failed' }>;

function expectFailed(outcome: JobRunOutcome): FailedOutcome {
  if (outcome.status !== 'failed') throw new Error(`expected a failed outcome, got ${outcome.status}`);
  return outcome;
}

interface Harness {
  db: FakeDb;
  registry: JobRegistry;
  repo: JobRepository;
  logger: ReturnType<typeof createTestLogger>;
  run: (payload: JobPayload) => Promise<JobRunOutcome>;
}

function harness(): Harness {
  const db = new FakeDb();
  const logger = createTestLogger();
  const registry = new JobRegistry();
  const repo = new JobRepository(db);
  return {
    db,
    registry,
    repo,
    logger,
    run: (payload) => runJob({ registry, repo, log: logger.log }, { payload, attempt: 1, maxAttempts: 3 }),
  };
}

describe('jobs table statements', () => {
  it('records a running row and closes it with a terminal status', () => {
    const insert = INSERT_RUNNING_SQL.toLowerCase();
    expect(insert).toContain("values ($1, $2, 'running'");
    expect(insert).toContain('started_at');
    expect(insert).toContain('scheduling_type');
    expect(insert).toContain('$5::jsonb');
    const finish = MARK_FINISHED_SQL.toLowerCase();
    expect(finish).toContain('set status = $2');
    expect(finish).toContain('finished_at = now()');
    expect(finish).toContain('result = $3::jsonb');
  });
});

describe('runJob', () => {
  it('runs a registered handler and writes running -> completed with the result', async () => {
    const seen: JobContext[] = [];
    const { db, registry, run } = harness();
    registry.register('demo.echo', async (context: JobContext): Promise<JobRunResult> => {
      seen.push(context);
      return { status: 'completed', message: 'echoed', result: { echo: context.data ?? {} } };
    });

    const outcome = await run({ job: 'demo.echo', data: { greeting: 'hi' } });

    expect(outcome.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data).toEqual({ greeting: 'hi' });

    const insert = db.lastCall(INSERT_FRAGMENT);
    expect(insert?.params[1]).toBe('demo.echo');
    expect(insert?.params[2]).toBeNull();
    expect(insert?.params[3]).toBeInstanceOf(Date);
    expect(insert?.params[4]).toBe(JSON.stringify({ greeting: 'hi' }));

    const finish = db.lastCall(FINISH_FRAGMENT);
    expect(finish?.params[1]).toBe('completed');
    const stored = JSON.parse(String(finish?.params[2])) as Record<string, unknown>;
    expect(stored.status).toBe('completed');
    expect(stored.message).toBe('echoed');
    expect(stored.result).toEqual({ echo: { greeting: 'hi' } });
    expect(stored.jobRowId).toBe(insert?.params[0]);
    expect(stored.attempt).toBe(1);
    expect(stored.maxAttempts).toBe(3);
  });

  it('passes userId from the job data into the handler context', async () => {
    let captured: JobContext | undefined;
    const { registry, run } = harness();
    registry.register('demo.user', async (context: JobContext): Promise<JobRunResult> => {
      captured = context;
      return { status: 'completed' };
    });

    await run({ job: 'demo.user', data: { userId: 'adminUserId' } });

    expect(captured?.userId).toBe('adminUserId');
  });

  it('marks the running row with scheduling_type = cron for scheduled payloads', async () => {
    const { db, registry, run } = harness();
    registry.register('demo.scheduled', async (): Promise<JobRunResult> => ({ status: 'completed' }));

    await run({ job: 'demo.scheduled', data: {}, scheduleId: 'daily', scheduledForMs: 1700000000000 });

    expect(db.lastCall(INSERT_FRAGMENT)?.params[2]).toBe('cron');
    const stored = JSON.parse(String(db.lastCall(FINISH_FRAGMENT)?.params[2])) as Record<string, unknown>;
    expect(stored.scheduleId).toBe('daily');
    expect(stored.scheduledForMs).toBe(1700000000000);
  });

  it('fails the row and asks for a retry when the handler throws', async () => {
    const { db, registry, run, logger } = harness();
    registry.register('demo.boom', async (): Promise<JobRunResult> => {
      throw new Error('kaboom');
    });

    const outcome = expectFailed(await run({ job: 'demo.boom', data: {} }));

    expect(outcome.retry).toBe(true);
    expect(outcome.message).toContain('kaboom');
    expect(db.lastCall(FINISH_FRAGMENT)?.params[1]).toBe('failed');
    const stored = JSON.parse(String(db.lastCall(FINISH_FRAGMENT)?.params[2])) as Record<string, unknown>;
    expect(stored.reason).toBe('handler_threw');
    expect(logger.recordsAt('error')).toHaveLength(1);
  });

  it('fails the row and retries when the handler reports a failed status', async () => {
    const { db, registry, run } = harness();
    registry.register('demo.nope', async (): Promise<JobRunResult> => ({
      status: 'failed',
      message: 'upstream rejected',
    }));

    const outcome = expectFailed(await run({ job: 'demo.nope', data: {} }));

    expect(outcome.retry).toBe(true);
    expect(outcome.message).toBe('upstream rejected');
    const stored = JSON.parse(String(db.lastCall(FINISH_FRAGMENT)?.params[2])) as Record<string, unknown>;
    expect(stored.reason).toBe('handler_returned_failed');
  });

  it('does not retry unknown jobs and records no running row', async () => {
    const { db, run, logger } = harness();

    const outcome = expectFailed(await run({ job: 'not.registered', data: {} }));

    expect(outcome.retry).toBe(false);
    expect(outcome.jobRowId).toBeNull();
    expect(outcome.message).toContain('No job handler registered for "not.registered"');
    expect(db.callsFor(INSERT_FRAGMENT)).toHaveLength(0);
    expect(logger.recordsAt('error')).toHaveLength(1);
  });

  it('surfaces bookkeeping failures so BullMQ retries instead of losing the job', async () => {
    const { db, registry, run } = harness();
    registry.register('demo.db', async (): Promise<JobRunResult> => ({ status: 'completed' }));
    db.throws(INSERT_FRAGMENT, new Error('jobs table unavailable'));

    await expect(run({ job: 'demo.db', data: {} })).rejects.toThrow('jobs table unavailable');
  });
});
