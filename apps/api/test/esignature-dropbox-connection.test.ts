import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hmacSha256Hex } from '../src/advanced-integrations/connectors/kit/webhook-signatures.js';
import { FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import { SNAPSHOT_STORAGE_ROOT } from '../src/esignature/esignature-document.service.js';
import { ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { DropboxSignAdapter } from '../src/esignature/providers/dropbox-sign/dropbox-sign-adapter.js';
import {
  DROPBOX_SIGN_TRANSPORT,
  type DropboxSignHttpRequest,
  type DropboxSignHttpResponse,
  type DropboxSignTransport,
  encodeMultipart,
} from '../src/esignature/providers/dropbox-sign/dropbox-sign-transport.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi } from './support/boot-api.js';

/**
 * Dropbox Sign — the API-key connection lifecycle, through the API.
 *
 * Proves the second authentication style end to end without a socket: creation validates the key
 * against the provider, stores it in the vault, binds the account, and connects; replacement
 * re-validates and re-binds; the consent flow is refused (there is none); and the direct-send shape
 * is admitted by the gate while the draft operation is not.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Only `AGENT_TEST_` rows with this
 * run's marker are created, and they are removed by exact id afterwards. Settings are saved and
 * restored.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_dropbox_${suffix}_${runId}`;
const API_KEY = `agent-test-dropbox-key-${runId}`;
const REPLACED_KEY = `agent-test-dropbox-key-replaced-${runId}`;
const ACCOUNT_ID = `agent-test-dropbox-account-${runId}`;
const REPLACED_ACCOUNT_ID = `agent-test-dropbox-account-replaced-${runId}`;
const WEBHOOK_KEY = `agent-test-dropbox-key-webhook-${runId}`;
const WEBHOOK_ACCOUNT_ID = `agent-test-dropbox-account-webhook-${runId}`;
const SEND_KEY = `agent-test-dropbox-key-send-${runId}`;
const SEND_ACCOUNT_ID = `agent-test-dropbox-account-send-${runId}`;
const SEND_PROVIDER_REQUEST_ID = `provider-request-send-${runId}`;
const SEND_SIGNER_EMAIL = 'agent-test-dropbox-signer@example.test';
const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST dropbox direct send\n%%EOF\n', 'utf8');

let ctx: ApiContext;
let app: NestFastifyApplication;
let storage: FileStorage;
let baseline: unknown = null;
const createdConnections: string[] = [];
const createdRequests: string[] = [];
const createdAttachments: string[] = [];

const stub = {
  calls: [] as DropboxSignHttpRequest[],
};

function answer(status: number, body: unknown): DropboxSignHttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, headers: {}, body: bytes, text: Buffer.from(bytes).toString('utf8') };
}

/** The provider's answers, keyed by the Basic credential the adapter sent and the endpoint called. */
async function stubRequest(input: DropboxSignHttpRequest): Promise<DropboxSignHttpResponse> {
  stub.calls.push(input);
  const pathname = new URL(input.url).pathname;
  if (pathname.endsWith('/signature_request/send')) {
    return answer(200, {
      signature_request: {
        signature_request_id: SEND_PROVIDER_REQUEST_ID,
        created_at: 1_800_000_000,
        is_complete: false,
        is_declined: false,
        test_mode: true,
        signatures: [
          {
            signature_id: 'provider-signature-send-1',
            signer_email_address: SEND_SIGNER_EMAIL,
            signer_name: 'Signer One',
            order: 0,
            status_code: 'awaiting_signature',
            signed_at: null,
            last_viewed_at: null,
            decline_reason: null,
          },
        ],
      },
    });
  }
  if (!pathname.endsWith('/account')) {
    return answer(404, { error: { error_name: 'not_found' } });
  }
  const authorization = input.headers?.['authorization'] ?? '';
  if (authorization === `Basic ${Buffer.from(`${API_KEY}:`, 'utf8').toString('base64')}`) {
    return answer(200, { account: { account_id: ACCOUNT_ID, email_address: 'agent-test-dropbox@example.test' } });
  }
  if (authorization === `Basic ${Buffer.from(`${REPLACED_KEY}:`, 'utf8').toString('base64')}`) {
    return answer(200, { account: { account_id: REPLACED_ACCOUNT_ID, email_address: 'agent-test-dropbox-replaced@example.test' } });
  }
  if (authorization === `Basic ${Buffer.from(`${WEBHOOK_KEY}:`, 'utf8').toString('base64')}`) {
    return answer(200, { account: { account_id: WEBHOOK_ACCOUNT_ID, email_address: 'agent-test-dropbox-webhook@example.test' } });
  }
  if (authorization === `Basic ${Buffer.from(`${SEND_KEY}:`, 'utf8').toString('base64')}`) {
    return answer(200, { account: { account_id: SEND_ACCOUNT_ID, email_address: 'agent-test-dropbox-sender@example.test' } });
  }
  return answer(401, { error: { error_name: 'invalid_auth', error_msg: 'Bad key.' } });
}

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
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

function settingsService(): ESignatureSettingsService {
  return app.get(ESignatureSettingsService);
}

async function patchSettings(patch: Record<string, unknown>): Promise<CallResult> {
  const result = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  settingsService().invalidate();
  return result;
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baseline = row?.data ?? null;
  const enabled = await patchSettings({
    enabled: true,
    features: { connections: true, requests: true, documents: true, send: true, webhooks: true },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

  // Outside production the module binds the fake for `docusign`; this suite registers the real
  // Dropbox adapter over a stub transport, which is the same seam the production module uses.
  const transport = app.get<DropboxSignTransport>(DROPBOX_SIGN_TRANSPORT);
  (transport as { request: typeof stubRequest }).request = stubRequest;
  app.get(SignatureProviderRegistry).register(new DropboxSignAdapter(transport));
});

afterAll(async () => {
  const db = ctx.database.db;
  if (createdRequests.length > 0) {
    // Snapshot bytes live outside the database; remove the files this run wrote before the rows.
    const snapshots = await db
      .selectFrom('signature_document_snapshots')
      .select('storage_ref')
      .where('request_id', 'in', createdRequests)
      .execute();
    for (const entry of snapshots) if (entry.storage_ref !== null) await storage.delete(String(entry.storage_ref)).catch(() => undefined);
    for (const requestId of createdRequests) {
      await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
    }
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', createdRequests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', createdRequests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', createdRequests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', createdRequests).execute();
  }
  if (createdAttachments.length > 0) {
    const files = await db.selectFrom('attachments').select('storage_key').where('id', 'in', createdAttachments).execute();
    for (const file of files) {
      if (file.storage_key !== null) await storage.delete(String(file.storage_key)).catch(() => undefined);
    }
    await db.deleteFrom('attachments').where('id', 'in', createdAttachments).execute();
  }
  if (createdConnections.length > 0) {
    // Inbox rows reference the connection with ON DELETE RESTRICT; only this run's rows are removed.
    await db.deleteFrom('signature_webhook_inbox').where('connection_id', 'in', createdConnections).execute();
    await db.deleteFrom('esignature_credential_secrets').where('connection_id', 'in', createdConnections).execute();
    await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', createdConnections).execute();
    await db.deleteFrom('esignature_connections').where('id', 'in', createdConnections).execute();
  }
  if (baseline === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  } else {
    const serialized = JSON.stringify(baseline);
    await db
      .insertInto('app_settings')
      .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  settingsService().invalidate();
});

describe('an API-key connection', () => {
  it('validates the key, binds the account and is usable immediately', async () => {
    const created = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'dropbox_sign',
      name: marker('connection'),
      environment: 'demo',
      apiKey: API_KEY,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    createdConnections.push(id);
    expect(created.body).toMatchObject({
      providerKey: 'dropbox_sign',
      providerLabel: 'Dropbox Sign',
      providerStatus: 'available',
      status: 'connected',
      isActive: true,
      accountId: ACCOUNT_ID,
      authStyle: 'api_key',
      hasApiKey: true,
      hasClientSecret: false,
      hasRefreshToken: false,
      webhookSecretKind: 'api_key',
      grantedScopes: [],
    });
    expect(JSON.stringify(created.body)).not.toContain(API_KEY);
    const credentials = created.body['credentials'] as { kind: string; state: string }[];
    expect(credentials).toEqual([expect.objectContaining({ kind: 'api_key', state: 'active' })]);

    // The credential really is encrypted at rest, not stored as a column value.
    const stored = await ctx.database.db
      .selectFrom('esignature_credential_secrets')
      .select(['kind', 'payload_encrypted'])
      .where('connection_id', '=', id)
      .executeTakeFirst();
    expect(stored?.kind).toBe('api_key');
    expect(stored?.payload_encrypted ?? '').not.toContain(API_KEY);
  });

  it('answers a connection test through the live adapter', async () => {
    const id = createdConnections[0];
    expect(id).toBeDefined();
    const tested = await call('POST', `/api/v1/ESignature/connections/${String(id)}/test`, ctx.adminToken);
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body).toMatchObject({ reachable: true, adapterMode: 'live', detailCode: 'ok' });
  });

  it('admits the direct send shape and refuses the draft operation', async () => {
    const send = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, {
      operation: 'sendEnvelope',
      providerKey: 'dropbox_sign',
    });
    expect(send.status, JSON.stringify(send.body)).toBe(200);

    const prepare = await call('POST', '/api/v1/ESignature/action/gate/check', ctx.adminToken, {
      operation: 'prepareEnvelope',
      providerKey: 'dropbox_sign',
    });
    expect(prepare.status).toBe(422);
    expect(String(((prepare.body['error'] ?? {}) as { code?: string }).code)).toBe('NOT_SUPPORTED_BY_PROVIDER');
  });

  it('refuses the OAuth consent flow, because this provider has none', async () => {
    const id = createdConnections[0];
    const refused = await call('POST', `/api/v1/ESignature/connections/${String(id)}/authorize`, ctx.adminToken, {});
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('API_KEY_REPLACEMENT_REQUIRED');
  });

  it('re-validates and re-binds a replaced key, and refuses an invalid one without unbinding', async () => {
    const id = createdConnections[0];
    const replaced = await call('POST', `/api/v1/ESignature/connections/${String(id)}/secret`, ctx.adminToken, {
      kind: 'api_key',
      value: REPLACED_KEY,
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toMatchObject({ status: 'connected', accountId: REPLACED_ACCOUNT_ID, isActive: true });

    const refused = await call('POST', `/api/v1/ESignature/connections/${String(id)}/secret`, ctx.adminToken, {
      kind: 'api_key',
      value: 'agent-test-invalid-key',
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const after = await call('GET', `/api/v1/ESignature/connections/${String(id)}`, ctx.adminToken);
    expect(after.body).toMatchObject({ accountId: REPLACED_ACCOUNT_ID, status: 'connected' });
  });

  it('exposes the API-key connection as a usable provider on a request', async () => {
    const created = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('direct_request'),
      providerKey: 'dropbox_sign',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const requestId = String(created.body['id']);
    createdRequests.push(requestId);
    expect(created.body).toMatchObject({ providerKey: 'dropbox_sign', providerDrafting: 'direct' });

    // Preparation is the operation this provider does not have; the refusal names it rather than
    // failing later inside an adapter.
    const prepare = await call('POST', `/api/v1/ESignature/requests/${requestId}/envelope`, ctx.adminToken, { version: 1 });
    expect(prepare.status).toBe(422);
    expect(String(((prepare.body['error'] ?? {}) as { code?: string }).code)).toBe('NOT_SUPPORTED_BY_PROVIDER');
  });
});

describe('the callback endpoint', () => {
  /**
   * Dropbox Sign posts `multipart/form-data` with a `json` part, signed by `event_hash` over
   * `event_time + event_type`, and retries — eventually disabling the endpoint — unless the answer is
   * exactly `Hello API Event Received`. This drives that shape through the real HTTP route.
   */
  it('acknowledges a delivery with the exact wording the provider requires', async () => {
    const created = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'dropbox_sign',
      name: marker('webhook_connection'),
      environment: 'demo',
      apiKey: WEBHOOK_KEY,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    createdConnections.push(id);

    // The routing id is the connection's opaque public id, never its database id or a secret.
    const row = await ctx.database.db.selectFrom('esignature_connections').select('public_id').where('id', '=', id).executeTakeFirst();
    const publicId = String(row?.public_id ?? '');
    expect(publicId).not.toBe('');

    const time = String(Math.floor(Date.now() / 1000));
    const type = 'signature_request_all_signed';
    const providerRequestId = `provider-request-${runId}`;
    const payload = {
      event: {
        event_time: time,
        event_type: type,
        event_hash: hmacSha256Hex(WEBHOOK_KEY, `${time}${type}`),
        event_metadata: { related_signature_id: 'provider-signature-1', reported_for_account_id: WEBHOOK_ACCOUNT_ID },
      },
      signature_request: { signature_request_id: providerRequestId },
    };
    const boundary = 'agent-test-boundary';
    const deliver = async (body: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/integrations/esignature/${publicId}`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(encodeMultipart([{ name: 'json', value: JSON.stringify(body) }], boundary)),
      });

    const accepted = await deliver(payload);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(String(accepted.headers['content-type'])).toContain('text/plain');
    expect(accepted.body).toBe('Hello API Event Received');

    const stored = await ctx.database.db
      .selectFrom('signature_webhook_inbox')
      .select(['signature_status', 'provider_envelope_id', 'routing_public_id'])
      .where('connection_id', '=', id)
      .execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      signature_status: 'verified',
      provider_envelope_id: providerRequestId,
      routing_public_id: publicId,
    });

    // A duplicate is acknowledged the same way: any other wording makes the provider retry forever.
    const duplicate = await deliver(payload);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body).toBe('Hello API Event Received');

    // A forged delivery is refused, and is *not* handed the acknowledgement that ends retries.
    const forged = await deliver({ ...payload, event: { ...payload.event, event_hash: 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(401);
    expect(forged.body).not.toContain('Hello API Event Received');
  });
});

describe('a direct send', () => {
  /** An attachment the request can name, uploaded the way the UI uploads one. */
  async function uploadPdf(): Promise<string> {
    const boundary = 'agent-test-upload-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/Attachment/upload',
      headers: { ...authHeader(ctx.adminToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        encodeMultipart(
          [{ name: 'file', filename: `${marker('agreement')}.pdf`, contentType: 'application/pdf', value: PDF_BYTES }],
          boundary,
        ),
      ),
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = String((response.json() as { id: string }).id);
    createdAttachments.push(id);
    return id;
  }

  async function versionOf(id: string): Promise<number> {
    return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, ctx.adminToken)).body['version']);
  }

  it('creates and sends in one call, records the envelope, and refuses a second send', async () => {
    const connection = await call('POST', '/api/v1/ESignature/connections', ctx.adminToken, {
      providerKey: 'dropbox_sign',
      name: marker('send_connection'),
      environment: 'demo',
      apiKey: SEND_KEY,
    });
    expect(connection.status, JSON.stringify(connection.body)).toBe(201);
    const connectionId = String(connection.body['id']);
    createdConnections.push(connectionId);

    const created = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
      name: marker('direct_send'),
      subject: 'Please sign',
      connectionId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    createdRequests.push(id);

    const recipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
      recipients: [{ name: 'Signer One', email: SEND_SIGNER_EMAIL, recipientType: 'signer', routingOrder: 1 }],
    });
    expect(recipients.status, JSON.stringify(recipients.body)).toBe(200);
    const attachmentId = await uploadPdf();
    const document = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId });
    expect(document.status, JSON.stringify(document.body)).toBe(201);

    // The preview is local and still required: the sender reviews exactly what will be created.
    const prepared = await call('POST', `/api/v1/ESignature/requests/${id}/prepare`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect((prepared.body['request'] as Record<string, unknown>)['status']).toBe('ready_to_send');

    const sent = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body['request']).toMatchObject({
      status: 'sent',
      providerKey: 'dropbox_sign',
      providerDrafting: 'direct',
      providerEnvelopeId: SEND_PROVIDER_REQUEST_ID,
      editable: false,
    });
    expect((sent.body['request'] as Record<string, unknown>)['sentAt']).not.toBeNull();

    // The provider was called exactly once, at its create-and-send endpoint.
    const sendCalls = stub.calls.filter((entry) => new URL(entry.url).pathname.endsWith('/signature_request/send'));
    expect(sendCalls).toHaveLength(1);
    expect(new URL(sendCalls[0]?.url ?? '').pathname).toBe('/v3/signature_request/send');

    // The send answer's envelope id and status are on the row, with the reviewed snapshot kept.
    const row = await ctx.database.db
      .selectFrom('signature_requests')
      .select(['status', 'provider_envelope_id', 'sent_at', 'outgoing_digest'])
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row).toMatchObject({ status: 'sent', provider_envelope_id: SEND_PROVIDER_REQUEST_ID });
    expect(row?.sent_at).not.toBeNull();
    expect(row?.outgoing_digest).not.toBeNull();

    // One request, one provider call: a second click is refused before it reaches the provider.
    const retry = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, {
      version: await versionOf(id),
      confirm: true,
    });
    expect(retry.status).toBe(409);
    expect(
      stub.calls.filter((entry) => new URL(entry.url).pathname.endsWith('/signature_request/send')),
    ).toHaveLength(1);
  });
});
