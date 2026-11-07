import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-AI.21 — the self-approval policy
 * (`plans/PLAN_Phase_19_AI_Agents.md` §24, `19-AI.21`).
 *
 * The audit that produced §24 found no broken rule in §9.2 — it found an **unwritten** one: nobody
 * had decided whether a human may approve the proposal they themselves requested. This suite holds
 * the decision the module now enforces:
 *
 *  - `forbidden` (the default): the requester of a `material_write` / `high_impact` proposal may not
 *    approve it. The refusal is a 403 with the stable code `AI_APPROVAL_SELF_APPROVAL_FORBIDDEN`, it
 *    decides nothing, and the proposal stays open for somebody else.
 *  - `permitted_with_audit`: the requester's own signature is **recorded** — on the approval row and
 *    in the run timeline — but it does not make the action executable. A second approver has to sign;
 *    until then the run stays in `waiting_for_approval`.
 *
 * Rejecting one's own proposal stays allowed: refusing an action is the safe direction.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every record carries the run marker
 * and is removed by exact id in `afterAll`; nothing is truncated or recreated. Model calls use the
 * deterministic fake adapter — no billable API, no network. The instance settings row is restored to
 * the baseline it had before this suite ran.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_selfapproval_${runId}`;
const ROLE_REQUESTER = `AGENT_TEST-selfapp-requester-${runId}`;
const ROLE_APPROVER = `AGENT_TEST-selfapp-approver-${runId}`;
const USER_REQUESTER = `AGENT_TEST-selfapp-requester-user-${runId}`;
const USER_APPROVER = `AGENT_TEST-selfapp-approver-user-${runId}`;
const PROVIDER_KEY = `agent-test-selfapp-${runId}`;

let ctx: ApiContext;
let requesterToken = '';
let approverToken = '';
let agentId = '';
let baselineSettings: unknown = null;
const createdUserIds: string[] = [];
const entityIds: string[] = [];
const runIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function baseConfig(): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Follow the task and use tools carefully.' },
    input: { mode: 'text' },
    tools: [{ key: 'crm_update_record_fields' }],
    limits: {
      maxSteps: 6,
      maxModelCalls: 6,
      maxToolCalls: 4,
      maxTokens: 12_000,
      maxCostUsd: 0.5,
      maxElapsedSeconds: 60,
      maxRetries: 0,
      maxOutputTokens: 1_024,
      temperature: 0.2,
    },
    output: { mode: 'text' },
    memory: { mode: 'none' },
    triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

async function setPolicy(policy: 'forbidden' | 'permitted_with_audit'): Promise<void> {
  const result = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    approval: { selfApprovalPolicy: policy },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function createTask(name: string): Promise<string> {
  const created = await call('POST', '/api/v1/Task', ctx.adminToken, { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  entityIds.push(id);
  return id;
}

/** The requester starts the run and drives it to the approval wait. */
async function startRun(taskId: string): Promise<string> {
  const created = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, requesterToken, {
    input: {
      text:
        `__FAKE_TOOL__:crm_update_record_fields __FAKE_TOOL_ARGS__:` +
        `{"entity":"Task","id":"${taskId}","fields":{"description":"${MARKER} written"}}`,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  runIds.push(id);
  const waiting = await call('POST', `/api/v1/AIAgents/action/runs/${id}/execute`, ctx.adminToken, {});
  expect((waiting.body['run'] as { status: string }).status).toBe('waiting_for_approval');
  return id;
}

async function pendingApproval(id: string): Promise<{ id: string }> {
  const inbox = await call('GET', '/api/v1/AIAgents/action/approvals?status=pending', ctx.adminToken);
  expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
  const approval = (inbox.body['list'] as { id: string; runId: string }[]).find((entry) => entry.runId === id);
  if (approval === undefined) throw new Error(`no pending approval for run ${id}`);
  return approval;
}

beforeAll(async () => {
  ctx = await bootApi();

  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'aiAgents').execute();
  baselineSettings = rows[0]?.data ?? null;

  // The requester runs agents, owns the record the proposal writes to — and holds the approval
  // capability, so the policy is what refuses them, not a missing right.
  await createTestRole(ctx, {
    id: ROLE_REQUESTER,
    name: `${MARKER} requester`,
    permissions: {
      AIAgent: { read: 'yes' },
      AIAgentApproval: { edit: 'yes' },
      Task: { read: 'all', edit: 'all', create: 'all' },
    },
  });
  // The second approver reviews proposals. It needs no record rights: the decision path reads the
  // target's version, not the record's content, and the write itself runs as the requester.
  await createTestRole(ctx, {
    id: ROLE_APPROVER,
    name: `${MARKER} approver`,
    permissions: {
      AIAgent: { read: 'yes' },
      AIAgentApproval: { edit: 'yes' },
    },
  });
  const requester = await createTestUser(ctx, { userName: USER_REQUESTER, roleIds: [ROLE_REQUESTER] });
  const approver = await createTestUser(ctx, { userName: USER_APPROVER, roleIds: [ROLE_APPROVER] });
  requesterToken = requester.token;
  approverToken = approver.token;
  createdUserIds.push(requester.id, approver.id);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: `agent-test-selfapp-${runId}`,
    name: `${MARKER} agent`,
    visibility: 'organization',
    config: baseConfig(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agentId = String(created.body['id']);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (runIds.length > 0) {
    for (const id of runIds) {
      await db
        .deleteFrom('jobs')
        .where('job', '=', 'aiAgents.executeRun')
        .where(sql`target::text like ${`%${id}%`}`)
        .execute();
    }
    await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agents').where('id', '=', agentId).execute();
  if (entityIds.length > 0) {
    await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  }
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'aiAgents').execute();
  } else {
    const serialized = JSON.stringify(baselineSettings);
    await db
      .insertInto('app_settings')
      .values({ name: 'aiAgents', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  await db
    .updateTable('app_settings')
    .set({
      data: sql`jsonb_set(data, '{settings,provider,defaultKey}', '""'::jsonb)`,
      modified_at: new Date(),
    })
    .where('name', '=', 'aiAgents')
    .where(sql`data->'settings'->'provider'->>'defaultKey'`, '=', PROVIDER_KEY)
    .execute();
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_REQUESTER, ROLE_APPROVER]).execute();
  await shutdownApi();
});

describe('self-approval policy (19-AI.21)', () => {
  it('refuses the requester their own material write and decides nothing', async () => {
    await setPolicy('forbidden');
    const taskId = await createTask(`${MARKER} own approval`);
    const run = await startRun(taskId);
    const approval = await pendingApproval(run);

    const refused = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, requesterToken, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused)).toBe('AI_APPROVAL_SELF_APPROVAL_FORBIDDEN');

    // Nothing was decided: the proposal is still open for somebody else.
    const view = await call('GET', `/api/v1/AIAgents/action/approvals/${approval.id}`, ctx.adminToken);
    expect(view.body['status']).toBe('pending');
    expect(view.body['decidedByUserId']).toBeNull();
    expect(view.body['awaitingSecondApproval']).toBe(false);

    const runView = await call('GET', `/api/v1/AIAgents/action/runs/${run}`, ctx.adminToken);
    expect(runView.body['status']).toBe('waiting_for_approval');

    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(task.body['description'] ?? '')).not.toContain(MARKER);
  });

  it('lets a second approver sign the proposal, and the write runs exactly once', async () => {
    await setPolicy('forbidden');
    const taskId = await createTask(`${MARKER} second approver`);
    const run = await startRun(taskId);
    const approval = await pendingApproval(run);

    const approved = await call(
      'POST',
      `/api/v1/AIAgents/action/approvals/${approval.id}/approve`,
      approverToken,
      { note: 'Reviewed by a second approver.' },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body['approval'] as { status: string }).status).toBe('approved');

    const executed = await call('POST', `/api/v1/AIAgents/action/runs/${run}/execute`, ctx.adminToken, {});
    expect((executed.body['run'] as { status: string }).status).toBe('succeeded');

    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(task.body['description'] ?? '')).toContain(MARKER);

    const calls = await call('GET', `/api/v1/AIAgents/action/runs/${run}/toolCalls`, ctx.adminToken);
    const succeeded = (calls.body['list'] as { status: string }[]).filter((entry) => entry.status === 'succeeded');
    expect(succeeded.length).toBe(1);
  });

  it('records the requester signature in permissive mode and still needs a second approver', async () => {
    await setPolicy('permitted_with_audit');
    const taskId = await createTask(`${MARKER} permissive`);
    const run = await startRun(taskId);
    const approval = await pendingApproval(run);

    const first = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, requesterToken, {
      note: 'I checked it myself.',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(errorCode(first)).toBe('AI_APPROVAL_SECOND_APPROVER_REQUIRED');

    const view = await call('GET', `/api/v1/AIAgents/action/approvals/${approval.id}`, ctx.adminToken);
    expect(view.body['status']).toBe('pending');
    expect(view.body['decidedByUserId']).toBeNull();
    expect(view.body['awaitingSecondApproval']).toBe(true);

    // Asking again does not complete the requester's own proposal.
    const again = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, requesterToken, {});
    expect(again.status).toBe(403);
    expect(errorCode(again)).toBe('AI_APPROVAL_SECOND_APPROVER_REQUIRED');

    const waiting = await call('GET', `/api/v1/AIAgents/action/runs/${run}`, ctx.adminToken);
    expect(waiting.body['status']).toBe('waiting_for_approval');
    const untouched = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(untouched.body['description'] ?? '')).not.toContain(MARKER);

    // The first signature is in the audit trail.
    const events = await call('GET', `/api/v1/AIAgents/action/runs/${run}/events`, ctx.adminToken);
    const timeline = events.body['list'] as { type: string }[];
    expect(timeline.some((event) => event.type === 'approval.self_signed')).toBe(true);

    // A second approver completes it.
    const second = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, approverToken, {
      note: 'Second signature.',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const executed = await call('POST', `/api/v1/AIAgents/action/runs/${run}/execute`, ctx.adminToken, {});
    expect((executed.body['run'] as { status: string }).status).toBe('succeeded');
    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(task.body['description'] ?? '')).toContain(MARKER);
    const calls = await call('GET', `/api/v1/AIAgents/action/runs/${run}/toolCalls`, ctx.adminToken);
    const succeeded = (calls.body['list'] as { status: string }[]).filter((entry) => entry.status === 'succeeded');
    expect(succeeded.length).toBe(1);
  });

  it('lets the requester reject their own proposal', async () => {
    await setPolicy('forbidden');
    const taskId = await createTask(`${MARKER} self reject`);
    const run = await startRun(taskId);
    const approval = await pendingApproval(run);

    const rejected = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/reject`, requesterToken, {
      note: 'Not needed.',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((rejected.body['approval'] as { status: string }).status).toBe('rejected');

    const runView = await call('GET', `/api/v1/AIAgents/action/runs/${run}`, ctx.adminToken);
    expect(runView.body['status']).toBe('canceled');
    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(task.body['description'] ?? '')).not.toContain(MARKER);
  });

  it('still refuses an approval whose target changed before the second signature', async () => {
    await setPolicy('forbidden');
    const taskId = await createTask(`${MARKER} stale before signature`);
    const run = await startRun(taskId);
    const approval = await pendingApproval(run);

    // A person edits the record after the proposal was shown.
    const edited = await call('PATCH', `/api/v1/Task/${taskId}`, ctx.adminToken, {
      description: `${MARKER} human edit`,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const refused = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, approverToken, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('changed after the proposal');

    const view = await call('GET', `/api/v1/AIAgents/action/approvals/${approval.id}`, ctx.adminToken);
    expect(view.body['status']).toBe('invalidated');
    const runView = await call('GET', `/api/v1/AIAgents/action/runs/${run}`, ctx.adminToken);
    expect(runView.body['status']).toBe('blocked_by_policy');
    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(String(task.body['description'] ?? '')).toContain('human edit');
  });
});
