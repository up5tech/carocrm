import type { AclAction, AclCheckOptions, AclDecision, AclRecordAccess,AclRoleLevel } from '../types/index.js';
import { maxLevel } from '../types/index.js';

export interface AclRoleProvider {
  getRoles(userId: string): Promise<string[]>;
  getRoleLevel(roleId: string, entity: string, action: AclAction): AclRoleLevel;
  getFieldRoleLevel(roleId: string, entity: string, field: string, action: AclAction): AclRoleLevel;
  getRecordAccess(userId: string, entity: string, record: Record<string, unknown>): Promise<AclRecordAccess>;
}

export class AclEvaluator {
  private roles = new Map<string, Map<string, Record<string, AclRoleLevel>>>();
  private fieldRoles = new Map<string, Map<string, Record<string, Record<string, AclRoleLevel>>>>();

  constructor() {}

  registerRole(
    roleId: string,
    entityPermissions: Record<string, Record<string, AclRoleLevel>>,
    fieldPermissions?: Record<string, Record<string, Record<string, AclRoleLevel>>>,
  ): void {
    this.roles.set(roleId, new Map(Object.entries(entityPermissions)));
    if (fieldPermissions) {
      this.fieldRoles.set(roleId, new Map(Object.entries(fieldPermissions)));
    }
  }

  getRoleLevel(roleId: string, entity: string, action: AclAction): AclRoleLevel {
    const entityMap = this.roles.get(roleId);
    if (!entityMap) return 'no';
    const permissions = entityMap.get(entity);
    if (!permissions) return 'no';
    return permissions[action] ?? 'no';
  }

  getFieldRoleLevel(roleId: string, entity: string, field: string, action: AclAction): AclRoleLevel {
    const fieldMap = this.fieldRoles.get(roleId);
    if (!fieldMap) return 'all';
    const entityFields = fieldMap.get(entity);
    if (!entityFields) return 'all';
    const fieldActions = entityFields[field];
    if (!fieldActions) return 'all';
    return fieldActions[action] ?? 'all';
  }

  async evaluate(options: AclCheckOptions): Promise<AclDecision> {
    const { entity, action, record, field, userId, roles = [], teams = [] } = options;

    if (!roles.length) {
      return { allowed: false, reason: 'No roles assigned' };
    }

    const levels: AclRoleLevel[] = [];
    for (const roleId of roles) {
      const level = field
        ? this.getFieldRoleLevel(roleId, entity, field, action)
        : this.getRoleLevel(roleId, entity, action);
      levels.push(level);
    }

    const effectiveLevel = maxLevel(levels);

    if (effectiveLevel === 'no') {
      return { allowed: false, reason: `No ${action} permission for ${entity}` };
    }

    if (effectiveLevel === 'yes' || effectiveLevel === 'all') {
      return { allowed: true, scope: effectiveLevel };
    }

    if (effectiveLevel === 'team') {
      if (!record) return { allowed: true, scope: 'team' };
      const recordTeams = (record as { teams?: string[] }).teams ?? [];
      const hasTeam = teams.some((t) => recordTeams.includes(t));
      if (hasTeam) return { allowed: true, scope: 'team' };
      return { allowed: false, reason: 'Record not in user teams' };
    }

    if (effectiveLevel === 'own') {
      if (!record) return { allowed: true, scope: 'own' };
      const assignedUserId = (record as { assignedUserId?: string }).assignedUserId;
      const createdById = (record as { createdById?: string }).createdById;
      if (assignedUserId === userId || createdById === userId) {
        return { allowed: true, scope: 'own' };
      }
      return { allowed: false, reason: 'Record not assigned to user' };
    }

    return { allowed: false, reason: 'Access denied' };
  }

  async canCreate(userId: string, entity: string, roles: string[]): Promise<AclDecision> {
    return this.evaluate({ entity, action: 'create', userId, roles });
  }

  async canRead(
    userId: string,
    entity: string,
    record: Record<string, unknown> | undefined,
    roles: string[],
    teams: string[],
  ): Promise<AclDecision> {
    return this.evaluate({ entity, action: 'read', record, userId, roles, teams });
  }

  async canEdit(
    userId: string,
    entity: string,
    record: Record<string, unknown>,
    roles: string[],
    teams: string[],
  ): Promise<AclDecision> {
    return this.evaluate({ entity, action: 'edit', record, userId, roles, teams });
  }

  async canDelete(
    userId: string,
    entity: string,
    record: Record<string, unknown>,
    roles: string[],
    teams: string[],
  ): Promise<AclDecision> {
    return this.evaluate({ entity, action: 'delete', record, userId, roles, teams });
  }

  async canStream(
    userId: string,
    entity: string,
    record: Record<string, unknown>,
    roles: string[],
    teams: string[],
  ): Promise<AclDecision> {
    return this.evaluate({ entity, action: 'stream', record, userId, roles, teams });
  }

  getFieldAccess(
    roleId: string,
    entity: string,
    field: string,
    action: AclAction,
  ): AclRoleLevel {
    return this.getFieldRoleLevel(roleId, entity, field, action);
  }

  isFieldVisible(roleId: string, entity: string, field: string): boolean {
    const level = this.getFieldRoleLevel(roleId, entity, field, 'read');
    return level !== 'no';
  }

  isFieldEditable(roleId: string, entity: string, field: string): boolean {
    const level = this.getFieldRoleLevel(roleId, entity, field, 'edit');
    return level !== 'no';
  }
}

export const ACL_EVALUATOR = Symbol('ACL_EVALUATOR');