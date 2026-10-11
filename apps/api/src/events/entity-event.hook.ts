import type { EntityEventPayload } from '@carocrm/core/domain-events/index.js';
import { changedFields, entityEventType } from '@carocrm/core/domain-events/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AfterSaveHook, AfterSaveHookArgs } from '../entity/hooks.js';
import { EventBus } from './event-bus.js';

export type { EntityEventPayload };

/**
 * Turns every generic record mutation into a domain event, inside the mutation transaction
 * (PLAN §23.2). Registered onto `KERNEL_HOOKS_TOKEN` at bootstrap, exactly like audit and stream.
 */
@Injectable()
export class EntityEventHookService {
  constructor(
    @Inject(EventBus) private readonly bus: EventBus,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async handle(args: AfterSaveHookArgs): Promise<void> {
    const payload: EntityEventPayload = {
      entityType: args.entityType,
      entityId: args.record.id,
      changed: args.operation === 'delete' || args.operation === 'restore' ? [] : changedFields(args.record.data, args.previous),
      userId: args.userId ?? this.scope.userId ?? null,
      version: args.record.version,
    };
    await this.bus.dispatch(args.tx, { type: entityEventType(args.operation), payload: { ...payload } });
  }
}

/** Pushes the event hook onto the kernel hook array; returns it so callers can remove it. */
export function registerEntityEventHook(hooks: AfterSaveHook[], service: EntityEventHookService): AfterSaveHook {
  const hook: AfterSaveHook = (args) => service.handle(args);
  hooks.push(hook);
  return hook;
}
