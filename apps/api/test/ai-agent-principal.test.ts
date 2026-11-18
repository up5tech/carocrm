import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 25.2 — the execution principal is pinned in the published agent version.
 *
 * Evidence in one place: an automated door runs as the pinned publisher (never a service identity),
 * a manual/Chat door refuses a publisher-pinned version, every timeline event carries the effective
 * user and pinned version, and a revoked publisher is skipped before a run is even created.
 */
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';
const TEST_SECRET = `agent-test-principal-secret-${Date.now().toString(36)}`;
process.env.REPORT_WORKER_SECRET = TEST_SECRET;

const suffix = Date.now().toString(36);
const MARKER = `AGENT_TEST_principal_${suffix}`;
const OWNER_NAME = `AGENT_TEST_principal_owner_${suffix}`;
const OWNER_ROLE = `AGENT_TEST-principal-role-${suffix}`;
const PROVIDER_KEY = `agent-test-principal-${suffix}`;
const AGENT_KEY = `agent-test-principal-${suffix}`;
const EVENT_ID = `evt-principal-${suffix}`;
const REVOKED_EVENT_ID = `evt-principal-revoked-${suffix}`;

type Method = 'GET' | 'POST';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let ctx: ApiContext;
let agentId = '';
let ownerId = '';
let accountId = '';
let baselineSettings: unknown = null;
const entityIds: string[] = [];
const runIds: string[] = [];
const pricingSnapshotIds: string[] = [];

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

function baseConfig(mode: 'requesting_user' | 'publisher'): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Answer briefly.' },
    input: { mode: 'record', entity: 'Account' },
    tools: [],
    principal: { mode },
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

beforeAll(async () => {
  ctx = await bootApi();
  baselineSettings = await snapshotSettings(ctx, 'aiAgents');

  const created = await call('POST', '/api/v1/Account', ctx.adminToken, { name: `${MARKER} fixture` });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  accountId = String(created.body['id']);
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
  pricingSnapshotIds.push(String(pricing.body['id']));

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true, eventTriggers: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  const owner = await createTestUser(ctx, { userName: OWNER_NAME, roleIds: [OWNER_ROLE] });
  ownerId = owner.id;

  await createTestRole(ctx, {
    id: OWNER_ROLE,
    name: `${MARKER} owner role`,
    permissions: { AIAgent: { read: 'yes' }, Account: { read: 'all' } },
  });

  const agent = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: AGENT_KEY,
    name: `${MARKER} publisher-pinned agent`,
    visibility: 'organization',
    config: baseConfig('publisher'),
  });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  agentId = String(agent.body['id']);
  // Narrow fixture rewrite: only this test's agent gets the test owner.
  await ctx.database.db
    .updateTable('ai_agents')
    .set({ owner_user_id: ownerId })
    .where('id', '=', agentId)
    .execute();
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const id of runIds) {
    await db
      .deleteFrom('jobs')
      .where('job', '=', 'aiAgents.executeRun')
      .where(sql`target::text like ${`%${id}%`}`)
      .execute();
  }
  if (runIds.length > 0) await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  await db.deleteFrom('ai_agent_runs').where('causation_id', 'in', [EVENT_ID, REVOKED_EVENT_ID]).execute();
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  if (pricingSnapshotIds.length > 0) {
    await db.deleteFrom('ai_agent_pricing_snapshots').where('id', 'in', pricingSnapshotIds).execute();
  }
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agent_tool_grants')
    .where(
      'agent_version_id',
      'in',
      db.selectFrom('ai_agent_versions').select('id').where('agent_id', '=', agentId),
    )
    .execute();
  await db.deleteFrom('ai_agent_versions').where('agent_id', '=', agentId).execute();
  await db.deleteFrom('ai_agent_memory_items').where('agent_id', '=', agentId).execute();
  await db.deleteFrom('ai_agent_conversations').where('agent_id', '=', agentId).execute();
  await db.deleteFrom('ai_agents').where('id', '=', agentId).execute();
  await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  if (ownerId !== '') await db.deleteFrom('users').where('id', '=', ownerId).execute();
  await db.deleteFrom('roles').where('id', '=', OWNER_ROLE).execute();
  await restoreSettings(ctx, 'aiAgents', baselineSettings);
  await shutdownApi();
});

describe('agent execution principal (25.2)', () => {
  it('refuses a service identity at the configuration boundary', async () => {
    const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
      key: `agent-test-principal-service-${suffix}`,
      name: `${MARKER} service identity`,
      visibility: 'organization',
      config: { ...baseConfig('requesting_user'), principal: { mode: 'service' } },
    });
    expect([400, 422]).toContain(created.status);
  });

  it('refuses a publisher-pinned version from a manual door', async () => {
    const started = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, ctx.adminToken, {
      input: { record: { entity: 'Account', id: accountId } },
    });
    expect([400, 422]).toContain(started.status);
    expect(started.body['id']).toBeUndefined();
  });

  it('runs an automated trigger as the pinned publisher with no service identity', async () => {
    const fired = await call(
      'POST',
      '/api/v1/AIAgents/action/worker/trigger-event',
      undefined,
      { eventId: EVENT_ID, eventType: 'entity.created', entityType: 'Account', entityId: accountId },
      TEST_SECRET,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect(fired.body['started'], JSON.stringify(fired.body)).toBe(1);

    const row = await ctx.database.db
      .selectFrom('ai_agent_runs')
      .select(['id', 'initiated_by_user_id', 'service_principal', 'agent_version', 'trigger'])
      .where('causation_id', '=', EVENT_ID)
      .executeTakeFirst();
    expect(row).toBeDefined();
    if (row === undefined) return;
    runIds.push(row.id);
    expect(row.initiated_by_user_id).toBe(ownerId);
    expect(row.service_principal).toBeNull();
    expect(row.agent_version).toBe(1);
    expect(row.trigger).toBe('event');

    const events = await ctx.database.db
      .selectFrom('ai_agent_run_events')
      .select(['payload', 'actor_type', 'actor_id'])
      .where('run_id', '=', row.id)
      .execute();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const payload =
        typeof event.payload === 'string'
          ? (JSON.parse(event.payload) as Record<string, unknown>)
          : (event.payload as Record<string, unknown>);
      expect(payload['effectivePrincipalUserId']).toBe(ownerId);
      expect(payload['pinnedAgentVersion']).toBe(1);
      expect(event.actor_type).toBe('user');
      expect(event.actor_id).toBe(ownerId);
    }
  });

  it('skips an automated door when the pinned publisher has been revoked', async () => {
    await ctx.database.db
      .updateTable('users')
      .set({ is_active: false })
      .where('id', '=', ownerId)
      .execute();
    const fired = await call(
      'POST',
      '/api/v1/AIAgents/action/worker/trigger-event',
      undefined,
      { eventId: REVOKED_EVENT_ID, eventType: 'entity.created', entityType: 'Account', entityId: accountId },
      TEST_SECRET,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect(fired.body['started']).toBe(0);
    expect(JSON.stringify(fired.body['skipped'])).toContain('owner-inactive');
    const started = await ctx.database.db
      .selectFrom('ai_agent_runs')
      .select('id')
      .where('causation_id', '=', REVOKED_EVENT_ID)
      .execute();
    expect(started).toHaveLength(0);
  });
});
