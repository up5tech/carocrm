import type { Provider, Type } from '@nestjs/common';

import { DomainEventController } from './domain-event.controller.js';
import { EntityEventHookService } from './entity-event.hook.js';
import { EventBus } from './event-bus.js';

export { EntityEventHookService, registerEntityEventHook } from './entity-event.hook.js';
export { EventBus } from './event-bus.js';
export type { DomainEventInput, EntityEventPayload, RecordMutation } from '@carocrm/core/domain-events/index.js';
export { changedFields, DOMAIN_EVENT_TYPES, entityEventType,KNOWN_DOMAIN_EVENTS } from '@carocrm/core/domain-events/index.js';

/**
 * Domain-event barrel (PLAN §23.2).
 *
 * `DOMAIN_EVENT_CONTROLLERS` owns the static `/api/v1/DomainEvent` prefix and must be spread
 * before `ENTITY_CONTROLLERS`.
 */
export const DOMAIN_EVENT_CONTROLLERS: Type<unknown>[] = [DomainEventController];
export const DOMAIN_EVENT_PROVIDERS: Provider[] = [EventBus, EntityEventHookService];
