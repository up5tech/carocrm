import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { detailsOf, reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.12 — delivery orders and return orders, through the real HTTP API.
 *
 * The acceptance criteria, one by one:
 *
 *  - delivered quantities reconcile with the order's own lines under the documented policy: the
 *    order's fulfilment state is **derived** from its confirmed deliveries, never typed;
 *  - partial deliveries are supported (a second delivery order for the same order is a partial move,
 *    not a duplicate billing) and an over-move is refused with the remainder attached;
 *  - stock-affecting confirmations are idempotent and auditable — the state machine refuses a second
 *    confirmation, and the frozen snapshot carries one movement key per document;
 *  - a returned line is restocked only when its own disposition allows it;
 *  - a delivery/return reference, tracking field and print hook exist on the record itself.
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documents: { kind: string; id: string }[] = [];
const itemIds: string[] = [];
const otherIds: string[] = [];

let productSeq = 0;

async function readDocument(kind: string, id: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/**
 * The frozen commercial envelope of an issued document, read from the record itself.
 *
 * `snapshot` is a detail field of the entity, and its `data` is exactly what issuance wrote — so a
 * test can see the stock movement a confirmation committed, not only the totals around it.
 */
async function snapshotOf(entity: 'DeliveryOrder' | 'ReturnOrder', id: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/${entity}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const envelope = JSON.parse(String(result.body['snapshot'])) as { data: Record<string, unknown> };
  return envelope.data;
}

async function transition(kind: string, id: string, action: string, reason?: string) {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, { action, ...(reason === undefined ? {} : { reason }) });
}

/** A confirmed sales order for `quantity` units of one new product. */
async function confirmedOrder(quantity: string): Promise<string> {
  productSeq += 1;
  const product = await fix.createProduct({ sku: `AGENT-${fix.runId}-D${productSeq}`, unitPrice: '10.00' });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'salesOrder',
    data: {
      name: `AGENT_TEST_${fix.runId} Order ${productSeq}`,
      currency: 'USD',
      orderDate: '2026-10-15',
      warehouseId: `AGENT_TEST_${fix.runId}-wh`,
    },
    items: [{ productId: product, quantity, unitPrice: '10.00', taxRatePercent: '0' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  documents.push({ kind: 'salesOrder', id });
  const confirmed = await transition('salesOrder', id, 'confirm');
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return id;
}

/**
 * A delivery order generated from that order, then re-drawn to move `quantity` of its source line.
 *
 * The conversion copies the whole line; a partial shipment re-states the same `sourceItemId` at the
 * quantity actually going out — the lineage is what the remaining-quantity guard reads.
 */
async function convertDelivery(orderId: string, quantity: string): Promise<string> {
  const converted = await fix.call('POST', `/api/v1/Sales/document/salesOrder/${orderId}/convert`, { action: 'convertToDeliveryOrder' });
  expect(converted.status, JSON.stringify(converted.body)).toBe(201);
  const id = String(converted.body['id']);
  documents.push({ kind: 'deliveryOrder', id });
  const lines = await firstLineOf('deliveryOrder', id);
  const patched = await fix.call('PATCH', `/api/v1/Sales/document/deliveryOrder/${id}`, {
    data: { trackingNumber: `AGENT-TRK-${fix.runId}` },
    items: [{ ...lines[0], quantity }],
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  return id;
}

/** The document's stored lines, in the shape a `PATCH` re-states them (lineage included). */
async function firstLineOf(kind: string, id: string): Promise<Record<string, unknown>[]> {
  const view = await readDocument(kind, id);
  const items = view['items'] as Record<string, unknown>[];
  expect(items.length, JSON.stringify(view)).toBeGreaterThan(0);
  return items.map((item) => {
    const line: Record<string, unknown> = {
      sourceItemId: item['sourceItemId'],
      productId: item['productId'],
      name: item['name'],
      quantity: item['quantity'],
      unitPrice: item['unitPrice'],
      taxRatePercent: item['taxRatePercent'] ?? '0',
      disposition: item['disposition'],
    };
    // A stored `null` is "this kind has no such fact"; the request shape only accepts a value.
    for (const [key, value] of Object.entries(line)) if (value === null) delete line[key];
    return line;
  });
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const { kind, id } of documents) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) for (const item of items) itemIds.push(String((item as { id: string }).id));
  }
  const all = [...documents.map((document) => document.id), ...itemIds, ...otherIds];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  await ctx.database.db
    .deleteFrom('outbox_events')
    .where((eb) =>
      eb.or([
        eb('payload', '->>', 'salesOrderId', 'in', documents.map((d) => d.id) as never),
        eb('payload', '->>', 'deliveryOrderId', 'in', documents.map((d) => d.id) as never),
        eb('payload', '->>', 'returnOrderId', 'in', documents.map((d) => d.id) as never),
        eb('payload', '->>', 'id', 'in', documents.map((d) => d.id) as never),
      ]),
    )
    .execute()
    .catch(() => undefined);
  // The feature flags this suite flips are put back exactly as they were found.
  await fix.call('POST', '/api/v1/Sales/action/settings', { features: { inventory: false } }).catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['SalesOrder', 'SalesOrderItem', 'DeliveryOrder', 'DeliveryOrderItem', 'ReturnOrder', 'ReturnOrderItem']);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('partial deliveries and the derived fulfilment state (19-S.12)', () => {
  it('links a converted delivery order to the order and its lines', async () => {
    const orderId = await confirmedOrder('5');
    const deliveryId = await convertDelivery(orderId, '2');
    const delivery = await readDocument('deliveryOrder', deliveryId);
    expect(delivery['document']).toMatchObject({ salesOrderId: orderId, status: 'draft', trackingNumber: `AGENT-TRK-${fix.runId}` });
    const items = delivery['items'] as { sourceItemId: string | null; quantity: string }[];
    expect(items[0]?.sourceItemId).toBeTruthy();
  });

  it('derives `partiallyFulfilled` from the confirmed delivery, not from a typed field', async () => {
    const orderId = await confirmedOrder('5');
    const deliveryId = await convertDelivery(orderId, '2');
    const confirmed = await transition('deliveryOrder', deliveryId, 'confirm');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const order = await readDocument('salesOrder', orderId);
    expect(order['document']).toMatchObject({ status: 'partiallyFulfilled' });
    // The refresh job/command sees the same state and changes nothing: it is idempotent.
    const refresh = await fix.call('POST', `/api/v1/Sales/salesOrder/${orderId}/refreshFulfilment`);
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
    expect(refresh.body).toMatchObject({ changed: false, state: 'partiallyFulfilled' });
  });

  it('accepts a second delivery for the remainder and reaches `fulfilled`', async () => {
    const orderId = await confirmedOrder('5');
    const first = await convertDelivery(orderId, '2');
    expect((await transition('deliveryOrder', first, 'confirm')).status).toBe(200);

    const second = await convertDelivery(orderId, '3');
    const secondView = await readDocument('deliveryOrder', second);
    expect((secondView['items'] as { quantity: string }[])[0]?.quantity).toBe('3');
    expect((await transition('deliveryOrder', second, 'confirm')).status, JSON.stringify(secondView)).toBe(200);
    expect((await readDocument('salesOrder', orderId))['document']).toMatchObject({ status: 'fulfilled' });
  });

  it('refuses to ship more than the order line still allows, with the remainder attached', async () => {
    const orderId = await confirmedOrder('5');
    const tooMuch = await convertDelivery(orderId, '6');
    const refused = await transition('deliveryOrder', tooMuch, 'confirm');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/would move 6, more than the 5 still outstanding/);
    // The refusal happened before the number was taken: the document is still a draft with no number.
    const view = await readDocument('deliveryOrder', tooMuch);
    expect(view['document']).toMatchObject({ status: 'draft', number: null });
  });

  it('refuses a second confirmation of the same delivery, so stock cannot move twice', async () => {
    const orderId = await confirmedOrder('1');
    const deliveryId = await convertDelivery(orderId, '1');
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const again = await transition('deliveryOrder', deliveryId, 'confirm');
    expect(again.status).toBe(422);
    expect(reasonOf(again)).toMatch(/not allowed from the "confirmed"/);
  });

  it('freezes one stock movement plan per delivery, keyed by the document not the request', async () => {
    const orderId = await confirmedOrder('2');
    const deliveryId = await convertDelivery(orderId, '2');
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const snapshot = await snapshotOf('DeliveryOrder', deliveryId);
    const plan = snapshot['stockMovement'] as {
      key: string;
      kind: string;
      documentNumber: string | null;
      lines: { restocked: boolean; quantity: string }[];
    };
    expect(plan).toMatchObject({ key: `DeliveryOrder:${deliveryId}`, kind: 'delivery' });
    // The plan names the official number it was confirmed under, taken in the same transaction.
    expect(plan.documentNumber).toMatch(/^DO-/);
    expect(plan.lines.every((line) => line.restocked)).toBe(true);
  });

  it('refuses to cancel a delivery once it moved stock; the correction is a return order', async () => {
    const orderId = await confirmedOrder('4');
    const deliveryId = await convertDelivery(orderId, '4');
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    expect((await readDocument('salesOrder', orderId))['document']).toMatchObject({ status: 'fulfilled' });

    const refused = await transition('deliveryOrder', deliveryId, 'cancel', 'AGENT_TEST wrong carrier');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/not allowed from the "confirmed"/);

    // A draft that was never confirmed moves nothing, so cancelling it leaves its order confirmed.
    const otherOrder = await confirmedOrder('2');
    const draft = await convertDelivery(otherOrder, '1');
    expect((await transition('deliveryOrder', draft, 'cancel', 'AGENT_TEST not needed')).status).toBe(200);
    expect((await readDocument('salesOrder', otherOrder))['document']).toMatchObject({ status: 'confirmed' });
  });

  it('refuses to confirm a delivery against an order that was cancelled', async () => {
    const orderId = await confirmedOrder('3');
    const deliveryId = await convertDelivery(orderId, '1');
    expect((await transition('salesOrder', orderId, 'cancel', 'AGENT_TEST customer withdrew')).status).toBe(200);
    const refused = await transition('deliveryOrder', deliveryId, 'confirm');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/"cancelled" state has nothing to move against/);
  });
});

describe('return orders and restock dispositions (19-S.12)', () => {
  /** A confirmed delivery of `quantity`, returned afterwards. */
  async function delivered(quantity: string): Promise<{ orderId: string; deliveryId: string }> {
    const orderId = await confirmedOrder('4');
    const deliveryId = await convertDelivery(orderId, quantity);
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    return { orderId, deliveryId };
  }

  async function convertReturn(deliveryId: string): Promise<string> {
    const converted = await fix.call('POST', `/api/v1/Sales/document/deliveryOrder/${deliveryId}/convert`, { action: 'convertToReturnOrder' });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const id = String(converted.body['id']);
    documents.push({ kind: 'returnOrder', id });
    return id;
  }

  /** Re-draw the return's lines, keeping the shipment line they were generated against. */
  async function redrawReturn(returnId: string, lines: Record<string, unknown>[]): Promise<void> {
    const [source] = await firstLineOf('returnOrder', returnId);
    const patched = await fix.call('PATCH', `/api/v1/Sales/document/returnOrder/${returnId}`, {
      items: lines.map((line) => ({ ...source, ...line })),
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  }

  it('links the return to both the shipment and the order it came from', async () => {
    const { orderId, deliveryId } = await delivered('2');
    const returnId = await convertReturn(deliveryId);
    const view = await readDocument('returnOrder', returnId);
    expect(view['document']).toMatchObject({ deliveryOrderId: deliveryId, salesOrderId: orderId, status: 'draft' });
    const lines = view['items'] as { sourceItemId: string | null }[];
    expect(lines[0]?.sourceItemId).toBeTruthy();
  });

  it('refuses to return more than was delivered on that shipment', async () => {
    const { deliveryId } = await delivered('2');
    const returnId = await convertReturn(deliveryId);
    await redrawReturn(returnId, [{ quantity: '3', disposition: 'restock' }]);
    const refused = await transition('returnOrder', returnId, 'confirm');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/more than the 2 still outstanding/);
  });

  it('keeps the disposition per line and restocks only the lines that allow it', async () => {
    const { deliveryId } = await delivered('4');
    const returnId = await convertReturn(deliveryId);
    await fix.call('PATCH', `/api/v1/Sales/document/returnOrder/${returnId}`, { data: { reason: 'AGENT_TEST damaged in transit' } });
    await redrawReturn(returnId, [
      { quantity: '1', disposition: 'restock', name: 'AGENT_TEST restock line' },
      { quantity: '3', disposition: 'scrap', name: 'AGENT_TEST scrap line' },
    ]);

    expect((await transition('returnOrder', returnId, 'confirm')).status).toBe(200);
    const snapshot = await snapshotOf('ReturnOrder', returnId);
    const plan = snapshot['stockMovement'] as {
      key: string;
      kind: string;
      lines: { restocked: boolean; disposition: string | null; quantity: string }[];
    };
    expect(plan).toMatchObject({ key: `ReturnOrder:${returnId}`, kind: 'return' });
    // Every line is on the plan — including the scrapped one — because a plan that drops lines cannot be audited.
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ restocked: true, disposition: 'restock' });
    expect(plan.lines[1]).toMatchObject({ restocked: false, disposition: 'scrap' });
  });

  it('stores the disposition on the return line itself, not only in the snapshot', async () => {
    const { deliveryId } = await delivered('1');
    const returnId = await convertReturn(deliveryId);
    await redrawReturn(returnId, [{ disposition: 'quarantine', name: 'AGENT_TEST quarantine line' }]);
    const items = (await readDocument('returnOrder', returnId))['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ disposition: 'quarantine' });
  });

  it('bounds a return made against the order by what was delivered, not what was ordered', async () => {
    const orderId = await confirmedOrder('5');
    const deliveryId = await convertDelivery(orderId, '2');
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);

    const converted = await fix.call('POST', `/api/v1/Sales/document/salesOrder/${orderId}/convert`, { action: 'convertToReturnOrder' });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const returnId = String(converted.body['id']);
    documents.push({ kind: 'returnOrder', id: returnId });
    const refused = await transition('returnOrder', returnId, 'confirm');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/more than the 2 still outstanding/);
  });
});

describe('the print hook and the inventory boundary (19-S.12)', () => {
  it('renders a delivery order from its own blocks, with the tracking reference', async () => {
    const orderId = await confirmedOrder('1');
    const deliveryId = await convertDelivery(orderId, '1');
    expect((await transition('deliveryOrder', deliveryId, 'confirm')).status).toBe(200);
    const rendered = await fix.call('POST', `/api/v1/Sales/document/deliveryOrder/${deliveryId}/render`, {});
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
    const body = String(rendered.body['body']);
    expect(rendered.body).toMatchObject({ kind: 'deliveryOrder', fromSnapshot: true });
    // The heading block is drawn in caps by the shared renderer; the number is the issued one.
    expect(body).toMatch(/DELIVERY ORDER DO-/);
    expect(body).toContain(`AGENT-TRK-${fix.runId}`);
    expect(rendered.body['blocks']).toBeTruthy();
  });

  it('consults the stock ledger when inventory is enabled (19-S.14)', async () => {
    // The order and the shipment draft are prepared with inventory off, so the confirmation below is
    // the only thing that could move stock. With the flag on, confirming now *applies* the movement
    // the snapshot froze — so a warehouse that does not exist is refused instead of the confirmation
    // being recorded against nothing. The applied case, with a real warehouse and real stock, is
    // `apps/api/test/sales-inventory.test.ts`.
    const orderId = await confirmedOrder('1');
    const deliveryId = await convertDelivery(orderId, '1');
    const enabled = await fix.call('POST', '/api/v1/Sales/action/settings', { features: { inventory: true } });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    try {
      const refused = await transition('deliveryOrder', deliveryId, 'confirm');
      expect(refused.status).toBe(422);
      expect(reasonOf(refused)).toMatch(/does not exist/);
      expect(detailsOf(refused)).toMatchObject({ warehouseId: `AGENT_TEST_${fix.runId}-wh` });
      // Nothing was applied: the document stayed a draft, and no number was consumed.
      expect((await readDocument('deliveryOrder', deliveryId))['document']).toMatchObject({
        status: 'draft',
        number: null,
      });
    } finally {
      await fix.call('POST', '/api/v1/Sales/action/settings', { features: { inventory: false } });
    }
  });
});
