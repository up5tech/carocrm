/**
 * Phase 18 — portal administration (PLAN §37).
 *
 * Admin-only lifecycle for the external-access surface: portals, the separate portal role
 * space, portal navigation, portal dashboards and their dashlets. Everything here mutates
 * configuration only; portal record visibility itself is enforced by
 * `PortalPolicyService` + the entity record store, never by these tables.
 */
import { AuthorizationDeniedError, DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { TEXTISH_TYPES } from '../search/portal-shapes.js';
import {
  ENTITY_NAME,
  MAX_NAV_ITEMS,
  MAX_PORTAL_DASHBOARDS,
  MAX_PORTAL_DASHLETS,
  MAX_PORTAL_ROLES,
  MAX_PORTALS,
  PortalDashboardInputSchema,
  PortalDashletConfigSchema,
  PortalDashletInputSchema,
  PortalInputSchema,
  PortalNavInputSchema,
  PortalRoleInputSchema,
  PortalRoleLinkSchema,
} from './shapes.js';

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, label: string): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ValidationError(`Invalid ${label}.`, { issues: result.error.issues.map((issue) => issue.message) });
  }
  return result.data;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class PortalAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
  }

  private assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!ENTITY_NAME.test(entity) || !this.metadata.registry.hasEntity(entity)) {
      throw new NotFoundError(`Entity "${entity}" does not exist.`);
    }
  }

  // -------------------------------------------------------------------------
  // portals
  // -------------------------------------------------------------------------

  async listPortals(): Promise<Record<string, unknown>[]> {
    this.requireAdmin();
    const rows = await this.db
      .selectFrom('portals')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name')
      .limit(MAX_PORTALS)
      .execute();
    const counts = await Promise.all(
      rows.map(async (row) => ({
        users: await this.db.selectFrom('users').select('id').where('portal_id', '=', row.id).where('is_deleted', '=', false).execute(),
        roles: await this.db.selectFrom('portals_portal_roles').select('portal_role_id').where('portal_id', '=', row.id).execute(),
      })),
    );
    return rows.map((row, index) => ({
      id: row.id,
      name: row.name,
      urlPath: row.url_path,
      isActive: row.is_active,
      settings: asObject(row.settings),
      userCount: counts[index]?.users.length ?? 0,
      portalRoleIds: (counts[index]?.roles ?? []).map((entry) => entry.portal_role_id),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    }));
  }

  async getPortal(id: string): Promise<Record<string, unknown>> {
    this.requireAdmin();
    const row = await this.portalRow(id);
    const roles = await this.db
      .selectFrom('portals_portal_roles')
      .select('portal_role_id')
      .where('portal_id', '=', id)
      .execute();
    return {
      id: row.id,
      name: row.name,
      urlPath: row.url_path,
      isActive: row.is_active,
      settings: asObject(row.settings),
      portalRoleIds: roles.map((entry) => entry.portal_role_id),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }

  async createPortal(body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    const data = parseOrThrow(PortalInputSchema, body, 'portal');
    const id = data.id ?? generateId();
    const exists = await this.db.selectFrom('portals').select('id').where('id', '=', id).executeTakeFirst();
    if (exists) throw new DuplicateRecordError(`Portal "${id}" already exists.`);
    const count = await this.db.selectFrom('portals').select('id').where('is_deleted', '=', false).execute();
    if (count.length >= MAX_PORTALS) throw new ValidationError(`At most ${String(MAX_PORTALS)} portals are allowed.`);
    await this.db
      .insertInto('portals')
      .values({
        id,
        name: data.name,
        url_path: data.urlPath,
        is_active: data.isActive,
        settings: JSON.stringify(data.settings),
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return this.getPortal(id);
  }

  async updatePortal(id: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.portalRow(id);
    const data = parseOrThrow(PortalInputSchema.partial(), body, 'portal');
    await this.db
      .updateTable('portals')
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.urlPath !== undefined ? { url_path: data.urlPath } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        ...(data.settings !== undefined ? { settings: JSON.stringify(data.settings) } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    return this.getPortal(id);
  }

  async deletePortal(id: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.portalRow(id);
    const users = await this.db.selectFrom('users').select('id').where('portal_id', '=', id).where('is_deleted', '=', false).execute();
    if (users.length > 0) {
      throw new DuplicateRecordError('Reassign or delete the portal users of this portal first.');
    }
    await this.db.updateTable('portals').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    return { id, deleted: true };
  }

  /** Roles granted to every portal user of the portal (PLAN §18.2). */
  async setPortalRoles(id: string, body: unknown): Promise<{ portalId: string; portalRoleIds: string[] }> {
    this.requireAdmin();
    await this.portalRow(id);
    const data = parseOrThrow(PortalRoleLinkSchema, body, 'portal role link');
    for (const roleId of data.portalRoleIds) await this.portalRoleRow(roleId);
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('portals_portal_roles').where('portal_id', '=', id).execute();
      for (const roleId of data.portalRoleIds) {
        await tx.insertInto('portals_portal_roles').values({ portal_id: id, portal_role_id: roleId }).onConflict((oc) => oc.doNothing()).execute();
      }
    });
    return { portalId: id, portalRoleIds: data.portalRoleIds };
  }

  private async portalRow(id: string) {
    const row = await this.db.selectFrom('portals').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || row.is_deleted) throw new NotFoundError(`Portal "${id}" does not exist.`);
    return row;
  }

  // -------------------------------------------------------------------------
  // portal roles
  // -------------------------------------------------------------------------

  async listPortalRoles(): Promise<Record<string, unknown>[]> {
    this.requireAdmin();
    const rows = await this.db
      .selectFrom('portal_roles')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name')
      .limit(MAX_PORTAL_ROLES)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      permissions: asObject(row.permissions),
      fieldPermissions: asObject(row.field_permissions),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    }));
  }

  async getPortalRole(id: string): Promise<Record<string, unknown>> {
    this.requireAdmin();
    const row = await this.portalRoleRow(id);
    return {
      id: row.id,
      name: row.name,
      permissions: asObject(row.permissions),
      fieldPermissions: asObject(row.field_permissions),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }

  async createPortalRole(body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    const data = parseOrThrow(PortalRoleInputSchema, body, 'portal role');
    const id = data.id ?? generateId();
    const count = await this.db.selectFrom('portal_roles').select('id').where('is_deleted', '=', false).execute();
    if (count.length >= MAX_PORTAL_ROLES) throw new ValidationError(`At most ${String(MAX_PORTAL_ROLES)} portal roles are allowed.`);
    await this.db
      .insertInto('portal_roles')
      .values({
        id,
        name: data.name,
        permissions: JSON.stringify(data.permissions),
        field_permissions: JSON.stringify(data.fieldPermissions),
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return this.getPortalRole(id);
  }

  async updatePortalRole(id: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.portalRoleRow(id);
    const data = parseOrThrow(PortalRoleInputSchema.partial(), body, 'portal role');
    await this.db
      .updateTable('portal_roles')
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.permissions !== undefined ? { permissions: JSON.stringify(data.permissions) } : {}),
        ...(data.fieldPermissions !== undefined ? { field_permissions: JSON.stringify(data.fieldPermissions) } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    return this.getPortalRole(id);
  }

  async deletePortalRole(id: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.portalRoleRow(id);
    await this.db.deleteFrom('portals_portal_roles').where('portal_role_id', '=', id).execute();
    await this.db.updateTable('portal_roles').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    return { id, deleted: true };
  }

  private async portalRoleRow(id: string) {
    const row = await this.db.selectFrom('portal_roles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || row.is_deleted) throw new NotFoundError(`Portal role "${id}" does not exist.`);
    return row;
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  async listNav(portalId: string): Promise<Record<string, unknown>[]> {
    this.requireAdmin();
    await this.portalRow(portalId);
    const rows = await this.db
      .selectFrom('portal_nav_items')
      .selectAll()
      .where('portal_id', '=', portalId)
      .orderBy('position')
      .orderBy('label')
      .limit(MAX_NAV_ITEMS)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      portalId: row.portal_id,
      label: row.label,
      entity: row.entity,
      route: row.route,
      icon: row.icon,
      position: row.position,
      isActive: row.is_active,
    }));
  }

  async createNavItem(portalId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.portalRow(portalId);
    const data = parseOrThrow(PortalNavInputSchema, body, 'portal navigation item');
    if (data.entity === null && data.route === null) {
      throw new ValidationError('A navigation item needs an entity or a route.');
    }
    if (data.entity !== null) this.assertEntity(data.entity);
    const existing = await this.db.selectFrom('portal_nav_items').select('id').where('portal_id', '=', portalId).execute();
    if (existing.length >= MAX_NAV_ITEMS) throw new ValidationError(`At most ${String(MAX_NAV_ITEMS)} navigation items per portal.`);
    const id = data.id ?? generateId();
    await this.db
      .insertInto('portal_nav_items')
      .values({
        id,
        portal_id: portalId,
        label: data.label,
        entity: data.entity,
        route: data.route,
        icon: data.icon,
        position: data.position,
        is_active: data.isActive,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return this.navItem(portalId, id);
  }

  async updateNavItem(portalId: string, itemId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.portalRow(portalId);
    await this.navItem(portalId, itemId);
    const data = parseOrThrow(PortalNavInputSchema.partial(), body, 'portal navigation item');
    if (data.entity !== undefined && data.entity !== null) this.assertEntity(data.entity);
    await this.db
      .updateTable('portal_nav_items')
      .set({
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.entity !== undefined ? { entity: data.entity } : {}),
        ...(data.route !== undefined ? { route: data.route } : {}),
        ...(data.icon !== undefined ? { icon: data.icon } : {}),
        ...(data.position !== undefined ? { position: data.position } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', itemId)
      .where('portal_id', '=', portalId)
      .execute();
    return this.navItem(portalId, itemId);
  }

  async deleteNavItem(portalId: string, itemId: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.navItem(portalId, itemId);
    await this.db.deleteFrom('portal_nav_items').where('id', '=', itemId).where('portal_id', '=', portalId).execute();
    return { id: itemId, deleted: true };
  }

  private async navItem(portalId: string, itemId: string) {
    const row = await this.db
      .selectFrom('portal_nav_items')
      .selectAll()
      .where('id', '=', itemId)
      .where('portal_id', '=', portalId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Navigation item "${itemId}" does not exist.`);
    return {
      id: row.id,
      portalId: row.portal_id,
      label: row.label,
      entity: row.entity,
      route: row.route,
      icon: row.icon,
      position: row.position,
      isActive: row.is_active,
    };
  }

  // -------------------------------------------------------------------------
  // dashboards and dashlets
  // -------------------------------------------------------------------------

  async listDashboards(portalId: string): Promise<Record<string, unknown>[]> {
    this.requireAdmin();
    await this.portalRow(portalId);
    const rows = await this.db
      .selectFrom('portal_dashboards')
      .selectAll()
      .where('portal_id', '=', portalId)
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .limit(MAX_PORTAL_DASHBOARDS)
      .execute();
    return Promise.all(rows.map((row) => this.dashboardView(row)));
  }

  async getDashboard(portalId: string, dashboardId: string): Promise<Record<string, unknown>> {
    this.requireAdmin();
    return this.dashboardView(await this.dashboardRow(portalId, dashboardId));
  }

  async createDashboard(portalId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.portalRow(portalId);
    const data = parseOrThrow(PortalDashboardInputSchema, body, 'portal dashboard');
    if (data.portalRoleId !== null) await this.portalRoleRow(data.portalRoleId);
    const existing = await this.db.selectFrom('portal_dashboards').select('id').where('portal_id', '=', portalId).execute();
    if (existing.length >= MAX_PORTAL_DASHBOARDS) throw new ValidationError(`At most ${String(MAX_PORTAL_DASHBOARDS)} dashboards per portal.`);
    const id = data.id ?? generateId();
    await this.db.transaction().execute(async (tx) => {
      // One default per portal: the partial unique index enforces it, the API keeps it honest.
      if (data.isDefault && data.portalRoleId === null) {
        await tx.updateTable('portal_dashboards').set({ is_default: false, modified_at: new Date() }).where('portal_id', '=', portalId).where('is_default', '=', true).execute();
      }
      await tx
        .insertInto('portal_dashboards')
        .values({
          id,
          portal_id: portalId,
          portal_role_id: data.portalRoleId,
          name: data.name,
          layout: JSON.stringify(data.layout),
          config: JSON.stringify(data.config),
          is_default: data.isDefault,
          created_at: new Date(),
          modified_at: new Date(),
        })
        .execute();
    });
    return this.getDashboard(portalId, id);
  }

  async updateDashboard(portalId: string, dashboardId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.dashboardRow(portalId, dashboardId);
    const data = parseOrThrow(PortalDashboardInputSchema.partial(), body, 'portal dashboard');
    if (data.portalRoleId !== undefined && data.portalRoleId !== null) await this.portalRoleRow(data.portalRoleId);
    await this.db.transaction().execute(async (tx) => {
      const becomesDefault = data.isDefault === true;
      const roleScoped = data.portalRoleId !== undefined ? data.portalRoleId : (await this.dashboardRow(portalId, dashboardId)).portal_role_id;
      if (becomesDefault && roleScoped === null) {
        await tx.updateTable('portal_dashboards').set({ is_default: false, modified_at: new Date() }).where('portal_id', '=', portalId).where('is_default', '=', true).where('id', '!=', dashboardId).execute();
      }
      await tx
        .updateTable('portal_dashboards')
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.portalRoleId !== undefined ? { portal_role_id: data.portalRoleId } : {}),
          ...(data.layout !== undefined ? { layout: JSON.stringify(data.layout) } : {}),
          ...(data.config !== undefined ? { config: JSON.stringify(data.config) } : {}),
          ...(data.isDefault !== undefined ? { is_default: data.isDefault } : {}),
          modified_at: new Date(),
        })
        .where('id', '=', dashboardId)
        .where('portal_id', '=', portalId)
        .execute();
    });
    return this.getDashboard(portalId, dashboardId);
  }

  async deleteDashboard(portalId: string, dashboardId: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.dashboardRow(portalId, dashboardId);
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('portal_dashlets').where('dashboard_id', '=', dashboardId).execute();
      await tx.deleteFrom('portal_dashboards').where('id', '=', dashboardId).where('portal_id', '=', portalId).execute();
    });
    return { id: dashboardId, deleted: true };
  }

  async createDashlet(portalId: string, dashboardId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.dashboardRow(portalId, dashboardId);
    const data = parseOrThrow(PortalDashletInputSchema, body, 'portal dashlet');
    this.assertDashletConfig(data.config);
    const existing = await this.db.selectFrom('portal_dashlets').select('id').where('dashboard_id', '=', dashboardId).execute();
    if (existing.length >= MAX_PORTAL_DASHLETS) throw new ValidationError(`At most ${String(MAX_PORTAL_DASHLETS)} dashlets per dashboard.`);
    const id = data.id ?? generateId();
    await this.db
      .insertInto('portal_dashlets')
      .values({
        id,
        dashboard_id: dashboardId,
        name: data.name,
        kind: data.kind,
        position: data.position,
        config: JSON.stringify(data.config),
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return this.dashletView(id);
  }

  async updateDashlet(portalId: string, dashboardId: string, dashletId: string, body: unknown): Promise<Record<string, unknown>> {
    this.requireAdmin();
    await this.dashboardRow(portalId, dashboardId);
    await this.dashletRow(dashboardId, dashletId);
    const data = parseOrThrow(PortalDashletInputSchema.partial(), body, 'portal dashlet');
    if (data.config !== undefined) this.assertDashletConfig(data.config);
    await this.db
      .updateTable('portal_dashlets')
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.kind !== undefined ? { kind: data.kind } : {}),
        ...(data.position !== undefined ? { position: data.position } : {}),
        ...(data.config !== undefined ? { config: JSON.stringify(data.config) } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', dashletId)
      .where('dashboard_id', '=', dashboardId)
      .execute();
    return this.dashletView(dashletId);
  }

  async deleteDashlet(portalId: string, dashboardId: string, dashletId: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.dashboardRow(portalId, dashboardId);
    await this.dashletRow(dashboardId, dashletId);
    await this.db.deleteFrom('portal_dashlets').where('id', '=', dashletId).where('dashboard_id', '=', dashboardId).execute();
    return { id: dashletId, deleted: true };
  }

  /** Same configuration contract as the internal dashlets (PLAN §33): no raw SQL, ever. */
  private assertDashletConfig(raw: Record<string, unknown>): void {
    const parsed = PortalDashletConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('Invalid dashlet config.', { issues: parsed.error.issues.map((issue) => issue.message) });
    }
    this.assertEntity(parsed.data.entity);
    const fields = this.metadata.registry.getFields(parsed.data.entity);
    if (parsed.data.groupBy !== undefined) {
      const def = fields[parsed.data.groupBy];
      if (!def || !TEXTISH_TYPES.has(def.type)) {
        throw new ValidationError(`Dashlet "groupBy" must be a categorical text field of "${parsed.data.entity}".`);
      }
    }
    if (parsed.data.measure !== undefined) {
      const def = fields[parsed.data.measure];
      if (!def || !['int', 'float', 'decimal', 'currency'].includes(def.type)) {
        throw new ValidationError(`Dashlet "measure" must be a numeric field of "${parsed.data.entity}".`);
      }
      if (parsed.data.aggregation === 'count') {
        throw new ValidationError('Dashlet "measure" requires aggregation "sum" or "avg".');
      }
    }
  }

  private async dashboardRow(portalId: string, dashboardId: string) {
    const row = await this.db
      .selectFrom('portal_dashboards')
      .selectAll()
      .where('id', '=', dashboardId)
      .where('portal_id', '=', portalId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Dashboard "${dashboardId}" does not exist.`);
    return row;
  }

  private async dashboardView(row: {
    id: string;
    portal_id: string;
    portal_role_id: string | null;
    name: string;
    layout: unknown;
    config: unknown;
    is_default: boolean;
    created_at: Date;
    modified_at: Date;
  }): Promise<Record<string, unknown>> {
    const dashlets = await this.db
      .selectFrom('portal_dashlets')
      .selectAll()
      .where('dashboard_id', '=', row.id)
      .orderBy('position')
      .execute();
    return {
      id: row.id,
      portalId: row.portal_id,
      portalRoleId: row.portal_role_id,
      name: row.name,
      layout: Array.isArray(row.layout) ? row.layout : [],
      config: asObject(row.config),
      isDefault: row.is_default,
      dashlets: dashlets.map((dashlet) => ({
        id: dashlet.id,
        name: dashlet.name,
        kind: dashlet.kind,
        position: dashlet.position,
        config: asObject(dashlet.config),
      })),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }

  private async dashletRow(dashboardId: string, dashletId: string) {
    const row = await this.db
      .selectFrom('portal_dashlets')
      .selectAll()
      .where('id', '=', dashletId)
      .where('dashboard_id', '=', dashboardId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Dashlet "${dashletId}" does not exist.`);
    return row;
  }

  private async dashletView(dashletId: string): Promise<Record<string, unknown>> {
    const row = await this.db.selectFrom('portal_dashlets').selectAll().where('id', '=', dashletId).executeTakeFirst();
    if (!row) throw new NotFoundError(`Dashlet "${dashletId}" does not exist.`);
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      name: row.name,
      kind: row.kind,
      position: row.position,
      config: asObject(row.config),
    };
  }
}
