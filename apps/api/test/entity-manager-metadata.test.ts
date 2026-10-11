import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `p8${Date.now().toString(36)}`;
const ENTITY = 'Account';

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
  return { status: res.statusCode, body };
}

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
});

afterAll(async () => {
  await shutdownApi();
});

describe('Phase 8 — entity layout configuration', () => {
  it('stores panels and rejects a panel that references an unknown field', async () => {
    const ok = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      layouts: {
        detail: [{ entity: ENTITY, type: 'detail', panels: [{ name: 'overview', label: 'Overview', position: 0, fields: ['name', 'industry'] }] }],
      },
    });
    expect(ok.status).toBe(200);
    const layouts = (ok.body['layouts'] ?? {}) as Record<string, { panels: { name: string; fields: string[] }[] }[]>;
    expect(layouts['detail']?.[0]?.panels?.[0]).toMatchObject({ name: 'overview', fields: ['name', 'industry'] });

    const bad = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      layouts: { detail: [{ entity: ENTITY, type: 'detail', panels: [{ name: 'x', fields: ['doesNotExist'] }] }] },
    });
    expect(bad.status).toBe(422);
    expect(errorOf(bad.body)).toBe('VALIDATION_FAILED');
  });
});

describe('Phase 8 — entity index configuration', () => {
  it('accepts a valid index and refuses unknown / reserved field keys', async () => {
    const ok = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      indexes: [{ name: `idx_${runId}`, fields: ['industry'], unique: false }],
    });
    expect(ok.status).toBe(200);
    const indexes = (ok.body['indexes'] ?? []) as { name: string; fields: string[] }[];
    expect(indexes.find((index) => index.name === `idx_${runId}`)).toMatchObject({ fields: ['industry'] });

    const unknownField = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      indexes: [{ name: `bad_${runId}`, fields: ['ghostField'] }],
    });
    expect(unknownField.status).toBe(422);

    const reserved = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      indexes: [{ name: `bad2_${runId}`, fields: ['id'] }],
    });
    expect(reserved.status).toBe(422);

    const empty = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      indexes: [{ name: `bad3_${runId}`, fields: [] }],
    });
    expect(empty.status).toBe(422);
  });
});

describe('Phase 8 — entity ACL metadata', () => {
  it('persists acl metadata on the entity definition and serves it back', async () => {
    const ok = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      acl: { permissions: { [ENTITY]: { read: 'all', edit: 'team', delete: 'no' } } },
    });
    expect(ok.status).toBe(200);
    const acl = (ok.body['acl'] ?? {}) as { permissions?: Record<string, Record<string, string>> };
    expect(acl.permissions?.[ENTITY]).toMatchObject({ read: 'all', edit: 'team', delete: 'no' });

    const read = await call('GET', `/api/v1/Metadata/${ENTITY}`, adminToken);
    const served = (read.body['acl'] ?? {}) as { permissions?: Record<string, Record<string, string>> };
    expect(served.permissions?.[ENTITY]).toMatchObject({ read: 'all', edit: 'team', delete: 'no' });
  });

  it('rejects an acl block with an invalid level', async () => {
    const bad = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      acl: { permissions: { read: 'sometimes' } },
    });
    expect(bad.status).toBe(422);
    expect(errorOf(bad.body)).toBe('VALIDATION_FAILED');
  });
});