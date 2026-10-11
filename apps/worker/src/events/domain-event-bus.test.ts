import { DOMAIN_EVENT_TYPES } from '@carocrm/core/domain-events/index.js';
import { describe, expect, it } from 'vitest';

import { createKernelOutboxSetup } from '../handlers/outbox-handlers.js';
import { OutboxHandlerRegistry } from '../outbox/outbox-registry.js';
import { createTestLogger } from '../testing/test-logger.js';
import { DomainEventBus, entityPayloadOf, registerDomainEventHandlers, SUBSCRIBE_ALL, subscribeToMutation } from './domain-event-bus.js';

function entityEvent(eventType = DOMAIN_EVENT_TYPES.entityUpdated, overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    eventType,
    payload: { entityType: 'Account', entityId: 'a1', changed: ['industry'], userId: 'u1', version: 3, ...overrides },
  };
}

describe('DomainEventBus', () => {
  it('delivers an entity event to matching subscribers with a typed payload', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const seen: string[] = [];

    bus.subscribe({
      name: 'notify-sales',
      eventType: DOMAIN_EVENT_TYPES.entityUpdated,
      handler: async (event) => {
        seen.push(`${String(event.entity?.entityType)}:${String(event.entity?.changed)}`);
      },
    });
    bus.subscribe({ name: 'other', eventType: DOMAIN_EVENT_TYPES.entityDeleted, handler: async () => undefined });

    await bus.publish(entityEvent());
    expect(seen).toEqual(['Account:industry']);
    expect(bus.list().map((subscriber) => subscriber.name)).toEqual(['notify-sales', 'other']);
  });

  it('supports a wildcard subscriber and runs handlers in registration order', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const order: string[] = [];
    bus.subscribe({ name: 'first', eventType: DOMAIN_EVENT_TYPES.entityCreated, handler: async () => void order.push('first') });
    bus.subscribe({ name: 'all', eventType: SUBSCRIBE_ALL, handler: async () => void order.push('all') });

    await bus.publish(entityEvent(DOMAIN_EVENT_TYPES.entityCreated));
    expect(order).toEqual(['first', 'all']);

    expect(bus.unsubscribe('first')).toBe(true);
    expect(bus.unsubscribe('first')).toBe(false);
  });

  it('rethrows the first subscriber failure so the poller retries the event', async () => {
    const harness = createTestLogger();
    const bus = new DomainEventBus(harness.log);
    let secondCalls = 0;
    bus.subscribe({
      name: 'boom',
      eventType: DOMAIN_EVENT_TYPES.entityUpdated,
      handler: async () => {
        throw new Error('subscriber failed');
      },
    });
    bus.subscribe({
      name: 'second',
      eventType: DOMAIN_EVENT_TYPES.entityUpdated,
      handler: async () => {
        secondCalls += 1;
      },
    });

    await expect(bus.publish(entityEvent())).rejects.toThrow('subscriber failed');
    expect(secondCalls).toBe(0);
    expect(harness.recordsAt('error').length).toBeGreaterThan(0);
  });

  it('rejects duplicate subscriber names and empty event types', () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const noop = { name: 'dup', eventType: 'entity.created', handler: async () => undefined };
    bus.subscribe(noop);
    expect(() => bus.subscribe(noop)).toThrow(/already registered/);
    expect(() => bus.subscribe({ ...noop, name: 'other', eventType: '  ' })).toThrow(/needs an event type/);
  });

  it('leaves non-entity payloads untouched', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    let captured: unknown;
    bus.subscribe({
      name: 'jobs',
      eventType: SUBSCRIBE_ALL,
      handler: async (event) => {
        captured = event.entity;
      },
    });
    await bus.publish({ id: 'j1', eventType: 'system.log', payload: { jobName: 'cleanup' } });
    expect(captured).toBeUndefined();
    expect(entityPayloadOf({ id: 'j1', eventType: 'entity.updated', payload: { nope: true } })).toBeUndefined();
  });

  it('scopes a subscriber to one entity type through subscribeToMutation', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const hits: string[] = [];
    subscribeToMutation({
      bus,
      name: 'account-only',
      operation: 'update',
      entityType: 'Account',
      handler: async (event) => {
        hits.push(String(event.entity?.entityId));
      },
    });

    await bus.publish(entityEvent());
    await bus.publish({ ...entityEvent(), payload: { ...entityEvent().payload, entityType: 'Contact' } });
    expect(hits).toEqual(['a1']);
  });

  it('is wired to the outbox registry by the kernel setup', async () => {
    const { log } = createTestLogger();
    const { registry, events } = createKernelOutboxSetup(log);
    expect(registry.has(DOMAIN_EVENT_TYPES.entityCreated)).toBe(true);
    expect(registry.has(DOMAIN_EVENT_TYPES.entityRestored)).toBe(true);

    const seen: string[] = [];
    events.subscribe({ name: 'probe', eventType: DOMAIN_EVENT_TYPES.entityUpdated, handler: async (event) => void seen.push(event.id) });
    const handler = registry.get(DOMAIN_EVENT_TYPES.entityUpdated);
    await handler?.(entityEvent());
    expect(seen).toEqual(['evt-1']);
  });

  it('registerDomainEventHandlers attaches every known event type', () => {
    const { log } = createTestLogger();
    const registry = new OutboxHandlerRegistry(log);
    registerDomainEventHandlers(registry, new DomainEventBus(log));
    expect(registry.list()).toContain(DOMAIN_EVENT_TYPES.entityDeleted);
  });
});
