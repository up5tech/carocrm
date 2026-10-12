import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seed } from '../../../database/seed.js';
import { AuthService } from '../src/auth/auth.service.js';
import { createApp, migrateDb } from '../src/bootstrap.js';
import type { AppConfig } from '../src/config.js';
import { buildConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, createTestRole, createTestUser } from './support/boot-api.js';

/**
 * BPM process engine — authoring, execution and audit trail (PLAN §36).
 *
 * This suite is the phase's acceptance criterion: **a multi-step approval process with user tasks,
 * timers, conditions and auditability, driven end-to-end through the API.** The state machine runs
 * in-process (the API owns advancement), so unlike workflows the whole path — start → park at a
 * human → answer → loop or gateway → completion — is exercised here, while timer/service-task jobs
 * are asserted at the dispatch boundary and covered behaviourally by the worker tests.
 *
 * What matters beyond the happy path:
 *  - a definition the engine could refuse can never be stored or published;
 *  - tasks are only visible/answerable by their assignee or a candidate of their role;
 *  - every move lands in `process_events`, so the trail explains a stopped process;
 *  - an unresolvable assignee fails the instance *visibly* rather than orphaning a task.
 */

const RUN = 'p' + String(Date.now()).toString(36);

let app: NestFastifyApplication;
let database: DatabaseService;
let adminToken: string;
let ctx: ApiContext;
let manager: TestUser; // direct assignee of the main approval, candidate of the role process
let stranger: TestUser; // no tasks, no instances — must see nothing

const createdDefinitions: string[] = [];
const createdInstances: string[] = [];
const createdAccounts: string[] = [];

/** Typed element access that fails loudly when a fixture is shorter than the test assumes. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`expected item at ${index}, list has ${list.length}`);
  return item;
}

function approvalDefinition(): Record<string, unknown> {
  return {
    entityType: 'Account',
    start: 'review',
    nodes: [
      {
        id: 'review',
        type: 'userTask',
        name: 'Manager review',
        assignee: { type: 'user', value: manager.id },
        dueSeconds: 3_600,
        escalateAfterSeconds: 86_400,
        escalateTo: { type: 'user', value: stranger.id },
        outcomes: [
          { value: 'approved', label: 'Approve', next: 'notify' },
          { value: 'changes', label: 'Request changes', next: 'review' },
          { value: 'rejected', label: 'Reject', next: 'stop' },
        ],
      },
      {
        id: 'notify',
        type: 'serviceTask',
        name: 'Notify finance',
        action: 'createNotification',
        params: { userId: manager.id, message: 'Approved: {{name}}' },
        next: 'gate',
      },
      { id: 'gate', type: 'gateway', name: 'High value?', branches: [{ when: "field('amount') > 1000", next: 'audit' }], default: 'done' },
      { id: 'audit', type: 'serviceTask', name: 'Flag for audit', action: 'updateRecord', params: { fields: { stage: 'Audit' } }, next: 'done' },
      { id: 'done', type: 'end', name: 'Approved', outcome: 'approved' },
      { id: 'stop', type: 'end', name: 'Rejected', outcome: 'rejected' },
    ],
  };
}

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token = adminToken, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function createProcess(payload: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const res = await api('POST', '/api/v1/Process', adminToken, payload);
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; key: string };
  createdDefinitions.push(body.id);
  return body;
}

async function createAccount(attrs: Record<string, unknown>): Promise<string> {
  const id = `AGENT_TEST_acc_${RUN}_${String(createdAccounts.length)}`;
  await database.db
    .insertInto('entity_records')
    .values({
      id,
      entity_type: 'Account',
      name: String(attrs['name'] ?? id),
      attrs: JSON.stringify(attrs),
      assigned_user_id: typeof attrs['assignedUserId'] === 'string' ? attrs['assignedUserId'] : null,
      created_by_id: null,
      modified_by_id: null,
      team_ids: JSON.stringify([]),
      created_at: new Date(),
      modified_at: new Date(),
      deleted_at: null,
      version: 1,
    })
    .execute();
  createdAccounts.push(id);
  return id;
}

interface InstanceView {
  id: string;
  status: string;
  currentNode: string | null;
  outcome: string | null;
  error: string | null;
  version: number | null;
  tasks: {
    id: string;
    nodeId: string;
    status: string;
    assigneeId: string | null;
    assigneeRoleId: string | null;
    dueAt: string | null;
    escalatedAt: string | null;
    outcome: string | null;
    outcomes: { value: string; label: string }[];
  }[];
  events: { type: string; message: string; data: unknown }[];
  context?: never;
}

async function start(key: string, accountId: string, token = adminToken): Promise<InstanceView> {
  const res = await api('POST', '/api/v1/ProcessInstance', token, { processKey: key, entityType: 'Account', entityId: accountId });
  expect(res.statusCode).toBe(201);
  const view = res.json() as InstanceView;
  createdInstances.push(view.id);
  return view;
}

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  process.env.JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME ?? 'crm-jobs-test';

  const config: AppConfig = buildConfig();
  await migrateDb(config.databaseUrl);
  await seed(config.databaseUrl, { adminLogin: 'admin', adminPassword: 'admin' });
  app = await createApp(config, { skipMigrations: true });
  database = app.get(DatabaseService);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/Authentication',
    payload: { userName: 'admin', password: 'admin' },
  });
  adminToken = (login.json() as { accessToken: string }).accessToken;
  ctx = { app, config, adminToken, database, auth: app.get(AuthService) };

  const roleId = `role-${RUN}`;
  await createTestRole(ctx, { id: roleId, name: `Role ${RUN}`, permissions: { '*': { read: 'yes' } } });
  manager = await createTestUser(ctx, { userName: `AGENT_TEST_${RUN}_mgr`, roleIds: [roleId] });
  stranger = await createTestUser(ctx, { userName: `AGENT_TEST_${RUN}_str` });
}, 120_000);

afterAll(async () => {
  // Only rows this run created (AGENTS.md §3.3): every id was tracked as it was created.
  for (const id of createdInstances) {
    await database.db.deleteFrom('process_tasks').where('instance_id', '=', id).execute();
    await database.db.deleteFrom('process_events').where('instance_id', '=', id).execute();
    await database.db.deleteFrom('process_instances').where('id', '=', id).execute();
  }
  for (const id of createdDefinitions) {
    await database.db.deleteFrom('process_definition_versions').where('definition_id', '=', id).execute();
    await database.db.deleteFrom('process_definitions').where('id', '=', id).execute();
  }
  for (const id of createdAccounts) {
    await database.db.deleteFrom('entity_records').where('id', '=', id).execute();
  }
  for (const user of [manager, stranger]) {
    if (user === undefined) continue;
    await database.db
      .deleteFrom('notifications')
      .where('user_id', '=', user.id)
      .where('type', '=', 'ProcessTask')
      .execute();
  }
  await app?.close();
}, 60_000);

describe('process definition authoring', () => {
  it('publishes the vocabulary the editor builds from', async () => {
    const res = await api('GET', '/api/v1/Process/action/catalog');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      actions: { name: string }[];
      nodeTypes: { type: string }[];
      assigneeTypes: { type: string }[];
    };
    expect(body.actions.map((action) => action.name)).toEqual([
      'updateRecord',
      'createRecord',
      'createNotification',
      'sendEmail',
      'runJob',
    ]);
    expect(body.nodeTypes.map((node) => node.type)).toEqual(['userTask', 'serviceTask', 'gateway', 'end']);
    expect(body.assigneeTypes.map((entry) => entry.type)).toEqual(['user', 'role', 'recordField']);
  });

  it('creates a multi-step approval process as an unpublished draft', async () => {
    const { id } = await createProcess({ key: `approval-${RUN}`, name: `${RUN} approval`, definition: approvalDefinition() });
    const view = (await api('GET', `/api/v1/Process/${id}`)).json() as {
      isActive: boolean;
      currentVersion: number;
      currentVersionStatus: string;
      publishedVersion: number | null;
      entityType: string;
      issues: unknown[];
    };
    expect(view.currentVersion).toBe(1);
    expect(view.currentVersionStatus).toBe('draft');
    // Nothing runs until it is published *and* enabled.
    expect(view.publishedVersion).toBeNull();
    expect(view.isActive).toBe(false);
    expect(view.entityType).toBe('Account');
    expect(view.issues).toEqual([]);
  });

  it('refuses a loop with nothing to wait for — a token would spin through it', async () => {
    const res = await api('POST', '/api/v1/Process', adminToken, {
      key: `hotloop-${RUN}`,
      name: `${RUN} hot loop`,
      definition: {
        start: 'a',
        nodes: [
          { id: 'a', type: 'serviceTask', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'b' },
          { id: 'b', type: 'gateway', name: 'B', branches: [{ when: 'true', next: 'a' }], default: 'a' },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    const issues = (res.json() as { error: { details: { issues: { code: string }[] } } }).error.details.issues;
    expect(issues.map((issue) => issue.code)).toContain('PROCESS_HOT_LOOP');
  });

  it('refuses a definition the engine could never run', async () => {
    const res = await api('POST', '/api/v1/Process', adminToken, {
      key: `broken-${RUN}`,
      name: `${RUN} broken`,
      definition: {
        start: 'review',
        nodes: [
          { id: 'review', type: 'userTask', name: 'Nope', assignee: { type: 'user', value: 'u1' }, outcomes: [{ value: 'ok', label: 'OK', next: 'end' }] },
          { id: 'end', type: 'end', name: 'Done' },
          { id: 'ghost', type: 'serviceTask', name: 'X', action: 'launchRockets', params: {}, next: 'end' },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    const issues = (res.json() as { error: { details: { issues: { code: string }[] } } }).error.details.issues;
    expect(issues.map((issue) => issue.code)).toContain('PROCESS_UNKNOWN_ACTION');
  });

  it('validates without storing', async () => {
    const ok = await api('POST', '/api/v1/Process/action/validate', adminToken, { definition: approvalDefinition() });
    expect((ok.json() as { valid: boolean }).valid).toBe(true);

    const hot = await api('POST', '/api/v1/Process/action/validate', adminToken, {
      definition: {
        start: 'a',
        nodes: [
          { id: 'a', type: 'serviceTask', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'a' },
        ],
      },
    });
    expect((hot.json() as { valid: boolean; issues: { code: string }[] }).valid).toBe(false);
    expect((hot.json() as { issues: { code: string }[] }).issues.map((issue) => issue.code)).toContain('PROCESS_HOT_LOOP');
  });

  it('refuses a duplicate key and a malformed key', async () => {
    await createProcess({ key: `dup-${RUN}`, name: `${RUN} dup`, definition: approvalDefinition() });
    const duplicate = await api('POST', '/api/v1/Process', adminToken, { key: `dup-${RUN}`, name: 'again', definition: approvalDefinition() });
    expect(duplicate.statusCode).toBe(409);

    const malformed = await api('POST', '/api/v1/Process', adminToken, { key: 'Not A Key', name: 'x', definition: approvalDefinition() });
    expect(malformed.statusCode).toBe(422);
  });

  it('is administrator-only', async () => {
    expect((await api('GET', '/api/v1/Process', manager.token)).statusCode).toBe(403);
    expect((await api('GET', '/api/v1/Process/action/catalog', manager.token)).statusCode).toBe(403);
    expect(
      (await api('POST', '/api/v1/Process', manager.token, { key: `nope-${RUN}`, name: 'nope', definition: approvalDefinition() })).statusCode,
    ).toBe(403);
  });
});

describe('versioning and activation', () => {
  it('refuses to enable before publishing, then publishes and enables', async () => {
    const { id } = await createProcess({ key: `activate-${RUN}`, name: `${RUN} activate`, definition: approvalDefinition() });

    const early = await api('POST', `/api/v1/Process/${id}/action/enable`);
    expect(early.statusCode).toBe(422);
    expect((early.json() as { error: { message: string } }).error.message).toContain('Publish');

    const published = await api('POST', `/api/v1/Process/${id}/action/publish`);
    expect(published.statusCode).toBe(200);
    expect((published.json() as { publishedVersion: number }).publishedVersion).toBe(1);

    const enabled = await api('POST', `/api/v1/Process/${id}/action/enable`);
    expect((enabled.json() as { isActive: boolean }).isActive).toBe(true);
  });

  it('refuses to publish a version twice', async () => {
    const { id } = await createProcess({ key: `twice-${RUN}`, name: `${RUN} twice`, definition: approvalDefinition() });
    await api('POST', `/api/v1/Process/${id}/action/publish`);
    expect((await api('POST', `/api/v1/Process/${id}/action/publish`)).statusCode).toBe(422);
  });

  it('forks a new draft when editing a published process, leaving the live version untouched', async () => {
    const { id } = await createProcess({ key: `fork-${RUN}`, name: `${RUN} fork`, definition: approvalDefinition() });
    await api('POST', `/api/v1/Process/${id}/action/publish`);

    const updated = await api('PUT', `/api/v1/Process/${id}`, adminToken, {
      definition: (() => {
        const definition = approvalDefinition();
        at(definition['nodes'] as Record<string, unknown>[], 1)['name'] = 'Notify finance (v2)';
        return definition;
      })(),
    });
    expect(updated.statusCode).toBe(200);
    const view = updated.json() as {
      currentVersion: number;
      currentVersionStatus: string;
      publishedVersion: number;
      versions: { version: number; status: string; definition: { nodes: { name: string }[] } }[];
    };
    expect(view.currentVersion).toBe(2);
    expect(view.currentVersionStatus).toBe('draft');
    expect(view.publishedVersion).toBe(1);
    const live = view.versions.find((version) => version.version === 1);
    expect(live?.status).toBe('published');
    expect(live?.definition.nodes[1]?.name).toBe('Notify finance'); // version 1 is immutable

    const republished = await api('POST', `/api/v1/Process/${id}/action/publish`);
    const after = republished.json() as { publishedVersion: number; versions: { version: number; status: string }[] };
    expect(after.publishedVersion).toBe(2);
    expect(after.versions.find((version) => version.version === 1)?.status).toBe('archived');
  });

  it('soft deletes a definition and hides it from the list', async () => {
    const { id } = await createProcess({ key: `delete-${RUN}`, name: `${RUN} delete`, definition: approvalDefinition() });
    expect((await api('DELETE', `/api/v1/Process/${id}`)).statusCode).toBe(200);
    expect((await api('GET', `/api/v1/Process/${id}`)).statusCode).toBe(404);
    const list = (await api('GET', '/api/v1/Process')).json() as { list: { id: string }[] };
    expect(list.list.some((entry) => entry.id === id)).toBe(false);
  });
});

describe('process execution — multi-step approval', () => {
  const RUN_KEY = `run-${RUN}`;
  let instanceId: string;
  let firstTaskId: string;
  let accountId: string;

  it('starts on a record and parks at the first user task, armed with timers', async () => {
    const process = await createProcess({ key: RUN_KEY, name: `${RUN} run`, definition: approvalDefinition() });
    expect((await api('POST', `/api/v1/Process/${process.id}/action/publish`)).statusCode).toBe(200);
    expect((await api('POST', `/api/v1/Process/${process.id}/action/enable`)).statusCode).toBe(200);

    accountId = await createAccount({ name: `AGENT_TEST_ account ${RUN}`, amount: 2_000 });
    const view = await start(RUN_KEY, accountId);

    expect(view.status).toBe('waiting');
    expect(view.currentNode).toBe('review');
    expect(view.version).toBe(1);
    expect(view.error).toBeNull();
    expect(view.tasks).toHaveLength(1);
    const task = at(view.tasks, 0);
    firstTaskId = task.id;
    instanceId = view.id;
    expect(task).toMatchObject({ nodeId: 'review', status: 'open', assigneeId: manager.id, assigneeRoleId: null });
    // The due timer is armed at creation; the escalation timer lives in the queue and its moment is
    // stamped onto the row only when it actually fires.
    expect(task.dueAt).not.toBeNull();
    expect(task.escalatedAt).toBeNull();
    expect(new Date(task.dueAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(task.outcomes.map((outcome) => outcome.value)).toEqual(['approved', 'changes', 'rejected']);

    // The audit trail explains how the process got there, in order.
    expect(view.events.map((event) => event.type)).toEqual(['instance.started', 'node.entered', 'task.created']);

    // The assignee is notified the moment the task exists.
    const notes = await database.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', manager.id)
      .where('type', '=', 'ProcessTask')
      .execute();
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the task only to its assignee and to admins', async () => {
    const mine = (await api('GET', '/api/v1/ProcessTask', manager.token)).json() as { list: { id: string }[]; total: number };
    expect(mine.list.some((task) => task.id === firstTaskId)).toBe(true);

    const strangers = (await api('GET', '/api/v1/ProcessTask', stranger.token)).json() as { total: number };
    expect(strangers.total).toBe(0);

    const all = (await api('GET', '/api/v1/ProcessTask?all=true')).json() as { list: { id: string }[] };
    expect(all.list.some((task) => task.id === firstTaskId)).toBe(true);

    expect((await api('GET', `/api/v1/ProcessTask/${firstTaskId}`, stranger.token)).statusCode).toBe(403);
    expect((await api('GET', `/api/v1/ProcessInstance/${instanceId}`, stranger.token)).statusCode).toBe(403);
    // A participant sees the whole trail — an approval history makes no sense half-hidden.
    expect((await api('GET', `/api/v1/ProcessInstance/${instanceId}`, manager.token)).statusCode).toBe(200);
  });

  it('refuses an outcome the task does not offer', async () => {
    const res = await api('POST', `/api/v1/ProcessTask/${firstTaskId}/action/complete`, adminToken, { outcome: 'maybe' });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toContain('not offered');
  });

  it('refuses an answer from someone who does not hold the task', async () => {
    const res = await api('POST', `/api/v1/ProcessTask/${firstTaskId}/action/complete`, stranger.token, { outcome: 'approved' });
    expect(res.statusCode).toBe(403);
  });

  it('loops back for a fresh task when the reviewer requests changes', async () => {
    const res = await api('POST', `/api/v1/ProcessTask/${firstTaskId}/action/complete`, manager.token, {
      outcome: 'changes',
      comment: 'Needs updated numbers',
    });
    expect(res.statusCode).toBe(200);
    const view = res.json() as InstanceView;

    // Still parked at the same node, with a brand-new task; the answer is on the record.
    expect(view.status).toBe('waiting');
    expect(view.currentNode).toBe('review');
    expect(view.tasks).toHaveLength(2);
    const [answered, fresh] = view.tasks;
    expect(answered).toMatchObject({ id: firstTaskId, status: 'completed', outcome: 'changes' });
    expect(fresh).toMatchObject({ status: 'open', nodeId: 'review' });
    const types = view.events.map((event) => event.type);
    expect(types).toContain('task.outcome');
    expect(types.filter((type) => type === 'task.created')).toHaveLength(2);

    // Answering twice is refused: the token already moved on.
    const again = await api('POST', `/api/v1/ProcessTask/${firstTaskId}/action/complete`, manager.token, { outcome: 'approved' });
    expect(again.statusCode).toBe(422);

    firstTaskId = (fresh as { id: string }).id;
  });

  it('completes end to end: service tasks dispatched, gateway chooses the audit branch', async () => {
    const res = await api('POST', `/api/v1/ProcessTask/${firstTaskId}/action/complete`, manager.token, {
      outcome: 'approved',
      comment: 'Go ahead',
    });
    expect(res.statusCode).toBe(200);
    const view = res.json() as InstanceView;

    expect(view.status).toBe('completed');
    expect(view.outcome).toBe('approved');
    expect(view.currentNode).toBeNull();
    expect(view.tasks.every((task) => task.status === 'completed')).toBe(true);

    // The trail reads as a story: decision → moves → dispatches → branch → completion.
    const types = view.events.map((event) => event.type);
    expect(types).toEqual([
      'instance.started',
      'node.entered',
      'task.created',
      'task.outcome', // "changes" — answered in the loop above
      'task.created', // the fresh task the loop created
      'task.outcome', // "approved" — the answer that finishes it
      'node.entered',
      'service.dispatched',
      'node.entered',
      'branch.selected',
      'node.entered',
      'service.dispatched',
      'node.entered',
      'instance.completed',
    ]);
    const dispatched = view.events.filter((event) => event.type === 'service.dispatched').map((event) => (event.data as { action: string }).action);
    expect(dispatched).toEqual(['createNotification', 'updateRecord']); // amount 2000 > 1000 → audit branch
    expect(view.events.at(-1)?.message).toContain('approved');
    expect(view.events.find((event) => event.type === 'branch.selected')?.data).toMatchObject({ chosen: 'audit', matched: "field('amount') > 1000" });
  });

  it('takes the gateway default when no branch condition holds', async () => {
    const lowId = await createAccount({ name: `AGENT_TEST_ small ${RUN}`, amount: 50 });
    const view = await start(RUN_KEY, lowId);
    const task = at(view.tasks, 0);

    const done = (await api('POST', `/api/v1/ProcessTask/${task.id}/action/complete`, manager.token, { outcome: 'approved' })).json() as InstanceView;
    expect(done.status).toBe('completed');
    const dispatched = done.events.filter((event) => event.type === 'service.dispatched');
    // Only the notification: the amount branch did not hold, so no audit write.
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]?.data as { action: string }).action).toBe('createNotification');
    expect((done.events.find((event) => event.type === 'branch.selected')?.data as { matched: string | null }).matched).toBeNull();
  });

  it('assigns by role: any candidate of the role sees and may answer the task', async () => {
    const process = await createProcess({
      key: `roleproc-${RUN}`,
      name: `${RUN} role`,
      definition: {
        entityType: 'Account',
        start: 'review',
        nodes: [
          {
            id: 'review',
            type: 'userTask',
            name: 'Role review',
            assignee: { type: 'role', value: `Role ${RUN}` },
            outcomes: [{ value: 'approved', label: 'Approve', next: 'end' }],
          },
          { id: 'end', type: 'end', name: 'Approved', outcome: 'approved' },
        ],
      },
    });
    await api('POST', `/api/v1/Process/${process.id}/action/publish`);
    await api('POST', `/api/v1/Process/${process.id}/action/enable`);

    const roleId = await database.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', `Role ${RUN}`)
      .executeTakeFirstOrThrow();

    const view = await start(`roleproc-${RUN}`, accountId);
    const task = at(view.tasks, 0);
    // Candidate-group semantics: the task belongs to the role, not to a person.
    expect(task).toMatchObject({ assigneeId: null, assigneeRoleId: roleId.id });

    const visible = (await api('GET', '/api/v1/ProcessTask', manager.token)).json() as { list: { id: string }[] };
    expect(visible.list.some((entry) => entry.id === task.id)).toBe(true);

    const done = await api('POST', `/api/v1/ProcessTask/${task.id}/action/complete`, manager.token, { outcome: 'approved' });
    expect(done.statusCode).toBe(200);
    expect((done.json() as InstanceView).status).toBe('completed');
  });

  it('assigns by record field: whoever the record points at holds the task', async () => {
    const process = await createProcess({
      key: `fieldproc-${RUN}`,
      name: `${RUN} field`,
      definition: {
        entityType: 'Account',
        start: 'review',
        nodes: [
          {
            id: 'review',
            type: 'userTask',
            name: 'Owner review',
            assignee: { type: 'recordField', value: 'assignedUserId' },
            outcomes: [{ value: 'approved', label: 'Approve', next: 'end' }],
          },
          { id: 'end', type: 'end', name: 'Approved', outcome: 'approved' },
        ],
      },
    });
    await api('POST', `/api/v1/Process/${process.id}/action/publish`);
    await api('POST', `/api/v1/Process/${process.id}/action/enable`);

    const ownerId = await createAccount({ name: `AGENT_TEST_ owned ${RUN}`, assignedUserId: stranger.id });
    const view = await start(`fieldproc-${RUN}`, ownerId);
    expect(view.tasks[0]).toMatchObject({ assigneeId: stranger.id, assigneeRoleId: null });
    // The owner — not the admin who started it — answers.
    const done = await api('POST', `/api/v1/ProcessTask/${at(view.tasks, 0).id}/action/complete`, stranger.token, { outcome: 'approved' });
    expect(done.statusCode).toBe(200);
    expect((done.json() as InstanceView).status).toBe('completed');
  });

  it('fails the instance with a visible reason when the assignee cannot be resolved', async () => {
    const process = await createProcess({
      key: `ghost-${RUN}`,
      name: `${RUN} ghost`,
      definition: {
        entityType: 'Account',
        start: 'review',
        nodes: [
          {
            id: 'review',
            type: 'userTask',
            name: 'Ghost review',
            assignee: { type: 'user', value: 'u_does_not_exist' },
            outcomes: [{ value: 'approved', label: 'Approve', next: 'end' }],
          },
          { id: 'end', type: 'end', name: 'Approved', outcome: 'approved' },
        ],
      },
    });
    await api('POST', `/api/v1/Process/${process.id}/action/publish`);
    await api('POST', `/api/v1/Process/${process.id}/action/enable`);

    const view = await start(`ghost-${RUN}`, accountId);
    // Failure is data: the process stopped, no task was orphaned, and the audit says why.
    expect(view.status).toBe('failed');
    expect(view.error).toContain('does not exist or is not active');
    expect(view.tasks).toHaveLength(0);
    expect(view.events.map((event) => event.type)).toContain('instance.failed');
  });

  it('scopes instance lists and refuses to start processes that are not enabled', async () => {
    // The stranger participated in exactly one instance (the record-field task); everything else
    // belongs to other people and must stay invisible.
    const strangers = (await api('GET', '/api/v1/ProcessInstance', stranger.token)).json() as { list: { id: string }[]; total: number };
    expect(strangers.list.some((entry) => entry.id === instanceId)).toBe(false);
    expect(strangers.total).toBeLessThanOrEqual(1);

    const admins = (await api('GET', '/api/v1/ProcessInstance')).json() as { total: number };
    expect(admins.total).toBeGreaterThanOrEqual(4);

    const unknownStatus = await api('GET', '/api/v1/ProcessInstance?status=exploded');
    expect(unknownStatus.statusCode).toBe(422);

    // A published-but-disabled process accepts no new instances.
    const disabled = await createProcess({ key: `off-${RUN}`, name: `${RUN} off`, definition: approvalDefinition() });
    await api('POST', `/api/v1/Process/${disabled.id}/action/publish`);
    const res = await api('POST', '/api/v1/ProcessInstance', adminToken, { processKey: `off-${RUN}`, entityType: 'Account', entityId: accountId });
    expect(res.statusCode).toBe(422);

    // The record must exist and be readable by the starter (404 hides it otherwise).
    const missing = await api('POST', '/api/v1/ProcessInstance', adminToken, { processKey: RUN_KEY, entityType: 'Account', entityId: 'AGENT_TEST_nope' });
    expect(missing.statusCode).toBe(404);

    expect((await api('GET', '/api/v1/ProcessInstance/AGENT_TEST_nope')).statusCode).toBe(404);
  });

  it('cancels a running instance, cancelling its open task with it', async () => {
    const view = await start(RUN_KEY, accountId);
    const taskId = at(view.tasks, 0).id;

    const cancelled = await api('POST', `/api/v1/ProcessInstance/${view.id}/action/cancel`, manager.token);
    expect(cancelled.statusCode).toBe(403); // only the initiator or an admin may cancel

    const done = await api('POST', `/api/v1/ProcessInstance/${view.id}/action/cancel`);
    expect(done.statusCode).toBe(200);
    const body = done.json() as InstanceView;
    expect(body.status).toBe('cancelled');
    expect(body.tasks.every((task) => task.status === 'cancelled')).toBe(true);
    expect(body.events.map((event) => event.type)).toContain('instance.cancelled');

    // The cancelled task can no longer be answered.
    const answer = await api('POST', `/api/v1/ProcessTask/${taskId}/action/complete`, manager.token, { outcome: 'approved' });
    expect(answer.statusCode).toBe(422);

    // Cancelling twice is refused: the process is finished.
    expect((await api('POST', `/api/v1/ProcessInstance/${view.id}/action/cancel`)).statusCode).toBe(422);
  });

  it('keeps the definition of a running instance stable while editing forks a new version', async () => {
    // The instance points at the version it started on; republishing never rewrites its history.
    const view = await start(RUN_KEY, accountId);
    const definitionId = (await database.db
      .selectFrom('process_instances')
      .select('definition_id')
      .where('id', '=', view.id)
      .executeTakeFirstOrThrow()).definition_id;
    const versionId = (await database.db
      .selectFrom('process_instances')
      .select('version_id')
      .where('id', '=', view.id)
      .executeTakeFirstOrThrow()).version_id;

    const definition = (await api('GET', `/api/v1/Process/${definitionId}`)).json() as { publishedVersion: number };
    await api('PUT', `/api/v1/Process/${definitionId}`, adminToken, {
      definition: (() => {
        const next = approvalDefinition();
        at(next['nodes'] as Record<string, unknown>[], 0)['name'] = 'Manager review v2';
        return next;
      })(),
    });
    const republished = await api('POST', `/api/v1/Process/${definitionId}/action/publish`);
    expect((republished.json() as { publishedVersion: number }).publishedVersion).toBe(definition.publishedVersion + 1);

    const instance = (await api('GET', `/api/v1/ProcessInstance/${view.id}`)).json() as InstanceView;
    expect(instance.version).toBe(1); // still version 1
    const stored = await database.db
      .selectFrom('process_definition_versions')
      .select('id')
      .where('id', '=', versionId)
      .executeTakeFirst();
    expect(stored).toBeDefined(); // the version it runs against still exists, unchanged

    await api('POST', `/api/v1/ProcessInstance/${view.id}/action/cancel`);
  });
});
