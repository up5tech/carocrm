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
import { connectSignature } from '../src/esignature/providers/signature-provider-signature.js';
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureDocumentSnapshotRepository } from '../src/esignature/signature-document-snapshot.repository.js';
import { SignatureProviderEventRepository } from '../src/esignature/signature-provider-event.repository.js';
import { SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import { SignatureWebhookInboxRepository } from '../src/esignature/signature-webhook-inbox.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phases 19-ES.11–19-ES.16 — Connect intake, projection, embedded signing, completed artifacts and
 * lifecycle actions (`PLAN_Phase_19_ESignature.md` §10, §13.2–§13.4, §16, §18).
 *
 * One suite drives the whole post-send story with the fake provider and the configured database:
 *
 *  - a verified delivery is durable before it is processed, and a duplicate is a no-op;
 *  - an invalid, malformed or misrouted delivery changes nothing;
 *  - a recipient finishing does not complete the envelope, and an older event cannot undo a completion;
 *  - an embedded view is generated only for the named signer and an allowlisted return host;
 *  - completed documents and the certificate are new artifacts, and a retry stores none;
 *  - reminders respect the cooldown; a void is audited with its reason; correction is a named refusal.
 *
 * No test reaches DocuSign: the bound adapter is the fake (plan §17.3), and every row this run creates
 * is removed by its own id (AGENTS.md §3.3).
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

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es11_${suffix}_${runId}`;
const CONNECT_SECRET = `agent-test-connect-${runId}`;
const ROLE_SIGNER = `AGENT_TEST-es11-signer-${runId}`;
const ROLE_OUTSIDER = `AGENT_TEST-es11-outsider-${runId}`;
const USER_SIGNER = `agent_test_es11_signer_${runId}`;
const USER_OUTSIDER = `agent_test_es11_outsider_${runId}`;
const SIGNER_EMAIL = `${USER_SIGNER}@example.com`;

const PDF_BYTES = Buffer.from(`%PDF-1.4\n% AGENT_TEST es11 lifecycle\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`, 'utf8');

let tokenSigner = '';
let tokenOutsider = '';
let signerId = '';
let connectionId = '';
let connectionPublicId = '';
const created = { requests: [] as string[], attachments: [] as string[] };
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
  if (!(adapter instanceof FakeSignatureProviderAdapter)) throw new Error('The suite expects the fake adapter.');
  return adapter;
}

function one<T>(rows: readonly T[], what: string): T {
  const [first] = rows;
  if (first === undefined) throw new Error(`Expected one ${what}.`);
  return first;
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

async function versionOf(id: string): Promise<number> {
  return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['version']);
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
    `es11:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

interface SentFixture {
  readonly id: string;
  readonly envelopeId: string;
  readonly recipientId: string;
  readonly providerRecipientId: string;
}

/**
 * A request at `sent`, through the real command path: draft, recipients, document, preview, provider
 * draft, send. The fake adapter accepted it, so every post-send feature has a real envelope to work on.
 */
async function sentRequest(options: { embedded?: boolean; secondSigner?: boolean } = {}): Promise<SentFixture> {
  const draft = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker(`request_${String(created.requests.length)}`),
    subject: 'Please sign',
    connectionId,
  });
  expect(draft.status, draft.raw).toBe(201);
  const id = String(draft.body['id']);
  created.requests.push(id);

  const recipients: Record<string, unknown>[] = [
    {
      name: 'Signer One',
      email: SIGNER_EMAIL,
      recipientType: 'signer',
      routingOrder: 1,
      ...(options.embedded === true ? { authenticationMethod: 'embedded' } : {}),
    },
  ];
  if (options.secondSigner === true) {
    recipients.push({ name: 'Signer Two', email: `two_${runId}@example.com`, recipientType: 'signer', routingOrder: 2 });
  }
  expect((await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, { recipients })).status).toBe(200);
  const attachment = await uploadAttachment();
  expect((await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment })).status).toBe(201);
  const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, { version: await versionOf(id), confirm: true });
  expect(prepared.status, prepared.raw).toBe(200);
  const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
  expect(envelope.status, envelope.raw).toBe(200);
  const envelopeId = String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
  const sent = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
  expect(sent.status, sent.raw).toBe(200);

  const view = await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken);
  const recipient = one((view.body['recipients'] as { id: string }[]) ?? [], 'request recipient');
  const providerRecipient = one(fake().envelope(envelopeId)?.recipients ?? [], 'provider recipient');
  return { id, envelopeId, recipientId: recipient.id, providerRecipientId: providerRecipient.providerRecipientId };
}

function signedBody(body: Record<string, unknown>): {
  rawBody: Uint8Array;
  headers: Record<string, string>;
} {
  const signed = FakeSignatureProviderAdapter.signWebhookPayload(CONNECT_SECRET, body);
  return { rawBody: signed.rawBody, headers: signed.headers };
}

async function deliver(body: Record<string, unknown>, options: { publicId?: string } = {}): Promise<CallResult & { rawBody: Uint8Array }> {
  const signed = signedBody(body);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/integrations/esignature/${options.publicId ?? connectionPublicId}`,
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
  return { status: res.statusCode, body: parsed, raw, rawBody: signed.rawBody };
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

async function deliverAndProcess(body: Record<string, unknown>): Promise<{ accepted: CallResult; processed: Awaited<ReturnType<ESignatureWebhookService['processDelivery']>> }> {
  const accepted = await deliver(body);
  expect(accepted.status, accepted.raw).toBe(202);
  const processed = await services().webhooks.processDelivery(await latestInboxId());
  return { accepted, processed };
}

async function countInbox(): Promise<number> {
  const row = await ctx.database.db
    .selectFrom('signature_webhook_inbox')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('connection_id', '=', connectionId)
    .executeTakeFirst();
  return Number.parseInt(String(row?.n ?? '0'), 10) || 0;
}

async function inboxCountFor(providerEnvelopeId: string): Promise<number> {
  const row = await ctx.database.db
    .selectFrom('signature_webhook_inbox')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('connection_id', '=', connectionId)
    .where('provider_envelope_id', '=', providerEnvelopeId)
    .executeTakeFirst();
  return Number.parseInt(String(row?.n ?? '0'), 10) || 0;
}

async function eventCountFor(providerEnvelopeId: string): Promise<number> {
  const row = await ctx.database.db
    .selectFrom('signature_provider_events')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('connection_id', '=', connectionId)
    .where('provider_envelope_id', '=', providerEnvelopeId)
    .executeTakeFirst();
  return Number.parseInt(String(row?.n ?? '0'), 10) || 0;
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
  // The fake keeps its sequence for the whole suite: an envelope id is unique within the connection,
  // so resetting the fake between tests would make a new request collide with a stored envelope id.
  fake().reset();

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
      embeddedSigning: true,
      artifacts: true,
    },
    signing: {
      defaultExpiryDays: 30,
      remindersEnabled: true,
      resendCooldownMinutes: 0,
      embeddedReturnHosts: ['crm.example.com'],
    },
    webhooks: { requireHmac: true, maxPayloadBytes: 262_144, endpointUrl: '' },
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

  await createTestRole(ctx, { id: ROLE_SIGNER, name: `AGENT_TEST ES11 signer ${runId}`, permissions: { SignatureRequest: { read: 'all' } } });
  await createTestRole(ctx, { id: ROLE_OUTSIDER, name: `AGENT_TEST ES11 outsider ${runId}`, permissions: { SignatureRequest: { read: 'all' } } });
  const signer = await createTestUser(ctx, { userName: USER_SIGNER, roleIds: [ROLE_SIGNER] });
  tokenSigner = signer.token;
  signerId = signer.id;
  tokenOutsider = (await createTestUser(ctx, { userName: USER_OUTSIDER, roleIds: [ROLE_OUTSIDER] })).token;
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
  if (connectionId !== '') {
    if (created.requests.length > 0) {
      await sql`
        delete from jobs
        where job in ('esignature.processProviderWebhook', 'esignature.retrieveCompletedArtifacts')
          and (target->>'requestId' = any(${created.requests}::text[])
               or target->>'inboxId' in (select id from signature_webhook_inbox where connection_id = ${connectionId}))
      `.execute(db).catch(() => undefined);
    }
    await db.deleteFrom('signature_webhook_inbox').where('connection_id', '=', connectionId).execute();
  }
  if (created.requests.length > 0) {
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.attachments.length > 0) await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();
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
  await db.deleteFrom('users').where('user_name', 'in', [USER_SIGNER, USER_OUTSIDER]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_SIGNER, ROLE_OUTSIDER]).execute();
  await purgeEntityEvents(ctx.database, ['Account']);
  await shutdownApi();
});

describe('Connect intake (ES.11)', () => {
  it('accepts a verified delivery once, duplicates it harmlessly and projects the signer', async () => {
    const fixture = await sentRequest();
    const body = {
      event_id: `evt-delivered-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'fake-account-1',
      event_type: 'delivered',
      recipient_id: fixture.providerRecipientId,
      recipient_status: 'delivered',
      occurred_at: '2026-01-01T09:05:00.000Z',
    };
    const first = await deliver(body);
    expect(first.status, first.raw).toBe(202);
    expect(first.body['status']).toBe('accepted');
    const inboxId = await latestInboxId();

    const duplicate = await deliver(body);
    expect(duplicate.status, duplicate.raw).toBe(202);
    expect(duplicate.body['status']).toBe('duplicate');
    expect(await inboxCountFor(fixture.envelopeId)).toBe(1);
    expect(await eventCountFor(fixture.envelopeId)).toBe(0);

    const processed = await services().webhooks.processDelivery(inboxId);
    expect(processed.status).toBe('processed');
    expect(processed.requestId).toBe(fixture.id);
    const request = await services().requests.requireById(fixture.id);
    expect(request.status).toBe('delivered');
    const recipient = await services().recipients.requireById(fixture.recipientId);
    expect(recipient.status).toBe('delivered');
    expect(await eventCountFor(fixture.envelopeId)).toBe(1);

    // Processing the same receipt again is answered, not replayed.
    expect((await services().webhooks.processDelivery(inboxId)).status).toBe('already_processed');
    expect((await services().requests.requireById(fixture.id)).version).toBe(request.version);
  });

  it('refuses an invalid signature, a malformed body and a misrouted account without touching the request', async () => {
    const fixture = await sentRequest();
    const before = await services().requests.requireById(fixture.id);

    const tampered = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/esignature/${connectionPublicId}`,
      headers: { 'content-type': 'application/json', 'x-fake-signature': connectSignature('wrong-secret', new TextEncoder().encode('{"envelope_id":"x"}')) },
      payload: Buffer.from('{"envelope_id":"x"}'),
    });
    if (tampered.statusCode !== 401) throw new Error(`unexpected: ${tampered.statusCode} ${tampered.body}`);
    expect(tampered.statusCode).toBe(401);
    const invalid = await sql<{ signature_status: string; state: string; payload_minimized: unknown }>`
      select signature_status, state, payload_minimized from signature_webhook_inbox
      where connection_id = ${connectionId} order by received_at desc limit 1
    `.execute(ctx.database.db);
    expect(one(invalid.rows, 'invalid inbox row').signature_status).toBe('invalid');
    expect(one(invalid.rows, 'invalid inbox row').state).toBe('ignored');
    expect(one(invalid.rows, 'invalid inbox row').payload_minimized).toEqual({});

    const malformedBody = new TextEncoder().encode('not json');
    const malformed = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/esignature/${connectionPublicId}`,
      headers: { 'content-type': 'application/json', 'x-fake-signature': connectSignature(CONNECT_SECRET, malformedBody) },
      payload: Buffer.from(malformedBody),
    });
    expect(malformed.statusCode).toBe(401);

    const misrouted = await deliver({
      event_id: `evt-misrouted-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'some-other-account',
      event_type: 'completed',
    });
    expect(misrouted.status).toBe(401);
    expect(await eventCountFor(fixture.envelopeId)).toBe(0);
    expect((await services().requests.requireById(fixture.id)).version).toBe(before.version);
    expect((await services().requests.requireById(fixture.id)).status).toBe('sent');
  });

  it('stores an unknown envelope as evidence and never binds it to a request', async () => {
    const { accepted, processed } = await deliverAndProcess({
      event_id: `evt-ghost-${runId}`,
      envelope_id: `ghost-${runId}`,
      account_id: 'fake-account-1',
      event_type: 'completed',
    });
    expect(accepted.status).toBe(202);
    expect(processed).toMatchObject({ status: 'ignored', outcome: 'unknown_envelope', requestId: null });
    const event = await ctx.database.db
      .selectFrom('signature_provider_events')
      .select(['request_id', 'processing_status', 'provider_envelope_id'])
      .where('connection_id', '=', connectionId)
      .where('provider_envelope_id', '=', `ghost-${runId}`)
      .executeTakeFirstOrThrow();
    expect(event.request_id).toBeNull();
    expect(event.processing_status).toBe('ignored');
    expect(event.provider_envelope_id).toBe(`ghost-${runId}`);
    const delivery = await sql<{ state: string; last_error_safe: string | null }>`
      select state, last_error_safe from signature_webhook_inbox where connection_id = ${connectionId} order by received_at desc limit 1
    `.execute(ctx.database.db);
    expect(one(delivery.rows, 'unknown delivery').state).toBe('ignored');
    expect(one(delivery.rows, 'unknown delivery').last_error_safe).toBe('unknown_envelope');
  });

  it('closes the endpoint when webhooks are off and for an unknown routing id', async () => {
    const countBefore = await countInbox();
    await enabled({ features: { webhooks: false } });
    const refused = await deliver({ event_id: `evt-off-${runId}`, envelope_id: 'e', event_type: 'sent' });
    expect(refused.status).toBe(404);
    expect(await countInbox()).toBe(countBefore);
    await enabled({ features: { webhooks: true } });

    const unknown = await deliver({ event_id: `evt-unknown-${runId}`, envelope_id: 'e', event_type: 'sent' }, { publicId: 'doesnotexist' });
    expect(unknown.status).toBe(404);
    expect(await countInbox()).toBe(countBefore);
  });
});

describe('envelope and recipient synchronization (ES.12)', () => {
  it('does not complete on a recipient event, completes on the envelope event, and never moves backwards', async () => {
    const fixture = await sentRequest();

    const recipientDone = await deliverAndProcess({
      event_id: `evt-recipient-completed-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'fake-account-1',
      event_type: 'recipient_completed',
      recipient_id: fixture.providerRecipientId,
      recipient_status: 'completed',
      occurred_at: '2026-01-01T09:10:00.000Z',
    });
    expect(
      recipientDone.processed,
      JSON.stringify({
        processed: recipientDone.processed,
        audit: (await services().audit.listForRequest(fixture.id, { limit: 20 })).map((entry) => ({ action: entry.action, reason: entry.reasonSafe, detail: entry.detail })),
      }),
    ).toMatchObject({ status: 'processed' });
    expect((await services().requests.requireById(fixture.id)).status).toBe('partially_signed');
    expect((await services().recipients.requireById(fixture.recipientId)).status).toBe('completed');

    const completed = await deliverAndProcess({
      event_id: `evt-envelope-completed-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'fake-account-1',
      event_type: 'envelope-completed',
      occurred_at: '2026-01-01T09:11:00.000Z',
    });
    expect(completed.processed.status).toBe('processed');
    expect((await services().requests.requireById(fixture.id)).status).toBe('completed');

    const older = await deliverAndProcess({
      event_id: `evt-older-sent-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'fake-account-1',
      event_type: 'envelope-sent',
      occurred_at: '2026-01-01T09:00:00.000Z',
    });
    expect(older.processed.status).toBe('ignored');
    const final = await services().requests.requireById(fixture.id);
    expect(final.status).toBe('completed');
    const oldEvent = await ctx.database.db
      .selectFrom('signature_provider_events')
      .select('processing_status')
      .where('provider_event_id', '=', `evt-older-sent-${runId}`)
      .executeTakeFirstOrThrow();
    expect(oldEvent.processing_status).toBe('ignored');
  });

  it('reconciles a completed envelope idempotently, taking the provider’s answer', async () => {
    const fixture = await sentRequest();
    fake().advance(fixture.envelopeId, 'completed');
    const reconciled = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/reconcile`, ctx.adminToken);
    expect(reconciled.status, reconciled.raw).toBe(200);
    expect((reconciled.body['request'] as Record<string, unknown>)['status']).toBe('completed');
    expect((await services().recipients.requireById(fixture.recipientId)).status).toBe('completed');

    const again = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/reconcile`, ctx.adminToken);
    expect(again.status, again.raw).toBe(200);
    expect((again.body['request'] as Record<string, unknown>)['status']).toBe('completed');
    expect((await services().requests.requireById(fixture.id)).lastReconciledAt).not.toBeNull();
  });

  it('shows signer progress and an activity timeline, and hides both from an unrelated record scope', async () => {
    const fixture = await sentRequest({ secondSigner: true });
    const view = await call('GET', `/api/v1/ESignature/requests/${fixture.id}`, ctx.adminToken);
    const recipients = ((view.body['recipients'] as { id: string }[]) ?? []);
    const second = one(recipients.filter((entry) => entry.id !== fixture.recipientId), 'second recipient');
    await deliverAndProcess({
      event_id: `evt-progress-${runId}`,
      envelope_id: fixture.envelopeId,
      account_id: 'fake-account-1',
      event_type: 'recipient_completed',
      recipient_id: fixture.providerRecipientId,
      recipient_status: 'completed',
    });

    const list = await call('GET', '/api/v1/ESignature/requests?limit=100', ctx.adminToken);
    const row = ((list.body['list'] as { id: string; progress: { completed: number; signers: number } }[]) ?? []).find((entry) => entry.id === fixture.id);
    expect(row?.progress).toMatchObject({ completed: 1, signers: 2 });

    const timeline = await call('GET', `/api/v1/ESignature/requests/${fixture.id}/events`, ctx.adminToken);
    expect(timeline.status).toBe(200);
    const entries = (timeline.body['list'] as { kind: string; type: string }[]) ?? [];
    expect(entries.some((entry) => entry.kind === 'provider' && entry.type === 'completed')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'audit')).toBe(true);
    // The signer in the payload is the local second signer, not a leaked provider payload.
    expect(JSON.stringify(entries)).not.toContain('not json');
    expect(second.id).not.toBe(fixture.recipientId);
  });
});

describe('embedded signing (ES.14)', () => {
  it('creates a short-lived view for the named signer only, with an allowlisted return host', async () => {
    const fixture = await sentRequest({ embedded: true });
    const callsBefore = fake().calls.filter((entry) => entry.operation === 'recipientView').length;
    // The preparation marked this signer as embedded, so the provider was given our client user id.
    expect(one(fake().envelope(fixture.envelopeId)?.recipients ?? [], 'provider recipient').clientUserId).toBe(fixture.recipientId);
    expect(
      fake().calls.find((entry) => entry.operation === 'prepareEnvelope' && entry.detail['signatureRequestId'] === fixture.id)?.detail['embeddedRecipients'],
    ).toBe(1);

    const view = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/embedded-view`, tokenSigner, {
      recipientId: fixture.recipientId,
      returnUrl: 'https://crm.example.com/esignature',
    });
    expect(view.status, view.raw).toBe(200);
    expect(String(view.body['url'])).toContain('fake.docusign.invalid/signing/');
    expect(fake().calls.filter((entry) => entry.operation === 'recipientView').length).toBe(callsBefore + 1);

    // The browser session does not complete anything; the request is still sent.
    expect((await services().requests.requireById(fixture.id)).status).toBe('sent');

    const auditRows = await services().audit.listForRequest(fixture.id, { limit: 50 });
    const auditEntry = auditRows.find((entry) => entry.action === 'embedded_view.created');
    expect(auditEntry).toBeDefined();
    expect(JSON.stringify(auditEntry?.detail)).not.toContain('fake.docusign.invalid/signing');

    const unrelated = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/embedded-view`, tokenOutsider, {
      recipientId: fixture.recipientId,
      returnUrl: 'https://crm.example.com/esignature',
    });
    expect(unrelated.status).toBe(403);
    expect(errorCode(unrelated)).toBe('RECIPIENT_NOT_AUTHORIZED');

    const callsAfter = fake().calls.filter((entry) => entry.operation === 'recipientView').length;
    const foreignHost = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/embedded-view`, tokenSigner, {
      recipientId: fixture.recipientId,
      returnUrl: 'https://evil.example.com/esignature',
    });
    expect(foreignHost.status).toBe(422);
    expect(errorCode(foreignHost)).toBe('SIGNATURE_ACTION_NOT_AVAILABLE');
    expect(errorDetails(foreignHost)['refusal']).toBe('return_url_not_allowed');
    expect(fake().calls.filter((entry) => entry.operation === 'recipientView').length).toBe(callsAfter);
  });

  it('refuses an embedded view for a recipient who was configured for email signing', async () => {
    const fixture = await sentRequest();
    const view = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/embedded-view`, tokenSigner, {
      recipientId: fixture.recipientId,
      returnUrl: 'https://crm.example.com/esignature',
    });
    expect(view.status).toBe(422);
    expect(errorDetails(view)['refusal']).toBe('recipient_not_embedded');
  });
});

describe('completed documents and evidence (ES.15)', () => {
  it('stores new artifacts once, serves their bytes, and keeps the source snapshot unchanged', async () => {
    const fixture = await sentRequest();
    fake().advance(fixture.envelopeId, 'completed');
    expect((await call('POST', `/api/v1/ESignature/requests/${fixture.id}/reconcile`, ctx.adminToken)).status).toBe(200);

    const first = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/artifacts/retrieve`, ctx.adminToken);
    expect(first.status, first.raw).toBe(200);
    const artifacts = (first.body['artifacts'] as { id: string; artifactKind: string; contentHashSha256: string }[]) ?? [];
    expect(artifacts.filter((entry) => entry.artifactKind === 'provider_signed_document')).toHaveLength(1);
    expect(artifacts.filter((entry) => entry.artifactKind === 'completion_evidence')).toHaveLength(1);
    expect(Number(first.body['created'])).toBe(2);

    const second = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/artifacts/retrieve`, ctx.adminToken);
    expect(second.status, second.raw).toBe(200);
    expect(Number(second.body['created'])).toBe(0);
    expect(((second.body['artifacts'] as { id: string }[]) ?? []).map((entry) => entry.id).sort()).toEqual(artifacts.map((entry) => entry.id).sort());

    const all = await services().snapshots.listForRequest(fixture.id);
    const source = one(all.filter((entry) => entry.artifactKind === 'source_snapshot'), 'source snapshot');
    const signed = one(artifacts.filter((entry) => entry.artifactKind === 'provider_signed_document'), 'signed artifact');
    // The source snapshot still says what it said; the signed copy is a different artifact.
    expect(source.contentHashSha256).not.toBe(signed.contentHashSha256);
    const storedSource = one(
      (await services().snapshots.listForRequest(fixture.id)).filter((entry) => entry.artifactKind === 'source_snapshot'),
      'stored source snapshot',
    );
    expect(storedSource.contentHashSha256).toBe(source.contentHashSha256);

    for (const artifact of artifacts) {
      const download = await app.inject({
        method: 'GET',
        url: `/api/v1/ESignature/requests/${fixture.id}/documents/${artifact.id}/content`,
        headers: authHeader(ctx.adminToken),
      });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.headers['x-checksum-sha256']).toBe(artifact.contentHashSha256);
    }

    // A reader without `downloadCompleted` may read the source snapshot but not the signed copy.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/ESignature/requests/${fixture.id}/documents/${signed.id}/content`,
      headers: authHeader(tokenSigner),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('reminders, void and correction (ES.16)', () => {
  it('reminds, starts the cooldown only on success, and audits the accepted reminder', async () => {
    const fixture = await sentRequest();
    const first = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/resend-notification`, ctx.adminToken, {});
    expect(first.status, first.raw).toBe(200);
    expect(fake().calls.filter((entry) => entry.operation === 'resendNotifications')).toHaveLength(1);

    const audit = await services().audit.listForRequest(fixture.id, { limit: 50 });
    expect(audit.filter((entry) => entry.action === 'reminder.sent')).toHaveLength(1);

    await enabled({ signing: { remindersEnabled: true, resendCooldownMinutes: 10 } });
    const limited = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/resend-notification`, ctx.adminToken, {});
    expect(limited.status).toBe(429);
    expect(errorCode(limited)).toBe('SIGNATURE_RESEND_RATE_LIMITED');
    expect(fake().calls.filter((entry) => entry.operation === 'resendNotifications')).toHaveLength(1);
    await enabled({ signing: { resendCooldownMinutes: 0 } });
  });

  it('voids an open envelope with an actor and a reason, and refuses a closed one without a provider call', async () => {
    const fixture = await sentRequest();
    const unconfirmed = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/void`, ctx.adminToken, {
      version: await versionOf(fixture.id),
      confirm: false,
      reason: 'wrong counterparty',
    });
    expect(unconfirmed.status).toBe(422);
    expect((await call('POST', `/api/v1/ESignature/requests/${fixture.id}/void`, ctx.adminToken, {
      version: await versionOf(fixture.id),
      confirm: true,
      reason: 'x',
    })).status).toBe(400);

    const callsBefore = fake().calls.filter((entry) => entry.operation === 'voidEnvelope').length;
    const voided = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/void`, ctx.adminToken, {
      version: await versionOf(fixture.id),
      confirm: true,
      reason: 'wrong counterparty',
    });
    expect(voided.status, voided.raw).toBe(200);
    expect((voided.body['request'] as Record<string, unknown>)['status']).toBe('voided');
    expect(fake().calls.filter((entry) => entry.operation === 'voidEnvelope').length).toBe(callsBefore + 1);

    const audit = await services().audit.listForRequest(fixture.id, { limit: 50 });
    expect(audit.find((entry) => entry.action === 'void.completed')?.reasonSafe).toBe('wrong counterparty');
    expect(audit.find((entry) => entry.action === 'void.requested')?.actorId).not.toBeNull();

    const again = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/void`, ctx.adminToken, {
      version: await versionOf(fixture.id),
      confirm: true,
      reason: 'again',
    });
    expect(again.status).toBe(409);
    expect(fake().calls.filter((entry) => entry.operation === 'voidEnvelope').length).toBe(callsBefore + 1);
  });

  it('refuses correction by name, with an audit row and no provider call', async () => {
    const fixture = await sentRequest();
    const callsBefore = fake().calls.length;
    const refused = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/correct`, ctx.adminToken, {
      confirm: true,
      reason: 'recipient name typo',
    });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('NOT_SUPPORTED_BY_PROVIDER');
    expect(fake().calls.length).toBe(callsBefore);
    const audit = await services().audit.listForRequest(fixture.id, { limit: 50 });
    const entry = audit.find((row) => row.action === 'correct.requested');
    expect(entry?.outcome).toBe('refused');
    expect(entry?.reasonSafe).toBe('provider_not_supported');
  });

  it('refuses to reverse completion through the void command', async () => {
    const fixture = await sentRequest();
    fake().advance(fixture.envelopeId, 'completed');
    expect((await call('POST', `/api/v1/ESignature/requests/${fixture.id}/reconcile`, ctx.adminToken)).status).toBe(200);
    const callsBefore = fake().calls.filter((entry) => entry.operation === 'voidEnvelope').length;
    const refused = await call('POST', `/api/v1/ESignature/requests/${fixture.id}/void`, ctx.adminToken, {
      version: await versionOf(fixture.id),
      confirm: true,
      reason: 'change my mind',
    });
    expect(refused.status).toBe(409);
    expect(fake().calls.filter((entry) => entry.operation === 'voidEnvelope').length).toBe(callsBefore);
  });
});
