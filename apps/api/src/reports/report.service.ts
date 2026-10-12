import { randomBytes, timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { parseQueryRequest } from '@carocrm/query-engine/index.js';
import type { ReportDefinition, ReportFieldShape, ReportResult } from '@carocrm/reports';
import { executeAggregateReport, executeReport, MAX_REPORT_GROUPS, MAX_REPORT_SCAN, REPORT_PAGE_SIZE, validateReportDefinition } from '@carocrm/reports';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import type { Database, ReportsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { EntityCrudService, ListQuery } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';
import type { StoreReportRelation } from '../entity/entity-record.store.js';
import { isValidCronExpression } from '../jobs/cron.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { csvCell, toCsvText } from '../search/csv.js';
import { MAX_REPORTS, ReportCreateSchema, ReportUpdateSchema } from './report-shapes.js';

type ReportRow = Database['reports'] & { id: string };
type ReportScheduleRow = Database['report_schedules'] & { id: string };
type ReportFieldMap = Readonly<Record<string, ReportFieldShape>>;

const MAX_SCHEDULED_CSV_BYTES = 5 * 1024 * 1024;

export interface ReportScheduleView {
  readonly id: string;
  readonly reportId: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

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
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
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
    const schedule = await this.database.db.selectFrom('report_schedules').selectAll().where('report_id', '=', id).executeTakeFirst();
    if (schedule) await this.jobs.removeSchedule(schedule.scheduled_job_id);
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
    } else if (result.matrix !== undefined) {
      const metricNames = [...definition.metrics.map((metric) => metric.name), ...definition.calculatedMetrics.map((metric) => metric.name)];
      lines.push([result.matrix.rowField, result.matrix.columnField, 'count', ...metricNames].map(csvCell).join(','));
      for (const cell of result.matrix.cells) {
        lines.push([cell.rowKey, cell.columnKey, String(cell.count), ...metricNames.map((metric) => toCsvText(cell.metrics[metric]))].map(csvCell).join(','));
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
      rows: result.rows?.length ?? result.groups?.length ?? result.matrix?.cells.length ?? 1,
      truncated: result.truncated,
    };
  }

  async getSchedule(reportId: string): Promise<ReportScheduleView | null> {
    const report = await this.reportRow(reportId);
    if (!this.canSee(report)) throw new NotFoundError(`Report "${reportId}" does not exist.`);
    const row = await this.database.db.selectFrom('report_schedules').selectAll().where('report_id', '=', reportId).executeTakeFirst();
    return row ? scheduleView(row as ReportScheduleRow) : null;
  }

  async upsertSchedule(reportId: string, raw: unknown): Promise<ReportScheduleView> {
    const report = await this.reportRow(reportId);
    this.assertManage(report);
    const input = asObject(raw);
    const cron = input['cron'];
    if (typeof cron !== 'string' || !isValidCronExpression(cron)) {
      throw new ValidationError('A valid five-field cron expression is required.', { cron });
    }
    if (this.config.reportWorkerSecret.trim() === '') {
      throw new ValidationError('Scheduled report delivery is disabled until REPORT_WORKER_SECRET is configured.');
    }
    const ownerUserId = report.user_id;
    if (!ownerUserId) throw new ValidationError('A scheduled report must have an owner.');
    const current = await this.database.db.selectFrom('report_schedules').selectAll().where('report_id', '=', reportId).executeTakeFirst();
    const id = current?.id ?? randomBytes(16).toString('hex');
    const scheduledJobId = current?.scheduled_job_id ?? `report_${id}`;
    const enabled = input['enabled'] !== false;
    const now = new Date();

    // Keep the generic scheduler disabled until the owner-bound row is durable.
    if (current) await this.jobs.setScheduleEnabled(scheduledJobId, false);
    else await this.jobs.upsertSchedule({ id: scheduledJobId, job: 'reports.deliver', scheduling: cron.trim(), data: { scheduleId: id }, enabled: false });
    await this.database.db.insertInto('report_schedules').values({
      id,
      report_id: reportId,
      owner_user_id: ownerUserId,
      scheduled_job_id: scheduledJobId,
      cron: cron.trim(),
      enabled,
      created_at: current?.created_at ?? now,
      modified_at: now,
    }).onConflict((oc) => oc.column('report_id').doUpdateSet({ cron: cron.trim(), enabled, modified_at: now })).execute();
    await this.jobs.upsertSchedule({ id: scheduledJobId, job: 'reports.deliver', scheduling: cron.trim(), data: { scheduleId: id }, enabled: false });
    if (enabled) await this.jobs.setScheduleEnabled(scheduledJobId, true);
    const stored = await this.database.db.selectFrom('report_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!stored) throw new NotFoundError(`Report schedule "${id}" does not exist.`);
    return scheduleView(stored as ReportScheduleRow);
  }

  async setScheduleEnabled(reportId: string, enabled: boolean): Promise<ReportScheduleView> {
    const report = await this.reportRow(reportId);
    this.assertManage(report);
    const row = await this.database.db.selectFrom('report_schedules').selectAll().where('report_id', '=', reportId).executeTakeFirst();
    if (!row) throw new NotFoundError(`Report schedule for "${reportId}" does not exist.`);
    const modifiedAt = new Date();
    if (!enabled) {
      await this.jobs.setScheduleEnabled(row.scheduled_job_id, false);
      await this.database.db.updateTable('report_schedules').set({ enabled: false, modified_at: modifiedAt }).where('id', '=', row.id).execute();
    } else {
      await this.database.db.updateTable('report_schedules').set({ enabled: true, modified_at: modifiedAt }).where('id', '=', row.id).execute();
      try {
        await this.jobs.setScheduleEnabled(row.scheduled_job_id, true);
      } catch (error: unknown) {
        await this.database.db.updateTable('report_schedules').set({ enabled: false, modified_at: new Date() }).where('id', '=', row.id).execute();
        throw error;
      }
    }
    const stored = await this.database.db.selectFrom('report_schedules').selectAll().where('id', '=', row.id).executeTakeFirst();
    if (!stored) throw new NotFoundError(`Report schedule "${row.id}" does not exist.`);
    return scheduleView(stored as ReportScheduleRow);
  }

  async deleteSchedule(reportId: string): Promise<{ reportId: string; deleted: true }> {
    const report = await this.reportRow(reportId);
    this.assertManage(report);
    const row = await this.database.db.selectFrom('report_schedules').selectAll().where('report_id', '=', reportId).executeTakeFirst();
    if (!row) throw new NotFoundError(`Report schedule for "${reportId}" does not exist.`);
    await this.jobs.removeSchedule(row.scheduled_job_id);
    await this.database.db.deleteFrom('report_schedules').where('id', '=', row.id).execute();
    return { reportId, deleted: true };
  }

  /** Internal worker capability endpoint: reloads the schedule owner and re-applies current ACL. */
  async scheduledDelivery(scheduleId: string, suppliedSecret: string | undefined): Promise<{
    reportId: string;
    reportName: string;
    recipient: string;
    filename: string;
    csv: string;
  }> {
    this.assertWorkerSecret(suppliedSecret);
    const schedule = await this.database.db.selectFrom('report_schedules').selectAll().where('id', '=', scheduleId).executeTakeFirst();
    if (!schedule || !schedule.enabled) throw new NotFoundError(`Enabled report schedule "${scheduleId}" does not exist.`);
    const report = await this.reportRow(schedule.report_id);
    if (report.user_id !== schedule.owner_user_id) throw new AuthorizationDeniedError('Scheduled report owner no longer matches the saved report owner.');
    const principal = await this.auth.principalFromUser(schedule.owner_user_id);
    const recipientRow = await this.database.db.selectFrom('users').select(['email_address']).where('id', '=', schedule.owner_user_id).where('is_active', '=', true).where('is_deleted', '=', false).executeTakeFirst();
    const recipient = recipientRow?.email_address;
    if (typeof recipient !== 'string' || recipient.trim() === '') throw new ValidationError('The report owner has no active email address.');

    return this.scope.runAs(principal, async () => {
      const result = await this.exportCsv(report.id);
      if (result.truncated) throw new ValidationError('Scheduled report exceeds the bounded complete-result limit; no partial file was delivered.', { rows: result.rows });
      if (Buffer.byteLength(result.csv, 'utf8') > MAX_SCHEDULED_CSV_BYTES) {
        throw new ValidationError('Scheduled report CSV exceeds the 5 MiB delivery limit.');
      }
      return { reportId: report.id, reportName: report.name, recipient, filename: result.filename, csv: result.csv };
    }, `report-schedule:${schedule.id}:${randomBytes(8).toString('hex')}`);
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) throw new AuthenticationFailedError('Invalid report worker capability.');
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid report worker capability.');
    }
  }

  private async runDefinition(raw: unknown): Promise<ReportResult> {
    const definition = await this.validateDefinition(raw);
    const filterQuery = parseQueryRequest({ entity: definition.entityType, where: definition.filters }, this.metadata.registry);
    const requiredFields = new Set<string>(['id', ...definition.columns]);
    if (definition.groupBy !== undefined) requiredFields.add(definition.groupBy.field);
    if (definition.matrix !== undefined) {
      requiredFields.add(definition.matrix.rows.field);
      requiredFields.add(definition.matrix.columns.field);
    }
    for (const metric of definition.metrics) if (metric.field !== undefined) requiredFields.add(metric.field);
    for (const criterion of filterQuery.criteria) requiredFields.add(criterion.field);
    for (const field of requiredFields) await this.assertFieldReadable(definition.entityType, field);

    if (definition.kind !== 'list') {
      const dimensions = definition.groupBy !== undefined
        ? [{ ...(await this.reportFieldReference(definition.entityType, definition.groupBy.field)), field: definition.groupBy.field, ...(definition.groupBy.grain !== undefined ? { grain: definition.groupBy.grain } : {}) }]
        : definition.matrix !== undefined
          ? await Promise.all([definition.matrix.rows, definition.matrix.columns].map(async (dimension) => ({
            ...(await this.reportFieldReference(definition.entityType, dimension.field)),
            field: dimension.field,
            ...(dimension.grain !== undefined ? { grain: dimension.grain } : {}),
          })))
          : [];
      const metrics = await Promise.all(definition.metrics.map(async (metric) => ({
        name: metric.name,
        operation: metric.operation,
        ...(metric.field !== undefined ? { field: metric.field, ...(await this.reportFieldReference(definition.entityType, metric.field)) } : {}),
      })));
      const aggregate = await this.entities.aggregate(definition.entityType, {
        where: definition.filters,
        dimensions,
        metrics,
        maxGroups: MAX_REPORT_GROUPS,
      });
      try {
        return executeAggregateReport(definition, aggregate.total, aggregate.groups);
      } catch (error: unknown) {
        throw new ValidationError('Report result exceeds its configured cost limit.', { reason: error instanceof Error ? error.message : String(error) });
      }
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
    const fields: ReportFieldMap = this.reportFieldMap(entityType);
    let definition: ReportDefinition;
    try {
      definition = validateReportDefinition(raw, fields);
    } catch (error: unknown) {
      throw new ValidationError('Invalid report definition.', { reason: error instanceof Error ? error.message : String(error) });
    }
    if (definition.kind === 'list' && definition.columns.some((field) => field.includes('.'))) {
      throw new ValidationError('Related fields are available in summary, grouped, chart and matrix reports; list columns must be direct fields.');
    }
    // The Query Engine is the sole authority for filter grammar; report dimensions may also use a
    // metadata-validated one-hop link path, which is validated separately below.
    const translated = parseQueryRequest({ entity: entityType, where: definition.filters }, this.metadata.registry);
    const required = new Set<string>([...definition.columns, ...translated.criteria.map((criterion) => criterion.field)]);
    if (definition.groupBy !== undefined) required.add(definition.groupBy.field);
    if (definition.matrix !== undefined) {
      required.add(definition.matrix.rows.field);
      required.add(definition.matrix.columns.field);
    }
    for (const metric of definition.metrics) if (metric.field !== undefined) required.add(metric.field);
    for (const field of required) await this.assertFieldReadable(entityType, field);
    return definition;
  }

  private reportFieldMap(entityType: string): ReportFieldMap {
    const fields: Record<string, { type: string }> = { ...this.metadata.registry.getFields(entityType) };
    for (const [linkName, link] of Object.entries(this.metadata.registry.getFields(entityType))) {
      if (!['link', 'linkOne', 'foreign'].includes(link.type) || !link.entityKey || !this.metadata.registry.hasEntity(link.entityKey)) continue;
      for (const [fieldName, targetField] of Object.entries(this.metadata.registry.getFields(link.entityKey))) {
        fields[`${linkName}.${fieldName}`] = { type: targetField.type };
      }
    }
    return fields;
  }

  private async assertFieldReadable(entityType: string, fieldPath: string): Promise<void> {
    const parts = fieldPath.split('.');
    if (parts.length === 1) {
      if (!(await this.acl.visibleFields(entityType)).includes(fieldPath)) {
        throw new AuthorizationDeniedError(`Field "${fieldPath}" cannot be used in this report.`, { entity: entityType, field: fieldPath });
      }
      return;
    }
    if (parts.length !== 2) throw new ValidationError('Report related-field paths may traverse only one to-one relationship.', { field: fieldPath });
    const [linkName, targetField] = parts as [string, string];
    const link = this.metadata.registry.getField(entityType, linkName);
    const targetEntity = link?.entityKey;
    if (!link || !['link', 'linkOne', 'foreign'].includes(link.type) || !targetEntity || !this.metadata.registry.hasEntity(targetEntity)) {
      throw new ValidationError(`Field path "${fieldPath}" does not start with a supported to-one link field.`, { entity: entityType, field: fieldPath });
    }
    if (!(await this.acl.visibleFields(entityType)).includes(linkName)) {
      throw new AuthorizationDeniedError(`Relationship field "${linkName}" cannot be used in this report.`, { entity: entityType, field: linkName });
    }
    await this.acl.assertAccess(targetEntity, 'read');
    if (!(await this.acl.visibleFields(targetEntity)).includes(targetField)) {
      throw new AuthorizationDeniedError(`Related field "${targetField}" cannot be used in this report.`, { entity: targetEntity, field: targetField });
    }
  }

  private async reportFieldReference(entityType: string, fieldPath: string): Promise<{ fieldType: string; relation?: StoreReportRelation }> {
    const parts = fieldPath.split('.');
    if (parts.length === 1) {
      const field = this.metadata.registry.getField(entityType, fieldPath);
      if (!field) throw new ValidationError(`Unknown report field "${fieldPath}".`);
      return { fieldType: field.type };
    }
    await this.assertFieldReadable(entityType, fieldPath);
    const [sourceField, targetField] = parts as [string, string];
    const source = this.metadata.registry.getField(entityType, sourceField);
    const targetEntity = source?.entityKey;
    if (!source || !targetEntity) throw new ValidationError(`Unknown related report field "${fieldPath}".`);
    const target = this.metadata.registry.getField(targetEntity, targetField);
    if (!target) throw new ValidationError(`Unknown related report field "${fieldPath}".`);
    const acl = await this.acl.recordPredicate(targetEntity, 'read');
    return {
      fieldType: target.type,
      relation: { sourceField, sourceFieldType: source.type, targetEntity, targetField, targetFieldType: target.type, acl },
    };
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

function scheduleView(row: ReportScheduleRow): ReportScheduleView {
  return {
    id: row.id,
    reportId: row.report_id,
    cron: row.cron,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}
