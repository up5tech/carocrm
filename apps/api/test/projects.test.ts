import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';
import type { ProjectFixture } from './support/projects-fixtures.js';
import { projectFixture, reasonOf } from './support/projects-fixtures.js';

/**
 * Phase 19 — Projects: records, boards, groups, tasks and the read projections
 * (PLAN_Phase_19_Projects.md §12.2, §12.3). Admin-token calls only; the role and membership rules
 * are in `projects-security.test.ts`.
 */
let ctx: ApiContext;
let fix: ProjectFixture;

beforeAll(async () => {
  ctx = await bootApi();
  fix = await projectFixture(ctx);
});

afterAll(async () => {
  await fix?.cleanup();
  await shutdownApi();
});

describe('default configuration', () => {
  it('seeds one default board with stages covering every status, and the three built-in roles', async () => {
    const boards = await fix.call('GET', '/api/v1/ProjectBoard?maxSize=100');
    const list = (boards.body['list'] ?? []) as Record<string, unknown>[];
    expect(list.filter((board) => board['id'] === 'projectBoardDefault')).toHaveLength(1);

    const stages = await fix.call('GET', '/api/v1/ProjectBoardStage?where=' + encodeURIComponent(JSON.stringify([{ field: 'boardId', operator: 'equals', value: 'projectBoardDefault' }])) + '&maxSize=100&orderBy=sortOrder');
    const rows = (stages.body['list'] ?? []) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // §12.5: at least two stages map to the same status.
    expect(rows.filter((row) => row['statusValue'] === 'Started').length).toBeGreaterThanOrEqual(2);

    const roles = await fix.call('GET', '/api/v1/ProjectRole?maxSize=100');
    const roleRows = (roles.body['list'] ?? []) as Record<string, unknown>[];
    expect(['projectRoleOwner', 'projectRoleEditor', 'projectRoleMember'].every((id) => roleRows.some((role) => role['id'] === id))).toBe(true);

    // Re-seeding is idempotent: the seed has already run twice (boot + this suite) with no duplicate.
    expect(roleRows.filter((role) => role['id'] === 'projectRoleOwner')).toHaveLength(1);
  });
});

describe('project records', () => {
  it('refuses a project without a board and one that ends before it starts', async () => {
    const noBoard = await fix.call('POST', '/api/v1/Project', { name: `AGENT_TEST ${fix.runId} no board` });
    expect(noBoard.status).toBe(422);

    const dates = await fix.call('POST', '/api/v1/Project', {
      name: `AGENT_TEST ${fix.runId} bad dates`,
      boardId: 'projectBoardDefault',
      dateStart: '2026-05-10',
      dateEnd: '2026-05-01',
    });
    expect(dates.status).toBe(422);
    expect(reasonOf(dates)).toContain('before it starts');
  });

  it('keeps the board immutable after the project exists', async () => {
    const projectId = await fix.createProject();
    const other = await fix.create('ProjectBoard', { name: `AGENT_TEST other board ${fix.runId}` });
    const moved = await fix.call('PUT', `/api/v1/Project/${projectId}`, { boardId: other });
    expect(moved.status).toBe(422);
    expect(reasonOf(moved)).toContain('cannot be changed');

    const project = await fix.call('GET', `/api/v1/Project/${projectId}`);
    expect(project.body['boardId']).toBe('projectBoardDefault');
  });

  it('makes the creator the owner and the first Owner member', async () => {
    const projectId = await fix.createProject();
    const project = await fix.call('GET', `/api/v1/Project/${projectId}`);
    expect(project.body['ownerUserId']).toBe('adminUserId');
    const members = await fix.call('GET', `/api/v1/Project/${projectId}/members`);
    const list = (members.body['list'] ?? []) as Record<string, unknown>[];
    expect(list.map((row) => row['userId'])).toContain('adminUserId');
  });

  it('hierarchical categories refuse a loop and refuse to be deleted while in use', async () => {
    const root = await fix.create('ProjectCategory');
    const child = await fix.create('ProjectCategory', { parentId: root });
    const grand = await fix.create('ProjectCategory', { parentId: child });

    const loop = await fix.call('PUT', `/api/v1/ProjectCategory/${root}`, { parentId: grand });
    expect(loop.status).toBe(422);
    expect(reasonOf(loop)).toContain('loop');

    const self = await fix.call('PUT', `/api/v1/ProjectCategory/${root}`, { parentId: root });
    expect(self.status).toBe(422);

    const busy = await fix.call('DELETE', `/api/v1/ProjectCategory/${root}`);
    expect(busy.status).toBe(422);
    const project = await fix.createProject({ categoryId: root });
    const stillBusy = await fix.call('DELETE', `/api/v1/ProjectCategory/${root}`);
    expect(stillBusy.status).toBe(422);
    expect(project).toBeTruthy();
  });
});

describe('groups and tasks', () => {
  it('keeps a group inside its project and refuses foreign ids', async () => {
    const projectA = await fix.createProject();
    const projectB = await fix.createProject();
    const groupA = await fix.createGroup(projectA);

    const moved = await fix.call('POST', `/api/v1/Project/${projectB}/action/groupUpdate`, { groupId: groupA, name: 'stolen' });
    expect(moved.status).toBe(422);
    expect(reasonOf(moved)).toContain('another project');

    const task = await fix.createTask(projectA, groupA);
    const crossTask = await fix.call('POST', `/api/v1/Project/${projectB}/action/taskCreate`, {
      projectId: projectB,
      groupId: groupA,
      name: `AGENT_TEST cross ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    });
    expect(crossTask.status).toBe(422);
    expect(reasonOf(crossTask)).toContain('another project');
    expect(task).toBeTruthy();
  });

  it('derives the task status from the stage and refuses a direct status write', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const reviewStage = await fix.stageId('review');
    const taskId = await fix.createTask(projectId, groupId, { stageId: reviewStage });

    const task = await fix.call('GET', `/api/v1/ProjectTask/${taskId}`);
    expect(task.body['status']).toBe('Started');

    const direct = await fix.call('PUT', `/api/v1/ProjectTask/${taskId}`, { status: 'Completed' });
    expect(direct.status).toBe(422);
    expect(reasonOf(direct)).toContain('Status follows the stage');
  });

  it('rejects a stage from another board', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const otherBoard = await fix.create('ProjectBoard');
    const foreignStage = await fix.create('ProjectBoardStage', {
      name: 'Alien stage',
      boardId: otherBoard,
      key: 'alienStage',
      statusValue: 'Completed',
    });
    const task = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId,
      name: `AGENT_TEST wrong board ${fix.runId}`,
      stageId: foreignStage,
    });
    expect(task.status).toBe(422);
    expect(reasonOf(task)).toContain('another board');
  });

  it('moves a task between groups and stages, and the order survives a reload', async () => {
    const projectId = await fix.createProject();
    const backlog = await fix.createGroup(projectId, { groupType: 'Backlog' });
    const work = await fix.createGroup(projectId, { groupType: 'Work' });
    const first = await fix.createTask(projectId, work, { name: `AGENT_TEST first ${fix.runId}` });
    const second = await fix.createTask(projectId, work, { name: `AGENT_TEST second ${fix.runId}` });
    const third = await fix.createTask(projectId, work, { name: `AGENT_TEST third ${fix.runId}` });

    const moved = await fix.call('POST', `/api/v1/ProjectTask/${third}/action/move`, { groupId: backlog, stageId: await fix.stageId('done') });
    expect(moved.status).toBe(200);
    expect(moved.body['groupId']).toBe(backlog);
    expect(moved.body['status']).toBe('Completed');

    // Drag the third row between the two remaining ones.
    const reorder = await fix.call('POST', `/api/v1/ProjectTask/${first}/action/move`, { afterTaskId: second });
    expect(reorder.status).toBe(200);
    const plan = await fix.call('GET', `/api/v1/Project/${projectId}/action/plan`);
    const groups = (plan.body['groups'] ?? []) as { group: Record<string, unknown>; tasks: Record<string, unknown>[] }[];
    const workGroup = groups.find((entry) => entry.group['id'] === work);
    expect((workGroup?.tasks ?? []).map((task) => task['id'])).toEqual([second, first]);

    const foreign = await fix.call('POST', `/api/v1/ProjectTask/${third}/action/move`, { beforeTaskId: second });
    expect(foreign.status).toBe(422);
  });

  it('reorders a submitted block deterministically and refuses rows of another project', async () => {
    const projectId = await fix.createProject();
    const otherProject = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const otherGroup = await fix.createGroup(otherProject);
    const a = await fix.createTask(projectId, groupId, { name: `AGENT_TEST a ${fix.runId}` });
    const b = await fix.createTask(projectId, groupId, { name: `AGENT_TEST b ${fix.runId}` });

    const rejected = await fix.call('POST', `/api/v1/Project/${projectId}/action/groupReorder`, { groupIds: [otherGroup] });
    expect(rejected.status).toBe(422);

    const tasksRejected = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskReorder`, { groupId, taskIds: [b, a] });
    expect(tasksRejected.status).toBe(200);
    const plan = await fix.call('GET', `/api/v1/Project/${projectId}/action/plan`);
    const groups = (plan.body['groups'] ?? []) as { group: Record<string, unknown>; tasks: Record<string, unknown>[] }[];
    expect(groups.find((entry) => entry.group['id'] === groupId)?.tasks.map((task) => task['id'])).toEqual([b, a]);

    const cross = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId: otherGroup,
      name: `AGENT_TEST cross ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    });
    expect(cross.status).toBe(422);
  });

  it('never deletes a group that still holds tasks unless they move first', async () => {
    const projectId = await fix.createProject();
    const from = await fix.createGroup(projectId);
    const to = await fix.createGroup(projectId);
    const taskId = await fix.createTask(projectId, from);

    const blocked = await fix.call('POST', `/api/v1/Project/${projectId}/action/groupRemove`, { groupId: from });
    expect(blocked.status).toBe(422);

    const moved = await fix.call('POST', `/api/v1/Project/${projectId}/action/groupRemove`, { groupId: from, moveToGroupId: to });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body['moved']).toBe(1);
    const task = await fix.call('GET', `/api/v1/ProjectTask/${taskId}`);
    expect(task.body['groupId']).toBe(to);
  });

  it('treats a milestone as a single date, never a duration', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const milestone = await fix.call('POST', `/api/v1/Project/${projectId}/action/milestone`, {
      groupId,
      name: `AGENT_TEST Milestone ${fix.runId}`,
      dateStart: '2026-06-01',
    });
    expect(milestone.status).toBe(200);
    expect(milestone.body['taskType']).toBe('Milestone');
    expect(milestone.body['status']).toBe('Not Started');

    const asDuration = await fix.call('POST', `/api/v1/Project/${projectId}/action/milestone`, {
      groupId,
      name: `AGENT_TEST Bad milestone ${fix.runId}`,
      dateStart: '2026-06-01',
    });
    expect(asDuration.status).toBe(200);
    const withEnd = await fix.call('PUT', `/api/v1/ProjectTask/${asDuration.body['id']}`, { dateEnd: '2026-06-05', version: 1 });
    expect(withEnd.status).toBe(422);
    expect(reasonOf(withEnd)).toContain('single date');
  });

  it('guards the subtask hierarchy and the completion rule', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const parent = await fix.createTask(projectId, groupId, { name: `AGENT_TEST parent ${fix.runId}` });
    const child = await fix.createTask(projectId, groupId, { name: `AGENT_TEST child ${fix.runId}`, parentTaskId: parent });

    const selfParent = await fix.call('POST', `/api/v1/ProjectTask/${parent}/action/move`, { parentTaskId: parent });
    expect(selfParent.status).toBe(422);

    const loop = await fix.call('POST', `/api/v1/ProjectTask/${parent}/action/move`, { parentTaskId: child });
    expect(loop.status).toBe(422);
    expect(reasonOf(loop)).toContain('loop');

    const completeParent = await fix.call('POST', `/api/v1/ProjectTask/${parent}/action/transition`, { kind: 'complete' });
    expect(completeParent.status).toBe(422);
    expect(reasonOf(completeParent)).toContain('subtasks');

    const completeChild = await fix.call('POST', `/api/v1/ProjectTask/${child}/action/transition`, { kind: 'complete' });
    expect(completeChild.status).toBe(200);
    const afterChild = await fix.call('POST', `/api/v1/ProjectTask/${parent}/action/transition`, { kind: 'complete' });
    expect(afterChild.body['status']).toBe('Completed');
  });

  it('reopens a completed parent when one of its subtasks starts working again', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const parent = await fix.createTask(projectId, groupId, { name: `AGENT_TEST parent2 ${fix.runId}` });
    const child = await fix.createTask(projectId, groupId, { name: `AGENT_TEST child2 ${fix.runId}`, parentTaskId: parent });
    await fix.call('POST', `/api/v1/ProjectTask/${child}/action/transition`, { kind: 'complete' });
    await fix.call('POST', `/api/v1/ProjectTask/${parent}/action/transition`, { kind: 'complete' });

    const reopen = await fix.call('POST', `/api/v1/ProjectTask/${child}/action/move`, { stageId: await fix.stageId('inProgress') });
    expect(reopen.status).toBe(200);
    const parentAfter = await fix.call('GET', `/api/v1/ProjectTask/${parent}`);
    expect(parentAfter.body['status']).toBe('Started');
  });

  it('deletes nothing that still has descendants', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const parent = await fix.createTask(projectId, groupId, { name: `AGENT_TEST parent3 ${fix.runId}` });
    await fix.createTask(projectId, groupId, { name: `AGENT_TEST child3 ${fix.runId}`, parentTaskId: parent });

    const deleteParent = await fix.call('DELETE', `/api/v1/ProjectTask/${parent}`);
    expect(deleteParent.status).toBe(422);
    const child = await fix.call('GET', `/api/v1/ProjectTask/${parent}`);
    expect(child.status).toBe(200);
  });
});

describe('project settings', () => {
  it('enforces a disabled feature on the API and keeps the stored value when it is re-enabled', async () => {
    const projectId = await fix.createProject({ pointsEnabled: true, estimatedHoursEnabled: true });
    const groupId = await fix.createGroup(projectId);
    const taskId = await fix.createTask(projectId, groupId, { priority: 'High', points: 5, estimateHours: 2.5 });

    const off = await fix.call('POST', `/api/v1/Project/${projectId}/action/settings`, { priorityEnabled: false, pointsEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body['priorityEnabled']).toBe(false);

    const rejected = await fix.call('PUT', `/api/v1/ProjectTask/${taskId}`, { priority: 'Urgent' });
    expect(rejected.status).toBe(422);
    expect(reasonOf(rejected)).toContain('disabled');

    // A write that does not touch the disabled field is still allowed.
    const rename = await fix.call('PUT', `/api/v1/ProjectTask/${taskId}`, { name: `AGENT_TEST renamed ${fix.runId}` });
    expect(rename.status).toBe(200);

    await fix.call('POST', `/api/v1/Project/${projectId}/action/settings`, { priorityEnabled: true, pointsEnabled: true });
    const task = await fix.call('GET', `/api/v1/ProjectTask/${taskId}`);
    expect(task.body['priority']).toBe('High');
    expect(task.body['points']).toBe(5);
    expect(task.body['estimateHours']).toBe(2.5);
  });

  it('hides the Gantt view when it is disabled, without erasing dates', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const taskId = await fix.createTask(projectId, groupId, { dateStart: '2026-07-01', dateEnd: '2026-07-05' });

    const view = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt`);
    expect(view.status).toBe(200);
    expect((view.body['tasks'] ?? []) as unknown[]).toHaveLength(1);

    await fix.call('POST', `/api/v1/Project/${projectId}/action/settings`, { ganttEnabled: false });
    const hidden = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt`);
    expect(hidden.status).toBe(422);
    const task = await fix.call('GET', `/api/v1/ProjectTask/${taskId}`);
    // The kernel serialises a `date` attribute as an instant; the day part is what the view reads.
    expect(String(task.body['dateStart'])).toMatch(/^2026-07-01/);
    expect(String(task.body['dateEnd'])).toMatch(/^2026-07-05/);
  });
});

describe('read projections', () => {
  it('serves the kanban columns from the board stages of the project', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    const taskId = await fix.createTask(projectId, groupId, { name: `AGENT_TEST kanban ${fix.runId}` });

    const board = await fix.call('GET', `/api/v1/Project/${projectId}/action/board?groupId=${groupId}`);
    expect(board.status).toBe(200);
    const columns = (board.body['columns'] ?? []) as { stage: Record<string, unknown>; tasks: Record<string, unknown>[] }[];
    expect(columns.length).toBeGreaterThanOrEqual(5);
    expect(columns.map((column) => column.stage['key'])).toContain('notStarted');
    const first = columns.find((column) => (column.tasks ?? []).some((task) => task['id'] === taskId));
    expect(first?.stage['statusValue']).toBe('Not Started');

    const stages = await fix.call('GET', `/api/v1/Project/${projectId}/action/stages`);
    expect((stages.body['list'] ?? []) as unknown[]).toHaveLength(columns.length);
  });

  it('draws milestones and dependency edges in the gantt projection', async () => {
    const projectId = await fix.createProject();
    const groupId = await fix.createGroup(projectId);
    await fix.call('POST', `/api/v1/Project/${projectId}/action/settings`, { dependenciesEnabled: true });
    const first = await fix.createTask(projectId, groupId, { name: `AGENT_TEST g1 ${fix.runId}`, dateStart: '2026-08-01', dateEnd: '2026-08-03' });
    const second = await fix.createTask(projectId, groupId, { name: `AGENT_TEST g2 ${fix.runId}`, dateStart: '2026-08-04', dateEnd: '2026-08-06' });
    const milestone = await fix.call('POST', `/api/v1/Project/${projectId}/action/milestone`, { groupId, name: `AGENT_TEST m ${fix.runId}`, dateStart: '2026-08-07' });
    const edge = await fix.call('POST', `/api/v1/ProjectTask/${second}/action/dependencies`, { predecessorTaskId: first, dependencyType: 'FinishToStart' });
    expect(edge.status, JSON.stringify(edge.body)).toBe(200);

    const gantt = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt`);
    expect(gantt.status).toBe(200);
    const tasks = (gantt.body['tasks'] ?? []) as Record<string, unknown>[];
    expect(tasks).toHaveLength(3);
    expect(tasks.find((task) => task['id'] === milestone.body['id'])?.['taskType']).toBe('Milestone');
    const dependencies = (gantt.body['dependencies'] ?? []) as Record<string, unknown>[];
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]?.['dependencyType']).toBe('FinishToStart');
  });

  it('excludes Backlog and Triage from the gantt unless asked for every group type', async () => {
    const projectId = await fix.createProject();
    const work = await fix.createGroup(projectId, { groupType: 'Work' });
    const backlog = await fix.createGroup(projectId, { groupType: 'Backlog' });
    await fix.createTask(projectId, work, { dateStart: '2026-09-01', dateEnd: '2026-09-02' });
    await fix.createTask(projectId, backlog, { dateStart: '2026-09-01', dateEnd: '2026-09-02' });

    const filtered = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt`);
    expect((filtered.body['tasks'] ?? []) as unknown[]).toHaveLength(1);
    expect(((filtered.body['groups'] ?? []) as unknown[])).toHaveLength(1);

    const all = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt?allGroupTypes=true`);
    expect((all.body['tasks'] ?? []) as unknown[]).toHaveLength(2);
  });

  it('reports the caller capabilities so the UI never has to guess', async () => {
    const projectId = await fix.createProject();
    const capabilities = await fix.call('GET', `/api/v1/Project/${projectId}/action/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body['isMember']).toBe(true);
    const parsed = capabilities.body['capabilities'] as Record<string, boolean>;
    expect(parsed['createTask']).toBe(true);
    expect(parsed['manageMembers']).toBe(true);
    const features = capabilities.body['features'] as Record<string, boolean>;
    expect(features['priorityEnabled']).toBe(true);
    expect(features['dependenciesEnabled']).toBe(false);
  });
});
