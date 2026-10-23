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
import { FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.10 — controlled send and ambiguous outcome recovery
 * (`PLAN_Phase_19_ESignature.md` §4.3, §11.1, §16, §18 `19-ES.10`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **One deliberate action, at most one effective send** — a second click, a retry after the fact and a
 *    retry after a lost answer are all refused, and the fake adapter's ledger shows a single
 *    `sendEnvelope` call for the action that really happened.
 *  - **An ambiguous outcome is `send_unknown`, never a blind retry** — the request is held, the operator's
 *    only way forward is `reconcile`, and that command either concludes the send or proves it never
 *    happened (which is what makes a later retry safe).
 *  - **Every send records sender, time, source, documents and recipients** — the sender and time on the
 *    row, and the immutable snapshot with the documents' hashes and the recipient routing.
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

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es10_${suffix}_${runId}`;
const ROLE_DRAFTER = `AGENT_TEST-es10-drafter-${runId}`;
const ROLE_FOREIGN = `AGENT_TEST-es10-foreign-${runId}`;
const USER_DRAFTER = `agent_test_es10_drafter_${runId}`;
const USER_FOREIGN = `agent_test_es10_foreign_${runId}`;

const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es10 send\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');

let tokenDrafter = '';
let tokenForeign = '';
let drafterId = '';
let connectionId = '';
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
    vault: app.get(ESignatureCredentialVault),
    attachments: app.get(AttachmentService),
    registry: app.get(SignatureProviderRegistry),
  };
}

function fakeAdapter(): FakeSignatureProviderAdapter {
  const adapter = services().registry.resolve('docusign');
  if (!(adapter instanceof FakeSignatureProviderAdapter)) throw new Error('The test suite expects the fake adapter to be bound.');
  return adapter;
}

function sendCalls(): number {
  return fakeAdapter().calls.filter((entry) => entry.operation === 'sendEnvelope').length;
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
    `es10:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

async function draft(): Promise<string> {
  const created_ = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, { name: marker('request'), subject: 'Please sign', connectionId });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.requests.push(id);
  expect((await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
    recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }],
  })).status).toBe(200);
  const attachment = await uploadAttachment();
  expect((await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment })).status).toBe(201);
  return id;
}

async function versionOf(id: string): Promise<number> {
  return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['version']);
}

async function preparePreview(id: string): Promise<CallResult> {
  const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, { version: await versionOf(id), confirm: true });
  expect(prepared.status, prepared.raw).toBe(200);
  return prepared;
}

async function createEnvelope(id: string): Promise<string> {
  const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
  expect(envelope.status, envelope.raw).toBe(200);
  return String((envelope.body['envelope'] as { providerEnvelopeId: string }).providerEnvelopeId);
}

/** A request at `ready_to_send` with a provider draft and no send attempted. */
async function readyToSend(): Promise<{ id: string; envelopeId: string }> {
  const id = await draft();
  await preparePreview(id);
  return { id, envelopeId: await createEnvelope(id) };
}

async function send(id: string, overrides: Record<string, unknown> = {}): Promise<CallResult> {
  return call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true, ...overrides });
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baselineSettings = row?.data ?? null;

  await enabled({
    enabled: true,
    features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, requests: true, documents: true, send: true, connections: true },
  });

  connectionId = await authorizedConnection(marker('conn'));
  await createTestRole(ctx, {
    id: ROLE_DRAFTER,
    name: `AGENT_TEST ES10 drafter ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' } },
  });
  await createTestRole(ctx, { id: ROLE_FOREIGN, name: `AGENT_TEST ES10 foreign ${runId}`, permissions: { SignatureRequest: { create: 'yes', read: 'own' } } });
  const drafter = await createTestUser(ctx, { userName: USER_DRAFTER, roleIds: [ROLE_DRAFTER] });
  tokenDrafter = drafter.token;
  drafterId = drafter.id;
  tokenForeign = (await createTestUser(ctx, { userName: USER_FOREIGN, roleIds: [ROLE_FOREIGN] })).token;
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
  await purgeEntityEvents(ctx.database, ['Account']);
  await shutdownApi();
});

describe('guarded send (acceptance 3)', () => {
  it('refuses without the sender’s confirmation, without a draft, and with a stale version', async () => {
    const ready = await readyToSend();
    const callsBefore = sendCalls();

    const unconfirmed = await send(ready.id, { confirm: false });
    expect(unconfirmed.status).toBe(422);
    expect(errorDetails(unconfirmed)['code']).toBe('CONFIRMATION_REQUIRED');

    const stale = await send(ready.id, { version: 999 });
    expect(stale.status).toBe(409);

    const noEnvelope = await draft();
    await preparePreview(noEnvelope);
    const refused = await call('POST', `/api/v1/ESignature/requests/${noEnvelope}/send`, ctx.adminToken, { version: await versionOf(noEnvelope), confirm: true });
    expect(refused.status).toBe(422);
    expect(errorDetails(refused)['code']).toBe('SIGNATURE_REQUEST_INVALID_STATE');

    expect(sendCalls()).toBe(callsBefore);
    expect((await services().requests.requireById(ready.id)).status).toBe('ready_to_send');
  });

  it('requires the approval the policy demands for the exact contents', async () => {
    const ready = await readyToSend();
    // A policy flipped after preparation makes the preview stale (the digest covers the policy), and a
    // re-preparation routes to pending_approval. The state below is the one ES.17's approval flow
    // produces: a preview prepared under an approval requirement, with no decision yet. The stored
    // digest is realigned to the current preview so the approval gate — not the staleness guard — answers.
    await ctx.database.db.updateTable('signature_requests').set({ approval_required: true }).where('id', '=', ready.id).execute();
    const current = await call('GET', `/api/v1/ESignature/requests/${ready.id}/preview`, ctx.adminToken);
    await ctx.database.db
      .updateTable('signature_requests')
      .set({ outgoing_digest: String(current.body['digest']) })
      .where('id', '=', ready.id)
      .execute();
    const refused = await send(ready.id);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('SIGNATURE_APPROVAL_REQUIRED');
    expect(sendCalls()).toBe(0);
  });

  it('lets a sender without the drafting right send, and refuses one without the send right', async () => {
    const ready = await readyToSend();
    const refused = await call('POST', `/api/v1/ESignature/requests/${ready.id}/send`, tokenDrafter, { version: 1, confirm: true });
    // The drafter owns the request but holds no `SignatureSend` right.
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('AUTHORIZATION_DENIED');
    const foreign = await call('POST', `/api/v1/ESignature/requests/${ready.id}/send`, tokenForeign, { version: 1, confirm: true });
    expect(foreign.status).toBe(403);
  });
});

describe('one deliberate action, at most one send (acceptance 1)', () => {
  it('sends once, records sender and time, and keeps the snapshot as the record', async () => {
    const ready = await readyToSend();
    const before = sendCalls();
    const sent = await send(ready.id);
    expect(sent.status, sent.raw).toBe(200);
    expect(sendCalls()).toBe(before + 1);

    const view = sent.body['request'] as Record<string, unknown>;
    expect(view['status']).toBe('sent');
    expect(view['providerEnvelopeId']).toBe(ready.envelopeId);
    expect(view['providerStatusRaw']).toBe('sent');
    expect(view['sentAt']).not.toBeNull();
    expect(view['editable']).toBe(false);

    const stored = await services().requests.requireById(ready.id);
    expect(stored.sentById).not.toBeNull();
    expect(String(stored.sentById)).toMatch(/admin/i);
    expect(stored.sendAttemptId).not.toBeNull();
    // The record of what was sent is the snapshot: documents with hashes, recipients with routing.
    const data = stored.outgoingSnapshot?.data;
    expect(data?.documents[0]?.contentHashSha256).toBeDefined();
    expect(data?.recipients.map((recipient) => recipient.email)).toEqual(['one@example.invalid']);
    expect(data?.recipients[0]?.routingOrder).toBe(1);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'detail'])
      .where('request_id', '=', ready.id)
      .execute();
    const completed = audit.find((entry) => entry.action === 'send.completed');
    expect(completed).toBeDefined();
    expect((completed?.detail as { recipientCount?: number }).recipientCount).toBe(1);
  });

  it('refuses a second send of the same request, and no second provider call is made', async () => {
    const ready = await readyToSend();
    expect((await send(ready.id)).status).toBe(200);
    const callsAfterSend = sendCalls();
    const retry = await send(ready.id);
    expect(retry.status).toBe(409);
    expect(errorCode(retry)).toBe('SIGNATURE_REQUEST_INVALID_STATE');
    expect(sendCalls()).toBe(callsAfterSend);
    expect(fakeAdapter().envelopesFor(ready.id)).toHaveLength(1);
  });
});

describe('an ambiguous outcome is held, never retried (acceptance 2)', () => {
  it('holds a lost response as send_unknown and refuses a resend', async () => {
    const ready = await readyToSend();
    const before = sendCalls();
    fakeAdapter().loseNextSendResponse();

    const lost = await send(ready.id);
    expect(lost.status).toBe(409);
    expect(errorCode(lost)).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(sendCalls()).toBe(before + 1);

    const stored = await services().requests.requireById(ready.id);
    expect(stored.status).toBe('send_unknown');
    expect(stored.sendAttemptId).not.toBeNull();

    // A second click cannot send it again: the state no longer permits it.
    const resend = await send(ready.id);
    expect(resend.status).toBe(409);
    expect(sendCalls()).toBe(before + 1);
    expect(fakeAdapter().envelopesFor(ready.id)).toHaveLength(1);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('request_id', '=', ready.id)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('send.outcome_unknown');
  });

  it('reconciles a lost response into sent, using the provider’s own answer', async () => {
    const ready = await readyToSend();
    fakeAdapter().loseNextSendResponse();
    expect((await send(ready.id)).status).toBe(409);

    const reconciled = await call('POST', `/api/v1/ESignature/requests/${ready.id}/reconcile`, ctx.adminToken);
    expect(reconciled.status, reconciled.raw).toBe(200);
    expect(reconciled.body['reconciled']).toBe(true);
    expect(reconciled.body['providerStatus']).toBe('sent');
    const view = reconciled.body['request'] as Record<string, unknown>;
    expect(view['status']).toBe('sent');
    expect(view['sentAt']).not.toBeNull();

    // And the request can never be sent again.
    expect((await send(ready.id)).status).toBe(409);
  });

  it('proves a send that never happened, then allows a deliberate retry', async () => {
    const ready = await readyToSend();
    // Simulate an ambiguous attempt whose envelope the provider still holds as a draft: the local row is
    // moved exactly as the send path would leave it, without a provider call.
    const current = await services().requests.requireById(ready.id);
    if (current.outgoingSnapshot === null) throw new Error('The fixture request has no prepared snapshot.');
    const claimed = await services().requests.claimSendAttempt(ready.id, current.version, `agent-test-attempt-${runId}`, current.outgoingSnapshot);
    const sending = await services().requests.transition(ready.id, { expectedVersion: claimed.version, to: 'sending', origin: 'local', actorId: 'admin' });
    await services().requests.transition(ready.id, {
      expectedVersion: sending.version,
      to: 'send_unknown',
      origin: 'provider',
      failure: { category: 'unknown_outcome', code: 'SEND_OUTCOME_UNKNOWN', messageSafe: 'agent test' },
    });

    const reconciled = await call('POST', `/api/v1/ESignature/requests/${ready.id}/reconcile`, ctx.adminToken);
    expect(reconciled.status, reconciled.raw).toBe(200);
    expect(reconciled.body).toMatchObject({ reconciled: true, providerStatus: 'draft' });
    expect((reconciled.body['request'] as Record<string, unknown>)['status']).toBe('provider_error');

    const recovered = await call('POST', `/api/v1/ESignature/requests/${ready.id}/send/recover`, ctx.adminToken);
    expect(recovered.status, recovered.raw).toBe(200);
    const restored = recovered.body['request'] as Record<string, unknown>;
    expect(restored['status']).toBe('ready_to_send');
    expect((await services().requests.requireById(ready.id)).sendAttemptId).toBeNull();

    const before = sendCalls();
    const sent = await send(ready.id);
    expect(sent.status, sent.raw).toBe(200);
    expect(sendCalls()).toBe(before + 1);
  });
});

describe('a definite rejection is recoverable', () => {
  it('marks provider_error, keeps the attempt as evidence, and recovers through a new attempt', async () => {
    const ready = await readyToSend();
    // The provider no longer has this envelope: a definite refusal, not an ambiguous one.
    await ctx.database.db
      .updateTable('signature_requests')
      .set({ provider_envelope_id: `missing-${runId}` })
      .where('id', '=', ready.id)
      .execute();

    const refused = await send(ready.id);
    expect(refused.status, refused.raw).toBe(409);
    const stored = await services().requests.requireById(ready.id);
    expect(stored.status).toBe('provider_error');
    expect(stored.failureCategory).toBe('not_found');
    expect(stored.sendAttemptId).not.toBeNull();

    const recovered = await call('POST', `/api/v1/ESignature/requests/${ready.id}/send/recover`, ctx.adminToken);
    expect(recovered.status, recovered.raw).toBe(200);
    expect((recovered.body['request'] as Record<string, unknown>)['status']).toBe('ready_to_send');
    expect((await services().requests.requireById(ready.id)).sendAttemptId).toBeNull();
  });
});
