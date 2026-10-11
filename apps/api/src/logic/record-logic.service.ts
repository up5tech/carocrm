import { ValidationError } from '@carocrm/core/errors/index.js';
import { DynamicLogicEvaluator, type FieldLogicState, type FormulaValue } from '@carocrm/formula/index.js';
import type { EntityDefinition, FieldDefinition } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { FormulaService } from './formula.service.js';

interface LogicViolation {
  field: string;
  message: string;
}

/**
 * Applies dynamic logic and formula fields to a record write (PLAN §21, §22). The same rule set the
 * SPA evaluates runs here, so an API client cannot create a record the UI would refuse: rules can
 * make fields required or read-only, fill in values, and declare a business condition that blocks
 * the save.
 */
@Injectable()
export class RecordLogicService {
  private readonly evaluator: DynamicLogicEvaluator;

  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
  ) {
    this.evaluator = new DynamicLogicEvaluator(formulas.engine);
  }

  /**
   * @param data     the merged attribute set that would be stored
   * @param supplied the keys and values the caller actually sent; a write that changes a field the
   *                 rules compute is rejected, while a resend of the same value is allowed
   */
  apply(options: {
    entity: string;
    data: Record<string, unknown>;
    supplied: Readonly<Record<string, unknown>>;
    previous?: Readonly<Record<string, unknown>> | undefined;
    timezone?: string | undefined;
  }): Record<string, unknown> {
    const definition = this.metadata.registry.getEntity(options.entity);
    if (!definition) return options.data;

    const data = { ...options.data };
    const computed = new Map<string, FormulaValue>();
    const violations: LogicViolation[] = [];

    this.applyDynamicLogic(definition, data, options, computed, violations);
    this.applyFormulaFields(definition, data, computed, violations, options);

    if (violations.length > 0) {
      const details: Record<string, string> = {};
      for (const violation of violations) details[violation.field] = violation.message;
      throw new ValidationError(`Record validation failed for "${options.entity}".`, details);
    }
    return data;
  }

  private applyDynamicLogic(
    definition: EntityDefinition,
    data: Record<string, unknown>,
    options: {
      supplied: Readonly<Record<string, unknown>>;
      previous?: Readonly<Record<string, unknown>> | undefined;
      timezone?: string | undefined;
    },
    computed: Map<string, FormulaValue>,
    violations: LogicViolation[],
  ): void {
    const rules = this.formulas.parseRules(definition);
    const formulaFields = Object.entries(definition.fields).filter(([, field]) => typeof field.formula === 'string' && field.formula.trim() !== '');
    if (rules.length === 0 && formulaFields.length === 0) return;

    const states: Record<string, FieldLogicState> = {};
    for (const [name, field] of Object.entries(definition.fields)) {
      states[name] = { visible: true, required: field.required === true, readOnly: false };
    }

    const contextRecord = toContextRecord(definition, data);
    const context = {
      record: contextRecord,
      now: new Date(),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    };

    const result = this.evaluator.evaluate({ rules, fields: states, context });

    for (const failure of result.failures) {
      violations.push({
        field: failure.field ?? '*',
        message: `Dynamic logic rule "${failure.rule}" could not be evaluated: ${failure.reason}`,
      });
    }

    for (const error of result.errors) {
      const targets = error.fields.length > 0 ? error.fields : ['*'];
      for (const field of targets) violations.push({ field, message: error.message });
    }

    // Rule-provided values are applied first so the read-only and required checks see the outcome.
    for (const [name, value] of Object.entries(result.values)) {
      const field = definition.fields[name];
      if (!field) continue;
      try {
        const coerced = coerceValue(field, value);
        data[name] = coerced;
        computed.set(name, value);
        (contextRecord as Record<string, unknown>)[name] = toContextValue(coerced);
      } catch (error) {
        violations.push({ field: name, message: error instanceof Error ? error.message : 'Rule value is not usable for this field.' });
      }
    }

    for (const [name, state] of Object.entries(result.fields)) {
      if (!state.readOnly) continue;
      this.rejectReadOnlyWrite(name, definition, options, data, computed, violations);
    }

    for (const [name, state] of Object.entries(result.fields)) {
      if (!state.required) continue;
      if (isEmptyStored(data[name])) {
        violations.push({ field: name, message: `Field "${labelOf(definition, name)}" is required by a dynamic logic rule.` });
      }
    }
  }

  /**
   * A field a rule pins down may still be sent back unchanged, but writing a different value — or
   * any value at all to a computed field on create — is rejected rather than silently ignored.
   */
  private rejectReadOnlyWrite(
    name: string,
    definition: EntityDefinition,
    options: { supplied: Readonly<Record<string, unknown>> },
    data: Record<string, unknown>,
    computed: Map<string, FormulaValue>,
    violations: LogicViolation[],
  ): void {
    if (!Object.prototype.hasOwnProperty.call(options.supplied, name)) return;
    const supplied = options.supplied[name];
    if (isEmptyStored(supplied) && !computed.has(name)) return;
    const outcome = toContextValue(data[name]);
    if (sameValue(toContextValue(supplied), outcome)) return;
    violations.push({
      field: name,
      message: `Field "${labelOf(definition, name)}" is computed by the server and cannot be set directly.`,
    });
  }

  private applyFormulaFields(
    definition: EntityDefinition,
    data: Record<string, unknown>,
    computed: Map<string, FormulaValue>,
    violations: LogicViolation[],
    options: { supplied: Readonly<Record<string, unknown>> },
  ): void {
    const contextRecord = toContextRecord(definition, data);
    const context = { record: contextRecord, now: new Date() };

    for (const [name, field] of Object.entries(definition.fields)) {
      const source = typeof field.formula === 'string' ? field.formula.trim() : '';
      if (source === '') continue;
      let value: FormulaValue;
      try {
        value = this.formulas.engine.evaluate(source, context);
      } catch (error) {
        violations.push({ field: name, message: `Formula for "${labelOf(definition, name)}" failed: ${error instanceof Error ? error.message : 'error'}` });
        continue;
      }
      if (!computed.has(name)) {
        try {
          const coerced = coerceValue(field, value);
          data[name] = coerced;
          computed.set(name, value);
        } catch (error) {
          violations.push({ field: name, message: error instanceof Error ? error.message : 'Formula produced an unusable value.' });
          continue;
        }
      }
      (contextRecord as Record<string, unknown>)[name] = toContextValue(data[name]);
      this.rejectReadOnlyWrite(name, definition, options, data, computed, violations);
    }
  }
}

/** Field list of a rule is evaluated against the merged record, with every known field present. */
function toContextRecord(definition: EntityDefinition, data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const name of Object.keys(definition.fields)) record[name] = toContextValue(data[name]);
  for (const name of ['id', 'createdAt', 'modifiedAt', 'assignedUserId']) {
    if (data[name] !== undefined) record[name] = toContextValue(data[name]);
  }
  return record;
}

function toContextValue(value: unknown): FormulaValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toContextValue(item));
  if (typeof value === 'object') return value as Record<string, FormulaValue>;
  return String(value);
}

function coerceValue(field: FieldDefinition, value: FormulaValue): unknown {
  if (value === null) return null;
  switch (field.type) {
    case 'int':
      return Math.trunc(toNumberValue(value));
    case 'float':
    case 'decimal':
    case 'currency':
      return toNumberValue(value);
    case 'bool':
      return value === true || value === 1 || value === '1' || value === 'true';
    case 'date':
    case 'datetime': {
      const text = typeof value === 'string' ? value : String(value);
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) throw new ValidationError(`Formula produced an invalid date: "${text}".`, { value: text });
      return parsed;
    }
    case 'multiEnum':
    case 'linkMultiple':
      return Array.isArray(value) ? value.map((item) => (item === null ? '' : String(item))) : [String(value)];
    case 'varchar':
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
    case 'enum':
    case 'link':
    case 'linkOne':
    case 'formula':
    case 'generated':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

function toNumberValue(value: FormulaValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw new ValidationError(`Formula produced a non-numeric value: "${String(value)}".`, { value });
  return parsed;
}

function isEmptyStored(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sameValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => JSON.stringify(toContextValue(value)) ?? 'null';
  return normalize(left) === normalize(right);
}

function labelOf(definition: EntityDefinition, name: string): string {
  return definition.fields[name]?.label ?? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}
