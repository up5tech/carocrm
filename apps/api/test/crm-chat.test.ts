import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.2 — module registration, capabilities, feature flags, navigation and diagnostics
 * (PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.2`, acceptance: "authorized users can open the Chat
 * workspace shell; unauthorized users cannot access the route or API; disabled Chat is absent from
 * navigation and enforced server-side").
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row this suite creates carries
 * the run marker, is created through the public API or the shared test helpers, and is removed by
 * exact id in `afterAll`; nothing is truncated, reset or recreated. No model call happens here — the
 * module's foundation endpoints never reach a provider.
 */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface NavNode {
  readonly key?: string;
  readonly route?: string;
  readonly children?: readonly NavNode[];
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chat_${runId}`;
const ROLE_USE = `AGENT_TEST-chat-use-${runId}`;
const ROLE_NONE = `AGENT_TEST-chat-none-${runId}`;
const USER_USE = `AGENT_TEST-chat-use-user-${runId}`;
const USER_NONE = `AGENT_TEST-chat-none-user-${runId}`;

let ctx: ApiContext;
let useToken = '';
let noneToken = '';
let baselineVersion = 0;
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

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Every route in the resolved menu, flattened; the tree is nested, the assertion is not. */
function routes(nodes: readonly NavNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node.route === 'string' && node.route !== '') out.push(node.route);
    if (node.children !== undefined) out.push(...routes(node.children));
  }
  return out;
}

async function menuRoutes(token: string): Promise<string[]> {
  const res = await call('GET', '/api/v1/Navigation', token);
  expect(res.status).toBe(200);
  return routes((res.body['items'] ?? []) as NavNode[]);
}

async function patchSettings(patch: Record<string, unknown>): Promise<CallResult> {
  return call('POST', '/api/v1/CRMChat/action/settings', ctx.adminToken, patch);
}

beforeAll(async () => {
  ctx = await bootApi();
  const baseline = await call('GET', '/api/v1/CRMChat/action/settings', ctx.adminToken);
  expect(baseline.status, JSON.stringify(baseline.body)).toBe(200);
  baselineVersion = Number(baseline.body['version'] ?? 0);

  await createTestRole(ctx, {
    id: ROLE_USE,
    name: `${MARKER} chat user role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all', delete: 'all' },
      CRMChatFeedback: { edit: 'all' },
      CRMChatPrompt: { edit: 'all' },
      AIAgent: { read: 'all' },
    },
  });
  await createTestRole(ctx, {
    id: ROLE_NONE,
    name: `${MARKER} unrelated role`,
    permissions: { Account: { read: 'own' } },
  });

  const granted = await createTestUser(ctx, { userName: USER_USE, roleIds: [ROLE_USE] });
  const denied = await createTestUser(ctx, { userName: USER_NONE, roleIds: [ROLE_NONE] });
  useToken = granted.token;
  noneToken = denied.token;
  createdUserIds.push(granted.id, denied.id);
});

afterAll(async () => {
  const db = ctx.database.db;
  // Restore the settings row this suite may have created or changed: a version-0 snapshot means the
  // row did not exist, so the only faithful restoration is to remove it again.
  if (baselineVersion === 0) {
    await db.deleteFrom('app_settings').where('name', '=', 'crmChat').execute();
  } else {
    await patchSettings({
      features: { workspace: true, readTools: false, helpRetrieval: false, actionProposals: false, feedback: false, conversationSearch: false },
      safety: { allowWrites: false },
    });
  }
  if (createdUserIds.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USE, ROLE_NONE]).execute();
  await shutdownApi();
});

describe('CRMChat module shell (19-CHAT.2)', () => {
  it('refuses the capability matrix to a caller without the Chat right', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/capabilities', noneToken);
    expect(result.status).toBe(403);
    expect(errorCode(result)).toBe('AUTHORIZATION_DENIED');
  });

  it('answers the capability matrix for a granted caller without leaking a role list', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/capabilities', useToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const module = recordOf(result.body['module']);
    expect(module['id']).toBe('CRMChat');
    expect(module['frontendRoute']).toBe('/crm-chat');
    expect(module['apiPrefix']).toBe('/api/v1/CRMChat');

    const workspace = recordOf(result.body['workspace']);
    expect(workspace['permitted']).toBe(true);
    expect(workspace['enabled']).toBe(true);

    const capabilities = result.body['capabilities'] as { key: string; granted: boolean }[];
    expect(capabilities.map((entry) => entry.key).sort()).toEqual(['admin', 'delete', 'feedback', 'manage', 'prompts', 'use']);
    expect(capabilities.find((entry) => entry.key === 'use')?.granted).toBe(true);
    // The granted role carries no Chat administration right; hiding the tab is not the check.
    expect(capabilities.find((entry) => entry.key === 'admin')?.granted).toBe(false);

    // A workspace that cannot answer says so instead of offering a composer that would fail; a
    // configured, published assistant is equally a valid state on a shared development database.
    const assistant = recordOf(result.body['assistant']);
    const assistantState = String(assistant['state']);
    expect(['not-configured', 'unresolvable', 'ready']).toContain(assistantState);
    const actions = recordOf(result.body['actions']);
    if (assistantState === 'ready') {
      expect(actions['canStartTurn']).toBe(true);
      expect(actions['reason']).toBeNull();
    } else {
      expect(actions['canStartTurn']).toBe(false);
      expect(String(actions['reason'] ?? '')).not.toBe('');
    }
    expect(actions['canConfirmWrite']).toBe(false);
  });

  it('reports flags with their prerequisite chain, not just their stored value', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/capabilities', useToken);
    const features = result.body['features'] as { key: string; enabled: boolean; effective: boolean; defaultEnabled: boolean }[];
    const workspace = features.find((feature) => feature.key === 'workspace');
    expect(workspace?.defaultEnabled).toBe(true);
    // Action proposals require read tools, which start off; the flag itself is off too, and either
    // way `effective` must agree with what the API would actually allow.
    const proposals = features.find((feature) => feature.key === 'actionProposals');
    expect(proposals?.enabled).toBe(false);
    expect(proposals?.effective).toBe(false);
  });

  it('keeps settings away from a caller who only holds the workspace right', async () => {
    const read = await call('GET', '/api/v1/CRMChat/action/settings', useToken);
    expect(read.status).toBe(403);
    expect(errorCode(read)).toBe('AUTHORIZATION_DENIED');
    const write = await call('POST', '/api/v1/CRMChat/action/settings', useToken, { features: { workspace: false } });
    expect(write.status).toBe(403);
  });

  it('reads validated settings and surfaces safe warnings', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/settings', ctx.adminToken);
    expect(result.status).toBe(200);
    const settings = recordOf(result.body['settings']);
    const features = recordOf(settings['features']);
    expect(features['workspace']).toBe(true);
    expect(features['readTools']).toBe(false);
    expect(recordOf(settings['safety'])['allowWrites']).toBe(false);
    const warnings = result.body['warnings'] as { code: string }[];
    const assistant = recordOf(settings['assistant']);
    const configured = typeof assistant['agentKey'] === 'string' && assistant['agentKey'] !== '';
    // The warning is a function of the stored key, not of the database's default state.
    expect(warnings.some((warning) => warning.code === 'assistantNotConfigured')).toBe(!configured);
  });

  it('refuses an unknown key, an out-of-range value and a wrong type', async () => {
    // A malformed request body is the repository's `InvalidQueryError` (400), exactly like
    // `AIAgents/action/settings`; a semantically invalid *value* that reaches the service is 422.
    const unknown = await patchSettings({ features: { workspace: true }, somethingElse: 1 });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe('INVALID_QUERY');

    const outOfRange = await patchSettings({ limits: { maxMessageChars: 0 } });
    expect(outOfRange.status).toBe(400);

    const wrongType = await patchSettings({ features: { workspace: 'yes' } });
    expect(wrongType.status).toBe(400);

    // A refused patch must not have changed anything.
    const after = await call('GET', '/api/v1/CRMChat/action/settings', ctx.adminToken);
    expect(recordOf(recordOf(after.body['settings'])['features'])['workspace']).toBe(true);
  });

  it('hides the menu entry and refuses the workspace API when Chat is disabled', async () => {
    try {
      expect(await menuRoutes(useToken)).toContain('/crm-chat');

      const off = await patchSettings({ features: { workspace: false } });
      expect(off.status, JSON.stringify(off.body)).toBe(200);

      // The menu cache is dropped by the settings write, so this is the next render, not a 30 s wait.
      expect(await menuRoutes(useToken)).not.toContain('/crm-chat');

      // The capability endpoint still answers so the shell can explain the state...
      const capabilities = await call('GET', '/api/v1/CRMChat/action/capabilities', useToken);
      expect(capabilities.status).toBe(200);
      expect(recordOf(capabilities.body['workspace'])['enabled']).toBe(false);

      // ...while every functional endpoint is refused by the server, not merely hidden.
      const health = await call('GET', '/api/v1/CRMChat/action/health', useToken);
      expect(health.status).toBe(403);
      expect(errorCode(health)).toBe('FEATURE_DISABLED');
    } finally {
      const on = await patchSettings({ features: { workspace: true } });
      expect(on.status).toBe(200);
    }

    expect(await menuRoutes(useToken)).toContain('/crm-chat');
  });

  it('keeps the administration surface reachable while the workspace is disabled', async () => {
    try {
      expect((await patchSettings({ features: { workspace: false } })).status).toBe(200);
      const settings = await call('GET', '/api/v1/CRMChat/action/settings', ctx.adminToken);
      expect(settings.status).toBe(200);
      expect(recordOf(recordOf(settings.body['settings'])['features'])['workspace']).toBe(false);
    } finally {
      expect((await patchSettings({ features: { workspace: true } })).status).toBe(200);
    }
  });

  it('reports dependency evidence and assistant readiness from the running system', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/health', ctx.adminToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const dependencies = result.body['dependencies'] as { id: string; present: boolean; missing: string[] }[];
    expect(dependencies.length).toBeGreaterThan(0);
    for (const dependency of dependencies) {
      expect(dependency.present, `${dependency.id} missing: ${dependency.missing.join(', ')}`).toBe(true);
    }

    const module = recordOf(result.body['module']);
    expect(module['id']).toBe('CRMChat');
    expect(module['dependsOn']).toContain('AIAgents');
    expect(module['implementedPhases']).toContain('19-CHAT.2');
    expect(module['implementedPhases']).toContain('19-CHAT.3');
    expect(module['implementedPhases']).toContain('19-CHAT.4');

    // 19-CHAT.3's three tables are reported from the live schema, not hard-coded.
    const structures = result.body['structures'] as { name: string; present: boolean }[];
    expect(structures.map((entry) => entry.name)).toEqual(['crm_chat_citations', 'crm_chat_feedback', 'crm_chat_prompts']);
    for (const structure of structures) expect(structure.present).toBe(true);
    const checks = result.body['checks'] as { name: string; ok: boolean; detail: string }[];
    expect(checks.map((check) => check.name)).toContain('owner-module');
    expect(checks.find((check) => check.name === 'owner-module')?.ok).toBe(true);

    // A fresh installation has no assistant configured: the view must be honest about that, and the
    // overall status must not claim health it cannot deliver.
    const assistant = recordOf(result.body['assistant']);
    if (assistant['state'] === 'not-configured') {
      expect(result.body['ok']).toBe(false);
      expect(checks.find((check) => check.name === 'assistant')?.ok).toBe(false);
    }
  });

  it('does not advertise the workspace to a caller without the capability, even when enabled', async () => {
    expect(await menuRoutes(noneToken)).not.toContain('/crm-chat');
  });

  it('publishes its foundation routes in the generated OpenAPI document', async () => {
    // 19-CHAT.1's third deliverable is a *versioned* contract, and the machine-readable half of it is
    // the OpenAPI document the server generates from the route decorators. A route that exists but is
    // absent here is undocumented in every client that reads the spec.
    const result = await call('GET', '/api/v1/OpenApi', ctx.adminToken);
    expect(result.status, JSON.stringify(result.body).slice(0, 200)).toBe(200);
    const paths = recordOf(result.body['paths']);
    // The spec is generated by `@fastify/swagger` from the registered routes, so the assertion is
    // about published paths and verbs, not about Nest decorator metadata.
    expect(Object.keys(recordOf(paths['/api/v1/CRMChat/action/capabilities']))).toContain('get');
    expect(Object.keys(recordOf(paths['/api/v1/CRMChat/action/health']))).toContain('get');
    expect(Object.keys(recordOf(paths['/api/v1/CRMChat/action/settings'])).sort()).toEqual(['get', 'post']);
    expect(String(recordOf(result.body['info'])['version'])).toBe('1.0.0');
  });

  it('ships a catalog that satisfies the i18n key convention', async () => {
    // A key that violates `KEY_RE` makes the loader reject the whole catalog and silently disable
    // translations, so this asserts the real contract rather than the JSON being parseable.
    const result = await call('GET', '/api/v1/I18n', ctx.adminToken);
    expect(result.status).toBe(200);
    const catalog = recordOf(result.body['catalog']);
    expect(catalog['web.crmChat.title']).toBe('CRM Chat');
    expect(catalog['web.crmChat.assistantState.not_configured']).toBeDefined();
  });
});
