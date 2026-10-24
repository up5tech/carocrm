import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

const runId = Date.now().toString(36);

let ctx: ApiContext;
let dashboardId = '';
let dashletId = '';

beforeAll(async () => {
  ctx = await bootApi();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Dashboard',
    headers: authHeader(ctx.adminToken),
    payload: { name: `AGENT_TEST_${runId}_kpi_ctx`, layout: [], config: {} },
  });
  dashboardId = (created.json() as { id: string }).id;
  const dashlet = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/Dashboard/${dashboardId}/dashlets`,
    headers: authHeader(ctx.adminToken),
    payload: {
      name: `AGENT_TEST_${runId}_kpi`,
      kind: 'kpi',
      position: 0,
      config: { entity: 'Account', target: 5, dateField: 'createdAt', windowDays: 30 },
    },
  });
  dashletId = (dashlet.json() as { id: string }).id;
});

afterAll(async () => {
  if (dashboardId) await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Dashboard/${dashboardId}`, headers: authHeader(ctx.adminToken) });
  await shutdownApi();
});

describe('KPI context', () => {
  it('returns target and previous-window counts', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`,
      headers: authHeader(ctx.adminToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.target).toBe(5);
    expect(typeof body.previous).toBe('number');
  });
});