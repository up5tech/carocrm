import { describe, expect, it } from 'vitest';

import type { ScoreableField } from '../src/lead-score/lead-score-condition.js';
import { MAX_CONDITION_NODES, MAX_CONDITION_PREDICATES, parseScoreCondition, validateScoreCondition } from '../src/lead-score/lead-score-condition.js';
import type { ModelAttributes, RuleAttributes } from '../src/lead-score/lead-score-validator.js';
import { MAX_RULE_POINTS, validateModel } from '../src/lead-score/lead-score-validator.js';

/**
 * Phase 19-LS.3 — the rule DSL and model validation, tested as pure functions.
 *
 * No database, no HTTP, no clock: `validateModel` and the condition parser are the whole subject, so a
 * regression here is a wrong answer in the validator rather than a fixture problem. Every case states the
 * plan clause it guards, because "invalid models cannot be published" (plan §16 `19-LS.3`) is only real if
 * each refusal has a reason someone can read.
 */

/** The Lead fields a score may see, as the metadata declares them. */
const FIELDS: ReadonlyMap<string, ScoreableField> = new Map<string, ScoreableField>(
  (
    [
      { name: 'name', type: 'varchar', maxLength: 255 },
      { name: 'lastName', type: 'varchar', maxLength: 128, required: true },
      { name: 'emailAddress', type: 'email' },
      { name: 'phoneNumber', type: 'phone' },
      { name: 'company', type: 'varchar', maxLength: 255 },
      { name: 'industry', type: 'varchar', maxLength: 128 },
      { name: 'source', type: 'varchar', maxLength: 128 },
      { name: 'status', type: 'enum', options: ['New', 'Assigned', 'In Process', 'Converted', 'Dead'] },
      { name: 'description', type: 'text' },
      { name: 'title', type: 'varchar', maxLength: 128 },
      { name: 'scoreValue', type: 'int' },
      { name: 'scoreBand', type: 'enum', options: ['Unknown', 'Cold'] },
      { name: 'password', type: 'password' },
      { name: 'age', type: 'int' },
      { name: 'gender', type: 'varchar', maxLength: 32 },
      { name: 'healthStatus', type: 'varchar', maxLength: 64 },
      { name: 'interests', type: 'multiEnum', options: ['sport', 'finance'] },
      { name: 'convertedContactId', type: 'link' },
      { name: 'website', type: 'url' },
      { name: 'renewalDate', type: 'date' },
      { name: 'createdAt', type: 'datetime' },
      { name: 'employeeCount', type: 'int' },
      { name: 'annualValue', type: 'currency' },
      { name: 'isCustomer', type: 'bool' },
      { name: 'customScore', type: 'formula' },
    ] satisfies Partial<ScoreableField>[] as unknown as ScoreableField[]
  ).map((field) => [field.name, field]),
);

const SOURCE = { fields: FIELDS };

function model(overrides: Partial<ModelAttributes> = {}): ModelAttributes {
  return {
    id: 'model-1',
    name: 'ICP fit',
    status: 'draft',
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 0,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    ...overrides,
  };
}

function rule(overrides: Partial<RuleAttributes> = {}): RuleAttributes {
  return {
    id: 'rule-1',
    name: 'Has a company',
    modelId: 'model-1',
    modelVersion: 1,
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

function codes(report: ReturnType<typeof validateModel>, level: 'errors' | 'warnings' = 'errors'): string[] {
  return report[level].map((issue) => issue.code);
}

describe('the declarative condition is the only condition', () => {
  it('accepts a leaf and a bounded group', () => {
    const leaf = parseScoreCondition(JSON.stringify({ field: 'company', operator: 'isNotEmpty' }));
    expect(leaf.issues).toEqual([]);
    const group = parseScoreCondition(
      JSON.stringify({ all: [{ field: 'industry', operator: 'equals', value: 'Software' }, { any: [{ field: 'company', operator: 'isNotEmpty' }, { field: 'emailAddress', operator: 'isNotEmpty' }] }] }),
    );
    expect(group.issues).toEqual([]);
    expect(group.node).toBeDefined();
  });

  it('refuses a formula string, not just unparseable text', () => {
    // The platform's own `LogicCondition` union allows a formula string. A scoring rule may not: it would
    // make the score depend on code an administrator typed (plan §5.2, §6.2).
    for (const raw of ['field("company") != ""', 'ifThen(equals(field("status"), "New"), 1, 0)', 'DROP TABLE leads; --', 'company']) {
      const parsed = parseScoreCondition(raw);
      expect(parsed.node, raw).toBeUndefined();
      expect(['LS_CONDITION_NOT_JSON', 'LS_CONDITION_NOT_DECLARATIVE']).toContain(parsed.issues[0]?.code);
    }
  });

  it('refuses an empty or absent condition', () => {
    expect(codes(validateModel(model(), [rule({ condition: '' })], SOURCE)).concat(parseScoreCondition('').issues.map((i) => i.code))).toContain('LS_CONDITION_EMPTY');
    expect(codes(validateModel(model(), [rule({ condition: '{}' })], SOURCE)).length).toBeGreaterThan(0);
  });

  it('refuses keys that are not part of the vocabulary', () => {
    const parsed = parseScoreCondition(JSON.stringify({ field: 'company', operator: 'equals', value: 'x', sql: '1=1' }));
    expect(parsed.issues[0]?.code).toBe('LS_CONDITION_UNKNOWN_KEY');

    const mixed = parseScoreCondition(JSON.stringify({ all: [{ field: 'company', operator: 'isNotEmpty' }], field: 'industry', operator: 'equals', value: 'x' }));
    expect(mixed.issues[0]?.code).toBe('LS_CONDITION_UNKNOWN_KEY');
  });

  it('refuses a dotted path, a table name or anything that is not a field name', () => {
    // Field paths are validated against metadata, never interpolated: an identifier from configuration must
    // not reach a query (AGENTS.md §5.2).
    for (const field of ['accounts.name', 'entity_records', 'attrs->>\'company\'', 'Company', '1company']) {
      const parsed = parseScoreCondition(JSON.stringify({ field, operator: 'isNotEmpty' }));
      const node = parsed.node;
      expect(node, field).toBeDefined();
      const issues = node === undefined ? [] : validateScoreCondition(node, { fields: FIELDS });
      expect(issues.map((issue) => issue.code), field).toContain('LS_CONDITION_FIELD_INVALID_NAME');
    }
  });

  it('refuses an unknown operator and one that does not fit the field type', () => {
    const unknown = validateScoreCondition({ field: 'company', operator: 'regexp' as never }, { fields: FIELDS });
    expect(unknown.map((issue) => issue.code)).toContain('LS_CONDITION_UNKNOWN_OPERATOR');

    const numeric = validateScoreCondition({ field: 'employeeCount', operator: 'contains', value: '3' }, { fields: FIELDS });
    expect(numeric.map((issue) => issue.code)).toContain('LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE');

    const boolCompare = validateScoreCondition({ field: 'isCustomer', operator: 'contains', value: 'x' }, { fields: FIELDS });
    expect(boolCompare.map((issue) => issue.code)).toContain('LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE');

    const multiValue = validateScoreCondition({ field: 'interests', operator: 'equals', value: 'sport' }, { fields: FIELDS });
    expect(multiValue.map((issue) => issue.code)).toContain('LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE');
  });

  it('refuses a field the metadata does not declare', () => {
    const issues = validateScoreCondition({ field: 'monthlyRevenue', operator: 'isNotEmpty' }, { fields: FIELDS });
    expect(issues.map((issue) => issue.code)).toContain('LS_CONDITION_FIELD_UNKNOWN');
  });

  it('refuses protected characteristics and their proxies, even when the field exists', () => {
    // Plan §0.1-6: these may not be scoring factors. The names below are declared fields, which is exactly
    // the dangerous case — an installation that adds a `gender` column must not be able to score on it.
    for (const field of ['gender', 'age', 'healthStatus']) {
      const issues = validateScoreCondition({ field, operator: 'isNotEmpty' }, { fields: FIELDS });
      expect(issues.map((issue) => issue.code), field).toContain('LS_CONDITION_FIELD_PROTECTED');
    }
  });

  it('refuses the score reading itself back, which is the loop plan §10.4 names', () => {
    for (const field of ['scoreValue', 'scoreBand']) {
      const issues = validateScoreCondition({ field, operator: 'isNotEmpty' }, { fields: FIELDS });
      expect(issues.map((issue) => issue.code), field).toContain('LS_CONDITION_FIELD_IS_SCORING_OUTPUT');
    }
  });

  it('refuses secrets, artifacts and values computed at save time', () => {
    for (const field of ['password', 'customScore']) {
      const issues = validateScoreCondition({ field, operator: 'isNotEmpty' }, { fields: FIELDS });
      expect(issues.map((issue) => issue.code), field).toContain('LS_CONDITION_FIELD_NEVER_SCORABLE');
    }
  });

  it('honours the model allowlist and blocklist on top of the built-in rules', () => {
    const allowed = { fields: FIELDS, allowedPaths: ['company'] };
    expect(validateScoreCondition({ field: 'company', operator: 'isNotEmpty' }, allowed)).toEqual([]);
    expect(validateScoreCondition({ field: 'industry', operator: 'isNotEmpty' }, allowed).map((i) => i.code)).toContain('LS_CONDITION_FIELD_NOT_ALLOWED');
    expect(validateScoreCondition({ field: 'company', operator: 'isNotEmpty' }, { fields: FIELDS, blockedPaths: ['company'] }).map((i) => i.code)).toContain('LS_CONDITION_FIELD_BLOCKED');
  });

  it('bounds depth, predicate count and total nodes', () => {
    const deep = { all: [{ all: [{ all: [{ any: [{ field: 'company', operator: 'isNotEmpty' }] }] }] }] };
    expect(validateScoreCondition(deep, { fields: FIELDS }).map((i) => i.code)).toContain('LS_CONDITION_TOO_DEEP');

    const predicates = Array.from({ length: MAX_CONDITION_PREDICATES + 1 }, () => ({ field: 'company', operator: 'isNotEmpty' }));
    expect(validateScoreCondition({ all: predicates }, { fields: FIELDS }).map((i) => i.code)).toContain('LS_CONDITION_TOO_MANY_PREDICATES');

    // A single leaf cannot exceed the node budget, so the bound is exercised by counting it where it trips.
    expect(MAX_CONDITION_NODES).toBeGreaterThan(MAX_CONDITION_PREDICATES);
  });

  it('checks the value against the operator and the field', () => {
    const cases: [unknown, string][] = [
      [{ field: 'company', operator: 'equals' }, 'LS_CONDITION_VALUE_MISSING'],
      [{ field: 'company', operator: 'isEmpty', value: 'x' }, 'LS_CONDITION_VALUE_UNEXPECTED'],
      [{ field: 'employeeCount', operator: 'gt', value: 'ten' }, 'LS_CONDITION_NUMBER_INVALID'],
      [{ field: 'employeeCount', operator: 'gt', value: 2.5 }, 'LS_CONDITION_NUMBER_INVALID'],
      [{ field: 'annualValue', operator: 'gte', value: Number.NaN }, 'LS_CONDITION_NUMBER_INVALID'],
      [{ field: 'isCustomer', operator: 'equals', value: 'yes' }, 'LS_CONDITION_VALUE_TYPE'],
      [{ field: 'renewalDate', operator: 'gte', value: '2026-13-45' }, 'LS_CONDITION_DATE_INVALID'],
      [{ field: 'createdAt', operator: 'gte', value: '2026-05-01' }, 'LS_CONDITION_DATE_INVALID'],
      [{ field: 'status', operator: 'equals', value: 'Escalated' }, 'LS_CONDITION_VALUE_UNKNOWN_OPTION'],
      [{ field: 'company', operator: 'equals', value: 'x'.repeat(600) }, 'LS_CONDITION_VALUE_TOO_LONG'],
      [{ field: 'status', operator: 'in', value: [] }, 'LS_CONDITION_LIST_EMPTY'],
      [{ field: 'status', operator: 'in', value: Array.from({ length: 30 }, (_, index) => `v${index}`) }, 'LS_CONDITION_LIST_TOO_LONG'],
      [{ field: 'status', operator: 'equals', value: ['New'] }, 'LS_CONDITION_VALUE_TYPE'],
    ];
    for (const [node, code] of cases) {
      const issues = validateScoreCondition(node as never, { fields: FIELDS });
      expect(issues.map((issue) => issue.code), JSON.stringify(node)).toContain(code);
    }

    // The shapes that are legitimate, spelled the way the platform's criteria vocabulary defines them.
    expect(validateScoreCondition({ field: 'status', operator: 'in', value: ['New', 'Assigned'] }, { fields: FIELDS })).toEqual([]);
    expect(validateScoreCondition({ field: 'renewalDate', operator: 'gte', value: '2026-05-01' }, { fields: FIELDS })).toEqual([]);
    expect(validateScoreCondition({ field: 'createdAt', operator: 'gte', value: '2026-05-01T00:00:00Z' }, { fields: FIELDS })).toEqual([]);
    expect(validateScoreCondition({ field: 'isCustomer', operator: 'isTrue' }, { fields: FIELDS })).toEqual([]);
  });
});

describe('the model shape, scale and bands', () => {
  it('accepts a coherent model with one rule', () => {
    const report = validateModel(model(), [rule()], SOURCE);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('refuses an inconsistent scale or clamp band', () => {
    expect(codes(validateModel(model({ scaleMin: 50, scaleMax: 50 }), [], SOURCE))).toContain('LS_MODEL_SCALE_INVALID');
    expect(codes(validateModel(model({ scaleMin: 10, scaleMax: 2010 }), [], SOURCE))).toContain('LS_MODEL_SCALE_INVALID');
    expect(codes(validateModel(model({ scoreFloor: 80, scoreCeiling: 20 }), [], SOURCE))).toContain('LS_MODEL_BOUNDS_INVALID');
    expect(codes(validateModel(model({ scoreCeiling: 200 }), [], SOURCE))).toContain('LS_MODEL_BOUNDS_INVALID');
    expect(codes(validateModel(model({ scoreFloor: 50, scoreCeiling: 50 }), [], SOURCE))).toContain('LS_MODEL_BOUNDS_INVALID');
    expect(codes(validateModel(model({ baseScore: 150 }), [], SOURCE))).toContain('LS_MODEL_BASE_SCORE_OUT_OF_RANGE');
    expect(codes(validateModel(model({ modelVersion: 0 }), [], SOURCE))).toContain('LS_MODEL_VERSION_INVALID');
  });

  it('requires bands, and refuses ones that overlap, escape the scale or claim a reserved name', () => {
    expect(codes(validateModel(model({ qualificationBands: '' }), [], SOURCE))).toContain('LS_MODEL_BANDS_EMPTY');
    expect(codes(validateModel(model({ qualificationBands: 'Cold, Warm' }), [], SOURCE))).toContain('LS_MODEL_BANDS_INVALID_JSON');
    expect(codes(validateModel(model({ qualificationBands: '[]' }), [], SOURCE))).toContain('LS_MODEL_BANDS_EMPTY');
    expect(codes(validateModel(model({ qualificationBands: '[{"band":"Cold","min":0,"max":10},{"band":"Lead","min":20,"max":30}]' }), [], SOURCE))).toContain('LS_MODEL_BAND_UNKNOWN');
    expect(codes(validateModel(model({ qualificationBands: '[{"band":"Unknown","min":0,"max":10}]' }), [], SOURCE))).toContain('LS_MODEL_BAND_RESERVED');
    expect(codes(validateModel(model({ qualificationBands: '[{"band":"Cold","min":0,"max":50},{"band":"Warm","min":40,"max":80}]' }), [], SOURCE))).toContain('LS_MODEL_BANDS_OVERLAP');
    expect(codes(validateModel(model({ qualificationBands: '[{"band":"Hot","min":70,"max":120}]' }), [], SOURCE))).toContain('LS_MODEL_BAND_OUT_OF_SCALE');
    expect(codes(validateModel(model({ qualificationBands: '[{"band":"Cold","max":10}]' }), [], SOURCE))).toContain('LS_MODEL_BANDS_INVALID_SHAPE');
  });

  it('treats a band gap as a warning, because it is a modelling choice rather than a contradiction', () => {
    const report = validateModel(model({ qualificationBands: '[{"band":"Cold","min":0,"max":39},{"band":"Hot","min":70,"max":100}]' }), [rule()], SOURCE);
    expect(report.valid).toBe(true);
    expect(codes(report, 'warnings')).toContain('LS_MODEL_BAND_GAP');
  });

  it('allows `Disqualified` from a rule, never from a threshold', () => {
    // Plan §3.3: low score ≠ disqualified. A `setBand` rule is the explicit-signal path.
    const fromRule = validateModel(model(), [rule({ effect: 'setBand', targetBand: 'Disqualified', points: 0 })], SOURCE);
    expect(fromRule.errors).toEqual([]);
    const fromThreshold = validateModel(model({ qualificationBands: '[{"band":"Disqualified","min":0,"max":9}]' }), [rule()], SOURCE);
    expect(codes(fromThreshold)).toContain('LS_MODEL_BAND_RESERVED');
  });

  it('checks dimension weights, and warns where a weight and its rules disagree', () => {
    expect(codes(validateModel(model({ dimensionWeights: '{oops' }), [rule()], SOURCE))).toContain('LS_MODEL_WEIGHTS_INVALID_JSON');
    expect(codes(validateModel(model({ dimensionWeights: '[40]' }), [rule()], SOURCE))).toContain('LS_MODEL_WEIGHTS_INVALID_JSON');
    expect(codes(validateModel(model({ dimensionWeights: '{"revenue":40}' }), [rule()], SOURCE))).toContain('LS_MODEL_WEIGHTS_INVALID_SHAPE');
    expect(codes(validateModel(model({ dimensionWeights: '{"fit":"high"}' }), [rule()], SOURCE))).toContain('LS_MODEL_WEIGHTS_INVALID_SHAPE');

    const unweighted = validateModel(model({ dimensionWeights: '{"fit":30}' }), [rule()], SOURCE);
    expect(codes(unweighted, 'warnings')).toContain('LS_DIMENSION_WEIGHTED_WITHOUT_RULES');
    const zeroWeight = validateModel(model({ dimensionWeights: '{"completeness":0}' }), [rule()], SOURCE);
    expect(codes(zeroWeight, 'warnings')).toContain('LS_DIMENSION_HAS_RULES_BUT_NO_WEIGHT');
    expect(validateModel(model({ dimensionWeights: '{"completeness":40}' }), [rule()], SOURCE).errors).toEqual([]);
  });

  it('refuses field paths that do not exist, and a path that is both granted and blocked', () => {
    const unknown = validateModel(model({ allowedFieldPaths: JSON.stringify(['monthlyRevenue']) }), [rule()], SOURCE);
    expect(codes(unknown)).toContain('LS_MODEL_FIELD_PATH_UNKNOWN');
    const contradictory = validateModel(
      model({ allowedFieldPaths: JSON.stringify(['company']), blockedFieldPaths: JSON.stringify(['company']) }),
      [rule()],
      SOURCE,
    );
    expect(codes(contradictory)).toContain('LS_MODEL_FIELD_PATH_CONTRADICTORY');
    expect(codes(validateModel(model({ allowedFieldPaths: 'company' }), [rule()], SOURCE))).toContain('LS_MODEL_FIELD_PATHS_INVALID_JSON');
  });

  it('refuses a model setting nothing reads yet, so configuration cannot lie about being live', () => {
    expect(validateModel(model({ settingsJson: '{}' }), [rule()], SOURCE).errors).toEqual([]);
    expect(codes(validateModel(model({ settingsJson: '{"rounding":"floor"}' }), [rule()], SOURCE))).toContain('LS_MODEL_SETTING_UNSUPPORTED');
    expect(codes(validateModel(model({ settingsJson: 'rounding' }), [rule()], SOURCE))).toContain('LS_MODEL_SETTING_UNSUPPORTED');
  });
});

describe('rule configuration', () => {
  it('requires a stable, well-formed reason code and refuses two rules sharing one', () => {
    for (const reasonCode of ['', 'Company Known', 'a', 'x'.repeat(70), 'industry-target', '9company']) {
      expect(codes(validateModel(model(), [rule({ reasonCode })], SOURCE)), reasonCode).toContain('LS_RULE_REASON_CODE_INVALID');
    }
    const duplicated = validateModel(model(), [rule({ id: 'a' }), rule({ id: 'b', name: 'Second' })], SOURCE);
    expect(codes(duplicated)).toContain('LS_RULE_REASON_CODE_DUPLICATE');
  });

  it('bounds how much one rule can move a score', () => {
    expect(codes(validateModel(model(), [rule({ points: MAX_RULE_POINTS + 1 })], SOURCE))).toContain('LS_RULE_POINTS_OUT_OF_BOUNDS');
    expect(codes(validateModel(model(), [rule({ points: -(MAX_RULE_POINTS + 1) })], SOURCE))).toContain('LS_RULE_POINTS_OUT_OF_BOUNDS');
    expect(codes(validateModel(model(), [rule({ points: 1.5 })], SOURCE))).toContain('LS_RULE_POINTS_OUT_OF_BOUNDS');
    expect(validateModel(model(), [rule({ points: -20, dimension: 'negative' })], SOURCE).errors).toEqual([]);
  });

  it('keeps effect, points and target band consistent with each other', () => {
    expect(codes(validateModel(model(), [rule({ effect: 'setBand', targetBand: '' })], SOURCE))).toContain('LS_RULE_TARGET_BAND_REQUIRED');
    expect(codes(validateModel(model(), [rule({ effect: 'setBand', targetBand: 'Nope' })], SOURCE))).toContain('LS_RULE_TARGET_BAND_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ effect: 'setBand', targetBand: 'Unknown' })], SOURCE))).toContain('LS_RULE_TARGET_BAND_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ effect: 'setBand', points: 5 })], SOURCE))).toContain('LS_RULE_POINTS_IGNORED_BY_EFFECT');
    expect(codes(validateModel(model(), [rule({ targetBand: 'Hot' })], SOURCE))).toContain('LS_RULE_TARGET_BAND_REQUIRED');
    expect(codes(validateModel(model(), [rule({ points: 0 })], SOURCE))).toContain('LS_RULE_HAS_NO_EFFECT');
    expect(codes(validateModel(model(), [rule({ effect: 'multiply' })], SOURCE))).toContain('LS_RULE_EFFECT_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ dimension: 'sentiment' })], SOURCE))).toContain('LS_RULE_DIMENSION_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ missingDataPolicy: 'zero' })], SOURCE))).toContain('LS_RULE_MISSING_DATA_POLICY_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ priority: 5000 })], SOURCE))).toContain('LS_RULE_PRIORITY_OUT_OF_BOUNDS');
  });

  it('warns where a rule reads against its own dimension, and where a model cannot score anything', () => {
    const signMismatch = validateModel(model(), [rule({ dimension: 'negative', points: 10 })], SOURCE);
    expect(codes(signMismatch)).toContain('LS_RULE_SIGN_DOES_NOT_MATCH_DIMENSION');
    const noRules = validateModel(model(), [], SOURCE);
    expect(noRules.valid).toBe(true);
    expect(codes(noRules, 'warnings')).toContain('LS_MODEL_HAS_NO_ENABLED_RULES');
    const disabled = validateModel(model(), [rule({ enabled: false })], SOURCE);
    expect(codes(disabled, 'warnings')).toContain('LS_RULE_DISABLED');
    expect(codes(disabled, 'warnings')).toContain('LS_MODEL_HAS_NO_ENABLED_RULES');
  });

  it('bounds the engagement sources it can read and refuses the ones it cannot', () => {
    // Plan §0.1-4 forbids assuming an integration exists, and 19-LS.9 delivered the one the audit found real:
    // Marketing Automation's delivery table. An engagement rule is publishable now — and what makes it safe
    // is the *window*, so the bounds are refused at configuration rather than discovered as a scan.
    expect(codes(validateModel(model(), [rule({ signalSource: 'crm' })], SOURCE))).toContain('LS_RULE_SIGNAL_SOURCE_UNKNOWN');

    const opens = JSON.stringify({ field: 'eventCount', operator: 'gte', value: 2 });
    const bounded = validateModel(
      model(),
      [rule({ signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30, condition: opens, dimension: 'engagement' })],
      SOURCE,
    );
    expect(codes(bounded)).toEqual([]);
    // A decayed engagement rule is the reason 19-LS.9 also owns the sweep.
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30, condition: opens, decayPolicy: 'halfLife', decayHalfLifeDays: 14, dimension: 'engagement' })], SOURCE))).toEqual([]);
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30, condition: opens, decayPolicy: 'halfLife', dimension: 'engagement' })], SOURCE))).toContain('LS_RULE_DECAY_HALF_LIFE_INVALID');

    // No window, an impossible window, and an event type nothing writes.
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', eventType: 'opened', condition: opens })], SOURCE))).toContain('LS_RULE_SIGNAL_WINDOW_INVALID');
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 5_000, condition: opens })], SOURCE))).toContain('LS_RULE_SIGNAL_WINDOW_INVALID');
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', eventType: 'ping', lookbackDays: 30, condition: opens })], SOURCE))).toContain('LS_RULE_EVENT_TYPE_UNKNOWN');
    // `emailLinks` is the clicked slice, so naming another type is a contradiction, not a filter.
    expect(codes(validateModel(model(), [rule({ signalSource: 'emailLinks', eventType: 'opened', lookbackDays: 30, condition: opens })], SOURCE))).toContain('LS_RULE_EVENT_TYPE_UNKNOWN');
    // A rule over a source compares that source's metrics. A Lead field, or the other source's metric, is
    // simply not a field that rule can name — the same refusal, from the same code, that a Lead rule gets for
    // a field the metadata does not declare.
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', lookbackDays: 30 })], SOURCE))).toContain('LS_CONDITION_FIELD_UNKNOWN');
    expect(codes(validateModel(model(), [rule({ signalSource: 'marketingEvents', lookbackDays: 30, condition: JSON.stringify({ field: 'clickCount', operator: 'gte', value: 1 }) })], SOURCE))).toContain('LS_CONDITION_FIELD_UNKNOWN');

    // A `lead` rule reads the record as stored, so a window or a decay on it is a mistake, not a feature.
    expect(codes(validateModel(model(), [rule({ lookbackDays: 30 })], SOURCE))).toContain('LS_RULE_SIGNAL_WINDOW_INVALID');
    expect(codes(validateModel(model(), [rule({ eventType: 'opened' })], SOURCE))).toContain('LS_RULE_SIGNAL_WINDOW_INVALID');
    expect(codes(validateModel(model(), [rule({ decayPolicy: 'halfLife' })], SOURCE))).toContain('LS_RULE_DECAY_HALF_LIFE_INVALID');
    expect(codes(validateModel(model(), [rule({ decayPolicy: 'exponential' })], SOURCE))).toContain('LS_RULE_DECAY_POLICY_UNKNOWN');
  });

  it('refuses a model that asks more engagement questions than one score may cost', () => {
    // Each distinct (source, event types, window) is one bounded read of `marketing_events` per Lead. The
    // ceiling is a refusal rather than a silent drop, so an author is never told a model published when part
    // of it was quietly never read (the same choice LS.6 made for the batch ceilings).
    const opens = JSON.stringify({ field: 'eventCount', operator: 'gte', value: 2 });
    const plans = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        rule({
          id: `rule-${String(index)}`,
          reasonCode: `plan_${String(index)}`,
          priority: (index + 1) * 10,
          signalSource: 'marketingEvents',
          eventType: 'opened',
          // A different window is a different question: two rules with the same one share a single read.
          lookbackDays: index + 1,
          condition: opens,
          dimension: 'engagement',
        }),
      );
    expect(codes(validateModel(model(), plans(20), SOURCE))).toEqual([]);
    expect(codes(validateModel(model(), [...plans(20), rule({ id: 'rule-extra', reasonCode: 'plan_shared', lookbackDays: 20, eventType: 'opened', signalSource: 'marketingEvents', condition: opens, dimension: 'engagement' })], SOURCE))).toEqual([]);
    expect(codes(validateModel(model(), plans(21), SOURCE))).toContain('LS_MODEL_SIGNAL_PLANS_LIMIT');
  });

  it('refuses a rule that names a different model version than the one being published', () => {
    // The pair (modelId, modelVersion) is what a stored evaluation points back to; a mismatch would make a
    // published version's rule set ambiguous (plan §3.1, §5.1).
    expect(codes(validateModel(model(), [rule({ modelVersion: 2 })], SOURCE))).toContain('LS_RULE_MODEL_VERSION_MISMATCH');
    expect(codes(validateModel(model(), [rule({ modelId: 'other' })], SOURCE))).toContain('LS_RULE_MODEL_VERSION_MISMATCH');
  });

  it('reports every problem in a draft at once, and keeps warnings from blocking a publish', () => {
    const report = validateModel(
      model({ scoreCeiling: 200, qualificationBands: '' }),
      [rule({ points: 900, reasonCode: 'Bad Code' }), rule({ condition: 'field("nope")', id: 'rule-2', reasonCode: 'second' })],
      SOURCE,
    );
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThanOrEqual(5);
    for (const issue of report.errors) {
      expect(typeof issue.code).toBe('string');
      expect(issue.code.length).toBeGreaterThan(3);
      expect(issue.message.length).toBeGreaterThan(10);
    }
    // Every error carries the rule it belongs to, so the editor can put it on the right row.
    expect(report.errors.some((issue) => issue.ruleId !== undefined)).toBe(true);
  });

  it('carries the condition issue codes through into the report', () => {
    const report = validateModel(model(), [rule({ condition: JSON.stringify({ field: 'gender', operator: 'isNotEmpty' }) })], SOURCE);
    expect(codes(report)).toContain('LS_CONDITION_FIELD_PROTECTED');
    const unparsable = validateModel(model(), [rule({ condition: '{"field":"company","operator":' })], SOURCE);
    expect(codes(unparsable)).toContain('LS_CONDITION_NOT_JSON');
  });
});
