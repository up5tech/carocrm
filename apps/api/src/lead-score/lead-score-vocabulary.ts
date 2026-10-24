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

/** Membership test for a value that arrived as a plain string (a stored attribute, a request body). */
export function isScoreBand(value: string): value is ScoreBand {
  return (SCORE_BANDS as readonly string[]).includes(value);
}

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

/**
 * What an engagement source answers with, in place of a Lead field (plan §6.3, §10.1).
 *
 * A rule whose `signalSource` is not `lead` compares a **metric of that source**, never a Lead attribute:
 * the recipient-scoped engagement this record received inside the rule's own lookback window. The types are
 * the platform's own field types, so the operator matrix in `lead-score-condition.ts` decides what each
 * metric can answer and the editor offers exactly those operators — one vocabulary for a Lead field and for
 * a signal, which is what keeps a rule and a list filter from drifting into two languages.
 *
 * `lead` has no metrics: its conditions read the Lead's declared fields, which is the whole point of the
 * distinction.
 */
export interface SignalMetric {
  readonly name: string;
  /** A platform field type, so `OPERATORS_BY_TYPE` applies unchanged. */
  readonly type: 'int' | 'datetime';
}

export const SIGNAL_METRICS: Readonly<Record<SignalSource, readonly SignalMetric[]>> = {
  lead: [],
  marketingEvents: [
    { name: 'eventCount', type: 'int' },
    { name: 'lastEventAt', type: 'datetime' },
    { name: 'daysSinceLastEvent', type: 'int' },
  ],
  emailLinks: [
    { name: 'clickCount', type: 'int' },
    { name: 'lastClickedAt', type: 'datetime' },
    { name: 'daysSinceLastClick', type: 'int' },
  ],
};

/**
 * The `normalized_type` values Marketing Automation writes (audit §7.1).
 *
 * This is the MA vocabulary, restated here on purpose: Lead Score reads the table, it does not import the
 * module (plan §0.1-4), and an unknown type in a rule is refused at validation rather than silently matching
 * nothing. `conversion` is written by the attribution path outside MA's own union, and `provider_event` is a
 * raw fallback that means nothing to a scoring rule, so neither is offered.
 */
export const MARKETING_EVENT_TYPES = [
  'delivered',
  'opened',
  'clicked',
  'soft_bounce',
  'hard_bounce',
  'complaint',
  'unsubscribed',
  'rejected',
  'deferred',
  'provider_error',
] as const;
export type MarketingEventType = (typeof MARKETING_EVENT_TYPES)[number];

/**
 * Bounds on the engagement read (plan §6.3 "explicit lookback periods", §9.4 "bounded").
 *
 * A window is a *rule* setting, so a model that forgets one is refused at validation rather than silently
 * reading the whole event log; and the row cap is what keeps "how often did they open" answerable from the
 * set that was actually read, instead of from a truncated one that looks complete.
 */
export const MIN_SIGNAL_LOOKBACK_DAYS = 1;
export const MAX_SIGNAL_LOOKBACK_DAYS = 365;
export const MAX_SIGNAL_EVENTS_PER_PLAN = 200;
export const MAX_SIGNAL_PLANS_PER_MODEL = 20;
/** What a rule that forgot a window reads, which is also what the editor shows as its default. */
export const DEFAULT_SIGNAL_LOOKBACK_DAYS = 30;

/** A rule shape the contract needs, stated structurally so this file imports no other module. */
interface SignalRuleShape {
  readonly enabled: boolean;
  readonly signalSource: string;
  readonly eventType?: string | undefined;
  readonly lookbackDays?: number | undefined;
}

/** One (source, event types, window) the model actually asks for. Rules that agree share one plan. */
export interface SignalPlan {
  readonly key: string;
  readonly source: Exclude<SignalSource, 'lead'>;
  readonly eventTypes: readonly string[];
  readonly lookbackDays: number;
}

export function isEngagementSource(source: string): source is Exclude<SignalSource, 'lead'> {
  return source === 'marketingEvents' || source === 'emailLinks';
}

/** A window outside the bounds is clamped rather than refused here: validation refuses, this only reads. */
export function signalLookbackDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIGNAL_LOOKBACK_DAYS;
  return Math.min(MAX_SIGNAL_LOOKBACK_DAYS, Math.max(MIN_SIGNAL_LOOKBACK_DAYS, Math.trunc(value)));
}

/**
 * The event types a rule counts.
 *
 * `emailLinks` is the clicked-with-a-link slice of the same table, so its type is fixed. An empty
 * `eventType` on a `marketingEvents` rule means "any real engagement", and `delivered` is excluded from
 * that default: delivery is what the provider did, not what the recipient did, and counting it as
 * engagement would score every addressable Lead the same. A rule that names it explicitly still gets it —
 * a bounce or an unsubscribe as a *negative* signal is a legitimate, transparent model choice (plan §3.2).
 */
export function eventTypesFor(source: Exclude<SignalSource, 'lead'>, eventType: string | undefined): readonly string[] {
  if (source === 'emailLinks') return ['clicked'];
  const trimmed = (eventType ?? '').trim();
  if (trimmed === '') return MARKETING_EVENT_TYPES.filter((entry) => entry !== 'delivered');
  return (MARKETING_EVENT_TYPES as readonly string[]).includes(trimmed) ? [trimmed] : [];
}

/** The plan key is derived, never stored: two rules that ask one question read the table once. */
export function planKeyOf(source: Exclude<SignalSource, 'lead'>, eventTypes: readonly string[], lookbackDays: number): string {
  return `${source}|${[...eventTypes].sort().join(',')}|${String(lookbackDays)}`;
}

/** The plans a model puts on the table, in a stable order so two runs read the same thing. */
export function signalPlans(rules: readonly SignalRuleShape[], limit: number = MAX_SIGNAL_PLANS_PER_MODEL): SignalPlan[] {
  const plans = new Map<string, SignalPlan>();
  for (const rule of rules) {
    if (!rule.enabled || !isEngagementSource(rule.signalSource)) continue;
    const eventTypes = eventTypesFor(rule.signalSource, rule.eventType);
    if (eventTypes.length === 0) continue;
    const lookbackDays = signalLookbackDays(rule.lookbackDays);
    const key = planKeyOf(rule.signalSource, eventTypes, lookbackDays);
    if (!plans.has(key)) plans.set(key, { key, source: rule.signalSource, eventTypes: [...eventTypes].sort(), lookbackDays });
  }
  // The ceiling is a validator refusal (`LS_MODEL_SIGNAL_PLANS_LIMIT`), so a model that reached this code is
  // already inside it. The slice stays as defence in depth for a draft written straight through the record
  // API: a plan is a bounded read, but a model with a thousand of them is a thousand bounded reads.
  return [...plans.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, limit);
}

/** Why an engagement reading is not there. Each one has a different fix, so they are not one boolean. */
export type SignalSourceState =
  /** Reading happens: the table exists and the feature is on. */
  | 'available'
  /** `features.engagementSignals` is off. Scoring continues; the rules skip with this reason. */
  | 'disabled'
  /** Marketing Automation is not installed in this build (no `marketing_events` table). */
  | 'absent'
  /** The table answered, and this Lead has no matching recipient rows — a real answer, not a failure. */
  | 'no_events';

/** The metrics each plan answers with, so a screen or a response can name what a rule read. */
export function metricsByPlan(plans: readonly SignalPlan[]): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const plan of plans) out[plan.key] = SIGNAL_METRICS[plan.source].map((metric) => metric.name);
  return out;
}

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
