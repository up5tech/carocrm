import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seed } from '../../../database/seed.js';
import { AuthService } from '../src/auth/auth.service.js';
import { createApp, migrateDb } from '../src/bootstrap.js';
import type { AppConfig } from '../src/config.js';
import { buildConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, createTestRole, createTestUser } from './support/boot-api.js';

/**
 * Workflow engine — authoring, versioning and run history (PLAN §35).
 *
 * The suite drives the administrative API the UI is built on: create, validate, publish, enable,
 * edit (which must fork a new version rather than touch the published one), and read run history.
 *
 * Execution itself belongs to the worker and is covered by its own tests; what matters here is that
 * the API cannot store something the engine would refuse, and that publishing is the only thing
 * that makes a definition runnable.
 */

const RUN = 'wf' + String(Date.now()).toString(36);

let app: NestFastifyApplication;
let database: DatabaseService;
let adminToken: string;
let ctx: ApiContext;
const created: string[] = [];

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: { eventType: 'entity.created', entityType: 'Account' },
    start: 'a1',
    nodes: [
      { id: 'a1', type: 'action', name: 'Set status', action: 'updateRecord', params: { fields: { status: 'Working' } }, next: 'e' },
      { id: 'e', type: 'end', name: 'Done' },
    ],
    ...overrides,
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

async function createWorkflow(payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await api('POST', '/api/v1/Workflow', adminToken, payload);
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string };
  created.push(body.id);
  return body;
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
}, 120_000);

afterAll(async () => {
  // Only rows this run created (AGENTS.md §3.3): every id is in `created`.
  for (const id of created) await database.db.deleteFrom('workflows').where('id', '=', id).execute();
  await app?.close();
}, 60_000);

describe('workflow authoring', () => {
  it('publishes the action catalog the editor builds from', async () => {
    const res = await api('GET', '/api/v1/Workflow/action/catalog');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: string[]; actions: { name: string; label: string }[] };
    expect(body.events).toEqual(['entity.created', 'entity.updated', 'entity.deleted', 'entity.restored']);
    expect(body.actions.map((action) => action.name)).toEqual([
      'updateRecord',
      'createRecord',
      'createNotification',
      'sendEmail',
      'runJob',
    ]);
  });

  it('creates a workflow with its first draft version', async () => {
    const { id } = await createWorkflow({ name: `${RUN} onboarding`, definition: definition() });
    const res = await api('GET', `/api/v1/Workflow/${id}`);
    const view = res.json() as { name: string; currentVersion: number; currentVersionStatus: string; publishedVersion: number | null; isActive: boolean; entityType: string; eventType: string; versions: unknown[]; issues: unknown[] };
    expect(view.name).toBe(`${RUN} onboarding`);
    expect(view.currentVersion).toBe(1);
    expect(view.currentVersionStatus).toBe('draft');
    // Nothing is published and nothing is enabled: a new workflow cannot start running by accident.
    expect(view.publishedVersion).toBeNull();
    expect(view.isActive).toBe(false);
    expect(view.entityType).toBe('Account');
    expect(view.eventType).toBe('entity.created');
    expect(view.issues).toEqual([]);
  });

  it('refuses a definition the engine could not run', async () => {
    const res = await api('POST', '/api/v1/Workflow', adminToken, {
      name: `${RUN} broken`,
      definition: definition({
        nodes: [
          { id: 'a1', type: 'action', name: 'Nope', action: 'dropDatabase', params: {} },
          { id: 'e', type: 'end', name: 'Done' },
        ],
      }),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; details: { issues: { code: string; message: string }[] } } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues[0]?.code).toBe('WORKFLOW_UNKNOWN_ACTION');
  });

  it('refuses a graph that loops or points nowhere', async () => {
    const validation = await api('POST', '/api/v1/Workflow/action/validate', adminToken, {
      definition: definition({
        nodes: [
          { id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'a2' },
          { id: 'a2', type: 'action', name: 'B', action: 'updateRecord', params: { fields: {} }, next: 'a1' },
        ],
      }),
    });
    expect(validation.statusCode).toBe(200);
    expect((validation.json() as { valid: boolean }).valid).toBe(false);

    const dangling = await api('POST', '/api/v1/Workflow', adminToken, {
      name: `${RUN} dangling`,
      definition: definition({ nodes: [{ id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'ghost' }] }),
    });
    expect(dangling.statusCode).toBe(422);
  });

  it('refuses a condition whose formula is not sandboxed-valid', async () => {
    const res = await api('POST', '/api/v1/Workflow', adminToken, {
      name: `${RUN} bad formula`,
      definition: definition({
        start: 'c',
        nodes: [
          { id: 'c', type: 'condition', name: 'Bad', formula: 'dropEverything()', then: 'e' },
          { id: 'e', type: 'end', name: 'Done' },
        ],
      }),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { details: { issues: { code: string }[] } } }).error.details.issues[0]?.code).toBe(
      'WORKFLOW_INVALID_FORMULA',
    );
  });

  it('requires a name', async () => {
    const res = await api('POST', '/api/v1/Workflow', adminToken, { name: '  ', definition: definition() });
    expect(res.statusCode).toBe(422);
  });
});

describe('versioning and activation', () => {
  it('publishes a draft, then makes it the version runs use', async () => {
    const { id } = await createWorkflow({ name: `${RUN} publish`, definition: definition() });

    const published = await api('POST', `/api/v1/Workflow/${id}/action/publish`);
    expect(published.statusCode).toBe(200);
    const view = published.json() as { publishedVersion: number; currentVersionStatus: string; versions: { status: string; publishedAt: string | null }[] };
    expect(view.publishedVersion).toBe(1);
    expect(view.currentVersionStatus).toBe('published');
    expect(view.versions[0]?.publishedAt).not.toBeNull();

    const enabled = await api('POST', `/api/v1/Workflow/${id}/action/enable`);
    expect((enabled.json() as { isActive: boolean }).isActive).toBe(true);
  });

  it('refuses to publish the same version twice', async () => {
    const { id } = await createWorkflow({ name: `${RUN} twice`, definition: definition() });
    await api('POST', `/api/v1/Workflow/${id}/action/publish`);
    const again = await api('POST', `/api/v1/Workflow/${id}/action/publish`);
    expect(again.statusCode).toBe(422);
  });

  it('refuses to enable a workflow that has never been published', async () => {
    const { id } = await createWorkflow({ name: `${RUN} unpublished`, definition: definition() });
    const res = await api('POST', `/api/v1/Workflow/${id}/action/enable`);
    expect(res.statusCode).toBe(422);
    const error = (res.json() as { error: { message: string; details?: Record<string, unknown> } }).error;
    expect(`${String(error.details?.['reason'] ?? '')}${error.message}`).toContain('Publish a version');
  });

  it('editing a published workflow forks a new version instead of mutating the live one', async () => {
    const { id } = await createWorkflow({ name: `${RUN} fork`, definition: definition() });
    await api('POST', `/api/v1/Workflow/${id}/action/publish`);
    await api('POST', `/api/v1/Workflow/${id}/action/enable`);

    const updated = await api('PUT', `/api/v1/Workflow/${id}`, adminToken, {
      definition: definition({
        nodes: [
          { id: 'a1', type: 'action', name: 'Set status', action: 'updateRecord', params: { fields: { status: 'Touched' } }, next: 'e' },
          { id: 'e', type: 'end', name: 'Done' },
        ],
      }),
    });
    expect(updated.statusCode).toBe(200);
    const view = updated.json() as {
      currentVersion: number;
      currentVersionStatus: string;
      publishedVersion: number;
      versions: { version: number; status: string; definition: { nodes: { params: { fields: { status: string } } }[] } }[];
    };
    expect(view.currentVersion).toBe(2);
    expect(view.currentVersionStatus).toBe('draft');
    // Version 1 is still what an in-flight run would use, unchanged.
    expect(view.publishedVersion).toBe(1);
    const published = view.versions.find((version) => version.version === 1);
    expect(published?.status).toBe('published');
    expect(published?.definition.nodes[0]?.params.fields.status).toBe('Working');

    // Publishing the new version archives the old one.
    const republished = await api('POST', `/api/v1/Workflow/${id}/action/publish`);
    const after = republished.json() as { publishedVersion: number; versions: { version: number; status: string }[] };
    expect(after.publishedVersion).toBe(2);
    expect(after.versions.find((version) => version.version === 1)?.status).toBe('archived');
  });

  it('keeps editing the same draft while it is unpublished', async () => {
    const { id } = await createWorkflow({ name: `${RUN} draft`, definition: definition() });
    await api('PUT', `/api/v1/Workflow/${id}`, adminToken, { name: `${RUN} draft renamed` });
    await api('PUT', `/api/v1/Workflow/${id}`, adminToken, { definition: definition({ start: 'e', nodes: [{ id: 'e', type: 'end', name: 'Done' }] }) });
    const view = (await api('GET', `/api/v1/Workflow/${id}`)).json() as { currentVersion: number; versions: unknown[]; name: string };
    expect(view.currentVersion).toBe(1);
    expect(view.versions).toHaveLength(1);
    expect(view.name).toBe(`${RUN} draft renamed`);
  });

  it('reports a validation issue on a stored definition without hiding it', async () => {
    // Written straight to the database: the API is not the only writer, and the UI must show why
    // such a definition can never run.
    const id = `${RUN}handedited`;
    const versionId = `${id}-v1`;
    await database.db
      .insertInto('workflows')
      .values({
        id,
        name: `${RUN} hand edited`,
        entity_type: 'Account',
        event_type: 'entity.created',
        is_active: false,
        current_version_id: versionId,
        published_version_id: null,
        is_deleted: false,
        created_by_id: null,
        modified_by_id: null,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    created.push(id);
    await database.db
      .insertInto('workflow_versions')
      .values({
        id: versionId,
        workflow_id: id,
        version: 1,
        definition: JSON.stringify(definition({ nodes: [{ id: 'a1', type: 'action', name: 'X', action: 'gone', params: {} }] })),
        status: 'draft',
        created_by_id: null,
        created_at: new Date(),
        published_at: null,
      })
      .execute();

    const view = (await api('GET', `/api/v1/Workflow/${id}`)).json() as { issues: { code: string }[] };
    expect(view.issues[0]?.code).toBe('WORKFLOW_UNKNOWN_ACTION');
    expect((await api('POST', `/api/v1/Workflow/${id}/action/publish`)).statusCode).toBe(422);
  });

  it('refuses a version that no longer exists rather than running an empty graph', async () => {
    const id = `${RUN}missingversion`;
    await database.db
      .insertInto('workflows')
      .values({
        id,
        name: `${RUN} missing version`,
        entity_type: 'Account',
        event_type: 'entity.created',
        is_active: false,
        current_version_id: null,
        published_version_id: null,
        is_deleted: false,
        created_by_id: null,
        modified_by_id: null,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    created.push(id);
    const res = await api('PUT', `/api/v1/Workflow/${id}`, adminToken, { definition: definition() });
    expect(res.statusCode).toBe(422);
  });

  it('soft deletes a workflow and hides it from the list', async () => {
    const { id } = await createWorkflow({ name: `${RUN} delete`, definition: definition() });
    expect((await api('DELETE', `/api/v1/Workflow/${id}`)).statusCode).toBe(200);
    expect((await api('GET', `/api/v1/Workflow/${id}`)).statusCode).toBe(404);
    const list = (await api('GET', '/api/v1/Workflow')).json() as { list: { id: string }[] };
    expect(list.list.some((workflow) => workflow.id === id)).toBe(false);
  });
});

describe('workflow access control and run history', () => {
  it('is administrator-only', async () => {
    const roleId = `role-${RUN}`;
    await createTestRole(ctx, { id: roleId, name: `Role ${RUN}`, permissions: { '*': { read: 'yes' } } });
    const user = await createTestUser(ctx, { userName: `AGENT_TEST_${RUN}`, password: 'secret-password', roleIds: [roleId] });

    expect((await api('GET', '/api/v1/Workflow', user.token)).statusCode).toBe(403);
    expect((await api('POST', '/api/v1/Workflow', user.token, { name: 'nope', definition: definition() })).statusCode).toBe(403);
    expect((await api('GET', '/api/v1/WorkflowRun', user.token)).statusCode).toBe(403);
  });

  it('returns an empty run history rather than inventing runs', async () => {
    const res = await api('GET', '/api/v1/WorkflowRun');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { list: { id: string }[]; total: number };
    expect(Array.isArray(body.list)).toBe(true);
    expect(body.total).toBe(body.list.length);
  });

  it('rejects an unknown status filter instead of ignoring it', async () => {
    const res = await api('GET', '/api/v1/WorkflowRun?status=exploded');
    expect(res.statusCode).toBe(422);
  });

  it('reads a run with its steps, as the worker wrote them', async () => {
    // A run written directly stands in for one the worker produced; the read path is what the UI
    // depends on, and it must survive a run whose steps failed mid-graph.
    const workflow = await createWorkflow({ name: `${RUN} history`, definition: definition() });
    await database.db
      .insertInto('workflow_runs')
      .values({
        id: `${RUN}run1`,
        workflow_id: workflow.id,
        version_id: 'v-does-not-matter',
        entity_type: 'Account',
        entity_id: 'a-fixture',
        status: 'failed',
        current_node: null,
        user_id: null,
        error: 'a1: updateRecord failed: record gone',
        context: {},
        attempt: 2,
        started_at: new Date(),
        finished_at: new Date(),
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    await database.db
      .insertInto('workflow_run_steps')
      .values([
        {
          id: `${RUN}step1`,
          run_id: `${RUN}run1`,
          node_id: 'a1',
          node_type: 'action',
          name: 'Set status',
          status: 'failed',
          attempt: 2,
          output: null,
          error: 'record gone',
          started_at: new Date(),
          finished_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ])
      .execute();

    const listed = await api('GET', `/api/v1/Workflow/${workflow.id}/runs`);
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { total: number; list: { id: string; status: string; attempt: number; steps: { nodeId: string; status: string; error: string }[] }[] };
    expect(body.total).toBe(1);
    expect(body.list[0]?.status).toBe('failed');
    expect(body.list[0]?.attempt).toBe(2);
    expect(body.list[0]?.steps[0]).toMatchObject({ nodeId: 'a1', status: 'failed', error: 'record gone' });

    const single = await api('GET', `/api/v1/WorkflowRun/${RUN}run1`);
    expect(single.statusCode).toBe(200);
    expect((single.json() as { workflowName: string }).workflowName).toBe(`${RUN} history`);

    const filtered = await api('GET', '/api/v1/WorkflowRun?status=failed');
    expect((filtered.json() as { total: number }).total).toBeGreaterThanOrEqual(1);

    await database.db.deleteFrom('workflow_runs').where('id', '=', `${RUN}run1`).execute();
  });

  it('404s for a run that does not exist', async () => {
    expect((await api('GET', `/api/v1/WorkflowRun/${RUN}nope`)).statusCode).toBe(404);
  });
});