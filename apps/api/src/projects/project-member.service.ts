import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { MemberAddInput, MemberBulkInput, MemberRemoveInput, MemberUpdateInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { text } from './project-domain.js';
import { ProjectRecords, type ProjectRow } from './project-records.js';

/** One row of the member table: the membership plus the resolved role and user names. */
export interface ProjectMemberView {
  id: string;
  projectId: string;
  userId: string;
  userName: string | null;
  projectRoleId: string | null;
  roleName: string | null;
  createdAt: string;
}

/**
 * Project members and their roles (§4.4). Membership is what a project role is read from, so this
 * is also the place that keeps the two invariants that a single-record hook cannot see on its own:
 * the last Owner cannot leave without the ownership leaving with them, and removing a member must
 * not leave tasks assigned to someone who is no longer eligible.
 */
@Injectable()
export class ProjectMemberService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async list(projectId: string): Promise<ProjectMemberView[]> {
    await this.access.requireProject(projectId);
    const result = await this.entities.list('ProjectMember', {
      where: [{ field: 'projectId', operator: 'equals', value: projectId }],
      maxSize: 200,
      total: false,
    });
    const rows = result.list;
    const userIds = [...new Set(rows.map((row) => text(row['userId']) ?? '').filter((id) => id !== ''))];
    const names = await this.userNames(userIds);
    // Project roles are configuration, so their names are read directly rather than through the
    // member's role ACL, which is about records and not about what a role is called.
    const roleIds = [...new Set(rows.map((row) => text(row['projectRoleId']) ?? '').filter((id) => id !== ''))];
    const roleNames = new Map<string, string>();
    for (const roleId of roleIds) {
      const role = await this.records.byId('ProjectRole', roleId);
      const name = role === undefined ? undefined : text(role.data['name']);
      if (name !== undefined) roleNames.set(roleId, name);
    }

    return rows.map((row) => {
      const userId = text(row['userId']) ?? '';
      const roleId = text(row['projectRoleId']);
      return {
        id: text(row['id']) ?? '',
        projectId,
        userId,
        userName: names.get(userId) ?? null,
        projectRoleId: roleId ?? null,
        roleName: roleId === undefined ? null : roleNames.get(roleId) ?? null,
        createdAt: text(row['createdAt']) ?? '',
      };
    });
  }

  async add(projectId: string, input: MemberAddInput): Promise<Record<string, unknown>> {
    await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'memberManage');
    await this.assertUserExists(input.userId);
    await this.assertRoleExists(input.projectRoleId);
    const existing = await this.records.find('ProjectMember', { projectId, userId: input.userId });
    if (existing.length > 0) throw new ValidationError('That user is already a member of this project.', { userId: input.userId });
    return this.entities.create('ProjectMember', { name: 'Member', projectId, userId: input.userId, projectRoleId: input.projectRoleId });
  }

  async changeRole(projectId: string, input: MemberUpdateInput): Promise<Record<string, unknown>> {
    const member = await this.requireMember(projectId, input.memberId);
    await this.access.assertProjectAbility(projectId, 'memberManage');
    await this.assertRoleExists(input.projectRoleId);
    if (await this.isLastOwner(member)) {
      throw new ValidationError('Transfer the project ownership before changing the role of the last owner.', { projectId });
    }
    return this.entities.update('ProjectMember', member.id, { projectRoleId: input.projectRoleId, version: member.version });
  }

  /**
   * Remove a member. Ownership transfer and the cleanup of the work they still hold happen in one
   * transaction, so the project never ends up ownerless or holding a task assigned to an ex-member.
   */
  async remove(projectId: string, input: MemberRemoveInput): Promise<{ memberId: string; clearedTasks: number }> {
    const member = await this.requireMember(projectId, input.memberId);
    await this.access.assertProjectAbility(projectId, 'memberManage');
    const userId = text(member.data['userId']) ?? '';

    const transfer = input.transferToMemberId;
    if (transfer !== undefined) {
      const target = await this.requireMember(projectId, transfer);
      if (await this.isLastOwner(member)) {
        await this.entities.update('ProjectMember', target.id, { projectRoleId: text(member.data['projectRoleId']) ?? '', version: target.version });
      }
    } else if (await this.isLastOwner(member)) {
      throw new ValidationError('Transfer the project ownership before removing the last owner.', { projectId });
    }

    return runInTransaction(this.database.db, async () => {
      // §4.6: an ex-member can no longer hold work. The deterministic policy is to clear, not to
      // guess a new owner.
      const assigned = await this.records.find('ProjectTask', { projectId, assigneeUserId: userId });
      for (const task of assigned) {
        await this.entities.update('ProjectTask', task.id, { assigneeUserId: null, version: task.version });
      }
      const collaborations = await this.records.find('ProjectTaskCollaborator', { projectId, userId });
      for (const row of collaborations) {
        await this.entities.remove('ProjectTaskCollaborator', row.id);
      }
      await this.entities.remove('ProjectMember', member.id);
      return { memberId: member.id, clearedTasks: assigned.length };
    });
  }

  /**
   * Bulk membership across projects (§4.4, §4.17). Every project is authorised on its own and a
   * refusal is reported per record instead of aborting the whole selection.
   */
  async bulk(input: MemberBulkInput): Promise<{ succeeded: string[]; failed: { projectId: string; message: string }[] }> {
    const succeeded: string[] = [];
    const failed: { projectId: string; message: string }[] = [];
    await this.assertRoleExists(input.projectRoleId);
    for (const projectId of input.projectIds) {
      try {
        await this.access.requireProject(projectId);
        await this.access.assertProjectAbility(projectId, 'memberManage');
        for (const userId of input.userIds) {
          const existing = await this.records.find('ProjectMember', { projectId, userId });
          if (input.operation === 'add') {
            if (existing[0] === undefined) await this.add(projectId, { userId, projectRoleId: input.projectRoleId });
          } else if (input.operation === 'role') {
            const member = existing[0];
            if (member !== undefined) {
              await this.entities.update('ProjectMember', member.id, { projectRoleId: input.projectRoleId, version: member.version });
            }
          } else {
            for (const member of existing) {
              await this.remove(projectId, { memberId: member.id });
            }
          }
        }
        succeeded.push(projectId);
      } catch (error) {
        failed.push({ projectId, message: error instanceof Error ? error.message : 'Rejected.' });
      }
    }
    return { succeeded, failed };
  }

  /** Users a task may be assigned to in this project (§4.6). */
  async assignableUserIds(projectId: string): Promise<string[]> {
    const members = await this.records.find('ProjectMember', { projectId });
    return members.map((member) => text(member.data['userId']) ?? '').filter((id) => id !== '');
  }

  /**
   * Display names for the member table. A `User` is an identity row, not a metadata entity, so it
   * is read from its own table — a member of a project is entitled to know who else is in it.
   */
  private async userNames(userIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (userIds.length === 0) return names;
    const rows = await this.database.db
      .selectFrom('users')
      .select(['id', 'user_name', 'first_name', 'last_name'])
      .where('id', 'in', [...userIds])
      .execute();
    for (const row of rows) {
      const full = [row.first_name, row.last_name].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
      names.set(row.id, full === '' ? row.user_name : full);
    }
    return names;
  }

  private async requireMember(projectId: string, memberId: string): Promise<ProjectRow> {
    const member = await this.records.byId('ProjectMember', memberId);
    if (member === undefined) throw new ValidationError(`Project member "${memberId}" does not exist.`, { memberId });
    if (text(member.data['projectId']) !== projectId) {
      throw new AuthorizationDeniedError('That membership belongs to another project.', { projectId });
    }
    return member;
  }

  private async isLastOwner(member: ProjectRow): Promise<boolean> {
    if (!(await this.isOwnerRole(text(member.data['projectRoleId']) ?? ''))) return false;
    const projectId = text(member.data['projectId']) ?? '';
    const members = await this.records.find('ProjectMember', { projectId });
    const others = members.filter((row) => row.id !== member.id);
    for (const other of others) {
      if (await this.isOwnerRole(text(other.data['projectRoleId']) ?? '')) return false;
    }
    return true;
  }

  /** "Owner" in the invariant sense: the role that manages members, i.e. Owner and Editor. */
  private async isOwnerRole(roleId: string): Promise<boolean> {
    const role = await this.records.byId('ProjectRole', roleId);
    return role !== undefined && text(role.data['memberManage']) === 'yes';
  }

  /** Users live in their own table (the identity module), not in `entity_records`. */
  private async assertUserExists(userId: string): Promise<void> {
    const row = await this.database.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (row === undefined) throw new ValidationError(`User "${userId}" does not exist.`, { userId });
  }

  private async assertRoleExists(roleId: string): Promise<void> {
    if ((await this.records.byId('ProjectRole', roleId)) === undefined) {
      throw new ValidationError(`Project role "${roleId}" does not exist.`, { projectRoleId: roleId });
    }
  }
}
