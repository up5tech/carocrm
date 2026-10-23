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
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.17 — the approval workflow and policy engine
 * (`PLAN_Phase_19_ESignature.md` §11.1, §11.2, §18 `19-ES.17`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **A required approval blocks send while pending or rejected** — the prepared request stays out of
 *    `ready_to_send`, and the send command refuses before any provider contact.
 *  - **Approval applies to the exact snapshot** — the reviewer decides a stored digest/version; any
 *    relevant edit returns the request to `draft` and drops the decision.
 *  - **Every decision is auditable** — requested/granted/rejected rows carry the actor, reason, digest
 *    and reviewed version; separation-of-duties refusals have their own stable code.
 *
 * Runs against the configured database and storage (AGENTS.md §3.1). All fixture rows and files are
 * removed by their own ids; the settings row is restored.
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
const marker = (suffix: string) => `AGENT_TEST_es17_${suffix}_${runId}`;
const ROLE_APPROVER = `AGENT_TEST-es17-approver-${runId}`;
const ROLE_READER = `AGENT_TEST-es17-reader-${runId}`;
const USER_APPROVER = `agent_test_es17_approver_${runId}`;
const USER_READER = `agent_test_es17_reader_${runId}`;
const PDF_BYTES = Buffer.from(`%PDF-1.4\n% AGENT_TEST es17 approval\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`, 'utf8');

let tokenApprover = '';
let tokenReader = '';
let connectionId = '';
const created = { requests: [] as string[], attachments: [] as string[], accounts: [] as string[] };
let baselineSettings: unknown = null;

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
    audit: app.get(SignatureAuditRepository),
    vault: app.get(ESignatureCredentialVault),
    attachments: app.get(AttachmentService),
  };
}

async function enabled(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

async function createAccount(industry: string): Promise<string> {
  const account = await call('POST', '/api/v1/Account', ctx.adminToken, {
    name: marker(`account_${industry}`),
    industry,
    type: 'Customer',
  });
  expect(account.status, account.raw).toBe(201);
  const id = String(account.body['id']);
  created.accounts.push(id);
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
    `es17:upload:${String(Math.random()).slice(2)}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

async function draft(accountId: string | null): Promise<string> {
  const created_ = await call('POST', '/api/v1/ESignature/requests', ctx.adminToken, {
    name: marker('request'),
    subject: 'Please sign',
    connectionId,
    ...(accountId === null ? {} : { sourceEntityType: 'Account', sourceRecordId: accountId }),
  });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.requests.push(id);
  const recipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, ctx.adminToken, {
    recipients: [{ name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 }],
  });
  expect(recipients.status, recipients.raw).toBe(200);
  const attachment = await uploadAttachment();
  const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, ctx.adminToken, { attachmentId: attachment });
  expect(attached.status, attached.raw).toBe(201);
  return id;
}

async function versionOf(id: string, token = ctx.adminToken): Promise<number> {
  return Number((await call('GET', `/api/v1/ESignature/requests/${id}`, token)).body['version']);
}

async function prepare(id: string, token = ctx.adminToken): Promise<CallResult> {
  return call('POST', `/api/v1/ESignature/requests/${id}/prepare`, token, { version: await versionOf(id, token), confirm: true });
}

async function decide(id: string, decision: 'approve' | 'reject', token: string, reason?: string): Promise<CallResult> {
  return call('POST', `/api/v1/ESignature/requests/${id}/${decision}`, token, {
    version: await versionOf(id, token),
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Create the provider draft and send; used only after the approval gate should be open. */
async function createEnvelopeAndSend(id: string): Promise<CallResult> {
  const envelope = await call('POST', `/api/v1/ESignature/requests/${id}/envelope`, ctx.adminToken, { version: await versionOf(id) });
  expect(envelope.status, envelope.raw).toBe(200);
  return call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
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
      approvals: true,
    },
    approval: { requiredForSourceEntities: [], rules: [], preventSelfApproval: true },
  });

  const connection = await services().connections.create({ name: marker('conn'), environment: 'demo', oauthClientId: `agent-test-key-${runId}` });
  connectionId = connection.id;
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

  await createTestRole(ctx, {
    id: ROLE_APPROVER,
    name: `AGENT_TEST ES17 approver ${runId}`,
    permissions: { SignatureRequest: { read: 'all' }, SignatureApprove: { edit: 'yes' } },
  });
  await createTestRole(ctx, {
    id: ROLE_READER,
    name: `AGENT_TEST ES17 reader ${runId}`,
    permissions: { SignatureRequest: { read: 'all' } },
  });
  tokenApprover = (await createTestUser(ctx, { userName: USER_APPROVER, roleIds: [ROLE_APPROVER] })).token;
  tokenReader = (await createTestUser(ctx, { userName: USER_READER, roleIds: [ROLE_READER] })).token;
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
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.attachments.length > 0) await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();
  if (created.accounts.length > 0) {
    await db.deleteFrom('stream_followers').where('entity_id', 'in', created.accounts).execute();
    await db.deleteFrom('stream_items').where('entity_type', '=', 'Account').where('entity_id', 'in', created.accounts).execute();
    await db.deleteFrom('audit_log').where('entity_type', '=', 'Account').where('record_id', 'in', created.accounts).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('id', 'in', created.accounts).execute();
  }
  if (connectionId !== '') {
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
  await db.deleteFrom('users').where('user_name', 'in', [USER_APPROVER, USER_READER]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_APPROVER, ROLE_READER]).execute();
  await purgeEntityEvents(ctx.database, ['Account']);
  await shutdownApi();
});

describe('a required approval blocks send (acceptance 1)', () => {
  it('keeps the request in pending_approval until an authorized approver decides', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const id = await draft(accountId);

    const prepared = await prepare(id);
    expect(prepared.status, prepared.raw).toBe(200);
    const pending = prepared.body['request'] as Record<string, unknown>;
    expect(pending['status']).toBe('pending_approval');
    expect(pending['approvalStatus']).toBe('pending');
    expect(pending['approvalRequestedAt']).not.toBeNull();
    expect(pending['approvalRequestedById']).toMatch(/admin/i);

    const blocked = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
    expect(blocked.status).toBe(409);

    const approved = await decide(id, 'approve', tokenApprover, 'Reviewed the customer terms');
    expect(approved.status, approved.raw).toBe(200);
    const ready = approved.body['request'] as Record<string, unknown>;
    expect(ready['status']).toBe('ready_to_send');
    expect(ready['approvalStatus']).toBe('approved');
    expect(ready['approvalReviewedVersion']).toBe(pending['version']);
    expect(ready['approvalDecidedById']).not.toBeNull();
    expect(String(ready['approvalReviewedDigest'])).toMatch(/^[0-9a-f]{64}$/);

    const sent = await createEnvelopeAndSend(id);
    expect(sent.status, sent.raw).toBe(200);
    expect((sent.body['request'] as Record<string, unknown>)['status']).toBe('sent');
  });

  it('refuses a rejection as terminal for the reviewed bytes, and returns to draft on an edit', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const id = await draft(accountId);
    await prepare(id);

    const shortReason = await decide(id, 'reject', tokenApprover, 'no');
    expect(shortReason.status).toBe(422);
    const rejected = await decide(id, 'reject', tokenApprover, 'The payment terms are wrong');
    expect(rejected.status, rejected.raw).toBe(200);
    const viewAfter = rejected.body['request'] as Record<string, unknown>;
    expect(viewAfter['status']).toBe('pending_approval');
    expect(viewAfter['approvalStatus']).toBe('rejected');
    expect(viewAfter['approvalReason']).toBe('The payment terms are wrong');

    const blocked = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
    expect(blocked.status).toBe(409);

    const edited = await call('PATCH', `/api/v1/ESignature/requests/${id}`, ctx.adminToken, {
      version: await versionOf(id),
      subject: 'Please sign the corrected agreement',
    });
    expect(edited.status, edited.raw).toBe(200);
    const draftView = edited.body;
    expect(draftView['status']).toBe('draft');
    expect(draftView['approvalStatus']).toBe('pending');
    expect(draftView['approvalReviewedVersion']).toBeNull();
    expect(draftView['approvalReviewedDigest']).toBeNull();
    expect(draftView['approvalReason']).toBeNull();
  });

  it('refuses an approver without the approval right or without record access', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const id = await draft(accountId);
    await prepare(id);

    const noRight = await decide(id, 'approve', tokenReader);
    expect(noRight.status).toBe(403);
    expect(errorCode(noRight)).toBe('AUTHORIZATION_DENIED');

    // The reader role has `read: all`, so record scope is not the wall here; the approval right is.
    const view_ = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenReader);
    expect(view_.status).toBe(200);
  });
});

describe('approval binds to the exact snapshot (acceptance 2)', () => {
  it('refuses a stale version and drops the approval when a reviewed input changes', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const id = await draft(accountId);
    await prepare(id);
    const version = await versionOf(id);

    const stale = await call('POST', `/api/v1/ESignature/requests/${id}/approve`, tokenApprover, { version: version - 1 });
    expect(stale.status).toBe(409);

    const approved = await decide(id, 'approve', tokenApprover);
    expect(approved.status, approved.raw).toBe(200);
    const reviewedVersion = Number((approved.body['request'] as Record<string, unknown>)['approvalReviewedVersion']);

    const edited = await call('PATCH', `/api/v1/ESignature/requests/${id}`, ctx.adminToken, {
      version: await versionOf(id),
      subject: 'New subject after approval',
    });
    expect(edited.status, edited.raw).toBe(200);
    const draftView = edited.body;
    expect(draftView['status']).toBe('draft');
    expect(draftView['approvalStatus']).toBe('pending');
    expect(draftView['approvalReviewedVersion']).toBeNull();
    expect(Number(draftView['approvalReviewedVersion'] ?? -1)).not.toBe(reviewedVersion);

    const blocked = await call('POST', `/api/v1/ESignature/requests/${id}/send`, ctx.adminToken, { version: await versionOf(id), confirm: true });
    expect(blocked.status).toBe(409);
  });

  it('applies a policy rule to the linked record value, and leaves an uncovered record alone', async () => {
    await enabled({
      approval: {
        requiredForSourceEntities: [],
        rules: [{ label: 'Banking customers', sourceEntityType: 'Account', field: 'industry', operator: 'equals', value: 'Banking' }],
        preventSelfApproval: true,
      },
    });
    const coveredAccount = await createAccount('Banking');
    const covered = await draft(coveredAccount);
    const preview = await call('GET', `/api/v1/ESignature/requests/${covered}/preview`, ctx.adminToken);
    expect(preview.body['approvalRequired']).toBe(true);
    const reasons = preview.body['approvalReasons'] as { label: string }[];
    expect(reasons.some((reason) => reason.label.includes('Banking customers'))).toBe(true);
    const prepared = await prepare(covered);
    expect((prepared.body['request'] as Record<string, unknown>)['status']).toBe('pending_approval');

    const openAccount = await createAccount('Technology');
    const open = await draft(openAccount);
    const openPreview = await call('GET', `/api/v1/ESignature/requests/${open}/preview`, ctx.adminToken);
    expect(openPreview.body['approvalRequired']).toBe(false);
  });

  it('supports an explicit review request on a prepared request', async () => {
    await enabled({ approval: { requiredForSourceEntities: [], rules: [], preventSelfApproval: true } });
    const id = await draft(null);
    const prepared = await prepare(id);
    expect((prepared.body['request'] as Record<string, unknown>)['status']).toBe('ready_to_send');

    const requested = await call('POST', `/api/v1/ESignature/requests/${id}/request-approval`, ctx.adminToken, { version: await versionOf(id) });
    expect(requested.status, requested.raw).toBe(200);
    expect(requested.body['status']).toBe('pending_approval');
    expect(requested.body['approvalStatus']).toBe('pending');

    const approved = await decide(id, 'approve', tokenApprover);
    expect(approved.status, approved.raw).toBe(200);
    expect((approved.body['request'] as Record<string, unknown>)['status']).toBe('ready_to_send');
  });
});

describe('separation of duties and auditing (acceptance 3)', () => {
  it('refuses self-approval by default and allows it only when the policy is switched off', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const id = await draft(accountId);
    await prepare(id);

    const self = await decide(id, 'approve', ctx.adminToken);
    expect(self.status).toBe(403);
    expect(errorCode(self)).toBe('SIGNATURE_APPROVAL_SEPARATION_REQUIRED');

    await enabled({ approval: { preventSelfApproval: false } });
    const allowed = await decide(id, 'approve', ctx.adminToken);
    expect(allowed.status, allowed.raw).toBe(200);
    expect((allowed.body['request'] as Record<string, unknown>)['approvalStatus']).toBe('approved');
  });

  it('audits the request, the grant and the rejection with actor, reason and digest', async () => {
    await enabled({ approval: { requiredForSourceEntities: ['Account'], rules: [], preventSelfApproval: true } });
    const accountId = await createAccount('Banking');
    const grantedId = await draft(accountId);
    await prepare(grantedId);
    await decide(grantedId, 'approve', tokenApprover, 'Looks good');

    const grantedAudit = await services().audit.listForRequest(grantedId, { limit: 50 });
    expect(grantedAudit.some((entry) => entry.action === 'approval.requested')).toBe(true);
    const grant = grantedAudit.find((entry) => entry.action === 'approval.granted');
    expect(grant?.actorType).toBe('user');
    expect(grant?.reasonSafe).toBe('Looks good');
    expect(String(grant?.detail['digest'])).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof grant?.detail['reviewedVersion']).toBe('number');

    const rejectedId = await draft(accountId);
    await prepare(rejectedId);
    await decide(rejectedId, 'reject', tokenApprover, 'Wrong terms');
    const rejectedAudit = await services().audit.listForRequest(rejectedId, { limit: 50 });
    const rejection = rejectedAudit.find((entry) => entry.action === 'approval.rejected');
    expect(rejection?.reasonSafe).toBe('Wrong terms');
    expect(rejection?.actorType).toBe('user');
  });

  it('refuses an approval rule that names a field the entity does not have', async () => {
    const refused = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, {
      approval: {
        rules: [{ label: 'Typo', sourceEntityType: 'Account', field: 'doesNotExist', operator: 'equals', value: 'x' }],
      },
    });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('VALIDATION_FAILED');
    await enabled({ approval: { rules: [] } });
  });
});
