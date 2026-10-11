import { describe, expect, it } from 'vitest';

import { createTestLogger } from '../testing/test-logger.js';
import { OutboxHandlerRegistry } from './outbox-registry.js';

describe('OutboxHandlerRegistry', () => {
  it('registers, looks up and lists event types', async () => {
    const { log } = createTestLogger();
    const registry = new OutboxHandlerRegistry(log);
    let calls = 0;
    registry.register('entity.created', async () => {
      calls += 1;
    });

    expect(registry.has('entity.created')).toBe(true);
    expect(registry.get('entity.missing')).toBeUndefined();
    await registry.get('entity.created')?.({ id: '1', eventType: 'entity.created', payload: {} });
    expect(calls).toBe(1);

    registry.register('account.notified', async () => undefined);
    expect(registry.list()).toEqual(['account.notified', 'entity.created']);
  });

  it('warns when an event type is registered twice', () => {
    const harness = createTestLogger();
    const registry = new OutboxHandlerRegistry(harness.log);
    registry.register('dup', async () => undefined);
    registry.register('dup', async () => undefined);
    expect(registry.list()).toEqual(['dup']);
    expect(harness.recordsAt('warn')).toHaveLength(1);
  });
});
