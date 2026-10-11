import { describe, expect, it } from 'vitest';

import { FormulaEngine } from '../engine/index.js';
import { criteriaToAst, DynamicLogicEvaluator, type DynamicLogicRule, type FieldLogicState, isEmptyLogicValue, LogicDefinitionError, parseDynamicLogic, readFieldsOf, validateDynamicLogic } from './index.js';

const engine = new FormulaEngine();
const evaluator = new DynamicLogicEvaluator(engine);

function states(...names: string[]): Record<string, FieldLogicState> {
  const record: Record<string, FieldLogicState> = {};
  for (const name of names) record[name] = { visible: true, required: false, readOnly: false };
  return record;
}

function run(rules: DynamicLogicRule[], record: Record<string, unknown>, fields: Record<string, FieldLogicState>) {
  return evaluator.evaluate({ rules, fields, context: { record, now: new Date('2026-03-05T10:00:00Z') } });
}

describe('criteriaToAst', () => {
  it('compiles the PLAN §21 example into a safe AST', () => {
    const ast = criteriaToAst({ field: 'type', operator: 'equals', value: 'Customer' });
    expect(ast).toMatchObject({ kind: 'binary', operator: '==', left: { kind: 'call', name: 'field' } });
  });

  it('combines all/any/not nodes', () => {
    const ast = criteriaToAst({
      all: [{ field: 'type', operator: 'equals', value: 'Customer' }, { any: [{ field: 'revenue', operator: 'gt', value: 100 }, { not: { field: 'active', operator: 'isTrue' } }] }],
    });
    expect(engine.evaluateAst(ast, { record: { type: 'Customer', revenue: 150, active: false } })).toBe(true);
    expect(engine.evaluateAst(ast, { record: { type: 'Lead', revenue: 150, active: false } })).toBe(false);
  });

  it('rejects valueless operators and unknown shapes', () => {
    expect(() => criteriaToAst({ field: 'type', operator: 'contains' })).toThrowError(LogicDefinitionError);
    expect(() => criteriaToAst({ field: 'bad-name', operator: 'equals', value: 1 })).toThrowError(LogicDefinitionError);
    expect(() => criteriaToAst({ all: [] })).toThrowError(LogicDefinitionError);
  });
});

describe('DynamicLogicEvaluator', () => {
  it('makes a field required and visible only when the condition matches', () => {
    const rules: DynamicLogicRule[] = [{ when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setRequired: ['taxId'], hide: ['industry'] } }];
    const fields = states('type', 'taxId', 'industry');

    const matching = run(rules, { type: 'Customer' }, fields);
    expect(matching.fields.taxId?.required).toBe(true);
    expect(matching.fields.industry?.visible).toBe(false);
    expect(matching.matched).toEqual(['rule #1']);

    const other = run(rules, { type: 'Lead' }, fields);
    expect(other.fields.taxId?.required).toBe(false);
    expect(other.fields.industry?.visible).toBe(true);
  });

  it('accepts formula-text conditions as well as criteria', () => {
    const rules: DynamicLogicRule[] = [{ name: 'big', when: "field('revenue') > 1000 && isNotEmpty(field('manager'))", then: { setReadOnly: ['revenue'] } }];
    expect(run(rules, { revenue: 2000, manager: 'Ann' }, states('revenue', 'manager')).fields.revenue?.readOnly).toBe(true);
    expect(run(rules, { revenue: 200, manager: 'Ann' }, states('revenue', 'manager')).fields.revenue?.readOnly).toBe(false);
  });

  it('computes values for later rules and keeps later rules winning', () => {
    const rules: DynamicLogicRule[] = [
      { name: 'first', when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setReadOnly: ['level'], setValues: { level: "concat('T-', number(field('revenue')) > 100 ? 'high' : 'low')" } } },
      { name: 'second', when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { show: ['level'] } },
    ];
    const result = run(rules, { type: 'Customer', revenue: 500 }, states('type', 'level'));
    expect(result.values.level).toBe('T-high');
    expect(result.fields.level?.readOnly).toBe(true);
    expect(result.fields.level?.visible).toBe(true);
  });

  it('reports business-condition errors', () => {
    const rules: DynamicLogicRule[] = [{ name: 'window', when: { field: 'closeDate', operator: 'lt', value: '2026-01-01' }, then: { error: { message: 'Close date must be in the future.', fields: ['closeDate'] } } }];
    const result = run(rules, { closeDate: '2025-12-31' }, states('closeDate'));
    expect(result.errors[0]).toMatchObject({ rule: 'window', message: 'Close date must be in the future.', fields: ['closeDate'] });
    expect(run(rules, { closeDate: '2026-06-01' }, states('closeDate')).errors).toEqual([]);
  });

  it('tracks panel visibility and skipped rules', () => {
    const rules: DynamicLogicRule[] = [
      { name: 'off', disabled: true, when: 'true', then: { hidePanels: ['billing'] } },
      { name: 'on', when: 'true', then: { hidePanels: ['billing'], showPanels: ['shipping'] } },
    ];
    const result = evaluator.evaluate({ rules, fields: states('a'), panels: ['billing', 'shipping'], context: { record: {} } });
    expect(result.panels.billing).toBe(false);
    expect(result.panels.shipping).toBe(true);
    expect(result.matched).toEqual(['on']);
  });

  it('fails closed: a broken condition is reported, never silently true', () => {
    const rules: DynamicLogicRule[] = [{ name: 'broken', when: "concatName(field('type'))", then: { setRequired: ['taxId'] } }];
    const result = run(rules, { taxId: null }, states('taxId'));
    expect(result.failures[0]).toMatchObject({ rule: 'broken' });
    expect(result.fields.taxId?.required).toBe(false);
  });

  it('reports setValues failures per field', () => {
    const rules: DynamicLogicRule[] = [{ name: 'v', when: 'true', then: { setValues: { amount: "number('abc')" } } }];
    const result = run(rules, { amount: 1 }, states('amount'));
    expect(result.failures[0]?.field).toBe('amount');
    expect(result.values.amount).toBeUndefined();
  });
});

describe('validateDynamicLogic', () => {
  const known = new Set(['type', 'taxId', 'revenue', 'level']);

  it('accepts well-formed rules', () => {
    const rules: DynamicLogicRule[] = [{ name: 'ok', when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setRequired: ['taxId'], setValues: { level: 'field("type")' } } }];
    expect(validateDynamicLogic(rules, engine, known)).toEqual([]);
  });

  it('rejects bad formulas and unknown fields', () => {
    const rules: DynamicLogicRule[] = [
      { name: 'syntax', when: 'field("type" ==', then: { setRequired: ['taxId'] } },
      { name: 'ghost', when: { field: 'nope', operator: 'equals', value: 1 }, then: { hide: ['alsoMissing'] } },
      { name: 'formula', when: "field('type') == 'x'", then: { setValues: { taxId: "unknownFn('y')" } } },
    ];
    const problems = validateDynamicLogic(rules, engine, known);
    expect(problems.some((problem) => problem.startsWith('syntax:'))).toBe(true);
    expect(problems.some((problem) => problem.includes('unknown field "nope"'))).toBe(true);
    expect(problems.some((problem) => problem.includes('unknown field "alsoMissing"'))).toBe(true);
    expect(problems.some((problem) => problem.includes('value formula for "taxId"'))).toBe(true);
  });

  it('requires a message on error rules', () => {
    expect(validateDynamicLogic([{ when: 'true', then: { error: { message: '  ' } } }], engine, known)).toHaveLength(1);
  });

  it('finds field reads inside formula text', () => {
    expect(readFieldsOf("field('a') == 1 && field( 'b' ) == 2 && field('a') == 3")).toEqual(['a', 'b']);
  });

  it('treats empty values consistently', () => {
    expect(isEmptyLogicValue(null)).toBe(true);
    expect(isEmptyLogicValue('')).toBe(true);
    expect(isEmptyLogicValue([])).toBe(true);
    expect(isEmptyLogicValue(0)).toBe(false);
    expect(isEmptyLogicValue('x')).toBe(false);
  });
});

describe('parseDynamicLogic', () => {
  it('accepts both the { rules } wrapper and a bare array', () => {
    const rule = { name: 'tax', when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setRequired: ['taxId'] } };
    expect(parseDynamicLogic({ rules: [rule] }).rules).toHaveLength(1);
    expect(parseDynamicLogic([rule]).rules).toHaveLength(1);
    expect(parseDynamicLogic(undefined)).toEqual({ rules: [], problems: [] });
  });

  it('keeps the parsed rule usable by the evaluator', () => {
    const parsed = parseDynamicLogic({ rules: [{ when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setRequired: ['taxId'] } }] });
    expect(parsed.problems).toEqual([]);
    const result = run(parsed.rules, { type: 'Customer' }, states('taxId'));
    expect(result.fields.taxId?.required).toBe(true);
  });

  it('reports structural problems instead of throwing', () => {
    const parsed = parseDynamicLogic({
      rules: [
        { when: '   ', then: {} },
        { when: { field: 'a' }, then: {} },
        { when: { all: [{ field: 'a', operator: 'nope', value: 1 }] }, then: {} },
        { when: 'true', then: { show: 'nope' } },
        { when: 'true', then: { setValues: { level: 42 } } },
        { when: 'true', then: { error: true } },
        'not-an-object',
      ],
    });
    expect(parsed.rules).toHaveLength(0);
    expect(parsed.problems.length).toBe(7);
    expect(parsed.problems.some((problem) => problem.includes('unknown criteria operator'))).toBe(true);
    expect(parsed.problems.some((problem) => problem.includes('"show" must be a list'))).toBe(true);
  });

  it('rejects a malformed section', () => {
    expect(parseDynamicLogic({ rules: 'nope' }).problems[0]).toContain('dynamicLogic must be');
    expect(parseDynamicLogic('nope').problems[0]).toContain('dynamicLogic must be');
  });
});
