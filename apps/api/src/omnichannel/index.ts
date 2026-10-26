/**
 * Phase 19-OM.2 — the module barrel (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`).
 *
 * The repository's module convention: a directory under `apps/api/src/`, an `index.ts` that exports
 * the controller and provider arrays, and one spread in `app.module.ts`. The shell never imports
 * the module's files directly.
 *
 * `OMNICHANNEL_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: it owns the
 * static `/api/v1/Omnichannel` prefix, and the generic `:entity` wildcard has to stay last so static
 * routes win. The reserved webhook prefix (`OMNICHANNEL_MODULE.webhookPrefix`) has no controller
 * yet — the first provider ingress and the `bootstrap.ts` raw-body entry (extension E2) arrive
 * together in 19-OM.5, never one without the other.
 */

import type { Provider, Type } from '@nestjs/common';

import { OmnichannelController } from './omnichannel.controller.js';
import { OmnichannelModuleHealthService } from './omnichannel-module-health.service.js';
import { OmnichannelNavigationService } from './omnichannel-navigation.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { noopMenuInvalidator, OMNICHANNEL_MENU_INVALIDATOR, OmnichannelSettingsService } from './omnichannel-settings.service.js';

export const OMNICHANNEL_CONTROLLERS: Type<unknown>[] = [OmnichannelController];

export const OMNICHANNEL_PROVIDERS: Provider[] = [
  // Default menu-invalidator binding so an isolated boot works; `AppModule` overrides the token
  // with the lazy `NavigationService` resolver (the `CRM_CHAT_MENU_INVALIDATOR` wiring).
  { provide: OMNICHANNEL_MENU_INVALIDATOR, useValue: noopMenuInvalidator },
  // Settings first: the permission-free switch every other service and the kernel gate reads.
  OmnichannelSettingsService,
  OmnichannelPermissionService,
  OmnichannelNavigationService,
  OmnichannelModuleHealthService,
];

export type { OmnichannelCapabilityDefinition,OmnichannelCapabilityKey } from './omnichannel-module.js';
export { OMNICHANNEL_CAPABILITIES, OMNICHANNEL_FEATURES, OMNICHANNEL_MODULE } from './omnichannel-module.js';
export type { OmnichannelHealthView } from './omnichannel-module-health.service.js';
export type { MenuInvalidator, OmnichannelSettings, OmnichannelSettingsView } from './omnichannel-settings.service.js';
export { noopMenuInvalidator, OMNICHANNEL_MENU_INVALIDATOR, OmnichannelSettingsService } from './omnichannel-settings.service.js';
