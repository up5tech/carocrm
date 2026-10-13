import { Inject, Injectable } from '@nestjs/common';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { ProjectTaskDashletInput } from './dto/project-shapes.js';
import { isoDay, text } from './project-domain.js';
import { ProjectRecords } from './project-records.js';

export interface DashletTaskRow {
  id: string;
  name: string | null;
  status: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  projectId: string | null;
  projectName: string | null;
  groupId: string | null;
  groupType: string | null;
  stageId: string | null;
  assigneeUserId: string | null;
  ownerUserId: string | null;
  relation: 'assigned' | 'owned' | 'collaboration';
}

/**
 * The Project Task dashlet (§4.16), expressed as an ordinary ACL-filtered entity list plus the
 * option set of the dashlet instance.
 *
 * Access is never decided here: `EntityCrudService` already applies the global scope and the
 * project-role narrowing, so a dashlet on a shared dashboard can only ever show what its reader
 * could open in the Projects views.
 *
 * Date semantics: a Project date is a calendar day (§4.12), so the window is `[today, today +
 * nextDays]` in the reader's own time zone, and a task is "due" when either of its dates falls in
 * it — a long-running task starting tomorrow is as relevant as one ending tomorrow.
 */
@Injectable()
export class ProjectDashletService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async run(options: ProjectTaskDashletInput): Promise<{ list: DashletTaskRow[]; count: number; truncated: boolean }> {
    const userId = this.scope.userId ?? '';
    const today = new Date();
    const from = isoDay(today);
    const to = isoDay(new Date(today.getTime() + options.nextDays * 86_400_000));
    const toExclusive = isoDay(new Date(today.getTime() + (options.nextDays + 1) * 86_400_000));

    // A `date` attribute is compared as a timestamp, so the window is bounded by whole days on the
    // SQL side (`to` is exclusive) and narrowed exactly here.
    const where: Record<string, unknown>[] = [
      {
        or: [
          { field: 'dateEnd', operator: 'greaterThanOrEqual', value: from },
          { field: 'dateStart', operator: 'greaterThanOrEqual', value: from },
        ],
      },
      {
        or: [
          { field: 'dateStart', operator: 'lessThan', value: toExclusive },
          { field: 'dateEnd', operator: 'lessThan', value: toExclusive },
        ],
      },
    ];
    if (!options.includeCompleted) {
      where.push({
        or: [
          { field: 'status', operator: 'notEquals', value: 'Completed' },
          { field: 'status', operator: 'notEquals', value: 'Canceled' },
        ],
      });
    }

    const result = await this.entities.list('ProjectTask', { where, orderBy: 'dateEnd', order: 'asc', maxSize: 200, total: true });
    const scanned = result.list;

    const groupIds = [...new Set(scanned.map((task) => text(task['groupId']) ?? '').filter((id) => id !== ''))];
    const groupTypes = new Map<string, string>();
    if (groupIds.length > 0) {
      const groups = await this.entities.list('ProjectGroup', {
        where: [{ field: 'id', operator: 'in', value: groupIds }],
        maxSize: 200,
        total: false,
      });
      for (const group of groups.list) {
        const id = text(group['id']);
        if (id !== undefined) groupTypes.set(id, text(group['groupType']) ?? 'Work');
      }
    }

    const projectIds = [...new Set(scanned.map((task) => text(task['projectId']) ?? '').filter((id) => id !== ''))];
    const projectNames = new Map<string, string>();
    if (projectIds.length > 0) {
      const projects = await this.entities.list('Project', { where: [{ field: 'id', operator: 'in', value: projectIds }], maxSize: 200, total: false });
      for (const project of projects.list) {
        const id = text(project['id']);
        if (id !== undefined) projectNames.set(id, text(project['name']) ?? id);
      }
    }

    const collaboratorTaskIds = options.includeCollaboration ? await this.collaboratorTaskIds(userId) : new Set<string>();

    const list: DashletTaskRow[] = [];
    for (const task of scanned) {
      const id = text(task['id']) ?? '';
      const windowStart = dayText(task['dateStart']);
      const windowEnd = dayText(task['dateEnd']);
      if ((windowStart === null || windowStart > to) && (windowEnd === null || windowEnd > to)) continue;
      const groupId = text(task['groupId']) ?? null;
      if (options.groupTypes.length > 0) {
        const type = groupId === null ? null : groupTypes.get(groupId) ?? null;
        if (type !== null && !options.groupTypes.includes(type as (typeof options.groupTypes)[number])) continue;
      }
      const assigned = text(task['assigneeUserId']) === userId;
      const owned = text(task['ownerUserId']) === userId;
      const shared = collaboratorTaskIds.has(id);
      if (options.excludeAssigned && assigned) continue;
      let relation: DashletTaskRow['relation'] | undefined;
      if (assigned) relation = 'assigned';
      else if (options.includeOwned && owned) relation = 'owned';
      else if (options.includeCollaboration && shared) relation = 'collaboration';
      if (relation === undefined) continue;

      list.push({
        id,
        name: text(task['name']) ?? null,
        status: text(task['status']) ?? null,
        dateStart: dayText(task['dateStart']),
        dateEnd: dayText(task['dateEnd']),
        projectId: text(task['projectId']) ?? null,
        projectName: projectNames.get(text(task['projectId']) ?? '') ?? null,
        groupId,
        groupType: groupId === null ? null : groupTypes.get(groupId) ?? null,
        stageId: text(task['stageId']) ?? null,
        assigneeUserId: text(task['assigneeUserId']) ?? null,
        ownerUserId: text(task['ownerUserId']) ?? null,
        relation,
      });
      if (list.length >= options.maxSize) break;
    }

    return { list, count: list.length, truncated: list.length >= options.maxSize || (result.total ?? 0) > scanned.length };
  }

  private async collaboratorTaskIds(userId: string): Promise<Set<string>> {
    const rows = await this.records.find('ProjectTaskCollaborator', { userId });
    return new Set(rows.map((row) => text(row.data['taskId']) ?? ''));
  }
}

function dayText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value !== '') return value.slice(0, 10);
  return null;
}
