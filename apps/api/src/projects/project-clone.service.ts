import { generateId } from '@carocrm/core/utils/id.js';
import type { FileStorage } from '@carocrm/files/storage/index.js';
import { Inject,Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { FILE_STORAGE_TOKEN } from '../attachment/attachment.constants.js';
import { buildStorageKey } from '../attachment/attachment.service.js';
import { OutboxService } from '../common/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { CloneProjectInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { cloneDateOffset, dayValue, shiftDay, text } from './project-domain.js';
import { ProjectRecords, type ProjectRow } from './project-records.js';
import { asDomainProjectWrite } from './project-write-context.js';

export interface CloneResult {
  projectId: string;
  name: string;
  counts: { members: number; groups: number; tasks: number; dependencies: number; collaborators: number; attachments: number };
}

/**
 * Project cloning (§4.15).
 *
 * The whole structural copy runs in one transaction: a clone that failed half-way would otherwise
 * leave a project with groups but no tasks, and every id inside it would have to be remapped —
 * groups, parents, stages, dependencies and the active group. Nothing system-level travels with the
 * copy: ids, audit rows, stream history and attachments' storage keys are all re-created or left
 * behind.
 *
 * Attachments are the one deliberate exception: their bytes are copied after the transaction
 * commits, because writing to object storage is an external effect that cannot roll back.
 */
@Injectable()
export class ProjectCloneService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
  ) {}

  async clone(sourceProjectId: string, input: CloneProjectInput): Promise<CloneResult> {
    const source = await this.access.requireProject(sourceProjectId);
    // §4.15: global create permission for projects, edit permission on the source.
    await this.acl.assertAccess('Project', 'create');
    await this.acl.assertAccess('Project', 'edit');
    if (!(await this.access.isUnrestricted('Project', 'edit'))) {
      await this.access.assertProjectAbility(sourceProjectId, 'projectEdit');
    }

    const sourceStart = dayValue(source.data['dateStart']);
    const targetStart = input.dateStart ?? sourceStart;
    const offset = cloneDateOffset(sourceStart, targetStart);
    const userId = this.access.userId;
    const name = input.name ?? `${text(source.data['name']) ?? 'Project'} (copy)`;

    const counts: CloneResult['counts'] = { members: 0, groups: 0, tasks: 0, dependencies: 0, collaborators: 0, attachments: 0 };

    const result = await runInTransaction(this.database.db, async (tx) =>
      asDomainProjectWrite(async () => {
        const created = await this.entities.create('Project', {
          name,
          ...(text(source.data['description']) !== undefined ? { description: source.data['description'] } : {}),
          ...(targetStart !== undefined ? { dateStart: targetStart } : {}),
          ...(shifted(dayValue(source.data['dateEnd']), offset) !== undefined ? { dateEnd: shifted(dayValue(source.data['dateEnd']), offset) } : {}),
          boardId: text(source.data['boardId']) ?? '',
          ...(text(source.data['categoryId']) !== undefined ? { categoryId: source.data['categoryId'] } : {}),
          dependenciesEnabled: source.data['dependenciesEnabled'] === true,
          collaboratorsEnabled: source.data['collaboratorsEnabled'] === true,
          priorityEnabled: source.data['priorityEnabled'] !== false,
          pointsEnabled: source.data['pointsEnabled'] === true,
          estimatedHoursEnabled: source.data['estimatedHoursEnabled'] === true,
          ganttEnabled: source.data['ganttEnabled'] !== false,
        });
        const projectId = text(created['id']) ?? '';
         
        if (projectId === '') throw new Error('The cloned project has no id.');

        // 1. Members first: assignees and collaborators are only valid once the membership exists.
        const memberUserIds = new Set<string>([userId]);
        if (input.copyMembers) {
          for (const member of await this.records.find('ProjectMember', { projectId: sourceProjectId })) {
            const memberId = text(member.data['userId']);
            if (memberId === undefined || memberId === userId) continue;
            await this.entities.create('ProjectMember', {
              name: 'Member',
              projectId,
              userId: memberId,
              projectRoleId: text(member.data['projectRoleId']) ?? 'projectRoleMember',
            });
            memberUserIds.add(memberId);
            counts.members += 1;
          }
        }

        // 2. Groups, keeping their order and settings.
        const groupMap = new Map<string, string>();
        for (const group of await this.records.findOrdered('ProjectGroup', { projectId: sourceProjectId })) {
          const row = await this.entities.create('ProjectGroup', {
            projectId,
            name: text(group.data['name']) ?? 'Group',
            groupType: text(group.data['groupType']) ?? 'Work',
            sortOrder: numberOrZero(group.data['sortOrder']),
            ...(text(group.data['color']) !== undefined ? { color: group.data['color'] } : {}),
            newTaskPlacement: text(group.data['newTaskPlacement']) ?? 'Bottom',
          });
          const newId = text(row['id']);
          if (newId !== undefined) groupMap.set(group.id, newId);
          counts.groups += 1;
        }

        // 3. Tasks parents before children, so a parent id exists when its subtask is written.
        const sourceTasks = await this.records.findOrdered('ProjectTask', { projectId: sourceProjectId });
        const ordered = orderParentsFirst(sourceTasks);
        const taskMap = new Map<string, string>();
        for (const task of ordered) {
          const groupId = text(task.data['groupId']);
          const mappedGroup = groupId === undefined ? undefined : groupMap.get(groupId);
          const parentId = text(task.data['parentTaskId']);
          const assignee = text(task.data['assigneeUserId']);
          const keepAssignee = input.copyTaskAssignees && assignee !== undefined && memberUserIds.has(assignee);
          const owner = input.copyTaskOwners ? text(task.data['ownerUserId']) : undefined;
          const row = await this.entities.create('ProjectTask', {
            projectId,
            ...(mappedGroup !== undefined ? { groupId: mappedGroup } : {}),
            ...(parentId !== undefined ? { parentTaskId: taskMap.get(parentId) ?? null } : {}),
            name: text(task.data['name']) ?? 'Task',
            ...(text(task.data['description']) !== undefined ? { description: task.data['description'] } : {}),
            taskType: text(task.data['taskType']) ?? 'Task',
            ...(text(task.data['stageId']) !== undefined ? { stageId: task.data['stageId'] } : {}),
            status: text(task.data['status']) ?? 'Not Started',
            ownerUserId: owner ?? userId,
            ...(keepAssignee ? { assigneeUserId: assignee } : {}),
            ...optional('dateStart', shifted(dayValue(task.data['dateStart']), offset)),
            ...optional('dateEnd', shifted(dayValue(task.data['dateEnd']), offset)),
            ...(text(task.data['priority']) !== undefined ? { priority: task.data['priority'] } : {}),
            ...(groupHasValue(task, 'points') ? { points: task.data['points'] } : {}),
            ...(groupHasValue(task, 'estimateHours') ? { estimateHours: task.data['estimateHours'] } : {}),
            sortOrder: numberOrZero(task.data['sortOrder']),
          });
          const newId = text(row['id']);
          if (newId !== undefined) taskMap.set(task.id, newId);
          counts.tasks += 1;
        }

        // 4. Dependencies, only once every cloned task id is known (§4.15).
        if (source.data['dependenciesEnabled'] === true) {
          for (const edge of await this.records.find('ProjectTaskDependency', { projectId: sourceProjectId })) {
            const successor = taskMap.get(text(edge.data['taskId']) ?? '');
            const predecessor = taskMap.get(text(edge.data['predecessorTaskId']) ?? '');
            if (successor === undefined || predecessor === undefined) continue;
            await this.entities.create('ProjectTaskDependency', {
              name: 'Dependency',
              projectId,
              taskId: successor,
              predecessorTaskId: predecessor,
              ...(text(edge.data['dependencyType']) !== undefined ? { dependencyType: edge.data['dependencyType'] } : {}),
            });
            counts.dependencies += 1;
          }
        }

        // 5. Collaborators, bounded by the memberships that actually exist now.
        if (input.copyMembers && source.data['collaboratorsEnabled'] === true) {
          for (const row of await this.records.find('ProjectTaskCollaborator', { projectId: sourceProjectId })) {
            const taskId = taskMap.get(text(row.data['taskId']) ?? '');
            const collaborator = text(row.data['userId']);
            if (taskId === undefined || collaborator === undefined || !memberUserIds.has(collaborator)) continue;
            await this.entities.create('ProjectTaskCollaborator', { name: 'Collaborator', projectId, taskId, userId: collaborator });
            counts.collaborators += 1;
          }
        }

        // 6. The active group pointer, remapped like everything else.
        const activeGroupId = text(source.data['activeGroupId']);
        const mappedActive = activeGroupId === undefined ? undefined : groupMap.get(activeGroupId);
        if (mappedActive !== undefined) {
          const row = await this.records.byId('Project', projectId);
          await this.entities.update('Project', projectId, { activeGroupId: mappedActive, ...(row !== undefined ? { version: row.version } : {}) });
        }

        counts.attachments = input.copyAttachments ? await this.countAttachments(sourceProjectId, taskMap) : 0;
        await this.outbox.insertMany(tx, [{ eventType: 'project.cloned', payload: { sourceId: sourceProjectId, projectId, counts: { ...counts } } }]);
        return { projectId, copiedTaskIds: [...taskMap.values()], copiedAttachmentParents: [sourceProjectId, ...taskMap.keys()] };
      }),
    );

    if (input.copyAttachments) {
      counts.attachments = await this.copyAttachments(result.projectId, result.copiedTaskIds, result.copiedAttachmentParents);
    }

    return { projectId: result.projectId, name, counts };
  }

  private async countAttachments(sourceProjectId: string, taskMap: Map<string, string>): Promise<number> {
    const parents = [sourceProjectId, ...taskMap.keys()];
    const rows = await sql<{ id: string }>`
      select id from attachments
      where parent_type in ('Project', 'ProjectTask') and parent_id in (${sql.join(parents)})
    `.execute(this.database.db);
    return rows.rows.length;
  }

  /**
   * Copy the bytes of each attachment to a new storage object under the cloned record. Runs after
   * the transaction, and a failed copy is rolled back by deleting the row it created (§11: no
   * external effect inside a transaction).
   */
  private async copyAttachments(projectId: string, clonedTaskIds: readonly string[], sourceParents: readonly string[]): Promise<number> {
    const rows = await sql<{ id: string; name: string; mime_type: string; size: string; storage_key: string; parent_type: string; parent_id: string; field: string | null; role: string | null }>`
      select id, name, mime_type, size::text, storage_key, parent_type, parent_id, field, role
      from attachments
      where parent_type in ('Project', 'ProjectTask') and parent_id in (${sql.join([...sourceParents])})
    `.execute(this.database.db);
    const taskIndex = new Map<string, string>();
    // The order of `copiedTaskIds` matches the order the tasks were created in, which is the order
    // of `sourceParents` after the project itself.
    let index = 0;
    for (const parent of sourceParents.slice(1)) {
      const clone = clonedTaskIds[index];
      if (clone !== undefined) taskIndex.set(parent, clone);
      index += 1;
    }

    let copied = 0;
    for (const row of rows.rows) {
      const parentId = row.parent_type === 'Project' ? projectId : taskIndex.get(row.parent_id);
      if (parentId === undefined) continue;
      const id = generateId();
      const key = buildStorageKey(row.parent_type, id, row.name);
      try {
        const body = await this.storage.get(row.storage_key);
        await this.storage.put({ key, body: Buffer.from(body), contentType: row.mime_type });
        await this.database.db
          .insertInto('attachments')
          .values({
            id,
            name: row.name,
            type: row.parent_type === 'Project' ? 'Attachment' : 'Attachment',
            size: BigInt(row.size),
            mime_type: row.mime_type,
            storage_key: key,
            checksum: null,
            parent_id: parentId,
            parent_type: row.parent_type,
            field: row.field,
            role: row.role,
            created_by_id: this.access.userId || null,
            created_at: new Date(),
          })
          .execute();
        copied += 1;
      } catch {
        await this.database.db.deleteFrom('attachments').where('id', '=', id).execute().catch(() => undefined);
      }
    }
    return copied;
  }
}

/** A shifted calendar day, or nothing at all when there is no date to move. */
function shifted(value: string | undefined, offset: number): string | undefined {
  if (value === undefined || offset === 0) return value;
  return shiftDay(value, offset) ?? undefined;
}

function optional(field: string, value: string | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [field]: value };
}

/** Parents before their children; anything unreachable keeps its original place. */
function orderParentsFirst(tasks: readonly ProjectRow[]): ProjectRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const out: ProjectRow[] = [];
  const placed = new Set<string>();
  const place = (task: ProjectRow, depth: number): void => {
    if (placed.has(task.id) || depth > 20) return;
    const parentId = text(task.data['parentTaskId']);
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (parent !== undefined) place(parent, depth + 1);
    placed.add(task.id);
    out.push(task);
  };
  for (const task of tasks) place(task, 0);
  return out;
}

function groupHasValue(task: ProjectRow, field: string): boolean {
  const value = task.data[field];
  return typeof value === 'number' && Number.isFinite(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
