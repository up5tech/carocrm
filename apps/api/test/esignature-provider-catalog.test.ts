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
const createdRequests: string[] = [];

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
  if (createdRequests.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', createdRequests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', createdRequests).execute();
  }
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
    expect(dropbox).toMatchObject({
      label: 'Dropbox Sign',
      authStyle: 'api_key',
      integrationStatus: 'available',
      envelopeDrafting: 'direct',
      webhookSecretKind: 'api_key',
    });
    const capabilities = dropbox?.['capabilities'] as Record<string, boolean>;
    expect(capabilities['sendNewEnvelope']).toBe(true);
    // API v3 has no unsent draft and this adapter does not claim embedded signing.
    expect(capabilities['prepareEnvelope']).toBe(false);
    expect(capabilities['recipientView']).toBe(false);
    expect(dropbox?.['documentLimits']).toBeNull();

    // The answer is metadata only: no credential field, no stored client id.
    expect(JSON.stringify(catalog.body)).not.toContain(CLIENT_SECRET);
  });

  it('keeps the catalog and the callable provider list in one place', () => {
    expect(SIGNATURE_PROVIDER_CATALOG.map((entry) => entry.key)).toEqual([...SIGNATURE_PROVIDER_KEYS]);
    expect(SIGNATURE_PROVIDER_CATALOG.filter((entry) => entry.integrationStatus === 'available').map((entry) => entry.key)).toEqual([
      'docusign',
      'dropbox_sign',
    ]);
    // Every installed provider is executed by an adapter in production; none is left as a promise.
    expect(SIGNATURE_PROVIDER_CATALOG.filter((entry) => entry.integrationStatus === 'declared')).toEqual([]);
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

  it('refuses an API-key provider without its key, and writes no row', async () => {
    const before = await ctx.database.db
      .selectFrom('esignature_connections')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_key', '=', 'dropbox_sign')
      .where('name', '=', marker('missing_key_provider'))
      .executeTakeFirst();
    const refused = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'dropbox_sign',
      name: marker('missing_key_provider'),
      environment: 'demo',
      // An OAuth client secret is the wrong credential for this provider and must not be accepted.
      clientSecret: CLIENT_SECRET,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/API key/i);
    expect(JSON.stringify(refused.body)).not.toContain(CLIENT_SECRET);
    const after = await ctx.database.db
      .selectFrom('esignature_connections')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_key', '=', 'dropbox_sign')
      .where('name', '=', marker('missing_key_provider'))
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

  it('does not admit a provider-draft operation for a direct-send provider', async () => {
    const probe = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, {
      operation: 'prepareEnvelope',
      providerKey: 'dropbox_sign',
    });
    expect(probe.status).toBe(422);
    expect(errorCode(probe)).toBe('NOT_SUPPORTED_BY_PROVIDER');
  });
});

describe('requests name a provider', () => {
  it('stores the provider key and reports the provider’s drafting mode', async () => {
    const created = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('direct_request'),
      providerKey: 'dropbox_sign',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createdRequests.push(String(created.body['id']));
    expect(created.body).toMatchObject({ providerKey: 'dropbox_sign', providerDrafting: 'direct' });
    // A DocuSign request keeps the provider-draft step.
    const docusign = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('draft_request'),
      providerKey: 'docusign',
    });
    expect(docusign.status, JSON.stringify(docusign.body)).toBe(201);
    createdRequests.push(String(docusign.body['id']));
    expect(docusign.body).toMatchObject({ providerKey: 'docusign', providerDrafting: 'draft' });
  });
});
