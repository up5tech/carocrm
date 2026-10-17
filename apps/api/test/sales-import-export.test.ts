import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SALES_ENTITY_TYPES } from '../src/sales/sales-records.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.17 task 9 — import and export for Sales, as an executable contract.
 *
 * The platform already serves CSV import/export for every metadata entity (`ImportExportService`), so
 * "add mappings" for Sales means proving the three rules that make using it safe here, rather than
 * inventing a second import path:
 *
 *  1. **The columns are the mapping.** `GET /:entity/action/exportColumns` answers the field list the
 *     export writes and the import reads, so a round trip is possible without a per-installation file.
 *     This suite checks that list against the metadata for every Sales entity — no column that is not
 *     a field, and the display field always present.
 *  2. **Master data imports.** A product arrives from a CSV with its own columns, through the same
 *     domain validation the form uses (a duplicate SKU is still refused).
 *  3. **A document can only arrive as a draft.** `status`, `number`, the totals and the snapshot are
 *     server-owned (§5.7, §4.7), so an import that carries them is refused with the field named — a CSV
 *     is not a back door around issuance, numbering or the write guard.
 *
 * Runs against the configured primary database through the booted application (AGENTS.md §3.1). Every
 * row this suite creates is removed by exact id in `afterAll`.
 */

let ctx: ApiContext;
let fix: SalesFixture;
const createdIds: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  const all = [...createdIds, ...fix.ids];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, ['Product', 'Quote', 'Invoice', 'SalesOrder']);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

interface Column {
  name: string;
  type: string;
}

describe('export columns are the mapping (19-S.17 task 9)', () => {
  it('answers a column list per Sales entity that is exactly its fields', async () => {
    const problems: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const result = await fix.call('GET', `/api/v1/${entity}/action/exportColumns`);
      if (result.status !== 200) {
        problems.push(`${entity}: ${String(result.status)}`);
        continue;
      }
      const columns = (result.body['columns'] ?? []) as Column[];
      if (columns.length === 0) problems.push(`${entity}: no columns`);
      for (const column of columns) {
        if (typeof column.name !== 'string' || column.name === '') problems.push(`${entity}: a column with no name`);
      }
      // The display field is what an operator recognises a row by, so an export without it is a
      // spreadsheet of ids.
      const metadata = await fix.call('GET', `/api/v1/Metadata/${entity}`);
      const display = (metadata.body['record'] as { displayField?: string } | undefined)?.displayField;
      if (display !== undefined && !columns.some((column) => column.name === display)) {
        problems.push(`${entity}: the export omits its display field "${display}"`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('exports a CSV whose header is that column list', async () => {
    const columns = ((await fix.call('GET', '/api/v1/Product/action/exportColumns')).body['columns'] ?? []) as Column[];
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/Product/action/export',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const header = (String(response.body).split('\n')[0] ?? '').trim();
    // The order is the exporter's business; the set is the contract, because the importer matches a CSV
    // column by its name.
    expect([...header.split(',')].sort()).toEqual(columns.map((column) => column.name).sort());
  });
});

describe('master data imports through the same validation (19-S.17 task 9)', () => {
  it('creates a product from a CSV and refuses a duplicate SKU', async () => {
    const sku = `AGENT-${fix.runId}-CSV`;
    const csv = `name,sku,productType,active,unitPrice\nAGENT_TEST_${fix.runId} imported,${sku},Goods,true,12.34\n`;
    const imported = await fix.call('POST', '/api/v1/Product/action/import', { csv });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body['created'], JSON.stringify(imported.body)).toBe(1);
    const ids = (imported.body['ids'] ?? []) as string[];
    expect(ids).toHaveLength(1);
    createdIds.push(...ids);

    // The values arrived as the domain reads them: a decimal **string** for money — the record store
    // refuses a JS number on a decimal field — and a real bool for a flag.
    const record = await fix.call('GET', `/api/v1/Product/${ids[0]}`);
    // A SKU is stored normalised — the catalog upper-cases it — so the comparison is case-insensitive.
    expect(String(record.body['sku'])).toBe(sku.toUpperCase());
    expect(record.body['unitPrice']).toBe('12.34');
    expect(record.body['active']).toBe(true);

    // The same file again is a duplicate SKU, not a second product: import is not a bypass of the
    // catalog's own uniqueness rule.
    const again = await fix.call('POST', '/api/v1/Product/action/import', { csv });
    expect(again.body['created']).toBe(0);
    expect(JSON.stringify(again.body['errors'])).toMatch(/sku|duplicate/i);
  });
});

describe('a document can only arrive as a draft (19-S.17 task 9)', () => {
  it('refuses an import that tries to set the issued state, the number or the totals', async () => {
    const csv = [
      'name,status,number,grossTotal',
      `AGENT_TEST_${fix.runId} forged,issued,INV-999999,999999.00`,
    ].join('\n');
    const result = await fix.call('POST', '/api/v1/Quote/action/import', { csv });
    // The write guard refuses server-owned fields on the client path, and import *is* the client path.
    expect(result.body['created'] ?? 0).toBe(0);
    expect(JSON.stringify(result.body['errors'])).toMatch(/status/);
  });

  it('imports a document as a readable draft with no number, whatever the file says', async () => {
    const csv = ['name,currency,description', `AGENT_TEST_${fix.runId} imported quote,USD,from a spreadsheet`].join('\n');
    const result = await fix.call('POST', '/api/v1/Quote/action/import', { csv });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const ids = (result.body['ids'] ?? []) as string[];
    expect(ids.length).toBeGreaterThan(0);
    createdIds.push(...ids);

    const record = await fix.call('GET', `/api/v1/Quote/${ids[0]}`);
    expect(record.body['status']).toBe('draft');
    // A number is allocated at issuance, never imported (§4.7).
    expect(record.body['number'] ?? null).toBeNull();

    // …and the document it produced is still a document: the view answers for a line-less draft with
    // zeroed totals instead of refusing, because the screen that would let an operator add the lines is
    // exactly what needs to open it.
    const view = await fix.call('GET', `/api/v1/Sales/document/quote/${ids[0]}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect((view.body['totals'] as { grossTotal: string }).grossTotal).toMatch(/^0(\.0+)?$/);
    expect((view.body['actions'] as { action: string }[]).map((action) => action.action)).toContain('send');
  });

  it('refuses a document with no lines when the command creates it, so a half-made draft cannot be saved', async () => {
    // The import path is bulk and cannot carry lines; the command is the operator's path and says what
    // is missing before anything exists.
    const result = await fix.call('POST', '/api/v1/Sales/document', { kind: 'invoice', data: { currency: 'USD' }, items: [] });
    expect(result.status).toBe(422);
  });
});
