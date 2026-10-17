import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiContext, authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let agent!: TestUser;
let viewer!: TestUser;
let caseId = '';
let roleIds: string[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function createCase(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Case',
    headers: authHeader(ctx.adminToken),
    payload: { name: marker('subject'), requesterName: 'Requester' },
  });
  return String((res.json() as Record<string, unknown>)['id']);
}

async function resolve(id: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/ServiceDesk/action/case/${id}/transition`,
    headers: authHeader(ctx.adminToken),
    payload: { command: 'resolve', resolutionCode: 'Solved' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdcsat${Date.now().toString(36)}`;
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/ServiceDesk/action/settings',
    headers: authHeader(ctx.adminToken),
    payload: { features: { caseManagement: true, csat: true } },
  });

  const editorRole = `sdCsatEdit${runId}`;
  const viewerRole = `sdCsatView${runId}`;
  roleIds = [editorRole, viewerRole];
  await createTestRole(ctx, {
    id: editorRole,
    name: `csat editor ${runId}`,
    permissions: { Case: { read: 'all', create: 'all', edit: 'all', delete: 'no', stream: 'no' } },
  });
  await createTestRole(ctx, {
    id: viewerRole,
    name: `csat viewer ${runId}`,
    permissions: { Case: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
  });
  agent = await createTestUser(ctx, { userName: `sd_csat_${runId}`, roleIds: [editorRole] });
  viewer = await createTestUser(ctx, { userName: `sd_csat_view_${runId}`, roleIds: [viewerRole] });

  caseId = await createCase();
  await resolve(caseId);
});

afterAll(async () => {
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/ServiceDesk/action/settings',
    headers: authHeader(ctx.adminToken),
    payload: { features: { caseManagement: true, csat: false } },
  });
  // Only this run's records, by exact identifiers.
  await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'CsatSurvey').where(sql`attrs ->> 'caseId'`, '=', caseId).execute();
  if (caseId !== '') await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Case/${caseId}`, headers: authHeader(ctx.adminToken) });
  for (const user of [agent, viewer]) {
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute();
  }
  for (const roleId of roleIds) await ctx.database.db.deleteFrom('roles').where('id', '=', roleId).execute();
  await shutdownApi();
});

describe('phase 19-SD.14 — CSAT', () => {
  it('creates an invitation for a resolved case and accepts a submission', async () => {
    const inv = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/ServiceDesk/action/case/${caseId}/csat/invite`,
      headers: authHeader(agent.token),
    });
    expect(inv.statusCode, inv.body).toBe(200);
    const token = (inv.json() as Record<string, unknown>)['token'] as string;
    const sub = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 5, feedback: 'great' } });
    expect(sub.statusCode).toBe(200);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ServiceDesk/action/case/${caseId}/csat`,
      headers: authHeader(agent.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)['count']).toBe(1);
    expect((res.json() as Record<string, unknown>)['average']).toBe(5);
  });

  it('rejects duplicate submission', async () => {
    const inv = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/ServiceDesk/action/case/${caseId}/csat/invite`,
      headers: authHeader(agent.token),
    });
    const token = (inv.json() as Record<string, unknown>)['token'] as string;
    await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 4 } });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/csat/submit', payload: { token, rating: 3 } });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses to invite a survey before the case is resolved', async () => {
    const openCase = await createCase();
    const inv = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/ServiceDesk/action/case/${openCase}/csat/invite`,
      headers: authHeader(agent.token),
    });
    expect(inv.statusCode).toBe(422);
    await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Case/${openCase}`, headers: authHeader(ctx.adminToken) });
  });

  it('refuses an invitation from an agent without edit permission on the case', async () => {
    const inv = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/ServiceDesk/action/case/${caseId}/csat/invite`,
      headers: authHeader(viewer.token),
    });
    expect(inv.statusCode).toBeGreaterThanOrEqual(400);
    expect(inv.statusCode).toBeLessThan(500);
  });
});
