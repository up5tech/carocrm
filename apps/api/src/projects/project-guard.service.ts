import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { HookContext } from '@carocrm/entity-engine/types/index.js';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import {
  datesAreConsistent,
  dayValue,
  dependencyBlockFor,
  type ProjectRolePolicy,
  roleGrants,
  type StageRow,
  statusOfStage,
  subtasksAllowCompletion,
  text,
  wouldCreateCycle,
  wouldCreateHierarchyCycle,
} from './project-domain.js';
import { ProjectPolicyService, toRolePolicy } from './project-policy.service.js';
import type { ProjectRow } from './project-records.js';
import { ProjectRecords } from './project-records.js';
import { isDomainProjectWrite } from './project-write-context.js';

/**
 * Phase 19 validation engine (PLAN_Phase_19_Projects.md §10).
 *
 * Every Project invariant is enforced here, on the `beforeValidate` / `beforeDelete` phases of the
 * Entity Engine, because the same record can arrive through a domain command *or* through the
 * generic `PUT /api/v1/ProjectTask/:id`. A rule that only lived in a command would be a side door.
 *
 * The commands add what a single-record hook cannot do — multi-row transactions, dependency-aware
 * transitions, cloning — but they never relax anything here. Writes made by a domain command run in
 * `asDomainProjectWrite()`, which unlocks exactly one thing: the derived `status` field, and nothing
 * else (see `project-write-context.ts`).
 */
@Injectable()
export class ProjectGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(ProjectPolicyService) private readonly policy: ProjectPolicyService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  /** Named registrations, so `GET /api/v1/Hook` shows what this module contributes. */
  register(): void {
    this.hooks.register({ name: 'projects.validate', phase: 'beforeValidate', handler: (context) => this.validate(context) });
    this.hooks.register({ name: 'projects.deleting', phase: 'beforeDelete', handler: (context) => this.validateDelete(context) });
    // A project's creator becomes its first Owner member, otherwise a global `own` scope would
    // leave them unable to act on the record they just made.
    this.hooks.register({ name: 'projects.creatorMembership', phase: 'afterCreate', entity: 'Project', handler: (context) => this.creatorMembership(context) });
    // §5.5: a deleted project's own membership and group rows would otherwise survive it as orphans
    // nothing can address any more. Tasks are the exception — deleting a project with tasks is
    // refused above, so no work is ever taken down silently.
    this.hooks.register({ name: 'projects.cascadeContainerRows', phase: 'whenDeleted', entity: 'Project', handler: (context) => this.dropContainerRows(context) });
  }

  // -------------------------------------------------------------------------
  // create / update
  // -------------------------------------------------------------------------

  private async validate(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    const previous = context.operation === 'update' ? (context.previous ?? {}) : undefined;
    const userId = context.userId ?? this.scope.userId ?? '';

    if (context.entity === 'Project') await this.validateProject(data, previous, userId);
    if (context.entity === 'ProjectCategory') await this.validateCategory(data, context);
    if (context.entity === 'ProjectTask') await this.validateTask(data, previous, userId, context);
    if (context.entity === 'ProjectGroup') await this.validateGroup(data, previous);
    if (context.entity === 'ProjectMember') await this.validateMember(data, previous);
    if (context.entity === 'ProjectTaskCollaborator') await this.validateCollaborator(data);
    if (context.entity === 'ProjectTaskDependency') await this.validateDependency(data, context);
  }

  private async validateProject(data: Record<string, unknown>, previous: Record<string, unknown> | undefined, userId: string): Promise<void> {
    const dateStart = dayValue(data['dateStart']);
    const dateEnd = dayValue(data['dateEnd']);
    if (!datesAreConsistent(dateStart, dateEnd)) {
      throw new ValidationError('A project cannot end before it starts.', { field: 'dateEnd' });
    }
    if (previous !== undefined && text(data['boardId']) !== text(previous['boardId'])) {
      throw new ValidationError('The board of a project cannot be changed after it was created.', { field: 'boardId' });
    }
    if (previous === undefined && data['ownerUserId'] === undefined && userId !== '') {
      data['ownerUserId'] = userId;
    }
    // The board is a shared definition, so it must exist even for a project nobody may read yet.
    const boardId = text(data['boardId']);
    if (boardId !== undefined && (await this.records.byId('ProjectBoard', boardId)) === undefined) {
      throw new ValidationError(`Project board "${boardId}" does not exist.`, { field: 'boardId' });
    }
    if (previous !== undefined) await this.assertEditDimension(text(previous['id']) ?? context_record_id(data), 'projectEdit', userId, data, previous);
  }

  private async validateCategory(data: Record<string, unknown>, context: HookContext): Promise<void> {
    const id = context.operation === 'update' ? context.record?.id : undefined;
    const parentId = text(data['parentId']);
    if (id === undefined || parentId === undefined) return;
    if (parentId === id) throw new ValidationError('A project category cannot be its own parent.', { field: 'parentId' });
    // Walk up from the new parent: meeting this record again means the move would create a cycle.
    let cursor: string | undefined = parentId;
    const seen = new Set<string>();
    while (cursor !== undefined && cursor !== '') {
      if (cursor === id) throw new ValidationError('Moving this category under itself would create a loop.', { field: 'parentId' });
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const parent = await this.records.byId('ProjectCategory', cursor);
      cursor = parent === undefined ? undefined : text(parent.data['parentId']);
    }
  }

  private async validateGroup(data: Record<string, unknown>, previous: Record<string, unknown> | undefined): Promise<void> {
    const projectId = text(data['projectId']);
    if (projectId === undefined) return;
    if (previous !== undefined && text(previous['projectId']) !== projectId) {
      throw new ValidationError('A project group cannot be moved to another project.', { field: 'projectId' });
    }
    if ((await this.records.byId('Project', projectId)) === undefined) {
      throw new ValidationError(`Project "${projectId}" does not exist.`, { field: 'projectId' });
    }
  }

  private async validateMember(data: Record<string, unknown>, previous: Record<string, unknown> | undefined): Promise<void> {
    const projectId = text(data['projectId']);
    const userId = text(data['userId']);
    if (projectId === undefined || userId === undefined) return;
    if (previous !== undefined && text(previous['projectId']) !== projectId) {
      throw new ValidationError('A project membership cannot be moved to another project.', { field: 'projectId' });
    }
    const roleId = text(data['projectRoleId']);
    if (roleId !== undefined && (await this.records.byId('ProjectRole', roleId)) === undefined) {
      throw new ValidationError(`Project role "${roleId}" does not exist.`, { field: 'projectRoleId' });
    }
  }

  /**
   * Project Task is where all the cross-record rules meet: the board/stage/status mapping, the
   * project boundaries of a group, assignee eligibility, subtask hierarchy, dependencies and the
   * per-project feature settings (§4.6 §4.7 §4.8 §4.11).
   */
  private async validateTask(data: Record<string, unknown>, previous: Record<string, unknown> | undefined, userId: string, context: HookContext): Promise<void> {
    const id = context.operation === 'update' ? context.record?.id : undefined;
    const projectId = text(data['projectId']);
    if (projectId === undefined) {
      if (context.operation === 'create') throw new ValidationError('A project task needs a project.', { field: 'projectId' });
      return;
    }
    if (previous !== undefined && text(previous['projectId']) !== projectId) {
      throw new ValidationError('A project task cannot be moved to another project.', { field: 'projectId' });
    }
    const project = await this.records.byId('Project', projectId);
    if (project === undefined) throw new ValidationError(`Project "${projectId}" does not exist.`, { field: 'projectId' });

    const taskType = text(data['taskType']) ?? 'Task';
    const features = await this.policy.features(projectId);
    this.assertNotDisabled('priority', features.priorityEnabled, data, previous, ['priority']);
    this.assertNotDisabled('points', features.pointsEnabled, data, previous, ['points']);
    this.assertNotDisabled('estimated hours', features.estimatedHoursEnabled, data, previous, ['estimateHours']);

    const dateStart = dayValue(data['dateStart']);
    const dateEnd = dayValue(data['dateEnd']);
    if (!datesAreConsistent(dateStart, dateEnd)) throw new ValidationError('A task cannot end before it starts.', { field: 'dateEnd' });
    if (taskType === 'Milestone' && dateEnd !== undefined) {
      // §4.9: a milestone is one point on the timeline, never a duration.
      throw new ValidationError('A milestone has a single date; clear the end date or use a task.', { field: 'dateEnd' });
    }

    const groupId = text(data['groupId']);
    if (groupId !== undefined) {
      const group = await this.records.byId('ProjectGroup', groupId);
      if (group === undefined || text(group.data['projectId']) !== projectId) {
        throw new ValidationError('The selected group belongs to another project.', { field: 'groupId' });
      }
    }

    // Stage → status mapping is the single source of truth (§4.3).
    const stageId = text(data['stageId']);
    if (taskType === 'Task' && stageId === undefined && context.operation === 'create') {
      throw new ValidationError('A task needs a stage of the project board.', { field: 'stageId' });
    }
    let stage: (StageRow & { boardIdRef: unknown }) | undefined;
    if (stageId !== undefined) {
      const row = await this.records.byId('ProjectBoardStage', stageId);
      if (row === undefined) throw new ValidationError(`Project board stage "${stageId}" does not exist.`, { field: 'stageId' });
      stage = toStageRow(row);
      const boardId = text(project.data['boardId']);
      if (boardId === undefined || text(stage.boardIdRef) !== boardId) {
        throw new ValidationError('The selected stage belongs to another board.', { field: 'stageId' });
      }
    }
    const derived = statusOfStage(stage);
    const incomingStatus = text(data['status']);
    if (stage !== undefined && derived !== undefined) {
      if (previous !== undefined && incomingStatus !== undefined && incomingStatus !== text(previous['status']) && !isDomainProjectWrite()) {
        throw new ValidationError('Status follows the stage; move the task to another stage instead.', { field: 'status' });
      }
      data['status'] = derived;
    } else if (previous !== undefined && incomingStatus !== undefined && incomingStatus !== text(previous['status']) && !isDomainProjectWrite()) {
      throw new ValidationError('Status follows the stage; move the task to another stage instead.', { field: 'status' });
    }

    if (id !== undefined && stageId !== undefined && previous !== undefined && text(previous['stageId']) !== stageId) {
      await this.assertStageMoveAllowed(projectId, userId, data, previous, id, text(data['status']) ?? derived ?? 'Not Started');
    }

    await this.validateParent(data, projectId, id);
    await this.validateAssignee(data, previous, projectId, userId);

    if (context.operation === 'create') {
      if (!(await this.isUnrestricted('ProjectTask', 'edit'))) await this.policy.assertRole(projectId, userId, 'taskCreate');
    } else {
      await this.assertEditDimension(projectId, 'taskEditScope', userId, data, previous ?? {}, id);
    }
  }

  private async validateParent(data: Record<string, unknown>, projectId: string, id: string | undefined): Promise<void> {
    const parentTaskId = text(data['parentTaskId']);
    if (parentTaskId === undefined) return;
    if (id !== undefined && parentTaskId === id) throw new ValidationError('A task cannot be its own parent.', { field: 'parentTaskId' });
    const parent = await this.records.byId('ProjectTask', parentTaskId);
    if (parent === undefined) throw new ValidationError(`Parent task "${parentTaskId}" does not exist.`, { field: 'parentTaskId' });
    if (text(parent.data['projectId']) !== projectId) throw new ValidationError('A subtask cannot cross projects.', { field: 'parentTaskId' });
    if (text(parent.data['taskType']) === 'Milestone') throw new ValidationError('A milestone cannot have subtasks.', { field: 'parentTaskId' });
    if (id !== undefined) {
      const children = await this.childMap(projectId);
      if (wouldCreateHierarchyCycle(children, id, parentTaskId)) {
        throw new ValidationError('Moving this task under that parent would create a loop.', { field: 'parentTaskId' });
      }
    }
  }

  private async validateAssignee(data: Record<string, unknown>, previous: Record<string, unknown> | undefined, projectId: string, userId: string): Promise<void> {
    const assignee = text(data['assigneeUserId']);
    if (assignee === undefined) return;
    if (previous !== undefined && text(previous['assigneeUserId']) === assignee) return;
    const membership = await this.policy.membership(projectId, assignee);
    if (membership === undefined) {
      throw new ValidationError('The assignee must be a member of the project.', { field: 'assigneeUserId', assigneeUserId: assignee });
    }
    if (assignee !== userId && !roleGrants(membership.role, 'assignmentScope', { userId: assignee })) {
      throw new AuthorizationDeniedError('This project role may only assign tasks to itself.', { projectId, field: 'assigneeUserId' });
    }
  }

  /**
   * The stage move a task is about to make is a transition: dependencies and open subtasks guard it
   * exactly the way the explicit complete/cancel commands do (§4.8, §12.5).
   */
  private async assertStageMoveAllowed(projectId: string, userId: string, data: Record<string, unknown>, previous: Record<string, unknown>, id: string, nextStatus: string): Promise<void> {
    const membership = await this.policy.membership(projectId, userId);
    const unrestricted = await this.isUnrestricted('ProjectTask', 'edit');
    if (!unrestricted) {
      if (membership === undefined) throw new AuthorizationDeniedError('Only project members may move this task.', { projectId });
      const allowed = roleGrants(membership.role, 'stageMoveScope', {
        userId,
        ...(text(previous['ownerUserId']) !== undefined ? { ownerUserId: text(previous['ownerUserId']) } : {}),
        ...(text(previous['assigneeUserId']) !== undefined ? { assigneeUserId: text(previous['assigneeUserId']) } : {}),
        isCollaborator: await this.policy.isCollaborator(id, userId),
      });
      if (!allowed) throw new AuthorizationDeniedError('The project role does not allow moving this task.', { projectId });
    }

    const previousStatus = text(previous['status']) ?? 'Not Started';
    const transition = nextStatus === 'Completed' ? 'complete' : nextStatus === 'Started' && previousStatus !== 'Started' ? 'start' : undefined;
    if (transition === undefined) return;

    if (transition === 'complete') {
      const childStatuses = (await this.records.find('ProjectTask', { parentTaskId: id })).map((child) => text(child.data['status']) ?? 'Not Started');
      if (!subtasksAllowCompletion(childStatuses)) {
        throw new ValidationError('Complete or cancel the subtasks before completing this task.', { field: 'subtasks', count: childStatuses.length });
      }
      const parentTaskId = text(data['parentTaskId']);
      if (parentTaskId !== undefined) {
        const parent = await this.records.byId('ProjectTask', parentTaskId);
        if (parent !== undefined && text(parent.data['status']) === 'Completed') {
          throw new ValidationError('The parent task is completed; reopen it before changing this subtask.', { field: 'parentTaskId' });
        }
      }
    }

    const features = await this.policy.features(projectId);
    if (!features.dependenciesEnabled) return;
    const blockers = await this.blockingDependencies(id, transition, nextStatus);
    if (blockers.length > 0) {
      const first = blockers[0] as { dependencyType: string; reason: string; predecessorId: string };
      // The blocking rule is named, the hidden task's content is not (§7.3).
      throw new ValidationError(
        `The task cannot be ${transition === 'complete' ? 'completed' : 'started'}: ${first.dependencyType} — ${first.reason}`,
        { dependencyType: first.dependencyType, dependencyId: first.predecessorId },
      );
    }
  }

  private async validateCollaborator(data: Record<string, unknown>): Promise<void> {
    const taskId = text(data['taskId']);
    const userId = text(data['userId']);
    if (taskId === undefined || userId === undefined) return;
    const task = await this.records.byId('ProjectTask', taskId);
    if (task === undefined) throw new ValidationError(`Project task "${taskId}" does not exist.`, { field: 'taskId' });
    const projectId = text(task.data['projectId']) ?? '';
    const features = await this.policy.features(projectId);
    if (!features.collaboratorsEnabled) throw new ValidationError('Task collaborators are disabled for this project.', { field: 'taskId' });
    // §4.10: collaborators are bounded by project membership in this implementation.
    if (!(await this.policy.isMember(projectId, userId))) {
      throw new ValidationError('A collaborator must be a member of the project.', { field: 'userId' });
    }
    if (text(data['projectId']) !== projectId) data['projectId'] = projectId;
  }

  private async validateDependency(data: Record<string, unknown>, context: HookContext): Promise<void> {
    const successorId = text(data['taskId']);
    const predecessorId = text(data['predecessorTaskId']);
    if (successorId === undefined || predecessorId === undefined) return;
    if (successorId === predecessorId) throw new ValidationError('A task cannot depend on itself.', { field: 'predecessorTaskId' });

    const successor = await this.records.byId('ProjectTask', successorId);
    if (successor === undefined) throw new ValidationError(`Project task "${successorId}" does not exist.`, { field: 'taskId' });
    const predecessor = await this.records.byId('ProjectTask', predecessorId);
    const projectId = text(successor.data['projectId']) ?? '';
    const features = await this.policy.features(projectId);
    if (!features.dependenciesEnabled) throw new ValidationError('Task dependencies are disabled for this project.', { field: 'taskId' });

    if (predecessor !== undefined && text(predecessor.data['projectId']) !== projectId) {
      throw new ValidationError('A dependency can only link tasks of the same project.', { field: 'predecessorTaskId' });
    }
    if (text(data['projectId']) !== projectId) data['projectId'] = projectId;
    if (predecessor !== undefined && text(predecessor.data['taskType']) === 'Milestone') {
      throw new ValidationError('A milestone cannot be a predecessor.', { field: 'predecessorTaskId' });
    }

    const edges = (await this.records.find('ProjectTaskDependency', { projectId })).flatMap((row) => {
      const from = text(row.data['predecessorTaskId']);
      const to = text(row.data['taskId']);
      return from !== undefined && to !== undefined ? [{ from, to }] : [];
    });
    const record = context.record;
    if (context.operation === 'update' && record !== undefined) {
      const previousFrom = text(context.previous?.['predecessorTaskId']) ?? '';
      const existing = edges.findIndex((edge) => edge.from === previousFrom && edge.to === record.id);
      if (existing >= 0) edges.splice(existing, 1);
    }
    if (wouldCreateCycle(edges, { from: predecessorId, to: successorId })) {
      throw new ValidationError('That dependency would create a cycle.', { field: 'predecessorTaskId' });
    }
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  private async validateDelete(context: HookContext): Promise<void> {
    const record = context.record;
    if (record === undefined) return;
    const id = record.id;
    const data = record.data;

    if (context.entity === 'ProjectCategory') {
      const children = await this.records.find('ProjectCategory', { parentId: id });
      const projects = await this.records.find('Project', { categoryId: id });
      if (children.length > 0 || projects.length > 0) {
        throw new ValidationError('Move the child categories and projects before deleting this category.', { children: children.length, projects: projects.length });
      }
    }
    if (context.entity === 'ProjectBoard') {
      const projects = await this.records.find('Project', { boardId: id });
      if (projects.length > 0) throw new ValidationError('Tasks of existing projects still use this board.', { projects: projects.length });
    }
    if (context.entity === 'ProjectBoardStage') {
      const tasks = await this.records.find('ProjectTask', { stageId: id });
      if (tasks.length > 0) throw new ValidationError('Tasks still sit in this stage; move them first.', { tasks: tasks.length });
    }
    if (context.entity === 'ProjectRole') {
      if (data['isSystem'] === true) throw new ValidationError('A built-in project role cannot be deleted.', { id });
      const members = await this.records.find('ProjectMember', { projectRoleId: id });
      if (members.length > 0) throw new ValidationError('Project members still use this role.', { members: members.length });
    }
    if (context.entity === 'ProjectGroup') {
      const tasks = await this.records.find('ProjectTask', { groupId: id });
      if (tasks.length > 0) {
        // §4.5: never cascade-delete a group's tasks.
        throw new ValidationError('Move the tasks of this group to another group before deleting it.', { tasks: tasks.length });
      }
      const project = text(data['projectId']);
      if (project !== undefined) {
        const row = await this.records.byId('Project', project);
        if (row !== undefined && text(row.data['activeGroupId']) === id) {
          throw new ValidationError('This is the active group of the project; select another one first.', { field: 'activeGroupId' });
        }
      }
    }
    if (context.entity === 'ProjectMember') {
      await this.assertNotLastOwner(id, data);
    }
    if (context.entity === 'ProjectTask') {
      const children = await this.records.find('ProjectTask', { parentTaskId: id });
      if (children.length > 0) throw new ValidationError('Delete or move the subtasks first.', { subtasks: children.length });
    }
    if (context.entity === 'Project') {
      const tasks = await this.records.find('ProjectTask', { projectId: id });
      if (tasks.length > 0) throw new ValidationError('A project with tasks cannot be deleted; delete its tasks first.', { tasks: tasks.length });
    }
  }

  /** §4.4: the last Owner cannot disappear without the ownership moving with them. */
  async assertNotLastOwner(memberId: string, data: Record<string, unknown>): Promise<void> {
    const projectId = text(data['projectId']);
    const roleId = text(data['projectRoleId']);
    if (projectId === undefined || roleId === undefined) return;
    const role = await this.records.byId('ProjectRole', roleId);
    if (role === undefined || text(role.data['memberManage']) !== 'yes') return;
    const members = await this.records.find('ProjectMember', { projectId });
    const owners = members.filter((member) => member.id !== memberId);
    let remaining = 0;
    for (const member of owners) {
      const memberRole = await this.records.byId('ProjectRole', text(member.data['projectRoleId']) ?? '');
      if (memberRole !== undefined && text(memberRole.data['memberManage']) === 'yes') remaining += 1;
    }
    if (remaining === 0) throw new ValidationError('Transfer the project ownership before removing the last owner.', { projectId });
  }

  private async creatorMembership(context: HookContext): Promise<void> {
    const record = context.record;
    const userId = context.userId ?? this.scope.userId;
    if (record === undefined || userId === undefined || userId === '') return;
    const already = await this.policy.membership(record.id, userId);
    if (already !== undefined) return;
    // The ambient transaction of a command (a clone, for instance) owns this write too.
    const db = currentTx() ?? this.database.db;
    const now = new Date();
    await sql`
      insert into entity_records (id, entity_type, name, attrs, created_at, modified_at, version)
      values (${generateId()}, 'ProjectMember', ${'Member'}, ${JSON.stringify({ projectId: record.id, userId, projectRoleId: 'projectRoleOwner' })}, ${now}, ${now}, ${1})
      on conflict (id) do nothing
    `.execute(db);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Soft-delete the membership and group rows of a project that was just deleted. */
  private async dropContainerRows(context: HookContext): Promise<void> {
    const record = context.record;
    if (record === undefined) return;
    const db = currentTx() ?? this.database.db;
    await sql`
      update entity_records
      set deleted_at = now(), modified_at = now()
      where entity_type in ('ProjectMember', 'ProjectGroup')
        and deleted_at is null
        and (attrs ->> 'projectId') = ${record.id}
    `.execute(db);
  }

  /** Blocking dependency edges of a task, evaluated for the transition it is about to make. */
  async blockingDependencies(taskId: string, transition: 'start' | 'complete', nextStatus: string): Promise<{ dependencyType: string; reason: string; predecessorId: string }[]> {
    const edges = await this.records.find('ProjectTaskDependency', { taskId });
    const out: { dependencyType: string; reason: string; predecessorId: string }[] = [];
    for (const edge of edges) {
      const predecessorId = text(edge.data['predecessorTaskId']);
      if (predecessorId === undefined) continue;
      const predecessor = await this.records.byId('ProjectTask', predecessorId);
      if (predecessor === undefined) continue;
      const block = dependencyBlockFor({
        dependencyType: text(edge.data['dependencyType']),
        transition,
        predecessor: { status: text(predecessor.data['status']) ?? 'Not Started' },
        successor: { status: nextStatus },
      });
      if (block !== undefined) out.push({ dependencyType: block.dependencyType, reason: block.reason, predecessorId });
    }
    return out;
  }

  private async childMap(projectId: string): Promise<Map<string, string[]>> {
    const tasks = await this.records.find('ProjectTask', { projectId });
    const map = new Map<string, string[]>();
    for (const task of tasks) {
      const parent = text(task.data['parentTaskId']);
      if (parent === undefined) continue;
      const list = map.get(parent);
      if (list) list.push(task.id);
      else map.set(parent, [task.id]);
    }
    return map;
  }

  /** A project feature that is off cannot be written, but its stored values are left alone (§4.11). */
  private assertNotDisabled(label: string, enabled: boolean, data: Record<string, unknown>, previous: Record<string, unknown> | undefined, fields: readonly string[]): void {
    if (enabled) return;
    for (const field of fields) {
      const value = data[field];
      if (value === undefined) continue;
      const before = previous?.[field];
      if (before !== undefined && before === value) continue;
      if (before === undefined && field === 'priority' && value === 'Normal') continue;
      throw new ValidationError(`${label} is disabled for this project.`, { field, feature: label });
    }
  }

  /**
   * Edit authority for a record that actually changed. `data` on the update path is the merged
   * record, so the comparison against `previous` is what tells a real edit from a no-op PATCH.
   */
  private async assertEditDimension(
    projectId: string,
    dimension: keyof ProjectRolePolicy,
    userId: string,
    data: Record<string, unknown>,
    previous: Record<string, unknown>,
    taskId?: string,
  ): Promise<void> {
    if (await this.isUnrestricted(dimension === 'projectEdit' ? 'Project' : 'ProjectTask', 'edit')) return;
    if (!hasChanged(data, previous)) return;
    const membership = await this.policy.membership(projectId, userId);
    if (membership === undefined) throw new AuthorizationDeniedError('Only project members may edit this record.', { projectId });
    const allowed = roleGrants(membership.role, dimension, {
      userId,
      ...(text(data['ownerUserId']) !== undefined ? { ownerUserId: text(data['ownerUserId']) } : {}),
      ...(text(previous['assigneeUserId']) !== undefined ? { assigneeUserId: text(previous['assigneeUserId']) } : {}),
      isCollaborator: taskId === undefined ? false : await this.policy.isCollaborator(taskId, userId),
    });
    if (!allowed) throw new AuthorizationDeniedError(`The project role does not allow "${dimension}".`, { projectId, dimension });
  }

  /**
   * A global level of `all` / `yes` is the documented "global policy explicitly permits it"
   * (PLAN_Phase_19_Projects.md §9.1) — project roles then stop narrowing that principal.
   */
  private async isUnrestricted(entity: string, action: 'read' | 'edit' | 'delete'): Promise<boolean> {
    if (this.scope.isAdmin) return true;
    const level = await this.acl.canUser(entity, action);
    return level === 'all' || level === 'yes';
  }
}

/** True when the merged record differs from what is stored, ignoring physical bookkeeping keys. */
function hasChanged(data: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  const skipped = new Set(['id', 'createdAt', 'modifiedAt', 'modifiedById', 'createdById', 'deletedAt', 'version', 'entityType', 'name', 'isOverdue']);
  for (const [key, value] of Object.entries(data)) {
    if (skipped.has(key)) continue;
    if (JSON.stringify(value ?? null) !== JSON.stringify(previous[key] ?? null)) return true;
  }
  return false;
}

/** A project update arrives with its id in `data`; a create has none yet. */
function context_record_id(data: Record<string, unknown>): string {
  return text(data['id']) ?? '';
}

function toStageRow(row: ProjectRow): StageRow & { boardIdRef: unknown } {
  return {
    id: row.id,
    key: text(row.data['key']) ?? '',
    name: text(row.data['name']) ?? row.id,
    statusValue: text(row.data['statusValue']) ?? 'Not Started',
    sortOrder: typeof row.data['sortOrder'] === 'number' ? row.data['sortOrder'] : Number(row.data['sortOrder'] ?? 0),
    boardIdRef: row.data['boardId'],
  };
}

/** Exported so the command services reuse the same role resolution shape. */
export { toRolePolicy };
