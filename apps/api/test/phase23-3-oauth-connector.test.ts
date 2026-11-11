import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConnectorAdapter } from '../src/advanced-integrations/integration-registry.service.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { OAuthFlowService } from '../src/advanced-integrations/oauth-flow.service.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.3 — OAuth and connector credential correctness
 * (`plans/PLAN_Phase_23_Security_Hardening.md` §8; findings G47, G50, G51).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted by id in `afterAll`; no table is reset or truncated and no extra
 * database is created. Provider calls use a deterministic fake connector — no billable API is used
 * and no network is touched.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const runId = Date.now().toString(36);
const PROVIDER_KEY = `agent-test-p23-3-provider-${runId}`;
const OTHER_PROVIDER_KEY = `agent-test-p23-3-other-${runId}`;
/** A provider that only ever has one connection, for the "no need to name it" case. */
const SINGLE_PROVIDER_KEY = `agent-test-p23-3-single-${runId}`;
const ACCESS_TOKEN = 'agent-test-p23-3-access-token-never-returned';
const REFRESH_TOKEN = 'agent-test-p23-3-refresh-token-never-returned';

let ctx: ApiContext;
let registry: IntegrationRegistry;
let oauth: OAuthFlowService;
const createdConnectionIds: string[] = [];

/** The fake provider's mutable behaviour, so a test can steer one exchange or refresh. */
const fake = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  exchangeCount: 0,
  refreshCount: 0,
  /** How many times the provider refused the credential. */
  refusalsLeft: 0,
  /** The access tokens the provider actually saw, in order. */
  seenAccessTokens: [] as string[],
};

const capabilities = {
  schemaVersion: 1,
  authentication: 'oauth',
  objects: [
    {
      objectType: 'fakeRecord',
      label: 'Fake record',
      read: true,
      create: false,
      update: false,
      delete: false,
      upsert: false,
      webhook: false,
      syncDirections: ['inbound'] as const,
      fullSync: true,
      incrementalSync: true,
      requiredScopes: ['fake.read'],
      optionalScopes: ['fake.write'],
      maxPageSize: 100,
      rateLimitStrategy: 'provider_header' as const,
      externalIdFields: ['id'],
      uniqueFields: ['id'],
      deletionVisibility: 'tombstoned' as const,
      transactional: true,
      dataSensitivity: 'business' as const,
    },
  ],
  webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
};

const fakeAdapter: ConnectorAdapter = {
  providerKey: PROVIDER_KEY,
  adapterVersion: '1.0.0',
  providerApiVersion: '2026-01-01',
  capabilities,
  operations: {
    implementsFetch: true,
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: false,
  },
  supportsAuthorization: true,
  supportsRefresh: true,
  supportsRevocation: false,
  getCapabilities: () => capabilities,
  validateConnection: async (context) => {
    fake.seenAccessTokens.push(context.credential.accessToken ?? '');
    if (fake.refusalsLeft > 0) {
      fake.refusalsLeft -= 1;
      throw new ProviderError('TOKEN_EXPIRED', 'The provider refused the credential.', {
        category: 'authorization',
        retryable: false,
        status: 401,
      });
    }
    return {
      ok: true,
      code: null,
      message: null,
      accountRef: 'fake-account-1',
      grantedScopes: ['fake.read'],
    };
  },
  listObjectSchemas: async () => [],
  listFields: async () => [],
  authorize: async (context) => ({
    authorizationUrl: `https://provider.test/authorize?state=${encodeURIComponent(context.state)}`,
  }),
  exchangeCode: async () => {
    fake.exchangeCount += 1;
    return {
      accessToken: fake.accessToken,
      refreshToken: fake.refreshToken,
      expiresAt: fake.expiresAt,
      grantedScopes: ['fake.read'],
      tokenType: 'Bearer',
      accountRef: 'fake-account-1',
    };
  },
  refreshCredentials: async () => {
    fake.refreshCount += 1;
    fake.accessToken = `${ACCESS_TOKEN}-rotated-${String(fake.refreshCount)}`;
    fake.expiresAt = new Date(Date.now() + 3600_000).toISOString();
    return {
      accessToken: fake.accessToken,
      refreshToken: fake.refreshToken,
      expiresAt: fake.expiresAt,
      grantedScopes: ['fake.read'],
      tokenType: 'Bearer',
      accountRef: 'fake-account-1',
    };
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

function errorMessage(result: CallResult): string {
  // The catalog replaces the message with the generic face of the code; the specific reason
  // travels in `details.reason`.
  const details = (result.body['error'] as { details?: Record<string, unknown> } | undefined)?.details ?? {};
  const reason = details['reason'];
  if (typeof reason === 'string') return reason;
  return String(((result.body['error'] ?? {}) as { message?: string }).message ?? '');
}

async function createConnection(name: string, providerKey = PROVIDER_KEY): Promise<string> {
  const created = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', ctx.adminToken, {
    providerKey,
    name,
    ownerType: 'organization',
  });
  expect(created.status).toBe(201);
  const id = String(created.body['id']);
  createdConnectionIds.push(id);
  return id;
}

/** Authorizes a connection and completes the callback, so it holds a live credential. */
async function connect(connectionId: string): Promise<void> {
  const started = await call(
    'POST',
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/authorize`,
    ctx.adminToken,
    {},
  );
  expect(started.status).toBe(201);
  const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';
  const completed = await call(
    'GET',
    `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
  );
  expect(completed.status).toBe(302);
}

beforeAll(async () => {
  ctx = await bootApi();
  registry = ctx.app.get(IntegrationRegistry);
  oauth = ctx.app.get(OAuthFlowService);

  // The OAuth flow is off by default; a test enables it and restores it afterwards.
  await call('POST', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken, {
    features: { oauth: true },
  });

  registry.register({
    providerKey: PROVIDER_KEY,
    displayName: 'Agent test provider',
    description: 'A deterministic fake connector used by the Phase 23.3 tests.',
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

  // A second provider, so a test can prove that a named connection is checked against the
  // provider that was named.
  registry.register({
    providerKey: OTHER_PROVIDER_KEY,
    displayName: 'Agent test other provider',
    description: 'A second deterministic fake connector used by the Phase 23.3 tests.',
    category: 'test',
    adapterVersion: '1.0.0',
    providerApiVersion: '2026-01-01',
    status: 'available',
    capabilities: fakeAdapter.capabilities,
    requiredScopes: ['fake.read'],
    optionalScopes: ['fake.write'],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: { ...fakeAdapter, providerKey: OTHER_PROVIDER_KEY },
  });

  // A third provider that only ever has one connection.
  registry.register({
    providerKey: SINGLE_PROVIDER_KEY,
    displayName: 'Agent test single provider',
    description: 'A third deterministic fake connector used by the Phase 23.3 tests.',
    category: 'test',
    adapterVersion: '1.0.0',
    providerApiVersion: '2026-01-01',
    status: 'available',
    capabilities: fakeAdapter.capabilities,
    requiredScopes: ['fake.read'],
    optionalScopes: ['fake.write'],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: { ...fakeAdapter, providerKey: SINGLE_PROVIDER_KEY },
  });
});

afterAll(async () => {
  await call('POST', '/api/v1/AdvancedIntegrations/action/settings', ctx.adminToken, {
    features: { oauth: false },
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
      .deleteFrom('integration_audit_log')
      .where('connection_id', 'in', createdConnectionIds)
      .execute();
    await ctx.database.db
      .deleteFrom('integration_object_mappings')
      .where('connection_id', 'in', createdConnectionIds)
      .execute();
    await ctx.database.db
      .deleteFrom('integration_connections')
      .where('id', 'in', createdConnectionIds)
      .execute();
  }
  await shutdownApi();
});

describe('Phase 23.3 — G51: the redirect URI is compared before the code is exchanged', () => {
  it('refuses a callback whose redirect URI is not the one the platform sent', async () => {
    const id = await createConnection(`AGENT_TEST-p233-redirect-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    expect(started.status).toBe(201);
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';

    const exchangesBefore = fake.exchangeCount;
    const refused = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code&redirect_uri=${encodeURIComponent('https://attacker.test/steal')}`,
    );

    expect(refused.status).toBe(401);
    expect(errorCode(refused)).toBe('AUTHENTICATION_FAILED');
    // The refusal happens **before** the exchange: no token request was made at all.
    expect(fake.exchangeCount).toBe(exchangesBefore);
  });

  it('accepts a callback that echoes the exact redirect URI the platform sent', async () => {
    const id = await createConnection(`AGENT_TEST-p233-redirect-ok-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';

    const completed = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code&redirect_uri=${encodeURIComponent('/api/v1/integrations/advanced-integrations/oauth/callback')}`,
    );
    expect(completed.status).toBe(302);
    expect(String(completed.headers['location'] ?? '')).toContain('connected');
  });

  it('refuses a state row whose stored redirect URI was tampered with', async () => {
    const id = await createConnection(`AGENT_TEST-p233-redirect-row-${runId}`);
    const started = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${id}/authorize`,
      ctx.adminToken,
      {},
    );
    const state = new URL(String(started.body['authorizationUrl'])).searchParams.get('state') ?? '';

    // The stored state names a redirect URI that is not the platform's constant.
    await ctx.database.db
      .updateTable('integration_oauth_states')
      .set({ redirect_uri: 'https://attacker.test/steal' })
      .where('id', '=', hashStateForTest(state))
      .execute();

    const exchangesBefore = fake.exchangeCount;
    const refused = await call(
      'GET',
      `/api/v1/integrations/advanced-integrations/oauth/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    );
    expect(refused.status).toBe(401);
    expect(fake.exchangeCount).toBe(exchangesBefore);
  });
});

describe('Phase 23.3 — G50: a mapping names the connection it belongs to', () => {
  it('refuses to guess when a provider has more than one connection', async () => {
    const first = await createConnection(`AGENT_TEST-p233-a-${runId}`);
    const second = await createConnection(`AGENT_TEST-p233-b-${runId}`);
    expect(first).not.toBe(second);

    const refused = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', ctx.adminToken, {
      providerKey: PROVIDER_KEY,
      objectType: 'fakeRecord',
      crmEntityType: 'Contact',
    });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('VALIDATION_FAILED');
    expect(errorMessage(refused)).toMatch(/more than one connection/);
  });

  it('uses the connection the caller named', async () => {
    const first = await createConnection(`AGENT_TEST-p233-c-${runId}`);
    const second = await createConnection(`AGENT_TEST-p233-d-${runId}`);

    const created = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', ctx.adminToken, {
      providerKey: PROVIDER_KEY,
      connectionId: second,
      objectType: 'fakeRecord',
      crmEntityType: 'Contact',
    });
    expect(created.status).toBe(201);
    // The mapping belongs to the connection that was named, not to the alphabetically first one.
    expect(created.body['connectionId']).toBe(second);
    expect(created.body['connectionId']).not.toBe(first);
  });

  it('refuses a connection that belongs to another provider', async () => {
    const mine = await createConnection(`AGENT_TEST-p233-e-${runId}`);
    const other = await createConnection(`AGENT_TEST-p233-f-${runId}`, OTHER_PROVIDER_KEY);

    const refused = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', ctx.adminToken, {
      providerKey: PROVIDER_KEY,
      connectionId: other,
      objectType: 'fakeRecord',
      crmEntityType: 'Contact',
    });
    expect(refused.status).toBe(422);
    expect(errorMessage(refused)).toMatch(/does not belong to the named provider/);
    expect(mine).not.toBe(other);
  });

  it('still resolves the only connection of a provider without naming it', async () => {
    // `SINGLE_PROVIDER_KEY` has exactly one connection, so the mapping may omit it.
    const only = await createConnection(`AGENT_TEST-p233-g-${runId}`, SINGLE_PROVIDER_KEY);
    const created = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', ctx.adminToken, {
      providerKey: SINGLE_PROVIDER_KEY,
      objectType: 'fakeRecord',
      crmEntityType: 'Contact',
    });
    expect(created.status).toBe(201);
    expect(created.body['connectionId']).toBe(only);
  });
});

describe('Phase 23.3 — G47: the connector refreshes its credential', () => {
  it('refreshes an expired token before the call', async () => {
    const id = await createConnection(`AGENT_TEST-p233-expired-${runId}`);
    fake.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await connect(id);

    const refreshesBefore = fake.refreshCount;
    const tested = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/test`, ctx.adminToken);
    expect(tested.status).toBe(201);
    expect(tested.body['ok']).toBe(true);
    // The expired token was refreshed before the provider was called.
    expect(fake.refreshCount).toBe(refreshesBefore + 1);
    // The provider saw the **rotated** token, not the expired one.
    expect(fake.seenAccessTokens.at(-1)).toBe(`${ACCESS_TOKEN}-rotated-${String(fake.refreshCount)}`);
  });

  it('refreshes once and retries once when the provider refuses the credential', async () => {
    const id = await createConnection(`AGENT_TEST-p233-refusal-${runId}`);
    await connect(id);

    const refreshesBefore = fake.refreshCount;
    const seenBefore = fake.seenAccessTokens.length;
    // The provider refuses the first call with an authorization error.
    fake.refusalsLeft = 1;

    const tested = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/test`, ctx.adminToken);
    expect(tested.status).toBe(201);
    expect(tested.body['ok']).toBe(true);
    // Exactly one refresh, and exactly one additional attempt.
    expect(fake.refreshCount).toBe(refreshesBefore + 1);
    expect(fake.seenAccessTokens.length).toBe(seenBefore + 2);
  });

  it('does not retry endlessly when the provider keeps refusing the credential', async () => {
    const id = await createConnection(`AGENT_TEST-p233-refusal-2-${runId}`);
    await connect(id);

    const refreshesBefore = fake.refreshCount;
    const seenBefore = fake.seenAccessTokens.length;
    // The provider refuses **every** call.
    fake.refusalsLeft = 5;

    const tested = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/test`, ctx.adminToken);
    expect(tested.status).toBe(201);
    expect(tested.body['ok']).toBe(false);
    // The retry is bounded: two attempts, one refresh, then the failure is the failure.
    expect(fake.seenAccessTokens.length).toBe(seenBefore + 2);
    expect(fake.refreshCount).toBe(refreshesBefore + 1);
    fake.refusalsLeft = 0;
  });

  it('does not refresh a token that is still valid', async () => {
    const id = await createConnection(`AGENT_TEST-p233-valid-${runId}`);
    fake.expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await connect(id);

    const refreshesBefore = fake.refreshCount;
    const tested = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${id}/test`, ctx.adminToken);
    expect(tested.status).toBe(201);
    expect(tested.body['ok']).toBe(true);
    expect(fake.refreshCount).toBe(refreshesBefore);
  });

  it('refuses to refresh a credential the provider already replaced', async () => {
    const id = await createConnection(`AGENT_TEST-p233-stale-${runId}`);
    await connect(id);

    // A forced refresh is bound to the token that was refused. When the stored credential is
    // already a different one, the refresh is skipped — a rotating refresh token is not rotated
    // twice.
    const before = fake.refreshCount;
    const result = await oauth.refresh(id, { force: true, expectedAccessToken: 'a-token-that-was-never-stored' });
    expect(result.refreshed).toBe(false);
    expect(fake.refreshCount).toBe(before);
  });
});

/**
 * The platform stores the **hashed** state, so a test that wants to touch the row computes the
 * same hash the platform does.
 */
function hashStateForTest(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
