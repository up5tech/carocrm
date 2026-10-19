import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20.9 — the internal tab's guarded danger zone (PLAN_Phase_20_Settings_UX.md §4.3 row 8).
 *
 * The refusals are exercised over HTTP; the destructive success paths are deliberately NOT executed
 * against this shared database — resetting metadata would discard every administrator's Entity Manager
 * overrides and purging the queue would drop other work's waiting jobs. The acceptance criterion
 * ("typed confirmation, audited") is what these tests pin: without the exact phrase the server refuses
 * with the expected phrase in `details`, and a refusal writes no audit row.
 */
type Method = 'GET' | 'POST';

let ctx: ApiContext;
let regularToken = '';
let regularUserId = '';

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

async function auditCount(operation: string): Promise<number> {
  const rows = await ctx.database.db.selectFrom('schema_changes').select('id').where('operation', '=', operation).execute();
  return rows.length;
}

beforeAll(async () => {
  ctx = await bootApi();
  const regular = await createTestUser(ctx, { userName: `AGENT_TEST p209 plain ${Date.now().toString(36)}` });
  regularToken = regular.token;
  regularUserId = regular.id;
});

afterAll(async () => {
  if (regularUserId !== '') {
    await ctx.database.db.deleteFrom('user_sessions').where('user_id', '=', regularUserId).execute();
    await ctx.database.db.deleteFrom('users').where('id', '=', regularUserId).execute();
  }
  await shutdownApi();
});

describe('internal info', () => {
  it('answers an administrator and refuses everyone else', async () => {
    const denied = await call('GET', '/api/v1/AdminInternal', regularToken);
    expect(denied.status).toBe(403);

    const ok = await call('GET', '/api/v1/AdminInternal', ctx.adminToken);
    expect(ok.status).toBe(200);
    expect(ok.body['metadataVersion']).toBeTypeOf('number');
    expect(ok.body['entityCount']).toBeTypeOf('number');
    expect(ok.body['overrideCount']).toBeTypeOf('number');
    expect((ok.body['jobQueue'] as Record<string, unknown>)['name']).toBeTypeOf('string');
    expect(ok.body['nodeVersion']).toBeTypeOf('string');
  });
});

describe('the guarded danger zone', () => {
  it('refuses the metadata reset without the exact typed phrase and writes no audit row', async () => {
    const before = await auditCount('admin.internal.metadataReset');
    const overridesBefore = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst();

    const missing = await call('POST', '/api/v1/AdminInternal/action/metadata-reset', ctx.adminToken, {});
    expect(missing.status).toBe(422);
    expect(detailsOf(missing.body)['expected']).toBe('RESET METADATA');

    const wrong = await call('POST', '/api/v1/AdminInternal/action/metadata-reset', ctx.adminToken, { confirm: 'reset metadata' });
    expect(wrong.status).toBe(422);

    const denied = await call('POST', '/api/v1/AdminInternal/action/metadata-reset', regularToken, { confirm: 'RESET METADATA' });
    expect(denied.status).toBe(403);

    // The overrides the Entity Manager wrote are untouched, and nothing was audited.
    const overridesAfter = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst();
    expect(overridesAfter === undefined).toBe(overridesBefore === undefined);
    expect(overridesAfter?.data).toEqual(overridesBefore?.data);
    expect(await auditCount('admin.internal.metadataReset')).toBe(before);
  });

  it('refuses the queue purge without the exact typed phrase and writes no audit row', async () => {
    const before = await auditCount('admin.internal.queuePurge');

    const wrong = await call('POST', '/api/v1/AdminInternal/action/queue-purge', ctx.adminToken, { confirm: 'PURGE' });
    expect(wrong.status).toBe(422);
    expect(detailsOf(wrong.body)['expected']).toBe('PURGE QUEUE');

    const denied = await call('POST', '/api/v1/AdminInternal/action/queue-purge', regularToken, { confirm: 'PURGE QUEUE' });
    expect(denied.status).toBe(403);

    expect(await auditCount('admin.internal.queuePurge')).toBe(before);
  });
});
