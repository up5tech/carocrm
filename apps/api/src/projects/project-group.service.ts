import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { GroupCreateInput, GroupDeleteInput, GroupReorderInput, GroupUpdateInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { ORDER_GAP, ranksFor, text } from './project-domain.js';
import { ProjectRecords } from './project-records.js';

/**
 * Project groups (§4.5). A group belongs to exactly one project, its order is project-scoped, and
 * deleting one never takes its tasks with it — the tasks move first or the delete is refused.
 */
@Injectable()
export class ProjectGroupService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async create(projectId: string, input: GroupCreateInput): Promise<Record<string, unknown>> {
    await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'groupManage');
    const sortOrder = input.sortOrder ?? (await this.nextRank(projectId));
    return this.entities.create('ProjectGroup', {
      projectId,
      name: input.name,
      groupType: input.groupType,
      color: input.color,
      newTaskPlacement: input.newTaskPlacement,
      sortOrder,
    });
  }

  async update(projectId: string, input: GroupUpdateInput): Promise<Record<string, unknown>> {
    const { groupId, ...data } = input;
    await this.assertGroupInProject(projectId, groupId);
    await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'groupManage');
    const row = await this.records.byId('ProjectGroup', groupId);
    if (row === undefined) throw new ValidationError(`Project group "${groupId}" does not exist.`);
    return this.entities.update('ProjectGroup', groupId, { ...data, version: row.version });
  }

  /**
   * Remove a group. With `moveToGroupId` its tasks move first, in the same transaction, so a
   * rejected destination leaves the group and its tasks exactly as they were (§4.5).
   */
  async remove(projectId: string, input: GroupDeleteInput): Promise<{ groupId: string; moved: number }> {
    await this.assertGroupInProject(projectId, input.groupId);
    await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'groupManage');

    const tasks = await this.records.find('ProjectTask', { groupId: input.groupId });
    const destination = input.moveToGroupId;
    if (tasks.length > 0 && destination === undefined) {
      throw new ValidationError('Move the tasks of this group to another group before deleting it.', { tasks: tasks.length });
    }
    if (destination !== undefined) await this.assertGroupInProject(projectId, destination);

    return runInTransaction(this.database.db, async () => {
      let moved = 0;
      if (destination !== undefined) {
        for (const task of tasks) {
          await this.entities.update('ProjectTask', task.id, { groupId: destination, version: task.version });
          moved += 1;
        }
      }
      if (await this.isActiveGroup(projectId, input.groupId)) {
        await this.entities.update('Project', projectId, { activeGroupId: null });
      }
      await this.entities.remove('ProjectGroup', input.groupId);
      return { groupId: input.groupId, moved };
    });
  }

  /** Persist an ordered set of group ids (§5.4: batch, validated, deterministic). */
  async reorder(projectId: string, input: GroupReorderInput): Promise<{ count: number }> {
    await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'groupManage');
    const groups = await this.records.find('ProjectGroup', { projectId });
    const known = new Set(groups.map((group) => group.id));
    const requested = new Set(input.groupIds);
    for (const id of input.groupIds) {
      if (!known.has(id)) throw new ValidationError(`Project group "${id}" does not belong to this project.`, { groupId: id });
    }
    // Anything not listed keeps its place behind the submitted block, so a partial drag cannot
    // silently drop a group out of the plan.
    const missing = groups.filter((group) => !requested.has(group.id)).map((group) => group.id);
    const order = [...input.groupIds, ...missing];
    const ranks = ranksFor(order);

    return runInTransaction(this.database.db, async () => {
      for (const group of groups) {
        const next = ranks.get(group.id);
        if (next === undefined) continue;
        if (numberOrUndefined(group.data['sortOrder']) === next) continue;
        await this.entities.update('ProjectGroup', group.id, { sortOrder: next, version: group.version });
      }
      return { count: ranks.size };
    });
  }

  private async assertGroupInProject(projectId: string, groupId: string): Promise<{ id: string; data: Record<string, unknown> }> {
    const group = await this.records.byId('ProjectGroup', groupId);
    if (group === undefined) throw new ValidationError(`Project group "${groupId}" does not exist.`, { groupId });
    if (text(group.data['projectId']) !== projectId) {
      // A guessed id from another project is not a not-found, it is a refusal (§9.1).
      throw new ValidationError('That group belongs to another project.', { groupId });
    }
    return group;
  }

  private async isActiveGroup(projectId: string, groupId: string): Promise<boolean> {
    const project = await this.records.byId('Project', projectId);
    return project !== undefined && text(project.data['activeGroupId']) === groupId;
  }

  private async nextRank(projectId: string): Promise<number> {
    const groups = await this.records.findOrdered('ProjectGroup', { projectId });
    const last = groups[groups.length - 1];
    const current = last === undefined ? 0 : numberOrUndefined(last.data['sortOrder']) ?? 0;
    return current + ORDER_GAP;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
