/**
 * Phase 19-LS.1 — the `LeadScore` module descriptor
 * (`PLAN_Phase_19_LeadScore.md` §4.1, §16 `19-LS.1`; audit §2, §9).
 *
 * Like Customer Success, Sales and ESignature, `LeadScore` is a kernel domain directory under
 * `apps/api/src` rather than an installable extension package: the extension SDK exposes no entity
 * CRUD facade, so a package that owned score records could only write them with raw SQL and would
 * bypass ACL, validation, audit, stream and domain events (AGENTS.md §5.2).
 *
 * This file is the module's identity: its id and version, the platform capabilities it builds on, the
 * optional modules it can talk to, the rights it grants, and the feature switches with the sub-phase
 * that implements each one. The health endpoint reports all of it from the running system, so an
 * operator sees what is *installed* rather than what a plan promised.
 *
 * **Every feature is declared pending at LS.1.** That is the honest state and it is what plan §15.2
 * asks for: "deploy schema/metadata with scoring disabled and conversion behavior unchanged". A flag
 * here is an administrator's switch, not a claim that code exists — `effective` in the settings view
 * is `false` for a pending feature even when the switch is on.
 */

import type { AclAction } from '@carocrm/acl/types/index.js';

import {
  LEADCONVERSION_EXECUTE_PERMISSION_ENTITY,
  LEADCONVERSION_FIELD_MERGE_PERMISSION_ENTITY,
  LEADCONVERSION_OVERRIDE_PERMISSION_ENTITY,
  LEADCONVERSION_PREVIEW_PERMISSION_ENTITY,
  LEADCONVERSION_RECOVER_PERMISSION_ENTITY,
  LEADSCORE_BATCH_PERMISSION_ENTITY,
  LEADSCORE_EXPLAIN_PERMISSION_ENTITY,
  LEADSCORE_MODEL_PERMISSION_ENTITY,
  LEADSCORE_MODEL_PUBLISH_PERMISSION_ENTITY,
  LEADSCORE_PLANNED_ENTITY_TYPES,
  LEADSCORE_RECALCULATE_PERMISSION_ENTITY,
  LEADSCORE_SETTINGS_PERMISSION_ENTITY,
  LEADSCORE_SETTINGS_ROW,
  LEADSCORE_VIEW_PERMISSION_ENTITY,
} from './lead-score-domain.js';

export interface LeadScoreFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `leadScore` settings row. */
  readonly settingsPath: string;
  readonly requires: readonly string[];
  /** The sub-phase that implements this switch; `null` once it is delivered. */
  readonly pendingPhase: string | null;
}

export interface LeadScoreOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /**
   * Metadata marker the optional module registers. Detection reads the running registry, never an
   * import, so an absent module is a `false` answer rather than a broken boot (audit §7).
   */
  readonly markerEntity: string;
}

export type PlatformEvidenceKind = 'entity' | 'table' | 'column' | 'hookPhase';

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface LeadScorePlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * The stable codes this build answers with (plan §8.4: a caller switches on `code`, never on the
 * message). Each later phase adds the codes its own failures need — invalid mapping, stale preview,
 * duplicate review required, already converted, operation conflict — in the commit that raises them,
 * together with the catalog entries in `i18n/<locale>/errors.json` that localize them.
 */
export type LeadScoreErrorCode = 'LEADSCORE_MODULE_DISABLED' | 'LEADSCORE_PHASE_PENDING';

export interface LeadScoreCapabilityDefinition {
  readonly key: LeadScoreCapabilityKey;
  readonly label: string;
  readonly description: string;
  readonly resource: string;
  readonly action: AclAction;
}

/** Every right the module gates on; the matrix below gives each one its label and ACL resource. */
export type LeadScoreCapabilityKey =
  | 'viewScore'
  | 'explainScore'
  | 'recalculate'
  | 'modelRead'
  | 'modelManage'
  | 'modelPublish'
  | 'batchRecalculate'
  | 'settingsManage'
  | 'convertPreview'
  | 'convertExecute'
  | 'duplicateOverride'
  | 'applyFieldChanges'
  | 'conversionAuditRead'
  | 'conversionRecover';

/**
 * The rights this module gates on.
 *
 * Plan §9.1 also lists *Create Contact*, *Create Account*, *Link existing Contact/Account* and
 * *Convert Lead to Opportunity*. Those are **not** duplicated here on purpose: they are the core
 * entities' own ACL, and conversion enforces `Contact:create`, `Account:create`, `Opportunity:create`
 * and the corresponding read levels through `AclApiService` at execution time (plan §7.1, §9.2). A
 * `LeadScore`-specific "can create a Contact" right would be a second permission system that could
 * disagree with the first.
 */
export const LEADSCORE_CAPABILITIES: readonly LeadScoreCapabilityDefinition[] = [
  {
    key: 'viewScore',
    label: 'View lead scores',
    description: 'See the module, its current score and qualification band, and the reason codes a score carries.',
    resource: LEADSCORE_VIEW_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'explainScore',
    label: 'Read score explanation and history',
    description: 'Open the per-rule breakdown and the stored evaluations of a Lead, subject to the field ACL of the signals involved.',
    resource: LEADSCORE_EXPLAIN_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'recalculate',
    label: 'Recalculate one Lead score',
    description: 'Ask for a manual recalculation of a single Lead. Rate-bounded, because it is the cheap loop an interface must not enable.',
    resource: LEADSCORE_RECALCULATE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'modelRead',
    label: 'View score models and rules',
    description: 'Read the scoring models, their rule sets, thresholds and the field paths each model is allowed to use.',
    resource: LEADSCORE_MODEL_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'modelManage',
    label: 'Edit score model drafts',
    description: 'Create and edit a draft model and its rules. A draft never changes a stored score.',
    resource: LEADSCORE_MODEL_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'modelPublish',
    label: 'Publish and archive score models',
    description: 'Publish an immutable model version or archive it — the action that changes what future scores mean.',
    resource: LEADSCORE_MODEL_PUBLISH_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'batchRecalculate',
    label: 'Run batch recalculation',
    description: 'Queue a bounded background rebuild over a filtered Lead set after a model publication.',
    resource: LEADSCORE_BATCH_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'settingsManage',
    label: 'Administer Lead Score settings',
    description: 'Read and change the module switch, the feature switches and the policy limits.',
    resource: LEADSCORE_SETTINGS_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'convertPreview',
    label: 'Preview a Lead conversion',
    description: 'Build the side-effect-free preview: target choices, mapped fields, duplicate candidates and required fields.',
    resource: LEADCONVERSION_PREVIEW_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'convertExecute',
    label: 'Convert a Lead',
    description: 'Confirm and run a conversion. Still requires the target entities own create/link permissions at execution time.',
    resource: LEADCONVERSION_EXECUTE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'duplicateOverride',
    label: 'Create despite a duplicate warning',
    description: 'Proceed with a new Contact or Account when an exact match exists — an explicit, audited override.',
    resource: LEADCONVERSION_OVERRIDE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'applyFieldChanges',
    label: 'Apply Lead values to an existing record',
    description: 'Overwrite a non-empty field on a linked Contact or Account after a before/after preview. Off by default policy (plan §7.4).',
    resource: LEADCONVERSION_FIELD_MERGE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'conversionAuditRead',
    label: 'Read conversion operations',
    description: 'See who converted what, which targets were created versus linked, and the mapping version used.',
    resource: 'LeadConversionOperation',
    action: 'read',
  },
  {
    key: 'conversionRecover',
    label: 'Recover a failed conversion',
    description: 'Retry or resolve an operation left in a retryable state, after checking what it already created.',
    resource: LEADCONVERSION_RECOVER_PERMISSION_ENTITY,
    action: 'edit',
  },
];

/**
 * The feature switches and the sub-phase that implements each one.
 *
 * `pendingPhase` is data, not a comment: `LEADSCORE_PENDING_FEATURES` is derived from it, the settings
 * view computes `effective` from it, and the gate refuses an operation whose feature is still pending
 * with the phase in the response. A later phase flips it to `null` in its own commit.
 */
export const LEADSCORE_FEATURES: readonly LeadScoreFeatureDescriptor[] = [
  { key: 'modelAdministration', label: 'Score model administration', settingsPath: 'features.modelAdministration', requires: [], pendingPhase: '19-LS.3' },
  { key: 'scoring', label: 'Rule-based scoring', settingsPath: 'features.scoring', requires: ['modelAdministration'], pendingPhase: '19-LS.4' },
  { key: 'scoreExplanation', label: 'Score explanation and history', settingsPath: 'features.scoreExplanation', requires: ['scoring'], pendingPhase: '19-LS.5' },
  { key: 'manualRecalculation', label: 'Manual recalculation', settingsPath: 'features.manualRecalculation', requires: ['scoring'], pendingPhase: '19-LS.6' },
  { key: 'eventRecalculation', label: 'Event-driven recalculation', settingsPath: 'features.eventRecalculation', requires: ['scoring'], pendingPhase: '19-LS.6' },
  { key: 'batchRecalculation', label: 'Batch recalculation', settingsPath: 'features.batchRecalculation', requires: ['scoring'], pendingPhase: '19-LS.6' },
  { key: 'thresholdNotifications', label: 'Band-change notifications', settingsPath: 'features.thresholdNotifications', requires: ['scoring'], pendingPhase: '19-LS.9' },
  { key: 'engagementSignals', label: 'Marketing engagement signals', settingsPath: 'features.engagementSignals', requires: ['scoring'], pendingPhase: '19-LS.9' },
  { key: 'duplicateDetection', label: 'Duplicate candidate review', settingsPath: 'features.duplicateDetection', requires: [], pendingPhase: '19-LS.11' },
  { key: 'fieldMapping', label: 'Conversion field mapping', settingsPath: 'features.fieldMapping', requires: [], pendingPhase: '19-LS.12' },
  { key: 'conversionPreview', label: 'Conversion preview', settingsPath: 'features.conversionPreview', requires: ['fieldMapping'], pendingPhase: '19-LS.12' },
  { key: 'leadConversion', label: 'Lead conversion', settingsPath: 'features.leadConversion', requires: ['conversionPreview'], pendingPhase: '19-LS.13' },
  { key: 'conversionRecovery', label: 'Conversion operation recovery', settingsPath: 'features.conversionRecovery', requires: ['leadConversion'], pendingPhase: '19-LS.13' },
  { key: 'opportunityConversion', label: 'Opportunity conversion', settingsPath: 'features.opportunityConversion', requires: ['leadConversion'], pendingPhase: '19-LS.16' },
  { key: 'aiInsight', label: 'AI-assisted fit insight', settingsPath: 'features.aiInsight', requires: ['scoring'], pendingPhase: '19-LS.17' },
];

/** Everything still ahead of this build, derived from the table above so the two cannot disagree. */
export const LEADSCORE_PENDING_FEATURES: readonly { readonly key: string; readonly phase: string }[] = LEADSCORE_FEATURES.flatMap(
  (feature) => (feature.pendingPhase === null ? [] : [{ key: feature.key, phase: feature.pendingPhase }]),
);

export const REQUIRED_CAPABILITIES: readonly LeadScorePlatformCapability[] = [
  {
    id: 'entity-engine',
    label: 'Entity Engine (metadata-driven records)',
    evidence: [
      { kind: 'entity', value: 'Lead' },
      { kind: 'table', value: 'entity_records' },
      { kind: 'table', value: 'metadata_entries' },
    ],
  },
  {
    id: 'crm-core-records',
    label: 'CRM core records this module extends',
    evidence: [
      { kind: 'entity', value: 'Lead' },
      { kind: 'entity', value: 'Contact' },
      { kind: 'entity', value: 'Account' },
      { kind: 'entity', value: 'Opportunity' },
    ],
  },
  {
    id: 'acl',
    label: 'ACL (record and field level)',
    evidence: [
      { kind: 'table', value: 'roles' },
      { kind: 'column', value: 'roles.permissions' },
      { kind: 'column', value: 'roles.field_permissions' },
    ],
  },
  {
    id: 'hooks',
    label: 'Hook registry (audit, stream, domain events)',
    evidence: [
      { kind: 'hookPhase', value: 'beforeValidate' },
      { kind: 'hookPhase', value: 'afterSave' },
    ],
  },
  {
    id: 'audit-stream-outbox',
    label: 'Audit log, stream and transactional outbox',
    evidence: [
      { kind: 'table', value: 'audit_log' },
      { kind: 'table', value: 'stream_items' },
      { kind: 'table', value: 'outbox_events' },
    ],
  },
  {
    id: 'jobs',
    label: 'Background jobs and schedules',
    evidence: [
      { kind: 'table', value: 'jobs' },
      { kind: 'table', value: 'job_logs' },
      { kind: 'table', value: 'scheduled_jobs' },
    ],
  },
  {
    id: 'settings',
    label: 'Instance settings store',
    evidence: [{ kind: 'table', value: 'app_settings' }],
  },
];

/**
 * Optional modules, detected by the marker entity each one registers.
 *
 * Plan §0.1-4 forbids assuming an event or API exists. These are the three cases the audit resolved
 * (§7): MarketingAutomation engagement is a **table read**, not an event; Sales owns no Opportunity
 * and emits no events, so only the core `Opportunity` record is consumed; AIAgents answers manual
 * runs only. None of them is a prerequisite for scoring or conversion.
 */
export const OPTIONAL_INTEGRATIONS: readonly LeadScoreOptionalIntegration[] = [
  {
    id: 'marketing-automation',
    label: 'Marketing Automation',
    provides: 'Delivered/opened/clicked/bounced engagement per recipient record, campaign attribution and suppression state, read from the delivery tables',
    markerEntity: 'Campaign',
  },
  {
    id: 'email-engagement',
    label: 'Email links to Leads',
    provides: 'Inbound and outbound Email records already linked to a Lead through the core relation',
    markerEntity: 'Email',
  },
  {
    id: 'ai-agents',
    label: 'AI Agents',
    provides: 'An optional, operator-requested fit explanation from an audited manual run — never a score input',
    markerEntity: 'AIAgent',
  },
  {
    id: 'workflows',
    label: 'Workflows / BPM',
    provides: 'Reactions to a Lead change or band crossing through the platform engine (the `runJob` seam); no LeadScore-owned trigger type',
    markerEntity: 'Workflow',
  },
];

export const LEADSCORE_MODULE = {
  id: 'LeadScore',
  name: 'Lead Score',
  version: '0.1.0',
  minPlatformVersion: '1.0.0',
  /** Kernel module directories load in order; Lead Score runs after ESignature (`390`). */
  loadOrder: 395,
  apiPrefix: '/api/v1/LeadScore',
  settingsRow: LEADSCORE_SETTINGS_ROW,
  /** Sub-phases delivered by this module. */
  implementedPhases: ['19-LS.0', '19-LS.1'],
  /**
   * The entity set this module owns. Empty until 19-LS.2 registers them — reporting the plan separately
   * (`plannedEntityTypes`) is what keeps the health view honest about what exists today.
   */
  entityTypes: [] as readonly string[],
  plannedEntityTypes: LEADSCORE_PLANNED_ENTITY_TYPES,
} as const;

export type LeadScoreModuleDescriptor = typeof LEADSCORE_MODULE;
