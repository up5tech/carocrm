import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { buildConfig } from '../src/config.js';
import type { TestContext } from './helper.js';
import { authHeader, bootTestApp, closeTestApp, getAdminToken } from './helper.js';

process.env.LOG_LEVEL = 'error';

const app = await createApp({ ...buildConfig(), authRateLimitMax: 1, authRateLimitWindowSeconds: 900 }, { skipMigrations: true });

/**
 * Phase 23.2 (PLAN_Phase_23_Security_Hardening.md §8, task 1) — the per-source authentication budget
 * is served by the single global `@fastify/rate-limit` registration, scoped to the credential routes
 * through the same limiter's per-request ceiling/window hooks.
 */
describe('phase 23.2 — auth rate limit', () => {
  afterAll(async () => {
    await app.close();
  });

  it('throttles the login route at the configured per-source auth ceiling', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: 'admin', password: 'admin' } });
    void first;
    const limited = await app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: 'admin', password: 'admin' } });
    expect(limited.statusCode).toBe(429);
    const body = limited.json() as {
      error?: { code?: string; message?: string; details?: { reason?: string; retryAfterSeconds?: number } };
    };
    expect(body.error?.code).toBe('RATE_LIMITED');
    expect(body.error?.message).toBe('Rate limit exceeded. Please try again later.');
    expect(body.error?.details?.reason).toContain('Rate limit exceeded, retry in');
    expect(body.error?.details?.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('phase 23.2 — login throttling and lockout', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  async function failureRows(subjectHash: string) {
    const { DatabaseService } = await import('../src/database/database.service.js');
    const rows = await ctx.app.get(DatabaseService).db.selectFrom('auth_login_attempts').select('subject_hash').where('subject_hash', '=', subjectHash).execute();
    return rows.length;
  }

  it('locks an account after the configured number of failed logins and refuses without recording', async () => {
    const userName = `agentlock-${Date.now().toString(36)}`;
    const subjectHash = createHash('sha256').update(userName.trim().toLowerCase()).digest('hex');
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName, password: 'agent-wrong-password' } });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('AUTHENTICATION_FAILED');
      }
      // The policy allows five failures before the lockout engages (PLAN §8 task 1).
      const before = await failureRows(subjectHash);
      expect(before).toBe(5);
      const locked = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName, password: 'agent-wrong-password' } });
      expect(locked.statusCode).toBe(401);
      expect(locked.json().error.code).toBe('AUTHENTICATION_FAILED');
      const after = await failureRows(subjectHash);
      expect(after).toBe(before);
    } finally {
      const { DatabaseService } = await import('../src/database/database.service.js');
      await ctx.app.get(DatabaseService).db.deleteFrom('auth_login_attempts').where('subject_hash', '=', subjectHash).execute();
    }
  });

  it('clears the failure history after a successful sign-in', async () => {
    const token = await getAdminToken();
    const userName = `agentclear-${Date.now().toString(36)}`;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/User',
      headers: authHeader(token),
      payload: { userName, password: 'agent-clear-password', isAdmin: true },
    });
    expect(created.statusCode).toBe(201);
    const userId = String((created.json() as { id: string }).id);
    try {
      const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName, password: 'agent-clear-wrong' } });
      expect(bad.statusCode).toBe(401);
      const subjectHash = createHash('sha256').update(userName.trim().toLowerCase()).digest('hex');
      const good = await ctx.app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName, password: 'agent-clear-password' } });
      expect(good.statusCode).toBe(201);
      const remaining = await failureRows(subjectHash);
      expect(remaining).toBe(0);
    } finally {
      const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/User/${userId}`, headers: authHeader(token) });
      expect(del.statusCode).toBe(200);
    }
  });
});
