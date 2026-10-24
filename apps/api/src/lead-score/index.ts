import type { Provider, Type } from '@nestjs/common';

import { LeadScoreController } from './lead-score.controller.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import { LeadScoreWriteGuardService } from './lead-score-write-guard.service.js';

/**
 * Phase 19-LS.1 — the `LeadScore` module barrel (`PLAN_Phase_19_LeadScore.md` §4.1, §16 `19-LS.1`).
 *
 * Like Customer Success, Sales and ESignature, Lead Score is a kernel domain directory under
 * `apps/api/src`, not an installable extension package and not a second framework: score and
 * operation records use the generic `entity_records` store, and ACL, validation, audit, stream,
 * hooks, jobs and search stay the platform's and are reused rather than re-implemented (AGENTS.md §5).
 *
 * `LEADSCORE_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: this controller
 * owns the static `/api/v1/LeadScore` prefix, and the generic `:entity` wildcard has to stay last so
 * static routes win.
 *
 * The plan names a `LeadScoreModule` class; this repository has no per-domain `@Module` class — a
 * domain module *is* this barrel plus the two spreads in `AppModule`. Same wiring, one convention
 * (recorded in `docs/implementation/lead-score-ls1-completion-report.md`).
 */
export const LEADSCORE_CONTROLLERS: Type<unknown>[] = [LeadScoreController];

export const LEADSCORE_PROVIDERS: Provider[] = [
  // Registered first so its `onApplicationBootstrap` hook lands before any record write can be served.
  LeadScoreWriteGuardService,
  LeadScoreSettingsService,
  LeadScorePermissionService,
  LeadScoreFeatureGate,
  LeadScoreModuleHealthService,
];

export { LeadScoreController } from './lead-score.controller.js';
export {
  LEADSCORE_CORE_ENTITY_TYPES,
  LEADSCORE_EVENT_NAMESPACE,
  LEADSCORE_MODULE_KEY,
  LEADSCORE_SETTINGS_ROW,
} from './lead-score-domain.js';
export { LeadScoreError, leadScoreModuleDisabledError, leadScorePhasePendingError } from './lead-score-errors.js';
export { LEADSCORE_OPERATIONS, LeadScoreFeatureGate, type LeadScoreOperation, type LeadScoreOperationAssessment } from './lead-score-feature-gate.service.js';
export {
  changedKeys,
  isLeadScoreInternalWrite,
  LEADSCORE_ENTITY_TYPES,
  type LeadScoreEntityType,
  MODULE_WRITTEN_ENTITY_TYPES,
  runAsLeadScoreInternal,
  SERVER_OWNED_LEAD_FIELDS,
  SERVER_OWNED_MODEL_FIELDS,
} from './lead-score-internal.js';
export {
  LEADSCORE_CAPABILITIES,
  LEADSCORE_FEATURES,
  LEADSCORE_MODULE,
  LEADSCORE_PENDING_FEATURES,
  type LeadScoreCapabilityDefinition,
  type LeadScoreCapabilityKey,
  type LeadScoreErrorCode,
  type LeadScoreFeatureDescriptor,
  type LeadScoreModuleDescriptor,
  OPTIONAL_INTEGRATIONS,
  REQUIRED_CAPABILITIES,
} from './lead-score-module.js';
export {
  type HealthCheck,
  type HealthDependency,
  type HealthFeature,
  type HealthIntegration,
  type LeadScoreHealthView,
  LeadScoreModuleHealthService,
} from './lead-score-module-health.service.js';
export { LeadScorePermissionService } from './lead-score-permission.service.js';
export {
  DEFAULT_LEADSCORE_SETTINGS,
  type LeadScoreSettings,
  LeadScoreSettingsSchema,
  LeadScoreSettingsService,
  type LeadScoreSettingsView,
} from './lead-score-settings.service.js';
export {
  CONVERSION_STATUSES,
  CONVERSION_TARGETS,
  DECAY_POLICIES,
  DEFAULT_SCORE_SCALE,
  EVALUATION_RESULT_STATES,
  EVALUATION_STATUSES,
  EVALUATION_TRIGGERS,
  MISSING_DATA_POLICIES,
  MODEL_STATUSES,
  RULE_DIMENSIONS,
  RULE_EFFECTS,
  RULE_OUTCOMES,
  SCORE_BANDS,
  SIGNAL_SOURCES,
} from './lead-score-vocabulary.js';
export { LeadScoreWriteGuardService } from './lead-score-write-guard.service.js';
