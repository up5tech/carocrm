import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-INT.8 — the transformation compiler
 * (`PLAN_Phase_19_Advanced_Integrations.md` §9.2; `19-INT.8`).
 *
 * The plan is explicit about what a field mapping may do to a value: *"Implement a safe,
 * allowlisted transformation set. Do not evaluate arbitrary expressions, scripts or code."*
 * This file is that allowlist, made executable.
 *
 * Three decisions shape the implementation:
 *
 *  1. **A transformation is data, not code.** A spec is a plain, serialisable object with a
 *     `type` discriminator and a small, fixed set of options. There is no expression parser, no
 *     template evaluation and no function constructor — nothing an operator can type into the
 *     mapping builder becomes something the runtime executes.
 *  2. **Validation happens at compile time, never at run time.** Every option is checked once,
 *     when the mapping is compiled: an unknown type, an unknown key, an empty separator, a
 *     non-positive limit, a negative `keep`. A compiled mapping is therefore a closed set of
 *     behaviours, and the hot path (one record, one field) does no validation work at all.
 *  3. **A transformation never throws and never invents a value.** A value it cannot interpret
 *     becomes `null` — not `NaN`, not an exception in the middle of a sync run. The caller
 *     decides what a missing value means (`required` is the caller's business).
 *
 * The compiler is deliberately free of Nest, of the database and of the provider SDK: it is pure
 * data in, pure data out, and it is unit-tested as such.
 */

/**
 * The allowlisted transformation kinds.
 *
 * Every member is a *closed* shape: the compiler refuses an unknown key rather than ignoring it,
 * because an ignored key is almost always a typo that silently changes the meaning of a mapping.
 */
export type TransformSpec =
  | { readonly type: 'direct' }
  | { readonly type: 'toString' }
  | { readonly type: 'toNumber' }
  | { readonly type: 'toBoolean' }
  | { readonly type: 'toDate'; readonly options?: { readonly format?: 'iso' | 'epochSeconds' | 'epochMillis' } }
  | { readonly type: 'trim' }
  | { readonly type: 'default'; readonly options: { readonly value: unknown } }
  | { readonly type: 'constant'; readonly options: { readonly value: unknown } }
  | { readonly type: 'split'; readonly options: { readonly separator: string; readonly limit?: number } }
  | { readonly type: 'join'; readonly options: { readonly separator: string } }
  | { readonly type: 'redact'; readonly options?: { readonly keep?: number } };

/** The date formats `toDate` understands. */
export type DateFormat = 'iso' | 'epochSeconds' | 'epochMillis';

const TRANSFORM_TYPES = [
  'direct',
  'toString',
  'toNumber',
  'toBoolean',
  'toDate',
  'trim',
  'default',
  'constant',
  'split',
  'join',
  'redact',
] as const;

type TransformType = (typeof TRANSFORM_TYPES)[number];

/** A path segment is an identifier-like name. Nothing else may appear in a path. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A number written as text. Deliberately narrower than `Number()` — no hex, no `Infinity`. */
const NUMERIC_STRING_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const TRUE_STRINGS = new Set(['true', '1', 'yes']);
const FALSE_STRINGS = new Set(['false', '0', 'no']);

// ---------------------------------------------------------------------------
// small typed readers — they keep the validation explicit and free of casts
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransformType(value: unknown): value is TransformType {
  return typeof value === 'string' && (TRANSFORM_TYPES as readonly string[]).includes(value);
}

/** Refuses a key the transformation does not define. A typo is an error, not a shrug. */
function assertNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    throw new ValidationError(`Unknown key "${key}" in ${context}. Allowed keys: ${allowed.join(', ')}.`, {
      key,
      allowed: [...allowed],
    });
  }
}

function readRequiredOptions(spec: Record<string, unknown>, type: TransformType): Record<string, unknown> {
  const options = spec['options'];
  if (options === undefined) {
    throw new ValidationError(`A "${type}" transformation requires an "options" object.`, { type });
  }
  if (!isPlainObject(options)) {
    throw new ValidationError(`The "options" of a "${type}" transformation must be an object.`, { type });
  }
  return options;
}

function readSeparator(options: Record<string, unknown>, type: TransformType): string {
  const separator = options['separator'];
  if (typeof separator !== 'string') {
    throw new ValidationError(`The "separator" of a "${type}" transformation must be a string.`, { type });
  }
  if (separator.length === 0) {
    throw new ValidationError(`The "separator" of a "${type}" transformation must not be empty.`, { type });
  }
  return separator;
}

function readLimit(options: Record<string, unknown>): number | undefined {
  const limit = options['limit'];
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError('The "limit" of a "split" transformation must be a positive integer.', { limit });
  }
  return limit;
}

function readKeep(options: Record<string, unknown>): number | undefined {
  const keep = options['keep'];
  if (keep === undefined) return undefined;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) {
    throw new ValidationError('The "keep" of a "redact" transformation must be a non-negative integer.', { keep });
  }
  return keep;
}

function readDateFormat(options: Record<string, unknown>): DateFormat | undefined {
  const format = options['format'];
  if (format === undefined) return undefined;
  if (format === 'iso' || format === 'epochSeconds' || format === 'epochMillis') return format;
  throw new ValidationError(`Unknown "toDate" format "${String(format)}". Allowed: iso, epochSeconds, epochMillis.`, {
    format,
  });
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Validates a transformation spec and returns a normalized copy.
 *
 * Throws a `ValidationError` for anything the allowlist does not cover: an unknown type, an
 * unknown key, a missing or malformed `options` object, an empty separator, a non-positive
 * limit, a negative or fractional `keep`, an unknown date format.
 */
export function validateTransformSpec(spec: unknown): TransformSpec {
  if (!isPlainObject(spec)) {
    throw new ValidationError('A transformation must be an object with a "type".', { spec });
  }

  const type = spec['type'];
  if (!isTransformType(type)) {
    throw new ValidationError(
      `Unknown transformation type "${String(type)}". Allowed: ${TRANSFORM_TYPES.join(', ')}.`,
      { type, allowed: [...TRANSFORM_TYPES] },
    );
  }

  switch (type) {
    case 'direct':
      assertNoUnknownKeys(spec, ['type'], 'a "direct" transformation');
      return { type: 'direct' };
    case 'toString':
      assertNoUnknownKeys(spec, ['type'], 'a "toString" transformation');
      return { type: 'toString' };
    case 'toNumber':
      assertNoUnknownKeys(spec, ['type'], 'a "toNumber" transformation');
      return { type: 'toNumber' };
    case 'toBoolean':
      assertNoUnknownKeys(spec, ['type'], 'a "toBoolean" transformation');
      return { type: 'toBoolean' };
    case 'trim':
      assertNoUnknownKeys(spec, ['type'], 'a "trim" transformation');
      return { type: 'trim' };
    case 'toDate': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "toDate" transformation');
      const raw = spec['options'];
      if (raw === undefined) return { type: 'toDate' };
      if (!isPlainObject(raw)) {
        throw new ValidationError('The "options" of a "toDate" transformation must be an object.', {});
      }
      assertNoUnknownKeys(raw, ['format'], 'the "options" of a "toDate" transformation');
      const format = readDateFormat(raw);
      if (format === undefined) return { type: 'toDate', options: {} };
      return { type: 'toDate', options: { format } };
    }
    case 'redact': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "redact" transformation');
      const raw = spec['options'];
      if (raw === undefined) return { type: 'redact' };
      if (!isPlainObject(raw)) {
        throw new ValidationError('The "options" of a "redact" transformation must be an object.', {});
      }
      assertNoUnknownKeys(raw, ['keep'], 'the "options" of a "redact" transformation');
      const keep = readKeep(raw);
      if (keep === undefined) return { type: 'redact', options: {} };
      return { type: 'redact', options: { keep } };
    }
    case 'default': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "default" transformation');
      const options = readRequiredOptions(spec, type);
      assertNoUnknownKeys(options, ['value'], 'the "options" of a "default" transformation');
      if (!('value' in options)) {
        throw new ValidationError('A "default" transformation requires an "options.value".', {});
      }
      return { type: 'default', options: { value: options['value'] } };
    }
    case 'constant': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "constant" transformation');
      const options = readRequiredOptions(spec, type);
      assertNoUnknownKeys(options, ['value'], 'the "options" of a "constant" transformation');
      if (!('value' in options)) {
        throw new ValidationError('A "constant" transformation requires an "options.value".', {});
      }
      return { type: 'constant', options: { value: options['value'] } };
    }
    case 'split': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "split" transformation');
      const options = readRequiredOptions(spec, type);
      assertNoUnknownKeys(options, ['separator', 'limit'], 'the "options" of a "split" transformation');
      const separator = readSeparator(options, type);
      const limit = readLimit(options);
      if (limit === undefined) return { type: 'split', options: { separator } };
      return { type: 'split', options: { separator, limit } };
    }
    case 'join': {
      assertNoUnknownKeys(spec, ['type', 'options'], 'a "join" transformation');
      const options = readRequiredOptions(spec, type);
      assertNoUnknownKeys(options, ['separator'], 'the "options" of a "join" transformation');
      const separator = readSeparator(options, type);
      return { type: 'join', options: { separator } };
    }
  }
}

// ---------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------

/**
 * The textual form of a value.
 *
 * Primitives use `String(value)`; objects use a JSON representation, because `String({})` is
 * `"[object Object]"` and useless in a CRM field. A circular object cannot be serialised — it
 * becomes `null` rather than an exception inside a sync run.
 */
function stringifyValue(value: unknown): string {
  if (typeof value !== 'object') return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return '[unserializable]';
  }
}

function toStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringifyValue(value);
}

function toNumberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!NUMERIC_STRING_PATTERN.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBooleanValue(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
    return null;
  }
  if (typeof value === 'number') return value !== 0;
  return null;
}

/**
 * An epoch value as an ISO 8601 string.
 *
 * `epochSeconds` (the default) multiplies by 1000; `epochMillis` uses the number as-is. The
 * `iso` format declares a provider that sends ISO strings, so it defines no epoch unit at all:
 * a numeric value under it is a format mismatch and is refused rather than guessed.
 */
function epochToIso(epoch: number, format: DateFormat): string | null {
  if (format === 'iso') return null;
  if (!Number.isFinite(epoch)) return null;
  const millis = format === 'epochMillis' ? epoch : epoch * 1000;
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toDateValue(value: unknown, format: DateFormat): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') return epochToIso(value, format);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (NUMERIC_STRING_PATTERN.test(trimmed)) return epochToIso(Number(trimmed), format);
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString();
  }
  return null;
}

function trimValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return value.trim();
}

/** One element of a list, as text. `null` and `undefined` join as an empty segment. */
function joinElement(element: unknown): string {
  if (element === null || element === undefined) return '';
  return stringifyValue(element);
}

// ---------------------------------------------------------------------------
// compilation
// ---------------------------------------------------------------------------

/**
 * Compiles a transformation into a function.
 *
 * The spec is re-validated here so that a malformed spec can never escape as a `TypeError` deep
 * inside a sync run — it is refused with a `ValidationError` at compile time, like every other
 * mistake in a mapping.
 *
 * The returned function never throws: a value it cannot interpret becomes `null`.
 */
export function compileTransform(spec: TransformSpec): (value: unknown) => unknown {
  const validated = validateTransformSpec(spec);

  switch (validated.type) {
    case 'direct':
      return (value) => value;
    case 'toString':
      return (value) => toStringValue(value);
    case 'toNumber':
      return (value) => toNumberValue(value);
    case 'toBoolean':
      return (value) => toBooleanValue(value);
    case 'toDate': {
      const format = validated.options?.format ?? 'epochSeconds';
      return (value) => toDateValue(value, format);
    }
    case 'trim':
      return (value) => trimValue(value);
    case 'default': {
      const fallback = validated.options.value;
      return (value) => (value === null || value === undefined ? fallback : value);
    }
    case 'constant': {
      const constant = validated.options.value;
      return () => constant;
    }
    case 'split': {
      const separator = validated.options.separator;
      const limit = validated.options.limit;
      return (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
          return limit === undefined ? value.split(separator) : value.split(separator, limit);
        }
        if (Array.isArray(value)) return value;
        return null;
      };
    }
    case 'join': {
      const separator = validated.options.separator;
      return (value) => {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) return value.map(joinElement).join(separator);
        if (typeof value === 'string') return value;
        return null;
      };
    }
    case 'redact': {
      const keep = validated.options?.keep ?? 0;
      return (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
          return value.slice(0, keep) + '*'.repeat(Math.max(0, value.length - keep));
        }
        if (typeof value === 'number') return '*'.repeat(String(value).length);
        return null;
      };
    }
  }
}

/**
 * Validates and compiles in one step.
 *
 * This is what a mapping builder calls: the spec comes from a request body, so it is untrusted
 * until it has been through the allowlist.
 */
export function compileTransformSafe(spec: unknown): (value: unknown) => unknown {
  return compileTransform(validateTransformSpec(spec));
}

// ---------------------------------------------------------------------------
// field mappings
// ---------------------------------------------------------------------------

/** One field mapping, as the mapping builder stores it. */
export interface FieldMappingInput {
  /** A dotted path into the SOURCE object, e.g. 'organizer.email' or 'summary'. */
  readonly sourcePath: string;
  /** The CRM field the value is written to. */
  readonly targetField: string;
  /** The transformation applied after the source value is read. `null` means a direct copy. */
  readonly transform: TransformSpec | null;
  /** Whether a missing value is an error for the caller. */
  readonly required: boolean;
  /**
   * Whether the mapping may write a **protected** CRM field.
   *
   * A protected field decides who may act on a record or what the record means financially or
   * for consent. An imported payload never writes one unless the mapping says so — and saying so
   * is the "explicit reviewed mapping" of plan §14.2. The flag is per field, so one reviewed
   * target does not unlock the rest.
   */
  readonly allowProtected?: boolean | undefined;
}

/** A compiled field mapping: a validated target and a ready-to-run reader. */
export interface CompiledFieldMapping {
  readonly targetField: string;
  readonly required: boolean;
  /** Whether this mapping may write a protected field. */
  readonly allowProtected: boolean;
  /** Reads the source path and applies the transformation. Returns `undefined` when absent. */
  readonly apply: (source: Readonly<Record<string, unknown>>) => unknown;
}

/**
 * Resolves a dotted path against a source object.
 *
 * Only *own* properties are read, so a path can never reach the prototype chain. A missing
 * segment yields `undefined` and never throws — a source object that simply does not carry the
 * field is an ordinary situation, not an exception.
 */
export function readPath(source: Readonly<Record<string, unknown>>, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0) return undefined;

  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (segment.length === 0) return undefined;
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertValidSourcePath(sourcePath: unknown): string {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new ValidationError('A field mapping requires a non-empty "sourcePath".', { sourcePath });
  }
  for (const segment of sourcePath.split('.')) {
    if (!IDENTIFIER_PATTERN.test(segment)) {
      throw new ValidationError(
        `"${sourcePath}" is not a valid source path. Every segment must match ${IDENTIFIER_PATTERN.source}.`,
        { sourcePath, segment },
      );
    }
  }
  return sourcePath;
}

function assertValidTargetField(targetField: unknown): string {
  if (typeof targetField !== 'string' || targetField.length === 0) {
    throw new ValidationError('A field mapping requires a non-empty "targetField".', { targetField });
  }
  if (!IDENTIFIER_PATTERN.test(targetField)) {
    throw new ValidationError(
      `"${targetField}" is not a valid target field. It must match ${IDENTIFIER_PATTERN.source}.`,
      { targetField },
    );
  }
  return targetField;
}

/**
 * Compiles a list of field mappings.
 *
 * Everything that can be wrong with a mapping is wrong *here*, at compile time: a malformed
 * source path, a malformed target field, an invalid transformation, two mappings writing the
 * same field. A compiled mapping is a closed set of behaviours that the sync runtime can call
 * per record without further checks.
 */
export function compileFieldMappings(mappings: readonly FieldMappingInput[]): CompiledFieldMapping[] {
  if (!Array.isArray(mappings)) {
    throw new ValidationError('Field mappings must be an array.', {});
  }

  const targets = new Set<string>();

  return mappings.map((mapping, index) => {
    if (!isPlainObject(mapping)) {
      throw new ValidationError(`Field mapping #${index} must be an object.`, { index });
    }

    // The declared type is a convenience for callers; at run time the mapping arrives from a
    // request body and every field is therefore untrusted.
    const record = mapping as unknown as Record<string, unknown>;

    const sourcePath = assertValidSourcePath(record['sourcePath']);
    const targetField = assertValidTargetField(record['targetField']);

    if (targets.has(targetField)) {
      throw new ValidationError(`Two field mappings target "${targetField}".`, { targetField, index });
    }
    targets.add(targetField);

    const rawTransform = record['transform'];
    const transform = rawTransform === undefined || rawTransform === null ? null : validateTransformSpec(rawTransform);
    const compiled = transform === null ? null : compileTransform(transform);

    const required = record['required'];
    if (required !== undefined && typeof required !== 'boolean') {
      throw new ValidationError(`The "required" flag of field mapping #${index} must be a boolean.`, { index });
    }

    const allowProtected = record['allowProtected'];
    if (allowProtected !== undefined && typeof allowProtected !== 'boolean') {
      throw new ValidationError(`The "allowProtected" flag of field mapping #${index} must be a boolean.`, { index });
    }

    return {
      targetField,
      required: required === true,
      allowProtected: allowProtected === true,
      apply: (source: Readonly<Record<string, unknown>>): unknown => {
        const raw = readPath(source, sourcePath);
        // An absent path is not a value: it stays absent, and `required` is the caller's business.
        if (raw === undefined) return undefined;
        if (compiled === null) return raw;
        // A present value — including an explicit `null` — is what the transformation sees.
        return compiled(raw);
      },
    };
  });
}
