import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdw2c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  // enable caseManagement
  await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/settings', headers: { authorization: 'Bearer ' + ctx.adminToken }, payload: { features: { caseManagement: true } } });
});

afterAll(async () => {
  await shutdownApi();
});

describe('phase 19-SD.12 — web-to-case (§5.10)', () => {
  it('creates a case from a public intake payload', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ServiceDesk/action/webToCase',
      payload: { name: `AGENT_TEST_${runId} subject`, requesterName: 'Public User', requesterEmail: 'pub@example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['created']).toBe(true);
    expect(body['caseNumber']).toBeTruthy();
  });

  it('idempotent on the same key', async () => {
    const key = `idem-${runId}`;
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/webToCase', payload: { name: `AGENT_TEST_${runId} subject2`, requesterName: 'Pub', idempotencyKey: key } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/webToCase', payload: { name: `AGENT_TEST_${runId} subject3`, requesterName: 'Pub', idempotencyKey: key } });
    expect(second.statusCode).toBe(200);
    expect((second.json() as Record<string, unknown>)['duplicate']).toBe(true);
  });

  it('rejects invalid email', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/webToCase', payload: { name: `AGENT_TEST_${runId} subject4`, requesterEmail: 'not-an-email' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('honeypot returns fake success', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/ServiceDesk/action/webToCase', payload: { name: `AGENT_TEST_${runId} subject5`, website: 'http://spam.example' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)['created']).toBe(false);
  });
});
