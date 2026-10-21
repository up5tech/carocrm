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

/**
 * Phase 20.18 — the record-page relation tabs (PLAN_Phase_20_Settings_UX.md §5.11).
 *
 * The arrangement is entity metadata: it belongs to the entity's detail layout, so it is written
 * through the same `POST /Metadata/:entity` route as the panels. The rules are the schema's — a
 * relation belongs to at most one tab, and a tab may only name a relation the entity has.
 */
describe('Phase 20.18 — record-page relation tabs', () => {
  const arrangement = {
    mode: 'tabs',
    tabs: [
      { id: 'people', label: 'People', order: 0, relations: ['contacts'] },
      { id: 'commercial', label: 'Commercial', order: 1, relations: ['quotes', 'invoices'] },
    ],
  };

  afterAll(async () => {
    // Leave the entity on the stacked page, exactly as it was before the test.
    await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { detailTabs: { mode: 'stacked', tabs: [] } });
  });

  it('stores the arrangement on the entity and serves it back', async () => {
    const ok = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { detailTabs: arrangement });
    expect(ok.status).toBe(200);
    expect(ok.body['detailTabs']).toMatchObject({ mode: 'tabs' });

    const read = await call('GET', `/api/v1/Metadata/${ENTITY}`, adminToken);
    const served = read.body['detailTabs'] as { mode?: string; tabs?: { id: string }[] };
    expect(served.mode).toBe('tabs');
    expect(served.tabs?.map((tab) => tab.id)).toEqual(['people', 'commercial']);

    // The record page reads the whole metadata document, not one entity at a time, so the section
    // has to survive the list route and the label translation it applies.
    const bulk = await call('GET', '/api/v1/Metadata', adminToken);
    const fromList = (bulk.body[ENTITY] as { detailTabs?: { mode?: string } } | undefined)?.detailTabs;
    expect(fromList?.mode).toBe('tabs');
  });

  it('refuses a relation listed in two tabs', async () => {
    const duplicated = {
      mode: 'tabs',
      tabs: [
        { id: 'a', label: 'A', order: 0, relations: ['contacts'] },
        { id: 'b', label: 'B', order: 1, relations: ['contacts'] },
      ],
    };
    const refused = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { detailTabs: duplicated });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body)).toBe('VALIDATION_FAILED');
  });

  it('refuses a tab that names a relation the entity does not have', async () => {
    const unknown = {
      mode: 'tabs',
      tabs: [{ id: 'x', label: 'X', order: 0, relations: ['aRelationThatNoLongerExists'] }],
    };
    const refused = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { detailTabs: unknown });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body)).toBe('VALIDATION_FAILED');
  });

  it('leaves the stored arrangement untouched when a write is refused', async () => {
    const read = await call('GET', `/api/v1/Metadata/${ENTITY}`, adminToken);
    const served = read.body['detailTabs'] as { mode?: string; tabs?: { id: string }[] };
    expect(served.mode).toBe('tabs');
    expect(served.tabs?.map((tab) => tab.id)).toEqual(['people', 'commercial']);
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

describe('entity appearance metadata', () => {
  it('stores an entity icon and lets it be cleared back to the default', async () => {
    const set = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { icon: 'StarOutlined' });
    expect(set.status).toBe(200);
    expect(set.body['icon']).toBe('StarOutlined');

    const cleared = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { icon: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body['icon']).toBeNull();
  });

  it('rejects an icon name that is not a plain short string', async () => {
    const bad = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, { icon: 'x'.repeat(80) });
    expect(bad.status).toBe(422);
    expect(errorOf(bad.body)).toBe('VALIDATION_FAILED');
  });

  it('labels an existing relation and clears the label again', async () => {
    const read = await call('GET', `/api/v1/Metadata/${ENTITY}`, adminToken);
    const relations = (read.body['relations'] ?? {}) as Record<string, Record<string, unknown>>;
    const name = Object.keys(relations)[0];
    expect(name).toBeDefined();

    const labelled = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      relations: { [name as string]: { ...relations[name as string], label: 'Related accounts' } },
    });
    expect(labelled.status).toBe(200);
    expect((labelled.body['relations'] as Record<string, { label?: string }>)[name as string]?.label).toBe('Related accounts');

    const cleared = await call('POST', `/api/v1/Metadata/${ENTITY}`, adminToken, {
      relations: { [name as string]: { ...relations[name as string], label: null } },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body['relations'] as Record<string, { label?: string | null }>)[name as string]?.label).toBeNull();
  });
});