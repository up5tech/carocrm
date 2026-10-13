import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { EntityCrudService } from '../entity/entity.service.js';
import type { ProjectSettingsInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { GANTT_GROUP_TYPES, text } from './project-domain.js';
import { ProjectRecords } from './project-records.js';

/** A task as any of the three views needs it: already ACL-filtered and field-masked. */
export interface TaskProjection {
  id: string;
  name: string | null;
  status: string | null;
  stageId: string | null;
  groupId: string | null;
  parentTaskId: string | null;
  taskType: string;
  assigneeUserId: string | null;
  ownerUserId: string | null;
  priority: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  points: number | null;
  estimateHours: number | null;
  sortOrder: number;
  version: number;
}

export interface PlanProjection {
  project: Record<string, unknown>;
  stages: Record<string, unknown>[];
  groups: { group: Record<string, unknown>; tasks: TaskProjection[] }[];
  truncated: boolean;
}

export interface BoardProjection {
  project: Record<string, unknown>;
  group: Record<string, unknown> | null;
  columns: { stage: Record<string, unknown>; tasks: TaskProjection[] }[];
  truncated: boolean;
}

export interface GanttProjection {
  project: Record<string, unknown>;
  groups: Record<string, unknown>[];
  tasks: TaskProjection[];
  dependencies: { id: string; taskId: string; predecessorTaskId: string; dependencyType: string | null }[];
  truncated: boolean;
}

/** One list page; the query engine clamps `maxSize` to 500, so a wide project is paged (§13). */
const PAGE = 500;
const MAX_PAGES = 4;

/**
 * Read projections for the Plan, Kanban and Gantt views (§4.12).
 *
 * Each projection is built from ordinary entity lists, so record-level ACL, the project role
 * narrowing and field masking are applied by the kernel rather than re-implemented here. A project
 * with more tasks than a projection can hold says so through `truncated` instead of lying.
 */
@Injectable()
export class ProjectViewService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
  ) {}

  async plan(projectId: string): Promise<PlanProjection> {
    const project = await this.access.requireProject(projectId);
    const [groups, tasks, stageRows] = await Promise.all([
      this.list('ProjectGroup', projectId, 'sortOrder'),
      this.tasks(projectId),
      this.list('ProjectBoardStage', text(project.data['boardId']) ?? '', 'sortOrder', 'boardId'),
    ]);
    const byGroup = new Map<string, TaskProjection[]>();
    for (const task of tasks.list) {
      const groupId = task.groupId ?? '';
      const bucket = byGroup.get(groupId);
      if (bucket) bucket.push(task);
      else byGroup.set(groupId, [task]);
    }
    return {
      project: await this.projectView(projectId),
      stages: stageRows.list,
      groups: groups.list.map((group) => ({
        group,
        tasks: sortByOrder(byGroup.get(text(group['id']) ?? '') ?? []),
      })),
      truncated: groups.truncated || tasks.truncated,
    };
  }

  /**
   * Kanban: the board's stages as columns, one selected group at a time. With no `groupId` the
   * project's active group is used, and with none at all every task of the project is shown, which
   * is the only honest reading of a project that has no groups yet.
   */
  async board(projectId: string, groupId?: string): Promise<BoardProjection> {
    const project = await this.access.requireProject(projectId);
    const activeGroupId = groupId ?? text(project.data['activeGroupId']);
    const [stages, tasks, groupRows] = await Promise.all([
      this.list('ProjectBoardStage', text(project.data['boardId']) ?? '', 'sortOrder', 'boardId'),
      this.tasks(projectId, activeGroupId),
      activeGroupId === undefined ? Promise.resolve({ list: [] as Record<string, unknown>[], truncated: false }) : this.list('ProjectGroup', projectId, 'sortOrder'),
    ]);
    const columnOf = new Map<string, TaskProjection[]>();
    for (const task of tasks.list) {
      const stageId = task.stageId ?? '';
      const bucket = columnOf.get(stageId);
      if (bucket) bucket.push(task);
      else columnOf.set(stageId, [task]);
    }
    const group = groupRows.list.find((row) => text(row['id']) === activeGroupId) ?? null;
    return {
      project: await this.projectView(projectId),
      group,
      columns: stages.list.map((stage) => ({
        stage,
        tasks: sortByOrder(columnOf.get(text(stage['id']) ?? '') ?? []),
      })),
      truncated: tasks.truncated,
    };
  }

  /**
   * Gantt: dated ranges, milestone points and the dependency edges between them. Triage and Backlog
   * groups are excluded by default (§4.5); `allGroupTypes` opts back in.
   */
  async gantt(projectId: string, allGroupTypes = false): Promise<GanttProjection> {
    const project = await this.access.requireProject(projectId);
    if (project.data['ganttEnabled'] === false) {
      throw new ValidationError('The Gantt view is disabled for this project.', { projectId });
    }
    const [groups, tasks] = await Promise.all([this.list('ProjectGroup', projectId, 'sortOrder'), this.tasks(projectId)]);
    const typeOf = new Map<string, string>();
    for (const group of groups.list) {
      const id = text(group['id']);
      if (id !== undefined) typeOf.set(id, text(group['groupType']) ?? 'Work');
    }
    const visibleGroups = groups.list.filter((group) => {
      const type = text(group['groupType']) ?? 'Work';
      return allGroupTypes || (GANTT_GROUP_TYPES as readonly string[]).includes(type);
    });
    const visibleIds = new Set(visibleGroups.map((group) => text(group['id']) ?? ''));
    const dated = tasks.list.filter((task) => task.taskType === 'Milestone' || task.dateStart !== null || task.dateEnd !== null);
    const shown = dated.filter((task) => task.groupId === null || visibleIds.has(task.groupId));
    const shownIds = new Set(shown.map((task) => task.id));

    const edges = await this.records.find('ProjectTaskDependency', { projectId });
    const dependencies = edges
      .filter((edge) => shownIds.has(text(edge.data['taskId']) ?? '') && shownIds.has(text(edge.data['predecessorTaskId']) ?? ''))
      .map((edge) => ({
        id: edge.id,
        taskId: text(edge.data['taskId']) ?? '',
        predecessorTaskId: text(edge.data['predecessorTaskId']) ?? '',
        dependencyType: text(edge.data['dependencyType']) ?? null,
      }));

    return {
      project: await this.projectView(projectId),
      groups: visibleGroups,
      tasks: sortByOrder(shown),
      dependencies,
      truncated: tasks.truncated || groups.truncated,
    };
  }

  /** Typed project settings (§4.11): authorised, stored on the record, never in frontend state. */
  async updateSettings(projectId: string, input: ProjectSettingsInput): Promise<Record<string, unknown>> {
    await this.access.requireProject(projectId);
    if (!(await this.access.isUnrestricted('Project', 'edit'))) {
      await this.access.assertProjectAbility(projectId, 'projectEdit');
    }
    const row = await this.records.byId('Project', projectId);
    if (row === undefined) throw new ValidationError(`Project "${projectId}" does not exist.`);
    await this.entities.update('Project', projectId, { ...input, version: row.version });
    return this.projectView(projectId);
  }

  async projectView(projectId: string): Promise<Record<string, unknown>> {
    return this.entities.get('Project', projectId);
  }

  /**
   * Task rows through the generic list, so the ACL predicate is the one place that decides. Ordered
   * by `sortOrder`; the caller's group or stage ordering is applied on top.
   */
  private async tasks(projectId: string, groupId?: string): Promise<{ list: TaskProjection[]; truncated: boolean }> {
    const where: Record<string, unknown>[] = [{ field: 'projectId', operator: 'equals', value: projectId }];
    if (groupId !== undefined && groupId !== '') where.push({ field: 'groupId', operator: 'equals', value: groupId });
    const pages: TaskProjection[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.entities.list('ProjectTask', { where, orderBy: 'sortOrder', order: 'asc', offset: page * PAGE, maxSize: PAGE, total: page === 0 });
      pages.push(...result.list.map(toProjection));
      if (result.list.length < PAGE) {
        truncated = false;
        break;
      }
      truncated = true;
    }
    return { list: pages, truncated };
  }

  private async list(entity: string, value: string, orderField: string, attribute = 'projectId'): Promise<{ list: Record<string, unknown>[]; truncated: boolean }> {
    if (value === '') return { list: [], truncated: false };
    const result = await this.entities.list(entity, {
      where: [{ field: attribute, operator: 'equals', value }],
      orderBy: orderField,
      order: 'asc',
      maxSize: PAGE,
      total: false,
    });
    return { list: result.list, truncated: result.list.length >= PAGE };
  }
}

function toProjection(record: Record<string, unknown>): TaskProjection {
  return {
    id: text(record['id']) ?? '',
    name: text(record['name']) ?? null,
    status: text(record['status']) ?? null,
    stageId: text(record['stageId']) ?? null,
    groupId: text(record['groupId']) ?? null,
    parentTaskId: text(record['parentTaskId']) ?? null,
    taskType: text(record['taskType']) ?? 'Task',
    assigneeUserId: text(record['assigneeUserId']) ?? null,
    ownerUserId: text(record['ownerUserId']) ?? null,
    priority: text(record['priority']) ?? null,
    dateStart: dayText(record['dateStart']),
    dateEnd: dayText(record['dateEnd']),
    points: typeof record['points'] === 'number' ? record['points'] : null,
    estimateHours: typeof record['estimateHours'] === 'number' ? record['estimateHours'] : null,
    sortOrder: typeof record['sortOrder'] === 'number' ? record['sortOrder'] : Number(record['sortOrder'] ?? 0),
    version: typeof record['version'] === 'number' ? record['version'] : Number(record['version'] ?? 1),
  };
}

function dayText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value !== '') return value.slice(0, 10);
  return null;
}

function sortByOrder(tasks: TaskProjection[]): TaskProjection[] {
  return [...tasks].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

