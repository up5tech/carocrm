import type { AclAction } from '@carocrm/acl/types/index.js';

import { type ProjectRolePolicy,ROLE_FIELD_FOR_ACTION, ROLE_SCOPE_ALL, ROLE_SCOPE_ASSIGNED, ROLE_SCOPE_OWN } from './project-domain.js';

/**
 * Which records a `ProjectRole` speaks for, and with which of its fields (PLAN_Phase_19_Projects.md
 * §4.4, §9). This is the only place that turns an entity/action pair into role semantics, and every
 * value here is an application constant: the ACL evaluator and the record store take the descriptor
 * as data, so no request can name a role field or a permitted value.
 */
export interface ProjectScopeDescriptor {
  /** Attribute holding the project id, or `id` when the record IS the project. */
  readonly projectAttr: string;
  /** `null` = being a member is the whole grant. */
  readonly roleField: keyof ProjectRolePolicy | null;
  readonly allValues: readonly string[];
  readonly assignedValues: readonly string[];
  readonly ownValues: readonly string[];
}

/** Entities whose access a project role can decide, beyond the global own/team scope. */
const SCOPED: ReadonlySet<string> = new Set([
  'Project',
  'ProjectTask',
  'ProjectGroup',
  'ProjectMember',
  'ProjectTaskCollaborator',
  'ProjectTaskDependency',
]);

export function isProjectScopedEntity(entity: string): boolean {
  return SCOPED.has(entity);
}

function roleDimensionScope(roleField: keyof ProjectRolePolicy, projectAttr = 'projectId'): ProjectScopeDescriptor {
  return {
    projectAttr,
    roleField,
    allValues: ROLE_SCOPE_ALL[roleField] ?? [],
    assignedValues: ROLE_SCOPE_ASSIGNED[roleField] ?? [],
    ownValues: ROLE_SCOPE_OWN[roleField] ?? [],
  };
}

/** Membership-only grant on the project's own id. */
const MEMBERSHIP_ON_ID: ProjectScopeDescriptor = { projectAttr: 'id', roleField: null, allValues: [], assignedValues: [], ownValues: [] };
const MEMBERSHIP_ON_PROJECT_ID: ProjectScopeDescriptor = { ...MEMBERSHIP_ON_ID, projectAttr: 'projectId' };

/**
 * `undefined` means "no project rule for this entity/action" — the global ACL alone decides, which
 * is the correct answer for `create` (there is no project to consult yet) and for the board/role
 * configuration entities.
 */
/** `move` is a Projects command, not a kernel ACL action; it maps to `stageMoveScope`. */
export type ProjectScopeAction = AclAction | 'move';

export function projectScopeFor(entity: string, action: ProjectScopeAction): ProjectScopeDescriptor | undefined {
  if (!isProjectScopedEntity(entity)) return undefined;

  if (entity === 'Project') {
    if (action === 'read') return MEMBERSHIP_ON_ID;
    if (action === 'edit') return roleDimensionScope('projectEdit', 'id');
    if (action === 'stream') return roleDimensionScope('projectStreamAccess', 'id');
    return undefined;
  }

  if (entity === 'ProjectMember' || entity === 'ProjectGroup') {
    if (action === 'read') return MEMBERSHIP_ON_PROJECT_ID;
    if (action === 'edit') return roleDimensionScope(entity === 'ProjectMember' ? 'memberManage' : 'groupManage');
    if (action === 'delete') return roleDimensionScope(entity === 'ProjectMember' ? 'memberManage' : 'groupManage');
    return undefined;
  }

  // ProjectTask and the two task junctions: the task's own people attributes decide the tier.
  if (action === 'create') return undefined;
  const roleField = action === 'move' ? 'stageMoveScope' : ROLE_FIELD_FOR_ACTION[action as 'read' | 'edit' | 'delete' | 'stream'];
  if (roleField === undefined) return undefined;
  return roleDimensionScope(roleField);
}
