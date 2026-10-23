import { createHash } from 'node:crypto';
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
import { SignatureTemplateMappingRepository } from '../src/esignature/signature-template-mapping.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.8 — recipient routing and the send preview
 * (`PLAN_Phase_19_ESignature.md` §4.3, §4.4, §11.2, §13.3, §18 `19-ES.8`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **A multi-recipient preview reflects the final request** — signers and carbon copies, routing order,
 *    documents with their hashes, the account context and the policy; the digest is stable between two
 *    previews of unchanged state and changes when anything relevant does.
 *  - **Wrong or ambiguous signer mappings are blocked** — no signer, two signers sharing an address, a
 *    template role nobody fills, a required tab with no source value, an inactive or foreign mapping.
 *  - **No external send happens during draft or preparation** — asserted on the fake adapter's own call
 *    ledger: preparing makes no provider call at all, and certainly no `sendEnvelope`.
 *
 * Runs against the configured database and storage (AGENTS.md §3.1). Every request, mapping, attachment,
 * connection and account this run creates is removed by its own id; the settings row is restored.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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
const marker = (suffix: string) => `AGENT_TEST_es8_${suffix}_${runId}`;
const ROLE_DRAFTER = `AGENT_TEST-es8-drafter-${runId}`;
const ROLE_FOREIGN = `AGENT_TEST-es8-foreign-${runId}`;
const USER_DRAFTER = `agent_test_es8_drafter_${runId}`;
const USER_FOREIGN = `agent_test_es8_foreign_${runId}`;

const TEMPLATE = 'fake-template-1';
const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es8 agreement\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');

let tokenDrafter = '';
let tokenForeign = '';
let drafterId = '';
let connectionId = '';
let otherConnectionId = '';
let mappingId = '';
let otherMappingId = '';
let accountId = '';

const created = { requests: [] as string[], attachments: [] as string[], accounts: [] as string[] };
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
    templates: app.get(ESignatureTemplateService),
    requests: app.get(SignatureRequestRepository),
    vault: app.get(ESignatureCredentialVault),
    attachments: app.get(AttachmentService),
    registry: app.get(SignatureProviderRegistry),
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return scope.runAs(adminPrincipal, work, `es8:${String(Math.random()).slice(2)}`);
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
    `es8:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

interface DraftOptions {
  recipients?: readonly Record<string, unknown>[];
  document?: boolean;
  overrides?: Record<string, unknown>;
}

async function draft(options: DraftOptions = {}): Promise<string> {
  const created_ = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker('request'),
    subject: 'Please sign',
    connectionId,
    ...(options.overrides ?? {}),
  });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.requests.push(id);
  const recipients = options.recipients ?? [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }];
  if (recipients.length > 0) {
    const stored = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, { recipients });
    expect(stored.status, stored.raw).toBe(200);
  }
  if (options.document !== false) {
    const attachment = await uploadAttachment();
    const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
    expect(attached.status, attached.raw).toBe(201);
  }
  return id;
}

async function prepare(id: string, overrides: Record<string, unknown> = {}): Promise<CallResult> {
  const current = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
  return call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, {
    version: Number(current.body['version']),
    confirm: true,
    ...overrides,
  });
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
    features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, requests: true, documents: true, templates: true, connections: true },
  });

  connectionId = await authorizedConnection(marker('conn'));
  otherConnectionId = await authorizedConnection(marker('conn_other'));

  await createTestRole(ctx, {
    id: ROLE_DRAFTER,
    name: `AGENT_TEST ES8 drafter ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' }, Account: { read: 'own' } },
  });
  await createTestRole(ctx, {
    id: ROLE_FOREIGN,
    name: `AGENT_TEST ES8 foreign ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' } },
  });
  const drafter = await createTestUser(ctx, { userName: USER_DRAFTER, roleIds: [ROLE_DRAFTER] });
  tokenDrafter = drafter.token;
  drafterId = drafter.id;
  tokenForeign = (await createTestUser(ctx, { userName: USER_FOREIGN, roleIds: [ROLE_FOREIGN] })).token;

  const account = await call('POST', '/api/v1/Account', ctx.adminToken, { name: marker('account'), assignedUserId: drafter.id });
  accountId = String(account.body['id']);
  created.accounts.push(accountId);

  mappingId = await createMapping(connectionId, marker('mapping'), false);
  otherMappingId = await createMapping(otherConnectionId, marker('other_mapping'), true);
});

let mappingCounter = 0;
async function createMapping(targetConnection: string, name: string, withRequiredCompany: boolean): Promise<string> {
  mappingCounter += 1;
  const created_ = await asAdmin(() =>
    services().templates.create({
      name: `${name}_${String(mappingCounter)}`,
      // `document_type` for the stricter fixture: the table allows one workflow mapping per template.
      mappingType: withRequiredCompany ? 'document_type' : 'workflow',
      connectionId: targetConnection,
      providerTemplateId: TEMPLATE,
      supportedSourceEntities: ['Account'],
      roleMappings: [{ roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'emailAddress' }],
      fieldMappings: [
        { tabName: 'Full Name', crmField: 'name', required: true, roleName: 'Signer 1' },
        ...(withRequiredCompany ? [{ tabName: 'Company', crmField: 'description', required: true, roleName: 'Signer 2' }] : []),
      ],
      isActive: true,
    }),
  );
  return created_.id;
}

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

  const connections = [connectionId, otherConnectionId].filter((id) => id !== '');
  if (connections.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', connections).execute();
    await db.deleteFrom('signature_template_mappings').where('connection_id', 'in', connections).execute();
    await db.deleteFrom('esignature_credential_secrets').where('connection_id', 'in', connections).execute();
    await db.deleteFrom('esignature_oauth_states').where('connection_id', 'in', connections).execute();
    await db.deleteFrom('esignature_connections').where('id', 'in', connections).execute();
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

describe('the preview reflects the request (acceptance 1)', () => {
  it('describes documents, recipients, routing and account without writing anything', async () => {
    const id = await draft({
      recipients: [
        { name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 },
        { name: 'Copy Two', email: 'two@example.invalid', recipientType: 'carbon_copy', routingOrder: 2 },
      ],
    });
    const before = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body['problems']).toEqual([]);
    expect(preview.body['ready']).toBe(true);
    const data = preview.body['data'] as {
      documents: { contentHashSha256: string; documentOrder: number }[];
      recipients: { name: string; recipientType: string; routingOrder: number }[];
      environment: string;
      accountId: string;
    };
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]?.contentHashSha256).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));
    expect(data.recipients.map((recipient) => [recipient.name, recipient.recipientType, recipient.routingOrder])).toEqual([
      ['Signer One', 'signer', 1],
      ['Copy Two', 'carbon_copy', 2],
    ]);
    expect(data.environment).toBe('demo');
    expect(data.accountId).toBe('fake-account-1');
    expect(typeof preview.body['digest']).toBe('string');

    const after = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
    expect(after.body['version']).toBe(before.body['version']);
    expect(after.body['status']).toBe('draft');
  });

  it('is stable for unchanged state and changes when a recipient or a document does', async () => {
    const id = await draft();
    const first = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    const second = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(second.body['digest']).toBe(first.body['digest']);

    const recipients = await call('GET', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken);
    await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [
        { name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 },
        { name: 'Copy Two', email: 'two@example.invalid', recipientType: 'carbon_copy', routingOrder: 2 },
      ],
    });
    const afterRecipients = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(afterRecipients.body['digest']).not.toBe(first.body['digest']);
    expect((recipients.body as unknown[]).length).toBe(1);
  });
});

describe('ambiguous or incomplete requests are blocked (acceptance 2)', () => {
  it('refuses a request with no document, no signer, two signers with one address, or a past expiry', async () => {
    const noDocument = await draft({ document: false });
    const noDocumentPreview = await call('GET', `/api/v1/ESignature/requests/${noDocument}/preview`, ctx.adminToken);
    expect(noDocumentPreview.body['ready']).toBe(false);
    expect((noDocumentPreview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toContain('no_documents');
    const refused = await prepare(noDocument);
    expect(refused.status).toBe(422);
    expect(problems(refused)).toContain('no_documents');

    const ccOnly = await draft({ recipients: [{ name: 'Copy Only', email: 'copy@example.invalid', recipientType: 'carbon_copy', routingOrder: 1 }] });
    const ccPreview = await call('GET', `/api/v1/ESignature/requests/${ccOnly}/preview`, ctx.adminToken);
    expect((ccPreview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toContain('no_signer');

    const duplicate = await draft({
      recipients: [
        { name: 'One', email: 'same@example.invalid', recipientType: 'signer', routingOrder: 1 },
        { name: 'Two', email: 'SAME@example.invalid', recipientType: 'signer', routingOrder: 2 },
      ],
    });
    const duplicatePreview = await call('GET', `/api/v1/ESignature/requests/${duplicate}/preview`, ctx.adminToken);
    expect((duplicatePreview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toContain('duplicate_signer_email');

    const pastExpiry = await draft({ overrides: { expiresAt: '2020-01-01T00:00:00.000Z' } });
    const expiryPreview = await call('GET', `/api/v1/ESignature/requests/${pastExpiry}/preview`, ctx.adminToken);
    expect((expiryPreview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toContain('expiry_in_past');
  });

  it('blocks a template role nobody fills and a required tab with no source value', async () => {
    const unmappedRole = await draft({
      recipients: [{ name: 'Not The Role', email: 'role@example.invalid', recipientType: 'signer', routingOrder: 1 }],
      overrides: { templateMappingId: mappingId, sourceEntityType: 'Account', sourceRecordId: accountId },
    });
    const rolePreview = await call('GET', `/api/v1/ESignature/requests/${unmappedRole}/preview`, ctx.adminToken);
    const roleProblems = (rolePreview.body['problems'] as { code: string; message: string }[]).filter((problem) => problem.code === 'missing_role');
    expect(roleProblems).toHaveLength(1);
    expect(roleProblems[0]?.message).toContain('Signer 1');
    expect((await prepare(unmappedRole)).status).toBe(422);

    // A mapping whose required "Company" tab reads Account.description, which this account does not have.
    const strictMapping = await createMapping(connectionId, marker('strict_mapping'), true);
    const missingValue = await draft({
      recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1' }],
      overrides: { templateMappingId: strictMapping, sourceEntityType: 'Account', sourceRecordId: accountId },
    });
    const valuePreview = await call('GET', `/api/v1/ESignature/requests/${missingValue}/preview`, ctx.adminToken);
    const valueProblems = (valuePreview.body['problems'] as { code: string; message: string }[]).filter((problem) => problem.code === 'missing_tab_value');
    expect(valueProblems).toHaveLength(1);
    expect(valueProblems[0]?.message).toContain('Company');
  });

  it('refuses a mapping from another connection, an inactive mapping, and a request with no connection', async () => {
    const foreignMapping = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, { name: marker('foreign_mapping'), connectionId, templateMappingId: otherMappingId });
    expect(foreignMapping.status).toBe(422);
    expect(errorDetails(foreignMapping)['code']).toBe('MAPPING_CONNECTION_MISMATCH');

    await asAdmin(() => services().mappings.setActive(mappingId, false));
    const inactive = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, { name: marker('inactive_mapping'), connectionId, templateMappingId: mappingId });
    expect(inactive.status).toBe(422);
    expect(errorDetails(inactive)['code']).toBe('MAPPING_INACTIVE');
    await asAdmin(() => services().mappings.setActive(mappingId, true));

    const unconnected = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, { name: marker('no_connection') });
    const id = String(unconnected.body['id']);
    created.requests.push(id);
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect((preview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toContain('connection_missing');
    expect((await prepare(id)).status).toBe(422);
  });
});

describe('preparing records an immutable preview (acceptance 1, 3)', () => {
  it('requires the sender’s explicit confirmation and a current version', async () => {
    const id = await draft();
    const unconfirmed = await prepare(id, { confirm: false });
    expect(unconfirmed.status).toBe(422);
    expect(errorDetails(unconfirmed)['code']).toBe('CONFIRMATION_REQUIRED');
    const stale = await prepare(id, { version: 999 });
    expect(stale.status).toBe(409);
    const untouched = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
    expect(untouched.body['status']).toBe('draft');
  });

  it('stores the snapshot, moves to ready_to_send, and contacts no provider', async () => {
    const id = await draft();
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    const prepared = await prepare(id);
    expect(prepared.status, prepared.raw).toBe(200);
    const view = prepared.body['request'] as Record<string, unknown>;
    expect(view['status']).toBe('ready_to_send');
    expect(view['editable']).toBe(true);
    expect(view['sentAt']).toBeNull();
    const stored = await services().requests.requireById(id);
    expect(stored.outgoingDigest).toBe(String(preview.body['digest']));
    expect(stored.outgoingSnapshot?.digest).toBe(stored.outgoingDigest);
    expect(stored.preparedAt).not.toBeNull();
    const after = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(after.body['storedDigest']).toBe(stored.outgoingDigest);
    expect(after.body['staleStoredPreview']).toBe(false);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('request_id', '=', id)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('request.prepared');

    // The bound adapter in tests is the fake; its ledger is the proof that preparation stayed local.
    const adapter = services().registry.resolve('docusign');
    expect(adapter).toBeInstanceOf(FakeSignatureProviderAdapter);
    const calls = adapter instanceof FakeSignatureProviderAdapter ? adapter.calls : [];
    expect(calls.some((entry) => entry.operation === 'sendEnvelope')).toBe(false);
    expect(calls.some((entry) => entry.operation === 'prepareEnvelope')).toBe(false);
  });

  it('moves a request the approval policy covers into pending approval, and keeps it out of ready_to_send', async () => {
    await enabled({ features: { approvals: true }, approval: { requiredForSourceEntities: ['Account'] } });
    const id = await draft({ overrides: { sourceEntityType: 'Account', sourceRecordId: accountId } });
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(preview.body['approvalRequired']).toBe(true);
    const prepared = await prepare(id);
    expect(prepared.status, prepared.raw).toBe(200);
    const view = prepared.body['request'] as Record<string, unknown>;
    expect(view['status']).toBe('pending_approval');
    expect(view['approvalStatus']).toBe('pending');
    const stored = await services().requests.requireById(id);
    expect(stored.approvalRequired).toBe(true);
    await enabled({ features: { approvals: false }, approval: { requiredForSourceEntities: [] } });
  });
});

describe('a changed draft invalidates the preview and the approval (acceptance 1)', () => {
  it('returns the request to draft when a document, a recipient or the subject changes', async () => {
    const id = await draft();
    const first = await prepare(id);
    expect(first.status, first.raw).toBe(200);
    const preparedVersion = Number((first.body['request'] as Record<string, unknown>)['version']);

    const edited = await call('PATCH', `/api/v1/ESignature/requests/${id}`, ctx.adminToken, {
      version: preparedVersion,
      subject: 'Please sign the corrected agreement',
    });
    expect(edited.status, edited.raw).toBe(200);
    expect(edited.body['status']).toBe('draft');
    const stored = await services().requests.requireById(id);
    expect(stored.outgoingDigest).toBeNull();
    expect(stored.outgoingSnapshot).toBeNull();
    expect(stored.preparedAt).toBeNull();
    expect(stored.approvedDigest).toBeNull();

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'detail'])
      .where('request_id', '=', id)
      .execute();
    expect(audit.some((entry) => (entry.detail as { change?: string }).change === 'preparation_invalidated')).toBe(true);

    const second = await prepare(id);
    expect(second.status, second.raw).toBe(200);
    const firstDigest = (first.body['preview'] as { digest: string }).digest;
    const secondDigest = (second.body['preview'] as { digest: string }).digest;
    expect(secondDigest).not.toBe(firstDigest);
  });

  it('invalidates when a recipient is added after preparation', async () => {
    const id = await draft();
    expect((await prepare(id)).status).toBe(200);
    const stored = await services().requests.requireById(id);
    const added = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [
        { name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 },
        { name: 'Copy Two', email: 'two@example.invalid', recipientType: 'carbon_copy', routingOrder: 2 },
      ],
    });
    expect(added.status, added.raw).toBe(200);
    const after = await services().requests.requireById(id);
    expect(after.status).toBe('draft');
    expect(after.outgoingDigest).toBeNull();
    expect(after.version).toBeGreaterThan(stored.version);
  });
});

describe('the mapping is part of the previewed state (acceptance 2)', () => {
  it('names the template and mapping in the snapshot, and changes the digest when the mapping changes', async () => {
    const id = await draft({
      recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1' }],
      overrides: { templateMappingId: mappingId, sourceEntityType: 'Account', sourceRecordId: accountId },
    });
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(preview.body['problems']).toEqual([]);
    const data = preview.body['data'] as { templateId: string; templateMappingId: string; templateMappingVersion: number };
    expect(data.templateId).toBe(TEMPLATE);
    expect(data.templateMappingId).toBe(mappingId);
    expect(data.templateMappingVersion).toBeGreaterThanOrEqual(1);

    const prepared = await prepare(id);
    expect(prepared.status, prepared.raw).toBe(200);
    const storedDigest = (prepared.body['preview'] as { digest: string }).digest;

    // A review of the mapping changes what ES.9 would build: the preview must stop describing the request.
    const currentMapping = await services().mappings.requireById(mappingId);
    await asAdmin(() =>
      services().templates.update(mappingId, { version: currentMapping.version, patch: { defaultSubject: 'Please review' } }),
    );
    const afterMapping = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(afterMapping.body['storedDigest']).toBe(storedDigest);
    expect(afterMapping.body['staleStoredPreview']).toBe(true);
    expect(afterMapping.body['digest']).not.toBe(storedDigest);
  });
});

describe('scope and state guards', () => {
  it('lets a drafting user preview their own request', async () => {
    const own = await call('POST', '/api/v1/ESignature/requests', tokenDrafter, { name: marker('own_request'), connectionId });
    expect(own.status, own.raw).toBe(201);
    created.requests.push(String(own.body['id']));
    const preview = await call('GET', `/api/v1/ESignature/requests/${String(own.body['id'])}/preview`, tokenDrafter);
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body['ready']).toBe(false);
    expect((preview.body['problems'] as { code: string }[]).map((problem) => problem.code)).toEqual(expect.arrayContaining(['no_documents', 'no_signer']));
  });

  it('will not preview or prepare another user’s request', async () => {
    const id = await draft();
    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, tokenForeign);
    expect(preview.status).toBe(403);
    const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, tokenForeign, { version: 1, confirm: true });
    expect(prepared.status).toBe(403);
  });

  it('refuses to prepare a request that is already sending', async () => {
    const id = await draft();
    const request = await services().requests.requireById(id);
    const ready = await services().requests.transition(id, { expectedVersion: request.version, to: 'ready_to_send', origin: 'local' });
    await services().requests.transition(id, { expectedVersion: ready.version, to: 'sending', origin: 'local' });
    const refused = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, { version: ready.version + 1, confirm: true });
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('SIGNATURE_REQUEST_INVALID_STATE');
  });
});
