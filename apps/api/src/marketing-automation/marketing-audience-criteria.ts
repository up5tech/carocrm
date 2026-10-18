import {
  isSegmentEntityType,
  SEGMENT_ENTITY_TYPES,
  type SegmentEntityType,
} from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.4 — the dynamic audience criteria contract (§5.2, §6.1).
 *
 * A stored audience is **data**, never executable content. §6.1 says it directly: "Do not store raw SQL or
 * executable code in `criteria_json`", and §5.2 requires validation "against entity/field allowlists,
 * types, operators and ACL-aware query rules. Never execute user-provided SQL." This module is the whole of
 * that boundary: it parses the stored JSON into a closed shape, refuses anything outside it, and hands the
 * result to the platform's own query engine, which validates field names against metadata and binds every
 * value as a parameter. Nothing here assembles a statement.
 *
 * The shape is deliberately flat: one clause per record type, each clause a set of filters combined with
 * `all`/`any`. There is no nesting, no sub-query, no expression language and no cross-entity join — §5.2
 * asks for exactly those limits ("avoid an unbounded cross-entity join or arbitrary formula query").
 */

export const CRITERIA_VERSION = 1;

const MAX_CLAUSES = SEGMENT_ENTITY_TYPES.length;
const MAX_FILTERS_PER_CLAUSE = 20;
const MAX_IN_VALUES = 50;
const MAX_VALUE_LENGTH = 512;
const FIELD_PATTERN = /^[a-z][A-Za-z0-9]{0,40}$/;

/**
 * Operators a stored audience may use — exactly the vocabulary the platform query engine accepts
 * (`QUERY_OPERATORS` in `packages/query-engine`, plus its own aliases). Naming anything else here would
 * store a criterion that cannot be executed, so the list is deliberately the engine's and not a wish.
 */
export const CRITERIA_OPERATORS = [
  "equals",
  "notEquals",
  "equalsExact",
  "contains",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "isNull",
  "isNotNull",
  "in",
  "notIn",
  "between",
] as const;
export type CriteriaOperator = (typeof CRITERIA_OPERATORS)[number];

/** Which operators make sense for which metadata field type — the type check §5.2 asks for. */
const OPERATORS_BY_TYPE: Readonly<Record<string, readonly CriteriaOperator[]>> = {
  varchar: ["equals", "notEquals", "equalsExact", "contains", "isNull", "isNotNull", "in", "notIn"],
  text: ["equals", "notEquals", "contains", "isNull", "isNotNull"],
  email: ["equals", "notEquals", "contains", "isNull", "isNotNull"],
  phone: ["equals", "notEquals", "contains", "isNull", "isNotNull"],
  url: ["equals", "notEquals", "contains", "isNull", "isNotNull"],
  enum: ["equals", "notEquals", "in", "notIn", "isNull", "isNotNull"],
  multiEnum: ["contains", "isNull", "isNotNull"],
  bool: ["equals", "notEquals"],
  int: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "in", "notIn", "isNull", "isNotNull"],
  float: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"],
  decimal: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"],
  currency: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"],
  date: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"],
  datetime: ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"],
  link: ["equals", "notEquals", "in", "notIn", "isNull", "isNotNull"],
};

/** Field names that must never be a filter, whatever their type says. */
const DENIED_FIELDS: readonly string[] = [
  "id",
  "deletedAt",
  "password",
  "apiKey",
  "token",
  "tokenHash",
  "emailHash",
  "teams",
  "assignedUsers",
];

/** Fields that are audit columns rather than business attributes, allowed but capped to date operators. */
const AUDIT_FIELDS: readonly string[] = ["createdAt", "modifiedAt"];

export interface CriteriaFilter {
  readonly field: string;
  readonly operator: CriteriaOperator;
  readonly value?: string | number | boolean | readonly string[] | null | undefined;
}

export interface CriteriaClause {
  readonly entityType: SegmentEntityType;
  readonly match: "all" | "any";
  readonly filters: readonly CriteriaFilter[];
}

export interface AudienceCriteria {
  readonly version: number;
  readonly clauses: readonly CriteriaClause[];
}

export interface FieldLookup {
  /** Metadata read: the field's declared type, or `undefined` when the entity has no such field. */
  fieldType(entity: string, field: string): string | undefined;
  /**
   * ACL read: may *this caller* filter on this field? Filtering is a read channel — a boolean "does anyone
   * with X have this address?" answer discloses a record the caller may not see — so the caller's field
   * permission decides, not the definition alone (§5.2, §9.2).
   */
  filterable(entity: string, field: string): boolean;
}

/**
 * Is a metadata field usable as an audience filter? Its type must have a defined operator set (so the
 * comparison means something), and it must not have been opted out of filtering in metadata. This is the
 * field allowlist §5.2 asks for, derived from the definition rather than a second hard-coded schema.
 */
export function fieldIsFilterable(field: { type: string; inFilter?: boolean | undefined } | undefined): boolean {
  if (field === undefined) return false;
  if (field.inFilter === false) return false;
  return Object.prototype.hasOwnProperty.call(OPERATORS_BY_TYPE, field.type);
}

export interface CriteriaValidation {
  readonly ok: boolean;
  readonly criteria?: AudienceCriteria;
  readonly errors: readonly string[];
}

/** Parse and validate a stored `criteriaJson`. Never throws: a bad stored audience is reported, not fatal. */
export function validateCriteria(raw: unknown, lookup: FieldLookup): CriteriaValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["Audience criteria must be a JSON object."] };
  }
  const input = raw as Record<string, unknown>;
  if (input["version"] !== CRITERIA_VERSION) {
    return {
      ok: false,
      errors: [`Audience criteria version ${String(input["version"])} is not supported; this build writes version ${String(CRITERIA_VERSION)}.`],
    };
  }
  const clauses = input["clauses"];
  if (!Array.isArray(clauses) || clauses.length === 0) {
    return { ok: false, errors: ["Audience criteria needs at least one clause."] };
  }
  if (clauses.length > MAX_CLAUSES) {
    return { ok: false, errors: [`Audience criteria has at most ${String(MAX_CLAUSES)} clauses (one per supported record type).`] };
  }

  const parsed: CriteriaClause[] = [];
  const seen = new Set<string>();
  for (const [index, clause] of clauses.entries()) {
    const problem = parseClause(clause, index, lookup, errors);
    if (problem === undefined) continue;
    if (seen.has(problem.entityType)) {
      errors.push(`Clause ${String(index + 1)} repeats record type "${problem.entityType}"; one clause per type.`);
      continue;
    }
    seen.add(problem.entityType);
    parsed.push(problem);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, criteria: { version: CRITERIA_VERSION, clauses: parsed }, errors };
}

function parseClause(
  clause: unknown,
  index: number,
  lookup: FieldLookup,
  errors: string[],
): CriteriaClause | undefined {
  const label = `Clause ${String(index + 1)}`;
  if (typeof clause !== "object" || clause === null || Array.isArray(clause)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }
  const input = clause as Record<string, unknown>;
  if (!isSegmentEntityType(input["entityType"])) {
    errors.push(
      `${label} names record type ${String(input["entityType"])}, which cannot be an audience. Supported: ${SEGMENT_ENTITY_TYPES.join(", ")} (§5.2).`,
    );
    return undefined;
  }
  const entityType = input["entityType"];
  if (input["match"] !== "all" && input["match"] !== "any") {
    errors.push(`${label} must combine its filters with "all" or "any".`);
    return undefined;
  }
  const filters = input["filters"];
  if (!Array.isArray(filters) || filters.length === 0) {
    errors.push(`${label} needs at least one filter; an empty clause would match every record of that type.`);
    return undefined;
  }
  if (filters.length > MAX_FILTERS_PER_CLAUSE) {
    errors.push(`${label} has at most ${String(MAX_FILTERS_PER_CLAUSE)} filters.`);
    return undefined;
  }

  const parsed: CriteriaFilter[] = [];
  for (const [position, filter] of filters.entries()) {
    const item = parseFilter(filter, `${label} filter ${String(position + 1)}`, entityType, lookup, errors);
    if (item !== undefined) parsed.push(item);
  }
  if (parsed.length === 0) return undefined;
  return { entityType, match: input["match"], filters: parsed };
}

function parseFilter(
  filter: unknown,
  label: string,
  entityType: SegmentEntityType,
  lookup: FieldLookup,
  errors: string[],
): CriteriaFilter | undefined {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }
  const input = filter as Record<string, unknown>;
  const field = typeof input["field"] === "string" ? input["field"] : "";
  if (!FIELD_PATTERN.test(field)) {
    errors.push(`${label} has an invalid field name.`);
    return undefined;
  }
  if (DENIED_FIELDS.includes(field)) {
    errors.push(`${label} may not filter on "${field}".`);
    return undefined;
  }
  const type = lookup.fieldType(entityType, field);
  if (type === undefined) {
    errors.push(`${label} filters "${entityType}.${field}", which this platform does not define.`);
    return undefined;
  }
  if (!lookup.filterable(entityType, field)) {
    errors.push(`${label} filters "${entityType}.${field}", which you are not allowed to read.`);
    return undefined;
  }
  const allowed = operatorsFor(field, type);
  const rawOperator = input["operator"];
  const operator = typeof rawOperator === "string"
    ? (allowed as readonly string[]).includes(rawOperator)
      ? (rawOperator as CriteriaOperator)
      : undefined
    : undefined;
  if (operator === undefined) {
    errors.push(
      `${label} cannot use operator ${String(rawOperator)} on "${entityType}.${field}" (a ${type}). Allowed: ${allowed.join(", ")}.`,
    );
    return undefined;
  }

  const value = input["value"];
  const problem = checkValue(operator, value, field);
  if (problem !== undefined) {
    errors.push(`${label}: ${problem}`);
    return undefined;
  }
  return value === undefined
    ? { field, operator }
    : { field, operator, value: value as CriteriaFilter["value"] };
}

/** The operator set a field may use: its declared type, narrowed for audit columns. */
function operatorsFor(field: string, type: string): readonly CriteriaOperator[] {
  const base = OPERATORS_BY_TYPE[type] ?? [];
  if (!AUDIT_FIELDS.includes(field)) return base;
  return base.filter((operator) =>
    ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between"].includes(operator),
  );
}

function checkValue(operator: CriteriaOperator, value: unknown, field: string): string | undefined {
  if (operator === "isNull" || operator === "isNotNull") {
    return value === undefined || value === null ? undefined : `"${field}" with ${operator} takes no value.`;
  }
  if (value === undefined || value === null) return `"${field}" with ${operator} needs a value.`;

  if (operator === "between") {
    if (!Array.isArray(value) || value.length !== 2) return `"${field}" with between needs exactly two values.`;
    return value.every(isScalar) ? undefined : `"${field}" between values must be text or numbers.`;
  }
  if (operator === "in" || operator === "notIn") {
    if (!Array.isArray(value) || value.length === 0) return `"${field}" with ${operator} needs a list of values.`;
    if (value.length > MAX_IN_VALUES) return `"${field}" lists at most ${String(MAX_IN_VALUES)} values.`;
    return value.every(isScalar) ? undefined : `"${field}" list values must be text or numbers.`;
  }
  if (typeof value === "boolean") {
    return operator === "equals" || operator === "notEquals"
      ? undefined
      : `"${field}" cannot compare true/false with ${operator}.`;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `"${field}" needs a finite number.`;
  }
  if (typeof value !== "string") return `"${field}" needs text, a number or true/false.`;
  if (value.length > MAX_VALUE_LENGTH) return `"${field}" value is too long.`;
  // A CRLF inside a filter value would be a header-injection payload travelling into a rendered message
  // later; the value is a bind parameter so it cannot reach SQL, but no legitimate filter text contains a
  // newline either (§9.4).
  if (/[\r\n]/.test(value) || value.includes(String.fromCharCode(0))) {
    return `"${field}" value contains an illegal character.`;
  }
  return undefined;
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Translate a validated clause into the platform's list-query shape, which `EntityCrudService.list` then
 * runs through the query engine: field names are re-validated against metadata and every value is bound as
 * a parameter. `match: 'any'` becomes the engine's `or` group. This function moves data between two closed
 * shapes and never builds SQL text (AGENTS.md §5.2).
 */
export function clauseToListQuery(
  clause: CriteriaClause,
  options: { readonly maxSize: number; readonly offset?: number },
): { where: unknown[]; orderBy: string; order: string; maxSize: number; offset: number; total: true } {
  const filters = clause.filters.map((filter) => ({
    field: filter.field,
    operator: filter.operator,
    ...(filter.value !== undefined ? { value: filter.value } : {}),
  }));
  return {
    where: clause.match === "any" && filters.length > 1 ? [{ or: filters }] : filters,
    orderBy: "createdAt",
    order: "asc",
    maxSize: options.maxSize,
    offset: options.offset ?? 0,
    total: true,
  };
}

/** A stable fingerprint of the criteria, so a changed audience is detectable from a snapshot (§5.2). */
export function criteriaFingerprint(criteria: AudienceCriteria): string {
  const canonical = criteria.clauses
    .map((clause) =>
      `${clause.entityType}:${clause.match}:` +
      clause.filters
        .map((filter) => `${filter.field}|${filter.operator}|${JSON.stringify(filter.value ?? null)}`)
        .sort()
        .join("&"),
    )
    .sort()
    .join(";");
  return canonical;
}
