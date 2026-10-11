import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { HOOK_PHASES } from '@carocrm/entity-engine/types/index.js';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { HookRegistry } from './hook.registry.js';

/**
 * Hook introspection (PLAN §23.1, §9.4): which phases exist and which handlers are installed.
 * Static prefix, so it must be registered before the generic record controller.
 */
@ApiTags('platform')
@Controller('api/v1/Hook')
export class HookController {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  list(): { phases: string[]; recommended: string[]; handlers: { name: string; phase: string; entity: string }[] } {
    if (!this.scope.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to inspect hooks.');
    return {
      phases: this.hooks.phases(),
      recommended: [...HOOK_PHASES],
      handlers: this.hooks.list(),
    };
  }
}
