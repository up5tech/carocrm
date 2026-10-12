import type { Provider, Type } from '@nestjs/common';

import { ProcessController, ProcessInstanceController, ProcessTaskController } from './process.controller.js';
import { ProcessService } from './process.service.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

export { ProcessController, ProcessInstanceController, ProcessTaskController } from './process.controller.js';
export type {
  CreateProcessInput,
  ProcessVersionStatus,
  ProcessVersionView,
  ProcessView,
  PublishedProcess,
  UpdateProcessInput,
} from './process.service.js';
export { ProcessService } from './process.service.js';
export type {
  CompleteTaskInput,
  ProcessEventView,
  ProcessInstanceView,
  ProcessTaskView,
  StartProcessInput,
} from './process-runtime.service.js';
export { ProcessRuntimeService } from './process-runtime.service.js';

/**
 * BPM process module barrel (PLAN §36).
 *
 * `/api/v1/Process`, `/api/v1/ProcessInstance` and `/api/v1/ProcessTask` are static prefixes and
 * must be registered **before** `ENTITY_CONTROLLERS` (see `apps/api/src/app.module.ts`).
 *
 * Needs `ENTITY_PROVIDERS` (EntityCrudService reads the record an instance is attached to, with
 * record-level ACL) and `JOB_PROVIDERS` (the runtime dispatches service tasks and arms task timers
 * onto the queue — no HTTP request ever runs an action itself, PLAN §5.5).
 *
 * The state machine itself lives in `@carocrm/bpm`; this module only persists what it decides and
 * resolves the human parts (assignees, roles, the record behind a `recordField`).
 */
export const PROCESS_CONTROLLERS: Type<unknown>[] = [ProcessController, ProcessInstanceController, ProcessTaskController];
export const PROCESS_PROVIDERS: Provider[] = [ProcessService, ProcessRuntimeService];
