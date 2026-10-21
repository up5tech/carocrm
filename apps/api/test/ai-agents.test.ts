import { FeatureDisabledError } from '@carocrm/core/errors/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AIAgentsPolicyService } from '../src/ai-agents/ai-agents-policy.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-AI.2–19-AI.4 — foundation integration tests
 * (PLAN_Phase_19_AI_Agents.md §18, §20 `19-AI.2`–`19-AI.4`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted by id in `afterAll`; no table is reset or truncated and no extra
 * database is created. Provider calls use the deterministic fake adapter — no billable API is used.
 */

// A test key before `bootApi()` builds the config; the value is obviously synthetic and never logged.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface NavigationNode {
  readonly key: string;
  readonly children?: readonly NavigationNode[];
}

const runId = Date.now().toString(36);
const ROLE_USE = `AGENT_TEST-ai-use-${runId}`;
const ROLE_NONE = `AGENT_TEST-ai-none-${runId}`;
const USER_USE = `AGENT_TEST-ai-use-user-${runId}`;
const USER_NONE = `AGENT_TEST-ai-none-user-${runId}`;
const PROVIDER_KEY = `agent-test-${runId}`;
const PROVIDER_LOOPBACK_KEY = `agent-test-loopback-${runId}`;
const PROVIDER_SECRET = 'agent-test-secret-value-never-returned';

let ctx: ApiContext;
let useToken = '';
let noneToken = '';
let baselineSettings: unknown = null;
const createdUserIds: string[] = [];

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

function navigationKeys(body: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly NavigationNode[]): void => {
    for (const node of nodes) {
      out.add(node.key);
      if (node.children !== undefined) walk(node.children);
    }
  };
  const items = body['items'];
  if (Array.isArray(items)) walk(items as NavigationNode[]);
  return out;
}

beforeAll(async () => {
  ctx = await bootApi();

  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'aiAgents').execute();
  baselineSettings = rows[0]?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_USE,
    name: `AGENT_TEST AI use ${runId}`,
    permissions: { AIAgent: { read: 'yes' } },
  });
  await createTestRole(ctx, {
    id: ROLE_NONE,
    name: `AGENT_TEST AI none ${runId}`,
    permissions: {},
  });

  const useUser = await createTestUser(ctx, { userName: USER_USE, roleIds: [ROLE_USE] });
  const noneUser = await createTestUser(ctx, { userName: USER_NONE, roleIds: [ROLE_NONE] });
  useToken = useUser.token;
  noneToken = noneUser.token;
  createdUserIds.push(useUser.id, noneUser.id);
});

afterAll(async () => {
  const db = ctx.database.db;
  // Only rows this run created, identified by its unique keys.
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', 'in', [PROVIDER_KEY, PROVIDER_LOOPBACK_KEY]).execute();
  await db.deleteFrom('ai_provider_connections').where('key', 'in', [PROVIDER_KEY, PROVIDER_LOOPBACK_KEY]).execute();
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
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USE, ROLE_NONE]).execute();
  await shutdownApi();
});

describe('permissions and navigation', () => {
  it('gives an administrator every capability and the menu entry', async () => {
    const capabilities = await call('GET', '/api/v1/AIAgents/action/capabilities', ctx.adminToken);
    expect(capabilities.status).toBe(200);
    const entries = capabilities.body['capabilities'] as { key: string; granted: boolean }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.granted)).toBe(true);

    const navigation = await call('GET', '/api/v1/Navigation', ctx.adminToken);
    expect(navigationKeys(navigation.body).has('aiAgents')).toBe(true);
  });

  it('reports foundation health from the running platform', async () => {
    const health = await call('GET', '/api/v1/AIAgents/action/health', ctx.adminToken);
    expect(health.status).toBe(200);
    expect(health.body['ok']).toBe(true);
    expect((health.body['module'] as { id: string }).id).toBe('AIAgents');
    const structures = health.body['structures'] as { name: string; present: boolean }[];
    expect(structures.length).toBeGreaterThan(0);
    expect(structures.every((structure) => structure.present)).toBe(true);
    const providers = health.body['providers'] as { adapterKeys: string[]; encryptionConfigured: boolean };
    expect(providers.adapterKeys).toContain('fake');
    expect(providers.encryptionConfigured).toBe(true);
  });

  it('shows the page to a role with use and refuses administration', async () => {
    const capabilities = await call('GET', '/api/v1/AIAgents/action/capabilities', useToken);
    expect(capabilities.status).toBe(200);
    const entries = capabilities.body['capabilities'] as { key: string; granted: boolean }[];
    expect(entries.find((entry) => entry.key === 'use')?.granted).toBe(true);
    expect(entries.find((entry) => entry.key === 'policyAdmin')?.granted).toBe(false);

    expect((await call('GET', '/api/v1/AIAgents/action/settings', useToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/AIAgents/action/providers', useToken)).status).toBe(403);

    const navigation = await call('GET', '/api/v1/Navigation', useToken);
    expect(navigationKeys(navigation.body).has('aiAgents')).toBe(true);
  });

  it('hides the page and refuses health to a role without the capability', async () => {
    expect((await call('GET', '/api/v1/AIAgents/action/capabilities', noneToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/AIAgents/action/health', noneToken)).status).toBe(403);
    const navigation = await call('GET', '/api/v1/Navigation', noneToken);
    expect(navigationKeys(navigation.body).has('aiAgents')).toBe(false);
  });
});

describe('module settings and execution gate', () => {
  it('rejects an unknown settings key', async () => {
    const result = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, { notAFeature: true });
    expect(result.status).toBe(422);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });

  it('keeps execution off until it is explicitly enabled, and blocks it while paused', async () => {
    const disabled = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      features: { execution: false },
      safety: { globalExecutionPaused: false, reason: null },
    });
    expect(disabled.status).toBe(200);
    let capabilities = await call('GET', '/api/v1/AIAgents/action/capabilities', ctx.adminToken);
    expect((capabilities.body['execution'] as { enabled: boolean }).enabled).toBe(false);
    expect((capabilities.body['execution'] as { available: boolean }).available).toBe(false);
    // The gate every future run-creation path must call refuses while the feature is off.
    const policy = ctx.app.get(AIAgentsPolicyService);
    await expect(policy.assertExecutionEnabled()).rejects.toBeInstanceOf(FeatureDisabledError);

    const paused = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      features: { execution: true },
      safety: { globalExecutionPaused: true, reason: 'AGENT_TEST maintenance' },
    });
    expect(paused.status).toBe(200);
    capabilities = await call('GET', '/api/v1/AIAgents/action/capabilities', ctx.adminToken);
    expect((capabilities.body['execution'] as { enabled: boolean }).enabled).toBe(true);
    expect((capabilities.body['execution'] as { available: boolean }).available).toBe(false);
    await expect(policy.assertExecutionEnabled()).rejects.toBeInstanceOf(FeatureDisabledError);

    const resumed = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      safety: { globalExecutionPaused: false, reason: null },
    });
    expect(resumed.status).toBe(200);
    capabilities = await call('GET', '/api/v1/AIAgents/action/capabilities', ctx.adminToken);
    expect((capabilities.body['execution'] as { available: boolean }).available).toBe(true);
    await expect(policy.assertExecutionEnabled()).resolves.toBeUndefined();
  });
});

describe('provider connections', () => {
  it('stores a credential encrypted and never returns it', async () => {
    const created = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
      kind: 'fake',
      key: PROVIDER_KEY,
      label: 'AGENT_TEST provider',
      baseUrl: 'https://example.com/v1',
      models: ['fake-model'],
      dataClasses: ['internal'],
      apiKey: PROVIDER_SECRET,
      config: { allowLoopback: false },
      enabled: true,
    });
    expect(created.status).toBe(201);
    expect(created.body['hasApiKey']).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain(PROVIDER_SECRET);
    expect(created.body['key']).toBe(PROVIDER_KEY);

    const row = await ctx.database.db
      .selectFrom('ai_provider_connections')
      .select('api_key_encrypted')
      .where('key', '=', PROVIDER_KEY)
      .executeTakeFirstOrThrow();
    expect(row.api_key_encrypted).not.toBeNull();
    expect(row.api_key_encrypted).not.toBe(PROVIDER_SECRET);
    expect(row.api_key_encrypted?.startsWith('v1:')).toBe(true);

    const listed = await call('GET', '/api/v1/AIAgents/action/providers', ctx.adminToken);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(PROVIDER_SECRET);
  });

  it('refuses a duplicate key and an unsafe base URL', async () => {
    const duplicate = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
      kind: 'fake',
      key: PROVIDER_KEY,
      label: 'duplicate',
      baseUrl: 'https://example.com/v1',
      models: ['fake-model'],
    });
    expect(duplicate.status).toBe(409);

    const unsafe = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
      kind: 'fake',
      key: `${PROVIDER_KEY}-unsafe`,
      label: 'unsafe',
      baseUrl: 'http://user:pass@example.com/v1',
      models: ['fake-model'],
    });
    expect(unsafe.status).toBe(422);

    const loopback = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
      kind: 'fake',
      key: PROVIDER_LOOPBACK_KEY,
      label: 'loopback without opt-in',
      baseUrl: 'https://127.0.0.1:11434/v1',
      models: ['fake-model'],
    });
    expect(loopback.status).toBe(422);
  });

  it('runs a controlled connectivity check, records a redacted ledger row and never leaks the key', async () => {
    const checked = await call('POST', `/api/v1/AIAgents/action/providers/${PROVIDER_KEY}/check`, ctx.adminToken, {
      model: 'fake-model',
    });
    expect(checked.status).toBe(200);
    expect(checked.body['ok']).toBe(true);
    expect(checked.body['category']).toBeNull();
    expect(JSON.stringify(checked.body)).not.toContain(PROVIDER_SECRET);
    expect(JSON.stringify(checked.body)).not.toContain('Reply with the single word');

    const ledger = await ctx.database.db
      .selectFrom('ai_agent_provider_requests')
      .select(['request_hash', 'request_meta', 'outcome'])
      .where('provider_key', '=', PROVIDER_KEY)
      .execute();
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0]?.outcome).toBe('succeeded');
    expect(ledger[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const meta = JSON.stringify(ledger[0]?.request_meta);
    expect(meta).not.toContain('Reply with the single word');
    expect(meta).toContain('messageCount');
  });

  it('rejects a model outside the allowlist and clears a secret without returning it', async () => {
    const badModel = await call('POST', `/api/v1/AIAgents/action/providers/${PROVIDER_KEY}/check`, ctx.adminToken, {
      model: 'not-allowed',
    });
    expect(badModel.status).toBe(422);

    const cleared = await call('PATCH', `/api/v1/AIAgents/action/providers/${PROVIDER_KEY}`, ctx.adminToken, {
      apiKey: null,
      label: 'AGENT_TEST provider (no credential)',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body['hasApiKey']).toBe(false);

    const removed = await call('DELETE', `/api/v1/AIAgents/action/providers/${PROVIDER_KEY}`, ctx.adminToken);
    expect(removed.status).toBe(200);
    expect(removed.body['success']).toBe(true);
  });
});
