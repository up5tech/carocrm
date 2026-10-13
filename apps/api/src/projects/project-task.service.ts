import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { MilestoneInput, TaskBulkInput, TaskCreateInput, TaskMoveInput, TaskReorderInput, TaskUpdateInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectBoardService } from './project-board.service.js';
import {
  ORDER_GAP,
  type ProjectTaskStatus,
  rankBetween,
  text,
} from './project-domain.js';
import { ProjectGuardService } from './project-guard.service.js';
import { ProjectRecords, type ProjectRow } from './project-records.js';
import { asDomainProjectWrite } from './project-write-context.js';

/** Status a complete/cancel command is looking for in the project's board (§4.3). */
const TRANSITION_TARGET: Record<TaskTransitionKind, ProjectTaskStatus> = {
  complete: 'Completed',
  cancel: 'Canceled',
  start: 'Started',
};

export type TaskTransitionKind = 'complete' | 'cancel' | 'start';

/**
 * Project tasks: the commands the Plan, Board and Gantt views drive (§4.6, §4.7, §4.12).
 *
 * A "transition" is always a stage move, never a status write: the board mapping stays the single
 * source of truth for the status, and the dependency and subtask guards run on the way through
 * `ProjectGuardService`, so a command and a generic PATCH cannot diverge.
 */
@Injectable()
export class ProjectTaskService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(ProjectBoardService) private readonly boards: ProjectBoardService,
    @Inject(ProjectGuardService) private readonly guard: ProjectGuardService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async create(projectId: string, input: TaskCreateInput): Promise<Record<string, unknown>> {
    const project = await this.access.requireProject(projectId);
    await this.access.assertProjectAbility(projectId, 'taskCreate', undefined, 'ProjectTask');
    const stageId = input.stageId ?? (await this.firstStageOf(project, input.taskType ?? 'Task'));
    const ownerUserId = input.ownerUserId ?? this.access.userId;
    const group = await this.assertGroupInProject(projectId, input.groupId);
    const sortOrder = await this.placementRank(projectId, group, input.parentTaskId);

    return this.entities.create('ProjectTask', {
      projectId,
      groupId: input.groupId,
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      ...(stageId !== undefined ? { stageId } : {}),
      name: input.name,
      taskType: input.taskType ?? 'Task',
      ...(input.description !== undefined ? { description: input.description } : {}),
      ownerUserId,
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
      ...(input.dateStart !== undefined ? { dateStart: input.dateStart } : {}),
      ...(input.dateEnd !== undefined ? { dateEnd: input.dateEnd } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.points !== undefined ? { points: input.points } : {}),
      ...(input.estimateHours !== undefined ? { estimateHours: input.estimateHours } : {}),
      sortOrder,
    });
  }

  async update(taskId: string, input: TaskUpdateInput): Promise<Record<string, unknown>> {
    const task = await this.requireTask(taskId);
    const projectId = text(task.data['projectId']) ?? '';
    if (input.groupId !== undefined) await this.assertGroupInProject(projectId, input.groupId);
    if (input.parentTaskId !== undefined) await this.assertParent(task, input.parentTaskId);
    return this.entities.update('ProjectTask', taskId, { ...input, version: task.version });
  }

  /**
   * Move a task between groups and stages and/or place it between two neighbours — the one command
   * a drag-and-drop calls, validated and persisted atomically (§4.12).
   */
  async move(taskId: string, input: TaskMoveInput): Promise<Record<string, unknown>> {
    const task = await this.requireTask(taskId);
    const projectId = text(task.data['projectId']) ?? '';
    const project = await this.access.requireProject(projectId);

    const data: Record<string, unknown> = {};
    if (input.groupId !== undefined) {
      await this.assertGroupInProject(projectId, input.groupId);
      data['groupId'] = input.groupId;
    }
    if (input.parentTaskId !== undefined) {
      if (input.parentTaskId === null) data['parentTaskId'] = null;
      else {
        await this.assertParent(task, input.parentTaskId);
        data['parentTaskId'] = input.parentTaskId;
      }
    }
    if (input.stageId !== undefined) {
      await this.assertStageOfBoard(project, input.stageId);
      data['stageId'] = input.stageId;
    }

    const rank = await this.rankFor(task, {
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.parentTaskId !== undefined && input.parentTaskId !== null ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.beforeTaskId !== undefined ? { beforeTaskId: input.beforeTaskId } : {}),
      ...(input.afterTaskId !== undefined ? { afterTaskId: input.afterTaskId } : {}),
    });
    if (rank !== undefined) data['sortOrder'] = rank;

    if (Object.keys(data).length === 0) return task.data;

    return runInTransaction(this.database.db, async () => {
      const updated = await this.entities.update('ProjectTask', taskId, { ...data, ...(input.version !== undefined ? { version: input.version } : {}) });
      await this.reopenParentIfNeeded(taskId, updated);
      return updated;
    });
  }

  /** Complete / cancel / start, expressed as a stage move (§4.6 "domain commands"). */
  async transition(taskId: string, kind: TaskTransitionKind): Promise<Record<string, unknown>> {
    const task = await this.requireTask(taskId);
    const projectId = text(task.data['projectId']) ?? '';
    const project = await this.access.requireProject(projectId);
    const stageId = await this.stageForStatus(project, TRANSITION_TARGET[kind]);
    if (stageId === undefined) {
      throw new ValidationError(`The board of this project has no "${TRANSITION_TARGET[kind]}" stage.`, { projectId, status: TRANSITION_TARGET[kind] });
    }
    return this.move(taskId, { stageId });
  }

  /**
   * Bulk complete / cancel / self-assign (§4.17). Each record is authorised on its own and a
   * refusal is reported rather than aborting the selection.
   */
  async bulk(ids: readonly string[], operation: TaskBulkInput['operation']): Promise<{ succeeded: string[]; failed: { id: string; message: string }[] }> {
    const succeeded: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const userId = this.access.userId;
    for (const id of ids) {
      try {
        if (operation === 'selfAssign') {
          const task = await this.requireTask(id);
          await this.entities.update('ProjectTask', id, { assigneeUserId: userId, version: task.version });
        } else {
          await this.transition(id, operation);
        }
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : 'Rejected.' });
      }
    }
    return { succeeded, failed };
  }

  /** Persist an ordered set of task ids inside one group or one parent (§5.4). */
  async reorder(projectId: string, input: TaskReorderInput): Promise<{ count: number }> {
    const scopeField = input.parentTaskId !== undefined ? 'parentTaskId' : 'groupId';
    const scopeId = input.parentTaskId ?? input.groupId;
    if (scopeId === undefined) throw new ValidationError('Reordering needs a group or a parent task.', { field: scopeField });

    const tasks = await this.records.find('ProjectTask', { [scopeField]: scopeId });
    const known = new Map(tasks.map((task) => [task.id, task]));
    if (text(known.get(input.taskIds[0] as string)?.data['projectId']) !== projectId) {
      // A reorder addressed to one project cannot move the rows of another (§9.1).
      throw new ValidationError('Those tasks do not belong to this project.', { projectId });
    }
    for (const id of input.taskIds) {
      if (!known.has(id)) throw new ValidationError(`Task "${id}" is not in the selected ${input.parentTaskId !== undefined ? 'parent' : 'group'}.`, { taskId: id });
    }
    const ranks = rankSet(input.taskIds);

    return runInTransaction(this.database.db, async () => {
      for (const id of input.taskIds) {
        const task = known.get(id);
        if (task === undefined) continue;
        const next = ranks.get(id);
        if (next === undefined) continue;
        if (numberOrUndefined(task.data['sortOrder']) === next) continue;
        await this.entities.update('ProjectTask', id, { sortOrder: next, version: task.version });
      }
      return { count: ranks.size };
    });
  }

  /** Milestone from the Plan view group menu: one date, no duration (§4.9). */
  async createMilestone(projectId: string, input: MilestoneInput): Promise<Record<string, unknown>> {
    await this.assertGroupInProject(projectId, input.groupId);
    return this.create(projectId, {
      projectId,
      groupId: input.groupId,
      name: input.name,
      taskType: 'Milestone',
      dateStart: input.dateStart,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
    });
  }

  async addCollaborator(taskId: string, userId: string): Promise<Record<string, unknown>> {
    const task = await this.requireTask(taskId);
    const projectId = text(task.data['projectId']) ?? '';
    await this.access.assertProjectAbility(projectId, 'taskEditScope', { taskId, ...(text(task.data['ownerUserId']) !== undefined ? { ownerUserId: text(task.data['ownerUserId']) } : {}), ...(text(task.data['assigneeUserId']) !== undefined ? { assigneeUserId: text(task.data['assigneeUserId']) } : {}) }, 'ProjectTask');
    const existing = await this.records.find('ProjectTaskCollaborator', { taskId, userId });
    if (existing.length > 0) throw new ValidationError('That user already collaborates on this task.', { userId });
    return this.entities.create('ProjectTaskCollaborator', { name: 'Collaborator', taskId, userId, projectId });
  }

  async removeCollaborator(taskId: string, userId: string): Promise<{ removed: boolean }> {
    const rows = await this.records.find('ProjectTaskCollaborator', { taskId, userId });
    for (const row of rows) await this.entities.remove('ProjectTaskCollaborator', row.id);
    return { removed: rows.length > 0 };
  }

  async collaborators(taskId: string): Promise<{ id: string; userId: string }[]> {
    const rows = await this.records.find('ProjectTaskCollaborator', { taskId });
    return rows.map((row) => ({ id: row.id, userId: text(row.data['userId']) ?? '' }));
  }

  /** Dependency edges of a task, both directions, for the task detail panel. */
  async dependencies(taskId: string): Promise<{ predecessors: Record<string, unknown>[]; successors: Record<string, unknown>[] }> {
    const predecessors = await this.records.find('ProjectTaskDependency', { taskId });
    const successors = await this.records.find('ProjectTaskDependency', { predecessorTaskId: taskId });
    const shape = (row: ProjectRow, key: 'predecessorTaskId' | 'taskId'): Record<string, unknown> => ({
      id: row.id,
      dependencyType: row.data['dependencyType'] ?? null,
      [key]: row.data[key],
    });
    return {
      predecessors: predecessors.map((row) => shape(row, 'predecessorTaskId')),
      successors: successors.map((row) => shape(row, 'taskId')),
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * §4.7: a child that starts working again must not leave a completed parent claiming completion.
   * The deterministic rule is to reopen the parent to its board's `Started` stage — reported here,
   * in the same transaction as the move, rather than left for the next reader to notice.
   */
  private async reopenParentIfNeeded(taskId: string, updated: Record<string, unknown>): Promise<void> {
    const status = text(updated['status']);
    if (status !== undefined && status !== 'Completed' && status !== 'Canceled') {
      // only a reopening counts: completing a child never reopens anything
      const task = await this.records.byId('ProjectTask', taskId);
      const parentTaskId = task === undefined ? undefined : text(task.data['parentTaskId']);
      if (parentTaskId === undefined || parentTaskId === '') return;
      const parent = await this.records.byId('ProjectTask', parentTaskId);
      if (parent === undefined || text(parent.data['status']) !== 'Completed') return;
      const projectId = text(parent.data['projectId']) ?? '';
      const project = await this.access.requireProject(projectId);
      const stageId = await this.stageForStatus(project, 'Started');
      if (stageId === undefined) return;
      await this.entities.update('ProjectTask', parentTaskId, { stageId, version: parent.version });
    }
  }

  private async rankFor(task: ProjectRow, input: { groupId?: string; parentTaskId?: string; beforeTaskId?: string; afterTaskId?: string }): Promise<number | undefined> {
    if (input.beforeTaskId === undefined && input.afterTaskId === undefined) return undefined;
    const scopeId = input.parentTaskId ?? input.groupId ?? text(task.data['groupId']) ?? '';
    const scopeField = input.parentTaskId !== undefined ? 'parentTaskId' : 'groupId';
    const siblings = await this.records.findOrdered('ProjectTask', { [scopeField]: scopeId });
    const before = siblings.find((row) => row.id === input.beforeTaskId);
    const after = siblings.find((row) => row.id === input.afterTaskId);
    if (input.beforeTaskId !== undefined && before === undefined) {
      throw new ValidationError('The task to place before is not in this group.', { taskId: input.beforeTaskId });
    }
    if (input.afterTaskId !== undefined && after === undefined) {
      throw new ValidationError('The task to place after is not in this group.', { taskId: input.afterTaskId });
    }
    // `afterTaskId` is the row this one follows (the lower bound), `beforeTaskId` the row it
    // precedes (the upper bound).
    return rankBetween(numberOrUndefined(after?.data['sortOrder']), numberOrUndefined(before?.data['sortOrder']));
  }

  private async placementRank(projectId: string, group: ProjectRow, parentTaskId?: string): Promise<number> {
    if (parentTaskId !== undefined) {
      const siblings = await this.records.findOrdered('ProjectTask', { parentTaskId });
      const last = siblings[siblings.length - 1];
      return numberOrUndefined(last?.data['sortOrder']) === undefined ? ORDER_GAP : (numberOrUndefined(last?.data['sortOrder']) ?? 0) + ORDER_GAP;
    }
    void projectId;
    const placement = text(group.data['newTaskPlacement']) ?? 'Bottom';
    const siblings = await this.records.findOrdered('ProjectTask', { groupId: group.id });
    const first = siblings[0];
    const last = siblings[siblings.length - 1];
    if (placement === 'Top') return (numberOrUndefined(first?.data['sortOrder']) ?? ORDER_GAP * 2) - ORDER_GAP;
    return (numberOrUndefined(last?.data['sortOrder']) ?? 0) + ORDER_GAP;
  }

  private async assertGroupInProject(projectId: string, groupId: string): Promise<ProjectRow> {
    const group = await this.records.byId('ProjectGroup', groupId);
    if (group === undefined) throw new ValidationError(`Project group "${groupId}" does not exist.`, { groupId });
    if (text(group.data['projectId']) !== projectId) throw new ValidationError('That group belongs to another project.', { groupId });
    return group;
  }

  private async assertParent(task: ProjectRow, parentTaskId: string): Promise<void> {
    if (parentTaskId === task.id) throw new ValidationError('A task cannot be its own parent.', { parentTaskId });
    const parent = await this.records.byId('ProjectTask', parentTaskId);
    if (parent === undefined) throw new ValidationError(`Parent task "${parentTaskId}" does not exist.`, { parentTaskId });
    if (text(parent.data['projectId']) !== text(task.data['projectId'])) throw new ValidationError('A subtask cannot cross projects.', { parentTaskId });
  }

  private async assertStageOfBoard(project: ProjectRow, stageId: string): Promise<void> {
    const stage = await this.records.byId('ProjectBoardStage', stageId);
    if (stage === undefined) throw new ValidationError(`Project board stage "${stageId}" does not exist.`, { stageId });
    if (text(stage.data['boardId']) !== text(project.data['boardId'])) {
      throw new ValidationError('The selected stage belongs to another board.', { stageId });
    }
  }

  /** The first stage of the board that maps to the wanted status, in board order. */
  private async stageForStatus(project: ProjectRow, status: ProjectTaskStatus): Promise<string | undefined> {
    const boardId = text(project.data['boardId']);
    if (boardId === undefined) return undefined;
    const stages = await this.boards.stages(boardId);
    return stages.find((stage) => stage.statusValue === status)?.id;
  }

  /** A task needs a stage; a milestone is a point on the timeline and usually has none. */
  private async firstStageOf(project: ProjectRow, taskType: string): Promise<string | undefined> {
    if (taskType === 'Milestone') return undefined;
    const boardId = text(project.data['boardId']);
    if (boardId === undefined) return undefined;
    const stages = await this.boards.stages(boardId);
    return stages[0]?.id;
  }

  private async requireTask(taskId: string): Promise<ProjectRow> {
    const task = await this.records.byId('ProjectTask', taskId);
    if (task === undefined) throw new ValidationError(`Project task "${taskId}" does not exist.`, { taskId });
    return task;
  }

  /** Used by the transition engine before it writes a derived status. */
  static domainWrite<T>(work: () => Promise<T>): Promise<T> {
    return asDomainProjectWrite(work);
  }

  /** Exposed for the dependency service's cycle-aware messages and the tests. */
  blocking(taskId: string, transition: 'start' | 'complete', nextStatus: string) {
    return this.guard.blockingDependencies(taskId, transition, nextStatus);
  }
}

function rankSet(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  ids.forEach((id, index) => out.set(id, (index + 1) * ORDER_GAP));
  return out;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
