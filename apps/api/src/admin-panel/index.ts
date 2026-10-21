/**
 * Admin panel barrel — integrator entry point (PLAN_Phase_20_Settings_UX.md §7.1).
 *
 * Wire into AppModule:
 *   controllers: [...ADMIN_PANEL_CONTROLLERS]   // after ...SETTINGS_CONTROLLERS, before the `:entity` wildcard
 *   providers:   [...ADMIN_PANEL_PROVIDERS]
 *
 * Owns the settings document registry, the document read/write/reset service, the administration
 * panel descriptors and the navigation resolver. It depends on the request scope, the ACL, the
 * metadata registry, the extension host and the settings services; nothing domain-specific depends
 * on it.
 */
import type { Provider, Type } from '@nestjs/common';

import { AdminPanelController, NavigationController } from './admin-panel.controller.js';
import { AdminPanelService } from './admin-panel.service.js';
import { InternalInfoController } from './internal.controller.js';
import { InternalInfoService } from './internal.service.js';
import { NavigationService } from './navigation.service.js';
import { allowEveryNavigationFeature, NAVIGATION_FEATURE_GATE } from './navigation-features.js';
import { PlatformSettingsRegistrar } from './platform-settings.js';
import { SettingsDocumentService } from './settings-document.service.js';
import { SettingsDocumentsController } from './settings-documents.controller.js';
import { SettingsRegistryService } from './settings-registry.service.js';

export { AdminPanelController, NavigationController } from './admin-panel.controller.js';
export type { AdminPanelGroup, AdminPanelTab } from './admin-panel.service.js';
export { AdminPanelService,adminTabDocKeys } from './admin-panel.service.js';
export { InternalInfoController } from './internal.controller.js';
export type { InternalInfoView } from './internal.service.js';
export { InternalInfoService, METADATA_RESET_CONFIRM, QUEUE_PURGE_CONFIRM } from './internal.service.js';
export type { NavigationNode, NavigationTree } from './navigation.service.js';
export { NavigationService } from './navigation.service.js';
export type { NavigationFeatureGate } from './navigation-features.js';
export { allowEveryNavigationFeature, NAVIGATION_FEATURE_GATE } from './navigation-features.js';
export type { SettingsDocumentView } from './settings-document.service.js';
export { SettingsDocumentService } from './settings-document.service.js';
export { SettingsDocumentsController } from './settings-documents.controller.js';
export type { RegisteredDocument, SettingsDocumentDefinition, SettingsLevel, SettingsWarning } from './settings-registry.service.js';
export { SettingsRegistryService } from './settings-registry.service.js';
export {
  DEFAULT_NAVIGATION_SETTINGS,
  NAVIGATION_ACCENTS,
  NAVIGATION_ICONS,
  type NavigationSettings,
  NavigationSettingsSchema,
} from './settings-shapes.js';

export const ADMIN_PANEL_PROVIDERS: Provider[] = [
  // Default feature gate: every module page is visible. `AppModule` overrides this with a resolver
  // that reads each module's settings row, so the kernel depends on no domain module.
  { provide: NAVIGATION_FEATURE_GATE, useValue: allowEveryNavigationFeature },
  SettingsRegistryService,
  SettingsDocumentService,
  NavigationService,
  AdminPanelService,
  PlatformSettingsRegistrar,
  InternalInfoService,
];

export const ADMIN_PANEL_CONTROLLERS: Type<unknown>[] = [AdminPanelController, NavigationController, SettingsDocumentsController, InternalInfoController];
