import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';
import type { CallResult, SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.15 — product variants, batch/serial tracking and removal policies, through the real
 * HTTP API.
 *
 * The acceptance criteria, one by one:
 *
 *  - inventory identity remains correct per product variant, batch or serial — asserted against the
 *    batch/serial views and the identity section of `POST /inventory/reconcile`;
 *  - expired/invalid lots are not selected when the policy forbids them — FEFO suggestions and the
 *    movement actually applied both exclude an expired lot, while an explicit operator choice may
 *    still ship it;
 *  - transfers and returns preserve batch/serial traceability — a transfer receive re-applies the
 *    dispatch's own lot split and serials, and a restocked return comes back into the lot it names;
 *  - what the line editor's suggestion shows is what the confirmation later writes (task 7).
 *
 * Every setting the suite flips is restored in `afterAll`, and only `AGENT_TEST_`-marked records
 * identified by this run's ids are touched (AGENTS.MD §3.3).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const productIds: string[] = [];
const warehouseIds: string[] = [];
const recordIds: string[] = [];
const documents: { kind: string; id: string }[] = [];
const transferIds: string[] = [];

let previousSettings: unknown;
let supplierId = '';
let supplierPriceId = '';
let sequence = 0;
let wh1 = '';
let wh2 = '';
/** The lot-tracked product the lots, transfer and return suites share. */
let batchProduct = '';
/** A product whose stock predates lot tracking — the reconcile's deliberate unattributed remainder. */
let unattributedProduct = '';

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await fix.call('POST', '/api/v1/Sales/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function createWarehouse(label: string): Promise<string> {
  const id = await fix.create('Warehouse', {
    code: `AGENT-${fix.runId}-${label}`,
    active: true,
  });
  warehouseIds.push(id);
  return id;
}

async function createTrackedProduct(
  label: string,
  stockTracking: 'none' | 'batch' | 'serial',
): Promise<string> {
  const id = await fix.createProduct({
    sku: `AGENT-${fix.runId}-${label}`,
    productType: 'Goods',
    unitPrice: '10.00',
    stockTracking,
  });
  productIds.push(id);
  return id;
}

async function transition(kind: string, id: string, action: string, reason?: string) {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, {
    action,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function readDocument(kind: string, id: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** Request a reviewed correction; the caller decides whether to approve it. */
async function requestAdjustment(
  productId: string,
  quantityDelta: string,
  extra: Record<string, unknown> = {},
): Promise<CallResult> {
  return await fix.call('POST', '/api/v1/Sales/inventory/adjustment', {
    productId,
    warehouseId: wh1,
    quantityDelta,
    reason: `AGENT_TEST_${fix.runId} stock identity`,
    ...extra,
  });
}

/** Add (or write off) stock the supported way: requested, then approved. */
async function adjust(
  productId: string,
  quantityDelta: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const requested = await requestAdjustment(productId, quantityDelta, extra);
  expect(requested.status, JSON.stringify(requested.body)).toBe(201);
  const approved = await fix.call(
    'POST',
    `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
    { action: 'approve' },
  );
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
}

async function availability(productId: string, warehouseId = wh1): Promise<Record<string, unknown>> {
  const result = await fix.call(
    'GET',
    `/api/v1/Sales/inventory/availability?productId=${productId}&warehouseId=${warehouseId}`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function batchStock(
  productId: string,
  warehouseId = wh1,
): Promise<Record<string, unknown>[]> {
  const result = await fix.call(
    'GET',
    `/api/v1/Sales/inventory/batches?productId=${productId}&warehouseId=${warehouseId}`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body['list'] as Record<string, unknown>[];
}

async function lotOf(
  productId: string,
  batchNumber: string,
  warehouseId = wh1,
): Promise<Record<string, unknown> | undefined> {
  return (await batchStock(productId, warehouseId)).find(
    (row) => row['batchNumber'] === batchNumber,
  );
}

async function serialsOf(
  productId: string,
  warehouseId?: string,
  status?: string,
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({ productId });
  if (warehouseId !== undefined) query.set('warehouseId', warehouseId);
  if (status !== undefined) query.set('status', status);
  const result = await fix.call('GET', `/api/v1/Sales/inventory/serials?${query.toString()}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body['list'] as Record<string, unknown>[];
}

async function suggestion(
  productId: string,
  quantity: string,
  warehouseId = wh1,
): Promise<Record<string, unknown>> {
  const result = await fix.call(
    'GET',
    `/api/v1/Sales/inventory/picking-suggestions?productId=${productId}&warehouseId=${warehouseId}&quantity=${quantity}`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** The ledger rows one document produced, newest first. */
async function movementsFor(
  sourceEntity: string,
  sourceId: string,
): Promise<Record<string, unknown>[]> {
  const result = await fix.call(
    'GET',
    `/api/v1/Sales/inventory/history?limit=200`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return (result.body['list'] as Record<string, unknown>[]).filter(
    (row) => row['sourceEntity'] === sourceEntity && row['sourceId'] === sourceId,
  );
}

/** A standalone delivery order for `quantity` units, drawn straight on the warehouse. */
async function createDelivery(
  productId: string,
  quantity: string,
  warehouseId: string,
  lineExtra: Record<string, unknown> = {},
): Promise<string> {
  sequence += 1;
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'deliveryOrder',
    data: {
      name: `AGENT_TEST_${fix.runId} DO ${String(sequence)}`,
      currency: 'USD',
      deliveryDate: '2026-10-15',
      warehouseId,
    },
    items: [
      {
        productId,
        quantity,
        unitPrice: '10.00',
        taxRatePercent: '0',
        ...lineExtra,
      },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  documents.push({ kind: 'deliveryOrder', id });
  return id;
}

/** Receive `quantity` of `productId` into `lot` through the purchasing flow (supplier → PO → receipt). */
async function receiveLot(
  productId: string,
  quantity: string,
  lot: {
    batchNumber: string;
    manufacturingDate?: string;
    expiryDate?: string;
  },
): Promise<void> {
  if (supplierId === '') {
    supplierId = await fix.createSupplier({ currency: 'USD' });
    supplierPriceId = await fix.createSupplierPrice(supplierId, productId, {
      unitPrice: '4.20',
      currency: 'USD',
    });
  }
  sequence += 1;
  const order = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'purchaseOrder',
    data: {
      name: `AGENT_TEST_${fix.runId} PO ${String(sequence)}`,
      supplierId,
      currency: 'USD',
      orderDate: '2026-10-15',
      warehouseId: wh1,
    },
    items: [
      {
        productId,
        quantity,
        unitPrice: '4.20',
        taxRatePercent: '0',
        supplierProductPriceId: supplierPriceId,
      },
    ],
  });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const orderId = String(order.body['id']);
  documents.push({ kind: 'purchaseOrder', id: orderId });
  expect((await transition('purchaseOrder', orderId, 'confirm')).status).toBe(200);

  const converted = await fix.call(
    'POST',
    `/api/v1/Sales/document/purchaseOrder/${orderId}/convert`,
    { action: 'convertToReceiptOrder' },
  );
  expect(converted.status, JSON.stringify(converted.body)).toBe(201);
  const receiptId = String(converted.body['id']);
  documents.push({ kind: 'receiptOrder', id: receiptId });
  const view = await readDocument('receiptOrder', receiptId);
  const [line] = (view['items'] as Record<string, unknown>[]).slice(0, 1);
  const patched = await fix.call('PATCH', `/api/v1/Sales/document/receiptOrder/${receiptId}`, {
    items: [
      {
        sourceItemId: line?.['sourceItemId'],
        productId: line?.['productId'],
        quantity,
        unitPrice: '4.20',
        taxRatePercent: '0',
        supplierProductPriceId: supplierPriceId,
        batchNumber: lot.batchNumber,
        ...(lot.manufacturingDate === undefined
          ? {}
          : { manufacturingDate: lot.manufacturingDate }),
        ...(lot.expiryDate === undefined ? {} : { expiryDate: lot.expiryDate }),
      },
    ],
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const confirmed = await transition('receiptOrder', receiptId, 'confirm');
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  const current = await fix.call('GET', '/api/v1/Sales/action/settings');
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  previousSettings = (current.body as { settings: unknown }).settings;
  wh1 = await createWarehouse('15a');
  wh2 = await createWarehouse('15b');
  await setSettings({
    features: { inventory: true, purchases: true, productVariants: true },
    inventory: {
      removalPolicy: 'fifo',
      excludeExpiredStock: true,
      adjustmentApprovalRequired: true,
      defaultWarehouseId: null,
    },
    variants: {
      attributes: [
        { code: 'size', label: 'Size' },
        { code: 'color', label: 'Colour' },
      ],
      requireAllAttributes: true,
    },
  });
}, 120_000);

afterAll(async () => {
  if (previousSettings !== undefined) {
    await setSettings(previousSettings as Record<string, unknown>).catch(() => undefined);
  }
  const all = [...fix.ids, ...recordIds, ...productIds, ...warehouseIds, ...documents.map((each) => each.id), ...transferIds];
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
  if (productIds.length > 0) {
    await sql`
      delete from entity_records
      where entity_type in (
        'InventoryTransaction', 'InventoryReservation', 'InventoryAdjustment',
        'TransferOrder', 'TransferOrderItem',
        'InventoryBatch', 'InventorySerial',
        'SupplierProductPrice', 'Supplier',
        'SalesOrderItem', 'DeliveryOrderItem', 'ReturnOrderItem',
        'PurchaseOrderItem', 'ReceiptOrderItem'
      ) and (attrs ->> 'productId') in (${sql.join(productIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (warehouseIds.length > 0) {
    await sql`
      delete from sales_inventory_stock where warehouse_id in (${sql.join(warehouseIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`
      delete from sales_inventory_batch_stock where warehouse_id in (${sql.join(warehouseIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  await shutdownApi(ctx);
});

describe('19-S.15 — product variants (§4.2)', () => {
  it('accepts a product that joins a family with every configured attribute, stored canonically', async () => {
    sequence += 1;
    const created = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Variant ${String(sequence)}`,
      sku: `AGENT-${fix.runId}-VAR-${String(sequence)}`,
      productType: 'Goods',
      variantFamily: 'T-Shirt',
      variantAttributes: { COLOR: 'red', size: ' M ' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    recordIds.push(String(created.body['id']));
    const read = await fix.call('GET', `/api/v1/Product/${String(created.body['id'])}`);
    expect(read.status).toBe(200);
    expect(read.body['variantFamily']).toBe('T-Shirt');
    expect(JSON.parse(String(read.body['variantAttributes']))).toEqual({
      color: 'red',
      size: 'M',
    });
  });

  it('refuses attributes nobody configured and a missing required one', async () => {
    sequence += 1;
    const unknown = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Variant ${String(sequence)}`,
      sku: `AGENT-${fix.runId}-VAR-${String(sequence)}`,
      variantFamily: 'T-Shirt',
      variantAttributes: { material: 'cotton' },
    });
    expect([409, 422]).toContain(unknown.status);
    expect(reasonOf(unknown)).toMatch(/Unknown variant attribute/i);

    sequence += 1;
    const missing = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Variant ${String(sequence)}`,
      sku: `AGENT-${fix.runId}-VAR-${String(sequence)}`,
      variantFamily: 'T-Shirt',
      variantAttributes: { size: 'L' },
    });
    expect([409, 422]).toContain(missing.status);
    expect(reasonOf(missing)).toMatch(/Missing variant attribute/i);
  });

  it('refuses two products of one family that are the same variant', async () => {
    sequence += 1;
    const duplicate = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Variant ${String(sequence)}`,
      sku: `AGENT-${fix.runId}-VAR-${String(sequence)}`,
      variantFamily: 'T-Shirt',
      // Same combination as the first product, written in a different key order and casing.
      variantAttributes: { size: 'M', color: 'red' },
    });
    expect([409, 422]).toContain(duplicate.status);
    expect(reasonOf(duplicate)).toMatch(/exact combination of variant attributes/i);
  });

  it('keeps the catalog working with the feature off — the fields are inert', async () => {
    await setSettings({ features: { productVariants: false } });
    sequence += 1;
    const created = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Variant ${String(sequence)}`,
      sku: `AGENT-${fix.runId}-VAR-${String(sequence)}`,
      variantFamily: 'Scarf',
      variantAttributes: JSON.stringify({ material: 'wool' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    recordIds.push(String(created.body['id']));
    await setSettings({ features: { productVariants: true } });
  });
});

describe('19-S.15 — lots and the removal policy', () => {
  beforeAll(async () => {
    batchProduct = await createTrackedProduct('15-BATCH', 'batch');
    // LOT-A arrives first, through the purchasing flow, carrying its dates.
    await receiveLot(batchProduct, '5', {
      batchNumber: 'LOT-A',
      manufacturingDate: '2026-01-15',
      expiryDate: '2027-06-30',
    });
    // LOT-B and LOT-EXP exist as records first (a lot may be registered before its stock arrives).
    for (const lot of [
      { batchNumber: 'LOT-B', expiryDate: '2026-11-30' },
      { batchNumber: 'LOT-EXP', manufacturingDate: '2025-10-01', expiryDate: '2026-10-01' },
    ]) {
      const created = await fix.call('POST', '/api/v1/InventoryBatch', {
        productId: batchProduct,
        ...lot,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      recordIds.push(String(created.body['id']));
    }
    await adjust(batchProduct, '5', { batchNumber: 'LOT-B' });
    await adjust(batchProduct, '2', { batchNumber: 'LOT-EXP' });
  }, 120_000);

  it('refuses an inbound movement that does not name the lot it brings stock into', async () => {
    const result = await requestAdjustment(batchProduct, '1');
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const approved = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(result.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(approved)).toMatch(/must name the lot/i);
  });

  it('shows lot stock with its dates, and keeps identity correct per lot', async () => {
    expect((await availability(batchProduct))['onHand']).toBe('12');
    expect(await lotOf(batchProduct, 'LOT-A')).toMatchObject({
      onHand: '5',
      expiryDate: '2027-06-30',
      manufacturingDate: '2026-01-15',
    });
    expect(await lotOf(batchProduct, 'LOT-B')).toMatchObject({
      onHand: '5',
      expiryDate: '2026-11-30',
    });
    expect(await lotOf(batchProduct, 'LOT-EXP')).toMatchObject({ onHand: '2' });
  });

  it('validates lot dates on the record itself and refuses a duplicate lot per product', async () => {
    const badDates = await fix.call('POST', '/api/v1/InventoryBatch', {
      productId: batchProduct,
      manufacturingDate: '2026-12-01',
      expiryDate: '2026-01-01',
    });
    expect(badDates.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(badDates)).toMatch(/must not be after/i);

    const first = await fix.call('POST', '/api/v1/InventoryBatch', {
      productId: batchProduct,
      batchNumber: 'LOT-DUP',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    recordIds.push(String(first.body['id']));
    const second = await fix.call('POST', '/api/v1/InventoryBatch', {
      productId: batchProduct,
      batchNumber: 'lot-dup',
    });
    expect([409, 422]).toContain(second.status);
    expect(reasonOf(second)).toMatch(/already exists/i);
  });

  it('refuses a receive that would silently re-date an existing lot', async () => {
    sequence += 1;
    const order = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'purchaseOrder',
      data: {
        name: `AGENT_TEST_${fix.runId} PO ${String(sequence)}`,
        supplierId,
        currency: 'USD',
        orderDate: '2026-10-15',
        warehouseId: wh1,
      },
      items: [
        {
          productId: batchProduct,
          quantity: '1',
          unitPrice: '4.20',
          taxRatePercent: '0',
          supplierProductPriceId: supplierPriceId,
        },
      ],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = String(order.body['id']);
    documents.push({ kind: 'purchaseOrder', id: orderId });
    expect((await transition('purchaseOrder', orderId, 'confirm')).status).toBe(200);
    const converted = await fix.call(
      'POST',
      `/api/v1/Sales/document/purchaseOrder/${orderId}/convert`,
      { action: 'convertToReceiptOrder' },
    );
    expect(converted.status).toBe(201);
    const receiptId = String(converted.body['id']);
    documents.push({ kind: 'receiptOrder', id: receiptId });
    const view = await readDocument('receiptOrder', receiptId);
    const [line] = (view['items'] as Record<string, unknown>[]).slice(0, 1);
    await fix.call('PATCH', `/api/v1/Sales/document/receiptOrder/${receiptId}`, {
      items: [
        {
          sourceItemId: line?.['sourceItemId'],
          productId: line?.['productId'],
          quantity: '1',
          unitPrice: '4.20',
          taxRatePercent: '0',
          supplierProductPriceId: supplierPriceId,
          batchNumber: 'LOT-A',
          expiryDate: '2027-12-31',
        },
      ],
    });
    const confirmed = await transition('receiptOrder', receiptId, 'confirm');
    expect(confirmed.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(confirmed)).toMatch(/re-date/i);
  });

  it('FEFO picks the earliest expiry, excluding lots the policy forbids', async () => {
    await setSettings({ inventory: { removalPolicy: 'fefo' } });
    const pick = await suggestion(batchProduct, '20');
    expect(pick['tracking']).toBe('batch');
    expect(pick['policy']).toBe('fefo');
    const allocations = pick['allocations'] as { batchNumber: string }[];
    // LOT-EXP has the earliest expiry of all — and is excluded because it has passed.
    expect(allocations.map((each) => each.batchNumber)).toEqual(['LOT-B', 'LOT-A']);
    expect(allocations.some((each) => each.batchNumber === 'LOT-EXP')).toBe(false);
    expect(pick['shortage']).toBe('10');
  });

  it('FIFO picks the oldest receipt — and the confirmation writes exactly what the suggestion showed', async () => {
    await setSettings({ inventory: { removalPolicy: 'fifo' } });
    const pick = await suggestion(batchProduct, '3');
    expect(pick['allocations']).toEqual([{ batchNumber: 'LOT-A', quantity: '3' }]);

    const deliveryId = await createDelivery(batchProduct, '3', wh1);
    const confirmed = await transition('deliveryOrder', deliveryId, 'confirm');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const [movement] = await movementsFor('DeliveryOrder', deliveryId);
    expect(movement?.['batchNumber']).toBe('LOT-A');
    expect(JSON.parse(String(movement?.['batchAllocations']))).toEqual(
      pick['allocations'],
    );
    expect((await lotOf(batchProduct, 'LOT-A'))?.['onHand']).toBe('2');
    expect((await availability(batchProduct))['onHand']).toBe('9');
  });

  it('ships the earliest-expiring eligible lot under FEFO, still matching the suggestion', async () => {
    await setSettings({ inventory: { removalPolicy: 'fefo' } });
    const pick = await suggestion(batchProduct, '4');
    expect((pick['allocations'] as { batchNumber: string }[])[0]?.batchNumber).toBe('LOT-B');
    const deliveryId = await createDelivery(batchProduct, '4', wh1);
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const [movement] = await movementsFor('DeliveryOrder', deliveryId);
    expect(JSON.parse(String(movement?.['batchAllocations']))).toEqual(pick['allocations']);
    expect((await lotOf(batchProduct, 'LOT-B'))?.['onHand']).toBe('1');
  });

  it('lets an operator explicitly choose an expired lot — the policy only governs automatic picks', async () => {
    const deliveryId = await createDelivery(batchProduct, '1', wh1, {
      batchNumber: 'LOT-EXP',
    });
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    expect((await lotOf(batchProduct, 'LOT-EXP'))?.['onHand']).toBe('1');
  });

  it('refuses a document movement no lot can cover, naming the policy and the unattributed stock', async () => {
    // The honest hard case: physical stock exists, but it was received before this product was
    // lot-tracked, so no lot accounts for it — the refusal must say so instead of shipping blind.
    const unattributed = await createTrackedProduct('15-UNATTR', 'none');
    unattributedProduct = unattributed;
    await adjust(unattributed, '5');
    await fix.call('PATCH', `/api/v1/Product/${unattributed}`, {
      stockTracking: 'batch',
    });
    const pick = await suggestion(unattributed, '2');
    expect(pick['attributedAvailable']).toBe('0');
    expect(pick['shortage']).toBe('2');

    const deliveryId = await createDelivery(unattributed, '2', wh1);
    const refused = await transition('deliveryOrder', deliveryId, 'confirm');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(refused)).toMatch(/removal policy/i);
    expect(reasonOf(refused)).toMatch(/not attributed to any lot/i);
  });

  it('suggests nothing for a product that is not tracked — the plain path stays functional', async () => {
    const plain = await createTrackedProduct('15-PLAIN', 'none');
    await adjust(plain, '4');
    expect((await availability(plain))['onHand']).toBe('4');
    const pick = await suggestion(plain, '2');
    expect(pick['tracking']).toBe('none');
    expect(pick['shortage']).toBe('0');
    expect(pick['allocations']).toEqual([]);
    const deliveryId = await createDelivery(plain, '2', wh1);
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    expect((await availability(plain))['onHand']).toBe('2');
    // No identity is recorded for an untracked product.
    const [movement] = await movementsFor('DeliveryOrder', deliveryId);
    expect(movement?.['batchNumber']).toBeUndefined();
  });
});

describe('19-S.15 — serialised units', () => {
  let serialProduct = '';

  beforeAll(async () => {
    serialProduct = await createTrackedProduct('15-SERIAL', 'serial');
  });

  it('refuses an inbound movement that names no serial numbers', async () => {
    const requested = await requestAdjustment(serialProduct, '3');
    expect(requested.status).toBe(201);
    const approved = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(approved)).toMatch(/must name the serial numbers/i);
  });

  it('refuses a line whose serial count is not its quantity', async () => {
    const requested = await requestAdjustment(serialProduct, '2', {
      serialNumbers: ['SN-15A', 'SN-15B', 'SN-15C'],
    });
    expect(requested.status).toBe(201);
    const approved = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(approved)).toMatch(/serial number/i);
  });

  it('receives named units and shows them in stock', async () => {
    await adjust(serialProduct, '3', {
      serialNumbers: ['SN-15A', 'SN-15B', 'SN-15C'],
    });
    expect((await availability(serialProduct))['onHand']).toBe('3');
    const inStock = await serialsOf(serialProduct, wh1, 'inStock');
    expect(inStock.map((row) => row['serialNumber']).sort()).toEqual([
      'SN-15A',
      'SN-15B',
      'SN-15C',
    ]);
  });

  it('refuses counting one unit into stock twice', async () => {
    const requested = await requestAdjustment(serialProduct, '1', {
      serialNumbers: ['SN-15A'],
    });
    expect(requested.status).toBe(201);
    const approved = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
      { action: 'approve' },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(approved)).toMatch(/already in stock/i);
  });

  it('ships the units the policy suggests and walks their state, suggestion matching movement', async () => {
    const pick = await suggestion(serialProduct, '2');
    expect(pick['tracking']).toBe('serial');
    const suggested = pick['serialNumbers'] as string[];
    expect(suggested).toHaveLength(2);
    const deliveryId = await createDelivery(serialProduct, '2', wh1);
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const [movement] = await movementsFor('DeliveryOrder', deliveryId);
    expect(JSON.parse(String(movement?.['serialNumbers']))).toEqual(suggested);
    expect((await availability(serialProduct))['onHand']).toBe('1');
    expect(await serialsOf(serialProduct, wh1, 'shipped')).toHaveLength(2);
    expect(await serialsOf(serialProduct, wh1, 'inStock')).toHaveLength(1);
  });

  it('ships exactly the units a line names, and refuses one more than exists', async () => {
    const [remaining] = await serialsOf(serialProduct, wh1, 'inStock');
    const named = String(remaining?.['serialNumber']);
    const deliveryId = await createDelivery(serialProduct, '1', wh1, {
      serialNumbers: [named],
    });
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    expect((await availability(serialProduct))['onHand']).toBe('0');
    expect(await serialsOf(serialProduct, wh1, 'shipped')).toHaveLength(3);

    const empty = await createDelivery(serialProduct, '1', wh1);
    const refused = await transition('deliveryOrder', empty, 'confirm');
    // With no stock left the product-level rule refuses first — either way the delivery does not go
    // through, and the suggestion is what tells the editor beforehand.
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(refused)).toMatch(/would go negative|not accounted for/i);
    const pick = await suggestion(serialProduct, '1');
    expect(pick['serialNumbers']).toEqual([]);
    expect(pick['shortage']).toBe('1');
  });

  it('scopes serial uniqueness per product — another product may carry the same vendor number', async () => {
    const other = await createTrackedProduct('15-SERIAL-B', 'serial');
    await adjust(other, '1', { serialNumbers: ['SN-15A'] });
    expect(await serialsOf(other, wh1, 'inStock')).toHaveLength(1);
    expect(await serialsOf(serialProduct, wh1, 'shipped')).toHaveLength(3);
  });

  it('keeps a serial together across a two-sided transfer', async () => {
    const mover = await createTrackedProduct('15-SERIAL-T', 'serial');
    await adjust(mover, '2', { serialNumbers: ['SN-T1', 'SN-T2'] });
    const created = await fix.call('POST', '/api/v1/Sales/inventory/transfer', {
      sourceWarehouseId: wh1,
      destinationWarehouseId: wh2,
      items: [{ productId: mover, quantity: '2' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const transferId = String(created.body['id']);
    transferIds.push(transferId);
    const dispatched = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'confirm' },
    );
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(await serialsOf(mover, wh1, 'inTransit')).toHaveLength(2);
    expect((await availability(mover, wh1))['onHand']).toBe('0');

    const received = await fix.call(
      'POST',
      `/api/v1/Sales/inventory/transfer/${transferId}/transition`,
      { action: 'receive' },
    );
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    const atDestination = await serialsOf(mover, wh2, 'inStock');
    expect(atDestination.map((row) => row['serialNumber']).sort()).toEqual(['SN-T1', 'SN-T2']);
    expect((await availability(mover, wh2))['onHand']).toBe('2');
    expect((await availability(mover, wh1))['onHand']).toBe('0');
  });
});

describe('19-S.15 — transfers and returns keep lot traceability', () => {
  it('re-applies the dispatch lot split when the transfer is received', async () => {
    // Back to a known policy and a known pool: LOT-A and LOT-EXP remain in wh1.
    await setSettings({ inventory: { removalPolicy: 'fifo' } });
    const before = (await lotOf(batchProduct, 'LOT-A')) ?? {};
    const onHand = String(before['onHand'] ?? '0');
    expect(Number(onHand)).toBeGreaterThan(1);

    const created = await fix.call('POST', '/api/v1/Sales/inventory/transfer', {
      sourceWarehouseId: wh1,
      destinationWarehouseId: wh2,
      items: [{ productId: batchProduct, quantity: '1' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const transferId = String(created.body['id']);
    transferIds.push(transferId);
    expect(
      (
        await fix.call('POST', `/api/v1/Sales/inventory/transfer/${transferId}/transition`, {
          action: 'confirm',
        })
      ).status,
    ).toBe(200);
    const [outMovement] = await movementsFor('TransferOrder', transferId);
    const split = JSON.parse(String(outMovement?.['batchAllocations'])) as {
      batchNumber: string;
    }[];
    expect(split).toHaveLength(1);
    const lot = split[0]?.batchNumber ?? '';
    expect(lot).not.toBe('');
    expect(outMovement?.['transactionType']).toBe('transferOut');

    expect(
      (
        await fix.call('POST', `/api/v1/Sales/inventory/transfer/${transferId}/transition`, {
          action: 'receive',
        })
      ).status,
    ).toBe(200);
    const movements = await movementsFor('TransferOrder', transferId);
    const inbound = movements.find((row) => row['transactionType'] === 'transferIn');
    expect(inbound?.['batchNumber']).toBe(lot);
    // Same lot, two warehouses: it moved, it did not split into a new identity.
    expect(await lotOf(batchProduct, lot, wh2)).toMatchObject({ onHand: '1' });
    expect((await lotOf(batchProduct, lot))?.['onHand']).toBe(
      String(Number(onHand) - 1),
    );
  });

  it('restocks a returned shipment into the lot it names', async () => {
    // Earlier suites drew LOT-A down (its dispatches and deliveries took units out); top it back up
    // so the out-and-back round trip this test is about has stock to move. The lot's own dates stay
    // untouched — an inbound movement never re-dates a lot.
    await adjust(batchProduct, '2', { batchNumber: 'LOT-A' });
    const deliveryId = await createDelivery(batchProduct, '2', wh1, {
      batchNumber: 'LOT-A',
    });
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const lotBefore = await lotOf(batchProduct, 'LOT-A');
    const converted = await fix.call(
      'POST',
      `/api/v1/Sales/document/deliveryOrder/${deliveryId}/convert`,
      { action: 'convertToReturnOrder' },
    );
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const returnId = String(converted.body['id']);
    documents.push({ kind: 'returnOrder', id: returnId });
    const view = await readDocument('returnOrder', returnId);
    const [stored] = (view['items'] as Record<string, unknown>[]).slice(0, 1);
    // Re-state the line the way a client edits it — the fields the request shape accepts, with no
    // stored `id`/`position` and no `null` for "this kind has no such fact" (the PATCH `items` shape
    // is strict; `sales-delivery-returns` re-states lines the same way).
    const line: Record<string, unknown> = {
      sourceItemId: stored?.['sourceItemId'],
      productId: stored?.['productId'],
      name: stored?.['name'],
      unitPrice: stored?.['unitPrice'],
      taxRatePercent: stored?.['taxRatePercent'] ?? '0',
      disposition: 'restock',
      batchNumber: 'LOT-A',
    };
    for (const [key, value] of Object.entries(line)) if (value === null) delete line[key];
    const patched = await fix.call('PATCH', `/api/v1/Sales/document/returnOrder/${returnId}`, {
      items: [{ ...line, quantity: '2' }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await transition('returnOrder', returnId, 'confirm')).status).toBe(200);

    const [movement] = await movementsFor('ReturnOrder', returnId);
    expect(movement?.['batchNumber']).toBe('LOT-A');
    const lotAfter = await lotOf(batchProduct, 'LOT-A');
    expect(Number(lotAfter?.['onHand'] ?? '0')).toBe(
      Number(lotBefore?.['onHand'] ?? '0') + 2,
    );
  });

  it('reconciles physical stock with what the lots account for', async () => {
    // The lot-tracked product's physical on-hand and its lot attribution agree exactly.
    const scoped = await fix.call('POST', '/api/v1/Sales/inventory/reconcile', {
      warehouseId: wh1,
      productId: batchProduct,
    });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.body['ok']).toBe(true);
    expect(scoped.body['identityChecked']).toBe(1);
    expect(
      scoped.body['identityOk'],
      JSON.stringify(scoped.body['identityMismatches']),
    ).toBe(true);

    // Stock that predates lot tracking is a real difference the reconcile *reports*, never corrects.
    const all = await fix.call('POST', '/api/v1/Sales/inventory/reconcile', {
      warehouseId: wh1,
    });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body['identityChecked']).toBeGreaterThan(0);
    const mismatches = all.body['identityMismatches'] as { productId: string }[];
    expect(mismatches.some((row) => row.productId === unattributedProduct)).toBe(true);
  });
});
