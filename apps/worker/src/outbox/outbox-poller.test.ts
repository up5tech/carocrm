import type { OutboxEvent } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import { FakeDb, outboxRow, result } from '../testing/fake-db.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  CLAIM_SQL,
  mapClaimedEvent,
  MARK_PROCESSED_SQL,
  MARK_RETRY_SQL,
  OutboxPoller,
  type OutboxPollerOptions,
  retryDelayMs,
} from './outbox-poller.js';
import { OutboxHandlerRegistry } from './outbox-registry.js';

const CLAIM_FRAGMENT = 'for update skip locked';
const PROCESSED_FRAGMENT = 'processed_at = now()';
const RETRY_FRAGMENT = 'make_interval';

interface Harness {
  db: FakeDb;
  registry: OutboxHandlerRegistry;
  poller: OutboxPoller;
  logger: ReturnType<typeof createTestLogger>;
}

function harness(rows: Record<string, unknown>[], overrides: Partial<OutboxPollerOptions> = {}): Harness {
  const db = new FakeDb();
  const logger = createTestLogger();
  const registry = new OutboxHandlerRegistry(logger.log);
  db.returns(CLAIM_FRAGMENT, rows);
  const poller = new OutboxPoller({
    db,
    registry,
    log: logger.log,
    intervalMs: 2000,
    batchSize: 10,
    maxAttempts: 8,
    backoffBaseMs: 5000,
    backoffMaxMs: 900000,
    ...overrides,
  });
  return { db, registry, poller, logger };
}

describe('retryDelayMs', () => {
  it('doubles from the base and caps at the ceiling', () => {
    expect(retryDelayMs(0, 5000, 900000)).toBe(5000);
    expect(retryDelayMs(1, 5000, 900000)).toBe(10000);
    expect(retryDelayMs(3, 5000, 900000)).toBe(40000);
    expect(retryDelayMs(7, 5000, 900000)).toBe(640000);
    expect(retryDelayMs(8, 5000, 900000)).toBe(900000);
    expect(retryDelayMs(40, 5000, 900000)).toBe(900000);
  });

  it('clamps negative attempt counts to the base delay', () => {
    expect(retryDelayMs(-2, 5000, 900000)).toBe(5000);
  });
});

describe('outbox SQL shape', () => {
  it('claims only pending rows whose available_at passed, locking with SKIP LOCKED', () => {
    const sql = CLAIM_SQL.toLowerCase();
    expect(sql).toContain("set status = 'running'");
    expect(sql).toContain("where status = 'pending'");
    expect(sql).toContain('available_at <= now()');
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain('returning id, event_type, payload, attempts');
  });

  it('marks successes processed and failures retried or dead-lettered', () => {
    expect(MARK_PROCESSED_SQL.toLowerCase()).toContain("set status = 'processed'");
    expect(MARK_PROCESSED_SQL.toLowerCase()).toContain('processed_at = now()');
    const retry = MARK_RETRY_SQL.toLowerCase();
    expect(retry).toContain("case when attempts + 1 >= $2::int then 'failed' else 'pending' end");
    expect(retry).toContain('attempts = attempts + 1');
    expect(retry).toContain('available_at = now() + make_interval');
    expect(retry).toContain('last_error = $4');
  });

  it('maps claimed rows into events', () => {
    const event = mapClaimedEvent(outboxRow({ id: 'e9', event_type: 'x.y', payload: { a: 1 }, attempts: 2 }));
    expect(event).toEqual({ id: 'e9', eventType: 'x.y', payload: { a: 1 }, attempts: 2 });
  });
});

describe('OutboxPoller.tick', () => {
  it('claims a batch and marks successful events processed', async () => {
    const handled: OutboxEvent[] = [];
    const { db, registry, poller } = harness([
      outboxRow(),
      outboxRow({ id: 'event-2', event_type: 'system.other' }),
    ]);
    registry.register('system.noop', async (event) => {
      handled.push(event);
    });
    registry.register('system.other', async (event) => {
      handled.push(event);
    });

    const claimed = await poller.tick();

    expect(claimed.map((event) => event.id)).toEqual(['event-1', 'event-2']);
    expect(handled.map((event) => event.id)).toEqual(['event-1', 'event-2']);
    expect(handled[0]?.eventType).toBe('system.noop');
    expect(handled[0]?.payload).toEqual({ hello: 'world' });
    expect(db.lastCall(CLAIM_FRAGMENT)?.params).toEqual([10]);
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(2);
    expect(db.lastCall(PROCESSED_FRAGMENT)?.params).toEqual(['event-2']);
    expect(db.callsFor(RETRY_FRAGMENT)).toHaveLength(0);
  });

  it('treats unknown event types as processed and logs a warning', async () => {
    const { db, poller, logger } = harness([outboxRow({ event_type: 'not.wired.yet' })]);

    const claimed = await poller.tick();

    expect(claimed).toHaveLength(1);
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(1);
    expect(logger.recordsAt('warn')).toHaveLength(1);
  });

  it('retries a failing handler with exponential backoff', async () => {
    const { db, registry, poller, logger } = harness([outboxRow({ attempts: 2 })]);
    registry.register('system.noop', async () => {
      throw new Error('handler exploded');
    });

    await poller.tick();

    const call = db.lastCall(RETRY_FRAGMENT);
    expect(call?.params[0]).toBe('event-1');
    expect(call?.params[1]).toBe(8);
    expect(call?.params[2]).toBe(20); // 2^2 * 5s = 20s, in seconds for make_interval
    expect(String(call?.params[3])).toContain('handler exploded');
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(0);
    expect(logger.recordsAt('error')).toHaveLength(1);
  });

  it('caps the backoff at the configured ceiling', async () => {
    const { db, registry, poller } = harness([outboxRow({ attempts: 6 })]);
    registry.register('system.noop', async () => {
      throw new Error('still broken');
    });

    await poller.tick();

    expect(db.lastCall(RETRY_FRAGMENT)?.params[2]).toBe(320);
  });

  it('promotes the event to failed once max attempts is reached', async () => {
    const { db, registry, poller, logger } = harness([outboxRow({ attempts: 7 })]);
    db.on(RETRY_FRAGMENT, () => result([{ status: 'failed', attempts: 8 }], 1));
    registry.register('system.noop', async () => {
      throw new Error('fatal');
    });

    await poller.tick();

    expect(db.callsFor(RETRY_FRAGMENT)).toHaveLength(1);
    const failure = logger.recordsAt('error')[0];
    expect(failure?.nextOutcome).toBe('failed');
    expect(failure?.retryInMs).toBeNull();
  });

  it('does nothing when there is nothing pending', async () => {
    const { db, poller } = harness([]);
    expect(await poller.tick()).toHaveLength(0);
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(0);
  });

  it('surfaces claim failures so the caller can retry the cycle', async () => {
    const { db, poller } = harness([outboxRow()]);
    db.throws(CLAIM_FRAGMENT, new Error('connection lost'));
    await expect(poller.tick()).rejects.toThrow('connection lost');
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(0);
  });

  it('keeps the loop alive when the retry write itself fails', async () => {
    const { db, registry, poller, logger } = harness([outboxRow()]);
    registry.register('system.noop', async () => {
      throw new Error('handler exploded');
    });
    db.throws(RETRY_FRAGMENT, new Error('db down'));

    await expect(poller.tick()).resolves.toHaveLength(1);
    expect(logger.recordsAt('error').length).toBeGreaterThan(0);
    expect(db.callsFor(PROCESSED_FRAGMENT)).toHaveLength(0);
  });
});
