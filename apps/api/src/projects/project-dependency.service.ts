import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { EntityCrudService } from '../entity/entity.service.js';
import type { DependencyCreateInput, DependencyRemoveInput, DependencyUpdateInput } from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { text } from './project-domain.js';
import { ProjectRecords, type ProjectRow } from './project-records.js';

/**
 * Task dependencies (§4.8). Storage and graph validation live in `ProjectGuardService`, so the
 * generic entity API is guarded identically; this service is the command surface: who may touch the
 * edge and which project's settings apply.
 *
 * Direction is explicit and never inferred: `taskId` is the successor, `predecessorTaskId` the task
 * it waits for.
 */
@Injectable()
export class ProjectDependencyService {
  constructor(
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
  ) {}

  async create(taskId: string, input: DependencyCreateInput): Promise<Record<string, unknown>> {
    const task = await this.requireTask(taskId);
    const projectId = projectOf(task);
    await this.assertDependenciesEnabled(projectId);
    await this.assertTaskEdit(task);
    return this.entities.create('ProjectTaskDependency', {
      name: 'Dependency',
      taskId,
      predecessorTaskId: input.predecessorTaskId,
      projectId,
      ...(input.dependencyType !== undefined && input.dependencyType !== null ? { dependencyType: input.dependencyType } : {}),
    });
  }

  /** Changing the type re-runs every guard, because a different type blocks a different transition. */
  async changeType(taskId: string, input: DependencyUpdateInput): Promise<Record<string, unknown>> {
    const row = await this.requireEdge(taskId, input.dependencyId);
    if (row === undefined) throw new ValidationError(`Dependency "${input.dependencyId}" does not exist.`, { dependencyId: input.dependencyId });
    const task = await this.requireTask(text(row.data['taskId']) ?? '');
    await this.assertDependenciesEnabled(projectOf(task));
    await this.assertTaskEdit(task);
    return this.entities.update('ProjectTaskDependency', row.id, { dependencyType: input.dependencyType, version: row.version });
  }

  async remove(taskId: string, input: DependencyRemoveInput): Promise<{ removed: boolean }> {
    const row = await this.requireEdge(taskId, input.dependencyId, true);
    if (row === undefined) return { removed: false };
    const task = await this.requireTask(text(row.data['taskId']) ?? '');
    await this.assertDependenciesEnabled(projectOf(task));
    await this.assertTaskEdit(task);
    await this.entities.remove('ProjectTaskDependency', row.id);
    return { removed: true };
  }

  /** Edges of a whole project, for the Gantt projection. */
  async edgesOfProject(projectId: string): Promise<ProjectRow[]> {
    return this.records.find('ProjectTaskDependency', { projectId });
  }

  /**
   * The edge must belong to the task the request is addressed to: a guessed dependency id of another
   * task cannot be used to mutate it (§9.1).
   */
  private async requireEdge(taskId: string, dependencyId: string, allowMissing = false): Promise<ProjectRow | undefined> {
    const row = await this.records.byId('ProjectTaskDependency', dependencyId);
    if (row === undefined) {
      if (allowMissing) return undefined;
      throw new ValidationError(`Dependency "${dependencyId}" does not exist.`, { dependencyId });
    }
    if (text(row.data['taskId']) !== taskId) {
      throw new ValidationError('That dependency belongs to another task.', { dependencyId, taskId });
    }
    return row;
  }

  private async assertTaskEdit(task: ProjectRow): Promise<void> {
    const taskAccess = {
      taskId: task.id,
      ...(text(task.data['ownerUserId']) !== undefined ? { ownerUserId: text(task.data['ownerUserId']) } : {}),
      ...(text(task.data['assigneeUserId']) !== undefined ? { assigneeUserId: text(task.data['assigneeUserId']) } : {}),
    };
    await this.access.assertProjectAbility(projectOf(task), 'taskEditScope', taskAccess, 'ProjectTask');
  }

  private async assertDependenciesEnabled(projectId: string): Promise<void> {
    const project = await this.access.requireProject(projectId);
    if (project.data['dependenciesEnabled'] !== true) {
      throw new ValidationError('Task dependencies are disabled for this project.', { projectId });
    }
  }

  private async requireTask(taskId: string): Promise<ProjectRow> {
    const task = await this.records.byId('ProjectTask', taskId);
    if (task === undefined) throw new ValidationError(`Project task "${taskId}" does not exist.`, { taskId });
    return task;
  }
}

function projectOf(row: ProjectRow): string {
  return text(row.data['projectId']) ?? '';
}
