import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { totpAt } from '../src/auth/totp.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

const runId = Date.now().toString(36);
const USER_A = `AGENT_TEST-p232a-${runId}`;
const USER_B = `AGENT_TEST-p232b-${runId}`;
const ADMIN_NAME = `AGENT_TEST-p232adm-${runId}`;
const ADMIN_PASSWORD = 'agent-admin-password';

let ctx: ApiContext;
let userAId = '';
let userAToken = '';
let userBId = '';
let userBToken = '';
const createdApiUserIds: string[] = [];
let adminUserId = '';

beforeAll(async () => {
  ctx = await bootApi();
  const a = await createTestUser(ctx, { userName: USER_A, password: 'agent-user-password' });
  userAId = a.id;
  userAToken = a.token;
  const b = await createTestUser(ctx, { userName: USER_B, password: 'agent-user-password' });
  userBId = b.id;
  userBToken = b.token;
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const apiUserId of createdApiUserIds) {
    await db.deleteFrom('api_keys').where('api_user_id', '=', apiUserId).execute();
    await db.deleteFrom('api_users').where('id', '=', apiUserId).execute();
  }
  await db.deleteFrom('user_sessions').where('user_id', 'in', [userAId, userBId, adminUserId].filter((id) => id !== '')).execute();
  await db.deleteFrom('user_recovery_codes').where('user_id', 'in', [userAId, userBId, adminUserId].filter((id) => id !== '')).execute();
  await db.deleteFrom('auth_challenges').where('user_id', 'in', [userAId, userBId, adminUserId].filter((id) => id !== '')).execute();
  await db.deleteFrom('users').where('id', 'in', [userAId, userBId, adminUserId].filter((id) => id !== '')).execute();
  await shutdownApi();
});

describe('phase 23.2 — session management', () => {
  it('lists only the caller\'s own sessions and marks the current one', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me/sessions', headers: authHeader(userAToken) });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { list: { id: string; current: boolean; ip: string | null }[] }).list;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.filter((row) => row.current)).toHaveLength(1);
    // Every listed session belongs to user A — user B's sessions never appear.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(userBToken) });
    const otherList = (await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me/sessions', headers: authHeader(userBToken) })).json() as {
      list: { id: string }[];
    };
    expect(me.statusCode).toBe(200);
    expect(otherList.list.every((row) => !list.some((mine) => mine.id === row.id))).toBe(true);
  });

  it('revokes one of the caller\'s sessions; its access and refresh tokens die immediately', async () => {
    // A second sign-in for the same account opens a second session.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_A, password: 'agent-user-password' },
    });
    expect(second.statusCode).toBe(201);
    const secondTokens = second.json() as { accessToken: string; refreshToken: string };

    const listRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me/sessions', headers: authHeader(userAToken) });
    const sessions = (listRes.json() as { list: { id: string; current: boolean }[] }).list;
    const other = sessions.find((row) => !row.current);
    expect(other).toBeDefined();

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/AppUser/me/sessions/${other?.id}`,
      headers: authHeader(userAToken),
    });
    expect(revoked.statusCode).toBe(200);

    const deadAccess = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(secondTokens.accessToken) });
    expect(deadAccess.statusCode).toBe(401);
    const deadRefresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Refresh',
      payload: { refreshToken: secondTokens.refreshToken },
    });
    expect(deadRefresh.statusCode).toBe(401);
  });

  it('answers 404 when revoking a session that is not the caller\'s', async () => {
    const listA = (await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me/sessions', headers: authHeader(userAToken) })).json() as {
      list: { id: string }[];
    };
    const victim = listA.list[0];
    expect(victim).toBeDefined();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/AppUser/me/sessions/${victim?.id}`,
      headers: authHeader(userBToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('phase 23.2 — refresh rotation and replay', () => {
  it('revokes the whole refresh family when a rotated token is replayed', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_B, password: 'agent-user-password' },
    });
    expect(login.statusCode).toBe(201);
    const first = login.json() as { refreshToken: string };

    const rotated = await ctx.app.inject({ method: 'POST', url: '/api/v1/Refresh', payload: { refreshToken: first.refreshToken } });
    expect(rotated.statusCode).toBe(201);
    const second = rotated.json() as { refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Replaying the rotated-away token is theft evidence: the family dies, including the live one.
    const replay = await ctx.app.inject({ method: 'POST', url: '/api/v1/Refresh', payload: { refreshToken: first.refreshToken } });
    expect(replay.statusCode).toBe(401);
    const orphaned = await ctx.app.inject({ method: 'POST', url: '/api/v1/Refresh', payload: { refreshToken: second.refreshToken } });
    expect(orphaned.statusCode).toBe(401);
  });
});

describe('phase 23.2 — MFA policy enforcement', () => {
  /** Writes the `security` document's mfa.required value, preserving the rest of the row. */
  async function setMfaRequired(required: 'off' | 'admins' | 'all'): Promise<() => Promise<void>> {
    const db = ctx.database.db;
    const row = await db.selectFrom('app_settings').select('data').where('name', '=', 'security').executeTakeFirst();
    let envelope: Record<string, unknown> = {};
    if (typeof row?.data === 'string') {
      try {
        const parsed = JSON.parse(row.data) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
      } catch {
        envelope = {};
      }
    }
    const previous = row?.data ?? null;
    const value = typeof envelope['value'] === 'object' && envelope['value'] !== null ? (envelope['value'] as Record<string, unknown>) : {};
    const next = JSON.stringify({ ...envelope, value: { ...value, mfa: { required } } });
    await db
      .insertInto('app_settings')
      .values({ name: 'security', data: next, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: next, modified_at: new Date() }))
      .execute();
    return async () => {
      if (previous === null) {
        await db.deleteFrom('app_settings').where('name', '=', 'security').execute();
      } else {
        await db.updateTable('app_settings').set({ data: previous, modified_at: new Date() }).where('name', '=', 'security').execute();
      }
    };
  }

  it('restricts a covered account\'s session to enrollment until TOTP is confirmed', async () => {
    // A dedicated administrator: the 'admins' policy covers it, regular users stay untouched.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/User',
      headers: authHeader(ctx.adminToken),
      payload: { userName: ADMIN_NAME, password: ADMIN_PASSWORD, isAdmin: true },
    });
    expect(created.statusCode).toBe(201);
    adminUserId = String((created.json() as { id: string }).id);

    // Signed in while the policy is still off — the live re-check, not just the login-time flag,
    // is what confines this session once the policy tightens.
    const token = await loginAs(ctx, ADMIN_NAME, ADMIN_PASSWORD);
    const restore = await setMfaRequired('admins');
    try {
      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().mfaPending).toBe(true);

      // Everything outside the enrollment surface is refused.
      const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/User', headers: authHeader(token) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('AUTHORIZATION_DENIED');

      // Enrollment is the one permitted path, and it is bound to this session.
      const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/AppUser/me/totp/setup', headers: authHeader(token), payload: {} });
      expect(setup.statusCode).toBe(200);
      const { secret } = setup.json() as { secret: string };
      const enable = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/AppUser/me/totp/enable',
        headers: authHeader(token),
        payload: { code: totpAt(secret, Date.now()) },
      });
      expect(enable.statusCode).toBe(200);

      const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(token) });
      expect(after.json().mfaPending).toBe(false);
      expect(after.json().twoFactorEnabled).toBe(true);
      const allowed = await ctx.app.inject({ method: 'GET', url: '/api/v1/User', headers: authHeader(token) });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await restore();
    }
  });
});

describe('phase 23.2 — API-key lifecycle', () => {
  async function createKeyedApiUser(input: { scopes?: string[]; allowedIps?: string[] }): Promise<{ apiUserId: string; keyId: string; secret: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ApiUser',
      headers: authHeader(ctx.adminToken),
      payload: { userName: `AGENT_TEST-key-${runId}-${createdApiUserIds.length}`, assignedRoleIds: ['sysAdmin'], ...input },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; keyId: string; secret: string };
    createdApiUserIds.push(body.id);
    return { apiUserId: body.id, keyId: body.keyId, secret: body.secret };
  }

  it('enforces the read scope: safe methods pass, writes are refused', async () => {
    const key = await createKeyedApiUser({ scopes: ['read'] });
    const auth = { authorization: `ApiKey ${key.keyId}:${key.secret}` };

    const read = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: auth });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ApiUser',
      headers: auth,
      payload: { userName: `AGENT_TEST-keywrite-${runId}` },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('lets a write-scoped key perform writes and records last_used_at', async () => {
    const key = await createKeyedApiUser({ scopes: ['write'] });
    const auth = { authorization: `ApiKey ${key.keyId}:${key.secret}` };

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ApiUser',
      headers: auth,
      payload: { userName: `AGENT_TEST-keywrite2-${runId}` },
    });
    expect(write.statusCode).toBe(201);
    const childId = String((write.json() as { id: string }).id);
    createdApiUserIds.push(childId);

    const { DatabaseService } = await import('../src/database/database.service.js');
    const row = await ctx.app.get(DatabaseService).db
      .selectFrom('api_keys')
      .select(['last_used_at', 'scopes'])
      .where('id', '=', key.keyId)
      .executeTakeFirst();
    expect(row?.last_used_at).not.toBeNull();
    expect(JSON.stringify(row?.scopes)).toContain('write');
  });

  it('refuses a key used from an address outside its allowed_ips', async () => {
    const key = await createKeyedApiUser({ allowedIps: ['10.255.255.1'] });
    const auth = { authorization: `ApiKey ${key.keyId}:${key.secret}` };

    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: auth });
    expect(denied.statusCode).toBe(401);

    const allowed = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: auth, remoteAddress: '10.255.255.1' });
    expect(allowed.statusCode).toBe(200);
  });

  it('rotates a key: the replacement inherits restrictions, the old secret dies, nothing is stored raw', async () => {
    const key = await createKeyedApiUser({ scopes: ['read'], allowedIps: ['127.0.0.1'] });

    const rotated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/ApiKey/${key.keyId}/rotate`,
      headers: authHeader(ctx.adminToken),
      payload: {},
    });
    expect(rotated.statusCode).toBe(201);
    const next = rotated.json() as { keyId: string; secret: string; userName: string };
    expect(next.keyId).not.toBe(key.keyId);
    expect(next.secret).not.toBe(key.secret);

    const oldDead = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AppUser/me',
      headers: { authorization: `ApiKey ${key.keyId}:${key.secret}` },
    });
    expect(oldDead.statusCode).toBe(401);

    // The replacement kept the restrictions: reads pass, writes still fail, the IP list still applies.
    const nextAuth = { authorization: `ApiKey ${next.keyId}:${next.secret}` };
    const read = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: nextAuth });
    expect(read.statusCode).toBe(200);
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ApiUser',
      headers: nextAuth,
      payload: { userName: `AGENT_TEST-keywrite3-${runId}` },
    });
    expect(write.statusCode).toBe(403);

    // Only hashes are stored; the list endpoint never hands a secret back.
    const { DatabaseService } = await import('../src/database/database.service.js');
    const db = ctx.app.get(DatabaseService).db;
    const stored = await db.selectFrom('api_keys').select(['id', 'secret_hash', 'scopes', 'allowed_ips', 'revoked_at']).where('api_user_id', '=', key.apiUserId).execute();
    for (const row of stored) {
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(next.secret);
      expect(JSON.stringify(row)).not.toContain(key.secret);
    }
    const rotatedRow = stored.find((row) => row.id === next.keyId);
    expect(rotatedRow?.revoked_at).toBeNull();
    expect(JSON.stringify(rotatedRow?.scopes)).toContain('read');
    expect(JSON.stringify(rotatedRow?.allowed_ips)).toContain('127.0.0.1');
    const oldRow = stored.find((row) => row.id === key.keyId);
    expect(oldRow?.revoked_at).not.toBeNull();

    const listed = await ctx.app.inject({ method: 'GET', url: `/api/v1/ApiKey/${key.apiUserId}`, headers: authHeader(ctx.adminToken) });
    expect(listed.statusCode).toBe(200);
    for (const row of (listed.json() as { list: Record<string, unknown>[] }).list) {
      expect(row).not.toHaveProperty('secret');
      expect(row).not.toHaveProperty('secretHash');
    }
  });
});
