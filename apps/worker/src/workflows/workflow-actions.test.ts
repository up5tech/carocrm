import type { Logger } from '@carocrm/core/logger/index.js';
import { WorkflowActionPendingError } from '@carocrm/workflow';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db.js';
import { createTestLogger } from '../testing/test-logger.js';
import type { ActionDeps } from './workflow-actions.js';
import { actionContextOf, runWorkflowAction, splitFields } from './workflow-actions.js';
import type { StoredRecord, WorkflowStore } from './workflow-store.js';

/**
 * Action tests (PLAN §35).
 *
 * The assertions here are about *shape*: which SQL an action issues and with which parameters. A
 * workflow is a promise that automation will touch data, so what it can write — and what it must
 * never write — is worth pinning down precisely.
 */

const NODE = {
  id: 'n1',
  type: 'action',
  name: 'Act',
  action: 'updateRecord',
  params: { fields: {} },
} as never;

const RUN = {
  runId: 'run1',
  workflowId: 'wf1',
  versionId: 'v1',
  entityType: 'Account',
  entityId: 'a1',
  userId: 'u1',
  record: {},
  attempt: 1,
};

const RECORD: StoredRecord = {
  id: 'a1',
  entityType: 'Account',
  attrs: { name: 'ACME', status: 'New' },
  assignedUserId: 'u2',
  createdById: 'u3',
};

function harness(rowCount = 1): { deps: ActionDeps; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db: Queryable = {
    query: async (sql, params) => {
      queries.push({ sql, params: [...(params ?? [])] });
      return { rows: [{ id: 'x' }], rowCount };
    },
  };
  const store = {} as WorkflowStore;
  return {
    queries,
    deps: {
      db,
      store,
      log: createTestLogger().log as unknown as Logger,
      enqueue: async (job, data) => {
        queries.push({ sql: `enqueue:${job}`, params: [JSON.stringify(data)] });
        return 'job-1';
      },
    },
  };
}

describe('splitFields', () => {
  it('separates ownership from attributes', () => {
    const split = splitFields({ status: 'Working', assignedUserId: 'u9' });
    expect(split.attrs).toEqual({ status: 'Working' });
    expect(split.assignedUserId).toBe('u9');
  });

  it('treats an empty assignment as unassigned', () => {
    expect(splitFields({ assignedUserId: '' }).assignedUserId).toBeNull();
  });

  it('refuses bookkeeping fields instead of writing a second, invisible copy', () => {
    expect(() => splitFields({ id: 'other' })).toThrowError(/managed by the platform/);
    expect(() => splitFields({ createdAt: '2020-01-01' })).toThrowError(/managed by the platform/);
    expect(() => splitFields({ teams: ['t1'] })).toThrowError(/managed by the platform/);
  });
});

describe('actionContextOf', () => {
  it('exposes the record plus its identity and owner', () => {
    expect(actionContextOf(RECORD, RUN)).toEqual({
      name: 'ACME',
      status: 'New',
      id: 'a1',
      entityId: 'a1',
      entityType: 'Account',
      userId: 'u1',
      assignedUserId: 'u2',
      createdById: 'u3',
    });
  });

  it('tolerates a record that no longer exists', () => {
    expect(actionContextOf(undefined, RUN)).toMatchObject({ id: 'a1', assignedUserId: null, createdById: null });
  });
});

describe('workflow actions', () => {
  it('patches attributes and assigns ownership through the physical column', async () => {
    const { deps, queries } = harness();
    const result = await runWorkflowAction(
      deps,
      RUN,
      { ...(NODE as never as { id: string; type: 'action'; name: string; action: string; params: Record<string, unknown> }), params: { fields: { status: 'Working', assignedUserId: 'u9' } } } as never,
      RECORD,
    );
    expect(result.summary).toContain('updated Account/a1');
    expect(queries[0]?.sql).toContain('attrs = attrs ||');
    expect(queries[0]?.params[2]).toBe('{"status":"Working"}');
    expect(queries[1]?.sql).toContain('assigned_user_id');
    expect(queries[1]?.params[2]).toBe('u9');
  });

  it('resolves placeholders from the triggering record', async () => {
    const { deps, queries } = harness();
    await runWorkflowAction(
      deps,
      RUN,
      { ...(NODE as never as object), action: 'updateRecord', params: { fields: { description: 'Account {{name}} ({{entityType}})' } } } as never,
      RECORD,
    );
    expect(queries[0]?.params[2]).toBe('{"description":"Account ACME (Account)"}');
  });

  it('does nothing when the patch has no writable fields', async () => {
    const { deps, queries } = harness();
    const result = await runWorkflowAction(deps, RUN, NODE, RECORD);
    expect(result.summary).toBe('no writable fields');
    expect(queries).toHaveLength(0);
  });

  it('fails when the triggering record has gone', async () => {
    const { deps } = harness(0);
    await expect(
      runWorkflowAction(deps, RUN, { ...(NODE as never as object), params: { fields: { status: 'x' } } } as never, RECORD),
    ).rejects.toThrowError(/no longer exists/);
  });

  it('creates a record with a generated name when none is given', async () => {
    const { deps, queries } = harness();
    const result = await runWorkflowAction(
      deps,
      RUN,
      { ...(NODE as never as object), action: 'createRecord', params: { entityType: 'Task', fields: { status: 'Planned' } } } as never,
      RECORD,
    );
    expect(result.summary).toContain('created Task/');
    expect(queries[0]?.sql).toContain('INSERT INTO entity_records');
    expect(queries[0]?.params[2]).toBe('Task from workflow');
  });

  it('fails a notification for a user that does not exist', async () => {
    const { deps } = harness(0);
    await expect(
      runWorkflowAction(deps, RUN, { ...(NODE as never as object), action: 'createNotification', params: { userId: 'ghost', message: 'hi' } } as never, RECORD),
    ).rejects.toThrowError(/no such active user/);
  });

  it('queues the platform send job for an email action', async () => {
    const { deps, queries } = harness();
    const result = await runWorkflowAction(
      deps,
      RUN,
      {
        ...(NODE as never as object),
        action: 'sendEmail',
        params: { to: '{{emailAddress}}', subject: 'Hello', body: 'Hi' },
      } as never,
      { ...RECORD, attrs: { name: 'ACME', emailAddress: 'owner@acme.test' } },
    );
    const email = queries.find((query) => query.sql.includes('INSERT INTO entity_records') && query.params[1] === 'Email');
    expect(email).toBeDefined();
    expect(String(email?.params[3])).toContain('owner@acme.test');
    expect(queries.some((query) => query.sql === 'enqueue:system.sendEmail')).toBe(true);
    expect(result.summary).toContain('owner@acme.test');
  });

  it('queues an arbitrary registered job', async () => {
    const { deps, queries } = harness();
    const result = await runWorkflowAction(
      deps,
      RUN,
      { ...(NODE as never as object), action: 'runJob', params: { jobName: 'system.cleanupOutbox' } } as never,
      RECORD,
    );
    expect(result.summary).toBe('queued system.cleanupOutbox');
    expect(queries.at(-1)?.sql).toBe('enqueue:system.cleanupOutbox');
  });

  it('refuses an action this build does not implement', async () => {
    const { deps } = harness();
    await expect(
      runWorkflowAction(deps, RUN, { ...(NODE as never as object), action: 'dropEverything' } as never, RECORD),
    ).rejects.toThrowError(/no implementation in this worker build/);
  });
});

describe('runAgent workflow action', () => {
  const AGENT_ID = '11111111-2222-4333-8444-555555555555';
  const AI_NODE = {
    id: 'ai1',
    type: 'action',
    name: 'Classify',
    action: 'runAgent',
    params: { agentId: AGENT_ID, task: 'Summarize {{name}}', outputMapping: { fields: { description: 'data.summary' } } },
  } as never;

  function aiHarness(body: Record<string, unknown>, status = 200) {
    const base = harness();
    const calls: { url: string; init: RequestInit }[] = [];
    const deps: ActionDeps = {
      ...base.deps,
      workflowAI: {
        apiBaseUrl: 'http://api.test/',
        secret: 'worker-secret',
        fetcher: async (url, init) => {
          calls.push({ url: String(url), init: init as RequestInit });
          return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        },
      },
    };
    return { ...base, deps, calls };
  }

  it('parks the workflow instead of faking a result while the agent run is active', async () => {
    const { deps, calls } = aiHarness({ runId: 'agent-run-1', status: 'running', pending: true });
    let caught: unknown;
    try {
      await runWorkflowAction(deps, RUN, AI_NODE, RECORD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowActionPendingError);
    expect((caught as WorkflowActionPendingError).detail).toEqual({ agentRunId: 'agent-run-1', workflowNodeId: 'ai1' });
    expect(calls[0]?.url).toBe('http://api.test/api/v1/AIAgents/action/worker/workflow/run');
    expect(calls[0]?.init.headers).toMatchObject({ 'x-worker-secret': 'worker-secret' });
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent['idempotencyKey']).toBe('wf:run1:ai1');
    expect(sent['task']).toBe('Summarize ACME');
    expect(sent['workflow']).toMatchObject({ workflowRunId: 'run1', nodeId: 'ai1', entityType: 'Account' });
  });

  it('maps only validated fields onto the triggering record', async () => {
    const { deps, queries } = aiHarness({
      runId: 'agent-run-1',
      status: 'succeeded',
      fields: { description: 'a short summary' },
    });
    const result = await runWorkflowAction(deps, RUN, AI_NODE, RECORD);
    expect(result.summary).toContain('agent-run-1');
    const patch = queries.find((query) => query.sql.includes('attrs = attrs ||'));
    expect(patch?.params[0]).toBe('a1');
    expect(patch?.params[2]).toBe('{"description":"a short summary"}');
  });

  it('refuses to invent agent runs when no worker capability is configured', async () => {
    const { deps } = harness();
    await expect(runWorkflowAction(deps, RUN, AI_NODE, RECORD)).rejects.toThrowError(/no worker capability/);
  });

  it('surfaces a failed agent run as a failed workflow action', async () => {
    const { deps } = aiHarness({
      runId: 'agent-run-1',
      status: 'failed',
      failure: { category: 'invalid_output', message: 'bad schema' },
    });
    await expect(runWorkflowAction(deps, RUN, AI_NODE, RECORD)).rejects.toThrowError(/runAgent failed: agent run agent-run-1 failed: bad schema/);
  });
});