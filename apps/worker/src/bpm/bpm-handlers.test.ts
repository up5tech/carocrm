import type { ProcessDefinition } from '@carocrm/bpm';
import type { Logger } from '@carocrm/core/logger/index.js';
import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db.js';
import { createTestLogger } from '../testing/test-logger.js';
import type { StoredRecord } from '../workflows/workflow-store.js';
import { BPM_SERVICE_TASK_JOB, BPM_TASK_TIMER_JOB, registerBpmJobs } from './bpm-handlers.js';
import type { BpmStore, StoredProcessInstance, StoredProcessTask } from './bpm-store.js';

/**
 * Worker-side BPM tests (PLAN §36).
 *
 * Fakes, no Postgres and no Redis — the part that must be right is *orchestration*: a redelivered
 * timer must not escalate an answered task twice, a service task for a cancelled instance must be
 * skipped rather than executed, and a failing action must stop the process with a visible reason.
 */

/** Typed element access that fails loudly when a fixture is shorter than the test assumes. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`expected item at ${index}, list has ${list.length}`);
  return item;
}

const DEFINITION: ProcessDefinition = {
  entityType: 'Opportunity',
  start: 'review',
  nodes: [
    {
      id: 'review',
      type: 'userTask',
      name: 'Manager review',
      assignee: { type: 'role', value: 'Sales Manager' },
      escalateAfterSeconds: 86_400,
      escalateTo: { type: 'user', value: 'boss' },
      outcomes: [{ value: 'approved', label: 'Approve', next: 'audit' }],
    },
    { id: 'audit', type: 'serviceTask', name: 'Flag for audit', action: 'updateRecord', params: { fields: { stage: 'Audit' } }, next: 'done' },
    { id: 'done', type: 'end', name: 'Done', outcome: 'approved' },
  ],
};

interface FakeState {
  instance: StoredProcessInstance | undefined;
  task: StoredProcessTask | undefined;
  definition: ProcessDefinition | undefined;
  record: StoredRecord | undefined;
  roleIds: Record<string, string>;
  activeUsers: Set<string>;
  overdue: boolean;
  escalated: { assigneeId: string | null; assigneeRoleId: string | null } | null;
  events: { instanceId: string; nodeId?: string | undefined; type: string; message: string }[];
  notifications: { userId: string; message: string }[];
  failures: { instanceId: string; error: string }[];
}

function instance(overrides: Partial<StoredProcessInstance> = {}): StoredProcessInstance {
  return {
    id: 'inst1',
    version_id: 'v1',
    entity_type: 'Opportunity',
    entity_id: 'opp1',
    status: 'waiting',
    initiated_by: 'u1',
    ...overrides,
  };
}

function task(overrides: Partial<StoredProcessTask> = {}): StoredProcessTask {
  return {
    id: 'task1',
    instance_id: 'inst1',
    node_id: 'review',
    name: 'Manager review',
    status: 'open',
    assignee_id: 'manager',
    assignee_role_id: null,
    assignee_spec: { type: 'user', value: 'manager' },
    ...overrides,
  };
}

function fakeStore(overrides: Partial<FakeState> = {}): { store: BpmStore; state: FakeState } {
  const state: FakeState = {
    instance: instance(),
    task: task(),
    definition: DEFINITION,
    record: { id: 'opp1', entityType: 'Opportunity', attrs: { name: 'Big deal', amount: 2000 }, assignedUserId: null, createdById: 'u1' },
    roleIds: { 'Sales Manager': 'role1' },
    activeUsers: new Set(['manager', 'boss']),
    overdue: true,
    escalated: null,
    events: [],
    notifications: [],
    failures: [],
    ...overrides,
  };

  const store: BpmStore = {
    loadInstance: async () => state.instance,
    loadDefinition: async () => state.definition,
    loadTask: async () => state.task,
    loadRecord: async () => state.record,
    resolveRoleByName: async (name) => state.roleIds[name],
    userIsActive: async (userId) => state.activeUsers.has(userId),
    markTaskOverdue: async () => {
      const wasOpen = state.task?.status === 'open';
      if (wasOpen && state.task !== undefined) state.task = { ...state.task, status: 'overdue' };
      return wasOpen;
    },
    escalateTask: async ({ assigneeId, assigneeRoleId }) => {
      const task = state.task;
      const answerable = task !== undefined && (task.status === 'open' || task.status === 'overdue');
      if (task === undefined || !answerable) return false;
      state.escalated = { assigneeId, assigneeRoleId };
      state.task = { ...task, status: 'escalated', assignee_id: assigneeId, assignee_role_id: assigneeRoleId };
      return true;
    },
    recordEvent: async (event) => {
      state.events.push(event);
    },
    notify: async (userId, message) => {
      state.notifications.push({ userId, message });
    },
    failInstance: async ({ instanceId, error }) => {
      state.failures.push({ instanceId, error });
      state.instance = state.instance === undefined ? undefined : { ...state.instance, status: 'failed' };
    },
  };
  return { store, state };
}

function harness(store: BpmStore, options: { db?: Queryable } = {}) {
  const registry = new JobRegistry();
  const enqueued: { job: string; data: Record<string, unknown> }[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];

  registerBpmJobs({
    db:
      options.db ??
      ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: [...(params ?? [])] });
          return { rows: [{ id: 'opp1' }], rowCount: 1 };
        },
      } as Queryable),
    log: createTestLogger().log as unknown as Logger,
    registry,
    enqueue: async (job, data) => {
      enqueued.push({ job, data });
      return `job-${String(enqueued.length)}`;
    },
    store,
  });

  return { registry, enqueued, queries };
}

const job = (data: Record<string, unknown>) => ({
  userId: undefined,
  data,
  progress: () => undefined,
  log: () => undefined,
  shouldStop: async () => false,
});

async function run(registry: JobRegistry, name: string, data: Record<string, unknown>) {
  const handler = registry.get(name);
  if (handler === undefined) throw new Error(`job ${name} is not registered`);
  return handler(job(data));
}

describe('bpm jobs', () => {
  it('registers the service-task and timer jobs', () => {
    const { store } = fakeStore();
    const { registry } = harness(store);
    expect(registry.has(BPM_SERVICE_TASK_JOB)).toBe(true);
    expect(registry.has(BPM_TASK_TIMER_JOB)).toBe(true);
  });

  // ------------------------------------------------------------ service tasks

  it('runs a dispatched service task and reports it into the audit trail', async () => {
    const { store, state } = fakeStore();
    const { registry, queries } = harness(store);

    const result = await run(registry, BPM_SERVICE_TASK_JOB, {
      instanceId: 'inst1',
      nodeId: 'audit',
      action: 'updateRecord',
      entityType: 'Opportunity',
      entityId: 'opp1',
    });

    expect(result.status).toBe('completed');
    expect(queries.some((entry) => entry.sql.includes('UPDATE entity_records'))).toBe(true);
    expect(state.events.map((event) => event.type)).toEqual(['service.completed']);
    expect(state.failures).toHaveLength(0);
  });

  it('skips a service task whose instance was cancelled while the message waited', async () => {
    const { store } = fakeStore({ instance: instance({ status: 'cancelled' }) });
    const { registry, queries } = harness(store);

    const result = await run(registry, BPM_SERVICE_TASK_JOB, { instanceId: 'inst1', nodeId: 'audit', action: 'updateRecord' });

    expect(result).toMatchObject({ status: 'completed', result: { skipped: 'instance already cancelled' } });
    expect(queries).toHaveLength(0);
  });

  it('stops the process when the action fails', async () => {
    const failing: Queryable = {
      query: async () => {
        throw new Error('record no longer exists');
      },
    } as Queryable;
    const { store, state } = fakeStore();
    const { registry } = harness(store, { db: failing });

    const result = await run(registry, BPM_SERVICE_TASK_JOB, { instanceId: 'inst1', nodeId: 'audit', action: 'updateRecord' });

    expect(result.status).toBe('completed'); // not re-run by the queue: a failed action is an incident
    expect(state.events.map((event) => event.type)).toEqual(['service.failed']);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]?.error).toContain('record no longer exists');
    expect(state.instance?.status).toBe('failed');
  });

  it('tolerates a failing action when the node says onError: continue', async () => {
    const failing: Queryable = {
      query: async () => {
        throw new Error('boom');
      },
    } as Queryable;
    const { store, state } = fakeStore({
      definition: {
        ...DEFINITION,
        nodes: [at(DEFINITION.nodes, 0), { ...(at(DEFINITION.nodes, 1) as { onError?: string }), onError: 'continue' } as never, at(DEFINITION.nodes, 2)],
      },
    });
    const { registry } = harness(store, { db: failing });

    const result = await run(registry, BPM_SERVICE_TASK_JOB, { instanceId: 'inst1', nodeId: 'audit', action: 'updateRecord' });

    expect(result).toMatchObject({ status: 'completed', result: { continued: true } });
    expect(state.failures).toHaveLength(0);
    expect(state.instance?.status).toBe('waiting');
  });

  it('fails when the stored definition no longer contains the node', async () => {
    const { store, state } = fakeStore({ definition: { entityType: 'Opportunity', start: 'done', nodes: [{ id: 'done', type: 'end', name: 'Done' }] } });
    const { registry } = harness(store);

    const result = await run(registry, BPM_SERVICE_TASK_JOB, { instanceId: 'inst1', nodeId: 'audit', action: 'updateRecord' });

    expect(result.status).toBe('failed');
    expect(state.events.map((event) => event.type)).toEqual(['service.failed']);
  });

  // ------------------------------------------------------------ timers

  it('marks an overdue task and reminds its assignee', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store);

    const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'due' });

    expect(result.status).toBe('completed');
    expect(state.task?.status).toBe('overdue');
    expect(state.events.map((event) => event.type)).toEqual(['task.overdue']);
    expect(state.notifications[0]).toMatchObject({ userId: 'manager' });
  });

  it('does nothing twice when a due timer is redelivered', async () => {
    const { store, state } = fakeStore({ task: task({ status: 'overdue' }) });
    const { registry } = harness(store);

    const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'due' });

    expect(result).toMatchObject({ status: 'completed', result: { skipped: 'task already overdue' } });
    expect(state.events).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  it('ignores a timer for a task that was answered', async () => {
    const { store, state } = fakeStore({ task: task({ status: 'completed' }) });
    const { registry } = harness(store);

    const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'escalate' });

    // The status guard refuses to reassign an answered task, whatever the definition still says.
    expect(result).toMatchObject({ status: 'completed', result: { skipped: 'task already completed' } });
    expect(state.escalated).toBeNull();
  });

  it('escalates to the configured user and notifies them', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store);

    const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'escalate' });

    expect(result.status).toBe('completed');
    expect(state.task).toMatchObject({ status: 'escalated', assignee_id: 'boss' });
    expect(state.events.map((event) => event.type)).toEqual(['task.escalated']);
    expect(state.notifications[0]).toMatchObject({ userId: 'boss' });
  });

  it('escalates to a role when the target is a role', async () => {
    const { store, state } = fakeStore({
      definition: {
        ...DEFINITION,
        nodes: [
          { ...(DEFINITION.nodes[0] as { escalateTo?: unknown }), escalateTo: { type: 'role', value: 'Sales Manager' } } as never,
          at(DEFINITION.nodes, 1),
          at(DEFINITION.nodes, 2),
        ],
      },
    });
    const { registry } = harness(store);

    await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'escalate' });

    expect(state.escalated).toEqual({ assigneeId: null, assigneeRoleId: 'role1' });
    expect(state.notifications).toHaveLength(0); // role candidates are not notified individually
  });

  it('records a visible escalation failure when the target cannot be resolved', async () => {
    const { store, state } = fakeStore({ activeUsers: new Set(['manager']) }); // "boss" no longer active
    const { registry } = harness(store);

    const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'escalate' });

    expect(result.status).toBe('completed');
    expect(state.events.map((event) => event.type)).toEqual(['escalation.failed']);
    expect(state.task?.status).toBe('open');
  });

  it('skips every timer once the instance is no longer active', async () => {
    for (const status of ['completed', 'cancelled', 'failed']) {
      const { store, state } = fakeStore({ instance: instance({ status }) });
      const { registry } = harness(store);
      const result = await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'due' });
      expect(result).toMatchObject({ status: 'completed', result: { skipped: 'instance is no longer active' } });
      expect(state.events).toHaveLength(0);
    }
  });

  it('rejects a timer payload without a task id or a known kind', async () => {
    const { store } = fakeStore();
    const { registry } = harness(store);
    expect((await run(registry, BPM_TASK_TIMER_JOB, { kind: 'due' })).status).toBe('failed');
    expect((await run(registry, BPM_TASK_TIMER_JOB, { taskId: 'task1', kind: 'someday' })).status).toBe('failed');
  });
});
