import type { RecordStorePort } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityRecord } from '@carocrm/entity-engine/types/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { AclRecordLike } from '../acl/acl-api.service.js';
import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { type RequestAccessScope, SignatureRequestRepository } from './signature-request.repository.js';

/**
 * Phase 19-ES.18 — the CRM record entry point
 * (`PLAN_Phase_19_ESignature.md` §2.3, §13.1, §18 `19-ES.18`).
 *
 * A record detail page should be able to offer "start a signature request from this record" without
 * every module importing ESignature and without ESignature importing every module. The answer is one
 * capability-checked endpoint: the UI renders a generic component on a record page, the server decides
 * whether this entity is an entry point, whether the caller may read the record and the module, and
 * what the caller may do.
 *
 * The supported list is a registry, not a hard dependency:
 *
 *  - `Account` and `Contact` are platform entities and are always candidates;
 *  - `Quote`/`SalesOrder`/`Invoice`, `Project`/`ProjectTask`, `Case`, `Campaign` and
 *    `CustomerSuccessProfile` are only candidates when their metadata entity exists, which is exactly
 *    when the optional module is installed.
 *
 * Availability is deliberately a **200 answer**, not a 403: a user without ESignature access sees no
 * entry point on a record page, and an installation without the module sees the same nothing. The
 * component never has to interpret an authorization error to decide whether to render.
 */

export const ENTRY_POINT_ENTITIES: Readonly<Record<string, string>> = {
  Account: 'core',
  Contact: 'core',
  Opportunity: 'sales',
  Quote: 'sales',
  SalesOrder: 'sales',
  Invoice: 'sales',
  Project: 'projects',
  ProjectTask: 'projects',
  Case: 'service-desk',
  Campaign: 'marketing',
  CustomerSuccessProfile: 'customer-success',
};

export type RecordEntryReason =
  | 'available'
  | 'module_disabled'
  | 'no_permission'
  | 'unsupported_entity'
  | 'record_missing'
  | 'record_restricted';

export interface RecordEntryRequestView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly approvalStatus: string;
  readonly modifiedAt: string;
}

export interface RecordEntryView {
  readonly available: boolean;
  readonly reason: RecordEntryReason;
  readonly entityType: string;
  readonly recordId: string;
  readonly canPrepare: boolean;
  readonly requests: readonly RecordEntryRequestView[];
}

@Injectable()
export class ESignatureRecordEntryService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(ENTITY_STORE) private readonly store: RecordStorePort,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(SignatureRequestRepository) private readonly requests: SignatureRequestRepository,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async entry(entityType: string, recordId: string): Promise<RecordEntryView> {
    const closed = (reason: RecordEntryReason): RecordEntryView => ({
      available: false,
      reason,
      entityType,
      recordId,
      canPrepare: false,
      requests: [],
    });

    const settingsView = await this.settings.read();
    if (settingsView.settings.enabled !== true || settingsView.effective.requests !== true) {
      return closed('module_disabled');
    }
    if (!(await this.permissions.can('use'))) return closed('no_permission');
    if (!Object.prototype.hasOwnProperty.call(ENTRY_POINT_ENTITIES, entityType)) return closed('unsupported_entity');
    if (!this.metadata.registry.hasEntity(entityType)) return closed('unsupported_entity');

    const record = await this.store.findById(entityType, recordId);
    if (record === undefined) return closed('record_missing');
    const decision = await this.acl.canAccessRecord(entityType, 'read', recordShape(record));
    if (!decision.allowed) return closed('record_restricted');

    const canPrepare = await this.permissions.can('manageDraft');
    const level = await this.permissions.level('use');
    const userId = this.scope.userId ?? '';
    const access: RequestAccessScope =
      level === 'all' || level === 'yes'
        ? { kind: 'all', userId, teamIds: [] }
        : { kind: level === 'team' ? 'team' : 'own', userId, teamIds: this.scope.teamIds() };
    const { list } = await this.requests.list({
      sourceEntityType: entityType,
      sourceRecordId: recordId,
      limit: 5,
      offset: 0,
      access,
    });
    return {
      available: true,
      reason: 'available',
      entityType,
      recordId,
      canPrepare,
      requests: list.map((request) => ({
        id: request.id,
        name: request.name,
        status: request.status,
        approvalStatus: request.approvalStatus,
        modifiedAt: request.modifiedAt,
      })),
    };
  }
}

/** The ACL shape the platform evaluator reads for a metadata record. */
function recordShape(record: EntityRecord): AclRecordLike {
  const teams = Array.isArray(record.data['teams']) ? (record.data['teams'] as string[]) : undefined;
  return {
    id: record.id,
    ...(record.assignedUserId !== undefined ? { assignedUserId: record.assignedUserId } : {}),
    ...(record.createdById !== undefined ? { createdById: record.createdById } : {}),
    ...(teams !== undefined ? { teams } : {}),
    data: record.data,
  };
}
