import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly versionHeader?: string;
}

const runId = `m${Date.now().toString(36)}`;
const newField = `contractEnd${runId.replace(/^\w/, (c) => c.toUpperCase())}`;
const disableField = `legacyNote${runId.replace(/^\w/, (c) => c.toUpperCase())}`;

let ctx: ApiContext;
let adminToken = '';

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
  const header = res.headers['x-metadata-version'];
  return { status: res.statusCode, body, versionHeader: Array.isArray(header) ? header[0] : header };
}

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

function fieldsOf(body: Record<string, unknown>): Record<string, { type: string }> {
  return (body['fields'] ?? {}) as Record<string, { type: string }>;
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
});

afterAll(async () => {
  await shutdownApi();
});

describe('metadata API', () => {
  it('requires authentication', async () => {
    const res = await call('GET', '/api/v1/Metadata');
    expect(res.status).toBe(401);
    expect(errorOf(res.body)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns the full metadata map with a version header', async () => {
    const res = await call('GET', '/api/v1/Metadata', adminToken);
    expect(res.status).toBe(200);
    expect(typeof res.versionHeader).toBe('string');
    const account = res.body['Account'] as Record<string, unknown> | undefined;
    expect(account).toBeDefined();
    expect(Object.keys(fieldsOf(account ?? {}))).toEqual(
      expect.arrayContaining(['name', 'website', 'industry', 'assignedUserId', 'teams']),
    );
  });

  it('serves a single entity definition and 404s for unknown entities', async () => {
    const one = await call('GET', '/api/v1/Metadata/Account', adminToken);
    expect(one.status).toBe(200);
    expect(one.body['name']).toBe('Account');
    expect(fieldsOf(one.body)['industry']?.type).toBe('varchar');

    const missing = await call('GET', '/api/v1/Metadata/NoSuchEntity', adminToken);
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe('NOT_FOUND');
  });

  it('admin patch adds a field, persists the override and records a schema change', async () => {
    const before = await call('GET', '/api/v1/Metadata', adminToken);

    const patched = await call('POST', '/api/v1/Metadata/Account', adminToken, {
      fields: {
        [newField]: { type: 'date', label: 'Contract end', inList: true, inDetail: true, inEdit: true },
        [disableField]: { type: 'varchar' },
      },
    });
    expect(patched.status).toBe(200);
    expect(fieldsOf(patched.body)[newField]?.type).toBe('date');

    const after = await call('GET', '/api/v1/Metadata/Account', adminToken);
    expect(fieldsOf(after.body)[newField]?.type).toBe('date');
    expect(Number(after.versionHeader)).toBeGreaterThan(Number(before.versionHeader ?? 0));

    // existing fields survive the shallow merge
    expect(fieldsOf(after.body)['website']?.type).toBe('url');
    const relations = (after.body['relations'] ?? {}) as Record<string, { target: string }>;
    expect(relations['contacts']?.target).toBe('Contact');

    const override = await ctx.database.db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', 'entity')
      .executeTakeFirst();
    const entityScope = (override?.data as { entity?: Record<string, { fields?: Record<string, unknown> }> })?.entity;
    expect(entityScope?.['Account']?.fields?.[newField]).toBeDefined();

    const change = await ctx.database.db
      .selectFrom('schema_changes')
      .select(['operation', 'entity_type', 'status'])
      .where('entity_type', '=', 'Account')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    expect(change).toMatchObject({ operation: 'entity.update', entity_type: 'Account', status: 'applied' });

    // the new field is immediately usable through the generic record API
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: authHeader(adminToken),
      payload: { name: `Metadata ${runId}`, [newField]: '2026-12-31' },
    });
    expect(created.statusCode).toBe(201);
    expect(String((created.json() as Record<string, unknown>)[newField])).toContain('2026-12-31');
  });

  it('rejects an invalid patch without touching the registry', async () => {
    const res = await call('POST', '/api/v1/Metadata/Account', adminToken, { fields: { broken: { label: 'no type' } } });
    expect(res.status).toBe(422);
    expect(errorOf(res.body)).toBe('VALIDATION_FAILED');

    const after = await call('GET', '/api/v1/Metadata/Account', adminToken);
    expect(fieldsOf(after.body)['broken']).toBeUndefined();
  });

  it('disables a field via DELETE /Metadata/:entity/Field/:field', async () => {
    const res = await call('DELETE', `/api/v1/Metadata/Account/Field/${disableField}`, adminToken);
    expect(res.status).toBe(200);
    expect(fieldsOf(res.body)[disableField]?.type).toBe('disabled');

    const missing = await call('DELETE', '/api/v1/Metadata/Account/Field/noSuchField', adminToken);
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe('NOT_FOUND');
  });

  it('denies metadata writes to non-admin users', async () => {
    const plain = await createTestUser(ctx, { userName: `meta_plain_${runId}`, roleIds: ['noAccess'] });

    const patch = await call('POST', '/api/v1/Metadata/Account', plain.token, { fields: { sneaky: { type: 'varchar' } } });
    expect(patch.status).toBe(403);
    expect(errorOf(patch.body)).toBe('AUTHORIZATION_DENIED');

    const disable = await call('DELETE', '/api/v1/Metadata/Account/Field/industry', plain.token);
    expect(disable.status).toBe(403);

    const read = await call('GET', '/api/v1/Metadata', plain.token);
    expect(read.status).toBe(200);
    expect(fieldsOf(read.body)['sneaky']).toBeUndefined();
  });
});
