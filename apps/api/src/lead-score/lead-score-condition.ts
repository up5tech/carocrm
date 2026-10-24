import type { ConditionNode, CriteriaOperator } from '@carocrm/formula';
import { CRITERIA_OPERATORS } from '@carocrm/formula';

/**
 * Phase 19-LS.3 — the bounded, declarative condition a score rule may use
 * (`PLAN_Phase_19_LeadScore.md` §5.2, §6.2; audit §5.2, decision D8).
 *
 * A score decides what a salesperson looks at first. Plan §0.1-5 makes it non-negotiable that the
 * decision is explainable, and §6.2 makes it non-negotiable that a rule cannot be code. So a condition
 * here is a **tree of `{field, operator, value}` leaves**, and nothing else:
 *
 * - the operator vocabulary is the platform's own `CRITERIA_OPERATORS` — the same list the Entity
 *   Manager UI offers and `packages/formula` compiles, so a rule and the rest of the CRM speak one
 *   language rather than two that drift;
 * - the `string` alternative of the platform's `LogicCondition` is **rejected**, not compiled. That
 *   alternative is a formula expression, and `RecordLogicService` evaluates formula strings while
 *   writing fields (audit §5.2) — a scoring rule must read signals and add points, never write;
 * - every field must be a declared field of the entity the model scores, must be inside the model's own
 *   allowlist, must not be on its denylist, must not be a *scoring output* (that is the loop plan §10.4
 *   asks to prevent), and must not name a protected characteristic or a proxy for one (plan §0.1-6);
 * - the tree is bounded in depth, in predicate count and in total nodes, so no model can turn a Lead
 *   list rebuild into an unbounded expression evaluation (plan §9.4).
 *
 * The result is a list of issues with **stable codes**. Nothing here throws for a bad model: the
 * validator answers, and the publish path decides to refuse. That is what lets the 19-LS.8 editor show
 * every problem in a draft at once instead of failing on the first one.
 */

/** Nesting budget: `all`/`any` groups may sit inside one another this many levels. */
export const MAX_CONDITION_DEPTH = 2;
/** Predicate leaves in one condition. */
export const MAX_CONDITION_PREDICATES = 20;
/** Total nodes, the same kind of budget `packages/formula/src/limits` applies to formulas. */
export const MAX_CONDITION_NODES = 60;
/** Values in one `in`/`notIn` list. */
export const MAX_CONDITION_LIST_VALUES = 25;
/** A comparison string cannot be longer than the field it compares against, nor longer than this. */
export const MAX_CONDITION_VALUE_CHARS = 512;

const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const OPERATORS = new Set<string>(CRITERIA_OPERATORS);
export const VALUELESS_OPERATORS: ReadonlySet<string> = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

/** Operators that compare against an option list rather than an arbitrary value. */
export const LIST_OPERATORS: ReadonlySet<string> = new Set(['in', 'notIn']);

/** Operators that take a list of values (`in`, `notIn`) rather than a scalar. */
export const ARRAY_OPERATORS: ReadonlySet<string> = new Set(['in', 'notIn', 'between']);

/**
 * Which operators make sense for which declared field type.
 *
 * This is the type half of "validate all rule field references against metadata, type and authorization
 * constraints" (plan §16 `19-LS.3`). `contains` on an integer, `gt` on a boolean and `equals` on a
 * multi-value field are all nonsense, and the evaluator in 19-LS.4 would have to invent a meaning for
 * them. Inventing one later would change what a stored score meant, so the meaning is fixed now.
 */
export const OPERATORS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  varchar: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
  text: ['equals', 'notEquals', 'contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  email: ['equals', 'notEquals', 'contains', 'notContains', 'endsWith', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
  phone: ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
  url: ['equals', 'notEquals', 'contains', 'endsWith', 'isEmpty', 'isNotEmpty'],
  int: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  float: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  decimal: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  currency: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  aggregationCount: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  bool: ['isTrue', 'isFalse', 'equals', 'notEquals'],
  date: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  datetime: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  enum: ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
  // A multi-value field needs "contains one of these" semantics that the shared operator list does not
  // define. Empty/not-empty is unambiguous, so that is all a rule may ask of one until 19-LS.4 gives the
  // rest a documented meaning — refusing now is what keeps a stored score re-derivable later.
  multiEnum: ['isEmpty', 'isNotEmpty'],
  // Existence only. Relationship *matching* is a one-hop, model-declared thing for 19-LS.9 (plan §6.2),
  // and this build has no Lead→Activity relation to traverse (audit gap G2), so a rule that wanted it
  // would be validated against a path the evaluator could never read.
  link: ['isEmpty', 'isNotEmpty'],
  linkOne: ['isEmpty', 'isNotEmpty'],
  linkMultiple: ['isEmpty', 'isNotEmpty'],
  linkParent: ['isEmpty', 'isNotEmpty'],
  foreign: ['isEmpty', 'isNotEmpty'],
};

/**
 * Field types a rule may never read, whatever the name.
 *
 * `password` and the file types hold secrets and artifacts, not qualification signals; `formula` and
 * `generated` are computed by the platform on save, so a score would be built on a value the model
 * cannot re-read deterministically from stored data (plan §3.1 "input freshness" and §6.3
 * reproducibility). `file`/`image`/`attachmentMultiple` are excluded because reading them means opening
 * a document, which is not a bounded rule.
 */
export const NEVER_SCORABLE_FIELD_TYPES: ReadonlySet<string> = new Set(['password', 'file', 'image', 'attachmentMultiple', 'formula', 'generated']);

/**
 * Names that describe a protected or sensitive characteristic, or a direct proxy for one.
 *
 * Plan §0.1-6 forbids scoring on these and forbids *inferring* them. Matching on the field name rather
 * than on a fixed list of Lead fields matters because a Lead field is something an administrator adds:
 * the denylist has to bite the day such a column appears, not have been edited on the same day.
 *
 * It is deliberately a vocabulary of *concepts*, not of CRM columns: `age` is a proxy for date of birth,
 * `nationality` and `ethnicity` are protected, `healthStatus` is health data. Free-text columns are not
 * scanned, because "don't infer these attributes from communications" (§9.3) is a rule about what a
 * model may be configured to read, and that is exactly what the allowlist above enforces.
 */
export const PROTECTED_FIELD_NAMES: readonly string[] = [
  'age',
  'birthDate',
  'dateOfBirth',
  'disability',
  'ethnicity',
  'familyStatus',
  'gender',
  'healthCondition',
  'healthStatus',
  'maritalStatus',
  'nationalId',
  'nationality',
  'passportNumber',
  'politicalView',
  'race',
  'religion',
  'sexualOrientation',
  'socialSecurityNumber',
  'tradeUnionMember',
];

/** Field names that are *outputs* of scoring. Reading one back in is the loop plan §10.4 names. */
export const SCORING_OUTPUT_FIELD_NAMES: readonly string[] = [
  'scoreValue',
  'scoreBand',
  'scoreStatus',
  'scoreModelId',
  'scoreModelVersion',
  'scoreCalculatedAt',
  'scoreInputsAsOf',
  'scorePreviousValue',
  'scoreCoverage',
  'scoreReasonCodes',
];

export type ConditionIssueCode =
  | 'LS_CONDITION_NOT_JSON'
  | 'LS_CONDITION_NOT_DECLARATIVE'
  | 'LS_CONDITION_EMPTY'
  | 'LS_CONDITION_TOO_DEEP'
  | 'LS_CONDITION_TOO_LARGE'
  | 'LS_CONDITION_TOO_MANY_PREDICATES'
  | 'LS_CONDITION_UNKNOWN_KEY'
  | 'LS_CONDITION_GROUP_EMPTY'
  | 'LS_CONDITION_UNKNOWN_OPERATOR'
  | 'LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE'
  | 'LS_CONDITION_FIELD_UNKNOWN'
  | 'LS_CONDITION_FIELD_INVALID_NAME'
  | 'LS_CONDITION_FIELD_NEVER_SCORABLE'
  | 'LS_CONDITION_FIELD_PROTECTED'
  | 'LS_CONDITION_FIELD_IS_SCORING_OUTPUT'
  | 'LS_CONDITION_FIELD_NOT_ALLOWED'
  | 'LS_CONDITION_FIELD_BLOCKED'
  | 'LS_CONDITION_VALUE_MISSING'
  | 'LS_CONDITION_VALUE_UNEXPECTED'
  | 'LS_CONDITION_VALUE_TYPE'
  | 'LS_CONDITION_VALUE_UNKNOWN_OPTION'
  | 'LS_CONDITION_VALUE_TOO_LONG'
  | 'LS_CONDITION_LIST_EMPTY'
  | 'LS_CONDITION_LIST_TOO_LONG'
  | 'LS_CONDITION_DATE_INVALID'
  | 'LS_CONDITION_NUMBER_INVALID';

export interface ConditionIssue {
  readonly code: ConditionIssueCode;
  readonly path: string;
  readonly message: string;
}

/** What a validator needs to know about one field of the entity being scored. */
export interface ScoreableField {
  readonly name: string;
  readonly type: string;
  readonly maxLength?: number | undefined;
  readonly options?: readonly string[] | undefined;
}

export interface ConditionFieldPolicy {
  /** Every field of the entity being scored. */
  readonly fields: ReadonlyMap<string, ScoreableField>;
  /** When non-empty, the only paths the model is granted. */
  readonly allowedPaths?: readonly string[] | undefined;
  /** Paths the installation forbids, on top of the built-in denylists. */
  readonly blockedPaths?: readonly string[] | undefined;
}

export interface ParsedCondition {
  readonly node: ConditionNode | undefined;
  readonly issues: readonly ConditionIssue[];
}

/**
 * Parse the stored condition.
 *
 * The stored form is a JSON tree in a `text` attribute (audit §4: the platform has no object field
 * type). A string that is not JSON, or JSON that is not a condition tree, is a shape problem rather than
 * a policy problem, and is answered with an issue instead of an exception so `validate` can list all of
 * a draft's trouble at once.
 */
export function parseScoreCondition(raw: unknown): ParsedCondition {
  if (raw === undefined || raw === null || raw === '') {
    return { node: undefined, issues: [issue('LS_CONDITION_EMPTY', 'condition', 'A rule needs a condition.')] };
  }
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        node: undefined,
        issues: [
          issue(
            'LS_CONDITION_NOT_JSON',
            'condition',
            'A rule condition must be a declarative JSON tree, not free text, a formula or an expression.',
          ),
        ],
      };
    }
    return parseScoreConditionValue(parsed);
  }
  if (typeof raw === 'object') return parseScoreConditionValue(raw);
  return {
    node: undefined,
    issues: [issue('LS_CONDITION_NOT_DECLARATIVE', 'condition', 'A rule condition must be an object: one leaf, or a group of `all`, `any` or `not`.')],
  };
}

function parseScoreConditionValue(value: unknown): ParsedCondition {
  if (typeof value === 'string') {
    // A formula string in the place of a tree is the exact thing plan §6.2 forbids, and the platform's
    // `LogicCondition` union would happily allow it. It is refused by name so the answer is never "a
    // formula that happens to evaluate to false".
    return {
      node: undefined,
      issues: [issue('LS_CONDITION_NOT_DECLARATIVE', 'condition', 'A formula string is not a scoring condition. Use {field, operator, value}, or a group of all/any/not.')],
    };
  }
  if (!isRecord(value)) {
    return { node: undefined, issues: [issue('LS_CONDITION_NOT_DECLARATIVE', 'condition', 'A rule condition must be an object, not a literal value.')] };
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return { node: undefined, issues: [issue('LS_CONDITION_EMPTY', 'condition', 'A rule condition is empty.')] };
  }
  const known = new Set(['field', 'operator', 'value', 'all', 'any', 'not']);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return {
      node: undefined,
      issues: [issue('LS_CONDITION_UNKNOWN_KEY', 'condition', `Unknown condition keys: ${unknown.join(', ')}. A condition may only use field, operator, value, all, any or not.`)],
    };
  }
  if (keys.some((key) => key === 'all' || key === 'any' || key === 'not')) {
    if (keys.length !== 1) {
      return {
        node: undefined,
        issues: [issue('LS_CONDITION_UNKNOWN_KEY', 'condition', 'A condition is either a group (all, any or not) or a leaf (field and operator), never both.')],
      };
    }
    const groupKey = keys[0] as 'all' | 'any' | 'not';
    if (groupKey === 'not') {
      const inner = parseScoreConditionValue(value.not);
      return { node: inner.node === undefined ? undefined : { not: inner.node }, issues: inner.issues };
    }
    const children = value[groupKey];
    if (!Array.isArray(children) || children.length === 0) {
      return { node: undefined, issues: [issue('LS_CONDITION_GROUP_EMPTY', `condition.${groupKey}`, `"${groupKey}" needs at least one condition.`)] };
    }
    const issues: ConditionIssue[] = [];
    const nodes: ConditionNode[] = [];
    children.forEach((child, index) => {
      const parsed = parseScoreConditionValue(child);
      issues.push(...parsed.issues.map((entry) => ({ ...entry, path: `condition.${groupKey}[${index}]${entry.path.replace(/^condition/, '')}` })));
      if (parsed.node !== undefined) nodes.push(parsed.node);
    });
    if (issues.length > 0 || nodes.length !== children.length) {
      return { node: undefined, issues };
    }
    return { node: groupKey === 'all' ? { all: nodes } : { any: nodes }, issues: [] };
  }
  const field = value.field;
  const operator = value.operator;
  if (typeof field !== 'string' || typeof operator !== 'string') {
    return { node: undefined, issues: [issue('LS_CONDITION_UNKNOWN_KEY', 'condition', 'A leaf condition needs a field name and an operator.')] };
  }
  const leaf: ConditionNode = {
    field,
    operator: operator as CriteriaOperator,
    ...('value' in value ? { value: value.value } : {}),
  } as ConditionNode;
  return { node: leaf, issues: [] };
}

/**
 * Validate a parsed condition against the entity's metadata and the model's field policy.
 *
 * Returns every problem it can find, including inside groups the caller has not finished reading, so one
 * call answers a whole draft.
 */
export function validateScoreCondition(node: ConditionNode, policy: ConditionFieldPolicy, path = 'condition'): readonly ConditionIssue[] {
  const budget = { depth: 0, predicates: 0, nodes: 0 };
  return validateNode(node, policy, path, budget);
}

function validateNode(node: ConditionNode, policy: ConditionFieldPolicy, path: string, budget: { depth: number; predicates: number; nodes: number }): readonly ConditionIssue[] {
  budget.nodes += 1;
  if (budget.nodes > MAX_CONDITION_NODES) {
    return [issue('LS_CONDITION_TOO_LARGE', path, `A condition may hold at most ${MAX_CONDITION_NODES} nodes.`)];
  }
  if ('all' in node || 'any' in node) {
    if (budget.depth >= MAX_CONDITION_DEPTH) {
      return [issue('LS_CONDITION_TOO_DEEP', path, `A condition may nest ${MAX_CONDITION_DEPTH} levels of all/any groups.`)];
    }
    const children = ('all' in node ? node.all : node.any) as ConditionNode[];
    if (!Array.isArray(children) || children.length === 0) {
      return [issue('LS_CONDITION_GROUP_EMPTY', path, 'A group needs at least one condition.')];
    }
    const issues: ConditionIssue[] = [];
    const depthBefore = budget.depth;
    budget.depth = depthBefore + 1;
    children.forEach((child, index) => {
      issues.push(...validateNode(child, policy, `${path}.${'all' in node ? 'all' : 'any'}[${index}]`, budget));
    });
    budget.depth = depthBefore;
    return issues;
  }
  if ('not' in node) {
    if (budget.depth >= MAX_CONDITION_DEPTH) {
      return [issue('LS_CONDITION_TOO_DEEP', path, `A condition may nest ${MAX_CONDITION_DEPTH} levels of groups.`)];
    }
    const depthBefore = budget.depth;
    budget.depth = depthBefore + 1;
    const issues = validateNode(node.not as ConditionNode, policy, `${path}.not`, budget);
    budget.depth = depthBefore;
    return issues;
  }
  return validateLeaf(node, policy, path, budget);
}

function validateLeaf(node: ConditionNode, policy: ConditionFieldPolicy, path: string, budget: { depth: number; predicates: number; nodes: number }): readonly ConditionIssue[] {
  if (!('field' in node) || !('operator' in node)) {
    return [issue('LS_CONDITION_UNKNOWN_KEY', path, 'A condition must be a leaf of {field, operator, value} or a group.')]
  }
  budget.predicates += 1;
  if (budget.predicates > MAX_CONDITION_PREDICATES) {
    return [issue('LS_CONDITION_TOO_MANY_PREDICATES', path, `A condition may hold at most ${MAX_CONDITION_PREDICATES} comparisons.`)];
  }
  const leaf = node as { field: string; operator: string; value?: unknown };
  const issues: ConditionIssue[] = [];
  const fieldPath = `${path}.${leaf.field}`;

  if (!OPERATORS.has(leaf.operator)) {
    issues.push(issue('LS_CONDITION_UNKNOWN_OPERATOR', fieldPath, `"${leaf.operator}" is not a supported operator. Supported: ${[...OPERATORS].join(', ')}.`));
    return issues;
  }
  if (!FIELD_NAME.test(leaf.field)) {
    issues.push(issue('LS_CONDITION_FIELD_INVALID_NAME', fieldPath, 'A condition names a field with a plain lower-camel field name; a path, a table name or a SQL fragment is not accepted.'));
    return issues;
  }

  const fieldPolicyIssue = checkFieldPresence(leaf.field, fieldPath, policy);
  if (fieldPolicyIssue !== undefined) {
    issues.push(fieldPolicyIssue);
    return issues;
  }
  const field = policy.fields.get(leaf.field);
  if (field === undefined) return issues;

  const allowed = OPERATORS_BY_TYPE[field.type];
  if (allowed === undefined) {
    issues.push(issue('LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE', fieldPath, `Field type "${field.type}" has no scoring operators defined.`));
    return issues;
  }
  if (!allowed.includes(leaf.operator)) {
    issues.push(
      issue(
        'LS_CONDITION_OPERATOR_NOT_ALLOWED_FOR_TYPE',
        fieldPath,
        `Operator "${leaf.operator}" does not apply to a ${field.type} field. Allowed here: ${allowed.join(', ')}.`,
      ),
    );
    return issues;
  }

  issues.push(...checkValue(leaf, field, fieldPath));
  return issues;
}

function checkFieldPresence(name: string, path: string, policy: ConditionFieldPolicy): ConditionIssue | undefined {
  if (PROTECTED_FIELD_NAMES.includes(name)) {
    return issue('LS_CONDITION_FIELD_PROTECTED', path, `"${name}" describes a protected or sensitive characteristic, or a proxy for one. Scoring must not read it (plan §0.1-6).`);
  }
  if (SCORING_OUTPUT_FIELD_NAMES.includes(name)) {
    return issue('LS_CONDITION_FIELD_IS_SCORING_OUTPUT', path, `"${name}" is an output of scoring. Reading it back in lets a score feed itself (plan §10.4).`);
  }
  if (policy.blockedPaths?.includes(name) === true) {
    return issue('LS_CONDITION_FIELD_BLOCKED', path, `The installation blocks "${name}" as a scoring input.`);
  }
  const field = policy.fields.get(name);
  if (field === undefined) {
    return issue('LS_CONDITION_FIELD_UNKNOWN', path, `"${name}" is not a field of the entity this model scores. A rule cannot read a field the metadata does not declare.`);
  }
  if (NEVER_SCORABLE_FIELD_TYPES.has(field.type)) {
    return issue('LS_CONDITION_FIELD_NEVER_SCORABLE', path, `A ${field.type} field is never a scoring input: it is a secret, an artifact or a value computed at save time.`);
  }
  if (policy.allowedPaths !== undefined && policy.allowedPaths.length > 0 && !policy.allowedPaths.includes(name)) {
    return issue('LS_CONDITION_FIELD_NOT_ALLOWED', path, `This model is not granted "${name}". Add it to the model's allowed field paths, or remove the comparison.`);
  }
  return undefined;
}

function checkValue(leaf: { operator: string; value?: unknown }, field: ScoreableField, path: string): readonly ConditionIssue[] {
  const hasValue = 'value' in leaf && leaf.value !== undefined;
  if (VALUELESS_OPERATORS.has(leaf.operator)) {
    return hasValue ? [issue('LS_CONDITION_VALUE_UNEXPECTED', path, `Operator "${leaf.operator}" compares existence and takes no value.`)] : [];
  }
  if (!hasValue) {
    return [issue('LS_CONDITION_VALUE_MISSING', path, `Operator "${leaf.operator}" needs a value.`)];
  }
  const value = leaf.value;

  if (LIST_OPERATORS.has(leaf.operator)) {
    if (!Array.isArray(value) || value.length === 0) {
      return [issue('LS_CONDITION_LIST_EMPTY', path, `"${leaf.operator}" needs a non-empty list of values.`)];
    }
    if (value.length > MAX_CONDITION_LIST_VALUES) {
      return [issue('LS_CONDITION_LIST_TOO_LONG', path, `"${leaf.operator}" accepts at most ${MAX_CONDITION_LIST_VALUES} values.`)];
    }
    return value.flatMap((item, index) => checkScalar(item, field, `${path}[${index}]`, leaf.operator));
  }
  if (Array.isArray(value)) {
    return [issue('LS_CONDITION_VALUE_TYPE', path, `Operator "${leaf.operator}" compares one value; use \`in\` for a list.`)];
  }
  return checkScalar(value, field, path, leaf.operator);
}

function checkScalar(value: unknown, field: ScoreableField, path: string, operator: string): readonly ConditionIssue[] {
  const numeric = field.type === 'int' || field.type === 'float' || field.type === 'decimal' || field.type === 'currency' || field.type === 'aggregationCount';
  const temporal = field.type === 'date' || field.type === 'datetime';

  if (numeric) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [issue('LS_CONDITION_NUMBER_INVALID', path, `A ${field.type} comparison needs a finite number.`)];
    }
    if (field.type === 'int' || field.type === 'aggregationCount') {
      if (!Number.isInteger(value)) return [issue('LS_CONDITION_NUMBER_INVALID', path, `"${value}" is not an integer.`)];
    }
    return [];
  }

  if (field.type === 'bool') {
    if (operator === 'equals' || operator === 'notEquals') {
      return typeof value === 'boolean' ? [] : [issue('LS_CONDITION_VALUE_TYPE', path, 'A boolean comparison needs true or false.')];
    }
    return [];
  }

  if (temporal) {
    if (typeof value !== 'string') return [issue('LS_CONDITION_DATE_INVALID', path, `A ${field.type} comparison needs an ISO date string.`)];
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return [issue('LS_CONDITION_DATE_INVALID', path, `"${value}" is not a date.`)];
    const shape = field.type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    if (!shape.test(value)) {
      return [issue('LS_CONDITION_DATE_INVALID', path, `A ${field.type} comparison needs the ISO form ${field.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDThh:mm…'}.`)]
    }
    return [];
  }

  if (typeof value !== 'string') {
    return [issue('LS_CONDITION_VALUE_TYPE', path, `A ${field.type} comparison needs a string value.`)];
  }
  if (value.length === 0 && operator !== 'equals' && operator !== 'notEquals') {
    return [issue('LS_CONDITION_VALUE_TYPE', path, 'An empty string is not a comparison value; use isEmpty or isNotEmpty.')];
  }
  if (value.length > MAX_CONDITION_VALUE_CHARS) {
    return [issue('LS_CONDITION_VALUE_TOO_LONG', path, `A comparison value is limited to ${MAX_CONDITION_VALUE_CHARS} characters.`)];
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return [issue('LS_CONDITION_VALUE_TOO_LONG', path, `"${field.name}" holds at most ${field.maxLength} characters, so a longer value can never match.`)];
  }
  if (field.options !== undefined && field.options.length > 0) {
    const known = new Set(field.options);
    if (!known.has(value)) {
      return [issue('LS_CONDITION_VALUE_UNKNOWN_OPTION', path, `"${value}" is not one of the options "${field.name}" defines (${field.options.join(', ')}).`)];
    }
  }
  if (field.type === 'enum' && field.options === undefined) {
    return [issue('LS_CONDITION_VALUE_UNKNOWN_OPTION', path, `"${field.name}" is an enum with no configured options, so nothing can match it.`)];
  }
  return [];
}

function issue(code: ConditionIssueCode, path: string, message: string): ConditionIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
