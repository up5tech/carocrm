import { describe, expect, it } from 'vitest';

import { FakeDb, result } from '../testing/fake-db.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  CLAIM_SCHEDULE_RUN_SQL,
  mapScheduleRow,
  RELEASE_SCHEDULE_RUN_SQL,
  Scheduler,
  SELECT_ENABLED_SCHEDULES_SQL,
} from './scheduler.js';

const SELECT_FRAGMENT = 'from scheduled_jobs';
const CLAIM_FRAGMENT = 'or last_run_at <';
const RELEASE_FRAGMENT = 'set last_run_at';

interface EnqueueCall {
  jobId: string;
  job: string;
  data: Record<string, unknown>;
  scheduleId: string;
  scheduledForMs: number;
}

interface Harness {
  db: FakeDb;
  calls: EnqueueCall[];
  scheduler: Scheduler;
  logger: ReturnType<typeof createTestLogger>;
}

function harness(rows: Record<string, unknown>[], options: { failEnqueue?: boolean } = {}): Harness {
  const db = new FakeDb();
  const logger = createTestLogger();
  const calls: EnqueueCall[] = [];
  db.returns(SELECT_FRAGMENT, rows);
  db.on(CLAIM_FRAGMENT, () => result([{ id: 'claimed' }], 1));
  const scheduler = new Scheduler({
    db,
    log: logger.log,
    intervalMs: 30000,
    enqueue: {
      enqueueScheduled: async (input) => {
        if (options.failEnqueue === true) throw new Error('redis unavailable');
        calls.push(input);
        return input.jobId;
      },
    },
  });
  return { db, calls, scheduler, logger };
}

function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cleanup',
    job: 'system.cleanupOutbox',
    scheduling: '* * * * *',
    target: { retentionDays: 7 },
    last_run_at: null,
    ...overrides,
  };
}

describe('scheduled_jobs SQL shape', () => {
  it('only loads enabled schedules and claims a boundary atomically', () => {
    const select = SELECT_ENABLED_SCHEDULES_SQL.toLowerCase();
    expect(select).toContain('where enabled = true');
    expect(select).toContain('last_run_at');
    const claim = CLAIM_SCHEDULE_RUN_SQL.toLowerCase();
    expect(claim).toContain('and (last_run_at is null or last_run_at < $2)');
    expect(claim).toContain('returning id');
    expect(RELEASE_SCHEDULE_RUN_SQL.toLowerCase()).toContain('set last_run_at = $2');
  });

  it('maps a row into a schedule', () => {
    expect(mapScheduleRow({ ...scheduleRow(), last_run_at: new Date(1700000000000) })).toEqual({
      id: 'cleanup',
      job: 'system.cleanupOutbox',
      cron: '* * * * *',
      data: { retentionDays: 7 },
      lastRunAtMs: 1700000000000,
    });
  });
});

describe('Scheduler.tick', () => {
  const now = new Date('2026-02-10T10:00:30.000Z');

  it('enqueues a due schedule with a deterministic jobId and claims the boundary', async () => {
    const { db, calls, scheduler } = harness([scheduleRow()]);

    expect(await scheduler.tick(now)).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.job).toBe('system.cleanupOutbox');
    expect(call?.scheduleId).toBe('cleanup');
    expect(call?.data).toEqual({ retentionDays: 7 });
    expect(call?.jobId).toBe(`cleanup_${String(call?.scheduledForMs)}`);
    expect(call?.scheduledForMs).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime() - (call?.scheduledForMs ?? 0)).toBeLessThan(60000);

    const claim = db.lastCall(CLAIM_FRAGMENT);
    expect(claim?.params[0]).toBe('cleanup');
    expect(claim?.params[1]).toBeInstanceOf(Date);
    expect((claim?.params[1] as Date).getTime()).toBe(call?.scheduledForMs);
  });

  it('skips a schedule whose last run is at or after the current boundary', async () => {
    const { db, calls, scheduler } = harness([scheduleRow({ last_run_at: new Date(now.getTime() - 1000) })]);

    expect(await scheduler.tick(now)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.callsFor(CLAIM_FRAGMENT)).toHaveLength(0);
  });

  it('skips when another worker already claimed the boundary', async () => {
    const { db, calls, scheduler } = harness([scheduleRow()]);
    db.on(CLAIM_FRAGMENT, () => result([], 0));

    expect(await scheduler.tick(now)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.callsMatching(RELEASE_FRAGMENT, 'returning id')).toHaveLength(0);
  });

  it('rolls the claim back when Redis rejects the enqueue', async () => {
    const { db, scheduler, logger } = harness([scheduleRow()], { failEnqueue: true });

    expect(await scheduler.tick(now)).toBe(0);
    const release = db.lastMatching(RELEASE_FRAGMENT, 'returning id');
    expect(release?.params[0]).toBe('cleanup');
    expect(release?.params[1]).toBeNull();
    expect(logger.recordsAt('error')).toHaveLength(1);
  });

  it('restores the previous last_run_at when the enqueue fails', async () => {
    const previous = new Date(now.getTime() - 120000);
    const { db, scheduler } = harness([scheduleRow({ last_run_at: previous })], { failEnqueue: true });

    await scheduler.tick(now);

    const release = db.lastMatching(RELEASE_FRAGMENT, 'returning id');
    expect(release?.params[1]).toBeInstanceOf(Date);
    expect((release?.params[1] as Date).getTime()).toBe(previous.getTime());
  });

  it('logs and skips an invalid cron expression without breaking the cycle', async () => {
    const { db, calls, scheduler, logger } = harness([scheduleRow({ scheduling: 'this is not cron' })]);

    expect(await scheduler.tick(now)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.callsFor(CLAIM_FRAGMENT)).toHaveLength(0);
    expect(logger.recordsAt('error')).toHaveLength(1);
  });

  it('handles several schedules in one reload', async () => {
    const { calls, scheduler } = harness([
      scheduleRow(),
      scheduleRow({ id: 'sessions', job: 'system.pruneSessions', scheduling: '* * * * *' }),
      scheduleRow({ id: 'not-due', job: 'system.noop', scheduling: '* * * * *', last_run_at: now }),
    ]);

    expect(await scheduler.tick(now)).toBe(2);
    expect(calls.map((call) => call.scheduleId)).toEqual(['cleanup', 'sessions']);
  });

  it('fails the reload when the schedule table is unreachable', async () => {
    const { db, scheduler } = harness([scheduleRow()]);
    db.throws(SELECT_FRAGMENT, new Error('db down'));

    await expect(scheduler.tick(now)).rejects.toThrow('db down');
  });
});
