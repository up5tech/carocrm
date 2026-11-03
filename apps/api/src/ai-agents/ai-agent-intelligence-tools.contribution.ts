import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type RawBuilder,sql } from 'kysely';
import { z } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import type { AclPredicate } from '../acl/predicate.js';
import { DatabaseService } from '../database/database.service.js';
import { ReportService } from '../reports/report.service.js';
import { type AIToolDefinition, AIToolRegistry, type AIToolResult } from './ai-agent-tools.js';

/**
 * Phase 19-CHAT.23 — module intelligence tools owned by AIAgents
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.23`; `plans/SPEC.md` §9.4).
 *
 * Two thin wrappers over shared core services:
 *
 * - `crm_run_report` — `ReportService.list()` / `run()`. The service already enforces `canSee`
 *   (admin, owner, or shared), so a caller can never run a report they are not permitted to run.
 * - `crm_stale_records` — one SQL query over `entity_records` with a single `NOT EXISTS` over
 *   `stream_items`. The database does the exclusion (no fetch-then-filter in JavaScript) and the
 *   caller's record ACL predicate is folded into the same query, so a record the caller cannot read
 *   never appears in the "silent" list.
 *
 * Both are registered by AIAgents because `reports` and the generic record/ACL store are shared core.
 */

const MAX_REPORT_ROWS = 50;
const MAX_STALE_LIMIT = 100;

// ---------------------------------------------------------------------------
// crm_run_report
// ---------------------------------------------------------------------------

const RunReportArgumentsSchema = z
  .object({
    /** When set, run this report. When omitted, list the reports the caller may see. */
    reportId: z.string().trim().min(1).max(120).optional(),
    /** Cap on rows returned for a list report. */
    maxRows: z.number().int().min(1).max(MAX_REPORT_ROWS).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// crm_stale_records
// ---------------------------------------------------------------------------

const StaleRecordsArgumentsSchema = z
  .object({
    /** Which entity to scan for silence (e.g. "Account", "Contact", "Lead"). */
    entity: z.string().trim().min(1).max(80),
    /** Records untouched for at least this many days are "silent". Default 30. */
    days: z.number().int().min(1).max(365 * 5).optional(),
    /** Maximum records to return. Default 25. */
    limit: z.number().int().min(1).max(MAX_STALE_LIMIT).optional(),
  })
  .strict();

@Injectable()
export class AIAgentReportToolContribution implements OnModuleInit {
  constructor(
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(ReportService) private readonly reports: ReportService,
  ) {}

  onModuleInit(): void {
    if (this.tools.has('crm_run_report')) return;
    this.tools.register(this.reportDefinition());
  }

  private reportDefinition(): AIToolDefinition {
    return {
      key: 'crm_run_report',
      label: 'Run or list saved reports',
      description:
        'List the saved reports the caller is allowed to see, or run one by id and return its bounded result. Use it to answer "what do our saved reports say about X" without re-deriving a report the installation already owns.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [],
      inputSchema: RunReportArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reportId: { type: 'string', maxLength: 120 },
          maxRows: { type: 'integer', minimum: 1, maximum: MAX_REPORT_ROWS },
        },
      },
      maxResultBytes: 32_768,
      timeoutMs: 15_000,
      execute: (args) => this.runReport(args),
    };
  }

  private async runReport(raw: unknown): Promise<AIToolResult> {
    const args = RunReportArgumentsSchema.parse(raw);
    if (args.reportId === undefined) {
      const list = await this.reports.list();
      return {
        summary: `Found ${String(list.length)} report(s) you may run.`,
        result: { reports: list.map((report) => ({
          id: report['id'],
          name: report['name'],
          entityType: report['entityType'],
          isShared: report['isShared'],
          userId: report['userId'],
        })) },
      };
    }

    const { report, result } = await this.reports.run(args.reportId);
    const maxRows = args.maxRows ?? MAX_REPORT_ROWS;
    const bounded: Record<string, unknown> = {
      entityType: result.entityType,
      kind: result.kind,
      total: result.total,
      truncated: result.truncated,
      columns: result.columns,
    };
    if (result.rows !== undefined) {
      bounded.rows = result.rows.slice(0, maxRows);
    } else if (result.groups !== undefined) {
      bounded.groups = result.groups;
    } else if (result.matrix !== undefined) {
      bounded.matrix = result.matrix;
    }

    return {
      summary: `Ran report "${String(report['name'])}" (${String(report['entityType'])}): ${String(result.total)} row(s)${result.truncated ? ', truncated' : ''}.`,
      result: { report: { id: report['id'], name: report['name'], entityType: report['entityType'], isShared: report['isShared'] }, result: bounded },
      resultRef: `Report:${String(report['id'])}`,
    };
  }
}

@Injectable()
export class AIAgentStaleRecordsToolContribution implements OnModuleInit {
  constructor(
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  onModuleInit(): void {
    if (this.tools.has('crm_stale_records')) return;
    this.tools.register(this.staleDefinition());
  }

  private staleDefinition(): AIToolDefinition {
    return {
      key: 'crm_stale_records',
      label: 'Find silent records',
      description:
        'Return records of one entity type that have had no stream (timeline) activity for at least N days — candidates for follow-up or data hygiene. Respects record access: a record the caller cannot read never appears.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [],
      inputSchema: StaleRecordsArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity'],
        properties: {
          entity: { type: 'string', maxLength: 80 },
          days: { type: 'integer', minimum: 1, maximum: 365 * 5 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_STALE_LIMIT },
        },
      },
      maxResultBytes: 24_576,
      timeoutMs: 10_000,
      execute: (args) => this.runStale(args),
    };
  }

  private async runStale(raw: unknown): Promise<AIToolResult> {
    const args = StaleRecordsArgumentsSchema.parse(raw);
    const days = args.days ?? 30;
    const limit = args.limit ?? 25;
    const threshold = new Date(Date.now() - days * 86_400_000);

    const acl = await this.acl.recordPredicate(args.entity, 'read');
    const aclCondition = aclToSql(acl, 'entity_records');

    let query = this.database.db
      .selectFrom('entity_records')
      .select(['id', 'entity_type', 'attrs', 'modified_at', 'created_by_id', 'assigned_user_id'])
      .where('entity_type', '=', args.entity)
      .where('deleted_at', 'is', null)
      .where('modified_at', '<', threshold)
      .where(
        sql<boolean>`not exists (
          select 1 from stream_items s
          where s.entity_type = entity_records.entity_type
            and s.entity_id = entity_records.id
            and s.is_deleted = false
        )`,
      );

    if (aclCondition !== undefined) {
      query = query.where(aclCondition);
    }

    const rows = await query.orderBy('modified_at', 'asc').limit(limit).execute();

    const records = rows.map((row) => {
      const a = (row.attrs ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        entity: row.entity_type,
        name: typeof a['name'] === 'string' ? a['name'] : null,
        modifiedAt: row.modified_at,
        assignedUserId: row.assigned_user_id ?? null,
      };
    });

    return {
      summary: `Found ${String(records.length)} silent ${args.entity} record(s) (no activity for ≥ ${String(days)} day(s)).`,
      result: { entity: args.entity, days, count: records.length, records },
    };
  }
}

/**
 * Translate the record-scope ACL predicate into SQL, mirroring `entity-record.store.ts` so a list and
 * this tool decide identically. `allowAll` returns `undefined` (no clause); `denyAll` returns a
 * constant-false clause.
 */
function aclToSql(acl: AclPredicate, table: string): RawBuilder<boolean> | undefined {
  if (acl.kind === 'allowAll') return undefined;
  if (acl.kind === 'denyAll') return sql<boolean>`false`;
  if (acl.kind === 'portal') return portalSql(acl, table);
  if (acl.kind === 'projectScoped') return projectSql(acl, table);

  const assigned = sql`${sql.id(table, 'assigned_user_id')} = ${acl.userId}`;
  const creator = sql`${sql.id(table, 'created_by_id')} = ${acl.userId}`;
  if (acl.kind === 'own') return sql<boolean>`( ${assigned} or ${creator} )`;
  if (acl.teamIds.length === 0) return sql<boolean>`( ${assigned} or ${creator} )`;
  return sql<boolean>`( ${sql.id(table, 'team_ids')} ?| cast(${[...acl.teamIds]} as text[]) or ${assigned} or ${creator} )`;
}

function portalSql(acl: Extract<AclPredicate, { kind: 'portal' }>, table: string): RawBuilder<boolean> {
  const ids = [acl.contactId, acl.accountId].filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return sql<boolean>`false`;
  const clauses: RawBuilder<boolean>[] = ids.map((id) => sql<boolean>`${sql.id(table, 'id')} = ${id}`);
  for (const link of acl.linkFields) {
    for (const id of ids) {
      if (link.multiple) {
        clauses.push(sql<boolean>`(${sql.id(table, 'attrs')} -> ${link.field}::text) @> ${JSON.stringify([id])}::jsonb`);
      } else {
        clauses.push(sql<boolean>`(${sql.id(table, 'attrs')} ->> ${link.field}::text) = ${id}`);
      }
    }
  }
  clauses.push(sql<boolean>`exists (
    select 1 from entity_links l
    where l.record_id_b = ${sql.id(table, 'id')} and l.entity_type_b = ${acl.entity} and l.record_id_a in (${sql.join(ids)})
  )`);
  clauses.push(sql<boolean>`exists (
    select 1 from entity_links l
    where l.record_id_a = ${sql.id(table, 'id')} and l.entity_type_a = ${acl.entity} and l.record_id_b in (${sql.join(ids)})
  )`);
  return sql<boolean>`( ${sql.join(clauses, sql` or `)} )`;
}

/** Exact mirror of `entity-record.store.ts` `projectScopeSql`. */
function projectSql(acl: Extract<AclPredicate, { kind: 'projectScoped' }>, table: string): RawBuilder<boolean> {
  const attrs = sql.id(table, 'attrs');
  const projectIdOfRecord =
    acl.projectAttr === 'id'
      ? sql.id(table, 'id')
      : sql`(${attrs} ->> ${acl.projectAttr}::text)`;
  const ownerOrAssignee = sql`( (${attrs} ->> 'assigneeUserId'::text) = ${acl.userId} or (${attrs} ->> 'ownerUserId'::text) = ${acl.userId} )`;
  const isCollaborator = sql`exists (
    select 1 from entity_records c
    where c.entity_type = 'ProjectTaskCollaborator' and c.deleted_at is null
      and (c.attrs ->> 'userId') = ${acl.userId} and (c.attrs ->> 'taskId') = ${sql.id(table, 'id')}
  )`;

  const roleClauses: RawBuilder<boolean>[] = [];
  if (acl.roleField === null) {
    roleClauses.push(sql<boolean>`true`);
  } else {
    const field = sql`(pr.attrs ->> ${acl.roleField}::text)`;
    if (acl.allValues.length > 0) roleClauses.push(sql<boolean>`${field} = any(cast(${[...acl.allValues]} as text[]))`);
    if (acl.assignedValues.length > 0) {
      roleClauses.push(sql<boolean>`(${field} = any(cast(${[...acl.assignedValues]} as text[])) and ${ownerOrAssignee})`);
    }
    if (acl.ownValues.length > 0) {
      roleClauses.push(sql<boolean>`(${field} = any(cast(${[...acl.ownValues]} as text[])) and (${ownerOrAssignee} or ${isCollaborator}))`);
    }
  }
  const roleCondition = roleClauses.length === 0 ? sql<boolean>`false` : sql<boolean>`( ${sql.join(roleClauses, sql` or `)} )`;

  const memberOf = (extra: RawBuilder<boolean>): RawBuilder<boolean> => sql`exists (
    select 1 from entity_records pm
    left join entity_records pr on pr.id = (pm.attrs ->> 'projectRoleId') and pr.entity_type = 'ProjectRole' and pr.deleted_at is null
    where pm.entity_type = 'ProjectMember' and pm.deleted_at is null
      and (pm.attrs ->> 'userId') = ${acl.userId}
      and (pm.attrs ->> ${acl.projectAttr}::text) = ${projectIdOfRecord}
      and ${extra}
  )`;

  const assigned = sql`${sql.id(table, 'assigned_user_id')} = ${acl.base.userId}`;
  const created = sql`${sql.id(table, 'created_by_id')} = ${acl.base.userId}`;
  const teams =
    acl.base.kind === 'own' || acl.base.teamIds.length === 0
      ? sql``
      : sql`${sql.id(table, 'team_ids')} ?| cast(${[...acl.base.teamIds]} as text[]) or `;
  const base = sql<boolean>`( ${teams}${assigned} or ${created} )`;

  return sql<boolean>`( ( not ${memberOf(sql<boolean>`true`)} and ${base} ) or ${memberOf(roleCondition)} )`;
}
