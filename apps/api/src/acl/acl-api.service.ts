import { AclEvaluator } from '@carocrm/acl/evaluator/index.js';
import type { AclAction, AclDecision, AclRoleLevel } from '@carocrm/acl/types/index.js';
import { maxLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError, RecordNotFoundError } from '@carocrm/core/errors/index.js';
import { toCamelCase } from '@carocrm/query-engine/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { PortalPolicyService } from '../portal/portal-policy.service.js';
import { ProjectPolicyService } from '../projects/project-policy.service.js';
import { projectScopeFor } from '../projects/project-scope.js';
import type { AclPredicate, ProjectScopedPredicate } from './predicate.js';

export type { AclPredicate } from './predicate.js';

export interface FieldAccess {
  readonly read: AclRoleLevel;
  readonly edit: AclRoleLevel;
}

/** One role's contribution to an explanation, so the administrator can see why the answer is what it is. */
export interface AclExplanationRole {
  readonly id: string;
  readonly name: string;
  readonly level: AclRoleLevel;
}

export interface AclExplanation {
  readonly userId: string;
  readonly userName: string;
  readonly entity: string;
  readonly action: AclAction;
  readonly level: AclRoleLevel;
  readonly administrator: boolean;
  readonly roles: readonly AclExplanationRole[];
}

export interface AclRecordLike {
  /** Record id — the portal policy requires it to establish record visibility. */
  readonly id?: string | undefined;
  readonly assignedUserId?: string | undefined;
  readonly createdById?: string | undefined;
  readonly teams?: readonly string[] | undefined;
  /** Full record attributes when the caller already has them (portal link visibility). */
  readonly data?: Record<string, unknown> | undefined;
}

interface RolePermissions {
  readonly [entity: string]: { readonly [action: string]: string | undefined } | undefined;
}

interface FieldPermissions {
  readonly [entity: string]: { readonly [field: string]: { readonly [action: string]: string | undefined } | undefined } | undefined;
}

interface DbRole {
  readonly id: string;
  readonly permissions: RolePermissions;
  readonly fieldPermissions: FieldPermissions;
}

interface AclSnapshot {
  readonly roles: readonly DbRole[];
  readonly roleIds: readonly string[];
  readonly userId: string | undefined;
  readonly teams: readonly string[];
  readonly admin: boolean;
  readonly evaluators: Map<string, AclEvaluator>;
}

const ENTITY_WILDCARD = '*';
const SYS_ADMIN_ROLE = 'sysAdmin';
const SNAPSHOT_CACHE_LIMIT = 256;
const ACL_ACTION_LIST: readonly AclAction[] = ['create', 'read', 'edit', 'delete', 'stream'];

/**
 * Request-facing ACL facade: resolves the DB roles of the current principal
 * (through RequestScope) into entity/field/record access decisions.
 * Registered by class token (`AclApiService`) — every injection site uses an
 * explicit `@Inject(...)` token because decorator metadata is not emitted.
 */
@Injectable()
export class AclApiService {
  private readonly snapshots = new Map<string, AclSnapshot>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(PortalPolicyService) private readonly portal: PortalPolicyService,
    @Inject(ProjectPolicyService) private readonly projects: ProjectPolicyService,
  ) {}

  /**
   * Phase 18 (PLAN §37): portal principals are decided by the portal policy provider, never by
   * the internal role tables. Internal roles, teams and the sysAdmin role are all invisible to a
   * portal session — `AuthService.principalFromUser` keeps `assigned_role_ids` empty for portal
   * users and this branch ignores them even if a row still carries them.
   */
  private get isPortalPrincipal(): boolean {
    return this.scope.userType === 'portal';
  }

  /** Effective ACL level of the current principal for `entity`/`action`. */
  async canUser(entity: string, action: AclAction): Promise<AclRoleLevel> {
    if (this.isPortalPrincipal) return this.portal.canUser(entity, action);
    const snapshot = await this.snapshot();
    if (snapshot.admin) return 'all';
    const levels = snapshot.roles.map((role) => roleLevel(role, entity, action));
    return maxLevel(levels);
  }

  /** Throws 403 when the current principal has no access at all. */
  async assertAccess(entity: string, action: AclAction): Promise<AclRoleLevel> {
    const level = await this.canUser(entity, action);
    if (level === 'no') {
      throw new AuthorizationDeniedError(`No "${action}" permission for "${entity}".`, { entity, action });
    }
    return level;
  }

  /** Merged (max) field access across the principal's roles; unrestricted defaults to 'all'. */
  async fieldAccess(entity: string, field: string): Promise<FieldAccess> {
    if (this.isPortalPrincipal) return this.portal.fieldAccess(entity, field);
    const snapshot = await this.snapshot();
    if (snapshot.admin) return { read: 'all', edit: 'all' };
    const camel = toCamelCase(field);
    const evaluator = evaluatorFor(snapshot, entity);
    const read = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, camel, 'read')));
    const edit = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, camel, 'edit')));
    return { read, edit };
  }

  /** Every metadata field the principal may read (used by list/detail serialization). */
  async visibleFields(entity: string): Promise<string[]> {
    if (this.isPortalPrincipal) return this.portal.visibleFields(entity);
    const snapshot = await this.snapshot();
    const fields = Object.keys(this.metadata.registry.getFields(entity));
    if (!fields.includes('id')) fields.unshift('id');
    if (snapshot.admin) return fields;
    const evaluator = evaluatorFor(snapshot, entity);
    return fields.filter((field) => {
      const level = maxLevel(snapshot.roles.map((role) => evaluator.getFieldRoleLevel(role.id, entity, toCamelCase(field), 'read')));
      return level !== 'no';
    });
  }

  /** Remove fields the principal may not read from a serialized record. */
  async stripRestricted(entity: string, dto: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.isPortalPrincipal) return this.portal.stripRestricted(entity, dto);
    const snapshot = await this.snapshot();
    if (snapshot.admin) return dto;
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

  /** Reject writes touching fields restricted with edit level 'no'. */
  async assertFieldWrites(entity: string, data: Record<string, unknown>): Promise<void> {
    if (this.isPortalPrincipal) {
      await this.portal.assertFieldWrites(entity, data);
      return;
    }
    const snapshot = await this.snapshot();
    if (snapshot.admin) return;
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

  /** List/detail record-scope predicate derived from the entity level. */
  async recordPredicate(entity: string, action: AclAction): Promise<AclPredicate> {
    if (this.isPortalPrincipal) return this.portal.recordPredicate(entity, action);
    const level = await this.canUser(entity, action);
    if (level === 'no') return { kind: 'denyAll' };
    // Phase 19: 'all' / 'yes' is the global policy explicitly permitting everything, so a project
    // role does not narrow it; a restricted level is widened ONLY inside projects the user belongs
    // to, and the role there narrows it further (§9 "a project role must never grant a permission
    // denied by the global ACL").
    if (level === 'all' || level === 'yes') return { kind: 'allowAll' };
    const userId = this.scope.userId;
    if (!userId) return { kind: 'denyAll' };
    const base = { kind: level === 'own' ? ('own' as const) : ('team' as const), userId, teamIds: this.scope.teamIds() };
    const scope = projectScopeFor(entity, action);
    if (scope === undefined) return base;
    return {
      kind: 'projectScoped',
      userId,
      base,
      projectAttr: scope.projectAttr,
      roleField: scope.roleField,
      allValues: scope.allValues,
      assignedValues: scope.assignedValues,
      ownValues: scope.ownValues,
    } satisfies ProjectScopedPredicate;
  }

  /**
   * Phase 19: project-scoped access for an already-loaded record, evaluated by the same rule the
   * record store puts into SQL. A `projectScoped` predicate can only exist for an internal
   * principal, so anything else fails closed.
   */
  async projectScopedAllows(predicate: ProjectScopedPredicate, recordId: string, data: Record<string, unknown>): Promise<boolean> {
    if (this.isPortalPrincipal) return false;
    return this.projects.allowsScoped(predicate, recordId, data);
  }

  /**
   * Record level decision honouring own/team scoping (internal) or portal contact/account
   * visibility (Phase 18). Used for get/update/delete.
   */
  async canAccessRecord(entity: string, action: AclAction, record: AclRecordLike): Promise<AclDecision> {
    if (this.isPortalPrincipal) return this.portal.canAccessRecord(entity, action, record);
    const snapshot = await this.snapshot();
    if (snapshot.admin) return { allowed: true, scope: 'all' };
    if (snapshot.roleIds.length === 0) return { allowed: false, reason: 'No roles assigned' };
    const evaluator = evaluatorFor(snapshot, entity);
    return evaluator.evaluate({
      entity,
      action,
      record: { ...record },
      userId: snapshot.userId,
      roles: [...snapshot.roleIds],
      teams: [...snapshot.teams],
    });
  }

  /**
   * Phase 18: portal record visibility for an already-loaded record (detail/write paths).
   * A portal predicate can only exist for a portal principal, so anything else fails closed.
   */
  async portalRecordVisible(entity: string, recordId: string, data: Record<string, unknown>): Promise<boolean> {
    if (!this.isPortalPrincipal) return false;
    return this.portal.recordVisible(entity, recordId, data);
  }

  /** 403 when the action is not permitted at entity level, 403 also when the record is out of scope. */
  async assertRecordAccess(entity: string, action: AclAction, record: AclRecordLike): Promise<boolean> {
    if (this.isPortalPrincipal) {
      const decision = await this.portal.canAccessRecord(entity, action, record);
      if (!decision.allowed) {
        throw new AuthorizationDeniedError(decision.reason ?? `No "${action}" access to this "${entity}" record.`, { entity, action });
      }
      return true;
    }
    const level = await this.canUser(entity, action);
    if (level === 'no') {
      throw new AuthorizationDeniedError(`No "${action}" permission for "${entity}".`, { entity, action });
    }
    if (level === 'all' || level === 'yes') return true;
    const decision = await this.canAccessRecord(entity, action, record);
    if (!decision.allowed) {
      throw new AuthorizationDeniedError(
        decision.reason ?? `No "${action}" access to this "${entity}" record.`,
        { entity, action },
      );
    }
    return true;
  }

  /**
   * "Why can this user do this?" for the Permissions tab (PLAN_Phase_20_Settings_UX.md §4.8).
   *
   * The evaluation is the same `roleLevel`/`maxLevel` pair `canUser` uses, so the explanation cannot
   * disagree with the decision. It answers for an **arbitrary** user, which the request-scoped
   * snapshot cannot, so it loads that user's roles directly. Administrator accounts resolve to `all`
   * without consulting a role, exactly like the runtime. Role names are returned because an
   * explanation nobody can act on is not an explanation; nothing else about the user is exposed.
   */
  async explainFor(userId: string, entity: string, action: AclAction): Promise<AclExplanation> {
    const { user, administrator, rows } = await this.loadGrant(userId);
    const roles: AclExplanationRole[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      level: roleLevel(toDbRole(row.id, row.permissions, row.field_permissions), entity, action),
    }));

    return {
      userId,
      userName: user.user_name,
      entity,
      action,
      level: administrator ? 'all' : maxLevel(roles.map((role) => role.level)),
      administrator,
      roles,
    };
  }

  /**
   * §4.9 menu preview: the same evaluation `canUser` runs, but for an **arbitrary internal user**
   * instead of the request principal. The request-scoped snapshot cannot answer that, so it loads
   * that user's grant directly — exactly like `explainFor`, and for the same reason.
   */
  async canUserAs(userId: string, entity: string, action: AclAction): Promise<AclRoleLevel> {
    const { administrator, rows } = await this.loadGrant(userId);
    if (administrator) return 'all';
    return maxLevel(rows.map((row) => roleLevel(toDbRole(row.id, row.permissions, row.field_permissions), entity, action)));
  }

  /** Whether an arbitrary user is administrative — the administrator gates of the menu preview. */
  async isAdminFor(userId: string): Promise<boolean> {
    const { administrator } = await this.loadGrant(userId);
    return administrator;
  }

  /** Load one internal user's administrative flag and role rows; throws when the user is gone. */
  private async loadGrant(userId: string): Promise<{
    user: { id: string; user_name: string };
    administrator: boolean;
    rows: { id: string; name: string; permissions: unknown; field_permissions: unknown }[];
  }> {
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'user_name', 'is_admin', 'type', 'assigned_role_ids'])
      .where('id', '=', userId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!user) throw new RecordNotFoundError('User', userId);

    const rawRoleIds: unknown = user.assigned_role_ids;
    const roleIds = Array.isArray(rawRoleIds) ? rawRoleIds.filter((id): id is string => typeof id === 'string') : [];
    const administrator = user.is_admin || user.type === 'admin' || roleIds.includes(SYS_ADMIN_ROLE);

    const rows = administrator || roleIds.length === 0
      ? []
      : await this.database.db
          .selectFrom('roles')
          .select(['id', 'name', 'permissions', 'field_permissions'])
          .where('id', 'in', roleIds)
          .where('is_deleted', '=', false)
          .execute();
    return { user: { id: user.id, user_name: user.user_name }, administrator, rows };
  }

  /** Drop any memoised role snapshot (call after modifying roles, teams or portal assignments). */
  invalidateSnapshotCache(): void {
    this.snapshots.clear();
    this.portal.invalidateSnapshotCache();
  }

  private async snapshot(): Promise<AclSnapshot> {
    const cacheKey = this.scope.requestId;
    const cached = this.snapshots.get(cacheKey);
    if (cached) return cached;

    const principal = this.scope.principal;
    const roleIds = principal ? [...principal.roles] : [];
    const rows = await this.loadRoles(roleIds);
    const snapshot: AclSnapshot = {
      roles: rows,
      roleIds,
      userId: principal?.userId,
      teams: principal ? [...principal.teams] : [],
      admin: this.scope.isAdmin || roleIds.includes(SYS_ADMIN_ROLE),
      evaluators: new Map(),
    };
    if (this.snapshots.size >= SNAPSHOT_CACHE_LIMIT) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    this.snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  private async loadRoles(roleIds: readonly string[]): Promise<DbRole[]> {
    const rows = await this.database.db
      .selectFrom('roles')
      .select(['id', 'permissions', 'field_permissions'])
      .where('is_deleted', '=', false)
      .execute();
    const byId = new Map(rows.map((row) => [row.id, toDbRole(row.id, row.permissions, row.field_permissions)]));
    const out: DbRole[] = [];
    for (const roleId of roleIds) {
      const role = byId.get(roleId);
      if (role) out.push(role);
    }
    return out;
  }
}

function toDbRole(id: string, permissions: unknown, fieldPermissions: unknown): DbRole {
  return {
    id,
    permissions: asNested(permissions),
    fieldPermissions: asFieldNested(fieldPermissions),
  };
}

/** Explicit entity entry wins; the `*` key is the role default for every other entity. */
function roleLevel(role: DbRole, entity: string, action: AclAction): AclRoleLevel {
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

/**
 * Builds (and memoises per request) an AclEvaluator holding the DB roles with the
 * wildcard already expanded for `entity`, so record scoping can be delegated to
 * the shared @carocrm/acl engine.
 */
function evaluatorFor(snapshot: AclSnapshot, entity: string): AclEvaluator {
  const cached = snapshot.evaluators.get(entity);
  if (cached) return cached;

  const evaluator = new AclEvaluator();
  for (const role of snapshot.roles) {
    const actions: Record<string, AclRoleLevel> = {};
    for (const action of ACL_ACTION_LIST) {
      actions[action] = roleLevel(role, entity, action);
    }
    const fieldEntry = role.fieldPermissions[entity] ?? role.fieldPermissions[ENTITY_WILDCARD] ?? {};
    const fieldPermissions: Record<string, Record<string, AclRoleLevel>> = {};
    for (const [field, actionsByField] of Object.entries(fieldEntry)) {
      if (!actionsByField) continue;
      const normalized: Record<string, AclRoleLevel> = {};
      for (const action of ['read', 'edit'] as const) {
        normalized[action] = toLevel(actionsByField[action], 'all');
      }
      fieldPermissions[toCamelCase(field)] = normalized;
    }
    evaluator.registerRole(role.id, { [entity]: actions }, { [entity]: fieldPermissions });
  }
  snapshot.evaluators.set(entity, evaluator);
  return evaluator;
}

function asNested(value: unknown): RolePermissions {
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

function asFieldNested(value: unknown): FieldPermissions {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, Record<string, string | undefined> | undefined>> = {};
  for (const [entity, fields] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fields !== 'object' || fields === null) continue;
    const entry: Record<string, Record<string, string | undefined> | undefined> = {};
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
