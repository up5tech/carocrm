import type { Provider, Type } from '@nestjs/common';

import { ProjectAccessService } from './project-access.service.js';
import { ProjectBoardService } from './project-board.service.js';
import { ProjectCloneService } from './project-clone.service.js';
import { ProjectDashletService } from './project-dashlet.service.js';
import { ProjectDependencyService } from './project-dependency.service.js';
import { ProjectGroupService } from './project-group.service.js';
import { ProjectGuardService } from './project-guard.service.js';
import { ProjectMemberService } from './project-member.service.js';
import { ProjectPolicyService } from './project-policy.service.js';
import { ProjectRecords } from './project-records.js';
import { ProjectTaskService } from './project-task.service.js';
import { ProjectViewService } from './project-view.service.js';
import { ProjectController, ProjectTaskController } from './projects.controller.js';

/**
 * Projects domain module barrel (PLAN_Phase_19_Projects.md §6.1).
 *
 * Like every other domain here, Projects is a directory under `apps/api/src`, not a second
 * framework: the Entity Engine, ACL, stream, audit, attachments and dashboards are the kernel's and
 * are reused rather than re-implemented.
 *
 * `PROJECTS_CONTROLLERS` is spread into `AppModule` BEFORE `ENTITY_CONTROLLERS`: these two
 * controllers own the static `/api/v1/Project` and `/api/v1/ProjectTask` prefixes, and the generic
 * `:entity` wildcard has to stay last so static routes win (docs/module-guide.md).
 */
export const PROJECTS_CONTROLLERS: Type<unknown>[] = [ProjectController, ProjectTaskController];

export const PROJECTS_PROVIDERS: Provider[] = [
  ProjectRecords,
  ProjectPolicyService,
  ProjectAccessService,
  ProjectBoardService,
  ProjectGroupService,
  ProjectMemberService,
  ProjectTaskService,
  ProjectDependencyService,
  ProjectCloneService,
  ProjectViewService,
  ProjectDashletService,
  ProjectGuardService,
];

export { ProjectAccessService } from './project-access.service.js';
export { ProjectDashletService } from './project-dashlet.service.js';
export { ProjectGuardService } from './project-guard.service.js';
export { ProjectController, ProjectTaskController } from './projects.controller.js';
