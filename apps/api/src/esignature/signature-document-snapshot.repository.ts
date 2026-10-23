import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { artifactRetentionFor } from './esignature-retention.js';
import type { ESignatureSettings } from './esignature-settings.service.js';
import { assertEditable } from './esignature-state-machine.js';
import { SignatureRequestRepository } from './signature-request.repository.js';

/**
 * Phase 19-ES.2 — document snapshots and derived artifacts
 * (`PLAN_Phase_19_ESignature.md` §6.3, §4.5, §16).
 *
 * The row records **what the bytes were**, not where they live now: a SHA-256 of the exact content
 * handed to the provider, the name, the MIME type and the size at that moment, plus an immutable
 * version reference. Hashing the file again when a screen renders it proves nothing about what was
 * sent, because the file may have been replaced (plan §4.5) — so the hash is captured at record time
 * and never recomputed into the row.
 *
 * `artifact_kind` separates the four things a request can hold, and the separation is the guarantee
 * that a provider result cannot overwrite a source: the signed document and the completion
 * certificate are *new rows* of a different kind, and this repository has no operation that writes to
 * a `source_snapshot` row's bytes or to a source attachment.
 *
 * Recording is idempotent: the same content hash for the same kind on the same request returns the
 * existing row instead of a second one, which is what makes a retried artifact-download job safe
 * (plan §16: "re-running an artifact-download job must not create duplicate attachments").
 */

export const ARTIFACT_KINDS = ['source_snapshot', 'provider_signed_document', 'completion_evidence', 'supporting_document'] as const;
export type SignatureArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface SignatureDocumentSnapshot {
  readonly id: string;
  readonly requestId: string;
  readonly artifactKind: SignatureArtifactKind;
  readonly sourceAttachmentId: string | null;
  readonly sourceVersionId: string | null;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHashSha256: string;
  readonly storageRef: string | null;
  readonly documentOrder: number;
  readonly providerDocumentId: string | null;
  readonly retentionClass: string;
  readonly createdAt: string;
  readonly createdById: string | null;
  readonly deleted: boolean;
}

export interface RecordArtifactInput {
  requestId: string;
  artifactKind: SignatureArtifactKind;
  displayName: string;
  mimeType: string;
  byteSize: number;
  contentHashSha256: string;
  storageRef?: string | null;
  sourceAttachmentId?: string | null;
  sourceVersionId?: string | null;
  documentOrder?: number;
  providerDocumentId?: string | null;
  createdById?: string | undefined;
  /**
   * The row's id, when the caller has already used it to name a storage object.
   *
   * ES.5 writes the snapshot bytes under a key derived from this id, so the id has to exist before the
   * row does; leaving it unset keeps the previous behaviour for every other caller.
   */
  id?: string | undefined;
  /** The policy the row is classified under; the retention rule is not a caller's choice. */
  settings: ESignatureSettings;
}

const HASH_RE = /^[0-9a-f]{64}$/;

@Injectable()
export class SignatureDocumentSnapshotRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
  ) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * Record an artifact, returning the existing row when the same content is already stored.
   *
   * A source snapshot may only be attached to a draft: replacing what was submitted after the send
   * would rewrite the evidence (plan §4.3). A provider artifact may be recorded at any later state,
   * which is exactly what ES.15 does.
   */
  async record(input: RecordArtifactInput): Promise<{ snapshot: SignatureDocumentSnapshot; created: boolean }> {
    const hash = input.contentHashSha256.toLowerCase();
    if (!HASH_RE.test(hash)) throw new ValidationError('An artifact needs the SHA-256 of the exact bytes.', { contentHashSha256: 'expected 64 hex characters' });
    const displayName = input.displayName.trim();
    if (displayName === '') throw new ValidationError('An artifact needs a display name.');
    if (!Number.isFinite(input.byteSize) || input.byteSize < 0) throw new ValidationError('An artifact byte size cannot be negative.');
    if (!(ARTIFACT_KINDS as readonly string[]).includes(input.artifactKind)) throw new ValidationError('Unknown artifact kind.', { artifactKind: input.artifactKind });

    const request = await this.requests.requireById(input.requestId);
    if (input.artifactKind === 'source_snapshot') {
      assertEditable(request.status, 'attach a document');
      const order = Math.trunc(input.documentOrder ?? 1);
      if (order < 1) throw new ValidationError('A document order starts at 1.');
      const existing = await this.findByOrder(input.requestId, order);
      if (existing !== undefined) {
        // Same slot, same bytes: idempotent. Same slot, different bytes: the draft is being changed,
        // and the caller must replace it deliberately rather than have the old row silently reused.
        if (existing.contentHashSha256 === hash) return { snapshot: existing, created: false };
        throw new ValidationError(`Document slot ${String(order)} already holds different content.`, { documentOrder: order });
      }
    }

    const existingByHash = await this.findByHash(input.requestId, input.artifactKind, hash);
    if (existingByHash !== undefined) {
      if (typeof input.providerDocumentId === 'string' && input.providerDocumentId.trim() !== '' && existingByHash.providerDocumentId === null) {
        await this.attachProviderDocumentId(existingByHash.id, input.providerDocumentId);
        const refreshed = await this.findById(existingByHash.id);
        if (refreshed !== undefined) return { snapshot: refreshed, created: false };
      }
      return { snapshot: existingByHash, created: false };
    }

    const retention = artifactRetentionFor(input.artifactKind, input.settings);
    const row = await this.db
      .insertInto('signature_document_snapshots')
      .values({
        id: input.id?.trim() || randomUUID(),
        request_id: input.requestId,
        artifact_kind: input.artifactKind,
        source_attachment_id: input.sourceAttachmentId ?? null,
        source_version_id: input.sourceVersionId ?? null,
        display_name: displayName.slice(0, 250),
        mime_type: input.mimeType.trim().toLowerCase().slice(0, 120),
        byte_size: String(Math.trunc(input.byteSize)),
        content_hash_sha256: hash,
        storage_ref: input.storageRef?.trim() || null,
        document_order: Math.trunc(input.documentOrder ?? 1),
        provider_document_id: input.providerDocumentId?.trim() || null,
        retention_class: retention.retentionClass,
        created_at: new Date(),
        created_by_id: input.createdById ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { snapshot: toSnapshot(row), created: true };
  }

  async findById(id: string): Promise<SignatureDocumentSnapshot | undefined> {
    const row = await this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toSnapshot(row);
  }

  async listForRequest(requestId: string, kinds?: readonly SignatureArtifactKind[]): Promise<SignatureDocumentSnapshot[]> {
    let query = this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('deleted_at', 'is', null);
    if (kinds !== undefined && kinds.length > 0) query = query.where('artifact_kind', 'in', kinds);
    const rows = await query
      .orderBy('artifact_kind', 'asc')
      .orderBy('document_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => toSnapshot(row));
  }

  private async findByOrder(requestId: string, documentOrder: number): Promise<SignatureDocumentSnapshot | undefined> {
    const row = await this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('artifact_kind', '=', 'source_snapshot')
      .where('document_order', '=', documentOrder)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toSnapshot(row);
  }

  /**
   * The artifact already recorded for these exact bytes.
   *
   * Public because idempotency is a question callers ask before they copy anything: a retried download
   * job, or a document attached twice, must find the existing row rather than write a second object
   * (plan §16).
   */
  async findByHash(requestId: string, kind: SignatureArtifactKind, hash: string): Promise<SignatureDocumentSnapshot | undefined> {
    const row = await this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('artifact_kind', '=', kind)
      .where('content_hash_sha256', '=', hash)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toSnapshot(row);
  }

  /**
   * The artifact already recorded for this provider document.
   *
   * The provider's document id and the content hash are two independent identities; a retried
   * retrieval may match either, and never stores a second object for the same evidence (plan §16).
   */
  async findByProviderDocumentId(
    requestId: string,
    kind: SignatureArtifactKind,
    providerDocumentId: string,
  ): Promise<SignatureDocumentSnapshot | undefined> {
    const id = providerDocumentId.trim();
    if (id === '') return undefined;
    const row = await this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('artifact_kind', '=', kind)
      .where('provider_document_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toSnapshot(row);
  }

  /** A snapshot the caller named, or a refusal: an unknown id is not an empty result (plan §4.5). */
  async requireById(id: string): Promise<SignatureDocumentSnapshot> {
    const found = await this.findById(id);
    if (found === undefined) throw new ValidationError(`No signature document snapshot "${id}".`, { id });
    return found;
  }

  /**
   * A snapshot of one specific request.
   *
   * The request id is checked, not assumed: a snapshot belongs to exactly one request, and an id from
   * another request must not be readable or detachable through this one (plan §12.4).
   */
  async requireForRequest(id: string, requestId: string): Promise<SignatureDocumentSnapshot> {
    const found = await this.requireById(id);
    if (found.requestId !== requestId) {
      throw new ValidationError('That document does not belong to this signature request.', { id, requestId });
    }
    return found;
  }

  /**
   * The snapshot already taken from this attachment.
   *
   * Asked before any byte is read: attaching the same file twice is the same snapshot, and re-copying
   * it would put a second object where the evidence says there is one (plan §16).
   */
  async findBySourceAttachment(requestId: string, attachmentId: string): Promise<SignatureDocumentSnapshot | undefined> {
    const row = await this.db
      .selectFrom('signature_document_snapshots')
      .selectAll()
      .where('request_id', '=', requestId)
      .where('artifact_kind', '=', 'source_snapshot')
      .where('source_attachment_id', '=', attachmentId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toSnapshot(row);
  }

  async attachProviderDocumentId(id: string, providerDocumentId: string): Promise<void> {
    await this.db
      .updateTable('signature_document_snapshots')
      .set({ provider_document_id: providerDocumentId.trim() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /**
   * Remove a source snapshot from a draft.
   *
   * Only a draft loses a document, and only the row is soft-deleted: nothing here touches the
   * attachment the bytes came from, and a signed artifact can never be removed this way (plan §4.5).
   */
  async removeFromDraft(id: string): Promise<void> {
    const found = await this.findById(id);
    if (found === undefined) return;
    if (found.artifactKind !== 'source_snapshot') {
      throw new ValidationError('Only a source document can be removed from a request.', { artifactKind: found.artifactKind });
    }
    const request = await this.requests.requireById(found.requestId);
    assertEditable(request.status, 'remove a document');
    await this.db
      .updateTable('signature_document_snapshots')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}

function toSnapshot(row: {
  id: string;
  request_id: string;
  artifact_kind: string;
  source_attachment_id: string | null;
  source_version_id: string | null;
  display_name: string;
  mime_type: string;
  byte_size: string;
  content_hash_sha256: string;
  storage_ref: string | null;
  document_order: number;
  provider_document_id: string | null;
  retention_class: string;
  created_at: Date;
  created_by_id: string | null;
  deleted_at: Date | null;
}): SignatureDocumentSnapshot {
  return {
    id: row.id,
    requestId: row.request_id,
    artifactKind: row.artifact_kind as SignatureArtifactKind,
    sourceAttachmentId: row.source_attachment_id,
    sourceVersionId: row.source_version_id,
    displayName: row.display_name,
    mimeType: row.mime_type,
    byteSize: Number.parseInt(row.byte_size, 10) || 0,
    contentHashSha256: row.content_hash_sha256,
    storageRef: row.storage_ref,
    documentOrder: row.document_order,
    providerDocumentId: row.provider_document_id,
    retentionClass: row.retention_class,
    createdAt: row.created_at.toISOString(),
    createdById: row.created_by_id,
    deleted: row.deleted_at !== null,
  };
}
