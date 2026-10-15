import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.13 — suppliers, purchase orders, receipt orders, supplier bills and bill credits, through
 * the real HTTP API.
 *
 * The acceptance criteria, one by one:
 *
 *  - **purchase-to-receipt-to-bill traceability**: each generated document keeps the line and the
 *    document it came from, and the bill names both its purchase order and the receipt that arrived;
 *  - **supplier prices cannot leak into sales pricing**: the buying resolver reads only
 *    `SupplierProductPrice`, the sales resolver never does, and the two commands are separate;
 *  - **allocations stay consistent and audited**: an outgoing payment settles a bill, a bill credit
 *    reduces it through its own allocation rows, and a reversal keeps the original row;
 *  - **receiving is not duplicated on a retry**: the state machine refuses a second confirmation and
 *    the frozen snapshot carries one movement key per receipt order;
 *  - the purchasing half is its own feature, with its own permission surface.
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

async function transition(kind: string, id: string, action: string, reason?: string) {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, { action, ...(reason === undefined ? {} : { reason }) });
}

async function convert(kind: string, id: string, action: string) {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/convert`, { action });
}

/** The lines of a document, re-stated in the shape a `PATCH` accepts (lineage kept). */
async function linesOf(kind: string, id: string): Promise<Record<string, unknown>[]> {
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
    };
    for (const [key, value] of Object.entries(line)) if (value === null) delete line[key];
    return line;
  });
}

async function snapshotOf(entity: 'ReceiptOrder' | 'Bill' | 'BillCredit' | 'PurchaseOrder', id: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/${entity}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const envelope = JSON.parse(String(result.body['snapshot'])) as { data: Record<string, unknown> };
  return envelope.data;
}

/** A supplier, its price for a new product, and a confirmed purchase order for `quantity`. */
async function purchaseOrder(quantity: string): Promise<{ supplierId: string; productId: string; priceId: string; orderId: string }> {
  productSeq += 1;
  const supplierId = await fix.createSupplier({ currency: 'USD' });
  const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P${productSeq}`, unitPrice: '99.00' });
  const priceId = await fix.createSupplierPrice(supplierId, productId, { unitPrice: '4.20', currency: 'USD' });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'purchaseOrder',
    data: {
      name: `AGENT_TEST_${fix.runId} PO ${productSeq}`,
      supplierId,
      currency: 'USD',
      orderDate: '2026-10-15',
      warehouseId: `AGENT_TEST_${fix.runId}-wh`,
    },
    items: [{ productId, quantity, unitPrice: '4.20', taxRatePercent: '0', supplierProductPriceId: priceId }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = String(created.body['id']);
  documents.push({ kind: 'purchaseOrder', id: orderId });
  expect((await transition('purchaseOrder', orderId, 'confirm')).status).toBe(200);
  return { supplierId, productId, priceId, orderId };
}

/** A confirmed receipt order against that purchase order, receiving `quantity`. */
async function receive(orderId: string, quantity: string): Promise<string> {
  const converted = await convert('purchaseOrder', orderId, 'convertToReceiptOrder');
  expect(converted.status, JSON.stringify(converted.body)).toBe(201);
  const id = String(converted.body['id']);
  documents.push({ kind: 'receiptOrder', id });
  const [line] = await linesOf('receiptOrder', id);
  const patched = await fix.call('PATCH', `/api/v1/Sales/document/receiptOrder/${id}`, {
    items: [{ ...line, quantity, batchNumber: `AGENT-BATCH-${fix.runId}` }],
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  expect((await transition('receiptOrder', id, 'confirm')).status, JSON.stringify(patched)).toBe(200);
  return id;
}

async function issueBill(receiptOrderId: string): Promise<string> {
  const converted = await convert('receiptOrder', receiptOrderId, 'convertToBill');
  expect(converted.status, JSON.stringify(converted.body)).toBe(201);
  const id = String(converted.body['id']);
  documents.push({ kind: 'bill', id });
  expect((await transition('bill', id, 'issue')).status).toBe(200);
  return id;
}

async function recordPayment(amount: string, supplierId: string): Promise<string> {
  const created = await fix.call('POST', '/api/v1/Sales/payment', { amount, direction: 'outgoing', currency: 'USD', supplierId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  otherIds.push(id);
  const confirmed = await fix.call('POST', `/api/v1/Sales/payment/${id}/transition`, { action: 'confirm' });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return id;
}

async function payBill(paymentId: string, billId: string, amount: string) {
  return await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, { documentId: billId, documentEntity: 'Bill', amount });
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  // Purchasing is a feature, off by default; this suite turns it on and puts it back afterwards.
  const enabled = await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: true } });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: false } }).catch(() => undefined);
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
    .where((eb) => eb('payload', '->>', 'id', 'in', documents.map((document) => document.id) as never))
    .execute()
    .catch(() => undefined);
  await purgeEntityEvents(ctx.database, [
    'PurchaseOrder',
    'PurchaseOrderItem',
    'ReceiptOrder',
    'ReceiptOrderItem',
    'Bill',
    'BillItem',
    'BillCredit',
    'BillCreditItem',
    'BillCreditAllocation',
    'Payment',
    'PaymentAllocation',
    'PaymentTermProfile',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('the purchasing boundary (19-S.13)', () => {
  it('refuses a purchasing document while the feature is off, and says why', async () => {
    await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: false } });
    try {
      const refused = await fix.call('POST', '/api/v1/Sales/document', {
        kind: 'purchaseOrder',
        data: { name: `AGENT_TEST_${fix.runId} disabled PO`, currency: 'USD', orderDate: '2026-10-15' },
        items: [{ name: 'AGENT_TEST line', quantity: '1', unitPrice: '1.00', taxRatePercent: '0' }],
      });
      expect(refused.status).toBe(403);
      expect(reasonOf(refused)).toMatch(/purchases/);
    } finally {
      const back = await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: true } });
      expect(back.status).toBe(200);
    }
  });

  it('refers a client write to a computed field on a bill or a bill credit', async () => {
    const forged = await fix.call('POST', '/api/v1/Bill', {
      name: `AGENT_TEST_${fix.runId} forged bill`,
      currency: 'USD',
      billDate: '2026-10-15',
      grossTotal: '1.00',
      amountDue: '0.00',
      paymentStatus: 'paid',
    });
    expect(forged.status).toBe(422);
    expect(reasonOf(forged)).toMatch(/computed by the server/);
  });
});

describe('purchase order to receipt (19-S.13)', () => {
  it('issues a purchase order with a number, its supplier, and the supplier price on the line', async () => {
    const { supplierId, priceId, orderId } = await purchaseOrder('5');
    const view = await readDocument('purchaseOrder', orderId);
    expect(view['document']).toMatchObject({ status: 'confirmed', supplierId });
    expect(String(view['document']['number'])).toMatch(/^PO-/);
    const items = view['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ supplierProductPriceId: priceId });
  });

  it('derives `partiallyReceived` from a confirmed partial receipt, then `received`', async () => {
    const { orderId } = await purchaseOrder('5');
    await receive(orderId, '2');
    expect((await readDocument('purchaseOrder', orderId))['document']).toMatchObject({ status: 'partiallyReceived' });

    await receive(orderId, '3');
    const order = await readDocument('purchaseOrder', orderId);
    expect(order['document']).toMatchObject({ status: 'received' });

    // The recompute command sees the same state and changes nothing: it is idempotent.
    const refresh = await fix.call('POST', `/api/v1/Sales/purchaseOrder/${orderId}/refreshReceipt`);
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
    expect(refresh.body).toMatchObject({ changed: false, state: 'received' });
  });

  it('refuses to receive more than the order line allows, before taking a number', async () => {
    const { orderId } = await purchaseOrder('2');
    const converted = await convert('purchaseOrder', orderId, 'convertToReceiptOrder');
    const id = String(converted.body['id']);
    documents.push({ kind: 'receiptOrder', id });
    const [line] = await linesOf('receiptOrder', id);
    await fix.call('PATCH', `/api/v1/Sales/document/receiptOrder/${id}`, { items: [{ ...line, quantity: '3' }] });
    const refused = await transition('receiptOrder', id, 'confirm');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/more than the 2 still outstanding/);
    expect((await readDocument('receiptOrder', id))['document']).toMatchObject({ status: 'draft', number: null });
  });

  it('refuses a second confirmation, and freezes one receipt movement per document', async () => {
    const { orderId } = await purchaseOrder('3');
    const receiptId = await receive(orderId, '3');
    const again = await transition('receiptOrder', receiptId, 'confirm');
    expect(again.status).toBe(422);

    const snapshot = await snapshotOf('ReceiptOrder', receiptId);
    const plan = snapshot['stockMovement'] as { key: string; kind: string; documentNumber: string | null; lines: { restocked: boolean }[] };
    expect(plan).toMatchObject({ key: `ReceiptOrder:${receiptId}`, kind: 'receipt' });
    expect(plan.documentNumber).toMatch(/^GRN-/);
    expect(plan.lines.every((line) => line.restocked)).toBe(true);
    // The receipt line keeps the batch identity it arrived with (§4.12).
    const items = (await readDocument('receiptOrder', receiptId))['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ batchNumber: `AGENT-BATCH-${fix.runId}` });
  });
});

describe('supplier bills (19-S.13)', () => {
  it('traces a bill back to the purchase order and the receipt that produced it', async () => {
    const { supplierId, orderId } = await purchaseOrder('4');
    const receiptId = await receive(orderId, '4');
    const billId = await issueBill(receiptId);
    const bill = await readDocument('bill', billId);
    expect(bill['document']).toMatchObject({
      status: 'issued',
      supplierId,
      purchaseOrderId: orderId,
      receiptOrderId: receiptId,
    });
    expect(String(bill['document']['number'])).toMatch(/^BILL-/);
  });

  it('computes the due date from the payment terms, never from the caller', async () => {
    const terms = await fix.create('PaymentTermProfile', { dueDays: 14, basis: 'net', active: true });
    const { supplierId, productId } = await purchaseOrder('1');
    const created = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'bill',
      data: { name: `AGENT_TEST_${fix.runId} Bill`, supplierId, productId, currency: 'USD', billDate: '2026-10-15', paymentTermId: terms },
      items: [{ name: 'AGENT_TEST freight', quantity: '1', unitPrice: '50.00', taxRatePercent: '0' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body['id']);
    documents.push({ kind: 'bill', id });
    expect((await readDocument('bill', id))['document']).toMatchObject({ dueDate: '2026-10-29' });
  });

  it('settles a bill with an outgoing payment and keeps both balances derived', async () => {
    const { supplierId, orderId } = await purchaseOrder('1');
    const receiptId = await receive(orderId, '1');
    const billId = await issueBill(receiptId);
    const paymentId = await recordPayment('4.20', supplierId);

    const open = await fix.call('GET', `/api/v1/Sales/allocatableDocuments?direction=outgoing&supplierId=${supplierId}`);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect((open.body['list'] as { id: string }[]).some((row) => row.id === billId)).toBe(true);

    const applied = await payBill(paymentId, billId, '4.20');
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result = applied.body as unknown as { document: { amountDue: string; paymentStatus: string } };
    expect(result.document.amountDue).toBe('0.00');
    expect(result.document.paymentStatus).toBe('paid');

    const view = await readDocument('bill', billId);
    expect(view['document']).toMatchObject({ amountDue: '0.00', paymentStatus: 'paid' });
  });

  it('refuses to settle a bill with a customer payment', async () => {
    const { supplierId, orderId } = await purchaseOrder('1');
    const receiptId = await receive(orderId, '1');
    const billId = await issueBill(receiptId);
    const incoming = await fix.call('POST', '/api/v1/Sales/payment', { amount: '4.20', direction: 'incoming', currency: 'USD' });
    expect(incoming.status, JSON.stringify(incoming.body)).toBe(201);
    const paymentId = String(incoming.body['id']);
    otherIds.push(paymentId);
    await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/transition`, { action: 'confirm' });
    const refused = await payBill(paymentId, billId, '4.20');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/is not one of them/);

    // …and a payment that names both an account and a supplier is refused at the door.
    const account = await fix.create('Account');
    const ambiguous = await fix.call('POST', '/api/v1/Sales/payment', { amount: '1.00', direction: 'outgoing', accountId: account, supplierId });
    expect(ambiguous.status).toBe(422);
    expect(reasonOf(ambiguous)).toMatch(/either an account or a supplier/);
  });
});

describe('bill credits (19-S.13)', () => {
  async function creditFrom(billId: string, amount: string): Promise<string> {
    const converted = await convert('bill', billId, 'convertToBillCredit');
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const id = String(converted.body['id']);
    documents.push({ kind: 'billCredit', id });
    const [line] = await linesOf('billCredit', id);
    await fix.call('PATCH', `/api/v1/Sales/document/billCredit/${id}`, {
      data: { reason: 'AGENT_TEST goods returned to supplier' },
      items: [{ ...line, quantity: '1', unitPrice: amount }],
    });
    expect((await transition('billCredit', id, 'issue')).status).toBe(200);
    return id;
  }

  it('reduces a payable through its own allocation rows, and a reversal restores it', async () => {
    const { orderId } = await purchaseOrder('1');
    const billId = await issueBill(await receive(orderId, '1'));
    const creditId = await creditFrom(billId, '1.20');

    // A freshly issued credit is fully unallocated, on the supplier side as on the customer's.
    expect((await readDocument('billCredit', creditId))['document']).toMatchObject({ unallocatedAmount: '1.20' });

    const allocated = await fix.call('POST', `/api/v1/Sales/billCredit/${creditId}/allocate`, { billId, amount: '1.20' });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
    const first = allocated.body as unknown as { bill: { amountDue: string }; allocation: { id: string } };
    expect(first.bill.amountDue).toBe('3.00');
    otherIds.push(first.allocation.id);

    const history = await fix.call('GET', `/api/v1/Sales/bill/${billId}/creditAllocations`);
    expect((history.body['list'] as { status: string }[])[0]).toMatchObject({ status: 'active' });

    const reversed = await fix.call('DELETE', `/api/v1/Sales/billCredit/allocation/${first.allocation.id}`, { reason: 'AGENT_TEST wrong bill' });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    const back = reversed.body as unknown as { bill: { amountDue: string }; allocation: { status: string; reversalReason: string | null } };
    expect(back.bill.amountDue).toBe('4.20');
    // The row is kept and marked: the original and its reversal are both on record.
    expect(back.allocation).toMatchObject({ status: 'reversed', reversalReason: 'AGENT_TEST wrong bill' });

    const twice = await fix.call('DELETE', `/api/v1/Sales/billCredit/allocation/${first.allocation.id}`, { reason: 'AGENT_TEST again' });
    expect(twice.status).toBe(422);
    expect(reasonOf(twice)).toMatch(/already been reversed/);
  });

  it('refuses to credit more than the credit has, or more than the bill still owes', async () => {
    const { orderId } = await purchaseOrder('1');
    const billId = await issueBill(await receive(orderId, '1'));
    const creditId = await creditFrom(billId, '1.20');

    // Past the credit's own remainder — the side that runs out first.
    const tooMuchCredit = await fix.call('POST', `/api/v1/Sales/billCredit/${creditId}/allocate`, { billId, amount: '5.00' });
    expect(tooMuchCredit.status).toBe(422);
    expect(reasonOf(tooMuchCredit)).toMatch(/still unallocated on bill credit/);

    // A credit bigger than the payable is refused against the bill's outstanding amount (§4.12).
    // A second generated credit from the same bill is not the supported path, so this one is manual.
    const bill = (await readDocument('bill', billId))['document'] as Record<string, unknown>;
    const manual = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'billCredit',
      data: { name: `AGENT_TEST_${fix.runId} oversized credit`, supplierId: bill['supplierId'], billId, currency: 'USD', creditDate: '2026-10-15', reason: 'AGENT_TEST over-credit attempt' },
      items: [{ name: 'AGENT_TEST credit line', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' }],
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    const overSized = String(manual.body['id']);
    documents.push({ kind: 'billCredit', id: overSized });
    expect((await transition('billCredit', overSized, 'issue')).status).toBe(200);
    const tooMuchBill = await fix.call('POST', `/api/v1/Sales/billCredit/${overSized}/allocate`, { billId, amount: '5.00' });
    expect(tooMuchBill.status).toBe(422);
    expect(reasonOf(tooMuchBill)).toMatch(/still outstanding on bill/);
  });

  it('keeps customer credits and supplier credits in their own records', async () => {
    const { orderId } = await purchaseOrder('1');
    const billId = await issueBill(await receive(orderId, '1'));
    const creditId = await creditFrom(billId, '1.00');
    const allocatable = await fix.call('GET', `/api/v1/Sales/billCredit/allocatableBills?billCreditId=${creditId}&supplierId=${String((await readDocument('bill', billId))['document']['supplierId'])}`);
    expect(allocatable.status, JSON.stringify(allocatable.body)).toBe(200);
    const rows = allocatable.body['list'] as { id: string; outstanding: string }[];
    const bill = rows.find((row) => row.id === billId);
    expect(bill?.outstanding).toBe('4.20');
    // The credit-note list never offers a bill, and vice versa: the sides of the ledger stay apart.
    const notes = await fix.call('GET', '/api/v1/Sales/creditNote/allocatableInvoices');
    expect((notes.body['list'] as { id: string }[]).some((row) => row.id === billId)).toBe(false);
  });
});

describe('suppliers and prices (19-S.13)', () => {
  it('freezes the identity of a supplier an issued bill already names', async () => {
    const { supplierId, orderId } = await purchaseOrder('1');
    await issueBill(await receive(orderId, '1'));
    const renamed = await fix.call('PATCH', `/api/v1/Supplier/${supplierId}`, { name: `AGENT_TEST_${fix.runId} renamed` });
    expect(renamed.status).toBe(422);
    expect(reasonOf(renamed)).toMatch(/referenced by issued purchasing documents/);

    // Deactivating is a forward-looking decision, not a rewrite of history, so it stays allowed.
    const deactivated = await fix.call('PATCH', `/api/v1/Supplier/${supplierId}`, { active: false });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
  });

  it('resolves the buying price from supplier rows only', async () => {
    productSeq += 1;
    const supplierId = await fix.createSupplier({ currency: 'USD' });
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-S${productSeq}`, unitPrice: '99.00', listPrice: '120.00' });
    const priceId = await fix.createSupplierPrice(supplierId, productId, { unitPrice: '4.20', currency: 'USD' });

    const buying = await fix.call('POST', '/api/v1/Sales/action/resolveSupplierPrice', { supplierId, productId, quantity: '1', currency: 'USD', date: '2026-10-15' });
    expect(buying.status, JSON.stringify(buying.body)).toBe(200);
    expect(buying.body).toMatchObject({ resolved: true, price: '4.20', supplierProductPriceId: priceId });

    // The selling resolver sees the same product and answers with the sales price — the buying row
    // cannot leak into it, and the reverse command never reaches a price book (§4.12 acceptance).
    const selling = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId, quantity: '1', currency: 'USD', date: '2026-10-15' });
    expect(selling.status, JSON.stringify(selling.body)).toBe(200);
    expect(selling.body).toMatchObject({ resolved: true, price: '99.00' });
    expect(String(JSON.stringify(selling.body))).not.toContain(priceId);
  });

  it('renders a supplier bill through the shared print hook', async () => {
    const { supplierId, orderId } = await purchaseOrder('1');
    const billId = await issueBill(await receive(orderId, '1'));
    const rendered = await fix.call('POST', `/api/v1/Sales/document/bill/${billId}/render`, {});
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
    expect(rendered.body).toMatchObject({ kind: 'bill', fromSnapshot: true });
    const body = String(rendered.body['body']);
    expect(body).toMatch(/BILL BILL-/i);
    expect(body).toContain('Supplier');
    const supplier = await fix.call('GET', `/api/v1/Supplier/${supplierId}`);
    expect(body).toContain(String(supplier.body['name']));
  });
});
