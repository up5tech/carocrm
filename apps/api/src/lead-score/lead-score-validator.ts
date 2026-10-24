import type { ConditionFieldPolicy, ConditionIssue, ScoreableField } from './lead-score-condition.js';
import { parseScoreCondition, PROTECTED_FIELD_NAMES, SCORING_OUTPUT_FIELD_NAMES, validateScoreCondition } from './lead-score-condition.js';
import {
  DEFAULT_SCORE_SCALE,
  eventTypesFor,
  isEngagementSource,
  isScoreBand,
  MARKETING_EVENT_TYPES,
  MAX_SIGNAL_LOOKBACK_DAYS,
  MAX_SIGNAL_PLANS_PER_MODEL,
  MIN_SIGNAL_LOOKBACK_DAYS,
  MISSING_DATA_POLICIES,
  MODEL_STATUSES,
  type ModelStatus,
  RULE_DIMENSIONS,
  RULE_EFFECTS,
  type RuleDimension,
  type RuleEffect,
  SCORE_BANDS,
  SIGNAL_METRICS,
  SIGNAL_SOURCES,
  signalPlans,
  type SignalSource,
} from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.3 — the model and rule validator
 * (`PLAN_Phase_19_LeadScore.md` §5.1, §5.2, §6.1–§6.5, §9.3; audit §5).
 *
 * This is where "invalid models cannot be published" (plan §16 `19-LS.3`) actually means something. It
 * is pure: no database, no clock, no I/O. Given the model's stored attributes and the rules that belong
 * to it, it answers with issues and warnings, and the publish path decides to refuse.
 *
 * Three things it protects, in order of how much they cost to get wrong:
 *
 * 1. **the score's meaning stays re-derivable.** Every rule must name a field the metadata declares and
 *    an operator that type can answer; the scale, floor and ceiling must be consistent; the bands must
 *    not overlap. A model that violates one of these could produce a number that cannot be recomputed
 *    from its own version (plan §1.2, §6.3).
 * 2. **nobody can smuggle code or secrets into a rule.** The condition is a declarative tree only; a
 *    formula string, a path with dots, a table name, a `password` field or an artifact field is refused
 *    by name, not by a sandbox that hopes to contain it (plan §5.2, §6.2).
 * 3. **a protected characteristic cannot become a factor.** `PROTECTED_FIELD_NAMES` and the model's own
 *    `blockedFieldPaths` are refused at configuration time, before any Lead is evaluated, and the score's
 *    own outputs are refused as inputs so a score cannot feed itself (plan §0.1-6, §10.4).
 */

/**
 * The condition policy of one engagement source: its metrics, and nothing else.
 *
 * A metric carries a platform field type, so it answers exactly the operators that type answers on a Lead
 * field — one vocabulary for both, which is what keeps the editor's offer and the validator's verdict from
 * disagreeing about what `eventCount` may be asked. The model's field grant does not apply here: the grant
 * bounds what a rule may read *of the Lead*, and the source plus its window bounds an engagement read.
 */
function metricPolicyFor(source: Exclude<SignalSource, 'lead'>): ConditionFieldPolicy {
  const metrics = SIGNAL_METRICS[source];
  const fields = new Map<string, ScoreableField>(metrics.map((metric) => [metric.name, { name: metric.name, type: metric.type }]));
  return { fields, allowedPaths: metrics.map((metric) => metric.name), blockedPaths: [] };
}

/** A single rule may not swing more than this many points (plan §6.3 "keep negative rules bounded"). */
export const MAX_RULE_POINTS = 50;
/** Model and rule name lengths, matching what the metadata columns hold. */
export const MAX_NAME_CHARS = 128;
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export type ValidationLevel = 'error' | 'warning';

export interface ValidationIssue {
  readonly code: string;
  readonly level: ValidationLevel;
  readonly path: string;
  readonly message: string;
  readonly ruleId?: string | undefined;
}

export interface ModelAttributes {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly modelVersion: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly baseScore: number;
  readonly scoreFloor: number;
  readonly scoreCeiling: number;
  readonly qualificationBands?: string | undefined;
  readonly dimensionWeights?: string | undefined;
  readonly allowedFieldPaths?: string | undefined;
  readonly blockedFieldPaths?: string | undefined;
  readonly settingsJson?: string | undefined;
}

export interface RuleAttributes {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly modelId: string;
  readonly modelVersion: number;
  readonly reasonCode: string;
  readonly dimension: string;
  readonly enabled: boolean;
  readonly condition: string;
  readonly effect: string;
  readonly points: number;
  readonly priority: number;
  readonly missingDataPolicy: string;
  readonly signalSource: string;
  readonly targetBand?: string | undefined;
  readonly eventType?: string | undefined;
  readonly lookbackDays?: number | undefined;
  readonly decayPolicy?: string | undefined;
  readonly decayHalfLifeDays?: number | undefined;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

/** Every issue code this validator can raise, so a UI and the tests can switch on them. */
export const VALIDATION_CODES = {
  modelStatusUnknown: 'LS_MODEL_STATUS_UNKNOWN',
  modelVersionInvalid: 'LS_MODEL_VERSION_INVALID',
  modelScale: 'LS_MODEL_SCALE_INVALID',
  modelBounds: 'LS_MODEL_BOUNDS_INVALID',
  modelBaseScore: 'LS_MODEL_BASE_SCORE_OUT_OF_RANGE',
  modelBandsJson: 'LS_MODEL_BANDS_INVALID_JSON',
  modelBandsShape: 'LS_MODEL_BANDS_INVALID_SHAPE',
  modelBandsEmpty: 'LS_MODEL_BANDS_EMPTY',
  modelBandUnknown: 'LS_MODEL_BAND_UNKNOWN',
  modelBandReserved: 'LS_MODEL_BAND_RESERVED',
  modelBandOverlap: 'LS_MODEL_BANDS_OVERLAP',
  modelBandRange: 'LS_MODEL_BAND_OUT_OF_SCALE',
  modelBandGap: 'LS_MODEL_BAND_GAP',
  modelWeightsJson: 'LS_MODEL_WEIGHTS_INVALID_JSON',
  modelWeightsShape: 'LS_MODEL_WEIGHTS_INVALID_SHAPE',
  modelWeightsUnweightedDimension: 'LS_DIMENSION_WEIGHTED_WITHOUT_RULES',
  modelWeightsZeroForRuleDimension: 'LS_DIMENSION_HAS_RULES_BUT_NO_WEIGHT',
  modelPathsJson: 'LS_MODEL_FIELD_PATHS_INVALID_JSON',
  modelPathUnknown: 'LS_MODEL_FIELD_PATH_UNKNOWN',
  modelPathBothLists: 'LS_MODEL_FIELD_PATH_CONTRADICTORY',
  modelSettingsJson: 'LS_MODEL_SETTING_UNSUPPORTED',
  ruleName: 'LS_RULE_NAME_MISSING',
  ruleReasonCode: 'LS_RULE_REASON_CODE_INVALID',
  ruleReasonCodeDuplicate: 'LS_RULE_REASON_CODE_DUPLICATE',
  ruleDimension: 'LS_RULE_DIMENSION_UNKNOWN',
  ruleEffect: 'LS_RULE_EFFECT_UNKNOWN',
  rulePointsBound: 'LS_RULE_POINTS_OUT_OF_BOUNDS',
  rulePointsIgnored: 'LS_RULE_POINTS_IGNORED_BY_EFFECT',
  rulePointsNoEffect: 'LS_RULE_HAS_NO_EFFECT',
  rulePointsSign: 'LS_RULE_SIGN_DOES_NOT_MATCH_DIMENSION',
  rulePriority: 'LS_RULE_PRIORITY_OUT_OF_BOUNDS',
  ruleMissingDataPolicy: 'LS_RULE_MISSING_DATA_POLICY_UNKNOWN',
  ruleSignalSource: 'LS_RULE_SIGNAL_SOURCE_UNKNOWN',
  ruleSignalWindow: 'LS_RULE_SIGNAL_WINDOW_INVALID',
  ruleSignalEventType: 'LS_RULE_EVENT_TYPE_UNKNOWN',
  ruleDecayPolicy: 'LS_RULE_DECAY_POLICY_UNKNOWN',
  ruleDecayHalfLife: 'LS_RULE_DECAY_HALF_LIFE_INVALID',
  ruleTargetBand: 'LS_RULE_TARGET_BAND_REQUIRED',
  ruleTargetBandUnknown: 'LS_RULE_TARGET_BAND_UNKNOWN',
  ruleModelMismatch: 'LS_RULE_MODEL_VERSION_MISMATCH',
  ruleDisabled: 'LS_RULE_DISABLED',
  modelNoEnabledRules: 'LS_MODEL_HAS_NO_ENABLED_RULES',
  modelSignalPlansLimit: 'LS_MODEL_SIGNAL_PLANS_LIMIT',
} as const;

export interface ValidatorFieldSource {
  /** The fields of the entity being scored, already read from metadata. */
  readonly fields: ReadonlyMap<string, ScoreableField>;
}

export function validateModel(
  model: ModelAttributes,
  rules: readonly RuleAttributes[],
  source: ValidatorFieldSource,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const at = (code: string, path: string, message: string, level: ValidationLevel = 'error'): void => {
    issues.push({ code, level, path, message });
  };

  if (!MODEL_STATUSES.includes(model.status as ModelStatus)) {
    at(VALIDATION_CODES.modelStatusUnknown, 'status', `"${model.status}" is not a model state. Expected ${MODEL_STATUSES.join(', ')}.`);
  }
  if (!Number.isInteger(model.modelVersion) || model.modelVersion < 1) {
    at(VALIDATION_CODES.modelVersionInvalid, 'modelVersion', 'A model version is a positive integer, and it is the number every stored evaluation names.');
  }

  const scaleIssues = validateScale(model);
  issues.push(...scaleIssues);
  const bands = validateBands(model);
  issues.push(...bands);
  const weights = validateWeights(model);
  issues.push(...weights.issues);
  const allowedPaths = validatePathList(model, 'allowedFieldPaths');
  const blockedPaths = validatePathList(model, 'blockedFieldPaths');
  issues.push(...allowedPaths.issues, ...blockedPaths.issues);
  issues.push(...validateSettingsJson(model));

  const fieldNames = [...source.fields.keys()];
  for (const name of allowedPaths.values) {
    if (!fieldNames.includes(name)) {
      at(VALIDATION_CODES.modelPathUnknown, 'allowedFieldPaths', `"${name}" is not a field of the entity this model scores, so it grants access to nothing.`);
    }
  }
  for (const name of blockedPaths.values) {
    if (!fieldNames.includes(name)) {
      at(VALIDATION_CODES.modelPathUnknown, 'blockedFieldPaths', `"${name}" is not a field of the entity this model scores.`);
    }
  }
  const contradiction = allowedPaths.values.filter((name) => blockedPaths.values.includes(name));
  if (contradiction.length > 0) {
    at(VALIDATION_CODES.modelPathBothLists, 'allowedFieldPaths', `"${contradiction.join(', ')}" is both granted and blocked. Resolve it: a blocked path is never scored.`);
  }

  // The policy a condition is checked against: the model's own grant, the installation's block list, and
  // the two built-in denylists that are never negotiable (plan §0.1-6, §10.4).
  const policy: ConditionFieldPolicy = {
    fields: source.fields,
    ...(allowedPaths.values.length > 0 ? { allowedPaths: allowedPaths.values } : {}),
    blockedPaths: [...blockedPaths.values, ...PROTECTED_FIELD_NAMES, ...SCORING_OUTPUT_FIELD_NAMES],
  };

  const seenReasonCodes = new Map<string, string>();
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  const dimensionsWithRules = new Set<string>();

  for (const rule of rules) {
    const ruleAt = (code: string, path: string, message: string, level: ValidationLevel = 'error'): void => {
      issues.push({ code, level, path, message, ruleId: rule.id });
    };
    if (rule.name.trim() === '') ruleAt(VALIDATION_CODES.ruleName, 'name', 'A rule needs a name an administrator can read.');
    if (!REASON_CODE_PATTERN.test(rule.reasonCode)) {
      ruleAt(VALIDATION_CODES.ruleReasonCode, 'reasonCode', 'A reason code is a stable lower_snake identifier (for example `industry_target`); it is what the UI localizes and the history stores.');
    }
    const previous = seenReasonCodes.get(rule.reasonCode);
    if (previous !== undefined) {
      ruleAt(VALIDATION_CODES.ruleReasonCodeDuplicate, 'reasonCode', `"${rule.reasonCode}" is already used by rule ${previous}. Two rules with one reason code make a stored breakdown ambiguous about what produced the score.`);
    } else {
      seenReasonCodes.set(rule.reasonCode, rule.id);
    }
    if (!RULE_DIMENSIONS.includes(rule.dimension as RuleDimension)) {
      ruleAt(VALIDATION_CODES.ruleDimension, 'dimension', `"${rule.dimension}" is not a scoring dimension. Expected ${RULE_DIMENSIONS.join(', ')}.`);
    } else if (rule.enabled) {
      dimensionsWithRules.add(rule.dimension);
    }
    if (!RULE_EFFECTS.includes(rule.effect as RuleEffect)) {
      ruleAt(VALIDATION_CODES.ruleEffect, 'effect', `"${rule.effect}" is not a supported effect. Expected ${RULE_EFFECTS.join(', ')}.`);
    }
    if (!Number.isInteger(rule.points) || Math.abs(rule.points) > MAX_RULE_POINTS) {
      ruleAt(VALIDATION_CODES.rulePointsBound, 'points', `A rule contributes a whole number of points between -${MAX_RULE_POINTS} and ${MAX_RULE_POINTS}. One rule must not decide the whole scale (plan §6.3).`);
    }
    if (rule.effect === 'setBand') {
      if (rule.points !== 0) {
        ruleAt(VALIDATION_CODES.rulePointsIgnored, 'points', 'A `setBand` rule assigns a band; its points are ignored, so set them to 0 or use add/subtract.');
      }
      if (rule.targetBand === undefined || rule.targetBand === '') {
        ruleAt(VALIDATION_CODES.ruleTargetBand, 'targetBand', 'A `setBand` rule must name the band it assigns.');
      } else if (!isScoreBand(rule.targetBand)) {
        ruleAt(VALIDATION_CODES.ruleTargetBandUnknown, 'targetBand', `"${rule.targetBand}" is not a band this module defines.`);
      } else if (rule.targetBand === 'Unknown') {
        ruleAt(VALIDATION_CODES.ruleTargetBandUnknown, 'targetBand', '`Unknown` is reserved for a Lead that has never been scored; a rule cannot assign it.');
      }
    } else {
      if (rule.targetBand !== undefined && rule.targetBand !== '') {
        ruleAt(VALIDATION_CODES.ruleTargetBand, 'targetBand', `Only a \`setBand\` rule may name a target band; "${rule.effect}" changes points instead.`);
      }
      if (rule.points === 0) {
        ruleAt(VALIDATION_CODES.rulePointsNoEffect, 'points', `"${rule.effect}" with 0 points changes no score. Use \`setBand\` to assign a band, or give it points.`);
      }
    }
    if (rule.dimension === 'negative' && rule.points > 0) {
      ruleAt(VALIDATION_CODES.rulePointsSign, 'points', 'A rule on the `negative` dimension subtracts points; a positive value here reads as a mis-entered sign.');
    }
    if ((rule.dimension === 'fit' || rule.dimension === 'intent' || rule.dimension === 'engagement') && rule.points < 0) {
      ruleAt(VALIDATION_CODES.rulePointsSign, 'points', `A rule on the \`${rule.dimension}\` dimension adds points; a negative value belongs on the \`negative\` dimension so the reason reads correctly.`);
    }
    if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 1000) {
      ruleAt(VALIDATION_CODES.rulePriority, 'priority', 'Priority is a whole number between 0 and 1000 and decides the order rules are applied in.');
    }
    if (!MISSING_DATA_POLICIES.includes(rule.missingDataPolicy as (typeof MISSING_DATA_POLICIES)[number])) {
      ruleAt(VALIDATION_CODES.ruleMissingDataPolicy, 'missingDataPolicy', `"${rule.missingDataPolicy}" is not a missing-data policy. Expected ${MISSING_DATA_POLICIES.join(', ')}.`);
    }
    if (!SIGNAL_SOURCES.includes(rule.signalSource as (typeof SIGNAL_SOURCES)[number])) {
      ruleAt(VALIDATION_CODES.ruleSignalSource, 'signalSource', `"${rule.signalSource}" is not a signal source this module knows.`);
    } else if (isEngagementSource(rule.signalSource)) {
      // 19-LS.9 delivers the read, so the source is publishable — and the *window* is what makes it safe.
      // An engagement rule without a bounded lookback is an unbounded scan of another module's event log
      // (plan §6.3, §9.4), so the window is mandatory here rather than defaulted silently.
      const window = rule.lookbackDays;
      if (!Number.isInteger(window ?? 0) || (window ?? 0) < MIN_SIGNAL_LOOKBACK_DAYS || (window ?? 0) > MAX_SIGNAL_LOOKBACK_DAYS) {
        ruleAt(
          VALIDATION_CODES.ruleSignalWindow,
          'lookbackDays',
          `An engagement rule needs a whole-day lookback window between ${MIN_SIGNAL_LOOKBACK_DAYS} and ${MAX_SIGNAL_LOOKBACK_DAYS}; the read is bounded by it, and "all history" is not a window.`,
        );
      }
      const named = (rule.eventType ?? '').trim();
      if (rule.signalSource === 'emailLinks' && named !== '' && named !== 'clicked') {
        ruleAt(VALIDATION_CODES.ruleSignalEventType, 'eventType', '`emailLinks` counts link clicks, so its event type is `clicked` or nothing at all.');
      } else if (named !== '' && !(MARKETING_EVENT_TYPES as readonly string[]).includes(named)) {
        ruleAt(VALIDATION_CODES.ruleSignalEventType, 'eventType', `"${named}" is not an engagement type this build reads. Expected one of ${MARKETING_EVENT_TYPES.join(', ')}.`);
      }
      if (eventTypesFor(rule.signalSource, rule.eventType).length === 0) {
        ruleAt(VALIDATION_CODES.ruleSignalEventType, 'eventType', 'This rule names an event type that matches nothing, so it could never contribute.');
      }
    } else if (rule.signalSource === 'lead') {
      if (rule.lookbackDays !== undefined && rule.lookbackDays !== null) {
        ruleAt(VALIDATION_CODES.ruleSignalWindow, 'lookbackDays', 'A lookback window describes an event stream; a `lead` signal reads the record as it stands.');
      }
      if (rule.eventType !== undefined && rule.eventType !== '') {
        ruleAt(VALIDATION_CODES.ruleSignalWindow, 'eventType', 'An event type belongs to a signal source that reads events, not to `lead`.');
      }
      if (rule.decayPolicy !== undefined && rule.decayPolicy !== 'none') {
        ruleAt(VALIDATION_CODES.ruleDecayHalfLife, 'decayPolicy', 'Decay ages a signal over time; a `lead` field is read as stored, so decay does not apply.');
      }
    }
    if (rule.decayPolicy !== undefined && rule.decayPolicy !== null && rule.decayPolicy !== 'none' && rule.decayPolicy !== 'linear' && rule.decayPolicy !== 'halfLife') {
      ruleAt(VALIDATION_CODES.ruleDecayPolicy, 'decayPolicy', `"${rule.decayPolicy}" is not a decay policy.`);
    }
    if (rule.decayPolicy === 'halfLife' && (!Number.isInteger(rule.decayHalfLifeDays ?? 0) || (rule.decayHalfLifeDays ?? 0) < 1)) {
      ruleAt(VALIDATION_CODES.ruleDecayHalfLife, 'decayHalfLifeDays', 'A half-life decay needs a half-life in days.');
    }
    if (rule.modelId !== model.id) {
      ruleAt(VALIDATION_CODES.ruleModelMismatch, 'modelId', 'This rule belongs to a different model row than the one being validated.');
    }
    if (rule.modelVersion !== model.modelVersion) {
      ruleAt(VALIDATION_CODES.ruleModelMismatch, 'modelVersion', `A rule attached to model ${model.id} carries version ${rule.modelVersion} while the model is version ${model.modelVersion}. The pair identifies the stored evaluation's provenance.`);
    }

    const parsed = parseScoreCondition(rule.condition);
    for (const entry of parsed.issues) issues.push(toValidationIssue(entry, rule.id));
    if (parsed.node !== undefined) {
      // An engagement rule compares a **metric of its source**, never a Lead field, so it is checked against
      // that metric set with the same operator matrix. The model's field grant does not apply to a metric —
      // the grant is about the Lead's own attributes, and the source is what bounds an engagement read.
      const conditionPolicy = isEngagementSource(rule.signalSource) ? metricPolicyFor(rule.signalSource) : policy;
      for (const entry of validateScoreCondition(parsed.node, conditionPolicy)) issues.push(toValidationIssue(entry, rule.id));
    }
  }

  for (const weight of weights.dimensions) {
    // Warnings, not errors: a weight with no rule and a rule with no weight are both modelling smells.
    // The evaluator in 19-LS.4 defines how weights normalise (plan §6.3), so refusing a publish here would
    // block a configuration that a later phase may give a meaning to.
    if (weight.weight > 0 && !dimensionsWithRules.has(weight.dimension)) {
      at(VALIDATION_CODES.modelWeightsUnweightedDimension, 'dimensionWeights', `Dimension "${weight.dimension}" is weighted but has no enabled rule, so the weight moves nothing.`, 'warning');
    }
    if (weight.weight === 0 && dimensionsWithRules.has(weight.dimension)) {
      at(VALIDATION_CODES.modelWeightsZeroForRuleDimension, 'dimensionWeights', `Dimension "${weight.dimension}" has rules but a weight of 0, so they can never contribute.`, 'warning');
    }
  }

  if (enabledRuleCount === 0) {
    at(VALIDATION_CODES.modelNoEnabledRules, 'rules', 'This model has no enabled rule, so every Lead would score the base value. Add a rule or enable one.', 'warning');
  }
  // Each distinct engagement question is one bounded read of another module's event log per score. Past the
  // ceiling the answer is a refusal, not a silent drop of the extra rules — the same rule LS.6 set for the
  // batch ceilings, so a model never scores under a subset of what its author wrote.
  if (signalPlans(rules, MAX_SIGNAL_PLANS_PER_MODEL + 1).length > MAX_SIGNAL_PLANS_PER_MODEL) {
    at(VALIDATION_CODES.modelSignalPlansLimit, 'rules', `A model may ask at most ${String(MAX_SIGNAL_PLANS_PER_MODEL)} distinct engagement questions per score; give the rules the same window and event types to share one read.`);
  }
  if (rules.some((rule) => !rule.enabled)) {
    at(VALIDATION_CODES.ruleDisabled, 'rules', `${rules.filter((rule) => !rule.enabled).length} rule(s) are disabled and will not be evaluated.`, 'warning');
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  return { valid: errors.length === 0, errors, warnings };
}

function validateScale(model: ModelAttributes): readonly ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (code: string, path: string, message: string): void => {
    out.push({ code, level: 'error', path, message });
  };
  const { scaleMin, scaleMax, scoreFloor, scoreCeiling, baseScore } = model;
  if (!Number.isInteger(scaleMin) || !Number.isInteger(scaleMax) || scaleMin >= scaleMax) {
    push(VALIDATION_CODES.modelScale, 'scaleMax', `A score scale needs whole bounds with a minimum below the maximum (got ${scaleMin}–${scaleMax}).`);
    return out;
  }
  if (scaleMax - scaleMin > 1000) {
    push(VALIDATION_CODES.modelScale, 'scaleMax', `A score scale spans at most 1000 points so it stays readable on a badge (plan §3.1 recommends ${DEFAULT_SCORE_SCALE.min}–${DEFAULT_SCORE_SCALE.max}).`);
  }
  if (!Number.isInteger(scoreFloor) || !Number.isInteger(scoreCeiling) || scoreFloor > scoreCeiling) {
    push(VALIDATION_CODES.modelBounds, 'scoreCeiling', `The score floor must not exceed the ceiling (got ${scoreFloor}–${scoreCeiling}); they are what a computed score is clamped to.`);
  } else if (scoreFloor < scaleMin || scoreCeiling > scaleMax) {
    push(VALIDATION_CODES.modelBounds, 'scoreFloor', `The clamp band ${scoreFloor}–${scoreCeiling} must sit inside the scale ${scaleMin}–${scaleMax}, or a score would be shown outside the scale the UI names.`);
  } else if (scoreFloor === scoreCeiling) {
    push(VALIDATION_CODES.modelBounds, 'scoreFloor', `The floor and ceiling are both ${scoreFloor}, so every Lead would score the same number.`);
  }
  if (!Number.isInteger(baseScore) || baseScore < scoreFloor || baseScore > scoreCeiling) {
    push(VALIDATION_CODES.modelBaseScore, 'baseScore', `The starting score must be a whole number inside the clamp band ${scoreFloor}–${scoreCeiling}.`);
  }
  return out;
}

interface BandEntry {
  readonly band: string;
  readonly min: number;
  readonly max: number;
}

function validateBands(model: ModelAttributes): readonly ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (code: string, message: string, level: ValidationLevel = 'error'): void => {
    out.push({ code, level, path: 'qualificationBands', message });
  };
  if (model.qualificationBands === undefined || model.qualificationBands === '') {
    push(VALIDATION_CODES.modelBandsEmpty, 'A model must define its qualification bands: a score without a band cannot be sorted into Hot Leads or Sales Ready (plan §3.3).');
    return out;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(model.qualificationBands);
  } catch {
    push(VALIDATION_CODES.modelBandsJson, 'The qualification bands are not valid JSON. Expected [{"band":"Cold","min":0,"max":39}, …].');
    return out;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    push(VALIDATION_CODES.modelBandsEmpty, 'The band list is empty.');
    return out;
  }
  const bands: BandEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      push(VALIDATION_CODES.modelBandsShape, `Band ${index} is not an object with band, min and max.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const band = record.band;
    const min = record.min;
    const max = record.max;
    if (typeof band !== 'string' || typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(min) || !Number.isInteger(max)) {
      push(VALIDATION_CODES.modelBandsShape, `Band ${index} needs a band name and whole-number min and max.`);
      continue;
    }
    if (!isScoreBand(band)) {
      push(VALIDATION_CODES.modelBandUnknown, `"${band}" is not a band this module defines (${SCORE_BANDS.join(', ')}).`);
      continue;
    }
    if (band === 'Unknown') {
      push(VALIDATION_CODES.modelBandReserved, '`Unknown` is the band of a Lead that has never been scored; a threshold cannot claim it.');
      continue;
    }
    if (band === 'Disqualified') {
      // Plan §3.3: disqualification is a lifecycle signal, not the bottom of a scale. A threshold band
      // called Disqualified would make "low score" mean "no longer a prospect", which is exactly the
      // reading the plan forbids.
      push(VALIDATION_CODES.modelBandReserved, 'A low score is not a disqualification. `Disqualified` comes from a `setBand` rule or the Lead’s own `Dead` status (plan §3.3), never from a numeric threshold.');
      continue;
    }
    if (min > max) {
      push(VALIDATION_CODES.modelBandsShape, `Band "${band}" has min ${min} above max ${max}.`);
      continue;
    }
    if (min < model.scaleMin || max > model.scaleMax) {
      push(VALIDATION_CODES.modelBandRange, `Band "${band}" (${min}–${max}) reaches outside the score scale ${model.scaleMin}–${model.scaleMax}.`);
      continue;
    }
    bands.push({ band, min, max });
  }

  const sorted = [...bands].sort((left, right) => left.min - right.min);
  for (const [index, entry] of sorted.entries()) {
    const next = sorted[index + 1];
    if (next !== undefined && entry.max >= next.min) {
      push(VALIDATION_CODES.modelBandOverlap, `Bands "${entry.band}" (${entry.min}–${entry.max}) and "${next.band}" (${next.min}–${next.max}) overlap, so one score would answer with two bands.`);
    }
    if (next !== undefined && next.min > entry.max + 1) {
      out.push({
        code: VALIDATION_CODES.modelBandGap,
        level: 'warning',
        path: 'qualificationBands',
        message: `Nothing maps to a band between ${entry.max + 1} and ${next.min - 1}; a score in that gap is stored with no band change.`,
      });
    }
  }
  return out;
}

interface WeightEntry {
  readonly dimension: string;
  readonly weight: number;
}

function validateWeights(model: ModelAttributes): { readonly issues: readonly ValidationIssue[]; readonly dimensions: readonly WeightEntry[] } {
  const issues: ValidationIssue[] = [];
  const dimensions: WeightEntry[] = [];
  if (model.dimensionWeights === undefined || model.dimensionWeights === '') return { issues, dimensions };
  let raw: unknown;
  try {
    raw = JSON.parse(model.dimensionWeights);
  } catch {
    issues.push({ code: VALIDATION_CODES.modelWeightsJson, level: 'error', path: 'dimensionWeights', message: 'The dimension weights are not valid JSON. Expected {"fit":40,"intent":25,…}.' });
    return { issues, dimensions };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ code: VALIDATION_CODES.modelWeightsJson, level: 'error', path: 'dimensionWeights', message: 'The dimension weights must be an object of dimension to weight.' });
    return { issues, dimensions };
  }
  for (const [dimension, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!RULE_DIMENSIONS.includes(dimension as RuleDimension)) {
      issues.push({ code: VALIDATION_CODES.modelWeightsShape, level: 'error', path: `dimensionWeights.${dimension}`, message: `"${dimension}" is not a scoring dimension (${RULE_DIMENSIONS.join(', ')}).` });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
      issues.push({ code: VALIDATION_CODES.modelWeightsShape, level: 'error', path: `dimensionWeights.${dimension}`, message: 'A dimension weight is a number from 0 to 1000.' });
      continue;
    }
    dimensions.push({ dimension, weight: value });
  }
  return { issues, dimensions };
}

function validatePathList(model: ModelAttributes, key: 'allowedFieldPaths' | 'blockedFieldPaths'): { readonly issues: readonly ValidationIssue[]; readonly values: readonly string[] } {
  const raw = model[key];
  if (raw === undefined || raw === '') return { issues: [], values: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { issues: [{ code: VALIDATION_CODES.modelPathsJson, level: 'error', path: key, message: `The ${key} list is not valid JSON. Expected ["industry","company"].` }], values: [] };
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    return { issues: [{ code: VALIDATION_CODES.modelPathsJson, level: 'error', path: key, message: `The ${key} list must be an array of field names.` }], values: [] };
  }
  return { issues: [], values: parsed as string[] };
}

/**
 * `settingsJson` exists in the schema (plan §5.1) for validated, versioned configuration, and this phase
 * has no such key to accept. Keeping it open would let an administrator type a policy name and believe it
 * did something, so anything other than an empty object is refused until the phase that reads a key
 * admits it — the same rule the module's own settings document follows.
 */
function validateSettingsJson(model: ModelAttributes): readonly ValidationIssue[] {
  const raw = model.settingsJson;
  if (raw === undefined || raw === '' || raw === '{}' || raw === 'null') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ code: VALIDATION_CODES.modelSettingsJson, level: 'error', path: 'settingsJson', message: 'The model settings are not valid JSON.' }];
  }
  if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0) return [];
  return [
    {
      code: VALIDATION_CODES.modelSettingsJson,
      level: 'error',
      path: 'settingsJson',
      message: 'No model setting is read by this build yet. Configuration that nothing consults would look administered while doing nothing, so it is refused here until the phase that reads it admits it.',
    },
  ];
}

function toValidationIssue(entry: ConditionIssue, ruleId: string): ValidationIssue {
  return { code: entry.code, level: 'error', path: entry.path, message: entry.message, ruleId };
}
