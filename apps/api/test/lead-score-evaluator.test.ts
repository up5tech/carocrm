import { describe, expect, it } from 'vitest';

import type { ScoreableField } from '../src/lead-score/lead-score-condition.js';
import type { ScoreEvaluation } from '../src/lead-score/lead-score-evaluator.js';
import { EVALUATION_CODES, MAX_EVALUATED_RULES, requiredInputFields, scoreLead,SCORING_OPERATORS } from '../src/lead-score/lead-score-evaluator.js';
import type { ModelAttributes, RuleAttributes } from '../src/lead-score/lead-score-validator.js';

/**
 * Phase 19-LS.4 — the deterministic scoring engine, tested as a pure function.
 *
 * Plan §16 `19-LS.4` accepts on one sentence: *the same model and input snapshot produce the same auditable
 * result*. A sentence like that is only proved by cases that try to break it — a clock, an array order, a
 * key order, a whitespace difference — and by cases that pin the meaning of every operator, because a score
 * stored in March has to mean the same thing when it is re-derived in September (plan §1.2, §6.3).
 *
 * There is no database and no HTTP here on purpose: `lead-score-schema.test.ts` and
 * `lead-score-preview.test.ts` own the storage and ACL half. What this file owns is arithmetic and semantics,
 * where a wrong answer would survive every integration test by looking plausible.
 */

const FIELDS: ReadonlyMap<string, ScoreableField> = new Map<string, ScoreableField>(
  (
    [
      { name: 'name', type: 'varchar', maxLength: 255 },
      { name: 'company', type: 'varchar', maxLength: 255 },
      { name: 'industry', type: 'varchar', maxLength: 128 },
      { name: 'source', type: 'varchar', maxLength: 128 },
      { name: 'title', type: 'varchar', maxLength: 128 },
      { name: 'emailAddress', type: 'email' },
      { name: 'phoneNumber', type: 'phone' },
      { name: 'website', type: 'url' },
      { name: 'description', type: 'text' },
      { name: 'status', type: 'enum', options: ['New', 'Assigned', 'In Process', 'Converted', 'Dead'] },
      { name: 'employeeCount', type: 'int' },
      { name: 'annualValue', type: 'currency' },
      { name: 'scoreWeight', type: 'float' },
      { name: 'renewalDate', type: 'date' },
      { name: 'createdAt', type: 'datetime' },
      { name: 'isCustomer', type: 'bool' },
      { name: 'interests', type: 'multiEnum', options: ['sport', 'finance'] },
      { name: 'accountId', type: 'link' },
      { name: 'teams', type: 'linkMultiple' },
      { name: 'scoreValue', type: 'int' },
      { name: 'scoreBand', type: 'enum', options: ['Unknown', 'Cold'] },
      { name: 'age', type: 'int' },
      { name: 'gender', type: 'varchar', maxLength: 32 },
      { name: 'password', type: 'password' },
    ] satisfies Partial<ScoreableField>[] as unknown as ScoreableField[]
  ).map((field) => [field.name, field]),
);

const BANDS = JSON.stringify([
  { band: 'Cold', min: 0, max: 39 },
  { band: 'Warm', min: 40, max: 69 },
  { band: 'Hot', min: 70, max: 89 },
  { band: 'Sales Ready', min: 90, max: 100 },
]);

function model(overrides: Partial<ModelAttributes> = {}): ModelAttributes {
  return {
    id: 'model-1',
    name: 'ICP fit',
    status: 'published',
    modelVersion: 3,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 10,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: BANDS,
    ...overrides,
  };
}

function rule(overrides: Partial<RuleAttributes> = {}): RuleAttributes {
  return {
    id: 'rule-1',
    name: 'Has a company',
    modelId: 'model-1',
    modelVersion: 3,
    reasonCode: 'company_known',
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
    ...overrides,
  };
}

interface RunOptions {
  readonly values?: Record<string, unknown>;
  readonly sourceRevision?: number;
  readonly inputsAsOf?: string;
  /** The engagement reading, as 19-LS.9's reader supplies it. */
  readonly signals?: { evaluatedAt: string; state: 'available' | 'disabled' | 'absent' | 'no_events'; readings: Record<string, readonly string[]> };
  readonly now?: string;
}

function run(rules: readonly RuleAttributes[], options: RunOptions = {}, modelOverrides: Partial<ModelAttributes> = {}): ScoreEvaluation {
  return scoreLead({
    model: model(modelOverrides),
    rules,
    fields: FIELDS,
    snapshot: {
      recordId: 'lead-1',
      sourceRevision: options.sourceRevision ?? 7,
      inputsAsOf: options.inputsAsOf ?? '2026-10-24T09:00:00.000Z',
      values: options.values ?? {},
      ...(options.signals === undefined ? {} : { signals: options.signals }),
    },
  });
}

function outcome(rules: readonly RuleAttributes[], values: Record<string, unknown>, modelOverrides: Partial<ModelAttributes> = {}): string {
  return run(rules, { values }, modelOverrides).ruleEvaluations[0]?.outcome ?? 'none';
}

function points(rules: readonly RuleAttributes[], values: Record<string, unknown>, modelOverrides: Partial<ModelAttributes> = {}): number {
  return run(rules, { values }, modelOverrides).ruleEvaluations[0]?.points ?? 0;
}

/** Rules run in priority order, so an assertion names the reason code it means. */
function entryFor(result: ScoreEvaluation, reasonCode: string): ScoreEvaluation['ruleEvaluations'][number] | undefined {
  return result.ruleEvaluations.find((entry) => entry.reasonCode === reasonCode);
}

function condition(node: unknown, overrides: Partial<RuleAttributes> = {}): RuleAttributes {
  return rule({ condition: JSON.stringify(node), ...overrides });
}

describe('reproducibility — the acceptance of 19-LS.4 (plan §1.2, §16)', () => {
  const rules = [condition({ field: 'industry', operator: 'equals', value: 'Software' }, { reasonCode: 'industry_target', points: 15 }), rule()];
  const values = { industry: 'Software', company: 'Acme' };

  it('answers identically for the same model and the same snapshot', () => {
    const first = run(rules, { values });
    const second = run(rules, { values });
    expect(second).toEqual(first);
    expect(second.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not read a clock, so the same data scored tomorrow scores the same', () => {
    const today = run(rules, { values, inputsAsOf: '2026-10-24T00:00:00.000Z', sourceRevision: 7 });
    const nextYear = run(rules, { values, inputsAsOf: '2027-10-24T23:59:59.000Z', sourceRevision: 99 });
    // Provenance travels with the result; it does not participate in it.
    expect(nextYear.scoreValue).toBe(today.scoreValue);
    expect(nextYear.signature).toBe(today.signature);
  });

  it('ignores the order the caller supplied the field values in', () => {
    const left = run(rules, { values: { industry: 'Software', company: 'Acme' } });
    const right = run(rules, { values: { company: 'Acme', industry: 'Software' } });
    expect(right.signature).toBe(left.signature);
  });

  it('does not sign a withheld signal as an empty one', () => {
    const rules = [condition({ field: 'company', operator: 'isEmpty' })];
    const withheld = run(rules, { values: {} });
    const empty = run(rules, { values: { company: null } });
    // Two different information sets produced these two results, so a stored score can tell them apart later.
    expect(withheld.signature).not.toBe(empty.signature);
    expect(withheld.inputsHash).not.toBe(empty.inputsHash);
    expect(withheld.coverage).toBe(0);
    expect(empty.coverage).toBe(1);
  });

  it('scores by priority, not by the order rules arrived in', () => {
    const early = [condition({ field: 'company', operator: 'equals', value: 'Acme' }, { id: 'rule-a', priority: 5, reasonCode: 'a' }), rule({ id: 'rule-b', priority: 50 })];
    const reversed = [...early].reverse();
    expect(run(reversed, { values: { company: 'Acme' } })).toEqual(run(early, { values: { company: 'Acme' } }));
  });

  it('treats two spellings of one condition as one condition', () => {
    const tight = [condition({ field: 'industry', operator: 'equals', value: 'Software' })];
    const spaced = [rule({ condition: '{ "operator" : "equals", "field": "industry",  "value": "Software" }' })];
    expect(run(spaced, { values: { industry: 'Software' } }).signature).toBe(run(tight, { values: { industry: 'Software' } }).signature);
  });

  it('changes the signature when a rule or a signal changes', () => {
    const baseline = run(rules, { values });
    expect(run(rules.map((entry) => ({ ...entry, points: entry.id === 'rule-1' ? 11 : entry.points })), { values }).signature).not.toBe(baseline.signature);
    expect(run(rules, { values: { ...values, company: 'Acme Corp' } }).signature).not.toBe(baseline.signature);
    expect(run(rules, { values }, { scoreFloor: 5 }).signature).not.toBe(baseline.signature);
  });

  it('breaks a priority tie the same way every time (compat U13)', () => {
    // Two rules at one priority would otherwise be applied in whatever order the list query returned, which
    // would make a stored score depend on a database detail. `reasonCode`, then `id`, fixes it.
    const first = condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'rule-b', priority: 7, reasonCode: 'aaa_first' });
    const second = condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'rule-a', priority: 7, reasonCode: 'zzz_last' });
    const values = { company: 'Acme', industry: 'Software' };
    expect(run([first, second], { values }).ruleEvaluations.map((entry) => entry.reasonCode)).toEqual(['aaa_first', 'zzz_last']);
    expect(run([second, first], { values }).ruleEvaluations.map((entry) => entry.reasonCode)).toEqual(['aaa_first', 'zzz_last']);
    expect(run([second, first], { values }).signature).toBe(run([first, second], { values }).signature);
  });

  it('reads only the fields the rules name, and says which', () => {
    const result = run(rules, { values: { ...values, description: 'irrelevant', phoneNumber: '+15551234' } });
    expect(result.readFields).toEqual(['company', 'industry']);
    expect(result.inputsHash).toBe(run(rules, { values: { ...values, description: 'changed' } }).inputsHash);
  });
});

describe('missing is not negative by default (plan §1.2)', () => {
  const shapes: [string, Record<string, unknown>][] = [
    ['absent', {}],
    ['null', { company: null }],
    ['empty text', { company: '' }],
    ['whitespace only', { company: '   ' }],
    ['empty list', { interests: [] }],
  ];

  it('answers unknown, contributes nothing, and never subtracts', () => {
    for (const [label, values] of shapes) {
      const asked = condition({ field: label === 'empty list' ? 'interests' : 'company', operator: 'equals', value: 'Acme' });
      expect(outcome([asked], values), label).toBe('unknown');
      expect(points([asked], values), label).toBe(0);
    }
  });

  it('lets an existence question answer about an empty signal, but not about one the caller was not given', () => {
    // The distinction matters because a field a reader may not see and a field nobody filled in look the same
    // in a JSON blob. Treating the first as the second would state a fact about a record the reader cannot
    // read, so an withheld signal answers nothing (plan §6.5, §9.2).
    expect(outcome([condition({ field: 'company', operator: 'isEmpty' })], {})).toBe('unknown');
    expect(outcome([condition({ field: 'company', operator: 'isNotEmpty' })], {})).toBe('unknown');
    expect(outcome([condition({ field: 'company', operator: 'isEmpty' })], { company: null })).toBe('matched');
    expect(outcome([condition({ field: 'company', operator: 'isEmpty' })], { company: '   ' })).toBe('matched');
    expect(outcome([condition({ field: 'company', operator: 'isNotEmpty' })], { company: '' })).toBe('not_matched');
    expect(outcome([condition({ field: 'company', operator: 'isNotEmpty' })], { company: 'Acme' })).toBe('matched');
  });

  it('refuses to let a missing signal decide a group it is only part of', () => {
    // `all` with one false answer is false; with one unknown and no false it is unknown, and `not` of an
    // unknown stays unknown — absence of a signal does not prove its opposite.
    const andUnknown = condition({ all: [{ field: 'company', operator: 'isNotEmpty' }, { field: 'industry', operator: 'equals', value: 'Software' }] });
    expect(outcome([andUnknown], { company: 'Acme' })).toBe('unknown');
    const negated = condition({ not: { field: 'industry', operator: 'equals', value: 'Software' } });
    expect(outcome([negated], {})).toBe('unknown');
    const orUnknown = condition({ any: [{ field: 'industry', operator: 'equals', value: 'Software' }, { field: 'company', operator: 'equals', value: 'Acme' }] });
    expect(outcome([orUnknown], { company: 'Acme' })).toBe('matched');
  });

  it('separates the two missing-data policies by coverage, not by points', () => {
    const missing = { values: { industry: 'Software' } };
    const pair = (policy: 'ignore' | 'neutral'): RuleAttributes[] => [
      condition({ field: 'company', operator: 'equals', value: 'Acme' }, { id: 'rule-1', reasonCode: 'company_acme', points: 20, dimension: 'fit', missingDataPolicy: policy }),
      condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'rule-2', reasonCode: 'industry_known', points: 10, dimension: 'fit' }),
    ];
    // `ignore` says the absent signal asks nothing, so the score rests on what the model could ask.
    expect(run(pair('ignore'), missing).coverage).toBe(1);
    // `neutral` says the model wanted that weight and the Lead did not answer: the same score, a visible hole.
    expect(run(pair('neutral'), missing).coverage).toBe(0.3333);
    expect(run(pair('neutral'), missing).scoreValue).toBe(run(pair('ignore'), missing).scoreValue);
    expect(run(pair('neutral'), missing).unknownReasonCodes).toEqual(['company_acme']);
    expect(run(pair('neutral'), missing).positiveReasonCodes).toEqual(['industry_known']);
  });

  it('reports a base score for a model with no enabled rule instead of hiding it', () => {
    const result = run([rule({ enabled: false })], { values: { company: 'Acme' } });
    expect(result.scoreValue).toBe(10);
    expect(result.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.ruleDisabled);
    expect(result.skippedReasonCodes).toEqual(['company_known']);
    expect(result.coverage).toBe(0);
  });
});

describe('every operator has one documented scoring meaning (plan §6.2, audit §5.2-4)', () => {
  interface OperatorCase {
    readonly label: string;
    readonly node: unknown;
    readonly values: Record<string, unknown>;
    readonly expected: 'matched' | 'not_matched' | 'unknown';
  }

  const cases: OperatorCase[] = [
    { label: 'equals on text', node: { field: 'industry', operator: 'equals', value: 'Software' }, values: { industry: 'Software' }, expected: 'matched' },
    { label: 'equals is case-sensitive, like the platform', node: { field: 'industry', operator: 'equals', value: 'Software' }, values: { industry: 'software' }, expected: 'not_matched' },
    { label: 'notEquals', node: { field: 'industry', operator: 'notEquals', value: 'Software' }, values: { industry: 'Hardware' }, expected: 'matched' },
    { label: 'contains', node: { field: 'company', operator: 'contains', value: 'Ltd' }, values: { company: 'Acme Ltd' }, expected: 'matched' },
    { label: 'notContains', node: { field: 'company', operator: 'notContains', value: 'Ltd' }, values: { company: 'Acme Ltd' }, expected: 'not_matched' },
    { label: 'startsWith', node: { field: 'company', operator: 'startsWith', value: 'Acme' }, values: { company: 'Acme Ltd' }, expected: 'matched' },
    { label: 'endsWith on an email domain', node: { field: 'emailAddress', operator: 'endsWith', value: '@example.com' }, values: { emailAddress: 'a@example.com' }, expected: 'matched' },
    { label: 'in', node: { field: 'source', operator: 'in', value: ['Webinar', 'Referral'] }, values: { source: 'Referral' }, expected: 'matched' },
    { label: 'notIn', node: { field: 'source', operator: 'notIn', value: ['Webinar', 'Referral'] }, values: { source: 'Cold call' }, expected: 'matched' },
    { label: 'gt with a numeric string stored as text', node: { field: 'employeeCount', operator: 'gt', value: 40 }, values: { employeeCount: '45' }, expected: 'matched' },
    { label: 'gte boundary', node: { field: 'employeeCount', operator: 'gte', value: 45 }, values: { employeeCount: 45 }, expected: 'matched' },
    { label: 'lt boundary', node: { field: 'employeeCount', operator: 'lt', value: 45 }, values: { employeeCount: 45 }, expected: 'not_matched' },
    { label: 'lte on currency', node: { field: 'annualValue', operator: 'lte', value: 1000 }, values: { annualValue: 999.5 }, expected: 'matched' },
    { label: 'date comparison', node: { field: 'renewalDate', operator: 'gt', value: '2026-01-01' }, values: { renewalDate: '2026-06-30' }, expected: 'matched' },
    { label: 'datetime comparison', node: { field: 'createdAt', operator: 'gte', value: '2026-06-01T00:00' }, values: { createdAt: new Date('2026-06-01T00:00:00Z') }, expected: 'matched' },
    { label: 'enum membership', node: { field: 'status', operator: 'in', value: ['New', 'Assigned'] }, values: { status: 'New' }, expected: 'matched' },
    { label: 'isTrue', node: { field: 'isCustomer', operator: 'isTrue' }, values: { isCustomer: true }, expected: 'matched' },
    { label: 'isFalse', node: { field: 'isCustomer', operator: 'isFalse' }, values: { isCustomer: false }, expected: 'matched' },
    // The LS.3 matrix also admits `equals`/`notEquals` on a boolean, so they must mean the same question here.
    { label: 'equals on a bool field', node: { field: 'isCustomer', operator: 'equals', value: true }, values: { isCustomer: true }, expected: 'matched' },
    { label: 'equals on a bool field, answered the other way', node: { field: 'isCustomer', operator: 'equals', value: true }, values: { isCustomer: false }, expected: 'not_matched' },
    { label: 'notEquals on a bool field', node: { field: 'isCustomer', operator: 'notEquals', value: true }, values: { isCustomer: false }, expected: 'matched' },
    { label: 'a link field answers existence', node: { field: 'accountId', operator: 'isNotEmpty' }, values: { accountId: 'account-1' }, expected: 'matched' },
    { label: 'a multi-value field answers existence', node: { field: 'teams', operator: 'isEmpty' }, values: { teams: [] }, expected: 'matched' },
    { label: 'an unreadable number is unknown, not false', node: { field: 'employeeCount', operator: 'gt', value: 40 }, values: { employeeCount: 'many' }, expected: 'unknown' },
    { label: 'an unreadable date is unknown', node: { field: 'renewalDate', operator: 'gt', value: '2026-01-01' }, values: { renewalDate: 'not-a-date' }, expected: 'unknown' },
    { label: 'an unsupported operator is unknown with a code', node: { field: 'isCustomer', operator: 'gt', value: 1 }, values: { isCustomer: true }, expected: 'unknown' },
  ];

  for (const entry of cases) {
    it(entry.label, () => {
      expect(outcome([condition(entry.node)], entry.values)).toBe(entry.expected);
    });
  }

  it('gives a scoring meaning to every operator the platform names', () => {
    // The health check compares this list with `CRITERIA_OPERATORS`; the test says why that matters — a new
    // platform operator must not become a rule that quietly never matches (audit §5.2-4).
    expect(SCORING_OPERATORS).toHaveLength(16);
    expect(new Set(SCORING_OPERATORS).size).toBe(16);
  });

  it('keeps a stored signal out of the response', () => {
    const result = run([condition({ field: 'emailAddress', operator: 'endsWith', value: '@example.com' })], { values: { emailAddress: 'person@example.com' } });
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(result.ruleEvaluations[0]?.outcome).toBe('matched');
  });
});

describe('aggregation: base, deltas, weights, clamp, rounding, band (plan §6.3, audit §5.2)', () => {
  it('starts from the base score and adds the matched deltas', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', points: 10, priority: 1 }),
      condition({ field: 'industry', operator: 'equals', value: 'Software' }, { id: 'r2', reasonCode: 'b', points: 5, priority: 2 }),
    ];
    const result = run(rules, { values: { company: 'Acme', industry: 'Software' } });
    expect(result.baseScore).toBe(10);
    expect(result.delta).toBe(15);
    expect(result.scoreValue).toBe(25);
    expect(result.positiveReasonCodes).toEqual(['a', 'b']);
  });

  it('lets the effect decide the sign, not the number an administrator typed', () => {
    // A `subtract` rule stored as -8 and one stored as 8 both subtract 8: the score cannot depend on a
    // data-entry habit, and a negative rule on the `negative` dimension reads the same as the label says.
    expect(points([condition({ field: 'company', operator: 'isEmpty' }, { effect: 'subtract', points: -8 })], { company: 'Acme' })).toBe(0);
    const matched = [condition({ field: 'company', operator: 'isNotEmpty' }, { effect: 'subtract', points: -8, dimension: 'negative' })];
    expect(points(matched, { company: 'Acme' })).toBe(-8);
    expect(points([condition({ field: 'company', operator: 'isNotEmpty' }, { effect: 'subtract', points: 8 })], { company: 'Acme' })).toBe(-8);
  });

  it('clamps to the model floor and ceiling and says it did', () => {
    const high = run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 40 })], { values: { company: 'Acme' } });
    expect(high.scoreValue).toBe(50);
    const beyond = run(
      [
        condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', points: 40, priority: 1 }),
        condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'b', points: 40, priority: 2 }),
      ],
      { values: { company: 'Acme', industry: 'Software' } },
      { scoreCeiling: 60 },
    );
    expect(beyond.scoreValue).toBe(60);
    expect(beyond.clamped).toBe(true);
    const floor = run(
      [condition({ field: 'company', operator: 'isNotEmpty' }, { effect: 'subtract', points: 100, dimension: 'negative' })],
      { values: { company: 'Acme' } },
      { scoreFloor: 5 },
    );
    expect(floor.scoreValue).toBe(5);
    expect(floor.clamped).toBe(true);
  });

  it('rounds a weighted half away from zero on both sides', () => {
    // 10 base + a half point: `Math.round` would send -0.5 to -0, so the sign of a delta would change the
    // rounding rule. Plan §6.3 asks for stable numeric semantics.
    const up = run(
      [
        condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', dimension: 'fit', points: 5, priority: 1 }),
        condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'b', dimension: 'intent', points: 1, priority: 2 }),
      ],
      { values: { company: 'Acme', industry: 'Software' } },
      { dimensionWeights: JSON.stringify({ fit: 2, intent: 1 }) },
    );
    expect(up.delta).toBeCloseTo(3.6666667, 7);
    expect(up.scoreValue).toBe(14);
    const down = run(
      [
        condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', dimension: 'fit', effect: 'subtract', points: 3, priority: 1 }),
        condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'b', dimension: 'intent', effect: 'subtract', points: 4, priority: 2 }),
      ],
      { values: { company: 'Acme', industry: 'Software' } },
      { baseScore: 0, scaleMin: -10, scoreFloor: -10, dimensionWeights: JSON.stringify({ fit: 1, intent: 1 }) },
    );
    // A weighted delta of exactly -3.5: `Math.round` would send it to -3, so the sign of the delta would
    // decide the rounding rule. Plan §6.3 asks for stable numeric semantics, so a half moves away from zero.
    expect(down.delta).toBe(-3.5);
    expect(down.scoreValue).toBe(-4);
  });

  it('treats dimension weights as relative influence, not as a multiplier', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'fit_a', dimension: 'fit', points: 20, priority: 1 }),
      condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'intent_b', dimension: 'intent', points: 30, priority: 2 }),
    ];
    const weighted = run(rules, { values: { company: 'Acme', industry: 'Software' } }, { dimensionWeights: JSON.stringify({ fit: 40, intent: 60 }) });
    // (20 × 40 + 30 × 60) / (40 + 60) = 26, so the scale cannot widen: the same rules unweighted give 50.
    expect(weighted.delta).toBe(26);
    expect(weighted.scoreValue).toBe(36);
    const unweighted = run(rules, { values: { company: 'Acme', industry: 'Software' } });
    expect(unweighted.scoreValue).toBe(60);
    const single = run([rules[0] as RuleAttributes], { values: { company: 'Acme' } }, { dimensionWeights: JSON.stringify({ fit: 70 }) });
    expect(single.delta).toBe(20);
  });

  it('uses the unweighted delta and flags the model when every weight is zero', () => {
    const result = run(
      [condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', dimension: 'fit', points: 20 })],
      { values: { company: 'Acme' } },
      { dimensionWeights: JSON.stringify({ fit: 0 }) },
    );
    expect(result.delta).toBe(20);
    expect(result.errorCodes).toContain(EVALUATION_CODES.weightsIgnored);
  });

  it('reads a skipped rule out of the weight denominator, so it cannot dilute the score', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', dimension: 'fit', points: 20, priority: 1 }),
      condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'b', dimension: 'intent', points: 100, priority: 2, enabled: false }),
    ];
    const result = run(rules, { values: { company: 'Acme', industry: 'Software' } }, { dimensionWeights: JSON.stringify({ fit: 50, intent: 50 }) });
    // Only `fit` was attempted, so only its weight normalizes: the delta stays 20 rather than halving to 10.
    expect(result.delta).toBe(20);
    expect(result.scoreValue).toBe(30);
  });

  it('resolves the band from the score range, and a boundary belongs to one band only', () => {
    // base 10 + 20 = 30 → Cold; +30 = 40 is the first point of Warm; +60 = 70 is Hot; +80 = 90 is Sales Ready.
    expect(run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 20 })], { values: { company: 'Acme' } }).band).toBe('Cold');
    expect(run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 30 })], { values: { company: 'Acme' } }).band).toBe('Warm');
    expect(run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 60 })], { values: { company: 'Acme' } }).band).toBe('Hot');
    expect(run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 80 })], { values: { company: 'Acme' } }).band).toBe('Sales Ready');
    const boundary = run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 30 })], { values: { company: 'Acme' } });
    expect(boundary.bandSource).toBe('threshold');
  });

  it('lets a matched setBand decide the band and carry no points', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'a', points: 40, priority: 1 }),
      condition({ field: 'status', operator: 'equals', value: 'Dead' }, { id: 'r2', reasonCode: 'dead_lead', effect: 'setBand', points: 0, priority: 2, targetBand: 'Disqualified', dimension: 'negative' }),
    ];
    const result = run(rules, { values: { company: 'Acme', status: 'Dead' } });
    expect(result.band).toBe('Disqualified');
    expect(result.bandSource).toBe('rule');
    expect(result.scoreValue).toBe(50);
    expect(result.ruleEvaluations[1]?.points).toBe(0);
  });

  it('gives the last matched setBand in priority order the answer', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'warm_band', effect: 'setBand', points: 0, priority: 5, targetBand: 'Warm' }),
      condition({ field: 'industry', operator: 'isNotEmpty' }, { id: 'r2', reasonCode: 'hot_band', effect: 'setBand', points: 0, priority: 10, targetBand: 'Hot' }),
    ];
    expect(run(rules, { values: { company: 'Acme', industry: 'Software' } }).band).toBe('Hot');
    expect(run(rules, { values: { company: 'Acme' } }).band).toBe('Warm');
  });

  it('never reaches Disqualified from a low number (plan §3.3)', () => {
    const result = run([condition({ field: 'company', operator: 'isNotEmpty' }, { effect: 'subtract', points: 40, dimension: 'negative' })], { values: { company: 'Acme' } }, { baseScore: 5 });
    expect(result.scoreValue).toBe(0);
    expect(result.band).toBe('Cold');
    expect(result.band).not.toBe('Disqualified');
  });

  it('says so when no band covers the score', () => {
    const gapped = run([condition({ field: 'company', operator: 'isNotEmpty' }, { points: 40 })], { values: { company: 'Acme' } }, { qualificationBands: JSON.stringify([{ band: 'Cold', min: 0, max: 39 }, { band: 'Hot', min: 70, max: 89 }]) });
    expect(gapped.scoreValue).toBe(50);
    expect(gapped.band).toBe('Unknown');
    expect(gapped.bandSource).toBe('none');
    expect(gapped.errorCodes).toContain(EVALUATION_CODES.scoreOutsideBands);
  });

  it('refuses to score a rule set it cannot hold whole', () => {
    const rules = Array.from({ length: MAX_EVALUATED_RULES + 1 }, (_unused, index) =>
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: `rule-${index}`, reasonCode: `code_${index}`, priority: index }),
    );
    const result = run(rules, { values: { company: 'Acme' } });
    expect(result.resultState).toBe('failed');
    expect(result.scoreValue).toBeNull();
    expect(result.errorCodes).toEqual([EVALUATION_CODES.ruleLimit]);
  });
});

describe('a rule that cannot be evaluated is an outcome, not an exception (plan §5.4, §6.5)', () => {
  it('refuses a condition that is not a declarative tree', () => {
    const result = run([rule({ condition: 'field("company") != ""' })], { values: { company: 'Acme' } });
    expect(result.resultState).toBe('failed');
    expect(result.scoreValue).toBeNull();
    expect(result.errorCodes).toContain(EVALUATION_CODES.conditionUnreadable);
  });

  it('refuses a rule that names a field the model was not granted', () => {
    const result = run([condition({ field: 'description', operator: 'contains', value: 'urgent' })], { values: { description: 'urgent', company: 'Acme' } }, { allowedFieldPaths: JSON.stringify(['company']) });
    expect(result.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.fieldNotGranted);
    expect(result.readFields).toEqual([]);
  });

  it('refuses a scoring output and a protected characteristic even when the caller supplies them', () => {
    for (const [field, code] of [
      ['scoreValue', EVALUATION_CODES.fieldNotGranted],
      ['age', EVALUATION_CODES.fieldNotGranted],
      ['gender', EVALUATION_CODES.fieldNotGranted],
    ] as const) {
      const result = run([condition({ field, operator: 'isNotEmpty' })], { values: { [field]: 'anything' } });
      expect(result.ruleEvaluations[0]?.code, field).toBe(code);
      expect(result.readFields, field).toEqual([]);
    }
  });

  it('honours the installation block list on top of the built-in one', () => {
    const result = run([condition({ field: 'company', operator: 'isNotEmpty' })], { values: { company: 'Acme' } }, { blockedFieldPaths: JSON.stringify(['company']) });
    expect(result.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.fieldNotGranted);
  });

  it('names a field the metadata does not declare', () => {
    const result = run([condition({ field: 'employeeSizeBand', operator: 'isNotEmpty' })], { values: {} });
    expect(result.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.fieldUnknown);
  });

  it('is partial when one rule errored and another answered, and never silently drops the error', () => {
    const rules = [
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r1', reasonCode: 'good', points: 10, priority: 1 }),
      rule({ id: 'r2', reasonCode: 'broken', condition: 'not json at all', priority: 2 }),
    ];
    const result = run(rules, { values: { company: 'Acme' } });
    expect(result.resultState).toBe('partial');
    expect(result.scoreValue).toBe(20);
    expect(result.errorCodes).toEqual([EVALUATION_CODES.conditionUnreadable]);
    expect(result.ruleEvaluations.map((entry) => entry.outcome)).toEqual(['matched', 'error']);
  });

  it('skips an engagement rule the reading could not serve, and still scores the rest (plan §16 `19-LS.9`)', () => {
    // The exit criterion is one sentence, and this is its first half: an optional signal source that is
    // switched off, absent or simply not supplied must not break the score. The rule leaves coverage rather
    // than inventing a zero, and the Lead rests at the base with the reason visible.
    const engagement = condition({ field: 'eventCount', operator: 'gte', value: 2 }, { signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30, reasonCode: 'opened_twice' });
    for (const state of ['disabled', 'absent'] as const) {
      const result = run([engagement, rule()], { values: { company: 'Acme' }, signals: { evaluatedAt: NOW, state, readings: {} } });
      const entry = entryFor(result, 'opened_twice');
      expect(result.resultState, state).toBe('success');
      expect(result.scoreValue, state).toBe(20);
      expect(entry?.outcome, state).toBe('skipped');
      expect(entry?.code, state).toBe(EVALUATION_CODES.signalSourceUnavailable);
      // A skip leaves the denominator, so coverage says "the one rule that could answer, did".
      expect(result.coverage, state).toBe(1);
    }
    // No reading at all — a caller that never asked the reader — answers the same way, not as an error.
    const absent = run([engagement, rule()], { values: { company: 'Acme' } });
    expect(entryFor(absent, 'opened_twice')?.code).toBe(EVALUATION_CODES.signalSourceUnavailable);
    expect(absent.scoreValue).toBe(20);
    // A source this module has no read for at all stays the older, different answer.
    const unknown = run([condition({ field: 'company', operator: 'isNotEmpty' }, { signalSource: 'activities' })], { values: { company: 'Acme' } });
    expect(unknown.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.signalSourceNotReadable);
  });

  it('records an unreadable stored value as unknown with a code', () => {
    const result = run([condition({ field: 'employeeCount', operator: 'gt', value: 40 })], { values: { employeeCount: 'many' } });
    expect(result.errorCodes).toContain(EVALUATION_CODES.valueUnreadable);
    expect(result.unknownReasonCodes).toEqual(['company_known']);
  });
});

describe('the projection a recalculation must fetch', () => {
  it('lists exactly the granted fields the enabled rules name', () => {
    const rules = [
      condition({ all: [{ field: 'industry', operator: 'equals', value: 'Software' }, { field: 'company', operator: 'isNotEmpty' }] }, { id: 'r1', reasonCode: 'a' }),
      condition({ field: 'employeeCount', operator: 'gt', value: 40 }, { id: 'r2', reasonCode: 'b' }),
      condition({ field: 'company', operator: 'isNotEmpty' }, { id: 'r3', reasonCode: 'c', enabled: false }),
      condition({ field: 'description', operator: 'isNotEmpty' }, { id: 'r4', reasonCode: 'd', signalSource: 'emailLinks' }),
    ];
    expect(requiredInputFields(model(), rules, FIELDS)).toEqual(['company', 'employeeCount', 'industry']);
    expect(requiredInputFields(model({ allowedFieldPaths: JSON.stringify(['industry', 'company']) }), rules, FIELDS)).toEqual(['company', 'industry']);
    expect(requiredInputFields(model({ blockedFieldPaths: JSON.stringify(['employeeCount']) }), rules, FIELDS)).toEqual(['company', 'industry']);
  });

  it('agrees with what the engine actually read', () => {
    const rules = [condition({ all: [{ field: 'industry', operator: 'equals', value: 'Software' }, { field: 'company', operator: 'isNotEmpty' }] })];
    const result = run(rules, { values: { industry: 'Software', company: 'Acme' } });
    expect(requiredInputFields(model(), rules, FIELDS)).toEqual(result.readFields);
  });
});

// ---------------------------------------------------------------------------
// 19-LS.9 — engagement signals, decay and the calendar
// ---------------------------------------------------------------------------

const NOW = '2026-10-24T09:00:00.000Z';
const OPEN_PLAN_KEY = 'marketingEvents|opened|30';

function engagementRule(overrides: Partial<RuleAttributes> = {}): RuleAttributes {
  return rule({
    name: 'Opened twice',
    reasonCode: 'opened_twice',
    dimension: 'engagement',
    signalSource: 'marketingEvents',
    eventType: 'opened',
    lookbackDays: 30,
    condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 2 }),
    points: 15,
    ...overrides,
  });
}

function reading(events: readonly string[], overrides: Partial<{ state: 'available' | 'no_events'; evaluatedAt: string }> = {}): RunOptions {
  return { signals: { evaluatedAt: overrides.evaluatedAt ?? NOW, state: overrides.state ?? 'available', readings: { [OPEN_PLAN_KEY]: events } } };
}

describe('the engagement signal (19-LS.9)', () => {
  it('counts events inside the rule window and answers the comparison', () => {
    const two = run([engagementRule()], reading(['2026-10-20T09:00:00.000Z', '2026-10-21T09:00:00.000Z']));
    expect(two.ruleEvaluations[0]?.outcome).toBe('matched');
    expect(two.scoreValue).toBe(25);
    const one = run([engagementRule()], reading(['2026-10-20T09:00:00.000Z']));
    expect(one.ruleEvaluations[0]?.outcome).toBe('not_matched');
    expect(one.scoreValue).toBe(10);
  });

  it('treats an empty window as a definite zero, and a missing metric as no answer', () => {
    // "No opens in 30 days" is a fact about this Lead, so `eventCount gte 2` answers not_matched.
    const none = run([engagementRule()], reading([]));
    expect(none.ruleEvaluations[0]?.outcome).toBe('not_matched');
    // `daysSinceLastEvent` with nothing to be since is not zero days — it is no answer (plan §1.2).
    const days = run([engagementRule({ condition: JSON.stringify({ field: 'daysSinceLastEvent', operator: 'lte', value: 7 }) })], reading([]));
    expect(days.ruleEvaluations[0]?.outcome).toBe('unknown');
    expect(days.coverage).toBe(0);
  });

  it('applies decay to the signal, never to a stored row (plan §6.4)', () => {
    const old = ['2026-09-25T09:00:00.000Z'];
    const fresh = ['2026-10-23T09:00:00.000Z'];
    const halfLife = engagementRule({ decayPolicy: 'halfLife', decayHalfLifeDays: 14, condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 0.6 }) });
    // One event two half-lives old is worth a quarter of one; the same event yesterday is worth almost one.
    expect(run([halfLife], reading(old)).ruleEvaluations[0]?.outcome).toBe('not_matched');
    expect(run([halfLife], reading(fresh)).ruleEvaluations[0]?.outcome).toBe('matched');
    const linear = engagementRule({ decayPolicy: 'linear', condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 0.5 }) });
    // Linear fades across the rule's own window: 29 days into 30 is nearly nothing, 1 day in is nearly one.
    expect(run([linear], reading(old)).ruleEvaluations[0]?.outcome).toBe('not_matched');
    expect(run([linear], reading(fresh)).ruleEvaluations[0]?.outcome).toBe('matched');
    // Undecayed, both events are simply one each.
    expect(run([engagementRule({ condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 1 }) })], reading(old)).scoreValue).toBe(25);
  });

  it('is reproducible, and the calendar is part of the identity of a decayed score', () => {
    const events = ['2026-10-01T09:00:00.000Z', '2026-10-20T09:00:00.000Z'];
    const decayed = engagementRule({ decayPolicy: 'halfLife', decayHalfLifeDays: 14 });
    const first = run([decayed], reading(events));
    expect(run([decayed], reading(events))).toEqual(first);
    // A later sweep sees the same events as older, so it is a *different* evaluation — which is why the
    // signal half belongs in the idempotency key and not in the record's freshness watermark.
    const later = run([decayed], reading([...events], { evaluatedAt: '2026-12-20T09:00:00.000Z' }));
    expect(later.signalsHash).not.toBe(first.signalsHash);
    expect(later.inputsHash).toBe(first.inputsHash);
    // A rule that reads no signal leaves the signal half empty, so a pre-19-LS.9 key is unchanged.
    expect(run([rule()], { values: { company: 'Acme' } }).signalsHash).toBe('');
  });

  it('names the source, the window and the value it compared, for the explanation', () => {
    const result = run([engagementRule()], reading(['2026-10-20T09:00:00.000Z', '2026-10-21T09:00:00.000Z']));
    expect(result.ruleEvaluations[0]?.signal).toEqual({ source: 'marketingEvents', eventTypes: ['opened'], windowDays: 30, metric: 'eventCount', value: 2 });
    // No Lead value is anywhere in it (plan §6.5, §9.2).
    expect(JSON.stringify(result.ruleEvaluations)).not.toContain('Acme');
  });

  it('refuses to read a metric that belongs to another source', () => {
    const result = run([engagementRule({ condition: JSON.stringify({ field: 'clickCount', operator: 'gte', value: 1 }) })], reading(['2026-10-20T09:00:00.000Z']));
    expect(result.ruleEvaluations[0]?.outcome).toBe('error');
    expect(result.ruleEvaluations[0]?.code).toBe(EVALUATION_CODES.signalMetricUnknown);
    expect(result.resultState).toBe('failed');
  });
});
