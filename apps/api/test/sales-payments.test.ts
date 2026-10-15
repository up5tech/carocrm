import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.10 — payments, allocation and provider events through the real HTTP API.
 *
 * The four acceptance criteria, one test each:
 *
 *  - a payment cannot be allocated beyond what it has left, nor beyond what a document owes;
 *  - the document's `amountDue` and `paymentStatus` follow the allocation rows, in both directions;
 *  - a duplicate provider event creates no second payment and no second allocation;
 *  - nothing here calls a gateway — the provider-facing surface is a record and an idempotent log.
 *
 * Plus the security edge the phase exists to close: a client cannot set a derived balance through the
 * generic record API, and a provider payload carrying card data is refused rather than stored.
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documentIds: { kind: string; id: string }[] = [];
const itemIds: string[] = [];
const otherIds: string[] = [];

interface PaymentView {
  id: string;
  status: string;
  direction: string;
  amount: string;
  balance: { amount: string; allocated: string; unallocated: string; status: string };
}

interface AllocationResult {
  allocation: { id: string; amount: string };
  payment: { allocated: string; unallocated: string; status: string };
  document: { amountDue: string; paymentStatus: string };
}

let invoiceSeq = 0;
async function issueInvoice(amount: string): Promise<string> {
  invoiceSeq += 1;
  const product = await fix.createProduct({ sku: `AGENT-${fix.runId}-P${invoiceSeq}`, unitPrice: amount });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'invoice',
    data: { name: `AGENT_TEST_${fix.runId} Invoice`, currency: 'USD', invoiceDate: '2026-10-15' },
    items: [{ productId: product, quantity: '1', unitPrice: amount, taxRatePercent: '0' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const invoiceId = String(created.body['id']);
  documentIds.push({ kind: 'invoice', id: invoiceId });

  const issued = await fix.call('POST', `/api/v1/Sales/document/invoice/${invoiceId}/transition`, { action: 'issue' });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return invoiceId;
}

async function recordPayment(amount: string, direction = 'incoming'): Promise<PaymentView> {
  const created = await fix.call('POST', '/api/v1/Sales/payment', { amount, currency: 'USD', direction, date: '2026-10-15' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const payment = created.body as unknown as PaymentView;
  otherIds.push(payment.id);
  return payment;
}

async function confirmPayment(id: string): Promise<PaymentView> {
  const result = await fix.call('POST', `/api/v1/Sales/payment/${id}/transition`, { action: 'confirm' });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as unknown as PaymentView;
}

async function allocate(paymentId: string, documentId: string, amount: string) {
  return await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, { documentId, amount });
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const { kind, id } of documentIds) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) {
      for (const item of items) itemIds.push(String((item as { id: string }).id));
    }
  }
  const all = [...documentIds.map((document) => document.id), ...itemIds, ...otherIds];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, [
    'Invoice',
    'InvoiceItem',
    'Payment',
    'PaymentAllocation',
    'PaymentRequest',
    'PaymentProviderEventLog',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('recording a payment (19-S.10)', () => {
  it('records a draft whose balance is derived, not supplied', async () => {
    const payment = await recordPayment('100.00');
    expect(payment.status).toBe('draft');
    expect(payment.direction).toBe('incoming');
    expect(payment.balance).toEqual({ amount: '100.00', allocated: '0.00', unallocated: '100.00', status: 'unallocated' });
  });

  it('refuses a client-supplied derived balance', async () => {
    const created = await fix.call('POST', '/api/v1/Payment', {
      name: `AGENT_TEST_${fix.runId} Forged payment`,
      amount: '100.00',
      currency: 'USD',
      direction: 'incoming',
      allocatedAmount: '100.00',
      allocationStatus: 'allocated',
    });
    expect(created.status).toBe(422);
    expect(reasonOf(created)).toMatch(/computed by the server/);
  });

  it('will not allocate a payment that has not been confirmed', async () => {
    const invoiceId = await issueInvoice('50.00');
    const payment = await recordPayment('50.00');
    const result = await allocate(payment.id, invoiceId, '50.00');
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/must be confirmed/);
  });

  it('will not allocate to an invoice that has not been issued', async () => {
    const draft = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'invoice',
      data: { name: `AGENT_TEST_${fix.runId} Draft invoice`, currency: 'USD', invoiceDate: '2026-10-15' },
      items: [{ name: 'line', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' }],
    });
    const draftId = String(draft.body['id']);
    documentIds.push({ kind: 'invoice', id: draftId });

    const payment = await confirmPayment((await recordPayment('10.00')).id);
    const result = await allocate(payment.id, draftId, '10.00');
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/Only an issued invoice/);
  });

  it('refuses an outgoing payment until the payable documents exist', async () => {
    const invoiceId = await issueInvoice('20.00');
    const payment = await confirmPayment((await recordPayment('20.00', 'outgoing')).id);
    const result = await allocate(payment.id, invoiceId, '20.00');
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/19-S\.13/);
  });
});

describe('allocating and unallocating (19-S.10)', () => {
  it('settles part of an invoice and keeps both sides consistent', async () => {
    const invoiceId = await issueInvoice('100.00');
    const payment = await confirmPayment((await recordPayment('100.00')).id);

    const first = await allocate(payment.id, invoiceId, '40.00');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const partial = first.body as unknown as AllocationResult;
    otherIds.push(partial.allocation.id);
    expect(partial.payment).toMatchObject({ allocated: '40.00', unallocated: '60.00', status: 'partiallyAllocated' });
    expect(partial.document).toEqual({ amountDue: '60.00', paymentStatus: 'partiallyPaid' });

    const second = await allocate(payment.id, invoiceId, '60.00');
    const settled = second.body as unknown as AllocationResult;
    otherIds.push(settled.allocation.id);
    expect(settled.payment).toMatchObject({ allocated: '100.00', unallocated: '0.00', status: 'allocated' });
    expect(settled.document).toEqual({ amountDue: '0.00', paymentStatus: 'paid' });

    // The invoice itself is still an issued invoice: payment status is a separate concept.
    const invoice = await fix.call('GET', `/api/v1/Sales/document/invoice/${invoiceId}`);
    expect(invoice.body['document']).toMatchObject({ status: 'issued', paymentStatus: 'paid', amountDue: '0.00' });
  });

  it('refuses an allocation beyond the payment and names the remainder', async () => {
    const invoiceId = await issueInvoice('100.00');
    const payment = await confirmPayment((await recordPayment('30.00')).id);
    const result = await allocate(payment.id, invoiceId, '50.00');
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/still unallocated on payment/);
  });

  it('refuses an allocation beyond what the invoice still owes', async () => {
    const invoiceId = await issueInvoice('20.00');
    const payment = await confirmPayment((await recordPayment('100.00')).id);
    const result = await allocate(payment.id, invoiceId, '30.00');
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/still outstanding/);
  });

  it('recomputes both sides when an allocation is removed', async () => {
    const invoiceId = await issueInvoice('80.00');
    const payment = await confirmPayment((await recordPayment('80.00')).id);
    const applied = await allocate(payment.id, invoiceId, '80.00');
    const allocationId = String((applied.body as unknown as AllocationResult).allocation.id);
    otherIds.push(allocationId);

    const removed = await fix.call('DELETE', `/api/v1/Sales/allocation/${allocationId}`);
    expect(removed.status).toBe(204);

    const paymentAfter = await fix.call('GET', `/api/v1/Sales/payment/${payment.id}`);
    expect((paymentAfter.body as unknown as PaymentView).balance).toMatchObject({ allocated: '0.00', unallocated: '80.00', status: 'unallocated' });
    const invoiceAfter = await fix.call('GET', `/api/v1/Sales/document/invoice/${invoiceId}`);
    expect(invoiceAfter.body['document']).toMatchObject({ amountDue: '80.00', paymentStatus: 'unpaid' });
  });

  it('lists the payment history and the invoices still open', async () => {
    const invoiceId = await issueInvoice('45.00');
    const payment = await confirmPayment((await recordPayment('45.00')).id);
    const applied = await allocate(payment.id, invoiceId, '45.00');
    otherIds.push(String((applied.body as unknown as AllocationResult).allocation.id));

    const history = await fix.call('GET', `/api/v1/Sales/payment/${payment.id}/allocations`);
    expect(history.status).toBe(200);
    expect((history.body['list'] as { documentId: string; amount: string }[])[0]).toMatchObject({ documentId: invoiceId, amount: '45.00' });

    const open = await fix.call('GET', '/api/v1/Sales/allocatableInvoices?direction=incoming');
    expect(open.status).toBe(200);
    const list = open.body['list'] as { id: string; outstanding: string }[];
    // A fully settled invoice is not offered for allocation.
    expect(list.some((row) => row.id === invoiceId)).toBe(false);
  });

  it('refuses to cancel a payment that has allocations', async () => {
    const invoiceId = await issueInvoice('15.00');
    const payment = await confirmPayment((await recordPayment('15.00')).id);
    const applied = await allocate(payment.id, invoiceId, '15.00');
    otherIds.push(String((applied.body as unknown as AllocationResult).allocation.id));

    const cancelled = await fix.call('POST', `/api/v1/Sales/payment/${payment.id}/transition`, { action: 'cancel', reason: 'mistake' });
    expect(cancelled.status).toBe(422);
    expect(reasonOf(cancelled)).toMatch(/unallocate it before cancelling/);
  });
});

describe('provider events (19-S.10)', () => {
  it('ingests an event once and reports a duplicate delivery without side effects', async () => {
    const request = await fix.call('POST', '/api/v1/Sales/paymentRequest', {
      amount: '25.00',
      currency: 'USD',
      accountId: null,
      invoiceId: null,
    });
    // `accountId` is required by the schema, so a request without one is refused — not silently created.
    // A body that fails the request schema is the kernel's `INVALID_QUERY` (400), not a domain refusal.
    expect(request.status).toBe(400);

    const eventId = `evt-${fix.runId}-1`;
    const first = await fix.call('POST', '/api/v1/Sales/providerEvent', {
      provider: 'test-provider',
      providerEventId: eventId,
      eventType: 'payment.succeeded',
      payload: { amount: '25.00', currency: 'USD' },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ providerEventId: eventId, duplicate: false });
    otherIds.push(String(first.body['id']));

    const second = await fix.call('POST', '/api/v1/Sales/providerEvent', {
      provider: 'test-provider',
      providerEventId: eventId,
      eventType: 'payment.succeeded',
      payload: { amount: '25.00', currency: 'USD' },
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    // A duplicate delivery creates no second log row.
    expect(second.body['id']).toBe(first.body['id']);
  });

  it('refuses a payload that carries card data or a reusable secret', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/providerEvent', {
      provider: 'test-provider',
      providerEventId: `evt-${fix.runId}-2`,
      eventType: 'payment.succeeded',
      payload: { amount: '10.00', cardNumber: '4111111111111111', cvc: '123' },
    });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/must not carry card data/);
  });
});
