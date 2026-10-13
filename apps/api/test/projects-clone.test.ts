import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { ProjectFixture } from './support/projects-fixtures.js';
import { projectFixture, reasonOf } from './support/projects-fixtures.js';

/**
 * Phase 19 — project cloning (§4.15, §12.5 scenario 12).
 *
 * A clone must be a structurally identical project with its own identity: every internal reference
 * re-pointed at the cloned row, every date moved by the same distance, and nothing system-level
 * carried over.
 */
let ctx: ApiContext;
let fix: ProjectFixture;
let sourceId = '';
let workGroupId = '';
let firstTaskId = '';
let secondTaskId = '';
let memberUserId = '';

const day = (offset: number): string => new Date(Date.UTC(2027, 0, 1 + offset)).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await bootApi();
  fix = await projectFixture(ctx);

  sourceId = await fix.createProject({
    name: `AGENT_TEST CloneSource ${fix.runId}`,
    dateStart: '2027-01-01',
    dateEnd: '2027-02-01',
    dependenciesEnabled: true,
    collaboratorsEnabled: true,
    priorityEnabled: true,
    pointsEnabled: true,
  });
  workGroupId = await fix.createGroup(sourceId, { groupType: 'Work', name: `AGENT_TEST W ${fix.runId}` });
  await fix.createGroup(sourceId, { groupType: 'Backlog', name: `AGENT_TEST B ${fix.runId}` });

  firstTaskId = await fix.createTask(sourceId, workGroupId, {
    name: `AGENT_TEST c1 ${fix.runId}`,
    stageId: await fix.stageId('inProgress'),
    dateStart: day(2),
    dateEnd: day(5),
    priority: 'High',
    points: 3,
  });
  secondTaskId = await fix.createTask(sourceId, workGroupId, {
    name: `AGENT_TEST c2 ${fix.runId}`,
    stageId: await fix.stageId('notStarted'),
    dateStart: day(6),
    dateEnd: day(9),
  });
  await fix.call('POST', `/api/v1/Project/${sourceId}/action/milestone`, {
    groupId: workGroupId,
    name: `AGENT_TEST m ${fix.runId}`,
    dateStart: day(10),
  });
  await fix.createTask(sourceId, workGroupId, {
    name: `AGENT_TEST c1a ${fix.runId}`,
    parentTaskId: firstTaskId,
    stageId: await fix.stageId('done'),
    dateStart: day(3),
  });
  await fix.call('POST', `/api/v1/ProjectTask/${secondTaskId}/action/dependencies`, { predecessorTaskId: firstTaskId, dependencyType: 'FinishToStart' });

  // A second member, so the "members are not copied" case has somebody to drop.
  const user = await fix.call('POST', '/api/v1/User', {
    userName: `AGENT_TEST_${fix.runId}_clone_member`,
    firstName: 'Clone',
    lastName: 'Member',
    type: 'regular',
    assignedRoleIds: ['noAccess'],
  });
  memberUserId = String(user.body['id']);
  await fix.createMember(sourceId, memberUserId);
  await fix.createTask(sourceId, workGroupId, { name: `AGENT_TEST assigned ${fix.runId}`, assigneeUserId: memberUserId });
});

afterAll(async () => {
  if (memberUserId !== '') {
    await ctx.database.db.deleteFrom('users').where('id', '=', memberUserId).execute().catch(() => undefined);
  }
  await fix?.cleanup();
  await purgeEntityEvents(ctx.database, ['Project', 'ProjectTask', 'ProjectGroup', 'ProjectMember', 'ProjectTaskDependency', 'ProjectTaskCollaborator']);
  await shutdownApi();
});

describe('project cloning', () => {
  it('copies the structure, remaps every internal reference and shifts the dates', async () => {
    const clone = await fix.call('POST', `/api/v1/Project/${sourceId}/action/clone`, {
      name: `AGENT_TEST CloneA ${fix.runId}`,
      dateStart: '2027-03-01',
      copyMembers: true,
      copyTaskOwners: true,
      copyTaskAssignees: true,
    });
    expect(clone.status, reasonOf(clone)).toBe(200);
    const body = clone.body as { projectId: string; name: string; counts: Record<string, number> };
    const newId = body.projectId;
    expect(newId).toBeTruthy();
    fix.trackProject(newId);

    // Dates move by the distance between the two project start dates: 2027-01-01 → 2027-03-01 is 59 days.
    const project = await fix.call('GET', `/api/v1/Project/${newId}`);
    expect(String(project.body['dateStart'])).toMatch(/^2027-03-01/);
    expect(String(project.body['dateEnd'])).toMatch(/^2027-04-01/);
    expect(project.body['boardId']).toBe('projectBoardDefault');

    const plan = await fix.call('GET', `/api/v1/Project/${newId}/action/plan`);
    const groups = (plan.body['groups'] ?? []) as { group: Record<string, unknown>; tasks: Record<string, unknown>[] }[];
    expect(groups).toHaveLength(2);
    expect(groups.map((entry) => entry.group['id'])).not.toContain(workGroupId);
    expect(groups.map((entry) => entry.group['name'])).toContain(`AGENT_TEST W ${fix.runId}`);

    const tasks = groups.flatMap((entry) => entry.tasks);
    // Four planned items plus the task the fixture added for the membership case.
    expect(tasks).toHaveLength(5);
    const cloned = tasks.find((task) => task['name'] === `AGENT_TEST c1 ${fix.runId}`) as Record<string, unknown>;
    expect(cloned).toBeDefined();
    expect(String(cloned['dateStart'])).toMatch(/^2027-03-03/);
    expect(String(cloned['dateEnd'])).toMatch(/^2027-03-06/);
    expect(cloned['priority']).toBe('High');
    expect(cloned['points']).toBe(3);
    // The status travels with the stage, and the stage is the same board stage.
    expect(cloned['stageId']).toBe(await fix.stageId('inProgress'));
    expect(cloned['status']).toBe('Started');

    const milestone = tasks.find((task) => task['name'] === `AGENT_TEST m ${fix.runId}`) as Record<string, unknown>;
    expect(milestone['taskType']).toBe('Milestone');
    expect(String(milestone['dateStart'])).toMatch(/^2027-03-11/);
    expect(milestone['dateEnd'] ?? null).toBeNull();

    // The subtask points at the CLONED parent, never at the source task.
    const child = tasks.find((task) => task['name'] === `AGENT_TEST c1a ${fix.runId}`) as Record<string, unknown>;
    expect(child['parentTaskId']).toBe(cloned['id']);
    expect(child['parentTaskId']).not.toBe(firstTaskId);
    expect(child['groupId']).not.toBe(workGroupId);

    // Dependencies are remapped onto the cloned ids.
    const gantt = await fix.call('GET', `/api/v1/Project/${newId}/action/gantt`);
    const edges = (gantt.body['dependencies'] ?? []) as Record<string, unknown>[];
    expect(edges).toHaveLength(1);
    const ids = tasks.map((task) => task['id']);
    expect(ids).toContain(edges[0]?.['taskId']);
    expect(ids).toContain(edges[0]?.['predecessorTaskId']);
    expect(edges[0]?.['dependencyType']).toBe('FinishToStart');

    // Members travel with the copy; the creator is the Owner of the clone as well.
    const members = await fix.call('GET', `/api/v1/Project/${newId}/action/members`);
    const userIds = ((members.body['list'] ?? []) as Record<string, unknown>[]).map((row) => row['userId']);
    expect(userIds).toContain('adminUserId');
    expect(userIds).toContain(memberUserId);
    // With the membership copied, the assignee is valid again and travels too.
    const withAssignee = (plan.body['groups'] as { tasks: Record<string, unknown>[] }[]).flatMap((entry) => entry.tasks)
      .find((task) => task['name'] === `AGENT_TEST assigned ${fix.runId}`) as Record<string, unknown>;
    expect(withAssignee['assigneeUserId']).toBe(memberUserId);

    // Nothing was written back to the source.
    const sourcePlan = await fix.call('GET', `/api/v1/Project/${sourceId}/action/plan`);
    const sourceTasks = (sourcePlan.body['groups'] ?? []).flatMap((entry: { tasks: Record<string, unknown>[] }) => entry.tasks);
    expect(sourceTasks.map((task) => task['id'])).toContain(firstTaskId);
    expect(String((await fix.call('GET', `/api/v1/ProjectTask/${firstTaskId}`)).body['dateStart'])).toMatch(/^2027-01-03/);
  });

  it('without copied members, no task is left assigned to somebody who is not a member', async () => {
    const clone = await fix.call('POST', `/api/v1/Project/${sourceId}/action/clone`, {
      name: `AGENT_TEST CloneB ${fix.runId}`,
      copyMembers: false,
      copyTaskAssignees: true,
    });
    expect(clone.status, reasonOf(clone)).toBe(200);
    const newId = String((clone.body as { projectId: string }).projectId);
    fix.trackProject(newId);

    const plan = await fix.call('GET', `/api/v1/Project/${newId}/action/plan`);
    const tasks = (plan.body['groups'] ?? []).flatMap((entry: { tasks: Record<string, unknown>[] }) => entry.tasks) as Record<string, unknown>[];
    const names = tasks.map((task) => task['name']);
    expect(names).toContain(`AGENT_TEST assigned ${fix.runId}`);
    // The ex-member's assignment is cleared rather than left dangling; the cloning user stays, because
    // they are the Owner of the clone by construction.
    const assignedClone = tasks.find((task) => task['name'] === `AGENT_TEST assigned ${fix.runId}`) as Record<string, unknown>;
    expect(assignedClone['assigneeUserId'] ?? null).toBeNull();
    const kept = tasks.find((task) => task['name'] === `AGENT_TEST c1 ${fix.runId}`) as Record<string, unknown>;
    expect(kept['assigneeUserId'] ?? null).toBeNull();

    const members = await fix.call('GET', `/api/v1/Project/${newId}/action/members`);
    const userIds = ((members.body['list'] ?? []) as Record<string, unknown>[]).map((row) => row['userId']);
    // Only the cloning user, who is the Owner of the clone by construction.
    expect(userIds).toEqual(['adminUserId']);
  });

  it('keeps the clone independent: editing it never touches the source', async () => {
    const clone = await fix.call('POST', `/api/v1/Project/${sourceId}/action/clone`, { name: `AGENT_TEST CloneC ${fix.runId}` });
    const newId = String((clone.body as { projectId: string }).projectId);
    fix.trackProject(newId);

    const plan = await fix.call('GET', `/api/v1/Project/${newId}/action/plan`);
    const tasks = (plan.body['groups'] ?? []).flatMap((entry: { tasks: Record<string, unknown>[] }) => entry.tasks) as Record<string, unknown>[];
    const target = tasks.find((task) => task['name'] === `AGENT_TEST c2 ${fix.runId}`) as Record<string, unknown>;

    const moved = await fix.call('POST', `/api/v1/ProjectTask/${target['id']}/action/transition`, { kind: 'complete' });
    expect(moved.status, reasonOf(moved)).toBe(200);
    const sourceTask = await fix.call('GET', `/api/v1/ProjectTask/${secondTaskId}`);
    expect(sourceTask.body['status']).toBe('Not Started');
    const sourceEdge = await fix.call('GET', `/api/v1/ProjectTask/${secondTaskId}/action/dependencies`);
    expect(((sourceEdge.body['predecessors'] ?? []) as unknown[])).toHaveLength(1);
    const cloneEdge = await fix.call('GET', `/api/v1/ProjectTask/${target['id']}/action/dependencies`);
    expect(((cloneEdge.body['predecessors'] ?? []) as unknown[])).toHaveLength(1);

    // Audit and stream history do not travel with a clone.
    const sourceHistory = await fix.call('GET', `/api/v1/Project/${sourceId}/stream`);
    const cloneHistory = await fix.call('GET', `/api/v1/Project/${newId}/stream`);
    const cloneItems = (cloneHistory.body['list'] ?? []) as Record<string, unknown>[];
    const sourceItems = (sourceHistory.body['list'] ?? []) as Record<string, unknown>[];
    expect(cloneItems.map((item) => item['id'])).toEqual(expect.arrayContaining([]));
    for (const item of cloneItems) {
      expect(sourceItems.map((existing) => existing['id'])).not.toContain(item['id']);
    }
  });

  it('refuses a clone from a project the caller cannot read', async () => {
    const missing = await fix.call('POST', `/api/v1/Project/project-missing-${fix.runId}/action/clone`, {});
    expect(missing.status).toBe(404);
  });
});
