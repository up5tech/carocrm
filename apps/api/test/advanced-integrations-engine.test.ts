import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { ConflictService } from '../src/advanced-integrations/conflict.service.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import type { ConnectorAdapter } from '../src/advanced-integrations/connector-adapter.port.js';
import { assertConnectorContract, runConnectorContract } from '../src/advanced-integrations/connector-contract.js';
import { ConnectorExecutor } from '../src/advanced-integrations/connector-executor.service.js';
import {
  createFakeProviderAdapter,
  type FakeProviderAdapter,
} from '../src/advanced-integrations/connectors/fake/fake-provider.adapter.js';
import { DeadLetterService } from '../src/advanced-integrations/dead-letter.service.js';
import { ExternalLinkService } from '../src/advanced-integrations/external-link.service.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { MappingService } from '../src/advanced-integrations/mapping.service.js';
import { OutboundSyncService } from '../src/advanced-integrations/outbound-sync.service.js';
import { categorizeHttpStatus, errorForStatus, parseRetryAfter,ProviderError } from '../src/advanced-integrations/provider-error.js';
import { assertProviderUrl, createProviderHttpClient } from '../src/advanced-integrations/provider-http-client.js';
import { RecordOriginService } from '../src/advanced-integrations/record-origin.service.js';
import {
  computeRetryDelay,
  decideRetry,
  ProviderCircuitBreaker,
  ProviderRateLimiter,
} from '../src/advanced-integrations/resilience.js';
import { SyncOrchestrator } from '../src/advanced-integrations/sync-orchestrator.service.js';
import { WebhookIngressService } from '../src/advanced-integrations/webhook-ingress.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-INT.6–19-INT.13 — the Advanced Integrations engine tests
 * (`PLAN_Phase_19_Advanced_Integrations.md` §8, §9, §10, §11; `19-INT.6`–`19-INT.13`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted by id in `afterAll`; no table is reset or truncated and no extra
 * database is created.
 *
 * The provider is the deterministic fake connector: no network, no clock, no randomness, and no
 * billable API is touched. The fake holds its dataset in memory and is reset between tests.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const runId = Date.now().toString(36);
const PROVIDER_KEY = `agent-test-engine-${runId}`;
const CONNECTION_NAME = `AGENT_TEST-engine-${runId}`;

let ctx: ApiContext;
let registry: IntegrationRegistry;
let links: ExternalLinkService;
let mappings: MappingService;
let orchestrator: SyncOrchestrator;
let conflicts: ConflictService;
let deadLetters: DeadLetterService;
let limiter: ProviderRateLimiter;
let breaker: ProviderCircuitBreaker;
let origins: RecordOriginService;
let outbound: OutboundSyncService;
let webhooks: WebhookIngressService;
let executor: ConnectorExecutor;
let scope: RequestScope;
let fake: FakeProviderAdapter;
const connectionIds: string[] = [];
const mappingIds: string[] = [];

/**
 * Run a body under the documented service authority.
 *
 * The module's services check a capability on every privileged action. A test that calls them
 * directly has no user session, so it runs as the platform's system identity — exactly how the
 * worker and the OAuth callback run them.
 */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

/** A test that runs under the service authority. */
function itSystem(name: string, fn: () => Promise<void> | void): void {
  it(name, async () => {
    await asSystem(async () => {
      await fn();
    });
  });
}

/**
 * Move a connection to a state in which the provider may be called.
 *
 * A draft connection is inert on purpose — it holds configuration and no credential, and nothing
 * may call a provider through it. A test that exercises the engine has to make it usable first.
 */
async function makeUsable(connectionId: string): Promise<void> {
  const lifecycle = ctx.app.get(ConnectionLifecycleService);
  await lifecycle.transition(connectionId, 'pending_authorization');
  await lifecycle.transition(connectionId, 'connected', { grantedScopes: [] });
  await lifecycle.update(connectionId, { enabled: true });
}

/**
 * The field mappings every contact mapping uses.
 *
 * The `Contact` entity requires both `name` and `lastName`, so a mapping that omits one of them
 * fails record validation — which is the platform working as intended.
 */
const CONTACT_FIELDS = [{ sourcePath: 'fullName', targetField: 'name', transform: null, required: true }] as const;

/**
 * The Account records that existed before this run.
 *
 * The cleanup removes the **delta** — the records this run created — rather than a tracked list.
 * A tracked list depends on every code path remembering to record its ids, and one missed path
 * leaves residue behind for the next run to trip over.
 */
let preexistingAccountIds: ReadonlySet<string> = new Set<string>();

async function snapshotAccountIds(): Promise<ReadonlySet<string>> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'Account')
    .execute();
  return new Set(rows.map((row) => row.id));
}

/**
 * Remember the CRM records this run created, so the cleanup removes exactly those.
 *
 * The records are created by the sync engine, so the ids are read back from the external links
 * the run produced.
 */
async function trackCreatedAccounts(connectionId: string): Promise<void> {
  const existing = await asSystem(() => links.list(connectionId));
  for (const link of existing) {
    if (link.crmEntityId !== null && !createdAccountIds.includes(link.crmEntityId)) {
      createdAccountIds.push(link.crmEntityId);
    }
  }
}

/**
 * How many **live** CRM records the entity holds right now.
 *
 * A soft-deleted record is not a live one: the platform keeps it, and counting it would make the
 * assertion depend on what other test files left behind.
 */
async function countAccounts(): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'Account')
    .where('deleted_at', 'is', null)
    .execute();
  return rows.length;
}

/** A connection to the webhook-capable connector. */
async function createWebhookConnection(): Promise<string> {
  const created = await ctx.app.get(ConnectionLifecycleService).create({
    providerKey: WEBHOOK_PROVIDER_KEY,
    name: `${CONNECTION_NAME}-webhook-${String(connectionCounter + 1)}`,
    ownerType: 'organization',
    ownerId: 'organization',
  });
  connectionCounter += 1;
  connectionIds.push(created.id);
  // A provider is never called through a draft connection, so the ingress test needs a usable one.
  await makeUsable(created.id);
  return created.id;
}

/** The opaque endpoint key a connection hands to its provider. */
async function webhookKeyOf(connectionId: string): Promise<string> {
  const connection = await ctx.app.get(ConnectionLifecycleService).get(connectionId);
  expect(connection.webhookKey).not.toBeNull();
  return connection.webhookKey ?? '';
}

const createdAccountIds: string[] = [];

let connectionCounter = 0;

async function createConnection(): Promise<string> {
  connectionCounter += 1;
  const created = await ctx.app
    .get(ConnectionLifecycleService)
    .create({
      providerKey: PROVIDER_KEY,
      // A connection name is unique per (provider, owner), so each one gets its own.
      name: `${CONNECTION_NAME}-${String(connectionCounter)}`,
      ownerType: 'organization',
      ownerId: 'organization',
    });
  connectionIds.push(created.id);
  return created.id;
}

/**
 * A connector that receives webhooks.
 *
 * The fake connector does not push events, so the ingress test needs one that does. It verifies a
 * fixed signature over the raw body — which is exactly what a real provider does — and normalizes
 * the callback into one event.
 */
const WEBHOOK_PROVIDER_KEY = `agent-test-webhook-${runId}`;
const WEBHOOK_SIGNATURE = 'test-signature';

const webhookAdapter: ConnectorAdapter = {
  providerKey: WEBHOOK_PROVIDER_KEY,
  adapterVersion: '1.0.0',
  providerApiVersion: '2026-01-01',
  capabilities: {
    schemaVersion: 1,
    authentication: 'api_key',
    objects: [
      {
        objectType: 'contact',
        label: 'Contact',
        read: true,
        create: false,
        update: true,
        delete: false,
        upsert: false,
        webhook: true,
        syncDirections: ['inbound'],
        fullSync: true,
        incrementalSync: false,
        requiredScopes: [],
        optionalScopes: [],
        maxPageSize: 100,
        rateLimitStrategy: 'unknown',
        externalIdFields: ['id'],
        uniqueFields: ['id'],
        deletionVisibility: 'tombstoned',
        transactional: true,
        dataSensitivity: 'business',
      },
    ],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  },
  operations: {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: false,
    implementsWebhook: true,
  },
  supportsAuthorization: false,
  supportsRefresh: false,
  supportsRevocation: false,
  getCapabilities: () => webhookAdapter.capabilities,
  validateConnection: async () => ({
    ok: true,
    code: null,
    message: null,
    accountRef: 'webhook-account',
    grantedScopes: [],
  }),
  listObjectSchemas: async () => [
    {
      objectType: 'contact',
      label: 'Contact',
      incremental: false,
      maxPageSize: 100,
      fields: [
        { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
      ],
    },
  ],
  listFields: async () => [
    { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  ],
  verifyWebhook: async (input) => {
    const signature = input.headers['x-test-signature'];
    if (signature !== WEBHOOK_SIGNATURE) {
      return { valid: false, reason: 'invalid_signature', challenge: null };
    }
    return { valid: true, reason: null, challenge: null };
  },
  normalizeWebhook: async (input) => {
    const body = input.body as { deliveryId?: string; externalId?: string; eventType?: string } | null;
    return [
      {
        deliveryId: body?.deliveryId ?? 'delivery-1',
        objectType: 'contact',
        externalId: body?.externalId ?? 'contact-1',
        eventType: body?.eventType ?? 'contact.updated',
        occurredAt: null,
        fields: { id: body?.externalId ?? 'contact-1', fullName: 'Webhook Contact' },
        deleted: false,
      },
    ];
  },
};

beforeAll(async () => {
  ctx = await bootApi();
  registry = ctx.app.get(IntegrationRegistry);
  links = ctx.app.get(ExternalLinkService);
  mappings = ctx.app.get(MappingService);
  orchestrator = ctx.app.get(SyncOrchestrator);
  conflicts = ctx.app.get(ConflictService);
  deadLetters = ctx.app.get(DeadLetterService);
  limiter = ctx.app.get(ProviderRateLimiter);
  breaker = ctx.app.get(ProviderCircuitBreaker);
  origins = ctx.app.get(RecordOriginService);
  outbound = ctx.app.get(OutboundSyncService);
  webhooks = ctx.app.get(WebhookIngressService);
  executor = ctx.app.get(ConnectorExecutor);
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  preexistingAccountIds = await snapshotAccountIds();

  fake = createFakeProviderAdapter({ providerKey: PROVIDER_KEY });
  registry.register({
    providerKey: PROVIDER_KEY,
    displayName: 'Agent test engine connector',
    description: 'A deterministic fake connector used by the Advanced Integrations engine tests.',
    category: 'test',
    adapterVersion: fake.adapterVersion,
    providerApiVersion: fake.providerApiVersion,
    status: 'available',
    capabilities: fake.getCapabilities(),
    requiredScopes: [],
    optionalScopes: [],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: fake,
  });

  registry.register({
    providerKey: WEBHOOK_PROVIDER_KEY,
    displayName: 'Agent test webhook connector',
    description: 'A connector that receives webhooks, used by the ingress test.',
    category: 'test',
    adapterVersion: webhookAdapter.adapterVersion,
    providerApiVersion: webhookAdapter.providerApiVersion,
    status: 'available',
    capabilities: webhookAdapter.capabilities,
    requiredScopes: [],
    optionalScopes: [],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: webhookAdapter,
  });
});

afterAll(async () => {
  // The cleanup is ordered children-first: every table below references the one after it, and
  // deleting a parent before its child violates a foreign key, which would abort the cleanup and
  // leave residue behind.
  if (connectionIds.length > 0) {
    await ctx.database.db.deleteFrom('integration_field_mappings').where('mapping_id', 'in', mappingIds).execute();
    await ctx.database.db.deleteFrom('integration_sync_checkpoints').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_sync_operations').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_sync_runs').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_conflicts').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_external_links').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_record_origins').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_outbound_operations').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_webhook_deliveries').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_dead_letters').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_credential_secrets').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('integration_oauth_states').where('connection_id', 'in', connectionIds).execute();
    // 19-INT.26: the module's own audit trail. The rows belong to the connections this run
    // created, so they go with them.
    await ctx.database.db.deleteFrom('integration_audit_log').where('connection_id', 'in', connectionIds).execute();
    // The mappings reference the connections, so they go after their own children.
    if (mappingIds.length > 0) {
      await ctx.database.db.deleteFrom('integration_object_mappings').where('id', 'in', mappingIds).execute();
    }
    await ctx.database.db.deleteFrom('integration_connections').where('id', 'in', connectionIds).execute();
  }
  await ctx.database.db
    .deleteFrom('integration_rate_limit_buckets')
    .where('key', 'in', [...connectionIds.map((id) => `conn:${id}`), `conn:${runId}-rate`, `conn:${runId}-circuit`])
    .execute();
  await ctx.database.db
    .deleteFrom('integration_circuit_states')
    .where('key', 'in', [...connectionIds.map((id) => `conn:${id}`), `conn:${runId}-rate`, `conn:${runId}-circuit`])
    .execute();
  // Only the records this run created are removed: the delta against the snapshot taken before
  // the tests. A broad delete would take a developer's records with it (AGENTS.md §3.3).
  const remaining = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'Account')
    .execute();
  const created = remaining.map((row) => row.id).filter((id) => !preexistingAccountIds.has(id));
  if (created.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', created).execute();
  }
  await shutdownApi();
});


describe('Advanced Integrations — the connector contract (19-INT.6)', () => {
  itSystem('the fake connector satisfies the contract', async () => {
    const failures = await runConnectorContract(fake);
    expect(failures).toEqual([]);
    expect(() => assertConnectorContract(fake)).not.toThrow();
  });

  itSystem('rejects an adapter that promises more than it implements', async () => {
    const declared = fake.getCapabilities();
    const firstObject = declared.objects[0];
    if (firstObject === undefined) throw new Error('The fake connector declares no objects.');
    const broken = {
      providerKey: 'broken',
      adapterVersion: fake.adapterVersion,
      providerApiVersion: fake.providerApiVersion,
      capabilities: {
        ...declared,
        objects: [{ ...firstObject, delete: true }],
      },
      operations: { ...fake.operations, implementsDelete: false },
      supportsAuthorization: false,
      supportsRefresh: false,
      supportsRevocation: false,
      getCapabilities: () => broken.capabilities,
      validateConnection: fake.validateConnection.bind(fake),
      listObjectSchemas: fake.listObjectSchemas.bind(fake),
      listFields: fake.listFields.bind(fake),
    };
    const failures = await runConnectorContract(broken);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((failure) => `${failure.check} ${failure.message}`).join(' ')).toContain('delete');
  });

  itSystem('classifies provider errors and never retries an authorization failure', () => {
    expect(categorizeHttpStatus(429)).toEqual({ category: 'rate_limited', retryable: true });
    expect(categorizeHttpStatus(401)).toEqual({ category: 'authorization', retryable: false });
    expect(categorizeHttpStatus(500)).toEqual({ category: 'provider_outage', retryable: true });

    const error = errorForStatus(429, 5000);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(5000);
    expect(errorForStatus(401).code).toBe('TOKEN_EXPIRED');
    expect(errorForStatus(401).retryable).toBe(false);
  });

  itSystem('parses a Retry-After header in both forms', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
  });

  itSystem('refuses a provider destination that resolves to a private address', async () => {
    await expect(
      assertProviderUrl('https://provider.test/x', {
        allowLoopback: false,
        resolve: async () => ['10.0.0.5'],
      }),
    ).rejects.toThrow(/private address/);
    await expect(
      assertProviderUrl('http://provider.test/x', { allowLoopback: false, resolve: async () => ['93.184.216.34'] }),
    ).rejects.toThrow(/must use https/);
    // A public address is accepted.
    await expect(
      assertProviderUrl('https://provider.test/x', {
        allowLoopback: false,
        resolve: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeDefined();
  });

  itSystem('does not follow a redirect and normalizes the failure', async () => {
    const client = createProviderHttpClient({
      providerKey: PROVIDER_KEY,
      connectionId: null,
      fetchImpl: (async () =>
        new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    });
    await expect(
      client.request({ method: 'GET', url: 'https://provider.test/x' }),
    ).rejects.toThrow(/redirect/);
  });

  itSystem('keeps a credential out of a log line', async () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const client = createProviderHttpClient({
      providerKey: PROVIDER_KEY,
      connectionId: null,
      log: (fields, message) => lines.push({ fields, message }),
      fetchImpl: (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    });
    await client.request({
      method: 'GET',
      url: 'https://provider.test/x',
      headers: { authorization: 'Bearer super-secret-token' },
    });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).toContain('provider.test');
  });
});

describe('Advanced Integrations — external id links (19-INT.7)', () => {
  itSystem('links idempotently and refuses a second record for one provider object', async () => {
    const connectionId = await createConnection();
    const first = await links.link(connectionId, {
      objectType: 'contact',
      externalId: 'contact-1',
      crmEntityType: 'Account',
      crmEntityId: 'record-a',
    });
    expect(first.linkStatus).toBe('linked');
    // The same provider object seen again updates the link instead of creating a second one.
    const again = await links.link(connectionId, {
      objectType: 'contact',
      externalId: 'contact-1',
      crmEntityType: 'Account',
      crmEntityId: 'record-a',
    });
    expect(again.id).toBe(first.id);
    const all = await links.list(connectionId);
    expect(all.filter((link) => link.externalId === 'contact-1')).toHaveLength(1);
  });

  itSystem('unlinks without deleting the CRM record', async () => {
    const connectionId = await createConnection();
    await links.link(connectionId, {
      objectType: 'contact',
      externalId: 'contact-9',
      crmEntityType: 'Account',
      crmEntityId: 'record-b',
    });
    const unlinked = await links.unlink(connectionId, 'contact', 'contact-9');
    expect(unlinked.linkStatus).toBe('unlinked');
    // The row survives, so the history is preserved.
    expect(await links.resolve(connectionId, 'contact', 'contact-9')).not.toBeNull();
  });
});

describe('Advanced Integrations — mappings (19-INT.8)', () => {
  itSystem('refuses a mapping for an object the provider does not offer', async () => {
    const connectionId = await createConnection();
    await expect(
      mappings.create({
        connectionId,
        objectType: 'notAnObject',
        crmEntityType: 'Account',
      }),
    ).rejects.toThrow(/does not offer the object/);
  });

  itSystem('refuses a mapping with a transformation outside the allowlist', async () => {
    const connectionId = await createConnection();
    await expect(
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Account',
        fields: [
          {
            sourcePath: 'id',
            targetField: 'name',
            transform: { type: 'eval', options: { expression: 'process.exit()' } } as never,
            required: false,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  itSystem('keeps one active mapping per object type and versions the change', async () => {
    const connectionId = await createConnection();
    const created = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [{ sourcePath: 'id', targetField: 'name', transform: null, required: false }],
    });
    mappingIds.push(created.id);
    expect(created.status).toBe('draft');
    expect(created.mappingVersion).toBe(1);

    const activated = await mappings.activate(created.id);
    expect(activated.status).toBe('active');

    const second = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [{ sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false }],
    });
    mappingIds.push(second.id);
    await mappings.activate(second.id);
    // The previous mapping was retired rather than left active alongside it.
    const active = await mappings.findActive(connectionId, 'contact');
    expect(active?.id).toBe(second.id);

    const updated = await mappings.update(created.id, {
      fields: [{ sourcePath: 'fullName', targetField: 'name', transform: null, required: false }],
    });
    expect(updated.mappingVersion).toBe(2);
  });

  itSystem('previews a mapping without writing anything', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [
        { sourcePath: 'fullName', targetField: 'name', transform: { type: 'trim' }, required: true },
        { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
      ],
    });
    mappingIds.push(mapping.id);
    const before = await countAccounts();
    const preview = await mappings.preview(mapping.id, { fullName: '  Ada Lovelace  ', email: 'ada@example.test' });
    expect(preview.dryRun).toBe(true);
    expect(preview.values['name']).toBe('Ada Lovelace');
    expect(preview.values['emailAddress']).toBe('ada@example.test');
    // Nothing was written.
    expect(await countAccounts()).toBe(before);
  });
});

describe('Advanced Integrations — the sync engine (19-INT.9)', () => {
  itSystem('creates CRM records, links them and advances the checkpoint', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [
        ...CONTACT_FIELDS,
        { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
      ],
    });
    mappingIds.push(mapping.id);
    await mappings.activate(mapping.id);
    await makeUsable(connectionId);

    const run = await orchestrator.runInbound(mapping.id, {
      triggerSource: 'manual',
      maxRecords: 3,
      pageSize: 2,
    });
    await trackCreatedAccounts(connectionId);
    expect(run.status).toBe('completed');
    expect(run.recordsApplied).toBe(3);

    const linksForConnection = await links.list(connectionId);
    expect(linksForConnection).toHaveLength(3);
    expect(linksForConnection.every((link) => link.linkStatus === 'linked')).toBe(true);

    // The checkpoint advanced past the pages that succeeded.
    const checkpoint = await orchestrator.readCheckpoint(mapping.id, 'inbound');
    expect(checkpoint.cursorValue).not.toBeNull();
    expect(checkpoint.resetRequired).toBe(false);
  });

  itSystem('is idempotent: a second run does not create a second record', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [...CONTACT_FIELDS],
    });
    mappingIds.push(mapping.id);
    await mappings.activate(mapping.id);
    await makeUsable(connectionId);

    const before = await countAccounts();
    const first = await orchestrator.runInbound(mapping.id, { triggerSource: 'manual', maxRecords: 2 });
    await trackCreatedAccounts(connectionId);
    expect(first.recordsApplied).toBe(2);
    const afterFirst = await links.list(connectionId);
    expect(afterFirst).toHaveLength(2);
    const afterFirstRun = await countAccounts();
    expect(afterFirstRun - before).toBe(2);

    // A full re-sync from the beginning sees the same provider objects again. The external link
    // is what makes it idempotent: the same provider object resolves to the same CRM record.
    await orchestrator.writeCheckpoint(mapping.id, 'inbound', null, false);
    const second = await orchestrator.runInbound(mapping.id, { triggerSource: 'manual', maxRecords: 2 });
    expect(second.status).toBe('completed');

    const afterSecond = await links.list(connectionId);
    expect(afterSecond).toHaveLength(afterFirst.length);
    // No second record was created for the same provider objects.
    expect(await countAccounts()).toBe(afterFirstRun);
  });

  itSystem('unlinks on a provider-side delete and keeps the CRM record', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      fields: [...CONTACT_FIELDS],
    });
    mappingIds.push(mapping.id);
    await mappings.activate(mapping.id);
    await makeUsable(connectionId);
    await orchestrator.runInbound(mapping.id, { triggerSource: 'manual', maxRecords: 1 });

    const before = await links.list(connectionId);
    expect(before).toHaveLength(1);
    const linkedRecord = before[0];
    expect(linkedRecord).toBeDefined();
    if (linkedRecord === undefined) return;
    const recordsBefore = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Account')
      .execute();

    // The provider reports the object as deleted.
    const outcome = await orchestrator.applyObject(
      mapping,
      {
        objectType: 'contact',
        externalId: linkedRecord.externalId,
        externalParentId: null,
        fields: {},
        updatedAt: null,
        version: null,
        deleted: true,
      },
      null,
    );
    expect(outcome.action).toBe('skipped');
    const after = await links.resolve(connectionId, 'contact', linkedRecord.externalId);
    expect(after?.linkStatus).toBe('unlinked');
    // The CRM record is untouched.
    const recordsAfter = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Account')
      .execute();
    expect(recordsAfter.length).toBe(recordsBefore.length);
  });
});

describe('Advanced Integrations — conflicts (19-INT.10)', () => {
  itSystem('opens a conflict instead of overwriting, and resolves it explicitly', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      conflictPolicy: 'manual',
      fields: [...CONTACT_FIELDS],
    });
    mappingIds.push(mapping.id);
    await mappings.activate(mapping.id);
    await makeUsable(connectionId);
    await orchestrator.runInbound(mapping.id, { triggerSource: 'manual', maxRecords: 1 });
    await trackCreatedAccounts(connectionId);
    await trackCreatedAccounts(connectionId);

    const linked = (await links.list(connectionId))[0];
    expect(linked).toBeDefined();
    if (linked === undefined) return;
    // The provider now reports a different value for the same object.
    const outcome = await orchestrator.applyObject(
      mapping,
      {
        objectType: 'contact',
        externalId: linked.externalId,
        externalParentId: null,
        fields: { fullName: 'A Different Name' },
        updatedAt: null,
        version: 'v2',
        deleted: false,
      },
      null,
    );
    expect(outcome.action).toBe('conflict');

    const open = await conflicts.listOpen(connectionId);
    expect(open).toHaveLength(1);
    expect(open[0]?.conflictType).toBe('field_conflict');
    // The CRM value was not silently overwritten. `name` is a column of `entity_records`, not an
    // attribute, so it is read from the column — and the row is the one the link names.
    const conflictedId = linked.crmEntityId;
    expect(conflictedId).not.toBeNull();
    const crmRecord = await ctx.database.db
      .selectFrom('entity_records')
      .select('name')
      .where('id', '=', conflictedId ?? '')
      .executeTakeFirst();
    expect(crmRecord?.name).not.toBe('A Different Name');

    const openConflict = open[0];
    expect(openConflict).toBeDefined();
    if (openConflict === undefined) return;
    const resolved = await conflicts.resolve(openConflict.id, 'keep_provider');
    expect(resolved.status).toBe('resolved');
    const after = await ctx.database.db
      .selectFrom('entity_records')
      .select('name')
      .where('id', '=', conflictedId ?? '')
      .executeTakeFirst();
    expect(after?.name).toBe('A Different Name');
  });
});

describe('Advanced Integrations — resilience (19-INT.11)', () => {
  itSystem('computes a bounded, jittered backoff', () => {
    const first = computeRetryDelay(1, { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5 }, () => 0);
    const second = computeRetryDelay(2, { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5 }, () => 0);
    expect(first).toBe(50);
    expect(second).toBe(100);
    // The delay is capped.
    expect(computeRetryDelay(20, { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5 }, () => 1)).toBeLessThanOrEqual(
      1000,
    );
  });

  itSystem('never retries a non-retryable error and honours the attempts limit', () => {
    const permanent = new ProviderError('INVALID_REQUEST', 'nope', {
      category: 'permanent_validation',
      retryable: false,
    });
    expect(decideRetry(1, permanent).retryable).toBe(false);
    const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'nope', {
      category: 'provider_outage',
      retryable: true,
    });
    expect(decideRetry(1, transient).retryable).toBe(true);
    expect(decideRetry(5, transient).retryable).toBe(false);
    // The provider's own guidance wins over the computed delay.
    const limited = new ProviderError('RATE_LIMITED', 'nope', {
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(decideRetry(1, limited).delayMs).toBe(60_000);
  });

  itSystem('shares a token bucket between callers', async () => {
    const key = `conn:${runId}-rate`;
    const options = { capacity: 2, refillPerSecond: 0.0001, cost: 1 };
    expect((await limiter.consume(key, options)).allowed).toBe(true);
    expect((await limiter.consume(key, options)).allowed).toBe(true);
    const third = await limiter.consume(key, options);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    await limiter.reset(key, 2);
    expect((await limiter.consume(key, options)).allowed).toBe(true);
  });

  itSystem('opens the circuit after repeated provider failures and refuses the call', async () => {
    const key = `conn:${runId}-circuit`;
    const options = { failureThreshold: 2, openDurationMs: 60_000 };
    const outage = new ProviderError('PROVIDER_UNAVAILABLE', 'down', {
      category: 'provider_outage',
      retryable: true,
    });
    await breaker.recordFailure(key, outage, options);
    await breaker.recordFailure(key, outage, options);
    const snapshot = await breaker.snapshot(key);
    expect(snapshot.state).toBe('open');
    await expect(breaker.beforeRequest(key)).rejects.toThrow(/temporarily disabled/);

    // A validation failure does not open the circuit: it is the platform's mistake, not the
    // provider's.
    await breaker.reset(key);
    await breaker.recordFailure(
      key,
      new ProviderError('INVALID_REQUEST', 'bad', { category: 'permanent_validation', retryable: false }),
      options,
    );
    expect((await breaker.snapshot(key)).state).toBe('closed');
  });

  itSystem('records a dead letter and replays it explicitly', async () => {
    const connectionId = await createConnection();
    const letter = await deadLetters.record({
      connectionId,
      providerKey: PROVIDER_KEY,
      error: new ProviderError('PROVIDER_UNAVAILABLE', 'down', {
        category: 'provider_outage',
        retryable: true,
        detail: 'http 503',
      }),
      attempts: 5,
      payload: { note: 'redacted' },
    });
    expect(letter.status).toBe('open');
    expect(letter.errorCategory).toBe('provider_outage');
    expect((await deadLetters.listOpen(connectionId)).length).toBeGreaterThan(0);

    const replayed = await deadLetters.markReplayed(letter.id);
    expect(replayed.status).toBe('replayed');
    // A letter can only be replayed once.
    await expect(deadLetters.markReplayed(letter.id)).rejects.toThrow(/not open/);
  });
});

describe('Advanced Integrations — the webhook ingress (19-INT.12)', () => {
  itSystem('rejects an unknown endpoint without recording anything', async () => {
    const result = await webhooks.ingest({
      providerKey: PROVIDER_KEY,
      webhookKey: 'not-a-real-key',
      kind: 'contact.updated',
      headers: {},
      query: {},
      rawBody: '{}',
      body: {},
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('unknown_endpoint');
    const receipts = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select('id')
      .where('provider_key', '=', PROVIDER_KEY)
      .execute();
    expect(receipts).toHaveLength(0);
  });

  itSystem('rejects a delivery whose signature does not verify', async () => {
    const connectionId = await createWebhookConnection();
    const webhookKey = await webhookKeyOf(connectionId);

    const result = await webhooks.ingest({
      providerKey: WEBHOOK_PROVIDER_KEY,
      webhookKey,
      kind: 'contact.updated',
      headers: { 'x-test-signature': 'wrong' },
      query: {},
      rawBody: '{"deliveryId":"d-1"}',
      body: { deliveryId: 'd-1' },
    });
    expect(result.status).toBe('rejected');
    const receipts = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select(['status', 'signature_valid', 'payload'])
      .where('connection_id', '=', connectionId)
      .execute();
    // The delivery is recorded as rejected, but it carries **no payload**: an unverified payload
    // is never stored.
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every((receipt) => receipt.signature_valid === false)).toBe(true);
    expect(receipts.every((receipt) => receipt.payload === null)).toBe(true);
  });

  itSystem('records a verified delivery once and deduplicates a repeat', async () => {
    const connectionId = await createWebhookConnection();
    const webhookKey = await webhookKeyOf(connectionId);

    const first = await webhooks.ingest({
      providerKey: WEBHOOK_PROVIDER_KEY,
      webhookKey,
      kind: 'contact.updated',
      headers: { 'x-test-signature': WEBHOOK_SIGNATURE },
      query: {},
      rawBody: '{"deliveryId":"d-2"}',
      body: { deliveryId: 'd-2', externalId: 'contact-1' },
    });
    expect(first.status).toBe('accepted');
    expect(first.eventCount).toBe(1);

    // The same delivery again is acknowledged and discarded, never processed twice.
    const second = await webhooks.ingest({
      providerKey: WEBHOOK_PROVIDER_KEY,
      webhookKey,
      kind: 'contact.updated',
      headers: { 'x-test-signature': WEBHOOK_SIGNATURE },
      query: {},
      rawBody: '{"deliveryId":"d-2"}',
      body: { deliveryId: 'd-2', externalId: 'contact-1' },
    });
    expect(second.status).toBe('duplicate');

    const receipts = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select('delivery_id')
      .where('connection_id', '=', connectionId)
      .execute();
    expect(receipts.filter((receipt) => receipt.delivery_id === 'd-2')).toHaveLength(1);
  });
});

describe('Advanced Integrations — outbound sync and echo prevention (19-INT.13)', () => {
  itSystem('skips a record whose last change came from a sync', async () => {
    const connectionId = await createConnection();
    await origins.record({
      entityType: 'Account',
      entityId: 'record-echo',
      connectionId,
      origin: 'inbound_sync',
      originRef: 'run-1',
    });
    expect(await origins.isEcho('Account', 'record-echo', connectionId)).toBe(true);

    await origins.record({
      entityType: 'Account',
      entityId: 'record-user',
      connectionId,
      origin: 'user',
      originRef: null,
    });
    expect(await origins.isEcho('Account', 'record-user', connectionId)).toBe(false);
  });

  itSystem('queues an outbound operation for a genuine change and skips the echo', async () => {
    const connectionId = await createConnection();
    const mapping = await mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Account',
      direction: 'outbound',
      fields: [
        { sourcePath: 'name', targetField: 'fullName', transform: null, required: false, direction: 'outbound' },
      ],
    });
    mappingIds.push(mapping.id);
    await mappings.activate(mapping.id);
    await makeUsable(connectionId);

    // The outbound path builds its payload from the CRM record, so the record must exist.
    const userRecord = await ctx.app
      .get(EntityCrudService)
      .create('Account', { name: `AGENT_TEST-outbound-user-${runId}` });
    const echoRecord = await ctx.app
      .get(EntityCrudService)
      .create('Account', { name: `AGENT_TEST-outbound-echo-${runId}` });
    const userId = String(userRecord['id']);
    const echoId = String(echoRecord['id']);
    createdAccountIds.push(userId, echoId);

    // A record whose last change was a user edit is queued.
    await origins.record({
      entityType: 'Account',
      entityId: userId,
      connectionId,
      origin: 'user',
    });
    const userResult = await outbound.handleEvent({
      eventId: 'event-user',
      eventType: 'entity.updated',
      entityType: 'Account',
      entityId: userId,
    });
    expect(userResult.queued).toBe(1);
    expect(userResult.echoes).toBe(0);

    // The same event delivered again queues nothing new: the idempotency key is derived from
    // the event id.
    const again = await outbound.handleEvent({
      eventId: 'event-user',
      eventType: 'entity.updated',
      entityType: 'Account',
      entityId: userId,
    });
    expect(again.queued).toBe(0);

    // A record whose last change came from a sync is an echo and is skipped.
    await origins.record({
      entityType: 'Account',
      entityId: echoId,
      connectionId,
      origin: 'inbound_sync',
    });
    const echoResult = await outbound.handleEvent({
      eventId: 'event-echo',
      eventType: 'entity.updated',
      entityType: 'Account',
      entityId: echoId,
    });
    expect(echoResult.queued).toBe(0);
    expect(echoResult.echoes).toBe(1);

    const operations = await outbound.listOperations(connectionId);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.status).toBe('queued');
    expect(operations[0]?.idempotencyKey).toBeTruthy();
  });
});

describe('Advanced Integrations — the executor', () => {
  itSystem('refuses to call the provider through a connection that is not usable', async () => {
    const connectionId = await createConnection();
    await expect(
      executor.call(connectionId, async () => 'never'),
    ).rejects.toThrow(/may not call the provider/);
  });
});
