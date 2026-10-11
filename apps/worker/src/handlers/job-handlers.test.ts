import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import { FakeDb } from '../testing/fake-db.js';
import { jobContext } from '../testing/job-context.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  CLEANUP_OUTBOX_SQL,
  createSystemJobRegistry,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
  PRUNE_SESSIONS_SQL,
  registerSystemJobs,
  REMINDER_INSERT_SQL,
  REMINDER_MARK_SQL,
  REMINDER_SCAN_SQL,
  retentionDays,
} from './job-handlers.js';

const OUTBOX_FRAGMENT = 'delete from outbox_events';
const SESSIONS_FRAGMENT = 'delete from user_sessions';

function harness() {
  const db = new FakeDb();
  const logger = createTestLogger();
  const registry = createSystemJobRegistry({ db, log: logger.log });
  return { db, logger, registry };
}

const REMINDER_SCAN_FRAGMENT = 'from entity_records';
const REMINDER_INSERT_FRAGMENT = 'insert into notifications';
const REMINDER_MARK_FRAGMENT = 'set attrs = jsonb_set';

describe('system.sendReminders', () => {
  it('notifies the recipient and marks the activity so it fires once', async () => {
    const { db, registry } = harness();
    const due = new Date(Date.now() - 60_000);
    db.returns(REMINDER_SCAN_FRAGMENT, [
      { id: 'task-1', entity_type: 'Task', name: 'Call back', recipient_id: 'user-9', date_start: due },
    ]);
    db.returns(REMINDER_INSERT_FRAGMENT, []);
    db.returns(REMINDER_MARK_FRAGMENT, [{ id: 'task-1' }], 1);

    const outcome = await registry.get('system.sendReminders')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ scanned: 1, delivered: 1 });
    const insert = db.lastCall(REMINDER_INSERT_FRAGMENT);
    expect(insert?.params[1]).toBe('user-9');
    const payload = JSON.parse(String(insert?.params[2])) as Record<string, unknown>;
    expect(payload).toMatchObject({ activityId: 'task-1', activityType: 'Task', activityName: 'Call back' });
    expect(db.lastCall(REMINDER_MARK_FRAGMENT)?.params).toEqual(['task-1']);
  });

  it('skips rows without a recipient and reports nothing delivered', async () => {
    const { db, registry } = harness();
    db.returns(REMINDER_SCAN_FRAGMENT, [{ id: 'task-2', entity_type: 'Task', name: null, recipient_id: null, date_start: new Date() }]);
    const outcome = await registry.get('system.sendReminders')?.(jobContext({ batchSize: 5 }));
    expect(outcome?.result).toEqual({ scanned: 1, delivered: 0 });
    expect(db.lastCall(REMINDER_SCAN_FRAGMENT)?.params).toEqual([5]);
    expect(db.calls.some((call) => call.sql.toLowerCase().includes('insert into notifications'))).toBe(false);
  });

  it('only selects reminder-flagged, unfinished activities with a valid date', () => {
    const sql = REMINDER_SCAN_SQL.toLowerCase();
    expect(sql).toContain("attrs->>'reminder' = 'true'");
    expect(sql).toContain("attrs->>'remindersentat' is null");
    expect(sql).toContain("not in ('completed', 'canceled', 'deferred', 'held', 'not held')");
    expect(sql).toContain("jsonb_typeof(attrs->'datestart') = 'string'");
    expect(sql).toContain('make_interval(mins =>');
    expect(REMINDER_INSERT_SQL.toLowerCase()).toContain('insert into notifications');
    expect(REMINDER_MARK_SQL.toLowerCase()).toContain("attrs->>'remindersentat' is null");
  });
});

describe('kernel job registry', () => {
  it('registers the system jobs by name', () => {
    expect(createSystemJobRegistry({ db: new FakeDb(), log: createTestLogger().log }).list()).toEqual([
      'system.cleanupOutbox',
      'system.noop',
      'system.pruneSessions',
      'system.sendReminders',
    ]);
  });

  it('is an extension point: modules can register alongside the kernel jobs', () => {
    const registry = new JobRegistry();
    registerSystemJobs(registry, { db: new FakeDb(), log: createTestLogger().log });
    registry.register('invoicing.generate', async () => ({ status: 'completed' }));
    expect(registry.has('invoicing.generate')).toBe(true);
    expect(registry.list()).toContain('system.noop');
  });

  it('system.noop completes without touching the database', async () => {
    const { db, registry } = harness();
    const outcome = await registry.get('system.noop')?.(jobContext({ anything: true }));
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result?.ok).toBe(true);
    expect(db.calls).toHaveLength(0);
  });
});

describe('system.cleanupOutbox', () => {
  it('deletes processed/failed events older than the retention window', async () => {
    const { db, registry } = harness();
    db.returns(OUTBOX_FRAGMENT, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 3);

    const outcome = await registry.get('system.cleanupOutbox')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ deleted: 3, days: DEFAULT_OUTBOX_RETENTION_DAYS });
    expect(db.lastCall(OUTBOX_FRAGMENT)?.params).toEqual([7]);
    const sql = CLEANUP_OUTBOX_SQL.toLowerCase();
    expect(sql).toContain("status in ('processed', 'failed')");
    expect(sql).toContain('created_at < now() - make_interval');
  });

  it('accepts a retentionDays override from the job data', async () => {
    const { db, registry } = harness();
    db.returns(OUTBOX_FRAGMENT, [], 0);

    const outcome = await registry.get('system.cleanupOutbox')?.(jobContext({ retentionDays: 2 }));

    expect(db.lastCall(OUTBOX_FRAGMENT)?.params).toEqual([2]);
    expect(outcome?.message).toBe('Removed 0 outbox events');
  });
});

describe('system.pruneSessions', () => {
  it('deletes revoked or expired sessions older than 30 days', async () => {
    const { db, registry } = harness();
    db.returns(SESSIONS_FRAGMENT, [{ id: 's1' }], 1);

    const outcome = await registry.get('system.pruneSessions')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ deleted: 1, days: DEFAULT_SESSION_RETENTION_DAYS });
    expect(db.lastCall(SESSIONS_FRAGMENT)?.params).toEqual([30]);
    const sql = PRUNE_SESSIONS_SQL.toLowerCase();
    expect(sql).toContain('revoked_at is not null and revoked_at <');
    expect(sql).toContain('expired_at is not null and expired_at <');
  });

  it('ignores a bogus retention override', async () => {
    const { db, registry } = harness();
    db.returns(SESSIONS_FRAGMENT, [], 0);

    await registry.get('system.pruneSessions')?.(jobContext({ retentionDays: -5 }));

    expect(db.lastCall(SESSIONS_FRAGMENT)?.params).toEqual([30]);
  });
});

describe('retentionDays', () => {
  it('prefers a positive integer from the payload', () => {
    expect(retentionDays({ retentionDays: 3 }, 'retentionDays', 7)).toBe(3);
    expect(retentionDays({ retentionDays: '4' }, 'retentionDays', 7)).toBe(4);
  });

  it('falls back for anything else', () => {
    expect(retentionDays(undefined, 'retentionDays', 7)).toBe(7);
    expect(retentionDays({}, 'retentionDays', 7)).toBe(7);
    expect(retentionDays({ retentionDays: 0 }, 'retentionDays', 7)).toBe(7);
    expect(retentionDays({ retentionDays: 1.5 }, 'retentionDays', 7)).toBe(7);
    expect(retentionDays({ retentionDays: 'nope' }, 'retentionDays', 7)).toBe(7);
  });
});
