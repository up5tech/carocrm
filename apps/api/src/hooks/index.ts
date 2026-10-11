import type { Provider, Type } from '@nestjs/common';

import { HookController } from './hook.controller.js';
import { HookRegistry } from './hook.registry.js';

export type { EntityHookRegistration, HookDescription } from './hook.registry.js';
export { HookRegistry } from './hook.registry.js';

export const HOOK_CONTROLLERS: Type<unknown>[] = [HookController];
export const HOOK_PROVIDERS: Provider[] = [HookRegistry];
