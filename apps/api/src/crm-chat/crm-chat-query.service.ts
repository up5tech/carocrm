import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { EntityCrudService, ListQuery } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';

/**
 * Phase 19-CHAT.10 — Read-Only CRM Tools and Safe Query Plans
 * (PLAN_Phase_19_CRM_Chat.md §10, §17 `19-CHAT.10`).
 *
 * This service provides safe, read-only access to CRM data for the Chat assistant. It ensures:
 * - All queries are validated against metadata (no arbitrary SQL)
 * - ACL is enforced before any data retrieval (delegated to EntityCrudService)
 * - List sizes are bounded to prevent unbounded consumption
 * - The model never receives database credentials and never submits SQL
 *
 * The Query Engine (`packages/query-engine`) performs the authoritative metadata validation:
 * unknown entities, unknown fields and unsupported operators are rejected there. This layer
 * therefore only constrains the *shape* of a plan (operator allowlist, bounds) and translates
 * the Chat-facing filter map into the engine's criterion form. It never silently drops a
 * filter, because dropping a restrictive filter would widen the result set.
 */

export interface QueryPlan {
  readonly entity: string;
  readonly fields?: readonly string[] | undefined;
  readonly filters?: Record<string, unknown> | undefined;
  readonly sort?: { field: string; direction: 'asc' | 'desc' } | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface QueryResult {
  readonly records: readonly Record<string, unknown>[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly queryTime: string;
}

export interface RecordSummary {
  readonly id: string;
  readonly label: string;
  readonly entityType: string;
  readonly route: string;
}

/** Safe limits to prevent unbounded queries. */
const MAX_LIST_SIZE = 50;
const DEFAULT_LIMIT = 25;

/**
 * Filter operators the Chat surface may use, mapped to their canonical name. Anything else is
 * rejected outright instead of being ignored, so a plan can never quietly mean something other
 * than what was written.
 */
const ALLOWED_OPERATORS: Readonly<Record<string, string>> = {
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
  gte: 'greaterThanOrEqual',
  lessthan: 'lessThan',
  lt: 'lessThan',
  before: 'lessThan',
  lessthanorequal: 'lessThanOrEqual',
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

/** Operators that take no operand. */
const NO_VALUE_OPERATORS = new Set(['isNull', 'none', 'isNotNull', 'notNull', 'notNone']);

/** Operators whose operand must be an array. */
const ARRAY_OPERATORS = new Set(['in', 'notIn', 'between']);

/** Criterion shape understood by the Query Engine. */
interface QueryCriterionPayload {
  readonly field: string;
  readonly operator?: string;
  readonly value?: unknown;
}

@Injectable()
export class CRMChatQueryService {
  constructor(
    @Inject(EntityService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * Execute a validated read-only query with ACL enforcement.
   * Delegates to EntityCrudService which enforces ACL and validates against metadata.
   */
  async executeQuery(plan: QueryPlan): Promise<QueryResult> {
    this.validateQueryPlan(plan);

    const limit = Math.min(plan.limit ?? DEFAULT_LIMIT, MAX_LIST_SIZE);
    const offset = plan.offset ?? 0;

    const query: ListQuery = { maxSize: limit, offset };

    if (plan.fields && plan.fields.length > 0) {
      query.select = [...plan.fields];
    }

    const criteria = this.buildCriteria(plan.filters ?? {});
    if (criteria.length > 0) {
      query.where = criteria;
    }

    if (plan.sort) {
      query.orderBy = [{ [plan.sort.field]: plan.sort.direction }];
    }

    const result = await this.entities.list(plan.entity, query);
    const total = result.total ?? result.list.length;

    return {
      records: result.list,
      total,
      hasMore: result.list.length === limit && total > offset + limit,
      queryTime: new Date().toISOString(),
    };
  }

  /**
   * Get a single record by ID with ACL check (delegated to EntityCrudService).
   * A record the caller may not read is reported as absent rather than forbidden.
   */
  async getRecord(entity: string, id: string): Promise<Record<string, unknown> | null> {
    this.validateEntityName(entity);

    try {
      return await this.entities.get(entity, id);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Search records by keyword with ACL enforcement.
   * The engine applies the `like` wildcard, so the raw term is passed through unchanged.
   */
  async searchRecords(entity: string, query: string, limit = 10): Promise<readonly RecordSummary[]> {
    this.validateEntityName(entity);

    const safeLimit = Math.min(limit, MAX_LIST_SIZE);
    const normalizedQuery = query.trim();

    if (!normalizedQuery) return [];

    const result = await this.entities.list(entity, {
      where: [{ field: 'name', operator: 'like', value: normalizedQuery }],
      maxSize: safeLimit,
      offset: 0,
    });

    return result.list.map((record) => ({
      id: String(record['id'] ?? ''),
      label: typeof record['name'] === 'string' ? record['name'] : `Record #${String(record['id'] ?? 'unknown')}`,
      entityType: entity,
      route: `/entity/${encodeURIComponent(entity)}/${encodeURIComponent(String(record['id']))}`,
    }));
  }

  /**
   * Validate a query plan against safety rules.
   */
  private validateQueryPlan(plan: QueryPlan): void {
    this.validateEntityName(plan.entity);

    if (plan.limit !== undefined && (plan.limit < 0 || plan.limit > MAX_LIST_SIZE)) {
      throw new ValidationError(`Limit must be between 0 and ${MAX_LIST_SIZE}, got ${plan.limit}.`, {
        field: 'limit',
      });
    }

    if (plan.offset !== undefined && plan.offset < 0) {
      throw new ValidationError(`Offset must be non-negative, got ${plan.offset}.`, { field: 'offset' });
    }

    if (plan.sort && !['asc', 'desc'].includes(plan.sort.direction)) {
      throw new ValidationError(`Sort direction must be "asc" or "desc", got "${plan.sort.direction}".`, {
        field: 'sort.direction',
      });
    }

    if (plan.fields) {
      for (const field of plan.fields) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(field)) {
          throw new ValidationError(`Invalid field name: "${field}".`, { field: 'fields' });
        }
      }
    }
  }

  /**
   * Validate entity name format. The Query Engine resolves entity names against metadata and
   * answers "unknown entity" with a `404`; this guard rejects a *malformed* name as a bad request
   * before it reaches the SQL builder, so an injection attempt is a `400` and never a query.
   */
  private validateEntityName(entity: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(entity)) {
      throw new ValidationError(`Invalid entity name: "${entity}".`, { field: 'entity' });
    }
  }

  /**
   * Translate the Chat-facing filter map into Query Engine criteria.
   *
   * Supported filter value shapes:
   * - a primitive or array  -> equality (or `in` for an array)
   * - `{ operator, value }` -> an explicit operator
   * - `{ <operator>: value }` -> a single-entry operator shorthand
   *
   * An unsupported operator is a client error, never a silently ignored filter.
   */
  private buildCriteria(filters: Record<string, unknown>): QueryCriterionPayload[] {
    const criteria: QueryCriterionPayload[] = [];

    for (const [field, raw] of Object.entries(filters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(field)) {
        throw new ValidationError(`Invalid filter field: "${field}".`, { field: 'filters' });
      }

      const { operator, value } = this.readOperator(field, raw);

      if (ARRAY_OPERATORS.has(operator)) {
        if (!Array.isArray(value)) {
          throw new ValidationError(`Operator "${operator}" requires an array value for field "${field}".`, {
            field,
            operator,
          });
        }
        if (operator === 'between' && value.length !== 2) {
          throw new ValidationError(`Operator "between" requires exactly 2 values for field "${field}".`, {
            field,
            operator,
          });
        }
        if (operator !== 'between' && value.length === 0) {
          throw new ValidationError(`Operator "${operator}" requires at least one value for field "${field}".`, {
            field,
            operator,
          });
        }
      }

      criteria.push(NO_VALUE_OPERATORS.has(operator) ? { field, operator } : { field, operator, value });
    }

    return criteria;
  }

  /** Resolve the operator and operand of a single filter entry. */
  private readOperator(field: string, raw: unknown): { operator: string; value: unknown } {
    if (Array.isArray(raw)) {
      return { operator: 'in', value: raw };
    }
    if (raw === null || typeof raw !== 'object') {
      return { operator: 'equals', value: raw };
    }

    const record = raw as Record<string, unknown>;

    if (typeof record['operator'] === 'string') {
      return { operator: this.assertAllowedOperator(field, record['operator']), value: record['value'] };
    }

    const entries = Object.entries(record);
    if (entries.length === 1) {
      const [key, value] = entries[0] as [string, unknown];
      if (key !== 'value') {
        return { operator: this.assertAllowedOperator(field, key), value };
      }
    }

    return { operator: 'equals', value: raw };
  }

  private assertAllowedOperator(field: string, operator: string): string {
    const normalized = operator.toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonical = ALLOWED_OPERATORS[normalized];
    if (canonical === undefined) {
      throw new ValidationError(`Unsupported filter operator "${operator}" for field "${field}".`, {
        field,
        operator,
      });
    }
    return canonical;
  }
}

/** A record that exists but is outside the caller's scope is reported as absent. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof NotFoundError ||
    (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'RecordNotFoundError')
  );
}
