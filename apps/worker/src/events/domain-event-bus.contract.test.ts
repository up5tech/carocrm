import { DOMAIN_EVENT_TYPES, KNOWN_DOMAIN_EVENTS } from '@carocrm/core/domain-events/index.js';
import { describe, expect, it } from 'vitest';

import { createKernelOutboxSetup } from '../handlers/outbox-handlers.js';
import { createTestLogger } from '../testing/test-logger.js';
import { DomainEventBus, entityPayloadOf, SUBSCRIBE_ALL } from './domain-event-bus.js';

/**
 * Phase 22.6 — the event consumer contract
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 task 6; `docs/architecture/contract-catalog.md` §3).
 *
 * The platform's rule is **additive tolerance**: a producer may add fields to an event payload, and a
 * consumer built against the older contract must keep working. The platform carries no
 * `schemaVersion` column (22.3, Finding F2), so this tolerance is the *whole* versioning contract —
 * and nothing tested it.
 *
 * Pure unit tests: no database, no Redis, no clock. The bus is the consumer's public boundary.
 */

function entityEvent(eventType: string, payload: Record<string, unknown>) {
  return { id: 'evt-1', eventType, payload };
}

describe('the event consumer contract', () => {
  it('reads a payload that carries fields a newer producer added', () => {
    const payload = entityPayloadOf(
      entityEvent(DOMAIN_EVENT_TYPES.entityUpdated, {
        entityType: 'Account',
        entityId: 'a1',
        changed: ['industry'],
        userId: 'u1',
        version: 3,
        // A field a newer producer added. The consumer does not know it and must not break on it.
        actorType: 'system',
        schemaVersion: 2,
      }),
    );
    expect(payload).toEqual({
      entityType: 'Account',
      entityId: 'a1',
      changed: ['industry'],
      userId: 'u1',
      version: 3,
    });
  });

  it('reads a payload that omits the optional fields', () => {
    const payload = entityPayloadOf(
      entityEvent(DOMAIN_EVENT_TYPES.entityCreated, {
        entityType: 'Contact',
        entityId: 'c1',
      }),
    );
    expect(payload?.changed).toEqual([]);
    expect(payload?.userId).toBeNull();
    expect(payload?.version).toBe(0);
  });

  it('ignores an event type it does not know, without failing the delivery', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const typed: string[] = [];
    const wildcard: string[] = [];

    bus.subscribe({
      name: 'entity-updates',
      eventType: DOMAIN_EVENT_TYPES.entityUpdated,
      handler: async () => void typed.push('called'),
    });
    bus.subscribe({
      name: 'everything',
      eventType: SUBSCRIBE_ALL,
      handler: async (event) => void wildcard.push(event.eventType),
    });

    // A producer in a newer build published an event this worker has never heard of.
    await bus.publish({ id: 'evt-2', eventType: 'sales.invoice.discounted.v2', payload: { invoiceId: 'i1' } });

    expect(typed).toEqual([]);
    expect(wildcard).toEqual(['sales.invoice.discounted.v2']);
    // The payload is not a record mutation, so the typed view is absent rather than wrong.
    expect(entityPayloadOf(entityEvent('sales.invoice.discounted.v2', { entityType: 'Invoice', entityId: 'i1' }))).toBeUndefined();
  });

  it('keeps a subscriber working when the producer adds a field', async () => {
    const { log } = createTestLogger();
    const bus = new DomainEventBus(log);
    const seen: { entityType: string; changed: string[] }[] = [];

    bus.subscribe({
      name: 'outbound-sync',
      eventType: DOMAIN_EVENT_TYPES.entityUpdated,
      handler: async (event) => {
        seen.push({
          entityType: String(event.entity?.entityType),
          changed: [...(event.entity?.changed ?? [])],
        });
      },
    });

    await bus.publish(
      entityEvent(DOMAIN_EVENT_TYPES.entityUpdated, {
        entityType: 'Account',
        entityId: 'a1',
        changed: ['industry'],
        userId: 'u1',
        version: 3,
        somethingNewer: true,
      }),
    );

    expect(seen).toEqual([{ entityType: 'Account', changed: ['industry'] }]);
  });

  it('registers a handler for every event type the platform produces', () => {
    const { log } = createTestLogger();
    const { registry } = createKernelOutboxSetup(log);
    for (const eventType of KNOWN_DOMAIN_EVENTS) {
      expect(registry.has(eventType)).toBe(true);
    }
  });
});
