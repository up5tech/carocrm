import { randomUUID } from 'node:crypto';

import { RecordNotFoundError } from '@carocrm/core/errors/index.js';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { AuthService } from './auth.service.js';

export const CreateUserSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  userName: z.string().min(2).max(100),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  emailAddress: z.string().email().optional(),
  password: z.string().min(8).optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  assignedRoleIds: z.array(z.string()).optional(),
  title: z.string().max(128).optional(),
  phone: z.string().max(64).optional(),
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

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new ForbiddenException('Administrator access required.');
    }
  }

  private get db() {
    return this.database.db;
  }

  async listUsers(offset = 0, limit = 20, where?: string) {
    this.requireAdmin();
    let query = this.db.selectFrom('users').where('is_deleted', '=', false);
    if (where) {
      query = query.where('user_name', 'like', `%${where}%`);
    }
    const rows = await query
      .select(['id', 'user_name', 'first_name', 'last_name', 'email_address', 'is_admin', 'is_active', 'type', 'assigned_role_ids', 'created_at', 'modified_at'])
      .orderBy('user_name')
      .limit(limit)
      .offset(offset)
      .execute();
    const totalRow = await this.db
      .selectFrom('users')
      .where('is_deleted', '=', false)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirst();
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
    const data = CreateUserSchema.parse(payload);
    const id = data.id ?? randomUUID();
    const exists = await this.db.selectFrom('users').select('id').where('user_name', '=', data.userName).executeTakeFirst();
    if (exists) {
      throw new ConflictException(`User name "${data.userName}" is already in use.`);
    }
    await this.db
      .insertInto('users')
      .values({
        id,
        user_name: data.userName,
        first_name: data.firstName ?? null,
        last_name: data.lastName ?? null,
        email_address: data.emailAddress ?? null,
        is_admin: data.isAdmin ?? false,
        is_active: data.isActive ?? true,
        type: data.isAdmin ? 'admin' : 'regular',
        auth_method: 'password',
        password: null,
        assigned_role_ids: JSON.stringify(data.assignedRoleIds ?? []),
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
    return this.getUser(id);
  }

  async updateUser(id: string, payload: unknown) {
    this.requireAdmin();
    const data = UpdateUserSchema.parse(payload);
    const user = await this.db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
    if (!user) throw new RecordNotFoundError('User', id);
    await this.db
      .updateTable('users')
      .set({
        ...(data.firstName !== undefined ? { first_name: data.firstName } : {}),
        ...(data.lastName !== undefined ? { last_name: data.lastName } : {}),
        ...(data.emailAddress !== undefined ? { email_address: data.emailAddress } : {}),
        ...(data.isAdmin !== undefined ? { is_admin: data.isAdmin, type: data.isAdmin ? 'admin' : 'regular' } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        ...(data.assignedRoleIds !== undefined ? { assigned_role_ids: JSON.stringify(data.assignedRoleIds) } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (data.password) {
      await this.auth.setPassword(id, data.password);
    }
    return this.getUser(id);
  }

  async deleteUser(id: string) {
    this.requireAdmin();
    if (id === this.scope.userId) {
      throw new ConflictException('You cannot delete your own account.');
    }
    await this.db.updateTable('users').set({ is_deleted: true, modified_at: new Date() }).where('id', '=', id).execute();
    await this.db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
    return { success: true };
  }

  async listRoles(offset = 0, limit = 20) {
    const rows = await this.db
      .selectFrom('roles')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name')
      .limit(limit)
      .offset(offset)
      .execute();
    const totalRow = await this.db.selectFrom('roles').where('is_deleted', '=', false).select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();
    const list = rows.map(toRoleDto);
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getRole(id: string) {
    const row = await this.db.selectFrom('roles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RecordNotFoundError('Role', id);
    return toRoleDto(row);
  }

  async createRole(payload: unknown) {
    this.requireAdmin();
    const data = CreateRoleSchema.parse(payload);
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
    const data = CreateRoleSchema.partial().parse(payload);
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

  async listTeams(offset = 0, limit = 20) {
    const rows = await this.db.selectFrom('teams').selectAll().where('is_deleted', '=', false).orderBy('name').limit(limit).offset(offset).execute();
    const totalRow = await this.db.selectFrom('teams').where('is_deleted', '=', false).select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();
    const list = rows.map(toTeamDto);
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getTeam(id: string) {
    const row = await this.db.selectFrom('teams').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RecordNotFoundError('Team', id);
    return toTeamDto(row);
  }

  async createTeam(payload: unknown) {
    this.requireAdmin();
    const data = CreateTeamSchema.parse(payload);
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
    return this.getTeam(id);
  }

  async updateTeam(id: string, payload: unknown) {
    this.requireAdmin();
    const data = CreateTeamSchema.partial().parse(payload);
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
    return this.getTeam(id);
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
