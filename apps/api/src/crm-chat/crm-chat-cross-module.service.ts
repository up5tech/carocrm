import { Inject, Injectable } from '@nestjs/common';

import type { CRMChatQueryService, QueryPlan, QueryResult } from './crm-chat-query.service.js';
import { CRMChatQueryService } from './crm-chat-query.service.js';

/**
 * Phase 19-CHAT.11 — Cross-Module Analysis
 * (PLAN_Phase_19_CRM_Chat.md §5.5, §17 `19-CHAT.11`).
 *
 * This service enables cross-module queries by executing multiple single-entity queries and
 * correlating the results. It ensures:
 * - Only declared, schema-aware query paths are used
 * - Each module query is independently authorized
 * - Partial results are clearly labeled when modules are unavailable
 * - Query limits and timeouts prevent unbounded execution
 * - Evidence metadata includes which modules were queried and when
 *
 * The service does NOT perform SQL joins across modules. Instead, it executes separate queries
 * and correlates results in memory based on foreign key relationships.
 */

export interface CrossModuleQuery {
  /** Human-readable description of what is being queried */
  readonly description: string;
  /** Individual entity queries to execute */
  readonly queries: readonly CrossModuleSubQuery[];
  /** Maximum time for entire cross-module query in milliseconds */
  readonly timeoutMs?: number | undefined;
}

export interface CrossModuleSubQuery {
  /** Module/entity to query */
  readonly entity: string;
  /** Query plan for this entity */
  readonly plan: QueryPlan;
  /** Optional label for this sub-query in results */
  readonly label?: string | undefined;
  /** Foreign key field to use for correlation with other queries */
  readonly correlationField?: string | undefined;
}

export interface CrossModuleResult {
  readonly description: string;
  readonly results: readonly CrossModuleSubResult[];
  readonly executedAt: string;
  readonly partial: boolean;
  readonly warnings: readonly string[];
}

export interface CrossModuleSubResult {
  readonly entity: string;
  readonly label?: string | undefined;
  readonly result: QueryResult | null;
  readonly error?: string | undefined;
  readonly recordCount: number;
}

// Default timeout for cross-module queries
const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

@Injectable()
export class CRMChatCrossModuleService {
  constructor(
    @Inject(CRMChatQueryService) private readonly queryService: CRMChatQueryService,
  ) {}

  /**
   * Execute a cross-module query by running multiple sub-queries and correlating results.
   * Each sub-query is independently authorized and bounded.
   */
  async executeCrossModuleQuery(query: CrossModuleQuery): Promise<CrossModuleResult> {
    const startTime = Date.now();
    const timeout = query.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const warnings: string[] = [];
    const results: CrossModuleSubResult[] = [];
    let hasErrors = false;

    // Execute each sub-query with timeout tracking
    for (const subQuery of query.queries) {
      // Check if we've exceeded timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        warnings.push(`Query timed out after ${elapsed}ms. Some modules were not queried.`);
        hasErrors = true;
        break;
      }

      try {
        // Execute the sub-query (ACL enforced by CRMChatQueryService)
        const result = await this.queryService.executeQuery(subQuery.plan);

        results.push({
          entity: subQuery.entity,
          label: subQuery.label,
          result,
          recordCount: result.records.length,
        });
      } catch (error) {
        // Module unavailable or query failed - record as partial
        hasErrors = true;
        warnings.push(`Failed to query "${subQuery.entity}": ${error instanceof Error ? error.message : 'Unknown error'}`);

        results.push({
          entity: subQuery.entity,
          label: subQuery.label,
          result: null,
          error: error instanceof Error ? error.message : 'Query failed',
          recordCount: 0,
        });
      }
    }

    return {
      description: query.description,
      results,
      executedAt: new Date().toISOString(),
      partial: hasErrors || results.some((r) => r.result === null),
      warnings,
    };
  }

  /**
   * Execute a simple cross-module count query - get counts from multiple entities.
   * Useful for dashboard-style summaries across modules.
   */
  async getCrossModuleCounts(entities: readonly string[]): Promise<CrossModuleResult> {
    const queries: CrossModuleSubQuery[] = entities.map((entity) => ({
      entity,
      label: `${entity} count`,
      plan: {
        entity,
        limit: 1, // Only need count, not records
        offset: 0,
      },
    }));

    return this.executeCrossModuleQuery({
      description: `Count records across ${entities.length} entities`,
      queries,
    });
  }

  /**
   * Correlate records from two entities based on a foreign key relationship.
   * For example: correlate Accounts with their related Opportunities.
   */
  async correlateEntities(
    primaryEntity: string,
    primaryLabel: string,
    relatedEntity: string,
    relatedLabel: string,
    foreignKeyField: string,
    primaryIds: readonly string[],
  ): Promise<{
    readonly primary: QueryResult;
    readonly related: QueryResult;
    readonly correlationField: string;
    readonly executedAt: string;
  }> {
    // Query primary entities
    const primaryResult = await this.queryService.executeQuery({
      entity: primaryEntity,
      filters: { id: { $in: primaryIds } },
      limit: 50,
    });

    // Query related entities filtered by foreign key
    const relatedResult = await this.queryService.executeQuery({
      entity: relatedEntity,
      filters: { [foreignKeyField]: { $in: primaryIds } },
      limit: 100,
    });

    return {
      primary: primaryResult,
      related: relatedResult,
      correlationField: foreignKeyField,
      executedAt: new Date().toISOString(),
    };
  }
}
