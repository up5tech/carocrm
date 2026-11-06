import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 19-AI.17 — the domain-event trigger door (P1)
 * (`plans/PLAN_Phase_19_AI_Agents.md` §13.1, §13.8).
 *
 * What is under test is the whole path a committed entity event walks, minus the worker process
 * itself (which is a thin, tested-in-isolation subscriber):
 *
 * - `POST /api/v1/AIAgents/action/worker/trigger-event` requires the shared worker capability;
 * - with `features.eventTriggers` off, the door is a quiet no-op, never a retry storm;
 * - with the flag on, an agent that opted in (`triggers.event` + matching `eventTypes` and
 *   `eventEntities` allowlists, record-context for exactly this entity) starts exactly one run;
 * - the run executes as the **publishing user** (`initiated_by_user_id`), never wider;
 * - at-least-once delivery is safe: re-delivering the same event is a no-op for the agent;
 * - agents that opted out, or whose allowlists do not match, are never started.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';
// A test-local capability: the door must not read the developer's real one, and the value stays
// out of any output.
const TEST_SECRET = `agent-test-trigger-secret-${Date.now().toString(36)}`;
process.env.REPORT_WORKER_SECRET = TEST_SECRET;

type Method = 'GET' | 'POST';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_triggers_${runId}`;
const ROLE_TOOLS = `AGENT_TEST-triggers-${runId}`;
const USER_TOOLS = `AGENT_TEST-triggers-user-${runId}`;
const PROVIDER_KEY = `agent-test-triggers-${runId}`;
const EVENT_CREATE = 'evt-create-test-triggers';

let ctx: ApiContext;
let toolToken = '';
let toolUserId = '';
let accountId = '';
let adminUserId = '';
const createdUserIds: string[] = [];
const entityIds: string[] = [];
const runIds: string[] = [];
const pricingSnapshotIds: string[] = [];
const eventIds = [EVENT_CREATE];
let baselineAiSettings: unknown = null;

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

function baseConfig(tools: readonly { key: string }[]): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Follow the task and use tools carefully.' },
    input: { mode: 'record', entity: 'Account' },
    tools: [...tools],
    limits: {
      maxSteps: 4,
      maxModelCalls: 4,
      maxToolCalls: 2,
      maxTokens: 8_000,
      maxCostUsd: 0.5,
      maxElapsedSeconds: 60,
      maxRetries: 0,
      maxOutputTokens: 512,
      temperature: 0,
    },
    output: { mode: 'text' },
    memory: { mode: 'none' },
    triggers: {
      manual: true,
      record: false,
      event: true,
      schedule: false,
      integration: false,
      eventTypes: ['entity.created'],
      eventEntities: ['Account'],
    },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

async function createRecord(entity: string, data: Record<string, unknown>, token = ctx.adminToken): Promise<string> {
  const created = await call('POST', `/api/v1/${entity}`, token, data);
  expect(created.status, `${entity}: ${JSON.stringify(created.body)}`).toBe(201);
  const id = String(created.body['id']);
  entityIds.push(id);
  return id;
}

async function countRuns(key: string): Promise<number> {
  const row = await ctx.database.db
    .selectFrom('ai_agent_runs')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('causation_id', '=', key)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

beforeAll(async () => {
  ctx = await bootApi();

  baselineAiSettings = await snapshotSettings(ctx, 'aiAgents');

  const me = await call('GET', '/api/v1/AppUser/me', ctx.adminToken);
  expect(me.status).toBe(200);
  adminUserId = String(me.body['id']);

  await createTestRole(ctx, {
    id: ROLE_TOOLS,
    name: `${MARKER} triggers`,
    permissions: {
      AIAgent: { read: 'yes' },
      Account: { read: 'all', create: 'all' },
    },
  });
  const toolsUser = await createTestUser(ctx, { userName: USER_TOOLS, roleIds: [ROLE_TOOLS] });
  toolToken = toolsUser.token;
  toolUserId = toolsUser.id;
  createdUserIds.push(toolsUser.id);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status).toBe(201);

  // Cheap pricing, or every run is refused for cost before it is reached.
  await ctx.database.db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  const snapshot = await call('POST', '/api/v1/AIAgents/action/pricing', ctx.adminToken, {
    providerKey: PROVIDER_KEY,
    model: 'fake-model',
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.2,
  });
  expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
  pricingSnapshotIds.push(String(snapshot.body['id']));

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true, memory: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status).toBe(200);

  accountId = await createRecord('Account', { name: `${MARKER} trigger fixture` });
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
  if (eventIds.length > 0) {
    await db.deleteFrom('ai_agent_runs').where('causation_id', 'in', eventIds).execute();
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  if (pricingSnapshotIds.length > 0) {
    await db.deleteFrom('ai_agent_pricing_snapshots').where('id', 'in', pricingSnapshotIds).execute();
  }
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  const testAgents = await db
    .selectFrom('ai_agents')
    .select('id')
    .where('agent_key', 'like', `agent-test-${runId}-%`)
    .execute();
  if (testAgents.length > 0) {
    const ids = testAgents.map((agent) => agent.id);
    await db.deleteFrom('ai_agent_memory_items').where('agent_id', 'in', ids).execute();
    await db.deleteFrom('ai_agent_conversations').where('agent_id', 'in', ids).execute();
    await db.deleteFrom('ai_agent_tool_grants')
      .where(
        'agent_version_id',
        'in',
        db.selectFrom('ai_agent_versions').select('id').where('agent_id', 'in', ids),
      )
      .execute();
    await db.deleteFrom('ai_agent_versions').where('agent_id', 'in', ids).execute();
  }
  await db.deleteFrom('ai_agents').where('agent_key', 'like', `agent-test-${runId}-%`).execute();
  if (entityIds.length > 0) {
    await db.deleteFrom('stream_items').where('entity_id', 'in', entityIds).execute();
    await db
      .deleteFrom('entity_links')
      .where((eb) => eb.or([eb('record_id_a', 'in', entityIds), eb('record_id_b', 'in', entityIds)]))
      .execute();
    await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  }
  await restoreSettings(ctx, 'aiAgents', baselineAiSettings);
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_TOOLS]).execute();
  await shutdownApi();
});

describe('the domain-event trigger door (19-AI.17)', () => {
  it('is a quiet no-op while features.eventTriggers is off', async () => {
    const before = await countRuns(EVENT_CREATE);
    const res = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.created',
      entityType: 'Account',
      entityId: accountId,
    }, TEST_SECRET);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['disabled']).toBe(true);
    expect(await countRuns(EVENT_CREATE)).toBe(before);
  });

  it('refuses the door without the worker capability', async () => {
    const res = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.created',
      entityType: 'Account',
      entityId: accountId,
    });
    expect([401, 403]).toContain(res.status);
  });

  it('starts one run for a matching event, replay-safe', async () => {
    // Publish an agent that opted in for entity.created on Account.
    const enabled = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      features: { eventTriggers: true },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    const key = `agent-test-${runId}-trigger`;
    const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
      key,
      name: `${MARKER} trigger agent`,
      visibility: 'organization',
      config: baseConfig([]),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = String(created.body['id']);
    const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const first = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.created',
      entityType: 'Account',
      entityId: accountId,
    }, TEST_SECRET);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['started']).toBe(1);

    const row = await ctx.database.db
      .selectFrom('ai_agent_runs')
      .select(['id', 'trigger', 'initiated_by_user_id', 'causation_id', 'idempotency_key'])
      .where('causation_id', '=', EVENT_CREATE)
      .executeTakeFirst();
    expect(row, 'no run was started for the matching event').toBeDefined();
    expect(row?.trigger).toBe('event');
    // Owner-on-behalf: the run acts as the person who published the agent, never wider.
    expect(row?.initiated_by_user_id).toBe(adminUserId);
    expect(row?.idempotency_key).toBe(`evt:${EVENT_CREATE}:${agentId}`);
    runIds.push(String(row?.id ?? ''));

    // At-least-once delivery: re-delivering the same event must not start a second run.
    const replay = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.created',
      entityType: 'Account',
      entityId: accountId,
    }, TEST_SECRET);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body['started']).toBe(1);
    expect(await countRuns(EVENT_CREATE)).toBe(1);
  });

  it('does not start the agent for a non-listed event type', async () => {
    const before = await countRuns(EVENT_CREATE);
    const res = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.updated',
      entityType: 'Account',
      entityId: accountId,
    }, TEST_SECRET);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['started']).toBe(0);
    expect(await countRuns(EVENT_CREATE)).toBe(before);
  });

  it('does not start the agent for an entity outside its allowlist', async () => {
    const before = await countRuns(EVENT_CREATE);
    const res = await call('POST', '/api/v1/AIAgents/action/worker/trigger-event', undefined, {
      eventId: EVENT_CREATE,
      eventType: 'entity.created',
      entityType: 'Campaign',
      entityId: accountId,
    }, TEST_SECRET);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['started']).toBe(0);
    expect(await countRuns(EVENT_CREATE)).toBe(before);
  });
});
