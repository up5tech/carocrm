import { createHash,randomUUID  } from 'node:crypto';

import { AuthorizationDeniedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { type FileStorage } from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';

import { StreamProbe } from '../attachment/attachment.probe.js';
import { type AttachmentDto,AttachmentService, FILE_STORAGE_TOKEN } from '../attachment/index.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { PROVIDER_KEY_DOCUSIGN } from './esignature-domain.js';
import { signatureDocumentNotReadableError, signatureModuleDisabledError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { type ESignatureSettings, ESignatureSettingsService } from './esignature-settings.service.js';
import { assertEditable } from './esignature-state-machine.js';
import { signatureProviderDocumentLimits } from './providers/signature-provider.catalog.js';
import { type AuditInput, SignatureAuditRepository } from './signature-audit.repository.js';
import {
  type SignatureArtifactKind,
  type SignatureDocumentSnapshot,
  SignatureDocumentSnapshotRepository,
} from './signature-document-snapshot.repository.js';
import { type SignatureRequest,SignatureRequestRepository } from './signature-request.repository.js';

/**
 * Phase 19-ES.5 — the secure document snapshot service
 * (`PLAN_Phase_19_ESignature.md` §4.5, §6.3, §12.9, §18 `19-ES.5`).
 *
 * A signature request does not point at an attachment. It points at a **snapshot of the bytes that
 * were submitted**, because an attachment is a live CRM record: it can be renamed, unlinked, or — the
 * case that matters — replaced by a new upload while a contract is out for signature. Hashing the
 * current file when a screen renders it proves nothing about what the signer saw (plan §4.5), so this
 * service copies the bytes once into storage this module owns and records their SHA-256.
 *
 * Four rules, each of which is a refusal rather than a convention:
 *
 *  1. **The bytes are read through the platform's file authorization service.** `AttachmentService` is
 *     the only reader: `getById` and `download` enforce the parent record's ACL, the attachment
 *     visibility gate and the uploader-or-administrator rule (`attachment.service.ts:293-308`). A
 *     caller who cannot open the file in the CRM cannot attach it here either, and no path in this file
 *     bypasses that.
 *  2. **A source snapshot lives under a prefix nothing else writes to**, and provider artifacts under a
 *     sibling one, keyed by the artifact kind and the content hash. There is no method here that takes
 *     an existing row's storage reference and writes bytes to it, which is what makes "a provider
 *     result cannot overwrite the source file" structural rather than a promise to be careful.
 *  3. **The policy is the tighter of the settings document and the provider.** Extension and MIME must
 *     satisfy the administrator's allowlist *and* DocuSign's supported set; size must fit both
 *     ceilings; the count must fit the request's limit. An allowlist entry the provider cannot sign is
 *     refused here rather than discovered mid-send (plan §4.5: type, count, size and supported format).
 *  4. **The copy is verified against the source checksum.** The attachment row carries the SHA-256
 *     taken when it was uploaded; if the bytes that streamed out of storage do not match it, nothing is
 *     recorded. A snapshot of a half-written file would be worse than none, because it would look like
 *     evidence.
 *
 * Bytes are never buffered whole: the platform's own `StreamProbe` counts, hashes and enforces the
 * ceiling while the copy is written, exactly as an upload does.
 *
 * The HTTP surface for documents is ES.6's — a draft has to exist before anything can be attached to
 * it — so this service is what those endpoints will call, and the ES.5 suite drives it directly.
 */

/** Where a snapshot's bytes live. The kind is a path segment, so a source can never be replaced by an artifact. */
export const SNAPSHOT_STORAGE_ROOT = 'esignature';
const SOURCE_SEGMENT = 'source';
const DERIVED_SEGMENT = 'derived';

/** The kinds stored as derived artifacts; a source document always comes from an attachment. */
const DERIVED_ARTIFACT_KINDS: readonly SignatureArtifactKind[] = ['provider_signed_document', 'completion_evidence', 'supporting_document'];

export interface SnapshotRefusal {
  readonly reason: 'type_not_allowed' | 'too_large' | 'too_many' | 'empty';
  readonly message: string;
}

export interface AttachResult {
  readonly snapshot: SignatureDocumentSnapshot;
  /** False when these bytes were already snapshotted for this request — a retry is a no-op. */
  readonly created: boolean;
}

@Injectable()
export class ESignatureDocumentService {
  constructor(
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settingsService: ESignatureSettingsService,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
    @Inject(SignatureDocumentSnapshotRepository) private readonly snapshots: SignatureDocumentSnapshotRepository,
    @Inject(SignatureAuditRepository) private readonly audit: SignatureAuditRepository,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------
  // policy and layout — pure, so a settings change is testable without a file
  // ---------------------------------------------------------------------------

  /**
   * Whether these bytes may become a signature document, against the **tighter** of the settings
   * policy and DocuSign's own restrictions.
   */
  static policyIssue(
    input: { displayName: string; mimeType: string; byteSize: number; existingDocuments: number },
    settings: ESignatureSettings,
    providerKey: string = PROVIDER_KEY_DOCUSIGN,
  ): SnapshotRefusal | null {
    const policy = settings.documents;
    const extension = extensionOf(input.displayName);
    const allowed = policy.allowedExtensions.map((value) => value.toLowerCase());
    const providerLimits = signatureProviderDocumentLimits(providerKey);
    const providerAccepts = providerLimits === null || providerLimits.supportedExtensions.includes(extension);
    if (!allowed.includes(extension) || !providerAccepts) {
      return {
        reason: 'type_not_allowed',
        message: `A ".${extension || 'unknown'}" file is not an allowed signature document. Allowed: ${allowed.join(', ')}.`,
      };
    }
    if (extension === 'pdf' && !isPdfMime(input.mimeType)) {
      // The name says PDF and the declared type says otherwise. Plan §12.9 names an unexpected MIME
      // type as an attack surface, so a mismatch is refused rather than trusted to the extension.
      return { reason: 'type_not_allowed', message: `The declared type "${input.mimeType}" does not match the file extension.` };
    }
    if (input.byteSize <= 0) return { reason: 'empty', message: 'The document has no bytes to sign.' };
    const ceiling = documentCeiling(settings, providerKey);
    if (input.byteSize > ceiling) {
      return { reason: 'too_large', message: `The document is larger than the ${String(ceiling)} byte ceiling of this installation.` };
    }
    if (input.existingDocuments >= policy.maxDocumentsPerRequest) {
      return {
        reason: 'too_many',
        message: `A signature request holds at most ${String(policy.maxDocumentsPerRequest)} document(s) on this installation.`,
      };
    }
    return null;
  }

  /**
   * The storage key for one snapshot row: the request, the artifact kind, then the row's own id.
   *
   * The kind is a path segment, which is what makes the separation physical: a derived artifact's key
   * can never resolve to a source object, so no provider result can overwrite the file it was signed
   * from (plan §4.5). The id is the row's own, so one row owns exactly one object and a retry that
   * finds an existing row writes nothing new.
   */
  static storageKey(requestId: string, kind: SignatureArtifactKind, snapshotId: string, displayName: string): string {
    const segment = kind === 'source_snapshot' ? SOURCE_SEGMENT : DERIVED_SEGMENT;
    const extension = extensionOf(displayName);
    const suffix = extension === '' ? '' : `.${extension}`;
    return `${SNAPSHOT_STORAGE_ROOT}/${requestId}/${segment}/${snapshotId}${suffix}`;
  }

  // ---------------------------------------------------------------------------
  // source snapshots
  // ---------------------------------------------------------------------------

  /**
   * Snapshot an attachment into a draft request.
   *
   * The order is what it costs: capability, the draft's own state, the policy, and only then the
   * bytes. A file the caller may not read is refused by the attachment service with its own 403,
   * before anything is copied.
   */
  async attachAttachment(input: { requestId: string; attachmentId: string; documentOrder?: number }): Promise<AttachResult> {
    const settings = await this.assertDocumentsAllowed('manageDraft');
    const request = await this.requests.requireById(input.requestId);
    assertEditable(request.status, 'attach a document to a signature request');

    const existing = await this.snapshots.listForRequest(request.id, ['source_snapshot']);
    // The same attachment snapshotted twice is the same bytes; do not read the file again for it.
    const already = existing.find((entry) => entry.sourceAttachmentId === input.attachmentId);
    if (already !== undefined) return { snapshot: already, created: false };

    const attachment = await this.readableAttachment(input.attachmentId);
    const refusal = ESignatureDocumentService.policyIssue(
      { displayName: attachment.name, mimeType: attachment.mimeType, byteSize: attachment.size, existingDocuments: existing.length },
      settings,
      request.providerKey,
    );
    if (refusal !== null) throw signatureDocumentNotReadableError(refusal.reason, { filename: attachment.name });

    return this.copyToSnapshot({
      request,
      attachment,
      documentOrder: input.documentOrder ?? nextOrder(existing),
      settings,
      change: 'attached',
    });
  }

  /**
   * Replace the document in one named slot.
   *
   * A draft's document list is edited by the sender, so a slot may change — but only by naming the
   * slot, and only while the request is a draft. The previous row is soft-deleted and its bytes stay:
   * they are what an earlier preview or approval decision was made against (plan §6.6).
   */
  async replaceDocument(input: { requestId: string; documentOrder: number; attachmentId: string }): Promise<AttachResult> {
    const settings = await this.assertDocumentsAllowed('manageDraft');
    const request = await this.requests.requireById(input.requestId);
    assertEditable(request.status, 'replace a document on a signature request');
    const order = Math.trunc(input.documentOrder);
    if (order < 1) throw new ValidationError('A document order starts at 1.');

    const all = await this.snapshots.listForRequest(request.id, ['source_snapshot']);
    const occupant = all.find((entry) => entry.documentOrder === order);
    const attachment = await this.readableAttachment(input.attachmentId);
    const refusal = ESignatureDocumentService.policyIssue(
      {
        displayName: attachment.name,
        mimeType: attachment.mimeType,
        byteSize: attachment.size,
        // The slot being replaced does not count against the limit.
        existingDocuments: occupant === undefined ? all.length : all.length - 1,
      },
      settings,
      request.providerKey,
    );
    if (refusal !== null) throw signatureDocumentNotReadableError(refusal.reason, { filename: attachment.name });
    if (occupant !== undefined) await this.snapshots.removeFromDraft(occupant.id);

    return this.copyToSnapshot({ request, attachment, documentOrder: order, settings, change: 'replaced' });
  }

  /** Remove a document from a draft. The row stops being part of the request; the bytes are kept. */
  async detachDocument(requestId: string, snapshotId: string): Promise<{ detached: string }> {
    await this.assertDocumentsAllowed('manageDraft');
    const request = await this.requests.requireById(requestId);
    assertEditable(request.status, 'remove a document from a signature request');
    const found = await this.snapshots.requireForRequest(snapshotId, requestId);
    await this.snapshots.removeFromDraft(found.id);
    await this.audit.append({
      action: 'documents.changed',
      requestId,
      actor: this.actorRef(),
      detail: { change: 'removed', documentOrder: found.documentOrder, contentHash: found.contentHashSha256 },
    });
    return { detached: found.id };
  }

  /** The request's documents, metadata only. The bytes are read by `openSnapshot`. */
  async listDocuments(requestId: string, kinds?: readonly SignatureArtifactKind[]): Promise<SignatureDocumentSnapshot[]> {
    await this.assertDocumentsAllowed('use');
    await this.requests.requireById(requestId);
    return this.snapshots.listForRequest(requestId, kinds);
  }

  // ---------------------------------------------------------------------------
  // derived artifacts (plan §4.5: stored separately, never overwriting a source)
  // ---------------------------------------------------------------------------

  /**
   * Store what the provider produced as a **new** artifact.
   *
   * This is the only write path for provider bytes, and it cannot address a source: the kind is
   * restricted to the derived set and the key carries that kind, so a signed document lands beside the
   * snapshot and never on top of it. Storing the same content twice returns the existing row, which is
   * what makes a retried download job a no-op (plan §16).
   *
   * It asserts no caller capability on purpose: ES.15 reaches it from a worker job under the module's
   * documented service authority, where there is no session to check.
   */
  async storeDerivedArtifact(input: {
    requestId: string;
    artifactKind: SignatureArtifactKind;
    displayName: string;
    mimeType: string;
    bytes: Buffer;
    providerDocumentId?: string;
  }): Promise<AttachResult> {
    if (!(DERIVED_ARTIFACT_KINDS as readonly string[]).includes(input.artifactKind)) {
      throw new ValidationError('Only a provider artifact is stored this way; a source document comes from an attachment.', {
        artifactKind: input.artifactKind,
      });
    }
    const settings = await this.settingsService.settings();
    if (settings.enabled !== true) throw signatureModuleDisabledError('ESignature/enabled');
    const request = await this.requests.requireById(input.requestId);
    if (input.bytes.byteLength === 0) throw signatureDocumentNotReadableError('empty', { filename: input.displayName });

    const contentHashSha256 = digestBuffer(input.bytes);
    const known = await this.snapshots.findByHash(request.id, input.artifactKind, contentHashSha256);
    if (known !== undefined) return { snapshot: known, created: false };

    const id = randomUUID();
    const key = ESignatureDocumentService.storageKey(request.id, input.artifactKind, id, input.displayName);
    await this.storage.put({ key, body: input.bytes, contentType: input.mimeType, sizeHint: input.bytes.byteLength });
    // Read the object back and hash *that*, not the buffer that was handed in: the point of the record
    // is that these stored bytes are what the signer produced.
    let written: Buffer;
    try {
      written = await this.storage.get(key);
    } catch {
      await this.storage.delete(key).catch(() => undefined);
      throw signatureDocumentNotReadableError('storage_unavailable', { filename: input.displayName });
    }
    if (written.byteLength !== input.bytes.byteLength || digestBuffer(written) !== contentHashSha256) {
      await this.storage.delete(key).catch(() => undefined);
      throw signatureDocumentNotReadableError('checksum_mismatch', { filename: input.displayName });
    }
    const recorded = await this.snapshots.record({
      id,
      requestId: request.id,
      artifactKind: input.artifactKind,
      displayName: input.displayName,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      contentHashSha256,
      storageRef: key,
      ...(input.providerDocumentId === undefined ? {} : { providerDocumentId: input.providerDocumentId }),
      createdById: this.actorId() ?? undefined,
      settings,
    });
    if (!recorded.created) await this.storage.delete(key).catch(() => undefined);
    return { snapshot: recorded.snapshot, created: recorded.created };
  }

  // ---------------------------------------------------------------------------
  // reading a snapshot back
  // ---------------------------------------------------------------------------

  /**
   * The exact bytes of a snapshot, verified against the hash recorded for them.
   *
   * ES.9 sends these to the provider and ES.15 serves completed documents, and both must be able to
   * say "these are the bytes that were snapshotted" — so the digest is recomputed here and a mismatch
   * is a refusal, not a warning. Possession of a snapshot id is not access: the capability and the
   * owning request are both checked first (plan §4.5).
   */
  async openSnapshot(snapshotId: string): Promise<{ snapshot: SignatureDocumentSnapshot; bytes: Buffer }> {
    const snapshot = await this.snapshots.requireById(snapshotId);
    // A completed document is `artifacts` material; the source bytes are `documents` material. Reading
    // a signed copy must not require the attachment feature to be switched on (ES.15).
    const derived = snapshot.artifactKind === 'provider_signed_document' || snapshot.artifactKind === 'completion_evidence';
    await this.assertDocumentsAllowed('use', { allowArtifacts: derived });
    await this.requests.requireById(snapshot.requestId);
    if (snapshot.storageRef === null) throw signatureDocumentNotReadableError('storage_unavailable', { filename: snapshot.displayName });
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(snapshot.storageRef);
    } catch {
      throw signatureDocumentNotReadableError('storage_unavailable', { filename: snapshot.displayName });
    }
    if (digestBuffer(bytes) !== snapshot.contentHashSha256 || bytes.byteLength !== snapshot.byteSize) {
      throw signatureDocumentNotReadableError('checksum_mismatch', { filename: snapshot.displayName });
    }
    return { snapshot, bytes };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * Copy one attachment into this module's storage and record it.
   *
   * The stream is never buffered whole: `StreamProbe` counts, hashes and enforces the ceiling while the
   * driver writes, the same object an upload goes through. The probe's digest and the attachment's own
   * recorded checksum must agree with what landed, or nothing is recorded.
   */
  private async copyToSnapshot(input: {
    request: SignatureRequest;
    attachment: AttachmentDto;
    documentOrder: number;
    settings: ESignatureSettings;
    change: 'attached' | 'replaced';
  }): Promise<AttachResult> {
    const { request, attachment, documentOrder, settings, change } = input;
    const ceiling = documentCeiling(settings, request.providerKey);
    const known = await this.snapshots.findBySourceAttachment(request.id, attachment.id);
    if (known !== undefined) return { snapshot: known, created: false };

    const download = await this.attachments.download(attachment.id);
    const id = randomUUID();
    const key = ESignatureDocumentService.storageKey(request.id, 'source_snapshot', id, attachment.name);
    const probe = new StreamProbe(0, ceiling);
    download.stream.once('error', (error: Error) => probe.destroy(error));
    download.stream.pipe(probe);
    let size = 0;
    let hash = '';
    try {
      await this.storage.put({
        key,
        body: probe,
        contentType: attachment.mimeType,
        ...(attachment.size > 0 ? { sizeHint: attachment.size } : {}),
      });
      size = probe.size;
      hash = probe.digest();
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      if (probe.size > ceiling) throw signatureDocumentNotReadableError('too_large', { filename: attachment.name, limitBytes: ceiling });
      throw error;
    }
    if (size === 0) {
      await this.storage.delete(key).catch(() => undefined);
      throw signatureDocumentNotReadableError('empty', { filename: attachment.name });
    }
    if (attachment.checksum !== null && attachment.checksum !== hash) {
      // The bytes that came out of storage are not the bytes the platform hashed on upload. Recording
      // them would create evidence about a file that never existed.
      await this.storage.delete(key).catch(() => undefined);
      throw signatureDocumentNotReadableError('checksum_mismatch', { filename: attachment.name });
    }
    const alreadyStored = await this.snapshots.findByHash(request.id, 'source_snapshot', hash);
    if (alreadyStored !== undefined) {
      // Another slot already holds these exact bytes, with a row and an object of its own: no second
      // copy of either.
      await this.storage.delete(key).catch(() => undefined);
      return { snapshot: alreadyStored, created: false };
    }

    const recorded = await this.snapshots.record({
      id,
      requestId: request.id,
      artifactKind: 'source_snapshot',
      displayName: attachment.name,
      mimeType: attachment.mimeType,
      byteSize: size,
      contentHashSha256: hash,
      storageRef: key,
      sourceAttachmentId: attachment.id,
      // The attachment's checksum is the closest thing this platform has to an immutable file version,
      // and it is what proves the snapshot matches the source it came from (plan §6.3).
      sourceVersionId: attachment.checksum,
      documentOrder,
      createdById: this.actorId() ?? undefined,
      settings,
    });
    await this.audit.append({
      action: 'documents.changed',
      requestId: request.id,
      actor: this.actorRef(),
      detail: { change, documentOrder, contentHash: hash, byteSize: size },
    });
    if (!recorded.created) await this.storage.delete(key).catch(() => undefined);
    return { snapshot: recorded.snapshot, created: recorded.created };
  }

  /** Metadata read, through the service that decides who may see the file. */
  private async readableAttachment(attachmentId: string): Promise<AttachmentDto> {
    try {
      return await this.attachments.getById(attachmentId);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) throw error;
      if (error instanceof RecordNotFoundError) throw signatureDocumentNotReadableError('not_readable', { filename: attachmentId });
      throw error;
    }
  }

  /**
   * The guard on every document command.
   *
   * `use` or `manageDraft`, never `connectionManage`: preparing documents is the drafter's job
   * (plan §12) and the provider is not contacted here. The module and `documents` switches are checked
   * because a disabled module must not be writing files.
   */
  private async assertDocumentsAllowed(capability: 'use' | 'manageDraft', options: { allowArtifacts?: boolean } = {}): Promise<ESignatureSettings> {
    await this.permissions.assert(capability);
    const view = await this.settingsService.read();
    const documents = view.settings.enabled === true && view.settings.features.documents === true;
    const artifacts = options.allowArtifacts === true && view.settings.enabled === true && view.effective.artifacts === true;
    if (!documents && !artifacts) {
      throw signatureModuleDisabledError('ESignature/documents');
    }
    return view.settings;
  }

  private actorId(): string | null {
    return this.scope.userId ?? null;
  }

  private actorRef(): NonNullable<AuditInput['actor']> {
    const id = this.actorId();
    return id === null || id === 'system' ? { type: 'system' } : { type: 'user', id };
  }
}

/**
 * The lower-case extension of a filename, without the dot.
 *
 * The name is reduced to its last path segment first: the attachment service already basenames what
 * it stores, but this function also decides which bytes may enter storage, and a name that still
 * carries separators must not be able to talk it into a different extension than it appears to have.
 */
export function extensionOf(filename: string): string {
  const trimmed = (filename ?? '').trim().toLowerCase();
  const base = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).replace(/[^a-z0-9]/g, '');
}

/**
 * The byte ceiling both the installation and the provider accept.
 *
 * A provider with no verified limits (a cataloged one) imposes none here: the settings policy alone
 * decides, rather than refusing documents against a number nobody checked.
 */
export function documentCeiling(settings: ESignatureSettings, providerKey: string = PROVIDER_KEY_DOCUSIGN): number {
  const providerLimit = signatureProviderDocumentLimits(providerKey)?.maxDocumentBytes;
  return providerLimit === undefined ? settings.documents.maxDocumentBytes : Math.min(settings.documents.maxDocumentBytes, providerLimit);
}

function isPdfMime(mimeType: string): boolean {
  const lower = (mimeType ?? '').toLowerCase().trim();
  return lower === 'application/pdf' || lower === 'application/x-pdf';
}

/** The next free document slot: 1, 2, …, with no gap a sender has to reason about. */
function nextOrder(existing: readonly SignatureDocumentSnapshot[]): number {
  const used = new Set(existing.map((entry) => entry.documentOrder));
  let order = 1;
  while (used.has(order)) order += 1;
  return order;
}

function digestBuffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
