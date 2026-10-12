import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobRegistry } from '@carocrm/jobs';

import type { Queryable } from '../db.js';
import type { WorkflowStore } from '../workflows/workflow-store.js';
import { registerBpmJobs } from './bpm-handlers.js';
import type { BpmStore } from './bpm-store.js';

export type { BpmEngineDeps } from './bpm-handlers.js';
export { BPM_SERVICE_TASK_JOB, BPM_TASK_TIMER_JOB, registerBpmJobs } from './bpm-handlers.js';
export type { BpmStore, StoredProcessInstance, StoredProcessTask } from './bpm-store.js';
export { createBpmStore } from './bpm-store.js';

/**
 * BPM jobs barrel (PLAN §36).
 *
 * Wire `registerBpm()` from the worker composition root (`app.ts`) before `start()`. It registers
 * the two jobs the API arms: `bpm.serviceTask` (run one §35 action for a service task) and
 * `bpm.taskTimer` (fire a task's due or escalation timer). Unlike workflows, BPM subscribes to no
 * domain events — a process moves when a person acts, not when a record changes; the API decides
 * what to dispatch.
 */
export interface RegisterBpmOptions {
  db: Queryable;
  log: Logger;
  registry: JobRegistry;
  enqueue: (job: string, data: Record<string, unknown>) => Promise<string>;
  /** Injected in tests; production builds its own stores from `db`. */
  store?: BpmStore;
  workflowStore?: WorkflowStore;
}

export function registerBpm(options: RegisterBpmOptions): void {
  registerBpmJobs({
    db: options.db,
    log: options.log,
    registry: options.registry,
    enqueue: options.enqueue,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.workflowStore === undefined ? {} : { workflowStore: options.workflowStore }),
  });
}
