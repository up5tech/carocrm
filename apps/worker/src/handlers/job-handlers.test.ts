import type { Readable } from 'node:stream';

import type { FileRef, FileStorage, PutFileInput } from '@carocrm/files';
import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import { FakeDb } from '../testing/fake-db.js';
import { jobContext } from '../testing/job-context.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  CLEANUP_JOBS_SQL,
  CLEANUP_OUTBOX_SQL,
  CLEANUP_STREAM_ORPHANS_SQL,
  createSystemJobRegistry,
  DEFAULT_JOB_RETENTION_DAYS,
  DEFAULT_MARKETING_RECEIPT_DAYS,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_RETENTION_BATCH,
  DEFAULT_SESSION_RETENTION_DAYS,
  DEFAULT_STREAM_ORPHAN_DAYS,
  DEFAULT_UPLOAD_BATCH,
  DEFAULT_UPLOAD_EXPIRY_HOURS,
  DEFAULT_VOICE_RECEIPT_DAYS,
  DELETE_MARKETING_INBOX_SQL,
  DELETE_SIGNATURE_INBOX_SQL,
  DELETE_VOICE_RECEIPTS_SQL,
  EXPIRED_UPLOADS_SQL,
  MINIMIZE_SIGNATURE_EVENTS_SQL,
  MINIMIZE_VOICE_RECEIPTS_SQL,
  PRUNE_SESSIONS_SQL,
  registerSystemJobs,
  REMINDER_INSERT_SQL,
  REMINDER_MARK_SQL,
  REMINDER_SCAN_SQL,
  retentionDays,
} from './job-handlers.js';

const OUTBOX_FRAGMENT = 'delete from outbox_events';
const SESSIONS_FRAGMENT = 'delete from user_sessions';
const EXPIRED_FRAGMENT = 'from file_uploads';
const CLAIM_FRAGMENT = 'update file_uploads';

/** Storage double that records the keys the cleanup removed. */
class FakeStorage implements FileStorage {
  readonly driver = 'local' as const;
  readonly supportsSignedUrls = false;
  readonly deletedKeys: string[] = [];

  async put(input: PutFileInput): Promise<FileRef> {
    return { key: input.key, size: 0, driver: this.driver };
  }

  async get(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async openRead(): Promise<Readable> {
    throw new Error('these tests never read stored bytes');
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }

  async exists(): Promise<boolean> {
    return false;
  }
}

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
      'system.cleanupJobs',
      'system.cleanupOutbox',
      'system.cleanupProviderReceipts',
      'system.cleanupStreamOrphans',
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

describe('phase 23.7 retention jobs', () => {
  it('removes only terminal jobs and cascades their logs', async () => {
    const { db, registry } = harness();
    db.returns('delete from jobs', [{ id: 'j1' }], 1);

    const outcome = await registry.get('system.cleanupJobs')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ deleted: 1, days: DEFAULT_JOB_RETENTION_DAYS });
    expect(db.lastCall('delete from jobs')?.params).toEqual([DEFAULT_JOB_RETENTION_DAYS, DEFAULT_RETENTION_BATCH]);
    const sql = CLEANUP_JOBS_SQL.toLowerCase();
    expect(sql).toContain("status in ('completed', 'failed', 'cancelled')");
    expect(sql).toContain('coalesce(finished_at, created_at)');
    expect(sql).not.toContain("'pending'");
    expect(sql).not.toContain("'running'");
  });

  it('minimizes provider payloads and deletes only terminal receipts that are not evidence', async () => {
    const { db, registry } = harness();
    db.returns('update signature_provider_events', [{ id: 'e1' }], 1);
    db.returns('delete from signature_webhook_inbox', [{ id: 'i1' }], 1);
    db.returns('update voice_webhook_events', [{ id: 'v1' }], 1);
    db.returns('delete from voice_webhook_events', [{ id: 'v2' }], 1);
    db.returns('delete from marketing_provider_webhook_inbox', [{ id: 'm1' }], 1);

    const outcome = await registry.get('system.cleanupProviderReceipts')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({
      signatureEventsMinimized: 1,
      signatureInboxDeleted: 1,
      voiceReceiptsMinimized: 1,
      voiceReceiptsDeleted: 1,
      marketingInboxDeleted: 1,
    });
    expect(MINIMIZE_SIGNATURE_EVENTS_SQL.toLowerCase()).toContain("event_data = '{}'::jsonb");
    expect(DELETE_SIGNATURE_INBOX_SQL.toLowerCase()).toContain('purge_after < now()');
    expect(MINIMIZE_VOICE_RECEIPTS_SQL.toLowerCase()).toContain('payload_redacted = null');
    expect(DELETE_VOICE_RECEIPTS_SQL.toLowerCase()).toContain('not exists');
    expect(DELETE_MARKETING_INBOX_SQL.toLowerCase()).toContain("'processed_with_errors'");
    expect(db.lastCall('delete from voice_webhook_events')?.params).toEqual([DEFAULT_VOICE_RECEIPT_DAYS, DEFAULT_RETENTION_BATCH]);
    expect(db.lastCall('delete from marketing_provider_webhook_inbox')?.params).toEqual([DEFAULT_MARKETING_RECEIPT_DAYS, DEFAULT_RETENTION_BATCH]);
  });

  it('removes only old stream rows whose entity type exists but whose record does not', async () => {
    const { db, registry } = harness();
    db.returns('delete from stream_items', [{ id: 's1' }], 1);

    const outcome = await registry.get('system.cleanupStreamOrphans')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ deleted: 1, days: DEFAULT_STREAM_ORPHAN_DAYS });
    expect(db.lastCall('delete from stream_items')?.params).toEqual([DEFAULT_STREAM_ORPHAN_DAYS, DEFAULT_RETENTION_BATCH]);
    const sql = CLEANUP_STREAM_ORPHANS_SQL.toLowerCase();
    expect(sql).toContain('exists');
    expect(sql).toContain('not exists');
    expect(sql).toContain('entity_records');
  });

  it('keeps the documented defaults and accepts schedule overrides', async () => {
    const { db, registry } = harness();
    db.returns('delete from jobs', [], 0);
    db.returns('delete from stream_items', [], 0);

    await registry.get('system.cleanupJobs')?.(jobContext({ retentionDays: 7, batchSize: 10 }));
    await registry.get('system.cleanupStreamOrphans')?.(jobContext({ retentionDays: 2, batchSize: 3 }));

    expect(db.lastCall('delete from jobs')?.params).toEqual([7, 10]);
    expect(db.lastCall('delete from stream_items')?.params).toEqual([2, 3]);
  });
});

describe('system.cleanupUploads', () => {
  it('claims an expired upload and deletes its part files', async () => {
    const db = new FakeDb();
    const logger = createTestLogger();
    const storage = new FakeStorage();
    const registry = createSystemJobRegistry({ db, log: logger.log, storage, uploadExpiryHours: 12 });

    db.returns(EXPIRED_FRAGMENT, [{ id: 'u1', storage_prefix: 'uploads/u1', parts: { 0: { size: 5 }, 2: { size: 7 } } }]);
    db.returns(CLAIM_FRAGMENT, [{ id: 'u1' }]);

    const outcome = await registry.get('system.cleanupUploads')?.(jobContext({}));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ uploads: 1, parts: 2 });
    expect(storage.deletedKeys).toEqual(['uploads/u1/part-000000', 'uploads/u1/part-000002']);
    const call = db.lastCall(EXPIRED_FRAGMENT);
    expect(call?.params[1]).toBe(DEFAULT_UPLOAD_BATCH);
    expect(call?.params[0]).toBeInstanceOf(Date);
    expect(EXPIRED_UPLOADS_SQL.toLowerCase()).toContain("status = 'open'");
  });

  it('skips an upload another worker already claimed', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    const registry = createSystemJobRegistry({ db, log: createTestLogger().log, storage });

    db.returns(EXPIRED_FRAGMENT, [{ id: 'u2', storage_prefix: 'uploads/u2', parts: { 0: { size: 5 } } }]);
    db.returns(CLAIM_FRAGMENT, [], 0);

    const outcome = await registry.get('system.cleanupUploads')?.(jobContext({}));

    expect(outcome?.result).toEqual({ uploads: 0, parts: 0 });
    expect(storage.deletedKeys).toEqual([]);
  });

  it('waits the grace window after expires_at and keeps the default when the override is bogus', async () => {
    const db = new FakeDb();
    const registry = createSystemJobRegistry({ db, log: createTestLogger().log, storage: new FakeStorage() });
    db.returns(EXPIRED_FRAGMENT, []);

    const before = Date.now();
    await registry.get('system.cleanupUploads')?.(jobContext({ expiryHours: 2 }));
    const cutoff = db.lastCall(EXPIRED_FRAGMENT)?.params[0];
    expect(cutoff).toBeInstanceOf(Date);
    const hours = (before - (cutoff as Date).getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);

    await registry.get('system.cleanupUploads')?.(jobContext({ expiryHours: -1 }));
    const fallback = db.lastCall(EXPIRED_FRAGMENT)?.params[0];
    expect(fallback).toBeInstanceOf(Date);
    const fallbackHours = (before - (fallback as Date).getTime()) / 3_600_000;
    expect(fallbackHours).toBeCloseTo(DEFAULT_UPLOAD_EXPIRY_HOURS, 0);
  });

  it('is not installed when the process has no attachment storage', () => {
    const registry = createSystemJobRegistry({ db: new FakeDb(), log: createTestLogger().log });
    expect(registry.get('system.cleanupUploads')).toBeUndefined();
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
