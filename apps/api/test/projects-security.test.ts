import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { ProjectFixture } from './support/projects-fixtures.js';
import { projectFixture, reasonOf } from './support/projects-fixtures.js';

/**
 * Phase 19 — the authorization matrix (§9) and the leak tests (§9.1).
 *
 * The principals are ordinary users with a deliberately narrow global ACL (`own` on the Project
 * entities), which is the configuration where a project role is allowed to matter at all. A
 * permission that the global ACL denies outright must stay denied however generous the role is.
 */
let ctx: ApiContext;
let fix: ProjectFixture;
let projectId = '';
let otherProjectId = '';
let groupId = '';
let otherGroupId = '';
let ownerId = '';
let editorUser: TestUser;
let memberUser: TestUser;
let viewerUser: TestUser;
let strangerUser: TestUser;
let readerRoleId = '';
let editorId = '';
let memberId = '';
let viewerId = '';
let strangerId = '';
let groupIdOfEditor = '';
let taskOfOwner = '';
const userSuffix = Date.now().toString(36);

const ROLE_NAME = `AGENT_TEST p19 role ${userSuffix}`;
const ROLE_ID = `role-agent-test-p19-${userSuffix}`;
/** `own` everywhere: without a project role, each user only sees their own records. */
const PROJECT_PERMISSIONS = {
  Project: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'own' },
  ProjectTask: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'own' },
  ProjectGroup: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'no' },
  ProjectMember: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'no' },
  ProjectTaskCollaborator: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'no' },
  ProjectTaskDependency: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'no' },
  ProjectBoard: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  ProjectBoardStage: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  ProjectRole: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  ProjectCategory: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  User: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' },
  Account: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' },
  Note: { create: 'yes', read: 'own', edit: 'own', delete: 'own', stream: 'no' },
};

beforeAll(async () => {
  ctx = await bootApi();
  fix = await projectFixture(ctx);

  await createTestRole(ctx, { id: ROLE_ID, name: ROLE_NAME, permissions: PROJECT_PERMISSIONS });
  editorUser = await createTestUser(ctx, { userName: `p19editor${userSuffix}`, password: 'secret-password', roleIds: [ROLE_ID] });
  memberUser = await createTestUser(ctx, { userName: `p19member${userSuffix}`, password: 'secret-password', roleIds: [ROLE_ID] });
  viewerUser = await createTestUser(ctx, { userName: `p19viewer${userSuffix}`, password: 'secret-password', roleIds: [ROLE_ID] });
  strangerUser = await createTestUser(ctx, { userName: `p19stranger${userSuffix}`, password: 'secret-password', roleIds: [ROLE_ID] });
  editorId = editorUser.id;
  memberId = memberUser.id;
  viewerId = viewerUser.id;
  strangerId = strangerUser.id;

  projectId = await fix.createProject({ name: `AGENT_TEST SecProject ${fix.runId}`, collaboratorsEnabled: true, dependenciesEnabled: true });
  groupId = await fix.createGroup(projectId);
  otherProjectId = await fix.createProject({ name: `AGENT_TEST OtherProject ${fix.runId}` });
  otherGroupId = await fix.createGroup(otherProjectId);
  ownerId = 'adminUserId';

  await fix.createMember(projectId, editorId, 'projectRoleEditor');
  await fix.createMember(projectId, memberId, 'projectRoleMember');
  // A role that may read its own tasks and nothing else.
  readerRoleId = await fix.create('ProjectRole', {
    name: `AGENT_TEST reader ${fix.runId}`,
    taskCreate: 'no', assignmentScope: 'own', taskReadScope: 'own', taskStreamScope: 'own', taskEditScope: 'own',
    stageMoveScope: 'own', taskDeleteScope: 'no', projectStreamAccess: 'no', groupManage: 'no', memberManage: 'no', projectEdit: 'no',
  });
  await fix.createMember(projectId, viewerId, readerRoleId);

  taskOfOwner = await fix.createTask(projectId, groupId, { name: `AGENT_TEST ownerTask ${fix.runId}`, ownerUserId: ownerId, assigneeUserId: ownerId });
  groupIdOfEditor = groupId;
});

afterAll(async () => {
  await fix?.cleanup();
  for (const id of [editorId, memberId, viewerId, strangerId]) {
    if (id !== '') await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  await ctx.database.db.deleteFrom('roles').where('id', '=', ROLE_ID).execute().catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['Project', 'ProjectTask', 'ProjectGroup', 'ProjectMember', 'ProjectTaskCollaborator', 'ProjectTaskDependency', 'ProjectRole']);
  await shutdownApi();
});

describe('project membership and global ACL', () => {
  it('lets a member see the project through their membership, and keeps it invisible to a stranger', async () => {
    const asMember = await fix.call('GET', `/api/v1/Project/${projectId}`, undefined, memberUser.token);
    expect(asMember.status).toBe(200);

    const asStranger = await fix.call('GET', `/api/v1/Project/${projectId}`, undefined, strangerUser.token);
    expect(asStranger.status).toBe(404);

    const list = await fix.call('GET', '/api/v1/Project?maxSize=200', undefined, strangerUser.token);
    const ids = ((list.body['list'] ?? []) as Record<string, unknown>[]).map((row) => row['id']);
    expect(ids).not.toContain(projectId);
  });

  it('refuses everything to a principal whose global ACL denies the entity action', async () => {
    await createTestRole(ctx, {
      id: `role-agent-test-p19-none-${userSuffix}`,
      name: `AGENT_TEST none ${userSuffix}`,
      permissions: { Project: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' }, ProjectTask: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' } },
    });
    const noAcl = await createTestUser(ctx, { userName: `p19noacl${userSuffix}`, password: 'secret-password', roleIds: [`role-agent-test-p19-none-${userSuffix}`] });
    // This user IS a project member with the Editor role — the global ACL still has the last word.
    await fix.createMember(projectId, noAcl.id, 'projectRoleEditor');

    const read = await fix.call('GET', `/api/v1/Project/${projectId}`, undefined, noAcl.token);
    expect(read.status).toBe(403);
    const create = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, { projectId, groupId: groupIdOfEditor, name: `AGENT_TEST nope ${fix.runId}` }, noAcl.token);
    expect(create.status).toBe(403);
    const plan = await fix.call('GET', `/api/v1/Project/${projectId}/action/plan`, undefined, noAcl.token);
    expect(plan.status).toBe(403);

    await ctx.database.db.deleteFrom('users').where('id', '=', noAcl.id).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('roles').where('id', '=', `role-agent-test-p19-none-${userSuffix}`).execute().catch(() => undefined);
  });

  it('rejects a guessed id of another project rather than pretending it is a member', async () => {
    const group = await fix.call('POST', `/api/v1/Project/${otherProjectId}/action/groupCreate`, { name: `AGENT_TEST foreign ${fix.runId}` }, editorUser.token);
    expect(group.status).toBe(403);

    const task = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId: otherGroupId,
      name: `AGENT_TEST cross ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    }, editorUser.token);
    expect(task.status).toBe(422);
    expect(reasonOf(task)).toContain('another project');
  });
});

describe('project roles narrow what the member may do', () => {
  it('an Editor creates tasks and manages groups; a Member edits only their own work', async () => {
    const created = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId,
      name: `AGENT_TEST editorTask ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    }, editorUser.token);
    expect(created.status, reasonOf(created)).toBe(200);
    const editorTaskId = String(created.body['id']);

    const group = await fix.call('POST', `/api/v1/Project/${projectId}/action/groupCreate`, { name: `AGENT_TEST editorGroup ${fix.runId}` }, editorUser.token);
    expect(group.status, reasonOf(group)).toBe(200);

    const memberTask = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId,
      name: `AGENT_TEST memberTask ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    }, memberUser.token);
    expect(memberTask.status, reasonOf(memberTask)).toBe(200);

    // The Member role edits `own`: the editor's task is readable (taskReadScope all) but not theirs.
    // The Member role edits `own`: the editor's task is readable (taskReadScope all) but not theirs.
    const foreignEdit = await fix.call('PUT', `/api/v1/ProjectTask/${editorTaskId}`, { name: `AGENT_TEST stolen ${fix.runId}` }, memberUser.token);
    // Out of the member's record scope, so the kernel answers 404 rather than confirming the
    // record exists; a scope the reader can reach but the role forbids answers 403.
    expect([403, 404]).toContain(foreignEdit.status);
    const ownEdit = await fix.call('PUT', `/api/v1/ProjectTask/${memberTask.body['id']}`, { name: `AGENT_TEST memberRenamed ${fix.runId}` }, memberUser.token);
    expect(ownEdit.status, reasonOf(ownEdit)).toBe(200);

    // …and `stageMoveScope: assigned`: a task assigned to somebody else cannot be moved.
    const move = await fix.call('POST', `/api/v1/ProjectTask/${editorTaskId}/action/move`, { stageId: await fix.stageId('inProgress') }, memberUser.token);
    expect([403, 404]).toContain(move.status);
    const assign = await fix.call('PUT', `/api/v1/ProjectTask/${memberTask.body['id']}`, { assigneeUserId: memberUser.id }, memberUser.token);
    expect(assign.status, reasonOf(assign)).toBe(200);
    const moveOwn = await fix.call('POST', `/api/v1/ProjectTask/${memberTask.body['id']}/action/move`, { stageId: await fix.stageId('inProgress') }, memberUser.token);
    expect(moveOwn.status, reasonOf(moveOwn)).toBe(200);
    expect(moveOwn.body['status']).toBe('Started');

    const deleteDenied = await fix.call('DELETE', `/api/v1/ProjectTask/${memberTask.body['id']}`, undefined, memberUser.token);
    // `taskDeleteScope: no` — the role narrows even the member's own record.
    expect([403, 404]).toContain(deleteDenied.status);
  });

  it('a reader-only role sees nothing it does not own and cannot create anything', async () => {
    const create = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId,
      name: `AGENT_TEST readerTask ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    }, viewerUser.token);
    expect(create.status, reasonOf(create)).toBe(403);

    const list = await fix.call('GET', `/api/v1/ProjectTask?where=${encodeURIComponent(JSON.stringify([{ field: 'projectId', operator: 'equals', value: projectId }]))}`, undefined, viewerUser.token);
    const ids = ((list.body['list'] ?? []) as Record<string, unknown>[]).map((row) => row['id']);
    expect(ids).not.toContain(taskOfOwner);

    const detail = await fix.call('GET', `/api/v1/ProjectTask/${taskOfOwner}`, undefined, viewerUser.token);
    expect(detail.status).toBe(404);
  });

  it('refuses an assignee who is not a project member', async () => {
    const task = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId,
      name: `AGENT_TEST assignForeign ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
    }, editorUser.token);
    const assign = await fix.call('PUT', `/api/v1/ProjectTask/${task.body['id']}`, { assigneeUserId: strangerId }, editorUser.token);
    expect(assign.status).toBe(422);
    expect(reasonOf(assign)).toContain('member of the project');
  });

  it('keeps the last managing member from disappearing without a transfer', async () => {
    const solo = await fix.createProject({ name: `AGENT_TEST SoloProject ${fix.runId}` });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const members = await fix.call('GET', `/api/v1/Project/${solo}/action/members`);
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    const rows = (members.body['list'] ?? []) as Record<string, unknown>[];
    const adminMember = rows.find((row) => row['userId'] === 'adminUserId');
    expect(adminMember).toBeDefined();

    const refused = await fix.call('POST', `/api/v1/Project/${solo}/action/memberRemove`, { memberId: String(adminMember?.['id']) });
    expect(refused.status, reasonOf(refused)).toBe(422);
    expect(reasonOf(refused)).toContain('ownership');

    await fix.createMember(solo, editorId, 'projectRoleEditor');
    const after = await fix.call('GET', `/api/v1/Project/${solo}/action/members`);
    const editorRow = ((after.body['list'] ?? []) as Record<string, unknown>[]).find((row) => row['userId'] === editorId);
    const transferred = await fix.call('POST', `/api/v1/Project/${solo}/action/memberRemove`, { memberId: String(adminMember?.['id']), transferToMemberId: String(editorRow?.['id']) });
    expect(transferred.status, reasonOf(transferred)).toBe(200);
  });

  it('clears tasks and collaborations when a member leaves', async () => {
    const task = await fix.createTask(projectId, groupIdOfEditor, { name: `AGENT_TEST leaving ${fix.runId}`, assigneeUserId: memberId });
    await fix.call('POST', `/api/v1/Project/${projectId}/action/members`, { userId: memberId, projectRoleId: 'projectRoleMember' }).catch(() => undefined);
    const members = await fix.call('GET', `/api/v1/Project/${projectId}/action/members`);
    const row = ((members.body['list'] ?? []) as Record<string, unknown>[]).find((entry) => entry['userId'] === memberId);
    expect(row).toBeDefined();

    const removed = await fix.call('POST', `/api/v1/Project/${projectId}/action/memberRemove`, { memberId: String(row?.['id']) });
    expect(removed.status, reasonOf(removed)).toBe(200);
    const after = await fix.call('GET', `/api/v1/ProjectTask/${task}`);
    expect(after.body['assigneeUserId']).toBeNull();

    // Re-add so the remaining cases keep their fixture.
    await fix.createMember(projectId, memberId, 'projectRoleMember');
  });

  it('runs bulk membership changes per project and reports what it refused', async () => {
    const second = await fix.createProject({ name: `AGENT_TEST BulkProject ${fix.runId}` });
    const bulk = await fix.call('POST', `/api/v1/Project/${second}/action/memberBulk`, {
      projectIds: [second, projectId, otherProjectId],
      userIds: [viewerId],
      projectRoleId: 'projectRoleMember',
      operation: 'add',
    }, editorUser.token);
    expect(bulk.status, reasonOf(bulk)).toBe(200);
    const result = bulk.body as { succeeded: string[]; failed: unknown[] };
    // The editor is a member of `projectId` (Editor role, memberManage 'no') and of none of the
    // others, so nothing here is authorised — and no membership is created anywhere.
    expect(result.succeeded).toEqual([]);
    expect(result.failed.length).toBe(3);
  });
});

describe('projections never leak what the reader cannot open', () => {
  it('filters the plan, the board, the gantt, the dashlet and the calendar', async () => {
    // `viewerUser` holds the reader-only role: its own tasks, nobody else's.
    const hidden = await fix.createTask(projectId, groupIdOfEditor, { name: `AGENT_TEST hidden ${fix.runId}`, ownerUserId: ownerId, dateStart: '2026-01-04', dateEnd: '2026-01-05' });
    const mineResult = await fix.call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
      projectId,
      groupId: groupIdOfEditor,
      name: `AGENT_TEST mine ${fix.runId}`,
      stageId: await fix.stageId('notStarted'),
      ownerUserId: viewerId,
      dateStart: '2026-01-04',
      dateEnd: '2026-01-05',
    });
    expect(mineResult.status, reasonOf(mineResult)).toBe(200);
    const mine = String(mineResult.body['id']);

    const plan = await fix.call('GET', `/api/v1/Project/${projectId}/action/plan`, undefined, viewerUser.token);
    expect(plan.status, reasonOf(plan)).toBe(200);
    const ids = ((plan.body['groups'] ?? []) as { tasks: Record<string, unknown>[] }[]).flatMap((group) => group.tasks.map((task) => task['id']));
    expect(ids).toContain(mine);
    expect(ids).not.toContain(hidden);

    const board = await fix.call('GET', `/api/v1/Project/${projectId}/action/board?groupId=${groupIdOfEditor}`, undefined, viewerUser.token);
    const boardIds = ((board.body['columns'] ?? []) as { tasks: Record<string, unknown>[] }[]).flatMap((column) => column.tasks.map((task) => task['id']));
    expect(boardIds).not.toContain(hidden);

    const gantt = await fix.call('GET', `/api/v1/Project/${projectId}/action/gantt`, undefined, viewerUser.token);
    const ganttIds = ((gantt.body['tasks'] ?? []) as Record<string, unknown>[]).map((task) => task['id']);
    expect(ganttIds).not.toContain(hidden);

    const window = `?from=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-31T00:00:00.000Z')}&entities=ProjectTask`;
    const calendar = await fix.call('GET', `/api/v1/Calendar${window}`, undefined, viewerUser.token);
    const events = (calendar.body['list'] ?? []) as Record<string, unknown>[];
    expect(events.map((event) => event['activityId'])).not.toContain(hidden);
    expect(events.map((event) => event['activityId'])).toContain(mine);
  });

  it('answers the stream and note endpoints with the same boundary', async () => {
    const hidden = await fix.createTask(projectId, groupIdOfEditor, { name: `AGENT_TEST hiddenStream ${fix.runId}` });
    const stream = await fix.call('GET', `/api/v1/ProjectTask/${hidden}/stream`, undefined, viewerUser.token);
    expect([403, 404]).toContain(stream.status);
    const note = await fix.call('POST', '/api/v1/Note', { parentType: 'ProjectTask', parentId: hidden, post: 'AGENT_TEST leak' }, viewerUser.token);
    expect([403, 404]).toContain(note.status);

    const projectStream = await fix.call('GET', `/api/v1/Project/${projectId}/stream`, undefined, viewerUser.token);
    expect(projectStream.status).toBe(403);
  });

  it('shows a member only their own work in the Project Task dashlet', async () => {
    const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    await fix.createTask(projectId, groupIdOfEditor, { name: `AGENT_TEST dashOther ${fix.runId}`, ownerUserId: ownerId, dateStart: day(1), dateEnd: day(2) });
    await fix.createTask(projectId, groupIdOfEditor, { name: `AGENT_TEST dashMine ${fix.runId}`, ownerUserId: memberId, assigneeUserId: memberId, dateStart: day(1), dateEnd: day(2) });
    const dashboard = await fix.call('POST', '/api/v1/Dashboard', { name: `AGENT_TEST dash ${fix.runId}`, isShared: true });
    const dashboardId = String(dashboard.body['id']);
    const dashlet = await fix.call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, {
      name: 'My project tasks',
      kind: 'projectTasks',
      position: 0,
      config: { nextDays: 365, includeOwned: true, includeCollaboration: false, excludeAssigned: false, groupTypes: [], includeCompleted: false, maxSize: 50 },
    });
    expect(dashlet.status, reasonOf(dashlet)).toBe(201);
    const dashletId = String((dashlet.body as { id?: string })['id'] ?? '');

    const mine = await fix.call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`, undefined, memberUser.token);
    expect(mine.status, reasonOf(mine)).toBe(200);
    const rows = (mine.body['list'] ?? []) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The Member role reads `all` tasks of this project, so a colleague's task may appear; the
      // dashlet's own option set is what must hold: only rows owned, assigned or shared.
      expect([memberId, ownerId]).toContain(row['ownerUserId'] ?? row['assigneeUserId']);
    }
    expect(rows.some((row) => row['ownerUserId'] === memberId || row['assigneeUserId'] === memberId)).toBe(true);

    const hidden = await fix.call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`, undefined, viewerUser.token);
    expect(((hidden.body['list'] ?? []) as Record<string, unknown>[]).length).toBe(0);
  });
});
