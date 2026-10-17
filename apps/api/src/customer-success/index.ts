import type { Provider, Type } from "@nestjs/common";

import { CustomerSuccessController } from "./customer-success.controller.js";
import { CustomerSuccessDashletService } from "./customer-success-dashlet.service.js";
import { CustomerSuccessGoalService } from "./customer-success-goal.service.js";
import { CustomerSuccessHealthService } from "./customer-success-health.service.js";
import { CustomerSuccessHealthSnapshotService } from "./customer-success-health-snapshot.service.js";
import { CustomerSuccessLifecycleService } from "./customer-success-lifecycle.service.js";
import { CustomerSuccessModuleHealthService } from "./customer-success-module-health.service.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessPlanService } from "./customer-success-plan.service.js";
import { CustomerSuccessPlaybookService } from "./customer-success-playbook.service.js";
import { CustomerSuccessPortfolioService } from "./customer-success-portfolio.service.js";
import { CustomerSuccessProfileService } from "./customer-success-profile.service.js";
import { CustomerSuccessRecords } from "./customer-success-records.js";
import { CustomerSuccessRenewalService } from "./customer-success-renewal.service.js";
import { CustomerSuccessRiskService } from "./customer-success-risk.service.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";
import { HealthSignalRegistry } from "./customer-success-signals.js";
import { CustomerSuccessTouchpointService } from "./customer-success-touchpoint.service.js";
import { CustomerSuccessWriteGuardService } from "./customer-success-write-guard.service.js";

/**
 * Phase 19-CS.1 — Customer Success module barrel (PLAN_Phase_19_Customer_Success.md §14, `19-CS.1`).
 *
 * Like Sales and Projects, `CustomerSuccess` is a kernel domain directory under `apps/api/src`, not a
 * second framework: entity records use the generic `entity_records` store, and ACL, audit, stream,
 * attachments, hooks, jobs and search are the kernel's and are reused rather than re-implemented.
 *
 * `CUSTOMER_SUCCESS_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: this
 * controller owns the static `/api/v1/CustomerSuccess` prefix, and the generic `:entity` wildcard has
 * to stay last so static routes win (docs/module-guide.md).
 */
export const CUSTOMER_SUCCESS_CONTROLLERS: Type<unknown>[] = [CustomerSuccessController];

export const CUSTOMER_SUCCESS_PROVIDERS: Provider[] = [
  CustomerSuccessRecords,
  CustomerSuccessSettingsService,
  CustomerSuccessWriteGuardService,
  HealthSignalRegistry,
  CustomerSuccessModuleHealthService,
  CustomerSuccessProfileService,
  CustomerSuccessLifecycleService,
  CustomerSuccessPortfolioService,
  CustomerSuccessHealthSnapshotService,
  CustomerSuccessHealthService,
  CustomerSuccessPlanService,
  CustomerSuccessGoalService,
  CustomerSuccessRiskService,
  CustomerSuccessNotificationService,
  CustomerSuccessPlaybookService,
  CustomerSuccessRenewalService,
  CustomerSuccessTouchpointService,
  CustomerSuccessDashletService,
];

export { CustomerSuccessController } from "./customer-success.controller.js";
export { runAsSystem, SYSTEM_PRINCIPAL } from "./customer-success-authority.js";
export { CustomerSuccessDashletService } from "./customer-success-dashlet.service.js";
export {
  CUSTOMER_SUCCESS_DASHLET_DEFINITIONS,
  type CustomerSuccessDashletDefinition,
} from "./customer-success-dashlet.service.js";
export {
  checkLifecycleTransition,
  checkRiskTransition,
  classifyHealth,
  computeGoalProgress,
  computeHealthScore,
  dayDifference,
  DEFAULT_HEALTH_THRESHOLDS,
  DEFAULT_LIFECYCLE_TRANSITIONS,
  DEFAULT_RENEWAL_WINDOWS,
  GOAL_DIRECTIONS,
  type GoalProgressResult,
  HEALTH_STATUSES,
  type HealthCalculation,
  type HealthStatus,
  type HealthThresholdBand,
  healthTrend,
  isMeaningfulTouch,
  lastMeaningfulTouchAt,
  LIFECYCLE_STAGES,
  type PlaybookStepInput,
  PORTFOLIO_QUEUES,
  type PortfolioQueue,
  readyPlaybookSteps,
  renewalWindow,
  RISK_SEVERITIES,
  RISK_TYPES,
  riskComponentScore,
  type SignalApplicability,
  validateHealthThresholds,
  validatePlaybookSteps,
} from "./customer-success-domain.js";
export { CustomerSuccessGoalService } from "./customer-success-goal.service.js";
export {
  CustomerSuccessHealthService,
  type HealthView,
  type RecalculateOptions,
  RECALCULATION_SOURCES,
  type RecalculationSource,
} from "./customer-success-health.service.js";
export { CustomerSuccessHealthSnapshotService } from "./customer-success-health-snapshot.service.js";
export {
  CUSTOMER_SUCCESS_ENTITY_TYPES,
  isCustomerSuccessInternalWrite,
  runAsCustomerSuccessInternal,
} from "./customer-success-internal.js";
export { CustomerSuccessLifecycleService } from "./customer-success-lifecycle.service.js";
export {
  CUSTOMER_SUCCESS_FEATURES,
  CUSTOMER_SUCCESS_MODULE,
  OPTIONAL_INTEGRATIONS,
  SALES_INTEGRATION_MARKER_ENTITY,
} from "./customer-success-module.js";
export { CustomerSuccessModuleHealthService } from "./customer-success-module-health.service.js";
export { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
export { CustomerSuccessPlanService, PLAN_STATUSES } from "./customer-success-plan.service.js";
export { CustomerSuccessPlaybookService } from "./customer-success-playbook.service.js";
export { CustomerSuccessPortfolioService } from "./customer-success-portfolio.service.js";
export { CustomerSuccessProfileService } from "./customer-success-profile.service.js";
export { CustomerSuccessRecords } from "./customer-success-records.js";
export { CustomerSuccessRenewalService } from "./customer-success-renewal.service.js";
export { CustomerSuccessRiskService } from "./customer-success-risk.service.js";
export {
  type CustomerSuccessSettings,
  CustomerSuccessSettingsSchema,
  CustomerSuccessSettingsService,
  DEFAULT_CUSTOMER_SUCCESS_SETTINGS,
} from "./customer-success-settings.service.js";
export {
  type HealthFacts,
  type HealthSignalProvider,
  HealthSignalRegistry,
  type HealthSignalResult,
} from "./customer-success-signals.js";
export { CustomerSuccessTouchpointService } from "./customer-success-touchpoint.service.js";
export { CustomerSuccessWriteGuardService } from "./customer-success-write-guard.service.js";
