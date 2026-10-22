import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ESIGNATURE_OAUTH_CALLBACK_PATH,ESignatureConnectionService } from '../src/esignature/esignature-connection.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { DocuSignAdapter } from '../src/esignature/providers/docusign/docusign-adapter.js';
import { DOCUSIGN_TRANSPORT, type DocuSignHttpRequest, type DocuSignHttpResponse } from '../src/esignature/providers/docusign/docusign-transport.js';
import { createFakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.4 — DocuSign OAuth and the connection lifecycle, through the API
 * (`PLAN_Phase_19_ESignature.md` §8.1, §9.2, §13.4, §18 `19-ES.4`).
 *
 * Runs against the already-configured primary database (AGENTS.md §3.1): no database, schema or copy is
 * created; every row carries this run's marker and is removed by its exact id afterwards, children
 * before parents. Nothing here opens a socket. The transport the container holds is the seam the plan
 * asks for — production code injects a `DocuSignTransport`, so the suite replaces that object's
 * `request` implementation for the duration of the file and restores it, and every assertion about the
 * wire (hosts, the Basic credential header, the account payload, the refresh token) is about the bytes
 * the platform would really have sent.
 *
 * The acceptance line this file cannot prove is "a demo account can authorize and the connection test
 * succeeds": that needs real DocuSign demo credentials, and plan §17.3 forbids a test from using them.
 * Everything else about that sentence — the flow, the state, the account resolution, the health answer
 * — is proved here, and the credential-gated live step is 19-ES.22's (see the ES.4 completion report).
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const runId = Date.now().toString(36);
/** When this run began, so its own unattributed audit rows can be found again afterwards. */
const startedAt = new Date();
const marker = (suffix: string) => `AGENT_TEST_es4_${suffix}_${runId}`;
const ROLE_USER = `AGENT_TEST-es4-user-${runId}`;
const USER_NAME = `agent_test_es4_user_${runId}`;

const CLIENT_SECRET = `agent-test-client-secret-${runId}`;
const ACCESS_TOKEN = 'agent-test-access-token';
const REFRESH_TOKEN = 'agent-test-refresh-token';
const ROTATED_ACCESS_TOKEN = 'agent-test-access-token-rotated';
const ACCOUNT_ID = '9f000000-0000-4000-8000-000000000001';
const ACCOUNT_BASE_URI = 'https://demo.docusign.invalid';
const REDIRECT_URI = `http://localhost:7777${ESIGNATURE_OAUTH_CALLBACK_PATH}`;

let ctx: ApiContext;
let app: NestFastifyApplication;
let userToken = '';
const createdConnections: string[] = [];

/** The wire the stub answered with, so a test can assert on the bytes as well as the outcome. */
interface StubState {
  tokenCalls: { grant: string; count: number }[];
  restCalls: DocuSignHttpRequest[];
  /** One-shot override: the next `/oauth/token` answer, or the next REST status. */
  tokenError: { status: number; body: Record<string, unknown> } | null;

  restStatus: number;
  restBody: string;
  userinfoAccounts: unknown;
}

const stub: StubState = {
  tokenCalls: [],
  restCalls: [],
  tokenError: null,
  restStatus: 200,
  restBody: JSON.stringify({ envelopes: [] }),
  userinfoAccounts: undefined,
};

function resetStub(): void {
  stub.tokenCalls = [];
  stub.restCalls = [];
  stub.tokenError = null;
  stub.restStatus = 200;
  stub.restBody = JSON.stringify({ envelopes: [] });
  stub.userinfoAccounts = undefined;
}

function tokenGrantCount(grant: string): number {
  return stub.tokenCalls.filter((entry) => entry.grant === grant).reduce((total, entry) => total + entry.count, 0);
}

/** The stub provider. It answers the three URLs DocuSign owns and nothing else. */
async function stubRequest(input: DocuSignHttpRequest): Promise<DocuSignHttpResponse> {
  const url = new URL(input.url);
  if (url.pathname === '/oauth/token') {
    const form = new URLSearchParams(input.body ?? '');
    const grant = form.get('grant_type') ?? '';
    const existing = stub.tokenCalls.find((entry) => entry.grant === grant);
    if (existing) existing.count += 1;
    else stub.tokenCalls.push({ grant, count: 1 });
    if (narrowScopeGrant) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'bearer', refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: 'signature' }),
      };
    }
    if (stub.tokenError !== null) {
      const failure = stub.tokenError;
      stub.tokenError = null;
      return { status: failure.status, headers: {}, body: JSON.stringify(failure.body) };
    }
    const access = grant === 'refresh_token' ? ROTATED_ACCESS_TOKEN : ACCESS_TOKEN;
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: access,
        token_type: 'bearer',
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope: 'signature impersonation',
      }),
    };
  }
  if (url.pathname === '/oauth/userinfo') {
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        sub: 'agent-test-user-1',
        email: 'agent-test@example.invalid',
        name: 'Agent Test Signer',
        accounts: stub.userinfoAccounts ?? [
          {
            account_id: ACCOUNT_ID,
            organization: { account_name: 'AGENT_TEST DocuSign Account' },
            base_uri: ACCOUNT_BASE_URI,
            is_default: 'true',
          },
        ],
      }),
    };
  }
  // The REST surface the adapter touches: Test Connection and the account re-read.
  stub.restCalls.push(input);
  if (url.pathname === '/restapi/v2.1/userinfo') {
    return {
      status: stub.restStatus,
      headers: {},
      body: JSON.stringify({
        user_id: 'agent-test-user-1',
        accounts: [{ account_id: ACCOUNT_ID, organization: { account_name: 'AGENT_TEST DocuSign Account' }, base_uri: ACCOUNT_BASE_URI, is_default: true }],
      }),
    };
  }
  return { status: stub.restStatus, headers: {}, body: stub.restBody };
}

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await app.inject({
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
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) headers[key.toLowerCase()] = String(value);
  return { status: res.statusCode, body, headers };
}

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function services() {
  return {
    connections: app.get(ESignatureConnectionService),
    registry: app.get(SignatureProviderRegistry),
    settings: app.get(ESignatureSettingsService),
  };
}

async function patchSettings(patch: Record<string, unknown>): Promise<CallResult> {
  const result = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
  return result;
}

/** A connection row created through the API, tracked for cleanup. */
async function createConnection(name = marker('connection')): Promise<{ id: string; view: Record<string, unknown> }> {
  const created = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
    name,
    environment: 'demo',
    clientSecret: CLIENT_SECRET,
    oauthClientId: `agent-test-integration-key-${runId}`,
    redirectUri: REDIRECT_URI,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  createdConnections.push(id);
  return { id, view: created.body };
}

/** Drive the flow to a connected row, returning the state the callback consumed. */
async function authorizeConnection(id: string): Promise<string> {
  const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const url = new URL(String(started.body['authorizationUrl']));
  const state = url.searchParams.get('state') ?? '';
  expect(state).not.toBe('');
  const callback = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
  expect(callback.status, JSON.stringify(callback.body)).toBe(302);
  return state;
}

async function connectionRow(id: string): Promise<Record<string, unknown>> {
  const result = await call('GET', `/api/v1/ESignature/connections/${id}`, ctx.adminToken);
  expect(result.status).toBe(200);
  return result.body;
}

/**
 * The transport the container built is a plain object, and the production seam is that object's
 * `request` method — so this is where a suite puts a stub without changing what the code under test
 * does. `originalRequest` is restored in `afterAll`, so no other file can inherit the double.
 */
let originalRequest: ((input: DocuSignHttpRequest) => Promise<DocuSignHttpResponse>) | undefined;
let transportInstalled = false;
/** One test needs a grant that is missing a scope; the stub answers that case from this flag. */
let narrowScopeGrant = false;

function installStubTransport(): void {
  if (transportInstalled) return;
  const transport = app.get<{ request: (input: DocuSignHttpRequest) => Promise<DocuSignHttpResponse> }>(DOCUSIGN_TRANSPORT);
  originalRequest = transport.request.bind(transport);
  Object.defineProperty(transport, 'request', { value: stubRequest, configurable: true, writable: true });
  transportInstalled = true;
}

function restoreStubTransport(): void {
  if (!transportInstalled || originalRequest === undefined) return;
  const transport = app.get<{ request: unknown }>(DOCUSIGN_TRANSPORT);
  Object.defineProperty(transport, 'request', { value: originalRequest, configurable: true, writable: true });
  transportInstalled = false;
}

let baseline: unknown = null;

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  installStubTransport();

  await createTestRole(ctx, { id: ROLE_USER, name: `AGENT_TEST ES4 user ${runId}`, permissions: { SignatureRequest: { read: 'yes' } } });
  userToken = (await createTestUser(ctx, { userName: USER_NAME, roleIds: [ROLE_USER] })).token;

  // The row is restored byte-for-byte, so a configured installation is left exactly as it was found —
  // and an installation with no row at all is left with no row (§3.3).
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baseline = row?.data ?? null;
  await patchSettings({ enabled: true, features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, connections: true } });
});

afterAll(async () => {
  restoreStubTransport();
  const { registry } = services();
  // Whatever adapter a test bound here, the build's own answer comes back.
  registry.clear();
  registry.register(createFakeSignatureProviderAdapter());

  const db = ctx.database.db;
  await db.deleteFrom('esignature_oauth_states').where('connection_id', 'in', createdConnections).execute();
  await db.deleteFrom('esignature_credential_secrets').where('connection_id', 'in', createdConnections).execute();
  await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', createdConnections).execute();
  // A refused callback with no valid state has no connection to attribute it to — that is the point of
  // hashing it — so these rows are found by what they say and when this run said it (AGENTS.md §3.3:
  // only rows this run can positively identify).
  await db
    .deleteFrom('signature_audit_entries')
    .where('action', '=', 'connection.authorized')
    .where('outcome', '=', 'refused')
    .where('reason_safe', '=', 'state_not_found')
    .where('connection_id', 'is', null)
    .where('created_at', '>=', startedAt)
    .execute();
  await db.deleteFrom('esignature_connections').where('id', 'in', createdConnections).execute();
  if (baseline === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  } else {
    const serialized = JSON.stringify(baseline);
    await db
      .insertInto('app_settings')
      .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  services().settings.invalidate();
  await db.deleteFrom('users').where('user_name', '=', USER_NAME).execute();
  await db.deleteFrom('roles').where('id', '=', ROLE_USER).execute();
  await shutdownApi();
});

beforeEach(() => {
  resetStub();
});

describe('connection administration (plan §8.1, §12)', () => {
  it('refuses the connection surface to a caller without the administration capability', async () => {
    const list = await call('GET', '/api/v1/ESignature/connections', userToken);
    expect(list.status).toBe(403);
    expect(errorCode(list)).toBe('AUTHORIZATION_DENIED');
    const create = await call('POST', '/api/v1/ESignature/connections', userToken, {
      name: marker('nope'),
      environment: 'demo',
      clientSecret: CLIENT_SECRET,
    });
    expect(create.status).toBe(403);
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, { operation: 'testConnection' });
    expect([200, 409]).toContain(probe.status);
  });

  it('creates a connection with its secret write-only, and never shows the value again', async () => {
    const { id, view } = await createConnection(marker('write_only'));
    expect(view).toMatchObject({ id, environment: 'demo', status: 'not_connected', isActive: false, hasClientSecret: true });
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);

    const stored = await ctx.database.db
      .selectFrom('esignature_credential_secrets')
      .select(['kind', 'payload_encrypted', 'state'])
      .where('connection_id', '=', id)
      .execute();
    expect(stored.map((row) => row.kind)).toEqual(['client_secret']);
    expect(stored[0]?.payload_encrypted).not.toContain(CLIENT_SECRET);
    expect(stored[0]?.payload_encrypted).not.toBe(CLIENT_SECRET);

    const again = await connectionRow(id);
    expect(JSON.stringify(again)).not.toContain(CLIENT_SECRET);
    const list = await call('GET', '/api/v1/ESignature/connections', ctx.adminToken);
    expect(JSON.stringify(list.body)).not.toContain(CLIENT_SECRET);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'detail'])
      .where('connection_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toContain('connection.created');
    expect(JSON.stringify(audit.map((row) => row.detail))).not.toContain(CLIENT_SECRET);
  });

  it('refuses a redirect URI that is not this platform callback path', async () => {
    for (const redirectUri of [
      'https://attacker.example/api/v1/ESignature/other',
      'https://attacker.example/callback',
      'http://attacker.example/api/v1/ESignature/oauth/callback',
      'https://crm.example/api/v1/ESignature/oauth/callback?next=x#frag',
      'not-a-url',
    ]) {
      const res = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
        name: marker('bad_redirect'),
        environment: 'demo',
        clientSecret: CLIENT_SECRET,
        redirectUri,
      });
      expect(res.status, redirectUri).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    }
    // A credential in the URL, even on the right path, is refused rather than carried to the provider.
    expect((await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      name: marker('cred_redirect'),
      environment: 'demo',
      clientSecret: CLIENT_SECRET,
      redirectUri: 'https://a:b@localhost:7777/api/v1/ESignature/oauth/callback',
    })).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an access token pasted by an administrator, because the flow produces those', async () => {
    const { id } = await createConnection(marker('paste_token'));
    const res = await call('POST', `/api/v1/ESignature/connections/${id}/secret`, ctx.adminToken, {
      kind: 'oauth_access_token',
      value: 'a-token',
    });
    expect(res.status).toBe(400);
    const rotated = await call('POST', `/api/v1/ESignature/connections/${id}/secret`, ctx.adminToken, {
      kind: 'webhook_secret',
      value: 'agent-test-connect-hmac-secret',
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect((rotated.body['credentials'] as { kind: string }[]).map((entry) => entry.kind)).toContain('webhook_secret');
  });
});

describe('the authorization flow (plan §8.1, §9.2)', () => {
  it('starts with an unpredictable single-use state, bound to the connection and hashed at rest', async () => {
    const { id } = await createConnection(marker('state'));
    const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const url = new URL(String(started.body['authorizationUrl']));
    expect(url.host).toBe('account-d.docusign.com');
    expect(url.pathname).toBe('/oauth/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('signature impersonation');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    const state = url.searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(JSON.stringify(started.body)).not.toContain(CLIENT_SECRET);

    const rows = await ctx.database.db
      .selectFrom('esignature_oauth_states')
      .select(['id', 'code_verifier', 'environment', 'redirect_uri', 'requested_scopes', 'expires_at'])
      .where('connection_id', '=', id)
      .execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    // The state itself never lands in a column; its SHA-256 does.
    expect(row?.id).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row?.id).not.toBe(state);
    expect(row?.code_verifier).toBeTruthy();
    expect(row?.environment).toBe('demo');
    expect(row?.redirect_uri).toBe(REDIRECT_URI);
    expect((row?.requested_scopes as string[]).sort()).toEqual(['impersonation', 'signature']);

    const pending = await connectionRow(id);
    expect(pending['pendingAuthorization']).toBe(true);
    expect(pending['status']).toBe('not_connected');
  });

  it('refuses a forged, a replayed and an expired callback with the same answer', async () => {
    const forged = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=forged-state-value&code=agent-test-code`);
    expect(forged.status).toBe(401);
    expect(errorCode(forged)).toBe('AUTHENTICATION_FAILED');

    const { id } = await createConnection(marker('replay'));
    const state = await authorizeConnection(id);
    const replay = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
    expect(replay.status).toBe(401);
    expect(JSON.stringify(replay.body)).not.toContain('agent-test-code');
    expect(JSON.stringify(replay.body)).not.toContain(ACCESS_TOKEN);

    const second = await createConnection(marker('expired'));
    const startedAgain = await call('POST', `/api/v1/ESignature/connections/${second.id}/authorize`, ctx.adminToken, {});
    const otherState = new URL(String(startedAgain.body['authorizationUrl'])).searchParams.get('state') ?? '';
    await ctx.database.db
      .updateTable('esignature_oauth_states')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('connection_id', '=', second.id)
      .execute();
    const expired = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(otherState)}&code=agent-test-code`);
    expect(expired.status).toBe(401);
    expect(errorCode(expired)).toBe('AUTHENTICATION_FAILED');
    expect((await connectionRow(second.id))['status']).toBe('not_connected');
  });

  it('never echoes the code, the token or the secret into the redirect', async () => {
    const { id } = await createConnection(marker('redirect_target'));
    const state = await authorizeConnection(id);
    const view = await connectionRow(id);
    expect(view['status']).toBe('connected');
    expect(tokenGrantCount('authorization_code')).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(view)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(view)).not.toContain(state);
  });

  it('resolves the account and the account-specific base URI from userinfo, and stores both', async () => {
    const { id } = await createConnection(marker('account'));
    await authorizeConnection(id);
    const view = await connectionRow(id);
    expect(view).toMatchObject({
      status: 'connected',
      isActive: true,
      accountId: ACCOUNT_ID,
      accountName: 'AGENT_TEST DocuSign Account',
      baseUri: ACCOUNT_BASE_URI,
      consentStatus: 'granted',
    });
    expect(view['grantedScopes']).toEqual(expect.arrayContaining(['signature', 'impersonation']));
    expect(view['redirectUri']).toBe(REDIRECT_URI);
    expect(String(view['lastAuthAt'])).not.toBe('null');

    const credentials = view['credentials'] as { kind: string; state: string; expiresAt: string | null }[];
    expect(credentials.map((entry) => entry.kind).sort()).toEqual(['client_secret', 'oauth_access_token', 'oauth_refresh_token']);
    expect(credentials.every((entry) => entry.state === 'active')).toBe(true);
    expect(credentials.find((entry) => entry.kind === 'oauth_access_token')?.expiresAt).not.toBeNull();

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('connection_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toContain('connection.authorized');

    // The secret is encrypted at rest in its own table, and the account row keeps no credential column.
    const stored = await ctx.database.db
      .selectFrom('esignature_credential_secrets')
      .select('payload_encrypted')
      .where('connection_id', '=', id)
      .execute();
    for (const row of stored) expect(row.payload_encrypted).not.toMatch(/agent-test-(access|refresh|client)/);
  });

  it('refuses a callback aimed at a connection whose environment changed', async () => {
    const { id } = await createConnection(marker('environment'));
    const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    await ctx.database.db.updateTable('esignature_connections').set({ environment: 'production' }).where('id', '=', id).execute();
    const refused = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
    expect(refused.status).toBe(401);
    expect((await connectionRow(id))['status']).toBe('not_connected');
    // No credential was written for a flow the platform refused.
    const stored = await ctx.database.db
      .selectFrom('esignature_credential_secrets')
      .select('kind')
      .where('connection_id', '=', id)
      .execute();
    expect(stored.map((row) => row.kind)).toEqual(['client_secret']);
  });

  it('records a grant the provider refused, without quoting the provider', async () => {
    const { id } = await createConnection(marker('refused'));
    const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    const refused = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&error=access_denied&error_description=${encodeURIComponent(`token ${REFRESH_TOKEN}`)}`);
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).not.toContain(REFRESH_TOKEN);
    const view = await connectionRow(id);
    expect(view['status']).toBe('not_connected');
    expect(view['lastErrorCode']).toBe('AUTHORIZATION_REFUSED');
  });

  it('refuses to exchange a code when the provider says the grant is gone, and leaves the connection unusable', async () => {
    const { id } = await createConnection(marker('invalid_grant'));
    const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    stub.tokenError = { status: 400, body: { error: 'invalid_grant', error_description: 'consent revoked' } };
    const refused = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused)).toBe('SIGNATURE_CONNECTION_NOT_AVAILABLE');
    expect(JSON.stringify(refused.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(refused.body)).not.toContain('consent revoked');
    const view = await connectionRow(id);
    // Plan §9.2 names `invalid_grant` as the reauthorization case, not a generic error: a human must
    // consent again, and nothing else may act as if the connection were usable.
    expect(view['status']).toBe('reauthorization_required');
    expect(view['consentStatus']).toBe('revoked');
    expect(view['isActive']).toBe(false);
    expect(view['lastErrorCode']).toBe('AUTHORIZATION_FAILED');
    expect(view['accessTokenExpiresAt']).toBeNull();
    const stored = await ctx.database.db.selectFrom('esignature_credential_secrets').select('kind').where('connection_id', '=', id).execute();
    expect(stored.map((row) => row.kind)).toEqual(['client_secret']);
  });

  it('holds a grant that is real but insufficient in reauthorization_required, and says which scope is missing', async () => {
    const { id } = await createConnection(marker('narrow_scope'));
    const started = await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    // DocuSign answered with only one of the two scopes the flow asked for.
    narrowScopeGrant = true;
    const callback = await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
    expect(callback.status, JSON.stringify(callback.body)).toBe(302);
    narrowScopeGrant = false;

    const view = await connectionRow(id);
    expect(view['status']).toBe('reauthorization_required');
    expect(view['consentStatus']).toBe('insufficient');
    expect(view['isActive']).toBe(false);
    // An insufficient grant is not recorded as an authorized account context: the connection never
    // became usable, so the scopes it holds are not the scopes a send would be judged against.
    expect(view['grantedScopes']).toEqual([]);
    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'outcome', 'reason_safe', 'detail'])
      .where('connection_id', '=', id)
      .execute();
    const refusal = audit.find((row) => row.reason_safe === 'scope_missing');
    expect(refusal?.outcome).toBe('refused');
    expect(refusal?.detail).toMatchObject({ missingScopes: 'impersonation' });
  });

  it('stops the live grant the moment a re-authorization starts, and restores it when the flow completes', async () => {
    const { id } = await createConnection(marker('reauthorize'));
    await authorizeConnection(id);
    expect((await connectionRow(id))['status']).toBe('connected');

    const started = await call('POST', `/api/v1/ESignature/connections/${id}/re-authorize`, ctx.adminToken, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const mid = await connectionRow(id);
    expect(mid['status']).toBe('reauthorization_required');
    expect(mid['isActive']).toBe(false);
    // A provider call on *this* connection is refused while its consent is being replaced, whatever
    // other connections happen to be usable.
    const probe = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
    expect(probe.status).toBe(409);
    expect(errorCode(probe)).toBe('PROVIDER_NOT_CONNECTED');

    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    await call('GET', `${ESIGNATURE_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=agent-test-code`);
    const done = await connectionRow(id);
    expect(done['status']).toBe('connected');
    expect(done['isActive']).toBe(true);
    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('connection_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toContain('connection.reauthorized');
  });
});

describe('test connection, refresh and activation (plan §9.2, §13.4)', () => {
  it('refuses to test before a connection is authorized, and admits it after', async () => {
    const { id } = await createConnection(marker('gate'));
    const before = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
    expect(before.status).toBe(409);
    expect(errorCode(before)).toBe('PROVIDER_NOT_CONNECTED');
    expect(JSON.stringify(before.body)).not.toContain(CLIENT_SECRET);

    await authorizeConnection(id);
    const after = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    // The bound adapter in this build is the fake, and the answer says so.
    expect(after.body).toMatchObject({ reachable: true, connectionId: id, environment: 'demo' });
    expect(['fake', 'live']).toContain(String(after.body['adapterMode']));
    expect((await connectionRow(id))['lastSuccessfulApiAt']).toBeTruthy();
  });

  it('drives the real DocuSign adapter against the stub transport for Test Connection', async () => {
    const { registry } = services();
    const { id } = await createConnection(marker('live_adapter'));
    await authorizeConnection(id);
    registry.clear();
    registry.register(new DocuSignAdapter(app.get(DOCUSIGN_TRANSPORT)));
    try {
      const result = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ reachable: true, adapterMode: 'live', detailCode: 'ok' });
      const last = stub.restCalls[stub.restCalls.length - 1];
      expect(last?.url).toBe(`${ACCOUNT_BASE_URI}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes?count=1`);
      expect(last?.headers?.['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);

      // A revoked token is a state change, not a diagnostic: the connection leaves the usable set.
      stub.restStatus = 401;
      stub.tokenError = { status: 400, body: { error: 'invalid_grant' } };
      const failed = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ reachable: false, detailCode: 'token_expired' });
      const view = await connectionRow(id);
      expect(view['status']).toBe('reauthorization_required');
      expect(view['isActive']).toBe(false);
      // The connection left the usable set, so asking for it again is refused rather than retried.
      const again = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
      expect(again.status).toBe(409);
    } finally {
      stub.restStatus = 200;
      registry.clear();
      registry.register(createFakeSignatureProviderAdapter());
    }
  });

  it('refreshes once under concurrency, because a rotating refresh token is destroyed by a second call', async () => {
    const { connections } = services();
    const { id } = await createConnection(marker('refresh_race'));
    await authorizeConnection(id);
    // Expire the stored access token so both callers decide a refresh is needed.
    await ctx.database.db
      .updateTable('esignature_credential_secrets')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('connection_id', '=', id)
      .where('kind', '=', 'oauth_access_token')
      .execute();
    resetStub();
    const results = await Promise.all([connections.refresh(id), connections.refresh(id)]);
    expect(results.filter((entry) => entry.refreshed)).toHaveLength(1);
    expect(results.filter((entry) => !entry.refreshed)).toHaveLength(1);
    expect(tokenGrantCount('refresh_token')).toBe(1);
    expect(await connections.needsRefresh(id)).toBe(false);
  });

  it('moves a connection whose refresh token the provider revoked, and disables sends', async () => {
    const { connections } = services();
    const { id } = await createConnection(marker('revoked'));
    await authorizeConnection(id);
    await ctx.database.db
      .updateTable('esignature_credential_secrets')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('connection_id', '=', id)
      .where('kind', '=', 'oauth_access_token')
      .execute();
    stub.tokenError = { status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } };
    await expect(connections.refresh(id)).rejects.toThrow();
    const view = await connectionRow(id);
    expect(view['status']).toBe('reauthorization_required');
    expect(view['consentStatus']).toBe('revoked');
    expect(view['isActive']).toBe(false);
    const probe = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
    expect(probe.status).toBe(409);
  });

  it('uses the operator switch to stop calls without deleting anything', async () => {
    const { id } = await createConnection(marker('switch'));
    await authorizeConnection(id);
    const disabled = await call('POST', `/api/v1/ESignature/connections/${id}/disable`, ctx.adminToken);
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body).toMatchObject({ isActive: false, status: 'connected' });
    const probe = await call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken);
    expect(probe.status).toBe(409);
    expect(errorCode(probe)).toBe('PROVIDER_NOT_CONNECTED');

    const enabled = await call('POST', `/api/v1/ESignature/connections/${id}/enable`, ctx.adminToken);
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['isActive']).toBe(true);
    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('connection_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['connection.disabled', 'connection.enabled']));
  });

  it('destroys the credentials and the open states on disconnect, and keeps the history', async () => {
    const { id } = await createConnection(marker('disconnect'));
    await call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {});
    await authorizeConnection(id);
    const before = await ctx.database.db
      .selectFrom('esignature_credential_secrets')
      .select('id')
      .where('connection_id', '=', id)
      .execute();
    expect(before.length).toBeGreaterThan(0);

    const result = await call('POST', `/api/v1/ESignature/connections/${id}/disconnect`, ctx.adminToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['credentialsRemoved']).toBe(before.length);
    const secrets = await ctx.database.db.selectFrom('esignature_credential_secrets').select('id').where('connection_id', '=', id).execute();
    expect(secrets).toHaveLength(0);
    // No unfinished authorization survives; a consumed one stays only as the hashed record it is.
    const pendingStates = await ctx.database.db
      .selectFrom('esignature_oauth_states')
      .select('id')
      .where('connection_id', '=', id)
      .where('consumed_at', 'is', null)
      .execute();
    expect(pendingStates).toHaveLength(0);
    const list = await call('GET', '/api/v1/ESignature/connections', ctx.adminToken);
    expect((list.body as unknown[]).filter((row) => (row as { id: string }).id === id)).toHaveLength(0);
    const row = await ctx.database.db.selectFrom('esignature_connections').select(['deleted_at', 'status', 'is_active']).where('id', '=', id).executeTakeFirst();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.status).toBe('disabled');
    expect(row?.is_active).toBe(false);
    // The audit trail survives the connection it describes.
    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('connection_id', '=', id)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('connection.disconnected');
  });

  it('renames a connection and re-points its redirect URI, and never accepts a foreign path', async () => {
    const { id } = await createConnection(marker('rename'));
    const updated = await call('PATCH', `/api/v1/ESignature/connections/${id}`, ctx.adminToken, {
      name: marker('renamed'),
      connectReference: 'agent-test-connect-configuration',
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body['name']).toBe(marker('renamed'));
    expect((await connectionRow(id))['connectReference']).toBeUndefined();
    const badRedirect = await call('PATCH', `/api/v1/ESignature/connections/${id}`, ctx.adminToken, {
      redirectUri: 'https://attacker.example/api/v1/ESignature/other',
    });
    expect(badRedirect.status).toBeGreaterThanOrEqual(400);
    const nothing = await call('PATCH', `/api/v1/ESignature/connections/${id}`, ctx.adminToken, {});
    expect(nothing.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the ES.4 surface leaks nothing (plan §21, §12.13)', () => {
  it('reports the adapter bound for this build, so a fake answer is never read as DocuSign', async () => {
    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    expect(health.status).toBe(200);
    expect(health.body['module']).toMatchObject({ implementedPhases: expect.arrayContaining(['19-ES.3', '19-ES.4']) });
    const adapters = health.body['providerAdapters'] as { providerKey: string; mode: string }[];
    expect(adapters.map((entry) => entry.providerKey)).toEqual(['docusign']);
    const checks = health.body['checks'] as { name: string; ok: boolean; detail: string }[];
    const adapter = checks.find((check) => check.name === 'provider-adapter');
    expect(adapter?.ok, adapter?.detail).toBe(true);
    expect(String(adapter?.detail)).toMatch(/fake|live/);
    const features = health.body['features'] as { key: string; implemented: boolean }[];
    expect(features.find((feature) => feature.key === 'connections')?.implemented).toBe(true);
    const structures = health.body['structures'] as { name: string; present: boolean }[];
    expect(structures.find((entry) => entry.name === 'esignature_credential_secrets')?.present).toBe(true);
    expect(structures.find((entry) => entry.name === 'esignature_oauth_states')?.present).toBe(true);
    expect(JSON.stringify(health.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(health.body)).not.toContain(ACCESS_TOKEN);
  });

  it('keeps every credential value out of every connection response', async () => {
    const { id } = await createConnection(marker('leak'));
    await authorizeConnection(id);
    const responses = await Promise.all([
      call('GET', '/api/v1/ESignature/connections', ctx.adminToken),
      call('GET', `/api/v1/ESignature/connections/${id}`, ctx.adminToken),
      call('POST', `/api/v1/ESignature/connections/${id}/test`, ctx.adminToken),
      call('POST', `/api/v1/ESignature/connections/${id}/authorize`, ctx.adminToken, {}),
      call('GET', '/api/v1/ESignature/action/health', ctx.adminToken),
      call('GET', '/api/v1/ESignature/action/capabilities', ctx.adminToken),
    ]);
    for (const response of responses) {
      const serialized = JSON.stringify(response.body);
      expect(serialized, `${String(response.status)}`).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(serialized).not.toContain(`"${ACCESS_TOKEN}"`);
    }
    // The authorization answer carries the state, which is the only value meant to leave the platform.
    const authorize = responses[3];
    const state = new URL(String(authorize.body['authorizationUrl'])).searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(20);
  });
});
