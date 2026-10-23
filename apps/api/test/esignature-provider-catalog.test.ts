import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { SIGNATURE_PROVIDER_CATALOG } from '../src/esignature/providers/signature-provider.catalog.js';
import { SIGNATURE_PROVIDER_KEYS } from '../src/esignature/providers/signature-provider.keys.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi } from './support/boot-api.js';

/**
 * Multi-provider follow-on — the provider catalog and per-provider configuration, through the API.
 *
 * The point of this file is the **architecture**, not a second vendor: DocuSign is one provider among
 * several the module knows, a provider that is not installed cannot be connected, and every
 * provider-scoped setting and row is keyed rather than hard-coded. It runs against the configured
 * project database (AGENTS.md §3.1), creates only `AGENT_TEST_` rows with this run's marker, and
 * removes them by exact id afterwards. No provider is contacted: every case here is a refusal or a
 * local write.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_provider_${suffix}_${runId}`;
const DEMO_CLIENT_ID = `agent-test-docusign-client-${runId}`;
const CLIENT_SECRET = `agent-test-client-secret-${runId}`;
const REDIRECT_URI = 'http://localhost:7777/api/v1/ESignature/oauth/callback';

let ctx: ApiContext;
let app: NestFastifyApplication;
let baseline: unknown = null;
const createdConnections: string[] = [];

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
  return { status: res.statusCode, body };
}

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function settingsService(): ESignatureSettingsService {
  return app.get(ESignatureSettingsService);
}

async function patchSettings(patch: Record<string, unknown>): Promise<CallResult> {
  const result = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  settingsService().invalidate();
  return result;
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baseline = row?.data ?? null;
  const enabled = await patchSettings({
    enabled: true,
    features: { connections: true, requests: true },
    provider: { clients: { docusign: { demo: DEMO_CLIENT_ID, production: '' } } },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (createdConnections.length > 0) {
    await db.deleteFrom('esignature_credential_secrets').where('connection_id', 'in', createdConnections).execute();
    await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', createdConnections).execute();
    await db.deleteFrom('esignature_connections').where('id', 'in', createdConnections).execute();
  }
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
  settingsService().invalidate();
});

describe('provider catalog', () => {
  it('exposes every cataloged provider, its auth style and whether the integration is installed', async () => {
    const catalog = await call('GET', '/api/v1/ESignature/action/provider-catalog', ctx.adminToken);
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const providers = catalog.body['providers'] as Record<string, unknown>[];
    expect(providers.map((entry) => entry['key'])).toEqual([...SIGNATURE_PROVIDER_KEYS]);

    const docusign = providers.find((entry) => entry['key'] === 'docusign');
    expect(docusign).toMatchObject({
      label: 'DocuSign',
      authStyle: 'oauth2_authorization_code',
      integrationStatus: 'available',
    });
    expect((docusign?.['capabilities'] as Record<string, boolean>)['prepareEnvelope']).toBe(true);
    expect((docusign?.['documentLimits'] as { supportedExtensions: string[] }).supportedExtensions).toContain('pdf');

    const dropbox = providers.find((entry) => entry['key'] === 'dropbox_sign');
    expect(dropbox).toMatchObject({ label: 'Dropbox Sign', authStyle: 'api_key', integrationStatus: 'declared' });
    // A declared provider must not claim a capability it cannot perform.
    expect(Object.values(dropbox?.['capabilities'] as Record<string, boolean>).every((value) => value === false)).toBe(true);
    expect(dropbox?.['documentLimits']).toBeNull();

    // The answer is metadata only: no credential field, no stored client id.
    expect(JSON.stringify(catalog.body)).not.toContain(CLIENT_SECRET);
  });

  it('keeps the catalog and the callable provider list in one place', () => {
    expect(SIGNATURE_PROVIDER_CATALOG.map((entry) => entry.key)).toEqual([...SIGNATURE_PROVIDER_KEYS]);
    expect(SIGNATURE_PROVIDER_CATALOG.filter((entry) => entry.integrationStatus === 'available').map((entry) => entry.key)).toEqual([
      'docusign',
    ]);
  });
});

describe('per-provider settings', () => {
  it('stores an OAuth client id per provider and environment', async () => {
    const view = await call('GET', '/api/v1/ESignature/action/settings', ctx.adminToken);
    expect(view.status).toBe(200);
    const settings = view.body['settings'] as { provider: { clients: Record<string, { demo: string; production: string }> } };
    expect(settings.provider.clients['docusign']?.demo).toBe(DEMO_CLIENT_ID);
  });

  it('refuses a client id for a provider the catalog does not know', async () => {
    const refused = await patchSettings({ provider: { clients: { stripe: { demo: 'anything', production: '' } } } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(errorCode(refused)).toBe('VALIDATION_FAILED');
    // The stored document still names only the known provider.
    const view = await call('GET', '/api/v1/ESignature/action/settings', ctx.adminToken);
    const settings = view.body['settings'] as { provider: { clients: Record<string, unknown> } };
    expect(settings.provider.clients['stripe']).toBeUndefined();
  });
});

describe('connection creation is provider-aware', () => {
  it('defaults to DocuSign and takes the public client id from the per-provider settings', async () => {
    const created = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      name: marker('default_provider'),
      environment: 'demo',
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    createdConnections.push(id);
    expect(created.body).toMatchObject({
      providerKey: 'docusign',
      providerLabel: 'DocuSign',
      providerStatus: 'available',
      oauthClientId: DEMO_CLIENT_ID,
      hasClientSecret: true,
    });
  });

  it('refuses a cataloged provider whose integration is not installed, and writes no row', async () => {
    const before = await ctx.database.db
      .selectFrom('esignature_connections')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_key', '=', 'dropbox_sign')
      .executeTakeFirst();
    const refused = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'dropbox_sign',
      name: marker('declared_provider'),
      environment: 'demo',
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/planned integration/i);
    expect(JSON.stringify(refused.body)).not.toContain(CLIENT_SECRET);
    const after = await ctx.database.db
      .selectFrom('esignature_connections')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_key', '=', 'dropbox_sign')
      .executeTakeFirst();
    expect(String(after?.n)).toBe(String(before?.n));
  });

  it('refuses a provider key outside the catalog', async () => {
    const refused = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'acme_sign',
      name: marker('unknown_provider'),
      environment: 'demo',
      clientSecret: CLIENT_SECRET,
    });
    expect(refused.status).toBe(400);
  });

  it('does not admit an operation for a declared provider', async () => {
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, {
      operation: 'prepareEnvelope',
      providerKey: 'dropbox_sign',
    });
    expect(probe.status).toBe(422);
    expect(errorCode(probe)).toBe('NOT_SUPPORTED_BY_PROVIDER');
  });
});

describe('requests name a provider', () => {
  it('refuses a request for a declared provider before anything is stored', async () => {
    const refused = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('declared_request'),
      providerKey: 'dropbox_sign',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    const stored = await ctx.database.db
      .selectFrom('signature_requests')
      .select('id')
      .where('name', '=', marker('declared_request'))
      .executeTakeFirst();
    expect(stored).toBeUndefined();
  });
});
