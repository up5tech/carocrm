import { FormulaEvaluationError } from '../errors/index.js';

/** The only value shapes the sandbox may produce: no functions, no class instances, no prototypes. */
export type FormulaValue = string | number | boolean | null | FormulaValue[] | FormulaRecord;

export type FormulaRecord = { [key: string]: FormulaValue };

export function isFormulaRecord(value: unknown): value is FormulaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeValue(value: FormulaValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Dynamic-truthiness used by `if`, `&&`, `||`, `!` and `bool()`. */
export function toBool(value: FormulaValue): boolean {
  if (value === null || value === false || value === 0) return false;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value !== '' && value !== '0';
  return true;
}

export function toNumber(value: FormulaValue): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FormulaEvaluationError('Formula produced a non-finite number.');
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  const trimmed = value.trim();
  if (trimmed === '') throw new FormulaEvaluationError('Cannot use an empty string as a number.');
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new FormulaEvaluationError(`"${trimmed}" is not a number.`);
  return parsed;
}

export function toStringValue(value: FormulaValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FormulaEvaluationError('Formula produced a non-finite number.');
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => toStringValue(item)).join(',');
  throw new FormulaEvaluationError('Cannot use an object as a string.');
}

/**
 * Normalises arbitrary input (record attributes, request bodies) into sandbox values.
 * Anything that is not a plain scalar/array/object is dropped instead of leaking through.
 */
export function toFormulaValue(input: unknown, depth = 0): FormulaValue {
  if (depth > 16) throw new FormulaEvaluationError('Value nesting is too deep.');
  if (input === null || input === undefined) return null;
  if (typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();
  if (Array.isArray(input)) return input.map((item) => toFormulaValue(item, depth + 1));
  if (isFormulaRecord(input)) {
    const result: FormulaRecord = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      result[key] = toFormulaValue(value, depth + 1);
    }
    return result;
  }
  return String(input);
}

/** Structural equality with number/string coercion only when both sides are numeric. */
export function valuesEqual(left: FormulaValue, right: FormulaValue): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index] ?? null));
  }
  if (typeof left === 'object' || typeof right === 'object') return false;
  if (typeof left === 'number' || typeof right === 'number') {
    const numericLeft = typeof left === 'number' ? left : Number(String(left).trim());
    const numericRight = typeof right === 'number' ? right : Number(String(right).trim());
    return Number.isFinite(numericLeft) && Number.isFinite(numericRight) && numericLeft === numericRight;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return toBool(left) === toBool(right);
  }
  return toStringValue(left) === toStringValue(right);
}

export function compareValues(left: FormulaValue, right: FormulaValue): number {
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  const numericLeft = toNumber(left);
  const numericRight = toNumber(right);
  if (numericLeft < numericRight) return -1;
  if (numericLeft > numericRight) return 1;
  return 0;
}
