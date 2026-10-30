/**
 * Phase 19 request shapes (PLAN_Phase_19_Projects.md §7.3). The controller parses these; the domain
 * services receive already-validated values, so no service has to second-guess a payload.
 */
import { z } from 'zod';

import { patchOf } from '../../common/patch-schema.js';
import { PROJECT_DEPENDENCY_TYPES, PROJECT_GROUP_TYPES, PROJECT_PRIORITIES, PROJECT_TASK_STATUSES } from '../project-domain.js';

const id = z.string().trim().min(1).max(64);
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().trim().min(1).max(255);

/**
 * A UI control that has been cleared sends `null`, which means the same as "absent" for an optional
 * reference or date: both leave the field empty on the record.
 */
const optId = id.nullish().transform((value) => value ?? undefined).optional();
const optText = z.string().trim().max(60_000).nullish().transform((value) => value === null || value === '' ? undefined : value).optional();
const optDay = day.nullish().transform((value) => value ?? undefined).optional();
const optPoints = z.number().int().min(0).max(100_000).nullish().transform((value) => value ?? undefined).optional();
const optHours = z.number().min(0).max(100_000).nullish().transform((value) => value ?? undefined).optional();

export const ProjectSettingsSchema = z
  .object({
    dependenciesEnabled: z.boolean(),
    collaboratorsEnabled: z.boolean(),
    priorityEnabled: z.boolean(),
    pointsEnabled: z.boolean(),
    estimatedHoursEnabled: z.boolean(),
    ganttEnabled: z.boolean(),
    activeGroupId: id.nullable(),
  })
  .partial();

export const MemberAddSchema = z.object({ userId: id, projectRoleId: id });
export const MemberUpdateSchema = z.object({ memberId: id, projectRoleId: id });
export const MemberRemoveSchema = z.object({ memberId: id, transferToMemberId: id.optional() });
export const MemberBulkSchema = z.object({
  projectIds: z.array(id).min(1).max(100),
  userIds: z.array(id).min(1).max(200),
  projectRoleId: id,
  operation: z.enum(['add', 'remove', 'role']),
});

export const GroupCreateSchema = z.object({
  name,
  groupType: z.enum(PROJECT_GROUP_TYPES).default('Work'),
  color: optText,
  newTaskPlacement: z.enum(['Top', 'Bottom']).default('Bottom'),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});
export const GroupUpdateSchema = patchOf(GroupCreateSchema).extend({ groupId: id });
export const GroupDeleteSchema = z.object({ groupId: id, moveToGroupId: id.optional() });
export const GroupReorderSchema = z.object({ groupIds: z.array(id).min(1).max(500) });

export const TaskCreateSchema = z.object({
  projectId: id,
  groupId: id,
  stageId: optId,
  parentTaskId: optId,
  name,
  description: optText,
  taskType: z.enum(['Task', 'Milestone']).default('Task'),
  ownerUserId: optId,
  assigneeUserId: optId,
  dateStart: optDay,
  dateEnd: optDay,
  priority: z.enum(PROJECT_PRIORITIES).nullish().transform((value) => value ?? undefined).optional(),
  points: optPoints,
  estimateHours: optHours,
});

export const TaskUpdateSchema = patchOf(TaskCreateSchema).omit({ projectId: true });

export const TaskMoveSchema = z.object({
  stageId: optId,
  groupId: optId,
  beforeTaskId: id.optional(),
  afterTaskId: id.optional(),
  parentTaskId: z.union([id, z.null()]).optional(),
  version: z.number().int().nonnegative().optional(),
});

export const TaskReorderSchema = z.object({
  groupId: id.optional(),
  parentTaskId: id.optional(),
  taskIds: z.array(id).min(1).max(500),
});

export const TaskTransitionSchema = z.object({
  kind: z.enum(['start', 'complete', 'cancel']),
  version: z.number().int().nonnegative().optional(),
});

export const TaskBulkSchema = z.object({
  ids: z.array(id).min(1).max(200),
  operation: z.enum(['complete', 'cancel', 'selfAssign']),
});

export const CollaboratorSchema = z.object({ userId: id });

export const DependencyCreateSchema = z.object({
  predecessorTaskId: id,
  dependencyType: z.enum(PROJECT_DEPENDENCY_TYPES).nullable().optional(),
});
export const DependencyUpdateSchema = z.object({
  dependencyId: id,
  dependencyType: z.enum(PROJECT_DEPENDENCY_TYPES).nullable(),
});
export const DependencyRemoveSchema = z.object({ dependencyId: id });

export const MilestoneSchema = z.object({
  groupId: id,
  name,
  description: optText,
  dateStart: day,
  ownerUserId: optId,
  assigneeUserId: optId,
});

export const StageInputSchema = z.object({
  id: id.optional(),
  key: z.string().trim().regex(/^[a-z][A-Za-z0-9]{0,63}$/),
  name,
  statusValue: z.enum(PROJECT_TASK_STATUSES),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
});
export const BoardStagesSchema = z.object({ stages: z.array(StageInputSchema).min(1).max(100) });

export const CloneProjectSchema = z.object({
  name: name.optional(),
  dateStart: day.optional(),
  copyMembers: z.boolean().default(true),
  copyTaskOwners: z.boolean().default(true),
  copyTaskAssignees: z.boolean().default(false),
  copyAttachments: z.boolean().default(false),
});

export const ProjectTaskDashletSchema = z.object({
  nextDays: z.number().int().min(1).max(365).default(14),
  includeOwned: z.boolean().default(true),
  includeCollaboration: z.boolean().default(false),
  excludeAssigned: z.boolean().default(false),
  groupTypes: z.array(z.enum(PROJECT_GROUP_TYPES)).max(PROJECT_GROUP_TYPES.length).default([]),
  includeCompleted: z.boolean().default(false),
  maxSize: z.number().int().min(1).max(100).default(20),
});

export type ProjectSettingsInput = z.infer<typeof ProjectSettingsSchema>;
export type MemberAddInput = z.infer<typeof MemberAddSchema>;
export type MemberUpdateInput = z.infer<typeof MemberUpdateSchema>;
export type MemberRemoveInput = z.infer<typeof MemberRemoveSchema>;
export type MemberBulkInput = z.infer<typeof MemberBulkSchema>;
export type GroupReorderInput = z.infer<typeof GroupReorderSchema>;
export type DependencyRemoveInput = z.infer<typeof DependencyRemoveSchema>;
export type GroupCreateInput = z.infer<typeof GroupCreateSchema>;
export type GroupUpdateInput = z.infer<typeof GroupUpdateSchema>;
export type GroupDeleteInput = z.infer<typeof GroupDeleteSchema>;
export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type TaskMoveInput = z.infer<typeof TaskMoveSchema>;
export type TaskReorderInput = z.infer<typeof TaskReorderSchema>;
export type TaskBulkInput = z.infer<typeof TaskBulkSchema>;
export type DependencyCreateInput = z.infer<typeof DependencyCreateSchema>;
export type DependencyUpdateInput = z.infer<typeof DependencyUpdateSchema>;
export type MilestoneInput = z.infer<typeof MilestoneSchema>;
export type StageInput = z.infer<typeof StageInputSchema>;
export type CloneProjectInput = z.infer<typeof CloneProjectSchema>;
export type ProjectTaskDashletInput = z.infer<typeof ProjectTaskDashletSchema>;
