import type { Provider, Type } from "@nestjs/common";

import { CaseAssignmentService } from "./case-assignment.service.js";
import { CaseLifecycleService } from "./case-lifecycle.service.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import { ServiceDeskController } from "./service-desk.controller.js";
import { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
import { ServiceDeskNotificationService } from "./service-desk-notification.service.js";
import { ServiceDeskRecords } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
import { ServiceDeskWriteGuardService } from "./service-desk-write-guard.service.js";

/**
 * Phase 19-SD.1 – 19-SD.5 — Service Desk module barrel (PLAN_Phase_19_ServiceDesk.md §7.1).
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
 * `beforeValidate` hooks are registered before any later service; the case handler still does its own
 * two jobs in a fixed order.
 */
export const SERVICE_DESK_CONTROLLERS: Type<unknown>[] = [ServiceDeskController];

export const SERVICE_DESK_PROVIDERS: Provider[] = [
  ServiceDeskSettingsService,
  ServiceDeskRecords,
  CaseNumberingService,
  ServiceDeskNotificationService,
  ServiceDeskWriteGuardService,
  CaseLifecycleService,
  CaseAssignmentService,
  ServiceDeskModuleHealthService,
];

export { type CaseAssignInput, type CaseAssignmentResult, CaseAssignmentService, type CaseRouteResult, type QueueWorkload } from "./case-assignment.service.js";
export { type CaseCapabilities, CaseLifecycleService, type CaseTransitionRequest, type CaseTransitionResult } from "./case-lifecycle.service.js";
export { CASE_NUMBER_SEQUENCE, type CaseNumberAllocation, CaseNumberingService, type CaseNumberPreview } from "./case-numbering.service.js";
export { ServiceDeskController } from "./service-desk.controller.js";
export {
  allowedCaseCommands,
  CASE_ACTIVE_STATUSES,
  CASE_ASSIGNMENT_STRATEGIES,
  CASE_ENTITY,
  CASE_FALLBACK_BEHAVIORS,
  CASE_PRIORITIES,
  CASE_SEVERITIES,
  CASE_SLA_STATES,
  CASE_SOURCES,
  CASE_STATUSES,
  CASE_TERMINAL_STATUSES,
  CASE_TRANSITION_COMMANDS,
  CASE_TRANSITIONS,
  CASE_TYPES,
  type CaseAssignmentStrategy,
  type CaseDefaults,
  type CaseFallbackBehavior,
  type CaseNumberingConfig,
  type CasePriority,
  type CaseStatus,
  type CaseTransitionCommand,
  checkCaseTransition,
  checkResolutionRequirement,
  commandTargetStatus,
  DEFAULT_CASE_DEFAULTS,
  DEFAULT_CASE_NUMBERING,
  DEFAULT_RESOLUTION_CODES,
  formatCaseNumber,
  hasRequesterReference,
  isCaseStatus,
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
export { ServiceDeskRecords } from "./service-desk-records.js";
export {
  DEFAULT_SERVICE_DESK_SETTINGS,
  type ServiceDeskSettings,
  ServiceDeskSettingsSchema,
  ServiceDeskSettingsService,
  settingsWarnings,
} from "./service-desk-settings.service.js";
export { ServiceDeskWriteGuardService } from "./service-desk-write-guard.service.js";
