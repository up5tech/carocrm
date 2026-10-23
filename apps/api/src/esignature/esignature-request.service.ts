import { AuthorizationDeniedError, ConcurrencyConflictError, ValidationError } from '@carocrm/core/errors/index.js';
import type { RecordStorePort } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityRecord } from '@carocrm/entity-engine/types/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService, type AclRecordLike } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ESignatureConnectionService } from './esignature-connection.service.js';
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureDocumentService } from './esignature-document.service.js';
import type { SignatureRequestStatus } from './esignature-domain.js';
import { providerNotConnectedError, signatureModuleDisabledError, signatureRequestInvalidStateError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { buildSignaturePreview, type SignaturePreview } from './esignature-preview.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { buildSnapshot } from './esignature-snapshot.js';
import { isEditable } from './esignature-state-machine.js';
import { toModuleError } from './providers/signature-provider.errors.js';
import { correlationId, prepareIdentity } from './providers/signature-provider.idempotency.js';
import type { PrepareEnvelopeInput } from './providers/signature-provider.port.js';
import { SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import { type AuditInput, SignatureAuditRepository } from './signature-audit.repository.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';
import { type SignatureDocumentSnapshot, SignatureDocumentSnapshotRepository } from './signature-document-snapshot.repository.js';
import { type SignatureRecipient, SignatureRecipientRepository } from './signature-recipient.repository.js';
import { type RequestAccessScope, type SignatureRequest, SignatureRequestRepository } from './signature-request.repository.js';
import { SignatureTemplateMappingRepository } from './signature-template-mapping.repository.js';

/**
 * Phase 19-ES.6 — signature request draft and CRUD
 * (`PLAN_Phase_19_ESignature.md` §6.2, §8.2, §11, §13.2, §18 `19-ES.6`).
 *
 * This is the first HTTP surface over the module's own records, so it is also where the two
 * authorization questions the plan asks on every command are answered together:
 *
 *  1. **May this caller hold this right at all?** The synthetic capability matrix of ES.1
 *     (`use` to read, `manageDraft` to prepare) — checked first, so a caller without it learns only that.
 *  2. **May this caller touch this particular request?** The platform's record evaluator, over the
 *     request's own `assigned_user_id` / `team_ids` / `created_by_id`, exactly as a metadata entity is
 *     scoped. A request is not readable just because it exists.
 *
 * A third question is specific to this module and is answered on the way in: **is the linked CRM record
 * one the caller may read?** A request can name an Account, a Quote or a Project (plan §2.3), and a
 * signature request must never become a way to learn about a record the caller cannot open. The link
 * is therefore validated against the metadata registry and the record ACL when it is set, and the
 * detail view reports `accessible: false` with no label rather than leaking the name of a record the
 * caller may not see.
 *
 * What this service deliberately does **not** do: no provider call, no state change beyond the draft's
 * own content, and no way to set a server-owned column. `updateDraft` refuses those by name and refuses
 * any status that is no longer editable, which is what makes "a sent request cannot be modified through
 * a PATCH" true here as well as at the generic entity route (where signature requests simply do not
 * exist — they are not metadata entities).
 */

export interface RequestListQuery {
  readonly statuses?: readonly SignatureRequestStatus[] | undefined;
  readonly sourceEntityType?: string | undefined;
  readonly sourceRecordId?: string | undefined;
  readonly connectionId?: string | undefined;
  readonly assignedUserId?: string | undefined;
  readonly needsAttention?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface SignatureRequestSourceView {
  readonly entityType: string;
  readonly recordId: string;
  /** The record's display name, when the caller may read it. `null` otherwise — never the id as a name. */
  readonly label: string | null;
  readonly accessible: boolean;
  /** The linked record no longer exists. The request stays readable; its evidence must. */
  readonly missing: boolean;
}

export interface SignatureRequestDocumentView {
  readonly id: string;
  readonly artifactKind: SignatureDocumentSnapshot['artifactKind'];
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHashSha256: string;
  readonly documentOrder: number;
  readonly providerDocumentId: string | null;
  readonly createdAt: string;
}

export interface SignatureRequestRecipientView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly recipientType: SignatureRecipient['recipientType'];
  readonly roleName: string | null;
  readonly routingOrder: number;
  readonly status: SignatureRecipient['status'];
  readonly crmContactId: string | null;
}

/** One request, as its own screen needs it. */
export interface SignatureRequestView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: SignatureRequestStatus;
  readonly providerKey: string;
  readonly connectionId: string | null;
  /** The provider's draft envelope, once ES.9 prepared one. Null until then, and after an abandonment. */
  readonly providerEnvelopeId: string | null;
  readonly providerStatusRaw: string | null;
  /** The template mapping the draft uses, when it uses one (ES.8). */
  readonly templateMappingId: string | null;
  readonly source: SignatureRequestSourceView | null;
  readonly subject: string | null;
  readonly message: string | null;
  readonly emailBlurb: string | null;
  readonly expiresAt: string | null;
  readonly approvalRequired: boolean;
  readonly approvalStatus: SignatureRequest['approvalStatus'];
  readonly approvalReason: string | null;
  readonly createdById: string | null;
  readonly assignedUserId: string | null;
  readonly teamIds: readonly string[];
  readonly preparedAt: string | null;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly declinedAt: string | null;
  readonly voidedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
  /** True while a draft edit, a document change or a recipient change would be accepted. */
  readonly editable: boolean;
  readonly recipients: readonly SignatureRequestRecipientView[];
  readonly documents: readonly SignatureRequestDocumentView[];
}

export interface SignatureRequestListRow {
  readonly id: string;
  readonly name: string;
  readonly status: SignatureRequestStatus;
  readonly source: SignatureRequestSourceView | null;
  readonly assignedUserId: string | null;
  readonly createdById: string | null;
  readonly approvalStatus: SignatureRequest['approvalStatus'];
  readonly sentAt: string | null;
  readonly modifiedAt: string;
}

export interface RequestDraftPatch {
  readonly name?: string | undefined;
  readonly templateMappingId?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly subject?: string | null | undefined;
  readonly message?: string | null | undefined;
  readonly emailBlurb?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly connectionId?: string | null | undefined;
  readonly sourceEntityType?: string | null | undefined;
  readonly sourceRecordId?: string | null | undefined;
  readonly assignedUserId?: string | null | undefined;
  readonly teamIds?: readonly string[] | undefined;
  readonly approvalRequired?: boolean | undefined;
}

@Injectable()
export class ESignatureRequestService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settingsService: ESignatureSettingsService,
    @Inject(ESignatureDocumentService) private readonly documents: ESignatureDocumentService,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
    @Inject(SignatureRecipientRepository) private readonly recipients: SignatureRecipientRepository,
    @Inject(SignatureDocumentSnapshotRepository) private readonly snapshots: SignatureDocumentSnapshotRepository,
    @Inject(SignatureAuditRepository) private readonly audit: SignatureAuditRepository,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureTemplateMappingRepository) private readonly mappings: SignatureTemplateMappingRepository,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(ESignatureConnectionService) private readonly connectionService: ESignatureConnectionService,
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(ENTITY_STORE) private readonly store: RecordStorePort,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------
  // list and detail
  // ---------------------------------------------------------------------------

  async list(query: RequestListQuery): Promise<{ list: SignatureRequestListRow[]; total: number }> {
    await this.permissions.assert('use');
    await this.assertModuleEnabled();

    const level = await this.permissions.level('use');
    const userId = this.scope.userId ?? '';
    const access: RequestAccessScope =
      level === 'all' || level === 'yes'
        ? { kind: 'all', userId, teamIds: [] }
        : { kind: level === 'team' ? 'team' : 'own', userId, teamIds: this.scope.teamIds() };
    const { list, total } = await this.requests.list({
      limit: query.limit,
      offset: query.offset,
      access,
      ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      ...(query.sourceEntityType === undefined ? {} : { sourceEntityType: query.sourceEntityType }),
      ...(query.sourceRecordId === undefined ? {} : { sourceRecordId: query.sourceRecordId }),
      ...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
      ...(query.assignedUserId === undefined ? {} : { assignedUserId: query.assignedUserId }),
      ...(query.needsAttention === undefined ? {} : { needsAttention: query.needsAttention }),
    });
    return { list: await Promise.all(list.map((row) => this.toListRow(row))), total };
  }

  async get(id: string): Promise<SignatureRequestView> {
    const request = await this.loadScoped(id);
    return this.view(request);
  }

  // ---------------------------------------------------------------------------
  // drafts
  // ---------------------------------------------------------------------------

  /**
   * Create a draft.
   *
   * Ownership defaults to the creator and the creator's teams, so a role scoped to `own` or `team`
   * finds what it just made without an administrator assigning it. A linked source record is checked
   * for metadata validity and for read access before the row exists at all.
   */
  async create(input: RequestDraftPatch & { name: string }): Promise<SignatureRequestView> {
    await this.permissions.assert('manageDraft');
    await this.assertModuleEnabled();
    if (input.sourceEntityType !== undefined && input.sourceEntityType !== null) {
      await this.assertSourceReadable(input.sourceEntityType, input.sourceRecordId ?? null);
    }
    if (input.templateMappingId !== undefined && input.templateMappingId !== null) {
      await this.assertMappingBindable(input.connectionId ?? null, input.templateMappingId);
    }

    const created = await this.requests.createDraft({
      name: input.name,
      ...(input.description !== undefined && input.description !== null ? { description: input.description } : {}),
      ...(input.subject !== undefined && input.subject !== null ? { subject: input.subject } : {}),
      ...(input.message !== undefined && input.message !== null ? { message: input.message } : {}),
      ...(input.emailBlurb !== undefined && input.emailBlurb !== null ? { emailBlurb: input.emailBlurb } : {}),
      ...(input.expiresAt !== undefined && input.expiresAt !== null ? { expiresAt: input.expiresAt } : {}),
      ...(input.connectionId !== undefined && input.connectionId !== null ? { connectionId: input.connectionId } : {}),
      ...(input.templateMappingId !== undefined && input.templateMappingId !== null ? { templateMappingId: input.templateMappingId } : {}),
      ...(input.sourceEntityType !== undefined && input.sourceEntityType !== null ? { sourceEntityType: input.sourceEntityType } : {}),
      ...(input.sourceRecordId !== undefined && input.sourceRecordId !== null ? { sourceRecordId: input.sourceRecordId } : {}),
      ...(input.approvalRequired !== undefined ? { approvalRequired: input.approvalRequired } : {}),
      ...(this.scope.userId !== undefined ? { createdById: this.scope.userId, assignedUserId: this.scope.userId } : {}),
      teamIds: this.scope.teamIds(),
    });
    await this.audit.append({
      action: 'request.created',
      requestId: created.id,
      actor: this.actorRef(),
      detail: { sourceEntityType: created.sourceEntityType ?? 'none' },
    });
    return this.view(created);
  }

  /**
   * Edit a draft's content.
   *
   * `version` is required: two people editing the same draft is a real case, and the second save must
   * be told it lost rather than overwrite the first (plan §4.3's optimistic rule, applied to drafts).
   * A patch that names a server-owned field is refused by the repository, not silently ignored.
   */
  async update(id: string, input: { version: number; patch: RequestDraftPatch }): Promise<SignatureRequestView> {
    const request = await this.loadScoped(id, 'write');
    const patch = input.patch;
    if (patch.sourceEntityType !== undefined || patch.sourceRecordId !== undefined) {
      const entityType = patch.sourceEntityType !== undefined ? patch.sourceEntityType : request.sourceEntityType;
      const recordId = patch.sourceRecordId !== undefined ? patch.sourceRecordId : request.sourceRecordId;
      if (entityType !== null && recordId !== null) await this.assertSourceReadable(entityType, recordId);
    }
    if (patch.templateMappingId !== undefined) {
      const connectionId = patch.connectionId !== undefined ? patch.connectionId : request.connectionId;
      if (patch.templateMappingId !== null) await this.assertMappingBindable(connectionId, patch.templateMappingId);
    }
    const updated = await this.requests.updateDraft(
      request.id,
      input.version,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
        ...(patch.emailBlurb !== undefined ? { emailBlurb: patch.emailBlurb } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.connectionId !== undefined ? { connectionId: patch.connectionId } : {}),
        ...(patch.sourceEntityType !== undefined ? { sourceEntityType: patch.sourceEntityType } : {}),
        ...(patch.sourceRecordId !== undefined ? { sourceRecordId: patch.sourceRecordId } : {}),
        ...(patch.templateMappingId !== undefined ? { templateMappingId: patch.templateMappingId } : {}),
        ...(patch.assignedUserId !== undefined ? { assignedUserId: patch.assignedUserId } : {}),
        ...(patch.teamIds !== undefined ? { teamIds: patch.teamIds } : {}),
      },
      this.scope.userId,
    );
    await this.audit.append({
      action: 'request.updated',
      requestId: updated.id,
      actor: this.actorRef(),
      detail: { fields: Object.keys(patch).sort().join(',') },
    });
    await this.dropStalePreparation(updated.id);
    return this.view(await this.requests.requireById(updated.id));
  }

  // ---------------------------------------------------------------------------
  // recipients
  // ---------------------------------------------------------------------------

  async listRecipients(id: string): Promise<readonly SignatureRequestRecipientView[]> {
    const request = await this.loadScoped(id);
    return (await this.recipients.listForRequest(request.id)).map(toRecipientView);
  }

  /** Replace the whole recipient set. Only a draft has editable recipients (plan §8.2). */
  async replaceRecipients(
    id: string,
    recipients: readonly {
      name: string;
      email: string;
      recipientType?: SignatureRecipient['recipientType'] | undefined;
      crmContactId?: string | null | undefined;
      roleName?: string | null | undefined;
      routingOrder: number;
      authenticationMethod?: string | null | undefined;
    }[],
  ): Promise<readonly SignatureRequestRecipientView[]> {
    const request = await this.loadScoped(id, 'write');
    const stored = await this.recipients.replaceForDraft(request.id, recipients, this.scope.userId);
    await this.audit.append({
      action: 'recipients.changed',
      requestId: request.id,
      actor: this.actorRef(),
      detail: { count: stored.length },
    });
    await this.dropStalePreparation(request.id);
    return stored.map(toRecipientView);
  }

  // ---------------------------------------------------------------------------
  // documents (delegated to ES.5, behind this request's own ACL)
  // ---------------------------------------------------------------------------

  async listDocuments(id: string): Promise<readonly SignatureRequestDocumentView[]> {
    const request = await this.loadScoped(id);
    return (await this.snapshots.listForRequest(request.id)).map(toDocumentView);
  }

  async attachDocument(id: string, input: { attachmentId: string; documentOrder?: number | undefined }): Promise<SignatureRequestDocumentView> {
    const request = await this.loadScoped(id, 'write');
    const result = await this.documents.attachAttachment({
      requestId: request.id,
      attachmentId: input.attachmentId,
      ...(input.documentOrder === undefined ? {} : { documentOrder: input.documentOrder }),
    });
    await this.dropStalePreparation(request.id);
    return toDocumentView(result.snapshot);
  }

  async replaceDocument(id: string, documentOrder: number, attachmentId: string): Promise<SignatureRequestDocumentView> {
    const request = await this.loadScoped(id, 'write');
    const result = await this.documents.replaceDocument({ requestId: request.id, documentOrder, attachmentId });
    await this.dropStalePreparation(request.id);
    return toDocumentView(result.snapshot);
  }

  async detachDocument(id: string, snapshotId: string): Promise<{ detached: string }> {
    const request = await this.loadScoped(id, 'write');
    const detached = await this.documents.detachDocument(request.id, snapshotId);
    await this.dropStalePreparation(request.id);
    return detached;
  }

  async openDocument(id: string, snapshotId: string): Promise<{ document: SignatureRequestDocumentView; bytes: Buffer }> {
    const request = await this.loadScoped(id);
    const opened = await this.documents.openSnapshot(snapshotId);
    if (opened.snapshot.requestId !== request.id) {
      throw new ValidationError('That document does not belong to this signature request.', { snapshotId });
    }
    return { document: toDocumentView(opened.snapshot), bytes: opened.bytes };
  }

  // ---------------------------------------------------------------------------
  // preview and preparation (19-ES.8)
  // ---------------------------------------------------------------------------

  /**
   * What a send would carry, right now. Read-only: no write, no version bump, no provider call.
   *
   * The review screen shows this; the sender confirms it; `prepare` records it. Preparing from the same
   * function is what makes "the preview accurately reflects the final request" a property of the code
   * rather than a promise the two screens keep to each other.
   */
  async preview(id: string): Promise<SignaturePreview> {
    return this.buildPreview(await this.loadScoped(id));
  }

  /**
   * Record the immutable preview and move the request to the state the policy allows.
   *
   * `confirm` is required and must be literally `true`: plan §13.3 step 7 asks for an explicit sender
   * confirmation, and a defaulted boolean would let a retried request look confirmed by accident.
   * Nothing here reaches a provider — an envelope is ES.9's job (plan §4.3).
   */
  async prepare(id: string, input: { version: number; confirm: boolean }): Promise<{ request: SignatureRequestView; preview: SignaturePreview }> {
    const request = await this.loadScoped(id, 'write');
    if (input.confirm !== true) {
      throw new ValidationError('Preparing a signature request needs an explicit sender confirmation.', { code: 'CONFIRMATION_REQUIRED' });
    }
    if (request.version !== input.version) throw new ConcurrencyConflictError('SignatureRequest', id);
    const preview = await this.buildPreview(request);
    if (!preview.ready || preview.data === null) {
      throw new ValidationError('The request is not ready to prepare.', { problems: preview.problems });
    }

    const snapshot = buildSnapshot(`SignatureRequest:${request.id}`, preview.data);
    const updated = await this.requests.recordPreparation(request.id, input.version, {
      snapshot,
      preparedById: this.scope.userId ?? 'system',
      targetStatus: preview.approvalRequired ? 'pending_approval' : 'ready_to_send',
      approvalRequired: preview.approvalRequired,
      approvalStatus: preview.approvalRequired ? (preview.approvedForThisDigest ? 'approved' : 'pending') : 'not_required',
    });
    await this.audit.append({
      action: 'request.prepared',
      requestId: request.id,
      actor: this.actorRef(),
      detail: { digest: updated.outgoingDigest, targetStatus: updated.status, approvalRequired: preview.approvalRequired },
    });
    return { request: await this.view(updated), preview: await this.buildPreview(updated) };
  }

  // ---------------------------------------------------------------------------
  // provider envelope preparation (19-ES.9)
  // ---------------------------------------------------------------------------

  /**
   * Create the provider-side **draft** envelope from the prepared snapshot.
   *
   * Nothing is sent: `status: 'created'` at DocuSign means a draft, no invitation and no email (plan
   * §4.3, §18 `19-ES.9`). The local request stays `ready_to_send` and gains the envelope id; ES.10 is the
   * only thing that moves it to `sending`.
   *
   * Three guards make a retry safe rather than duplicating:
   *
   *  - an envelope already recorded is returned as-is, with no provider call;
   *  - the whole call runs under a per-request advisory lock, so two concurrent clicks serialise and the
   *    loser sees the winner's envelope;
   *  - the idempotency key is derived from the request and the *snapshot digest*, so a retried call of
   *    the same reviewed payload is the same key to the adapter, and a changed draft is a different one
   *    — which the stale-preview guard refuses before it gets that far.
   */
  async prepareEnvelopeAtProvider(
    id: string,
    input: { version: number },
  ): Promise<{ request: SignatureRequestView; envelope: { providerEnvelopeId: string; status: string; createdAt: string; created: boolean } }> {
    const request = await this.loadScoped(id, 'write');
    await this.gate.assertOperation('prepareEnvelope');
    if (request.status !== 'ready_to_send') throw signatureRequestInvalidStateError(request.status, 'create a provider envelope');
    if (request.providerEnvelopeId !== null) {
      return {
        request: await this.view(request),
        envelope: { providerEnvelopeId: request.providerEnvelopeId, status: request.providerStatusRaw ?? 'draft', createdAt: request.modifiedAt, created: false },
      };
    }
    if (request.version !== input.version) throw new ConcurrencyConflictError('SignatureRequest', id);
    if (request.outgoingSnapshot === null || request.outgoingDigest === null) {
      throw new ValidationError('The request has no prepared preview, so no provider envelope can be created from it.', { code: 'PREVIEW_REQUIRED' });
    }
    // The stored snapshot must still describe the request: an edit after preparation makes it stale.
    const preview = await this.buildPreview(request);
    if (preview.digest !== request.outgoingDigest) {
      throw new ValidationError('The request changed after its preview was recorded. Prepare the preview again before creating an envelope.', { code: 'PREVIEW_OUTDATED' });
    }
    const snapshot = request.outgoingSnapshot;
    const snapshotDigest = request.outgoingDigest;
    const connection = request.connectionId === null ? undefined : await this.connections.findById(request.connectionId);
    if (connection === undefined) throw providerNotConnectedError('no_connection');

    return this.database.db.transaction().execute(async (tx) => {
      // Serialise preparations for this request: two clicks must not create two provider drafts.
      await sql`select pg_advisory_xact_lock(hashtext(${id}))`.execute(tx);
      const current = await this.requests.requireById(id);
      if (current.providerEnvelopeId !== null) {
        return {
          request: await this.view(current),
          envelope: { providerEnvelopeId: current.providerEnvelopeId, status: current.providerStatusRaw ?? 'draft', createdAt: current.modifiedAt, created: false },
        };
      }
      if (current.status !== 'ready_to_send') throw signatureRequestInvalidStateError(current.status, 'create a provider envelope');
      if (current.version !== input.version) throw new ConcurrencyConflictError('SignatureRequest', id);

      const context = await this.connectionService.contextFor(connection);
      const adapter = this.providers.assertOperation(connection.providerKey, 'prepareEnvelope');
      // A template envelope carries the template's documents; only a document envelope needs the bytes.
      const documents: { documentSnapshotId: string; displayName: string; mimeType: string; documentOrder: number; bytes: Uint8Array; contentHashSha256: string }[] = [];
      if (snapshot.data.templateId === null) {
        for (const document of snapshot.data.documents) {
          const opened = await this.documents.openSnapshot(document.documentSnapshotId);
          documents.push({
            documentSnapshotId: document.documentSnapshotId,
            displayName: document.displayName,
            mimeType: document.mimeType,
            documentOrder: document.documentOrder,
            bytes: opened.bytes,
            contentHashSha256: document.contentHashSha256,
          });
        }
      }
      const identity = prepareIdentity({
        connectionId: connection.id,
        signatureRequestId: id,
        snapshotDigest,
        fallbackCorrelationId: correlationId(),
      });
      const envelopeInput: PrepareEnvelopeInput = {
        signatureRequestId: id,
        idempotencyKey: identity.idempotencyKey,
        correlationId: identity.correlationId,
        templateId: snapshot.data.templateId,
        subject: snapshot.data.subject,
        emailBlurb: snapshot.data.emailBlurb,
        expiresAt: snapshot.data.expiresAt,
        documents,
        recipients: snapshot.data.recipients.map((recipient) => ({
          recipientId: recipient.recipientId,
          name: recipient.name,
          email: recipient.email,
          recipientType: recipient.recipientType === 'carbon_copy' ? 'carbon_copy' : 'signer',
          routingOrder: recipient.routingOrder,
          roleName: recipient.roleName,
          authenticationMethod: recipient.authenticationMethod,
        })),
        mappedFields: snapshot.data.mappedFields ?? [],
      };
      let prepared;
      try {
        prepared = await adapter.prepareEnvelope(context, envelopeInput);
      } catch (error) {
        // A transport failure here may still have created a draft at the provider; the stable failure
        // says so by category, and the abandon/reconcile path is the operator's next step.
        throw toModuleError(error, connection.providerKey);
      }
      const updated = await this.requests.attachProviderEnvelope(id, current.version, prepared.providerEnvelopeId, prepared.status);
      await this.audit.append({
        action: 'request.prepared',
        requestId: id,
        actor: this.actorRef(),
        detail: { envelopeCreated: true, envelopeStatus: prepared.status, providerDocumentCount: Object.keys(prepared.providerDocumentIds).length },
      });
      return {
        request: await this.view(updated),
        envelope: { providerEnvelopeId: prepared.providerEnvelopeId, status: 'draft', createdAt: prepared.preparedAt, created: true },
      };
    });
  }

  /**
   * Delete the provider draft and forget it locally.
   *
   * Only an unsent request may do this, and only while it still names an envelope; the provider call is
   * attempted first, and the id is cleared either way — a draft the provider already lost needs no local
   * trace, and leaving the id behind would block the next preparation forever.
   */
  async abandonProviderEnvelope(id: string): Promise<{ request: SignatureRequestView; deleted: boolean }> {
    const request = await this.loadScoped(id, 'write');
    if (request.providerEnvelopeId === null) {
      throw new ValidationError('The request has no provider envelope to abandon.', { code: 'SIGNATURE_REQUEST_INVALID_STATE' });
    }
    if (request.status !== 'ready_to_send' && request.status !== 'pending_approval') {
      throw signatureRequestInvalidStateError(request.status, 'abandon the provider draft');
    }
    const connection = request.connectionId === null ? undefined : await this.connections.findById(request.connectionId);
    if (connection === undefined) throw providerNotConnectedError('no_connection');
    const adapter = this.providers.require(connection.providerKey);
    const context = await this.connectionService.contextFor(connection);
    let deleted = false;
    try {
      ({ deleted } = await adapter.abandonDraftEnvelope(context, request.providerEnvelopeId));
    } catch (error) {
      throw toModuleError(error, connection.providerKey);
    }
    const released = await this.requests.releaseProviderEnvelope(id, request.version, this.scope.userId);
    await this.audit.append({
      action: 'request.updated',
      requestId: id,
      actor: this.actorRef(),
      detail: { change: 'provider_draft_abandoned', providerDeleted: deleted },
    });
    return { request: await this.view(released), deleted };
  }

  private async buildPreview(request: SignatureRequest): Promise<SignaturePreview> {
    const [documents, recipients] = await Promise.all([
      this.snapshots.listForRequest(request.id, ['source_snapshot']),
      this.recipients.listForRequest(request.id),
    ]);
    const settings = await this.settingsService.settings();
    const connection = request.connectionId === null ? undefined : await this.connections.findById(request.connectionId);
    const mapping = request.templateMappingId === null ? undefined : await this.mappings.findById(request.templateMappingId);
    let sourceValues: Record<string, unknown> | null = null;
    if (request.sourceEntityType !== null && request.sourceRecordId !== null) {
      const record = await this.store.findById(request.sourceEntityType, request.sourceRecordId);
      // The preview reads the source record's values only when the caller may read the record itself;
      // otherwise the mapping's required tabs are reported as unavailable rather than filled from data
      // the request's own screen could not show.
      if (record !== undefined && (await this.acl.canAccessRecord(request.sourceEntityType, 'read', sourceShape(record))).allowed) {
        sourceValues = record.data;
      }
    }
    return buildSignaturePreview({
      request,
      documents,
      recipients,
      settings,
      connection:
        connection === undefined
          ? null
          : { environment: connection.environment, accountId: connection.accountId, status: connection.status },
      mapping: mapping ?? null,
      sourceValues,
    });
  }

  /**
   * The guard on binding a mapping to a draft.
   *
   * A mapping is configuration for one account's template, so it may only be bound to a request that
   * sends through the same connection, and only while it is active. Binding is a draft-time choice; a
   * retired mapping that a request already names stays named (the snapshot is the evidence).
   */
  private async assertMappingBindable(connectionId: string | null, mappingId: string): Promise<void> {
    const mapping = await this.mappings.requireById(mappingId);
    if (connectionId === null) {
      throw new ValidationError('A template mapping can only be used by a request with a provider connection.', { code: 'MAPPING_REQUIRES_CONNECTION' });
    }
    if (mapping.connectionId !== connectionId) {
      throw new ValidationError('That template mapping belongs to a different provider connection.', { code: 'MAPPING_CONNECTION_MISMATCH' });
    }
    if (!mapping.isActive) throw new ValidationError('That template mapping is switched off.', { code: 'MAPPING_INACTIVE' });
  }

  /**
   * Drop a preparation the draft has outgrown.
   *
   * Called after every draft mutation. A stored preview that no longer matches the draft is removed and
   * the request returns to `draft`, taking any approval given for the old bytes with it (plan §11.2).
   * A request that never prepared anything is left untouched, and one that is already sending is not
   * reachable here (its edits were refused before the mutation ran).
   */
  private async dropStalePreparation(requestId: string): Promise<void> {
    const before = await this.requests.requireById(requestId);
    if (before.outgoingDigest === null && before.status !== 'pending_approval' && before.status !== 'ready_to_send') return;
    const after = await this.requests.invalidatePreparation(requestId, this.scope.userId);
    if (after.version !== before.version) {
      await this.audit.append({
        action: 'request.updated',
        requestId,
        actor: this.actorRef(),
        detail: { change: 'preparation_invalidated', fromStatus: before.status },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // views and guards
  // ---------------------------------------------------------------------------

  async view(request: SignatureRequest): Promise<SignatureRequestView> {
    const [recipients, documents] = await Promise.all([
      this.recipients.listForRequest(request.id),
      this.snapshots.listForRequest(request.id),
    ]);
    return {
      id: request.id,
      name: request.name,
      description: request.description,
      status: request.status,
      providerKey: request.providerKey,
      connectionId: request.connectionId,
      providerEnvelopeId: request.providerEnvelopeId,
      providerStatusRaw: request.providerStatusRaw,
      templateMappingId: request.templateMappingId,
      source: await this.resolveSource(request.sourceEntityType, request.sourceRecordId),
      subject: request.subject,
      message: request.message,
      emailBlurb: request.emailBlurb,
      expiresAt: request.expiresAt,
      approvalRequired: request.approvalRequired,
      approvalStatus: request.approvalStatus,
      approvalReason: request.approvalReason,
      createdById: request.createdById,
      assignedUserId: request.assignedUserId,
      teamIds: request.teamIds,
      preparedAt: request.preparedAt,
      sentAt: request.sentAt,
      completedAt: request.completedAt,
      declinedAt: request.declinedAt,
      voidedAt: request.voidedAt,
      version: request.version,
      createdAt: request.createdAt,
      modifiedAt: request.modifiedAt,
      editable: isEditable(request.status),
      recipients: recipients.map(toRecipientView),
      documents: documents.map(toDocumentView),
    };
  }

  private async toListRow(request: SignatureRequest): Promise<SignatureRequestListRow> {
    return {
      id: request.id,
      name: request.name,
      status: request.status,
      source: await this.resolveSource(request.sourceEntityType, request.sourceRecordId),
      assignedUserId: request.assignedUserId,
      createdById: request.createdById,
      approvalStatus: request.approvalStatus,
      sentAt: request.sentAt,
      modifiedAt: request.modifiedAt,
    };
  }

  /**
   * Load a request the caller is allowed to see, or refuse.
   *
   * `write` additionally requires `manageDraft`; both modes apply the record scope, because a draft is
   * only editable by someone who may read it. The record is never returned to a caller who is out of
   * scope — the refusal says nothing about whether the id exists.
   */
  private async loadScoped(id: string, mode: 'read' | 'write' = 'read'): Promise<SignatureRequest> {
    await this.permissions.assert(mode === 'read' ? 'use' : 'manageDraft');
    await this.assertModuleEnabled();
    const request = await this.requests.requireById(id);
    await this.assertRecordAccess(request);
    if (mode === 'write' && !isEditable(request.status)) {
      // The repository enforces this too; answering here gives the caller the module's stable code and
      // a 409 instead of a generic validation failure, which is what plan §8.2 asks for.
      throw signatureRequestInvalidStateError(request.status, 'edit the request');
    }
    return request;
  }

  private async assertRecordAccess(request: SignatureRequest): Promise<void> {
    const decision = await this.acl.canAccessRecord('SignatureRequest', 'read', recordShape(request));
    if (!decision.allowed) {
      // The module's own resource, evaluated by the platform's evaluator: `own`, `team`, `all` and the
      // administrator wildcard all mean here what they mean for every other record.
      throw new AuthorizationDeniedError('You do not have access to this signature request.', { requestId: request.id });
    }
  }

  /**
   * The linked source record, as much of it as the caller may see.
   *
   * A request keeps working after its source is deleted (the id is stored without a foreign key), so a
   * missing record is reported as `missing` rather than hidden. A record that exists but is out of
   * scope is reported as `accessible: false` with no label: the request's own ACL admitted the caller,
   * and the *linked* record's ACL decides whether its name is any of their business.
   */
  private async resolveSource(entityType: string | null, recordId: string | null): Promise<SignatureRequestSourceView | null> {
    if (entityType === null || recordId === null) return null;
    const record = await this.store.findById(entityType, recordId);
    if (record === undefined) return { entityType, recordId, label: null, accessible: false, missing: true };
    const decision = await this.acl.canAccessRecord(entityType, 'read', sourceShape(record));
    const label = decision.allowed ? displayNameOf(record) : null;
    return { entityType, recordId, label, accessible: decision.allowed, missing: false };
  }

  /**
   * Refuse to *set* a link the caller cannot read.
   *
   * This is the write-side half of the linked-record rule: a request must not be usable to probe ids,
   * and a link the creator cannot open is a link that will later hide the evidence from them.
   */
  private async assertSourceReadable(entityType: string, recordId: string | null): Promise<void> {
    if (recordId === null || recordId.trim() === '') {
      throw new ValidationError('A linked source record needs both its entity type and its id.', { sourceEntityType: entityType });
    }
    const entities = new Set(this.metadata.registry.getEntities());
    if (!entities.has(entityType)) {
      throw new ValidationError(`"${entityType}" is not a metadata entity, so it cannot be a signature source.`, { sourceEntityType: entityType });
    }
    const record = await this.store.findById(entityType, recordId.trim());
    if (record === undefined) {
      throw new ValidationError('The linked source record does not exist.', { sourceEntityType: entityType, sourceRecordId: recordId });
    }
    const decision = await this.acl.canAccessRecord(entityType, 'read', sourceShape(record));
    if (!decision.allowed) {
      throw new AuthorizationDeniedError('You cannot read the linked source record.', {
        sourceEntityType: entityType,
        sourceRecordId: recordId,
      });
    }
  }

  /** The module switch and the request workspace flag, as the settings service composes them. */
  private async assertModuleEnabled(): Promise<void> {
    const view = await this.settingsService.read();
    if (view.settings.enabled !== true) throw signatureModuleDisabledError('ESignature');
    if (view.effective.requests !== true) throw signatureModuleDisabledError('ESignature.requests');
  }

  private actorRef(): NonNullable<AuditInput['actor']> {
    const id = this.scope.userId;
    return id === undefined || id === 'system' ? { type: 'system' } : { type: 'user', id };
  }
}

/** The record shape the platform's ACL evaluator reads, from this module's row. */
function recordShape(request: SignatureRequest): AclRecordLike {
  return {
    id: request.id,
    assignedUserId: request.assignedUserId ?? undefined,
    createdById: request.createdById ?? undefined,
    teams: request.teamIds,
    data: { assignedUserId: request.assignedUserId, createdById: request.createdById, teams: [...request.teamIds] },
  };
}

function sourceShape(record: EntityRecord): AclRecordLike {
  const teams = Array.isArray(record.data['teams']) ? (record.data['teams'] as string[]) : undefined;
  return {
    id: record.id,
    ...(record.assignedUserId !== undefined ? { assignedUserId: record.assignedUserId } : {}),
    ...(record.createdById !== undefined ? { createdById: record.createdById } : {}),
    ...(teams !== undefined ? { teams } : {}),
    data: record.data,
  };
}

function displayNameOf(record: EntityRecord): string {
  const name = record.data['name'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : record.id;
}

function toRecipientView(recipient: SignatureRecipient): SignatureRequestRecipientView {
  return {
    id: recipient.id,
    name: recipient.name,
    email: recipient.email,
    recipientType: recipient.recipientType,
    roleName: recipient.roleName,
    routingOrder: recipient.routingOrder,
    status: recipient.status,
    crmContactId: recipient.crmContactId,
  };
}

function toDocumentView(document: SignatureDocumentSnapshot): SignatureRequestDocumentView {
  return {
    id: document.id,
    artifactKind: document.artifactKind,
    displayName: document.displayName,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    contentHashSha256: document.contentHashSha256,
    documentOrder: document.documentOrder,
    providerDocumentId: document.providerDocumentId,
    createdAt: document.createdAt,
  };
}
