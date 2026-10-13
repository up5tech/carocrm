import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { AclRecordLike } from '../acl/acl-api.service.js';
import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import { DEFAULT_PROJECT_BOARD_ID, type StageRow,statusOfStage, text, validateStageSet } from './project-domain.js';
import { ProjectRecords } from './project-records.js';
import { asDomainProjectWrite } from './project-write-context.js';

/**
 * Project boards and their stages (§4.3). A board is shared configuration, so its write path is
 * administration-only through the global ACL; the stage list is edited as one document because a
 * half-saved mapping would leave tasks without a derivable status.
 */
@Injectable()
export class ProjectBoardService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async stages(boardId: string): Promise<StageRow[]> {
    const rows = await this.records.findOrdered('ProjectBoardStage', { boardId });
    return rows.map(toStageRow);
  }

  async stage(stageId: string): Promise<StageRow | undefined> {
    const row = await this.records.byId('ProjectBoardStage', stageId);
    return row === undefined ? undefined : toStageRow(row);
  }

  /**
   * The board a project gets when the caller does not name one. Deterministic: the row seeded by
   * `database/seed.ts` if it is still there, otherwise the board flagged default, otherwise the
   * first board by id — never "whichever row the planner happened to return".
   */
  async defaultBoardId(): Promise<string> {
    const seeded = await this.records.byId('ProjectBoard', DEFAULT_PROJECT_BOARD_ID);
    if (seeded !== undefined) return DEFAULT_PROJECT_BOARD_ID;
    const boards = await this.records.find('ProjectBoard', {});
    if (boards.length === 0) throw new ValidationError('No project board exists; ask an administrator to create one.');
    const byId = [...boards].sort((a, b) => a.id.localeCompare(b.id));
    const flagged = byId.find((board) => board.data['isDefault'] === true);
    return (flagged ?? byId[0] as { id: string }).id;
  }

  /**
   * Replace a board's stage list in one transaction (§4.3): rows are matched by id, created when
   * new, and deleted only when nothing references them any more. Statuses of tasks sitting in a
   * changed stage are re-derived in the same transaction, so a rename that also remaps the status
   * cannot leave a task claiming a status its stage no longer has.
   */
  async saveStages(boardId: string, stages: readonly { id?: string; key: string; name: string; statusValue: string; sortOrder: number }[]): Promise<StageRow[]> {
    const board = await this.records.byId('ProjectBoard', boardId);
    if (board === undefined) throw new NotFoundError(`Project board "${boardId}" does not exist.`);
    await this.acl.assertAccess('ProjectBoard', 'edit');
    if (!(await this.acl.canAccessRecord('ProjectBoard', 'edit', boardRecord(board)))) {
      throw new AuthorizationDeniedError('You cannot edit this project board.', { boardId });
    }

    const issues = validateStageSet(stages);
    if (issues.length > 0) throw new ValidationError('The stage list is invalid.', { issues });

    const existing = await this.records.find('ProjectBoardStage', { boardId });
    const existingById = new Map(existing.map((row) => [row.id, row]));
    const keep = new Set<string>();

    // One transaction, and a domain write: the derived `status` of the tasks under a remapped
    // stage has to move with the mapping (§4.3).
    return runInTransaction(this.database.db, () => asDomainProjectWrite(async () => {
      for (const stage of stages) {
        const status = statusOfStage({ id: stage.id ?? '', key: stage.key, name: stage.name, statusValue: stage.statusValue, sortOrder: stage.sortOrder });
        if (status === undefined) throw new ValidationError(`Stage "${stage.key}" maps to an unknown status.`);
        if (stage.id !== undefined) {
          const row = existingById.get(stage.id);
          if (row === undefined || text(row.data['boardId']) !== boardId) {
            throw new ValidationError(`Stage "${stage.id}" does not belong to this board.`, { stageId: stage.id });
          }
          keep.add(stage.id);
          const changedStatus = text(row.data['statusValue']) !== stage.statusValue;
          await this.entities.update('ProjectBoardStage', stage.id, {
            name: stage.name,
            key: stage.key,
            statusValue: stage.statusValue,
            sortOrder: stage.sortOrder,
            version: row.version,
          });
          if (changedStatus) await this.restatusTasksOfStage(stage.id, stage.statusValue);
          continue;
        }
        const created = await this.entities.create('ProjectBoardStage', {
          boardId,
          key: stage.key,
          name: stage.name,
          statusValue: stage.statusValue,
          sortOrder: stage.sortOrder,
        });
        const newId = text(created['id']);
        if (newId !== undefined) keep.add(newId);
      }

      for (const row of existing) {
        if (keep.has(row.id)) continue;
        const tasks = await this.records.find('ProjectTask', { stageId: row.id });
        if (tasks.length > 0) {
          // §4.3: an in-use stage is never silently removed from under its tasks.
          throw new ValidationError(`Stage "${text(row.data['key']) ?? row.id}" still has tasks; move them first.`, { stageId: row.id, tasks: tasks.length });
        }
        await this.entities.remove('ProjectBoardStage', row.id);
      }

      return this.stages(boardId);
    }));
  }

  /** Re-derive the status of every task in a stage after its mapping changed (§4.3). */
  private async restatusTasksOfStage(stageId: string, statusValue: string): Promise<void> {
    const tasks = await this.records.find('ProjectTask', { stageId });
    for (const task of tasks) {
      if (text(task.data['status']) === statusValue) continue;
      await this.entities.update('ProjectTask', task.id, { status: statusValue, version: task.version });
    }
  }
}

function toStageRow(row: { id: string; data: Record<string, unknown> }): StageRow {
  const sort = row.data['sortOrder'];
  return {
    id: row.id,
    key: text(row.data['key']) ?? '',
    name: text(row.data['name']) ?? row.id,
    statusValue: text(row.data['statusValue']) ?? 'Not Started',
    sortOrder: typeof sort === 'number' ? sort : Number(sort ?? 0),
  };
}

function boardRecord(row: { id: string; data: Record<string, unknown> }): AclRecordLike {
  const teams = Array.isArray(row.data['teams']) ? (row.data['teams'] as string[]) : undefined;
  return {
    id: row.id,
    data: row.data,
    ...(text(row.data['assignedUserId']) !== undefined ? { assignedUserId: text(row.data['assignedUserId']) } : {}),
    ...(text(row.data['createdById']) !== undefined ? { createdById: text(row.data['createdById']) } : {}),
    ...(teams !== undefined ? { teams } : {}),
  };
}
