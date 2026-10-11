import type { AstNode } from '../ast/index.js';
import { binaryNode, callNode, literal } from '../ast/index.js';
import type { FormulaContext, FormulaEngine } from '../engine/index.js';
import { FormulaError } from '../errors/index.js';
import type { FormulaValue } from '../value/index.js';
import { toBool } from '../value/index.js';

/** Declarative comparison used by the Entity Manager UI — the PLAN §21 `{field, operator, value}` shape. */
export type CriteriaOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse';

export const CRITERIA_OPERATORS: readonly CriteriaOperator[] = [
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

const VALUELESS_OPERATORS: ReadonlySet<CriteriaOperator> = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

export interface CriteriaCondition {
  field: string;
  operator: CriteriaOperator;
  value?: unknown;
}

export type ConditionNode = CriteriaCondition | { all: ConditionNode[] } | { any: ConditionNode[] } | { not: ConditionNode };

/** A rule condition is either a formula string or a structured criteria tree. */
export type LogicCondition = string | ConditionNode;

export interface LogicActions {
  show?: string[] | undefined;
  hide?: string[] | undefined;
  setRequired?: string[] | undefined;
  setReadOnly?: string[] | undefined;
  /** Field name -> expression producing the value the field should take. */
  setValues?: Record<string, string> | undefined;
  showPanels?: string[] | undefined;
  hidePanels?: string[] | undefined;
  /** Business condition: when it matches, the record must not be saved. */
  error?: { message: string; fields?: string[] | undefined } | undefined;
}

export interface DynamicLogicRule {
  name?: string | undefined;
  description?: string | undefined;
  disabled?: boolean | undefined;
  when: LogicCondition;
  then: LogicActions;
}

export interface FieldLogicState {
  visible: boolean;
  required: boolean;
  readOnly: boolean;
}

export interface LogicFailure {
  rule: string;
  field?: string | undefined;
  reason: string;
}

export interface DynamicLogicResult {
  fields: Record<string, FieldLogicState>;
  panels: Record<string, boolean>;
  values: Record<string, FormulaValue>;
  errors: { rule: string; message: string; fields: string[] }[];
  matched: string[];
  failures: LogicFailure[];
}

const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const MAX_CRITERIA_NODES = 120;

export class LogicDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogicDefinitionError';
  }
}

function isCriteriaLeaf(node: ConditionNode): node is CriteriaCondition {
  return 'field' in node && 'operator' in node;
}

function fieldRef(name: string): AstNode {
  if (!FIELD_NAME.test(name)) throw new LogicDefinitionError(`Invalid field name "${name}" in a dynamic logic condition.`);
  return callNode('field', [literal(name)]);
}

function scalarLiteral(value: unknown): AstNode {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return literal(value);
  throw new LogicDefinitionError('Criteria values must be a string, number, boolean or null.');
}

function arrayLiteral(value: unknown): AstNode {
  if (!Array.isArray(value)) return { kind: 'array', elements: [scalarLiteral(value)] };
  return { kind: 'array', elements: value.map((item) => scalarLiteral(item)) };
}

/** Criteria trees compile into the same AST as formula text, so a single evaluator serves both. */
export function criteriaToAst(node: ConditionNode, budget = { nodes: 0 }): AstNode {
  budget.nodes += 1;
  if (budget.nodes > MAX_CRITERIA_NODES) throw new LogicDefinitionError('Dynamic logic condition nests too deeply.');
  if ('all' in node) {
    if (!Array.isArray(node.all) || node.all.length === 0) throw new LogicDefinitionError('"all" needs at least one condition.');
    return node.all.map((child) => criteriaToAst(child, budget)).reduce((left, right) => ({ kind: 'logical', operator: '&&', left, right }));
  }
  if ('any' in node) {
    if (!Array.isArray(node.any) || node.any.length === 0) throw new LogicDefinitionError('"any" needs at least one condition.');
    return node.any.map((child) => criteriaToAst(child, budget)).reduce((left, right) => ({ kind: 'logical', operator: '||', left, right }));
  }
  if ('not' in node) return { kind: 'unary', operator: '!', operand: criteriaToAst(node.not, budget) };
  if (!isCriteriaLeaf(node)) throw new LogicDefinitionError('Unknown dynamic logic condition node.');

  if (VALUELESS_OPERATORS.has(node.operator) !== true && node.value === undefined) {
    throw new LogicDefinitionError(`Criteria operator "${node.operator}" needs a value.`);
  }
  const ref = fieldRef(node.field);
  switch (node.operator) {
    case 'equals':
      return binaryNode('==', ref, scalarLiteral(node.value ?? null));
    case 'notEquals':
      return binaryNode('!=', ref, scalarLiteral(node.value ?? null));
    case 'contains':
      return callNode('contains', [ref, scalarLiteral(node.value ?? '')]);
    case 'notContains':
      return { kind: 'unary', operator: '!', operand: callNode('contains', [ref, scalarLiteral(node.value ?? '')]) };
    case 'startsWith':
      return callNode('startsWith', [ref, scalarLiteral(node.value ?? '')]);
    case 'endsWith':
      return callNode('endsWith', [ref, scalarLiteral(node.value ?? '')]);
    case 'gt':
      return binaryNode('>', ref, scalarLiteral(node.value ?? 0));
    case 'gte':
      return binaryNode('>=', ref, scalarLiteral(node.value ?? 0));
    case 'lt':
      return binaryNode('<', ref, scalarLiteral(node.value ?? 0));
    case 'lte':
      return binaryNode('<=', ref, scalarLiteral(node.value ?? 0));
    case 'in':
      return callNode('inArray', [ref, arrayLiteral(node.value ?? [])]);
    case 'notIn':
      return { kind: 'unary', operator: '!', operand: callNode('inArray', [ref, arrayLiteral(node.value ?? [])]) };
    case 'isEmpty':
      return callNode('isEmpty', [ref]);
    case 'isNotEmpty':
      return callNode('isNotEmpty', [ref]);
    case 'isTrue':
      return callNode('bool', [ref]);
    case 'isFalse':
      return { kind: 'unary', operator: '!', operand: callNode('bool', [ref]) };
    default:
      throw new LogicDefinitionError('Unknown criteria operator.');
  }
}

function walkCriteria(node: ConditionNode, visit: (leaf: CriteriaCondition) => void): void {
  if ('all' in node) {
    for (const child of node.all) walkCriteria(child, visit);
    return;
  }
  if ('any' in node) {
    for (const child of node.any) walkCriteria(child, visit);
    return;
  }
  if ('not' in node) {
    walkCriteria(node.not, visit);
    return;
  }
  if (isCriteriaLeaf(node)) visit(node);
}

/** `field('x')` reads mentioned in a formula, used to reject typos before a rule is stored. */
export function readFieldsOf(source: string): string[] {
  const names = new Set<string>();
  const pattern = /field\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    if (match[1]) names.add(match[1]);
    match = pattern.exec(source);
  }
  return [...names];
}

function conditionFields(condition: LogicCondition): string[] {
  if (typeof condition === 'string') return readFieldsOf(condition);
  const names: string[] = [];
  walkCriteria(condition, (leaf) => names.push(leaf.field));
  return names;
}

function actionFields(rule: DynamicLogicRule): string[] {
  const names = [...(rule.then.show ?? []), ...(rule.then.hide ?? []), ...(rule.then.setRequired ?? []), ...(rule.then.setReadOnly ?? [])];
  if (rule.then.error?.fields) names.push(...rule.then.error.fields);
  return names;
}

/**
 * Checks a rule set before metadata stores it: conditions must parse, referenced fields must exist,
 * and value expressions must be formulas the sandbox accepts.
 */
export function validateDynamicLogic(rules: DynamicLogicRule[], engine: FormulaEngine, knownFields: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    const label = rule.name ?? `rule #${index + 1}`;
    if (!rule.when) problems.push(`${label}: "when" is required.`);
    else if (typeof rule.when === 'string') {
      const result = engine.validate(rule.when);
      if (!result.valid) problems.push(`${label}: condition — ${result.error ?? 'invalid formula'}`);
    } else {
      try {
        criteriaToAst(rule.when);
      } catch (error) {
        problems.push(`${label}: ${error instanceof Error ? error.message : 'invalid condition'}`);
      }
    }

    for (const field of conditionFields(rule.when)) {
      if (!knownFields.has(field)) problems.push(`${label}: condition uses unknown field "${field}".`);
    }
    for (const field of actionFields(rule)) {
      if (!knownFields.has(field)) problems.push(`${label}: action targets unknown field "${field}".`);
    }

    for (const [field, expression] of Object.entries(rule.then.setValues ?? {})) {
      if (!knownFields.has(field)) problems.push(`${label}: setValues targets unknown field "${field}".`);
      const result = engine.validate(expression);
      if (!result.valid) problems.push(`${label}: value formula for "${field}" — ${result.error ?? 'invalid formula'}`);
      for (const read of readFieldsOf(expression)) {
        if (!knownFields.has(read)) problems.push(`${label}: value formula for "${field}" reads unknown field "${read}".`);
      }
    }

    if (rule.then.error && rule.then.error.message.trim() === '') problems.push(`${label}: an error rule needs a message.`);
  });
  return problems;
}

function failureReason(error: unknown): string {
  return error instanceof FormulaError || error instanceof LogicDefinitionError ? error.message : 'Dynamic logic condition could not be evaluated.';
}

/**
 * Applies a rule set to a record state (PLAN §21). Rules run in order and later rules win. A
 * condition that cannot be evaluated is reported as a failure rather than thrown, so the caller
 * decides whether to block a write (API) or simply skip the rule (form UI).
 */
export class DynamicLogicEvaluator {
  constructor(private readonly engine: FormulaEngine) {}

  evaluate(options: {
    rules: DynamicLogicRule[];
    fields: Readonly<Record<string, FieldLogicState>>;
    panels?: readonly string[] | undefined;
    context: FormulaContext;
  }): DynamicLogicResult {
    const fields: Record<string, FieldLogicState> = {};
    for (const [name, state] of Object.entries(options.fields)) {
      fields[name] = { visible: state.visible, required: state.required, readOnly: state.readOnly };
    }
    const panels: Record<string, boolean> = {};
    for (const name of options.panels ?? []) panels[name] = true;

    const result: DynamicLogicResult = {
      fields,
      panels,
      values: {},
      errors: [],
      matched: [],
      failures: [],
    };

    options.rules.forEach((rule, index) => {
      if (rule.disabled === true) return;
      const label = rule.name ?? `rule #${index + 1}`;
      let matches: boolean;
      try {
        matches = toBool(this.valueOf(rule.when, options.context));
      } catch (error) {
        result.failures.push({ rule: label, reason: failureReason(error) });
        return;
      }
      if (!matches) return;
      result.matched.push(label);

      for (const name of rule.then.hide ?? []) if (fields[name]) fields[name].visible = false;
      for (const name of rule.then.show ?? []) if (fields[name]) fields[name].visible = true;
      for (const name of rule.then.setRequired ?? []) if (fields[name]) fields[name].required = true;
      for (const name of rule.then.setReadOnly ?? []) if (fields[name]) fields[name].readOnly = true;
      for (const name of rule.then.hidePanels ?? []) if (name in panels) panels[name] = false;
      for (const name of rule.then.showPanels ?? []) if (name in panels) panels[name] = true;

      for (const [name, expression] of Object.entries(rule.then.setValues ?? {})) {
        if (!fields[name]) {
          result.failures.push({ rule: label, field: name, reason: 'setValues targets a field that is not part of the form state.' });
          continue;
        }
        try {
          result.values[name] = this.valueOf(expression, options.context);
        } catch (error) {
          result.failures.push({ rule: label, field: name, reason: failureReason(error) });
        }
      }

      if (rule.then.error) {
        result.errors.push({ rule: label, message: rule.then.error.message, fields: rule.then.error.fields ?? [] });
      }
    });

    return result;
  }

  private valueOf(condition: LogicCondition, context: FormulaContext): FormulaValue {
    return typeof condition === 'string' ? this.engine.evaluate(condition, context) : this.engine.evaluateAst(criteriaToAst(condition), context);
  }
}

export function isEmptyLogicValue(value: FormulaValue): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === 'string' && item !== '')) return undefined;
  return value as string[];
}

function parseCriteriaNode(value: unknown, problems: string[], path: string): ConditionNode | undefined {
  if (typeof value === 'string') {
    problems.push(`${path}: nested conditions must be criteria objects, not formula text.`);
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push(`${path}: condition must be a formula string or a criteria object.`);
    return undefined;
  }
  if (Array.isArray(value.all)) {
    const children = value.all.map((child, index) => parseCriteriaNode(child, problems, `${path}.all[${index}]`));
    return children.every((child) => child !== undefined) ? { all: children as ConditionNode[] } : undefined;
  }
  if (Array.isArray(value.any)) {
    const children = value.any.map((child, index) => parseCriteriaNode(child, problems, `${path}.any[${index}]`));
    return children.every((child) => child !== undefined) ? { any: children as ConditionNode[] } : undefined;
  }
  if (isRecord(value.not)) {
    return parseCriteriaNode(value.not, problems, `${path}.not`);
  }
  if (typeof value.field !== 'string' || typeof value.operator !== 'string') {
    problems.push(`${path}: criteria object needs a "field" and an "operator".`);
    return undefined;
  }
  if (!CRITERIA_OPERATORS.includes(value.operator as CriteriaOperator)) {
    problems.push(`${path}: unknown criteria operator "${value.operator}".`);
    return undefined;
  }
  const leaf: CriteriaCondition = { field: value.field, operator: value.operator as CriteriaOperator };
  if ('value' in value) leaf.value = value.value;
  return leaf;
}

/** Accepts a condition as formula text or as a criteria tree; returns undefined when malformed. */
function parseCondition(value: unknown, label: string, problems: string[]): LogicCondition | undefined {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      problems.push(`${label}: "when" formula is empty.`);
      return undefined;
    }
    return value;
  }
  return parseCriteriaNode(value, problems, label);
}

function parseActions(value: unknown, label: string, problems: string[]): LogicActions | undefined {
  if (!isRecord(value)) {
    problems.push(`${label}: "then" must be an object of actions.`);
    return undefined;
  }
  const actions: LogicActions = {};
  for (const key of ['show', 'hide', 'setRequired', 'setReadOnly', 'showPanels', 'hidePanels'] as const) {
    if (value[key] === undefined) continue;
    const list = stringArray(value[key]);
    if (list === undefined) problems.push(`${label}: "${key}" must be a list of field names.`);
    else actions[key] = list;
  }
  if (value.setValues !== undefined) {
    if (!isRecord(value.setValues)) problems.push(`${label}: "setValues" must be an object of field -> formula.`);
    else {
      const entries: Record<string, string> = {};
      for (const [field, expression] of Object.entries(value.setValues)) {
        if (typeof expression !== 'string' || expression.trim() === '') problems.push(`${label}: setValues.${field} must be a formula string.`);
        else entries[field] = expression;
      }
      if (Object.keys(entries).length > 0) actions.setValues = entries;
    }
  }
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.message !== 'string') problems.push(`${label}: "error" needs a message.`);
    else {
      const error: { message: string; fields?: string[] | undefined } = { message: value.error.message };
      if (value.error.fields !== undefined) {
        const fields = stringArray(value.error.fields);
        if (fields === undefined) problems.push(`${label}: error.fields must be a list of field names.`);
        else error.fields = fields;
      }
      actions.error = error;
    }
  }
  return actions;
}

/**
 * Structural parse of a stored `dynamicLogic` metadata section. Metadata schemas keep a shallow
 * guard, so this is where shapes are pinned down before the semantic check runs.
 */
export function parseDynamicLogic(input: unknown): { rules: DynamicLogicRule[]; problems: string[] } {
  const problems: string[] = [];
  const rawRules = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.rules) ? input.rules : undefined;
  if (rawRules === undefined) {
    if (input !== undefined && input !== null) problems.push('dynamicLogic must be { rules: [...] } or an array of rules.');
    return { rules: [], problems };
  }
  if (rawRules.length > 100) problems.push('A maximum of 100 dynamic logic rules is supported.');

  const rules: DynamicLogicRule[] = [];
  rawRules.forEach((raw, index) => {
    const label = isRecord(raw) && typeof raw.name === 'string' && raw.name !== '' ? `rule "${raw.name}"` : `rule #${index + 1}`;
    const problemsBefore = problems.length;
    if (!isRecord(raw)) {
      problems.push(`${label}: a rule must be an object.`);
      return;
    }
    const when = parseCondition(raw.when, label, problems);
    const then = parseActions(raw.then, label, problems);
    if (when === undefined || then === undefined) return;
    if (problems.length !== problemsBefore) return;
    const rule: DynamicLogicRule = { when, then };
    if (typeof raw.name === 'string' && raw.name !== '') rule.name = raw.name;
    if (typeof raw.description === 'string') rule.description = raw.description;
    if (typeof raw.disabled === 'boolean') rule.disabled = raw.disabled;
    rules.push(rule);
  });
  return { rules, problems };
}
