import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let ctx: ApiContext;
let runId: string;
let priorFeatures: Record<string, unknown> = {};
const caseIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];
const clockIds: string[] = [];
let agent!: TestUser;

const marker = (s: string) => `AGENT_TEST_${runId} ${s}`;

async function call(method: Method, url: string, payload?: Record<string, unknown>, token = ctx.adminToken) {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload }) });
  let body: Record<string, unknown> = {};
  try { body = res.json() as Record<string, unknown>; } catch { body = {}; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdsla${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorFeatures = (settings.body['settings'] as Record<string, unknown>)['features'] as Record<string, unknown>;
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { caseManagement: true, sla: true } });

  const roleId = `sdSla${runId}`;
  roleIds.push(roleId);
  await createTestRole(ctx, {
    id: roleId,
    name: `SD sla ${runId}`,
    permissions: { Case: { read: 'all', create: 'all', edit: 'all', delete: 'no', stream: 'yes' } },
  });
  agent = await createTestUser(ctx, { userName: `sd_sla_${runId}`, roleIds: [roleId] });
  userIds.push(agent.id);

  // Create a default business calendar + SLA policy (30 min first response, 120 min resolution).
  const cal = await call('POST', '/api/v1/BusinessCalendar', {
    name: marker('Cal'), code: `CAL_${runId}`, timezone: 'UTC',
    intervals: JSON.stringify({ '1': [{ start: '00:00', end: '23:59' }], '2': [{ start: '00:00', end: '23:59' }], '3': [{ start: '00:00', end: '23:59' }], '4': [{ start: '00:00', end: '23:59' }], '5': [{ start: '00:00', end: '23:59' }], '6': [{ start: '00:00', end: '23:59' }], '0': [{ start: '00:00', end: '23:59' }] }),
    holidays: '[]', isActive: true, isDefault: true,
  });
  const calId = String(cal.body['id']);
  const pol = await call('POST', '/api/v1/SLAPolicy', {
    name: marker('Policy'), code: `POL_${runId}`, isActive: true, priority: 0,
    conditions: '[]', calendarId: calId,
    firstResponseMinutes: 30, nextResponseMinutes: 0, resolutionMinutes: 120,
    warningThresholds: '[75]', pauseOnCustomer: true, pauseOnInternal: true, version: 1,
  });
  expect(pol.status, JSON.stringify(pol.body)).toBeLessThan(300);
});

afterAll(async () => {
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: priorFeatures }).catch(() => undefined);
  for (const cid of caseIds) {
    await call('DELETE', `/api/v1/Case/${cid}`).catch(() => undefined);
  }
  // clocks
  for (const id of clockIds) {
    await ctx.database.db.deleteFrom('entity_records').where('id', '=', id).execute().catch(() => undefined);
  }
  await ctx.database.db.deleteFrom('entity_records').where('entity_type', 'in', ['SLAPolicy', 'BusinessCalendar']).where(sql`attrs ->> 'name' like ${'AGENT_TEST_' + runId + '%'}`).execute().catch(() => undefined);
  for (const uid of userIds) await ctx.database.db.deleteFrom('users').where('id', '=', uid).execute().catch(() => undefined);
  for (const rid of roleIds) await ctx.database.db.deleteFrom('roles').where('id', '=', rid).execute().catch(() => undefined);
  await shutdownApi();
});

describe('phase 19-SD.8 — SLA (§5.6)', () => {
  it('creates clocks when a case is created under an active policy', async () => {
    const c = await call('POST', '/api/v1/Case', { name: marker('subject'), requesterName: marker('Requester'), priority: 'High' }, agent.token);
    expect(c.status, JSON.stringify(c.body)).toBeLessThan(300);
    const caseId = String(c.body['id']);
    caseIds.push(caseId);
    const reread = await call('GET', `/api/v1/Case/${caseId}`);
    expect(reread.body['slaState']).toBe('OnTrack');
    expect(reread.body['slaPolicyId']).toBeTruthy();

    const clocks = await ctx.database.db.selectFrom('entity_records').select(['id', 'attrs']).where('entity_type', '=', 'CaseSLAClock').where(sql`attrs ->> 'caseId'`, '=', caseId).execute();
    expect(clocks.length).toBeGreaterThanOrEqual(1);
    for (const cl of clocks) clockIds.push(cl.id);
    const targets = clocks.map((cl) => (cl.attrs as Record<string, unknown>)['targetType']);
    expect(targets).toContain('firstResponse');
    expect(targets).toContain('resolution');
  });

  it('markMet on public reply moves first-response clock to met', async () => {
    const c = await call('POST', '/api/v1/Case', { name: marker('subject2'), requesterName: marker('Requester2') }, agent.token);
    const caseId = String(c.body['id']);
    caseIds.push(caseId);
    await call('POST', `/api/v1/ServiceDesk/action/case/${caseId}/reply`, { text: 'hi customer' }, agent.token);
    const clocks = await ctx.database.db.selectFrom('entity_records').select('attrs').where('entity_type', '=', 'CaseSLAClock').where(sql`attrs ->> 'caseId'`, '=', caseId).where(sql`attrs ->> 'targetType'`, '=', 'firstResponse').execute();
    expect(clocks.length).toBe(1);
    expect((clocks[0].attrs as Record<string, unknown>)['status']).toBe('met');
  });

  it('checkBreaches marks an overdue clock as breached', async () => {
    const c = await call('POST', '/api/v1/Case', { name: marker('subject3'), requesterName: marker('Requester3') }, agent.token);
    const caseId = String(c.body['id']);
    caseIds.push(caseId);
    // Force dueAt into the past.
    await ctx.database.db.updateTable('entity_records').set({ attrs: sql`attrs || '{"dueAt":"2020-01-01T00:00:00.000Z","status":"onTrack"}'::jsonb` }).where('entity_type', '=', 'CaseSLAClock').where(sql`attrs ->> 'caseId'`, '=', caseId).execute();
    // Directly invoke the service through the app.
    const sla = ctx.app.get((await import('../src/service-desk/sla.service.js')).SlaService);
    const r = await sla.checkBreaches();
    expect(r.breached).toBeGreaterThan(0);
  });
});
