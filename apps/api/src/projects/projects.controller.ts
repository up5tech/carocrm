import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import {
  CloneProjectSchema,
  CollaboratorSchema,
  DependencyCreateSchema,
  DependencyRemoveSchema,
  DependencyUpdateSchema,
  GroupCreateSchema,
  GroupDeleteSchema,
  GroupReorderSchema,
  GroupUpdateSchema,
  MemberAddSchema,
  MemberBulkSchema,
  MemberRemoveSchema,
  MemberUpdateSchema,
  MilestoneSchema,
  ProjectSettingsSchema,
  TaskBulkSchema,
  TaskCreateSchema,
  TaskMoveSchema,
  TaskReorderSchema,
  TaskTransitionSchema,
  TaskUpdateSchema,
} from './dto/project-shapes.js';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectBoardService } from './project-board.service.js';
import { ProjectCloneService } from './project-clone.service.js';
import { ProjectDependencyService } from './project-dependency.service.js';
import { ProjectGroupService } from './project-group.service.js';
import { ProjectMemberService } from './project-member.service.js';
import { ProjectTaskService, type TaskTransitionKind } from './project-task.service.js';
import { ProjectViewService } from './project-view.service.js';

/**
 * Projects domain commands (PLAN_Phase_19_Projects.md §7.2).
 *
 * Everything a single metadata record can express — list, read, create, edit, delete, relations,
 * attachments, stream — stays on the generic `/api/v1/:entity` API. These routes exist only where a
 * request mutates more than one record or must be interpreted: a stage move, a reorder, a
 * transition, a clone. Each one is action-addressed (`POST /:id/action/<name>`), the same shape the
 * kernel already uses for `massUpdate`, so it can never collide with the generic
 * `:entity/:id/:relation` routes.
 */
@ApiTags('projects')
@Controller('api/v1/Project')
export class ProjectController {
  constructor(
    @Inject(ProjectViewService) private readonly views: ProjectViewService,
    @Inject(ProjectGroupService) private readonly groups: ProjectGroupService,
    @Inject(ProjectMemberService) private readonly members: ProjectMemberService,
    @Inject(ProjectTaskService) private readonly tasks: ProjectTaskService,
    @Inject(ProjectCloneService) private readonly clone: ProjectCloneService,
    @Inject(ProjectAccessService) private readonly access: ProjectAccessService,
    @Inject(ProjectBoardService) private readonly boards: ProjectBoardService,
  ) {}

  /** What the reader may do here, and which features the project has on (§4.11, §8.3). */
  @Get(':id/action/capabilities')
  capabilities(@Param('id') id: string) {
    return this.access.capabilities(id);
  }

  @Get(':id/action/plan')
  plan(@Param('id') id: string) {
    return this.views.plan(id);
  }

  @Get(':id/action/board')
  board(@Param('id') id: string, @Query('groupId') groupId?: string) {
    return this.views.board(id, typeof groupId === 'string' && groupId !== '' ? groupId : undefined);
  }

  @Get(':id/action/gantt')
  gantt(@Param('id') id: string, @Query('allGroupTypes') allGroupTypes?: string) {
    return this.views.gantt(id, allGroupTypes === 'true');
  }

  /** The board stages of this project's board, in board order — the Kanban column definition. */
  @Get(':id/action/stages')
  async stages(@Param('id') id: string) {
    const view = await this.access.capabilities(id);
    return { list: await this.boards.stages(view.boardId ?? '') };
  }

  @Get(':id/action/members')
  async listMembers(@Param('id') id: string) {
    return { list: await this.members.list(id) };
  }

  @HttpCode(200)
  @Post(':id/action/members')
  addMember(@Param('id') id: string, @Body() body: unknown) {
    return this.members.add(id, parse(MemberAddSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/memberUpdate')
  updateMember(@Param('id') id: string, @Body() body: unknown) {
    return this.members.changeRole(id, parse(MemberUpdateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/memberRemove')
  removeMember(@Param('id') id: string, @Body() body: unknown) {
    return this.members.remove(id, parse(MemberRemoveSchema, body));
  }

  /** Bulk membership across selected projects, with per-project authorisation (§4.17). */
  @HttpCode(200)
  @Post(':id/action/memberBulk')
  bulkMembers(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(MemberBulkSchema, body);
    return this.members.bulk({ ...input, projectIds: [id, ...input.projectIds.filter((projectId) => projectId !== id)] });
  }

  @HttpCode(200)
  @Post(':id/action/groupCreate')
  createGroup(@Param('id') id: string, @Body() body: unknown) {
    return this.groups.create(id, parse(GroupCreateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/groupUpdate')
  updateGroup(@Param('id') id: string, @Body() body: unknown) {
    return this.groups.update(id, parse(GroupUpdateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/groupRemove')
  removeGroup(@Param('id') id: string, @Body() body: unknown) {
    return this.groups.remove(id, parse(GroupDeleteSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/groupReorder')
  reorderGroups(@Param('id') id: string, @Body() body: unknown) {
    return this.groups.reorder(id, parse(GroupReorderSchema, body));
  }

  /** Persist an ordered set of tasks inside one group or under one parent (§5.4). */
  @HttpCode(200)
  @Post(':id/action/taskReorder')
  reorderTasks(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.reorder(id, parse(TaskReorderSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/taskCreate')
  createTask(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.create(id, parse(TaskCreateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/milestone')
  createMilestone(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.createMilestone(id, parse(MilestoneSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/settings')
  settings(@Param('id') id: string, @Body() body: unknown) {
    return this.views.updateSettings(id, parse(ProjectSettingsSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/clone')
  cloneProject(@Param('id') id: string, @Body() body: unknown) {
    return this.clone.clone(id, parse(CloneProjectSchema, body));
  }
}

@ApiTags('projects')
@Controller('api/v1/ProjectTask')
export class ProjectTaskController {
  constructor(
    @Inject(ProjectTaskService) private readonly tasks: ProjectTaskService,
    @Inject(ProjectDependencyService) private readonly dependencies: ProjectDependencyService,
  ) {}

  @HttpCode(200)
  @Post('action/bulk')
  bulk(@Body() body: unknown) {
    const input = parse(TaskBulkSchema, body);
    return this.tasks.bulk(input.ids, input.operation);
  }

  @HttpCode(200)
  @Post(':id/action/update')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.update(id, parse(TaskUpdateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/move')
  move(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.move(id, parse(TaskMoveSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/transition')
  transition(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(TaskTransitionSchema, body);
    return this.tasks.transition(id, input.kind as TaskTransitionKind);
  }

  @Get(':id/action/dependencies')
  dependenciesOf(@Param('id') id: string) {
    return this.tasks.dependencies(id);
  }

  @HttpCode(200)
  @Post(':id/action/dependencies')
  addDependency(@Param('id') id: string, @Body() body: unknown) {
    return this.dependencies.create(id, parse(DependencyCreateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/dependencyUpdate')
  updateDependency(@Param('id') id: string, @Body() body: unknown) {
    return this.dependencies.changeType(id, parse(DependencyUpdateSchema, body));
  }

  @HttpCode(200)
  @Post(':id/action/dependencyRemove')
  removeDependency(@Param('id') id: string, @Body() body: unknown) {
    return this.dependencies.remove(id, parse(DependencyRemoveSchema, body));
  }

  @Get(':id/action/collaborators')
  async collaborators(@Param('id') id: string) {
    return { list: await this.tasks.collaborators(id) };
  }

  @HttpCode(200)
  @Post(':id/action/collaboratorAdd')
  addCollaborator(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.addCollaborator(id, parse(CollaboratorSchema, body).userId);
  }

  @HttpCode(200)
  @Post(':id/action/collaboratorRemove')
  removeCollaborator(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.removeCollaborator(id, parse(CollaboratorSchema, body).userId);
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', { issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return parsed.data;
}
