import type { Provider, Type } from '@nestjs/common';

import { ExtensionController } from './extension.controller.js';
import { ExtensionService } from './extension.service.js';

export { ExtensionController } from './extension.controller.js';
export type { ExtensionContributes, ExtensionView, InstallResult } from './extension.service.js';
export { ExtensionService } from './extension.service.js';
export { EXTENSION_HOST, extensionHost, setExtensionHost } from './extension-host.js';
export { applyExtensionMigrations, readInstalledExtensions } from './extension-store.js';
export type { ExtensionRuntime, FrontendNavContribution, SkippedExtension } from '@carocrm/extension-sdk';
export type { LoadExtensionsOptions } from '@carocrm/extension-sdk';
export type { ExtensionHost as ExtensionHostType } from '@carocrm/extension-sdk';
export { ExtensionHost, loadExtensions } from '@carocrm/extension-sdk';

/**
 * Kernel module for extension administration. Registered by the integrator *before*
 * `ENTITY_CONTROLLERS` (static `/api/v1/Extension` prefix) — see `apps/api/src/app.module.ts`.
 *
 * Extension *packages* are not registered here: their providers and controllers are installed by
 * `createExtensionHostModule()`, which the bootstrap builds from the packages that are installed
 * and enabled on disk.
 */
export const EXTENSION_CONTROLLERS: Type<unknown>[] = [ExtensionController];
export const EXTENSION_PROVIDERS: Provider[] = [ExtensionService];