import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiContext, authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let owner!: TestUser;
let outsider!: TestUser;
const caseIds: string[] = [];
const roleIds: string[] = [];
const userIds: string[] = [];
let priorFeatures: Record<string, unknown> = {};

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = ctx.adminToken) {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload }) });
  let body: Record<string, unknown> = {};
  try { body = res.json() as Record<string, unknown>; } catch { body = {}; }
  return { status: res.statusCode, body };
}

async function createCase(assignedUserId?: string): Promise<string> {
  const res = await call('POST', '/api/v1/Case', {
    name: marker('metric case'),
    requesterName: marker('Requester'),
    ...(assignedUserId !== undefined ? { assignedUserId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body['id']);
  caseIds.push(id);
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdmetrics${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorFeatures = (settings.body['settings'] as Record<string, unknown>)['features'] as Record<string, unknown>;
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { caseManagement: true, csat: true } });

  const ownerRole = `sdMetricOwner${runId}`;
  const outsiderRole = `sdMetricOut${runId}`;
  roleIds.push(ownerRole, outsiderRole);
  await createTestRole(ctx, {
    id: ownerRole,
    name: `metrics owner ${runId}`,
    permissions: { Case: { read: 'own', create: 'no', edit: 'own', delete: 'no', stream: 'no' } },
  });
  await createTestRole(ctx, { id: outsiderRole, name: `metrics outsider ${runId}`, permissions: {} });
  owner = await createTestUser(ctx, { userName: `sd_metric_owner_${runId}`, roleIds: [ownerRole] });
  outsider = await createTestUser(ctx, { userName: `sd_metric_out_${runId}`, roleIds: [outsiderRole] });
  userIds.push(owner.id, outsider.id);
});

afterAll(async () => {
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: priorFeatures }).catch(() => undefined);
  for (const id of [...caseIds].reverse()) {
    await call('DELETE', `/api/v1/Case/${id}`).catch(() => undefined);
  }
  for (const id of userIds) await ctx.database.db.deleteFrom('users').where('id', '=', id).execute();
  for (const id of roleIds) await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute();
  await shutdownApi();
});

describe('phase 19-SD.15 — ACL-scoped metrics', () => {
  it('counts only the cases the caller can read', async () => {
    await createCase(owner.id);
    await createCase(owner.id);
    await createCase(); // admin-owned, invisible to owner through the own predicate

    const own = await call('GET', '/api/v1/ServiceDesk/action/metrics', undefined, owner.token);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body['total']).toBe(2);
    expect(own.body['active']).toBe(2);
    expect((own.body['byStatus'] as { key: string; count: number }[]).find((bucket) => bucket.key === 'New')?.count).toBe(2);
    // CSAT aggregates are only exposed to read-all roles.
    expect(own.body['csat']).toEqual({ restricted: true });
  });

  it('reflects a resolved case in active/resolved totals', async () => {
    const target = caseIds[0];
    const resolved = await call('POST', `/api/v1/ServiceDesk/action/case/${target}/transition`, { command: 'resolve', resolutionCode: 'Solved' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const own = await call('GET', '/api/v1/ServiceDesk/action/metrics', undefined, owner.token);
    expect(own.body['active']).toBe(1);
    expect(own.body['resolved']).toBe(1);
  });

  it('gives a read-all caller the wider aggregate and the CSAT block', async () => {
    const admin = await call('GET', '/api/v1/ServiceDesk/action/metrics');
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(Number(admin.body['total'])).toBeGreaterThanOrEqual(3);
    expect(admin.body['csat']).toMatchObject({ restricted: false });
    expect(admin.body['definitions']).toBeTruthy();
  });

  it('refuses a caller with no Case read permission', async () => {
    const res = await call('GET', '/api/v1/ServiceDesk/action/metrics', undefined, outsider.token);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid range without running a query', async () => {
    const res = await call('GET', '/api/v1/ServiceDesk/action/metrics?from=not-a-date');
    expect(res.status).toBe(400);
  });
});
