export type AclRoleLevel = 'yes' | 'all' | 'team' | 'own' | 'no';

export type AclAction = 'create' | 'read' | 'edit' | 'delete' | 'stream';

export type AclScope = 'entity' | 'field' | 'record';

export interface AclRole {
  id: string;
  name: string;
  level: AclRoleLevel;
  permissions: Record<string, Record<string, AclRoleLevel>>;
  fieldPermissions: Record<string, Record<string, Record<string, AclRoleLevel>>>;
}

export interface AclContext {
  userId: string;
  userType: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles: string[];
  teams: string[];
  tenantId?: string;
}

export interface AclCheckOptions {
  entity: string;
  action: AclAction;
  record?: Record<string, unknown> | undefined;
  field?: string | undefined;
  userId?: string | undefined;
  roles?: string[] | undefined;
  teams?: string[] | undefined;
  assignedUserId?: string | undefined;
  createdById?: string | undefined;
}

export interface AclDecision {
  allowed: boolean;
  reason?: string;
  scope?: AclRoleLevel;
}

export interface AclRecordAccess {
  own: boolean;
  team: boolean;
  assigned: boolean;
  related: boolean;
  explicit: boolean;
}

export const ROLE_LEVELS: Record<AclRoleLevel, number> = {
  no: 0,
  own: 1,
  team: 2,
  all: 3,
  yes: 4,
};

export function maxLevel(levels: AclRoleLevel[]): AclRoleLevel {
  let max: AclRoleLevel = 'no';
  for (const level of levels) {
    if (ROLE_LEVELS[level] > ROLE_LEVELS[max]) {
      max = level;
    }
  }
  return max;
}

export function levelAtLeast(level: AclRoleLevel, required: AclRoleLevel): boolean {
  return ROLE_LEVELS[level] >= ROLE_LEVELS[required];
}