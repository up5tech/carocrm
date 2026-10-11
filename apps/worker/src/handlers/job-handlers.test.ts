import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import { FakeDb } from '../testing/fake-db.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  CLEANUP_OUTBOX_SQL,
  createSystemJobRegistry,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
  PRUNE_SESSIONS_SQL,
  registerSystemJobs,
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

describe('kernel job registry', () => {
  it('registers the system jobs by name', () => {
    expect(createSystemJobRegistry({ db: new FakeDb(), log: createTestLogger().log }).list()).toEqual([
      'system.cleanupOutbox',
      'system.noop',
      'system.pruneSessions',
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
    const outcome = await registry.get('system.noop')?.({ data: { anything: true } });
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result?.ok).toBe(true);
    expect(db.calls).toHaveLength(0);
  });
});

describe('system.cleanupOutbox', () => {
  it('deletes processed/failed events older than the retention window', async () => {
    const { db, registry } = harness();
    db.returns(OUTBOX_FRAGMENT, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 3);

    const outcome = await registry.get('system.cleanupOutbox')?.({ data: {} });

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

    const outcome = await registry.get('system.cleanupOutbox')?.({ data: { retentionDays: 2 } });

    expect(db.lastCall(OUTBOX_FRAGMENT)?.params).toEqual([2]);
    expect(outcome?.message).toBe('Removed 0 outbox events');
  });
});

describe('system.pruneSessions', () => {
  it('deletes revoked or expired sessions older than 30 days', async () => {
    const { db, registry } = harness();
    db.returns(SESSIONS_FRAGMENT, [{ id: 's1' }], 1);

    const outcome = await registry.get('system.pruneSessions')?.({ data: {} });

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

    await registry.get('system.pruneSessions')?.({ data: { retentionDays: -5 } });

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
