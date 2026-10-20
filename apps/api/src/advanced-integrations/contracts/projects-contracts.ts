import { Inject, Injectable, Optional } from '@nestjs/common';

import { ProjectTaskService } from '../../projects/project-task.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `Projects` contract
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * `Projects` owns the delivery board: the projects, their stages, their tasks and the rules about
 * who may change them. A connector may report that work happened; it may not rearrange the board.
 *
 * The contract therefore creates a **task in a project the connector already knows**, and it goes
 * through the owner's own service, which enforces the project access rules, the stage rules and
 * the task numbering. The connector does not write a `ProjectTask` row.
 *
 * The contract is optional: a deployment without `Projects` publishes none of it.
 */

/** The input of the task contract. */
export interface ProjectsTaskCreateInput {
  /** The project the task belongs to. The connector resolves it; the owner validates it. */
  readonly projectId: string;
  /** The task's name. */
  readonly name: string;
  readonly description?: string | undefined;
  readonly taskType?: 'Task' | 'Milestone' | undefined;
  readonly dateStart?: string | undefined;
  readonly dateEnd?: string | undefined;
  readonly priority?: string | undefined;
}

export interface ProjectsTaskCreateOutput {
  readonly id: string;
  readonly name: string;
}

@Injectable()
export class ProjectsIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(ProjectTaskService) private readonly tasks: ProjectTaskService | null,
  ) {
    if (this.tasks !== null) {
      this.registry.register<ProjectsTaskCreateInput, ProjectsTaskCreateOutput>({
        contractKey: 'projects.task.create',
        contractVersion: 1,
        owningModule: 'Projects',
        ownership:
          'The delivery board, the stages and the project access rules. A connector may report work; it may not move a card or assign a task.',
        apply: async (input) => {
          const tasks = this.tasks;
          if (tasks === null) throw new Error('The Projects module is not available.');
          const created = await tasks.create(input.projectId, {
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
            ...(input.dateStart === undefined ? {} : { dateStart: input.dateStart }),
            ...(input.dateEnd === undefined ? {} : { dateEnd: input.dateEnd }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
          } as never);
          return {
            value: { id: String(created['id'] ?? ''), name: String(created['name'] ?? input.name) },
            affectedRecords: [],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = ['projects.task.create'];
}
