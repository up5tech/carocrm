import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttachmentService, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { AuthenticatedPrincipal, RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { SNAPSHOT_STORAGE_ROOT } from '../src/esignature/esignature-document.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.6 — signature request draft and CRUD, through the API
 * (`PLAN_Phase_19_ESignature.md` §8.2, §11, §13.2, §18 `19-ES.6`).
 *
 * The three acceptance criteria are the spine of this file:
 *
 *  1. **A user can create, edit and view a draft** — the happy path, end to end, including documents and
 *     recipients attached through the same routes the SPA calls.
 *  2. **A sent request cannot be modified through a generic PATCH** — asserted twice: the module's own
 *     PATCH answers 409 `SIGNATURE_REQUEST_INVALID_STATE` once the request leaves the editable states,
 *     and the generic `/api/v1/:entity` route has no such entity to patch at all.
 *  3. **Linked-record ACL is enforced** — a request may not be created or re-pointed at a CRM record the
 *     caller cannot read, and the detail view never prints the name of one.
 *
 * Runs against the configured primary database and local storage (AGENTS.md §3.1). Accounts created
 * through the entity API are removed with their audit, stream and outbox rows; every request,
 * attachment, snapshot and settings change this run made is removed by its own id or run marker (§3.3).
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

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

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_es6_${suffix}_${runId}`;

const ROLE_A = `AGENT_TEST-es6-a-${runId}`;
const ROLE_B = `AGENT_TEST-es6-b-${runId}`;
const ROLE_ALL = `AGENT_TEST-es6-all-${runId}`;
const ROLE_READ = `AGENT_TEST-es6-read-${runId}`;
const USER_A = `agent_test_es6_a_${runId}`;
const USER_B = `agent_test_es6_b_${runId}`;
const USER_ALL = `agent_test_es6_all_${runId}`;
const USER_READ = `agent_test_es6_read_${runId}`;

const created = {
  requests: [] as string[],
  attachments: [] as string[],
  accounts: [] as string[],
  snapshotKeys: [] as string[],
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es6 agreement\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const PDF_HASH = createHash('sha256').update(PDF_BYTES).digest('hex');

let tokenA = '';
let tokenB = '';
let tokenAll = '';
let tokenRead = '';
let userAId = '';
let userBId = '';

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
    requests: app.get(SignatureRequestRepository),
    attachments: app.get(AttachmentService),
  };
}

async function patchSettings(patch: Record<string, unknown>): Promise<void> {
  await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, patch);
  services().settings.invalidate();
}

async function createAccount(name: string, options: { assignedUserId?: string } = {}): Promise<string> {
  const created_ = await call('POST', '/api/v1/Account', ctx.adminToken, {
    name,
    ...(options.assignedUserId === undefined ? {} : { assignedUserId: options.assignedUserId }),
  });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.accounts.push(id);
  return id;
}

/** An attachment the drafter owns, uploaded through the platform's own service under their principal. */
async function uploadAttachment(principal: AuthenticatedPrincipal, name = `${marker('doc')}.pdf`, bytes = PDF_BYTES, mimeType = 'application/pdf'): Promise<string> {
  const attachment = await scope.runAs(
    principal,
    () => services().attachments.upload({ filename: name, mimeType, body: bytes, declaredSize: bytes.byteLength }),
    `es6:upload:${randomUUID()}`,
  );
  created.attachments.push(attachment.id);
  return attachment.id;
}

let drafterPrincipal: AuthenticatedPrincipal;

function principalFor(userId: string, userName: string, roles: readonly string[]): AuthenticatedPrincipal {
  return { userId, userName, userType: 'regular', roles: [...roles], teams: [] };
}

async function createDraft(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created_ = await call('POST', '/api/v1/ESignature/requests', token, {
    name: marker('draft'),
    subject: 'Please sign the agreement',
    ...overrides,
  });
  expect(created_.status, created_.raw).toBe(201);
  const id = String(created_.body['id']);
  created.requests.push(id);
  return id;
}

let baselineSettings: unknown = null;

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baselineSettings = row?.data ?? null;

  // `own` scope on both the requests and the linked accounts: the drafting role is deliberately not an
  // administrator, so the record evaluator has something to decide.
  await createTestRole(ctx, {
    id: ROLE_A,
    name: `AGENT_TEST ES6 drafter A ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' }, Account: { read: 'own' } },
  });
  await createTestRole(ctx, {
    id: ROLE_B,
    name: `AGENT_TEST ES6 drafter B ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'own' }, Account: { read: 'own' } },
  });
  await createTestRole(ctx, {
    id: ROLE_ALL,
    name: `AGENT_TEST ES6 reader all ${runId}`,
    permissions: { SignatureRequest: { create: 'yes', read: 'all' }, Account: { read: 'all' } },
  });
  await createTestRole(ctx, { id: ROLE_READ, name: `AGENT_TEST ES6 read only ${runId}`, permissions: { SignatureRequest: { read: 'own' } } });

  const a = await createTestUser(ctx, { userName: USER_A, roleIds: [ROLE_A] });
  const b = await createTestUser(ctx, { userName: USER_B, roleIds: [ROLE_B] });
  const all = await createTestUser(ctx, { userName: USER_ALL, roleIds: [ROLE_ALL] });
  const read = await createTestUser(ctx, { userName: USER_READ, roleIds: [ROLE_READ] });
  tokenA = a.token;
  tokenB = b.token;
  tokenAll = all.token;
  tokenRead = read.token;
  userAId = a.id;
  userBId = b.id;
  drafterPrincipal = principalFor(a.id, USER_A, [ROLE_A]);

  await patchSettings({
    enabled: true,
    features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, requests: true, documents: true },
  });
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const key of created.snapshotKeys) await storage.delete(key).catch(() => undefined);
  for (const requestId of created.requests) {
    const keys = await db.selectFrom('signature_document_snapshots').select('storage_ref').where('request_id', '=', requestId).execute();
    for (const entry of keys) if (entry.storage_ref !== null) await storage.delete(String(entry.storage_ref)).catch(() => undefined);
    await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const id of created.attachments) {
    const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', id).executeTakeFirst();
    if (row?.storage_key !== undefined && row.storage_key !== null) await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  // Children before parents: the audit and snapshot rows reference the request.
  await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();

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
  await db.deleteFrom('users').where('user_name', 'in', [USER_A, USER_B, USER_ALL, USER_READ]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_A, ROLE_B, ROLE_ALL, ROLE_READ]).execute();
  await shutdownApi();
});

describe('creating, editing and viewing a draft (acceptance 1)', () => {
  it('creates a draft owned by its creator, and lists and reads it back', async () => {
    const created_ = await call('POST', '/api/v1/ESignature/requests', tokenA, {
      name: marker('first_draft'),
      subject: 'Please sign',
      message: 'Attached is the agreement.',
      emailBlurb: 'Hello',
    });
    expect(created_.status, created_.raw).toBe(201);
    const id = String(created_.body['id']);
    created.requests.push(id);
    expect(created_.body).toMatchObject({
      id,
      name: marker('first_draft'),
      status: 'draft',
      editable: true,
      version: 1,
      assignedUserId: userAId,
      createdById: userAId,
      recipients: [],
      documents: [],
      source: null,
    });

    const read = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(read.status).toBe(200);
    expect(read.body['id']).toBe(id);

    const list = await call('GET', '/api/v1/ESignature/requests?status=draft', tokenA);
    expect(list.status).toBe(200);
    const rows = list.body['list'] as { id: string }[];
    expect(rows.map((row) => row.id)).toContain(id);

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select(['action'])
      .where('request_id', '=', id)
      .execute();
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(['request.created']));
  });

  it('edits the draft with its version, and refuses a stale one', async () => {
    const id = await createDraft(tokenA, { name: marker('editable') });
    const edited = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, {
      version: 1,
      name: marker('edited'),
      subject: 'Updated subject',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(edited.status, edited.raw).toBe(200);
    expect(edited.body).toMatchObject({ name: marker('edited'), subject: 'Updated subject', version: 2 });
    expect(edited.body['expiresAt']).toContain('2026-12-31');

    const stale = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: 1, name: marker('stale') });
    expect(stale.status).toBe(409);
    const current = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(current.body['name']).toBe(marker('edited'));

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('request_id', '=', id)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('request.updated');
  });

  it('refuses a server-owned field and an invalid body', async () => {
    const id = await createDraft(tokenA, { name: marker('guarded') });
    const status = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: 1, status: 'completed' });
    expect(status.status).toBe(400);
    expect(errorCode(status)).toBe('INVALID_QUERY');

    const empty = await call('POST', '/api/v1/ESignature/requests', tokenA, { name: '' });
    expect(empty.status).toBe(400);

    const nothing = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: 1 });
    expect(nothing.status).toBe(400);
  });

  it('records who the request is assigned to when an editor reassigns it', async () => {
    const id = await createDraft(tokenA, { name: marker('assign') });
    const reassigned = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: 1, assignedUserId: userAId });
    expect(reassigned.status, reassigned.raw).toBe(200);
    expect(reassigned.body['assignedUserId']).toBe(userAId);
  });
});

describe('linked CRM records (acceptance 3)', () => {
  it('accepts a source record the caller can read and shows its name', async () => {
    const account = await createAccount(marker('account_own'), { assignedUserId: userAId });
    const id = await createDraft(tokenA, { name: marker('linked'), sourceEntityType: 'Account', sourceRecordId: account });
    const view = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(view.status).toBe(200);
    expect(view.body['source']).toMatchObject({ entityType: 'Account', recordId: account, accessible: true, missing: false });
    expect(String((view.body['source'] as { label: string }).label)).toContain(marker('account_own'));

    // The link can be cleared again; a draft without a source is valid.
    const cleared = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, {
      version: 1,
      sourceEntityType: null,
      sourceRecordId: null,
    });
    expect(cleared.status, cleared.raw).toBe(200);
    expect(cleared.body['source']).toBeNull();
  });

  it('refuses a source record the caller cannot read, on create and on re-point', async () => {
    // Owned by B: A's `Account: own` scope cannot read it.
    const foreign = await createAccount(marker('account_foreign'), { assignedUserId: userBId });
    const denied = await call('POST', '/api/v1/ESignature/requests', tokenA, {
      name: marker('denied_link'),
      sourceEntityType: 'Account',
      sourceRecordId: foreign,
    });
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('AUTHORIZATION_DENIED');
    expect(denied.raw).not.toContain(marker('account_foreign'));

    const id = await createDraft(tokenA, { name: marker('repoint') });
    const refused = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, {
      version: 1,
      sourceEntityType: 'Account',
      sourceRecordId: foreign,
    });
    expect(refused.status).toBe(403);
    const unchanged = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(unchanged.body['source']).toBeNull();
  });

  it('reports a linked record it may not read without leaking its name, and a missing one as missing', async () => {
    const account = await createAccount(marker('account_later'), { assignedUserId: userAId });
    const id = await createDraft(tokenA, { name: marker('scope_shift'), sourceEntityType: 'Account', sourceRecordId: account });
    // The record moves to B; A's request is still A's, but the linked record no longer is.
    const moved = await call('PATCH', `/api/v1/Account/${account}`, ctx.adminToken, { assignedUserId: userBId });
    expect(moved.status, moved.raw).toBe(200);
    const view = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(view.status).toBe(200);
    expect(view.body['source']).toMatchObject({ entityType: 'Account', recordId: account, accessible: false, missing: false, label: null });

    // A deleted source leaves the request readable and says so.
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('id', '=', account).execute();
    const missing = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenA);
    expect(missing.body['source']).toMatchObject({ recordId: account, accessible: false, missing: true });
  });

  it('refuses a source that is not a metadata entity, and one that does not exist', async () => {
    const notAnEntity = await call('POST', '/api/v1/ESignature/requests', tokenA, {
      name: marker('bad_entity'),
      sourceEntityType: 'NotAnEntity',
      sourceRecordId: 'x',
    });
    expect(notAnEntity.status).toBe(422);
    expect(errorCode(notAnEntity)).toBe('VALIDATION_FAILED');

    const missingRecord = await call('POST', '/api/v1/ESignature/requests', tokenA, {
      name: marker('bad_record'),
      sourceEntityType: 'Account',
      sourceRecordId: `does-not-exist-${runId}`,
    });
    expect(missingRecord.status).toBe(422);
  });
});

describe('record scope on the requests themselves (plan §11)', () => {
  it('hides one drafter’s request from another, and shows it to an "all" reader', async () => {
    const id = await createDraft(tokenA, { name: marker('private') });
    const foreignRead = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenB);
    expect(foreignRead.status).toBe(403);
    expect(errorCode(foreignRead)).toBe('AUTHORIZATION_DENIED');
    const foreignEdit = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenB, { version: 1, name: marker('hijack') });
    expect(foreignEdit.status).toBe(403);
    const foreignList = await call('GET', '/api/v1/ESignature/requests?limit=200', tokenB);
    expect((foreignList.body['list'] as { id: string }[]).map((row) => row.id)).not.toContain(id);

    const allRead = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenAll);
    expect(allRead.status).toBe(200);
    const allList = await call('GET', '/api/v1/ESignature/requests?limit=200', tokenAll);
    expect((allList.body['list'] as { id: string }[]).map((row) => row.id)).toContain(id);
  });

  it('separates the read right from the drafting right', async () => {
    const id = await createDraft(tokenA, { name: marker('readonly') });
    const read = await call('GET', `/api/v1/ESignature/requests/${id}`, tokenRead);
    // The read-only role's `own` scope does not include A's request — the record scope decides.
    expect(read.status).toBe(403);
    const create = await call('POST', '/api/v1/ESignature/requests', tokenRead, { name: marker('no_draft_right') });
    expect(create.status).toBe(403);
  });

  it('applies the same scope to recipients and documents', async () => {
    const id = await createDraft(tokenA, { name: marker('scope_children') });
    expect((await call('GET', `/api/v1/ESignature/requests/${id}/recipients`, tokenB)).status).toBe(403);
    expect((await call('GET', `/api/v1/ESignature/requests/${id}/documents`, tokenB)).status).toBe(403);
    const foreignRecipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenB, {
      recipients: [{ name: 'X', email: 'x@example.invalid', routingOrder: 1 }],
    });
    expect(foreignRecipients.status).toBe(403);
    expect((await call('GET', `/api/v1/ESignature/requests/${id}/recipients`, tokenA)).status).toBe(200);
    expect((await call('GET', `/api/v1/ESignature/requests/${id}/documents`, tokenA)).status).toBe(200);
  });
});

describe('a request that has left the draft (acceptance 2)', () => {
  it('refuses module edits and child changes once the request is sending', async () => {
    const id = await createDraft(tokenA, { name: marker('frozen') });
    const draft = await services().requests.requireById(id);
    const ready = await services().requests.transition(id, { expectedVersion: draft.version, to: 'ready_to_send', origin: 'local' });
    // Still editable while it is merely ready to send.
    const stillEditable = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: ready.version, subject: 'reviewed' });
    expect(stillEditable.status, stillEditable.raw).toBe(200);
    const sending = await services().requests.transition(id, { expectedVersion: Number(stillEditable.body['version']), to: 'sending', origin: 'local' });

    const patch = await call('PATCH', `/api/v1/ESignature/requests/${id}`, tokenA, { version: sending.version, subject: 'too late' });
    expect(patch.status).toBe(409);
    expect(errorCode(patch)).toBe('SIGNATURE_REQUEST_INVALID_STATE');

    const recipients = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenA, {
      recipients: [{ name: 'Late Signer', email: 'late@example.invalid', routingOrder: 1 }],
    });
    expect(recipients.status).toBe(409);
    expect(errorCode(recipients)).toBe('SIGNATURE_REQUEST_INVALID_STATE');

    const attachment = await uploadAttachment(drafterPrincipal, `${marker('late')}.pdf`);
    const document = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, tokenA, { attachmentId: attachment });
    expect(document.status).toBe(409);
  });

  it('has no generic entity route to reach a signature request through', async () => {
    const id = await createDraft(tokenA, { name: marker('generic') });
    const genericPatch = await call('PATCH', `/api/v1/SignatureRequest/${id}`, ctx.adminToken, { status: 'completed' });
    expect(genericPatch.status).toBe(404);
    const genericGet = await call('GET', `/api/v1/SignatureRequest/${id}`, ctx.adminToken);
    expect(genericGet.status).toBe(404);
    const row = await ctx.database.db.selectFrom('signature_requests').select(['status', 'version']).where('id', '=', id).executeTakeFirst();
    expect(row?.status).toBe('draft');
    expect(row?.version).toBe(1);
  });
});

describe('recipients on a draft', () => {
  it('replaces the whole set and validates it', async () => {
    const id = await createDraft(tokenA, { name: marker('recipients') });
    const replaced = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenA, {
      recipients: [
        { name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1 },
        { name: 'Copy Two', email: 'two@example.invalid', recipientType: 'carbon_copy', routingOrder: 2 },
      ],
    });
    expect(replaced.status, replaced.raw).toBe(200);
    const stored = await call('GET', `/api/v1/ESignature/requests/${id}/recipients`, tokenA);
    expect((stored.body as unknown as { name: string }[]).map((entry) => entry.name)).toEqual(['Signer One', 'Copy Two']);

    const invalidEmail = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenA, {
      recipients: [{ name: 'No Mail', email: 'not-an-email', routingOrder: 1 }],
    });
    expect(invalidEmail.status).toBe(400);
    const empty = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenA, { recipients: [] });
    expect(empty.status).toBe(400);

    const duplicatedRole = await call('PUT', `/api/v1/ESignature/requests/${id}/recipients`, tokenA, {
      recipients: [
        { name: 'A', email: 'a@example.invalid', routingOrder: 1, roleName: 'signer1' },
        { name: 'B', email: 'b@example.invalid', routingOrder: 2, roleName: 'signer1' },
      ],
    });
    expect(duplicatedRole.status).toBe(422);
    expect(errorDetails(duplicatedRole)['code']).toBe('RECIPIENT_NOT_AUTHORIZED');

    const audit = await ctx.database.db
      .selectFrom('signature_audit_entries')
      .select('action')
      .where('request_id', '=', id)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('recipients.changed');
  });
});

describe('documents on a draft', () => {
  it('attaches, lists, downloads and detaches a snapshotted document', async () => {
    const id = await createDraft(tokenA, { name: marker('documents') });
    const attachment = await uploadAttachment(drafterPrincipal, `${marker('agreement')}.pdf`);
    const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, tokenA, { attachmentId: attachment });
    expect(attached.status, attached.raw).toBe(201);
    expect(attached.body).toMatchObject({
      artifactKind: 'source_snapshot',
      displayName: `${marker('agreement')}.pdf`,
      mimeType: 'application/pdf',
      byteSize: PDF_BYTES.byteLength,
      contentHashSha256: PDF_HASH,
      documentOrder: 1,
    });
    const documentId = String(attached.body['id']);

    const listed = await call('GET', `/api/v1/ESignature/requests/${id}/documents`, tokenA);
    expect((listed.body as unknown as { id: string }[]).map((entry) => entry.id)).toEqual([documentId]);

    const download = await call('GET', `/api/v1/ESignature/requests/${id}/documents/${documentId}/content`, tokenA);
    expect(download.status).toBe(200);
    expect(Buffer.from(download.raw, 'utf8').equals(PDF_BYTES)).toBe(true);

    const detached = await call('DELETE', `/api/v1/ESignature/requests/${id}/documents/${documentId}`, tokenA);
    expect(detached.status, detached.raw).toBe(200);
    const after = await call('GET', `/api/v1/ESignature/requests/${id}/documents`, tokenA);
    expect(after.body as unknown as unknown[]).toHaveLength(0);
  });

  it('refuses a document type the policy does not allow, and a document from another request', async () => {
    const id = await createDraft(tokenA, { name: marker('doc_policy') });
    const note = await uploadAttachment(drafterPrincipal, `${marker('note')}.txt`, Buffer.from('just a note'), 'text/plain');
    const refused = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, tokenA, { attachmentId: note });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('SIGNATURE_DOCUMENT_NOT_READABLE');

    const otherId = await createDraft(tokenA, { name: marker('doc_other') });
    const attachment = await uploadAttachment(drafterPrincipal, `${marker('other')}.pdf`);
    const attached = await call('POST', `/api/v1/ESignature/requests/${otherId}/documents`, tokenA, { attachmentId: attachment });
    const documentId = String(attached.body['id']);
    const wrongRequest = await call('GET', `/api/v1/ESignature/requests/${id}/documents/${documentId}/content`, tokenA);
    expect(wrongRequest.status).toBe(422);
    expect(errorCode(wrongRequest)).toBe('VALIDATION_FAILED');
  });

  it('replaces the file in a slot without rewriting the previous snapshot', async () => {
    const id = await createDraft(tokenA, { name: marker('doc_replace') });
    const first = await uploadAttachment(drafterPrincipal, `${marker('first')}.pdf`);
    const second = await uploadAttachment(drafterPrincipal, `${marker('second')}.pdf`, Buffer.concat([PDF_BYTES, Buffer.from('% second\n')]));
    const attached = await call('POST', `/api/v1/ESignature/requests/${id}/documents`, tokenA, { attachmentId: first });
    const replaced = await call('PUT', `/api/v1/ESignature/requests/${id}/documents/order/1`, tokenA, { attachmentId: second });
    expect(replaced.status, replaced.raw).toBe(200);
    expect(replaced.body['documentOrder']).toBe(1);
    expect(replaced.body['contentHashSha256']).not.toBe(attached.body['contentHashSha256']);
    const rows = await ctx.database.db
      .selectFrom('signature_document_snapshots')
      .select(['id', 'deleted_at'])
      .where('request_id', '=', id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deleted_at !== null)).toHaveLength(1);
  });
});

describe('the list query (plan §13.2)', () => {
  it('filters by status and refuses a status the module does not know', async () => {
    await createDraft(tokenA, { name: marker('filter') });
    const drafts = await call('GET', '/api/v1/ESignature/requests?status=draft&limit=200', tokenA);
    expect(drafts.status).toBe(200);
    expect((drafts.body['list'] as { status: string }[]).every((row) => row.status === 'draft')).toBe(true);
    expect(Number(drafts.body['total'])).toBeGreaterThanOrEqual(1);

    const unknown = await call('GET', '/api/v1/ESignature/requests?status=not-a-status', tokenA);
    expect(unknown.status).toBe(400);

    const attention = await call('GET', '/api/v1/ESignature/requests?needsAttention=true', tokenA);
    expect(attention.status).toBe(200);
    expect(attention.body['list']).toEqual([]);

    const paged = await call('GET', '/api/v1/ESignature/requests?limit=1&offset=0', tokenA);
    expect((paged.body['list'] as unknown[]).length).toBeLessThanOrEqual(1);
    const bad = await call('GET', '/api/v1/ESignature/requests?limit=0', tokenA);
    expect(bad.status).toBe(400);
  });
});
