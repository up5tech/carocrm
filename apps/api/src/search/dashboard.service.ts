import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Database } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ListQuery } from '../entity/entity.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { ESignatureDashletConfigSchema } from '../esignature/dto/esignature-shapes.js';
import { ESignatureReportService } from '../esignature/esignature-report.service.js';
import { LeadScoreDashletConfigSchema, LeadScoreReportService } from '../lead-score/lead-score-report.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { ProjectTaskDashletSchema } from '../projects/dto/project-shapes.js';
import { ProjectDashletService } from '../projects/project-dashlet.service.js';
import { safeJson } from './csv.js';
import { DashboardInputSchema, DashletConfigSchema, DashletInputSchema, ENTITY_NAME, MAX_DASHBOARDS_LIMIT, MAX_DASHLET_SCAN, TEXTISH_TYPES } from './portal-shapes.js';
import { SavedFilterService } from './saved-filter.service.js';

type DashboardRow = Database['dashboards'] & { id: string };
function groupKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '(empty)';
  return String(value).slice(0, 120);
}
@Injectable()
export class DashboardService {
  constructor(@Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SavedFilterService) private readonly filters: SavedFilterService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(ProjectDashletService) private readonly projectTasks: ProjectDashletService,
    @Inject(ESignatureReportService) private readonly eSignatureReports: ESignatureReportService,
    @Inject(LeadScoreReportService) private readonly leadScoreReports: LeadScoreReportService) {}
  assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!ENTITY_NAME.test(entity) || !this.metadata.registry.hasEntity(entity)) throw new NotFoundError(`Entity "${entity}" does not exist.`);
  }
  canSee(row: { user_id: string | null; is_shared: boolean }): boolean {
    // Phase 18: a portal user only ever sees its own dashboards; the portal dashboard itself is
    // served by `/api/v1/Portal/dashboard` (PLAN §37).
    if (this.scope.userType === 'portal') return row.user_id !== null && row.user_id === this.scope.userId;
    if (this.scope.isAdmin) return true;
    if (row.user_id !== null && row.user_id === this.scope.userId) return true;
    return row.is_shared;
  }
  async dashboardRow(id: string): Promise<DashboardRow> {
    const row = await this.database.db.selectFrom('dashboards').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError(`Dashboard "${id}" does not exist.`);
    return row as DashboardRow;
  }
  async requireDashlet(dashboardId: string, dashletId: string): Promise<{ id: string; kind: string; config: unknown }> {
    const row = await this.database.db.selectFrom('dashlets').selectAll().where('id', '=', dashletId).executeTakeFirst();
    if (!row || row.dashboard_id !== dashboardId) throw new NotFoundError(`Dashlet "${dashletId}" does not exist.`);
    return { id: row.id, kind: row.kind, config: row.config };
  }
  async list(): Promise<Record<string, unknown>[]> {
    const rows = await this.database.db.selectFrom('dashboards').selectAll().orderBy('name', 'asc').limit(MAX_DASHBOARDS_LIMIT).execute();
    return Promise.all(rows.filter((r) => this.canSee(r)).map((r) => this.view(r as DashboardRow)));
  }
  async get(id: string): Promise<Record<string, unknown>> {
    const row = await this.dashboardRow(id);
    if (!this.canSee(row)) throw new NotFoundError(`Dashboard "${id}" does not exist.`);
    return this.view(row);
  }
  async create(body: unknown): Promise<Record<string, unknown>> {
    const p = DashboardInputSchema.safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid dashboard.', { issues: p.error.issues.map((i) => i.message) });
    const id = generateId();
    const now = new Date();
    await this.database.db.insertInto('dashboards').values({ id, name: p.data.name, user_id: this.scope.userId ?? null,
      config: JSON.stringify(p.data.config), layout: JSON.stringify(p.data.layout), is_shared: p.data.isShared, created_at: now, modified_at: now }).execute();
    return this.view(await this.dashboardRow(id));
  }
  async update(id: string, body: unknown): Promise<Record<string, unknown>> {
    const row = await this.dashboardRow(id);
    if (!this.scope.isAdmin && row.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the dashboard owner or an administrator may update it.');
    const p = DashboardInputSchema.partial().safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid dashboard.', { issues: p.error.issues.map((i) => i.message) });
    await this.database.db.updateTable('dashboards').set({
      ...(p.data.name !== undefined ? { name: p.data.name } : {}),
      ...(p.data.layout !== undefined ? { layout: JSON.stringify(p.data.layout) } : {}),
      ...(p.data.config !== undefined ? { config: JSON.stringify(p.data.config) } : {}),
      ...(p.data.isShared !== undefined ? { is_shared: p.data.isShared } : {}),
      modified_at: new Date() }).where('id', '=', id).execute();
    return this.view(await this.dashboardRow(id));
  }
  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    const row = await this.dashboardRow(id);
    if (!this.scope.isAdmin && row.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the dashboard owner or an administrator may delete it.');
    await this.database.db.deleteFrom('dashlets').where('dashboard_id', '=', id).execute();
    await this.database.db.deleteFrom('dashboards').where('id', '=', id).execute();
    return { id, deleted: true };
  }
  async view(row: DashboardRow): Promise<Record<string, unknown>> {
    const dashlets = await this.database.db.selectFrom('dashlets').selectAll().where('dashboard_id', '=', row.id).orderBy('position', 'asc').execute();
    return { id: row.id, name: row.name, userId: row.user_id,
      config: typeof row.config === 'string' ? safeJson(row.config) : (row.config ?? {}),
      layout: typeof row.layout === 'string' ? safeJson(row.layout, []) : (row.layout ?? []),
      isShared: row.is_shared,
      dashlets: dashlets.map((d) => ({ id: d.id, name: d.name, kind: d.kind, position: d.position,
        config: typeof d.config === 'string' ? safeJson(d.config) : (d.config ?? {}) })),
      createdAt: row.created_at.toISOString(), modifiedAt: row.modified_at.toISOString() };
  }
  assertDashletConfig(raw: Record<string, unknown>, kind = 'list'): void {
    if (kind === 'projectTasks') {
      const scoped = ProjectTaskDashletSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('Invalid Project Task dashlet options.', { issues: scoped.error.issues.map((i) => i.message) });
      return;
    }
    // An ESignature dashlet names one curated aggregate; the module's query enforces the capability
    // and the reader's record scope when the dashlet runs (ES.19).
    if (kind === 'esignature') {
      const scoped = ESignatureDashletConfigSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('Invalid ESignature dashlet options.', { issues: scoped.error.issues.map((i) => i.message) });
      return;
    }
    // A Lead Score dashlet names one of the module's curated views (19-LS.18). The aggregate runs under the
    // reader's own scope, so a shared dashboard never counts Leads the reader could not open.
    if (kind === 'leadScore') {
      const scoped = LeadScoreDashletConfigSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('Invalid Lead Score dashlet options.', { issues: scoped.error.issues.map((i) => i.message) });
      return;
    }
    const p = DashletConfigSchema.safeParse(raw);
    if (!p.success) throw new ValidationError('Invalid dashlet config.', { issues: p.error.issues.map((i) => i.message) });
    this.assertEntity(p.data.entity);
    const fields = this.metadata.registry.getFields(p.data.entity);
    if (p.data.groupBy !== undefined) {
      const def = fields[p.data.groupBy];
      if (!def || !TEXTISH_TYPES.has(def.type)) throw new ValidationError(`Dashlet "groupBy" must be a categorical text field of "${p.data.entity}".`);
    }
    if (p.data.measure !== undefined) {
      const def = fields[p.data.measure];
      if (!def || !['int','float','decimal','currency'].includes(def.type)) throw new ValidationError(`Dashlet "measure" must be a numeric field of "${p.data.entity}".`);
      if (p.data.aggregation === 'count') throw new ValidationError('Dashlet "measure" requires aggregation "sum" or "avg".');
    }
  }
  async createDashlet(dashboardId: string, body: unknown): Promise<Record<string, unknown>> {
    const dashboard = await this.dashboardRow(dashboardId);
    if (!this.canSee(dashboard)) throw new NotFoundError(`Dashboard "${dashboardId}" does not exist.`);
    if (!this.scope.isAdmin && dashboard.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the dashboard owner or an administrator may add dashlets.');
    const p = DashletInputSchema.safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid dashlet.', { issues: p.error.issues.map((i) => i.message) });
    this.assertDashletConfig(p.data.config, p.data.kind);
    const id = generateId();
    const now = new Date();
    await this.database.db.insertInto('dashlets').values({ id, dashboard_id: dashboardId, name: p.data.name,
      kind: p.data.kind, position: p.data.position, config: JSON.stringify(p.data.config), created_at: now, modified_at: now }).execute();
    const full = await this.database.db.selectFrom('dashlets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { id: full.id, dashboardId, name: full.name, kind: full.kind, position: full.position,
      config: typeof full.config === 'string' ? safeJson(full.config) : (full.config ?? {}) };
  }
  async updateDashlet(dashboardId: string, dashletId: string, body: unknown): Promise<Record<string, unknown>> {
    const dashboard = await this.dashboardRow(dashboardId);
    if (!this.scope.isAdmin && dashboard.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the dashboard owner or an administrator may update dashlets.');
    await this.requireDashlet(dashboardId, dashletId);
    const p = DashletInputSchema.partial().safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid dashlet.', { issues: p.error.issues.map((i) => i.message) });
    if (p.data.config) this.assertDashletConfig(p.data.config, p.data.kind ?? (await this.requireDashlet(dashboardId, dashletId)).kind);
    await this.database.db.updateTable('dashlets').set({
      ...(p.data.name !== undefined ? { name: p.data.name } : {}),
      ...(p.data.kind !== undefined ? { kind: p.data.kind } : {}),
      ...(p.data.position !== undefined ? { position: p.data.position } : {}),
      ...(p.data.config !== undefined ? { config: JSON.stringify(p.data.config) } : {}),
      modified_at: new Date() }).where('id', '=', dashletId).execute();
    const full = await this.database.db.selectFrom('dashlets').selectAll().where('id', '=', dashletId).executeTakeFirstOrThrow();
    return { id: full.id, dashboardId, name: full.name, kind: full.kind, position: full.position,
      config: typeof full.config === 'string' ? safeJson(full.config) : (full.config ?? {}) };
  }
  async deleteDashlet(dashboardId: string, dashletId: string): Promise<{ id: string; deleted: boolean }> {
    const dashboard = await this.dashboardRow(dashboardId);
    if (!this.scope.isAdmin && dashboard.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the dashboard owner or an administrator may delete dashlets.');
    await this.requireDashlet(dashboardId, dashletId);
    await this.database.db.deleteFrom('dashlets').where('id', '=', dashletId).execute();
    return { id: dashletId, deleted: true };
  }
  async runDashlet(dashboardId: string, dashletId: string): Promise<Record<string, unknown>> {
    const dashboard = await this.dashboardRow(dashboardId);
    if (!this.canSee(dashboard)) throw new NotFoundError(`Dashboard "${dashboardId}" does not exist.`);
    const dashlet = await this.requireDashlet(dashboardId, dashletId);
    const raw = typeof dashlet.config === 'string' ? safeJson(dashlet.config) : (dashlet.config ?? {});
    if (dashlet.kind === 'projectTasks') {
      // Project access is decided by the entity list underneath, so a shared dashlet can only ever
      // show what its reader could open in the Projects views (§4.16).
      const scoped = ProjectTaskDashletSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('Project Task dashlet options are invalid.', { issues: scoped.error.issues.map((i) => i.message) });
      const result = await this.projectTasks.run(scoped.data);
      return { dashletId, kind: 'projectTasks', entity: 'ProjectTask', ...result };
    }
    if (dashlet.kind === 'esignature') {
      // The aggregate runs under the reader's own scope, not the dashboard owner's: a shared
      // dashboard never becomes a way to count requests the reader could not list (ES.19).
      const scoped = ESignatureDashletConfigSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('ESignature dashlet options are invalid.', { issues: scoped.error.issues.map((i) => i.message) });
      const section = await this.eSignatureReports.section(scoped.data.view, { days: scoped.data.days });
      return { dashletId, kind: 'esignature', ...section };
    }
    if (dashlet.kind === 'leadScore') {
      // The same rule as the ESignature dashlet: the numbers are the reader's, not the dashboard owner's.
      const scoped = LeadScoreDashletConfigSchema.safeParse(raw);
      if (!scoped.success) throw new ValidationError('Lead Score dashlet options are invalid.', { issues: scoped.error.issues.map((i) => i.message) });
      const section = await this.leadScoreReports.section(scoped.data.view);
      return { dashletId, kind: 'leadScore', ...section };
    }
    const p = DashletConfigSchema.safeParse(raw);
    if (!p.success) throw new ValidationError('Dashlet config is invalid.', { issues: p.error.issues.map((i) => i.message) });
    this.assertEntity(p.data.entity);
    await this.acl.assertAccess(p.data.entity, 'read');
    let where = p.data.where as ListQuery['where'];
    if (p.data.filterId !== undefined) {
      const filter = await this.filters.row(p.data.filterId);
      if (filter.entity_type !== p.data.entity) throw new ValidationError('Dashlet filter belongs to a different entity.');
      if (!this.filters.canSee(filter)) throw new NotFoundError(`Saved filter "${p.data.filterId}" does not exist.`);
      const criteria = typeof filter.criteria === 'string' ? safeJson(filter.criteria) : (filter.criteria ?? {});
      where = where === undefined ? (criteria as ListQuery['where']) : [{ and: [criteria, where] }];
    }
    // A KPI without grouping needs only a number, so let the engine COUNT instead of pulling rows:
    // an ungrouped KPI stays correct on 100k+ records. Grouped charts still aggregate in-process over
    // a bounded scan and say so through `truncated`.
    const plainKpi = dashlet.kind === 'kpi' && p.data.groupBy === undefined && p.data.measure === undefined;
    // §5.7 KPI context: when the dashlet names a date field and a window, the number counts the
    // current window and the equivalent window immediately before it is counted too — both under
    // the reader's own scope, so a shared dashboard never counts what its reader could not list.
    // A chart or list keeps its unwindowed semantics; the context fields only reshape a KPI.
    const windowDays = p.data.windowDays;
    const dateField = p.data.dateField;
    const windowed = dashlet.kind === 'kpi' && windowDays !== undefined && dateField !== undefined;
    const windowWhere = (from: Date, to: Date): ListQuery['where'] => {
      const clauses = [
        { field: dateField as string, operator: 'greaterThanOrEqual' as const, value: from.toISOString() },
        { field: dateField as string, operator: 'lessThan' as const, value: to.toISOString() },
      ];
      return where === undefined ? clauses : [{ and: [where, clauses] }];
    };
    const now = Date.now();
    const currentStart = new Date(now - (windowDays ?? 0) * 86_400_000);
    const previousStart = new Date(now - 2 * (windowDays ?? 0) * 86_400_000);
    const effectiveWhere = windowed ? windowWhere(currentStart, new Date(now)) : where;
    const budget = dashlet.kind === 'list' ? p.data.maxSize : MAX_DASHLET_SCAN;
    const result = await this.entities.list(p.data.entity, {
      ...(effectiveWhere !== undefined ? { where: effectiveWhere } : {}),
      maxSize: plainKpi ? 1 : budget,
      total: true,
    });
    const scanned = result.count;
    const total = result.total ?? scanned;
    const truncated = total > scanned;
    let previous: number | undefined;
    if (windowed) {
      const previousResult = await this.entities.list(p.data.entity, {
        where: windowWhere(previousStart, currentStart),
        maxSize: 1,
        total: true,
      });
      previous = previousResult.total ?? previousResult.count;
    }
    const trend =
      previous === undefined
        ? undefined
        : total > previous
          ? 'up'
          : total < previous
            ? 'down'
            : 'flat';
    const context = {
      ...(p.data.target !== undefined ? { target: p.data.target } : {}),
      ...(previous !== undefined ? { previous } : {}),
      ...(trend !== undefined ? { trend } : {}),
    };
    if (dashlet.kind === 'list') {
      return { dashletId, kind: 'list', entity: p.data.entity, count: total, scanned, truncated, list: result.list };
    }
    if (plainKpi) {
      return { dashletId, kind: 'kpi', entity: p.data.entity, key: 'all', count: total, ...context };
    }
    const groups = new Map<string, { count: number; sum: number }>();
    for (const record of result.list) {
      const key = p.data.groupBy === undefined ? 'all' : groupKey(record[p.data.groupBy]);
      const entry = groups.get(key) ?? { count: 0, sum: 0 };
      entry.count += 1;
      if (p.data.measure !== undefined) { const num = Number(record[p.data.measure]); if (Number.isFinite(num)) entry.sum += num; }
      groups.set(key, entry);
      if (groups.size > 100) break;
    }
    const buckets = [...groups.entries()].map(([key, entry]) => ({ key, count: entry.count,
      ...(p.data.measure !== undefined ? (p.data.aggregation === 'avg' ? { value: entry.count === 0 ? 0 : entry.sum / entry.count } : { value: entry.sum }) : {}) }));
    if (dashlet.kind === 'kpi' && p.data.groupBy === undefined) {
      const only = buckets[0] ?? { key: 'all', count: 0 };
      return { dashletId, kind: 'kpi', entity: p.data.entity, scanned, truncated, ...only, ...context };
    }
    return { dashletId, kind: dashlet.kind, entity: p.data.entity, scanned, truncated, groups: buckets };
  }
}
