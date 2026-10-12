import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { parseQueryRequest } from '@carocrm/query-engine/index.js';
import type { ReportDefinition, ReportResult } from '@carocrm/reports';
import { executeReport, MAX_REPORT_SCAN, REPORT_PAGE_SIZE, validateReportDefinition } from '@carocrm/reports';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Database, ReportsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { EntityCrudService, ListQuery } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { csvCell, toCsvText } from '../search/csv.js';
import { MAX_REPORTS, ReportCreateSchema, ReportUpdateSchema } from './report-shapes.js';

type ReportRow = Database['reports'] & { id: string };
type ReportFieldMap = ReturnType<MetadataStoreService['registry']['getFields']>;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function view(row: ReportRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    userId: row.user_id,
    visibility: row.visibility,
    isShared: row.is_shared,
    definition: parseJson(row.definition),
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function filename(name: string): string {
  const safe = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${safe || 'report'}.csv`;
}

@Injectable()
export class ReportService {
  constructor(
    @Inject(EntityService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  canSee(row: Pick<ReportsTable, 'user_id' | 'is_shared'>): boolean {
    return this.scope.isAdmin || row.user_id === this.scope.userId || row.is_shared;
  }

  async list(): Promise<Record<string, unknown>[]> {
    let query = this.database.db.selectFrom('reports').selectAll().orderBy('modified_at', 'desc').limit(MAX_REPORTS);
    if (!this.scope.isAdmin) {
      const userId = this.scope.userId;
      if (!userId) return [];
      query = query.where((eb) => eb.or([eb('user_id', '=', userId), eb('is_shared', '=', true)]));
    }
    return (await query.execute()).map((row) => view(row as ReportRow));
  }

  async get(id: string): Promise<Record<string, unknown>> {
    const row = await this.reportRow(id);
    if (!this.canSee(row)) throw new NotFoundError(`Report "${id}" does not exist.`);
    return view(row);
  }

  async create(raw: unknown): Promise<Record<string, unknown>> {
    const parsed = ReportCreateSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new ValidationError('Invalid report.', { issues: parsed.error.issues.map((issue) => issue.message) });
    const definition = await this.validateDefinition(parsed.data.definition);
    const id = generateId();
    const now = new Date();
    await this.database.db.insertInto('reports').values({
      id,
      name: parsed.data.name,
      entity_type: definition.entityType,
      user_id: this.scope.requirePrincipal().userId,
      definition: JSON.stringify(definition),
      visibility: parsed.data.visibility,
      is_shared: parsed.data.visibility === 'shared',
      created_at: now,
      modified_at: now,
    }).execute();
    return this.get(id);
  }

  async update(id: string, raw: unknown): Promise<Record<string, unknown>> {
    const row = await this.reportRow(id);
    this.assertManage(row);
    const parsed = ReportUpdateSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new ValidationError('Invalid report update.', { issues: parsed.error.issues.map((issue) => issue.message) });
    const definition = parsed.data.definition === undefined ? undefined : await this.validateDefinition(parsed.data.definition);
    await this.database.db.updateTable('reports').set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(definition !== undefined ? { entity_type: definition.entityType, definition: JSON.stringify(definition) } : {}),
      ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility, is_shared: parsed.data.visibility === 'shared' } : {}),
      modified_at: new Date(),
    }).where('id', '=', id).execute();
    return this.get(id);
  }

  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.reportRow(id);
    this.assertManage(row);
    await this.database.db.deleteFrom('reports').where('id', '=', id).execute();
    return { id, deleted: true };
  }

  async preview(raw: unknown): Promise<{ result: ReportResult }> {
    const body = asObject(raw);
    return { result: await this.runDefinition(body['definition']) };
  }

  async run(id: string): Promise<{ report: Record<string, unknown>; result: ReportResult }> {
    const row = await this.reportRow(id);
    if (!this.canSee(row)) throw new NotFoundError(`Report "${id}" does not exist.`);
    return { report: view(row), result: await this.runDefinition(parseJson(row.definition)) };
  }

  async exportCsv(id: string): Promise<{ reportId: string; filename: string; csv: string; rows: number; truncated: boolean }> {
    const { report, result } = await this.run(id);
    const reportName = String(report['name'] ?? 'report');
    const definition = report['definition'] as ReportDefinition;
    const lines: string[] = [];
    if (result.rows !== undefined) {
      lines.push(definition.columns.map(csvCell).join(','));
      for (const row of result.rows) lines.push(definition.columns.map((field) => csvCell(toCsvText(row[field]))).join(','));
    } else if (result.groups !== undefined) {
      const metricNames = [...definition.metrics.map((metric) => metric.name), ...definition.calculatedMetrics.map((metric) => metric.name)];
      const groupName = definition.groupBy?.field ?? 'group';
      lines.push([groupName, 'count', ...metricNames].map(csvCell).join(','));
      for (const group of result.groups) {
        lines.push([group.key, String(group.count), ...metricNames.map((metric) => toCsvText(group.metrics[metric]))].map(csvCell).join(','));
      }
    } else {
      const metricNames = [...definition.metrics.map((metric) => metric.name), ...definition.calculatedMetrics.map((metric) => metric.name)];
      lines.push(metricNames.map(csvCell).join(','));
      lines.push(metricNames.map((metric) => csvCell(toCsvText(result.metrics?.[metric]))).join(','));
    }
    return {
      reportId: id,
      filename: filename(reportName),
      csv: `${lines.join('\r\n')}\r\n`,
      rows: result.rows?.length ?? result.groups?.length ?? 1,
      truncated: result.truncated,
    };
  }

  private async runDefinition(raw: unknown): Promise<ReportResult> {
    const definition = await this.validateDefinition(raw);
    const filterQuery = parseQueryRequest({ entity: definition.entityType, where: definition.filters }, this.metadata.registry);
    const visible = new Set(await this.acl.visibleFields(definition.entityType));
    const requiredFields = new Set<string>(['id', ...definition.columns]);
    if (definition.groupBy !== undefined) requiredFields.add(definition.groupBy.field);
    for (const metric of definition.metrics) if (metric.field !== undefined) requiredFields.add(metric.field);
    for (const criterion of filterQuery.criteria) requiredFields.add(criterion.field);
    for (const field of requiredFields) {
      if (!visible.has(field)) throw new AuthorizationDeniedError(`Field "${field}" cannot be used in this report.`, { entity: definition.entityType, field });
    }

    const select = [...requiredFields].join(',');
    const records: Record<string, unknown>[] = [];
    let total = 0;
    while (records.length < MAX_REPORT_SCAN) {
      const pageSize = Math.min(REPORT_PAGE_SIZE, MAX_REPORT_SCAN - records.length);
      const result = await this.entities.list(definition.entityType, {
        where: definition.filters,
        select,
        offset: records.length,
        maxSize: pageSize,
        total: true,
      } satisfies ListQuery);
      if (records.length === 0) total = result.total ?? result.count;
      records.push(...result.list);
      if (result.list.length < pageSize || records.length >= total || result.list.length === 0) break;
    }
    return executeReport(definition, records, total);
  }

  private async validateDefinition(raw: unknown): Promise<ReportDefinition> {
    this.metadata.ensureLoaded();
    const candidate = asObject(raw);
    const entityType = candidate['entityType'];
    if (typeof entityType !== 'string' || !/^[A-Z][A-Za-z0-9]{1,49}$/.test(entityType) || !this.metadata.registry.hasEntity(entityType)) {
      throw new NotFoundError(`Report entity "${String(entityType ?? '')}" does not exist.`);
    }
    await this.acl.assertAccess(entityType, 'read');
    const fields: ReportFieldMap = this.metadata.registry.getFields(entityType);
    let definition: ReportDefinition;
    try {
      definition = validateReportDefinition(raw, fields);
    } catch (error: unknown) {
      throw new ValidationError('Invalid report definition.', { reason: error instanceof Error ? error.message : String(error) });
    }
    // The Query Engine is the sole authority for filter grammar and metadata field references.
    const translated = parseQueryRequest({ entity: entityType, where: definition.filters }, this.metadata.registry);
    const required = new Set<string>([...definition.columns, ...translated.criteria.map((criterion) => criterion.field)]);
    if (definition.groupBy !== undefined) required.add(definition.groupBy.field);
    for (const metric of definition.metrics) if (metric.field !== undefined) required.add(metric.field);
    const visible = new Set(await this.acl.visibleFields(entityType));
    for (const field of required) {
      if (!visible.has(field)) throw new AuthorizationDeniedError(`Field "${field}" cannot be used in this report.`, { entity: entityType, field });
    }
    return definition;
  }

  private async reportRow(id: string): Promise<ReportRow> {
    const row = await this.database.db.selectFrom('reports').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError(`Report "${id}" does not exist.`);
    return row as ReportRow;
  }

  private assertManage(row: ReportRow): void {
    if (!this.scope.isAdmin && row.user_id !== this.scope.userId) {
      throw new AuthorizationDeniedError('Only the report owner or an administrator may change it.');
    }
  }
}
