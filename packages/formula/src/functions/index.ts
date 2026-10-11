import {
  addCalendarDays,
  addCalendarMonths,
  diffCalendarDays,
  formatDateValue,
  formatDateWithPattern,
  type FormulaDate,
  parseDateValue,
  startOfDay,
  startOfMonth,
  weekdayOf,
  zonedParts,
} from '../datetime/index.js';
import { FormulaDefinitionError, FormulaEvaluationError, FormulaLimitError } from '../errors/index.js';
import type { FormulaRecord, FormulaValue } from '../value/index.js';
import { isFormulaRecord, toBool, toFormulaValue, toNumber, toStringValue, valuesEqual } from '../value/index.js';

/** Everything a function may touch: the current record, the context clock and zone. No I/O, ever. */
export interface EvaluationContext {
  readonly record: FormulaRecord | undefined;
  readonly nowMs: number;
  readonly timeZone: string;
  readonly limits: { maxStringLength: number; maxArrayLength: number };
}

export interface FormulaFunction {
  readonly name: string;
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly description: string;
  apply(args: FormulaValue[], context: EvaluationContext): FormulaValue;
}

const VARIADIC_MAX = Number.MAX_SAFE_INTEGER;
const BANNED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function checkedString(value: FormulaValue, context: EvaluationContext): string {
  const text = toStringValue(value);
  if (text.length > context.limits.maxStringLength) throw new FormulaLimitError(`Resulting string is longer than ${context.limits.maxStringLength} characters.`);
  return text;
}

function checkedArray(values: FormulaValue[], context: EvaluationContext): FormulaValue[] {
  if (values.length > context.limits.maxArrayLength) throw new FormulaLimitError(`Resulting array is longer than ${context.limits.maxArrayLength} items.`);
  return values;
}

function asDate(value: FormulaValue, context: EvaluationContext): FormulaDate {
  return parseDateValue(value, context.timeZone);
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new FormulaEvaluationError(`${label} produced a non-finite number.`);
  return value;
}

function listArg(value: FormulaValue, name: string): FormulaValue[] {
  if (Array.isArray(value)) return value;
  if (isFormulaRecord(value)) return Object.values(value);
  throw new FormulaEvaluationError(`"${name}" expects an array.`);
}

const FUNCTIONS: FormulaFunction[] = [
  // --- conditional / type ---------------------------------------------------
  {
    name: 'ifThen',
    minArgs: 3,
    maxArgs: 3,
    description: 'ifThen(condition, whenTrue, whenFalse)',
    apply: ([condition, whenTrue, whenFalse]) => (toBool(condition ?? false) ? (whenTrue ?? null) : (whenFalse ?? null)),
  },
  {
    name: 'bool',
    minArgs: 1,
    maxArgs: 1,
    description: 'bool(value) — dynamic truthiness',
    apply: ([value]) => toBool(value ?? null),
  },
  {
    name: 'not',
    minArgs: 1,
    maxArgs: 1,
    description: 'not(value)',
    apply: ([value]) => !toBool(value ?? null),
  },
  {
    name: 'number',
    minArgs: 1,
    maxArgs: 1,
    description: 'number(value) — cast to a number',
    apply: ([value]) => toNumber(value ?? null),
  },
  {
    name: 'string',
    minArgs: 1,
    maxArgs: 1,
    description: 'string(value) — cast to text',
    apply: ([value], context) => checkedString(value ?? null, context),
  },
  {
    name: 'isNull',
    minArgs: 1,
    maxArgs: 1,
    description: 'isNull(value)',
    apply: ([value]) => value === null || value === undefined,
  },
  {
    name: 'isEmpty',
    minArgs: 1,
    maxArgs: 1,
    description: 'isEmpty(value) — null, empty text or empty array',
    apply: ([value]) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0),
  },
  {
    name: 'isNotEmpty',
    minArgs: 1,
    maxArgs: 1,
    description: 'isNotEmpty(value)',
    apply: ([value]) => !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)),
  },
  {
    name: 'coalesce',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'coalesce(a, b, ...) — first value that is not null/empty',
    apply: (args) => args.find((arg) => arg !== null && arg !== undefined && arg !== '') ?? null,
  },

  // --- record access --------------------------------------------------------
  {
    name: 'field',
    minArgs: 1,
    maxArgs: 1,
    description: "field('name') — attribute of the current record",
    apply: ([name], context) => {
      if (!context.record) throw new FormulaEvaluationError('No record is available in this formula context.');
      const key = toStringValue(name ?? '');
      if (BANNED_KEYS.has(key)) throw new FormulaEvaluationError(`Record attribute "${key}" is not accessible.`);
      return context.record[key] ?? null;
    },
  },
  {
    name: 'hasField',
    minArgs: 1,
    maxArgs: 1,
    description: "hasField('name') — attribute exists on the record",
    apply: ([name], context) => {
      if (!context.record) return false;
      return Object.prototype.hasOwnProperty.call(context.record, toStringValue(name ?? ''));
    },
  },
  {
    name: 'recordId',
    minArgs: 0,
    maxArgs: 0,
    description: 'recordId() — id of the current record',
    apply: (_args, context) => context.record?.['id'] ?? null,
  },

  // --- string ---------------------------------------------------------------
  {
    name: 'concat',
    minArgs: 0,
    maxArgs: VARIADIC_MAX,
    description: 'concat(a, b, ...) — text join',
    apply: (args, context) => checkedString(args.map((arg) => toStringValue(arg)).join(''), context),
  },
  {
    name: 'length',
    minArgs: 1,
    maxArgs: 1,
    description: 'length(text | array)',
    apply: ([value]) => {
      if (Array.isArray(value)) return value.length;
      return toStringValue(value ?? '').length;
    },
  },
  {
    name: 'lower',
    minArgs: 1,
    maxArgs: 1,
    description: 'lower(text)',
    apply: ([value], context) => checkedString(toStringValue(value ?? ''), context).toLowerCase(),
  },
  {
    name: 'upper',
    minArgs: 1,
    maxArgs: 1,
    description: 'upper(text)',
    apply: ([value], context) => checkedString(toStringValue(value ?? ''), context).toUpperCase(),
  },
  {
    name: 'trim',
    minArgs: 1,
    maxArgs: 1,
    description: 'trim(text)',
    apply: ([value]) => toStringValue(value ?? '').trim(),
  },
  {
    name: 'substring',
    minArgs: 2,
    maxArgs: 3,
    description: 'substring(text, start, length?)',
    apply: ([value, from, amount]) => {
      const text = toStringValue(value ?? '');
      const start = Math.max(0, Math.trunc(toNumber(from ?? 0)));
      if (amount === undefined || amount === null) return text.slice(start);
      return text.slice(start, start + Math.max(0, Math.trunc(toNumber(amount))));
    },
  },
  {
    name: 'replace',
    minArgs: 3,
    maxArgs: 3,
    description: 'replace(text, search, replacement) — literal, not a pattern',
    apply: ([value, search, replacement], context) =>
      checkedString(toStringValue(value ?? '').split(toStringValue(search ?? '')).join(toStringValue(replacement ?? '')), context),
  },
  {
    name: 'contains',
    minArgs: 2,
    maxArgs: 2,
    description: 'contains(text, search)',
    apply: ([value, search]) => toStringValue(value ?? '').includes(toStringValue(search ?? '')),
  },
  {
    name: 'startsWith',
    minArgs: 2,
    maxArgs: 2,
    description: 'startsWith(text, prefix)',
    apply: ([value, prefix]) => toStringValue(value ?? '').startsWith(toStringValue(prefix ?? '')),
  },
  {
    name: 'endsWith',
    minArgs: 2,
    maxArgs: 2,
    description: 'endsWith(text, suffix)',
    apply: ([value, suffix]) => toStringValue(value ?? '').endsWith(toStringValue(suffix ?? '')),
  },
  {
    name: 'split',
    minArgs: 1,
    maxArgs: 2,
    description: "split(text, separator=',')",
    apply: ([value, separator], context) => {
      const parts = toStringValue(value ?? '').split(separator === undefined || separator === null ? ',' : toStringValue(separator));
      return checkedArray(parts, context);
    },
  },

  // --- math -----------------------------------------------------------------
  {
    name: 'abs',
    minArgs: 1,
    maxArgs: 1,
    description: 'abs(number)',
    apply: ([value]) => Math.abs(toNumber(value ?? 0)),
  },
  {
    name: 'floor',
    minArgs: 1,
    maxArgs: 1,
    description: 'floor(number)',
    apply: ([value]) => Math.floor(toNumber(value ?? 0)),
  },
  {
    name: 'ceil',
    minArgs: 1,
    maxArgs: 1,
    description: 'ceil(number)',
    apply: ([value]) => Math.ceil(toNumber(value ?? 0)),
  },
  {
    name: 'round',
    minArgs: 1,
    maxArgs: 2,
    description: 'round(number, precision=0)',
    apply: ([value, precision]) => {
      const digits = Math.min(12, Math.max(0, Math.trunc(toNumber(precision ?? 0))));
      const factor = 10 ** digits;
      // Half-up, the arithmetic users expect from a CRM field.
      const scaled = toNumber(value ?? 0) * factor;
      const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
      return requireFinite(rounded / factor, 'round');
    },
  },
  {
    name: 'mod',
    minArgs: 2,
    maxArgs: 2,
    description: 'mod(number, divisor)',
    apply: ([value, divisor]) => {
      const d = toNumber(divisor ?? 0);
      if (d === 0) throw new FormulaEvaluationError('Division by zero.');
      return requireFinite(toNumber(value ?? 0) % d, 'mod');
    },
  },
  {
    name: 'power',
    minArgs: 2,
    maxArgs: 2,
    description: 'power(base, exponent)',
    apply: ([base, exponent]) => requireFinite(toNumber(base ?? 0) ** toNumber(exponent ?? 0), 'power'),
  },
  {
    name: 'sqrt',
    minArgs: 1,
    maxArgs: 1,
    description: 'sqrt(number)',
    apply: ([value]) => {
      const input = toNumber(value ?? 0);
      if (input < 0) throw new FormulaEvaluationError('sqrt() of a negative number.');
      return requireFinite(Math.sqrt(input), 'sqrt');
    },
  },
  {
    name: 'min',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'min(a, b, ...) or min(array)',
    apply: (args) => reduceNumbers(args, (acc, next) => Math.min(acc, next), Number.POSITIVE_INFINITY),
  },
  {
    name: 'max',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'max(a, b, ...) or max(array)',
    apply: (args) => reduceNumbers(args, (acc, next) => Math.max(acc, next), Number.NEGATIVE_INFINITY),
  },
  {
    name: 'sum',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'sum(a, b, ...) or sum(array)',
    apply: (args) => requireFinite(reduceNumbers(args, (acc, next) => acc + next, 0), 'sum'),
  },
  {
    name: 'avg',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'avg(values) — arithmetic mean',
    apply: (args) => {
      const numbers = flattenNumbers(args);
      if (numbers.length === 0) throw new FormulaEvaluationError('avg() of an empty collection.');
      return requireFinite(numbers.reduce((acc, next) => acc + next, 0) / numbers.length, 'avg');
    },
  },
  {
    name: 'numberFormat',
    minArgs: 1,
    maxArgs: 4,
    description: 'numberFormat(value, decimals=2, decimalSeparator=".", groupSeparator=",")',
    apply: ([value, decimals, decimalSeparator, groupSeparator]) => {
      const digits = Math.min(12, Math.max(0, Math.trunc(toNumber(decimals ?? 2))));
      const separator = decimalSeparator === undefined || decimalSeparator === null ? '.' : toStringValue(decimalSeparator);
      const group = groupSeparator === undefined || groupSeparator === null ? ',' : toStringValue(groupSeparator);
      const fixed = toNumber(value ?? 0).toFixed(digits);
      const [whole, fraction] = fixed.split('.');
      const grouped = (whole ?? '0').replace('-', '');
      const withGroups = grouped.replace(/\B(?=(\d{3})+(?!\d))/g, group);
      const sign = fixed.startsWith('-') ? '-' : '';
      return fraction === undefined ? `${sign}${withGroups}` : `${sign}${withGroups}${separator}${fraction}`;
    },
  },

  // --- collections ----------------------------------------------------------
  {
    name: 'count',
    minArgs: 1,
    maxArgs: 1,
    description: 'count(array)',
    apply: ([value]) => listArg(value ?? null, 'count').length,
  },
  {
    name: 'inArray',
    minArgs: 2,
    maxArgs: 2,
    description: 'inArray(needle, haystack)',
    apply: ([needle, haystack]) => listArg(haystack ?? null, 'inArray').some((item) => valuesEqual(item, needle ?? null)),
  },
  {
    name: 'arrayAdd',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'arrayAdd(array, value, ...)',
    apply: (args, context) => checkedArray([...listArg(args[0] ?? null, 'arrayAdd'), ...args.slice(1)], context),
  },
  {
    name: 'arrayAddUnique',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'arrayAddUnique(array, value, ...) — no duplicates',
    apply: (args, context) => {
      const result = [...listArg(args[0] ?? null, 'arrayAddUnique')];
      for (const candidate of args.slice(1)) {
        if (!result.some((item) => valuesEqual(item, candidate))) result.push(candidate);
      }
      return checkedArray(result, context);
    },
  },
  {
    name: 'arrayRemove',
    minArgs: 1,
    maxArgs: VARIADIC_MAX,
    description: 'arrayRemove(array, value, ...)',
    apply: (args, context) => {
      const removals = args.slice(1);
      return checkedArray(listArg(args[0] ?? null, 'arrayRemove').filter((item) => !removals.some((remove) => valuesEqual(item, remove))), context);
    },
  },
  {
    name: 'first',
    minArgs: 1,
    maxArgs: 1,
    description: 'first(array)',
    apply: ([value]) => listArg(value ?? null, 'first')[0] ?? null,
  },
  {
    name: 'last',
    minArgs: 1,
    maxArgs: 1,
    description: 'last(array)',
    apply: ([value]) => {
      const items = listArg(value ?? null, 'last');
      return items[items.length - 1] ?? null;
    },
  },
  {
    name: 'join',
    minArgs: 1,
    maxArgs: 2,
    description: "join(array, separator=',')",
    apply: ([value, separator], context) =>
      checkedString(listArg(value ?? null, 'join').map((item) => toStringValue(item)).join(separator === undefined || separator === null ? ',' : toStringValue(separator)), context),
  },
  {
    name: 'equals',
    minArgs: 2,
    maxArgs: 2,
    description: 'equals(a, b) — value equality',
    apply: ([left, right]) => valuesEqual(left ?? null, right ?? null),
  },

  // --- dates (context clock / zone only, never the host clock) --------------
  {
    name: 'now',
    minArgs: 0,
    maxArgs: 0,
    description: 'now() — context instant as ISO text',
    apply: (_args, context) => formatDateValue({ epochMs: context.nowMs, dateOnly: false }, context.timeZone),
  },
  {
    name: 'currentDate',
    minArgs: 0,
    maxArgs: 0,
    description: 'currentDate() — context date (YYYY-MM-DD)',
    apply: (_args, context) => formatDateValue({ epochMs: context.nowMs, dateOnly: true }, context.timeZone),
  },
  {
    name: 'currentTimestamp',
    minArgs: 0,
    maxArgs: 0,
    description: 'currentTimestamp() — context instant, epoch seconds',
    apply: (_args, context) => Math.floor(context.nowMs / 1000),
  },
  {
    name: 'timestampOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'timestampOf(date) — epoch seconds',
    apply: ([value], context) => Math.floor(asDate(value ?? '', context).epochMs / 1000),
  },
  {
    name: 'date',
    minArgs: 1,
    maxArgs: 1,
    description: 'date(value) — normalise to ISO text',
    apply: ([value], context) => formatDateValue(asDate(value ?? '', context), context.timeZone),
  },
  {
    name: 'formatDate',
    minArgs: 2,
    maxArgs: 2,
    description: "formatDate(date, 'YYYY-MM-DD')",
    apply: ([value, pattern], context) => {
      const text = toStringValue(pattern ?? '');
      if (text.length > 64) throw new FormulaEvaluationError('Date pattern is too long.');
      return formatDateWithPattern(asDate(value ?? '', context), text, context.timeZone);
    },
  },
  {
    name: 'addDays',
    minArgs: 2,
    maxArgs: 2,
    description: 'addDays(date, days) — absolute 24h days',
    apply: ([value, days], context) => formatDateValue(addCalendarDays(asDate(value ?? '', context), Math.trunc(toNumber(days ?? 0))), context.timeZone),
  },
  {
    name: 'subDays',
    minArgs: 2,
    maxArgs: 2,
    description: 'subDays(date, days)',
    apply: ([value, days], context) => formatDateValue(addCalendarDays(asDate(value ?? '', context), -Math.trunc(toNumber(days ?? 0))), context.timeZone),
  },
  {
    name: 'addMonths',
    minArgs: 2,
    maxArgs: 2,
    description: 'addMonths(date, months) — calendar months',
    apply: ([value, months], context) => formatDateValue(addCalendarMonths(asDate(value ?? '', context), Math.trunc(toNumber(months ?? 0)), context.timeZone), context.timeZone),
  },
  {
    name: 'addMinutes',
    minArgs: 2,
    maxArgs: 2,
    description: 'addMinutes(date, minutes)',
    apply: ([value, minutes], context) =>
      formatDateValue({ epochMs: asDate(value ?? '', context).epochMs + Math.trunc(toNumber(minutes ?? 0)) * 60_000, dateOnly: false }, context.timeZone),
  },
  {
    name: 'diffDays',
    minArgs: 2,
    maxArgs: 2,
    description: 'diffDays(from, to) — whole calendar days',
    apply: ([from, to], context) => diffCalendarDays(asDate(from ?? '', context), asDate(to ?? '', context), context.timeZone),
  },
  {
    name: 'startOfDay',
    minArgs: 1,
    maxArgs: 1,
    description: 'startOfDay(date)',
    apply: ([value], context) => formatDateValue(startOfDay(asDate(value ?? '', context), context.timeZone), context.timeZone),
  },
  {
    name: 'startOfMonth',
    minArgs: 1,
    maxArgs: 1,
    description: 'startOfMonth(date)',
    apply: ([value], context) => formatDateValue(startOfMonth(asDate(value ?? '', context), context.timeZone), context.timeZone),
  },
  {
    name: 'yearOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'yearOf(date)',
    apply: ([value], context) => zonedParts(asDate(value ?? '', context).epochMs, context.timeZone).year,
  },
  {
    name: 'monthOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'monthOf(date) — 1..12',
    apply: ([value], context) => zonedParts(asDate(value ?? '', context).epochMs, context.timeZone).month,
  },
  {
    name: 'dayOfMonth',
    minArgs: 1,
    maxArgs: 1,
    description: 'dayOfMonth(date) — 1..31',
    apply: ([value], context) => zonedParts(asDate(value ?? '', context).epochMs, context.timeZone).day,
  },
  {
    name: 'hourOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'hourOf(date) — 0..23',
    apply: ([value], context) => zonedParts(asDate(value ?? '', context).epochMs, context.timeZone).hour,
  },
  {
    name: 'minuteOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'minuteOf(date) — 0..59',
    apply: ([value], context) => zonedParts(asDate(value ?? '', context).epochMs, context.timeZone).minute,
  },
  {
    name: 'weekdayOf',
    minArgs: 1,
    maxArgs: 1,
    description: 'weekdayOf(date) — 0=Sunday',
    apply: ([value], context) => weekdayOf(asDate(value ?? '', context), context.timeZone),
  },
];

function flattenNumbers(args: FormulaValue[]): number[] {
  const numbers: number[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) {
        if (item === null || item === undefined || item === '') continue;
        numbers.push(toNumber(item));
      }
      continue;
    }
    if (arg === null || arg === undefined || arg === '') continue;
    numbers.push(toNumber(arg));
  }
  return numbers;
}

function reduceNumbers(args: FormulaValue[], combine: (acc: number, next: number) => number, seed: number): number {
  const numbers = flattenNumbers(args);
  if (numbers.length === 0) throw new FormulaEvaluationError('No numeric values to reduce.');
  return requireFinite(numbers.reduce(combine, seed), 'math function');
}

/** Explicit allowlist (PLAN §22.1: never execute arbitrary JS, whitelist functions). */
export class FunctionRegistry {
  private readonly functions = new Map<string, FormulaFunction>();

  constructor(extra: Iterable<FormulaFunction> = []) {
    for (const fn of FUNCTIONS) this.functions.set(fn.name, fn);
    for (const fn of extra) this.register(fn);
  }

  register(fn: FormulaFunction): void {
    if (!/^[a-z][A-Za-z0-9]{1,40}$/.test(fn.name)) throw new FormulaDefinitionError(`Invalid function name "${fn.name}".`);
    if (this.functions.has(fn.name)) throw new FormulaDefinitionError(`Function "${fn.name}" is already registered.`);
    if (fn.minArgs > fn.maxArgs) throw new FormulaDefinitionError(`Function "${fn.name}" has an impossible argument range.`);
    this.functions.set(fn.name, fn);
  }

  get(name: string): FormulaFunction | undefined {
    return this.functions.get(name);
  }

  has(name: string): boolean {
    return this.functions.has(name);
  }

  names(): string[] {
    return [...this.functions.keys()].sort();
  }

  /** Names the parser may accept without an unknown-identifier error. */
  assertKnown(name: string): FormulaFunction {
    const found = this.functions.get(name);
    if (!found) throw new FormulaEvaluationError(`Unknown function "${name}".`);
    return found;
  }
}

export function normalizeContextRecord(record: Readonly<Record<string, unknown>> | undefined): FormulaRecord | undefined {
  if (record === undefined) return undefined;
  const value = toFormulaValue(record);
  return isFormulaRecord(value) ? value : {};
}
