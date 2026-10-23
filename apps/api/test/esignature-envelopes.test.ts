import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttachmentService, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { AuthenticatedPrincipal, RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { ESignatureCredentialVault } from '../src/esignature/esignature-credential-vault.js';
import { SNAPSHOT_STORAGE_ROOT } from '../src/esignature/esignature-document.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { ESignatureTemplateService } from '../src/esignature/esignature-template.service.js';
import { FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.9 — provider envelope preparation
 * (`PLAN_Phase_19_ESignature.md` §4.3, §6.2, §13.3, §18 `19-ES.9`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **The provider accepts a draft for the synthetic document** — against the bound fake adapter, whose
 *    ledger proves the call was `prepareEnvelope` and nothing else.
 *  - **Retrying preparation cannot create uncontrolled duplicates** — a second call returns the envelope
 *    already recorded with no second provider call, the whole command is serialised per request, and the
 *    idempotency key is the reviewed snapshot's.
 *  - **Provider state maps to local draft/prepared state accurately** — the request stays `ready_to_send`
 *    with the provider's draft id and `draft` status; it is never marked sent. Abandoning the draft
 *    returns it to exactly the state it had before.
 *
 * Runs against the configured database and storage (AGENTS.md §3.1); every row this run creates is
 * removed by its own id and the settings row is restored.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

let ctx: ApiContext;
let app: NestFastifyApplication;
let scope: RequestScope;
let storage: FileStorage;
let adminPrincipal: AuthenticatedPrincipal;

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es9_${suffix}_${runId}`;
const ROLE_DRAFTER = `AGENT_TEST-es9-drafter-${runId}`;
const ROLE_FOREIGN = `AGENT_TEST-es9-foreign-${runId}`;
const USER_DRAFTER = `agent_test_es9_drafter_${runId}`;
const USER_FOREIGN = `agent_test_es9_foreign_${runId}`;

const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es9 envelope\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');

let tokenDrafter = '';
let tokenForeign = '';
let drafterId = '';
let connectionId = '';
let accountId = '';
const created = { requests: [] as string[], attachments: [] as string[], accounts: [] as string[] };
let baselineSettings: unknown = null;

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function errorDetails(result: CallResult): Record<string, unknown> {
  return (((result.body['error'] ?? {}) as { details?: Record<string, unknown> }).details ?? {});
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
    requests: app.get(SignatureRequestRepository),
    vault: app.get(ESignatureCredentialVault),
    attachments: app.get(AttachmentService),
    registry: app.get(SignatureProviderRegistry),
    templates: app.get(ESignatureTemplateService),
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return scope.runAs(adminPrincipal, work, `es9:${String(Math.random()).slice(2)}`);
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

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

async function uploadAttachment(): Promise<string> {
  const principal: AuthenticatedPrincipal = { userId: drafterId, userName: USER_DRAFTER, userType: 'regular', roles: [ROLE_DRAFTER], teams: [] };
  const attachment = await scope.runAs(
    principal,
    () => services().attachments.upload({ filename: `${marker('agreement')}.pdf`, mimeType: 'application/pdf', body: PDF_BYTES, declaredSize: PDF_BYTES.byteLength }),
    `es9:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

async function draft(overrides: Record<string, unknown> = {}): Promise<string> {
  const created_ = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker('request'),
    subject: 'Please sign',
    connectionId,
    ...overrides,
  });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.requests.push(id);
  const stored = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
    recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }],
  });
  expect(stored.status, stored.raw).toBe(200);
  const attachment = await uploadAttachment();
  const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
  expect(attached.status, attached.raw).toBe(201);
  return id;
}

/** Run the ES.8 preparation so the request is `ready_to_send` with a snapshot. */
async function preparePreview(id: string): Promise<CallResult> {
  const current = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
  const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, { version: Number(current.body['version']), confirm: true });
  expect(prepared.status, prepared.raw).toBe(200);
  return prepared;
}

async function createEnvelope(id: string, overrides: Record<string, unknown> = {}): Promise<CallResult> {
  const current = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
  return call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: Number(current.body['version']), ...overrides });
}

function fakeAdapter(): FakeSignatureProviderAdapter {
  const adapter = services().registry.resolve('docusign');
  if (!(adapter instanceof FakeSignatureProviderAdapter)) throw new Error('The test suite expects the fake adapter to be bound.');
  return adapter;
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
  adminPrincipal = { userId: 'admin', userName: 'admin', userType: 'admin', roles: ['sysAdmin'], teams: [] };

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baselineSettings = row?.data ?? null;

  await enabled({
    enabled: true,
    features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, requests: true, documents: true, send: true, connections: true, templates: true },
  });

  connectionId = await authorizedConnection(marker('conn'));
  await createTestRole(ctx, {
    id: ROLE_DRAFTER,
    name: `AGENT_TEST ES9 drafter ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' }, Account: { read: 'own' } },
  });
  await createTestRole(ctx, { id: ROLE_FOREIGN, name: `AGENT_TEST ES9 foreign ${runId}`, permissions: { SignatureRequest: { create: 'yes', read: 'own' } } });
  const drafter = await createTestUser(ctx, { userName: USER_DRAFTER, roleIds: [ROLE_DRAFTER] });
  tokenDrafter = drafter.token;
  drafterId = drafter.id;
  tokenForeign = (await createTestUser(ctx, { userName: USER_FOREIGN, roleIds: [ROLE_FOREIGN] })).token;

  const account = await call('POST', '/api/v1/Account', ctx.adminToken, { name: marker('account'), assignedUserId: drafter.id });
  accountId = String(account.body['id']);
  created.accounts.push(accountId);
});

afterAll(async () => {
  const db = ctx.database.db;
  const requests = created.requests;
  for (const requestId of requests) {
    const keys = await db.selectFrom('signature_document_snapshots').select('storage_ref').where('request_id', '=', requestId).execute();
    for (const entry of keys) if (entry.storage_ref !== null) await storage.delete(String(entry.storage_ref)).catch(() => undefined);
    await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const id of created.attachments) {
    const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', id).executeTakeFirst();
    if (row?.storage_key !== undefined && row.storage_key !== null) await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  if (requests.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', requests).execute();
  }
  if (created.attachments.length > 0) await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();

  if (connectionId !== '') {
    await db.deleteFrom('signature_audit_entries').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('signature_template_mappings').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_credential_secrets').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_oauth_states').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_connections').where('id', '=', connectionId).execute();
  }
  if (created.accounts.length > 0) {
    await db.deleteFrom('stream_followers').where('entity_id', 'in', created.accounts).execute();
    await db.deleteFrom('stream_items').where('entity_type', '=', 'Account').where('entity_id', 'in', created.accounts).execute();
    await db.deleteFrom('audit_log').where('entity_type', '=', 'Account').where('record_id', 'in', created.accounts).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('id', 'in', created.accounts).execute();
    await purgeEntityEvents(ctx.database, ['Account']);
  }
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
  await db.deleteFrom('users').where('user_name', 'in', [USER_DRAFTER, USER_FOREIGN]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_DRAFTER, ROLE_FOREIGN]).execute();
  await shutdownApi();
});

describe('creating the provider draft (acceptance 1, 3)', () => {
  it('refuses before the request has a prepared preview', async () => {
    const id = await draft();
    const refused = await createEnvelope(id);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('SIGNATURE_REQUEST_INVALID_STATE');
    expect(fakeAdapter().calls.some((entry) => entry.operation === 'prepareEnvelope')).toBe(false);
  });

  it('creates a draft envelope, records its id, and leaves the request ready to send', async () => {
    const id = await draft();
    const preview = await preparePreview(id);
    const digest = (preview.body['preview'] as { digest: string }).digest;
    const envelope = await createEnvelope(id);
    expect(envelope.status, envelope.raw).toBe(200);
    expect(envelope.body['envelope']).toMatchObject({ status: 'draft', created: true });
    const envelopeId = String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
    expect(envelopeId).toMatch(/^fake-env-/);

    const view = envelope.body['request'] as Record<string, unknown>;
    // `status: 'created'` at the provider is a draft: the local request has not been sent.
    expect(view['status']).toBe('ready_to_send');
    expect(view['providerEnvelopeId']).toBe(envelopeId);
    expect(view['providerStatusRaw']).toBe('draft');
    expect(view['sentAt']).toBeNull();

    const stored = await services().requests.requireById(id);
    expect(stored.providerEnvelopeId).toBe(envelopeId);
    expect(stored.outgoingDigest).toBe(digest);

    const calls = fakeAdapter().calls.filter((entry) => entry.operation === 'prepareEnvelope');
    expect(calls).toHaveLength(1);
    expect(fakeAdapter().calls.some((entry) => entry.operation === 'sendEnvelope')).toBe(false);
    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'detail'])
      .where('request_id', '=', id)
      .execute();
    expect(audit.some((entry) => entry.action === 'request.prepared' && (entry.detail as { envelopeCreated?: boolean }).envelopeCreated === true)).toBe(true);
  });

  it('returns the same envelope on a retry without calling the provider again', async () => {
    const id = await draft();
    await preparePreview(id);
    const first = await createEnvelope(id);
    const firstId = String((first.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
    const before = fakeAdapter().calls.filter((entry) => entry.operation === 'prepareEnvelope').length;

    const retry = await createEnvelope(id);
    expect(retry.status, retry.raw).toBe(200);
    expect(retry.body['envelope']).toMatchObject({ providerEnvelopeId: firstId, created: false });
    expect(fakeAdapter().calls.filter((entry) => entry.operation === 'prepareEnvelope')).toHaveLength(before);
    expect(fakeAdapter().envelopesFor(id)).toHaveLength(1);
  });

  it('refuses a stale stored preview rather than creating an envelope from it', async () => {
    const id = await draft();
    await preparePreview(id);
    await ctx.database.db
      .updateTable('signature_requests')
      .set({ outgoing_digest: 'f'.repeat(64) })
      .where('id', '=', id)
      .execute();
    const refused = await createEnvelope(id);
    expect(refused.status).toBe(422);
    expect(errorDetails(refused)['code']).toBe('PREVIEW_OUTDATED');
    expect(fakeAdapter().envelopesFor(id)).toHaveLength(0);
  });
});

describe('abandoning the provider draft (acceptance 3)', () => {
  it('deletes the provider draft, forgets it, and allows a new preparation', async () => {
    const id = await draft();
    await preparePreview(id);
    const first = await createEnvelope(id);
    const firstId = String((first.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);

    const abandoned = await call('POST', `/api/v1/ESignature/requests/${id}/envelope/abandon`, ctx.adminToken);
    expect(abandoned.status, abandoned.raw).toBe(200);
    expect(abandoned.body['deleted']).toBe(true);
    const view = abandoned.body['request'] as Record<string, unknown>;
    expect(view['providerEnvelopeId']).toBeNull();
    expect(view['providerStatusRaw']).toBeNull();
    expect(view['status']).toBe('ready_to_send');
    expect(fakeAdapter().envelopesFor(id)).toHaveLength(0);
    expect(fakeAdapter().calls.some((entry) => entry.operation === 'abandonDraftEnvelope')).toBe(true);

    const again = await createEnvelope(id);
    expect(again.status, again.raw).toBe(200);
    expect(again.body['envelope']).toMatchObject({ created: true });
    expect(String((again.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId)).not.toBe(firstId);
  });

  it('refuses to abandon when the request holds no provider draft', async () => {
    const id = await draft();
    await preparePreview(id);
    const refused = await call('POST', `/api/v1/ESignature/requests/${id}/envelope/abandon`, ctx.adminToken);
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('VALIDATION_FAILED');
  });
});

describe('the envelope is built from the reviewed snapshot (acceptance 1)', () => {
  it('passes the template, the roles and the mapped tab values through to the adapter', async () => {
    const mapping = await asAdmin(() =>
      services().templates.create({
        name: marker('mapping'),
        connectionId,
        providerTemplateId: 'fake-template-1',
        supportedSourceEntities: ['Account'],
        roleMappings: [{ roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'emailAddress' }],
        fieldMappings: [{ tabName: 'Full Name', crmField: 'name', required: true, roleName: 'Signer 1' }],
        isActive: true,
      }),
    );

    const created_ = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('template_request'),
      connectionId,
      templateMappingId: mapping.id,
      sourceEntityType: 'Account',
      sourceRecordId: accountId,
    });
    expect(created_.status, created_.raw).toBe(201);
    const id = String(created_.body['id']);
    created.requests.push(id);
    expect((await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1' }],
    })).status).toBe(200);

    await preparePreview(id);
    const envelope = await createEnvelope(id);
    expect(envelope.status, envelope.raw).toBe(200);

    const call_ = fakeAdapter().calls.filter((entry) => entry.operation === 'prepareEnvelope').at(-1);
    expect(call_?.detail).toMatchObject({ signatureRequestId: id, templateId: 'fake-template-1', recipients: 1, mappedTabs: 1 });
    // A template envelope carries no local documents: the template supplies them.
    expect(Number(call_?.detail['documents'])).toBe(0);
  });
});

describe('scope', () => {
  it('lets a drafting user prepare their own request end to end', async () => {
    const own = await call('POST', '/api/v1/ESignature/requests', tokenDrafter, { name: marker('own_request'), connectionId });
    expect(own.status, own.raw).toBe(201);
    const id = String(own.body['id']);
    created.requests.push(id);
    expect((await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenDrafter, {
      recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }],
    })).status).toBe(200);

    const principal: AuthenticatedPrincipal = { userId: drafterId, userName: USER_DRAFTER, userType: 'regular', roles: [ROLE_DRAFTER], teams: [] };
    const attachment = await scope.runAs(
      principal,
      () => services().attachments.upload({ filename: `${marker('own_doc')}.pdf`, mimeType: 'application/pdf', body: PDF_BYTES, declaredSize: PDF_BYTES.byteLength }),
      `es9:upload:${String(Math.random()).slice(2)}`,
    );
    created.attachments.push(attachment.id);
    expect((await call('POST', `/api/v1/ESignature/requests/${id}/documents`, tokenDrafter, { attachmentId: attachment.id })).status).toBe(201);

    const current = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenDrafter);
    const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, tokenDrafter, {
      version: Number(current.body['version']),
      confirm: true,
    });
    expect(prepared.status, prepared.raw).toBe(200);
    const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, tokenDrafter, {
      version: Number((prepared.body['request'] as Record<string, unknown>)['version']),
    });
    expect(envelope.status, envelope.raw).toBe(200);
    expect((envelope.body['request'] as Record<string, unknown>)['status']).toBe('ready_to_send');
  });

  it('will not create or abandon an envelope for another user’s request', async () => {
    const id = await draft();
    await preparePreview(id);
    const foreignCreate = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, tokenForeign, { version: 1 });
    expect(foreignCreate.status).toBe(403);
    const foreignAbandon = await call('POST', `/api/v1/ESignature/requests/${id}/envelope/abandon`, tokenForeign);
    expect(foreignAbandon.status).toBe(403);
  });
});
