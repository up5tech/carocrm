import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.21 — observability and operator surfaces
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §20 tasks 1, 4, 6, 9).
 *
 * What this proves through the real API against the configured database:
 *
 *  - a request id is generated or accepted from a bounded `x-correlation-id`, echoed as
 *    `x-request-id`, and written to the outbox row the request's mutation produced;
 *  - the operations snapshot answers an administrator with derived counters and refuses a regular
 *    account;
 *  - liveness/readiness stay public, cheap and secret-free.
 *
 * Every record is `AGENT_TEST_`-named and removed by exact id, together with its outbox/stream/audit
 * rows and the test user. Nothing is truncated or reset.
 */

const runId = Date.now().toString(36);
const userName = `agent_test_p22_obs_${runId}`;
const createdIds: string[] = [];

let ctx: ApiContext;
let regularToken = '';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  options: { payload?: unknown; token?: string; correlationId?: string } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) Object.assign(headers, authHeader(options.token));
  if (options.correlationId !== undefined) headers['x-correlation-id'] = options.correlationId;
  const response = await ctx.app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = response.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.statusCode, body, headers: response.headers as Record<string, string | string[] | undefined> };
}

beforeAll(async () => {
  ctx = await bootApi();
  regularToken = (await createTestUser(ctx, { userName })).token;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await ctx.database.db.deleteFrom('stream_items').where('entity_id', 'in', createdIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', createdIds).execute().catch(() => undefined);
    await sql`delete from outbox_events where payload ->> 'entityId' = any(${createdIds}::text[])`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', createdIds).execute().catch(() => undefined);
  }
  await ctx.database.db.deleteFrom('users').where('id', '=', `u_${userName}`).execute().catch(() => undefined);
  await shutdownApi();
});

describe('request and correlation ids (task 1)', () => {
  it('echoes a bounded correlation id and writes it to the event the request produced', async () => {
    const correlationId = `agent-test-p22-obs-${runId}`;
    const created = await call('POST', '/api/v1/Account', {
      token: ctx.adminToken,
      correlationId,
      payload: { name: `AGENT_TEST_p22_obs_${runId}_Account` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    createdIds.push(id);
    expect(created.headers['x-request-id']).toBe(correlationId);

    const event = await sql<{ correlation_id: string | null }>`
      select correlation_id from outbox_events
      where payload ->> 'entityId' = ${id}
      order by created_at desc limit 1
    `.execute(ctx.database.db);
    expect(event.rows[0]?.correlation_id).toBe(correlationId);
  });

  it('ignores an over-long correlation header instead of trusting it', async () => {
    const tooLong = `agent-test-${'x'.repeat(200)}`;
    const response = await call('GET', '/health/live', { correlationId: tooLong });
    expect(response.status).toBe(200);
    const echoed = String(response.headers['x-request-id'] ?? '');
    expect(echoed).not.toBe(tooLong);
    expect(echoed.length).toBeGreaterThan(0);
  });
});

describe('health probes (task 6)', () => {
  it('answers liveness and readiness without a session and without provider calls', async () => {
    const live = await call('GET', '/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });

    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', database: 'up' });
    // A probe is not a diagnostics dump: no connection string, credential or provider detail.
    const serialized = JSON.stringify(ready.body);
    expect(serialized).not.toMatch(/postgres:|password|token|secret/i);
  });
});

describe('operations snapshot (tasks 4 and 9)', () => {
  it('answers an administrator with derived counters', async () => {
    const snapshot = await call('GET', '/api/v1/AdminInternal/action/operations', { token: ctx.adminToken });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(snapshot.body['generatedAt']).toBeTypeOf('string');
    expect(snapshot.body['outbox']).toMatchObject({ byStatus: expect.any(Object) as object });
    expect(snapshot.body['jobs']).toMatchObject({ byStatus: expect.any(Object) as object });
    expect(snapshot.body['webhooks']).toMatchObject({
      signatureInbox: expect.any(Object) as object,
      connectorDeliveries: expect.any(Object) as object,
      voiceEvents: expect.any(Object) as object,
      marketingInbox: expect.any(Object) as object,
    });
    expect(snapshot.body['integrations']).toMatchObject({ connections: expect.any(Object) as object });
    expect(snapshot.body['ai']).toMatchObject({ approvalsPending: expect.any(Number) as number });
    // Counters only: no record content, address or credential.
    const serialized = JSON.stringify(snapshot.body);
    expect(serialized).not.toMatch(/postgres:|password|token|@example/i);
  });

  it('refuses a regular account', async () => {
    const refused = await call('GET', '/api/v1/AdminInternal/action/operations', { token: regularToken });
    expect(refused.status).toBe(403);
  });
});
