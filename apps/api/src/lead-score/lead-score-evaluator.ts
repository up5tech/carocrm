import { createHash } from 'node:crypto';

import type { ConditionNode } from '@carocrm/formula';

import type { ParsedCondition , ScoreableField } from './lead-score-condition.js';
import { parseScoreCondition,PROTECTED_FIELD_NAMES, SCORING_OUTPUT_FIELD_NAMES  } from './lead-score-condition.js';
import type { ModelAttributes, RuleAttributes } from './lead-score-validator.js';
import { isScoreBand, type RuleOutcome, type ScoreBand } from './lead-score-vocabulary.js';
import { RULE_DIMENSIONS } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.4 — the deterministic scoring engine
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §6.2–§6.5, §16 `19-LS.4`; audit §5.2, §11 `LS.4`).
 *
 * Plan §16 asks for one acceptance and it is a strong one: *the same model and the same input snapshot
 * produce the same auditable result*. That rules out more than a bug — it rules out any design where the
 * answer depends on something this module does not own. So this file has no database, no settings row, no
 * request scope and **no clock**: nothing here calls `Date.now()`, because a score that moved while nobody
 * edited anything would be unexplainable and unreproducible. Time appears only as data the caller supplies
 * (`inputsAsOf`, `sourceRevision`) and it never changes a comparison — 19-LS.3 confined every condition to
 * an absolute value, and the rules that would have needed a lookback window (a non-`lead` signal source)
 * are refused here rather than guessed at.
 *
 * What it implements, in the order audit §5.2 fixes:
 *
 * 1. the condition tree, evaluated **three-valued**. `matched`, `not_matched`, and a third answer for a
 *    signal that is simply not there, because plan §1.2 says missing is not negative by default. Absent,
 *    null, empty-text and empty-list are all "no signal"; only `isEmpty`/`isNotEmpty` answer about absence,
 *    since absence is exactly what they measure.
 * 2. the platform's operator vocabulary with the platform's meaning for each operator (case-sensitive text
 *    comparison, `contains` as substring, empty = null/''/[]) so a score rule and a list filter do not
 *    drift into two languages — while the *evaluation* stays this module's own, because 19-LS.3 forbade a
 *    score rule from reaching the formula engine (audit §5.2-1: no executable string in the write path).
 * 3. aggregation: `baseScore` + rule deltas in priority order → dimension weights → clamp to
 *    `[scoreFloor, scoreCeiling]` → stable rounding → band lookup, then a SHA-256 over the canonical
 *    configuration, the inputs actually read and the outcome.
 *
 * Field access is decided here as well as at publish time. Plan §6.2 asks for validation "at save time and
 * again at evaluation time", and a caller can always hand this function a wider object than the model was
 * granted: a leaf naming a field outside the model's grant, a blocked path, a protected characteristic or a
 * scoring output is recorded as an **error outcome and its value is never read**. That is the difference
 * between a rule that was checked once and a rule that cannot reach.
 */

/** A model with more rules than this is a configuration accident, not a paging problem: refuse rather than score a truncated set. */
export const MAX_EVALUATED_RULES = 200;

/** The canonical marker for a signal the caller was not given, as distinct from one that is empty. */
const NOT_SUPPLIED = '__not_supplied__';

/**
 * Every operator the engine gives a scoring meaning to, keyed by the platform's own name.
 *
 * `lead-score-module-health.service.ts` compares this list against `CRITERIA_OPERATORS`: a platform
 * operator with no documented scoring meaning has to show up as a failing health check rather than as a
 * rule that quietly never matched.
 */
export const SCORING_OPERATORS: readonly string[] = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
];

/** Stable codes for everything that kept a rule from contributing. `errorSummary` and the UI switch on these, never on the message. */
export const EVALUATION_CODES = {
  ruleDisabled: 'LS_EVALUATION_RULE_DISABLED',
  signalSourceNotReadable: 'LS_EVALUATION_SIGNAL_SOURCE_NOT_READABLE',
  fieldNotGranted: 'LS_EVALUATION_FIELD_NOT_GRANTED',
  fieldUnknown: 'LS_EVALUATION_FIELD_UNKNOWN',
  conditionUnreadable: 'LS_EVALUATION_CONDITION_UNREADABLE',
  operatorUnsupported: 'LS_EVALUATION_OPERATOR_UNSUPPORTED',
  valueUnreadable: 'LS_EVALUATION_VALUE_UNREADABLE',
  bandsUnreadable: 'LS_EVALUATION_BANDS_UNREADABLE',
  scoreOutsideBands: 'LS_EVALUATION_SCORE_OUTSIDE_BANDS',
  weightsIgnored: 'LS_EVALUATION_WEIGHTS_ZERO_TOTAL',
  ruleLimit: 'LS_EVALUATION_RULE_LIMIT_EXCEEDED',
} as const;

/** A comparison answer: matched, not matched, or no signal to compare against. */
type TriState = 'matched' | 'not_matched' | 'unknown';

export interface ScoreInputSnapshot {
  /** The Lead being scored. Only used for provenance and for the caller's response. */
  readonly recordId: string;
  /** The Lead row's own `version`: which data revision this score describes (plan §5.3 `sourceRevision`). */
  readonly sourceRevision: number;
  /** Stored as provenance. Nothing in the comparison reads it, which is what makes the result re-derivable. */
  readonly inputsAsOf: string | null;
  /**
   * The Lead's field values as the *caller* was allowed to see them. Extra keys are ignored: the engine
   * only ever reads a field a rule names and the model grants.
   */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface EvaluationRequest {
  readonly model: ModelAttributes;
  readonly rules: readonly RuleAttributes[];
  /** The scored entity's declared fields — the type that decides how a value is compared. */
  readonly fields: ReadonlyMap<string, ScoreableField>;
  readonly snapshot: ScoreInputSnapshot;
}

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly reasonCode: string;
  readonly dimension: string;
  readonly effect: string;
  readonly outcome: RuleOutcome;
  /** The points this rule actually carried — 0 for a skipped, unknown, setBand or failed rule. */
  readonly points: number;
  /** The `setBand` band this rule assigned, when it did. */
  readonly assignedBand?: string | undefined;
  /** Why it did not contribute, as a stable code. */
  readonly code?: string | undefined;
  /** Which field the code is about, so an editor can find it. Never a value. */
  readonly field?: string | undefined;
}

export interface ScoreEvaluation {
  readonly recordId: string;
  readonly modelId: string;
  readonly modelVersion: number;
  /** `null` only when nothing could be evaluated — a failed evaluation is recorded, not hidden (plan §5.4). */
  readonly scoreValue: number | null;
  readonly band: ScoreBand;
  /** `rule` when a matched `setBand` decided it, `threshold` when the score range did, `none` when nothing covered it. */
  readonly bandSource: 'rule' | 'threshold' | 'none';
  readonly resultState: 'success' | 'partial' | 'failed';
  /** Share of the attempted rule weight that produced a definite answer, 0–1, four decimals (plan §3.1 `coverage`). */
  readonly coverage: number;
  readonly baseScore: number;
  /** The signed total that was added to the base, after weighting and before clamping. */
  readonly delta: number;
  readonly clamped: boolean;
  readonly ruleEvaluations: readonly RuleEvaluation[];
  readonly positiveReasonCodes: readonly string[];
  readonly negativeReasonCodes: readonly string[];
  readonly unknownReasonCodes: readonly string[];
  readonly skippedReasonCodes: readonly string[];
  /** Every stable code that kept this score from being a plain success. */
  readonly errorCodes: readonly string[];
  /** The fields this model actually read — what a caller must fetch, and what the signature covers. */
  readonly readFields: readonly string[];
  /** SHA-256 over the canonical configuration, inputs read and outcome (plan §1.2 reproducible results). */
  readonly signature: string;
  readonly inputsHash: string;
}

export function scoreLead(request: EvaluationRequest): ScoreEvaluation {
  const { model, fields, snapshot } = request;
  const codes: string[] = [];
  const granted = fieldGrant(model);

  const rules = orderRules(request.rules);
  if (rules.length > MAX_EVALUATED_RULES) {
    // A truncated rule set would be a score the model cannot describe, and the version is immutable, so the
    // only honest answer is "this one did not happen".
    return emptyEvaluation(request, [], new Set(), [EVALUATION_CODES.ruleLimit]);
  }

  const readFields = new Set<string>();
  const evaluations: RuleEvaluation[] = [];
  let assignedBand: string | undefined;
  /** Every rule the evaluation attempted, in order: the basis for the delta and for coverage. */
  const scored: RuleEvaluation[] = [];
  const attempted: { outcome: TriState | 'error'; weight: number; counted: boolean }[] = [];

  for (const rule of rules) {
    const base = { ruleId: rule.id, reasonCode: rule.reasonCode, dimension: rule.dimension, effect: rule.effect };

    if (!rule.enabled) {
      evaluations.push({ ...base, outcome: 'skipped', points: 0, code: EVALUATION_CODES.ruleDisabled });
      continue;
    }
    // A published model cannot contain these (19-LS.3 refuses an unimplemented signal source at publish),
    // but the engine is also called on a draft preview and on a row an older build wrote. Reading the Lead
    // attributes as if the signal were there would invent a meaning for a stored score.
    if (rule.signalSource !== 'lead') {
      evaluations.push({ ...base, outcome: 'skipped', points: 0, code: EVALUATION_CODES.signalSourceNotReadable });
      continue;
    }

    const weight = ruleWeight(rule);
    const parsed = parseScoreCondition(rule.condition);
    if (parsed.node === undefined) {
      codes.push(EVALUATION_CODES.conditionUnreadable);
      const entry: RuleEvaluation = { ...base, outcome: 'error', points: 0, code: EVALUATION_CODES.conditionUnreadable };
      evaluations.push(entry);
      scored.push(entry);
      attempted.push({ outcome: 'error', weight, counted: true });
      continue;
    }

    const leafFailure = firstBlockedLeaf(parsed.node, fields, granted);
    if (leafFailure !== undefined) {
      codes.push(leafFailure.code);
      const entry: RuleEvaluation = { ...base, outcome: 'error', points: 0, code: leafFailure.code, field: leafFailure.field };
      evaluations.push(entry);
      scored.push(entry);
      attempted.push({ outcome: 'error', weight, counted: true });
      continue;
    }

    const answer = evaluateNode(parsed.node, fields, snapshot.values, readFields, codes);
    const entry = applyEffect(rule, answer);
    evaluations.push(entry);
    scored.push(entry);
    attempted.push({ outcome: answer, weight, counted: rule.missingDataPolicy !== 'ignore' || answer !== 'unknown' });
    if (answer === 'matched' && rule.effect === 'setBand') assignedBand = rule.targetBand;
  }

  const errored = attempted.filter((entry) => entry.outcome === 'error');
  // Nothing attempted is not a failure: a model whose rules all asked nothing about this Lead scores its
  // declared base with coverage 0, which is the neutral starting point plan §3.1 defines and `ignore`
  // policy asks for. Only a rule set that could not be evaluated at all refuses to produce a number.
  const resultState: ScoreEvaluation['resultState'] =
    attempted.length > 0 && errored.length === attempted.length ? 'failed' : errored.length > 0 ? 'partial' : 'success';

  if (attempted.length > 0 && errored.length === attempted.length) {
    // Every rule failed: report a failed evaluation with its codes rather than a base score dressed up as an
    // answer (plan §5.4 keeps partial and failed history visible).
    return emptyEvaluation(request, evaluations, readFields, codes);
  }

  const rawDelta = weightedDelta(model, scored);
  if (rawDelta.ignoredWeights) codes.push(EVALUATION_CODES.weightsIgnored);

  const bounded = Math.min(Math.max(model.baseScore + rawDelta.delta, model.scoreFloor), model.scoreCeiling);
  const score = roundHalfAwayFromZero(bounded);
  const clamped = bounded !== model.baseScore + rawDelta.delta;

  const bands = readBands(model);
  if (bands.unreadable) codes.push(EVALUATION_CODES.bandsUnreadable);
  let band: ScoreBand = 'Unknown';
  let bandSource: ScoreEvaluation['bandSource'] = 'none';
  if (assignedBand !== undefined && isScoreBand(assignedBand)) {
    band = assignedBand;
    bandSource = 'rule';
  } else {
    const hit = bands.entries.find((entry) => score >= entry.min && score <= entry.max);
    if (hit !== undefined) {
      band = hit.band;
      bandSource = 'threshold';
    } else if (bands.entries.length > 0) {
      codes.push(EVALUATION_CODES.scoreOutsideBands);
    }
  }

  const coverage = coverageOf(attempted);
  const signatureInput = canonicalSignature(model, rules, readFields, snapshot.values, evaluations, score, band, coverage);

  return {
    recordId: snapshot.recordId,
    modelId: model.id,
    modelVersion: model.modelVersion,
    scoreValue: score,
    band,
    bandSource,
    resultState,
    coverage,
    baseScore: model.baseScore,
    delta: rawDelta.delta,
    clamped,
    ruleEvaluations: evaluations,
    positiveReasonCodes: codesFor(evaluations, 'matched', (entry) => entry.points > 0),
    negativeReasonCodes: codesFor(evaluations, 'matched', (entry) => entry.points < 0),
    unknownReasonCodes: codesFor(evaluations, 'unknown'),
    skippedReasonCodes: codesFor(evaluations, 'skipped'),
    errorCodes: dedupe(codes),
    readFields: [...readFields].sort(),
    signature: digest(signatureInput),
    inputsHash: digest(JSON.stringify(canonicalInputs(readFields, snapshot.values))),
  };
}

/**
 * The field names a model can read: granted, declared by the entity, and named by an enabled rule.
 *
 * A recalculation over ten thousand Leads must fetch exactly this projection and nothing else (plan §4.2
 * step 3 "only the input fields that model is allowed to use"), and the same list is what a stored
 * evaluation's signature covers — so a score can be re-derived from named fields alone.
 */
export function requiredInputFields(model: ModelAttributes, rules: readonly RuleAttributes[], fields: ReadonlyMap<string, ScoreableField>): string[] {
  const granted = fieldGrant(model);
  const names = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled || rule.signalSource !== 'lead') continue;
    const parsed = parseScoreCondition(rule.condition);
    if (parsed.node === undefined) continue;
    for (const leaf of leafFields(parsed.node)) {
      if (refusalFor(leaf, fields, granted) !== undefined) continue;
      names.add(leaf);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// condition evaluation (three-valued)
// ---------------------------------------------------------------------------

function evaluateNode(
  node: ConditionNode,
  fields: ReadonlyMap<string, ScoreableField>,
  values: Readonly<Record<string, unknown>>,
  readFields: Set<string>,
  codes: string[],
): TriState {
  if ('all' in node) {
    const answers = node.all.map((child) => evaluateNode(child, fields, values, readFields, codes));
    // Kleene `and`: one definite "no" decides the group, otherwise the missing signals are what stopped it.
    if (answers.includes('not_matched')) return 'not_matched';
    if (answers.includes('unknown')) return 'unknown';
    return 'matched';
  }
  if ('any' in node) {
    const answers = node.any.map((child) => evaluateNode(child, fields, values, readFields, codes));
    if (answers.includes('matched')) return 'matched';
    if (answers.includes('unknown')) return 'unknown';
    return 'not_matched';
  }
  if ('not' in node) {
    const inner = evaluateNode(node.not as ConditionNode, fields, values, readFields, codes);
    // `not unknown` is still unknown: the absence of a signal does not prove its opposite, which is exactly
    // the reading plan §1.2 forbids.
    if (inner === 'unknown') return 'unknown';
    return inner === 'matched' ? 'not_matched' : 'matched';
  }

  const leaf = node as { field: string; operator: string; value?: unknown };
  const field = fields.get(leaf.field);
  readFields.add(leaf.field);
  if (field === undefined) return 'unknown';

  const stored = storedValue(values, leaf.field);
  // A signal the caller was not given answers nothing — including an existence question. Reporting
  // `not_matched` for a field this reader may not see would turn a withheld value into a stated fact about
  // the Lead, and plan §6.5 asks that a breakdown carry only what the reader is allowed to see.
  if (!stored.supplied) return 'unknown';
  // Existence questions answer about absence itself; anything else needs a signal to compare with.
  if (leaf.operator === 'isEmpty') return stored.isEmpty ? 'matched' : 'not_matched';
  if (leaf.operator === 'isNotEmpty') return stored.isEmpty ? 'not_matched' : 'matched';
  if (stored.isEmpty) {
    // The rule's own `missingDataPolicy` decides whether this non-answer is *neutral* (counted toward the
    // model's coverage, so a reader sees the hole) or *ignored* (excluded from it). Either way it is not a
    // negative signal — that is plan §1.2.
    return 'unknown';
  }

  const compared = compareLeaf(leaf, field, stored.value);
  if (compared === 'unreadable') {
    codes.push(EVALUATION_CODES.valueUnreadable);
    return 'unknown';
  }
  if (compared === 'unsupported') {
    // 19-LS.3 validated this operator against this declared type, so reaching it means the metadata changed
    // underneath an immutable version. An unknown with a code is the honest answer; a silent "no" would move
    // a score without telling anybody why.
    codes.push(EVALUATION_CODES.operatorUnsupported);
    return 'unknown';
  }
  return compared ? 'matched' : 'not_matched';
}

/**
 * One leaf comparison, with the platform's meaning for each operator
 * (`packages/formula` gives `contains`/`startsWith`/`endsWith` a case-sensitive substring reading and
 * `isEmpty` null, empty text or empty array — mirrored here so a rule and a list filter agree).
 */
function compareLeaf(leaf: { field: string; operator: string; value?: unknown }, field: ScoreableField, stored: unknown): boolean | 'unreadable' | 'unsupported' {
  const numeric = isNumericType(field.type);
  const temporal = field.type === 'date' || field.type === 'datetime';

  if (leaf.operator === 'in' || leaf.operator === 'notIn') {
    const list = Array.isArray(leaf.value) ? leaf.value : null;
    if (list === null) return 'unreadable';
    const found = list.some((candidate) => sameValue(stored, candidate, numeric, temporal));
    return leaf.operator === 'in' ? found : !found;
  }

  if (leaf.operator === 'isTrue' || leaf.operator === 'isFalse') {
    if (field.type !== 'bool') return 'unsupported';
    const flag = toBoolean(stored);
    if (flag === undefined) return 'unreadable';
    return leaf.operator === 'isTrue' ? flag : !flag;
  }

  if (numeric) {
    const left = toFiniteNumber(stored);
    const right = toFiniteNumber(leaf.value);
    if (left === undefined || right === undefined) return 'unreadable';
    return ordered(leaf.operator, left, right);
  }

  if (temporal) {
    const left = Date.parse(textOf(stored));
    const right = Date.parse(textOf(leaf.value));
    if (Number.isNaN(left) || Number.isNaN(right)) return 'unreadable';
    return ordered(leaf.operator, left, right);
  }

  if (field.type === 'bool') {
    // 19-LS.3's matrix allows `equals`/`notEquals` on a boolean as well as `isTrue`/`isFalse`, so both have to
    // mean one thing here: a rule stored as `equals true` is the same question as `isTrue`.
    const flag = toBoolean(stored);
    const wanted = typeof leaf.value === 'boolean' ? leaf.value : toBoolean(leaf.value);
    if (flag === undefined || wanted === undefined) return 'unreadable';
    switch (leaf.operator) {
      case 'equals':
        return flag === wanted;
      case 'notEquals':
        return flag !== wanted;
      default:
        return 'unsupported';
    }
  }

  const left = textOf(stored);
  const right = textOf(leaf.value);
  switch (leaf.operator) {
    case 'equals':
      return left === right;
    case 'notEquals':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'endsWith':
      return left.endsWith(right);
    default:
      return 'unsupported';
  }
}

function ordered(operator: string, left: number, right: number): boolean | 'unsupported' {
  switch (operator) {
    case 'equals':
      return left === right;
    case 'notEquals':
      return left !== right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    default:
      return 'unsupported';
  }
}

function sameValue(stored: unknown, candidate: unknown, numeric: boolean, temporal: boolean): boolean {
  if (numeric) {
    const left = toFiniteNumber(stored);
    const right = toFiniteNumber(candidate);
    return left !== undefined && right !== undefined && left === right;
  }
  if (temporal) {
    const left = Date.parse(textOf(stored));
    const right = Date.parse(textOf(candidate));
    return !Number.isNaN(left) && !Number.isNaN(right) && left === right;
  }
  return textOf(stored) === textOf(candidate);
}

function isNumericType(type: string): boolean {
  return type === 'int' || type === 'float' || type === 'decimal' || type === 'currency' || type === 'aggregationCount';
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => textOf(item)).filter((item) => item !== '').join(',');
  return '';
}

interface StoredValue {
  /** Whether the caller had the field at all. A signal hidden by field ACL is not a signal that is absent. */
  readonly supplied: boolean;
  readonly isEmpty: boolean;
  readonly value: unknown;
}

/**
 * The three states a stored signal arrives in, kept apart on purpose:
 *
 * - **not supplied** — the caller did not have the field: the reading user's field ACL hid it, or the fetch
 *   did not include it. This answers nothing, not even an existence question, because "you may not see it"
 *   is not evidence that there is nothing there;
 * - **supplied and empty** — null, empty text, an empty list, or whitespace only. An existence rule can
 *   answer this definitely, and a comparison cannot (plan §1.2: missing is not negative);
 * - **supplied with a value** — compared.
 */
function storedValue(values: Readonly<Record<string, unknown>>, field: string): StoredValue {
  if (!Object.prototype.hasOwnProperty.call(values, field)) return { supplied: false, isEmpty: true, value: undefined };
  const raw = values[field];
  if (raw === null || raw === undefined) return { supplied: true, isEmpty: true, value: raw };
  if (typeof raw === 'string' && raw.trim() === '') return { supplied: true, isEmpty: true, value: raw };
  if (Array.isArray(raw) && raw.length === 0) return { supplied: true, isEmpty: true, value: raw };
  return { supplied: true, isEmpty: false, value: raw };
}

// ---------------------------------------------------------------------------
// field grant (re-checked at evaluation time)
// ---------------------------------------------------------------------------

interface FieldGrant {
  readonly allowed: readonly string[];
  readonly blocked: ReadonlySet<string>;
}

function fieldGrant(model: ModelAttributes): FieldGrant {
  return {
    allowed: stringList(model.allowedFieldPaths),
    blocked: new Set([...stringList(model.blockedFieldPaths), ...PROTECTED_FIELD_NAMES, ...SCORING_OUTPUT_FIELD_NAMES]),
  };
}

function stringList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A rule that names an ungranted field is refused whole, not partially evaluated.
 *
 * Half-evaluating a tree whose other leaves were read would leak the shape of a signal the model was not
 * granted, and a `published` version is immutable — so the only useful answer is an error outcome naming
 * the field, which is what makes an editor fix the grant instead of guessing why nothing matched.
 */
function refusalFor(field: string, fields: ReadonlyMap<string, ScoreableField>, granted: FieldGrant): string | undefined {
  if (granted.blocked.has(field)) return EVALUATION_CODES.fieldNotGranted;
  if (granted.allowed.length > 0 && !granted.allowed.includes(field)) return EVALUATION_CODES.fieldNotGranted;
  if (!fields.has(field)) return EVALUATION_CODES.fieldUnknown;
  return undefined;
}

function firstBlockedLeaf(node: ConditionNode, fields: ReadonlyMap<string, ScoreableField>, granted: FieldGrant): { code: string; field: string } | undefined {
  for (const field of leafFields(node)) {
    const code = refusalFor(field, fields, granted);
    if (code !== undefined) return { code, field };
  }
  return undefined;
}

function leafFields(node: ConditionNode): string[] {
  if ('all' in node) return node.all.flatMap(leafFields);
  if ('any' in node) return node.any.flatMap(leafFields);
  if ('not' in node) return leafFields(node.not as ConditionNode);
  const leaf = node as { field?: unknown };
  return typeof leaf.field === 'string' ? [leaf.field] : [];
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

/** Evaluation order is part of the result, so it is fully specified: priority, then reason code, then id. */
function orderRules(rules: readonly RuleAttributes[]): RuleAttributes[] {
  return [...rules].sort((left, right) => left.priority - right.priority || left.reasonCode.localeCompare(right.reasonCode) || left.id.localeCompare(right.id));
}

function applyEffect(rule: RuleAttributes, outcome: TriState): RuleEvaluation {
  const base = { ruleId: rule.id, reasonCode: rule.reasonCode, dimension: rule.dimension, effect: rule.effect };
  if (outcome !== 'matched') return { ...base, outcome, points: 0 };
  if (rule.effect === 'setBand') {
    return { ...base, outcome: 'matched', points: 0, ...(rule.targetBand !== undefined ? { assignedBand: rule.targetBand } : {}) };
  }
  const magnitude = Math.abs(rule.points);
  // The effect decides the sign, not the number an administrator happened to type: a `subtract` rule keeps
  // reading as a subtraction whatever its stored sign, so a score cannot depend on a data-entry habit.
  const points = rule.effect === 'subtract' ? -magnitude : magnitude;
  return { ...base, outcome: 'matched', points };
}

interface WeightedDelta {
  readonly delta: number;
  readonly ignoredWeights: boolean;
}

/**
 * Dimension weights are **relative influence**, applied after the rule deltas and before clamping, and
 * normalized by the total weight of the dimensions that actually produced rules (plan §6.3 asks for the
 * formula to be defined rather than implied).
 *
 * With one dimension configured the delta passes through unchanged; with `fit: 40, intent: 60` the score
 * moves by 40 % of the fit total and 60 % of the intent total *in the same units as the unweighted sum*,
 * so a weight set cannot silently widen the scale. A weight total of 0 would multiply everything away, so
 * the unweighted delta is used and the model is flagged.
 */
function weightedDelta(model: ModelAttributes, attempted: readonly RuleEvaluation[]): WeightedDelta {
  const byDimension = new Map<string, number>();
  for (const entry of attempted) {
    if (!RULE_DIMENSIONS.includes(entry.dimension as (typeof RULE_DIMENSIONS)[number])) continue;
    byDimension.set(entry.dimension, (byDimension.get(entry.dimension) ?? 0) + entry.points);
  }
  // Nothing was attempted, so there is no delta to weight and no zero-total to complain about.
  if (byDimension.size === 0) return { delta: 0, ignoredWeights: false };
  const weights = readWeights(model);
  if (weights === undefined) return { delta: [...byDimension.values()].reduce((left, right) => left + right, 0), ignoredWeights: false };

  let total = 0;
  let weighted = 0;
  for (const [dimension, delta] of byDimension) {
    const weight = weights.get(dimension) ?? 0;
    total += weight;
    weighted += delta * weight;
  }
  if (total === 0) return { delta: [...byDimension.values()].reduce((left, right) => left + right, 0), ignoredWeights: true };
  return { delta: weighted / total, ignoredWeights: false };
}

function readWeights(model: ModelAttributes): Map<string, number> | undefined {
  const raw = model.dimensionWeights;
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const map = new Map<string, number>();
    for (const [dimension, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) map.set(dimension, value);
    }
    return map;
  } catch {
    return undefined;
  }
}

interface BandEntry {
  readonly band: ScoreBand;
  readonly min: number;
  readonly max: number;
}

function readBands(model: ModelAttributes): { entries: BandEntry[]; unreadable: boolean } {
  const raw = model.qualificationBands;
  if (raw === undefined || raw === '') return { entries: [], unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], unreadable: true };
  }
  if (!Array.isArray(parsed)) return { entries: [], unreadable: true };
  const entries: BandEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.band !== 'string' || !isScoreBand(record.band)) continue;
    if (typeof record.min !== 'number' || typeof record.max !== 'number') continue;
    entries.push({ band: record.band, min: record.min, max: record.max });
  }
  entries.sort((left, right) => left.min - right.min || left.band.localeCompare(right.band));
  return { entries, unreadable: false };
}

/**
 * Known-signal share of the model's own weight (plan §3.1: a 70 built on 20 % coverage must not read like a
 * 70 built on everything), four decimals for stable numeric semantics (plan §6.3).
 *
 * A rule's weight is the magnitude it could have carried — `|points|`, or 1 for a `setBand` rule and for a
 * draft rule whose points were never filled in, since both still ask the Lead a question.
 *
 * The three exclusions are the whole design decision:
 * - a **skipped** rule (disabled, or a signal source this build cannot read) left both sides out: it is a
 *   modelling fact about the model, not a gap in this Lead's data;
 * - an **unknown under `ignore`** left both sides out, because that policy says the rule asks nothing when
 *   the signal is absent, so it cannot make the score look less trustworthy;
 * - an **unknown under `neutral`** and an **error** stay in the denominator only: the model intended that
 *   weight, the data did not answer, and a reader has to see the hole.
 */
function coverageOf(attempted: readonly { outcome: TriState | 'error'; weight: number; counted: boolean }[]): number {
  let total = 0;
  let known = 0;
  for (const entry of attempted) {
    if (!entry.counted) continue;
    total += entry.weight;
    if (entry.outcome === 'matched' || entry.outcome === 'not_matched') known += entry.weight;
  }
  if (total === 0) return 0;
  return Number((known / total).toFixed(4));
}

function ruleWeight(rule: RuleAttributes): number {
  if (rule.effect === 'setBand') return 1;
  const magnitude = Math.abs(rule.points);
  return magnitude > 0 ? magnitude : 1;
}

function roundHalfAwayFromZero(value: number): number {
  // `Math.round` sends -0.5 to -0, which makes the rounding of a negative delta depend on its sign. Plan
  // §6.3 asks for stable numeric semantics, so halves move away from zero on both sides.
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function codesFor(evaluations: readonly RuleEvaluation[], outcome: RuleOutcome, filter?: (entry: RuleEvaluation) => boolean): string[] {
  return dedupe(
    evaluations
      .filter((entry) => entry.outcome === outcome && (filter === undefined || filter(entry)))
      .map((entry) => entry.reasonCode)
      .sort(),
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------

/**
 * Canonical form of everything the score was derived from: the version's configuration, the rule set, and
 * only the fields the engine actually read.
 *
 * It names the version rather than its timestamps, and it carries the outcome, so `signature` answers the
 * question plan §1.2 asks — *did a rebuild change anything?* — without storing the Lead's values in the
 * evaluation row (audit §5.3 keeps the values out of history).
 */
function canonicalSignature(
  model: ModelAttributes,
  rules: readonly RuleAttributes[],
  readFields: ReadonlySet<string>,
  values: Readonly<Record<string, unknown>>,
  evaluations: readonly RuleEvaluation[],
  score: number,
  band: ScoreBand,
  coverage: number,
): string {
  const weights = readWeights(model);
  return JSON.stringify({
    model: { id: model.id, version: model.modelVersion, scale: [model.scaleMin, model.scaleMax], base: model.baseScore, bounds: [model.scoreFloor, model.scoreCeiling] },
    configuration: {
      bands: readBands(model).entries,
      weights: weights === undefined ? null : Object.fromEntries([...weights].sort(([left], [right]) => left.localeCompare(right))),
      allowedFieldPaths: stringList(model.allowedFieldPaths).sort(),
      blockedFieldPaths: stringList(model.blockedFieldPaths).sort(),
    },
    rules: rules.map((rule) => ({
      id: rule.id,
      reasonCode: rule.reasonCode,
      dimension: rule.dimension,
      effect: rule.effect,
      points: rule.points,
      priority: rule.priority,
      enabled: rule.enabled,
      missingDataPolicy: rule.missingDataPolicy,
      signalSource: rule.signalSource,
      targetBand: rule.targetBand ?? null,
      condition: canonicalCondition(parseScoreCondition(rule.condition).node),
    })),
    inputs: canonicalInputs(readFields, values),
    outcome: { score, band, coverage, rules: evaluations.map((entry) => [entry.reasonCode, entry.outcome, entry.points, entry.code ?? null]) },
  });
}

function canonicalInputs(readFields: ReadonlySet<string>, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of [...readFields].sort()) {
    const stored = storedValue(values, field);
    if (!stored.supplied) {
      // Distinct from `null` on purpose: a withheld signal and an empty one are different facts, and a score
      // derived from each must not carry the same signature.
      out[field] = NOT_SUPPLIED;
      continue;
    }
    if (stored.isEmpty) {
      out[field] = null;
      continue;
    }
    const raw = stored.value;
    if (raw instanceof Date) out[field] = Number.isNaN(raw.getTime()) ? null : raw.toISOString();
    else if (Array.isArray(raw)) out[field] = raw.map((item) => textOf(item)).filter((item) => item !== '');
    else if (typeof raw === 'object' && raw !== null) out[field] = null;
    else out[field] = raw;
  }
  return out;
}

/** The parsed tree rather than the stored text: two rule authors, one meaning, one signature. */
function canonicalCondition(node: ConditionNode | ParsedCondition['node']): unknown {
  if (node === undefined) return null;
  if ('all' in node) return { all: node.all.map((child) => canonicalCondition(child)) };
  if ('any' in node) return { any: node.any.map((child) => canonicalCondition(child)) };
  if ('not' in node) return { not: canonicalCondition(node.not as ConditionNode) };
  const leaf = node as { field: string; operator: string; value?: unknown };
  return { field: leaf.field, operator: leaf.operator, value: leaf.value === undefined ? null : leaf.value };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// refused evaluations
// ---------------------------------------------------------------------------

/**
 * The shape of an evaluation that produced no score: `scoreValue: null`, band `Unknown`, coverage 0 and the
 * codes that explain it. Plan §5.4 keeps a failed history visible rather than hiding it, and LS.5 stores
 * exactly this — which is why "we could not tell" is a result the engine can express and not an exception.
 */
function emptyEvaluation(
  request: EvaluationRequest,
  evaluations: readonly RuleEvaluation[],
  readFields: ReadonlySet<string>,
  codes: readonly string[],
): ScoreEvaluation {
  const { model, snapshot } = request;
  return {
    recordId: snapshot.recordId,
    modelId: model.id,
    modelVersion: model.modelVersion,
    scoreValue: null,
    band: 'Unknown',
    bandSource: 'none',
    resultState: 'failed',
    coverage: 0,
    baseScore: model.baseScore,
    delta: 0,
    clamped: false,
    ruleEvaluations: evaluations,
    positiveReasonCodes: [],
    negativeReasonCodes: [],
    unknownReasonCodes: codesFor(evaluations, 'unknown'),
    skippedReasonCodes: codesFor(evaluations, 'skipped'),
    errorCodes: dedupe(codes),
    readFields: [...readFields].sort(),
    signature: digest(JSON.stringify({ model: { id: model.id, version: model.modelVersion }, score: null, band: 'Unknown', coverage: 0, codes: dedupe(codes) })),
    inputsHash: digest(JSON.stringify(canonicalInputs(readFields, snapshot.values))),
  };
}
