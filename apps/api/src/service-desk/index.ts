import type { Provider, Type } from "@nestjs/common";

import { CaseNumberingService } from "./case-numbering.service.js";
import { ServiceDeskController } from "./service-desk.controller.js";
import { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
import { ServiceDeskWriteGuardService } from "./service-desk-write-guard.service.js";

/**
 * Phase 19-SD.1 — Service Desk module barrel (PLAN_Phase_19_ServiceDesk.md §7.1).
 *
 * Like Projects, Sales and Customer Success, `ServiceDesk` is a kernel domain directory under
 * `apps/api/src`, not a second framework: entity records use the generic `entity_records` store, and
 * ACL, audit, stream, attachments, hooks, jobs and search are the kernel's and are reused rather than
 * re-implemented.
 *
 * `SERVICE_DESK_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: this
 * controller owns the static `/api/v1/ServiceDesk` prefix, and the generic `:entity` wildcard has to
 * stay last so static routes win (docs/module-guide.md).
 *
 * Provider order is deliberate: `ServiceDeskWriteGuardService` is instantiated first so its
 * `beforeValidate` hook is registered before any later service, though the single handler makes the
 * guard's own two jobs order-independent.
 */
export const SERVICE_DESK_CONTROLLERS: Type<unknown>[] = [ServiceDeskController];

export const SERVICE_DESK_PROVIDERS: Provider[] = [
  ServiceDeskSettingsService,
  CaseNumberingService,
  ServiceDeskWriteGuardService,
  ServiceDeskModuleHealthService,
];

export { CASE_NUMBER_SEQUENCE, type CaseNumberAllocation, CaseNumberingService, type CaseNumberPreview } from "./case-numbering.service.js";
export { ServiceDeskController } from "./service-desk.controller.js";
export {
  CASE_ENTITY,
  CASE_PRIORITIES,
  CASE_SEVERITIES,
  CASE_SLA_STATES,
  CASE_SOURCES,
  CASE_STATUSES,
  CASE_TERMINAL_STATUSES,
  CASE_TYPES,
  type CaseDefaults,
  type CaseNumberingConfig,
  type CasePriority,
  type CaseStatus,
  DEFAULT_CASE_DEFAULTS,
  DEFAULT_CASE_NUMBERING,
  formatCaseNumber,
  hasRequesterReference,
} from "./service-desk-domain.js";
export {
  isServiceDeskInternalWrite,
  runAsServiceDeskInternal,
  SERVER_OWNED_CASE_FIELDS,
  SERVICE_DESK_ENTITY_TYPES,
} from "./service-desk-internal.js";
export {
  OPTIONAL_INTEGRATIONS,
  REQUIRED_CAPABILITIES,
  SERVICE_DESK_FEATURES,
  SERVICE_DESK_MODULE,
} from "./service-desk-module.js";
export { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
export {
  DEFAULT_SERVICE_DESK_SETTINGS,
  type ServiceDeskSettings,
  ServiceDeskSettingsSchema,
  ServiceDeskSettingsService,
  settingsWarnings,
} from "./service-desk-settings.service.js";
export { ServiceDeskWriteGuardService } from "./service-desk-write-guard.service.js";
