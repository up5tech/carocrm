import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttachmentService, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { AuthenticatedPrincipal, RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { ESignatureCredentialVault } from '../src/esignature/esignature-credential-vault.js';
import { SNAPSHOT_STORAGE_ROOT } from '../src/esignature/esignature-document.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { ESignatureWebhookService } from '../src/esignature/esignature-webhook.service.js';
import { FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureDocumentSnapshotRepository } from '../src/esignature/signature-document-snapshot.repository.js';
import { SignatureProviderEventRepository } from '../src/esignature/signature-provider-event.repository.js';
import { SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import { SignatureWebhookInboxRepository } from '../src/esignature/signature-webhook-inbox.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import { type SalesFixture, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 22.9 — the journey: a quote becomes a signed document
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.2, steps 1–10).
 *
 * One story, in order, through the public contracts: a Sales quote is the commercial record, a
 * signature request is created **against that quote**, the reviewed bytes become an immutable
 * snapshot, an approval is required and given, the provider is asked to send, the provider's events
 * move the request, the signed artifact lands beside the source — separately — and the Sales records
 * are exactly where they were.
 *
 * The step that matters most is the last one: **a signed document is not a payment**. The quote and
 * the invoice keep their `unpaid` state, because nothing in this codebase lets a signature settle
 * money. The journey proves that negative so a future reader does not have to guess.
 *
 * The provider is the in-process fake: no envelope leaves the machine, no envelope is signed, and
 * every byte is deterministic.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No database is created, reset or
 * truncated; every record is created with an `AGENT_TEST_LS29_` marker and deleted by exact id.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_LS29_${suffix}_${runId}`;
const CONNECT_SECRET = `agent-test-connect-${runId}`;
const ROLE_SIGNER = `AGENT_TEST-ls29-signer-${runId}`;
const ROLE_APPROVER = `AGENT_TEST-ls29-approver-${runId}`;
const USER_SIGNER = `agent_test_ls29_signer_${runId}`;
const USER_APPROVER = `agent_test_ls29_approver_${runId}`;
const SIGNER_EMAIL = `${USER_SIGNER}@example.com`;
const TEMPLATE = 'fake-template-1';
const PDF_BYTES = Buffer.from(`%PDF-1.4\n% AGENT_TEST ls29 journey\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`, 'utf8');

let ctx: ApiContext;
let app: NestFastifyApplication;
let scope: RequestScope;
let storage: FileStorage;
let sales: SalesFixture;
let tokenApprover = '';
let signerId = '';
let connectionId = '';
let connectionPublicId = '';
let mappingId = '';
let quoteId = '';
let invoiceId = '';
let journeyEnvelopeId = '';
/** When the journey started: every money row it could have created is newer than this. */
const journeyStartedAt = new Date();
let baselineSettings: unknown = null;
const created = { requests: [] as string[], attachments: [] as string[], quotes: [] as string[] };

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
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
    recipients: app.get(SignatureRecipientRepository),
    snapshots: app.get(SignatureDocumentSnapshotRepository),
    events: app.get(SignatureProviderEventRepository),
    inbox: app.get(SignatureWebhookInboxRepository),
    audit: app.get(SignatureAuditRepository),
    vault: app.get(ESignatureCredentialVault),
    registry: app.get(SignatureProviderRegistry),
    webhooks: app.get(ESignatureWebhookService),
    attachments: app.get(AttachmentService),
  };
}

function fake(): FakeSignatureProviderAdapter {
  const adapter = services().registry.resolve('docusign');
  if (!(adapter instanceof FakeSignatureProviderAdapter)) throw new Error('The journey expects the fake adapter.');
  return adapter;
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  expect(result.status, result.raw).toBe(200);
  services().settings.invalidate();
}

async function versionOf(id: string): Promise<number> {
  return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['version']);
}

async function statusOf(id: string): Promise<string> {
  return String((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['status'] ?? '');
}

async function uploadAttachment(): Promise<string> {
  const principal: AuthenticatedPrincipal = {
    userId: signerId,
    userName: USER_SIGNER,
    userType: 'admin',
    roles: ['sysAdmin'],
    teams: [],
  };
  const attachment = await scope.runAs(
    principal,
    () =>
      services().attachments.upload({
        filename: `${marker('agreement')}.pdf`,
        mimeType: 'application/pdf',
        body: PDF_BYTES,
        declaredSize: PDF_BYTES.byteLength,
      }),
    `ls29:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

function signedBody(body: Record<string, unknown>): { rawBody: Uint8Array; headers: Record<string, string> } {
  const signed = FakeSignatureProviderAdapter.signWebhookPayload(CONNECT_SECRET, body);
  return { rawBody: signed.rawBody, headers: signed.headers };
}

async function deliver(body: Record<string, unknown>): Promise<CallResult> {
  const signed = signedBody(body);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/integrations/esignature/${connectionPublicId}`,
    headers: { ...signed.headers, 'content-type': 'application/json' },
    payload: Buffer.from(signed.rawBody),
  });
  const raw = res.body ?? '';
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.statusCode, body: parsed, raw };
}

async function latestInboxId(): Promise<string> {
  const row = await ctx.database.db
    .selectFrom('signature_webhook_inbox')
    .select('id')
    .where('connection_id', '=', connectionId)
    .orderBy('received_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) throw new Error('No inbox row was stored.');
  return row.id;
}

/** Deliver a provider event and apply it, the way the worker does. */
async function deliverAndProcess(body: Record<string, unknown>): Promise<{
  accepted: CallResult;
  processed: Awaited<ReturnType<ESignatureWebhookService['processDelivery']>>;
}> {
  const accepted = await deliver(body);
  expect(accepted.status, accepted.raw).toBe(202);
  const processed = await services().webhooks.processDelivery(await latestInboxId());
  return { accepted, processed };
}

interface Fixture {
  readonly id: string;
  readonly envelopeId: string;
  readonly recipientId: string;
  readonly providerRecipientId: string;
}

/**
 * A signature request against the quote, through the real command path: draft, recipients, document,
 * preview, the immutable snapshot, the approval, the provider envelope and the deliberate send.
 */
async function signedRequest(name: string, options: { readonly withMapping?: boolean } = {}): Promise<Fixture> {
  const withMapping = options.withMapping !== false;
  const draft = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker(name),
    subject: 'Please sign the quote',
    connectionId,
    ...(withMapping ? { templateMappingId: mappingId } : {}),
    sourceEntityType: 'Quote',
    sourceRecordId: quoteId,
  });
  expect(draft.status, draft.raw).toBe(201);
  const id = String(draft.body['id']);
  created.requests.push(id);

  const recipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
    recipients: [
      {
        name: 'Signer One',
        email: SIGNER_EMAIL,
        recipientType: 'signer',
        routingOrder: 1,
        roleName: 'Signer 1',
      },
    ],
  });
  expect(recipients.status, recipients.raw).toBe(200);

  const attachment = await uploadAttachment();
  const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
  expect(attached.status, attached.raw).toBe(201);

  const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, {
    version: await versionOf(id),
    confirm: true,
  });
  expect(prepared.status, prepared.raw).toBe(200);

  // The policy covers a Quote, so the request waits for a person who is not the sender.
  expect(await statusOf(id)).toBe('pending_approval');
  const approved = await call('POST', `/api/v1/ESignature/requests/${id}/approve`, tokenApprover, {
    version: await versionOf(id),
    reason: 'The quote was reviewed.',
  });
  expect(approved.status, approved.raw).toBe(200);

  const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
  expect(envelope.status, envelope.raw).toBe(200);
  const envelopeId = String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);

  const sent = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
    version: await versionOf(id),
    confirm: true,
  });
  expect(sent.status, sent.raw).toBe(200);

  const view = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
  const recipient = (view.body['recipients'] as { id: string }[])[0];
  const providerRecipient = fake().envelope(envelopeId)?.recipients[0];
  return {
    id,
    envelopeId,
    recipientId: String(recipient?.id ?? ''),
    providerRecipientId: String(providerRecipient?.providerRecipientId ?? ''),
  };
}

/** The provider's event for one envelope, in the shape the fake parses. */
function providerEvent(
  envelopeId: string,
  eventType: string,
  eventId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: eventId,
    envelope_id: envelopeId,
    account_id: 'fake-account-1',
    event_type: eventType,
    occurred_at: '2026-10-28T09:00:00.000Z',
    ...extra,
  };
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
  sales = await salesFixture(ctx);
  // The fake keeps its sequence for the whole suite: an envelope id is unique within the connection.
  fake().reset();

  const row = await ctx.database.db
    .selectFrom('app_settings')
    .select('data')
    .where('name', '=', 'ESignature')
    .executeTakeFirst();
  baselineSettings = row?.data ?? null;

  await enabled({
    enabled: true,
    features: {
      ...DEFAULT_ESIGNATURE_SETTINGS.features,
      requests: true,
      connections: true,
      documents: true,
      templates: true,
      send: true,
      webhooks: true,
      artifacts: true,
      approvals: true,
    },
    signing: { defaultExpiryDays: 30, remindersEnabled: true, resendCooldownMinutes: 0, embeddedReturnHosts: ['crm.example.com'] },
    webhooks: { requireHmac: true, maxPayloadBytes: 262_144, endpointUrl: '' },
    // A quote goes to a person before it leaves the building.
    approval: { requiredForSourceEntities: ['Quote'], rules: [], preventSelfApproval: true },
  });

  const connection = await services().connections.create({
    name: marker('conn'),
    environment: 'demo',
    oauthClientId: `agent-test-key-${runId}`,
  });
  connectionId = connection.id;
  connectionPublicId = connection.publicId;
  await services().connections.recordAuthorized(connection.id, {
    accountId: 'fake-account-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    subjectUserId: 'fake-user-1',
  });
  await services().vault.store({
    connectionId,
    kind: 'oauth_access_token',
    value: 'agent-test-access-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await services().vault.store({ connectionId, kind: 'webhook_secret', value: CONNECT_SECRET });

  await createTestRole(ctx, {
    id: ROLE_SIGNER,
    name: `AGENT_TEST LS29 signer ${runId}`,
    permissions: { SignatureRequest: { read: 'all' } },
  });
  await createTestRole(ctx, {
    id: ROLE_APPROVER,
    name: `AGENT_TEST LS29 approver ${runId}`,
    permissions: { SignatureRequest: { read: 'all' }, SignatureApprove: { edit: 'yes' } },
  });
  const signer = await createTestUser(ctx, { userName: USER_SIGNER, roleIds: [ROLE_SIGNER] });
  signerId = signer.id;
  tokenApprover = (await createTestUser(ctx, { userName: USER_APPROVER, roleIds: [ROLE_APPROVER] })).token;

  // The template mapping: the fake template's "Signer 1" role and one tab filled from the quote.
  const mapping = await call('POST', '/api/v1/ESignature/templates/mappings', ctx.adminToken, {
    name: marker('mapping'),
    mappingType: 'workflow',
    connectionId,
    providerTemplateId: TEMPLATE,
    supportedSourceEntities: ['Quote'],
    roleMappings: [{ roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, source: 'manual' }],
    fieldMappings: [{ tabName: 'Full Name', crmField: 'name', required: true, roleName: 'Signer 1' }],
    isActive: true,
  });
  expect(mapping.status, mapping.raw).toBe(201);
  mappingId = String(mapping.body['id']);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const requestId of created.requests) {
    const keys = await db
      .selectFrom('signature_document_snapshots')
      .select('storage_ref')
      .where('request_id', '=', requestId)
      .execute();
    for (const entry of keys) {
      if (entry.storage_ref !== null) await storage.delete(String(entry.storage_ref)).catch(() => undefined);
    }
    await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const id of created.attachments) {
    const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', id).executeTakeFirst();
    if (row?.storage_key !== undefined && row.storage_key !== null) await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  if (created.requests.length > 0) {
    await sql`
      delete from jobs
      where job in ('esignature.processProviderWebhook', 'esignature.retrieveCompletedArtifacts')
        and (target->>'requestId' = any(${created.requests}::text[])
             or target->>'inboxId' in (select id from signature_webhook_inbox where connection_id = ${connectionId}))
    `.execute(db).catch(() => undefined);
  }
  await db.deleteFrom('signature_webhook_inbox').where('connection_id', '=', connectionId).execute();
  if (created.requests.length > 0) {
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.attachments.length > 0) await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();
  if (created.quotes.length > 0) {
    // The commercial documents this journey created: their line items first, then the documents.
    await db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'QuoteItem')
      .where(sql`attrs->>'quoteId'`, 'in', created.quotes)
      .execute()
      .catch(() => undefined);
    await db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'InvoiceItem')
      .where(sql`attrs->>'invoiceId'`, 'in', created.quotes)
      .execute()
      .catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', created.quotes).execute().catch(() => undefined);
  }
  if (connectionId !== '') {
    await db.deleteFrom('signature_provider_events').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('signature_audit_entries').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('signature_template_mappings').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_credential_secrets').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_oauth_states').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_connections').where('id', '=', connectionId).execute();
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
  await sales.cleanup();
  await db.deleteFrom('users').where('user_name', 'in', [USER_SIGNER, USER_APPROVER]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_SIGNER, ROLE_APPROVER]).execute();
  await purgeEntityEvents(ctx.database, ['Account', 'Quote', 'Invoice']);
  await shutdownApi();
}, 240_000);

describe('the journey: a quote becomes a signed document (22.9)', () => {
  it('step 1 — the commercial record is a Sales quote that nobody has paid', async () => {
    const account = await sales.create('Account', { name: marker('account') });
    const product = await sales.createProduct({ sku: `${runId}-Q1`, unitPrice: '50.00' });

    const quote = await sales.call('POST', '/api/v1/Sales/document', {
      kind: 'quote',
      data: { name: marker('quote'), accountId: account, currency: 'USD', quoteDate: '2026-10-28' },
      items: [{ productId: product, quantity: '2', unitPrice: '50.00', taxRatePercent: '0' }],
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    quoteId = String((quote.body as unknown as { id: string }).id);
    created.quotes.push(quoteId);
    expect((quote.body as unknown as { document: Record<string, unknown> }).document['status']).toBe('draft');

    const invoice = await sales.call('POST', '/api/v1/Sales/document', {
      kind: 'invoice',
      data: { name: marker('invoice'), accountId: account, currency: 'USD', invoiceDate: '2026-10-28' },
      items: [{ productId: product, quantity: '2', unitPrice: '50.00', taxRatePercent: '0' }],
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    invoiceId = String((invoice.body as unknown as { id: string }).id);
    created.quotes.push(invoiceId);
    expect((invoice.body as unknown as { document: Record<string, unknown> }).document['paymentStatus']).toBe('unpaid');
  });

  it('step 2 — the signature request is created against that quote', async () => {
    const draft = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('linked_request'),
      subject: 'Please sign the quote',
      connectionId,
      templateMappingId: mappingId,
      sourceEntityType: 'Quote',
      sourceRecordId: quoteId,
    });
    expect(draft.status, draft.raw).toBe(201);
    const id = String(draft.body['id']);
    created.requests.push(id);

    // The link to the commercial record is the pair the module stores, as a readable source view.
    const source = draft.body['source'] as { entityType?: string; recordId?: string; accessible?: boolean } | null;
    expect(source?.entityType).toBe('Quote');
    expect(source?.recordId).toBe(quoteId);
    expect(source?.accessible).toBe(true);
    expect(draft.body['status']).toBe('draft');
  });

  it('step 3 — the recipients, the document and the preview are clean before anything is sent', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const recipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [
        { name: 'Signer One', email: SIGNER_EMAIL, recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1' },
      ],
    });
    expect(recipients.status, recipients.raw).toBe(200);

    const attachment = await uploadAttachment();
    const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
    expect(attached.status, attached.raw).toBe(201);

    const preview = await call('GET', `/api/v1/ESignature/requests/${id}/preview`, ctx.adminToken);
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body['problems']).toEqual([]);
    // The approval policy covers a quote, and the policy says so before anybody is asked.
    expect(preview.body['approvalRequired']).toBe(true);
  });

  it('step 4 — the reviewed bytes become an immutable snapshot beside the source', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(prepared.status, prepared.raw).toBe(200);
    expect(await statusOf(id)).toBe('pending_approval');

    const snapshots = await services().snapshots.listForRequest(id);
    const source = snapshots.find((snapshot) => snapshot.artifactKind === 'source_snapshot');
    expect(source).toBeDefined();
    expect(source?.contentHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(source?.storageRef ?? '')).toContain(`esignature/${id}/source/`);
    // The source snapshot carries the attachment it was copied from.
    expect(source?.sourceAttachmentId).not.toBeNull();
  });

  it('step 5 — the send waits for an approval from somebody else', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const blocked = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    // A request that waits for an approval cannot be sent: the send is refused before the provider
    // is ever asked.
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked)).toBe('SIGNATURE_REQUEST_INVALID_STATE');
    expect(await statusOf(id)).toBe('pending_approval');

    // The sender may not approve their own request: the refusal is 403 with its own stable code.
    const selfApproval = await call('POST', `/api/v1/ESignature/requests/${id}/approve`, ctx.adminToken, {
      version: await versionOf(id),
    });
    expect(selfApproval.status).toBe(403);
    expect(errorCode(selfApproval)).toBe('SIGNATURE_APPROVAL_SEPARATION_REQUIRED');

    const approved = await call('POST', `/api/v1/ESignature/requests/${id}/approve`, tokenApprover, {
      version: await versionOf(id),
      reason: 'The quote was reviewed.',
    });
    expect(approved.status, approved.raw).toBe(200);
    expect(await statusOf(id)).toBe('ready_to_send');

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('request_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toContain('approval.granted');
  });

  it('step 6 — the provider is asked once, and the request is sent', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
    expect(envelope.status, envelope.raw).toBe(200);
    const envelopeId = String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
    journeyEnvelopeId = envelopeId;

    const sent = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(sent.status, sent.raw).toBe(200);
    expect(await statusOf(id)).toBe('sent');

    // One deliberate send: the provider was asked exactly once.
    const sends = fake().calls.filter((call) => call.operation === 'sendEnvelope');
    expect(sends).toHaveLength(1);
    expect(fake().envelope(envelopeId)?.state).toBe('sent');
  });

  it('step 7 — the provider events move the request, and only the valid ones do', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const envelopeId = journeyEnvelopeId;
    expect(envelopeId).not.toBe('');

    const delivered = await deliverAndProcess(
      providerEvent(envelopeId, 'envelope-delivered', `evt-${runId}-delivered`, {
        occurred_at: '2026-10-28T09:05:00.000Z',
      }),
    );
    expect(delivered.processed.status).toBe('processed');
    expect(await statusOf(id)).toBe('delivered');

    // The same event again: a safe acknowledgement, and no second effect.
    const replay = await deliver(
      providerEvent(envelopeId, 'envelope-delivered', `evt-${runId}-delivered`, {
        occurred_at: '2026-10-28T09:05:00.000Z',
      }),
    );
    expect(replay.status).toBe(202);
    expect(replay.body['status']).toBe('duplicate');
    expect(await statusOf(id)).toBe('delivered');

    // A forged delivery changes nothing at all.
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/esignature/${connectionPublicId}`,
      headers: { 'content-type': 'application/json', 'x-fake-signature': 'not-the-signature' },
      payload: Buffer.from(JSON.stringify({ event_id: `evt-${runId}-forged`, envelope_id: envelopeId })),
    });
    expect(forged.statusCode).toBe(401);
    expect(await statusOf(id)).toBe('delivered');
  });

  it('step 8 — the signature completes, and the evidence lands beside the source, not on it', async () => {
    const id = created.requests[created.requests.length - 1] ?? '';
    const envelopeId = journeyEnvelopeId;
    expect(envelopeId).not.toBe('');

    const completed = await deliverAndProcess(
      providerEvent(envelopeId, 'envelope-completed', `evt-${runId}-completed`, {
        occurred_at: '2026-10-28T09:10:00.000Z',
      }),
    );
    expect(completed.processed.status).toBe('processed');
    expect(await statusOf(id)).toBe('completed');

    const before = await services().snapshots.listForRequest(id);
    const sourceBefore = before.find((snapshot) => snapshot.artifactKind === 'source_snapshot');
    expect(sourceBefore).toBeDefined();

    const retrieved = await call('POST', `/api/v1/ESignature/requests/${id}/artifacts/retrieve`, ctx.adminToken);
    expect(retrieved.status, retrieved.raw).toBe(200);
    expect(Number(retrieved.body['created'])).toBeGreaterThan(0);

    const after = await services().snapshots.listForRequest(id);
    // This request went out as a **template** envelope: the provider holds the template's own files,
    // so what comes back is the completion evidence — a derived artifact of its own.
    const evidence = after.find((snapshot) => snapshot.artifactKind === 'completion_evidence');
    expect(evidence).toBeDefined();
    expect(evidence?.contentHashSha256).not.toBe(sourceBefore?.contentHashSha256);
    expect(String(evidence?.storageRef ?? '')).toContain(`esignature/${id}/derived/`);
    // The source snapshot is exactly what it was.
    const sourceAfter = after.find((snapshot) => snapshot.artifactKind === 'source_snapshot');
    expect(sourceAfter?.contentHashSha256).toBe(sourceBefore?.contentHashSha256);
    expect(sourceAfter?.storageRef).toBe(sourceBefore?.storageRef);
  });

  it('step 8b — a document envelope returns the signed copy, stored apart from the source', async () => {
    // The other path: the request carries the reviewed document itself, so the provider answers with
    // a signed copy of it.
    const fixture = await signedRequest('document_request', { withMapping: false });
    const completed = await deliverAndProcess(
      providerEvent(fixture.envelopeId, 'envelope-completed', `evt-${runId}-completed_document`, {
        occurred_at: '2026-10-28T09:12:00.000Z',
      }),
    );
    expect(completed.processed.status).toBe('processed');
    expect(await statusOf(fixture.id)).toBe('completed');

    const before = await services().snapshots.listForRequest(fixture.id);
    const sourceBefore = before.find((snapshot) => snapshot.artifactKind === 'source_snapshot');
    expect(sourceBefore).toBeDefined();

    const retrieved = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/artifacts/retrieve`, ctx.adminToken);
    expect(retrieved.status, retrieved.raw).toBe(200);

    const after = await services().snapshots.listForRequest(fixture.id);
    const signed = after.find((snapshot) => snapshot.artifactKind === 'provider_signed_document');
    expect(signed).toBeDefined();
    // A different artifact, with different bytes, in a different place.
    expect(signed?.contentHashSha256).not.toBe(sourceBefore?.contentHashSha256);
    expect(String(signed?.storageRef ?? '')).toContain(`esignature/${fixture.id}/derived/`);
    // The source snapshot is exactly what it was: a provider result can never overwrite the source.
    const sourceAfter = after.find((snapshot) => snapshot.artifactKind === 'source_snapshot');
    expect(sourceAfter?.contentHashSha256).toBe(sourceBefore?.contentHashSha256);
    expect(sourceAfter?.storageRef).toBe(sourceBefore?.storageRef);
  });

  it('step 9 — a declined request and a voided request are their own stories', async () => {
    const declinedFixture = await signedRequest('declined_request');
    const declined = await deliverAndProcess(
      providerEvent(declinedFixture.envelopeId, 'envelope-declined', `evt-${runId}-declined`, {
        occurred_at: '2026-10-28T09:20:00.000Z',
      }),
    );
    expect(declined.processed.status).toBe('processed');
    expect(await statusOf(declinedFixture.id)).toBe('declined');

    const voidedFixture = await signedRequest('voided_request');
    const voided = await deliverAndProcess(
      providerEvent(voidedFixture.envelopeId, 'envelope-voided', `evt-${runId}-voided`, {
        occurred_at: '2026-10-28T09:21:00.000Z',
      }),
    );
    expect(voided.processed.status).toBe('processed');
    expect(await statusOf(voidedFixture.id)).toBe('voided');

    // A terminal request has no ordinary successor: an older event cannot move it back.
    const late = await deliverAndProcess(
      providerEvent(voidedFixture.envelopeId, 'envelope-sent', `evt-${runId}-late_sent`, {
        occurred_at: '2026-10-28T09:00:00.000Z',
      }),
    );
    expect(late.processed.status).toBe('ignored');
    expect(await statusOf(voidedFixture.id)).toBe('voided');
  });

  it('step 10 — a signed document is not a payment', async () => {
    const quote = await sales.call('GET', `/api/v1/Sales/document/quote/${quoteId}`);
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const quoteDocument = (quote.body as unknown as { document: Record<string, unknown> }).document;
    // The quote was never sent, accepted or converted because a document was signed.
    expect(quoteDocument['status']).toBe('draft');

    const invoice = await sales.call('GET', `/api/v1/Sales/document/invoice/${invoiceId}`);
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect((invoice.body as unknown as { document: Record<string, unknown> }).document['paymentStatus']).toBe('unpaid');

    // And no money moved: no payment, no allocation — not one row for this journey.
    const payments = await ctx.database.db
      .selectFrom('entity_records')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('entity_type', '=', 'Payment')
      .where('created_at', '>=', journeyStartedAt)
      .executeTakeFirst();
    const allocations = await ctx.database.db
      .selectFrom('entity_records')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('entity_type', '=', 'PaymentAllocation')
      .where('created_at', '>=', journeyStartedAt)
      .executeTakeFirst();
    expect(Number(payments?.n ?? 0)).toBe(0);
    expect(Number(allocations?.n ?? 0)).toBe(0);
  });

  it('step 11 — an ambiguous send is held for reconciliation, never reported as sent', async () => {
    const fixture = await signedRequest('ambiguous_request');
    expect(await statusOf(fixture.id)).toBe('sent');

    // A second request whose send answer is lost after the provider accepted it.
    const draft = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('unknown_request'),
      subject: 'Please sign',
      connectionId,
      templateMappingId: mappingId,
      sourceEntityType: 'Quote',
      sourceRecordId: quoteId,
    });
    expect(draft.status, draft.raw).toBe(201);
    const id = String(draft.body['id']);
    created.requests.push(id);
    await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [{ name: 'Signer One', email: SIGNER_EMAIL, recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1' }],
    });
    const attachment = await uploadAttachment();
    await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
    await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    await call('POST', `/api/v1/ESignature/requests/${id}/approve`, tokenApprover, { version: await versionOf(id) });
    const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
    expect(envelope.status, envelope.raw).toBe(200);

    fake().loseNextSendResponse();
    const sent = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(sent.status).toBe(409);
    expect(errorCode(sent)).toBe('PROVIDER_OUTCOME_UNKNOWN');
    // The platform does not claim a success it cannot see.
    expect(await statusOf(id)).toBe('send_unknown');

    // Reconciliation asks the provider what happened; the provider says it is sent.
    const reconciled = await call('POST', `/api/v1/ESignature/requests/${id}/reconcile`, ctx.adminToken);
    expect(reconciled.status, reconciled.raw).toBe(200);
    expect(await statusOf(id)).toBe('sent');
  });
});
