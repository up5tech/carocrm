import { DynamicLogicEvaluator, type FieldLogicState, FormulaEngine, type FormulaValue,parseDynamicLogic } from '@carocrm/formula';

import type { EntityDefinition } from '../api/types.js';

/**
 * Client half of PLAN §21: the same rule set the API enforces is evaluated here so the form hides,
 * requires and fills in fields while the user types instead of failing on save.
 */
const engine = new FormulaEngine();
const evaluator = new DynamicLogicEvaluator(engine);

export interface LogicOutcome {
  fields: Record<string, FieldLogicState>;
  values: Record<string, unknown>;
  errors: { rule: string; message: string; fields: string[] }[];
}

const IDLE: LogicOutcome = { fields: {}, values: {}, errors: [] };

/** Field types the server computes; they are never editable. */
export const COMPUTED_TYPES: ReadonlySet<string> = new Set(['formula', 'generated', 'aggregationCount']);

export function isComputedField(type: string): boolean {
  return COMPUTED_TYPES.has(type);
}

/** Form values arrive as dayjs objects, switches, arrays — everything the sandbox needs flattened. */
function toLogicValue(value: unknown): FormulaValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toLogicValue(item));
  const withIso = value as { toISOString?: () => string };
  if (typeof withIso.toISOString === 'function') return withIso.toISOString();
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const record: Record<string, FormulaValue> = {};
    for (const [key, item] of entries) record[key] = toLogicValue(item);
    return record;
  }
  return String(value);
}

export function evaluateEntityLogic(definition: EntityDefinition | undefined, values: Record<string, unknown>): LogicOutcome {
  if (!definition) return IDLE;
  const section = definition.dynamicLogic;
  if (!section) return IDLE;
  const parsed = parseDynamicLogic(section);
  if (parsed.rules.length === 0) return IDLE;

  const states: Record<string, FieldLogicState> = {};
  for (const [name, field] of Object.entries(definition.fields ?? {})) {
    states[name] = { visible: true, required: field.required === true, readOnly: isComputedField(field.type) };
  }

  const record: Record<string, FormulaValue> = {};
  for (const [name, value] of Object.entries(values)) record[name] = toLogicValue(value);

  const result = evaluator.evaluate({
    rules: parsed.rules,
    fields: states,
    context: { record, now: new Date() },
  });

  const computed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(result.values)) computed[name] = value;
  return { fields: result.fields, values: computed, errors: result.errors };
}
