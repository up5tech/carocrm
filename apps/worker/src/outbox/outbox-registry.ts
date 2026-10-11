import type { Logger } from '@carocrm/core/logger/index.js';
import type { OutboxEvent } from '@carocrm/jobs';

/**
 * An outbox event handler. Throw to make the poller retry the event with exponential
 * backoff; resolve to mark the event `processed`.
 */
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

/**
 * Extension point for `event_type` -> handler registration.
 *
 * Modules add handlers by calling `registry.register('entity.created', handler)` during
 * worker composition (see `src/handlers/outbox-handlers.ts`, wired in `src/app.ts`).
 * Unknown event types are logged with a warning and marked processed so a producer whose
 * consumer has not shipped yet cannot clog the outbox.
 */
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(private readonly log: Logger) {}

  register(eventType: string, handler: OutboxHandler): void {
    if (this.handlers.has(eventType)) {
      this.log.warn({ eventType }, 'outbox handler re-registered, last registration wins');
    }
    this.handlers.set(eventType, handler);
  }

  get(eventType: string): OutboxHandler | undefined {
    return this.handlers.get(eventType);
  }

  has(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  list(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }
}
