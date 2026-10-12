import { describe, expect, it } from 'vitest';

import type { ActionNode, WorkflowDefinition, WorkflowRunContext, WorkflowStepRecord, WorkflowStepSnapshot } from '../types/index.js';
import type { WorkflowExecutorPorts } from './index.js';
import { executeWorkflow } from './index.js';

function run(overrides: Partial<WorkflowRunContext> = {}): WorkflowRunContext {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    versionId: 'v1',
    entityType: 'Account',
    entityId: 'a1',
    userId: 'u1',
    record: { name: 'ACME', amount: 5000, status: 'New' },
    attempt: 1,
    ...overrides,
  };
}

/** In-memory ports: records what the engine asked for, and can be told to fail or stop. */
function ports(overrides: Partial<WorkflowExecutorPorts> & { failOn?: string } = {}) {
  const steps: WorkflowStepRecord[] = [];
  const actions: { name: string; params: Record<string, unknown> }[] = [];
  const resumes: { delaySeconds: number; nextNodeId: string | undefined }[] = [];
  const waiting: { nextNodeId: string | undefined; delaySeconds: number }[] = [];
  const finished: { status: string; error?: string }[] = [];
  const seeded: WorkflowStepSnapshot[] = overrides.loadSteps === undefined ? [] : [];
  const base: WorkflowExecutorPorts = {
    runAction: async ({ node, params }) => {
      if (overrides.failOn === node.name) throw new Error('action exploded');
      actions.push({ name: node.name, params });
      return { created: node.name };
    },
    recordStep: async (step) => {
      steps.push(step);
    },
    loadSteps: async () => seeded,
    finishRun: async ({ status, error }) => {
      finished.push({ status, ...(error === undefined ? {} : { error }) });
    },
    scheduleResume: async (input) => {
      resumes.push({ delaySeconds: input.delaySeconds, nextNodeId: input.nextNodeId });
    },
    markWaiting: async (input) => {
      waiting.push({ nextNodeId: input.nextNodeId, delaySeconds: input.delaySeconds });
    },
    ...(overrides.runAction === undefined ? {} : { runAction: overrides.runAction }),
    ...(overrides.recordStep === undefined ? {} : { recordStep: overrides.recordStep }),
    ...(overrides.loadSteps === undefined ? {} : { loadSteps: overrides.loadSteps }),
    ...(overrides.finishRun === undefined ? {} : { finishRun: overrides.finishRun }),
    ...(overrides.scheduleResume === undefined ? {} : { scheduleResume: overrides.scheduleResume }),
    ...(overrides.markWaiting === undefined ? {} : { markWaiting: overrides.markWaiting }),
    ...(overrides.shouldStop === undefined ? {} : { shouldStop: overrides.shouldStop }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  };
  return { ports: base, steps, actions, resumes, waiting, finished, seeded };
}

const linear: WorkflowDefinition = {
  trigger: { eventType: 'entity.created', entityType: 'Account' },
  start: 'a1',
  nodes: [
    { id: 'a1', type: 'action', name: 'Stamp', action: 'updateRecord', params: { fields: { status: 'Active' } }, next: 'a2' },
    { id: 'a2', type: 'action', name: 'Notify', action: 'createNotification', params: { userId: 'u2', message: 'hi' }, next: 'e' },
    { id: 'e', type: 'end', name: 'Done' },
  ],
};

describe('executeWorkflow', () => {
  it('runs the nodes in order and completes the run', async () => {
    const recorder = ports();
    const result = await executeWorkflow(linear, run(), recorder.ports);
    expect(result.status).toBe('completed');
    expect(recorder.actions.map((action) => action.name)).toEqual(['Stamp', 'Notify']);
    expect(recorder.finished).toEqual([{ status: 'completed' }]);
    expect(recorder.steps.filter((step) => step.status === 'completed').map((step) => step.nodeId)).toEqual(['a1', 'a2', 'e']);
  });

  it('records a running step before the action and the output after it', async () => {
    const recorder = ports();
    await executeWorkflow(linear, run(), recorder.ports);
    const stamp = recorder.steps.filter((step) => step.nodeId === 'a1');
    expect(stamp.map((step) => step.status)).toEqual(['running', 'completed']);
    expect(stamp[1]?.output).toEqual({ output: { created: 'Stamp' } });
  });

  it('follows the "then" branch when a condition matches', async () => {
    const definition: WorkflowDefinition = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'c',
      nodes: [
        { id: 'c', type: 'condition', name: 'Big?', formula: 'number(field("amount")) > 1000', then: 'big', otherwise: 'small' },
        { id: 'big', type: 'action', name: 'Escalate', action: 'createNotification', params: { userId: 'boss', message: 'big' } },
        { id: 'small', type: 'action', name: 'Ignore', action: 'createNotification', params: { userId: 'nobody', message: 'small' } },
      ],
    };
    const recorder = ports();
    await executeWorkflow(definition, run(), recorder.ports);
    expect(recorder.actions.map((action) => action.name)).toEqual(['Escalate']);
    const conditionStep = recorder.steps.find((step) => step.nodeId === 'c');
    expect(conditionStep?.output).toEqual({ matched: true });
  });

  it('follows the "otherwise" branch when a condition does not match', async () => {
    const definition: WorkflowDefinition = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'c',
      nodes: [
        { id: 'c', type: 'condition', name: 'Big?', formula: 'number(field("amount")) > 100000', then: 'big', otherwise: 'small' },
        { id: 'big', type: 'action', name: 'Escalate', action: 'createNotification', params: { userId: 'boss', message: 'big' } },
        { id: 'small', type: 'action', name: 'Ignore', action: 'createNotification', params: { userId: 'nobody', message: 'small' } },
      ],
    };
    const recorder = ports();
    await executeWorkflow(definition, run(), recorder.ports);
    expect(recorder.actions.map((action) => action.name)).toEqual(['Ignore']);
  });

  it('ends the run when a condition has no otherwise target and does not match', async () => {
    const definition: WorkflowDefinition = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'c',
      nodes: [
        { id: 'c', type: 'condition', name: 'Big?', formula: 'number(field("amount")) > 100000', then: 'big' },
        { id: 'big', type: 'action', name: 'Escalate', action: 'createNotification', params: { userId: 'boss', message: 'big' } },
      ],
    };
    const recorder = ports();
    const result = await executeWorkflow(definition, run(), recorder.ports);
    expect(result.status).toBe('completed');
    expect(recorder.actions).toEqual([]);
  });

  it('parks the run at a delay and asks for a resume', async () => {
    const definition: WorkflowDefinition = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'd',
      nodes: [
        { id: 'd', type: 'delay', name: 'Cool off', seconds: 3600, next: 'a' },
        { id: 'a', type: 'action', name: 'Follow up', action: 'sendEmail', params: { to: 'x@y.z', subject: 'hi', body: 'hello' } },
      ],
    };
    const recorder = ports();
    const result = await executeWorkflow(definition, run(), recorder.ports);
    expect(result.status).toBe('waiting');
    expect(result.result).toMatchObject({ resumeAt: 'a', delaySeconds: 3600 });
    expect(recorder.waiting).toEqual([{ nextNodeId: 'a', delaySeconds: 3600 }]);
    expect(recorder.resumes).toEqual([{ delaySeconds: 3600, nextNodeId: 'a' }]);
    expect(recorder.finished).toEqual([]);
  });

  it('continues after a delay when the job resumes at the next node', async () => {
    const recorder = ports();
    const result = await executeWorkflow(linear, run(), recorder.ports, { startNodeId: 'a2' });
    expect(result.status).toBe('completed');
    expect(recorder.actions.map((action) => action.name)).toEqual(['Notify']);
  });

  it('does not repeat an action that already completed in an earlier attempt', async () => {
    const recorder = ports({
      loadSteps: async () => [
        {
          runId: 'run-1',
          nodeId: 'a1',
          nodeType: 'action',
          name: 'Stamp',
          status: 'completed',
          attempt: 1,
          output: { output: { created: 'Stamp' } },
        },
      ],
    });
    const result = await executeWorkflow(linear, run(), recorder.ports);
    expect(result.status).toBe('completed');
    expect(recorder.actions.map((action) => action.name)).toEqual(['Notify']);
  });

  it('records the failure, closes the run and rethrows so the queue retries', async () => {
    const recorder = ports({ failOn: 'Notify' });
    await expect(executeWorkflow(linear, run(), recorder.ports)).rejects.toThrowError('action exploded');
    expect(recorder.finished).toEqual([{ status: 'failed', error: 'Notify: action exploded' }]);
    const failedStep = recorder.steps.find((step) => step.nodeId === 'a2' && step.status === 'failed');
    expect(failedStep?.error).toBe('action exploded');
    // The step before it succeeded and stays recorded, so the retry resumes rather than repeats.
    expect(recorder.steps.some((step) => step.nodeId === 'a1' && step.status === 'completed')).toBe(true);
  });

  it('stops between nodes when the run is cancelled', async () => {
    const recorder = ports({ shouldStop: async () => true });
    const result = await executeWorkflow(linear, run(), recorder.ports);
    expect(result.status).toBe('cancelled');
    expect(recorder.actions).toEqual([]);
    expect(recorder.finished).toEqual([{ status: 'cancelled' }]);
  });

  it('refuses to run a stored definition that no longer validates', async () => {
    const broken = { ...linear, nodes: [{ id: 'a1', type: 'action', name: 'Stamp', action: 'vanished', params: {} }] } as unknown as WorkflowDefinition;
    const recorder = ports();
    await expect(executeWorkflow(broken, run(), recorder.ports)).rejects.toThrowError(/not valid/);
    expect(recorder.actions).toEqual([]);
  });

  it('refuses to walk a definition containing a cycle', async () => {
    const cyclic = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'a1',
      nodes: [
        { id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'a2' },
        { id: 'a2', type: 'action', name: 'B', action: 'updateRecord', params: { fields: {} }, next: 'a1' },
      ],
    };
    const recorder = ports();
    await expect(executeWorkflow(cyclic as unknown as WorkflowDefinition, run(), recorder.ports)).rejects.toThrowError();
    expect(recorder.actions).toEqual([]);
  });

  it('evaluates a condition against the record with an injected clock', async () => {
    const definition: WorkflowDefinition = {
      trigger: { eventType: 'entity.created', entityType: 'Account' },
      start: 'c',
      nodes: [
        { id: 'c', type: 'condition', name: 'Due soon?', formula: 'diffDays(now(), timestampOf("2030-01-01")) < 0', then: 'e' },
        { id: 'e', type: 'end', name: 'End' },
      ],
    };
    const recorder = ports();
    const result = await executeWorkflow(definition, run(), recorder.ports, { now: new Date('2026-01-01T00:00:00.000Z') });
    expect(result.status).toBe('completed');
    expect(recorder.steps.find((step) => step.nodeId === 'c')?.output).toEqual({ matched: false });
  });

  it('passes the action node and its parameters straight to the port', async () => {
    const seen: ActionNode[] = [];
    const recorder = ports({
      runAction: async ({ node }) => {
        seen.push(node);
        return null;
      },
    });
    await executeWorkflow(linear, run(), recorder.ports);
    expect(seen[0]?.action).toBe('updateRecord');
    expect(seen[0]?.params).toEqual({ fields: { status: 'Active' } });
  });
});