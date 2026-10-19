import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20.7 — the identity API the administration tabs are built on
 * (PLAN_Phase_20_Settings_UX.md §4.7, §10.1). Runs against the configured database; every account,
 * role and team it creates carries this run's marker and is removed again.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const runId = Date.now().toString(36);

let ctx: ApiContext;
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTeams: string[] = [];
const createdApiUsers: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
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

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body['error'] ?? {}) as Record<string, unknown>;
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  return (errorOf(body)['details'] ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  ctx = await bootApi();
});

afterAll(async () => {
  const db = ctx.database.db;
  if (createdUsers.length > 0) {
    await db.deleteFrom('users_teams').where('user_id', 'in', createdUsers).execute();
    await db.deleteFrom('user_sessions').where('user_id', 'in', createdUsers).execute();
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  if (createdTeams.length > 0) {
    await db.deleteFrom('users_teams').where('team_id', 'in', createdTeams).execute();
    await db.deleteFrom('teams_roles').where('team_id', 'in', createdTeams).execute();
    await db.deleteFrom('teams').where('id', 'in', createdTeams).execute();
  }
  if (createdRoles.length > 0) await db.deleteFrom('roles').where('id', 'in', createdRoles).execute();
  if (createdApiUsers.length > 0) {
    await db.deleteFrom('api_keys').where('api_user_id', 'in', createdApiUsers).execute();
    await db.deleteFrom('api_users').where('id', 'in', createdApiUsers).execute();
  }
  await shutdownApi();
});

describe('user list filters', () => {
  it('narrows by account state, role and team on the server', async () => {
    const role = await call('POST', '/api/v1/Role', ctx.adminToken, { name: `AGENT_TEST p207 role ${runId}`, permissions: { Account: { read: 'all' } } });
    expect(role.status).toBe(201);
    const roleId = role.body['id'] as string;
    createdRoles.push(roleId);

    const team = await call('POST', '/api/v1/Team', ctx.adminToken, { name: `AGENT_TEST p207 team ${runId}`, roleIds: [roleId] });
    expect(team.status).toBe(201);
    const teamId = team.body['id'] as string;
    createdTeams.push(teamId);

    const member = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST p207 member ${runId}`,
      password: 'p207-secret',
      assignedRoleIds: [roleId],
      teamIds: [teamId],
    });
    expect(member.status).toBe(201);
    const memberId = member.body['id'] as string;
    createdUsers.push(memberId);
    expect((member.body['teams'] as string[]) ?? []).toContain(teamId);

    const byRole = await call('GET', `/api/v1/User?roleId=${encodeURIComponent(roleId)}`, ctx.adminToken);
    expect((byRole.body['list'] as { id: string }[]).map((row) => row.id)).toContain(memberId);
    const byTeam = await call('GET', `/api/v1/User?teamId=${encodeURIComponent(teamId)}`, ctx.adminToken);
    expect((byTeam.body['list'] as { id: string }[]).map((row) => row.id)).toEqual([memberId]);
    const inactive = await call('GET', '/api/v1/User?isActive=false', ctx.adminToken);
    const inactiveIds = (inactive.body['list'] as { id: string; isActive: boolean }[]).map((row) => row.id);
    expect((inactive.body['list'] as { isActive: boolean }[]).every((row) => row.isActive === false)).toBe(true);
    expect(inactiveIds).not.toContain(memberId);
    const admins = await call('GET', '/api/v1/User?type=admin&maxSize=100', ctx.adminToken);
    expect((admins.body['list'] as { type: string }[]).every((row) => row.type === 'admin')).toBe(true);
    expect(admins.body['total']).toBeTypeOf('number');
  });

  it('refuses a filter value it cannot interpret', async () => {
    const badType = await call('GET', '/api/v1/User?type=nonsense', ctx.adminToken);
    expect(badType.status).toBe(400);
    expect(errorOf(badType.body)['code']).toBe('INVALID_QUERY');
    const badFlag = await call('GET', '/api/v1/User?isActive=maybe', ctx.adminToken);
    expect(badFlag.status).toBe(400);
  });

  /**
   * The administration forms post the shape a browser sends — an empty email is `null`, and a half-typed
   * one fails the schema. A schema failure must read as a rejected record, not as a server outage.
   */
  it('answers a rejected payload with the field that failed, not a 500', async () => {
    const badEmail = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST_p207b_bademail_${runId}`,
      emailAddress: 'not-an-email',
    });
    expect(badEmail.status).toBe(422);
    expect(errorOf(badEmail.body)['code']).toBe('VALIDATION_FAILED');
    const issues = detailsOf(badEmail.body)['issues'] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain('emailAddress');

    const cleared = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST_p207b_cleared_${runId}`,
      emailAddress: null,
      title: null,
      phone: null,
    });
    expect(cleared.status).toBe(201);
    const id = cleared.body['id'] as string;
    createdUsers.push(id);
    expect(cleared.body['emailAddress']).toBeNull();

    const badRole = await call('POST', '/api/v1/Role', ctx.adminToken, { name: '', permissions: 'nope' });
    expect(badRole.status).toBe(422);

    const missingTeam = await call('PATCH', '/api/v1/Team/AGENT_TEST-no-such-team', ctx.adminToken, { name: 'whatever' });
    expect(missingTeam.status).toBe(404);
  });

  it('refuses a non-administrator', async () => {
    const regular = (await createTestUser(ctx, { userName: `AGENT_TEST p207 plain ${runId}` })).token;
    const denied = await call('GET', '/api/v1/User', regular);
    expect(denied.status).toBe(403);
  });
});

describe('team membership and team roles', () => {
  it('keeps users_teams and the team member list in step when the user side edits them', async () => {
    const team = await call('POST', '/api/v1/Team', ctx.adminToken, { name: `AGENT_TEST p207 move ${runId}` });
    const teamId = team.body['id'] as string;
    createdTeams.push(teamId);
    const user = await createTestUser(ctx, { userName: `AGENT_TEST p207 mover ${runId}` });
    createdUsers.push(user.id);

    const assigned = await call('PATCH', `/api/v1/User/${user.id}`, ctx.adminToken, { teamIds: [teamId] });
    expect(assigned.status).toBe(200);
    expect((assigned.body['teams'] as string[])).toContain(teamId);
    expect((await ctx.database.db.selectFrom('teams').select('user_id').where('id', '=', teamId).executeTakeFirstOrThrow()).user_id).toEqual([user.id]);

    const left = await call('PATCH', `/api/v1/User/${user.id}`, ctx.adminToken, { teamIds: [] });
    expect((left.body['teams'] as string[])).toEqual([]);
    expect((await ctx.database.db.selectFrom('users_teams').selectAll().where('user_id', '=', user.id).execute()).length).toBe(0);
    expect((await ctx.database.db.selectFrom('teams').select('user_id').where('id', '=', teamId).executeTakeFirstOrThrow()).user_id).toEqual([]);
  });

  it('rejects an unknown team assignment instead of storing it', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST p207 bogus ${runId}` });
    createdUsers.push(user.id);
    const res = await call('PATCH', `/api/v1/User/${user.id}`, ctx.adminToken, { teamIds: ['AGENT_TEST-no-such-team'] });
    expect(res.status).toBe(422);
  });

  it('grants a team role to its members, which is what the ACL reads', async () => {
    const role = await call('POST', '/api/v1/Role', ctx.adminToken, { name: `AGENT_TEST p207 teamrole ${runId}`, permissions: { Account: { read: 'all' } } });
    const roleId = role.body['id'] as string;
    createdRoles.push(roleId);
    const team = await call('POST', '/api/v1/Team', ctx.adminToken, { name: `AGENT_TEST p207 teamgrant ${runId}` });
    const teamId = team.body['id'] as string;
    createdTeams.push(teamId);
    const member = await createTestUser(ctx, { userName: `AGENT_TEST p207 grantee ${runId}` });
    createdUsers.push(member.id);

    // Without the team role the account may read nothing, so the list is refused.
    expect((await call('GET', '/api/v1/Account', member.token)).status).toBe(403);

    const updated = await call('PATCH', `/api/v1/Team/${teamId}`, ctx.adminToken, { roleIds: [roleId], userIds: [member.id] });
    expect(updated.status).toBe(200);
    const links = await ctx.database.db.selectFrom('teams_roles').selectAll().where('team_id', '=', teamId).execute();
    expect(links.map((row) => row.role_id)).toContain(roleId);

    // The member's own authority now resolves through the team, with nothing stored on the account.
    const allowed = await call('GET', '/api/v1/Account', member.token);
    expect(allowed.status).toBe(200);
  });
});

describe('role and team removal', () => {
  it('refuses to delete a role that is still assigned, then allows it once it is not', async () => {
    const role = await call('POST', '/api/v1/Role', ctx.adminToken, { name: `AGENT_TEST p207 removable ${runId}` });
    const roleId = role.body['id'] as string;
    const user = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST p207 holder ${runId}`,
      password: 'p207-secret',
      assignedRoleIds: [roleId],
    });
    createdUsers.push(user.body['id'] as string);

    const refused = await call('DELETE', `/api/v1/Role/${roleId}`, ctx.adminToken);
    expect(refused.status).toBe(422);
    expect(detailsOf(refused.body)['rule']).toBe('roleInUse');
    expect(detailsOf(refused.body)['users']).toBe(1);

    await call('PATCH', `/api/v1/User/${user.body['id'] as string}`, ctx.adminToken, { assignedRoleIds: [] });
    const removed = await call('DELETE', `/api/v1/Role/${roleId}`, ctx.adminToken);
    expect(removed.status).toBe(200);
    const row = await ctx.database.db.selectFrom('roles').select('is_deleted').where('id', '=', roleId).executeTakeFirst();
    expect(row?.is_deleted).toBe(true);
  });

  it('soft-deletes a team and drops its membership', async () => {
    const team = await call('POST', '/api/v1/Team', ctx.adminToken, { name: `AGENT_TEST p207 droppable ${runId}` });
    const teamId = team.body['id'] as string;
    const user = await createTestUser(ctx, { userName: `AGENT_TEST p207 dropmember ${runId}` });
    createdUsers.push(user.id);
    await call('PATCH', `/api/v1/Team/${teamId}`, ctx.adminToken, { userIds: [user.id] });

    const removed = await call('DELETE', `/api/v1/Team/${teamId}`, ctx.adminToken);
    expect(removed.status).toBe(200);
    expect((await ctx.database.db.selectFrom('teams').select('is_deleted').where('id', '=', teamId).executeTakeFirstOrThrow()).is_deleted).toBe(true);
    expect((await ctx.database.db.selectFrom('users_teams').selectAll().where('team_id', '=', teamId).execute()).length).toBe(0);
    expect((await call('GET', '/api/v1/Team', ctx.adminToken)).body['list']).toBeDefined();
  });
});

/**
 * The refusal itself is asserted against the rule function rather than over HTTP: triggering it
 * through the API would mean deactivating the instance's only real administrator, which is exactly
 * the state this database must never be left in. The HTTP wiring is covered by the allowed path
 * below, which goes through the same guard.
 */
describe('last administrator protection', () => {
  it('lets a second administrator be deactivated while the first remains', async () => {
    const second = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST p207 admin2 ${runId}`,
      password: 'p207-secret',
      isAdmin: true,
    });
    expect(second.status).toBe(201);
    const id = second.body['id'] as string;
    createdUsers.push(id);
    expect(second.body['type']).toBe('admin');

    const deactivated = await call('PATCH', `/api/v1/User/${id}`, ctx.adminToken, { isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body['isActive']).toBe(false);
  });

  it('computes the rule from the state after the change, not the fields being sent', async () => {
    const { leavesNoAdministrator } = await import('../src/auth/identity.service.js');
    const rows = [
      { id: 'a', is_admin: true, type: 'admin', assigned_role_ids: [], is_active: true },
      { id: 'b', is_admin: false, type: 'regular', assigned_role_ids: [], is_active: true },
    ];
    expect(leavesNoAdministrator(rows, 'a', { isAdmin: false, type: 'regular', roleIds: [], isActive: true })).toBe(true);
    expect(leavesNoAdministrator(rows, 'a', { isAdmin: false, type: 'regular', roleIds: [], isActive: false })).toBe(true);
    expect(leavesNoAdministrator(rows, 'a', { isAdmin: false, type: 'regular', roleIds: ['sysAdmin'], isActive: true })).toBe(false);
    expect(leavesNoAdministrator(rows, 'b', { isAdmin: false, type: 'regular', roleIds: [], isActive: false })).toBe(false);
  });
});

describe('api accounts and keys', () => {
  it('shows the secret exactly once and never again', async () => {
    const created = await call('POST', '/api/v1/ApiUser', ctx.adminToken, { userName: `AGENT_TEST p207 api ${runId}` });
    expect(created.status).toBe(201);
    const apiUserId = created.body['id'] as string;
    createdApiUsers.push(apiUserId);
    const secret = created.body['secret'] as string;
    expect(typeof secret).toBe('string');
    expect((secret ?? '').length).toBeGreaterThan(20);

    const listed = await call('GET', '/api/v1/ApiUser', ctx.adminToken);
    expect(listed.status).toBe(200);
    const account = (listed.body['list'] as Record<string, unknown>[]).find((row) => row['id'] === apiUserId);
    expect(account).toBeDefined();
    expect(account).not.toHaveProperty('secret');
    expect(account?.['activeKeys']).toBe(1);

    const keys = await call('GET', `/api/v1/ApiKey/${apiUserId}`, ctx.adminToken);
    expect(JSON.stringify(keys.body)).not.toContain(secret);

    const rotated = await call('POST', `/api/v1/ApiUser/${apiUserId}/key`, ctx.adminToken);
    expect(rotated.status).toBe(201);
    expect(typeof rotated.body['secret']).toBe('string');
    const keyId = rotated.body['keyId'] as string;
    expect((await call('GET', '/api/v1/ApiUser', ctx.adminToken)).body['list']).toBeDefined();

    const revoked = await call('DELETE', `/api/v1/ApiKey/${keyId}`, ctx.adminToken);
    expect(revoked.status).toBe(200);
    const after = await call('GET', '/api/v1/ApiUser', ctx.adminToken);
    const afterAccount = (after.body['list'] as Record<string, unknown>[]).find((row) => row['id'] === apiUserId);
    expect(afterAccount?.['activeKeys']).toBe(1);
  });

  it('refuses to issue a key for an account that does not exist', async () => {
    const res = await call('POST', '/api/v1/ApiUser/AGENT_TEST-nope/key', ctx.adminToken);
    expect(res.status).toBe(404);
  });
});

/**
 * The identity tabs of the settings shell (20.7) are descriptors the server resolves, so the tab the
 * SPA draws is the tab the caller may open — and the profile fields the user editor writes back must
 * be in the DTO the editor reads, or saving a name would blank the job title.
 */
describe('administration panel and editor round-trip', () => {
  it('offers the four identity tabs to an administrator and none to a regular user', async () => {
    const admin = await call('GET', '/api/v1/AdminPanel', ctx.adminToken);
    expect(admin.status).toBe(200);
    const groups = admin.body['groups'] as { key: string; tabs: { key: string }[] }[];
    const tabKeys = new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.key)));
    for (const key of ['users', 'teams', 'roles', 'apiKeys']) expect(tabKeys.has(key)).toBe(true);

    const regular = (await createTestUser(ctx, { userName: `AGENT_TEST p207 nopanel ${runId}` })).token;
    const rep = await call('GET', '/api/v1/AdminPanel', regular);
    expect(rep.status).toBe(200);
    expect((rep.body['groups'] as unknown[]).length).toBe(0);
  });

  it('serves title and phone from both the list and the single read', async () => {
    const marker = `AGENT_TEST p207 profile ${runId}`;
    const created = await call('POST', '/api/v1/User', ctx.adminToken, { userName: marker, title: 'Account Manager', phone: '+84 000 0000' });
    expect(created.status).toBe(201);
    const id = created.body['id'] as string;
    createdUsers.push(id);
    expect(created.body['title']).toBe('Account Manager');
    expect(created.body['phone']).toBe('+84 000 0000');

    const listed = await call('GET', `/api/v1/User?where=${encodeURIComponent(marker)}`, ctx.adminToken);
    const row = (listed.body['list'] as Record<string, unknown>[]).find((candidate) => candidate['id'] === id);
    expect(row?.['title']).toBe('Account Manager');
    expect(row?.['phone']).toBe('+84 000 0000');
  });
});

describe('password reset', () => {
  it('sets a new password, revokes the sessions the old one opened, and keeps no secret in the response', async () => {
    const user = await call('POST', '/api/v1/User', ctx.adminToken, {
      userName: `AGENT_TEST p207 reset ${runId}`,
      password: 'p207-before',
    });
    const id = user.body['id'] as string;
    createdUsers.push(id);

    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: `AGENT_TEST p207 reset ${runId}`, password: 'p207-before' } });
    const oldToken = (login.json() as { accessToken: string }).accessToken;
    expect((await call('GET', '/api/v1/AppUser/me', oldToken)).status).toBe(200);

    const reset = await call('POST', `/api/v1/User/${id}/password-reset`, ctx.adminToken, { password: 'p207-after' });
    expect(reset.status).toBe(200);
    expect(JSON.stringify(reset.body)).not.toContain('p207-after');

    expect((await call('GET', '/api/v1/AppUser/me', oldToken)).status).toBe(401);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: `AGENT_TEST p207 reset ${runId}`, password: 'p207-after' } });
    expect(again.statusCode).toBe(201);
  });

  it('refuses a too-short password', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST p207 short ${runId}` });
    createdUsers.push(user.id);
    const res = await call('POST', `/api/v1/User/${user.id}/password-reset`, ctx.adminToken, { password: 'short' });
    expect(res.status).toBe(400);
  });
});
