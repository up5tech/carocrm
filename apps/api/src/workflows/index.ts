import type { Provider, Type } from '@nestjs/common';

import { WorkflowController, WorkflowRunController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';

export { WorkflowController, WorkflowRunController } from './workflow.controller.js';
export type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowRunStepView,
  WorkflowRunView,
  WorkflowVersionStatus,
  WorkflowVersionView,
  WorkflowView,
} from './workflow.service.js';
export { WORKFLOW_EVENT_OPTIONS, WorkflowService } from './workflow.service.js';

/**
 * Workflow module barrel (PLAN §35).
 *
 * `/api/v1/Workflow` and `/api/v1/WorkflowRun` are static prefixes and must be registered **before**
 * `ENTITY_CONTROLLERS` (see `apps/api/src/app.module.ts`).
 *
 * Execution is not here on purpose: the worker owns side effects and writes the run history this
 * module reads. Keeping the two apart is what stops an HTTP request from ever blocking on an
 * automation (PLAN §5.5, §7.4).
 */
export const WORKFLOW_CONTROLLERS: Type<unknown>[] = [WorkflowController, WorkflowRunController];
export const WORKFLOW_PROVIDERS: Provider[] = [WorkflowService];