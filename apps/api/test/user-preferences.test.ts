import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20.10 — per-user preferences (PLAN_Phase_20_Settings_UX.md §5.9, §20.10).
 *
 * The guarantee under test: preferences follow the user across devices (a fresh login still sees them)
 * and never leak between users. There is no route that names another user, so the leak test is that a
 * second account's view of the same preference name is independent — reading it yields nothing of the
 * first account's, and writing it does not change the first account's.
 */
type Method = 'GET' | 'PUT';

const runId = Date.now().toString(36);

let ctx: ApiContext;
let aliceToken = '';
let bobToken = '';
const createdUsers: string[] = [];

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
  const alice = await createTestUser(ctx, { userName: `AGENT_TEST p210 alice ${runId}` });
  const bob = await createTestUser(ctx, { userName: `AGENT_TEST p210 bob ${runId}` });
  aliceToken = alice.token;
  bobToken = bob.token;
  createdUsers.push(alice.id, bob.id);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (createdUsers.length > 0) {
    await db.deleteFrom('user_preferences').where('user_id', 'in', createdUsers).execute();
    await db.deleteFrom('user_sessions').where('user_id', 'in', createdUsers).execute();
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await shutdownApi();
});

describe('preference ownership', () => {
  it('round-trips a value and keeps it across a fresh login', async () => {
    const put = await call('PUT', '/api/v1/Preferences/density', aliceToken, { value: 'compact' });
    expect(put.status).toBe(200);
    expect(put.body['value']).toBe('compact');
    expect(put.body['name']).toBe('density');

    const get = await call('GET', '/api/v1/Preferences/density', aliceToken);
    expect(get.status).toBe(200);
    expect(get.body['value']).toBe('compact');

    // "Across devices": a brand-new session for the same account still sees it.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: `AGENT_TEST p210 alice ${runId}`, password: 'secret-password' },
    });
    expect(again.statusCode).toBe(201);
    const freshToken = (again.json() as { accessToken: string }).accessToken;
    const relogin = await call('GET', '/api/v1/Preferences/density', freshToken);
    expect(relogin.body['value']).toBe('compact');

    const all = await call('GET', '/api/v1/Preferences', aliceToken);
    expect((all.body['items'] as { name: string }[]).some((item) => item.name === 'density')).toBe(true);
  });

  it('never mixes two accounts: the same name is independent per user', async () => {
    await call('PUT', '/api/v1/Preferences/density', aliceToken, { value: 'compact' });

    const bobsView = await call('GET', '/api/v1/Preferences/density', bobToken);
    expect(bobsView.status).toBe(200);
    expect(bobsView.body['value']).toBeNull();

    await call('PUT', '/api/v1/Preferences/density', bobToken, { value: 'comfortable' });
    const aliceAfter = await call('GET', '/api/v1/Preferences/density', aliceToken);
    expect(aliceAfter.body['value']).toBe('compact');
    const bobAfter = await call('GET', '/api/v1/Preferences/density', bobToken);
    expect(bobAfter.body['value']).toBe('comfortable');
  });

  it('refuses names and values it does not know', async () => {
    const unknownName = await call('PUT', '/api/v1/Preferences/nope', aliceToken, { value: 'dark' });
    expect(unknownName.status).toBe(422);
    expect(detailsOf(unknownName.body)['allowed']).toBeDefined();

    const unknownRead = await call('GET', '/api/v1/Preferences/nope', aliceToken);
    expect(unknownRead.status).toBe(422);

    const badValue = await call('PUT', '/api/v1/Preferences/density', aliceToken, { value: 'huge' });
    expect(badValue.status).toBe(422);
    expect(detailsOf(badValue.body)['issues']).toBeDefined();

    const badShape = await call('PUT', '/api/v1/Preferences/density', aliceToken, 'compact');
    // A non-object body is refused before validation even runs (JSON parse or body guard).
    expect(badShape.status).toBeGreaterThanOrEqual(400);
    expect(badShape.status).toBeLessThan(500);
  });

  it('validates the richer documents it stores', async () => {
    const columns = await call('PUT', '/api/v1/Preferences/columns', aliceToken, { value: { Account: ['name', 'type'] } });
    expect(columns.status).toBe(200);
    const read = await call('GET', '/api/v1/Preferences/columns', aliceToken);
    expect(read.body['value']).toEqual({ Account: ['name', 'type'] });

    const tooMany = await call('PUT', '/api/v1/Preferences/favorites', aliceToken, {
      value: Array.from({ length: 501 }, (_, index) => `Account:r${index}`),
    });
    expect(tooMany.status).toBe(422);

    const empty = await call('GET', '/api/v1/Preferences/defaultDashboard', aliceToken);
    expect(empty.body['value']).toBeNull();
  });
});
