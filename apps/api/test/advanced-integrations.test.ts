import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
  redactSecrets,
  secretHint,
} from '../src/advanced-integrations/advanced-integrations-domain.js';
import { ADVANCED_INTEGRATIONS_CONTROLLERS } from '../src/advanced-integrations/index.js';
import type { ConnectorAdapter } from '../src/advanced-integrations/integration-registry.service.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { OAuthFlowService } from '../src/advanced-integrations/oauth-flow.service.js';
import { validateConnectorCapabilities } from '../src/advanced-integrations/provider-capabilities.js';
import { AppModule } from '../src/app.module.js';
import { redactUrl } from '../src/common/global-exception.filter.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-INT.2–19-INT.5 — Advanced Integrations foundation tests
 * (`PLAN_Phase_19_Advanced_Integrations.md` §13, §19 `19-INT.2`–`19-INT.5`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted by id in `afterAll`; no table is reset or truncated and no extra
 * database is created. Provider calls use a deterministic fake connector — no billable API is used
 * and no network is touched.
 */

// A test key before `bootApi()` builds the config; the value is obviously synthetic and never logged.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const runId = Date.now().toString(36);
const PROVIDER_KEY = `agent-test-provider-${runId}`;
const CONNECTION_NAME = `AGENT_TEST-connection-${runId}`;
const SECRET_VALUE = 'agent-test-secret-value-never-returned';
const ACCESS_TOKEN = 'agent-test-access-token-never-returned';
const REFRESH_TOKEN = 'agent-test-refresh-token-never-returned';

let ctx: ApiContext;
let registry: IntegrationRegistry;
let oauth: OAuthFlowService;
let regularToken = '';
let regularUserId = '';
const createdConnectionIds: string[] = [];

/** The fake provider's mutable behaviour, so a test can steer one exchange or refresh. */
const fake = {
  grantedScopes: ['fake.read', 'fake.write'] as string[],
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  exchangeCount: 0,
  refreshCount: 0,
  authorizeCount: 0,
  revokeCount: 0,
  failRefresh: false,
};

const fakeAdapter: ConnectorAdapter = {
  providerKey: PROVIDER_KEY,
  adapterVersion: '1.0.0',
  providerApiVersion: '2026-01-01',
  capabilities: {
    schemaVersion: 1,
    authentication: 'oauth',
    objects: [
      {
        objectType: 'fakeRecord',
        label: 'Fake record',
        read: true,
        create: false,
        update: true,
        delete: false,
        upsert: false,
        webhook: false,
        syncDirections: ['inbound', 'outbound'],
        fullSync: true,
        incrementalSync: true,
        requiredScopes: ['fake.read'],
        optionalScopes: ['fake.write'],
        maxPageSize: 100,
        rateLimitStrategy: 'provider_header',
        externalIdFields: ['id'],
        uniqueFields: ['id'],
        deletionVisibility: 'tombstoned',
        transactional: true,
        dataSensitivity: 'business',
      },
    ],
    webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
  },
  operations: {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: false,
    implementsWebhook: false,
  },
  supportsAuthorization: true,
  supportsRefresh: true,
  supportsRevocation: true,
  authorize: async (context) => {
    fake.authorizeCount += 1;
    return {
      authorizationUrl: `https://provider.test/authorize?state=${encodeURIComponent(context.state)}&code_challenge=${String(context.codeChallenge)}`,
    };
  },
  exchangeCode: async () => {
    fake.exchangeCount += 1;
    return {
      accessToken: fake.accessToken,
      refreshToken: fake.refreshToken,
      expiresAt: fake.expiresAt,
      grantedScopes: [...fake.grantedScopes],
      tokenType: 'Bearer',
      accountRef: 'fake-account-1',
    };
  },
  refreshCredentials: async () => {
    fake.refreshCount += 1;
    if (fake.failRefresh) throw new Error('provider refused the refresh');
    fake.accessToken = `${ACCESS_TOKEN}-rotated-${String(fake.refreshCount)}`;
    fake.expiresAt = new Date(Date.now() + 3600_000).toISOString();
    return {
      accessToken: fake.accessToken,
      refreshToken: fake.refreshToken,
      expiresAt: fake.expiresAt,
      grantedScopes: [...fake.grantedScopes],
      tokenType: 'Bearer',
      accountRef: 'fake-account-1',
    };
  },
  revokeCredentials: async () => {
    fake.revokeCount += 1;
  },
};

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
  return { status: res.statusCode, body, headers: res.headers as Record<string, string> };
}

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

async function createConnection(name = CONNECTION_NAME): Promise<string> {
  const created = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', ctx.adminToken, {
    providerKey: PROVIDER_KEY,
    name,
    ownerType: 'organization',
  });
  expect(created.status).toBe(201);
  const id = String(created.body['id']);
  createdConnectionIds.push(id);
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  registry = ctx.app.get(IntegrationRegistry);
  oauth = ctx.app.get(OAuthFlowService);

  // The fake connector is registered into the live registry, exactly as a delivered connector would
  // be. It is code-registered, so it cannot drift from the adapter that implements it.
  registry.register({
    providerKey: PROVIDER_KEY,
    displayName: 'Agent test connector',
    description: 'A deterministic fake connector used by the Advanced Integrations tests.',
    category: 'test',
    adapterVersion: fakeAdapter.adapterVersion,
    providerApiVersion: fakeAdapter.providerApiVersion,
    status: 'available',
    capabilities: fakeAdapter.capabilities,
    requiredScopes: ['fake.read'],
    optionalScopes: ['fake.write'],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: fakeAdapter,
  });

  // The OAuth flow is off by default; a test enables it and restores it afterwards.
  await call('POST', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken, {
    features: { oauth: true, expiryNotices: true },
  });

  const user = await createTestUser(ctx, { userName: `AGENT_TEST-int-user-${runId}` });
  regularToken = user.token;
  regularUserId = user.id;
  await createTestRole(ctx, {
    id: `AGENT_TEST-int-none-${runId}`,
    name: `AGENT_TEST int none ${runId}`,
    permissions: {},
  });
});

afterAll(async () => {
  // Restore the module settings to their delivered defaults.
  await call('POST', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken, {
    features: { oauth: false, expiryNotices: false },
  });
  if (createdConnectionIds.length > 0) {
    await ctx.database.db
      .deleteFrom('integration_oauth_states')
      .where('connection_id', 'in', createdConnectionIds)
      .execute();
    await ctx.database.db
      .deleteFrom('integration_credential_secrets')
      .where('connection_id', 'in', createdConnectionIds)
      .execute();
    await ctx.database.db
      .deleteFrom('integration_connections')
      .where('id', 'in', createdConnectionIds)
      .execute();
  }
  await ctx.database.db
    .deleteFrom('notifications')
    .where('id', 'like', 'intgn_reauth_%')
    .execute();
  // The cleanup is scoped to this run's unique marker rather than to a captured id, so it still
  // runs when `beforeAll` failed part-way through (AGENTS.md §3.3: clean up only what this run
  // created, and only what can be positively identified).
  await ctx.database.db.deleteFrom('users').where('user_name', '=', `AGENT_TEST-int-user-${runId}`).execute();
  await ctx.database.db.deleteFrom('roles').where('id', '=', `AGENT_TEST-int-none-${runId}`).execute();
  await shutdownApi();
});

describe('Advanced Integrations — module registration (19-INT.2)', () => {
  it('serves the module routes instead of the generic entity wildcard', async () => {
    const health = await call('GET', '/api/v1/AdvancedIntegrations/action/health', ctx.adminToken);
    expect(health.status).toBe(200);
    // The generic entity API would answer with a list envelope; the module answers with its own
    // health document. This proves the static prefix won the route order.
    expect(health.body['list']).toBeUndefined();
    expect((health.body['module'] as Record<string, unknown>)['id']).toBe('AdvancedIntegrations');
  });

  it('registers each controller exactly once', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    for (const controller of ADVANCED_INTEGRATIONS_CONTROLLERS) {
      const occurrences = controllers.filter((entry) => entry === controller).length;
      expect(occurrences).toBe(1);
    }
    // The barrel itself must not list a controller twice.
    expect(new Set(ADVANCED_INTEGRATIONS_CONTROLLERS).size).toBe(ADVANCED_INTEGRATIONS_CONTROLLERS.length);
  });

  it('does not expose a connection through the generic entity API', async () => {
    const created = await createConnection(`AGENT_TEST-entity-${runId}`);
    // The generic route must refuse: a connection is control-plane state, and a direct PATCH
    // would move it between states without passing the state machine.
    const generic = await call('GET', `/api/v1/IntegrationConnection/${created}`, ctx.adminToken);
    expect(generic.status).toBe(404);
  });

  it('grants no broad administrative privileges by default', async () => {
    // A regular user with no role may not read the module at all.
    const denied = await call('GET', '/api/v1/AdvancedIntegrations/action/connections', regularToken);
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('AUTHORIZATION_DENIED');

    // The seeded default role grants nothing at all.
    const roles = await ctx.database.db
      .selectFrom('roles')
      .select(['id', 'permissions'])
      .where('id', '=', 'noAccess')
      .executeTakeFirst();
    expect(roles).toBeDefined();
    expect(Object.keys((roles?.permissions ?? {}) as Record<string, unknown>)).toHaveLength(0);
  });

  it('registers the module settings and refuses an unknown key', async () => {
    const read = await call('GET', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken);
    expect(read.status).toBe(200);
    expect((read.body['settings'] as Record<string, unknown>)['features']).toBeDefined();

    const invalid = await call('POST', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken, {
      features: { notAFeature: true },
    });
    expect(invalid.status).toBe(422);
  });
});

describe('Advanced Integrations — provider registry and capabilities (19-INT.3)', () => {
  it('rejects a malformed capability declaration', () => {
    expect(() => validateConnectorCapabilities({ schemaVersion: 99, authentication: 'oauth', objects: [] })).toThrow(
      /Unsupported capability schema version/,
    );
    expect(() =>
      validateConnectorCapabilities({
        schemaVersion: 1,
        authentication: 'oauth',
        objects: [{ objectType: 'x', read: 'yes' }],
      }),
    ).toThrow(/must be a boolean/);
  });

  it('rejects a capability combination that cannot work', () => {
    // A complete, valid declaration, so the assertion is about the *combination* and not about a
    // missing field.
    const validObject = {
      objectType: 'x',
      label: 'X',
      read: true,
      create: false,
      update: false,
      delete: false,
      upsert: false,
      webhook: false,
      syncDirections: [] as string[],
      fullSync: true,
      incrementalSync: false,
      requiredScopes: [] as string[],
      optionalScopes: [] as string[],
      maxPageSize: null,
      rateLimitStrategy: 'unknown',
      externalIdFields: ['id'],
      uniqueFields: ['id'],
      deletionVisibility: 'not_synchronized',
      transactional: false,
      dataSensitivity: 'business',
    };
    const base = {
      schemaVersion: 1,
      authentication: 'oauth',
      webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
    };

    // Deletes an object it cannot read.
    expect(() =>
      validateConnectorCapabilities({
        ...base,
        objects: [{ ...validObject, read: false, delete: true }],
      }),
    ).toThrow(/deletes an object it cannot read/);

    // Incremental sync without full sync.
    expect(() =>
      validateConnectorCapabilities({
        ...base,
        objects: [{ ...validObject, fullSync: false, incrementalSync: true }],
      }),
    ).toThrow(/incremental sync without full sync/);

    // Outbound sync with no write operation at all.
    expect(() =>
      validateConnectorCapabilities({
        ...base,
        objects: [{ ...validObject, syncDirections: ['outbound'] }],
      }),
    ).toThrow(/without any write operation/);

    // Inbound sync without being able to read.
    expect(() =>
      validateConnectorCapabilities({
        ...base,
        objects: [{ ...validObject, read: false, syncDirections: ['inbound'] }],
      }),
    ).toThrow(/syncs inbound without being able to read/);

    // A readable object with no external identifier cannot be correlated across syncs.
    expect(() =>
      validateConnectorCapabilities({
        ...base,
        objects: [{ ...validObject, externalIdFields: [] }],
      }),
    ).toThrow(/no external identifier/);
  });

  it('refuses a declaration the adapter cannot satisfy', () => {
    expect(() =>
      registry.register({
        providerKey: `agent-test-impossible-${runId}`,
        displayName: 'Impossible',
        description: 'Declares more than it implements.',
        category: 'test',
        adapterVersion: '1.0.0',
        providerApiVersion: '2026-01-01',
        status: 'available',
        capabilities: {
          schemaVersion: 1,
          authentication: 'api_key',
          objects: [
            {
              objectType: 'x',
              label: 'X',
              read: true,
              create: false,
              update: false,
              delete: true,
              upsert: false,
              webhook: false,
              syncDirections: [],
              fullSync: true,
              incrementalSync: false,
              requiredScopes: [],
              optionalScopes: [],
              maxPageSize: null,
              rateLimitStrategy: 'unknown',
              externalIdFields: ['id'],
              uniqueFields: ['id'],
              deletionVisibility: 'not_synchronized',
              transactional: false,
              dataSensitivity: 'business',
            },
          ],
          webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
        },
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: null,
        setupInstructionsKey: 'advancedintegrations.providers.setup',
        iconKey: 'ApiOutlined',
        adapter: { ...fakeAdapter, providerKey: `agent-test-impossible-${runId}`, operations: { ...fakeAdapter.operations, implementsDelete: false } },
      }),
    ).toThrow(/does not implement a delete operation/);
  });

  it('reports the catalog and refuses an unknown provider', async () => {
    const list = await call('GET', '/api/v1/AdvancedIntegrations/action/providers', ctx.adminToken);
    expect(list.status).toBe(200);
    const providers = (list.body['list'] ?? []) as Record<string, unknown>[];
    const found = providers.find((entry) => entry['providerKey'] === PROVIDER_KEY);
    expect(found).toBeDefined();
    // The description never carries a secret.
    expect(JSON.stringify(list.body)).not.toContain(SECRET_VALUE);

    const unknown = await call('GET', '/api/v1/AdvancedIntegrations/action/providers/nope-not-registered', ctx.adminToken);
    expect(unknown.status).toBe(422);
  });

  it('does not offer an operation the capability does not declare', () => {
    // The fake connector declares `update` but not `delete` and not `webhook`.
    expect(registry.supports(PROVIDER_KEY, 'fakeRecord', 'read')).toBe(true);
    expect(registry.supports(PROVIDER_KEY, 'fakeRecord', 'update')).toBe(true);
    expect(registry.supports(PROVIDER_KEY, 'fakeRecord', 'delete')).toBe(false);
    expect(registry.supports(PROVIDER_KEY, 'fakeRecord', 'webhook')).toBe(false);
    expect(registry.supports(PROVIDER_KEY, 'unknownObject', 'read')).toBe(false);
  });
});

describe('Advanced Integrations — connection lifecycle and secrets (19-INT.4)', () => {
  it('creates a draft connection', async () => {
    const id = await createConnection();
    const read = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(read.status).toBe(200);
    expect(read.body['status']).toBe('draft');
    expect(read.body['providerKey']).toBe(PROVIDER_KEY);
    expect(read.body['enabled']).toBe(false);
    expect(read.body['hasCredential']).toBe(false);
    expect(read.body['credentialHint']).toBeNull();
  });

  it('refuses an invalid state transition', async () => {
    const id = await createConnection(`AGENT_TEST-transition-${runId}`);
    // draft -> connected is not a legal move: the connection must be authorized first.
    const illegal = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/pause`, ctx.adminToken);
    expect(illegal.status).toBe(422);
    expect(errorCode(illegal)).toBe('VALIDATION_FAILED');

    const still = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(still.body['status']).toBe('draft');
  });

  it('refuses to make a connection usable without its required scopes', async () => {
    const id = await createConnection(`AGENT_TEST-scopes-${runId}`);
    // The required scope is `fake.read`; a grant without it must not reach `connected`.
    const scopes = await call(
      'PATCH',
      `/api/v1/AdvancedIntegrations/action/connections/${id}`,
      ctx.adminToken,
      { connectionOptions: { note: 'no scope change here' } },
    );
    expect(scopes.status).toBe(200);

    expect(canTransition('draft', 'connected')).toBe(false);
    expect(canTransition('pending_authorization', 'connected')).toBe(true);
    expect(() => assertTransition('draft', 'connected')).toThrow(/cannot move to "connected"/);
  });

  it('never returns a stored secret', async () => {
    const id = await createConnection(`AGENT_TEST-secret-${runId}`);
    const stored = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/credentials`,
      ctx.adminToken,
      { kind: 'api_key', value: SECRET_VALUE },
    );
    expect(stored.status).toBe(201);
    expect(stored.body['hasCredential']).toBe(true);
    // The value itself is nowhere in the response.
    expect(JSON.stringify(stored.body)).not.toContain(SECRET_VALUE);
    // The stored row holds ciphertext, never plaintext.
    const row = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select(['payload_encrypted', 'state'])
      .where('connection_id', '=', id)
      .executeTakeFirst();
    expect(row?.payload_encrypted).not.toContain(SECRET_VALUE);
    expect(row?.payload_encrypted.startsWith('v1:')).toBe(true);
    expect(row?.state).toBe('active');

    const read = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(JSON.stringify(read.body)).not.toContain(SECRET_VALUE);
  });

  it('refuses a credential smuggled through the configuration', async () => {
    const created = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', ctx.adminToken, {
      providerKey: PROVIDER_KEY,
      name: `AGENT_TEST-smuggle-${runId}`,
      ownerType: 'organization',
      connectionOptions: { apiKey: SECRET_VALUE },
    });
    expect(created.status).toBe(422);
    expect(errorCode(created)).toBe('VALIDATION_FAILED');
  });

  it('gates credential administration behind the capability', async () => {
    const id = await createConnection(`AGENT_TEST-gate-${runId}`);
    const denied = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/credentials`,
      regularToken,
      { kind: 'api_key', value: SECRET_VALUE },
    );
    expect(denied.status).toBe(403);
  });

  it('redacts credential-shaped keys from a payload', () => {
    const redacted = redactSecrets({
      accessToken: 'super-secret',
      nested: { clientSecret: 'also-secret', safe: 'visible' },
      list: [{ password: 'nope' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
    expect(JSON.stringify(redacted)).not.toContain('also-secret');
    expect(JSON.stringify(redacted)).not.toContain('nope');
    expect((redacted['nested'] as Record<string, unknown>)['safe']).toBe('visible');
    expect(secretHint('abcdefghijkl')).toBe('ab********kl');
    expect(secretHint('short')).toBe('*****');
  });
});

describe('Advanced Integrations — OAuth (19-INT.5)', () => {
  it('starts an authorization with PKCE and a single-use state', async () => {
    const id = await createConnection(`AGENT_TEST-oauth-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    expect(started.status).toBe(201);
    const url = String(started.body['authorizationUrl']);
    const state = new URL(url).searchParams.get('state');
    expect(state).toBeTruthy();
    // PKCE: the challenge travels with the authorization request.
    expect(new URL(url).searchParams.get('code_challenge')).toBeTruthy();
    expect(url).not.toContain(ACCESS_TOKEN);

    // The stored state is hashed, so a database read cannot yield a usable state.
    const row = await ctx.database.db
      .selectFrom('integration_oauth_states')
      .select(['id', 'code_verifier'])
      .where('connection_id', '=', id)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.id).not.toBe(state);
    expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_verifier).toBeTruthy();

    const pending = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(pending.body['status']).toBe('pending_authorization');
  });

  it('refuses a forged callback', async () => {
    const forged = await call(
      'GET',
      '/api/v1/integrations/advanced-integrations/oauth/callback?state=forged-state&code=forged-code',
    );
    expect(forged.status).toBe(401);
    expect(errorCode(forged)).toBe('AUTHENTICATION_FAILED');
  });

  it('completes an authorization and refuses a replayed callback', async () => {
    const id = await createConnection(`AGENT_TEST-replay-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';

    const first = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );
    expect(first.status).toBe(302);
    const location = String(first.headers['location'] ?? '');
    expect(location).toContain(encodeURIComponent(id));
    expect(location).toContain('connected');
    // The authorization code is never echoed back.
    expect(location).not.toContain('one-time-code');

    const connected = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(connected.body['status']).toBe('connected');
    expect(connected.body['missingScopes']).toEqual([]);

    // The same state a second time finds nothing: the state is single-use.
    const replay = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );
    expect(replay.status).toBe(401);
  });

  it('refuses a callback whose connection changed hands', async () => {
    const id = await createConnection(`AGENT_TEST-csrf-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';

    // The connection is handed to another owner while the authorization is in flight.
    await ctx.database.db
      .updateTable('integration_connections')
      .set({ owner_type: 'user', owner_id: regularUserId })
      .where('id', '=', id)
      .execute();

    const refused = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );
    expect(refused.status).toBe(401);
  });

  it('reports a scope mismatch and does not make the connection usable', async () => {
    const id = await createConnection(`AGENT_TEST-scopemismatch-${runId}`);
    fake.grantedScopes = ['fake.write'];
    try {
      const started = await call(
        'POST',
        `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
        ctx.adminToken,
        {},
      );
      const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
      const completed = await call(
        'GET',
        `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      );
      expect(completed.status).toBe(302);
      expect(String(completed.headers['location'] ?? '')).toContain('reauthorization_required');

      const read = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
      expect(read.body['status']).toBe('reauthorization_required');
      expect(read.body['missingScopes']).toEqual(['fake.read']);
      expect(read.body['lastErrorCode']).toBe('SCOPE_MISSING');
      // The missing permission class is reported; the credential is not.
      expect(JSON.stringify(read.body)).not.toContain(ACCESS_TOKEN);
    } finally {
      fake.grantedScopes = ['fake.read', 'fake.write'];
    }
  });

  it('serialises concurrent refreshes so a rotating token is not destroyed', async () => {
    const id = await createConnection(`AGENT_TEST-race-${runId}`);
    // The stored token is already expired, so both refreshes want to refresh.
    fake.expiresAt = new Date(Date.now() - 60_000).toISOString();
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );

    const before = fake.refreshCount;
    const results = await Promise.all([oauth.refresh(id), oauth.refresh(id)]);
    expect(fake.refreshCount - before).toBe(1);
    expect(results.filter((result) => result.refreshed)).toHaveLength(1);
    expect(results.filter((result) => !result.refreshed)).toHaveLength(1);
    fake.expiresAt = new Date(Date.now() + 3600_000).toISOString();
  });

  it('revokes the provider grant and the stored credential', async () => {
    const id = await createConnection(`AGENT_TEST-revoke-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
    await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );

    const revoked = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/revoke`, ctx.adminToken);
    expect(revoked.status).toBe(201);
    expect(revoked.body['providerRevoked']).toBe(true);
    expect(fake.revokeCount).toBe(1);

    const read = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(read.body['status']).toBe('revoked');
    expect(read.body['enabled']).toBe(false);
    expect(read.body['hasCredential']).toBe(false);
  });

  it('removes a connection without touching anything else', async () => {
    const id = await createConnection(`AGENT_TEST-remove-${runId}`);
    const removed = await call('DELETE', `/api/v1/AdvancedIntegrations/action/connections/${id}`, ctx.adminToken);
    expect(removed.status).toBe(200);
    const row = await ctx.database.db
      .selectFrom('integration_connections')
      .select(['deleted_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row?.deleted_at).not.toBeNull();
  });
});

describe('Advanced Integrations — log redaction', () => {
  it('removes the authorization code and the state from a logged URL', () => {
    const redacted = redactUrl(
      '/api/v1/integrations/advanced-integrations/oauth/callback?state=abc123&code=secret-code&other=keep',
    );
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('secret-code');
    expect(redacted).toContain('other=keep');
    expect(redacted).toContain('state=[redacted]');
    expect(redacted).toContain('code=[redacted]');
    // A URL without a query string is untouched.
    expect(redactUrl('/api/v1/AdvancedIntegrations/action/health')).toBe(
      '/api/v1/AdvancedIntegrations/action/health',
    );
  });
});
