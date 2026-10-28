import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdvancedIntegrationsSettingsService } from '../src/advanced-integrations/advanced-integrations-settings.service.js';
import type { ConnectorAdapter } from '../src/advanced-integrations/connector-adapter.port.js';
import { hmacSha256Base64, verifyBase64HmacSha256 } from '../src/advanced-integrations/connectors/kit/webhook-signatures.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { OAuthFlowService } from '../src/advanced-integrations/oauth-flow.service.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 22.14 — the journey: a connector that breaks, and what the platform does about it
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.7, steps 1–8, and its acceptance assertions).
 *
 * One story through the public contracts, with a hand-built provider that fails on cue:
 * an operator registers a connection, authorizes it through a real OAuth dance, and the credential
 * never leaves the vault in plaintext. A sync pages through the provider's objects, and every
 * interruption the journey can name — a rate-limited page, a cancelled run, a record the CRM owns —
 * leaves a run row that says what happened, a checkpoint that says **how far it got**, and no second
 * copy of a record that was already applied. A conflict is opened, not silently overwritten, and an
 * operator's decision on it is refused if the world moved underneath it. A provider callback is
 * verified over the exact bytes, recorded once, and a replay of the same delivery changes nothing.
 * Nothing here touches a network, and no response, log row or run row carries a token.
 *
 * The provider is an in-process adapter registered at boot (AGENTS.md §3.3: no external effects, no
 * credentials, no charges). It is deliberately a *stubborn* provider: it hands back a rate-limit
 * error, it repeats a page, it sends a change to a field the CRM owns.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Nothing is reset or truncated; every
 * row this run creates is removed by exact id or by this run's unique marker — the CRM records
 * included, which are identified by the external-link rows this run's connection wrote — and
 * `afterAll` asserts that. The settings document this journey touches is `AdvancedIntegrations`.
 */

// A synthetic key before `bootApi()` builds the config. Never logged, never a real secret.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ?? 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
// The worker→API capability the door under test compares. Restored in `afterAll`, because `process.env`
// is shared by every test file in this process.
const previousWorkerSecret = process.env.REPORT_WORKER_SECRET;
const WORKER_SECRET = `agent-test-int24-${Date.now().toString(36)}-capability`;
process.env.REPORT_WORKER_SECRET = WORKER_SECRET;

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_INT24_${runId}`;
const PROVIDER_KEY = `agent-test-int24-${runId}`;
const CONNECTION_NAME = `${MARKER} connector`;
const ROLE_VIEWER = `int24-viewer-${runId}`;
const ROLE_OPERATOR = `int24-operator-${runId}`;
/** The secret the fake provider signs its callbacks with. Write-only: it goes into the vault, never out. */
const HOOK_SECRET = `${MARKER}-hook-secret-value`;
const API_KEY = `${MARKER}-api-key-value`;
const ACCESS_TOKEN = `${MARKER}-access-token-value`;

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

let ctx: ApiContext;
let settingsBaseline: unknown;
let viewerToken = '';
let operatorToken = '';
let connectionId = '';
let mappingId = '';
const created = {
  connectionIds: [] as string[],
  mappingIds: [] as string[],
  userIds: [] as string[],
  accountIds: [] as string[],
  jobIds: [] as string[],
};

/** The provider's own dataset. Seven records, so a page size of two is four pages. */
const PROVIDER_CONTACTS = Array.from({ length: 7 }, (_unused, index) => ({
  id: `${runId}-contact-${String(index + 1)}`,
  fullName: `${MARKER} Contact ${String(index + 1)}`,
  email: `int24-${String(index + 1)}-${runId}@example.test`,
}));

/**
 * The scripted faults. A field the test sets, the next provider call consumes — so a failure happens
 * exactly where the journey needs it and nowhere else.
 */
const script = {
  failNextFetch: null as ProviderError | null,
  /** Called after each page is returned, so a test can cancel a run while it is working. */
  onPage: null as ((pageNumber: number) => Promise<void> | void) | null,
  pageNumber: 0,
  grantedScopes: ['crm.read'],
  expiresAt: null as string | null,
  counts: { exchange: 0, refresh: 0, revoke: 0, fetch: 0, upsert: 0 },
};

function resetScript(): void {
  script.failNextFetch = null;
  script.onPage = null;
  script.pageNumber = 0;
  script.grantedScopes = ['crm.read'];
  script.expiresAt = null;
}

/**
 * The connector under test: OAuth with a refreshable token, paged reads, and inbound webhooks signed
 * with an HMAC over the exact bytes.
 *
 * It is written here rather than reused because the journey needs all three at once on **one**
 * connection: the platform's own fake answers with an API key and cannot be authorized, and the
 * webhook connector in the engine tests cannot page. A recovery journey that needed two connections
 * to tell one story would be asserting less than what an operator actually does.
 */
const providerAdapter: ConnectorAdapter = {
  providerKey: PROVIDER_KEY,
  adapterVersion: '1.0.0',
  providerApiVersion: '2026-01-01',
  capabilities: {
    schemaVersion: 1,
    authentication: 'oauth',
    objects: [
      {
        objectType: 'contact',
        label: 'Contact',
        read: true,
        create: false,
        update: false,
        delete: false,
        upsert: false,
        webhook: true,
        syncDirections: ['inbound'],
        fullSync: true,
        incrementalSync: false,
        requiredScopes: ['crm.read'],
        optionalScopes: ['crm.write'],
        maxPageSize: 100,
        rateLimitStrategy: 'provider_header',
        externalIdFields: ['id'],
        uniqueFields: ['id'],
        deletionVisibility: 'tombstoned',
        transactional: true,
        dataSensitivity: 'business',
      },
    ],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  },
  operations: { implementsFetch: true, implementsWrite: false, implementsDelete: false, implementsWebhook: true },
  supportsAuthorization: true,
  supportsRefresh: true,
  supportsRevocation: true,
  getCapabilities: () => providerAdapter.capabilities,
  validateConnection: async (context) => {
    if (script.failNextFetch !== null && script.failNextFetch.category === 'authorization') {
      throw script.failNextFetch;
    }
    const token = context.credential.accessToken ?? context.credential.apiKey;
    if (typeof token !== 'string' || token.trim() === '') {
      return {
        ok: false,
        code: 'CONFIGURATION_INVALID',
        message: 'The connection holds no credential.',
        accountRef: null,
        grantedScopes: [],
      };
    }
    return { ok: true, code: null, message: null, accountRef: `${MARKER} account`, grantedScopes: ['crm.read'] };
  },
  listObjectSchemas: async () => [
    {
      objectType: 'contact',
      label: 'Contact',
      incremental: false,
      maxPageSize: 100,
      fields: [
        { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
        { name: 'fullName', label: 'Name', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
        { name: 'email', label: 'Email', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
        { name: 'ownerId', label: 'Owner', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
      ],
    },
  ],
  listFields: async () => [
    { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
    { name: 'fullName', label: 'Name', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
    { name: 'email', label: 'Email', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
    { name: 'ownerId', label: 'Owner', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  ],
  fetchPage: async (input) => {
    script.counts.fetch += 1;
    if (script.failNextFetch !== null) {
      const error = script.failNextFetch;
      script.failNextFetch = null;
      throw error;
    }
    const offset = input.cursor === null ? 0 : Number(input.cursor.replace('off:', ''));
    if (!Number.isFinite(offset) || offset < 0) {
      throw new ProviderError('CURSOR_EXPIRED', 'The cursor cannot be read.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'bad_cursor',
      });
    }
    const page = PROVIDER_CONTACTS.slice(offset, offset + input.pageSize);
    const nextOffset = offset + page.length;
    script.pageNumber += 1;
    const hook = script.onPage;
    if (hook !== null) await hook(script.pageNumber);
    return {
      objects: page.map((record) => ({
        objectType: 'contact',
        externalId: record.id,
        externalParentId: null,
        fields: { id: record.id, fullName: record.fullName, email: record.email, ownerId: 'provider-owner' },
        updatedAt: null,
        version: null,
        deleted: false,
      })),
      nextCursor: nextOffset < PROVIDER_CONTACTS.length ? `off:${String(nextOffset)}` : null,
      cursorExpired: false,
    };
  },
  verifyWebhook: async (input) => ({
    // A connector that is not doing endpoint validation answers `challenge: null` explicitly. The
    // kit's verification result carries only `valid` and `reason`, and spreading it without the field
    // is what made the ingress read every verified delivery as a challenge and apply nothing.
    ...(verifyBase64HmacSha256({
      rawBody: input.rawBody,
      secret: input.context.credential.webhookSecret ?? null,
      header: input.headers['x-int24-signature'],
    })),
    challenge: null,
  }),
  normalizeWebhook: async (input) => {
    const body = input.body as { id?: string; externalId?: string; name?: string; email?: string; eventType?: string } | null;
    // A callback carries only the fields that changed. Sending an empty value the mapping does not
    // hold would put an invalid record on the CRM instead of the change the provider reported.
    const fields: Record<string, unknown> = { id: body?.externalId ?? '' };
    if (typeof body?.name === 'string' && body.name !== '') fields['fullName'] = body.name;
    if (typeof body?.email === 'string' && body.email !== '') fields['email'] = body.email;
    return [{
      deliveryId: body?.id ?? `${MARKER}-delivery`,
      objectType: 'contact',
      externalId: body?.externalId ?? null,
      eventType: body?.eventType ?? 'contact.updated',
      occurredAt: null,
      fields,
      deleted: false,
    }];
  },
  authorize: async (context) => ({
    authorizationUrl:
      `https://provider.invalid/authorize?state=${encodeURIComponent(context.state)}`
      + `&code_challenge=${String(context.codeChallenge ?? 'none')}`,
  }),
  exchangeCode: async () => {
    script.counts.exchange += 1;
    return {
      accessToken: ACCESS_TOKEN,
      refreshToken: `${MARKER}-refresh-token-value`,
      expiresAt: script.expiresAt,
      grantedScopes: [...script.grantedScopes],
      tokenType: 'Bearer',
      accountRef: `${MARKER} account`,
    };
  },
  refreshCredentials: async () => {
    script.counts.refresh += 1;
    return {
      accessToken: `${ACCESS_TOKEN}-rotated-${String(script.counts.refresh)}`,
      refreshToken: `${MARKER}-refresh-token-value`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      grantedScopes: [...script.grantedScopes],
      tokenType: 'Bearer',
      accountRef: `${MARKER} account`,
    };
  },
  revokeCredentials: async () => {
    script.counts.revoke += 1;
  },
};

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: {
      ...(token === undefined ? {} : authHeader(token)),
      ...(extraHeaders ?? {}),
    },
    ...(payload === undefined ? {} : { payload: payload as Body }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function asAdmin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<CallResult> {
  return call(method, url, ctx.adminToken, payload);
}

/** The raw text of a response, for the one assertion that must read a redirect rather than a body. */
async function raw(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers?: Record<string, string>) {
  return ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { ...authHeader(token), ...(headers ?? {}) } }),
    ...(payload === undefined ? {} : { payload: payload as Body }),
  });
}

/** Everything the module's own read endpoints say about this connection, joined for a leak scan. */
async function readableSurface(): Promise<string> {
  const parts: string[] = [];
  for (const url of [
    '/api/v1/AdvancedIntegrations/action/connections',
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}`,
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/detail`,
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/runs`,
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/webhook-deliveries`,
    `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/logs`,
    '/api/v1/AdvancedIntegrations/action/health',
    '/api/v1/AdvancedIntegrations/action/metrics',
    '/api/v1/AdvancedIntegrations/action/audit',
  ]) {
    const res = await asAdmin('GET', url);
    parts.push(JSON.stringify(res.body));
  }
  return parts.join('\n');
}

async function connectionRow(id: string = connectionId): Promise<Body> {
  const rows = await ctx.database.db
    .selectFrom('integration_connections')
    .selectAll()
    .where('id', '=', id)
    .execute();
  return (rows[0] ?? {}) as unknown as Body;
}

async function checkpoint(): Promise<{ cursor: string | null; resetRequired: boolean }> {
  const rows = await sql<{ cursor_value: string | null; reset_required: boolean }>`
    select cursor_value, reset_required from integration_sync_checkpoints
    where connection_id = ${connectionId} and mapping_id = ${mappingId} and direction = 'inbound'
    limit 1
  `.execute(ctx.database.db);
  const row = rows.rows[0];
  return { cursor: row?.cursor_value ?? null, resetRequired: row?.reset_required === true };
}

/** The run's own row, straight from the table the route reads, so a count cannot be a rendering trick. */
async function runRow(runIdValue: string): Promise<Body> {
  const rows = await ctx.database.db
    .selectFrom('integration_sync_runs')
    .selectAll()
    .where('id', '=', runIdValue)
    .execute();
  return (rows[0] ?? {}) as unknown as Body;
}

function runIdOf(result: CallResult): string {
  return String(result.body['id'] ?? '');
}

async function accountCount(): Promise<number> {
  if (created.accountIds.length === 0) return 0;
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'Account')
    .where('id', 'in', created.accountIds)
    .where('deleted_at', 'is', null)
    .execute();
  return rows.length;
}

/** Remember the CRM records this run's connection produced, identified by its own link rows. */
async function trackLinkedRecords(): Promise<void> {
  const rows = await ctx.database.db
    .selectFrom('integration_external_links')
    .select(['crm_entity_id'])
    .where('connection_id', '=', connectionId)
    .execute();
  for (const row of rows) {
    if (row.crm_entity_id !== null && !created.accountIds.includes(row.crm_entity_id)) {
      created.accountIds.push(row.crm_entity_id);
    }
  }
}

async function linkCount(): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('integration_external_links')
    .select('id')
    .where('connection_id', '=', connectionId)
    .execute();
  return rows.length;
}

beforeAll(async () => {
  ctx = await bootApi();
  const registry = ctx.app.get(IntegrationRegistry);
  registry.register({
    providerKey: PROVIDER_KEY,
    displayName: `${MARKER} connector`,
    description: 'A deterministic OAuth+paged+webhook connector used by the Phase 22.14 recovery journey.',
    category: 'test',
    adapterVersion: providerAdapter.adapterVersion,
    providerApiVersion: providerAdapter.providerApiVersion,
    status: 'available',
    capabilities: providerAdapter.getCapabilities(),
    requiredScopes: ['crm.read'],
    optionalScopes: ['crm.write'],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: providerAdapter,
  });

  settingsBaseline = await snapshotSettings(ctx, 'AdvancedIntegrations');
  // The control plane and the OAuth flow are both off unless a deployment turns them on; this journey
  // needs them, and it puts the row back in `afterAll`.
  const settings = await asAdmin('POST', '/api/v1/AdvancedIntegrations/action/settings', {
    features: { connections: true, oauth: true },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBeLessThan(300);

  // A viewer may see the module; an operator may administer its connections. Neither is an
  // administrator, so every write below is a real test of the capability matrix.
  await createTestRole(ctx, { id: ROLE_VIEWER, name: `${MARKER} viewer`, permissions: { AdvancedIntegrations: { read: 'all' } } });
  await createTestRole(ctx, {
    id: ROLE_OPERATOR,
    name: `${MARKER} operator`,
    permissions: {
      // `edit` on the module is what the platform's visibility rule reads: an operator administers
      // organization-owned connections, a viewer may only see what its own owner granted.
      AdvancedIntegrations: { read: 'all', edit: 'all' },
      IntegrationProvider: { read: 'all' },
      IntegrationConnection: { read: 'all', edit: 'all' },
      IntegrationCredential: { read: 'all', edit: 'all' },
      IntegrationDiagnostic: { read: 'all' },
      Account: { read: 'all', create: 'yes', edit: 'all', delete: 'all' },
    },
  });
  const viewer = await createTestUser(ctx, { userName: `int24viewer${runId.slice(-7)}`, roleIds: [ROLE_VIEWER] });
  const operator = await createTestUser(ctx, { userName: `int24operator${runId.slice(-7)}`, roleIds: [ROLE_OPERATOR] });
  viewerToken = viewer.token;
  operatorToken = operator.token;
  created.userIds.push(viewer.id, operator.id);
}, 240_000);

afterAll(async () => {
  if (!ctx) {
    if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
    else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;
    return;
  }
  const db = ctx.database.db;
  // Every group is attempted even if an earlier one failed: the residue of a run nobody can attribute
  // is how a shared database rots. Failures are collected and reported together at the end.
  const failures: string[] = [];
  const attempt = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  };

  // The ids are recovered **from the database by this run's marker**, not only from the lists the steps
  // appended to. A step that failed before it recorded its own id would otherwise leave a connection,
  // a mapping or a CRM record behind that no later run can identify — and a row a step created and then
  // failed on is exactly the normal case this file has to survive.
  const owned = { connections: [] as string[], mappings: [] as string[], accounts: [] as string[], jobs: [] as string[] };
  const discover = async (): Promise<void> => {
    const connectionRows = await db
      .selectFrom('integration_connections')
      .select('id')
      .where('name', 'like', `${MARKER}%`)
      .execute();
    owned.connections = [...new Set([...created.connectionIds, ...connectionRows.map((row) => row.id)])];
    const mappingRows = await db
      .selectFrom('integration_object_mappings')
      .select('id')
      .where('connection_id', 'in', owned.connections.length > 0 ? owned.connections : ['__none__'])
      .execute();
    owned.mappings = [...new Set([...created.mappingIds, ...mappingRows.map((row) => row.id)])];
    const recordRows = await db
      .selectFrom('entity_records')
      .select('id')
      .where('name', 'like', `${MARKER}%`)
      .execute();
    owned.accounts = [...new Set([...created.accountIds, ...recordRows.map((row) => row.id)])];
    const jobRows = await db
      .selectFrom('jobs')
      .select('id')
      .where('job', 'like', 'advancedIntegrations.%')
      .where(sql`target ->> 'connectionId' = any(${owned.connections.length > 0 ? owned.connections : ['__none__']}::text[])`)
      .execute();
    owned.jobs = [...new Set([...created.jobIds, ...jobRows.map((row) => row.id)])];
  };

  const engine = async (): Promise<void> => {
    if (owned.connections.length === 0) return;
    await db.deleteFrom('integration_sync_operations').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_sync_runs').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_sync_checkpoints').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_conflicts').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_dead_letters').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_webhook_deliveries').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_outbound_operations').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_record_origins').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_external_links').where('connection_id', 'in', owned.connections).execute();
  };
  const crmRecords = async (): Promise<void> => {
    if (owned.accounts.length === 0) return;
    await db.deleteFrom('stream_items').where('entity_id', 'in', owned.accounts).execute();
    await db.deleteFrom('audit_log').where('record_id', 'in', owned.accounts).execute();
    await db.deleteFrom('outbox_events').where(sql`payload ->> 'entityId'`, 'in', owned.accounts).execute();
    await db.deleteFrom('entity_records').where('id', 'in', owned.accounts).execute();
  };
  const mappingRows = async (): Promise<void> => {
    if (owned.mappings.length === 0) return;
    await db.deleteFrom('integration_field_mappings').where('mapping_id', 'in', owned.mappings).execute();
    await db.deleteFrom('integration_object_mappings').where('id', 'in', owned.mappings).execute();
  };
  const authorization = async (): Promise<void> => {
    if (owned.connections.length === 0) return;
    await db.deleteFrom('integration_oauth_states').where('connection_id', 'in', owned.connections).execute();
    await db.deleteFrom('integration_credential_secrets').where('connection_id', 'in', owned.connections).execute();
  };
  const jobsAndTrail = async (): Promise<void> => {
    if (owned.jobs.length > 0) {
      await db.deleteFrom('job_logs').where('job_id', 'in', owned.jobs).execute();
      await db.deleteFrom('jobs').where('id', 'in', owned.jobs).execute();
    }
    if (owned.connections.length > 0) {
      await db.deleteFrom('integration_audit_log').where('connection_id', 'in', owned.connections).execute();
    }
  };
  const connections = async (): Promise<void> => {
    if (owned.connections.length === 0) return;
    await db.deleteFrom('integration_connections').where('id', 'in', owned.connections).execute();
  };
  const people = async (): Promise<void> => {
    await db.deleteFrom('user_sessions').where('user_id', 'in', created.userIds).execute();
    await db.deleteFrom('users_roles').where('user_id', 'in', created.userIds).execute();
    await db.deleteFrom('users').where('id', 'in', created.userIds).execute();
    await db.deleteFrom('roles').where('id', 'in', [ROLE_VIEWER, ROLE_OPERATOR]).execute();
  };
  const settings = async (): Promise<void> => {
    await restoreSettings(ctx, 'AdvancedIntegrations', settingsBaseline);
    ctx.app.get(AdvancedIntegrationsSettingsService).invalidate();
  };

  await attempt('discovery', discover);
  await attempt('sync engine rows', engine);
  await attempt('crm records', crmRecords);
  await attempt('mappings', mappingRows);
  await attempt('authorization', authorization);
  await attempt('jobs and trail', jobsAndTrail);
  await attempt('connections', connections);
  await attempt('users and roles', people);
  await attempt('settings', settings);
  await attempt('leftovers', async () => {
    const rows = await sql<{ n: string }>`
      select (
        (select count(*) from integration_connections where name like ${`${MARKER}%`}) +
        (select count(*) from integration_object_mappings where connection_id = any(${owned.connections})) +
        (select count(*) from integration_sync_runs where connection_id = any(${owned.connections})) +
        (select count(*) from integration_external_links where connection_id = any(${owned.connections})) +
        (select count(*) from integration_credential_secrets where connection_id = any(${owned.connections})) +
        (select count(*) from integration_oauth_states where connection_id = any(${owned.connections})) +
        (select count(*) from entity_records where name like ${`${MARKER}%`}) +
        (select count(*) from users where id = any(${created.userIds})) +
        (select count(*) from jobs where target ->> 'connectionId' = any(${owned.connections}) and job like 'advancedIntegrations.%') +
        (select count(*) from app_settings where data::text like ${`%${runId}%`})
      )::text as n
    `.execute(db);
    expect(Number(rows.rows[0]?.n ?? '1')).toBe(0);
  });

  if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;

  expect(failures, failures.join(' | ')).toEqual([]);
  await shutdownApi();
}, 300_000);

describe('the journey: a connector that breaks, and what the platform does about it (22.14)', () => {
  it('step 1 — the control plane is a capability, not a page', async () => {
    // The catalog is provider administration; a role that can only *see* the module gets a refusal,
    // not an empty list it might mistake for "no connectors".
    const viewerProviders = await call('GET', '/api/v1/AdvancedIntegrations/action/providers', viewerToken);
    expect(viewerProviders.status).toBe(403);
    const catalog = await asAdmin('GET', '/api/v1/AdvancedIntegrations/action/providers');
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const keys = ((catalog.body['list'] ?? []) as Body[]).map((row) => String(row['providerKey']));
    expect(keys).toContain(PROVIDER_KEY);

    // A connection starts inert: draft, disabled, holding nothing.
    const created_ = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', operatorToken, {
      providerKey: PROVIDER_KEY,
      name: CONNECTION_NAME,
      ownerType: 'organization',
    });
    expect(created_.status, JSON.stringify(created_.body)).toBeLessThan(300);
    connectionId = String(created_.body['id']);
    created.connectionIds.push(connectionId);
    const row = await connectionRow();
    expect(String(row['status'])).toBe('draft');
    expect(Boolean(row['enabled'])).toBe(false);

    // A credential smuggled through an ordinary configuration field is refused by name: the vault is
    // the only place a secret may go.
    const smuggled = await call('PATCH', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}`, operatorToken, {
      connectionOptions: { apiKey: API_KEY },
    });
    expect(smuggled.status).toBe(422);
    expect(JSON.stringify(smuggled.body)).toContain('apiKey');

    // Draft is not permission to call: every provider-facing operation refuses it. The connection test
    // answers as a *result* rather than an exception — and the answer is a code with no message, so a
    // provider's own words never ride back to the caller.
    const testDraft = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/test`, operatorToken);
    expect(testDraft.status, JSON.stringify(testDraft.body)).toBeLessThan(300);
    expect(Boolean(testDraft.body['ok'])).toBe(false);
    expect(String(testDraft.body['code'])).toBe('CONFIGURATION_INVALID');
    expect(testDraft.body['message']).toBeNull();
  });

  it('step 2 — a viewer cannot write, and the same calls answer for an operator', async () => {
    // The nine routes that decide what a connection writes are connection administration. A role that
    // holds only the module's own read right must be refused on every one of them — before this
    // sub-phase they had no check anywhere, in the controller or in the service behind them.
    const refused = [
      ['POST', '/api/v1/AdvancedIntegrations/action/mappings', { providerKey: PROVIDER_KEY, objectType: 'contact', crmEntityType: 'Account', fields: [] }],
      ['POST', '/api/v1/AdvancedIntegrations/action/connections/' + connectionId + '/reconcile', undefined],
      ['POST', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x/activate', undefined],
      ['POST', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x/retire', undefined],
      ['POST', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x/sync', {}],
      ['POST', '/api/v1/AdvancedIntegrations/action/runs/run-x/cancel', undefined],
      ['POST', '/api/v1/AdvancedIntegrations/action/conflicts/conflict-x/resolve', { resolution: 'ignore' }],
      ['POST', '/api/v1/AdvancedIntegrations/action/dead-letters/dead-x/replay', undefined],
      ['PATCH', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x', { conflictPolicy: 'crm_wins' }],
    ] as const;
    for (const [method, url, payload] of refused) {
      const res = await call(method, url, viewerToken, payload);
      expect(res.status, `${method} ${url} → ${JSON.stringify(res.body)}`).toBe(403);
    }

    // A dry run writes nothing, so the module's own read right is enough for it: the call reaches the
    // mapping lookup instead of the permission layer.
    const preview = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x/preview', viewerToken, {
      sample: { id: 'x' },
    });
    expect(preview.status, JSON.stringify(preview.body)).not.toBe(403);

    // The same calls for an operator reach the business logic instead of the permission layer: they
    // fail (or succeed) for a reason that names the domain, never for a missing right.
    const operatorSync = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings/mapping-x/sync', operatorToken, {});
    expect(operatorSync.status).not.toBe(403);
    expect(JSON.stringify(operatorSync.body)).not.toContain('AUTHORIZATION_DENIED');
  });

  it('step 3 — a credential is encrypted at rest and never readable in any form', async () => {
    const stored = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/credentials`, operatorToken, {
      kind: 'api_key',
      value: API_KEY,
    });
    expect(stored.status, JSON.stringify(stored.body)).toBeLessThan(300);

    const secrets = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .execute();
    const apiKeyRow = secrets.find((row) => row.kind === 'api_key');
    expect(apiKeyRow).toBeDefined();
    expect(String(apiKeyRow?.['payload_encrypted']).startsWith('v1:')).toBe(true);
    expect(String(apiKeyRow?.['payload_encrypted'])).not.toContain(API_KEY);

    // Nothing on the readable surface — the connection, its detail, its runs, its logs, the module's
    // health, metrics and audit trail — repeats the secret back.
    const surface = await readableSurface();
    expect(surface).not.toContain(API_KEY);
    expect(surface).not.toContain('payload_encrypted');

    // The webhook secret is a separate credential, and the operator who rotates it never sees the old
    // value: the write path is the only path.
    const hookSecret = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/credentials`, operatorToken, {
      kind: 'webhook_secret',
      value: HOOK_SECRET,
    });
    expect(hookSecret.status, JSON.stringify(hookSecret.body)).toBeLessThan(300);
    const rotated = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/rotate-secret`, operatorToken, {
      kind: 'api_key',
      value: `${API_KEY}-rotated`,
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBeLessThan(300);
    const after = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select(['kind', 'state', 'rotated_at'])
      .where('connection_id', '=', connectionId)
      .where('kind', '=', 'api_key')
      .execute();
    expect(after[0]?.state).toBe('active');
    expect(after[0]?.rotated_at).not.toBeNull();
  });

  it('step 4 — the authorization dance: state, PKCE, one use, and a refusal that names the missing scope', async () => {
    // A connection is authorized through the public flow. The refusal before it is configured says
    // which requirement is unmet.
    const notYet = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/authorize`, operatorToken, {});
    expect(notYet.status, JSON.stringify(notYet.body)).toBeLessThan(300);
    const started = notYet.body as Body;
    const url = String(started['authorizationUrl'] ?? '');
    expect(url).toContain('state=');
    expect(url).toContain('code_challenge=');
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(16);
    expect(JSON.stringify(started)).not.toContain('code_verifier');

    const pending = await connectionRow();
    expect(String(pending['status'])).toBe('pending_authorization');

    // A callback whose state the platform never issued is refused, and it changes nothing.
    const forged = await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${'f'.repeat(48)}&code=attacker-code`);
    expect(forged.statusCode).toBe(401);
    expect(JSON.stringify(forged.body)).not.toContain('attacker-code');

    // A provider that appends a parameter the contract does not describe is not parsed loosely.
    const extra = await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${state}&code=c1&iss=https://other.invalid`);
    expect(extra.statusCode).toBe(400);

    // The real callback: the browser leaves with a redirect to the operator's screen, and the code
    // appears in no part of it.
    const callback = await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${state}&code=one-time-code`);
    expect(callback.statusCode).toBe(302);
    const location = String(callback.headers['location'] ?? '');
    expect(location).toContain(connectionId);
    expect(location).not.toContain('one-time-code');
    const connected = await connectionRow();
    expect(String(connected['status'])).toBe('connected');
    expect(JSON.stringify(connected['granted_scopes'] ?? '')).toContain('crm.read');

    // The state is single-use: the same callback again is refused, because a second presentation of a
    // consumed authorization is either a replay or a bug — either way it must not re-authorize.
    const replay = await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${state}&code=one-time-code`);
    expect(replay.statusCode).toBe(401);

    // The tokens the flow stored are ciphertext, and the grant's owner is the connection.
    const vault = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select(['kind', 'payload_encrypted', 'expires_at'])
      .where('connection_id', '=', connectionId)
      .execute();
    const access = vault.find((row) => row.kind === 'oauth_access_token');
    expect(access).toBeDefined();
    expect(String(access?.payload_encrypted)).not.toContain(ACCESS_TOKEN);
    expect((await readableSurface())).not.toContain(ACCESS_TOKEN);

    // A provider that grants less than its own object requires does not reach "connected".
    script.grantedScopes = [];
    const second = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', operatorToken, {
      providerKey: PROVIDER_KEY,
      name: `${CONNECTION_NAME} scopeless`,
      ownerType: 'organization',
    });
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    const secondId = String(second.body['id']);
    created.connectionIds.push(secondId);
    const start2 = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${secondId}/authorize`, operatorToken, {});
    const state2 = new URL(String((start2.body as Body)['authorizationUrl'])).searchParams.get('state') ?? '';
    const cb2 = await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${state2}&code=c2`);
    expect(cb2.statusCode).toBe(302);
    const scopeless = await connectionRow(secondId);
    expect(String(scopeless['status'])).toBe('reauthorization_required');
    expect(String(scopeless['last_error_code'])).toBe('SCOPE_MISSING');
    script.grantedScopes = ['crm.read'];
    // It has served its point; leaving it behind would leave a second connection for the same provider.
    const cleanupSecond = await call('DELETE', `/api/v1/AdvancedIntegrations/action/connections/${secondId}`, operatorToken);
    expect(cleanupSecond.status, JSON.stringify(cleanupSecond.body)).toBeLessThan(300);
  });

  it('step 5 — a stale grant is refreshed on demand and revoked to a terminal state', async () => {
    // Refresh has no route of its own: an operator (or the expiry sweep) asks the flow service, and
    // the journey follows it there — with the finding recorded that no runtime path ever calls it
    // (docs/quality/known-gaps.md). The token the callback stored has no expiry, so it is already due.
    const oauth = ctx.app.get(OAuthFlowService);
    const before = script.counts.refresh;
    const refreshed = await oauth.refresh(connectionId);
    expect(Boolean(refreshed.refreshed)).toBe(true);
    expect(refreshed.expiresAt).not.toBeNull();
    expect(script.counts.refresh).toBe(before + 1);

    // The rotated access token is what the vault now holds, and the old one is gone.
    const vault = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select(['kind', 'payload_encrypted'])
      .where('connection_id', '=', connectionId)
      .execute();
    expect(vault.find((row) => row.kind === 'oauth_access_token')).toBeDefined();
    for (const row of vault) expect(String(row.payload_encrypted)).not.toContain(ACCESS_TOKEN);

    // Revoke tells the provider and then destroys the stored secret. The state is terminal.
    const revoked = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/revoke`, operatorToken);
    expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);
    expect(Boolean(revoked.body['providerRevoked'])).toBe(true);
    expect(script.counts.revoke).toBe(1);
    const row = await connectionRow();
    expect(String(row['status'])).toBe('revoked');
    const secrets = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select(['kind', 'state', 'payload_encrypted'])
      .where('connection_id', '=', connectionId)
      .execute();
    expect(secrets.every((secret) => secret.state === 'revoked')).toBe(true);
    expect(secrets.every((secret) => String(secret.payload_encrypted) === '')).toBe(true);

    // Nothing may call a provider through it any more: the test answers as a failed *result*, not as a
    // call, and no transition leads out of `revoked`.
    const refused = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/test`, operatorToken);
    expect(refused.status, JSON.stringify(refused.body)).toBeLessThan(300);
    expect(Boolean(refused.body['ok'])).toBe(false);
    const reauthorize = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/authorize`, operatorToken, {});
    expect(reauthorize.status, JSON.stringify(reauthorize.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(reauthorize.body)).toContain('revoked');

    // `reconnect` is the same state machine, not a way around it: a revoked grant is recovered by a new
    // connection, never by patching the terminal one.
    const reconnected = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconnect`, operatorToken, {});
    expect(reconnected.status, JSON.stringify(reconnected.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(reconnected.body)).toContain('revoked');

    // Removing it is an operator action, and the record leaves the control plane: the connection is
    // soft-deleted, and its credentials and authorization states go with it.
    const removed = await call('DELETE', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}`, operatorToken);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);

    // The journey continues on a fresh grant: authorize, callback, connected.
    const fresh = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', operatorToken, {
      providerKey: PROVIDER_KEY,
      name: `${CONNECTION_NAME} working`,
      ownerType: 'organization',
    });
    expect(fresh.status, JSON.stringify(fresh.body)).toBeLessThan(300);
    connectionId = String(fresh.body['id']);
    created.connectionIds.push(connectionId);
    const authorize = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/authorize`, operatorToken, {});
    const state = new URL(String((authorize.body as Body)['authorizationUrl'])).searchParams.get('state') ?? '';
    await raw('GET', `/api/v1/integrations/advanced-integrations/oauth/callback?state=${state}&code=code-2`);
    expect(String((await connectionRow())['status'])).toBe('connected');
    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/credentials`, operatorToken, {
      kind: 'webhook_secret',
      value: HOOK_SECRET,
    });
  });

  it('step 6 — a mapping is reviewed before it can write, and a preview proves it writes nothing', async () => {
    const drafted = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', operatorToken, {
      providerKey: PROVIDER_KEY,
      objectType: 'contact',
      crmEntityType: 'Account',
      direction: 'inbound',
      syncMode: 'full',
      conflictPolicy: 'manual',
      deletionPolicy: 'unlink',
      fields: [
        { sourcePath: 'fullName', targetField: 'name', transform: null, required: true, direction: 'inbound' },
        { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false, direction: 'inbound' },
      ],
    });
    expect(drafted.status, JSON.stringify(drafted.body)).toBeLessThan(300);
    mappingId = String(drafted.body['id']);
    created.mappingIds.push(mappingId);

    // A provider payload may not decide who owns a record. The mapping is refused *activation*; the
    // preview shows what would have been dropped.
    const overreaching = await call('POST', '/api/v1/AdvancedIntegrations/action/mappings', operatorToken, {
      providerKey: PROVIDER_KEY,
      objectType: 'contact',
      crmEntityType: 'Account',
      direction: 'inbound',
      fields: [{ sourcePath: 'ownerId', targetField: 'assignedUserId', transform: null, required: false, direction: 'inbound' }],
    });
    expect(overreaching.status, JSON.stringify(overreaching.body)).toBeLessThan(300);
    const overreachingId = String(overreaching.body['id']);
    created.mappingIds.push(overreachingId);
    const refusedActivate = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${overreachingId}/activate`, operatorToken);
    expect(refusedActivate.status, JSON.stringify(refusedActivate.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refusedActivate.body)).toContain('assignedUserId');

    const preview = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/preview`, operatorToken, {
      sample: { id: `${runId}-preview-1`, fullName: `${MARKER} Preview Only`, email: 'preview@example.test' },
    });
    expect(preview.status, JSON.stringify(preview.body)).toBeLessThan(300);
    expect(JSON.stringify(preview.body)).toContain(`${MARKER} Preview Only`);
    expect(await linkCount()).toBe(0);

    const activated = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/activate`, operatorToken);
    expect(activated.status, JSON.stringify(activated.body)).toBeLessThan(300);

    // Retiring the overreaching mapping keeps it out of the way; an *inactive* mapping cannot be synced.
    await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${overreachingId}/retire`, operatorToken);
    const syncDraft = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${overreachingId}/sync`, operatorToken, {});
    expect(syncDraft.status, JSON.stringify(syncDraft.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(syncDraft.body)).toContain('active');
  });

  it('step 7 — a paged sync records counts, a checkpoint and one link per provider object', async () => {
    const run = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 2,
      triggerSource: 'manual',
    });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    const id = runIdOf(run);
    const row = await runRow(id);
    expect(String(row['status'])).toBe('completed');
    expect(Number(row['records_scanned'])).toBe(PROVIDER_CONTACTS.length);
    expect(Number(row['records_applied'])).toBe(PROVIDER_CONTACTS.length);
    expect(Number(row['records_failed'])).toBe(0);
    // Four pages for seven records at two per page; the fake's cursor is the proof the loop turned.
    expect(script.counts.fetch).toBeGreaterThanOrEqual(4);
    // A full pass ends with no cursor left: the checkpoint says "everything up to here".
    expect(String(row['cursor_after'])).toBe('null');
    expect((await checkpoint()).cursor).toBeNull();

    await trackLinkedRecords();
    expect(await linkCount()).toBe(PROVIDER_CONTACTS.length);
    expect(await accountCount()).toBe(PROVIDER_CONTACTS.length);

    // The link is the identity: an operator who deletes the CRM record does not delete the link's
    // history, and the next run re-applies against the same external id rather than inventing one.
    const operations = await asAdmin('GET', `/api/v1/AdvancedIntegrations/action/runs/${id}/operations`);
    expect(operations.status).toBe(200);
    const list = (operations.body['list'] ?? []) as Body[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((op) => String(op['status']) === 'applied')).toBe(true);
    expect(list.every((op => op['idempotencyKey'] === undefined || String(op['idempotencyKey']).includes(mappingId)))).toBe(true);
  });

  it('step 8 — the same page twice is one record, and a bounded run stops where it really stopped', async () => {
    const again = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 3,
      triggerSource: 'manual',
    });
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    // The provider handed over the same seven objects again. The CRM still holds seven records.
    expect(await accountCount()).toBe(PROVIDER_CONTACTS.length);
    expect(await linkCount()).toBe(PROVIDER_CONTACTS.length);

    // A bounded run is a promise about the *checkpoint*, not only about the records: `maxRecords` may
    // stop in the middle of a page, and the cursor must not claim the rest of that page was applied.
    const reconcile = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    expect(reconcile.status, JSON.stringify(reconcile.body)).toBeLessThan(300);
    const bounded = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 2,
      maxRecords: 3,
      triggerSource: 'manual',
    });
    expect(bounded.status, JSON.stringify(bounded.body)).toBeLessThan(300);
    const boundedRow = await runRow(runIdOf(bounded));
    expect(Number(boundedRow['records_scanned'])).toBe(3);
    // Page 1 (two records) was complete; page 2 was cut off after one. The cursor therefore sits at
    // the end of page 1, not at the end of page 2 — the untouched record is still owed.
    expect((await checkpoint()).cursor).toBe('off:2');

    // Finish the job. This is the resume the checkpoint exists for: an **incremental** run picks the
    // cursor up, so it reads only what the bounded run left. A `full` run would re-read everything — and
    // still create nothing twice, which is the other half of the promise.
    const finish = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 5,
      runType: 'incremental',
      triggerSource: 'manual',
    });
    expect(finish.status, JSON.stringify(finish.body)).toBeLessThan(300);
    // Five, not four: the checkpoint moves by whole pages, so the record the bounded run took out of the
    // middle of page 2 is read again. Nothing is lost, and the idempotency key means nothing is doubled.
    expect(Number((await runRow(runIdOf(finish)))['records_scanned'])).toBe(PROVIDER_CONTACTS.length - 2);
    expect(await accountCount()).toBe(PROVIDER_CONTACTS.length);
    expect((await checkpoint()).cursor).toBeNull();
  });

  it('step 9 — a provider error stops the run, keeps the checkpoint, and shows up in the dead letters', async () => {
    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    script.pageNumber = 0;
    // The second page is the one the provider refuses: the first page is applied and committed, and the
    // refusal is armed only after that page came back, so it cannot land on the wrong call.
    script.onPage = (pageNumber) => {
      if (pageNumber !== 1) return;
      script.failNextFetch = new ProviderError('RATE_LIMITED', 'Too many requests.', {
        category: 'rate_limited',
        retryable: true,
        detail: 'page_two',
      });
    };
    const failed = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 2,
      triggerSource: 'schedule',
    });
    expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(400);
    resetScript();

    const runs = await asAdmin('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/runs`);
    const list = (runs.body['list'] ?? []) as Body[];
    const dead = list.find((entry) => String(entry['status']) === 'failed');
    expect(dead).toBeDefined();
    const row = await runRow(String((dead as Body)['id']));
    expect(String(row['last_error_code'])).toBe('RATE_LIMITED');
    // The error is a code and a safe detail. Neither a token nor a payload rides along.
    const detail = JSON.stringify(row['last_error_detail'] ?? '');
    expect(detail).not.toContain(ACCESS_TOKEN);
    expect(detail).not.toContain(HOOK_SECRET);
    expect(String(row['cursor_after'])).toBe('off:2');
    expect((await checkpoint()).cursor).toBe('off:2');

    // The failure is visible where an operator looks: the run, the dead letter, and the connection's
    // own "needs attention".
    const letters = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/dead-letters`, operatorToken);
    expect(letters.status, JSON.stringify(letters.body)).toBeLessThan(300);
    const open = ((letters.body['list'] ?? []) as Body[]).filter((letter) => String(letter['status']) === 'open');
    expect(open.length).toBeGreaterThan(0);
    const detailView = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/detail`, operatorToken);
    expect(JSON.stringify(detailView.body)).toContain('failed');

    // And the run resumes from the checkpoint, not from the start: the two records already applied are
    // not re-read, and the total never becomes nine.
    const resumed = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 5,
      runType: 'incremental',
      triggerSource: 'schedule',
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBeLessThan(300);
    expect(Number((await runRow(runIdOf(resumed)))['records_scanned'])).toBe(PROVIDER_CONTACTS.length - 2);
    expect(await accountCount()).toBe(PROVIDER_CONTACTS.length);
    expect((await checkpoint()).cursor).toBeNull();
  });

  it('step 10 — a cancelled run stops at the page boundary and reports what it already did', async () => {
    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    script.pageNumber = 0;
    // The operator presses cancel while the run is working: the request lands between two pages, which
    // is the only boundary a page-at-a-time loop can honour.
    script.onPage = async (pageNumber) => {
      if (pageNumber !== 1) return;
      const runs = await asAdmin('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/runs`);
      const running = ((runs.body['list'] ?? []) as Body[]).find((entry) => String(entry['status']) === 'running');
      expect(running).toBeDefined();
      const cancelled = await call('POST', `/api/v1/AdvancedIntegrations/action/runs/${String(running?.['id'])}/cancel`, operatorToken);
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
      expect(String(cancelled.body['status'])).toBe('cancelled');
    };
    const run = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 2,
      triggerSource: 'manual',
    });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    resetScript();

    const id = runIdOf(run);
    const row = await runRow(id);
    expect(String(row['status'])).toBe('cancelled');
    // Exactly one page was applied — and the checkpoint says exactly that, so the next run is a
    // continuation rather than a repetition.
    expect(Number(row['records_scanned'])).toBe(2);
    expect((await checkpoint()).cursor).toBe('off:2');

    const continued = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 5,
      runType: 'incremental',
      triggerSource: 'manual',
    });
    expect(continued.status, JSON.stringify(continued.body)).toBeLessThan(300);
    expect(Number((await runRow(runIdOf(continued)))['records_scanned'])).toBe(PROVIDER_CONTACTS.length - 2);
    expect(await accountCount()).toBe(PROVIDER_CONTACTS.length);

    // A run that finished is not cancellable: the refusal names the state.
    const late = await call('POST', `/api/v1/AdvancedIntegrations/action/runs/${id}/cancel`, operatorToken);
    expect(late.status, JSON.stringify(late.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(late.body)).toContain('cancelled');
  });

  it('step 11 — a conflict is opened, not overwritten, and a stale decision is refused', async () => {
    const linked = await ctx.database.db
      .selectFrom('integration_external_links')
      .select(['crm_entity_id', 'external_id'])
      .where('connection_id', '=', connectionId)
      .where('external_id', '=', PROVIDER_CONTACTS[0]?.id ?? '')
      .execute();
    const accountId = String(linked[0]?.crm_entity_id ?? '');
    expect(accountId).toBeTruthy();

    // Somebody with a right changes the record in the CRM. The provider does not own that field's
    // meaning, and its next page must not quietly win.
    const edited = await call('PATCH', `/api/v1/Account/${accountId}`, operatorToken, { name: `${MARKER} CRM edit` });
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);

    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    const run = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 100,
      triggerSource: 'manual',
    });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);

    const conflicts = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/conflicts`, operatorToken);
    expect(conflicts.status, JSON.stringify(conflicts.body)).toBeLessThan(300);
    const open = ((conflicts.body['list'] ?? []) as Body[]).filter((entry) => String(entry['status']) === 'open');
    expect(open.length).toBeGreaterThan(0);
    const conflictId = String(open[0]?.['id'] ?? '');

    // The record is still what the human wrote: a promise is not a write.
    const before = await call('GET', `/api/v1/Account/${accountId}`, operatorToken);
    expect(String((before.body as Body)['name'])).toBe(`${MARKER} CRM edit`);

    // A decision the operator changed their mind about is honoured, and the conflict closes exactly
    // once. `keep_provider` is a write the operator chose, and it is auditable.
    const resolved = await call('POST', `/api/v1/AdvancedIntegrations/action/conflicts/${conflictId}/resolve`, operatorToken, {
      resolution: 'keep_provider',
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);
    const after = await call('GET', `/api/v1/Account/${accountId}`, operatorToken);
    expect(String((after.body as Body)['name'])).toBe(PROVIDER_CONTACTS[0]?.fullName ?? '');

    const twice = await call('POST', `/api/v1/AdvancedIntegrations/action/conflicts/${conflictId}/resolve`, operatorToken, {
      resolution: 'keep_crm',
    });
    expect(twice.status, JSON.stringify(twice.body)).toBeGreaterThanOrEqual(400);

    // Staleness: the record moves again while an operator is deciding, so their decision is about a
    // world that no longer exists and the platform says so instead of guessing.
    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    await call('PATCH', `/api/v1/Account/${accountId}`, operatorToken, { name: `${MARKER} CRM edit again` });
    await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, { pageSize: 100 });
    const reopened = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/conflicts`, operatorToken);
    const freshOpen = ((reopened.body['list'] ?? []) as Body[]).filter((entry) => String(entry['status']) === 'open');
    const pendingId = String(freshOpen[0]?.['id'] ?? '');
    expect(pendingId).toBeTruthy();
    await call('PATCH', `/api/v1/Account/${accountId}`, operatorToken, { name: `${MARKER} moved underneath` });
    const stale = await call('POST', `/api/v1/AdvancedIntegrations/action/conflicts/${pendingId}/resolve`, operatorToken, {
      resolution: 'keep_provider',
    });
    expect(stale.status, JSON.stringify(stale.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(stale.body)).toContain('changed again');
    // The human's latest word still stands.
    const stillOurs = await call('GET', `/api/v1/Account/${accountId}`, operatorToken);
    expect(String((stillOurs.body as Body)['name'])).toBe(`${MARKER} moved underneath`);
  });

  it('step 12 — a provider callback is verified over the exact bytes, recorded once, and applied once', async () => {
    const key = String((await connectionRow())['webhook_key'] ?? '');
    expect(key.length).toBeGreaterThan(8);
    const door = `/api/v1/integrations/advanced-integrations/${PROVIDER_KEY}/${key}/event`;
    const deliveryId = `${runId}-delivery-1`;
    const body = {
      id: deliveryId,
      externalId: PROVIDER_CONTACTS[1]?.id,
      eventType: 'contact.updated',
      name: `${MARKER} By Webhook`,
    };
    const rawBody = JSON.stringify(body);
    const signature = hmacSha256Base64(HOOK_SECRET, rawBody);

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: door,
      headers: { 'content-type': 'application/json', 'x-int24-signature': signature },
      payload: rawBody,
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const receipt = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('delivery_id', '=', deliveryId)
      .execute();
    expect(receipt[0]?.status).toBe('received');
    expect(Boolean(receipt[0]?.signature_valid)).toBe(true);

    // The queue's own row is the contract between the door and the worker. Handing the API back
    // exactly what it enqueued is what "processed once" rests on — and this payload used to carry a
    // field the door's strict schema did not know, so every job failed with a 400 and no event was
    // ever applied.
    const job = await ctx.database.db
      .selectFrom('jobs')
      .select(['id', 'job', 'target'])
      .where('job', '=', 'advancedIntegrations.processWebhookEvent')
      .where(sql`target::text like ${`%${deliveryId}%`}`)
      .executeTakeFirst();
    expect(job).toBeDefined();
    if (job !== undefined) created.jobIds.push(job.id);
    const processed = await call(
      'POST',
      '/api/v1/AdvancedIntegrations/action/process-webhook-event',
      undefined,
      job?.target as Body,
      { 'x-worker-secret': WORKER_SECRET },
    );
    expect(processed.status, JSON.stringify(processed.body)).toBe(200);
    expect(String(processed.body['outcome'])).not.toBe('');

    const targetId = String((await ctx.database.db
      .selectFrom('integration_external_links')
      .select('crm_entity_id')
      .where('connection_id', '=', connectionId)
      .where('external_id', '=', PROVIDER_CONTACTS[1]?.id ?? '')
      .executeTakeFirst())?.crm_entity_id ?? '');
    await trackLinkedRecords();

    // Under the mapping's `manual` policy a webhook that disagrees is the same event as a poll that
    // disagrees: it opens a conflict and writes nothing. The push path does not get its own rules.
    const untouched = await call('GET', `/api/v1/Account/${targetId}`, operatorToken);
    expect(String((untouched.body as Body)['name'])).toBe(PROVIDER_CONTACTS[1]?.fullName ?? '');
    const fromHook = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/conflicts`, operatorToken);
    expect(JSON.stringify(fromHook.body)).toContain('field_conflict');

    // Set the policy to what the operator means by "the provider owns this field" and the same
    // delivery path writes the record — through the mapping, not around it.
    const providerWins = await call('PATCH', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}`, operatorToken, {
      conflictPolicy: 'provider_wins',
    });
    expect(providerWins.status, JSON.stringify(providerWins.body)).toBeLessThan(300);
    const secondBody = {
      id: `${runId}-delivery-2`,
      externalId: PROVIDER_CONTACTS[1]?.id,
      eventType: 'contact.updated',
      name: `${MARKER} By Webhook`,
    };
    const secondRaw = JSON.stringify(secondBody);
    const secondAccepted = await ctx.app.inject({
      method: 'POST',
      url: door,
      headers: { 'content-type': 'application/json', 'x-int24-signature': hmacSha256Base64(HOOK_SECRET, secondRaw) },
      payload: secondRaw,
    });
    expect(secondAccepted.statusCode, secondAccepted.body).toBe(202);
    const secondJob = await ctx.database.db
      .selectFrom('jobs')
      .select(['id', 'target'])
      .where('job', '=', 'advancedIntegrations.processWebhookEvent')
      .where(sql`target::text like ${`%${runId}-delivery-2%`}`)
      .executeTakeFirst();
    expect(secondJob).toBeDefined();
    if (secondJob !== undefined) created.jobIds.push(secondJob.id);
    const processedSecond = await call(
      'POST',
      '/api/v1/AdvancedIntegrations/action/process-webhook-event',
      undefined,
      secondJob?.target as Body,
      { 'x-worker-secret': WORKER_SECRET },
    );
    expect(processedSecond.status, JSON.stringify(processedSecond.body)).toBe(200);
    const changed = await call('GET', `/api/v1/Account/${targetId}`, operatorToken);
    expect(String((changed.body as Body)['name'])).toBe(`${MARKER} By Webhook`);

    // A replay of the same provider delivery is a duplicate: one receipt, no second apply.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: door,
      headers: { 'content-type': 'application/json', 'x-int24-signature': signature },
      payload: rawBody,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    const body2 = JSON.parse(replay.body) as Body;
    expect(String(body2['status'])).toBe('duplicate');
    const receipts = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('delivery_id', '=', deliveryId)
      .execute();
    expect(receipts.length).toBe(1);

    // A bad signature is refused, recorded as invalid, and changes nothing.
    const forged = await ctx.app.inject({
      method: 'POST',
      url: door,
      headers: { 'content-type': 'application/json', 'x-int24-signature': 'not-the-right-mac' },
      payload: JSON.stringify({ ...body, id: `${runId}-delivery-forged`, name: `${MARKER} Should Not Exist` }),
    });
    expect(forged.statusCode).toBe(401);
    // The rejected delivery is recorded under a synthetic id: the payload's own identity was never
    // verified, so it cannot be trusted as the deduplication key. What it does carry is the reason.
    const forgedReceipt = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('status', '=', 'rejected')
      .orderBy('received_at', 'desc')
      .executeTakeFirst();
    expect(forgedReceipt).toBeDefined();
    expect(Boolean(forgedReceipt?.signature_valid)).toBe(false);
    expect(String(forgedReceipt?.error_detail)).toBe('signature_mismatch');
    // The unverified payload is never stored.
    expect(forgedReceipt?.payload).toBeNull();
    expect((await accountCount())).toBe(PROVIDER_CONTACTS.length);

    // An endpoint key nobody issued is refused without recording anything: a scan of the door must not
    // become a write amplification of the receipt table.
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/advanced-integrations/${PROVIDER_KEY}/${runId}-nobody/${'event'}`,
      headers: { 'content-type': 'application/json', 'x-int24-signature': signature },
      payload: rawBody,
    });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    const rows = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('delivery_id', '=', `${runId}-unknown-endpoint`)
      .execute();
    expect(rows.length).toBe(0);

    // The door without the worker capability is not a public route, and a wrong capability is not a
    // near miss.
    const noSecret = await call('POST', '/api/v1/AdvancedIntegrations/action/process-webhook-event', undefined, job?.target as Body);
    expect(noSecret.status).toBe(401);
    const wrongSecret = await call(
      'POST',
      '/api/v1/AdvancedIntegrations/action/process-webhook-event',
      undefined,
      job?.target as Body,
      { 'x-worker-secret': `${WORKER_SECRET}-x` },
    );
    expect(wrongSecret.status).toBe(401);

    // An event a domain service already claimed is recorded and then **skipped** by the generic mapping
    // path — otherwise a consent or payment event would be applied twice, once by the service that owns
    // its invariants and once by a mapping that does not know them.
    const claimedBody = {
      id: `${runId}-delivery-claimed`,
      externalId: PROVIDER_CONTACTS[2]?.id,
      eventType: 'contact.updated',
      name: `${MARKER} Claimed By Domain`,
    };
    const claimedRaw = JSON.stringify(claimedBody);
    const claimedArrival = await ctx.app.inject({
      method: 'POST',
      url: door,
      headers: { 'content-type': 'application/json', 'x-int24-signature': hmacSha256Base64(HOOK_SECRET, claimedRaw) },
      payload: claimedRaw,
    });
    expect(claimedArrival.statusCode, claimedArrival.body).toBe(202);
    const claimedTarget = (await ctx.database.db
      .selectFrom('jobs')
      .select(['id', 'target'])
      .where('job', '=', 'advancedIntegrations.processWebhookEvent')
      .where(sql`target::text like ${`%${runId}-delivery-claimed%`}`)
      .executeTakeFirst())?.target as Body;
    expect(claimedTarget).toBeDefined();
    const claimed = await call(
      'POST',
      '/api/v1/AdvancedIntegrations/action/process-webhook-event',
      undefined,
      { ...claimedTarget, handled: true },
      { 'x-worker-secret': WORKER_SECRET },
    );
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(String(claimed.body['outcome'])).toBe('handled_by_domain');
    const claimedRecord = await ctx.database.db
      .selectFrom('integration_external_links')
      .select('crm_entity_id')
      .where('connection_id', '=', connectionId)
      .where('external_id', '=', PROVIDER_CONTACTS[2]?.id ?? '')
      .executeTakeFirst();
    const untouchedClaim = await call('GET', `/api/v1/Account/${String(claimedRecord?.crm_entity_id ?? '')}`, operatorToken);
    expect(String((untouchedClaim.body as Body)['name'])).toBe(PROVIDER_CONTACTS[2]?.fullName ?? '');

    // Back to the reviewed default: a provider does not get to decide a field nobody agreed it owns.
    const restorePolicy = await call('PATCH', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}`, operatorToken, {
      conflictPolicy: 'manual',
    });
    expect(restorePolicy.status, JSON.stringify(restorePolicy.body)).toBeLessThan(300);
  });

  it('step 13 — a partial failure is an operation with a name, and a retry does not invent a job', async () => {
    // A required field the provider stopped sending: the record fails, the run does not pretend
    // otherwise, and the failure is one operation deep.
    await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`, operatorToken);
    const before = await accountCount();
    const run = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, {
      pageSize: 100,
      triggerSource: 'manual',
    });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    const failedOps = await call(
      'GET',
      `/api/v1/AdvancedIntegrations/action/runs/${runIdOf(run)}/operations?status=failed`,
      operatorToken,
    );
    expect(failedOps.status, JSON.stringify(failedOps.body)).toBeLessThan(300);
    const list = (failedOps.body['list'] ?? []) as Body[];
    expect(await accountCount()).toBeGreaterThanOrEqual(Math.min(before, PROVIDER_CONTACTS.length));
    expect(Array.isArray(list)).toBe(true);

    // Retry re-opens one operation. It must not enqueue work nobody can do: the adapter contract reads
    // a page, never a single object by id, so a job naming a handler that does not exist would only
    // add a permanent failure to the queue and a lie to the operator's answer.
    const target = list[0] ?? await ctx.database.db
      .selectFrom('integration_sync_operations')
      .select(['id', 'status'])
      .where('connection_id', '=', connectionId)
      .limit(1)
      .executeTakeFirst();
    const operationId = String((target as { id?: string; operationId?: string })['id']
      ?? (target as { operationId?: string })['operationId']
      ?? '');
    expect(operationId).toBeTruthy();
    const jobCountBefore = await ctx.database.db.selectFrom('jobs').select('id').where('job', '=', 'advancedIntegrations.retryOperation').execute();
    const retried = await call('POST', `/api/v1/AdvancedIntegrations/action/operations/${operationId}/retry`, operatorToken);
    if (retried.status < 300) {
      expect(String(retried.body['status'])).toBe('pending');
      const jobCountAfter = await ctx.database.db.selectFrom('jobs').select('id').where('job', '=', 'advancedIntegrations.retryOperation').execute();
      expect(jobCountAfter.length).toBe(jobCountBefore.length);
    } else {
      // An operation that already applied is not retryable, and the refusal says which state is.
      expect(JSON.stringify(retried.body)).toContain('cannot be retried');
    }
    const notRetryable = await call('POST', `/api/v1/AdvancedIntegrations/action/operations/${operationId}/retry`, operatorToken);
    if (notRetryable.status < 300) expect(String(notRetryable.body['status'])).toBe('pending');

    // A dead letter is an operator's object: it can be marked replayed, once, by somebody entitled to
    // decide that — and a viewer may not.
    const letters = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/dead-letters`, operatorToken);
    const open = (((letters.body['list'] ?? []) as Body[])).filter((entry) => String(entry['status']) === 'open');
    if (open.length > 0) {
      const letterId = String(open[0]?.['id'] ?? '');
      const refused = await call('POST', `/api/v1/AdvancedIntegrations/action/dead-letters/${letterId}/replay`, viewerToken);
      expect(refused.status).toBe(403);
      const replayed = await call('POST', `/api/v1/AdvancedIntegrations/action/dead-letters/${letterId}/replay`, operatorToken);
      expect(replayed.status, JSON.stringify(replayed.body)).toBeLessThan(300);
      const again = await call('POST', `/api/v1/AdvancedIntegrations/action/dead-letters/${letterId}/replay`, operatorToken);
      expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
    }
  });

  it('step 14 — a disabled connector stops the provider work, and a disabled control plane stops new connections', async () => {
    // Pausing is the operator's outage switch: the grant, the credential and the history stay, and no
    // provider call goes out — including from a run somebody started before the pause. The fetch count
    // is the proof, because it is the provider's own counter, not a rendering of the answer.
    const paused = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/pause`, operatorToken);
    expect(paused.status, JSON.stringify(paused.body)).toBeLessThan(300);
    const fetchesBefore = script.counts.fetch;
    const sync = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, { pageSize: 2 });
    expect(fetchesBefore).toBe(script.counts.fetch);
    const test = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/test`, operatorToken);
    expect(test.status, JSON.stringify(test.body)).toBeLessThan(300);
    expect(Boolean(test.body['ok'])).toBe(false);
    expect(String(test.body['code'])).toBe('CONFIGURATION_INVALID');
    // The refusal is recorded, not swallowed: the run says it failed with that reason.
    if (sync.status >= 400) {
      const runs = await asAdmin('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/runs`);
      const failedRun = ((runs.body['list'] ?? []) as Body[])[0];
      expect(String(failedRun?.['status'])).toBe('failed');
    }

    const resumed = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/resume`, operatorToken);
    expect(resumed.status, JSON.stringify(resumed.body)).toBeLessThan(300);
    const afterResume = await call('POST', `/api/v1/AdvancedIntegrations/action/mappings/${mappingId}/sync`, operatorToken, { pageSize: 100 });
    expect(afterResume.status, JSON.stringify(afterResume.body)).toBeLessThan(300);
    expect(script.counts.fetch).toBeGreaterThan(fetchesBefore);
    expect(await accountCount()).toBeLessThanOrEqual(PROVIDER_CONTACTS.length);

    // The module's own switch. Before this sub-phase `features.connections` was stored, displayed in
    // the health report, and enforced by nothing.
    const off = await asAdmin('POST', '/api/v1/AdvancedIntegrations/action/settings', { features: { connections: false, oauth: true } });
    expect(off.status, JSON.stringify(off.body)).toBeLessThan(300);
    const refused = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', operatorToken, {
      providerKey: PROVIDER_KEY,
      name: `${CONNECTION_NAME} while disabled`,
      ownerType: 'organization',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('connections');
    // Reading is still allowed: the module says what is off rather than vanishing.
    const health = await asAdmin('GET', '/api/v1/AdvancedIntegrations/action/health');
    expect(health.status).toBe(200);
    const listed = await call('GET', '/api/v1/AdvancedIntegrations/action/connections', operatorToken);
    expect(listed.status).toBe(200);

    const back = await asAdmin('POST', '/api/v1/AdvancedIntegrations/action/settings', { features: { connections: true, oauth: true } });
    expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);
    const allowed = await call('POST', '/api/v1/AdvancedIntegrations/action/connections', operatorToken, {
      providerKey: PROVIDER_KEY,
      name: `${CONNECTION_NAME} re-enabled`,
      ownerType: 'organization',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBeLessThan(300);
    created.connectionIds.push(String(allowed.body['id']));

    // And through every step of this: no token, no secret, no ciphertext on any readable surface.
    const surface = await readableSurface();
    for (const secret of [ACCESS_TOKEN, HOOK_SECRET, API_KEY, `${MARKER}-refresh-token-value`]) {
      expect(surface).not.toContain(secret);
    }
  });
});
