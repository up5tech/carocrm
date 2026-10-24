import type { Provider, Type } from '@nestjs/common';

import { LeadScoreController } from './lead-score.controller.js';
import { LeadScoreCalculationService } from './lead-score-calculation.service.js';
import { LeadScoreExplanationService } from './lead-score-explanation.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScorePreviewService } from './lead-score-preview.service.js';
import { LeadScoreRecords } from './lead-score-records.js';
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
  LeadScoreModelService,
  LeadScoreRecords,
  LeadScorePreviewService,
  LeadScoreCalculationService,
  LeadScoreExplanationService,
  LeadScoreFeatureGate,
  LeadScoreModuleHealthService,
];

export { LeadScoreController } from './lead-score.controller.js';
export {
  LeadScoreCalculationService,
  type ScoreWriteView,
} from './lead-score-calculation.service.js';
export {
  type ConditionFieldPolicy,
  type ConditionIssue,
  type ConditionIssueCode,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MAX_CONDITION_PREDICATES,
  NEVER_SCORABLE_FIELD_TYPES,
  type ParsedCondition,
  parseScoreCondition,
  PROTECTED_FIELD_NAMES,
  type ScoreableField,
  SCORING_OUTPUT_FIELD_NAMES,
  validateScoreCondition,
} from './lead-score-condition.js';
export {
  LEADSCORE_CORE_ENTITY_TYPES,
  LEADSCORE_EVENT_NAMESPACE,
  LEADSCORE_MODULE_KEY,
  LEADSCORE_SETTINGS_ROW,
} from './lead-score-domain.js';
export {
  leadScoreDraftExistsError,
  LeadScoreError,
  leadScoreInvalidStateError,
  leadScoreModelImmutableError,
  leadScoreModuleDisabledError,
  leadScoreNoActiveModelError,
  leadScorePhasePendingError,
} from './lead-score-errors.js';
export {
  EVALUATION_CODES,
  type EvaluationRequest,
  MAX_EVALUATED_RULES,
  requiredInputFields,
  type RuleEvaluation,
  type ScoreEvaluation,
  type ScoreInputSnapshot,
  scoreLead,
  SCORING_OPERATORS,
} from './lead-score-evaluator.js';
export {
  LeadScoreExplanationService,
  MAX_HISTORY_PAGE,
  type ScoreBreakdownEntry,
  type ScoreHistoryView,
  type ScoreReadView,
} from './lead-score-explanation.service.js';
export { LEADSCORE_OPERATIONS, LeadScoreFeatureGate, type LeadScoreOperation, type LeadScoreOperationAssessment } from './lead-score-feature-gate.service.js';
export {
  changedKeys,
  isLeadScoreInternalWrite,
  LEADSCORE_ENTITY_TYPES,
  type LeadScoreEntityType,
  MODEL_DRAFT_STATUS,
  MODEL_FROZEN_STATUSES,
  MODULE_WRITTEN_ENTITY_TYPES,
  runAsLeadScoreInternal,
  SERVER_OWNED_LEAD_FIELDS,
  SERVER_OWNED_MODEL_FIELDS,
} from './lead-score-internal.js';
export { LeadScoreModelService } from './lead-score-model.service.js';
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
export { LeadScorePreviewService, type LeadScorePreviewView,MAX_PREVIEW_SAMPLE } from './lead-score-preview.service.js';
export { type LeadScoreEvaluationPage, LeadScoreRecords,type LeadScoreRow } from './lead-score-records.js';
export {
  DEFAULT_LEADSCORE_SETTINGS,
  type LeadScoreSettings,
  LeadScoreSettingsSchema,
  LeadScoreSettingsService,
  type LeadScoreSettingsView,
} from './lead-score-settings.service.js';
export {
  MAX_RULE_POINTS,
  type ModelAttributes,
  REASON_CODE_PATTERN,
  type RuleAttributes,
  validateModel,
  VALIDATION_CODES,
  type ValidationIssue,
  type ValidationReport,
} from './lead-score-validator.js';
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
