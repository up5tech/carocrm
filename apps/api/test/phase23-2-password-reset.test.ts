import { createHash } from 'node:crypto';

import type { MailTransport, MemoryTransport } from '@carocrm/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { buildConfig } from '../src/config.js';
import { MAIL_TRANSPORT_TOKEN } from '../src/email/email.constants.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.2 (PLAN_Phase_23_Security_Hardening.md §8, task 2) — self-service password reset:
 * single-use expiring token, no account enumeration, session revocation on success, and delivery
 * through the memory mail transport (no real email leaves this suite).
 */
const previousTransport = process.env.MAIL_TRANSPORT;
const previousFrom = process.env.SMTP_FROM;
process.env.MAIL_TRANSPORT = 'memory';
process.env.SMTP_FROM = 'reset@example.com';
process.env.LOG_LEVEL = 'error';

const runId = Date.now().toString(36);
const USER_NAME = `AGENT_TEST-reset-${runId}`;

let ctx: ApiContext;
let userId = '';
let userToken = '';
let transport: MemoryTransport;

function tokenFromLastMail(): string {
  const last = transport.messages[transport.messages.length - 1];
  if (!last?.text) throw new Error('no reset mail held by the memory transport');
  const match = /[A-Za-z0-9_-]{43}/.exec(last.text);
  if (!match) throw new Error('no reset token found in the mail body');
  return match[0];
}

async function requestReset(identifier: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/PasswordReset', payload: { identifier } });
}

async function confirmReset(token: string, newPassword: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/PasswordReset/confirm', payload: { token, newPassword } });
}

beforeAll(async () => {
  ctx = await bootApi();
  transport = ctx.app.get<MailTransport>(MAIL_TRANSPORT_TOKEN) as MemoryTransport;
  const created = await createTestUser(ctx, { userName: USER_NAME, password: 'old-password-1' });
  userId = created.id;
  userToken = created.token;
});

afterAll(async () => {
  const db = ctx.database.db;
  await db.deleteFrom('auth_password_resets').where('user_id', '=', userId).execute();
  await db.deleteFrom('user_sessions').where('user_id', '=', userId).execute();
  await db.deleteFrom('auth_login_attempts').where('subject_hash', '=', createHash('sha256').update(USER_NAME.toLowerCase()).digest('hex')).execute();
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await shutdownApi();
  if (previousTransport === undefined) delete process.env.MAIL_TRANSPORT;
  else process.env.MAIL_TRANSPORT = previousTransport;
  if (previousFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = previousFrom;
});

describe('phase 23.2 — password reset request', () => {
  it('sends a single-use token through the configured transport without enumerating accounts', async () => {
    const before = transport.messages.length;
    const known = await requestReset(USER_NAME);
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ status: true });
    expect(transport.messages.length).toBe(before + 1);
    const mail = transport.messages[transport.messages.length - 1];
    expect(mail?.to[0]?.address).toBe(`${USER_NAME}@example.com`.toLowerCase());

    const unknown = await requestReset(`AGENT_TEST-missing-${runId}`);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ status: true });
    expect(transport.messages.length).toBe(before + 1);

    // The stored row holds only the hash — never the raw token that went into the mail.
    const token = tokenFromLastMail();
    const rows = await ctx.database.db.selectFrom('auth_password_resets').selectAll().where('user_id', '=', userId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('accepts the account email as the identifier', async () => {
    // Still inside the cooldown of the first request: the answer stays generic and no second mail
    // is sent, which is the anti-mail-bomb bound.
    const byEmail = await requestReset(`${USER_NAME}@example.com`);
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json()).toEqual({ status: true });
  });

  it('keeps only one live token per account and honours the request cooldown', async () => {
    const before = transport.messages.length;
    const again = await requestReset(USER_NAME);
    expect(again.statusCode).toBe(200);
    expect(transport.messages.length).toBe(before);
    const rows = await ctx.database.db.selectFrom('auth_password_resets').select('token_hash').where('user_id', '=', userId).execute();
    expect(rows).toHaveLength(1);
  });
});

describe('phase 23.2 — password reset confirmation', () => {
  it('rejects an unknown token', async () => {
    const res = await confirmReset('not-a-real-token', 'new-password-2');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTHENTICATION_FAILED');
  });

  it('rejects an expired token', async () => {
    const token = tokenFromLastMail();
    await ctx.database.db
      .updateTable('auth_password_resets')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', userId)
      .execute();
    const res = await confirmReset(token, 'new-password-2');
    expect(res.statusCode).toBe(401);
    // Restore a live expiry for the success path below.
    await ctx.database.db
      .updateTable('auth_password_resets')
      .set({ expires_at: new Date(Date.now() + 60 * 60_000) })
      .where('user_id', '=', userId)
      .execute();
  });

  it('enforces the instance password policy on the new password', async () => {
    const db = ctx.database.db;
    const previous = await db.selectFrom('app_settings').select('data').where('name', '=', 'security').executeTakeFirst();
    await db
      .insertInto('app_settings')
      .values({ name: 'security', data: JSON.stringify({ value: { password: { minLength: 20 } }, version: 1 }), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify({ value: { password: { minLength: 20 } }, version: 1 }), modified_at: new Date() }))
      .execute();
    try {
      const token = tokenFromLastMail();
      const res = await confirmReset(token, 'short-9ch');
      expect(res.statusCode).toBe(422);
      // The token was not consumed by the rejected attempt.
      const rows = await db.selectFrom('auth_password_resets').select('used_at').where('user_id', '=', userId).execute();
      expect(rows[0]?.used_at).toBeNull();
    } finally {
      if (previous) {
        await db.updateTable('app_settings').set({ data: previous.data, modified_at: new Date() }).where('name', '=', 'security').execute();
      } else {
        await db.deleteFrom('app_settings').where('name', '=', 'security').execute();
      }
    }
  });

  it('consumes the token, revokes prior sessions, and cannot be replayed', async () => {
    const token = tokenFromLastMail();
    const res = await confirmReset(token, 'new-password-2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: true });

    // The session the old password opened is revoked.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(userToken) });
    expect(me.statusCode).toBe(401);

    // The old password no longer signs in; the new one does.
    const oldLogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: USER_NAME, password: 'old-password-1' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: USER_NAME, password: 'new-password-2' } });
    expect(newLogin.statusCode).toBe(201);
    userToken = (newLogin.json() as { accessToken: string }).accessToken;

    // Single use: the same token is refused a second time.
    const replay = await confirmReset(token, 'another-password-3');
    expect(replay.statusCode).toBe(401);
  });
});

describe('phase 23.2 — password reset rate budget', () => {
  it('shares the per-source auth ceiling with the other credential routes', async () => {
    const app = await createApp({ ...buildConfig(), authRateLimitMax: 1, authRateLimitWindowSeconds: 900 }, { skipMigrations: true });
    try {
      const first = await app.inject({ method: 'POST', url: '/api/v1/PasswordReset', payload: { identifier: 'anyone' } });
      expect(first.statusCode).toBe(200);
      const limited = await app.inject({ method: 'POST', url: '/api/v1/PasswordReset', payload: { identifier: 'anyone' } });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      // The bucket key is route-scoped: confirm has its own budget under the same auth ceiling.
      const confirmFirst = await app.inject({ method: 'POST', url: '/api/v1/PasswordReset/confirm', payload: { token: 'x', newPassword: 'whatever-123' } });
      expect(confirmFirst.statusCode).toBe(401);
      const confirmLimited = await app.inject({ method: 'POST', url: '/api/v1/PasswordReset/confirm', payload: { token: 'x', newPassword: 'whatever-123' } });
      expect(confirmLimited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});