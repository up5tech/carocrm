import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-AI.5–19-AI.10 — definitions, versions, tools, runs and approvals
 * (PLAN_Phase_19_AI_Agents.md §18, §20 `19-AI.5`–`19-AI.10`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row carries the run marker,
 * is created through the public API, and is removed by exact id in `afterAll`; nothing is truncated
 * or recreated. Model calls use the deterministic fake adapter — no billable API, no network.
 *
 * The job queue is the scratch `crm-jobs-test` queue from the boot helper, so an enqueued run is
 * never picked up by a real worker; the tests drive `.../execute` explicitly, which is the same door
 * the worker uses.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_${runId}`;
const ROLE_USE = `AGENT_TEST-ai5-use-${runId}`;
const ROLE_EDIT = `AGENT_TEST-ai5-edit-${runId}`;
const USER_USE = `AGENT_TEST-ai5-use-user-${runId}`;
const USER_EDIT = `AGENT_TEST-ai5-edit-user-${runId}`;
const PROVIDER_KEY = `agent-test-ai5-${runId}`;

let ctx: ApiContext;
let useToken = '';
let editToken = '';
let baselineSettings: unknown = null;
const createdUserIds: string[] = [];
const agentKeys: string[] = [];
const entityIds: string[] = [];
const runIds: string[] = [];
let taskId = '';

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

let agentCounter = 0;

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Follow the task and use tools carefully.' },
    input: { mode: 'text' },
    tools: [{ key: 'crm_search_records' }],
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
    ...overrides,
  };
}

async function createAgent(options: {
  readonly suffix: string;
  readonly visibility?: 'private' | 'team' | 'organization';
  readonly config?: Record<string, unknown>;
}): Promise<{ id: string; key: string }> {
  agentCounter += 1;
  const key = `agent-test-${runId}-${String(agentCounter)}-${options.suffix}`;
  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key,
    name: `${MARKER} agent ${options.suffix}`,
    visibility: options.visibility ?? 'organization',
    config: options.config ?? baseConfig(),
  });
  expect(created.status).toBe(201);
  agentKeys.push(key);
  return { id: String(created.body['id']), key };
}

async function publish(id: string): Promise<CallResult> {
  return call('POST', `/api/v1/AIAgents/action/agents/${id}/publish`, ctx.adminToken, {});
}

async function createRecord(entity: 'Account' | 'Task', name: string): Promise<string> {
  const created = await call('POST', `/api/v1/${entity}`, ctx.adminToken, { name });
  expect(created.status).toBe(201);
  const id = String(created.body['id']);
  entityIds.push(id);
  return id;
}

async function runAgent(agentId: string, text: string): Promise<CallResult> {
  const created = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, ctx.adminToken, {
    input: { text },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (created.status === 201) runIds.push(String(created.body['id']));
  return created;
}

async function executeRun(id: string): Promise<CallResult> {
  return call('POST', `/api/v1/AIAgents/action/runs/${id}/execute`, ctx.adminToken, {});
}

beforeAll(async () => {
  ctx = await bootApi();

  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'aiAgents').execute();
  baselineSettings = rows[0]?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_USE,
    name: `${MARKER} AI use`,
    permissions: { AIAgent: { read: 'yes' } },
  });
  await createTestRole(ctx, {
    id: ROLE_EDIT,
    name: `${MARKER} AI edit`,
    permissions: { AIAgent: { read: 'yes', edit: 'yes' } },
  });
  const useUser = await createTestUser(ctx, { userName: USER_USE, roleIds: [ROLE_USE] });
  const editUser = await createTestUser(ctx, { userName: USER_EDIT, roleIds: [ROLE_EDIT] });
  useToken = useUser.token;
  editToken = editUser.token;
  createdUserIds.push(useUser.id, editUser.id);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status).toBe(201);

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status).toBe(200);

  await createRecord('Account', `${MARKER} Acme`);
  taskId = await createRecord('Task', `${MARKER} task`);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (runIds.length > 0) {
    // Only the jobs this test run enqueued; the payload names the run id.
    for (const id of runIds) {
      await db
        .deleteFrom('jobs')
        .where('job', '=', 'aiAgents.executeRun')
        .where(sql`target::text like ${`%${id}%`}`)
        .execute();
    }
    await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  }
  await db.deleteFrom('ai_agent_runs').where('idempotency_key', 'like', `%${MARKER}%`).execute();
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agents').where('agent_key', 'like', `agent-test-${runId}-%`).execute();
  if (entityIds.length > 0) await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
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
  // A crashed earlier run could have captured this suite's provider key as its baseline. Clearing
  // only that exact value keeps a dangling default from outliving the connection it named.
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
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USE, ROLE_EDIT]).execute();
  await shutdownApi();
});

describe('agent definitions and versions (19-AI.5)', () => {
  it('creates a draft, validates it, publishes an immutable version and keeps old versions intact', async () => {
    const { id } = await createAgent({ suffix: 'lifecycle' });

    const draft = await call('GET', `/api/v1/AIAgents/action/agents/${id}`, ctx.adminToken);
    expect(draft.status).toBe(200);
    expect(draft.body['status']).toBe('draft');
    expect(draft.body['currentVersion']).toBeNull();
    const tools = draft.body['tools'] as { key: string; effectClass: string }[];
    expect(tools[0]?.key).toBe('crm_search_records');
    expect(tools[0]?.effectClass).toBe('read');

    const report = await call('GET', `/api/v1/AIAgents/action/agents/${id}/validate`, ctx.adminToken);
    expect(report.status).toBe(200);
    expect(report.body['ok']).toBe(true);

    const published = await publish(id);
    expect(published.status).toBe(200);
    const version = published.body['version'] as { version: number; checksum: string; providerKey: string };
    expect(version.version).toBe(1);
    expect(version.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(version.providerKey).toBe(PROVIDER_KEY);
    expect((published.body['agent'] as { status: string }).status).toBe('published');

    const changed = await call('PATCH', `/api/v1/AIAgents/action/agents/${id}`, ctx.adminToken, {
      config: baseConfig({ prompt: { system: 'You are the second revision of the test agent.' } }),
    });
    expect(changed.status).toBe(200);
    expect(changed.body['hasUnpublishedChanges']).toBe(true);

    const second = await publish(id);
    expect(second.status).toBe(200);
    expect((second.body['version'] as { version: number }).version).toBe(2);

    const firstVersion = await call('GET', `/api/v1/AIAgents/action/agents/${id}/versions/1`, ctx.adminToken);
    expect(firstVersion.status).toBe(200);
    const firstConfig = firstVersion.body['config'] as { prompt: { system: string } };
    expect(firstConfig.prompt.system).toBe('You are a test agent. Follow the task and use tools carefully.');
    expect(firstVersion.body['checksum']).toBe(version.checksum);

    const versions = await call('GET', `/api/v1/AIAgents/action/agents/${id}/versions`, ctx.adminToken);
    expect((versions.body['list'] as unknown[]).length).toBe(2);
  });

  it('rejects unbounded configuration and a second publish with no changes', async () => {
    const { id } = await createAgent({ suffix: 'bounds' });
    const tooBig = await call('PATCH', `/api/v1/AIAgents/action/agents/${id}`, ctx.adminToken, {
      config: baseConfig({
        limits: {
          maxSteps: 99,
          maxModelCalls: 6,
          maxToolCalls: 4,
          maxTokens: 12_000,
          maxCostUsd: 0.5,
          maxElapsedSeconds: 60,
          maxRetries: 0,
          maxOutputTokens: 1_024,
          temperature: 0.2,
        },
      }),
    });
    expect(tooBig.status).toBe(422);
    expect(errorCode(tooBig)).toBe('VALIDATION_FAILED');

    const unknownTool = await call('PATCH', `/api/v1/AIAgents/action/agents/${id}`, ctx.adminToken, {
      config: baseConfig({ tools: [{ key: 'crm_drop_all_tables' }] }),
    });
    expect(unknownTool.status).toBe(200); // the shape is valid; publication is what refuses an unknown tool

    const blocked = await publish(id);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);

    const restored = await call('PATCH', `/api/v1/AIAgents/action/agents/${id}`, ctx.adminToken, {
      config: baseConfig(),
    });
    expect(restored.status).toBe(200);
    expect((await publish(id)).status).toBe(200);
    const again = await publish(id);
    expect(again.status, JSON.stringify(again.body)).toBe(422);
  });

  it('enforces pause, resume, archive and restore-to-draft without mutating a version', async () => {
    const { id } = await createAgent({ suffix: 'states' });
    expect((await publish(id)).status).toBe(200);

    expect((await call('POST', `/api/v1/AIAgents/action/agents/${id}/pause`, ctx.adminToken, {})).status).toBe(200);
    const paused = await call('POST', `/api/v1/AIAgents/action/agents/${id}/runs`, ctx.adminToken, {
      input: { text: 'hello' },
    });
    expect(paused.status).toBe(422);

    expect((await call('POST', `/api/v1/AIAgents/action/agents/${id}/resume`, ctx.adminToken, {})).status).toBe(200);
    expect((await call('POST', `/api/v1/AIAgents/action/agents/${id}/archive`, ctx.adminToken, {})).status).toBe(200);

    const archivedRun = await call('POST', `/api/v1/AIAgents/action/agents/${id}/runs`, ctx.adminToken, {
      input: { text: 'hello' },
    });
    expect(archivedRun.status).toBe(422);

    const restored = await call('POST', `/api/v1/AIAgents/action/agents/${id}/restore`, ctx.adminToken, {});
    expect(restored.status).toBe(200);
    expect(restored.body['status']).toBe('draft');
    const versions = await call('GET', `/api/v1/AIAgents/action/agents/${id}/versions`, ctx.adminToken);
    expect((versions.body['list'] as unknown[]).length).toBe(1);
  });

  it('hides a private agent from another user and refuses an edit without ownership', async () => {
    const { id } = await createAgent({ suffix: 'private', visibility: 'private' });
    expect((await call('GET', `/api/v1/AIAgents/action/agents/${id}`, useToken)).status).toBe(404);
    expect((await call('POST', `/api/v1/AIAgents/action/agents/${id}/runs`, useToken, { input: { text: 'x' } })).status).toBe(404);

    const shared = await createAgent({ suffix: 'shared', visibility: 'organization' });
    expect((await call('GET', `/api/v1/AIAgents/action/agents/${shared.id}`, useToken)).status).toBe(200);
    expect(
      (
        await call('PATCH', `/api/v1/AIAgents/action/agents/${shared.id}`, useToken, {
          config: baseConfig(),
        })
      ).status,
    ).toBe(403);
    expect((await call('PATCH', `/api/v1/AIAgents/action/agents/${shared.id}`, editToken, { name: 'x' })).status).toBe(422);
    expect(
      (await call('POST', `/api/v1/AIAgents/action/agents/${shared.id}/publish`, editToken, {})).status,
    ).toBe(403);
  });

  it('exposes the reviewed read-only template and the tool catalogue', async () => {
    const templates = await call('GET', '/api/v1/AIAgents/action/templates', ctx.adminToken);
    expect(templates.status).toBe(200);
    const list = templates.body['list'] as { key: string; config: { provider?: unknown } }[];
    expect(list[0]?.key).toBe('account-briefing');
    expect(list[0]?.config.provider).toBeUndefined();

    const tools = await call('GET', '/api/v1/AIAgents/action/tools', ctx.adminToken);
    expect(tools.status).toBe(200);
    const catalogue = tools.body['tools'] as { key: string; effectClass: string; enabled: boolean }[];
    expect(catalogue.some((tool) => tool.key === 'crm_read_record' && tool.effectClass === 'read')).toBe(true);
    expect(catalogue.some((tool) => tool.key === 'crm_update_record_fields' && tool.effectClass === 'material_write')).toBe(true);
  });
});

describe('read-only run end to end (19-AI.6–19-AI.9)', () => {
  it('executes a bounded read tool under the starter ACL and records a traceable run', async () => {
    const { id } = await createAgent({ suffix: 'read-run' });
    expect((await publish(id)).status).toBe(200);

    const created = await runAgent(
      id,
      `Find accounts. __FAKE_TOOL__:crm_search_records __FAKE_TOOL_ARGS__:{"entity":"Account","criteria":[{"field":"name","operator":"contains","value":"${MARKER}"}],"maxSize":3}`,
    );
    expect(created.status).toBe(201);
    expect(created.body['status']).toBe('queued');
    const idRun = String(created.body['id']);

    const executed = await executeRun(idRun);
    expect(executed.status).toBe(200);
    const run = executed.body['run'] as {
      status: string;
      counters: { toolCalls: number; modelCalls: number; steps: number };
      result: { format: string; text: string };
    };
    expect(run.status).toBe('succeeded');
    expect(run.counters.toolCalls).toBe(1);
    expect(run.counters.modelCalls).toBe(2);
    expect(run.result.format).toBe('text');

    const toolCalls = await call('GET', `/api/v1/AIAgents/action/runs/${idRun}/toolCalls`, ctx.adminToken);
    const calls = toolCalls.body['list'] as { toolKey: string; status: string; summary: string | null }[];
    expect(calls[0]?.toolKey).toBe('crm_search_records');
    expect(calls[0]?.status).toBe('succeeded');
    expect(calls[0]?.summary).toContain('Found');

    const events = await call('GET', `/api/v1/AIAgents/action/runs/${idRun}/events`, ctx.adminToken);
    const types = (events.body['list'] as { type: string }[]).map((event) => event.type);
    expect(types).toContain('run.queued');
    expect(types).toContain('model.completed');
    expect(types).toContain('tool.succeeded');
    expect(types).toContain('run.completed');

    // A second execution of a terminal run is a no-op, not a second model call.
    const replay = await executeRun(idRun);
    expect((replay.body['run'] as { status: string }).status).toBe('succeeded');
    expect((replay.body['run'] as { counters: { modelCalls: number } }).counters.modelCalls).toBe(2);
  });

  it('refuses to run a read tool when the starter cannot read the entity', async () => {
    const { id } = await createAgent({ suffix: 'acl-run' });
    expect((await publish(id)).status).toBe(200);
    // The use role holds AIAgent:read only; it has no Account permission at all.
    const created = await call('POST', `/api/v1/AIAgents/action/agents/${id}/runs`, useToken, {
      input: {
        text: `__FAKE_TOOL__:crm_search_records __FAKE_TOOL_ARGS__:{"entity":"Account","maxSize":3}`,
      },
    });
    expect(created.status).toBe(201);
    const idRun = String(created.body['id']);
    runIds.push(idRun);

    const executed = await call('POST', `/api/v1/AIAgents/action/runs/${idRun}/execute`, useToken, {});
    expect(executed.status).toBe(200);
    expect((executed.body['run'] as { status: string }).status).toBe('succeeded');

    const toolCalls = await call('GET', `/api/v1/AIAgents/action/runs/${idRun}/toolCalls`, useToken);
    const calls = toolCalls.body['list'] as { status: string; summary: string | null }[];
    expect(calls[0]?.status).toBe('failed');
    expect(JSON.stringify(toolCalls.body)).not.toContain('AGENT_TEST');
  });

  it('records a retryable provider failure as a failed run, not a fabricated answer', async () => {
    const { id } = await createAgent({ suffix: 'failure' });
    expect((await publish(id)).status).toBe(200);
    const created = await runAgent(id, '__FAKE_ERROR__:rate_limit');
    expect(created.status).toBe(201);
    const idRun = String(created.body['id']);
    const executed = await executeRun(idRun);
    const run = executed.body['run'] as { status: string; failureCategory: string | null };
    expect(run.status).toBe('failed');
    expect(run.failureCategory).toBe('rate_limit');
  });

  it('cancels a queued run without executing it', async () => {
    const { id } = await createAgent({ suffix: 'cancel' });
    expect((await publish(id)).status).toBe(200);
    const created = await runAgent(id, 'do nothing');
    const idRun = String(created.body['id']);
    const canceled = await call('POST', `/api/v1/AIAgents/action/runs/${idRun}/cancel`, ctx.adminToken, {});
    expect(canceled.status).toBe(200);
    expect((canceled.body['status'] as string)).toBe('canceled');
    const executed = await executeRun(idRun);
    expect((executed.body['run'] as { status: string }).status).toBe('canceled');
  });
});

describe('approval service and low-risk writes (19-AI.10)', () => {
  it('pauses a material write, executes only after approval, and never duplicates it', async () => {
    const { id } = await createAgent({
      suffix: 'approval',
      config: baseConfig({ tools: [{ key: 'crm_update_record_fields' }] }),
    });
    expect((await publish(id)).status).toBe(200);

    const created = await runAgent(
      id,
      `__FAKE_TOOL__:crm_update_record_fields __FAKE_TOOL_ARGS__:{"entity":"Task","id":"${taskId}","fields":{"description":"${MARKER} updated by agent"}}`,
    );
    expect(created.status).toBe(201);
    const idRun = String(created.body['id']);

    const waiting = await executeRun(idRun);
    expect((waiting.body['run'] as { status: string }).status).toBe('waiting_for_approval');

    const inbox = await call('GET', '/api/v1/AIAgents/action/approvals?status=pending', ctx.adminToken);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const approvals = inbox.body['list'] as { id: string; runId: string; toolKey: string; actionClass: string }[];
    const approval = approvals.find((entry) => entry.runId === idRun);
    expect(approval?.toolKey).toBe('crm_update_record_fields');
    expect(approval?.actionClass).toBe('material_write');
    if (approval === undefined) throw new Error('approval not found');

    // The approval inbox is a capability, not something owning the run grants.
    expect((await call('GET', '/api/v1/AIAgents/action/approvals', useToken)).status).toBe(403);

    const approved = await call(
      'POST',
      `/api/v1/AIAgents/action/approvals/${approval.id}/approve`,
      ctx.adminToken,
      { note: 'Reviewed the proposed task description.' },
    );
    expect(approved.status).toBe(200);
    const view = approved.body['approval'] as { status: string; selfApproval: boolean; decidedByUserId: string | null };
    expect(view.status).toBe('approved');
    expect(view.decidedByUserId).not.toBeNull();

    const resumed = await executeRun(idRun);
    expect((resumed.body['run'] as { status: string }).status).toBe('succeeded');

    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(task.body['description']).toBe(`${MARKER} updated by agent`);

    const after = await call('GET', `/api/v1/AIAgents/action/approvals/${approval.id}`, ctx.adminToken);
    expect(after.body['status']).toBe('executed');
    expect((after.body['revalidation'] as { ok: boolean }).ok).toBe(true);

    // A replay cannot decide twice or execute twice.
    expect((await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, ctx.adminToken, {})).status).toBe(422);
    const replay = await executeRun(idRun);
    expect((replay.body['run'] as { status: string }).status).toBe('succeeded');

    const calls = await call('GET', `/api/v1/AIAgents/action/runs/${idRun}/toolCalls`, ctx.adminToken);
    const succeeded = (calls.body['list'] as { status: string }[]).filter((entry) => entry.status === 'succeeded');
    expect(succeeded.length).toBe(1);
  });

  it('rejects a proposal and ends the run without changing the record', async () => {
    const { id } = await createAgent({
      suffix: 'reject',
      config: baseConfig({ tools: [{ key: 'crm_update_record_fields' }] }),
    });
    expect((await publish(id)).status).toBe(200);
    const created = await runAgent(
      id,
      `__FAKE_TOOL__:crm_update_record_fields __FAKE_TOOL_ARGS__:{"entity":"Task","id":"${taskId}","fields":{"description":"${MARKER} rejected change"}}`,
    );
    const idRun = String(created.body['id']);
    await executeRun(idRun);

    const inbox = await call('GET', `/api/v1/AIAgents/action/approvals?status=pending`, ctx.adminToken);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const approval = (inbox.body['list'] as { id: string; runId: string }[]).find((entry) => entry.runId === idRun);
    if (approval === undefined) throw new Error('approval not found');

    const rejected = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/reject`, ctx.adminToken, {
      note: 'No.',
    });
    expect(rejected.status).toBe(200);
    expect((rejected.body['approval'] as { status: string }).status).toBe('rejected');

    const run = await call('GET', `/api/v1/AIAgents/action/runs/${idRun}`, ctx.adminToken);
    expect(run.body['status']).toBe('canceled');

    const task = await call('GET', `/api/v1/Task/${taskId}`, ctx.adminToken);
    expect(task.body['description']).not.toContain('rejected change');
  });

  it('invalidates an approval whose target disappeared before execution', async () => {
    const { id } = await createAgent({
      suffix: 'stale',
      config: baseConfig({ tools: [{ key: 'crm_update_record_fields' }] }),
    });
    expect((await publish(id)).status).toBe(200);
    const otherTaskId = await createRecord('Task', `${MARKER} soon removed`);
    const created = await runAgent(
      id,
      `__FAKE_TOOL__:crm_update_record_fields __FAKE_TOOL_ARGS__:{"entity":"Task","id":"${otherTaskId}","fields":{"description":"${MARKER} stale"}}`,
    );
    const idRun = String(created.body['id']);
    await executeRun(idRun);

    const inbox = await call('GET', `/api/v1/AIAgents/action/approvals?status=pending`, ctx.adminToken);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const approval = (inbox.body['list'] as { id: string; runId: string }[]).find((entry) => entry.runId === idRun);
    if (approval === undefined) throw new Error('approval not found');

    // Remove the target after the proposal was made, then approve and try to execute.
    await call('DELETE', `/api/v1/Task/${otherTaskId}`, ctx.adminToken);
    const approved = await call('POST', `/api/v1/AIAgents/action/approvals/${approval.id}/approve`, ctx.adminToken, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const executed = await executeRun(idRun);
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    const run = executed.body['run'] as { status: string; failureCategory: string | null };
    expect(run.status).toBe('failed');
    expect(run.failureCategory).toBe('approval_invalidated');

    const after = await call('GET', `/api/v1/AIAgents/action/approvals/${approval.id}`, ctx.adminToken);
    expect(after.body['status']).toBe('invalidated');
  });

  it('reports usage from the run and provider ledgers', async () => {
    const usage = await call('GET', '/api/v1/AIAgents/action/usage', ctx.adminToken);
    expect(usage.status).toBe(200);
    const totals = usage.body['totals'] as { runs: number; modelCalls: number; toolCalls: number };
    expect(totals.runs).toBeGreaterThan(0);
    expect(totals.modelCalls).toBeGreaterThan(0);
    expect(Array.isArray(usage.body['byProvider'])).toBe(true);
    expect((usage.body['byProvider'] as { providerKey: string }[]).some((entry) => entry.providerKey === PROVIDER_KEY)).toBe(true);
  });
});
