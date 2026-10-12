import type { Logger } from '@carocrm/core/logger/index.js';
import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db.js';
import type { DomainEventMessage } from '../events/domain-event-bus.js';
import { createTestLogger } from '../testing/test-logger.js';
import { DEFAULT_RUN_RETENTION_DAYS, registerWorkflowEngine,WORKFLOW_CLEANUP_JOB, WORKFLOW_RESUME_JOB, WORKFLOW_RUN_JOB } from './workflow-handlers.js';
import type { ActiveWorkflow, StoredRecord, StoredRun, WorkflowStore } from './workflow-store.js';

/**
 * Worker-side workflow tests (PLAN §35).
 *
 * These run against fakes — no Postgres, no Redis — because the engine is the part that has to be
 * right about *orchestration*: what gets enqueued on an event, what happens when a job is redelivered,
 * and what a delay does. The SQL is thin by comparison.
 */

const DEFINITION = {
  trigger: { eventType: 'entity.created', entityType: 'Account' },
  start: 'a1',
  nodes: [
    { id: 'a1', type: 'action', name: 'Update', action: 'updateRecord', params: { fields: { status: 'Working' } }, next: 'e' },
    { id: 'e', type: 'end', name: 'Done' },
  ],
};

const DELAY_DEFINITION = {
  trigger: { eventType: 'entity.created', entityType: 'Account' },
  start: 'd',
  nodes: [
    { id: 'd', type: 'delay', name: 'Wait a day', seconds: 86400, next: 'a1' },
    { id: 'a1', type: 'action', name: 'Update', action: 'updateRecord', params: { fields: { status: 'Working' } }, next: 'e' },
    { id: 'e', type: 'end', name: 'Done' },
  ],
};

interface FakeState {
  readonly workflows: ActiveWorkflow[];
  readonly record: StoredRecord | undefined;
  run: StoredRun | undefined;
  steps: { nodeId: string; status: string; attempt: number; output: unknown }[];
  finished: { status: string; error: string | null }[];
  waiting: string[];
  queries: { sql: string; params: unknown[] }[];
  prunedDays: number | null;
}

function fakeStore(state: Partial<FakeState> = {}): { store: WorkflowStore; state: FakeState } {
  const merged: FakeState = {
    workflows: [{ id: 'wf1', name: 'On account create', versionId: 'v1', definition: DEFINITION }],
    record: { id: 'a1', entityType: 'Account', attrs: { name: 'ACME', status: 'New' }, assignedUserId: null, createdById: 'u1' },
    run: undefined,
    steps: [],
    finished: [],
    waiting: [],
    queries: [],
    prunedDays: null,
    ...state,
  };

  const store: WorkflowStore = {
    activeWorkflows: async () => merged.workflows,
    activeWorkflow: async (id) => merged.workflows.find((workflow) => workflow.id === id),
    loadRecord: async () => merged.record,
    loadRun: async (runId) => (merged.run?.id === runId ? merged.run : undefined),
    loadSteps: async (runId) =>
      merged.steps.map((step) => ({
        runId,
        nodeId: step.nodeId,
        nodeType: 'action',
        name: step.nodeId,
        status: step.status,
        attempt: step.attempt,
        output: step.output,
      })),
    loadDefinition: async (versionId) => {
      const found = merged.workflows.find((workflow) => workflow.versionId === versionId);
      return found?.definition as never;
    },
    startRun: async (input) => {
      merged.run = {
        id: merged.run?.id ?? 'run1',
        workflow_id: input.workflowId,
        version_id: input.versionId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        status: 'running',
        user_id: input.userId,
        attempt: merged.run === undefined ? 1 : merged.run.attempt + 1,
      };
      return merged.run;
    },
    recordStep: async ({ nodeId, status, attempt, output }) => {
      merged.steps.push({ nodeId, status, attempt, output });
    },
    markWaiting: async ({ currentNode }) => {
      merged.waiting.push(currentNode ?? '');
    },
    finishRun: async ({ status, error }) => {
      merged.finished.push({ status, error: error ?? null });
    },
    pruneRuns: async (retentionDays) => {
      merged.prunedDays = retentionDays;
      return 3;
    },
  };
  return { store, state: merged };
}

function harness(store: WorkflowStore, state: FakeState) {
  const enqueued: { job: string; data: Record<string, unknown> }[] = [];
  const registry = new JobRegistry();
  const subscribers: { eventType: string; name: string; handler: (event: DomainEventMessage) => Promise<void> }[] = [];

  const db: Queryable = {
    query: async (sql, params) => {
      state.queries.push({ sql, params: [...(params ?? [])] });
      if (sql.includes('FROM entity_records')) return { rows: [{ id: 'a1', attrs: '{"name":"ACME"}' }], rowCount: 1 };
      if (sql.includes('INSERT INTO notifications')) {
        // A notification for a user that does not exist affects no row, exactly like the real
        // `INSERT … SELECT … FROM users WHERE id = $3`.
        return params?.[2] === 'ghost' ? { rows: [], rowCount: 0 } : { rows: [{ id: 'n1' }], rowCount: 1 };
      }
      return { rows: [{ id: 'x1' }], rowCount: 1 };
    },
  };

  registerWorkflowEngine({
    db,
    log: createTestLogger().log as unknown as Logger,
    registry,
    domainEvents: {
      subscribe: (input: { eventType: string; name: string; handler: (event: DomainEventMessage) => Promise<void> }) => {
        subscribers.push(input);
      },
      list: () => [],
      unsubscribe: () => true,
      publish: async () => undefined,
    } as never,
    enqueue: async (job, data) => {
      enqueued.push({ job, data });
      return `job-${String(enqueued.length)}`;
    },
    store,
  });

  return { registry, enqueued, subscribers };
}

const job = (data: Record<string, unknown>) => ({
  userId: undefined,
  data,
  progress: () => undefined,
  log: () => undefined,
  shouldStop: async () => false,
});

const CREATED_EVENT: DomainEventMessage = {
  id: 'evt1',
  eventType: 'entity.created',
  payload: { entityType: 'Account', entityId: 'a1', userId: 'u1' },
};

describe('workflow engine wiring', () => {
  it('registers the three jobs', () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    expect(registry.has(WORKFLOW_RUN_JOB)).toBe(true);
    expect(registry.has(WORKFLOW_RESUME_JOB)).toBe(true);
    expect(registry.has(WORKFLOW_CLEANUP_JOB)).toBe(true);
  });

  it('subscribes a single wildcard trigger to domain events', () => {
    const { store, state } = fakeStore();
    const { subscribers } = harness(store, state);
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.eventType).toBe('*');
    expect(subscribers[0]?.name).toBe('workflow:trigger');
  });

  it('queues one run per matching workflow when an entity is created', async () => {
    const { store, state } = fakeStore();
    const { subscribers, enqueued } = harness(store, state);
    await subscribers[0]?.handler(CREATED_EVENT);
    expect(enqueued).toEqual([
      {
        job: WORKFLOW_RUN_JOB,
        data: { workflowId: 'wf1', versionId: 'v1', entityType: 'Account', entityId: 'a1', userId: 'u1' },
      },
    ]);
  });

  it('ignores events that are not entity mutations', async () => {
    const { store, state } = fakeStore();
    const { subscribers, enqueued } = harness(store, state);
    await subscribers[0]?.handler({ id: 'e2', eventType: 'workflow.completed', payload: { entityType: 'Account', entityId: 'a1' } });
    await subscribers[0]?.handler({ id: 'e3', eventType: 'entity.created', payload: {} });
    expect(enqueued).toEqual([]);
  });

  it('runs the graph and writes the record through the action', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    const result = await registry.get(WORKFLOW_RUN_JOB)?.(
      job({ workflowId: 'wf1', versionId: 'v1', entityType: 'Account', entityId: 'a1', userId: 'u1' }),
    );
    expect(result?.status).toBe('completed');
    expect(state.finished).toEqual([{ status: 'completed', error: null }]);
    // One row per node in the database (the upsert overwrites); the fake records each transition.
    expect(state.steps.map((step) => `${step.nodeId}:${step.status}`)).toEqual(['a1:running', 'a1:completed', 'e:completed']);
    const patch = state.queries.find((query) => query.sql.includes('UPDATE entity_records'));
    expect(patch?.params[2]).toBe('{"status":"Working"}');
  });

  it('parks a run at a delay and enqueues the resume', async () => {
    const { store, state } = fakeStore({
      workflows: [{ id: 'wf1', name: 'Delayed', versionId: 'v1', definition: DELAY_DEFINITION as never }],
    });
    const { registry, enqueued } = harness(store, state);
    const result = await registry.get(WORKFLOW_RUN_JOB)?.(
      job({ workflowId: 'wf1', versionId: 'v1', entityType: 'Account', entityId: 'a1' }),
    );
    // A waiting run completed its job: nothing is retried, the resume carries the rest.
    expect(result?.status).toBe('completed');
    expect(state.waiting).toEqual(['a1']);
    expect(enqueued).toEqual([
      { job: WORKFLOW_RESUME_JOB, data: { runId: 'run1', delaySeconds: 86400, startNodeId: 'a1' } },
    ]);
  });

  it('continues a parked run when the resume job fires', async () => {
    const { store, state } = fakeStore({
      workflows: [{ id: 'wf1', name: 'Delayed', versionId: 'v1', definition: DELAY_DEFINITION as never }],
    });
    const { registry } = harness(store, state);
    state.run = {
      id: 'run1',
      workflow_id: 'wf1',
      version_id: 'v1',
      entity_type: 'Account',
      entity_id: 'a1',
      status: 'waiting',
      user_id: 'u1',
      attempt: 1,
    };
    const result = await registry.get(WORKFLOW_RESUME_JOB)?.(job({ runId: 'run1', startNodeId: 'a1' }));
    expect(result?.status).toBe('completed');
    expect(state.finished.at(-1)).toEqual({ status: 'completed', error: null });
    expect(state.queries.some((query) => query.sql.includes('UPDATE entity_records'))).toBe(true);
  });

  it('does not resume a run that already finished', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    state.run = {
      id: 'run1',
      workflow_id: 'wf1',
      version_id: 'v1',
      entity_type: 'Account',
      entity_id: 'a1',
      status: 'completed',
      user_id: null,
      attempt: 1,
    };
    const result = await registry.get(WORKFLOW_RESUME_JOB)?.(job({ runId: 'run1' }));
    expect(result?.status).toBe('completed');
    expect(state.queries).toHaveLength(0);
  });

  it('refuses a job without the ids it needs', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    const result = await registry.get(WORKFLOW_RUN_JOB)?.(job({ workflowId: 'wf1' }));
    expect(result).toMatchObject({ status: 'failed' });
  });

  it('fails the run when its version disappeared', async () => {
    const { store, state } = fakeStore({ workflows: [] });
    const { registry } = harness(store, state);
    const result = await registry.get(WORKFLOW_RUN_JOB)?.(
      job({ workflowId: 'wf1', versionId: 'v1', entityType: 'Account', entityId: 'a1' }),
    );
    expect(result).toMatchObject({ status: 'failed' });
    expect(state.finished.at(-1)?.status).toBe('failed');
  });

  it('marks a failing action as failed and rethrows so the queue retries', async () => {
    // Notifying a user that does not exist affects no row, so the action fails.
    const { store, state } = fakeStore({
      workflows: [
        {
          id: 'wf1',
          name: 'Notify',
          versionId: 'v1',
          definition: {
            trigger: { eventType: 'entity.created', entityType: 'Account' },
            start: 'a1',
            nodes: [{ id: 'a1', type: 'action', name: 'Notify nobody', action: 'createNotification', params: { userId: 'ghost', message: 'hi' } }],
          } as never,
        },
      ],
    });
    const { registry } = harness(store, state);
    await expect(
      registry.get(WORKFLOW_RUN_JOB)?.(job({ workflowId: 'wf1', versionId: 'v1', entityType: 'Account', entityId: 'a1' })),
    ).rejects.toThrowError(/createNotification failed/);
    expect(state.steps.some((step) => step.nodeId === 'a1' && step.status === 'failed')).toBe(true);
    expect(state.finished.at(-1)?.status).toBe('failed');
  });

  it('prunes finished runs on the default retention', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    const result = await registry.get(WORKFLOW_CLEANUP_JOB)?.(job({}));
    expect(result).toMatchObject({ status: 'completed', result: { deleted: 3 } });
    expect(state.prunedDays).toBe(DEFAULT_RUN_RETENTION_DAYS);
  });

  it('honours an explicit retention window', async () => {
    const { store, state } = fakeStore();
    const { registry } = harness(store, state);
    await registry.get(WORKFLOW_CLEANUP_JOB)?.(job({ retentionDays: 7 }));
    expect(state.prunedDays).toBe(7);
  });
});