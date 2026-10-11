/**
 * Generic query translator for the CRM entity API (PLAN §15).
 *
 * The engine never emits SQL text on its own: it turns an untrusted, EspoCRM-like
 * query request into a *validated* structure of column references + operators that
 * the persistence layer (apps/api/src/entity/entity-record.store.ts) binds into
 * Kysely expressions with parameters only. Field names and operators are validated
 * against entity metadata, so a raw identifier taken from user input can never be
 * interpolated into a statement.
 */
import { InvalidQueryError } from '@carocrm/core/errors/index.js';

export type QueryOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'like'
  | 'isNull'
  | 'isNotNull'
  | 'in'
  | 'notIn'
  | 'between'
  | 'equalsExact';

export const QUERY_OPERATORS: readonly QueryOperator[] = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'like',
  'isNull',
  'isNotNull',
  'in',
  'notIn',
  'between',
  'equalsExact',
];

/** Columns that exist physically on the generic `entity_records` table. */
export const PHYSICAL_COLUMNS = [
  'id',
  'name',
  'entity_type',
  'created_at',
  'modified_at',
  'assigned_user_id',
  'created_by_id',
  'modified_by_id',
  'deleted_at',
  'team_ids',
  'version',
] as const;

export type PhysicalColumn = (typeof PHYSICAL_COLUMNS)[number];

/** Logical (API) field name -> physical column. Everything else lives in `attrs`. */
export const PHYSICAL_FIELD_MAP: Readonly<Record<string, PhysicalColumn>> = {
  id: 'id',
  name: 'name',
  createdAt: 'created_at',
  modifiedAt: 'modified_at',
  assignedUserId: 'assigned_user_id',
  createdById: 'created_by_id',
  modifiedById: 'modified_by_id',
  deletedAt: 'deleted_at',
  deleted: 'deleted_at',
  teams: 'team_ids',
  version: 'version',
};

export type ColumnRef =
  | { readonly kind: 'physical'; readonly column: PhysicalColumn }
  | { readonly kind: 'attr'; readonly field: string };

/** Metadata port used for validation (satisfied by MetadataRegistry). */
export interface QueryMetadataPort {
  hasEntity(entity: string): boolean;
  getField(entity: string, field: string): { readonly type: string } | undefined;
}

export interface QueryCriterion {
  readonly ref: ColumnRef;
  /** Logical field name as used by the API (for error reporting). */
  readonly field: string;
  readonly operator: QueryOperator;
  readonly value: unknown;
  /** Metadata field type (undefined for physical bookkeeping columns). */
  readonly fieldType?: string | undefined;
}

export type QueryFilter =
  | { readonly type: 'criterion'; readonly criterion: QueryCriterion }
  | { readonly type: 'group'; readonly op: 'and' | 'or'; readonly children: readonly QueryFilter[] };

export interface OrderClause {
  readonly ref: ColumnRef;
  readonly field: string;
  readonly direction: 'asc' | 'desc';
  readonly fieldType?: string | undefined;
}

export interface TranslatedQuery {
  readonly entity: string;
  readonly select: readonly string[] | undefined;
  /** Top level filters, combined with AND. */
  readonly filter: readonly QueryFilter[];
  /** Flattened criterion list (handy for validation/logging). */
  readonly criteria: readonly QueryCriterion[];
  readonly orderBy: readonly OrderClause[];
  readonly offset: number;
  readonly limit: number;
  readonly includeDeleted: boolean;
}

/** Raw query request as accepted by the HTTP layer — everything here is untrusted (PLAN §15.1). */
export interface QueryRequest {
  readonly entity: string;
  readonly select?: unknown;
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly order?: unknown;
  readonly offset?: unknown;
  readonly maxSize?: unknown;
  readonly limit?: unknown;
  readonly includeDeleted?: unknown;
}

export const DEFAULT_MAX_SIZE = 20;
export const MAX_MAX_SIZE = 500;

const NO_VALUE_OPERATORS: ReadonlySet<QueryOperator> = new Set(['isNull', 'isNotNull']);
const ARRAY_OPERATORS: ReadonlySet<QueryOperator> = new Set(['in', 'notIn', 'between']);

const NUMERIC_TYPES: ReadonlySet<string> = new Set(['int', 'float', 'decimal', 'currency', 'aggregationCount']);
const DATE_TYPES: ReadonlySet<string> = new Set(['date', 'datetime']);

const OPERATOR_ALIASES: Readonly<Record<string, QueryOperator>> = {
  equals: 'equals',
  eq: 'equals',
  equal: 'equals',
  notequals: 'notEquals',
  ne: 'notEquals',
  notequal: 'notEquals',
  greaterthan: 'greaterThan',
  gt: 'greaterThan',
  after: 'greaterThan',
  greaterthanorequal: 'greaterThanOrEqual',
  greaterthanorequals: 'greaterThanOrEqual',
  gte: 'greaterThanOrEqual',
  lessthan: 'lessThan',
  lt: 'lessThan',
  before: 'lessThan',
  lessthanorequal: 'lessThanOrEqual',
  lessthanorequals: 'lessThanOrEqual',
  lte: 'lessThanOrEqual',
  like: 'like',
  contains: 'like',
  isnull: 'isNull',
  none: 'isNull',
  isnotnull: 'isNotNull',
  notnull: 'isNotNull',
  notnone: 'isNotNull',
  in: 'in',
  notin: 'notIn',
  between: 'between',
  equalsexact: 'equalsExact',
  exact: 'equalsExact',
};

/** Translate an untrusted query request into a validated, parameterizable structure. */
export function parseQueryRequest(input: QueryRequest, metadata: QueryMetadataPort): TranslatedQuery {
  const entity = input.entity;
  if (!metadata.hasEntity(entity)) {
    throw new InvalidQueryError(`Unknown entity "${entity}".`, { entity });
  }

  const rawWhere = parseWherePayload(input.where);
  const filter = rawWhere.map((node) => buildFilter(node, entity, metadata));
  const criteria = flattenFilters(filter);

  const select = parseSelect(input.select, entity, metadata);
  const orderBy = parseOrderBy(input.orderBy, input.order, entity, metadata);
  const offset = parseNonNegativeInt(input.offset, 'offset', 0);
  const limit = parseLimit(input);
  const includeDeleted =
    input.includeDeleted === true ||
    input.includeDeleted === 'true' ||
    input.includeDeleted === '1' ||
    criteria.some((c) => c.ref.kind === 'physical' && c.ref.column === 'deleted_at');

  return { entity, select, filter, criteria, orderBy, offset, limit, includeDeleted };
}

/** Resolve a logical field name to a physical column or an `attrs` JSON key. */
export function columnRef(field: string): ColumnRef {
  const physical = PHYSICAL_FIELD_MAP[field];
  if (physical) return { kind: 'physical', column: physical };
  return { kind: 'attr', field: toCamelCase(field) };
}

/** `account_id` / `accountId` -> `accountId` (attrs keys are stored in camelCase). */
export function toCamelCase(field: string): string {
  if (!field.includes('_')) return field;
  return field
    .split('_')
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join('');
}

export function normalizeOperator(raw: string): QueryOperator {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapped = OPERATOR_ALIASES[key];
  if (!mapped) {
    throw new InvalidQueryError(`Unsupported operator "${raw}".`, { operator: raw });
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// where
// ---------------------------------------------------------------------------

type RawFilterNode = { type: 'criterion'; field: string; operator?: string | undefined; value: unknown } | { type: 'group'; op: 'and' | 'or'; children: RawFilterNode[] };

function parseWherePayload(where: unknown): RawFilterNode[] {
  if (where === undefined || where === null || where === '') return [];
  if (typeof where === 'string') {
    let decoded: unknown;
    try {
      decoded = JSON.parse(where);
    } catch {
      throw new InvalidQueryError('Parameter "where" must be valid JSON.');
    }
    return parseWherePayload(decoded);
  }
  if (Array.isArray(where)) {
    const out: RawFilterNode[] = [];
    for (const item of where) out.push(...parseWhereItem(item));
    return out;
  }
  if (isRecord(where)) return parseWhereObject(where);
  throw new InvalidQueryError('Parameter "where" must be an object or an array of objects.');
}

function parseWhereItem(item: unknown): RawFilterNode[] {
  if (item === undefined || item === null) return [];
  if (Array.isArray(item)) return parseWherePayload(item);
  if (isRecord(item)) return parseWhereObject(item);
  throw new InvalidQueryError('Each "where" entry must be an object.');
}

/**
 * EspoCRM-like criterion:  { field, value, attributeData: { operator } }
 * Group:                  { or: [...], and: [...] }
 * Map shorthand:          { name: 'Acme', createdAt: { greaterThan: '...' } }
 */
function parseWhereObject(node: Record<string, unknown>): RawFilterNode[] {
  const group = parseGroupKeys(node);
  if (group) return [group];

  if (typeof node['field'] === 'string') {
    const attributeData = isRecord(node['attributeData']) ? node['attributeData'] : undefined;
    const operator = firstString(node['operator'], attributeData?.['operator']);
    return [{ type: 'criterion', field: node['field'], ...(operator !== undefined ? { operator } : {}), value: node['value'] }];
  }

  const out: RawFilterNode[] = [];
  for (const [field, value] of Object.entries(node)) {
    out.push(parseMapEntry(field, value));
  }
  return out;
}

function parseMapEntry(field: string, value: unknown): RawFilterNode {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0] && OPERATOR_ALIASES[normalizeKey(entries[0][0])]) {
      const [alias, operand] = entries[0];
      return { type: 'criterion', field, operator: alias, value: operand };
    }
    if (typeof value['operator'] === 'string') {
      return { type: 'criterion', field, operator: value['operator'], value: value['value'] };
    }
  }
  return { type: 'criterion', field, value };
}

function parseGroupKeys(node: Record<string, unknown>): RawFilterNode | undefined {
  const or = node['or'];
  const and = node['and'];
  if (Array.isArray(or)) {
    return { type: 'group', op: 'or', children: or.flatMap((child) => parseWhereItem(child)) };
  }
  if (Array.isArray(and)) {
    return { type: 'group', op: 'and', children: and.flatMap((child) => parseWhereItem(child)) };
  }
  return undefined;
}

function buildFilter(node: RawFilterNode, entity: string, metadata: QueryMetadataPort): QueryFilter {
  if (node.type === 'group') {
    const children = node.children.map((child) => buildFilter(child, entity, metadata));
    if (children.length === 0) {
      throw new InvalidQueryError(`Empty "${node.op}" group in "where".`);
    }
    return { type: 'group', op: node.op, children };
  }
  return { type: 'criterion', criterion: buildCriterion(node, entity, metadata) };
}

function buildCriterion(node: Extract<RawFilterNode, { type: 'criterion' }>, entity: string, metadata: QueryMetadataPort): QueryCriterion {
  const resolved = resolveField(node.field, entity, metadata);
  const operator = node.operator === undefined ? 'equals' : normalizeOperator(node.operator);
  const value = coerce(node.value, operator, resolved.fieldType, resolved.field, entity);
  return {
    ref: resolved.ref,
    field: resolved.field,
    operator,
    value,
    ...(resolved.fieldType !== undefined ? { fieldType: resolved.fieldType } : {}),
  };
}

function coerce(value: unknown, operator: QueryOperator, fieldType: string | undefined, field: string, entity: string): unknown {
  if (NO_VALUE_OPERATORS.has(operator)) return null;

  if (ARRAY_OPERATORS.has(operator)) {
    if (!Array.isArray(value)) {
      throw new InvalidQueryError(`Operator "${operator}" requires an array value for field "${field}".`, { entity, field });
    }
    if (operator === 'between' && value.length !== 2) {
      throw new InvalidQueryError(`Operator "between" requires exactly 2 values for field "${field}".`, { entity, field });
    }
    if (operator !== 'between' && value.length === 0) {
      throw new InvalidQueryError(`Operator "${operator}" requires at least one value for field "${field}".`, { entity, field });
    }
    return value.map((item) => coerceScalar(item, fieldType, field, entity));
  }

  if (value === null || value === undefined) return null;
  return coerceScalar(value, fieldType, field, entity);
}

function coerceScalar(value: unknown, fieldType: string | undefined, field: string, entity: string): unknown {
  if (value === null || value === undefined) return null;

  if (fieldType === 'bool') {
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    throw new InvalidQueryError(`Field "${field}" expects a boolean.`, { entity, field });
  }

  if (NUMERIC_TYPES.has(fieldType ?? '')) {
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    if (Number.isNaN(num)) {
      throw new InvalidQueryError(`Field "${field}" expects a number.`, { entity, field });
    }
    return num;
  }

  if (DATE_TYPES.has(fieldType ?? '') && !(value instanceof Date)) {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      throw new InvalidQueryError(`Field "${field}" expects a date.`, { entity, field });
    }
    return date.toISOString();
  }

  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

function parseSelect(select: unknown, entity: string, metadata: QueryMetadataPort): readonly string[] | undefined {
  if (select === undefined || select === null || select === '') return undefined;
  const fields = typeof select === 'string' ? select.split(',') : Array.isArray(select) ? select.map((s) => String(s)) : [String(select)];
  const out: string[] = [];
  for (const raw of fields) {
    const field = raw.trim();
    if (field === '') continue;
    const resolved = resolveField(field, entity, metadata);
    if (!out.includes(resolved.field)) out.push(resolved.field);
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// orderBy
// ---------------------------------------------------------------------------

function parseOrderBy(orderBy: unknown, order: unknown, entity: string, metadata: QueryMetadataPort): readonly OrderClause[] {
  if (orderBy === undefined || orderBy === null || orderBy === '') return [];

  const rawTokens: string[] =
    typeof orderBy === 'string'
      ? orderBy.split(',')
      : Array.isArray(orderBy)
        ? orderBy.map((item) => (isRecord(item) ? String(item['field'] ?? '') : String(item)))
        : [String(orderBy)];

  const directions = parseDirectionList(order, rawTokens.length);
  const clauses: OrderClause[] = [];

  rawTokens.forEach((rawToken, index) => {
    const token = rawToken.trim();
    if (token === '') return;
    let field = token;
    let direction: 'asc' | 'desc' | undefined;

    const bare = token.toLowerCase();
    if ((bare === 'asc' || bare === 'desc') && clauses.length > 0) {
      // `orderBy=createdAt,desc` — a bare direction token binds to the previous field.
      const previous = clauses[clauses.length - 1] as OrderClause;
      clauses[clauses.length - 1] = { ...previous, direction: bare === 'desc' ? 'desc' : 'asc' };
      return;
    }

    if (token.startsWith('-')) {
      field = token.slice(1);
      direction = 'desc';
    } else {
      const split = token.match(/^(.+?)[.:\s](asc|desc)$/i);
      if (split?.[1] && split[2]) {
        field = split[1];
        direction = split[2].toLowerCase() === 'desc' ? 'desc' : 'asc';
      }
    }

    const resolved = resolveField(field, entity, metadata);
    const inferred = direction ?? directions[index] ?? 'asc';
    clauses.push({
      ref: resolved.ref,
      field: resolved.field,
      direction: inferred,
      ...(resolved.fieldType !== undefined ? { fieldType: resolved.fieldType } : {}),
    });
  });

  return clauses;
}

/** `order` accepts `asc`, `desc` or a positional list such as `asc-desc` / `asc,desc`. */
function parseDirectionList(order: unknown, count: number): ('asc' | 'desc')[] {
  if (order === undefined || order === null || order === '') return new Array(count).fill('asc');
  const tokens = (Array.isArray(order) ? order.map((item) => String(item)) : [String(order)]).flatMap((item) => item.split(/[,;]/));
  const out: ('asc' | 'desc')[] = [];
  for (const token of tokens) {
    for (const part of token.split('-')) {
      const value = part.trim().toLowerCase();
      if (value === '') continue;
      if (value !== 'asc' && value !== 'desc') {
        throw new InvalidQueryError(`Unsupported order direction "${part}".`, { direction: part });
      }
      out.push(value);
    }
  }
  while (out.length < count) out.push('asc');
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ResolvedField {
  readonly field: string;
  readonly ref: ColumnRef;
  readonly fieldType?: string | undefined;
}

/**
 * Map a user supplied field name to a storage reference. Accepts the canonical
 * camelCase name as well as snake_case variants. Unknown fields are rejected —
 * nothing user-controlled ever reaches the statement as an identifier.
 */
export function resolveField(input: string, entity: string, metadata: QueryMetadataPort): ResolvedField {
  const candidates = input.includes('_') ? [input, toCamelCase(input)] : [input];
  for (const name of candidates) {
    const column = PHYSICAL_FIELD_MAP[name];
    if (column) return { field: name, ref: { kind: 'physical', column } };
    const def = metadata.getField(entity, name);
    if (def) return { field: name, ref: { kind: 'attr', field: toCamelCase(name) }, fieldType: def.type };
  }
  throw new InvalidQueryError(`Unknown field "${input}" for entity "${entity}".`, { entity, field: input });
}

function parseLimit(input: QueryRequest): number {
  const raw = input.maxSize ?? input.limit;
  const value = parseNonNegativeInt(raw, 'maxSize', DEFAULT_MAX_SIZE);
  if (value <= 0) return DEFAULT_MAX_SIZE;
  return Math.min(value, MAX_MAX_SIZE);
}

function parseNonNegativeInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidQueryError(`Parameter "${name}" must be a non-negative number.`, { [name]: raw });
  }
  return Math.floor(value);
}

function flattenFilters(filters: readonly QueryFilter[]): QueryCriterion[] {
  const out: QueryCriterion[] = [];
  const walk = (list: readonly QueryFilter[]): void => {
    for (const item of list) {
      if (item.type === 'criterion') out.push(item.criterion);
      else walk(item.children);
    }
  };
  walk(filters);
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
