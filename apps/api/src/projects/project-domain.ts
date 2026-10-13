/**
 * Phase 19 — Projects: pure domain rules (PLAN_Phase_19_Projects.md §4, §10).
 *
 * Nothing here touches Nest, the database or the request scope: every rule is a function over plain
 * values so the invariants can be unit-tested directly (§12.1) and reused by the policy service, the
 * transition engine and the SPA-agnostic projections.
 */

export const PROJECT_TASK_STATUSES = ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export const PROJECT_GROUP_TYPES = ['Triage', 'Backlog', 'Work', 'Phase', 'Sprint'] as const;
export type ProjectGroupType = (typeof PROJECT_GROUP_TYPES)[number];

/** Group types shown in the Gantt view by default (§4.5). */
export const GANTT_GROUP_TYPES: readonly ProjectGroupType[] = ['Work', 'Phase', 'Sprint'];

export const PROJECT_DEPENDENCY_TYPES = ['FinishToStart', 'FinishToFinish', 'StartToStart', 'StartToFinish'] as const;
export type ProjectDependencyType = (typeof PROJECT_DEPENDENCY_TYPES)[number];

export const PROJECT_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;

/** Built-in role ids seeded by `database/seed.ts`; they are configuration, not user data. */
export const PROJECT_ROLE_OWNER = 'projectRoleOwner';
export const PROJECT_ROLE_EDITOR = 'projectRoleEditor';
export const PROJECT_ROLE_MEMBER = 'projectRoleMember';
export const DEFAULT_PROJECT_BOARD_ID = 'projectBoardDefault';

/** Feature settings of a project (§4.11). Disabled = UI hides it and the backend rejects writes. */
export const PROJECT_FEATURE_FLAGS = [
  'dependenciesEnabled',
  'collaboratorsEnabled',
  'priorityEnabled',
  'pointsEnabled',
  'estimatedHoursEnabled',
  'ganttEnabled',
] as const;
export type ProjectFeatureFlag = (typeof PROJECT_FEATURE_FLAGS)[number];

export interface ProjectRolePolicy {
  readonly taskCreate: string;
  readonly assignmentScope: string;
  readonly taskReadScope: string;
  readonly taskStreamScope: string;
  readonly taskEditScope: string;
  readonly stageMoveScope: string;
  readonly taskDeleteScope: string;
  readonly projectStreamAccess: string;
  readonly groupManage: string;
  readonly memberManage: string;
  readonly projectEdit: string;
}

export const PROJECT_ROLE_DIMENSIONS: readonly (keyof ProjectRolePolicy)[] = [
  'taskCreate',
  'assignmentScope',
  'taskReadScope',
  'taskStreamScope',
  'taskEditScope',
  'stageMoveScope',
  'taskDeleteScope',
  'projectStreamAccess',
  'groupManage',
  'memberManage',
  'projectEdit',
] as const;

/** Which role field gates which record action (§4.4). */
export const ROLE_FIELD_FOR_ACTION: Readonly<Record<'read' | 'edit' | 'delete' | 'stream' | 'move', keyof ProjectRolePolicy>> = {
  read: 'taskReadScope',
  edit: 'taskEditScope',
  delete: 'taskDeleteScope',
  stream: 'taskStreamScope',
  move: 'stageMoveScope',
};

/**
 * Values of a role field that grant unrestricted access inside the project, that grant access to
 * tasks assigned to the user, and that grant access to the user's own tasks. Anything outside these
 * sets ('no') denies.
 */
export const ROLE_SCOPE_ALL: Readonly<Partial<Record<keyof ProjectRolePolicy, readonly string[]>>> = {
  taskReadScope: ['all'],
  taskEditScope: ['all'],
  taskDeleteScope: ['all'],
  taskStreamScope: ['all'],
  stageMoveScope: ['all'],
  assignmentScope: ['all'],
  groupManage: ['yes'],
  memberManage: ['yes'],
  projectEdit: ['yes'],
  projectStreamAccess: ['yes'],
  taskCreate: ['yes'],
};
export const ROLE_SCOPE_ASSIGNED: Readonly<Partial<Record<keyof ProjectRolePolicy, readonly string[]>>> = {
  taskEditScope: ['assigned'],
  stageMoveScope: ['assigned'],
};
export const ROLE_SCOPE_OWN: Readonly<Partial<Record<keyof ProjectRolePolicy, readonly string[]>>> = {
  taskReadScope: ['own'],
  taskEditScope: ['own'],
  taskDeleteScope: ['own'],
  taskStreamScope: ['own'],
  stageMoveScope: ['own'],
  assignmentScope: ['own'],
};

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A role dimension grants access to a task for `userId` or denies it. `isCollaborator` widens only
 * the `own` tier, which is what §4.10 asks for: a collaborator can read and post on that one task.
 */
export function roleGrants(
  role: ProjectRolePolicy | undefined,
  dimension: keyof ProjectRolePolicy,
  access: {
    readonly userId: string;
    readonly ownerUserId?: string | undefined;
    readonly assigneeUserId?: string | undefined;
    readonly isCollaborator?: boolean | undefined;
  },
): boolean {
  const value = role?.[dimension];
  if (typeof value !== 'string') return false;
  if (ROLE_SCOPE_ALL[dimension]?.includes(value) === true) return true;
  const isAssignee = access.assigneeUserId === access.userId;
  const isOwner = access.ownerUserId === access.userId;
  if (ROLE_SCOPE_ASSIGNED[dimension]?.includes(value) === true) return isAssignee;
  if (ROLE_SCOPE_OWN[dimension]?.includes(value) === true) return isOwner || isAssignee || access.isCollaborator === true;
  return false;
}

// ---------------------------------------------------------------------------
// Boards and stages
// ---------------------------------------------------------------------------

export interface StageRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly statusValue: string;
  readonly sortOrder: number;
}

/** The stage mapping is the single source of truth for a task's status (§4.3). */
export function statusOfStage(stage: StageRow | undefined): ProjectTaskStatus | undefined {
  const value = stage?.statusValue;
  return PROJECT_TASK_STATUSES.includes((value ?? '') as ProjectTaskStatus) ? (value as ProjectTaskStatus) : undefined;
}

export function isStageKey(value: string): boolean {
  return /^[a-z][A-Za-z0-9]{0,63}$/.test(value);
}

/** Stage keys are stable identifiers; only the display name may be renamed freely. */
export function validateStageSet(stages: readonly { key: string; name: string; statusValue: string }[]): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const stage of stages) {
    if (!isStageKey(stage.key)) issues.push(`Stage key "${stage.key}" must start with a lower-case letter and contain only alphanumerics.`);
    if (keys.has(stage.key)) issues.push(`Duplicate stage key "${stage.key}".`);
    keys.add(stage.key);
    if (stage.name.trim() === '') issues.push(`Stage "${stage.key}" needs a display name.`);
    if (!PROJECT_TASK_STATUSES.includes(stage.statusValue as ProjectTaskStatus)) issues.push(`Stage "${stage.key}" maps to an unknown status "${stage.statusValue}".`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Graph rules: hierarchies and dependencies
// ---------------------------------------------------------------------------

export interface DirectedEdge {
  readonly from: string;
  readonly to: string;
}

/** `true` when adding `candidate` to `edges` would create a cycle that includes it. */
export function wouldCreateCycle(edges: readonly DirectedEdge[], candidate: DirectedEdge): boolean {
  if (candidate.from === candidate.to) return true;
  // A cycle exists exactly when the candidate's target can already reach its source.
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  const stack = [candidate.to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === candidate.from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Same rule for the parent/child hierarchy. `childrenByParent` maps a parent to its children, so
 * re-parenting `childId` under `nextParentId` is a cycle exactly when that parent is already a
 * descendant of the child.
 */
export function wouldCreateHierarchyCycle(childrenByParent: ReadonlyMap<string, readonly string[]>, childId: string, nextParentId: string): boolean {
  if (childId === nextParentId) return true;
  const stack = [childId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === nextParentId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const child of childrenByParent.get(node) ?? []) stack.push(child);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dependencies and transitions
// ---------------------------------------------------------------------------

export type ProjectTaskTransition = 'start' | 'complete' | 'cancel';

export interface DependencyCheckTask {
  readonly status: string;
  readonly dateStart?: string | undefined;
}

export interface DependencyRuleInput {
  readonly dependencyType: string | null | undefined;
  readonly transition: ProjectTaskTransition;
  readonly predecessor: DependencyCheckTask;
  readonly successor?: DependencyCheckTask | undefined;
}

export interface DependencyBlock {
  readonly blocked: true;
  readonly dependencyType: string;
  readonly reason: string;
}

/**
 * Type-specific transition guards (§4.8). A dependency with no type is declarative and never
 * blocks; each typed rule is evaluated on its own terms rather than as "predecessor must be done".
 *
 * - FinishToStart  the successor may not start until the predecessor is finished.
 * - FinishToFinish the successor may not finish until the predecessor is finished.
 * - StartToStart   the successor may not start until the predecessor has started.
 * - StartToFinish  the successor may not finish until the predecessor has started.
 */
export function dependencyBlockFor(input: DependencyRuleInput): DependencyBlock | undefined {
  const type = input.dependencyType;
  if (type === null || type === undefined || type === '') return undefined;

  const predecessorStatus = input.predecessor.status;
  const started = predecessorStatus === 'Started' || predecessorStatus === 'Completed';
  const finished = predecessorStatus === 'Completed';

  if (input.transition === 'start') {
    if (type === 'FinishToStart' && !finished) return block(type, 'The predecessor task must be completed first.');
    if (type === 'StartToStart' && !started) return block(type, 'The predecessor task must be started first.');
    return undefined;
  }
  if (input.transition === 'complete') {
    if (type === 'FinishToFinish' && !finished) return block(type, 'The predecessor task must be completed before this one can be completed.');
    if (type === 'StartToFinish' && !started) return block(type, 'The predecessor task must be started before this one can be completed.');
    return undefined;
  }
  // Cancel is never blocked by a dependency: abandoning work is always possible (§4.8 only guards
  // start/complete), and a blocked cancel would strand tasks.
  return undefined;
}

function block(dependencyType: string, reason: string): DependencyBlock {
  return { blocked: true, dependencyType, reason };
}

/** §4.7: a parent with active subtasks cannot be completed. */
export function subtasksAllowCompletion(children: readonly string[]): boolean {
  return children.every((status) => status === 'Completed' || status === 'Canceled');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function dayValue(value: unknown): string | undefined {
  if (value instanceof Date) return isoDay(value);
  const raw = text(value);
  if (raw === undefined) return undefined;
  return raw.slice(0, 10);
}

/** `YYYY-MM-DD` in UTC — Project dates are calendar days, not instants (§4.12, §5.3). */
export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && isoDay(parsed) === value;
}

/** Whole-day difference between two calendar days; negative when `to` is before `from`. */
export function dayDifference(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Shift a calendar day by `days`, ignoring it when the input is absent. Used by project cloning. */
export function shiftDay(value: string | undefined | null, days: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return isoDay(new Date(parsed + days * 86_400_000));
}

/** §4.1 / §4.6: an end date never precedes its start date. */
export function datesAreConsistent(dateStart: string | undefined, dateEnd: string | undefined): boolean {
  if (dateStart === undefined || dateEnd === undefined) return true;
  return dateStart <= dateEnd;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Gap between consecutive `sortOrder` values, so an insert can happen without renumbering. */
export const ORDER_GAP = 1000;

/**
 * Deterministic ranks for an ordered id list. Ties are broken by the position in the submitted
 * order, and the result is spaced by `ORDER_GAP` so a later drag can insert between two rows.
 */
export function ranksFor(order: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  order.forEach((id, index) => out.set(id, (index + 1) * ORDER_GAP));
  return out;
}

/**
 * Rank for a row placed relative to its neighbours. `beforeId`/`afterId` are the adjacent rows in
 * the target list; the returned value sits strictly between them, or at the head/tail.
 */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return ORDER_GAP;
  if (before === undefined) return (after as number) - ORDER_GAP;
  if (after === undefined) return before + ORDER_GAP;
  const middle = Math.floor((before + after) / 2);
  return middle > before ? middle : before + 1;
}

// ---------------------------------------------------------------------------
// Clone options (§4.15)
// ---------------------------------------------------------------------------

export interface CloneOptions {
  readonly name: string;
  readonly dateStart?: string | undefined;
  readonly copyMembers: boolean;
  readonly copyTaskOwners: boolean;
  readonly copyTaskAssignees: boolean;
  readonly copyAttachments: boolean;
}

export const CLONE_DEFAULTS: Pick<CloneOptions, 'copyMembers' | 'copyTaskOwners' | 'copyTaskAssignees' | 'copyAttachments'> = {
  copyMembers: true,
  copyTaskOwners: true,
  copyTaskAssignees: false,
  copyAttachments: false,
};

/**
 * Day offset applied to every cloned date: the requested new start minus the source start. A clone
 * without a source start date has nothing to shift against, so the offset is 0.
 */
export function cloneDateOffset(sourceDateStart: string | undefined, targetDateStart: string | undefined): number {
  if (sourceDateStart === undefined || targetDateStart === undefined) return 0;
  return dayDifference(sourceDateStart, targetDateStart);
}
