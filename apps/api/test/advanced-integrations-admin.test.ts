import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import type { ConnectorAdapter } from '../src/advanced-integrations/connector-adapter.port.js';
import { ExternalLinkService } from '../src/advanced-integrations/external-link.service.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { MappingService } from '../src/advanced-integrations/mapping.service.js';
import { SyncOrchestrator } from '../src/advanced-integrations/sync-orchestrator.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-INT.14 / 19-INT.15 — the administration API
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted **by id** in `afterAll`; no table is reset or truncated and no
 * extra database is created.
 *
 * The connector is a deterministic fake: no network, no clock, no randomness and no billable API.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const runId = Date.now().toString(36);
const PROVIDER_KEY = `agent-test-admin-${runId}`;
const CONNECTION_NAME = `AGENT_TEST-admin-${runId}`;
const SECRET_VALUE = 'agent-test-admin-secret-never-returned';
const ACCOUNT_REF = 'agent-test-account';

let ctx: ApiContext;
let scope: RequestScope;
let registry: IntegrationRegistry;
let connections: ConnectionLifecycleService;
let mappings: MappingService;
let orchestrator: SyncOrchestrator;
const connectionIds: string[] = [];
const mappingIds: string[] = [];
const createdRecordIds: string[] = [];

/**
 * A connector with a deliberately mixed field list, so the mapping builder's warnings are
 * reachable: `summary` is a `text` (a lossy source for a `varchar` target) and `score` is a
 * `number` (a safe one).
 */
const adminAdapter: ConnectorAdapter = {
  providerKey: PROVIDER_KEY,
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
        webhook: false,
        syncDirections: ['inbound'],
        fullSync: true,
        incrementalSync: false,
        requiredScopes: [],
        optionalScopes: [],
        maxPageSize: 100,
        rateLimitStrategy: 'unknown',
        externalIdFields: ['id'],
        uniqueFields: ['email'],
        deletionVisibility: 'not_synchronized',
        transactional: true,
        dataSensitivity: 'personal',
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
  supportsAuthorization: false,
  supportsRefresh: false,
  supportsRevocation: false,
  getCapabilities: () => adminAdapter.capabilities,
  validateConnection: async (context) => ({
    ok: context.credential.apiKey !== null && context.credential.apiKey !== '',
    code: context.credential.apiKey === null || context.credential.apiKey === '' ? 'CONFIGURATION_INVALID' : null,
    message: null,
    accountRef: ACCOUNT_REF,
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
        { name: 'summary', label: 'Summary', type: 'text', required: false, unique: false, identifier: false, sensitive: false },
        { name: 'score', label: 'Score', type: 'number', required: false, unique: false, identifier: false, sensitive: false },
        { name: 'email', label: 'Email', type: 'string', required: false, unique: true, identifier: false, sensitive: true },
      ],
    },
  ],
  listFields: async () => [
    { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
    { name: 'summary', label: 'Summary', type: 'text', required: false, unique: false, identifier: false, sensitive: false },
    { name: 'score', label: 'Score', type: 'number', required: false, unique: false, identifier: false, sensitive: false },
    { name: 'email', label: 'Email', type: 'string', required: false, unique: true, identifier: false, sensitive: true },
  ],
  fetchPage: async () => ({
    objects: [
      {
        objectType: 'contact',
        externalId: 'admin-contact-1',
        externalParentId: null,
        fields: { id: 'admin-contact-1', summary: 'A summary', score: 42 },
        updatedAt: null,
        version: null,
        deleted: false,
      },
    ],
    nextCursor: null,
    cursorExpired: false,
  }),
  upsertObject: async () => ({ externalId: 'admin-contact-1', version: null, updatedAt: null, created: false }),
};

/**
 * Run a body under the documented service authority.
 *
 * The module's services assert a capability on every privileged action. A test that calls them
 * directly has no user session, so it runs as the platform's system identity — exactly how the
 * worker and the OAuth callback run them.
 */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(ctx.adminToken),
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

/** A connected connection with a stored credential, ready to be tested. */
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
 */
async function trackCreatedAccounts(connectionId: string): Promise<void> {
  const existing = await asSystem(() => ctx.app.get(ExternalLinkService).list(connectionId));
  for (const link of existing) {
    if (link.crmEntityId !== null && !createdRecordIds.includes(link.crmEntityId)) {
      createdRecordIds.push(link.crmEntityId);
    }
  }
}

let connectionCounter = 0;

async function makeConnection(): Promise<string> {
  const lifecycle = ctx.app.get(ConnectionLifecycleService);
  connectionCounter += 1;
  return asSystem(async () => {
    const created = await lifecycle.create({
      providerKey: PROVIDER_KEY,
      // A connection name is unique per (provider, owner), so each one gets its own.
      name: `${CONNECTION_NAME}-${String(connectionCounter)}`,
      ownerType: 'organization',
      ownerId: 'organization',
    });
    connectionIds.push(created.id);
    await lifecycle.storeCredential({
      connectionId: created.id,
      kind: 'api_key',
      value: SECRET_VALUE,
    });
    await lifecycle.transition(created.id, 'pending_authorization');
    await lifecycle.transition(created.id, 'connected', { grantedScopes: [] });
    await lifecycle.update(created.id, { enabled: true });
    return created.id;
  });
}

beforeAll(async () => {
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  preexistingAccountIds = await snapshotAccountIds();
  registry = ctx.app.get(IntegrationRegistry);
  connections = ctx.app.get(ConnectionLifecycleService);
  mappings = ctx.app.get(MappingService);
  orchestrator = ctx.app.get(SyncOrchestrator);

  registry.register({
    providerKey: PROVIDER_KEY,
    displayName: 'Agent test admin connector',
    description: 'A deterministic connector used by the administration API tests.',
    category: 'test',
    adapterVersion: adminAdapter.adapterVersion,
    providerApiVersion: adminAdapter.providerApiVersion,
    status: 'available',
    capabilities: adminAdapter.capabilities,
    requiredScopes: [],
    optionalScopes: [],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: adminAdapter,
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

describe('Advanced Integrations — the connector catalog (19-INT.14)', () => {
  it('lists a registered connector with its capabilities and connection count', async () => {
    const connectionId = await makeConnection();
    const catalog = await call('GET', '/api/v1/AdvancedIntegrations/action/catalog');
    expect(catalog.status).toBe(200);
    const list = (catalog.body['list'] ?? []) as Record<string, unknown>[];
    const provider = list.find((entry) => entry['providerKey'] === PROVIDER_KEY);
    expect(provider).toBeDefined();
    expect(provider?.['executable']).toBe(true);
    expect(provider?.['connectionCount']).toBeGreaterThanOrEqual(1);
    expect(provider?.['healthyCount']).toBeGreaterThanOrEqual(1);
    expect((provider?.['objects'] ?? []) as unknown[]).toHaveLength(1);
    expect(connectionId).toBeTruthy();
  });

  it('refuses the catalog to a caller without the capability', async () => {
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AdvancedIntegrations/action/catalog',
    });
    expect(denied.statusCode).toBe(401);
  });
});

describe('Advanced Integrations — the connection detail (19-INT.14)', () => {
  it('reports the connection, its state and what needs attention', async () => {
    const connectionId = await makeConnection();
    const detail = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/detail`);
    expect(detail.status).toBe(200);
    expect((detail.body['connection'] as Record<string, unknown>)['id']).toBe(connectionId);
    expect(detail.body['provider']).toBeDefined();
    expect(detail.body['tenant']).toBeDefined();
    expect(Array.isArray(detail.body['warnings'])).toBe(true);
    expect(Array.isArray(detail.body['mappings'])).toBe(true);
  });

  it('never exposes a secret', async () => {
    const connectionId = await makeConnection();
    const detail = await call('GET', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/detail`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(SECRET_VALUE);
  });

  it('tests the connection and records the outcome', async () => {
    const connectionId = await makeConnection();
    const tested = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/test`);
    expect(tested.status).toBe(201);
    expect(tested.body['ok']).toBe(true);
    expect(tested.body['accountRef']).toBe(ACCOUNT_REF);
    expect(tested.body['checkedAt']).toBeTruthy();
    // The result is recorded on the connection.
    const connection = await asSystem(() => connections.get(connectionId));
    expect(connection.lastValidatedAt).not.toBeNull();
    expect(connection.healthStatus).toBe('ok');
  });

  it('rotates a secret without ever returning it', async () => {
    const connectionId = await makeConnection();
    const rotated = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/rotate-secret`,
      { kind: 'api_key', value: `${SECRET_VALUE}-rotated` },
    );
    expect(rotated.status).toBe(201);
    expect(JSON.stringify(rotated.body)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(rotated.body)).not.toContain('rotated');
    // The stored row holds ciphertext.
    const row = await ctx.database.db
      .selectFrom('integration_credential_secrets')
      .select('payload_encrypted')
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    expect(row?.payload_encrypted).not.toContain(SECRET_VALUE);
  });

  it('resets the checkpoint on reconcile', async () => {
    const connectionId = await makeConnection();
    const mapping = await asSystem(() => mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Contact',
      fields: [{ sourcePath: 'summary', targetField: 'name', transform: null, required: false }],
    }));
    mappingIds.push(mapping.id);
    await asSystem(() => mappings.activate(mapping.id));
    await asSystem(() => orchestrator.writeCheckpoint(mapping.id, 'inbound', 'off:3', false));

    const reconciled = await call('POST', `/api/v1/AdvancedIntegrations/action/connections/${connectionId}/reconcile`);
    expect(reconciled.status).toBe(201);
    expect(reconciled.body['resetMappings']).toBeGreaterThanOrEqual(1);
    const checkpoint = await asSystem(() => orchestrator.readCheckpoint(mapping.id, 'inbound'));
    expect(checkpoint.cursorValue).toBeNull();
    expect(checkpoint.resetRequired).toBe(true);
  });
});

describe('Advanced Integrations — the mapping builder (19-INT.15)', () => {
  it('lists both field sets and warns about an unmapped required field and a lossy conversion', async () => {
    const connectionId = await makeConnection();
    const mapping = await asSystem(() => mappings.create({
      connectionId,
      objectType: 'contact',
      crmEntityType: 'Contact',
      fields: [
        // `text` into a `varchar` is a lossy conversion.
        { sourcePath: 'summary', targetField: 'name', transform: null, required: false },
        // A sensitive target.
        { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
      ],
    }));
    mappingIds.push(mapping.id);

    const fields = await call('GET', `/api/v1/AdvancedIntegrations/action/mappings/${mapping.id}/fields`);
    expect(fields.status).toBe(200);
    expect((fields.body['providerFields'] ?? []) as unknown[]).toHaveLength(4);
    expect(((fields.body['crmFields'] ?? []) as unknown[]).length).toBeGreaterThan(0);

    const warnings = (fields.body['warnings'] ?? []) as { code: string; message: string }[];
    const codes = warnings.map((warning) => warning.code);
    // `Contact` requires `lastName`, and nothing writes to it.
    expect(codes).toContain('REQUIRED_FIELD_UNMAPPED');
    // A `text` source into a `varchar` target loses information.
    expect(codes).toContain('LOSSY_CONVERSION');
    // `emailAddress` holds sensitive data.
    expect(codes).toContain('SENSITIVE_TARGET');
    for (const warning of warnings) {
      expect(warning.message).not.toContain(SECRET_VALUE);
    }
  });
});

describe('Advanced Integrations — sync runs and operations (19-INT.15)', () => {
  it('lists the operations of a run and retries only an eligible one', async () => {
    const connectionId = await makeConnection();
    const mapping = await asSystem(() => mappings.create({
      connectionId,
      objectType: 'contact',
      // `Account` requires only `name`, so the run writes a valid record.
      crmEntityType: 'Account',
      fields: [{ sourcePath: 'summary', targetField: 'name', transform: null, required: true }],
    }));
    mappingIds.push(mapping.id);
    await asSystem(() => mappings.activate(mapping.id));

    const run = await asSystem(() => orchestrator.runInbound(mapping.id, { triggerSource: 'manual' }));
    await trackCreatedAccounts(connectionId);
    expect(run.status).toBe('completed');

    const operations = await call('GET', `/api/v1/AdvancedIntegrations/action/runs/${run.id}/operations`);
    expect(operations.status).toBe(200);
    const list = (operations.body['list'] ?? []) as { id: string; status: string; retryable: boolean }[];
    expect(list.length).toBeGreaterThan(0);
    // An applied operation is not retryable.
    expect(list.every((operation) => operation.retryable === false)).toBe(true);

    // A failed operation becomes eligible, and retrying it leaves the run alone.
    const first = list[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await ctx.database.db
      .updateTable('integration_sync_operations')
      .set({ status: 'failed', error_code: 'PROVIDER_UNAVAILABLE' })
      .where('id', '=', first.id)
      .execute();
    const afterFailure = await call('GET', `/api/v1/AdvancedIntegrations/action/runs/${run.id}/operations`);
    const failed = ((afterFailure.body['list'] ?? []) as { id: string; retryable: boolean }[]).find(
      (operation) => operation.id === first.id,
    );
    expect(failed?.retryable).toBe(true);

    const retried = await call('POST', `/api/v1/AdvancedIntegrations/action/operations/${first.id}/retry`);
    expect(retried.status).toBe(201);
    expect(retried.body['status']).toBe('pending');
    // The run itself is untouched.
    const runAfter = await asSystem(() => orchestrator.getRun(run.id));
    expect(runAfter.status).toBe(run.status);
  });
});

describe('Advanced Integrations — the conflict workbench (19-INT.15)', () => {
  it('detects a stale conflict and refuses the provider value for it', async () => {
    const connectionId = await makeConnection();
    const mapping = await asSystem(() => mappings.create({
      connectionId,
      objectType: 'contact',
      // `Account` requires only `name`, so the run writes a valid record.
      crmEntityType: 'Account',
      conflictPolicy: 'manual',
      fields: [{ sourcePath: 'summary', targetField: 'name', transform: null, required: true }],
    }));
    mappingIds.push(mapping.id);
    await asSystem(() => mappings.activate(mapping.id));
    await asSystem(() => orchestrator.runInbound(mapping.id, { triggerSource: 'manual' }));
    await trackCreatedAccounts(connectionId);

    const links = await asSystem(() => ctx.app.get(ExternalLinkService).list(connectionId));
    const linked = links[0];
    expect(linked).toBeDefined();
    if (linked === undefined) return;

    // The provider reports a different value for the same object.
    const outcome = await asSystem(() => orchestrator.applyObject(
      mapping,
      {
        objectType: 'contact',
        externalId: linked.externalId,
        externalParentId: null,
        fields: { summary: 'A different summary' },
        updatedAt: null,
        version: 'v2',
        deleted: false,
      },
      null,
    ));
    expect(outcome.action).toBe('conflict');
    if (outcome.action !== 'conflict') return;
    const conflictId = outcome.conflictId;

    const fresh = await call('GET', `/api/v1/AdvancedIntegrations/action/conflicts/${conflictId}`);
    expect(fresh.status).toBe(200);
    expect(fresh.body['stale']).toBe(false);
    const resolutions = (fresh.body['resolutions'] ?? []) as { value: string; enabled: boolean }[];
    expect(resolutions.find((option) => option.value === 'keep_provider')?.enabled).toBe(true);

    // The CRM record moves on: the comparison is now between two old states.
    const record = await asSystem(() => ctx.app.get(EntityCrudService).get('Account', linked.crmEntityId ?? ''));
    createdRecordIds.push(String(record['id']));
    await asSystem(() =>
      ctx.app.get(EntityCrudService).update('Account', String(record['id']), { name: 'Moved on' }),
    );

    const stale = await call('GET', `/api/v1/AdvancedIntegrations/action/conflicts/${conflictId}`);
    expect(stale.body['stale']).toBe(true);
    expect(stale.body['staleSide']).toBe('local');
    const staleResolutions = (stale.body['resolutions'] ?? []) as { value: string; enabled: boolean; reason: string | null }[];
    const keepProvider = staleResolutions.find((option) => option.value === 'keep_provider');
    expect(keepProvider?.enabled).toBe(false);
    expect(keepProvider?.reason).toBeTruthy();

    // The server refuses the stale resolution too.
    const refused = await call(
      'POST',
      `/api/v1/AdvancedIntegrations/action/conflicts/${outcome.conflictId}/resolve`,
      { resolution: 'keep_provider' },
    );
    expect(refused.status).toBe(422);
  });
});
