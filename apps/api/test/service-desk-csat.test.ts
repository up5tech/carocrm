import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let agent!: TestUser;
let caseId = '';

beforeAll(async () => {
  ctx = await bootApi();
  const _s = await ctx.app.inject({ method: 'GET', url: '/api/v1/ServiceDesk/action/settings', headers: authHeader(ctx.adminToken) });
  const priorFeatures = (_s.json() as any).settings.features;
  runId = `sdcsat${Date.now().toString(36)}`;
  await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/settings', headers: authHeader(ctx.adminToken), payload: { features: { caseManagement: true, csat: true } } });
  const roleId = `sdCsat${runId}`;
  await createTestRole(ctx, { id: roleId, name: `csat ${runId}`, permissions: { Case: { read: 'all', create: 'all', edit: 'all', delete: 'no', stream: 'no' } } });
  agent = await createTestUser(ctx, { userName: `sd_csat_${runId}`, roleIds: [roleId] });
  const c = await ctx.app.inject({ method: 'POST', url: '/api/v1/Case', headers: authHeader(ctx.adminToken), payload: { name: `AGENT_TEST_${runId} subject`, requesterName: 'R' } });
  caseId = (c.json() as Record<string, unknown>)['id'] as string;
});

afterAll(async () => { await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/settings', headers: authHeader(ctx.adminToken), payload: { features: { caseManagement: true, csat: false } } }); await shutdownApi(); });

describe('phase 19-SD.14 — CSAT', () => {
  it('creates an invitation and accepts a submission', async () => {
    const inv = await ctx.app.inject({ method: 'POST', url: `/api/v1/ServiceDesk/action/case/${caseId}/csat/invite`, headers: authHeader(ctx.adminToken) });
    expect(inv.statusCode).toBe(200);
    const token = (inv.json() as Record<string, unknown>)['token'] as string;
    const sub = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 5, feedback: 'great' } });
    expect(sub.statusCode).toBe(200);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/ServiceDesk/action/case/${caseId}/csat`, headers: authHeader(ctx.adminToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)['count']).toBe(1);
    expect((res.json() as Record<string, unknown>)['average']).toBe(5);
  });

  it('rejects duplicate submission', async () => {
    const inv = await ctx.app.inject({ method: 'POST', url: `/api/v1/ServiceDesk/action/case/${caseId}/csat/invite`, headers: authHeader(ctx.adminToken) });
    const token = (inv.json() as Record<string, unknown>)['token'] as string;
    await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 4 } });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 3 } });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
  });
});
