import type { EntityEventPayload, RecordMutation } from '@carocrm/core/domain-events/index.js';
import { entityEventType, KNOWN_DOMAIN_EVENTS } from '@carocrm/core/domain-events/index.js';
import type { Logger } from '@carocrm/core/logger/index.js';
import type { OutboxEvent } from '@carocrm/jobs';

import type { OutboxHandlerRegistry } from '../outbox/outbox-registry.js';

/**
 * Read side of the domain-event bus (PLAN §23.2).
 *
 * The poller turns each committed `outbox_events` row into an {@link OutboxEvent}; this bus fans it
 * out to named subscribers. Registration is the extension point — automation lives here or in a
 * workflow, never in the record mutation path.
 *
 * Delivery is **at-least-once**: subscribers run in registration order, and the first failure
 * rethrows so the poller retries the whole event, which re-runs the subscribers that already
 * succeeded. Keep them idempotent (the event `id` is a stable key).
 */

/** Subscribe to every event type. */
export const SUBSCRIBE_ALL = '*';

export type DomainEventSubscriber = (event: DomainEventMessage) => Promise<void>;

export interface DomainEventMessage extends OutboxEvent {
  /** Typed view of an `entity.*` payload; `undefined` for other producers' events. */
  readonly entity?: EntityEventPayload;
}

interface Subscriber {
  name: string;
  eventType: string;
  handler: DomainEventSubscriber;
}

export class DomainEventBus {
  private readonly subscribers: Subscriber[] = [];

  constructor(private readonly log: Logger) {}

  subscribe(input: { eventType: string; name: string; handler: DomainEventSubscriber }): void {
    if (input.eventType.trim() === '') throw new Error('A domain event subscriber needs an event type.');
    if (this.subscribers.some((subscriber) => subscriber.name === input.name)) {
      throw new Error(`Domain event subscriber "${input.name}" is already registered.`);
    }
    this.subscribers.push({ name: input.name, eventType: input.eventType, handler: input.handler });
  }

  unsubscribe(name: string): boolean {
    const index = this.subscribers.findIndex((subscriber) => subscriber.name === name);
    if (index < 0) return false;
    this.subscribers.splice(index, 1);
    return true;
  }

  list(): { name: string; eventType: string }[] {
    return this.subscribers.map(({ name, eventType }) => ({ name, eventType }));
  }

  async publish(event: OutboxEvent): Promise<void> {
    const message: DomainEventMessage = toDomainEventMessage(event, this.log);
    const matching = this.subscribers.filter((subscriber) => subscriber.eventType === message.eventType || subscriber.eventType === SUBSCRIBE_ALL);
    for (const subscriber of matching) {
      try {
        await subscriber.handler(message);
      } catch (error: unknown) {
        this.log.error(
          { eventId: message.id, eventType: message.eventType, subscriber: subscriber.name, error: error instanceof Error ? error.message : String(error) },
          'domain event subscriber failed',
        );
        throw error;
      }
    }
  }
}

/** `payload` of an `entity.*` event is a record mutation summary. */
export function entityPayloadOf(event: OutboxEvent): EntityEventPayload | undefined {
  if (!KNOWN_DOMAIN_EVENTS.includes(event.eventType)) return undefined;
  const payload = event.payload as Partial<EntityEventPayload>;
  if (typeof payload.entityType !== 'string' || typeof payload.entityId !== 'string') return undefined;
  return {
    entityType: payload.entityType,
    entityId: payload.entityId,
    changed: Array.isArray(payload.changed) ? payload.changed : [],
    userId: typeof payload.userId === 'string' ? payload.userId : null,
    version: typeof payload.version === 'number' ? payload.version : 0,
  };
}

function toDomainEventMessage(event: OutboxEvent, log: Logger): DomainEventMessage {
  const entity = entityPayloadOf(event);
  if (KNOWN_DOMAIN_EVENTS.includes(event.eventType) && entity === undefined) {
    log.warn({ eventId: event.id, eventType: event.eventType }, 'domain event payload is not a record mutation');
  }
  const message: DomainEventMessage = { id: event.id, eventType: event.eventType, payload: event.payload };
  return entity === undefined ? message : { ...message, entity };
}

/** Attaches the bus to the outbox registry so committed entity events reach subscribers. */
export function registerDomainEventHandlers(registry: OutboxHandlerRegistry, bus: DomainEventBus): void {
  for (const eventType of KNOWN_DOMAIN_EVENTS) {
    registry.register(eventType, async (event) => {
      await bus.publish(event);
    });
  }
}

/** Convenience for subscribers that only care about one mutation of one entity type. */
export function subscribeToMutation(input: {
  bus: DomainEventBus;
  name: string;
  operation: RecordMutation;
  entityType: string;
  handler: DomainEventSubscriber;
}): void {
  input.bus.subscribe({
    eventType: entityEventType(input.operation),
    name: input.name,
    handler: async (event) => {
      if (event.entity?.entityType !== input.entityType) return;
      await input.handler(event);
    },
  });
}
