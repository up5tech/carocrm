import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 22.27 — the movement history as a *page*.
 *
 * G69 fixed what the endpoint reads (an arbitrary 200-row sample became the newest movements) and
 * left one thing open in its own words: "the endpoint still exposes a `limit` with no cursor, so a
 * UI that wants to scroll further back needs a follow-up `offset`/cursor contract". This suite is
 * that contract, pinned against the real HTTP API.
 *
 * The claims, one by one:
 *
 *  - the page says where it is: `count`, `total`, `hasMore`, and the `nextCursor` that reaches the
 *    page below it;
 *  - the cursor continues exactly where the page stopped — no row repeated, none skipped;
 *  - a movement written *after* the page was read does not move the boundary, so a deep scroll is
 *    stable (an offset window cannot promise this — G71);
 *  - a cursor this endpoint did not issue is refused with a clear message, not read as page one.
 *
 * Every record carries this run's marks and is removed again in `afterAll` (AGENTS.MD §3.3).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const productIds: string[] = [];
const warehouseIds: string[] = [];

async function setInventory(enabled: boolean): Promise<void> {
  const result = await fix.call('POST', '/api/v1/Sales/action/settings', {
    features: { inventory: enabled },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

/** A warehouse and a product of this run, to hang this test's movements on. */
async function pair(label: string): Promise<{ productId: string; warehouseId: string }> {
  const warehouseId = await fix.create('Warehouse', {
    code: `AGENT-${fix.runId}-${label}`,
    active: true,
  });
  warehouseIds.push(warehouseId);
  const productId = await fix.createProduct({
    sku: `AGENT-${fix.runId}-${label}`,
    productType: 'Goods',
  });
  productIds.push(productId);
  return { productId, warehouseId };
}

/**
 * Move stock the supported way — a reviewed adjustment, requested and then approved — and return
 * the ledger row it wrote. One approval is one movement, so the rows are countable.
 */
async function moveStock(
  productId: string,
  warehouseId: string,
  quantity: string,
): Promise<string> {
  const requested = await fix.call('POST', '/api/v1/Sales/inventory/adjustment', {
    productId,
    warehouseId,
    quantityDelta: quantity,
    reason: `AGENT_TEST_${fix.runId} opening balance`,
  });
  expect(requested.status, JSON.stringify(requested.body)).toBe(201);
  const approved = await fix.call(
    'POST',
    `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
    { action: 'approve' },
  );
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const transactionId = approved.body['transactionId'];
  expect(typeof transactionId, JSON.stringify(approved.body)).toBe('string');
  return String(transactionId);
}

async function historyPage(query: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/Sales/inventory/history${query}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

function idsOf(page: Record<string, unknown>): string[] {
  return (page['list'] as Record<string, unknown>[]).map((row) => String(row['id']));
}

function filterFor(productId: string, warehouseId: string): string {
  return `?productId=${productId}&warehouseId=${warehouseId}`;
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  await setInventory(true);
}, 120_000);

afterAll(async () => {
  await setInventory(false).catch(() => undefined);
  const all = [...fix.ids, ...productIds, ...warehouseIds];
  if (all.length > 0) {
    await ctx.database.db
      .deleteFrom('audit_log')
      .where('record_id', 'in', all)
      .execute()
      .catch(() => undefined);
    await ctx.database.db
      .deleteFrom('entity_records')
      .where('id', 'in', all)
      .execute()
      .catch(() => undefined);
  }
  // The movements, corrections and lines the commands above wrote carry this run's products.
  if (productIds.length > 0) {
    await sql`
      delete from entity_records
      where entity_type in (
        'InventoryTransaction', 'InventoryReservation', 'InventoryAdjustment'
      ) and (attrs ->> 'productId') in (${sql.join(productIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (warehouseIds.length > 0) {
    await sql`
      delete from sales_inventory_stock
      where warehouse_id in (${sql.join(warehouseIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, [
    'Warehouse',
    'InventoryTransaction',
    'InventoryAdjustment',
    'Product',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('the movement history as a page (G69, follow-up)', () => {
  it('says where the page is and whether another one follows', async () => {
    const { productId, warehouseId } = await pair('PAGE');
    const oldest = await moveStock(productId, warehouseId, '1');
    const middle = await moveStock(productId, warehouseId, '2');
    const newest = await moveStock(productId, warehouseId, '3');

    const page = await historyPage(`${filterFor(productId, warehouseId)}&limit=2`);

    expect(page['count']).toBe(2);
    expect(page['total']).toBe(3);
    expect(page['hasMore']).toBe(true);
    expect(page['offset']).toBe(0);
    expect(typeof page['nextCursor']).toBe('string');
    // Newest first — the movement written last leads the page.
    expect(idsOf(page)).toEqual([newest, middle]);
    expect(idsOf(page)).not.toContain(oldest);
  });

  it('continues from the cursor without repeating or skipping a row', async () => {
    const { productId, warehouseId } = await pair('CURSOR');
    const oldest = await moveStock(productId, warehouseId, '1');
    const middle = await moveStock(productId, warehouseId, '2');
    const newest = await moveStock(productId, warehouseId, '3');

    const first = await historyPage(`${filterFor(productId, warehouseId)}&limit=2`);
    const cursor = String(first['nextCursor']);
    const second = await historyPage(
      `${filterFor(productId, warehouseId)}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(idsOf(second)).toEqual([oldest]);
    expect(second['hasMore']).toBe(false);
    expect(second['nextCursor']).toBeUndefined();
    expect(second['count']).toBe(1);
    // The two pages together are the whole ledger, each movement exactly once.
    expect([...idsOf(first), ...idsOf(second)].sort()).toEqual(
      [oldest, middle, newest].sort(),
    );
  });

  it('does not move the cursor’s boundary when a movement is written meanwhile', async () => {
    const { productId, warehouseId } = await pair('STABLE');
    const oldest = await moveStock(productId, warehouseId, '1');
    const middle = await moveStock(productId, warehouseId, '2');

    const first = await historyPage(`${filterFor(productId, warehouseId)}&limit=1`);
    const cursor = String(first['nextCursor']);
    expect(idsOf(first)).toEqual([middle]);

    // A movement written now belongs *before* the boundary, not after it: the walk continues where
    // it stopped instead of restarting (which is what an offset window would do).
    const written = await moveStock(productId, warehouseId, '3');
    const second = await historyPage(
      `${filterFor(productId, warehouseId)}&limit=10&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(idsOf(second)).toEqual([oldest]);
    expect(idsOf(second)).not.toContain(written);
    expect(second['hasMore']).toBe(false);
  });

  it('walks the same pages by offset', async () => {
    const { productId, warehouseId } = await pair('OFFSET');
    const oldest = await moveStock(productId, warehouseId, '1');
    const middle = await moveStock(productId, warehouseId, '2');
    const newest = await moveStock(productId, warehouseId, '3');

    const byOffset = await historyPage(
      `${filterFor(productId, warehouseId)}&limit=2&offset=2`,
    );
    expect(idsOf(byOffset)).toEqual([oldest]);
    expect(byOffset['offset']).toBe(2);
    expect(byOffset['total']).toBe(3);

    // The cursor reaches the same row the offset names — one page, two ways to ask for it.
    const first = await historyPage(`${filterFor(productId, warehouseId)}&limit=2`);
    const byCursor = await historyPage(
      `${filterFor(productId, warehouseId)}&limit=2&cursor=${encodeURIComponent(
        String(first['nextCursor']),
      )}`,
    );
    expect(idsOf(byCursor)).toEqual([oldest]);
    expect(new Set([...idsOf(first), ...idsOf(byCursor)]).size).toBe(3);
    expect([...idsOf(first), ...idsOf(byCursor)].sort()).toEqual(
      [middle, newest, oldest].sort(),
    );
  });

  it('skips the count when the reader does not want it', async () => {
    const { productId, warehouseId } = await pair('TOTAL');
    await moveStock(productId, warehouseId, '1');

    const page = await historyPage(
      `${filterFor(productId, warehouseId)}&limit=1&total=false`,
    );
    expect(page['total']).toBeUndefined();
    expect(page['count']).toBe(1);
    expect(page['hasMore']).toBe(false);
  });

  it('refuses a cursor it did not issue, and a page number that is not one', async () => {
    const { productId, warehouseId } = await pair('REFUSED');

    const badCursor = await fix.call(
      'GET',
      `/api/v1/Sales/inventory/history${filterFor(productId, warehouseId)}&cursor=not-a-cursor`,
    );
    expect(badCursor.status, JSON.stringify(badCursor.body)).toBe(400);
    expect(reasonOf(badCursor)).toMatch(/cursor/i);

    const badOffset = await fix.call(
      'GET',
      `/api/v1/Sales/inventory/history${filterFor(productId, warehouseId)}&offset=-1`,
    );
    expect(badOffset.status, JSON.stringify(badOffset.body)).toBe(400);
    expect(reasonOf(badOffset)).toMatch(/offset/i);
  });
});
