import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AttachmentDto,AttachmentService, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { AuthenticatedPrincipal, RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { ESignatureDocumentService, extensionOf, SNAPSHOT_STORAGE_ROOT } from '../src/esignature/esignature-document.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS, type ESignatureSettings,ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { SignatureDocumentSnapshotRepository } from '../src/esignature/signature-document-snapshot.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.5 — the secure document snapshot service, against the configured database and the
 * configured file storage (`PLAN_Phase_19_ESignature.md` §4.5, §6.3, §12.9, §18 `19-ES.5`).
 *
 * The three acceptance criteria are the three things this file is built to prove:
 *
 *  - **A provider result cannot overwrite a source file.** Asserted by *changing the source* after the
 *    snapshot and reading the snapshot back, and by storing a derived artifact whose bytes are
 *    identical to the source and checking that the source object is untouched.
 *  - **The snapshot hash is the hash of the exact submitted bytes.** Asserted against an independent
 *    SHA-256 of the bytes the test wrote, and against a source whose bytes later differ.
 *  - **An unauthorized source document cannot be attached.** Asserted with a real second user who
 *    holds the drafting right but cannot read the attachment — and that the refusal happens before any
 *    byte is copied.
 *
 * No database, schema or container is created (AGENTS.md §3.1). Every attachment, snapshot object,
 * request and audit row this run makes is removed by its own id in `afterAll`, and the `ESignature`
 * settings row is restored exactly as it was found (§3.3).
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

let ctx: ApiContext;
let app: NestFastifyApplication;
let storage: FileStorage;
let scope: RequestScope;

const runId = `es5${Date.now().toString(36)}`;
const marker = (suffix: string) => `AGENT_TEST_${runId}_${suffix}`;
const ROLE_DRAFT = `AGENT_TEST-es5-draft-${runId}`;
const USER_DRAFT = `agent_test_es5_draft_${runId}`;
const ROLE_USE = `AGENT_TEST-es5-use-${runId}`;
const USER_USE = `agent_test_es5_use_${runId}`;

const created = {
  attachments: [] as string[],
  requests: [] as string[],
  keys: [] as string[],
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es5 source document\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const PDF_TWO_BYTES = Buffer.from('%PDF-1.4\n% AGENT_TEST es5 second document\n2 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const PDF_HASH = createHash('sha256').update(PDF_BYTES).digest('hex');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function services() {
  return {
    documents: app.get(ESignatureDocumentService),
    attachments: app.get(AttachmentService),
    requests: app.get(SignatureRequestRepository),
    snapshots: app.get(SignatureDocumentSnapshotRepository),
    audit: app.get(SignatureAuditRepository),
    settings: app.get(ESignatureSettingsService),
  };
}

/** A principal with the named roles, so a service call runs as that user. */
function principalFor(input: { userId: string; userName: string; roles: readonly string[]; admin?: boolean }): AuthenticatedPrincipal {
  return {
    userId: input.userId,
    userName: input.userName,
    userType: input.admin === true ? 'admin' : 'regular',
    roles: [...input.roles],
    teams: [],
  };
}

function as<T>(principal: AuthenticatedPrincipal, label: string, work: () => Promise<T>): Promise<T> {
  // A unique request id per call: the ACL snapshot is cached against it, and each call here must see
  // the roles of the principal it names.
  return scope.runAs(principal, work, `es5:${label}:${randomUUID()}`);
}

let adminPrincipal: AuthenticatedPrincipal;
let draftPrincipal: AuthenticatedPrincipal;
let usePrincipal: AuthenticatedPrincipal;

async function upload(input: { name: string; mimeType: string; bytes: Buffer; principal: AuthenticatedPrincipal }): Promise<AttachmentDto> {
  const attachment = await as(input.principal, `upload-${input.name}`, () =>
    services().attachments.upload({ filename: input.name, mimeType: input.mimeType, body: input.bytes, declaredSize: input.bytes.byteLength }),
  );
  created.attachments.push(attachment.id);
  return attachment;
}

async function newDraft(suffix: string): Promise<string> {
  const draft = await services().requests.createDraft({
    name: marker(`draft_${suffix}`),
    subject: 'Please sign the agreement',
    createdById: 'admin',
  });
  created.requests.push(draft.id);
  return draft.id;
}

async function pdfAttachment(suffix: string, bytes = PDF_BYTES, principal = adminPrincipal): Promise<AttachmentDto> {
  return upload({ name: `${marker(suffix)}.pdf`, mimeType: 'application/pdf', bytes, principal });
}

async function storedKeys(requestId: string): Promise<string[]> {
  const rows = await ctx.database.db
    .selectFrom('signature_document_snapshots')
    .select(['storage_ref'])
    .where('request_id', '=', requestId)
    .execute();
  return rows.map((row) => String(row.storage_ref));
}

let baselineSettings: unknown = null;

async function patchSettings(patch: Record<string, unknown>): Promise<void> {
  await ctx.app
    .inject({ method: 'POST', url: '/api/v1/ESignature/action/settings', headers: { authorization: `Bearer ${ctx.adminToken}` }, payload: patch })
    .then(() => services().settings.invalidate());
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
  scope = app.get(REQUEST_SCOPE_TOKEN);
  adminPrincipal = principalFor({ userId: 'admin', userName: 'admin', roles: ['sysAdmin'], admin: true });

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst();
  baselineSettings = row?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_DRAFT,
    name: `AGENT_TEST ES5 draft ${runId}`,
    permissions: { SignatureRequest: { read: 'yes', create: 'yes' } },
  });
  await createTestRole(ctx, { id: ROLE_USE, name: `AGENT_TEST ES5 use ${runId}`, permissions: { SignatureRequest: { read: 'yes' } } });
  const drafter = await createTestUser(ctx, { userName: USER_DRAFT, roleIds: [ROLE_DRAFT] });
  const reader = await createTestUser(ctx, { userName: USER_USE, roleIds: [ROLE_USE] });
  draftPrincipal = principalFor({ userId: drafter.id, userName: USER_DRAFT, roles: [ROLE_DRAFT] });
  usePrincipal = principalFor({ userId: reader.id, userName: USER_USE, roles: [ROLE_USE] });

  await patchSettings({ enabled: true, features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, documents: true } });
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const key of created.keys) await storage.delete(key).catch(() => undefined);
  // The snapshot objects live under the request's own prefix; remove anything still there.
  for (const requestId of created.requests) {
    for (const key of await storedKeys(requestId)) await storage.delete(key).catch(() => undefined);
    // The request's own snapshot directory, empty or not: this module wrote it, this run removes it.
    await rm(resolve(ctx.config.storageRoot, join(SNAPSHOT_STORAGE_ROOT, requestId)), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const attachment of created.attachments) {
    const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', attachment).executeTakeFirst();
    if (row?.storage_key !== undefined && row.storage_key !== null) await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  // Children first: the audit and snapshot rows reference the request.
  await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
  await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  await db.deleteFrom('attachments').where('id', 'in', created.attachments).execute();
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
  await db.deleteFrom('users').where('user_name', 'in', [USER_DRAFT, USER_USE]).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_DRAFT, ROLE_USE]).execute();
  await shutdownApi();
});

describe('the document policy (plan §4.5, §12.9)', () => {
  const settings = DEFAULT_ESIGNATURE_SETTINGS;
  const base = { displayName: 'agreement.pdf', mimeType: 'application/pdf', byteSize: 1024, existingDocuments: 0 };
  const issue = (over: Partial<typeof base>, at: ESignatureSettings = settings) =>
    ESignatureDocumentService.policyIssue({ ...base, ...over }, at);

  it('accepts a PDF and refuses what the settings allowlist does not name', () => {
    expect(issue({})).toBeNull();
    expect(issue({ displayName: 'notes.txt', mimeType: 'text/plain' })?.reason).toBe('type_not_allowed');
    expect(issue({ displayName: 'agreement.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
    expect(issue({ displayName: 'archive.zip', mimeType: 'application/zip' })?.reason).toBe('type_not_allowed');
  });

  it('refuses an extension the provider cannot sign even when an administrator allowlisted it', () => {
    const widened: ESignatureSettings = {
      ...settings,
      documents: { ...settings.documents, allowedExtensions: ['pdf', 'zip', 'exe'] },
    };
    const refusal = issue({ displayName: 'payload.zip', mimeType: 'application/zip' }, widened);
    expect(refusal?.reason).toBe('type_not_allowed');
    expect(String(refusal?.message)).toContain('Allowed: pdf, zip, exe');
  });

  it('refuses a declared type that contradicts the extension', () => {
    expect(issue({ displayName: 'invoice.pdf', mimeType: 'text/html' })?.reason).toBe('type_not_allowed');
    expect(issue({ displayName: 'invoice.pdf', mimeType: 'APPLICATION/PDF' })).toBeNull();
  });

  it('applies the tighter of the installation ceiling and the provider ceiling', () => {
    const tightened: ESignatureSettings = { ...settings, documents: { ...settings.documents, maxDocumentBytes: 2_048 } };
    expect(issue({ byteSize: 4_096 }, tightened)?.reason).toBe('too_large');
    expect(issue({ byteSize: 1_024 }, tightened)).toBeNull();
    // A settings value above the provider's own ceiling does not raise it.
    const loosened: ESignatureSettings = { ...settings, documents: { ...settings.documents, maxDocumentBytes: 500_000_000 } };
    expect(issue({ byteSize: 30_000_000 }, loosened)?.reason).toBe('too_large');
    expect(issue({ byteSize: 20_000_000 }, loosened)).toBeNull();
  });

  it('counts documents against the request limit and refuses an empty file', () => {
    const two: ESignatureSettings = { ...settings, documents: { ...settings.documents, maxDocumentsPerRequest: 2 } };
    expect(issue({ existingDocuments: 1 }, two)).toBeNull();
    expect(issue({ existingDocuments: 2 }, two)?.reason).toBe('too_many');
    expect(issue({ byteSize: 0 })?.reason).toBe('empty');
  });

  it('reads an extension off a name without letting a path through', () => {
    expect(extensionOf('Quarterly Agreement.PDF')).toBe('pdf');
    expect(extensionOf('../../etc/passwd')).toBe('');
    expect(extensionOf('../../etc/signed.exe')).toBe('exe');
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('keeps source snapshots and derived artifacts under different prefixes', () => {
    const source = ESignatureDocumentService.storageKey('req-1', 'source_snapshot', 'snap-1', 'a.pdf');
    const signed = ESignatureDocumentService.storageKey('req-1', 'provider_signed_document', 'snap-2', 'a.pdf');
    const evidence = ESignatureDocumentService.storageKey('req-1', 'completion_evidence', 'snap-3', 'a.pdf');
    expect(source.startsWith(`${SNAPSHOT_STORAGE_ROOT}/req-1/source/`)).toBe(true);
    expect(signed.startsWith(`${SNAPSHOT_STORAGE_ROOT}/req-1/derived/`)).toBe(true);
    expect(evidence.startsWith(`${SNAPSHOT_STORAGE_ROOT}/req-1/derived/`)).toBe(true);
    // The provider artifact's id is its own, so no derived key can resolve to a source object.
    expect(signed).not.toBe(source);
    expect(ESignatureDocumentService.storageKey('req-2', 'source_snapshot', 'snap-1', 'a.pdf')).not.toBe(source);
  });
});

describe('snapshotting a source document (plan §4.5, §6.3)', () => {
  it('copies the bytes, records their SHA-256, and reads back exactly what was submitted', async () => {
    const { documents } = services();
    const requestId = await newDraft('snapshot');
    const attachment = await pdfAttachment('snapshot_src');

    const result = await as(adminPrincipal, 'attach', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    created.keys.push(result.snapshot.storageRef ?? '');
    expect(result.created).toBe(true);
    expect(result.snapshot).toMatchObject({
      requestId,
      artifactKind: 'source_snapshot',
      sourceAttachmentId: attachment.id,
      mimeType: 'application/pdf',
      byteSize: PDF_BYTES.byteLength,
      contentHashSha256: PDF_HASH,
      documentOrder: 1,
      retentionClass: 'business',
    });
    // The attachment's own checksum is the immutable reference the snapshot was taken from.
    expect(result.snapshot.sourceVersionId).toBe(attachment.checksum);
    expect(sha256(PDF_BYTES)).toBe(PDF_HASH);

    const opened = await as(adminPrincipal, 'open', () => documents.openSnapshot(result.snapshot.id));
    expect(opened.bytes.equals(PDF_BYTES)).toBe(true);

    const listed = await as(adminPrincipal, 'list', () => documents.listDocuments(requestId));
    expect(listed.map((entry) => entry.id)).toEqual([result.snapshot.id]);
    const audit = await services().audit.listForRequest(requestId);
    expect(audit.map((entry) => entry.action)).toContain('documents.changed');
    expect(JSON.stringify(audit.map((entry) => entry.detail))).not.toContain(PDF_BYTES.toString('utf8').slice(0, 24));
  });

  it('numbers the documents in submission order and is idempotent per attachment', async () => {
    const { documents } = services();
    const requestId = await newDraft('order');
    const first = await pdfAttachment('order_a');
    const second = await pdfAttachment('order_b', PDF_TWO_BYTES);

    const a = await as(adminPrincipal, 'attach-a', () => documents.attachAttachment({ requestId, attachmentId: first.id }));
    const aAgain = await as(adminPrincipal, 'attach-a-again', () => documents.attachAttachment({ requestId, attachmentId: first.id }));
    const b = await as(adminPrincipal, 'attach-b', () => documents.attachAttachment({ requestId, attachmentId: second.id }));
    expect(aAgain.snapshot.id).toBe(a.snapshot.id);
    expect(aAgain.created).toBe(false);
    expect(b.snapshot.documentOrder).toBe(2);
    const listed = await as(adminPrincipal, 'list', () => documents.listDocuments(requestId));
    expect(listed.map((entry) => entry.documentOrder)).toEqual([1, 2]);
    created.keys.push(a.snapshot.storageRef ?? '', b.snapshot.storageRef ?? '');
  });

  it('stores one object when two different attachments carry the same bytes', async () => {
    const { documents } = services();
    const requestId = await newDraft('dedupe');
    const first = await pdfAttachment('dedupe_a');
    const twin = await pdfAttachment('dedupe_b');
    const a = await as(adminPrincipal, 'dedupe-a', () => documents.attachAttachment({ requestId, attachmentId: first.id }));
    const b = await as(adminPrincipal, 'dedupe-b', () => documents.attachAttachment({ requestId, attachmentId: twin.id, documentOrder: 2 }));
    created.keys.push(a.snapshot.storageRef ?? '', b.snapshot.storageRef ?? '');
    expect(b.snapshot.contentHashSha256).toBe(a.snapshot.contentHashSha256);
    // The second call found the existing row and removed the redundant copy it had just written.
    expect(b.created).toBe(false);
    expect(b.snapshot.storageRef).toBe(a.snapshot.storageRef);
    if (b.snapshot.storageRef !== null && b.snapshot.storageRef !== a.snapshot.storageRef) {
      expect(await storage.exists(b.snapshot.storageRef)).toBe(false);
    }
  });

  it('keeps the snapshot when the source file is replaced, and when it is deleted', async () => {
    const { documents, attachments } = services();
    const requestId = await newDraft('immutable');
    const attachment = await pdfAttachment('immutable_src');
    const result = await as(adminPrincipal, 'attach', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    created.keys.push(result.snapshot.storageRef ?? '');
    const snapshotKey = result.snapshot.storageRef ?? '';

    // (1) the bytes behind the attachment are replaced in storage — what a careless re-upload does;
    const sourceKey = await attachmentKey(attachment.id);
    await storage.put({ key: sourceKey, body: Buffer.from('%PDF-1.4 replaced under the request'), contentType: 'application/pdf' });
    const stored = await storage.get(sourceKey);
    expect(stored.byteLength).not.toBe(PDF_BYTES.byteLength);
    const afterReplacement = await as(adminPrincipal, 'open-1', () => documents.openSnapshot(result.snapshot.id));
    expect(afterReplacement.bytes.equals(PDF_BYTES)).toBe(true);
    expect(afterReplacement.snapshot.contentHashSha256).toBe(PDF_HASH);

    // (2) the source attachment is deleted outright — the snapshot is still the evidence.
    await as(adminPrincipal, 'remove', () => attachments.remove(attachment.id));
    const afterDelete = await as(adminPrincipal, 'open-2', () => documents.openSnapshot(result.snapshot.id));
    expect(afterDelete.bytes.equals(PDF_BYTES)).toBe(true);
    expect(await storage.exists(snapshotKey)).toBe(true);
  });

  it('refuses a source whose bytes no longer match its recorded checksum', async () => {
    const { documents } = services();
    const requestId = await newDraft('checksum');
    const attachment = await pdfAttachment('checksum_src');
    const key = await attachmentKey(attachment.id);
    await storage.put({ key, body: Buffer.from('%PDF-1.4 tampered after upload'), contentType: 'application/pdf' });

    await expect(as(adminPrincipal, 'attach-tampered', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_DOCUMENT_NOT_READABLE',
    });
    const listed = await as(adminPrincipal, 'list', () => documents.listDocuments(requestId));
    expect(listed).toHaveLength(0);
    // Nothing was left behind by the refused copy.
    expect(await storedKeys(requestId)).toHaveLength(0);
  });

  it('refuses a document the policy rejects, before reading any bytes', async () => {
    const { documents } = services();
    const requestId = await newDraft('policy');
    const note = await upload({ name: `${marker('policy_note')}.txt`, mimeType: 'text/plain', bytes: Buffer.from('please sign'), principal: adminPrincipal });
    await expect(as(adminPrincipal, 'attach-txt', () => documents.attachAttachment({ requestId, attachmentId: note.id }))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_DOCUMENT_NOT_READABLE',
    });
    expect(await storedKeys(requestId)).toHaveLength(0);
  });

  it('enforces the document count through the service', async () => {
    const { documents } = services();
    await patchSettings({ documents: { maxDocumentsPerRequest: 1 } });
    const requestId = await newDraft('count');
    const first = await pdfAttachment('count_a');
    const second = await pdfAttachment('count_b', PDF_TWO_BYTES);
    await as(adminPrincipal, 'count-1', () => documents.attachAttachment({ requestId, attachmentId: first.id }));
    await expect(as(adminPrincipal, 'count-2', () => documents.attachAttachment({ requestId, attachmentId: second.id }))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_DOCUMENT_NOT_READABLE',
    });
    await patchSettings({ documents: { maxDocumentsPerRequest: DEFAULT_ESIGNATURE_SETTINGS.documents.maxDocumentsPerRequest } });
  });
});

describe('who may put a document into a request (plan §12, §4.5)', () => {
  it('refuses a source document the caller cannot read, and copies nothing', async () => {
    const { documents } = services();
    const requestId = await newDraft('acl');
    // Admin owns this file: a different user holds the drafting right but not read access to it.
    const attachment = await pdfAttachment('acl_private');
    await expect(as(draftPrincipal, 'attach-foreign', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }))).rejects.toMatchObject({
      name: 'AuthorizationDeniedError',
    });
    expect(await storedKeys(requestId)).toHaveLength(0);
    const listed = await ctx.database.db
      .selectFrom('signature_document_snapshots')
      .select('id')
      .where('request_id', '=', requestId)
      .execute();
    expect(listed).toHaveLength(0);
  });

  it('lets that same user attach a file they can read', async () => {
    const { documents } = services();
    const requestId = await newDraft('acl_allowed');
    const own = await pdfAttachment('acl_own', PDF_BYTES, draftPrincipal);
    const result = await as(draftPrincipal, 'attach-own', () => documents.attachAttachment({ requestId, attachmentId: own.id }));
    created.keys.push(result.snapshot.storageRef ?? '');
    expect(result.snapshot.sourceAttachmentId).toBe(own.id);
  });

  it('requires the drafting right to change a request’s documents and the read right to list them', async () => {
    const { documents } = services();
    const requestId = await newDraft('rights');
    const attachment = await pdfAttachment('rights_src');
    await expect(as(usePrincipal, 'attach-without-draft-right', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }))).rejects.toMatchObject({
      name: 'AuthorizationDeniedError',
    });
    // `use` is enough to read the list, and the list is empty because nothing was attached.
    const listed = await as(usePrincipal, 'list-with-use', () => documents.listDocuments(requestId));
    expect(listed).toEqual([]);
  });

  it('refuses everything while the module or the documents feature is off', async () => {
    const { documents } = services();
    const requestId = await newDraft('disabled');
    const attachment = await pdfAttachment('disabled_src');
    await patchSettings({ enabled: false });
    await expect(as(adminPrincipal, 'attach-disabled', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_MODULE_DISABLED',
    });
    await patchSettings({ enabled: true, features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, documents: false } });
    await expect(as(adminPrincipal, 'attach-no-feature', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_MODULE_DISABLED',
    });
    await patchSettings({ enabled: true, features: { ...DEFAULT_ESIGNATURE_SETTINGS.features, documents: true } });
  });

  it('will not change the documents of a request that is no longer a draft', async () => {
    const { documents, requests } = services();
    const requestId = await newDraft('sent');
    const attachment = await pdfAttachment('sent_src');
    const draft = await requests.requireById(requestId);
    const ready = await requests.transition(requestId, { expectedVersion: draft.version, to: 'ready_to_send', origin: 'local' });
    // Ready to send is still editable; sending is not, because the bytes are already committed.
    const ok = await as(adminPrincipal, 'attach-when-ready', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    created.keys.push(ok.snapshot.storageRef ?? '');
    expect(ok.snapshot.documentOrder).toBe(1);

    const sending = await requests.transition(requestId, { expectedVersion: ready.version, to: 'sending', origin: 'local' });
    const second = await pdfAttachment('sent_src_2', PDF_TWO_BYTES);
    await expect(as(adminPrincipal, 'attach-when-sending', () => documents.attachAttachment({ requestId, attachmentId: second.id }))).rejects.toThrow(/only allowed while the request is a draft/);
    await expect(as(adminPrincipal, 'detach-when-sending', () => documents.detachDocument(requestId, ok.snapshot.id))).rejects.toThrow(/only allowed while the request is a draft/);
    expect(sending.status).toBe('sending');
  });
});

describe('derived artifacts stay separate from the source (plan §4.5)', () => {
  it('stores a signed document as a new artifact and leaves the source untouched', async () => {
    const { documents } = services();
    const requestId = await newDraft('derived');
    const attachment = await pdfAttachment('derived_src');
    const source = await as(adminPrincipal, 'derived-attach', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    const sourceKey = source.snapshot.storageRef ?? '';
    created.keys.push(sourceKey);
    const sourceBefore = await storage.get(sourceKey);

    // The provider's signed PDF, byte-identical to the source: the worst case for an overwrite.
    const signed = await documents.storeDerivedArtifact({
      requestId,
      artifactKind: 'provider_signed_document',
      displayName: `${marker('derived_signed')}.pdf`,
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
      providerDocumentId: 'provider-doc-1',
    });
    created.keys.push(signed.snapshot.storageRef ?? '');
    expect(signed.created).toBe(true);
    expect(signed.snapshot.artifactKind).toBe('provider_signed_document');
    expect(signed.snapshot.contentHashSha256).toBe(source.snapshot.contentHashSha256);
    expect(signed.snapshot.storageRef).not.toBe(sourceKey);
    expect(String(signed.snapshot.storageRef).startsWith(`${SNAPSHOT_STORAGE_ROOT}/${requestId}/derived/`)).toBe(true);
    expect(signed.snapshot.retentionClass).toBe('evidence');

    const sourceAfter = await storage.get(sourceKey);
    expect(sourceAfter.equals(sourceBefore)).toBe(true);
    const rows = await as(adminPrincipal, 'derived-list', () => documents.listDocuments(requestId));
    expect(rows.map((entry) => entry.artifactKind).sort()).toEqual(['provider_signed_document', 'source_snapshot']);
  });

  it('is idempotent for the same provider artifact and refuses a source kind', async () => {
    const { documents } = services();
    const requestId = await newDraft('derived_idem');
    const first = await documents.storeDerivedArtifact({
      requestId,
      artifactKind: 'completion_evidence',
      displayName: 'certificate.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_TWO_BYTES,
      providerDocumentId: 'provider-cert-1',
    });
    created.keys.push(first.snapshot.storageRef ?? '');
    const again = await documents.storeDerivedArtifact({
      requestId,
      artifactKind: 'completion_evidence',
      displayName: 'certificate.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_TWO_BYTES,
      providerDocumentId: 'provider-cert-1',
    });
    expect(again.created).toBe(false);
    expect(again.snapshot.id).toBe(first.snapshot.id);
    await expect(
      documents.storeDerivedArtifact({ requestId, artifactKind: 'source_snapshot', displayName: 'x.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }),
    ).rejects.toThrow(/Only a provider artifact is stored this way/);
  });

  it('refuses to read back a snapshot whose stored bytes were tampered with', async () => {
    const { documents } = services();
    const requestId = await newDraft('tamper');
    const attachment = await pdfAttachment('tamper_src');
    const result = await as(adminPrincipal, 'tamper-attach', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    const key = result.snapshot.storageRef ?? '';
    created.keys.push(key);
    await storage.put({ key, body: Buffer.from('%PDF-1.4 swapped after the snapshot'), contentType: 'application/pdf' });
    await expect(as(adminPrincipal, 'tamper-open', () => documents.openSnapshot(result.snapshot.id))).rejects.toMatchObject({
      esignatureCode: 'SIGNATURE_DOCUMENT_NOT_READABLE',
    });
  });
});

describe('detaching a document from a draft', () => {
  it('removes the row from the request and keeps the bytes it snapshotted', async () => {
    const { documents } = services();
    const requestId = await newDraft('detach');
    const attachment = await pdfAttachment('detach_src');
    const result = await as(adminPrincipal, 'detach-attach', () => documents.attachAttachment({ requestId, attachmentId: attachment.id }));
    const key = result.snapshot.storageRef ?? '';
    created.keys.push(key);
    const detached = await as(adminPrincipal, 'detach', () => documents.detachDocument(requestId, result.snapshot.id));
    expect(detached.detached).toBe(result.snapshot.id);
    expect(await storage.exists(key)).toBe(true);
    const listed = await as(adminPrincipal, 'list-after-detach', () => documents.listDocuments(requestId));
    expect(listed).toEqual([]);
    // A freed slot is reusable: the row is soft-deleted, not rewritten.
    const second = await pdfAttachment('detach_src_2', PDF_TWO_BYTES);
    const replaced = await as(adminPrincipal, 'detach-again', () => documents.attachAttachment({ requestId, attachmentId: second.id }));
    created.keys.push(replaced.snapshot.storageRef ?? '');
    expect(replaced.snapshot.documentOrder).toBe(1);
  });

  it('will not detach another request’s document', async () => {
    const { documents } = services();
    const mine = await newDraft('other_a');
    const theirs = await newDraft('other_b');
    const attachment = await pdfAttachment('other_src');
    const result = await as(adminPrincipal, 'other-attach', () => documents.attachAttachment({ requestId: mine, attachmentId: attachment.id }));
    created.keys.push(result.snapshot.storageRef ?? '');
    await expect(as(adminPrincipal, 'other-detach', () => documents.detachDocument(theirs, result.snapshot.id))).rejects.toThrow(/does not belong to this signature request/);
  });

  it('replaces one named slot and leaves the previous snapshot as evidence', async () => {
    const { documents } = services();
    const requestId = await newDraft('replace');
    const first = await pdfAttachment('replace_a');
    const second = await pdfAttachment('replace_b', PDF_TWO_BYTES);
    const original = await as(adminPrincipal, 'replace-1', () => documents.attachAttachment({ requestId, attachmentId: first.id }));
    const originalKey = original.snapshot.storageRef ?? '';
    created.keys.push(originalKey);
    const replacement = await as(adminPrincipal, 'replace-2', () => documents.replaceDocument({ requestId, documentOrder: 1, attachmentId: second.id }));
    created.keys.push(replacement.snapshot.storageRef ?? '');
    expect(replacement.snapshot.documentOrder).toBe(1);
    expect(replacement.snapshot.contentHashSha256).toBe(sha256(PDF_TWO_BYTES));
    const visible = await as(adminPrincipal, 'replace-list', () => documents.listDocuments(requestId));
    expect(visible.map((entry) => entry.id)).toEqual([replacement.snapshot.id]);
    // The replaced row still exists, soft-deleted, with its bytes: an approval decision was taken on it.
    const raw = await ctx.database.db
      .selectFrom('signature_document_snapshots')
      .select(['id', 'deleted_at', 'content_hash_sha256'])
      .where('request_id', '=', requestId)
      .orderBy('created_at', 'asc')
      .execute();
    expect(raw.length).toBe(2);
    expect(raw[0]?.deleted_at).not.toBeNull();
    expect(raw[0]?.content_hash_sha256).toBe(PDF_HASH);
    expect((await storage.get(originalKey)).equals(PDF_BYTES)).toBe(true);
  });
});

/** The storage key behind an attachment row, read straight from the database. */
async function attachmentKey(attachmentId: string): Promise<string> {
  const row = await ctx.database.db.selectFrom('attachments').select('storage_key').where('id', '=', attachmentId).executeTakeFirst();
  if (row?.storage_key === undefined) throw new Error('Expected the attachment row to carry a storage key.');
  return String(row.storage_key);
}
