import { getRequestId } from '@carocrm/core/context/index.js';
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

  it('runs the handler inside the request context of the enqueue (22.21)', async () => {
    let seen: string | undefined;
    const { registry, run } = harness();
    registry.register('demo.trace', async (): Promise<JobRunResult> => {
      seen = getRequestId();
      return { status: 'completed' };
    });

    await run({ job: 'demo.trace', data: {}, correlationId: 'req-77' });

    expect(seen).toBe('req-77');
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

describe('runJob — progress, logs and cancellation (PLAN §24)', () => {
  const ADOPT_FRAGMENT = 'and cancel_requested = false';
  const CANCEL_FRAGMENT = 'select cancel_requested from jobs';
  const PROGRESS_FRAGMENT = 'set progress';
  const LOG_FRAGMENT = 'insert into job_logs';
  const FINISH_FRAGMENT = 'finished_at = now()';

  interface RefinedHarness extends Harness {
    runWith: (payload: JobPayload, clock?: () => number) => Promise<JobRunOutcome>;
  }

  function refined(): RefinedHarness {
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
      runWith: (payload, clock) =>
        runJob(
          { registry, repo, log: logger.log, ...(clock === undefined ? {} : { now: clock }) },
          { payload, attempt: 1, maxAttempts: 3 },
        ),
    };
  }

  it('adopts the pending row the Jobs API created instead of inserting a second one', async () => {
    const { db, registry, runWith } = refined();
    db.returns(ADOPT_FRAGMENT, [{ id: 'row-1' }]);
    registry.register('demo.adopt', async (): Promise<JobRunResult> => ({ status: 'completed' }));

    const outcome = await runWith({ job: 'demo.adopt', data: {}, jobRowId: 'row-1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.jobRowId).toBe('row-1');
    expect(db.callsFor(INSERT_FRAGMENT)).toHaveLength(0);
    const adopt = db.lastCall(ADOPT_FRAGMENT);
    expect(adopt?.params[0]).toBe('row-1');
    expect(db.lastCall(FINISH_FRAGMENT)?.params[0]).toBe('row-1');
  });

  it('skips the handler when the row was already cancelled', async () => {
    const { db, registry, runWith, logger } = refined();
    db.returns(ADOPT_FRAGMENT, []);
    db.returns(CANCEL_FRAGMENT, [{ cancel_requested: true }]);
    let ran = false;
    registry.register('demo.gone', async (): Promise<JobRunResult> => {
      ran = true;
      return { status: 'completed' };
    });

    const outcome = await runWith({ job: 'demo.gone', data: {}, jobRowId: 'row-2' });

    expect(outcome.status).toBe('cancelled');
    expect(ran).toBe(false);
    expect(db.callsFor(INSERT_FRAGMENT)).toHaveLength(0);
    expect(logger.recordsAt('warn')).toHaveLength(0);
  });

  it('writes a fresh row when the pending row vanished (a retry attempt)', async () => {
    const { db, registry, runWith } = refined();
    db.returns(ADOPT_FRAGMENT, []);
    db.returns(CANCEL_FRAGMENT, [{ cancel_requested: false }]);
    registry.register('demo.retry', async (): Promise<JobRunResult> => ({ status: 'completed' }));

    const outcome = await runWith({ job: 'demo.retry', data: {}, jobRowId: 'row-3' });

    expect(outcome.status).toBe('completed');
    expect(outcome.jobRowId).not.toBe('row-3');
    expect(db.callsFor(INSERT_FRAGMENT)).toHaveLength(1);
  });

  it('records progress, clamps it and does not write the same percent twice', async () => {
    const { db, registry, runWith } = refined();
    let clock = 1_000;
    registry.register('demo.progress', async (context: JobContext): Promise<JobRunResult> => {
      context.progress(0);
      context.progress(50, 'halfway');
      context.progress(50);
      context.progress(140);
      return { status: 'completed' };
    });

    await runWith({ job: 'demo.progress', data: {} }, () => clock);
    clock = 9_000;

    const writes = db.callsFor(PROGRESS_FRAGMENT);
    expect(writes.map((call) => call.params[1])).toEqual([0, 50, 100]);
    expect(writes[1]?.params[2]).toBe('halfway');
  });

  it('appends job log lines and mirrors them to the worker logger', async () => {
    const { db, registry, runWith, logger } = refined();
    registry.register('demo.logging', async (context: JobContext): Promise<JobRunResult> => {
      context.log('starting batch');
      context.log('disk almost full', 'warn');
      return { status: 'completed' };
    });

    await runWith({ job: 'demo.logging', data: {} });

    const lines = db.callsFor(LOG_FRAGMENT);
    expect(lines.map((call) => [call.params[1], call.params[2]])).toEqual([
      ['info', 'starting batch'],
      ['warn', 'disk almost full'],
    ]);
    expect(logger.recordsAt('warn').length).toBeGreaterThanOrEqual(1);
    const finish = db.lastCall(FINISH_FRAGMENT);
    expect(finish?.params[3]).toBe('disk almost full');
  });

  it('lets a long job stop cooperatively and reports the row as cancelled', async () => {
    const { db, registry, runWith } = refined();
    db.returns(CANCEL_FRAGMENT, [{ cancel_requested: true }]);
    registry.register('demo.stops', async (context: JobContext): Promise<JobRunResult> => {
      if (await context.shouldStop()) {
        context.log('stopping at the user request');
        return { status: 'cancelled', message: 'stopped after 3 batches' };
      }
      return { status: 'completed' };
    });

    const outcome = await runWith({ job: 'demo.stops', data: {} });

    expect(outcome.status).toBe('cancelled');
    expect(db.lastCall(FINISH_FRAGMENT)?.params[1]).toBe('cancelled');
  });

  it('reports a completion that arrived after an admin cancel as cancelled', async () => {
    const { db, registry, runWith } = refined();
    // the admin cancelled while the handler was still finishing
    db.returns(CANCEL_FRAGMENT, [{ cancel_requested: true }]);
    registry.register('demo.race', async (): Promise<JobRunResult> => ({ status: 'completed', result: { rows: 5 } }));

    const outcome = await runWith({ job: 'demo.race', data: {} });

    expect(outcome.status).toBe('cancelled');
    expect(db.lastCall(FINISH_FRAGMENT)?.params[1]).toBe('cancelled');
  });
});
