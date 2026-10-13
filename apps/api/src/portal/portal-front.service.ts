/**
 * Phase 18 — the portal user's own API surface (PLAN §37).
 *
 * Everything a signed-in portal user may read about itself: which portal it belongs to, which
 * contact it is, the portal navigation and the portal dashboard. Dashlet execution goes through
 * `EntityCrudService`, so entity/record/field ACL for the portal principal — including the
 * contact/account visibility rule — is enforced by the same code path as any other read.
 */
import { AuthenticationRequiredError, AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import type { ListQuery } from '../entity/entity.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { PortalContextView } from './shapes.js';
import { PortalDashletConfigSchema } from './shapes.js';

const MAX_DASHBOARD_GROUPS = 100;

function groupKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '(empty)';
  return String(value).slice(0, 120);
}

@Injectable()
export class PortalFrontService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private requirePortalPrincipal(): { userId: string; portalId: string; contactId: string | undefined } {
    const principal = this.scope.principal;
    if (!principal || principal.userType !== 'portal') {
      throw new AuthorizationDeniedError('Portal users only.');
    }
    if (!principal.portalId) {
      throw new AuthorizationDeniedError('This portal user is not assigned to a portal.');
    }
    return { userId: principal.userId, portalId: principal.portalId, contactId: principal.contactId };
  }

  /** Everything the portal shell renders: portal, user, contact, roles, navigation, dashboard. */
  async context(): Promise<PortalContextView> {
    const { userId, portalId, contactId } = this.requirePortalPrincipal();
    const portal = await this.db
      .selectFrom('portals')
      .selectAll()
      .where('id', '=', portalId)
      .executeTakeFirst();
    if (!portal || !portal.is_active || portal.is_deleted) {
      throw new AuthorizationDeniedError('This portal is not active.');
    }
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'user_name', 'first_name', 'last_name', 'email_address', 'is_active', 'portal_id', 'contact_id', 'is_deleted'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || !user.is_active || user.is_deleted || user.portal_id !== portal.id) {
      throw new AuthenticationRequiredError('Portal user is not active.');
    }

    const contact = contactId ? await this.contactView(contactId) : null;
    const roles = await this.roleViews(portal.id, userId);
    const nav = await this.navViews(portal.id);
    const dashboard = await this.dashboardView(portal.id, roles.map((role) => role.id));
    return {
      portal: { id: portal.id, name: portal.name, urlPath: portal.url_path },
      user: {
        id: user.id,
        userName: user.user_name,
        firstName: user.first_name,
        lastName: user.last_name,
        emailAddress: user.email_address,
        isActive: user.is_active,
      },
      contact,
      roles,
      nav,
      dashboard,
    };
  }

  /** Portal navigation for the current user (active items only, in position order). */
  async nav(): Promise<PortalContextView['nav']> {
    const { portalId } = this.requirePortalPrincipal();
    const portal = await this.db.selectFrom('portals').select(['id', 'is_active', 'is_deleted']).where('id', '=', portalId).executeTakeFirst();
    if (!portal || !portal.is_active || portal.is_deleted) throw new AuthorizationDeniedError('This portal is not active.');
    return this.navViews(portal.id);
  }

  /** The dashboard for the current user: a role-specific one wins over the portal default. */
  async dashboard(): Promise<PortalContextView['dashboard']> {
    const { portalId, userId } = this.requirePortalPrincipal();
    const portal = await this.db.selectFrom('portals').select(['id', 'is_active', 'is_deleted']).where('id', '=', portalId).executeTakeFirst();
    if (!portal || !portal.is_active || portal.is_deleted) throw new AuthorizationDeniedError('This portal is not active.');
    const roles = await this.roleViews(portal.id, userId);
    return this.dashboardView(portal.id, roles.map((role) => role.id));
  }

  /**
   * Executes a portal dashlet under the current portal principal's ACL. The entity must be one
   * the portal role may read; record visibility then restricts the result to the portal user's
   * contact/account neighbourhood exactly like any other list read.
   */
  async runDashlet(dashletId: string): Promise<Record<string, unknown>> {
    const dashboard = await this.dashboard();
    const dashlet = dashboard?.dashlets.find((entry) => entry.id === dashletId);
    if (!dashlet) throw new NotFoundError(`Dashlet "${dashletId}" is not on your portal dashboard.`);

    const parsed = PortalDashletConfigSchema.safeParse(dashlet.config);
    if (!parsed.success) {
      throw new ValidationError('Dashlet config is invalid.', { issues: parsed.error.issues.map((issue) => issue.message) });
    }
    const config = parsed.data;
    if (!this.metadata.registry.hasEntity(config.entity)) {
      throw new NotFoundError(`Entity "${config.entity}" does not exist.`);
    }
    const query: ListQuery = {
      ...(config.where !== undefined ? { where: config.where } : {}),
      maxSize: config.maxSize,
      total: true,
    };
    const result = await this.entities.list(config.entity, query);
    const scanned = result.count;
    const total = result.total ?? scanned;

    if (dashlet.kind === 'list') {
      return { dashletId, kind: 'list', entity: config.entity, count: total, scanned, truncated: total > scanned, list: result.list };
    }
    const groups = new Map<string, { count: number; sum: number }>();
    for (const record of result.list) {
      const key = config.groupBy === undefined ? 'all' : groupKey(record[config.groupBy]);
      const entry = groups.get(key) ?? { count: 0, sum: 0 };
      entry.count += 1;
      if (config.measure !== undefined) {
        const num = Number(record[config.measure]);
        if (Number.isFinite(num)) entry.sum += num;
      }
      groups.set(key, entry);
      if (groups.size > MAX_DASHBOARD_GROUPS) break;
    }
    const buckets = [...groups.entries()].map(([key, entry]) => ({
      key,
      count: entry.count,
      ...(config.measure !== undefined
        ? config.aggregation === 'avg'
          ? { value: entry.count === 0 ? 0 : entry.sum / entry.count }
          : { value: entry.sum }
        : {}),
    }));
    if (dashlet.kind === 'kpi' && config.groupBy === undefined) {
      const only = buckets[0] ?? { key: 'all', count: 0 };
      return { dashletId, kind: 'kpi', entity: config.entity, scanned, truncated: total > scanned, ...only };
    }
    return { dashletId, kind: dashlet.kind, entity: config.entity, scanned, truncated: total > scanned, groups: buckets };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async contactView(contactId: string): Promise<{ id: string; name: string | null } | null> {
    if (!this.metadata.registry.hasEntity('Contact')) return null;
    const record = await this.entities.get('Contact', contactId).catch(() => undefined);
    if (!record) return null;
    const name = typeof record['name'] === 'string' ? record['name'] : null;
    return { id: contactId, name };
  }

  /** Portal roles of the user: the portal's own roles plus the roles assigned to the user. */
  private async roleViews(portalId: string, userId: string): Promise<{ id: string; name: string }[]> {
    const user = await this.db.selectFrom('users').select(['portal_role_ids']).where('id', '=', userId).executeTakeFirst();
    const direct = Array.isArray(user?.portal_role_ids) ? (user.portal_role_ids as string[]) : [];
    const linked = await this.db.selectFrom('portals_portal_roles').select('portal_role_id').where('portal_id', '=', portalId).execute();
    const roleIds = Array.from(new Set([...linked.map((row) => row.portal_role_id), ...direct]));
    if (roleIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('portal_roles')
      .select(['id', 'name'])
      .where('is_deleted', '=', false)
      .where('id', 'in', roleIds)
      .orderBy('name')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  private async navViews(portalId: string): Promise<PortalContextView['nav']> {
    const rows = await this.db
      .selectFrom('portal_nav_items')
      .selectAll()
      .where('portal_id', '=', portalId)
      .where('is_active', '=', true)
      .orderBy('position')
      .orderBy('label')
      .limit(50)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      entity: row.entity,
      route: row.route,
      icon: row.icon,
      position: row.position,
    }));
  }

  /** A dashboard bound to one of the user's roles wins; otherwise the portal default. */
  private async dashboardView(portalId: string, roleIds: readonly string[]): Promise<PortalContextView['dashboard']> {
    let row: { id: string; name: string } | undefined;
    if (roleIds.length > 0) {
      row = await this.db
        .selectFrom('portal_dashboards')
        .select(['id', 'name'])
        .where('portal_id', '=', portalId)
        .where('portal_role_id', 'in', roleIds as string[])
        .orderBy('name')
        .executeTakeFirst();
    }
    if (!row) {
      row = await this.db
        .selectFrom('portal_dashboards')
        .select(['id', 'name'])
        .where('portal_id', '=', portalId)
        .where('is_default', '=', true)
        .executeTakeFirst();
    }
    if (!row) return null;
    const dashlets = await this.db
      .selectFrom('portal_dashlets')
      .selectAll()
      .where('dashboard_id', '=', row.id)
      .orderBy('position')
      .limit(50)
      .execute();
    return {
      id: row.id,
      name: row.name,
      dashlets: dashlets.map((dashlet) => ({
        id: dashlet.id,
        name: dashlet.name,
        kind: dashlet.kind,
        position: dashlet.position,
        config: typeof dashlet.config === 'object' && dashlet.config !== null ? (dashlet.config as Record<string, unknown>) : {},
      })),
    };
  }
}
