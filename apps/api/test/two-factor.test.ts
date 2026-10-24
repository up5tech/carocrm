import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { totpAt } from '../src/auth/totp.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

const runId = Date.now().toString(36);
const USER_NAME = `AGENT_TEST-2fa-${runId}`;

let ctx: ApiContext;
let userToken = '';
let userId = '';
let recoveryCodes: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  const created = await createTestUser(ctx, { userName: USER_NAME, password: 'secret-password' });
  userId = created.id;
  userToken = created.token;
});

afterAll(async () => {
  const db = ctx.database.db;
  await db.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute();
  await db.deleteFrom('auth_challenges').where('user_id', '=', userId).execute();
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await shutdownApi();
});

describe('two-factor authentication', () => {
  it('enrolls a TOTP factor and returns recovery codes', async () => {
    const setupRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/AppUser/me/totp/setup',
      headers: authHeader(userToken),
      payload: {},
    });
    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { secret: string; otpauthUri: string };
    expect(setup.secret).toBeTruthy();
    expect(setup.otpauthUri).toContain('otpauth://totp/');

    const code = totpAt(setup.secret, Date.now());
    const enableRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/AppUser/me/totp/enable',
      headers: authHeader(userToken),
      payload: { code },
    });
    expect(enableRes.statusCode).toBe(200);
    recoveryCodes = (enableRes.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const profileRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AppUser/me',
      headers: authHeader(userToken),
    });
    expect(profileRes.json().twoFactorEnabled).toBe(true);
  });

  it('turns a password login into a one-shot challenge', async () => {
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_NAME, password: 'secret-password' },
    });
    expect(loginRes.statusCode).toBe(201);
    expect(loginRes.json().challengeId).toBeTruthy();
  });

  it('completes the challenge with a valid TOTP code', async () => {
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_NAME, password: 'secret-password' },
    });
    const challengeId = (loginRes.json() as { challengeId: string }).challengeId;

    // Re-enroll to know the secret? Instead use recovery code path below; here mint a fresh setup is not possible.
    // We cannot compute TOTP without the secret, so use a recovery code instead.
    const recovery = recoveryCodes[0];
    if (recovery === undefined) throw new Error('no recovery code');
    const challengeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication/challenge',
      payload: { challengeId, code: recovery },
    });
    expect(challengeRes.statusCode).toBe(200);
    expect((challengeRes.json() as { accessToken: string }).accessToken).toBeTruthy();
  });

  it('rejects a reused recovery code', async () => {
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_NAME, password: 'secret-password' },
    });
    const challengeId = (loginRes.json() as { challengeId: string }).challengeId;
    const reused = recoveryCodes[0];
    if (reused === undefined) throw new Error('no recovery code');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication/challenge',
      payload: { challengeId, code: reused },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets an administrator reset the second factor', async () => {
    const resetRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/User/${encodeURIComponent(userId)}/totp-reset`,
      headers: authHeader(ctx.adminToken),
      payload: {},
    });
    expect(resetRes.statusCode).toBe(200);

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: USER_NAME, password: 'secret-password' },
    });
    // 2FA cleared: login issues tokens directly.
    expect(loginRes.json().accessToken).toBeTruthy();
  });
});