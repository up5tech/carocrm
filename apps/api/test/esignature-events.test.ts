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
import { ESignatureRecordEntryService } from '../src/esignature/esignature-record-entry.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { ESignatureWebhookService } from '../src/esignature/esignature-webhook.service.js';
import { FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.18 — lifecycle events and CRM record entry points
 * (`PLAN_Phase_19_ESignature.md` §2.3, §15, §18 `19-ES.18`).
 *
 * What this suite pins down:
 *
 *  - every lifecycle fact is written to the platform outbox, with a schema version and a **semantic
 *    dedupe key**; replaying the same fact twice produces one consumer action;
 *  - the payload carries the request/provider/source references and no document bytes, token, signing
 *    URL or recipient email;
 *  - completing a signature request changes **nothing** in the linked opportunity (a downstream module
 *    decides its own business state, and this phase deliberately adds no Sales consumer because Sales
 *    exposes no documented acceptance service);
 *  - the record entry point answers a generic record page through one capability-checked endpoint, and
 *    disappears cleanly for a disabled module, an unsupported entity, a forbidden caller or a restricted
 *    record.
 *
 * Runs against the configured database and storage (AGENTS.md §3.1); fixtures and their outbox rows are
 * removed by their own ids and the settings row is restored.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

interface OutboxRow {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly status: string;
}

let ctx: ApiContext;
let app: NestFastifyApplication;
let scope: RequestScope;
let storage: FileStorage;
let adminPrincipal: AuthenticatedPrincipal;

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es18_${suffix}_${runId}`;
const ROLE_NO_ACCOUNT = `AGENT_TEST-es18-no-account-${runId}`;
const USER_NO_ESIG = `agent_test_es18_no_esignature_${runId}`;
const USER_NO_ACCOUNT = `agent_test_es18_no_account_${runId}`;
const CONNECT_SECRET = `agent-test-connect-${runId}`;
const PDF_BYTES = Buffer.from(`%PDF-1.4\n% AGENT_TEST es18 events\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`, 'utf8');

let tokenNoEsig = '';
let tokenNoAccount = '';
let connectionId = '';
let connectionPublicId = '';
const created = { requests: [] as string[], attachments: [] as string[], records: [] as string[] };
let baselineSettings: unknown = null;

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
    vault: app.get(ESignatureCredentialVault),
    attachments: app.get(AttachmentService),
    registry: app.get(SignatureProviderRegistry),
    webhooks: app.get(ESignatureWebhookService),
    entry: app.get(ESignatureRecordEntryService),
  };
}

function fake(): FakeSignatureProviderAdapter {
  const adapter = services().registry.resolve('docusign');
  if (!(adapter instanceof FakeSignatureProviderAdapter)) throw new Error('The suite expects the fake adapter.');
  return adapter;
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

async function createOpportunity(stage = 'Proposal'): Promise<string> {
  const response = await call('POST', '/api/v1/Opportunity', ctx.adminToken, {
    name: marker('opportunity'),
    stage,
    amount: '25000',
  });
  expect(response.status, response.raw).toBe(201);
  const id = String(response.body['id']);
  created.records.push(id);
  return id;
}

async function uploadAttachment(): Promise<string> {
  const attachment = await scope.runAs(
    adminPrincipal,
    () =>
      services().attachments.upload({
        filename: `${marker('agreement')}.pdf`,
        mimeType: 'application/pdf',
        body: PDF_BYTES,
        declaredSize: PDF_BYTES.byteLength,
      }),
    `es18:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

async function draft(opportunityId: string | null): Promise<string> {
  const response = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker('request'),
    subject: 'Please sign the event contract',
    connectionId,
    ...(opportunityId === null ? {} : { sourceEntityType: 'Opportunity', sourceRecordId: opportunityId }),
  });
  expect(response.status, response.raw).toBe(201);
  const id = String(response.body['id']);
  created.requests.push(id);
  expect(
    (await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }],
    })).status,
  ).toBe(200);
  const attachment = await uploadAttachment();
  expect((await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment })).status).toBe(201);
  return id;
}

async function versionOf(id: string): Promise<number> {
  return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['version']);
}

async function prepared(id: string): Promise<CallResult> {
  return call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, { version: await versionOf(id), confirm: true });
}

async function sent(id: string): Promise<{ envelopeId: string }> {
  const prepare = await prepared(id);
  expect(prepare.status, prepare.raw).toBe(200);
  const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
  expect(envelope.status, envelope.raw).toBe(200);
  const envelopeId = String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
  const send = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
  expect(send.status, send.raw).toBe(200);
  return { envelopeId };
}

async function outboxFor(requestId: string): Promise<OutboxRow[]> {
  const rows = await ctx.database.db
    .selectFrom('outbox_events')
    .select(['event_type', 'payload', 'status'])
    .where(sql<boolean>`payload ->> 'requestId' = ${requestId}`)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    event_type: row.event_type,
    payload: row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {},
    status: row.status,
  }));
}

function signedWebhook(body: Record<string, unknown>): { rawBody: Uint8Array; headers: Record<string, string> } {
  return FakeSignatureProviderAdapter.signWebhookPayload(CONNECT_SECRET, body);
}

async function deliverAndProcess(body: Record<string, unknown>): Promise<{ accepted: CallResult; processed: { status: string } }> {
  const signed = signedWebhook(body);
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/integrations/esignature/${connectionPublicId}`,
    headers: { ...signed.headers, 'content-type': 'application/json' },
    payload: Buffer.from(signed.rawBody),
  });
  expect(accepted.statusCode, accepted.body).toBe(202);
  const inbox = await ctx.database.db
    .selectFrom('signature_webhook_inbox')
    .select('id')
    .where('connection_id', '=', connectionId)
    .orderBy('received_at', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  const processed = await services().webhooks.processDelivery(inbox.id);
  return { accepted: { status: accepted.statusCode, body: {}, raw: accepted.body }, processed };
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
    features: {
      ...DEFAULT_ESIGNATURE_SETTINGS.features,
      requests: true,
      connections: true,
      documents: true,
      send: true,
      webhooks: true,
      artifacts: true,
    },
    webhooks: { endpointUrl: '', requireHmac: true, maxPayloadBytes: 262_144 },
  });

  const connection = await services().connections.create({ name: marker('conn'), environment: 'demo', oauthClientId: `agent-test-key-${runId}` });
  connectionId = connection.id;
  connectionPublicId = connection.publicId;
  await services().connections.recordAuthorized(connection.id, {
    accountId: 'fake-account-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    subjectUserId: 'fake-user-1',
  });
  await services().vault.store({ connectionId, kind: 'oauth_access_token', value: 'agent-test-access-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await services().vault.store({ connectionId, kind: 'webhook_secret', value: CONNECT_SECRET });

  await createTestRole(ctx, {
    id: ROLE_NO_ACCOUNT,
    name: `AGENT_TEST ES18 no account ${runId}`,
    permissions: { SignatureRequest: { read: 'all' } },
  });
  tokenNoEsig = (await createTestUser(ctx, { userName: USER_NO_ESIG, roleIds: [] })).token;
  tokenNoAccount = (await createTestUser(ctx, { userName: USER_NO_ACCOUNT, roleIds: [ROLE_NO_ACCOUNT] })).token;
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const requestId of created.requests) {
    const keys = await db.selectFrom('signature_document_snapshots').select('storage_ref').where('request_id', '=', requestId).execute();
    for (const entry of keys) if (entry.storage_ref !== null) await storage.delete(String(entry.storage_ref)).catch(() => undefined);
    await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const id of created.attachments) {
    const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', id).executeTakeFirst();
    if (row?.storage_key !== undefined && row.storage_key !== null) await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  if (created.requests.length > 0) {
    await db.deleteFrom('outbox_events').where(sql<boolean>`payload ->> 'requestId' = any(${created.requests}::text[])`).execute();
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.attachments.length > 0) await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();
  if (created.records.length > 0) {
    await db.deleteFrom('outbox_events').where(sql<boolean>`payload ->> 'entityId' = any(${created.records}::text[])`).execute();
    await db.deleteFrom('stream_followers').where('entity_id', 'in', created.records).execute();
    await db.deleteFrom('stream_items').where('entity_type', '=', 'Opportunity').where('entity_id', 'in', created.records).execute();
    await db.deleteFrom('audit_log').where('entity_type', '=', 'Opportunity').where('record_id', 'in', created.records).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'Opportunity').where('id', 'in', created.records).execute();
  }
  if (connectionId !== '') {
    await db.deleteFrom('signature_webhook_inbox').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('signature_provider_events').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('signature_audit_entries').where('connection_id', '=', connectionId).execute();
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
  await db.deleteFrom('users').where('user_name', 'in', [USER_NO_ESIG, USER_NO_ACCOUNT]).execute();
  await db.deleteFrom('roles').where('id', '=', ROLE_NO_ACCOUNT).execute();
  await purgeEntityEvents(ctx.database, ['Opportunity']);
  await shutdownApi();
});

describe('lifecycle events (acceptance 1 and 3)', () => {
  it('writes create, prepare, request-approval and approve as outbox events with safe payloads', async () => {
    await enabled({ features: { approvals: true }, approval: { requiredForSourceEntities: [], rules: [], preventSelfApproval: false } });
    const opportunityId = await createOpportunity();
    const id = await draft(opportunityId);
    await prepared(id);

    const requested = await call('POST', `/api/v1/ESignature/requests/${id}/request-approval`, ctx.adminToken, { version: await versionOf(id) });
    expect(requested.status, requested.raw).toBe(200);
    const approved = await call('POST', `/api/v1/ESignature/requests/${id}/approve`, ctx.adminToken, { version: await versionOf(id), reason: 'ok' });
    expect(approved.status, approved.raw).toBe(200);

    const events = await outboxFor(id);
    const types = events.map((event) => event.event_type);
    expect(types).toEqual(expect.arrayContaining([
      'esignature.requestCreated',
      'esignature.requestPrepared',
      'esignature.requestApprovalRequested',
      'esignature.requestApproved',
    ]));
    const createdEvent = events.find((event) => event.event_type === 'esignature.requestCreated');
    expect(createdEvent?.payload).toMatchObject({
      requestId: id,
      providerKey: 'docusign',
      connectionId,
      sourceEntityType: 'Opportunity',
      sourceRecordId: opportunityId,
      schemaVersion: 1,
    });
    expect(String(createdEvent?.payload['dedupeKey'])).toBe(`esignature.requestCreated:${id}:created`);
    // The event contract is data-minimal: no signer email, credential, URL or document bytes.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('one@example.invalid');
    expect(serialized).not.toContain('agent-test-access-token');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('%PDF');
  });

  it('emits sent, recipient-completed and request-completed once, even when a delivery is replayed', async () => {
    const opportunityId = await createOpportunity();
    const id = await draft(opportunityId);
    const { envelopeId } = await sent(id);
    const inboxCountBefore = Number(
      (await ctx.database.db
        .selectFrom('signature_webhook_inbox')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('connection_id', '=', connectionId)
        .executeTakeFirst())?.n ?? '0',
    );

    const providerRecipientId = (fake().envelope(envelopeId)?.recipients ?? [])[0]?.providerRecipientId ?? '';
    const recipientBody = {
      event_id: `evt-recipient-${runId}`,
      envelope_id: envelopeId,
      account_id: 'fake-account-1',
      event_type: 'recipient_completed',
      recipient_id: providerRecipientId,
      recipient_status: 'completed',
    };
    const first = await deliverAndProcess(recipientBody);
    expect(first.processed.status).toBe('processed');
    const duplicate = await deliverAndProcess(recipientBody);
    expect(duplicate.processed.status).toBe('already_processed');

    const completed = await deliverAndProcess({
      event_id: `evt-complete-${runId}`,
      envelope_id: envelopeId,
      account_id: 'fake-account-1',
      event_type: 'envelope-completed',
    });
    expect(completed.processed.status).toBe('processed');

    const events = await outboxFor(id);
    const types = events.map((event) => event.event_type);
    expect(types).toContain('esignature.requestSent');
    expect(types.filter((type) => type === 'esignature.recipientCompleted')).toHaveLength(1);
    expect(types.filter((type) => type === 'esignature.requestCompleted')).toHaveLength(1);
    const recipientEvent = events.find((event) => event.event_type === 'esignature.recipientCompleted');
    expect(recipientEvent?.payload['recipientStatus']).toBe('completed');
    expect(String(recipientEvent?.payload['recipientId'])).not.toBe('');
    expect(JSON.stringify(recipientEvent?.payload)).not.toContain('one@example.invalid');
    expect(
      Number(
        (await ctx.database.db
          .selectFrom('signature_webhook_inbox')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('connection_id', '=', connectionId)
          .executeTakeFirst())?.n ?? '0',
      ),
    ).toBe(inboxCountBefore + 2);
  });

  it('records a body mismatch when a provider event id is reused with a different body (G19)', async () => {
    const id = await draft(null);
    const { envelopeId } = await sent(id);
    const providerRecipientId = (fake().envelope(envelopeId)?.recipients ?? [])[0]?.providerRecipientId ?? '';
    const eventId = `evt-g19-body-${runId}`;
    const first = await deliverAndProcess({
      event_id: eventId,
      envelope_id: envelopeId,
      account_id: 'fake-account-1',
      event_type: 'recipient_completed',
      recipient_id: providerRecipientId,
      recipient_status: 'completed',
    });
    expect(first.processed.status).toBe('processed');

    // The same event id, a different body. It is a duplicate for state purposes — the first
    // delivery stays the receipt of record — but the mismatch must not vanish silently.
    const signed = signedWebhook({
      event_id: eventId,
      envelope_id: envelopeId,
      account_id: 'fake-account-1',
      event_type: 'recipient_declined',
      recipient_id: providerRecipientId,
      recipient_status: 'declined',
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/esignature/${connectionPublicId}`,
      headers: { ...signed.headers, 'content-type': 'application/json' },
      payload: Buffer.from(signed.rawBody),
    });
    expect(replay.statusCode, replay.body).toBe(202);

    const receipts = await ctx.database.db
      .selectFrom('signature_webhook_inbox')
      .select(['id', 'state', 'payload_minimized'])
      .where('connection_id', '=', connectionId)
      .where(sql<boolean>`payload_minimized ->> 'providerEventId' = ${eventId}`)
      .execute();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.state).toBe('processed');

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('action', '=', 'provider.event_body_mismatch')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe('refused');
    expect(audit[0]?.reason_safe).toBe('DEDUP_BODY_MISMATCH');
    expect(audit[0]?.connection_id).toBe(connectionId);
  });

  it('emits completedArtifactAvailable once for the stored artifacts', async () => {
    const id = await draft(null);
    const { envelopeId } = await sent(id);
    await deliverAndProcess({ event_id: `evt-artifact-complete-${runId}`, envelope_id: envelopeId, account_id: 'fake-account-1', event_type: 'envelope-completed' });
    const retrieve = await call('POST', `/api/v1/ESignature/requests/${id}/artifacts/retrieve`, ctx.adminToken);
    expect(retrieve.status, retrieve.raw).toBe(200);
    const again = await call('POST', `/api/v1/ESignature/requests/${id}/artifacts/retrieve`, ctx.adminToken);
    expect(again.status, again.raw).toBe(200);

    const events = (await outboxFor(id)).filter((event) => event.event_type === 'esignature.completedArtifactAvailable');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ artifactCount: 2, schemaVersion: 1 });
    expect(Array.isArray(events[0]?.payload['artifactKinds'])).toBe(true);
  });

  it('is safe for a replaying consumer that dedupes on the semantic key', async () => {
    const id = await draft(null);
    const { envelopeId } = await sent(id);
    await deliverAndProcess({ event_id: `evt-replay-complete-${runId}`, envelope_id: envelopeId, account_id: 'fake-account-1', event_type: 'envelope-completed' });
    const event = (await outboxFor(id)).find((row) => row.event_type === 'esignature.requestCompleted');
    expect(event).toBeDefined();
    const key = String(event?.payload['dedupeKey']);

    const processed = new Set<string>();
    let downstreamActions = 0;
    const consume = (dedupeKey: string): void => {
      if (processed.has(dedupeKey)) return;
      processed.add(dedupeKey);
      downstreamActions += 1;
    };
    consume(key);
    consume(key);
    expect(downstreamActions).toBe(1);
  });
});

describe('downstream modules decide their own state (acceptance 2)', () => {
  it('does not mark the linked opportunity won when the signature completes', async () => {
    const opportunityId = await createOpportunity('Proposal');
    const id = await draft(opportunityId);
    const { envelopeId } = await sent(id);
    await deliverAndProcess({ event_id: `evt-opportunity-complete-${runId}`, envelope_id: envelopeId, account_id: 'fake-account-1', event_type: 'envelope-completed' });

    const finalRequest = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
    expect(finalRequest.body['status']).toBe('completed');
    const opportunity = await call('GET', `/api/v1/Opportunity/${opportunityId}`, ctx.adminToken);
    expect(opportunity.status, opportunity.raw).toBe(200);
    expect(opportunity.body['stage']).toBe('Proposal');
    expect(opportunity.body['name']).toContain('AGENT_TEST_es18_opportunity');
  });
});

describe('CRM record entry points (acceptance 1)', () => {
  it('answers availability for a supported record, includes recent linked requests, and hides unsupported entities', async () => {
    const opportunityId = await createOpportunity();
    const id = await draft(opportunityId);
    const entry = await call(
      'GET',
      `/api/v1/ESignature/action/record-entry?entityType=Opportunity&recordId=${encodeURIComponent(opportunityId)}`,
      ctx.adminToken,
    );
    expect(entry.status, entry.raw).toBe(200);
    expect(entry.body).toMatchObject({ available: true, reason: 'available', canPrepare: true, entityType: 'Opportunity', recordId: opportunityId });
    expect((entry.body['requests'] as { id: string }[]).some((request) => request.id === id)).toBe(true);

    const unsupported = await call(
      'GET',
      `/api/v1/ESignature/action/record-entry?entityType=User&recordId=${encodeURIComponent(opportunityId)}`,
      ctx.adminToken,
    );
    expect(unsupported.status).toBe(200);
    expect(unsupported.body).toMatchObject({ available: false, reason: 'unsupported_entity' });
  });

  it('hides the entry point for a caller without the module right or without the record ACL', async () => {
    const opportunityId = await createOpportunity();
    const noModule = await call(
      'GET',
      `/api/v1/ESignature/action/record-entry?entityType=Opportunity&recordId=${encodeURIComponent(opportunityId)}`,
      tokenNoEsig,
    );
    expect(noModule.status).toBe(200);
    expect(noModule.body).toMatchObject({ available: false, reason: 'no_permission' });

    const restricted = await call(
      'GET',
      `/api/v1/ESignature/action/record-entry?entityType=Opportunity&recordId=${encodeURIComponent(opportunityId)}`,
      tokenNoAccount,
    );
    expect(restricted.status).toBe(200);
    expect(restricted.body).toMatchObject({ available: false, reason: 'record_restricted' });
  });

  it('closes the entry point cleanly when the module is off, with no error for the record page', async () => {
    const opportunityId = await createOpportunity();
    await enabled({ enabled: false });
    const closed = await call(
      'GET',
      `/api/v1/ESignature/action/record-entry?entityType=Opportunity&recordId=${encodeURIComponent(opportunityId)}`,
      ctx.adminToken,
    );
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ available: false, reason: 'module_disabled' });
    await enabled({ enabled: true });
  });
});
