import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `d${Date.now().toString(36)}`;
const entity = `AgentProbe${runId.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z0-9]/g, '')}`;

let ctx: ApiContext;
let adminToken = '';
const createdIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorOf(body: Record<string, unknown>): { code: string; message: string; details: Record<string, unknown> } {
  const error = (body['error'] ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
  return { code: error.code ?? '', message: error.message ?? '', details: error.details ?? {} };
}

/** Creates a record and remembers its id so the suite can delete exactly what it made. */
async function createRecord(payload: Record<string, unknown>): Promise<CallResult> {
  const res = await call('POST', `/api/v1/${entity}`, adminToken, { name: `Probe ${runId}`, ...payload });
  const id = res.body['id'];
  if (typeof id === 'string') createdIds.push(id);
  return res;
}

const rules = [
  { name: 'taxRequired', when: { field: 'type', operator: 'equals', value: 'Customer' }, then: { setRequired: ['taxId'], hide: ['industry'] } },
  { name: 'autoLevel', when: { field: 'revenue', operator: 'gt', value: 1000 }, then: { setValues: { level: "number(field('revenue')) > 5000 ? 'Tier A' : 'Tier B'" }, setReadOnly: ['level'] } },
  { name: 'blocked', when: { field: 'type', operator: 'equals', value: 'Blocked' }, then: { error: { message: 'Type Blocked is not allowed here.', fields: ['type'] } } },
  { name: 'partner', when: "field('type') == 'Partner'", then: { setRequired: ['industry'] } },
];

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;

  const created = await call('POST', `/api/v1/Metadata/${entity}`, adminToken, {
    label: 'Agent Probe',
    fields: {
      type: { type: 'varchar', inEdit: true, inDetail: true },
      taxId: { type: 'varchar', inEdit: true, inDetail: true },
      industry: { type: 'varchar', inEdit: true, inDetail: true },
      revenue: { type: 'int', inEdit: true, inDetail: true },
      level: { type: 'varchar', inEdit: true, inDetail: true },
      nameUpper: { type: 'formula', formula: "upper(field('name'))", inDetail: true },
    },
    dynamicLogic: { rules },
  });
  expect(created.status).toBe(200);
});

afterAll(async () => {
  for (const id of createdIds) {
    await call('DELETE', `/api/v1/${entity}/${id}`, adminToken);
  }
  // Take the probe entity out of the app so later suites never see it.
  await call('POST', `/api/v1/Metadata/${entity}`, adminToken, { isEntity: false, dynamicLogic: { rules: [] } });
  await purgeEntityEvents(ctx.database, [entity]);
  await shutdownApi();
});

describe('metadata guard for formulas and dynamic logic (PLAN §21, §22)', () => {
  it('serves the rule set through the metadata API', async () => {
    const res = await call('GET', `/api/v1/Metadata/${entity}`, adminToken);
    expect(res.status).toBe(200);
    const logic = res.body['dynamicLogic'] as { rules: { name: string }[] };
    expect(logic.rules.map((rule) => rule.name)).toEqual(['taxRequired', 'autoLevel', 'blocked', 'partner']);
  });

  it('rejects a rule that references an unknown field', async () => {
    const res = await call('POST', `/api/v1/Metadata/${entity}`, adminToken, {
      dynamicLogic: { rules: [{ name: 'ghost', when: { field: 'noSuchField', operator: 'equals', value: 1 }, then: { setRequired: ['taxId'] } }] },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(errorOf(res.body).details)).toContain('unknown field');
  });

  it('rejects an expression the sandbox cannot parse', async () => {
    const res = await call('POST', `/api/v1/Metadata/${entity}`, adminToken, {
      dynamicLogic: { rules: [{ name: 'bad', when: 'eval("alert(1)")', then: { hide: ['taxId'] } }] },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(errorOf(res.body).details)).toContain('Unknown function');
  });

  it('rejects a formula on a field that is not computed', async () => {
    const res = await call('POST', `/api/v1/Metadata/${entity}`, adminToken, {
      fields: { industry: { type: 'varchar', formula: "upper(field('name'))" } },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(errorOf(res.body).details)).toContain('only allowed on a');
  });

  it('leaves the rule set unchanged after the rejected patches', async () => {
    const res = await call('GET', `/api/v1/Metadata/${entity}`, adminToken);
    const logic = res.body['dynamicLogic'] as { rules: { name: string }[] };
    expect(logic.rules.map((rule) => rule.name)).toEqual(['taxRequired', 'autoLevel', 'blocked', 'partner']);
  });
});

describe('dynamic logic on record writes', () => {
  it('blocks a create that leaves a rule-required field empty', async () => {
    const res = await createRecord({ type: 'Customer' });
    expect(res.status).toBe(422);
    const details = errorOf(res.body).details;
    expect(String(details['taxId'])).toContain('required by a dynamic logic rule');
  });

  it('accepts the same create once the field is filled in', async () => {
    const res = await createRecord({ type: 'Customer', taxId: `TAX-${runId}` });
    expect(res.status).toBe(201);
    expect(res.body['taxId']).toBe(`TAX-${runId}`);
  });

  it('enforces a rule-required field on PATCH of an existing record', async () => {
    const created = await createRecord({ type: 'Lead' });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);

    const res = await call('PATCH', `/api/v1/${entity}/${id}`, adminToken, { type: 'Customer' });
    expect(res.status).toBe(422);
    expect(String(errorOf(res.body).details['taxId'])).toContain('required by a dynamic logic rule');

    // ...and keeps the stored value when the PATCH is rejected.
    const read = await call('GET', `/api/v1/${entity}/${id}`, adminToken);
    expect(read.body['type']).toBe('Lead');
  });

  it('honours a formula-text condition as well as a criteria object', async () => {
    const res = await createRecord({ type: 'Partner' });
    expect(res.status).toBe(422);
    expect(String(errorOf(res.body).details['industry'])).toContain('required by a dynamic logic rule');
  });

  it('refuses a record whose business condition is an error rule', async () => {
    const res = await createRecord({ type: 'Blocked', taxId: `TAX-3-${runId}` });
    expect(res.status).toBe(422);
    expect(JSON.stringify(errorOf(res.body).details)).toContain('Type Blocked is not allowed here.');
  });

  it('computes rule values and refuses a direct write to them', async () => {
    const computed = await createRecord({ revenue: 6000 });
    expect(computed.status).toBe(201);
    expect(computed.body['level']).toBe('Tier A');

    const res = await createRecord({ revenue: 6000, level: 'Tier Z' });
    expect(res.status).toBe(422);
    expect(String(errorOf(res.body).details['level'])).toContain('cannot be set directly');
  });

  it('is bypassed when the rule condition does not match', async () => {
    const res = await createRecord({ type: 'Lead', level: 'Manual' });
    expect(res.status).toBe(201);
    expect(res.body['level']).toBe('Manual');
  });
});

describe('formula fields', () => {
  it('stores the computed value on create and update', async () => {
    const created = await createRecord({ name: `Probe ${runId}` });
    expect(created.status).toBe(201);
    expect(created.body['nameUpper']).toBe(`PROBE ${runId.toUpperCase()}`);

    const id = String(created.body['id']);
    const updated = await call('PATCH', `/api/v1/${entity}/${id}`, adminToken, { name: `Renamed ${runId}` });
    expect(updated.status).toBe(200);
    expect(updated.body['nameUpper']).toBe(`RENAMED ${runId.toUpperCase()}`);
  });

  it('refuses a client-supplied value that differs from the formula', async () => {
    const res = await createRecord({ nameUpper: 'Handwritten' });
    expect(res.status).toBe(422);
    expect(String(errorOf(res.body).details['nameUpper'])).toContain('cannot be set directly');
  });
});

describe('formula tools API (admin only)', () => {
  it('validates expressions without running them', async () => {
    const good = await call('POST', '/api/v1/Formula/validate', adminToken, { expression: "concat(field('name'), ' / 1')" });
    expect(good.status).toBe(200);
    expect(good.body['valid']).toBe(true);

    const bad = await call('POST', '/api/v1/Formula/validate', adminToken, { expression: 'require("fs")' });
    expect(bad.status).toBe(200);
    expect(bad.body['valid']).toBe(false);
    expect(String(bad.body['error'])).toContain('Unknown function');
  });

  it('evaluates an expression against supplied attributes and refuses escapes', async () => {
    const ok = await call('POST', '/api/v1/Formula/evaluate', adminToken, { expression: "upper(field('code'))", attrs: { code: 'abc' } });
    expect(ok.status).toBe(200);
    expect(ok.body['value']).toBe('ABC');

    const escape = await call('POST', '/api/v1/Formula/evaluate', adminToken, { expression: 'process.env' });
    expect(escape.status).toBe(200);
    expect(String(escape.body['error'])).toContain('Unknown variable');
  });

  it('requires an expression string', async () => {
    const res = await call('POST', '/api/v1/Formula/validate', adminToken, {});
    expect(res.status).toBe(422);
    expect(errorOf(res.body).code).toBe('VALIDATION_FAILED');
  });

  it('is denied to a non-admin user', async () => {
    const user = await createTestUser(ctx, { userName: `nologic${runId}` });
    const res = await call('POST', '/api/v1/Formula/evaluate', user.token, { expression: '1 + 1' });
    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('AUTHORIZATION_DENIED');
  });

  it('is not reachable through the generic record controller', async () => {
    const res = await call('GET', `/api/v1/Formula`, adminToken);
    expect([404, 405, 400]).toContain(res.status);
  });
});
