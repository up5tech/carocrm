import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, DuplicateRecordError,RecordNotFoundError, ValidationError  } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { AuthService } from './auth.service.js';

/**
 * The built-in role that `AclApiService` folds into "administrator". It is named here because the
 * last-administrator rule has to recognise the same two ways an account can be administrative
 * (`users.is_admin` / `users.type`, or this role id) — see `assertKeepsAnAdministrator`.
 */
const SYS_ADMIN_ROLE = 'sysAdmin';

export const CreateUserSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  userName: z.string().min(2).max(100),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  // `null` clears a value; the administration form has to be able to empty a field, and an empty string
  // is not a valid email address. Omitting the key means "leave it as it is".
  emailAddress: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  assignedRoleIds: z.array(z.string()).optional(),
  /**
   * Team membership written from the user's side. `users_teams` is the authoritative table (the ACL
   * reads it), so the team's denormalised `user_id` array is recomputed from it after every change.
   */
  teamIds: z.array(z.string().min(1).max(36)).max(200).optional(),
  /** Phase 18: `portal` users get their authority from portal roles only (PLAN §37). */
  type: z.enum(['admin', 'regular', 'portal']).optional(),
  portalId: z.string().min(1).max(36).optional(),
  contactId: z.string().min(1).max(36).optional(),
  portalRoleIds: z.array(z.string().min(1).max(36)).max(100).optional(),
  title: z.string().max(128).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
});

export const UpdateUserSchema = CreateUserSchema.partial();

export const CreateRoleSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().min(1).max(150),
  permissions: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  fieldPermissions: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.string()))).optional(),
});

export const CreateTeamSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().min(1).max(150),
  userIds: z.array(z.string()).optional(),
  roleIds: z.array(z.string()).optional(),
  isPrivate: z.boolean().optional(),
});

/** Account kinds the `users.type` column can hold; `api` and `system` never sign in from the SPA. */
export const USER_ACCOUNT_TYPES = ['admin', 'regular', 'api', 'portal', 'system'] as const;
export type UserAccountType = (typeof USER_ACCOUNT_TYPES)[number];

/** Server-side filters for `GET /User` so a page of users can be narrowed without fetching them all. */
export interface UserFilters {
  readonly isActive?: boolean | undefined;
  readonly type?: UserAccountType | undefined;
  readonly roleId?: string | undefined;
  readonly teamId?: string | undefined;
}

/**
 * Validate a payload against a schema and answer the way every other write in this API does.
 * A raw `Schema.parse` throws a `ZodError`, which the exception filter reports as `500 INTERNAL_ERROR`
 * — so a mistyped email address in the users form looked like a server outage. The issue paths are the
 * same shape the settings documents report.
 */
function parseOrReject<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new ValidationError('The submitted record is not valid.', {
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
  }

  /**
   * The assignee picker behind the list view's **Assign** action (PLAN_Phase_20_Settings_UX.md §5.3).
   *
   * This is not `GET /User`: that list is administrator-only and carries fields a rep must not see
   * (roles, teams, flags, email). An assignee lookup answers one question — who may this work be
   * given to — so it returns an id and a display name for active internal accounts only, and it
   * refuses a portal principal outright: a customer never picks an internal owner.
   */
  async listAssignableUsers(term = ''): Promise<{ list: { id: string; name: string }[] }> {
    const principal = this.scope.principal;
    if (!principal || principal.userType === 'portal') {
      throw new AuthorizationDeniedError('Only internal users can be assigned records.');
    }
    let query = this.db
      .selectFrom('users')
      .select(['id', 'first_name', 'last_name', 'user_name'])
      .where('is_deleted', '=', false)
      .where('is_active', '=', true)
      .where('type', '!=', 'system');
    const trimmed = term.trim();
    if (trimmed !== '') query = query.where('user_name', 'like', `%${trimmed}%`);
    const rows = await query.orderBy('user_name').limit(500).execute();
    return {
      list: rows.map((row) => ({
        id: row.id,
        name: [row.first_name, row.last_name].filter((part): part is string => !!part).join(' ') || row.user_name,
      })),
    };
  }

  private get db() {
    return this.database.db;
  }

  /**
   * Refuse a change that would leave the instance with no active administrator
   * (PLAN_Phase_20_Settings_UX.md §4.7). An account is administrative the same way `AclApiService`
   * decides it — `is_admin`, `type = 'admin'`, or the built-in `sysAdmin` role — and the rule is
   * checked against the state *after* the change, so deactivating, demoting or deleting the last one
   * is what fails rather than the field being edited.
   */
  private async assertKeepsAnAdministrator(targetId: string, after: AdministratorState): Promise<void> {
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'is_admin', 'type', 'assigned_role_ids', 'is_active'])
      .where('is_deleted', '=', false)
      .execute();
    if (!leavesNoAdministrator(rows, targetId, after)) return;
    throw new ValidationError('This is the last administrator account, so it cannot be demoted, deactivated or deleted.', {
      rule: 'lastAdministrator',
    });
  }

  /**
   * Make `users_teams` match the given team list, then recompute each touched team's denormalised
   * `user_id` array from it. `users_teams` is what the ACL and the Service Desk read, so it stays the
   * single source of truth and the JSONB copy can never disagree about who is in a team.
   */
  private async syncUserTeams(userId: string, teamIds: readonly string[]): Promise<void> {
    if (teamIds.length > 0) {
      const known = await this.db.selectFrom('teams').select('id').where('is_deleted', '=', false).execute();
      const knownIds = new Set(known.map((row) => row.id));
      const unknown = teamIds.filter((teamId) => !knownIds.has(teamId));
      if (unknown.length > 0) throw new ValidationError('Unknown team assignment.', { teamIds: unknown });
    }
    const current = (await this.db.selectFrom('users_teams').select('team_id').where('user_id', '=', userId).execute()).map((row) => row.team_id);
    const added = teamIds.filter((teamId) => !current.includes(teamId));
    const removed = current.filter((teamId) => !teamIds.includes(teamId));
    for (const teamId of removed) {
      await this.db.deleteFrom('users_teams').where('user_id', '=', userId).where('team_id', '=', teamId).execute();
    }
    for (const teamId of added) {
      await this.db.insertInto('users_teams').values({ user_id: userId, team_id: teamId }).onConflict((oc) => oc.doNothing()).execute();
    }
    for (const teamId of [...added, ...removed]) {
      const members = (await this.db.selectFrom('users_teams').select('user_id').where('team_id', '=', teamId).execute()).map((row) => row.user_id);
      await this.db.updateTable('teams').set({ user_id: JSON.stringify(members), modified_at: new Date() }).where('id', '=', teamId).execute();
    }
  }

  /**
   * Keep `teams_roles` — the table the ACL actually reads for team-scoped roles — in step with the
   * team's `role_ids`. Before this, a role assigned to a team was stored but never granted.
   */
  private async syncTeamRoles(teamId: string, roleIds: readonly string[]): Promise<void> {
    if (roleIds.length > 0) {
      const known = await this.db.selectFrom('roles').select('id').where('is_deleted', '=', false).execute();
      const knownIds = new Set(known.map((row) => row.id));
      const unknown = roleIds.filter((roleId) => !knownIds.has(roleId));
      if (unknown.length > 0) throw new ValidationError('Unknown role assignment.', { roleIds: unknown });
    }
    await this.db.deleteFrom('teams_roles').where('team_id', '=', teamId).execute();
    for (const roleId of roleIds) {
      await this.db.insertInto('teams_roles').values({ team_id: teamId, role_id: roleId }).onConflict((oc) => oc.doNothing()).execute();
    }
  }

  async listUsers(offset = 0, limit = 20, where?: string, filters: UserFilters = {}) {
    this.requireAdmin();
    let query = this.db.selectFrom('users').where('is_deleted', '=', false);
    let countQuery = this.db.selectFrom('users').where('is_deleted', '=', false);
    if (where) {
      query = query.where('user_name', 'like', `%${where}%`);
      countQuery = countQuery.where('user_name', 'like', `%${where}%`);
    }
    if (filters.isActive !== undefined) {
      query = query.where('is_active', '=', filters.isActive);
      countQuery = countQuery.where('is_active', '=', filters.isActive);
    }
    if (filters.type !== undefined) {
      query = query.where('type', '=', filters.type);
      countQuery = countQuery.where('type', '=', filters.type);
    }
    // Role and team filters are JSONB containment and an existence check against the authoritative
    // membership table, so the paging stays on the server instead of the browser filtering one page.
    if (filters.roleId !== undefined) {
      const condition = sql<boolean>`assigned_role_ids @> ${JSON.stringify([filters.roleId])}::jsonb`;
      query = query.where(condition);
      countQuery = countQuery.where(condition);
    }
    if (filters.teamId !== undefined) {
      const condition = sql<boolean>`exists (select 1 from users_teams ut where ut.user_id = users.id and ut.team_id = ${filters.teamId})`;
      query = query.where(condition);
      countQuery = countQuery.where(condition);
    }
    const rows = await query
      .select(['id', 'user_name', 'first_name', 'last_name', 'email_address', 'is_admin', 'is_active', 'type', 'assigned_role_ids', 'portal_id', 'contact_id', 'portal_role_ids', 'title', 'phone', 'created_at', 'modified_at'])
      .orderBy('user_name')
      .limit(limit)
      .offset(offset)
      .execute();
    const totalRow = await countQuery.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();
    const list = rows.map(toUserDto);
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getUser(id: string) {
    this.requireAdmin();
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!row) {
      throw new RecordNotFoundError('User', id);
    }
    const teamRows = await this.db.selectFrom('users_teams').select('team_id').where('user_id', '=', id).execute();
    return { ...toUserDto(row), teams: teamRows.map((t) => t.team_id) };
  }

  async createUser(payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(CreateUserSchema, payload);
    const id = data.id ?? randomUUID();
    const exists = await this.db.selectFrom('users').select('id').where('user_name', '=', data.userName).executeTakeFirst();
    if (exists) {
      throw new DuplicateRecordError(`User name "${data.userName}" is already in use.`);
    }
    const isPortal = (data.type ?? 'regular') === 'portal';
    if (isPortal && (data.assignedRoleIds ?? []).length > 0) {
      throw new ValidationError('Portal users are authorized by portal roles only; internal roles cannot be assigned.');
    }
    const portal = isPortal ? await this.resolvePortalFields(data) : { portalId: null, contactId: null, portalRoleIds: [] };
    await this.db
      .insertInto('users')
      .values({
        id,
        user_name: data.userName,
        first_name: data.firstName ?? null,
        last_name: data.lastName ?? null,
        email_address: data.emailAddress ?? null,
        is_admin: isPortal ? false : (data.isAdmin ?? false),
        is_active: data.isActive ?? true,
        type: isPortal ? 'portal' : data.isAdmin ? 'admin' : (data.type ?? 'regular'),
        auth_method: 'password',
        password: null,
        assigned_role_ids: JSON.stringify(isPortal ? [] : (data.assignedRoleIds ?? [])),
        portal_id: portal.portalId,
        contact_id: portal.contactId,
        portal_role_ids: JSON.stringify(portal.portalRoleIds),
        title: data.title ?? null,
        phone: data.phone ?? null,
        portal_types: JSON.stringify([]),
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
        created_by_id: this.scope.userId ?? null,
        modified_by_id: this.scope.userId ?? null,
      })
      .execute();
    if (data.password) {
      await this.auth.setPassword(id, data.password);
    }
    if (data.teamIds !== undefined && !isPortal) {
      await this.syncUserTeams(id, data.teamIds);
    }
    return this.getUser(id);
  }

  async updateUser(id: string, payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(UpdateUserSchema, payload);
    const existing = await this.db
      .selectFrom('users')
      .select(['id', 'type', 'is_admin', 'is_active', 'assigned_role_ids', 'portal_id', 'contact_id', 'portal_role_ids'])
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!existing) throw new RecordNotFoundError('User', id);
    const isPortal = (data.type ?? existing.type) === 'portal';
    if (isPortal && (data.assignedRoleIds ?? []).length > 0) {
      throw new ValidationError('Portal users are authorized by portal roles only; internal roles cannot be assigned.');
    }
    // The last-administrator rule is evaluated on the state this update would produce.
    await this.assertKeepsAnAdministrator(id, {
      isAdmin: isPortal ? false : (data.isAdmin ?? existing.is_admin),
      type: isPortal ? 'portal' : (data.type ?? (data.isAdmin !== undefined ? (data.isAdmin ? 'admin' : 'regular') : existing.type)),
      roleIds: data.assignedRoleIds ?? this.asStringArray(existing.assigned_role_ids),
      isActive: data.isActive ?? existing.is_active,
    });
    const portal = isPortal ? await this.resolvePortalFields(data, existing) : { portalId: null, contactId: null, portalRoleIds: [] };
    await this.db
      .updateTable('users')
      .set({
        ...(data.firstName !== undefined ? { first_name: data.firstName } : {}),
        ...(data.lastName !== undefined ? { last_name: data.lastName } : {}),
        ...(data.emailAddress !== undefined ? { email_address: data.emailAddress } : {}),
        ...(data.isAdmin !== undefined && !isPortal ? { is_admin: data.isAdmin, type: data.isAdmin ? 'admin' : 'regular' } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        ...(data.type !== undefined && !isPortal ? { type: data.type } : {}),
        ...(isPortal ? { is_admin: false, type: 'portal', assigned_role_ids: JSON.stringify([]) } : {}),
        ...(data.assignedRoleIds !== undefined && !isPortal ? { assigned_role_ids: JSON.stringify(data.assignedRoleIds) } : {}),
        ...(isPortal
          ? { portal_id: portal.portalId, contact_id: portal.contactId, portal_role_ids: JSON.stringify(portal.portalRoleIds) }
          : { portal_id: null, contact_id: null, portal_role_ids: JSON.stringify([]) }),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (data.password) {
      await this.auth.setPassword(id, data.password);
      // An administrator setting a password is a reset: the sessions the old one opened end with it.
      await this.db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
    }
    if (data.teamIds !== undefined && !isPortal) {
      await this.syncUserTeams(id, data.teamIds);
    }
    return this.getUser(id);
  }

  /**
   * Phase 18 portal user linkage (PLAN §37). A portal user must point at an existing Contact
   * record and an active portal, and may hold portal roles only — the two role spaces never
   * mix. Partial updates keep existing linkage when the field is omitted.
   */
  private async resolvePortalFields(
    data: { portalId?: string | undefined; contactId?: string | undefined; portalRoleIds?: string[] | undefined },
    existing?: { portal_id: string | null; contact_id: string | null; portal_role_ids: unknown },
  ): Promise<{ portalId: string | null; contactId: string | null; portalRoleIds: string[] }> {
    const portalId = data.portalId ?? existing?.portal_id ?? null;
    const contactId = data.contactId ?? existing?.contact_id ?? null;
    if (!portalId) {
      throw new ValidationError('A portal user must be assigned to a portal.');
    }
    if (!contactId) {
      throw new ValidationError('A portal user must be linked to a contact record.');
    }
    const portal = await this.db.selectFrom('portals').select(['id', 'is_active', 'is_deleted']).where('id', '=', portalId).executeTakeFirst();
    if (!portal || !portal.is_active || portal.is_deleted) {
      throw new ValidationError(`Portal "${portalId}" does not exist or is not active.`);
    }
    const contact = await this.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Contact')
      .where('id', '=', contactId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!contact) {
      throw new ValidationError(`Contact "${contactId}" does not exist.`);
    }
    const portalRoleIds = data.portalRoleIds ?? this.asStringArray(existing?.portal_role_ids);
    for (const roleId of portalRoleIds) {
      const role = await this.db.selectFrom('portal_roles').select('id').where('id', '=', roleId).where('is_deleted', '=', false).executeTakeFirst();
      if (!role) {
        throw new ValidationError(`Portal role "${roleId}" does not exist.`);
      }
    }
    return { portalId, contactId, portalRoleIds };
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  async deleteUser(id: string) {
    this.requireAdmin();
    if (id === this.scope.userId) {
      throw new DuplicateRecordError('You cannot delete your own account.');
    }
    const target = await this.db
      .selectFrom('users')
      .select(['id', 'is_admin', 'type', 'assigned_role_ids', 'is_active'])
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!target) throw new RecordNotFoundError('User', id);
    // Deleting an account is the strongest form of deactivation, so it goes through the same rule.
    await this.assertKeepsAnAdministrator(id, {
      isAdmin: false,
      type: 'regular',
      roleIds: [],
      isActive: false,
    });
    await this.db.updateTable('users').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    await this.db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
    await this.db.deleteFrom('users_teams').where('user_id', '=', id).execute();
    return { success: true };
  }

  /**
   * Set an account's password from the administration screen. Distinct from `updateUser` because it
   * is a deliberate, confirmed action: it revokes the sessions the previous password opened.
   */
  async resetUserPassword(id: string, password: string) {
    this.requireAdmin();
    const user = await this.db.selectFrom('users').select('id').where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!user) throw new RecordNotFoundError('User', id);
    await this.auth.setPassword(id, password);
    await this.db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
    return { success: true };
  }

  async listRoles(offset = 0, limit = 20, term = '') {
    this.requireAdmin();
    // §5.3: the role picker is searchable, so a filter narrows rows *and* the reported total.
    const trimmed = term.trim();
    let rowsQuery = this.db.selectFrom('roles').selectAll().where('is_deleted', '=', false);
    let countQuery = this.db.selectFrom('roles').where('is_deleted', '=', false);
    if (trimmed !== '') {
      rowsQuery = rowsQuery.where('name', 'like', `%${trimmed}%`);
      countQuery = countQuery.where('name', 'like', `%${trimmed}%`);
    }
    const rows = await rowsQuery.orderBy('name').limit(limit).offset(offset).execute();
    const totalRow = await countQuery.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();
    const list = rows.map(toRoleDto);
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getRole(id: string) {
    this.requireAdmin();
    const row = await this.db.selectFrom('roles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RecordNotFoundError('Role', id);
    return toRoleDto(row);
  }

  async createRole(payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(CreateRoleSchema, payload);
    const id = data.id ?? randomUUID();
    await this.db
      .insertInto('roles')
      .values({
        id,
        name: data.name,
        permissions: JSON.stringify(data.permissions ?? {}),
        field_permissions: JSON.stringify(data.fieldPermissions ?? {}),
        entity_type: 'Role',
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return this.getRole(id);
  }

  async updateRole(id: string, payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(CreateRoleSchema.partial(), payload);
    await this.db
      .updateTable('roles')
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.permissions !== undefined ? { permissions: JSON.stringify(data.permissions) } : {}),
        ...(data.fieldPermissions !== undefined ? { field_permissions: JSON.stringify(data.fieldPermissions) } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    return this.getRole(id);
  }

  /**
   * Soft-delete a role. Refused while anything still points at it: an account that would silently
   * lose its authority is a worse outcome than an administrator having to reassign first.
   */
  async deleteRole(id: string) {
    this.requireAdmin();
    const role = await this.db.selectFrom('roles').select('id').where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!role) throw new RecordNotFoundError('Role', id);
    const users = await this.db
      .selectFrom('users')
      .select('id')
      .where('is_deleted', '=', false)
      .where(sql<boolean>`assigned_role_ids @> ${JSON.stringify([id])}::jsonb`)
      .execute();
    const apiUsers = await this.db
      .selectFrom('api_users')
      .select('id')
      .where(sql<boolean>`assigned_role_ids @> ${JSON.stringify([id])}::jsonb`)
      .execute();
    const teams = await this.db.selectFrom('teams_roles').select('team_id').where('role_id', '=', id).execute();
    if (users.length > 0 || apiUsers.length > 0 || teams.length > 0) {
      throw new ValidationError('This role is still assigned, so it cannot be deleted.', {
        rule: 'roleInUse',
        users: users.length,
        apiUsers: apiUsers.length,
        teams: teams.length,
      });
    }
    await this.db.updateTable('roles').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    return { success: true };
  }

  async listTeams(offset = 0, limit = 20) {
    this.requireAdmin();
    const rows = await this.db.selectFrom('teams').selectAll().where('is_deleted', '=', false).orderBy('name').limit(limit).offset(offset).execute();
    const totalRow = await this.db.selectFrom('teams').where('is_deleted', '=', false).select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();
    const list = rows.map(toTeamDto);
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getTeam(id: string) {
    this.requireAdmin();
    const row = await this.db.selectFrom('teams').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RecordNotFoundError('Team', id);
    return toTeamDto(row);
  }

  async createTeam(payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(CreateTeamSchema, payload);
    const id = data.id ?? randomUUID();
    await this.db
      .insertInto('teams')
      .values({
        id,
        name: data.name,
        user_id: JSON.stringify(data.userIds ?? []),
        role_ids: JSON.stringify(data.roleIds ?? []),
        is_private: data.isPrivate ?? false,
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    for (const userId of data.userIds ?? []) {
      await this.db.insertInto('users_teams').values({ user_id: userId, team_id: id }).onConflict((oc) => oc.doNothing()).execute();
    }
    await this.syncTeamRoles(id, data.roleIds ?? []);
    return this.getTeam(id);
  }

  async updateTeam(id: string, payload: unknown) {
    this.requireAdmin();
    const data = parseOrReject(CreateTeamSchema.partial(), payload);
    await this.db
      .updateTable('teams')
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.userIds !== undefined ? { user_id: JSON.stringify(data.userIds) } : {}),
        ...(data.roleIds !== undefined ? { role_ids: JSON.stringify(data.roleIds) } : {}),
        ...(data.isPrivate !== undefined ? { is_private: data.isPrivate } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (data.userIds !== undefined) {
      await this.db.deleteFrom('users_teams').where('team_id', '=', id).execute();
      for (const userId of data.userIds) {
        await this.db.insertInto('users_teams').values({ user_id: userId, team_id: id }).onConflict((oc) => oc.doNothing()).execute();
      }
    }
    if (data.roleIds !== undefined) {
      await this.syncTeamRoles(id, data.roleIds);
    }
    return this.getTeam(id);
  }

  /**
   * Soft-delete a team and drop its membership. Records keep whatever team references they hold —
   * team-level ACL rules then stop matching for the deleted team, which is the point of removing it —
   * so the confirmation belongs to the caller (PLAN_Phase_20 §4.7).
   */
  async deleteTeam(id: string) {
    this.requireAdmin();
    const team = await this.db.selectFrom('teams').select('id').where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!team) throw new RecordNotFoundError('Team', id);
    await this.db.updateTable('teams').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    await this.db.deleteFrom('users_teams').where('team_id', '=', id).execute();
    await this.db.deleteFrom('teams_roles').where('team_id', '=', id).execute();
    return { success: true };
  }

  async createApiUser(payload: { userName: string; assignedRoleIds?: string[] }) {
    this.requireAdmin();
    const id = randomUUID();
    await this.db
      .insertInto('api_users')
      .values({
        id,
        user_name: payload.userName,
        is_active: true,
        assigned_role_ids: JSON.stringify(payload.assignedRoleIds ?? []),
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    const key = await this.auth.issueApiKey(id);
    return { id, userName: payload.userName, keyId: key.keyId, secret: key.secret };
  }

  /**
   * The API accounts and their keys. The secret is never part of this view — it exists only in the
   * response that created it (§10: "secret shown once, never returned again").
   */
  async listApiUsers() {
    this.requireAdmin();
    const rows = await this.db.selectFrom('api_users').selectAll().orderBy('user_name').execute();
    const keys = await this.db.selectFrom('api_keys').select(['id', 'api_user_id', 'created_at', 'last_used_at', 'revoked_at']).execute();
    const list = rows.map((row) => {
      const own = keys.filter((key) => key.api_user_id === row.id);
      const active = own.filter((key) => key.revoked_at === null);
      return {
        id: row.id,
        userName: row.user_name,
        isActive: row.is_active,
        roles: Array.isArray(row.assigned_role_ids) ? (row.assigned_role_ids as string[]) : [],
        createdAt: row.created_at.toISOString(),
        activeKeys: active.length,
        lastUsedAt: active.map((key) => key.last_used_at).filter((at): at is Date => at !== null).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null,
      };
    });
    return { list, total: list.length };
  }

  /** Issue another key for an API account. The secret is returned once and stored only as a hash. */
  async issueApiKey(apiUserId: string) {
    this.requireAdmin();
    const account = await this.db.selectFrom('api_users').select(['id', 'user_name']).where('id', '=', apiUserId).executeTakeFirst();
    if (!account) throw new RecordNotFoundError('ApiUser', apiUserId);
    const key = await this.auth.issueApiKey(account.id);
    return { id: account.id, userName: account.user_name, keyId: key.keyId, secret: key.secret };
  }

  async listApiKeys(apiUserId: string) {
    this.requireAdmin();
    const rows = await this.db
      .selectFrom('api_keys')
      .select(['id', 'api_user_id', 'created_at', 'last_used_at', 'revoked_at'])
      .where('api_user_id', '=', apiUserId)
      .execute();
    return {
      list: rows.map((r) => ({
        id: r.id,
        apiUserId: r.api_user_id,
        createdAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
        revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
      })),
    };
  }

  async revokeApiKey(keyId: string) {
    this.requireAdmin();
    await this.db.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', keyId).execute();
    return { success: true };
  }
}

/**
 * The state an account would have after a pending change, expressed the way the ACL reads it.
 */
export interface AdministratorState {
  readonly isAdmin: boolean;
  readonly type: string;
  readonly roleIds: readonly string[];
  readonly isActive: boolean;
}

interface AccountRow {
  readonly id: string;
  readonly is_admin: boolean;
  readonly type: string;
  readonly assigned_role_ids: unknown;
  readonly is_active: boolean;
}

/**
 * True when `rows` would hold no active administrator after `targetId` became `after`. Kept separate
 * from the database call so the rule itself is testable without mutating the instance's real
 * administrators.
 */
export function leavesNoAdministrator(rows: readonly AccountRow[], targetId: string, after: AdministratorState): boolean {
  const administrative = (row: { is_admin: boolean; type: string; assigned_role_ids: unknown; is_active: boolean }): boolean =>
    row.is_active && (row.is_admin || row.type === 'admin' || roleListOf(row.assigned_role_ids).includes(SYS_ADMIN_ROLE));
  if (rows.some((row) => row.id !== targetId && administrative(row))) return false;
  return !administrative({ is_admin: after.isAdmin, type: after.type, assigned_role_ids: after.roleIds, is_active: after.isActive });
}

function roleListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toUserDto(row: {
  id: string;
  user_name: string;
  first_name: string | null;
  last_name: string | null;
  email_address: string | null;
  is_admin: boolean;
  is_active: boolean;
  type: string;
  assigned_role_ids: unknown;
  portal_id: string | null;
  contact_id: string | null;
  portal_role_ids: unknown;
  title: string | null;
  phone: string | null;
  created_at: Date;
  modified_at: Date;
}) {
  return {
    id: row.id,
    userName: row.user_name,
    firstName: row.first_name,
    lastName: row.last_name,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.user_name,
    emailAddress: row.email_address,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    type: row.type,
    roles: Array.isArray(row.assigned_role_ids) ? row.assigned_role_ids : [],
    /** Phase 18: portal assignment + contact relation (PLAN §37); null for internal users. */
    portalId: row.portal_id,
    contactId: row.contact_id,
    portalRoleIds: Array.isArray(row.portal_role_ids) ? row.portal_role_ids : [],
    title: row.title,
    phone: row.phone,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

function toRoleDto(row: { id: string; name: string; permissions: unknown; field_permissions: unknown; created_at: Date; modified_at: Date }) {
  return {
    id: row.id,
    name: row.name,
    permissions: row.permissions ?? {},
    fieldPermissions: row.field_permissions ?? {},
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

function toTeamDto(row: { id: string; name: string; user_id: unknown; role_ids: unknown; is_private: boolean; created_at: Date; modified_at: Date }) {
  return {
    id: row.id,
    name: row.name,
    userIds: Array.isArray(row.user_id) ? row.user_id : [],
    roleIds: Array.isArray(row.role_ids) ? row.role_ids : [],
    isPrivate: row.is_private,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}
