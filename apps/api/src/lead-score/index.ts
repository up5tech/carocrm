import type { Provider, Type } from '@nestjs/common';

import { LeadScoreController } from './lead-score.controller.js';
import { LeadScoreCalculationService } from './lead-score-calculation.service.js';
import { LeadScoreEditorService } from './lead-score-editor.js';
import { LeadScoreExplanationService } from './lead-score-explanation.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScorePreviewService } from './lead-score-preview.service.js';
import { LeadScoreRecalculationService } from './lead-score-recalculation.service.js';
import { LeadScoreRecords } from './lead-score-records.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import { LeadScoreSignalsService } from './lead-score-signals.js';
import { LeadScoreThresholdService } from './lead-score-threshold.service.js';
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
  // Reads only the metadata registry, so it is registered with the reads rather than the writers.
  LeadScoreEditorService,
  // 19-LS.9: the engagement read (another module's table, bounded) and the threshold action (events, one
  // notification and one audit row inside the score transaction).
  LeadScoreSignalsService,
  LeadScoreThresholdService,
  // Needs the job row and the settings document, so it is registered with the services it reads.
  LeadScoreRecalculationService,
  LeadScoreModuleHealthService,
];

export { LeadScoreController } from './lead-score.controller.js';
export { LEADSCORE_SYSTEM_PRINCIPAL, runAsLeadScoreSystem } from './lead-score-authority.js';
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
  LEADSCORE_BATCH_PERMISSION_ENTITY,
  LEADSCORE_CORE_ENTITY_TYPES,
  LEADSCORE_EVENT_NAMESPACE,
  LEADSCORE_EXPLAIN_PERMISSION_ENTITY,
  LEADSCORE_MODEL_PERMISSION_ENTITY,
  LEADSCORE_MODEL_PUBLISH_PERMISSION_ENTITY,
  LEADSCORE_MODULE_KEY,
  LEADSCORE_RECALCULATE_PERMISSION_ENTITY,
  LEADSCORE_SETTINGS_ROW,
  LEADSCORE_VIEW_PERMISSION_ENTITY,
} from './lead-score-domain.js';
export {
  type EditorCatalog,
  type EditorField,
  type EditorFieldRefusal,
  LeadScoreEditorService,
} from './lead-score-editor.js';
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
  type ScoreActionAnswer,
  type ScoreActions,
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
export {
  LeadScoreModelService,
  MAX_RULES_PER_MODEL,
  MAX_VERSIONS_PER_MODEL,
} from './lead-score-model.service.js';
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
export {
  type BatchChunkView,
  type BatchFilterCondition,
  type BatchStartView,
  LEADSCORE_JOB_NAMES,
  LeadScoreRecalculationService,
  MAX_BATCH_CHUNK,
  MAX_BATCH_TOTAL,
  type RecalculationDecision,
  type RecalculationEnqueueView,
} from './lead-score-recalculation.service.js';
export { type LeadScoreEvaluationPage, LeadScoreRecords,type LeadScoreRow } from './lead-score-records.js';
export {
  DEFAULT_LEADSCORE_SETTINGS,
  type LeadScoreSettings,
  LeadScoreSettingsSchema,
  LeadScoreSettingsService,
  type LeadScoreSettingsView,
} from './lead-score-settings.service.js';
export {
  LeadScoreSignalsService,
  type SignalReading,
} from './lead-score-signals.js';
export {
  LEADSCORE_EVENT_TYPES,
  LeadScoreThresholdService,
  THRESHOLD_AUDIT_ACTION,
  type ThresholdInput,
  type ThresholdOutcome,
} from './lead-score-threshold.service.js';
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
  DEFAULT_SIGNAL_LOOKBACK_DAYS,
  eventTypesFor,
  isEngagementSource,
  MARKETING_EVENT_TYPES,
  MAX_SIGNAL_EVENTS_PER_PLAN,
  MAX_SIGNAL_LOOKBACK_DAYS,
  MAX_SIGNAL_PLANS_PER_MODEL,
  metricsByPlan,
  MIN_SIGNAL_LOOKBACK_DAYS,
  planKeyOf,
  SIGNAL_METRICS,
  type SignalMetric,
  type SignalPlan,
  signalPlans,
  type SignalSourceState,
} from './lead-score-vocabulary.js';
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
