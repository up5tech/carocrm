import type { Logger } from '@carocrm/core/logger/index.js';
import type { OutboxEvent } from '@carocrm/jobs';

import { OutboxHandlerRegistry } from '../outbox/outbox-registry.js';

/**
 * ============================ OUTBOX EVENT HANDLERS ============================
 *
 * The poller (`src/outbox/outbox-poller.ts`) dispatches `outbox_events.event_type` rows to
 * this registry. It is the extension point for event-driven work: any module can attach a
 * handler during composition, e.g.
 *
 * ```ts
 * // apps/worker/src/app.ts (composition root) — or from a module barrel:
 * registry.register('entity.created', async (event) => {
 *   await doSomething(event.payload.entityType, event.payload.recordId);
 * });
 * ```
 *
 * Producers write events inside their own transaction through
 * `apps/api/src/common/outbox.service.ts` (`OutboxService.insertMany(tx, events)`), so a
 * handler only ever sees committed rows. Handlers are at-least-once: make them idempotent
 * (the event `id` is a stable key). Throwing means "retry with backoff"; resolving means
 * "processed". Event types with no registered handler are logged and marked processed so
 * they cannot block the poller.
 * ==============================================================================
 */

export interface KernelOutboxDeps {
  log: Logger;
}

export function noopOutboxHandler(deps: KernelOutboxDeps): (event: OutboxEvent) => Promise<void> {
  return async (event: OutboxEvent) => {
    deps.log.debug({ eventId: event.id }, 'system.noop outbox event handled');
  };
}

export function logOutboxHandler(deps: KernelOutboxDeps): (event: OutboxEvent) => Promise<void> {
  return async (event: OutboxEvent) => {
    deps.log.info({ eventId: event.id, eventType: event.eventType, payload: event.payload }, 'outbox event');
  };
}

export function registerKernelOutboxHandlers(registry: OutboxHandlerRegistry, deps: KernelOutboxDeps): void {
  registry.register('system.noop', noopOutboxHandler(deps));
  registry.register('system.log', logOutboxHandler(deps));
}

export function createKernelOutboxRegistry(log: Logger): OutboxHandlerRegistry {
  const registry = new OutboxHandlerRegistry(log);
  registerKernelOutboxHandlers(registry, { log });
  return registry;
}
