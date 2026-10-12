import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobRegistry } from '@carocrm/jobs';

import type { Queryable } from '../db.js';
import type { DomainEventBus } from '../events/domain-event-bus.js';
import { registerWorkflowEngine } from './workflow-handlers.js';
import type { WorkflowStore } from './workflow-store.js';

export type { ActionDeps, ActionResult } from './workflow-actions.js';
export { actionContextOf, runWorkflowAction, splitFields,WORKFLOW_ACTION_HANDLERS } from './workflow-actions.js';
export {
  DEFAULT_RUN_RETENTION_DAYS,
  registerWorkflowEngine,
  WORKFLOW_CLEANUP_JOB,
  WORKFLOW_RESUME_JOB,
  WORKFLOW_RUN_JOB,
} from './workflow-handlers.js';
export type { ActiveWorkflow, StoredRecord, StoredRun, WorkflowStore } from './workflow-store.js';
export { createWorkflowStore } from './workflow-store.js';

/**
 * Workflow engine barrel (PLAN §35).
 *
 * Wire `registerWorkflowEngine()` from the worker composition root (`app.ts`) before `start()`,
 * passing the queue's enqueue function. The engine subscribes to domain events and registers three
 * jobs: `workflow.run`, `workflow.resume` and `system.cleanupWorkflowRuns`.
 */
export interface RegisterWorkflowOptions {
  db: Queryable;
  log: Logger;
  registry: JobRegistry;
  domainEvents: DomainEventBus;
  enqueue: (job: string, data: Record<string, unknown>) => Promise<string>;
  /** Injected in tests; production builds its own store from `db`. */
  store?: WorkflowStore;
}

export function registerWorkflows(options: RegisterWorkflowOptions): void {
  registerWorkflowEngine({
    db: options.db,
    log: options.log,
    registry: options.registry,
    domainEvents: options.domainEvents,
    enqueue: options.enqueue,
    ...(options.store === undefined ? {} : { store: options.store }),
  });
}
