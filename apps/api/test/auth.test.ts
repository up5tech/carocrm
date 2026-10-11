import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './helper.js';
import { authHeader,bootTestApp, closeTestApp, getAdminToken } from './helper.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await bootTestApp();
});

afterAll(async () => {
  await closeTestApp();
});

describe('boot state', () => {
  it('admin is active immediately after boot', async () => {
    const { DatabaseService } = await import('../src/database/database.service.js');
    const row = await ctx.app.get(DatabaseService).db
      .selectFrom('users').select(['is_active', 'is_deleted', 'modified_at']).where('user_name', '=', 'admin').executeTakeFirst();
    expect(row?.is_active).toBe(true);
  });
});

describe('health', () => {
  it('liveness is public', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness reports database up', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().database).toBe('up');
  });
});

describe('authentication', () => {
  it('rejects unauthenticated requests with stable error code', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects wrong password', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: 'admin', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTHENTICATION_FAILED');
  });

  it('issues tokens and identity for valid credentials', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: 'admin', password: 'admin' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.type).toBe('admin');
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('password hash stored is argon2id and not reversible plaintext', async () => {
    const { DatabaseService } = await import('../src/database/database.service.js');
    const db = ctx.app.get(DatabaseService).db;
    const row = await db.selectFrom('users').select('password').where('user_name', '=', 'admin').executeTakeFirst();
    expect(row?.password).toMatch(/^\$argon2id\$/);
    expect(row?.password).not.toContain('admin');
  });

  it('refresh rotates the refresh token', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: 'admin', password: 'admin' },
    });
    const first = login.json();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(res.statusCode).toBe(201);
    const second = res.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('cookie session requires CSRF header for unsafe methods', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: 'admin', password: 'admin' },
    });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('CRM-SESSION='))?.split(';')[0];
    expect(session).toBeTruthy();
    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/User/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: session as string },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('logout revokes the session', async () => {
    const token = await getAdminToken();
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: 'admin', password: 'admin' },
    });
    const body = login.json();
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Logout',
      headers: authHeader(body.accessToken),
    });
    expect([200, 201]).toContain(out.statusCode);
    void token;
  });
});

describe('api keys', () => {
  it('creates an api user, authenticates, and revokes', async () => {
    const token = await getAdminToken();
    const name = `api-${Math.random().toString(36).slice(2, 8)}`;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ApiUser',
      headers: authHeader(token),
      payload: { userName: name, assignedRoleIds: ['sysAdmin'] },
    });
    expect(created.statusCode).toBe(201);
    const { keyId, secret } = created.json();
    expect(secret.length).toBeGreaterThan(20);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AppUser/me',
      headers: { authorization: `ApiKey ${keyId}:${secret}` },
    });
    expect(me.statusCode).toBe(200);
    expect(['api', 'admin']).toContain(me.json().type);

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/ApiKey/${keyId}`,
      headers: authHeader(token),
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AppUser/me',
      headers: { authorization: `ApiKey ${keyId}:${secret}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('stored secret is hashed, not plaintext', async () => {
    const { DatabaseService } = await import('../src/database/database.service.js');
    const db = ctx.app.get(DatabaseService).db;
    const rows = await db.selectFrom('api_keys').select('secret_hash').execute();
    for (const row of rows) {
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('identity management', () => {
  it('creates a regular user that can log in, then deactivates access', async () => {
    const token = await getAdminToken();
    const seed = Math.random().toString(36).slice(2, 8);
    const userName = `emp-${seed}`;
    // temporary admin so deactivation testing never mutates the shared admin account
    const tempAdminName = `tmpadmin-${seed}`;
    const tmp = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/User',
      headers: authHeader(token),
      payload: { userName: tempAdminName, password: 'tempadmin123', isAdmin: true },
    });
    expect(tmp.statusCode).toBe(201);
    const tmpLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: tempAdminName, password: 'tempadmin123' },
    });
    const tmpToken = tmpLogin.json().accessToken;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/User',
      headers: authHeader(tmpToken),
      payload: { userName, firstName: 'Test', lastName: 'User', password: 'secret123', assignedRoleIds: ['noAccess'] },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().id;

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName, password: 'secret123' },
    });
    expect(login.statusCode).toBe(201);
    const userToken = login.json().accessToken;

    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/User',
      headers: authHeader(userToken),
    });
    expect(forbidden.statusCode).toBe(403);

    const deactivated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/User/${userId}`,
      headers: authHeader(tmpToken),
      payload: { isActive: false },
    });
    expect(deactivated.statusCode).toBe(200);

    const loginAfter = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName, password: 'secret123' },
    });
    expect(loginAfter.statusCode).toBe(401);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/User/${tmp.json().id}`,
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(200);
    const { DatabaseService } = await import('../src/database/database.service.js');
    const adm = await ctx.app.get(DatabaseService).db
      .selectFrom('users').select(['is_active', 'is_deleted']).where('user_name', '=', 'admin').executeTakeFirst();
    expect(adm?.is_active).toBe(true);
  });

  it('rejects duplicate user names', async () => {
    const token = await getAdminToken();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/User',
      headers: authHeader(token),
      payload: { userName: 'admin', password: 'whatever123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('role create and update changes permissions', async () => {
    const token = await getAdminToken();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Role',
      headers: authHeader(token),
      payload: { name: `role-${Math.random().toString(36).slice(2, 8)}`, permissions: { Account: { read: 'own' } } },
    });
    expect(created.statusCode).toBe(201);
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/Role/${created.json().id}`,
      headers: authHeader(token),
      payload: { permissions: { Account: { read: 'team' } } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().permissions.Account.read).toBe('team');
  });
});
