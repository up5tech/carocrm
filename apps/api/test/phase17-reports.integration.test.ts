import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

const runId = `p17${Date.now().toString(36)}`;
const workerSecret = `phase17-test-${runId}-worker-capability`;
const originalWorkerSecret = process.env.REPORT_WORKER_SECRET;
process.env.REPORT_WORKER_SECRET = workerSecret;
const ownedIds: string[] = [];
let ctx: ApiContext;
let token = '';
let reportId = '';
let scheduleId = '';
let scheduledJobId = '';

async function call(method: 'POST', url: string, payload: unknown) {
  const response = await ctx.app.inject({ method, url, headers: authHeader(token), payload: payload as Record<string, unknown> });
  let body: unknown = {};
  try { body = response.json(); } catch { body = {}; }
  return { status: response.statusCode, body };
}

function recordId(body: unknown): string {
  const value = (body as { id?: unknown }).id;
  if (typeof value !== 'string') throw new Error(`Test record creation returned no id: ${JSON.stringify(body)}`);
  ownedIds.push(value);
  return value;
}

beforeAll(async () => {
  ctx = await bootApi();
  token = ctx.adminToken;
});

afterAll(async () => {
  if (reportId !== '') {
    const schedule = await ctx.database.db.selectFrom('report_schedules').select(['id', 'scheduled_job_id']).where('report_id', '=', reportId).executeTakeFirst();
    if (schedule) {
      scheduleId ||= schedule.id;
      scheduledJobId ||= schedule.scheduled_job_id;
    }
  }
  if (scheduledJobId !== '') await ctx.database.db.deleteFrom('scheduled_jobs').where('id', '=', scheduledJobId).execute();
  if (scheduleId !== '') await ctx.database.db.deleteFrom('report_schedules').where('id', '=', scheduleId).execute();
  if (reportId !== '') await ctx.database.db.deleteFrom('reports').where('id', '=', reportId).execute();
  if (ownedIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', ownedIds).execute();
    await ctx.database.db.deleteFrom('outbox_events').where(sql`payload ->> 'entityId'`, 'in', ownedIds).execute();
  }
  await shutdownApi();
  if (originalWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = originalWorkerSecret;
});

describe('Phase 17 exact report execution', () => {
  it('aggregates beyond the row-scan cap, pivots and resolves ACL-checked to-one fields', async () => {
    const accountNorth = `AGENT_TEST_${runId}_North`;
    const accountSouth = `AGENT_TEST_${runId}_South`;
    const northCreated = await call('POST', '/api/v1/Account', { name: accountNorth });
    const southCreated = await call('POST', '/api/v1/Account', { name: accountSouth });
    expect(northCreated.status).toBe(201);
    expect(southCreated.status).toBe(201);
    const northId = recordId(northCreated.body);
    const southId = recordId(southCreated.body);

    const opportunities = [
      { name: `AGENT_TEST_${runId}_O1`, stage: 'Proposal', amount: '100.00', accountId: northId },
      { name: `AGENT_TEST_${runId}_O2`, stage: 'Proposal', amount: '250.00', accountId: northId },
      { name: `AGENT_TEST_${runId}_O3`, stage: 'Qualification', amount: '75.00', accountId: southId },
    ];
    for (const input of opportunities) {
      const created = await call('POST', '/api/v1/Opportunity', input);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      recordId(created.body);
    }

    const summary = await call('POST', '/api/v1/Report/action/preview', { definition: {
      entityType: 'Opportunity', kind: 'summary', filters: [{ field: 'name', operator: 'like', value: runId }], columns: [],
      metrics: [{ name: 'totalAmount', operation: 'sum', field: 'amount' }, { name: 'records', operation: 'count' }],
    } });
    expect(summary.status).toBe(200);
    const summaryResult = (summary.body as { result: { total: number; scanned: number | null; truncated: boolean; metrics: Record<string, number> } }).result;
    expect(summaryResult).toMatchObject({ total: 3, scanned: null, truncated: false, metrics: { totalAmount: 425, records: 3 } });

    const matrix = await call('POST', '/api/v1/Report/action/preview', { definition: {
      entityType: 'Opportunity', kind: 'matrix', filters: [{ field: 'name', operator: 'like', value: runId }], columns: [],
      matrix: { rows: { field: 'stage' }, columns: { field: 'accountId.name' } },
      metrics: [{ name: 'amount', operation: 'sum', field: 'amount' }],
    } });
    expect(matrix.status).toBe(200);
    const cells = (matrix.body as { result: { matrix: { cells: { rowKey: string; columnKey: string; count: number; metrics: Record<string, number> }[] } } }).result.matrix.cells;
    expect(cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowKey: 'Proposal', columnKey: accountNorth, count: 2, metrics: { amount: 350 } }),
      expect.objectContaining({ rowKey: 'Qualification', columnKey: accountSouth, count: 1, metrics: { amount: 75 } }),
    ]));

    const createdReport = await call('POST', '/api/v1/Report', { name: `AGENT_TEST_${runId}_report`, visibility: 'private', definition: {
      entityType: 'Opportunity', kind: 'summary', filters: [{ field: 'name', operator: 'like', value: runId }], columns: [],
      metrics: [{ name: 'totalAmount', operation: 'sum', field: 'amount' }, { name: 'opportunities', operation: 'count' }],
    } });
    expect(createdReport.status).toBe(201);
    reportId = String((createdReport.body as { id: string }).id);
    const scheduled = await call('POST', `/api/v1/Report/${reportId}/schedule`, { cron: '0 8 * * 1', enabled: false });
    expect(scheduled.status).toBe(200);
    const schedule = scheduled.body as { id: string; enabled: boolean };
    scheduleId = schedule.id;
    expect(schedule.enabled).toBe(false);
    scheduledJobId = `report_${scheduleId}`;
    // Activate only the subscription row for this internal API assertion; keep the global cron row
    // disabled so the worker cannot send mail as a side effect of the test.
    await ctx.database.db.updateTable('report_schedules').set({ enabled: true }).where('id', '=', scheduleId).execute();
    const unauthorizedDelivery = await ctx.app.inject({ method: 'POST', url: '/api/v1/Report/action/deliver-scheduled', headers: { 'x-report-worker-secret': 'wrong-secret' }, payload: { scheduleId } });
    expect(unauthorizedDelivery.statusCode).toBe(401);
    const authorizedDelivery = await ctx.app.inject({ method: 'POST', url: '/api/v1/Report/action/deliver-scheduled', headers: { 'x-report-worker-secret': workerSecret }, payload: { scheduleId } });
    expect(authorizedDelivery.statusCode).toBe(200);
    expect(authorizedDelivery.json()).toMatchObject({ reportId, recipient: 'admin@example.com' });
    expect(String((authorizedDelivery.json() as { csv: string }).csv)).toContain('425');
    const removedSchedule = await call('DELETE', `/api/v1/Report/${reportId}/schedule`, {});
    expect(removedSchedule.status).toBe(200);
    scheduleId = '';
    scheduledJobId = '';
    const removedReport = await call('DELETE', `/api/v1/Report/${reportId}`, {});
    expect(removedReport.status).toBe(200);
    reportId = '';
  });
});
