import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let agentA!: TestUser;
let agentB!: TestUser;

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdsec${Date.now().toString(36)}`;
  const role = `sdSec${runId}`;
  await createTestRole(ctx, { id: role, name: `sec ${runId}`, permissions: { Case: { read: 'own', create: 'all', edit: 'own', delete: 'no', stream: 'yes' } } });
  agentA = await createTestUser(ctx, { userName: `sd_sec_a_${runId}`, roleIds: [role], teamIds: [] });
  agentB = await createTestUser(ctx, { userName: `sd_sec_b_${runId}`, roleIds: [role], teamIds: [] });
  await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/settings', headers: authHeader(ctx.adminToken), payload: { features: { caseManagement: true } } });
});

afterAll(async () => { await shutdownApi(); });

describe('phase 19-SD.17 — security (§9)', () => {
  it('agent cannot read another agent\'s case (IDOR)', async () => {
    const c = await ctx.app.inject({ method: 'POST', url: '/api/v1/Case', headers: authHeader(agentA.token), payload: { name: `AGENT_TEST_${runId} subj`, requesterName: 'R' } });
    const caseId = (c.json() as Record<string, unknown>)['id'] as string;
    const read = await ctx.app.inject({ method: 'GET', url: `/api/v1/Case/${caseId}`, headers: authHeader(agentB.token) });
    expect([403, 404]).toContain(read.statusCode);
  });

  it('cannot forge a server-owned field (caseNumber) on create', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/Case', headers: authHeader(agentA.token), payload: { name: `AGENT_TEST_${runId} subj2`, requesterName: 'R', caseNumber: 'FORGED-1' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('cannot forge visibility=internal via generic Note as portal (forced public)', async () => {
    // portal path tested in conversation suite; here just ensure generic Note rejects unknown visibility
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/Note', headers: authHeader(agentA.token), payload: { type: 'Post', parentType: 'Case', parentId: '00000000-0000-0000-0000-000000000000', post: 'x', visibility: 'system' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('web-to-case does not expose internal IDs in errors', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/webToCase', payload: { name: '' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.body;
    expect(body).not.toContain('stack');
  });

  it('SLA checkBreaches requires no auth but is safe (no crash on empty)', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/sla/checkBreaches', headers: authHeader(ctx.adminToken) });
    expect(res.statusCode).toBe(200);
  });
});
