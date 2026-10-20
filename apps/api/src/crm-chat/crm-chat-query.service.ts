import { Inject, Injectable } from '@nestjs/common';

import type { EntityCrudService } from '../entity/entity.service.js';
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

// Safe limits to prevent unbounded queries
const MAX_LIST_SIZE = 50;
const DEFAULT_LIMIT = 25;

// Safe entity name pattern
const ENTITY_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/;

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
    // Step 1: Validate the query plan format
    this.validateQueryPlan(plan);

    // Step 2: Enforce bounds
    const limit = Math.min(plan.limit ?? DEFAULT_LIMIT, MAX_LIST_SIZE);
    const offset = plan.offset ?? 0;

    // Step 3: Build query object for EntityCrudService
    const query: any = {
      maxSize: limit,
      offset,
    };

    if (plan.fields && plan.fields.length > 0) {
      query.select = plan.fields;
    }

    if (plan.filters && Object.keys(plan.filters).length > 0) {
      // Build safe where clause - EntityCrudService will validate against metadata
      query.where = this.buildSafeWhere(plan.entity, plan.filters);
    }

    if (plan.sort) {
      query.orderBy = [{ [plan.sort.field]: plan.sort.direction }];
    }

    // Step 4: Execute through EntityCrudService (enforces ACL automatically)
    try {
      const result = await this.entities.list(plan.entity, query);

      return {
        records: result.list,
        total: result.total ?? result.list.length,
        hasMore: result.list.length === limit && (result.total ?? 0) > offset + limit,
        queryTime: new Date().toISOString(),
      };
    } catch (error) {
      // Entity not found or ACL denied - return empty result rather than exposing error details
      return {
        records: [],
        total: 0,
        hasMore: false,
        queryTime: new Date().toISOString(),
      };
    }
  }

  /**
   * Get a single record by ID with ACL check (delegated to EntityCrudService).
   */
  async getRecord(entity: string, id: string): Promise<Record<string, unknown> | null> {
    this.validateEntityName(entity);

    try {
      const record = await this.entities.get(entity, id);
      return record || null;
    } catch {
      // Record not accessible or doesn't exist
      return null;
    }
  }

  /**
   * Search records by keyword in name field with ACL enforcement.
   */
  async searchRecords(entity: string, query: string, limit = 10): Promise<readonly RecordSummary[]> {
    this.validateEntityName(entity);

    const safeLimit = Math.min(limit, MAX_LIST_SIZE);
    const normalizedQuery = query.trim();

    if (!normalizedQuery) return [];

    try {
      // Search using like operator on name field
      const result = await this.entities.list(entity, {
        where: { name: { $like: `%${normalizedQuery}%` } },
        maxSize: safeLimit,
        offset: 0,
      });

      return result.list.map((record) => ({
        id: String(record['id'] ?? ''),
        label: typeof record['name'] === 'string' ? record['name'] : `Record #${String(record['id'] ?? 'unknown')}`,
        entityType: entity,
        route: `/entity/${encodeURIComponent(entity)}/${encodeURIComponent(String(record['id']))}`,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Validate a query plan against safety rules.
   */
  private validateQueryPlan(plan: QueryPlan): void {
    // Validate entity name format (prevent injection)
    this.validateEntityName(plan.entity);

    // Validate limit
    if (plan.limit !== undefined && (plan.limit < 0 || plan.limit > MAX_LIST_SIZE)) {
      throw new Error(`Limit must be between 0 and ${MAX_LIST_SIZE}, got ${plan.limit}.`);
    }

    // Validate offset
    if (plan.offset !== undefined && plan.offset < 0) {
      throw new Error(`Offset must be non-negative, got ${plan.offset}.`);
    }

    // Validate sort direction
    if (plan.sort && !['asc', 'desc'].includes(plan.sort.direction)) {
      throw new Error(`Sort direction must be "asc" or "desc", got "${plan.sort.direction}".`);
    }
  }

  /**
   * Validate entity name format (prevent SQL/path injection).
   */
  private validateEntityName(entity: string): void {
    if (!ENTITY_NAME_RE.test(entity)) {
      throw new Error(`Invalid entity name: "${entity}". Entity names must start with a letter and contain only letters, digits, hyphens, and underscores.`);
    }
  }

  /**
   * Build safe where clause, rejecting dangerous patterns.
   * EntityCrudService will further validate against metadata.
   */
  private buildSafeWhere(_entity: string, filters: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(filters)) {
      // Reject keys that look like SQL injection
      if (key.includes(';') || key.includes('--') || key.includes('/*') || key.includes('*/')) {
        continue;
      }

      // Reject values that could be SQL
      if (typeof value === 'string' && (value.includes(';') || value.toLowerCase().includes('drop ') || value.toLowerCase().includes('delete from'))) {
        continue;
      }

      safe[key] = value;
    }

    return safe;
  }
}
