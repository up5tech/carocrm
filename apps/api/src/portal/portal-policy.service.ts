/**
 * Phase 18 — portal ACL policy (PLAN §37).
 *
 * "Never reuse internal admin ACL blindly for portal requests. Portal ACL should have its own
 * policy provider built on shared authorization primitives." This service IS that provider:
 * `AclApiService` delegates every decision for a portal principal here, and this service
 *
 *   - resolves authority ONLY from `portal_roles` (the internal `roles` table is never read),
 *   - reuses the shared `@carocrm/acl` evaluator and the same level vocabulary,
 *   - and narrows record visibility to the portal user's own Contact/Account plus one link hop,
 *     which is what makes "a contact can safely access permitted records without gaining
 *     internal access" true even when a portal role grants entity-level `all`.
 */
import { AclEvaluator } from '@carocrm/acl/evaluator/index.js';
import type { AclAction, AclDecision, AclRoleLevel } from '@carocrm/acl/types/index.js';
import { maxLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { toCamelCase } from '@carocrm/query-engine/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { AclPredicate,PortalLinkField  } from '../acl/predicate.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import type { PostgresRecordStore } from '../entity/entity-record.store.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';

export type { PortalLinkField } from '../acl/predicate.js';

/** Field access pair, mirroring the internal ACL vocabulary. */
export interface PortalFieldAccess {
  readonly read: AclRoleLevel;
  readonly edit: AclRoleLevel;
}

export interface PortalAclRecordLike {
  /** Record id — required for portal visibility; without it the decision fails closed. */
  readonly id?: string | undefined;
  readonly assignedUserId?: string | undefined;
  readonly createdById?: string | undefined;
  readonly teams?: readonly string[] | undefined;
  /** Full record attributes when the caller already has them, to avoid a re-read. */
  readonly data?: Record<string, unknown> | undefined;
}

interface PortalRoleRow {
  readonly id: string;
  readonly permissions: Record<string, Record<string, string | undefined>>;
  readonly fieldPermissions: Record<string, Record<string, Record<string, string | undefined>>>;
}

interface PortalSnapshot {
  /** False when the principal is not a valid portal user — every decision then denies. */
  readonly ready: boolean;
  readonly roles: readonly PortalRoleRow[];
  readonly roleIds: readonly string[];
  readonly contactId: string | null;
  readonly accountId: string | null;
  readonly evaluators: Map<string, AclEvaluator>;
}

const ENTITY_WILDCARD = '*';
const SNAPSHOT_CACHE_LIMIT = 256;
const LINK_SINGLE_TYPES: ReadonlySet<string> = new Set(['link', 'linkOne', 'foreign']);
const LINK_MULTIPLE_TYPES: ReadonlySet<string> = new Set(['linkMultiple', 'attachmentMultiple']);
/** Physical/ownership columns the portal link scan never treats as a contact/account relation. */
const RESERVED_LINK_FIELDS: ReadonlySet<string> = new Set(['assignedUserId', 'createdById', 'modifiedById', 'teams']);

@Injectable()
export class PortalPolicyService {
  private readonly snapshots = new Map<string, PortalSnapshot>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(ENTITY_STORE) private readonly store: PostgresRecordStore,
  ) {}

  invalidateSnapshotCache(): void {
    this.snapshots.clear();
  }

  /** Effective portal-role level of the current principal for `entity`/`action`. */
  async canUser(entity: string, action: AclAction): Promise<AclRoleLevel> {
    const snapshot = await this.snapshot();
    if (!snapshot.ready || snapshot.roles.length === 0) return 'no';
    const levels = snapshot.roles.map((role) => portalRoleLevel(role, entity, action));
    return maxLevel(levels);
  }

  /** Throws 403 when the portal role grants no access at all. */
  async assertAccess(entity: string, action: AclAction): Promise<AclRoleLevel> {
    const level = await this.canUser(entity, action);
    if (level === 'no') {
      throw new AuthorizationDeniedError(`No "${action}" permission for "${entity}".`, { entity, action });
    }
    return level;
  }

  /** Merged (max) field access across the portal user's roles; unrestricted defaults to 'all'. */
  async fieldAccess(entity: string, field: string): Promise<PortalFieldAccess> {
    const snapshot = await this.snapshot();
    if (!snapshot.ready) return { read: 'no', edit: 'no' };
    const camel = toCamelCase(field);
    const evaluator = evaluatorFor(snapshot, entity);
    const read = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, camel, 'read')));
    const edit = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, camel, 'edit')));
    return { read, edit };
  }

  /** Every metadata field the portal user may read (used by list/detail serialization). */
  async visibleFields(entity: string): Promise<string[]> {
    const snapshot = await this.snapshot();
    const fields = Object.keys(this.metadata.registry.getFields(entity));
    if (!fields.includes('id')) fields.unshift('id');
    if (!snapshot.ready) return [];
    const evaluator = evaluatorFor(snapshot, entity);
    return fields.filter((field) => {
      const level = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, toCamelCase(field), 'read')));
      return level !== 'no';
    });
  }

  /** Remove fields the portal role may not read from a serialized record. */
  async stripRestricted(entity: string, dto: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot();
    if (!snapshot.ready) return {};
    const evaluator = evaluatorFor(snapshot, entity);
    const restricted = new Set<string>();
    for (const key of Object.keys(dto)) {
      const level = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, toCamelCase(key), 'read')));
      if (level === 'no') restricted.add(key);
    }
    if (restricted.size === 0) return dto;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (!restricted.has(key)) out[key] = value;
    }
    return out;
  }

  /** Reject writes touching fields the portal role restricts with edit level 'no'. */
  async assertFieldWrites(entity: string, data: Record<string, unknown>): Promise<void> {
    const snapshot = await this.snapshot();
    if (!snapshot.ready) {
      throw new AuthorizationDeniedError(`No write permission for "${entity}".`, { entity });
    }
    const evaluator = evaluatorFor(snapshot, entity);
    const blocked: string[] = [];
    for (const key of Object.keys(data)) {
      if (data[key] === undefined) continue;
      const level = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, toCamelCase(key), 'edit')));
      if (level === 'no') blocked.push(key);
    }
    if (blocked.length > 0) {
      throw new AuthorizationDeniedError(`Field(s) ${blocked.join(', ')} cannot be modified.`, { entity, fields: blocked });
    }
  }

  /**
   * Record-scope predicate. Portal record visibility is ALWAYS contact/account-scoped: even a
   * portal role with entity level `all` never sees a record outside its contact/account
   * one-hop neighbourhood (PLAN §37 "Restricted record visibility").
   */
  async recordPredicate(entity: string, _action: AclAction): Promise<AclPredicate> {
    const level = await this.canUser(entity, 'read');
    if (level === 'no') return { kind: 'denyAll' };
    const snapshot = await this.snapshot();
    if (!snapshot.contactId && !snapshot.accountId) return { kind: 'denyAll' };
    return {
      kind: 'portal',
      entity,
      contactId: snapshot.contactId,
      accountId: snapshot.accountId,
      linkFields: this.linkFieldsFor(entity),
    };
  }

  /** Record level decision honouring the portal visibility rule. Used for get/update/delete. */
  async canAccessRecord(entity: string, action: AclAction, record: PortalAclRecordLike): Promise<AclDecision> {
    const snapshot = await this.snapshot();
    if (!snapshot.ready || snapshot.roles.length === 0) {
      return { allowed: false, reason: 'No portal roles assigned' };
    }
    const evaluator = evaluatorFor(snapshot, entity);
    const entityDecision = await evaluator.evaluate({
      entity,
      action,
      record: { ...record },
      userId: this.scope.userId,
      roles: [...snapshot.roleIds],
      teams: [],
    });
    if (!entityDecision.allowed) return entityDecision;
    // Entity-level YES is not enough for a portal: the record must still be in the portal
    // user's contact/account neighbourhood (PLAN §37 "Restricted record visibility").
    const id = record.id;
    if (!id) return { allowed: false, reason: 'Record visibility cannot be established' };
    const data = record.data ?? (await this.store.findById(entity, id))?.data;
    if (!data) return { allowed: false, reason: 'Record not found' };
    if (!(await this.recordVisible(entity, id, data))) {
      return { allowed: false, reason: 'Record is not related to the portal contact or account' };
    }
    const scope = entityDecision.scope;
    return scope === undefined ? { allowed: true } : { allowed: true, scope };
  }

  /**
   * Portal record visibility for one already-loaded record (detail/write paths): the record is
   * the portal user's own Contact/Account, carries a link attribute to it, or is linked through
   * the entity link store in either direction.
   */
  async recordVisible(entity: string, recordId: string, data: Record<string, unknown>): Promise<boolean> {
    const snapshot = await this.snapshot();
    const { contactId, accountId } = snapshot;
    if (!contactId && !accountId) return false;
    // SD.11: a case marked hidden from the portal is never visible, even in the contact/account neighbourhood.
    if (entity === "Case" && data["isHiddenFromPortal"] === true) return false;
    if (recordId === contactId || recordId === accountId) return true;
    for (const link of this.linkFieldsFor(entity)) {
      const value = data[link.field];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.some((item) => item === contactId || item === accountId)) return true;
      } else if (value === contactId || value === accountId) {
        return true;
      }
    }
    return this.store.hasLinkBetween(entity, recordId, [contactId, accountId].filter((id): id is string => id !== null));
  }

  /** Link fields of `entity` pointing at Contact or Account (the portal relation surface). */
  linkFieldsFor(entity: string): PortalLinkField[] {
    const fields = this.metadata.registry.getFields(entity);
    const out: PortalLinkField[] = [];
    for (const [name, def] of Object.entries(fields)) {
      if (RESERVED_LINK_FIELDS.has(name)) continue;
      if (def.entityKey !== 'Contact' && def.entityKey !== 'Account') continue;
      if (LINK_SINGLE_TYPES.has(def.type)) out.push({ field: name, multiple: false });
      else if (LINK_MULTIPLE_TYPES.has(def.type)) out.push({ field: name, multiple: true });
    }
    return out;
  }

  private async snapshot(): Promise<PortalSnapshot> {
    const cacheKey = this.scope.requestId;
    const cached = this.snapshots.get(cacheKey);
    if (cached) return cached;

    const principal = this.scope.principal;
    let roles: PortalRoleRow[] = [];
    let contactId: string | null = principal?.contactId ?? null;
    let accountId: string | null = null;

    if (principal?.userType === 'portal') {
      const user = await this.database.db
        .selectFrom('users')
        .select(['portal_id', 'contact_id', 'portal_role_ids', 'is_active', 'is_deleted', 'type'])
        .where('id', '=', principal.userId)
        .executeTakeFirst();
      if (user && user.is_active && !user.is_deleted && user.type === 'portal') {
        contactId = user.contact_id;
        roles = await this.loadPortalRoles(user.portal_id, user.portal_role_ids);
        accountId = await this.accountOfContact(contactId);
      } else {
        // Deactivated mid-session, or the row stopped being a portal user: deny everything.
        contactId = null;
        accountId = null;
        roles = [];
      }
    }

    const snapshot: PortalSnapshot = {
      ready: principal?.userType === 'portal',
      roles,
      roleIds: roles.map((role) => role.id),
      contactId,
      accountId,
      evaluators: new Map(),
    };
    if (this.snapshots.size >= SNAPSHOT_CACHE_LIMIT) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    this.snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  /** Portal roles of a user: the portal's own roles plus the roles assigned to the user. */
  private async loadPortalRoles(portalId: string | null, directRoleIds: unknown): Promise<PortalRoleRow[]> {
    const direct = Array.isArray(directRoleIds) ? (directRoleIds as string[]) : [];
    let portalScoped: string[] = [];
    if (portalId) {
      const linked = await this.database.db
        .selectFrom('portals_portal_roles')
        .select('portal_role_id')
        .where('portal_id', '=', portalId)
        .execute();
      portalScoped = linked.map((row) => row.portal_role_id);
    }
    const roleIds = Array.from(new Set([...portalScoped, ...direct]));
    if (roleIds.length === 0) return [];
    const rows = await this.database.db
      .selectFrom('portal_roles')
      .select(['id', 'permissions', 'field_permissions'])
      .where('is_deleted', '=', false)
      .where('id', 'in', roleIds)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      permissions: asNested(row.permissions),
      fieldPermissions: asFieldNested(row.field_permissions),
    }));
  }

  /** The Account of the portal user's Contact, when it has one. */
  private async accountOfContact(contactId: string | null): Promise<string | null> {
    if (!contactId) return null;
    if (!this.metadata.registry.hasEntity('Contact')) return null;
    const contact = await this.store.findById('Contact', contactId);
    if (!contact) return null;
    const accountId = contact.data['accountId'];
    return typeof accountId === 'string' && accountId !== '' ? accountId : null;
  }
}

function evaluatorFor(snapshot: PortalSnapshot, entity: string): AclEvaluator {
  const cached = snapshot.evaluators.get(entity);
  if (cached) return cached;
  const evaluator = new AclEvaluator();
  for (const role of snapshot.roles) {
    const actions: Record<string, AclRoleLevel> = {};
    for (const action of ['create', 'read', 'edit', 'delete', 'stream'] as const) {
      actions[action] = portalRoleLevel(role, entity, action);
    }
    const fieldEntry = role.fieldPermissions[entity] ?? role.fieldPermissions[ENTITY_WILDCARD] ?? {};
    const fieldPermissions: Record<string, Record<string, AclRoleLevel>> = {};
    for (const [field, actionsByField] of Object.entries(fieldEntry)) {
      if (!actionsByField) continue;
      fieldPermissions[toCamelCase(field)] = {
        read: toLevel(actionsByField['read'], 'all'),
        edit: toLevel(actionsByField['edit'], 'all'),
      };
    }
    evaluator.registerRole(role.id, { [entity]: actions }, { [entity]: fieldPermissions });
  }
  snapshot.evaluators.set(entity, evaluator);
  return evaluator;
}

function portalRoleLevel(role: PortalRoleRow, entity: string, action: AclAction): AclRoleLevel {
  const entry = role.permissions[entity] ?? role.permissions[ENTITY_WILDCARD];
  if (!entry) return 'no';
  return toLevel(entry[action], 'no');
}

function toLevel(value: string | undefined, fallback: AclRoleLevel): AclRoleLevel {
  return isLevel(value) ? value : fallback;
}

function isLevel(value: unknown): value is AclRoleLevel {
  return value === 'yes' || value === 'all' || value === 'team' || value === 'own' || value === 'no';
}

function asNested(value: unknown): Record<string, Record<string, string | undefined>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string | undefined>> = {};
  for (const [entity, actions] of Object.entries(value as Record<string, unknown>)) {
    if (typeof actions !== 'object' || actions === null) continue;
    const entry: Record<string, string | undefined> = {};
    for (const [action, level] of Object.entries(actions as Record<string, unknown>)) {
      entry[action] = typeof level === 'string' ? level : undefined;
    }
    out[entity] = entry;
  }
  return out;
}

function asFieldNested(value: unknown): Record<string, Record<string, Record<string, string | undefined>>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, Record<string, string | undefined>>> = {};
  for (const [entity, fields] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fields !== 'object' || fields === null) continue;
    const entry: Record<string, Record<string, string | undefined>> = {};
    for (const [field, actions] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof actions !== 'object' || actions === null) continue;
      const normalized: Record<string, string | undefined> = {};
      for (const [action, level] of Object.entries(actions as Record<string, unknown>)) {
        normalized[action] = typeof level === 'string' ? level : undefined;
      }
      entry[field] = normalized;
    }
    out[entity] = entry;
  }
  return out;
}
