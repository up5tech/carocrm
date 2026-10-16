import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { CallResult, SalesFixture } from './support/sales-fixtures.js';
import { detailsOf, reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.14 — warehouses, the stock ledger, adjustments, transfers and reservations, through the
 * real HTTP API.
 *
 * The acceptance criteria, one by one:
 *
 *  - every physical quantity change has a traceable movement with a source and (where one is needed)
 *    a reason — asserted against the history endpoint;
 *  - concurrent reservations cannot overbook stock under the configured policy — asserted by refusing
 *    an over-reservation under `hard`;
 *  - transfer source and destination effects stay consistent — dispatch removes from the source and
 *    leaves the goods in transit until receipt adds them at the destination;
 *  - stock figures reconcile with the movement ledger.
 *
 * The suite flips `features.inventory` on for its duration and restores it, and it creates only
 * `AGENT_TEST_`-marked records identified by this run's ids (AGENTS.MD §3.3).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const productIds: string[] = [];
const warehouseIds: string[] = [];

async function createWarehouse(label: string): Promise<string> {
  const id = await fix.create('Warehouse', {
    code: `AGENT-${fix.runId}-${label}`,
    active: true,
  });
  warehouseIds.push(id);
  return id;
}

async function createGoods(label: string): Promise<string> {
  const id = await fix.createProduct({
    sku: `AGENT-${fix.runId}-${label}`,
    productType: 'Goods',
  });
  productIds.push(id);
  return id;
}

async function setInventory(enabled: boolean): Promise<void> {
  const result = await fix.call('POST', '/api/v1/Sales/action/settings', {
    features: { inventory: enabled },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function availability(
  productId: string,
  warehouseId: string,
): Promise<Record<string, unknown>> {
  const result = await fix.call(
    'GET',
    `/api/v1/Sales/inventory/availability?productId=${productId}&warehouseId=${warehouseId}`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** Add stock the supported way: a reviewed adjustment, requested and then approved. */
async function addStock(
  productId: string,
  warehouseId: string,
  quantity: string,
): Promise<void> {
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
  // Movements and corrections created internally by the commands above carry this run's products,
  // and so do the documents' own line items.
  if (productIds.length > 0) {
    await sql`
      delete from entity_records
      where entity_type in (
        'InventoryTransaction', 'InventoryReservation', 'InventoryAdjustment', 'TransferOrderItem',
        'SalesOrderItem', 'DeliveryOrderItem'
      ) and (attrs ->> 'productId') in (${sql.join(productIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  // The lockable projection rows for the warehouses this run created, and only those.
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
    'TransferOrder',
    'TransferOrderItem',
    'InventoryReservation',
    'SalesOrder',
    'SalesOrderItem',
    'DeliveryOrder',
    'DeliveryOrderItem',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('inventory enablement and the movement ledger (19-S.14)', () => {
  it('refuses inventory commands while the feature is off, naming the setting', async () => {
    await setInventory(false);
    try {
      const refused = await fix.call('POST', '/api/v1/Sales/inventory/reserve', {
        productId: 'irrelevant',
        quantity: '1',
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(reasonOf(refused)).toMatch(/Inventory is not enabled/);
    } finally {
      await setInventory(true);
    }
  });

  it('records a traceable movement with its source and reason when an adjustment is approved', async () => {
    const warehouseId = await createWarehouse('WH-A');
    const productId = await createGoods('ADJ');

    // A request moves nothing until it is decided (§4.15 "reviewed corrections").
    const requested: CallResult = await fix.call(
      'POST',
      '/api/v1/Sales/inventory/adjustment',
      {
        productId,
        warehouseId,
        quantityDelta: '12',
        reason: `AGENT_TEST_${fix.runId} found in stock`,
      },
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body).toMatchObject({ status: 'pending' });
    expect((await availability(productId, warehouseId))['onHand']).toBe('0');

    const approved = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'applied' });
    expect((await availability(productId, warehouseId))['onHand']).toBe('12');

    // The ledger explains the figure: the movement names its source and its reason.
    const history = await fix.call(
      'GET',
      `/api/v1/Sales/inventory/history?productId=${productId}&warehouseId=${warehouseId}`,
    );
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const list = history.body['list'] as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      transactionType: 'adjustment',
      quantityDelta: '12',
      sourceEntity: 'InventoryAdjustment',
      balanceAfter: '12',
    });
    expect(String(list[0]?.['reason'])).toMatch(/found in stock/);

    // A decided adjustment is final: the record API cannot re-open it.
    const again = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(reasonOf(again)).toMatch(/not allowed from the "applied" state/);
  });

  it('keeps the ledger append-only: the record API cannot write a movement', async () => {
    const warehouseId = await createWarehouse('WH-LEDGER');
    const productId = await createGoods('LEDGER');
    const refused = await fix.call('POST', '/api/v1/InventoryTransaction', {
      name: 'AGENT_TEST forged movement',
      transactionType: 'adjustment',
      productId,
      warehouseId,
      quantityDelta: '1000000',
      occurredAt: new Date().toISOString(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect((await availability(productId, warehouseId))['onHand']).toBe('0');
  });

  it('refuses to take a warehouse below zero by default', async () => {
    const warehouseId = await createWarehouse('WH-NEG');
    const productId = await createGoods('NEG');
    const requested = await fix.call('POST', '/api/v1/Sales/inventory/adjustment', {
      productId,
      warehouseId,
      quantityDelta: '-1',
      reason: `AGENT_TEST_${fix.runId} shrinkage`,
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refused = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(reasonOf(refused)).toMatch(/would go negative/);
    expect(detailsOf(refused)).toMatchObject({ onHand: '0', quantityDelta: '-1' });
  });
});

describe('reservations (19-S.14)', () => {
  it('reserves available stock, refuses an over-reservation, and releases cleanly', async () => {
    const warehouseId = await createWarehouse('WH-RES');
    const productId = await createGoods('RES');
    await addStock(productId, warehouseId, '5');

    const reserved = await fix.call('POST', '/api/v1/Sales/inventory/reserve', {
      productId,
      warehouseId,
      quantity: '2',
      sourceEntity: 'manual',
      sourceId: `AGENT_TEST_${fix.runId}`,
    });
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
    expect(reserved.body).toMatchObject({ status: 'active', quantity: '2' });
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '5',
      reserved: '2',
      available: '3',
    });

    // The hard policy refuses a promise the warehouse cannot keep — the concurrency rule's guard.
    const refused = await fix.call('POST', '/api/v1/Sales/inventory/reserve', {
      productId,
      warehouseId,
      quantity: '4',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(reasonOf(refused)).toMatch(/Only 3 .* available/);

    const released = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/reservation/${String(reserved.body['id'])}/release`,
      { reason: `AGENT_TEST_${fix.runId} not needed` },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body).toMatchObject({ status: 'released' });
    expect(await availability(productId, warehouseId)).toMatchObject({
      reserved: '0',
      available: '5',
    });
  });

  it('cannot overbook stock under concurrent reservations', async () => {
    const warehouseId = await createWarehouse('WH-RACE');
    const productId = await createGoods('RACE');
    await addStock(productId, warehouseId, '5');

    // Two callers each promise the whole warehouse at the same moment. The pair's level row is locked
    // (`SELECT … FOR UPDATE`) for the length of each reservation, so the second caller reads the
    // first's `reserved` figure and is refused — the acceptance criterion for 19-S.14, not merely a
    // sequential re-check.
    const body = {
      productId,
      warehouseId,
      quantity: '5',
      sourceEntity: 'manual',
      sourceId: `AGENT_TEST_${fix.runId}`,
    };
    const [first, second] = await Promise.all([
      fix.call('POST', '/api/v1/Sales/inventory/reserve', body),
      fix.call('POST', '/api/v1/Sales/inventory/reserve', body),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, JSON.stringify([first.body, second.body])).toEqual([201, 422]);
    const refused = first.status === 422 ? first : second;
    expect(reasonOf(refused)).toMatch(/Only 0 .* available/);

    // Exactly one promise exists: the loser wrote neither a row nor a `reserved` figure.
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '5',
      reserved: '5',
      available: '0',
    });
    const active = await fix.call(
      'GET',
      `/api/v1/Sales/inventory/reservations?productId=${productId}&warehouseId=${warehouseId}`,
    );
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body['list']).toHaveLength(1);
  });
});

describe('transfers keep both sides consistent (19-S.14)', () => {
  it('dispatches from the source, holds the goods in transit, then receives at the destination', async () => {
    const source = await createWarehouse('WH-SRC');
    const destination = await createWarehouse('WH-DST');
    const productId = await createGoods('TR');
    await addStock(productId, source, '8');

    const created = await fix.call('POST', '/api/v1/Sales/inventory/transfer', {
      name: `AGENT_TEST_${fix.runId} transfer`,
      sourceWarehouseId: source,
      destinationWarehouseId: destination,
      reason: `AGENT_TEST_${fix.runId} rebalance`,
      items: [{ productId, quantity: '3' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const transferId = String(created.body['id']);
    expect(created.body).toMatchObject({ status: 'draft' });

    const dispatched = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'confirm' },
    );
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body).toMatchObject({ transfer: { status: 'inTransit' } });
    // The source outflow applied; the destination has not received it yet.
    expect((await availability(productId, source))['onHand']).toBe('5');
    expect((await availability(productId, destination))['onHand']).toBe('0');
    // ... and it is visible as incoming rather than lost.
    expect((await availability(productId, destination))['incoming']).toBe('3');

    // A dispatched transfer can no longer be cancelled; it must be received or reversed.
    const cancel = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'cancel', reason: 'AGENT_TEST' },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(422);
    expect(reasonOf(cancel)).toMatch(/not allowed from the "inTransit" state/);

    const received = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'receive' },
    );
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body).toMatchObject({ transfer: { status: 'received' } });
    expect((await availability(productId, destination))['onHand']).toBe('3');
    expect((await availability(productId, destination))['incoming']).toBe('0');

    // Receiving twice is refused — the destination half applies once.
    const again = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'receive' },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(422);

    // Both halves are on the ledger under one transfer group, so neither can be lost.
    const history = await fix.call(
      'GET',
      `/api/v1/Sales/inventory/history?productId=${productId}`,
    );
    const movements = (history.body['list'] as Record<string, unknown>[]).filter(
      (row) => row['transactionType'] === 'transferOut' || row['transactionType'] === 'transferIn',
    );
    expect(movements).toHaveLength(2);
    expect(new Set(movements.map((row) => row['transferGroupId'])).size).toBe(1);

    const reconciled = await fix.call('POST', '/api/v1/Sales/inventory/reconcile', {
      warehouseId: source,
      productId,
    });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    expect(reconciled.body).toMatchObject({ ok: true });
  });
});

describe('stock moves with the selling documents (19-S.14)', () => {
  it('reserves on order confirmation and consumes the reservation as a delivery ships', async () => {
    const warehouseId = await createWarehouse('WH-FLOW');
    const productId = await createGoods('FLOW');
    await addStock(productId, warehouseId, '10');

    const order = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'salesOrder',
      data: {
        name: `AGENT_TEST_${fix.runId} stock order`,
        currency: 'USD',
        orderDate: '2026-10-15',
        warehouseId,
      },
      items: [{ productId, quantity: '4', unitPrice: '10.00', taxRatePercent: '0' }],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = String(order.body['id']);
    fix.ids.push(orderId);

    const confirmed = await fix.call(
      'POST',
      `/api/v1/Sales/document/salesOrder/${orderId}/transition`,
      { action: 'confirm' },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '10',
      reserved: '4',
      available: '6',
    });

    const delivery = await fix.call(
      'POST',
      `/api/v1/Sales/document/salesOrder/${orderId}/convert`,
      { action: 'convertToDeliveryOrder' },
    );
    expect(delivery.status, JSON.stringify(delivery.body)).toBe(201);
    const deliveryId = String(delivery.body['id']);
    fix.ids.push(deliveryId);
    const view = await fix.call('GET', `/api/v1/Sales/document/deliveryOrder/${deliveryId}`);
    const [line] = view.body['items'] as Record<string, unknown>[];
    const patched = await fix.call(
      'PATCH',
      `/api/v1/Sales/document/deliveryOrder/${deliveryId}`,
      {
        items: [
          {
            sourceItemId: line?.['sourceItemId'],
            productId,
            name: line?.['name'],
            quantity: '2',
            unitPrice: '10.00',
            taxRatePercent: '0',
          },
        ],
      },
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const shipped = await fix.call(
      'POST',
      `/api/v1/Sales/document/deliveryOrder/${deliveryId}/transition`,
      { action: 'confirm' },
    );
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    // On-hand went down by what shipped, and the reservation it fulfilled was consumed.
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '8',
      reserved: '2',
      available: '6',
    });

    const reconciled = await fix.call('POST', '/api/v1/Sales/inventory/reconcile', {
      warehouseId,
      productId,
    });
    expect(reconciled.body).toMatchObject({ ok: true, mismatches: [] });

    // Cancelling a confirmed order releases the soft hold it placed. A partly-shipped order cannot be
    // cancelled (the shipment stays on record), so this uses a second, untouched order.
    const second = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'salesOrder',
      data: {
        name: `AGENT_TEST_${fix.runId} second order`,
        currency: 'USD',
        orderDate: '2026-10-15',
        warehouseId,
      },
      items: [{ productId, quantity: '3', unitPrice: '10.00', taxRatePercent: '0' }],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondId = String(second.body['id']);
    fix.ids.push(secondId);
    const secondConfirmed = await fix.call(
      'POST',
      `/api/v1/Sales/document/salesOrder/${secondId}/transition`,
      { action: 'confirm' },
    );
    expect(secondConfirmed.status, JSON.stringify(secondConfirmed.body)).toBe(200);
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '8',
      reserved: '5',
    });

    const cancelled = await fix.call(
      'POST',
      `/api/v1/Sales/document/salesOrder/${secondId}/transition`,
      { action: 'cancel', reason: `AGENT_TEST_${fix.runId} withdrawn` },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await availability(productId, warehouseId)).toMatchObject({
      onHand: '8',
      reserved: '2',
      available: '6',
    });
  });
});
