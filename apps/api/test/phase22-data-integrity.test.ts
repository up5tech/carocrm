import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.19 — data integrity and concurrency
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §18 tasks 5 and 8).
 *
 * Two invariants the Entity Engine claims, driven through the real API against the configured
 * database (AGENTS.md §3.1):
 *
 *  1. **Optimistic locking is decided by the write, not by a client's last read.** Two callers that
 *     both saw version N cannot both write N+1; exactly one wins and the other is told it lost.
 *  2. **A page is a window over the current order, not a snapshot.** Offset pagination is documented
 *     as such: an insert that sorts *before* the next page's boundary shifts the window, and an update
 *     that does not move the sort key does not. The test asserts the honest behaviour instead of
 *     pretending the page is isolated.
 *
 * Every record is `AGENT_TEST_`-named and removed by exact id, together with the stream/audit/outbox
 * rows this run produced for it. Nothing is truncated or reset.
 */

const runId = `di${Date.now().toString(36)}`;
const prefix = `AGENT_TEST_p22_di_${runId}`;

let ctx: ApiContext;
const created: string[] = [];

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(ctx.adminToken),
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

async function createAccount(suffix: string): Promise<string> {
  const createdAccount = await call('POST', '/api/v1/Account', { name: `${prefix}-${suffix}` });
  expect(createdAccount.status, JSON.stringify(createdAccount.body)).toBe(201);
  const id = String(createdAccount.body['id']);
  created.push(id);
  return id;
}

const pagePrefix = `${prefix}-page`;

async function page(offset: number): Promise<{ ids: string[]; names: string[]; total: number }> {
  const where = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: pagePrefix }]));
  const result = await call('GET', `/api/v1/Account?where=${where}&orderBy=name&maxSize=2&offset=${String(offset)}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const list = (result.body['list'] ?? []) as { id: string; name: string }[];
  return {
    ids: list.map((row) => String(row.id)),
    names: list.map((row) => String(row.name)),
    total: Number(result.body['total'] ?? 0),
  };
}

beforeAll(async () => {
  ctx = await bootApi();
});

afterAll(async () => {
  if (created.length > 0) {
    await ctx.database.db.deleteFrom('stream_items').where('entity_id', 'in', created).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', created).execute().catch(() => undefined);
    await sql`delete from outbox_events where payload ->> 'entityId' = any(${created}::text[])`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', created).execute().catch(() => undefined);
  }
  await shutdownApi();
});

describe('optimistic locking (plan §18 task 5)', () => {
  it('lets exactly one of two writers at the same version win', async () => {
    const id = await createAccount('lock');
    const current = await call('GET', `/api/v1/Account/${id}`);
    const version = Number(current.body['version']);
    expect(Number.isFinite(version)).toBe(true);

    const [left, right] = await Promise.all([
      call('PATCH', `/api/v1/Account/${id}`, { description: 'writer left', version }),
      call('PATCH', `/api/v1/Account/${id}`, { description: 'writer right', version }),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winner = left.status === 200 ? left : right;
    const loser = left.status === 200 ? right : left;
    expect(JSON.stringify(loser.body)).toContain('CONCURRENCY_CONFLICT');
    const stored = await call('GET', `/api/v1/Account/${id}`);
    expect(stored.body['description']).toBe(winner.body['description']);
    expect(Number(stored.body['version'])).toBe(version + 1);
  });
});

describe('pagination under concurrent writes (plan §18 task 8)', () => {
  it('keeps the next page stable when a concurrent write does not cross the boundary, and documents the shift when one does', async () => {
    await createAccount('page-a');
    await createAccount('page-b');
    const c = await createAccount('page-c');
    await createAccount('page-d');

    const first = await page(0);
    expect(first.names).toEqual([`${pagePrefix}-a`, `${pagePrefix}-b`]);
    expect(first.total).toBe(4);

    // A concurrent edit that does not change the sort key, plus a record that sorts *after* the
    // remaining page: the next page is still the same four names, in the same order.
    await Promise.all([
      call('PATCH', `/api/v1/Account/${c}`, { description: `${prefix} edited while paging` }),
      createAccount('page-z'),
    ]);
    const second = await page(2);
    expect(second.names).toEqual([`${pagePrefix}-c`, `${pagePrefix}-d`]);
    expect(second.total).toBe(5);
    expect(second.ids.filter((id) => first.ids.includes(id))).toEqual([]);

    // An insert that sorts *before* the boundary shifts the window. That is what offset pagination
    // means; the test records the behaviour rather than claiming a snapshot the query cannot give.
    await createAccount('page-b2');
    const shifted = await page(2);
    expect(shifted.names).toEqual([`${pagePrefix}-b2`, `${pagePrefix}-c`]);
    expect(shifted.total).toBe(6);
    expect(shifted.ids.filter((id) => first.ids.includes(id))).toEqual([]);
  });
});
