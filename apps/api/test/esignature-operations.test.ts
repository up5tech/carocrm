import { createHash, randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESignatureCredentialVault } from '../src/esignature/esignature-credential-vault.js';
import { ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureWebhookInboxRepository } from '../src/esignature/signature-webhook-inbox.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.20 — admin operations and the recovery workbench
 * (`PLAN_Phase_19_ESignature.md` §14, §16, §18 `19-ES.20`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **Operators can diagnose without secret exposure** — the workbench reports connection health,
 *    webhook states, queues and failed jobs; the test stores a uniquely marked credential and asserts
 *    neither the overview nor the health response contains its value.
 *  - **Manual retry is unavailable where it could create a duplicate send** — only a verified inbound
 *    delivery can be retried; `provider_error` rows say `reconcileAllowed: false`, and no request
 *    retry route exists. The send-unknown row can only be reconciled.
 *  - **A provider outage does not block unrelated CRM features** — with a connection recording an
 *    error and no usable provider, the operations view and an ordinary Account read both answer.
 *
 * Runs against the configured database (AGENTS.md §3.1). Fixtures carry the run marker and are
 * removed by their own ids; the ESignature settings row is restored.
 */

type Method = 'GET' | 'POST';
interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

let ctx: ApiContext;
let app: NestFastifyApplication;
let tokenReader = '';
let tokenNone = '';
let readerUserId = '';
let baselineSettings: unknown = null;
let connectionId = '';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const RUN = `AGENT_TEST_es20_${runId}`;
const SECRET_VALUE = `AGENT_TEST_es20_secret_${runId}`;
const ROLE_READER = `AGENT_TEST-es20-reader-${runId}`;
const USER_READER = `agent_test_es20_reader_${runId}`;
const USER_NONE = `agent_test_es20_none_${runId}`;

const requests = {
  failed: { id: '', envelope: `${RUN}_env_failed` },
  stuckSending: { id: '', envelope: `${RUN}_env_stuck_sending` },
  stuckInFlight: { id: '', envelope: `${RUN}_env_stuck_inflight` },
  sendUnknown: { id: '', envelope: `${RUN}_env_unknown` },
  reconciliation: { id: '', envelope: `${RUN}_env_reconcile` },
  healthy: { id: '', envelope: `${RUN}_env_healthy` },
  own: { id: '', envelope: `${RUN}_env_own` },
};
const inbox = { dead: '', retryable: '', invalid: '', processed: '' };
const jobId = randomUUID();
const now = Date.now();
const hoursAgo = (hours: number): Date => new Date(now - hours * 3_600_000);

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await app.inject({
    method,
    url,
    headers: authHeader(token),
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

async function requestFixture(input: {
  key: keyof typeof requests;
  status: string;
  createdBy: string;
  modifiedAt: Date;
  sentAt?: Date | null;
  lastSyncAt?: Date | null;
  failureCode?: string | null;
}): Promise<void> {
  const id = randomUUID();
  requests[input.key].id = id;
  await ctx.database.db
    .insertInto('signature_requests')
    .values({
      id,
      name: `${RUN}_${input.key}`,
      status: input.status,
      provider_key: 'docusign',
      connection_id: connectionId,
      provider_envelope_id: requests[input.key].envelope,
      source_entity_type: null,
      created_by_id: input.createdBy,
      assigned_user_id: input.createdBy,
      team_ids: JSON.stringify([]),
      approval_required: false,
      approval_status: 'not_required',
      sent_at: input.sentAt ?? null,
      last_provider_sync_at: input.lastSyncAt ?? null,
      failure_category: input.failureCode === undefined || input.failureCode === null ? null : 'permanent_validation',
      failure_code: input.failureCode ?? null,
      failure_message_safe: input.failureCode === undefined || input.failureCode === null ? null : 'The provider refused the call.',
      version: 1,
      created_at: input.modifiedAt,
      modified_at: input.modifiedAt,
      deleted_at: null,
    })
    .execute();
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  baselineSettings =
    (await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst())?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_READER,
    name: `AGENT_TEST ES20 reader ${runId}`,
    permissions: { SignatureConnection: { read: 'yes' }, SignatureRequest: { read: 'own' } },
  });
  const reader = await createTestUser(ctx, { userName: USER_READER, roleIds: [ROLE_READER] });
  readerUserId = reader.id;
  tokenReader = reader.token;
  tokenNone = (await createTestUser(ctx, { userName: USER_NONE })).token;

  const enabled = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, {
    enabled: true,
    features: { requests: true, connections: true, webhooks: true },
  });
  expect(enabled.status, enabled.raw).toBe(200);
  app.get(ESignatureSettingsService).invalidate();

  const connections = app.get(SignatureConnectionRepository);
  const connection = await connections.create({ name: `${RUN}_connection`, environment: 'demo', oauthClientId: `client_${runId}` });
  connectionId = connection.id;
  await connections.recordAuthorized(connection.id, {
    accountId: `account_${runId}`,
    accountName: 'AGENT_TEST provider account',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    subjectUserId: `subject_${runId}`,
  });
  await connections.recordWebhookReceived(connection.id);

  const vault = app.get(ESignatureCredentialVault);
  await vault.store({ connectionId, kind: 'client_secret', value: SECRET_VALUE });
  await vault.store({ connectionId, kind: 'oauth_refresh_token', value: `${SECRET_VALUE}_refresh` });
  await vault.store({ connectionId, kind: 'webhook_secret', value: `${SECRET_VALUE}_webhook` });
  // Expires in the future so the token check is about presence, not a deliberately stale fixture.
  await vault.store({
    connectionId,
    kind: 'oauth_access_token',
    value: `${SECRET_VALUE}_access`,
    expiresAt: new Date(now + 3_600_000).toISOString(),
  });

  const adminCreator = 'adminUserId';
  await requestFixture({ key: 'failed', status: 'provider_error', createdBy: adminCreator, modifiedAt: hoursAgo(2), failureCode: 'PROVIDER_REFUSED' });
  await requestFixture({ key: 'stuckSending', status: 'sending', createdBy: adminCreator, modifiedAt: hoursAgo(1) });
  await requestFixture({
    key: 'stuckInFlight',
    status: 'sent',
    createdBy: adminCreator,
    modifiedAt: hoursAgo(50),
    sentAt: hoursAgo(72),
    lastSyncAt: hoursAgo(48),
  });
  await requestFixture({ key: 'sendUnknown', status: 'send_unknown', createdBy: adminCreator, modifiedAt: hoursAgo(1) });
  await requestFixture({ key: 'reconciliation', status: 'reconciliation_required', createdBy: adminCreator, modifiedAt: hoursAgo(1) });
  await requestFixture({
    key: 'healthy',
    status: 'sent',
    createdBy: adminCreator,
    modifiedAt: hoursAgo(1),
    sentAt: hoursAgo(1),
    lastSyncAt: hoursAgo(1),
  });
  await requestFixture({ key: 'own', status: 'provider_error', createdBy: readerUserId, modifiedAt: hoursAgo(2), failureCode: 'PROVIDER_REFUSED' });

  const inboxRepo = app.get(SignatureWebhookInboxRepository);
  const accepted = async (input: {
    dedup: string;
    envelope: string;
    signatureStatus: 'verified' | 'invalid' | 'not_required';
    state: 'processed' | 'ignored' | 'retryable' | 'dead_letter';
    receivedAt: Date;
    errorSafe?: string;
  }): Promise<string> => {
    const acceptedRow = await inboxRepo.accept({
      providerKey: 'docusign',
      dedupKey: `${RUN}:${input.dedup}`,
      payloadHash: createHash('sha256').update(`${input.dedup}_${runId}`).digest('hex'),
      contentLength: 128,
      signatureStatus: input.signatureStatus,
      payloadMinimized: { eventType: 'sent', occurredAt: input.receivedAt.toISOString() },
      connectionId,
      providerEnvelopeId: input.envelope,
      receivedAt: input.receivedAt,
    });
    await inboxRepo.markState(acceptedRow.delivery.id, input.state, { ...(input.errorSafe === undefined ? {} : { errorSafe: input.errorSafe }) });
    return acceptedRow.delivery.id;
  };
  inbox.dead = await accepted({
    dedup: 'dead',
    envelope: `${RUN}_env_dead`,
    signatureStatus: 'verified',
    state: 'dead_letter',
    receivedAt: hoursAgo(3),
    errorSafe: 'AGENT_TEST transient projection failure',
  });
  inbox.retryable = await accepted({
    dedup: 'retryable',
    envelope: `${RUN}_env_retryable`,
    signatureStatus: 'verified',
    state: 'retryable',
    receivedAt: hoursAgo(1),
    errorSafe: 'AGENT_TEST transient projection failure',
  });
  inbox.invalid = await accepted({
    dedup: 'invalid',
    envelope: `${RUN}_env_invalid`,
    signatureStatus: 'invalid',
    state: 'ignored',
    receivedAt: hoursAgo(4),
  });
  inbox.processed = await accepted({
    dedup: 'processed',
    envelope: `${RUN}_env_processed`,
    signatureStatus: 'verified',
    state: 'processed',
    receivedAt: hoursAgo(6),
  });

  await ctx.database.db
    .insertInto('jobs')
    .values({
      id: jobId,
      job: 'esignature.retrieveCompletedArtifacts',
      status: 'failed',
      scheduling_type: null,
      created_at: hoursAgo(2),
      started_at: hoursAgo(2),
      finished_at: hoursAgo(2),
      target: JSON.stringify({ requestId: requests.failed.id, inboxId: inbox.dead, secret: SECRET_VALUE }),
      result: null,
      progress: 40,
      message: 'The API refused the retrieval.',
      last_error: 'The API refused the retrieval (500).',
      queue_job_id: null,
      attempt: 5,
      max_attempts: 5,
      cancel_requested: false,
    })
    .execute();
});

afterAll(async () => {
  const db = ctx.database.db;
  const requestIds = Object.values(requests).map((entry) => entry.id).filter((id) => id !== '');
  const envelopeIds = Object.values(requests).map((entry) => entry.envelope);
  await db.deleteFrom('signature_audit_entries').where('connection_id', '=', connectionId).execute();
  if (requestIds.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', requestIds).execute();
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', requestIds).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', requestIds).execute();
  }
  await db.deleteFrom('signature_provider_events').where('provider_envelope_id', 'in', envelopeIds).execute();
  await db
    .deleteFrom('signature_provider_events')
    .where('provider_envelope_id', 'in', [`${RUN}_env_dead`, `${RUN}_env_retryable`, `${RUN}_env_invalid`, `${RUN}_env_processed`])
    .execute();
  await db.deleteFrom('signature_webhook_inbox').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('jobs').where('id', '=', jobId).execute();
  if (connectionId !== '') {
    await app.get(ESignatureCredentialVault).clear(connectionId);
    await db.deleteFrom('esignature_oauth_states').where('connection_id', '=', connectionId).execute();
    await db.deleteFrom('esignature_connections').where('id', '=', connectionId).execute();
  }
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  } else {
    const serialized = typeof baselineSettings === 'string' ? baselineSettings : JSON.stringify(baselineSettings);
    await db
      .insertInto('app_settings')
      .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  app.get(ESignatureSettingsService).invalidate();
  await db.deleteFrom('users').where('user_name', 'in', [USER_READER, USER_NONE]).execute();
  await db.deleteFrom('roles').where('id', '=', ROLE_READER).execute();
  await shutdownApi();
});

function worklist(body: Record<string, unknown>, key: string): { items: Record<string, unknown>[]; count: number } {
  const lists = body['worklists'] as Record<string, { items: Record<string, unknown>[]; count: number }>;
  return lists[key] ?? { items: [], count: 0 };
}

describe('diagnostics expose no secret (acceptance 1)', () => {
  it('reports connection health, webhook states and every recovery queue', async () => {
    const response = await call('GET', '/api/v1/ESignature/action/operations?staleAfterHours=24&limit=25', ctx.adminToken);
    expect(response.status, response.raw).toBe(200);
    expect(response.raw).not.toContain(SECRET_VALUE);
    expect(response.raw).not.toContain('AGENT_TEST_es20_secret');

    const connections = response.body['connections'] as Record<string, unknown>[];
    const health = connections.find((row) => row['id'] === connectionId) as Record<string, unknown>;
    expect(health).toBeDefined();
    expect(health['status']).toBe('connected');
    expect((health['token'] as Record<string, unknown>)['hasRefreshToken']).toBe(true);
    expect((health['webhook'] as Record<string, unknown>)['configured']).toBe(true);
    expect((health['requests'] as Record<string, number>)['provider_error']).toBe(2);

    const webhook = response.body['webhook'] as Record<string, unknown>;
    const counts = webhook['countsByState'] as Record<string, number>;
    expect(counts['dead_letter']).toBeGreaterThanOrEqual(1);
    expect(counts['retryable']).toBeGreaterThanOrEqual(1);
    expect((webhook['signatureStatus'] as Record<string, number>)['invalid']).toBeGreaterThanOrEqual(1);
    const deliveries = webhook['deliveries'] as Record<string, unknown>[];
    expect(deliveries.some((row) => row['state'] === 'dead_letter' && row['retryAllowed'] === true)).toBe(true);

    expect(worklist(response.body, 'failed').count).toBeGreaterThanOrEqual(2);
    expect(worklist(response.body, 'stuck').count).toBeGreaterThanOrEqual(2);
    expect(worklist(response.body, 'sendUnknown').count).toBeGreaterThanOrEqual(1);
    expect(worklist(response.body, 'reconciliation').count).toBeGreaterThanOrEqual(1);
    for (const kind of ['failed', 'stuck', 'sendUnknown', 'reconciliation'] as const) {
      expect(worklist(response.body, kind).items.length).toBeGreaterThan(0);
    }
    const failedRow = worklist(response.body, 'failed').items.find((row) => row['id'] === requests.failed.id);
    expect(failedRow?.['reconcileAllowed']).toBe(false);
    const unknownRow = worklist(response.body, 'sendUnknown').items.find((row) => row['id'] === requests.sendUnknown.id);
    expect(unknownRow?.['reconcileAllowed']).toBe(true);

    const jobs = response.body['failedJobs'] as { items: Record<string, unknown>[]; count: number };
    expect(jobs.count).toBeGreaterThanOrEqual(1);
    const job = jobs.items.find((item) => item['id'] === jobId);
    expect(job?.['job']).toBe('esignature.retrieveCompletedArtifacts');
    expect((job?.['targets'] as Record<string, unknown>)['requestId']).toBe(requests.failed.id);
    expect(response.raw).not.toContain(`"secret"`);

    const checks = response.body['checks'] as { name: string; ok: boolean }[];
    for (const name of ['token_refresh', 'webhook_secrets', 'provider_errors', 'webhook_inbox', 'credential_age']) {
      expect(checks.some((check) => check.name === name), name).toBe(true);
    }
    expect(checks.find((check) => check.name === 'webhook_inbox')?.ok).toBe(false);
    expect(response.body['actions']).toEqual({ canRetryWebhook: true, canReconcile: true });
  });

  it('adds the ES.20 checks to module health without a credential value', async () => {
    const response = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    expect(response.status, response.raw).toBe(200);
    expect(response.raw).not.toContain(SECRET_VALUE);
    const checks = response.body['checks'] as { name: string }[];
    for (const name of ['token_refresh', 'webhook_secrets', 'provider_errors', 'webhook_inbox', 'credential_age']) {
      expect(checks.some((check) => check.name === name), name).toBe(true);
    }
  });

  it('scopes request queues to the caller, while connection diagnostics stay readable', async () => {
    const response = await call('GET', '/api/v1/ESignature/action/operations', tokenReader);
    expect(response.status, response.raw).toBe(200);
    expect(response.body['requestAccess']).toBe('own');
    expect(response.body['actions']).toEqual({ canRetryWebhook: false, canReconcile: false });
    expect(worklist(response.body, 'failed').count).toBe(1);
    expect(worklist(response.body, 'failed').items[0]?.['id']).toBe(requests.own.id);
    expect(worklist(response.body, 'stuck').count).toBe(0);
    // Connection diagnostics are readable with `connectionRead`; the retry command is not.
    expect((response.body['connections'] as Record<string, unknown>[]).some((row) => row['id'] === connectionId)).toBe(true);
    const retry = await call('POST', `/api/v1/ESignature/action/operations/webhooks/${inbox.dead}/retry`, tokenReader);
    expect(retry.status, retry.raw).toBe(403);
  });

  it('refuses the workbench to a caller without connectionRead', async () => {
    const response = await call('GET', '/api/v1/ESignature/action/operations', tokenNone);
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('AUTHORIZATION_DENIED');
  });
});

describe('guarded recovery actions (acceptance 2)', () => {
  it('retries a verified dead-letter delivery once and audits it', async () => {
    const retried = await call('POST', `/api/v1/ESignature/action/operations/webhooks/${inbox.dead}/retry`, ctx.adminToken);
    expect(retried.status, retried.raw).toBe(200);
    expect(retried.body['previousState']).toBe('dead_letter');
    expect(['ignored', 'processed']).toContain(retried.body['status']);

    const delivery = await app.get(SignatureWebhookInboxRepository).findById(inbox.dead);
    expect(['ignored', 'processed']).toContain(delivery?.state);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action', 'detail', 'connection_id'])
      .where('action', '=', 'webhook.retryRequested')
      .where('connection_id', '=', connectionId)
      .execute();
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0]?.detail)).toContain(inbox.dead);

    const again = await call('POST', `/api/v1/ESignature/action/operations/webhooks/${inbox.dead}/retry`, ctx.adminToken);
    expect([400, 422]).toContain(again.status);
  });

  it('refuses to apply an unverified delivery', async () => {
    const retried = await call('POST', `/api/v1/ESignature/action/operations/webhooks/${inbox.invalid}/retry`, ctx.adminToken);
    expect(retried.status, retried.raw).toBe(422);
    expect(errorCode(retried)).toBe('VALIDATION_FAILED');
    const delivery = await app.get(SignatureWebhookInboxRepository).findById(inbox.invalid);
    expect(delivery?.state).toBe('ignored');
  });

  it('offers no send retry route: send_unknown is reconcile-only', async () => {
    const retrySend = await call('POST', `/api/v1/ESignature/action/operations/requests/${requests.sendUnknown.id}/retry`, ctx.adminToken);
    expect(retrySend.status).toBe(404);
    const response = await call('GET', '/api/v1/ESignature/action/operations', ctx.adminToken);
    const unknownRow = worklist(response.body, 'sendUnknown').items.find((row) => row['id'] === requests.sendUnknown.id);
    expect(unknownRow?.['reconcileAllowed']).toBe(true);
  });
});

describe('a provider outage stays inside the module (acceptance 3)', () => {
  it('still answers the workbench and an ordinary CRM read after a provider error', async () => {
    await app.get(SignatureConnectionRepository).recordError(connectionId, 'AGENT_TEST_OUTAGE');
    const ops = await call('GET', '/api/v1/ESignature/action/operations', ctx.adminToken);
    expect(ops.status, ops.raw).toBe(200);
    const providerCheck = (ops.body['checks'] as { name: string; ok: boolean }[]).find((check) => check.name === 'provider_errors');
    expect(providerCheck?.ok).toBe(false);

    const health = await call('GET', '/api/v1/ESignature/action/health', ctx.adminToken);
    expect(health.status, health.raw).toBe(200);

    const accounts = await call('GET', '/api/v1/Account?limit=1', ctx.adminToken);
    expect(accounts.status, accounts.raw).toBe(200);
  });
});

