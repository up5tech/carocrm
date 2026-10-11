import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestTeam, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `a${Date.now().toString(36)}`;

let ctx: ApiContext;
let adminToken = '';

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

const users = {} as Record<'all' | 'own' | 'team' | 'none' | 'field' | 'wildcard' | 'noDelete', TestUser>;
const ids = {} as Record<'own' | 'other' | 'team' | 'field', string>;
const teamId = `team_acl_${runId}`;

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;

  await createTestRole(ctx, {
    id: 'aclAll',
    name: `ACL All ${runId}`,
    permissions: { Account: { read: 'all', create: 'yes', edit: 'all', delete: 'all' } },
  });
  await createTestRole(ctx, {
    id: 'aclOwn',
    name: `ACL Own ${runId}`,
    permissions: { Account: { read: 'own', create: 'yes', edit: 'own', delete: 'own' } },
  });
  await createTestRole(ctx, {
    id: 'aclTeam',
    name: `ACL Team ${runId}`,
    permissions: { Account: { read: 'team', create: 'yes', edit: 'team', delete: 'team' } },
  });
  await createTestRole(ctx, { id: 'aclNone', name: `ACL None ${runId}`, permissions: { Account: { read: 'no', create: 'no', edit: 'no', delete: 'no' } } });
  await createTestRole(ctx, {
    id: 'aclWildcard',
    name: `ACL Wildcard ${runId}`,
    permissions: { '*': { read: 'all', create: 'yes', edit: 'all', delete: 'all' } },
  });
  await createTestRole(ctx, {
    id: 'aclNoDelete',
    name: `ACL NoDelete ${runId}`,
    permissions: { Account: { read: 'all', create: 'yes', edit: 'all', delete: 'no' } },
  });
  await createTestRole(ctx, {
    id: 'aclField',
    name: `ACL Field ${runId}`,
    permissions: { Account: { read: 'all', create: 'yes', edit: 'all', delete: 'all' } },
    fieldPermissions: { Account: { industry: { read: 'no', edit: 'no' } } },
  });

  await createTestTeam(ctx, teamId, `ACL Team ${runId}`);

  users.all = await createTestUser(ctx, { userName: `acl_all_${runId}`, roleIds: ['aclAll'], teamIds: [teamId] });
  users.own = await createTestUser(ctx, { userName: `acl_own_${runId}`, roleIds: ['aclOwn'] });
  users.team = await createTestUser(ctx, { userName: `acl_team_${runId}`, roleIds: ['aclTeam'], teamIds: [teamId] });
  users.none = await createTestUser(ctx, { userName: `acl_none_${runId}`, roleIds: ['aclNone'] });
  users.field = await createTestUser(ctx, { userName: `acl_field_${runId}`, roleIds: ['aclField'] });
  users.wildcard = await createTestUser(ctx, { userName: `acl_wild_${runId}`, roleIds: ['aclWildcard'] });
  users.noDelete = await createTestUser(ctx, { userName: `acl_nodelete_${runId}`, roleIds: ['aclNoDelete'] });

  const own = await call('POST', '/api/v1/Account', users.own.token, { name: `Owned ${runId}`, industry: 'Manufacturing' });
  ids.own = String(own.body['id']);
  expect(own.status).toBe(201);

  const other = await call('POST', '/api/v1/Account', adminToken, { name: `Foreign ${runId}`, assignedUserId: users.all.id });
  ids.other = String(other.body['id']);
  expect(other.status).toBe(201);

  const shared = await call('POST', '/api/v1/Account', adminToken, { name: `Team ${runId}`, teams: [teamId] });
  ids.team = String(shared.body['id']);
  expect(shared.status).toBe(201);

  const fielded = await call('POST', '/api/v1/Account', adminToken, { name: `Secret ${runId}`, industry: 'Banking', type: 'Supplier' });
  ids.field = String(fielded.body['id']);
  expect(fielded.status).toBe(201);
});

afterAll(async () => {
  await shutdownApi();
});

describe('ACL matrix — entity level', () => {
  it('level "no" -> 403 for list, read and write', async () => {
    const list = await call('GET', '/api/v1/Account', users.none.token);
    expect(list.status).toBe(403);
    expect(errorOf(list.body)).toBe('AUTHORIZATION_DENIED');

    const read = await call('GET', `/api/v1/Account/${ids.other}`, users.none.token);
    expect(read.status).toBe(403);

    const write = await call('POST', '/api/v1/Account', users.none.token, { name: `Denied ${runId}` });
    expect(write.status).toBe(403);
  });

  it('role id "sysAdmin" and admin user type bypass ACL', async () => {
    const admin = await call('GET', `/api/v1/Account/${ids.other}`, adminToken);
    expect(admin.status).toBe(200);

    const sysAdmin = await createTestUser(ctx, { userName: `acl_sys_${runId}`, roleIds: ['sysAdmin'] });
    const viaRole = await call('GET', `/api/v1/Account/${ids.other}`, sysAdmin.token);
    expect(viaRole.status).toBe(200);
  });

  it('wildcard "*" permission applies to entities without an explicit entry', async () => {
    const list = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`, users.wildcard.token);
    expect(list.status).toBe(200);
    const listBody = list.body['list'] as Record<string, unknown>[];
    expect(listBody.length).toBeGreaterThanOrEqual(1);

    const task = await call('POST', '/api/v1/Task', users.wildcard.token, { name: `Wildcard task ${runId}` });
    expect(task.status).toBe(201);
  });

  it('level "own": owner sees the record, others are filtered out (404, not 403)', async () => {
    const ownList = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`, users.own.token);
    expect(ownList.status).toBe(200);
    const visible = (ownList.body['list'] as Record<string, unknown>[]).map((item) => item['id']);
    expect(visible).toContain(ids.own);
    expect(visible).not.toContain(ids.other);
    expect(visible).not.toContain(ids.team);

    const every = (ownList.body['list'] as Record<string, unknown>[]).every(
      (item) => item['assignedUserId'] === users.own.id || item['createdById'] === users.own.id,
    );
    expect(every).toBe(true);

    const mine = await call('GET', `/api/v1/Account/${ids.own}`, users.own.token);
    expect(mine.status).toBe(200);

    const foreign = await call('GET', `/api/v1/Account/${ids.other}`, users.own.token);
    expect(foreign.status).toBe(404);

    const editForeign = await call('PATCH', `/api/v1/Account/${ids.other}`, users.own.token, { name: 'hijack' });
    expect(editForeign.status).toBe(404);

    const deleteForeign = await call('DELETE', `/api/v1/Account/${ids.other}`, users.own.token);
    expect(deleteForeign.status).toBe(404);

    const mass = await call('POST', '/api/v1/Account/action/massUpdate', users.own.token, { ids: [ids.other], data: { type: 'Lead' } });
    expect(mass.status).toBe(200);
    expect(mass.body['count']).toBe(0);
  });

  it('level "own" assigns new records to the current user', async () => {
    const created = await call('POST', '/api/v1/Account', users.own.token, { name: `Self assigned ${runId}` });
    expect(created.status).toBe(201);
    expect(created.body['assignedUserId']).toBe(users.own.id);

    const elsewhere = await call('POST', '/api/v1/Account', users.own.token, { name: `Sneaky ${runId}`, assignedUserId: users.all.id });
    expect(elsewhere.status).toBe(422);
  });

  it('level "team": team members see shared records, non-members do not', async () => {
    const list = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`, users.team.token);
    expect(list.status).toBe(200);
    const visible = (list.body['list'] as Record<string, unknown>[]).map((item) => item['id']);
    expect(visible).toContain(ids.team);
    expect(visible).not.toContain(ids.other);
    expect(visible).not.toContain(ids.own);

    const read = await call('GET', `/api/v1/Account/${ids.team}`, users.team.token);
    expect(read.status).toBe(200);

    const edit = await call('PATCH', `/api/v1/Account/${ids.team}`, users.team.token, { type: 'Customer' });
    expect(edit.status).toBe(200);

    const hidden = await call('GET', `/api/v1/Account/${ids.own}`, users.team.token);
    expect(hidden.status).toBe(404);
  });

  it('level "all" sees everything', async () => {
    const list = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`, users.all.token);
    const visible = (list.body['list'] as Record<string, unknown>[]).map((item) => item['id']);
    expect(visible).toContain(ids.own);
    expect(visible).toContain(ids.other);
    expect(visible).toContain(ids.team);
  });

  it('delete "no" blocks deletion while read/edit stay open', async () => {
    const created = await call('POST', '/api/v1/Account', users.noDelete.token, { name: `Keep ${runId}` });
    expect(created.status).toBe(201);
    const removed = await call('DELETE', `/api/v1/Account/${String(created.body['id'])}`, users.noDelete.token);
    expect(removed.status).toBe(403);
    expect(errorOf(removed.body)).toBe('AUTHORIZATION_DENIED');
  });
});

describe('ACL matrix — field level', () => {
  it('read "no" strips the field from GET and list responses', async () => {
    const read = await call('GET', `/api/v1/Account/${ids.field}`, users.field.token);
    expect(read.status).toBe(200);
    expect(read.body['industry']).toBeUndefined();
    expect(read.body['type']).toBe('Supplier');
    expect(Object.keys(read.body)).toContain('name');

    const list = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'id', operator: 'equals', value: ids.field }]))}`, users.field.token);
    const item = (list.body['list'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(item['industry']).toBeUndefined();

    const adminView = await call('GET', `/api/v1/Account/${ids.field}`, adminToken);
    expect(adminView.body['industry']).toBe('Banking');
  });

  it('edit "no" rejects writes touching the field but allows other fields', async () => {
    const blocked = await call('PATCH', `/api/v1/Account/${ids.field}`, users.field.token, { industry: 'Retail' });
    expect(blocked.status).toBe(403);
    expect(errorOf(blocked.body)).toBe('AUTHORIZATION_DENIED');

    const allowed = await call('PATCH', `/api/v1/Account/${ids.field}`, users.field.token, { type: 'Investor' });
    expect(allowed.status).toBe(200);
    expect(allowed.body['type']).toBe('Investor');

    const create = await call('POST', '/api/v1/Account', users.field.token, { name: `Field create ${runId}`, industry: 'Nope' });
    expect(create.status).toBe(403);
  });

  it('a second role without the restriction re-grants the field (max level wins)', async () => {
    await createTestRole(ctx, { id: 'aclFieldOpen', name: `ACL FieldOpen ${runId}`, permissions: {}, fieldPermissions: { Account: { industry: { read: 'all', edit: 'all' } } } });
    const opener = await createTestUser(ctx, { userName: `acl_open_${runId}`, roleIds: ['aclField', 'aclFieldOpen'] });

    const read = await call('GET', `/api/v1/Account/${ids.field}`, opener.token);
    expect(read.status).toBe(200);
    expect(read.body['industry']).toBe('Banking');

    const write = await call('PATCH', `/api/v1/Account/${ids.field}`, opener.token, { industry: 'Banking' });
    expect(write.status).toBe(200);
  });
});
