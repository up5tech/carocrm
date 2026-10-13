import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { ProjectScopedPredicate } from '../acl/predicate.js';
import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import { PROJECT_ROLE_DIMENSIONS, type ProjectFeatureFlag, type ProjectRolePolicy,roleGrants, text } from './project-domain.js';

/** A user's membership row in one project, with the role policy resolved. */
export interface ProjectMembership {
  readonly memberId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly roleId: string | null;
  readonly role: ProjectRolePolicy;
}

const EMPTY_ROLE: ProjectRolePolicy = {
  taskCreate: 'no',
  assignmentScope: 'own',
  taskReadScope: 'own',
  taskStreamScope: 'own',
  taskEditScope: 'own',
  stageMoveScope: 'own',
  taskDeleteScope: 'no',
  projectStreamAccess: 'no',
  groupManage: 'no',
  memberManage: 'no',
  projectEdit: 'no',
};

/**
 * Project membership and role policy (PLAN_Phase_19_Projects.md §4.4, §9).
 *
 * Two jobs, deliberately kept apart:
 *  - the record-scope decision, which mirrors the SQL the record store emits so a list and a
 *    by-id read agree (`allowsScoped`);
 *  - the command-level checks the generic entity API cannot express (`assertRole`, assignee
 *    eligibility, feature settings).
 *
 * A role never replaces the global ACL: `AclApiService` still has to grant the action at entity
 * level, and an entity level of `no` never reaches this service at all.
 *
 * No `AclApiService` injection here: the ACL facade depends on this policy, not the other way
 * around.
 */
@Injectable()
export class ProjectPolicyService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Inside a domain command the policy is read from the command's own transaction: a clone decides
   * "may this task be assigned to that member" about rows it created moments earlier, which another
   * connection cannot see yet.
   */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async membership(projectId: string, userId: string): Promise<ProjectMembership | undefined> {
    const rows = await sql<{ member_id: string; role_id: string | null; role: unknown }>`
      select pm.id as member_id,
             (pm.attrs ->> 'projectRoleId') as role_id,
             pr.attrs as role
      from entity_records pm
      left join entity_records pr
        on pr.id = (pm.attrs ->> 'projectRoleId') and pr.entity_type = 'ProjectRole' and pr.deleted_at is null
      where pm.entity_type = 'ProjectMember' and pm.deleted_at is null
        and (pm.attrs ->> 'projectId') = ${projectId}
        and (pm.attrs ->> 'userId') = ${userId}
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return {
      memberId: row.member_id,
      projectId,
      userId,
      roleId: row.role_id ?? null,
      role: toRolePolicy(row.role),
    };
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    return (await this.membership(projectId, userId)) !== undefined;
  }

  /** The current user's collaborators rows for a task. */
  async isCollaborator(taskId: string, userId: string): Promise<boolean> {
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'ProjectTaskCollaborator' and deleted_at is null
        and (attrs ->> 'taskId') = ${taskId} and (attrs ->> 'userId') = ${userId}
      limit 1
    `.execute(this.db);
    return rows.rows.length > 0;
  }

  /**
   * Grant a role dimension for a command, or throw. `userId` defaults to nothing: callers pass the
   * principal they are acting for, because a background job runs as the system user.
   */
  async assertRole(
    projectId: string,
    userId: string,
    dimension: keyof ProjectRolePolicy,
    details: { readonly taskId?: string; readonly ownerUserId?: string; readonly assigneeUserId?: string } = {},
  ): Promise<ProjectMembership> {
    const membership = await this.membership(projectId, userId);
    if (membership === undefined) {
      throw new AuthorizationDeniedError('Only project members may perform this action.', { projectId, dimension });
    }
    const allowed = roleGrants(membership.role, dimension, {
      userId,
      ...(details.ownerUserId !== undefined ? { ownerUserId: details.ownerUserId } : {}),
      ...(details.assigneeUserId !== undefined ? { assigneeUserId: details.assigneeUserId } : {}),
      isCollaborator: details.taskId === undefined ? false : await this.isCollaborator(details.taskId, userId),
    });
    if (!allowed) {
      throw new AuthorizationDeniedError(`The project role "${membership.roleId ?? 'none'}" does not allow "${dimension}".`, {
        projectId,
        dimension,
      });
    }
    return membership;
  }

  /**
   * `ProjectScopedPredicate` evaluated in JavaScript for one loaded record — the mirror of
   * `projectScopeSql` in the record store. Fail closed: anything unreadable is simply not allowed.
   */
  async allowsScoped(predicate: ProjectScopedPredicate, recordId: string, data: Record<string, unknown>): Promise<boolean> {
    const userId = predicate.userId;
    const projectId = predicate.projectAttr === 'id' ? recordId : text(data[predicate.projectAttr] ?? data['projectId']);
    if (projectId === undefined) return false;
    const membership = await this.membership(projectId, userId);

    // A non-member is decided by the global scope alone; a member is decided by their project role,
    // which narrows it. Mirror of `projectScopeSql` in the record store.
    if (membership === undefined) {
      const assigned = text(data['assignedUserId']);
      const created = text(data['createdById']);
      if (assigned === userId || created === userId) return true;
      if (predicate.base.kind === 'team') {
        const teams = Array.isArray(data['teams']) ? (data['teams'] as unknown[]).map(String) : [];
        return predicate.base.teamIds.some((team) => teams.includes(team));
      }
      return false;
    }
    if (predicate.roleField === null) return true;
    const dimension = PROJECT_ROLE_DIMENSIONS.find((name) => name === predicate.roleField);
    if (dimension === undefined) return false;

    return roleGrants(membership.role, dimension, {
      userId,
      ...(text(data['ownerUserId']) !== undefined ? { ownerUserId: text(data['ownerUserId']) } : {}),
      ...(text(data['assigneeUserId']) !== undefined ? { assigneeUserId: text(data['assigneeUserId']) } : {}),
      isCollaborator: await this.isCollaborator(recordId, userId),
    });
  }

  /** Feature flags of a project (§4.11). Missing flag = disabled, so a half-written project is safe. */
  async features(projectId: string): Promise<Record<ProjectFeatureFlag, boolean>> {
    const rows = await sql<{ attrs: unknown }>`
      select attrs from entity_records
      where entity_type = 'Project' and id = ${projectId} and deleted_at is null
      limit 1
    `.execute(this.db);
    const attrs = rows.rows[0]?.attrs;
    const data = typeof attrs === 'string' ? (JSON.parse(attrs) as Record<string, unknown>) : (attrs as Record<string, unknown> | undefined);
    return {
      dependenciesEnabled: data?.['dependenciesEnabled'] === true,
      collaboratorsEnabled: data?.['collaboratorsEnabled'] === true,
      priorityEnabled: data?.['priorityEnabled'] !== false,
      pointsEnabled: data?.['pointsEnabled'] === true,
      estimatedHoursEnabled: data?.['estimatedHoursEnabled'] === true,
      ganttEnabled: data?.['ganttEnabled'] !== false,
    };
  }

  /** Every project the user belongs to — used by the dashlet and the bulk member command. */
  async projectIdsOf(userId: string): Promise<string[]> {
    const rows = await sql<{ project_id: string }>`
      select (attrs ->> 'projectId') as project_id
      from entity_records
      where entity_type = 'ProjectMember' and deleted_at is null and (attrs ->> 'userId') = ${userId}
    `.execute(this.db);
    return rows.rows.map((row) => row.project_id);
  }
}

/** A `ProjectRole` record's attrs as a policy, with every unknown dimension denied. */
export function toRolePolicy(value: unknown): ProjectRolePolicy {
  const attrs = typeof value === 'string' ? safeParse(value) : value;
  if (typeof attrs !== 'object' || attrs === null) return { ...EMPTY_ROLE };
  const source = attrs as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const dimension of PROJECT_ROLE_DIMENSIONS) {
    out[dimension] = typeof source[dimension] === 'string' ? (source[dimension] as string) : EMPTY_ROLE[dimension];
  }
  return out as unknown as ProjectRolePolicy;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
