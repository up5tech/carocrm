import { ValidationError } from '@carocrm/core/errors/index.js';
import type { HookBinding, HookHandler, HookPhase } from '@carocrm/entity-engine/types/index.js';
import { HOOK_PHASES } from '@carocrm/entity-engine/types/index.js';
import { Injectable } from '@nestjs/common';

export interface EntityHookRegistration {
  /** Stable identifier shown by `GET /api/v1/Hook` and used to unregister. */
  readonly name: string;
  readonly phase: HookPhase;
  /** Limit the hook to one entity type; omit to run for every entity. */
  readonly entity?: string | undefined;
  readonly handler: HookHandler;
}

export interface HookDescription {
  name: string;
  phase: string;
  entity: string;
}

/**
 * Hook registry (PLAN §23.1). Modules register named handlers — usually once, from
 * `onApplicationBootstrap` — and the entity manager dispatches the documented phases through
 * them. A handler may mutate `context.data` before the write, or throw an `AppError` to abort it;
 * phases run in registration order.
 *
 * Transaction-scoped work (audit rows, stream items, outbox events) does NOT belong here: those
 * run inside the mutation transaction through `KERNEL_HOOKS_TOKEN` instead.
 */
@Injectable()
export class HookRegistry {
  private readonly registrations = new Map<string, EntityHookRegistration>();

  register(hook: EntityHookRegistration): EntityHookRegistration {
    if (hook.name.trim() === '') throw new ValidationError('A hook needs a name.');
    if (this.registrations.has(hook.name)) throw new ValidationError(`Hook "${hook.name}" is already registered.`);
    this.registrations.set(hook.name, hook);
    return hook;
  }

  unregister(name: string): boolean {
    return this.registrations.delete(name);
  }

  list(): HookDescription[] {
    return [...this.registrations.values()]
      .map((hook) => ({ name: hook.name, phase: hook.phase, entity: hook.entity ?? '*' }))
      .sort((a, b) => `${a.phase}:${a.name}`.localeCompare(`${b.phase}:${b.name}`));
  }

  /** Registered phases plus the recommended list, so the API can show what is available. */
  phases(): string[] {
    const used = [...new Set([...this.registrations.values()].map((hook) => hook.phase))];
    return [...new Set([...HOOK_PHASES, ...used])];
  }

  /** Bindings for one entity manager instance; the entity filter stays inside the wrapper. */
  bindings(): HookBinding[] {
    return [...this.registrations.values()].map((hook) => ({
      phase: hook.phase,
      handler: async (context) => {
        if (hook.entity !== undefined && hook.entity !== context.entity) return;
        await hook.handler(context);
      },
    }));
  }
}
