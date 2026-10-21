import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20.1 — the settings document registry (PLAN_Phase_20_Settings_UX.md §4.2, §8.1, §13.3).
 *
 * Runs against the configured project database (AGENTS.md §3.1). Only the documents this suite
 * writes are touched, each is snapshotted and restored, and the audit/event rows it produces are
 * deleted by the ids it collected.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const DOCUMENTS = ['brand', 'i18n', 'navigation', 'security', 'fileStorage', 'notifications'];

let ctx: ApiContext;
let regularToken = '';
let eventsBefore: string[] = [];
const restored: Record<string, unknown> = {};

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
  return (body['error'] as { code?: string } | undefined)?.code ?? '';
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  return ((body['error'] as { details?: Record<string, unknown> } | undefined)?.details ?? {}) as Record<string, unknown>;
}

async function readRow(name: string): Promise<unknown> {
  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', name).execute();
  return rows[0]?.data ?? null;
}

async function writeRow(name: string, data: unknown): Promise<void> {
  const serialized = JSON.stringify(data);
  await ctx.database.db
    .insertInto('app_settings')
    .values({ name, data: serialized, modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
    .execute();
}

async function document(name: string): Promise<Record<string, unknown>> {
  return (await call('GET', `/api/v1/Settings/documents/${name}`, ctx.adminToken)).body;
}

beforeAll(async () => {
  ctx = await bootApi();
  regularToken = (await createTestUser(ctx, { userName: `AGENT_TEST p20-${runId}` })).token;
  for (const name of DOCUMENTS) restored[name] = await readRow(name);
  eventsBefore = (await ctx.database.db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute()).map((row) => row.id);
});

afterAll(async () => {
  for (const [name, data] of Object.entries(restored)) {
    if (data === null) await ctx.database.db.deleteFrom('app_settings').where('name', '=', name).execute();
    else await writeRow(name, data);
  }
  const now = (await ctx.database.db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute()).map((row) => row.id);
  const created = now.filter((id) => !eventsBefore.includes(id));
  if (created.length > 0) await ctx.database.db.deleteFrom('outbox_events').where('id', 'in', created).execute();
  await shutdownApi();
});

describe('settings document registry API', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await call('GET', '/api/v1/Settings/documents')).status).toBe(401);
  });

  it('lists the documents the caller may read and refuses the rest', async () => {
    const res = await call('GET', '/api/v1/Settings/documents', ctx.adminToken);
    expect(res.status).toBe(200);
    const names = (res.body['documents'] as { name: string }[]).map((entry) => entry.name);
    for (const name of DOCUMENTS) expect(names).toContain(name);

    // The catalog answers with what this caller may read, so a regular user is offered the brand and
    // locale documents the shell needs, plus the `docs` switches every reader is allowed to know about
    // (PLAN_Phase_21_Documentation.md §6.1), and nothing else.
    const limited = await call('GET', '/api/v1/Settings/documents', regularToken);
    expect(limited.status).toBe(200);
    expect((limited.body['documents'] as { name: string }[]).map((entry) => entry.name)).toEqual(['brand', 'i18n', 'docs']);

    const denied = await call('GET', '/api/v1/Settings/documents/navigation', regularToken);
    expect(denied.status).toBe(403);
    expect(errorOf(denied.body)).toBe('AUTHORIZATION_DENIED');
  });

  it('reads a document as value, version and warnings', async () => {
    const body = await document('navigation');
    expect(body['name']).toBe('navigation');
    expect(typeof body['version']).toBe('number');
    expect(body['value']).toBeTypeOf('object');
    expect(Array.isArray(body['warnings'])).toBe(true);
    expect(body).not.toHaveProperty('data');
  });

  it('applies a write, bumps the version and records who did it', async () => {
    const before = await document('navigation');
    const version = before['version'] as number;
    const res = await call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
      value: { items: [{ key: 'home', enabled: true, order: 15 }] },
      version,
    });
    expect(res.status).toBe(200);
    expect(res.body['version']).toBe(version + 1);
    expect(res.body['updatedBy']).toBeTruthy();
    expect((res.body['value'] as { items: { key: string }[] }).items[0]?.key).toBe('home');
  });

  it('refuses a stale version with 409 and the current version, and does not apply twice', async () => {
    const current = await document('navigation');
    const stale = ((current['version'] as number) || 0) - 1;
    const conflict = await call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
      value: { items: [{ key: 'search', enabled: false }] },
      ...(stale >= 0 ? { version: stale } : {}),
    });
    expect(conflict.status).toBe(409);
    expect(errorOf(conflict.body)).toBe('CONCURRENCY_CONFLICT');
    expect(detailsOf(conflict.body)['currentVersion']).toBe(current['version']);
    expect(detailsOf(conflict.body)['document']).toBe('navigation');

    // The replayed payload did not land: the document still holds the previous write.
    const after = await document('navigation');
    expect(after['version']).toBe(current['version']);
    const items = (after['value'] as { items?: { key: string }[] }).items ?? [];
    expect(items.some((item) => item.key === 'search')).toBe(false);
  });

  it('refuses an invalid document with 422 and leaves the stored row untouched', async () => {
    const before = await document('navigation');
    const invalid = await call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
      value: { items: [{ key: 'home', accent: 'chartreuse' }] },
      version: before['version'] as number,
    });
    expect(invalid.status).toBe(422);
    expect(errorOf(invalid.body)).toBe('VALIDATION_FAILED');
    const issues = detailsOf(invalid.body)['issues'] as { path: string }[];
    expect(issues.some((issue) => issue.path.includes('accent'))).toBe(true);

    const untouched = await document('navigation');
    expect(untouched['version']).toBe(before['version']);
    expect(JSON.stringify(untouched['value'])).toBe(JSON.stringify(before['value']));
  });

  it('is strict about structure and lenient about keys inside an item', async () => {
    const current = await document('navigation');
    const structure = await call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
      value: { items: [], notAProperty: true },
      version: current['version'] as number,
    });
    expect(structure.status).toBe(422);

    const lenient = await call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
      value: { items: [{ key: 'home', enabled: true, order: 10, aFutureProperty: 'kept' }] },
      version: current['version'] as number,
    });
    expect(lenient.status).toBe(200);
    const warnings = lenient.body['warnings'] as { code: string }[];
    expect(warnings.some((warning) => warning.code === 'unrecognizedProperty')).toBe(true);
  });

  it('restores the registered defaults on reset, never null', async () => {
    const res = await call('POST', '/api/v1/Settings/documents/navigation/reset', ctx.adminToken);
    expect(res.status).toBe(200);
    const value = res.body['value'] as { items: unknown[]; groups: unknown[]; accentPalette: string[] };
    expect(value.items).toEqual([]);
    expect(value.groups).toEqual([]);
    expect(value.accentPalette.length).toBeGreaterThan(0);
    expect(res.body['version']).toBeTypeOf('number');
  });

  it('guards the super-administrator documents with the same rule', async () => {
    const denied = await call('POST', '/api/v1/Settings/documents/security', regularToken, { value: { loginNotice: 'nope' } });
    expect(denied.status).toBe(403);
  });

  it('shares validation and versioning with the legacy flat write', async () => {
    const before = await document('brand');
    const legacy = await call('POST', '/api/v1/Settings', ctx.adminToken, { pageTitle: `AGENT_TEST P20 ${runId}` });
    expect(legacy.status).toBe(200);
    expect(legacy.body['pageTitle']).toBe(`AGENT_TEST P20 ${runId}`);

    const after = await document('brand');
    expect((after['value'] as { pageTitle: string }).pageTitle).toBe(`AGENT_TEST P20 ${runId}`);
    expect(after['version'] as number).toBeGreaterThan(before['version'] as number);

    // The legacy route keeps its owning service's rules: the logo is still checked against the
    // attachment table, now through the registry path.
    const notImage = await call('POST', '/api/v1/Settings', ctx.adminToken, { logoAttachmentId: 'AGENT_TEST-missing-attachment' });
    expect(notImage.status).toBe(404);
  });

  it('audits a document change with keys only, never values', async () => {
    const rows = await ctx.database.db
      .selectFrom('schema_changes')
      .select(['operation', 'entity_type', 'payload'])
      .where('operation', '=', 'settings.document.update')
      .orderBy('created_at', 'desc')
      .limit(5)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    const payload = rows[0]?.payload as { document?: string; changedKeys?: string[]; actor?: string | null; value?: unknown };
    expect(payload.document).toBeTypeOf('string');
    expect(Array.isArray(payload.changedKeys)).toBe(true);
    expect(payload).not.toHaveProperty('value');
    expect(payload.actor).toBeTruthy();
  });

  it('publishes settings.document.updated after a successful write', async () => {
    const ids = (await ctx.database.db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute()).map((row) => row.id);
    expect(ids.length).toBeGreaterThan(eventsBefore.length);
  });
});
