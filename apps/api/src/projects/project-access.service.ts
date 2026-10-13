import { AuthorizationDeniedError, NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type ProjectRolePolicy,roleGrants, text } from './project-domain.js';
import { type ProjectMembership,ProjectPolicyService } from './project-policy.service.js';
import type { ProjectRow } from './project-records.js';
import { ProjectRecords } from './project-records.js';

/** The project-level answers the SPA needs to draw one screen. */
export interface ProjectCapabilities {
  projectId: string;
  boardId: string | null;
  isMember: boolean;
  role: string | null;
  roleName: string | null;
  capabilities: Record<'readTasks' | 'createTask' | 'editTask' | 'moveTask' | 'deleteTask' | 'manageGroups' | 'manageMembers' | 'editProject' | 'projectStream', boolean>;
  features: Record<'dependenciesEnabled' | 'collaboratorsEnabled' | 'priorityEnabled' | 'pointsEnabled' | 'estimatedHoursEnabled' | 'ganttEnabled', boolean>;
}

/**
 * The authority question every Projects command asks first: is this principal allowed to act on
 * this project, and through which rule?
 *
 * Two gates, in the order PLAN_Phase_19_Projects.md §9 sets out: the global ACL must grant the
 * entity action at all (otherwise the kernel already rejected the request), and inside the project
 * either the global level is broad enough to stand on its own or the caller's `ProjectRole` grants
 * the dimension. A role can never open a project the user is not a member of.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(ProjectPolicyService) private readonly policy: ProjectPolicyService,
    @Inject(ProjectRecords) private readonly records: ProjectRecords,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  get userId(): string {
    return this.scope.userId ?? '';
  }

  get isAdmin(): boolean {
    return this.scope.isAdmin;
  }

  async requireProject(projectId: string): Promise<ProjectRow> {
    const project = await this.records.byId('Project', projectId);
    if (project === undefined) throw new NotFoundError(`Project "${projectId}" does not exist.`);
    return project;
  }

  /** Global level that needs no project role behind it. */
  async isUnrestricted(entity: string, action: 'read' | 'edit' | 'delete'): Promise<boolean> {
    if (this.scope.isAdmin) return true;
    const level = await this.acl.canUser(entity, action);
    return level === 'all' || level === 'yes';
  }

  /**
   * Assert the project role dimension for a command, or skip it when the global level stands on its
   * own (§9.1: a non-member is denied, a holder of the global 'all' level is not). `taskAccess`
   * lets a task-level dimension use the task's own owner/assignee/collaborator facts.
   */
  async assertProjectAbility(
    projectId: string,
    dimension: keyof ProjectRolePolicy,
    taskAccess?: { taskId: string; ownerUserId?: string | undefined; assigneeUserId?: string | undefined },
    entity: string = 'Project',
  ): Promise<ProjectMembership | undefined> {
    const userId = this.userId;
    const membership = await this.policy.membership(projectId, userId);
    if (await this.isUnrestricted(entity, 'edit')) return membership;
    if (membership === undefined) {
      throw new AuthorizationDeniedError('Only project members may perform this action.', { projectId });
    }
    const allowed = roleGrants(membership.role, dimension, {
      userId,
      ...(taskAccess?.ownerUserId !== undefined ? { ownerUserId: taskAccess.ownerUserId } : {}),
      ...(taskAccess?.assigneeUserId !== undefined ? { assigneeUserId: taskAccess.assigneeUserId } : {}),
      isCollaborator: taskAccess === undefined ? false : await this.policy.isCollaborator(taskAccess.taskId, userId),
    });
    if (!allowed) {
      throw new AuthorizationDeniedError(`The project role does not allow "${dimension}".`, { projectId, dimension });
    }
    return membership;
  }

  /**
   * What this principal may do in this project, computed by the same rules the commands enforce —
   * so the SPA shows a control exactly when the server would accept the action, and hiding it is
   * never the security mechanism (§8.3).
   */
  async capabilities(projectId: string): Promise<ProjectCapabilities> {
    const project = await this.requireProject(projectId);
    const userId = this.userId;
    const membership = await this.policy.membership(projectId, userId);
    const unrestricted = await this.isUnrestricted('Project', 'edit');
    const features = await this.policy.features(projectId);
    const can = (dimension: keyof ProjectRolePolicy): boolean =>
      unrestricted || (membership !== undefined && roleGrants(membership.role, dimension, { userId }));

    return {
      projectId,
      boardId: text(project.data['boardId']) ?? null,
      isMember: membership !== undefined,
      role: membership?.roleId ?? null,
      roleName: membership === undefined ? null : await this.roleName(membership.roleId ?? ''),
      capabilities: {
        readTasks: can('taskReadScope'),
        createTask: can('taskCreate'),
        editTask: can('taskEditScope'),
        moveTask: can('stageMoveScope'),
        deleteTask: can('taskDeleteScope'),
        manageGroups: can('groupManage'),
        manageMembers: can('memberManage'),
        editProject: can('projectEdit'),
        projectStream: can('projectStreamAccess'),
      },
      features,
    };
  }

  private async roleName(roleId: string): Promise<string | null> {
    const role = await this.records.byId('ProjectRole', roleId);
    return role === undefined ? null : text(role.data['name']) ?? null;
  }

  /** Members eligible as assignees: the current project members (§4.6). */
  async eligibleAssignees(projectId: string): Promise<string[]> {
    const members = await this.records.find('ProjectMember', { projectId });
    return members.map((member) => text(member.data['userId']) ?? '').filter((id) => id !== '');
  }
}
