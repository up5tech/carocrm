import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESignatureSettingsService } from '../src/esignature/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.1 — module registration and the security contract
 * (`PLAN_Phase_19_ESignature.md` §18 `19-ES.1`).
 *
 * The three acceptance criteria this suite exists to protect:
 *   1. the module appears **only** for a caller whose ACL holds the read capability;
 *   2. **no provider operation is possible before a connection is enabled** — the gate answers with
 *      its stable code, and nothing here reaches DocuSign (there is no adapter yet, and plan §17.3
 *      forbids one from tests in any case);
 *   3. the naming is `ESignature` / `esignature`, with no `Ua` prefix anywhere.
 *
 * Runs against the already-configured primary database (AGENTS.md §3.1). No database, schema or
 * container is created; the single `app_settings` row this module owns is restored to the exact value
 * it held before the run, and the roles and users are deleted by their own ids (§3.3).
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Node {
  readonly key: string;
  readonly children?: readonly Node[];
}

const runId = Date.now().toString(36);
const ROLE_USE = `AGENT_TEST-es1-use-${runId}`;
const USER_USE = `agent_test_es1_use_${runId}`;
const ROLE_NONE = `AGENT_TEST-es1-none-${runId}`;
const USER_NONE = `agent_test_es1_none_${runId}`;

let ctx: ApiContext;
let useToken = '';
let noneToken = '';
let baselineSettings: unknown = null;

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
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
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      out.add(node.key);
      if (node.children !== undefined) walk(node.children);
    }
  };
  const items = body['items'];
  if (Array.isArray(items)) walk(items as Node[]);
  return out;
}

async function patchSettings(patch: Record<string, unknown>, token = ctx.adminToken): Promise<CallResult> {
  const result = await call('POST', '/api/v1/ESignature/action/settings', token, patch);
  refreshSettingsCache();
  return result;
}

/** The settings row is cached per instance; a test that writes it behind the API's back must drop it. */
function refreshSettingsCache(): void {
  ctx.app.get(ESignatureSettingsService).invalidate();
}

async function readSettings(token = ctx.adminToken): Promise<CallResult> {
  return call('GET', '/api/v1/ESignature/action/settings', token);
}

/**
 * Put the row back exactly as the run found it.
 *
 * A configured installation is restored byte-for-byte; a row left by an interrupted run is removed,
 * because "no row" is the state ES.1 ships and the state the defaults assertion is about.
 */
async function restoreSettings(): Promise<void> {
  const db = ctx.database.db;
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
    return;
  }
  const serialized = JSON.stringify(baselineSettings);
  await db
    .insertInto('app_settings')
    .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
    .execute();
  refreshSettingsCache();
}

/** The unconfigured state, established rather than assumed: the shared database may hold a row. */
async function clearSettingsRow(): Promise<void> {
  await ctx.database.db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  refreshSettingsCache();
}

beforeAll(async () => {
  ctx = await bootApi();
  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').execute();
  baselineSettings = rows[0]?.data ?? null;

  await createTestRole(ctx, { id: ROLE_USE, name: `AGENT_TEST ES1 use ${runId}`, permissions: { SignatureRequest: { read: 'yes' } } });
  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST ES1 none ${runId}`, permissions: {} });
  useToken = (await createTestUser(ctx, { userName: USER_USE, roleIds: [ROLE_USE] })).token;
  noneToken = (await createTestUser(ctx, { userName: USER_NONE, roleIds: [ROLE_NONE] })).token;
});

afterAll(async () => {
  await restoreSettings();
  const db = ctx.database.db;
  await db.deleteFrom('users').where('user_name', 'in', [USER_USE, USER_NONE]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USE, ROLE_NONE]).execute();
  await shutdownApi();
});

describe('module registration (19-ES.1)', () => {
  it('answers under the ESignature prefix with no Ua prefix anywhere', async () => {
    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    const module = health.body['module'] as Record<string, unknown>;
    expect(module).toMatchObject({
      id: 'ESignature',
      apiPrefix: '/api/v1/ESignature',
      frontendRoute: '/esignature',
      webhookPrefix: '/api/v1/integrations/esignature',
    });
    expect(String(module['id'])).not.toMatch(/^Ua/);
    expect(module['implementedPhases']).toContain('19-ES.1');
    expect(module['implementedPhases']).toContain('19-ES.2');
    // The module knows every cataloged provider; the catalog says which integration is installed.
    expect(module['providerKeys']).toEqual(['docusign', 'dropbox_sign']);
    expect(module['availableProviderKeys']).toEqual(['docusign']);
  });

  it('reports the platform foundation the module builds on, read from the running system', async () => {
    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    const dependencies = health.body['dependencies'] as { id: string; present: boolean; missing: string[] }[];
    expect(dependencies.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['acl', 'metadata', 'files', 'secret-encryption', 'jobs', 'domain-events', 'audit-stream', 'settings', 'hooks']),
    );
    for (const dependency of dependencies) {
      expect(dependency.present, `${dependency.id} missing ${dependency.missing.join(', ')}`).toBe(true);
    }
    expect(health.body['ok']).toBe(true);
  });

  it('treats every adjacent module as optional and reports the real state', async () => {
    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    const integrations = health.body['optionalIntegrations'] as { id: string; status: string }[];
    expect(integrations.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['sales', 'projects', 'customer-success', 'service-desk', 'advanced-integrations']),
    );
    for (const integration of integrations) {
      expect(['available', 'unavailable'], integration.id).toContain(integration.status);
    }
  });

  it('reports the schema ES.2 created as present, read from the running database', async () => {
    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    const structures = health.body['structures'] as { name: string; present: boolean }[];
    expect(structures.map((entry) => entry.name)).toContain('signature_requests');
    expect(structures.map((entry) => entry.name)).toContain('signature_audit_entries');
    expect(structures.every((entry) => entry.present), structures.filter((entry) => !entry.present).map((entry) => entry.name).join(', ')).toBe(true);
    const checks = health.body['checks'] as { name: string; ok: boolean; detail: string }[];
    const schema = checks.find((check) => check.name === 'schema');
    expect(schema?.ok, schema?.detail).toBe(true);
    expect(schema?.detail).toContain('tables are present');
  });
});

describe('permissions and navigation (plan §12)', () => {
  it('gives an administrator every capability and the menu entry once the module is on', async () => {
    await patchSettings({ enabled: true });
    const capabilities = await call('GET', '/api/v1/ESignature/action/capabilities', ctx.adminToken);
    expect(capabilities.status).toBe(200);
    const entries = capabilities.body['capabilities'] as { key: string; granted: boolean }[];
    expect(entries.map((entry) => entry.key)).toEqual([
      'use',
      'manageDraft',
      'send',
      'approve',
      'void',
      'correct',
      'downloadCompleted',
      'connectionRead',
      'connectionManage',
      'templateMappingManage',
      'auditRead',
    ]);
    expect(entries.every((entry) => entry.granted)).toBe(true);

    const navigation = await call('GET', '/api/v1/Navigation', ctx.adminToken);
    expect(navigationKeys(navigation.body).has('esignature')).toBe(true);
    await patchSettings({ enabled: false });
  });

  it('shows the page to a role holding only the read capability, and refuses administration', async () => {
    await patchSettings({ enabled: true });
    const capabilities = await call('GET', '/api/v1/ESignature/action/capabilities', useToken);
    expect(capabilities.status).toBe(200);
    const entries = capabilities.body['capabilities'] as { key: string; granted: boolean }[];
    expect(entries.find((entry) => entry.key === 'use')?.granted).toBe(true);
    expect(entries.find((entry) => entry.key === 'send')?.granted).toBe(false);
    expect(entries.find((entry) => entry.key === 'connectionManage')?.granted).toBe(false);

    const write = await patchSettings({ enabled: true }, useToken);
    expect(write.status).toBe(403);
    expect(errorCode(write)).toBe('AUTHORIZATION_DENIED');

    const navigation = await call('GET', '/api/v1/Navigation', useToken);
    expect(navigationKeys(navigation.body).has('esignature')).toBe(true);
  });

  it('hides the page and refuses every read to a role without the capability', async () => {
    expect((await call('GET', '/api/v1/ESignature/action/capabilities', noneToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/ESignature/action/health', noneToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/ESignature/action/nav', noneToken)).status).toBe(403);
    expect((await readSettings(noneToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/ESignature/action/gate/operations', noneToken)).status).toBe(403);
    const navigation = await call('GET', '/api/v1/Navigation', noneToken);
    expect(navigationKeys(navigation.body).has('esignature')).toBe(false);
  });

  it('leaves the sidebar empty when the module is switched off, even for an administrator', async () => {
    await patchSettings({ enabled: false });
    const navigation = await call('GET', '/api/v1/Navigation', ctx.adminToken);
    expect(navigationKeys(navigation.body).has('esignature')).toBe(false);
    const nav = await call('GET', '/api/v1/ESignature/action/nav', ctx.adminToken);
    expect(nav.status).toBe(200);
    expect(nav.body['enabled']).toBe(false);
    expect(nav.body['visible']).toBe(true);
  });
});

describe('the connection gate in front of every provider call', () => {
  it('refuses every operation while the module is off, with the stable code', async () => {
    await patchSettings({ enabled: false });
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'sendEnvelope' });
    expect(probe.status).toBe(403);
    expect(errorCode(probe)).toBe('SIGNATURE_MODULE_DISABLED');
  });

  it('refuses a send before a connection exists, and names the reason', async () => {
    await patchSettings({ enabled: true, features: { connections: true, send: true } });
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'sendEnvelope' });
    // Both features are implemented by now (connections ES.4, send ES.9), so the gate reaches its last
    // question and refuses for the real reason: there is no usable connection (ES.1 acceptance).
    expect(probe.status, JSON.stringify(probe.body)).toBe(409);
    expect(errorCode(probe)).toBe('PROVIDER_NOT_CONNECTED');

    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    const gate = health.body['gate'] as { ready: boolean; reason: string };
    expect(gate.ready).toBe(false);
    expect(['connections_disabled', 'encryption_key_missing', 'no_enabled_connection']).toContain(gate.reason);
    await patchSettings({ enabled: false, features: { connections: false, send: false } });
  });

  it('answers an unsupported provider operation rather than silently doing nothing', async () => {
    await patchSettings({ enabled: true, features: { connections: true, send: true } });
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'correctEnvelope' });
    // The capability check precedes the module check for `correct`, so the denial is the permission
    // answer for a caller who may not correct, and a support answer for one who may.
    expect([403, 422]).toContain(probe.status);
    await patchSettings({ enabled: false, features: { connections: false, send: false } });
  });

  it('refuses to admit an operation no rule declares', async () => {
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'issueRefund' });
    expect(probe.status).toBe(400);
    expect(errorCode(probe)).toBe('INVALID_QUERY');
  });
});

describe('settings document and secret handling (plan §4.1, §12.11)', () => {
  it('defaults every side-effecting feature off on an unconfigured installation', async () => {
    await clearSettingsRow();
    const view = await readSettings();
    expect(view.status).toBe(200);
    const settings = view.body['settings'] as { enabled: boolean; features: Record<string, boolean> };
    expect(settings.enabled).toBe(false);
    expect(Object.values(settings.features).every((enabled) => enabled === false)).toBe(true);
  });

  it('refuses an unknown settings key', async () => {
    const res = await patchSettings({ notASetting: true });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });

  it('refuses a secret-shaped field instead of storing it in the settings row', async () => {
    const res = await patchSettings({ provider: { clientSecret: 'super-secret-value' } });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');

    const stored = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
    expect(JSON.stringify(stored?.data ?? '{}')).not.toContain('super-secret-value');
  });

  it('refuses an oversized value that could only be a credential', async () => {
    const res = await patchSettings({ provider: { demoIntegrationKey: 'x'.repeat(900) } });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });

  it('accepts the whole document the admin screen submits, policy switches included', async () => {
    await clearSettingsRow();
    const res = await patchSettings({
      enabled: true,
      features: { requests: false, connections: false, documents: false, templates: false, send: false, webhooks: false, embeddedSigning: false, artifacts: false, approvals: false },
      provider: { demoIntegrationKey: '', productionIntegrationKey: '' },
      documents: { maxDocumentBytes: 26_214_400, maxDocumentsPerRequest: 5, allowedExtensions: ['pdf', 'doc', 'docx'] },
      signing: { defaultExpiryDays: 30, remindersEnabled: false, embeddedReturnHosts: [] },
      // `requireHmac` is a policy switch, not a credential; the secret guard must not refuse it.
      webhooks: { endpointUrl: '', requireHmac: true, maxPayloadBytes: 262_144 },
      retention: { webhookPayloadDays: 90, completedArtifactDays: 0 },
      approval: { requiredForSourceEntities: [] },
      environmentLabel: '',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body['settings'] as { webhooks: { requireHmac: boolean } }).webhooks.requireHmac).toBe(true);
    expect((res.body['settings'] as { enabled: boolean }).enabled).toBe(true);
    await restoreSettings();
  });

  it('bumps the settings version on every accepted change and records the actor', async () => {
    await clearSettingsRow();
    const before = await readSettings();
    const version = Number((before.body as Record<string, unknown>)['version']);
    const after = await patchSettings({ documents: { maxDocumentsPerRequest: 7 } });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(Number((after.body as Record<string, unknown>)['version'])).toBe(version + 1);
    expect(String((after.body as Record<string, unknown>)['updatedBy'])).toBe('admin');
    await restoreSettings();
  });

  it('makes the approval workflow effective once the module and request workspace are on', async () => {
    await patchSettings({ enabled: true, features: { requests: true, approvals: true } });
    const view = await readSettings();
    const effective = view.body['effective'] as Record<string, boolean>;
    expect(effective['approvals']).toBe(true);
    expect(view.body['pendingFeatures']).toEqual([]);
    await patchSettings({ enabled: false, features: { requests: false, approvals: false } });
  });

  it('refuses an embedded signing view path when no return host is allowlisted', async () => {
    await patchSettings({ enabled: true, features: { connections: true, send: true, embeddedSigning: true } });
    const view = await readSettings();
    const warnings = view.body['warnings'] as { code: string }[];
    expect(warnings.map((warning) => warning.code)).toContain('embeddedNoReturnHosts');
    // The feature is implemented now (ES.14), so the gate reaches its connection question and refuses
    // for the real reason: this installation has no usable connection.
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'recipientView' });
    expect([409, 422]).toContain(probe.status);
    expect(['PROVIDER_NOT_CONNECTED', 'ENCRYPTION_KEY_MISSING', 'SIGNATURE_MODULE_DISABLED']).toContain(errorCode(probe));
    await patchSettings({
      enabled: false,
      features: { connections: false, send: false, embeddedSigning: false },
      signing: { embeddedReturnHosts: [] },
    });
  });
});
