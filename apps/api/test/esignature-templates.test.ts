import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedPrincipal, RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { ESignatureCredentialVault } from '../src/esignature/esignature-credential-vault.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { ESignatureTemplateService } from '../src/esignature/esignature-template.service.js';
import { FAKE_TEMPLATES } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureTemplateMappingRepository } from '../src/esignature/signature-template-mapping.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.7 — the template catalog and mapping API
 * (`PLAN_Phase_19_ESignature.md` §6.7, §8.2, §13.1, §18 `19-ES.7`).
 *
 * The acceptance criteria are the spine:
 *
 *  - **An administrator can refresh the catalog and configure a mapping** — through the routes the admin
 *    screen calls, against the bound fake adapter, with the account's own templates.
 *  - **Mapping validation rejects unknown or unauthorized field references** — an unknown role, an
 *    unknown tab, a field the source entity does not carry, a field whose type a tab cannot hold, an
 *    entity that is not metadata, and a required role or tab left unmapped each produce a named problem.
 *  - **Templates and ids stay with the correct account** — every read is scoped to one connection, a
 *    mapping belongs to exactly one connection, and a template the account does not have is refused.
 *
 * Runs against the configured database (AGENTS.md §3.1). Two connections, their vault rows and every
 * mapping this run creates are removed by their own ids; the settings row is restored as found.
 */

type Method = 'GET' | 'POST' | 'PATCH';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

let ctx: ApiContext;
let app: NestFastifyApplication;
let scope: RequestScope;
let adminPrincipal: AuthenticatedPrincipal;

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es7_${suffix}_${runId}`;
const ROLE_MAPPER = `AGENT_TEST-es7-mapper-${runId}`;
const ROLE_PLAIN = `AGENT_TEST-es7-plain-${runId}`;
const USER_MAPPER = `agent_test_es7_mapper_${runId}`;
const USER_PLAIN = `agent_test_es7_plain_${runId}`;

const TEMPLATE = FAKE_TEMPLATES[0]?.templateId ?? 'fake-template-1';
const OTHER_TEMPLATE = FAKE_TEMPLATES[1]?.templateId ?? 'fake-template-2';

let tokenMapper = '';
let tokenPlain = '';
let connectionA = '';
let connectionB = '';
let baselineSettings: unknown = null;

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function errorDetails(result: CallResult): Record<string, unknown> {
  return (((result.body['error'] ?? {}) as { details?: Record<string, unknown> }).details ?? {});
}

function problems(result: CallResult): string[] {
  const list = errorDetails(result)['problems'];
  return Array.isArray(list) ? (list as { code: string }[]).map((problem) => problem.code) : [];
}

async function call(method: Method, url: string, token: string | undefined, payload?: unknown): Promise<CallResult> {
  const res = await app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const raw = res.body ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, raw };
}

function services() {
  return {
    settings: app.get(ESignatureSettingsService),
    connections: app.get(SignatureConnectionRepository),
    mappings: app.get(SignatureTemplateMappingRepository),
    vault: app.get(ESignatureCredentialVault),
    templates: app.get(ESignatureTemplateService),
  };
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

/** A connected, active connection with a stored access token: the state the gate requires. */
async function authorizedConnection(name: string): Promise<string> {
  const connection = await services().connections.create({ name, environment: 'demo', oauthClientId: `agent-test-key-${runId}` });
  await services().connections.recordAuthorized(connection.id, {
    accountId: 'fake-account-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    subjectUserId: 'fake-user-1',
  });
  await services().vault.store({
    connectionId: connection.id,
    kind: 'oauth_access_token',
    value: 'agent-test-access-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return connection.id;
}

/** The valid mapping payload: the fake template's Signer 1 filled from the Account's email, one tab mapped. */
function mappingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: marker('mapping'),
    mappingType: 'workflow',
    connectionId: connectionA,
    providerTemplateId: TEMPLATE,
    supportedSourceEntities: ['Account'],
    roleMappings: [{ roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'emailAddress' }],
    fieldMappings: [{ tabName: 'Full Name', crmField: 'name', required: true }],
    ...overrides,
  };
}

/** Run a service call as the administrator, the way a route would. */
function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return scope.runAs(adminPrincipal, work, `es7:${String(Math.random()).slice(2)}`);
}

async function createMapping(overrides: Record<string, unknown> = {}): Promise<string> {
  // One workflow mapping per (connection, template) is the table's rule; this run's earlier fixture is
  // retired first so each test starts from the same shape.
  const connectionId = String(overrides['connectionId'] ?? connectionA);
  const templateId = String(overrides['providerTemplateId'] ?? TEMPLATE);
  for (const existing of await services().mappings.listForConnection(connectionId)) {
    if (existing.providerTemplateId === templateId && existing.mappingType === 'workflow') await services().mappings.softDelete(existing.id);
  }
  const created = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload(overrides));
  expect(created.status, created.raw).toBe(201);
  return String(created.body['id']);
}

const createdMappings: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  adminPrincipal = { userId: 'admin', userName: 'admin', userType: 'admin', roles: ['sysAdmin'], teams: [] };

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baselineSettings = row?.data ?? null;

  connectionA = await authorizedConnection(marker('conn_a'));
  connectionB = await authorizedConnection(marker('conn_b'));

  await createTestRole(ctx, {
    id: ROLE_MAPPER,
    name: `AGENT_TEST ES7 mapper ${runId}`,
    permissions: { SignatureTemplateMapping: { edit: 'yes' } },
  });
  await createTestRole(ctx, { id: ROLE_PLAIN, name: `AGENT_TEST ES7 plain ${runId}`, permissions: {} });
  tokenMapper = (await createTestUser(ctx, { userName: USER_MAPPER, roleIds: [ROLE_MAPPER] })).token;
  tokenPlain = (await createTestUser(ctx, { userName: USER_PLAIN, roleIds: [ROLE_PLAIN] })).token;

  await enabled({
    enabled: true,
    features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, templates: true, connections: true },
  });
});

afterAll(async () => {
  const db = ctx.database.db;
  const ids = [connectionA, connectionB].filter((id) => id !== '');
  await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', ids).execute();
  await db.deleteFrom('signature_template_mappings').where('connection_id', 'in', ids).execute();
  await db.deleteFrom('esignature_credential_secrets').where('connection_id', 'in', ids).execute();
  await db.deleteFrom('esignature_oauth_states').where('connection_id', 'in', ids).execute();
  await db.deleteFrom('esignature_connections').where('id', 'in', ids).execute();
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  } else {
    const serialized = JSON.stringify(baselineSettings);
    await db
      .insertInto('app_settings')
      .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  services().settings.invalidate();
  await db.deleteFrom('users').where('user_name', 'in', [USER_MAPPER, USER_PLAIN]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_MAPPER, ROLE_PLAIN]).execute();
  await shutdownApi();
});

describe('the catalog (acceptance 1)', () => {
  it('refreshes the account’s templates and reports that no mapping exists yet', async () => {
    const refreshed = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', ctx.adminToken, { connectionId: connectionA });
    expect(refreshed.status, refreshed.raw).toBe(200);
    expect(refreshed.body).toMatchObject({ connectionId: connectionA, environment: 'demo' });
    const templates = refreshed.body['templates'] as { templateId: string; name: string }[];
    expect(templates.map((template) => template.templateId)).toEqual(FAKE_TEMPLATES.map((template) => template.templateId));
    expect(templates[0]?.name).toBe(FAKE_TEMPLATES[0]?.name);
    expect(refreshed.body['mappings']).toEqual([]);
  });

  it('reads one template’s roles and tabs', async () => {
    const detail = await call('GET', `/api/v1/ESignature/templates/catalog/${connectionA}/${TEMPLATE}`, ctx.adminToken);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body).toMatchObject({ connectionId: connectionA, environment: 'demo', templateId: TEMPLATE });
    expect((detail.body['roles'] as { roleName: string }[]).map((role) => role.roleName)).toEqual(['Signer 1', 'Signer 2', 'CC 1']);
    expect((detail.body['fields'] as { tabLabel: string }[]).map((field) => field.tabLabel)).toEqual(['Full Name', 'Sign Here', 'Company']);
  });

  it('refuses a template the account does not have', async () => {
    const missing = await call('GET', `/api/v1/ESignature/templates/catalog/${connectionA}/not-a-template`, ctx.adminToken);
    expect(missing.status).toBe(422);
    expect(errorDetails(missing)['code']).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('configuring a mapping (acceptance 1, 2)', () => {
  it('creates a valid mapping and records the provider template name it was built from', async () => {
    const created = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({ isActive: true }));
    expect(created.status, created.raw).toBe(201);
    createdMappings.push(String(created.body['id']));
    expect(created.body).toMatchObject({
      name: marker('mapping'),
      mappingType: 'workflow',
      connectionId: connectionA,
      providerTemplateId: TEMPLATE,
      providerTemplateName: FAKE_TEMPLATES[0]?.name,
      supportedSourceEntities: ['Account'],
      isActive: true,
      version: 1,
    });
    expect((created.body['roleMappings'] as unknown[]).length).toBe(1);
    expect((created.body['fieldMappings'] as unknown[]).length).toBe(1);

    const list = await call('GET', `/api/v1/ESignature/templates/mappings?connectionId=${connectionA}`, ctx.adminToken);
    expect(list.status).toBe(200);
    expect((list.body as unknown as { id: string }[]).map((entry) => entry.id)).toContain(String(created.body['id']));

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('connection_id', '=', connectionA)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('templateMapping.changed');

    const refreshed = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', ctx.adminToken, { connectionId: connectionA });
    expect((refreshed.body['mappings'] as { presentInCatalog: boolean }[]).every((entry) => entry.presentInCatalog)).toBe(true);
  });

  it('refuses a role the template does not have', async () => {
    const refused = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      roleMappings: [{ roleName: 'Unknown Role', recipientType: 'signer', routingOrder: 1, source: 'manual' }],
    }));
    expect(refused.status).toBe(422);
    expect(problems(refused)).toContain('unknown_role');
  });

  it('refuses an empty role set outright', async () => {
    const refused = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({ roleMappings: [] }));
    expect(refused.status, refused.raw).toBe(400); // the DTO requires at least one role entry
  });

  it('refuses an unknown tab, and a required data tab left unmapped', async () => {
    const unknownTab = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      fieldMappings: [
        { tabName: 'Full Name', crmField: 'name', required: true },
        { tabName: 'Not A Tab', crmField: 'name', required: false },
      ],
    }));
    expect(unknownTab.status).toBe(422);
    expect(problems(unknownTab)).toContain('unknown_tab');

    const missingTab = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({ fieldMappings: [] }));
    expect(missingTab.status).toBe(422);
    expect(problems(missingTab)).toContain('missing_required_tab');
  });

  it('refuses a field the source entity does not carry, and a field type a tab cannot hold', async () => {
    const unknownField = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      fieldMappings: [{ tabName: 'Full Name', crmField: 'noSuchField', required: true }],
    }));
    expect(unknownField.status).toBe(422);
    expect(problems(unknownField)).toContain('unknown_field');

    const notMappable = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      fieldMappings: [{ tabName: 'Full Name', crmField: 'assignedUserId', required: true }],
    }));
    expect(notMappable.status).toBe(422);
    expect(problems(notMappable)).toContain('field_type_not_mappable');
  });

  it('refuses an entity that is not metadata, and a duplicated role', async () => {
    const badEntity = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({ supportedSourceEntities: ['NotAnEntity'] }));
    expect(badEntity.status).toBe(422);
    expect(problems(badEntity)).toContain('unknown_source_entity');

    const duplicate = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      roleMappings: [
        { roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, source: 'manual' },
        { roleName: 'Signer 1', recipientType: 'carbon_copy', routingOrder: 2, source: 'manual' },
      ],
    }));
    expect(duplicate.status).toBe(422);
    expect(problems(duplicate)).toContain('duplicate_role');
  });

  it('will not silently accept a required role that the mapping leaves out', async () => {
    const detail = await asAdmin(() => services().templates.detail(connectionA, TEMPLATE));
    const validation = services().templates.validateDefinition(
      {
        name: marker('validation'),
        connectionId: connectionA,
        providerTemplateId: TEMPLATE,
        supportedSourceEntities: ['Account'],
        roleMappings: [],
        fieldMappings: [{ tabName: 'Full Name', crmField: 'name', required: true }],
      },
      detail,
    );
    expect(validation.valid).toBe(false);
    expect(validation.problems.map((problem) => problem.code)).toContain('missing_role');
  });

  it('updates a mapping with its version, and retires it by deactivating rather than deleting', async () => {
    const id = await createMapping();
    createdMappings.push(id);
    const updated = await call('PATCH', `/api/v1/ESignature/templates/mappings/${id}`, ctx.adminToken, {
      version: 1,
      name: marker('renamed'),
      defaultSubject: 'Please sign',
    });
    expect(updated.status, updated.raw).toBe(200);
    expect(updated.body).toMatchObject({ name: marker('renamed'), defaultSubject: 'Please sign', version: 2 });

    const stale = await call('PATCH', `/api/v1/ESignature/templates/mappings/${id}`, ctx.adminToken, { version: 1, name: marker('stale') });
    expect(stale.status).toBe(409);

    const deactivated = await call('POST', `/api/v1/ESignature/templates/mappings/${id}/active`, ctx.adminToken, { active: false });
    expect(deactivated.status, deactivated.raw).toBe(200);
    expect(deactivated.body['isActive']).toBe(false);
    const stillThere = await call('GET', `/api/v1/ESignature/templates/mappings/${id}`, ctx.adminToken);
    expect(stillThere.status).toBe(200);
  });
});

describe('templates and ids stay with the account (acceptance 3)', () => {
  it('keeps one connection’s mappings out of another’s list', async () => {
    const id = await createMapping();
    createdMappings.push(id);
    const bList = await call('GET', `/api/v1/ESignature/templates/mappings?connectionId=${connectionB}`, ctx.adminToken);
    expect(bList.status).toBe(200);
    expect((bList.body as unknown as { id: string }[]).map((entry) => entry.id)).not.toContain(id);

    const crossLookup = await services().mappings.findByProviderTemplate(connectionB, TEMPLATE);
    expect(crossLookup).toBeUndefined();
    const ownLookup = await services().mappings.findByProviderTemplate(connectionA, TEMPLATE);
    expect(ownLookup?.id).toBe(id);
  });

  it('refuses a mapping whose template belongs to another account’s catalog', async () => {
    const refused = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, mappingPayload({
      providerTemplateId: 'template-from-another-account',
    }));
    expect(refused.status).toBe(422);
    expect(errorDetails(refused)['code']).toBe('TEMPLATE_NOT_FOUND');
    expect(errorDetails(refused)['connectionId']).toBe(connectionA);
  });

  it('names the connection on every mapping, and requires one when listing', async () => {
    const id = await createMapping({ connectionId: connectionB, providerTemplateId: OTHER_TEMPLATE });
    createdMappings.push(id);
    const fetched = await call('GET', `/api/v1/ESignature/templates/mappings/${id}`, ctx.adminToken);
    expect(fetched.body['connectionId']).toBe(connectionB);
    const missing = await call('GET', '/api/v1/ESignature/templates/mappings', ctx.adminToken);
    expect(missing.status).toBe(422);
  });

  it('reports a mapping whose template disappeared from the catalog instead of deleting it', async () => {
    const orphan = await services().mappings.create({
      name: marker('orphan'),
      connectionId: connectionB,
      providerTemplateId: 'template-removed-at-provider',
      supportedSourceEntities: ['Account'],
      roleMappings: [],
      fieldMappings: [],
    });
    createdMappings.push(orphan.id);
    const refreshed = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', ctx.adminToken, { connectionId: connectionB });
    const entry = (refreshed.body['mappings'] as { id: string; presentInCatalog: boolean }[]).find((mapping) => mapping.id === orphan.id);
    expect(entry).toMatchObject({ presentInCatalog: false });
    const stillThere = await call('GET', `/api/v1/ESignature/templates/mappings/${orphan.id}`, ctx.adminToken);
    expect(stillThere.status).toBe(200);
  });
});

describe('validation before send (ES.8 uses this)', () => {
  it('reports missing roles and missing required values for a concrete request', async () => {
    const id = await createMapping();
    createdMappings.push(id);
    const check = await asAdmin(() => services().templates.checkUsage(id, { providedRoles: [], values: {} }));
    expect(check.usable).toBe(false);
    expect(check.missingRoles).toEqual(['Signer 1']);
    expect(check.missingValues.map((entry) => entry.tabName)).toEqual(['Full Name']);

    const complete = await asAdmin(() =>
      services().templates.checkUsage(id, {
        providedRoles: ['Signer 1'],
        values: { name: 'Agent Test Account' },
      }),
    );
    expect(complete).toEqual({ usable: true, missingRoles: [], missingValues: [] });
  });
});

describe('who may map a template (plan §12)', () => {
  it('lets a role with the mapping right use the surface, and refuses one without it', async () => {
    const refreshed = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', tokenMapper, { connectionId: connectionA });
    expect(refreshed.status, refreshed.raw).toBe(200);
    const refused = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', tokenPlain, { connectionId: connectionA });
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('AUTHORIZATION_DENIED');
  });

  it('refuses the whole surface while the templates feature is off', async () => {
    await enabled({ features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, templates: false, connections: true } });
    const refused = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', ctx.adminToken, { connectionId: connectionA });
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('SIGNATURE_MODULE_DISABLED');
    await enabled({ features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, templates: true, connections: true } });
  });

  it('refuses the catalog while no connection is usable', async () => {
    // All connections are disabled, so the gate's own admission rule answers rather than this service.
    await services().connections.setActive(connectionA, false);
    await services().connections.setActive(connectionB, false);
    const refused = await call('POST', '/api/v1/ESignature/templates/catalog/refresh', ctx.adminToken, { connectionId: connectionA });
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('PROVIDER_NOT_CONNECTED');
    await services().connections.setActive(connectionA, true);
    await services().connections.setActive(connectionB, true);
  });
});
