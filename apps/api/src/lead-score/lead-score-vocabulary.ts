/**
 * Phase 19-LS.2 — the enumerated vocabularies Lead Score records use
 * (`PLAN_Phase_19_LeadScore.md` §3.1–§3.3, §5.1–§5.5; audit §4–§6).
 *
 * These are the code side of the enums declared in `database/seed-metadata.ts` (`LS_BANDS`,
 * `LS_MODEL_STATUSES`, …). The duplication is deliberate and is the pattern Customer Success already
 * follows — `customer-success-domain.ts` and the seed each name the same list, and the schema check in
 * `docs/implementation/lead-score-ls2-completion-report.md` is what keeps them honest, because an enum
 * that drifts turns a stored value into one nothing recognizes.
 *
 * A band, a status or a trigger is a decision point: it appears in a filter, in an export and in
 * `scoreReasonCodes`, so it is an enumerated value rather than free text. `Disqualified` is reachable
 * only through a `setBand` rule or the existing `Dead` Lead status — never because a score was low
 * (plan §3.3).
 */

/** Qualification bands (plan §3.3). `Unknown` is the state of a Lead that has never been scored. */
export const SCORE_BANDS = ['Unknown', 'Cold', 'Warm', 'Hot', 'Sales Ready', 'Disqualified'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** Whether the stored projection still describes the Lead (plan §3.1 `evaluationStatus`). */
export const EVALUATION_STATUSES = ['current', 'stale', 'pending', 'failed', 'not_scored'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/** Model lifecycle. A published version is immutable; editing forks a draft (plan §5.1). */
export const MODEL_STATUSES = ['draft', 'published', 'archived'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Scoring dimensions (plan §3.2) — configurable groupings, never hard-coded sales rules. */
export const RULE_DIMENSIONS = ['fit', 'intent', 'engagement', 'completeness', 'recency', 'negative'] as const;
export type RuleDimension = (typeof RULE_DIMENSIONS)[number];

/**
 * The only effects a rule may have (plan §5.2). There is no `write field` and no `convert`: a score is a
 * prioritization signal, and conversion stays an explicit user action (§6.6, §2.2).
 */
export const RULE_EFFECTS = ['add', 'subtract', 'setBand'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** Missing-signal semantics (plan §5.2). Absent data is unknown, not negative — unless a rule says so. */
export const MISSING_DATA_POLICIES = ['ignore', 'neutral'] as const;
export type MissingDataPolicy = (typeof MISSING_DATA_POLICIES)[number];

/**
 * What a rule may read (plan §5.2, §10.1). This is the closed set the audit found real: the Lead's own
 * attributes, Marketing Automation's delivery/event tables and the core `Email`↔Lead links. There is no
 * `activities` source because Task/Call/Meeting cannot reference a Lead in this build (audit gap G2).
 */
export const SIGNAL_SOURCES = ['lead', 'marketingEvents', 'emailLinks'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** Why an evaluation happened (plan §5.4). */
export const EVALUATION_TRIGGERS = ['lead_change', 'engagement_event', 'manual_recalculate', 'model_publish', 'batch_rebuild', 'decay_sweep'] as const;
export type EvaluationTrigger = (typeof EVALUATION_TRIGGERS)[number];

/** How far an evaluation got (plan §5.4: partial and failed history is kept, not hidden). */
export const EVALUATION_RESULT_STATES = ['success', 'partial', 'failed'] as const;
export type EvaluationResultState = (typeof EVALUATION_RESULT_STATES)[number];

/** Time decay on a signal, applied at evaluation time rather than by rewriting history (plan §6.4). */
export const DECAY_POLICIES = ['none', 'linear', 'halfLife'] as const;
export type DecayPolicy = (typeof DECAY_POLICIES)[number];

/** Conversion operation lifecycle (plan §5.5). */
export const CONVERSION_STATUSES = ['previewed', 'processing', 'succeeded', 'failed_retryable', 'failed_final', 'needs_review'] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/** The canonical target types a conversion may create or link (plan §7.2). */
export const CONVERSION_TARGETS = ['Contact', 'Account', 'Opportunity'] as const;
export type ConversionTarget = (typeof CONVERSION_TARGETS)[number];

/** Per-rule outcomes recorded on an evaluation (plan §3.1 `ruleResults`). */
export const RULE_OUTCOMES = ['matched', 'not_matched', 'unknown', 'skipped', 'expired', 'error'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/** The score scale's default bounds; a model may configure others but the UI always shows them (§3.1). */
export const DEFAULT_SCORE_SCALE = { min: 0, max: 100 } as const;
