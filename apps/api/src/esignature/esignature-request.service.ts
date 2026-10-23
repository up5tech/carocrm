import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import type { RecordStorePort } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityRecord } from '@carocrm/entity-engine/types/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService,type AclRecordLike } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import { METADATA_STORE,type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ESignatureDocumentService } from './esignature-document.service.js';
import type { SignatureRequestStatus } from './esignature-domain.js';
import { signatureModuleDisabledError, signatureRequestInvalidStateError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { isEditable } from './esignature-state-machine.js';
import { type AuditInput, SignatureAuditRepository } from './signature-audit.repository.js';
import { type SignatureDocumentSnapshot, SignatureDocumentSnapshotRepository } from './signature-document-snapshot.repository.js';
import { type SignatureRecipient, SignatureRecipientRepository } from './signature-recipient.repository.js';
import { type RequestAccessScope, type SignatureRequest, SignatureRequestRepository } from './signature-request.repository.js';

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

    const created = await this.requests.createDraft({
      name: input.name,
      ...(input.description !== undefined && input.description !== null ? { description: input.description } : {}),
      ...(input.subject !== undefined && input.subject !== null ? { subject: input.subject } : {}),
      ...(input.message !== undefined && input.message !== null ? { message: input.message } : {}),
      ...(input.emailBlurb !== undefined && input.emailBlurb !== null ? { emailBlurb: input.emailBlurb } : {}),
      ...(input.expiresAt !== undefined && input.expiresAt !== null ? { expiresAt: input.expiresAt } : {}),
      ...(input.connectionId !== undefined && input.connectionId !== null ? { connectionId: input.connectionId } : {}),
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
    return this.view(updated);
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
    return toDocumentView(result.snapshot);
  }

  async replaceDocument(id: string, documentOrder: number, attachmentId: string): Promise<SignatureRequestDocumentView> {
    const request = await this.loadScoped(id, 'write');
    const result = await this.documents.replaceDocument({ requestId: request.id, documentOrder, attachmentId });
    return toDocumentView(result.snapshot);
  }

  async detachDocument(id: string, snapshotId: string): Promise<{ detached: string }> {
    const request = await this.loadScoped(id, 'write');
    return this.documents.detachDocument(request.id, snapshotId);
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
