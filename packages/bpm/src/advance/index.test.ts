import { describe, expect, it } from 'vitest';

import { ProcessExecutionError, ProcessValidationError } from '../errors/index.js';
import type { CreateTaskInput, ProcessAdvancePorts, ProcessDefinition, ProcessNode } from '../types/index.js';
import { commentContextKey, outcomeContextKey } from '../types/index.js';
import { advanceProcess } from './index.js';

interface RecordedEvent {
  type: string;
  nodeId?: string | undefined;
  message: string;
  data?: Record<string, unknown> | undefined;
}

function fakePorts(): {
  ports: ProcessAdvancePorts;
  events: RecordedEvent[];
  tasks: CreateTaskInput[];
  timers: { taskId: string; kind: 'due' | 'escalate'; seconds: number }[];
  dispatched: { nodeId: string; action: string; params: Record<string, unknown> }[];
  positions: { nodeId: string | null; context: Record<string, unknown> }[];
  finished: { outcome: string; context: Record<string, unknown> } | null;
} {
  const state = {
    events: [] as RecordedEvent[],
    tasks: [] as CreateTaskInput[],
    timers: [] as { taskId: string; kind: 'due' | 'escalate'; seconds: number }[],
    dispatched: [] as { nodeId: string; action: string; params: Record<string, unknown> }[],
    positions: [] as { nodeId: string | null; context: Record<string, unknown> }[],
    finished: null as { outcome: string; context: Record<string, unknown> } | null,
  };
  let counter = 0;
  const ports: ProcessAdvancePorts = {
    createTask: async (input) => {
      state.tasks.push(input);
      counter += 1;
      return { taskId: `task-${String(counter)}` };
    },
    dispatchServiceTask: async (input) => {
      state.dispatched.push({ ...input, params: { ...input.params } });
    },
    scheduleTimer: async (input) => {
      state.timers.push(input);
    },
    recordEvent: async (input) => {
      state.events.push(input);
    },
    setCurrentNode: async (nodeId, context) => {
      state.positions.push({ nodeId, context: { ...context } });
    },
    finishInstance: async (input) => {
      state.finished = { outcome: input.outcome, context: { ...input.context } };
    },
  };
  return {
    ports,
    events: state.events,
    tasks: state.tasks,
    timers: state.timers,
    dispatched: state.dispatched,
    positions: state.positions,
    get finished(): { outcome: string; context: Record<string, unknown> } | null {
      return state.finished;
    },
  };
}

/** A realistic multi-step approval: review → notify → value gateway → audit/end, plus a reject end. */
function approval(): ProcessDefinition {
  return {
    entityType: 'Opportunity',
    start: 'review',
    nodes: [
      {
        id: 'review',
        type: 'userTask',
        name: 'Manager review',
        assignee: { type: 'role', value: 'Sales Manager' },
        dueSeconds: 3_600,
        escalateAfterSeconds: 86_400,
        escalateTo: { type: 'user', value: 'boss' },
        outcomes: [
          { value: 'approved', label: 'Approve', next: 'notify' },
          { value: 'rejected', label: 'Reject', next: 'stop' },
        ],
      },
      {
        id: 'notify',
        type: 'serviceTask',
        name: 'Notify finance',
        action: 'createNotification',
        params: { userId: 'finance', message: 'Approved: {{name}}' },
        next: 'gate',
      },
      {
        id: 'gate',
        type: 'gateway',
        name: 'High value?',
        branches: [{ when: "field('amount') > 1000", next: 'audit' }],
        default: 'done',
      },
      {
        id: 'audit',
        type: 'serviceTask',
        name: 'Flag for audit',
        action: 'updateRecord',
        params: { fields: { stage: 'Audit' } },
        next: 'done',
      },
      { id: 'done', type: 'end', name: 'Approved', outcome: 'approved' },
      { id: 'stop', type: 'end', name: 'Rejected', outcome: 'rejected' },
    ] satisfies ProcessNode[],
  };
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('advanceProcess', () => {
  it('parks at the first user task, creating it with timers and a persisted position', async () => {
    const fake = fakePorts();
    const result = await advanceProcess({
      definition: approval(),
      state: { currentNode: null, context: {} },
      ports: fake.ports,
      options: { now: NOW, record: { name: 'Big deal', amount: 2_000 }, entityType: 'Opportunity', entityId: 'opp-1' },
    });

    expect(result.status).toBe('waiting');
    expect(result.currentNode).toBe('review');
    expect(fake.tasks).toHaveLength(1);
    expect(fake.tasks[0]).toMatchObject({
      nodeId: 'review',
      assignee: { type: 'role', value: 'Sales Manager' },
      dueAt: new Date('2026-01-01T01:00:00.000Z'),
      escalateAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(fake.timers).toEqual([
      { taskId: 'task-1', kind: 'due', seconds: 3_600 },
      { taskId: 'task-1', kind: 'escalate', seconds: 86_400 },
    ]);
    expect(fake.positions.at(-1)).toMatchObject({ nodeId: 'review' });
    expect(fake.events.map((event) => event.type)).toEqual(['node.entered', 'task.created']);
  });

  it('completes an approval end to end, dispatching service tasks and choosing a gateway branch', async () => {
    const fake = fakePorts();
    const record = { name: 'Big deal', amount: 2_000 };

    const afterApprove = await advanceProcess({
      definition: approval(),
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'review', outcome: 'approved', comment: 'Go ahead', userId: 'manager-1' },
      options: { now: NOW, record, entityType: 'Opportunity', entityId: 'opp-1' },
    });

    expect(afterApprove.status).toBe('completed');
    expect(afterApprove.outcome).toBe('approved');
    expect(afterApprove.context).toMatchObject({
      [outcomeContextKey('review')]: 'approved',
      [commentContextKey('review')]: 'Go ahead',
      outcome: 'approved',
      comment: 'Go ahead',
    });
    expect(fake.dispatched).toEqual([
      { nodeId: 'notify', action: 'createNotification', params: { userId: 'finance', message: 'Approved: Big deal' } },
      { nodeId: 'audit', action: 'updateRecord', params: { fields: { stage: 'Audit' } } },
    ]);
    expect(fake.finished?.outcome).toBe('approved');
    const types = fake.events.map((event) => event.type);
    expect(types).toContain('task.outcome');
    expect(types).toContain('branch.selected');
    expect(types).toContain('service.dispatched');
    expect(types.at(-1)).toBe('instance.completed');
  });

  it('takes the gateway default when no branch condition holds', async () => {
    const fake = fakePorts();
    const result = await advanceProcess({
      definition: approval(),
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'review', outcome: 'approved' },
      options: { now: NOW, record: { name: 'Small deal', amount: 10 }, entityType: 'Opportunity', entityId: 'opp-2' },
    });

    expect(result.status).toBe('completed');
    expect(fake.dispatched.map((entry) => entry.nodeId)).toEqual(['notify']);
    expect(fake.events.find((event) => event.type === 'branch.selected')?.data).toMatchObject({ chosen: 'done', matched: null });
  });

  it('reads task outcomes from the process context in a gateway formula', async () => {
    const definition: ProcessDefinition = {
      start: 'review',
      nodes: [
        {
          id: 'review',
          type: 'userTask',
          name: 'Review',
          assignee: { type: 'user', value: 'u1' },
          outcomes: [
            { value: 'approved', label: 'Approve', next: 'gate' },
            { value: 'rejected', label: 'Reject', next: 'gate' },
          ],
        },
        {
          id: 'gate',
          type: 'gateway',
          name: 'Decision',
          branches: [{ when: "field('reviewOutcome') == 'rejected'", next: 'stop' }],
          default: 'done',
        },
        { id: 'done', type: 'end', name: 'Done', outcome: 'approved' },
        { id: 'stop', type: 'end', name: 'Stopped', outcome: 'rejected' },
      ] satisfies ProcessNode[],
    };

    const fake = fakePorts();
    const result = await advanceProcess({
      definition,
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'review', outcome: 'rejected' },
      options: { now: NOW },
    });

    expect(result.outcome).toBe('rejected');
  });

  it('loops back for another task when an outcome returns to the same user task', async () => {
    const definition: ProcessDefinition = {
      start: 'review',
      nodes: [
        {
          id: 'review',
          type: 'userTask',
          name: 'Review',
          assignee: { type: 'user', value: 'u1' },
          outcomes: [
            { value: 'changes', label: 'Request changes', next: 'review' },
            { value: 'approved', label: 'Approve', next: 'done' },
          ],
        },
        { id: 'done', type: 'end', name: 'Done', outcome: 'approved' },
      ] satisfies ProcessNode[],
    };

    const fake = fakePorts();
    const result = await advanceProcess({
      definition,
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'review', outcome: 'changes', comment: 'Needs numbers' },
      options: { now: NOW },
    });

    // The pending outcome is consumed once: the second arrival parks and creates a fresh task.
    expect(result.status).toBe('waiting');
    expect(result.currentNode).toBe('review');
    expect(fake.tasks).toHaveLength(1);
    expect(result.context).toMatchObject({ [outcomeContextKey('review')]: 'changes', outcome: 'changes' });
  });

  it('parks when a completion arrives for a different node than the one in front', async () => {
    const fake = fakePorts();
    const result = await advanceProcess({
      definition: approval(),
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'notify', outcome: 'approved' },
      options: { now: NOW, record: {}, entityType: 'Opportunity', entityId: 'opp-3' },
    });

    expect(result.status).toBe('waiting');
    expect(fake.tasks).toHaveLength(1);
  });

  it('refuses an outcome the task does not offer', async () => {
    const fake = fakePorts();
    await expect(
      advanceProcess({
        definition: approval(),
        state: { currentNode: 'review', context: {} },
        ports: fake.ports,
        pending: { nodeId: 'review', outcome: 'maybe' },
        options: { now: NOW, record: {}, entityType: 'Opportunity', entityId: 'opp-4' },
      }),
    ).rejects.toBeInstanceOf(ProcessExecutionError);
  });

  it('refuses to run a stored definition that bypassed validation', async () => {
    const definition = {
      start: 'a',
      nodes: [
        { id: 'a', type: 'serviceTask', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'b' },
        { id: 'b', type: 'gateway', name: 'B', branches: [{ when: 'true', next: 'a' }], default: 'a' },
      ] satisfies ProcessNode[],
    } as unknown as ProcessDefinition;

    const fake = fakePorts();
    await expect(
      advanceProcess({ definition, state: { currentNode: null, context: {} }, ports: fake.ports, options: { now: NOW } }),
    ).rejects.toBeInstanceOf(ProcessValidationError);
    expect(fake.dispatched).toHaveLength(0);
  });

  it('records a node.entered transition for every move', async () => {
    const fake = fakePorts();
    await advanceProcess({
      definition: approval(),
      state: { currentNode: 'review', context: {} },
      ports: fake.ports,
      pending: { nodeId: 'review', outcome: 'rejected' },
      options: { now: NOW, record: {}, entityType: 'Opportunity', entityId: 'opp-5' },
    });

    const moves = fake.events.filter((event) => event.type === 'node.entered').map((event) => event.data);
    expect(moves).toEqual([{ from: 'review', to: 'stop' }]);
  });
});
