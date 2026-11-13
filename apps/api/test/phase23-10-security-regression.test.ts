import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.10 — security regression suite (`plans/PLAN_Phase_23_Security_Hardening.md` §16, task 2).
 *
 * The Phase 23.4 suites pin one surface each (attachments + audit history, denial audit). This
 * sibling pins the cells the §18 matrix still lacked a *single* test for: an anonymous caller is
 * refused on every P0 surface (not only on a list), and the field-level ACL still governs the
 * search and CSV-export paths, which read through a different service than a normal list.
 *
 * Runs against the configured primary database (AGENTS.MD §3.1). Every row this file creates is
 * marked `AGENT_TEST_`, and cleanup deletes exactly the ids this run produced.
 */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: string;
  readonly json: Record<string, unknown>;
}

const runId = `p2310_${Date.now().toString(36)}`;

let ctx: ApiContext;
let fieldUser: TestUser;
let noAccess: TestUser;
let plainAccountId = '';
let formulaAccountId = '';
const plainName = `AGENT_TEST_P2310 plain ${runId}`;
const formulaName = `=1+1 AGENT_TEST_P2310 ${runId}`;

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = res.json() as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.statusCode, body: res.body, json };
}

function errorCode(result: CallResult): string {
  const error = result.json['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

beforeAll(async () => {
  ctx = await bootApi();

  await createTestRole(ctx, {
    id: `p2310Field${runId}`,
    name: `P2310 Field ${runId}`,
    permissions: { Account: { read: 'all', create: 'yes', edit: 'all', delete: 'no' } },
    fieldPermissions: { Account: { industry: { read: 'no', edit: 'no' } } },
  });
  await createTestRole(ctx, {
    id: `p2310None${runId}`,
    name: `P2310 None ${runId}`,
    permissions: { Account: { read: 'no', create: 'no', edit: 'no', delete: 'no' } },
  });

  fieldUser = await createTestUser(ctx, { userName: `p2310_field_${runId}`, roleIds: [`p2310Field${runId}`] });
  noAccess = await createTestUser(ctx, { userName: `p2310_none_${runId}`, roleIds: [`p2310None${runId}`] });

  const plain = await call('POST', '/api/v1/Account', ctx.adminToken, { name: plainName, industry: 'Banking', type: 'Customer' });
  expect(plain.status).toBe(201);
  plainAccountId = String(plain.json['id']);

  const formula = await call('POST', '/api/v1/Account', ctx.adminToken, { name: formulaName, type: 'Customer' });
  expect(formula.status).toBe(201);
  formulaAccountId = String(formula.json['id']);
});

afterAll(async () => {
  for (const id of [formulaAccountId, plainAccountId]) {
    if (id !== '') {
      await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Account/${id}`, headers: authHeader(ctx.adminToken) });
    }
  }
  await shutdownApi();
});

describe('Phase 23.10 — anonymous access is refused on every P0 surface', () => {
  const surfaces: { name: string; method: Method; url: () => string; payload?: () => unknown }[] = [
    { name: 'list', method: 'GET', url: () => '/api/v1/Account?maxSize=1' },
    { name: 'detail', method: 'GET', url: () => `/api/v1/Account/${plainAccountId}` },
    { name: 'create', method: 'POST', url: () => '/api/v1/Account', payload: () => ({ name: `AGENT_TEST_P2310 anon ${runId}` }) },
    { name: 'update', method: 'PATCH', url: () => `/api/v1/Account/${plainAccountId}`, payload: () => ({ type: 'Lead' }) },
    { name: 'delete', method: 'DELETE', url: () => `/api/v1/Account/${plainAccountId}` },
    {
      name: 'mass update',
      method: 'POST',
      url: () => '/api/v1/Account/action/massUpdate',
      payload: () => ({ ids: [plainAccountId], data: { type: 'Lead' } }),
    },
    { name: 'audit history', method: 'GET', url: () => `/api/v1/AuditLog?entityType=Account&entityId=${plainAccountId}` },
    { name: 'global search', method: 'GET', url: () => `/api/v1/Search?q=${encodeURIComponent(runId)}` },
    { name: 'entity search', method: 'GET', url: () => `/api/v1/Search/Account?q=${encodeURIComponent(runId)}` },
    { name: 'CSV export', method: 'GET', url: () => '/api/v1/Account/action/export' },
    { name: 'CSV export columns', method: 'GET', url: () => '/api/v1/Account/action/exportColumns' },
    { name: 'own sessions', method: 'GET', url: () => '/api/v1/AppUser/me/sessions' },
    { name: 'attachment metadata', method: 'GET', url: () => '/api/v1/Attachment/00000000-0000-0000-0000-000000000000' },
  ];

  it.each(surfaces)('refuses $name without a principal', async (surface) => {
    const result = await call(surface.method, surface.url(), undefined, surface.payload?.());
    expect(result.status).toBe(401);
    expect(errorCode(result)).toBe('AUTHENTICATION_REQUIRED');
    // The refusal must not echo the record it refused: no name, id or industry value.
    expect(result.body).not.toContain(runId);
    expect(result.body).not.toContain('Banking');
  });

  it('did not create the record the anonymous write attempted', async () => {
    const list = await call(
      'GET',
      `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: `AGENT_TEST_P2310 anon ${runId}` }]))}`,
      ctx.adminToken,
    );
    expect(list.status).toBe(200);
    expect((list.json['list'] as unknown[]).length).toBe(0);
  });
});

describe('Phase 23.10 — field-level ACL survives the search surfaces', () => {
  it('strips a read-denied field from global search results', async () => {
    const admin = await call('GET', `/api/v1/Search?q=${encodeURIComponent(runId)}&entities=Account`, ctx.adminToken);
    expect(admin.status).toBe(200);
    const adminHits = (admin.json['list'] as { entityType: string; record: Record<string, unknown> }[]).filter(
      (hit) => hit.entityType === 'Account',
    );
    expect(adminHits.some((hit) => hit.record['id'] === plainAccountId && hit.record['industry'] === 'Banking')).toBe(true);

    const restricted = await call('GET', `/api/v1/Search?q=${encodeURIComponent(runId)}&entities=Account`, fieldUser.token);
    expect(restricted.status).toBe(200);
    const hits = (restricted.json['list'] as { entityType: string; record: Record<string, unknown> }[]).filter(
      (hit) => hit.entityType === 'Account',
    );
    const ours = hits.find((hit) => hit.record['id'] === plainAccountId);
    expect(ours).toBeDefined();
    expect(ours?.record['industry']).toBeUndefined();
    expect(ours?.record['type']).toBe('Customer');
    expect(restricted.body).not.toContain('Banking');
  });

  it('strips the same field from entity search and does not accept it through the where clause', async () => {
    const search = await call('GET', `/api/v1/Search/Account?q=${encodeURIComponent(runId)}`, fieldUser.token);
    expect(search.status).toBe(200);
    const found = (search.json['list'] as Record<string, unknown>[]).find((row) => row['id'] === plainAccountId);
    expect(found).toBeDefined();
    expect(found?.['industry']).toBeUndefined();

    // A filter on the restricted field must not act as an existence/value oracle.
    const filtered = await call(
      'POST',
      '/api/v1/Search/Account',
      fieldUser.token,
      { where: [{ field: 'industry', operator: 'equals', value: 'Banking' }] },
    );
    expect([200, 403]).toContain(filtered.status);
    expect(filtered.body).not.toContain('Banking');
  });
});

describe('Phase 23.10 — CSV export answers to the same ACL decision', () => {
  it('refuses an export to a caller without read access', async () => {
    const result = await call('GET', '/api/v1/Account/action/export', noAccess.token);
    expect(result.status).toBe(403);
    expect(errorCode(result)).toBe('AUTHORIZATION_DENIED');
    expect(result.body).not.toContain('Banking');
  });

  it('blanks a read-denied column and neutralises a formula in every exported cell', async () => {
    const admin = await call('GET', `/api/v1/Account/action/export?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`, ctx.adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body).toContain('Banking');

    const restricted = await call(
      'GET',
      `/api/v1/Account/action/export?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]))}`,
      fieldUser.token,
    );
    expect(restricted.status).toBe(200);
    expect(restricted.body).not.toContain('Banking');

    const [headerLine = '', ...rows] = restricted.body.trim().split('\r\n');
    const header = headerLine.split(',');
    const industryIndex = header.indexOf('industry');
    expect(industryIndex).toBeGreaterThan(-1);

    const plainRow = rows.find((line) => line.includes(`P2310 plain ${runId}`));
    expect(plainRow).toBeDefined();
    expect(plainRow?.split(',')[industryIndex]).toBe('');

    // A record whose name starts with `=` must not reach the spreadsheet as a live formula.
    const formulaRow = rows.find((line) => line.includes('AGENT_TEST_P2310') && line.includes("'=1+1"));
    expect(formulaRow).toBeDefined();
    // The neutralised value is a cell value, not a formula; the raw value never appears as a cell.
    const cells = formulaRow?.split(',') ?? [];
    expect(cells).toContain(`'${formulaName}`);
    expect(cells).not.toContain(formulaName);
  });
});
