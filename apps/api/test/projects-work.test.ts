import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';
import type { ProjectFixture } from './support/projects-fixtures.js';
import { projectFixture, reasonOf } from './support/projects-fixtures.js';

/**
 * Phase 19 — task transitions and dependencies (§4.7, §4.8, §12.5 scenarios 7 and 8).
 */
let ctx: ApiContext;
let fix: ProjectFixture;
let projectId = '';
let groupId = '';

async function newProject(flags: Record<string, boolean> = {}): Promise<string> {
  const id = await fix.createProject({ dependenciesEnabled: true, collaboratorsEnabled: true, ...flags });
  return id;
}

/** A task in a given stage key, so a test can name the status it starts from. */
async function taskIn(stageKey: string, name: string, targetProject = projectId, targetGroup = groupId): Promise<string> {
  return fix.createTask(targetProject, targetGroup, { name: `AGENT_TEST ${name} ${fix.runId}`, stageId: await fix.stageId(stageKey) });
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await projectFixture(ctx);
  projectId = await newProject();
  groupId = await fix.createGroup(projectId);
});

afterAll(async () => {
  await fix?.cleanup();
  await shutdownApi();
});

describe('task transitions', () => {
  it('starts, completes and cancels through stage moves, and the status follows the board', async () => {
    const taskId = await taskIn('notStarted', 'transition');
    const start = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/transition`, { kind: 'start' });
    expect(start.status, reasonOf(start)).toBe(200);
    expect(start.body['status']).toBe('Started');
    expect(String(start.body['stageId'])).toBe(await fix.stageId('inProgress'));

    const complete = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/transition`, { kind: 'complete' });
    expect(complete.body['status']).toBe('Completed');

    const cancelled = await taskIn('notStarted', 'to-cancel');
    const cancel = await fix.call('POST', `/api/v1/ProjectTask/${cancelled}/action/transition`, { kind: 'cancel' });
    expect(cancel.body['status']).toBe('Canceled');
  });

  it('refuses a transition the board cannot express', async () => {
    const board = await fix.create('ProjectBoard', { name: `AGENT_TEST tiny board ${fix.runId}` });
    const stage = await fix.create('ProjectBoardStage', { boardId: board, key: 'onlyOne', name: 'Only', statusValue: 'Not Started' });
    const project = await fix.createProject({ boardId: board, dependenciesEnabled: true });
    const group = await fix.createGroup(project);
    const taskId = await fix.createTask(project, group, { stageId: stage });

    const complete = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/transition`, { kind: 'complete' });
    expect(complete.status).toBe(422);
    expect(reasonOf(complete)).toContain('no "Completed" stage');
  });

  it('applies bulk completion per record and reports what it refused', async () => {
    const done = await taskIn('notStarted', 'bulk-done');
    const withChild = await taskIn('notStarted', 'bulk-parent');
    await taskIn('notStarted', 'bulk-child', projectId, groupId).then(async (child) => {
      await fix.call('POST', `/api/v1/ProjectTask/${child}/action/move`, { parentTaskId: withChild });
    });

    const bulk = await fix.call('POST', '/api/v1/ProjectTask/action/bulk', { ids: [done, withChild], operation: 'complete' });
    expect(bulk.status, reasonOf(bulk)).toBe(200);
    const result = bulk.body as { succeeded: string[]; failed: { id: string; message: string }[] };
    expect(result.succeeded).toEqual([done]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toContain('subtasks');

    const selfAssign = await fix.call('POST', '/api/v1/ProjectTask/action/bulk', { ids: [withChild], operation: 'selfAssign' });
    expect(selfAssign.status).toBe(200);
    const task = await fix.call('GET', `/api/v1/ProjectTask/${withChild}`);
    expect(task.body['assigneeUserId']).toBe('adminUserId');
  });
});

describe('dependencies', () => {
  it('FinishToStart prevents the successor from starting until the predecessor is completed', async () => {
    const predecessor = await taskIn('notStarted', 'fs-pre');
    const successor = await taskIn('notStarted', 'fs-succ');
    const edge = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencies`, { predecessorTaskId: predecessor, dependencyType: 'FinishToStart' });
    expect(edge.status, JSON.stringify(edge.body)).toBe(200);

    const blocked = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' });
    expect(blocked.status).toBe(422);
    expect(reasonOf(blocked)).toContain('FinishToStart');
    expect(reasonOf(blocked)).toContain('must be completed');

    await fix.call('POST', `/api/v1/ProjectTask/${predecessor}/action/transition`, { kind: 'complete' });
    const allowed = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' });
    expect(allowed.status, reasonOf(allowed)).toBe(200);
  });

  it('StartToStart needs a started predecessor and FinishToFinish needs a finished one', async () => {
    const predecessor = await taskIn('notStarted', 'ss-pre');
    const successor = await taskIn('notStarted', 'ss-succ');
    await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencies`, { predecessorTaskId: predecessor, dependencyType: 'StartToStart' });

    const startBlocked = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' });
    expect(startBlocked.status).toBe(422);
    expect(reasonOf(startBlocked)).toContain('must be started');

    await fix.call('POST', `/api/v1/ProjectTask/${predecessor}/action/transition`, { kind: 'start' });
    const startNow = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' });
    expect(startNow.status, reasonOf(startNow)).toBe(200);

    // FinishToFinish: the successor may run, but not finish, while the predecessor is open.
    const tail = await taskIn('notStarted', 'ff-succ');
    await fix.call('POST', `/api/v1/ProjectTask/${tail}/action/dependencies`, { predecessorTaskId: predecessor, dependencyType: 'FinishToFinish' });
    const finishBlocked = await fix.call('POST', `/api/v1/ProjectTask/${tail}/action/transition`, { kind: 'complete' });
    expect(finishBlocked.status).toBe(422);
    expect(reasonOf(finishBlocked)).toContain('FinishToFinish');
    await fix.call('POST', `/api/v1/ProjectTask/${predecessor}/action/transition`, { kind: 'complete' });
    const finishNow = await fix.call('POST', `/api/v1/ProjectTask/${tail}/action/transition`, { kind: 'complete' });
    expect(finishNow.status, reasonOf(finishNow)).toBe(200);
  });

  it('StartToFinish only guards completion, and an untyped edge never blocks', async () => {
    const predecessor = await taskIn('notStarted', 'sf-pre');
    const successor = await taskIn('notStarted', 'sf-succ');
    await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencies`, { predecessorTaskId: predecessor, dependencyType: 'StartToFinish' });

    const start = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' });
    expect(start.status, reasonOf(start)).toBe(200);
    const complete = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'complete' });
    expect(complete.status).toBe(422);
    expect(reasonOf(complete)).toContain('must be started');

    const free = await taskIn('notStarted', 'untyped');
    const other = await taskIn('notStarted', 'untyped-pre');
    const declarative = await fix.call('POST', `/api/v1/ProjectTask/${free}/action/dependencies`, { predecessorTaskId: other, dependencyType: null });
    expect(declarative.status, reasonOf(declarative)).toBe(200);
    const doneAnyway = await fix.call('POST', `/api/v1/ProjectTask/${free}/action/transition`, { kind: 'complete' });
    expect(doneAnyway.status, reasonOf(doneAnyway)).toBe(200);
  });

  it('refuses a self edge, a cycle, a cross-project edge and a duplicate', async () => {
    const a = await taskIn('notStarted', 'cycle-a');
    const b = await taskIn('notStarted', 'cycle-b');
    const c = await taskIn('notStarted', 'cycle-c');

    const self = await fix.call('POST', `/api/v1/ProjectTask/${a}/action/dependencies`, { predecessorTaskId: a });
    expect(self.status, JSON.stringify(self.body)).toBe(422);
    expect(reasonOf(self)).toContain('itself');

    expect((await fix.call('POST', `/api/v1/ProjectTask/${b}/action/dependencies`, { predecessorTaskId: a, dependencyType: 'FinishToStart' })).status).toBe(200);
    const loop = await fix.call('POST', `/api/v1/ProjectTask/${a}/action/dependencies`, { predecessorTaskId: b, dependencyType: 'FinishToStart' });
    expect(loop.status).toBe(422);
    expect(reasonOf(loop)).toContain('cycle');

    const three = await fix.call('POST', `/api/v1/ProjectTask/${c}/action/dependencies`, { predecessorTaskId: b });
    expect(three.status).toBe(200);
    const deep = await fix.call('POST', `/api/v1/ProjectTask/${a}/action/dependencies`, { predecessorTaskId: c });
    expect(deep.status).toBe(422);
    expect(reasonOf(deep)).toContain('cycle');

    const otherProject = await newProject();
    const otherGroup = await fix.createGroup(otherProject);
    const foreign = await taskIn('notStarted', 'foreign', otherProject, otherGroup);
    const cross = await fix.call('POST', `/api/v1/ProjectTask/${a}/action/dependencies`, { predecessorTaskId: foreign });
    expect(cross.status).toBe(422);
    expect(reasonOf(cross)).toContain('same project');

    const duplicate = await fix.call('POST', `/api/v1/ProjectTask/${b}/action/dependencies`, { predecessorTaskId: a });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);
  });

  it('changes a dependency type, deletes it, and refuses both when the project disabled them', async () => {
    const predecessor = await taskIn('notStarted', 'type-pre');
    const successor = await taskIn('notStarted', 'type-succ');
    const edge = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencies`, { predecessorTaskId: predecessor, dependencyType: 'FinishToStart' });
    expect(edge.status).toBe(200);
    const edgeId = String(edge.body['id']);

    const listed = await fix.call('GET', `/api/v1/ProjectTask/${successor}/action/dependencies`);
    expect((listed.body['predecessors'] ?? []) as unknown[]).toHaveLength(1);

    const changed = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencyUpdate`, { dependencyId: edgeId, dependencyType: 'StartToStart' });
    expect(changed.status, reasonOf(changed)).toBe(200);
    expect(changed.body['dependencyType']).toBe('StartToStart');

    // StartToStart is satisfied as soon as the predecessor has started, so this now passes.
    await fix.call('POST', `/api/v1/ProjectTask/${predecessor}/action/transition`, { kind: 'start' });
    expect((await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/transition`, { kind: 'start' })).status).toBe(200);

    const removed = await fix.call('POST', `/api/v1/ProjectTask/${successor}/action/dependencyRemove`, { dependencyId: edgeId });
    expect(removed.status).toBe(200);
    const empty = await fix.call('GET', `/api/v1/ProjectTask/${successor}/action/dependencies`);
    expect((empty.body['predecessors'] ?? []) as unknown[]).toHaveLength(0);

    const strictProject = await fix.createProject();
    const strictGroup = await fix.createGroup(strictProject);
    const one = await fix.createTask(strictProject, strictGroup, { stageId: await fix.stageId('notStarted') });
    const two = await fix.createTask(strictProject, strictGroup, { stageId: await fix.stageId('notStarted') });
    const refused = await fix.call('POST', `/api/v1/ProjectTask/${two}/action/dependencies`, { predecessorTaskId: one });
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toContain('disabled');
  });

  it('refuses a dependency addressed from another task', async () => {
    const owner = await taskIn('notStarted', 'edge-owner');
    const stranger = await taskIn('notStarted', 'edge-stranger');
    const edge = await fix.call('POST', `/api/v1/ProjectTask/${owner}/action/dependencies`, { predecessorTaskId: stranger });
    const forged = await fix.call('POST', `/api/v1/ProjectTask/${stranger}/action/dependencyRemove`, { dependencyId: String(edge.body['id']) });
    expect(forged.status).toBe(422);
    expect(reasonOf(forged)).toContain('another task');
  });
});

describe('collaborators', () => {
  it('shares a task with a project member and refuses a non-member or a disabled project', async () => {
    const taskId = await taskIn('notStarted', 'collab');
    const userId = `AGENT_TEST_${fix.runId}_collab`;
    const user = await fix.call('POST', '/api/v1/User', { userName: userId, firstName: 'Collab', lastName: fix.runId, type: 'regular', assignedRoleIds: ['noAccess'] });
    const newUserId = String(user.body['id']);
    expect(user.status, reasonOf(user)).toBe(201);

    try {
      const outside = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/collaboratorAdd`, { userId: newUserId });
      expect(outside.status, JSON.stringify(outside.body)).toBe(422);
      expect(reasonOf(outside)).toContain('member of the project');

      await fix.createMember(projectId, newUserId);
      const added = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/collaboratorAdd`, { userId: newUserId });
      expect(added.status, reasonOf(added)).toBe(200);
      const list = await fix.call('GET', `/api/v1/ProjectTask/${taskId}/action/collaborators`);
      const rows = (list.body as { list?: Record<string, unknown> } | Record<string, unknown>[]) ?? [];
      const ids = (Array.isArray(rows) ? rows : (rows['list'] ?? []) as Record<string, unknown>[]).map((row) => row['userId']);
      expect(ids).toContain(newUserId);

      const removed = await fix.call('POST', `/api/v1/ProjectTask/${taskId}/action/collaboratorRemove`, { userId: newUserId });
      expect(removed.status).toBe(200);

      const strict = await fix.createProject();
      const strictGroup = await fix.createGroup(strict);
      const strictTask = await fix.createTask(strict, strictGroup, { stageId: await fix.stageId('notStarted') });
      const disabled = await fix.call('POST', `/api/v1/ProjectTask/${strictTask}/action/collaboratorAdd`, { userId: 'adminUserId' });
      expect(disabled.status, JSON.stringify(disabled.body)).toBe(422);
      expect(reasonOf(disabled)).toContain('disabled');
    } finally {
      await ctx.database.db.deleteFrom('users').where('id', '=', newUserId).execute().catch(() => undefined);
    }
  });
});
