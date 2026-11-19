import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 25.5 — API evidence for the workflow AI door.
 *
 * An administrator's workflow starts exactly one published agent under the 25.2 principal rule.
 * A redelivered step replays the same run; a settled run is mapped only after revalidating its
 * structured answer, and the engine queues `workflow.resume` for the parked node. Fake provider only.
 */
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';
const TEST_SECRET = `agent-test-workflow-secret-${Date.now().toString(36)}`;
process.env.REPORT_WORKER_SECRET = TEST_SECRET;

const suffix = Date.now().toString(36);
const MARKER = `AGENT_TEST_workflow_${suffix}`;
const PROVIDER_KEY = `agent-test-workflow-${suffix}`;
const AGENT_KEY = `agent-test-workflow-${suffix}`;
const WORKFLOW_ID = `wf-workflow-${suffix}`;
const WORKFLOW_RUN_ID = `wfrun-workflow-${suffix}`;
const NODE_ID = 'classify';
const IDEMPOTENCY_KEY = `wf:${WORKFLOW_RUN_ID}:${NODE_ID}`;

type Method = 'GET' | 'POST';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let ctx: ApiContext;
let baselineSettings: unknown = null;
let adminId = '';
let accountId = '';
let agentId = '';
let noOptInId = '';
let agentRunId = '';
let pricingId = '';
const entityIds: string[] = [];
const runIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown, secret?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: {
      ...(token === undefined ? {} : authHeader(token)),
      ...(secret === undefined ? {} : { 'x-worker-secret': secret }),
    },
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

function config(trigger: boolean): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Answer with the declared JSON shape.' },
    input: { mode: 'text' },
    tools: [],
    principal: { mode: 'requesting_user' },
    limits: {
      maxSteps: 2,
      maxModelCalls: 2,
      maxToolCalls: 0,
      maxTokens: 4_000,
      maxCostUsd: 0.5,
      maxElapsedSeconds: 60,
      maxRetries: 0,
      maxOutputTokens: 256,
      temperature: 0,
    },
    output: { mode: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
    memory: { mode: 'none' },
    triggers: {
      manual: true,
      record: false,
      event: false,
      schedule: false,
      integration: false,
      workflow: trigger,
      eventTypes: [],
      eventEntities: [],
      integrationTypes: [],
    },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

function workflowPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId,
    task: `${MARKER}: classify the record`,
    idempotencyKey: IDEMPOTENCY_KEY,
    approvalExpectation: 'must_require',
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      nodeId: NODE_ID,
      entityType: 'Account',
      entityId: accountId,
      userId: adminId,
      outputMapping: { fields: { classification: 'data.ok' } },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  ctx = await bootApi();
  baselineSettings = await snapshotSettings(ctx, 'aiAgents');
  const admin = await ctx.database.db.selectFrom('users').select('id').where('user_name', '=', 'admin').executeTakeFirstOrThrow();
  adminId = admin.id;

  const account = await call('POST', '/api/v1/Account', ctx.adminToken, { name: `${MARKER} fixture` });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  accountId = String(account.body['id']);
  entityIds.push(accountId);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);

  await ctx.database.db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  const pricing = await call('POST', '/api/v1/AIAgents/action/pricing', ctx.adminToken, {
    providerKey: PROVIDER_KEY,
    model: 'fake-model',
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.2,
  });
  expect(pricing.status, JSON.stringify(pricing.body)).toBe(201);
  pricingId = String(pricing.body['id']);

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: AGENT_KEY,
    name: `${MARKER} workflow agent`,
    visibility: 'organization',
    config: config(true),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agentId = String(created.body['id']);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  const noOptIn = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: `${AGENT_KEY}-no-opt`,
    name: `${MARKER} no opt-in`,
    visibility: 'organization',
    config: config(false),
  });
  expect(noOptIn.status).toBe(201);
  noOptInId = String(noOptIn.body['id']);
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const id of runIds) {
    await db.deleteFrom('jobs').where('job', '=', 'aiAgents.executeRun').where(sql`target::text like ${`%${id}%`}`).execute();
    await db.deleteFrom('ai_agent_run_events').where('run_id', '=', id).execute();
  }
  await db.deleteFrom('jobs').where('job', '=', 'workflow.resume').where(sql`target::text like ${`%${WORKFLOW_RUN_ID}%`}`).execute();
  if (runIds.length > 0) await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  if (pricingId !== '') await db.deleteFrom('ai_agent_pricing_snapshots').where('id', '=', pricingId).execute();
  for (const id of [agentId, noOptInId].filter((entry) => entry !== '')) {
    await db.deleteFrom('ai_agent_tool_grants')
      .where('agent_version_id', 'in', db.selectFrom('ai_agent_versions').select('id').where('agent_id', '=', id))
      .execute();
    await db.deleteFrom('ai_agent_versions').where('agent_id', '=', id).execute();
    await db.deleteFrom('ai_agents').where('id', '=', id).execute();
  }
  if (entityIds.length > 0) await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await restoreSettings(ctx, 'aiAgents', baselineSettings);
  await shutdownApi();
});

describe('workflow AI door (25.5)', () => {
  it('refuses an agent that has not opted in and a capability-less caller', async () => {
    const refused = await call(
      'POST',
      '/api/v1/AIAgents/action/worker/workflow/run',
      undefined,
      workflowPayload({ agentId: noOptInId, idempotencyKey: `wf:${WORKFLOW_RUN_ID}:no-opt` }),
      TEST_SECRET,
    );
    expect([400, 422]).toContain(refused.status);

    const unauthenticated = await call('POST', '/api/v1/AIAgents/action/worker/workflow/run', undefined, workflowPayload(), 'wrong-secret');
    expect(unauthenticated.status).toBe(401);
  });

  it('starts one attributable run and replays it on redelivery', async () => {
    const started = await call('POST', '/api/v1/AIAgents/action/worker/workflow/run', undefined, workflowPayload(), TEST_SECRET);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body['pending']).toBe(true);
    agentRunId = String(started.body['runId']);
    runIds.push(agentRunId);

    const replay = await call('POST', '/api/v1/AIAgents/action/worker/workflow/run', undefined, workflowPayload(), TEST_SECRET);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body['runId']).toBe(agentRunId);

    const rows = await ctx.database.db
      .selectFrom('ai_agent_runs')
      .select(['id', 'trigger', 'causation_id', 'initiated_by_user_id', 'service_principal', 'input'])
      .where('idempotency_key', '=', IDEMPOTENCY_KEY)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: agentRunId,
      trigger: 'workflow',
      causation_id: WORKFLOW_RUN_ID,
      initiated_by_user_id: adminId,
      service_principal: null,
    });
    const input = typeof rows[0]?.input === 'string' ? (JSON.parse(rows[0].input) as Record<string, unknown>) : rows[0]?.input;
    expect(input).toMatchObject({ workflow: { workflowId: WORKFLOW_ID, nodeId: NODE_ID } });
  });

  it('maps a schema-validated answer and queues the parked workflow node', async () => {
    // Drive the run through the authenticated execute door (the same service the worker calls).
    // The worker-only door is intentionally public; it is tested separately for its capability check.
    const executed = await call('POST', `/api/v1/AIAgents/action/runs/${agentRunId}/execute`, ctx.adminToken, {});
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);

    const settled = await call('POST', '/api/v1/AIAgents/action/worker/workflow/run', undefined, workflowPayload(), TEST_SECRET);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body['status']).toBe('succeeded');
    expect(settled.body['fields']).toEqual({ classification: true });

    const resume = await ctx.database.db
      .selectFrom('jobs')
      .select(['id', 'job', 'target'])
      .where('job', '=', 'workflow.resume')
      .where(sql`target::text like ${`%${WORKFLOW_RUN_ID}%`}`)
      .execute();
    expect(resume).toHaveLength(1);
    expect(JSON.stringify(resume[0]?.target)).toContain(NODE_ID);
  });
});
