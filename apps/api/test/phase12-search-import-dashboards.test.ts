import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { csvCell } from '../src/search/csv.js';
import { ImportExportService } from '../src/search/import-export.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface CallResult { status: number; body: unknown; text: string; headers: Record<string, string | string[] | undefined>; }
const runId = `p12${Date.now().toString(36)}`;
let ctx: ApiContext;
let token = '';
async function call(method: Method, url: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: unknown = {};
  try { body = res.json(); } catch { body = {}; }
  return { status: res.statusCode, body, text: res.body, headers: res.headers as Record<string, string | string[] | undefined> };
}
function codeOf(body: unknown): string {
  return String(((body as { error?: { code?: string } }).error ?? {}).code ?? '');
}
beforeAll(async () => { ctx = await bootApi(); token = ctx.adminToken; });
afterAll(async () => {
  await ctx.database.db.deleteFrom('dashlets').where('name', 'like', `AGENT_TEST_${runId}%`).execute().catch(() => undefined);
  await ctx.database.db.deleteFrom('dashboards').where('name', 'like', `AGENT_TEST_${runId}%`).execute().catch(() => undefined);
  await ctx.database.db.deleteFrom('saved_filters').where('name', 'like', `AGENT_TEST_${runId}%`).execute().catch(() => undefined);
  // Safety net for a test that failed before its own cleanup: only records whose name carries this
  // run's unique marker, and only the entity types this suite writes.
  await ctx.database.db
    .deleteFrom('entity_records')
    .where('entity_type', 'in', ['Account'])
    .where('name', 'like', `AGENT_TEST%${runId}%`)
    .execute()
    .catch(() => undefined);
  // This suite writes Account records, so it owns their outbox rows too (AGENTS.md §3.3).
  await purgeEntityEvents(ctx.database, ['Account']);
  await shutdownApi();
});
describe('phase 12 — search', () => {
  it('creates records then finds them via entity + global search', async () => {
    const name = `AGENT_TEST_Search ${runId}`;
    const created = await call('POST', '/api/v1/Account', { name });
    expect(created.status).toBe(201);
    const entity = await call('GET', `/api/v1/Search/Account?q=${encodeURIComponent(runId)}`);
    expect(entity.status).toBe(200);
    const list = (entity.body as { list: { name: string }[] }).list;
    expect(list.some((r) => r.name === name)).toBe(true);
    const global = await call('GET', `/api/v1/Search?q=${encodeURIComponent(runId)}&entities=Account`);
    expect(global.status).toBe(200);
    const hits = (global.body as { list: { entityType: string }[] }).list;
    expect(hits.some((h) => h.entityType === 'Account')).toBe(true);
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('name', '=', name).execute();
  });
  it('rejects empty and oversized queries', async () => {
    const empty = await call('GET', '/api/v1/Search?q=%20');
    expect(empty.status).toBe(422);
    expect(codeOf(empty.body)).toBe('VALIDATION_FAILED');
    const huge = await call('GET', `/api/v1/Search?q=${'x'.repeat(201)}`);
    expect(huge.status).toBe(422);
  });
  it('returns 404 for unknown entity', async () => {
    const res = await call('GET', '/api/v1/Search/Nope?q=x');
    expect(res.status).toBe(404);
  });
});
describe('phase 12 — saved filters', () => {
  it('creates, lists, runs and deletes a filter', async () => {
    const name = `AGENT_TEST_${runId}_filter`;
    const created = await call('POST', '/api/v1/SavedFilter', { name, entityType: 'Account', criteria: [{ field: 'name', operator: 'like', value: runId }], visibility: 'private' });
    expect(created.status).toBe(201);
    const id = String((created.body as { id: string }).id);
    const listed = await call('GET', '/api/v1/SavedFilter?entityType=Account');
    expect(listed.status).toBe(200);
    expect(((listed.body as unknown[]) as { id: string }[]).some((f) => f.id === id)).toBe(true);
    const run = await call('POST', `/api/v1/SavedFilter/${id}/action/run`, {});
    expect(run.status).toBe(200);
    expect((run.body as { filter: { id: string } }).filter.id).toBe(id);
    const patched = await call('PATCH', `/api/v1/SavedFilter/${id}`, { name: `${name}-2` });
    expect(patched.status).toBe(200);
    const removed = await call('DELETE', `/api/v1/SavedFilter/${id}`);
    expect(removed.status).toBe(200);
  });
});
describe('phase 12 — import/export', () => {
  it('imports CSV then exports it back', async () => {
    const name = `AGENT_TEST_Imp ${runId}`;
    const csv = `name,website\n"${name}",https://example.com\n"Bad row",not-a-url\n`;
    const imported = await call('POST', '/api/v1/Account/action/import', { csv });
    expect(imported.status).toBe(200);
    const result = imported.body as { created: number; errors: { row: number }[] };
    expect(result.created).toBeGreaterThanOrEqual(1);
    const exported = await call('POST', '/api/v1/Account/action/export', { where: [{ field: 'name', operator: 'like', value: runId }] });
    expect(exported.status).toBe(200);
    expect(exported.text).toContain(name);
    expect(String(exported.headers['content-type'] ?? '')).toContain('text/csv');
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('name', 'like', `AGENT_TEST_%${runId}%`).execute();
  });
  it('rejects unknown import columns', async () => {
    const res = await call('POST', '/api/v1/Account/action/import', { csv: 'nope\nx\n' });
    expect(res.status).toBe(422);
  });
});
describe('phase 12 — dashboards', () => {
  it('creates dashboard + dashlets and runs them', async () => {
    const name = `AGENT_TEST_${runId}_dash`;
    const created = await call('POST', '/api/v1/Dashboard', { name, layout: [], config: {} });
    expect(created.status).toBe(201);
    const id = String((created.body as { id: string }).id);
    const kpi = await call('POST', `/api/v1/Dashboard/${id}/dashlets`, { name: `AGENT_TEST_${runId}_kpi`, kind: 'kpi', position: 0, config: { entity: 'Account' } });
    expect(kpi.status).toBe(201);
    const kpiId = String((kpi.body as { id: string }).id);
    const run = await call('POST', `/api/v1/Dashboard/${id}/dashlets/${kpiId}/action/run`, {});
    expect(run.status).toBe(200);
    expect((run.body as { kind: string }).kind).toBe('kpi');
    const chart = await call('POST', `/api/v1/Dashboard/${id}/dashlets`, { name: `AGENT_TEST_${runId}_chart`, kind: 'chart', position: 1, config: { entity: 'Account', groupBy: 'type', maxSize: 10 } });
    expect(chart.status).toBe(201);
    const chartId = String((chart.body as { id: string }).id);
    const runChart = await call('GET', `/api/v1/Dashboard/${id}/dashlets/${chartId}/action/run`);
    expect(runChart.status).toBe(200);
    expect(Array.isArray((runChart.body as { groups: unknown[] }).groups)).toBe(true);
    const bad = await call('POST', `/api/v1/Dashboard/${id}/dashlets`, { name: 'bad', kind: 'chart', position: 2, config: { entity: 'Nope' } });
    expect(bad.status).toBe(404);
    const removed = await call('DELETE', `/api/v1/Dashboard/${id}`);
    expect(removed.status).toBe(200);
  });
});
describe('phase 12 — csv helpers', () => {
  it('neutralises cells a spreadsheet would execute', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});
describe('phase 12 — search field coverage', () => {
  it('matches the indexed email key and an exact id', async () => {
    const created = await call('POST', '/api/v1/Account', { name: `AGENT_TEST_Cov ${runId}`, emailAddress: `x${runId}@example.com` });
    expect(created.status).toBe(201);
    const id = String((created.body as { id: string }).id);
    // Only emailAddress can match this term, so the assertion covers the attrs trigram path.
    const byEmail = await call('GET', `/api/v1/Search/Account?q=${encodeURIComponent(`${runId}@example`)}`);
    expect(((byEmail.body as { list: { id: string }[] }).list).some((r) => r.id === id)).toBe(true);
    const byId = await call('GET', `/api/v1/Search/Account?q=${encodeURIComponent(id)}`);
    expect(((byId.body as { list: { id: string }[] }).list).some((r) => r.id === id)).toBe(true);
    await ctx.database.db.deleteFrom('entity_records').where('id', '=', id).execute();
  });
});
describe('phase 12 — export guards', () => {
  it('escapes a stored formula when exporting', async () => {
    const name = `AGENT_TEST_Csv ${runId}`;
    const imported = await call('POST', '/api/v1/Account/action/import', {
      csv: `name,type\n"${name}","=HYPERLINK(""http://evil.example"")"\n`,
    });
    expect(imported.status).toBe(200);
    const exported = await call('POST', '/api/v1/Account/action/export', { where: [{ field: 'name', operator: 'equals', value: name }] });
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("'=HYPERLINK");
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'Account').where('name', '=', name).execute();
  });
});
describe('phase 12 — export paging', () => {
  it('walks every query-engine page instead of stopping at the 500-row clamp', async () => {
    const PAGE_CLAMP = 500; // packages/query-engine MAX_MAX_SIZE
    const total = 1_200;
    const all = Array.from({ length: total }, (_, i) => ({ id: `id${String(i)}`, name: `Row ${String(i)}` }));
    const seen: number[] = [];
    const entities = {
      list: async (_entity: string, query: Record<string, unknown>) => {
        const offset = Number(query['offset'] ?? 0);
        const size = Math.min(Number(query['maxSize'] ?? 20), PAGE_CLAMP);
        seen.push(size);
        const list = all.slice(offset, offset + size);
        return { list, offset, count: list.length };
      },
    };
    const metadata = {
      ensureLoaded: () => undefined,
      registry: {
        hasEntity: () => true,
        getFields: () => ({ name: { type: 'varchar' } }),
      },
    };
    const acl = { assertAccess: async () => 'yes' };
    const service = new ImportExportService(
      entities as unknown as ConstructorParameters<typeof ImportExportService>[0],
      metadata as unknown as ConstructorParameters<typeof ImportExportService>[1],
      acl as unknown as ConstructorParameters<typeof ImportExportService>[2],
    );
    const out = await service.exportCsv('Account', {});
    expect(out.count).toBe(total);
    expect(seen).toEqual([PAGE_CLAMP, PAGE_CLAMP, PAGE_CLAMP]);
    expect(out.csv).toContain('Row 1199');
    expect(out.csv.split('\n').length).toBe(total + 2);
  });
});
describe('phase 12 — dashlet scale behaviour', () => {
  it('honours maxSize for a list and counts through the query engine', async () => {
    const marker = `AGENT_TEST_Dsz${runId}`;
    const ids: string[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const created = await call('POST', '/api/v1/Account', { name: `${marker}${suffix}` });
      expect(created.status).toBe(201);
      ids.push(String((created.body as { id: string }).id));
    }
    const dash = await call('POST', '/api/v1/Dashboard', { name: `AGENT_TEST_${runId}_sz`, layout: [], config: {} });
    const dashId = String((dash.body as { id: string }).id);
    const where = [{ field: 'name', operator: 'like', value: marker }];
    const list = await call('POST', `/api/v1/Dashboard/${dashId}/dashlets`, {
      name: `AGENT_TEST_${runId}_szlist`, kind: 'list', position: 0, config: { entity: 'Account', where, maxSize: 2 },
    });
    expect(list.status).toBe(201);
    const ran = await call('POST', `/api/v1/Dashboard/${dashId}/dashlets/${String((list.body as { id: string }).id)}/action/run`, {});
    expect(ran.status).toBe(200);
    const body = ran.body as { count: number; list: unknown[]; truncated: boolean };
    expect(body.list.length).toBe(2);
    expect(body.count).toBeGreaterThanOrEqual(3);
    expect(body.truncated).toBe(true);
    const kpi = await call('POST', `/api/v1/Dashboard/${dashId}/dashlets`, {
      name: `AGENT_TEST_${runId}_szkpi`, kind: 'kpi', position: 1, config: { entity: 'Account', where },
    });
    expect(kpi.status).toBe(201);
    const ranKpi = await call('GET', `/api/v1/Dashboard/${dashId}/dashlets/${String((kpi.body as { id: string }).id)}/action/run`);
    expect(ranKpi.status).toBe(200);
    expect((ranKpi.body as { count: number }).count).toBeGreaterThanOrEqual(3);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', ids).execute();
  });
});
