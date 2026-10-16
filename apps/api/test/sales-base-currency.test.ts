import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.18 — the persisted exchange-rate snapshot (§4.13).
 *
 * A conversion is a fact about a moment, so it has to be *stored*, not re-derived: "never recompute
 * old issued document base-currency values using a newer exchange rate". Before this phase the module
 * read `exchangeRateSnapshot` in three places (the totals recalculation, the cross-currency allocation
 * gate, the bill-credit conversion) and **nothing ever wrote it**, so base-currency totals were always
 * null and a cross-currency allocation could never be authorised. These tests pin the closed loop:
 *
 *  - a document stores the rate it was converted at, and reusing it later reproduces the same base
 *    total instead of today's rate;
 *  - once the document is issued, the frozen rate is immutable like the rest of the issued money;
 *  - a payment freezes its own rate, derives `baseAmount`, and every allocation against it carries
 *    the amount converted at *that* rate — never a fresh quote;
 *  - a client cannot set any of it through the generic record API, and a rate that does not describe
 *    the money it is attached to is refused.
 *
 * Configured primary database only (AGENTS.MD §3.1); `AGENT_TEST_` rows deleted by exact id (§3.3).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documentIds: { kind: string; id: string }[] = [];
const paymentIds: string[] = [];

const USD_TO_EUR = {
  documentCurrency: 'USD',
  baseCurrency: 'EUR',
  rate: '0.9000',
  rateDate: '2026-10-01',
  source: 'AGENT_TEST ledger',
};

async function createInvoice(
  amount: string,
  exchangeRate?: Record<string, unknown>,
  issue = false,
) {
  const product = await fix.createProduct({
    sku: `AGENT-${fix.runId}-BC${documentIds.length}`,
    unitPrice: amount,
  });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'invoice',
    data: {
      name: `AGENT_TEST_${fix.runId} Base currency invoice`,
      currency: 'USD',
      invoiceDate: '2026-10-15',
    },
    items: [{ productId: product, quantity: '1', unitPrice: amount, taxRatePercent: '0' }],
    ...(exchangeRate === undefined ? {} : { exchangeRate }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  documentIds.push({ kind: 'invoice', id });
  if (issue) {
    const issued = await fix.call('POST', `/api/v1/Sales/document/invoice/${id}/transition`, {
      action: 'issue',
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  }
  return { id, view: created.body };
}

async function readInvoice(id: string): Promise<Record<string, unknown>> {
  const result = await fix.call('GET', `/api/v1/Sales/document/invoice/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function createPayment(amount: string, exchangeRate?: Record<string, unknown>) {
  const created = await fix.call('POST', '/api/v1/Sales/payment', {
    amount,
    currency: 'USD',
    direction: 'incoming',
    ...(exchangeRate === undefined ? {} : { exchangeRate }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id'] ?? ((created.body['payment'] as Record<string, unknown>)['id']));
  paymentIds.push(id);
  return { id, view: created.body };
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  const records = [...documentIds.map((entry) => entry.id), ...paymentIds];
  if (paymentIds.length > 0) {
    // Allocation rows keep only their `paymentId`, so they are found by exactly that.
    await sql`
      delete from entity_records
      where entity_type in ('PaymentAllocation', 'WriteOff')
        and (attrs ->> 'paymentId') in (${sql.join(paymentIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (records.length > 0) {
    await sql`
      delete from audit_log where record_id in (${sql.join(records)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`
      delete from entity_records where id in (${sql.join(records)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  await fix.cleanup().catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['Invoice', 'Payment']).catch(() => undefined);
  await shutdownApi();
});

describe('the frozen exchange rate on a document (19-S.18)', () => {
  it('stores the snapshot and the base total the conversion produced', async () => {
    const { id, view } = await createInvoice('200.00', USD_TO_EUR);
    const totals = view['totals'] as Record<string, unknown>;
    expect(String(totals['baseCurrency'])).toBe('EUR');
    expect(String(totals['baseGrossTotal'])).toBe('180.00');

    const stored = await readInvoice(id);
    const document = stored['document'] as Record<string, unknown>;
    const snapshot = JSON.parse(String(document['exchangeRateSnapshot'])) as Record<string, unknown>;
    // Stored validated and canonical: the rate is the decimal, not the string the caller typed.
    expect(String(snapshot['rate'])).toBe('0.9');
    expect(String(snapshot['rateDate'])).toBe('2026-10-01');
    expect(String(snapshot['source'])).toBe('AGENT_TEST ledger');
  });

  it('reuses the stored rate on a later recalculation instead of a newer one', async () => {
    const { id } = await createInvoice('200.00', USD_TO_EUR);
    const before = await readInvoice(id);
    const beforeTotals = before['totals'] as Record<string, unknown>;

    const recalculated = await fix.call('POST', `/api/v1/Sales/document/invoice/${id}/recalculate`, {});
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    const afterTotals = recalculated.body['totals'] as Record<string, unknown>;
    expect(String(afterTotals['baseGrossTotal'])).toBe(String(beforeTotals['baseGrossTotal']));
    expect(String(afterTotals['baseCurrency'])).toBe('EUR');
  });

  it('refuses to move the frozen rate of an issued document', async () => {
    const { id } = await createInvoice('200.00', USD_TO_EUR);
    const issued = await fix.call('POST', `/api/v1/Sales/document/invoice/${id}/transition`, {
      action: 'issue',
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);

    const retaxed = await fix.call('PATCH', `/api/v1/Sales/document/invoice/${id}`, {
      exchangeRate: { ...USD_TO_EUR, rate: '0.5000', rateDate: '2027-01-01' },
    });
    expect(retaxed.status, JSON.stringify(retaxed.body)).toBe(422);
    expect(reasonOf(retaxed)).toMatch(/exchangeRateSnapshot/);

    const still = await readInvoice(id);
    const totals = still['totals'] as Record<string, unknown>;
    expect(String(totals['baseGrossTotal'])).toBe('180.00');
  });

  it('refuses a snapshot that describes a different currency than the document', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'invoice',
      data: {
        name: `AGENT_TEST_${fix.runId} mismatched rate`,
        currency: 'USD',
        invoiceDate: '2026-10-15',
      },
      items: [{ name: `AGENT_TEST_${fix.runId} line`, quantity: '1', unitPrice: '10.00', taxRatePercent: '0' }],
      exchangeRate: { ...USD_TO_EUR, documentCurrency: 'GBP' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(JSON.stringify(result.body)).toMatch(/GBP/);
  });

  it('leaves base figures absent when no conversion was supplied', async () => {
    const { id } = await createInvoice('200.00');
    const stored = await readInvoice(id);
    const document = stored['document'] as Record<string, unknown>;
    expect(document['exchangeRateSnapshot'] ?? null).toBe(null);
    expect((stored['totals'] as Record<string, unknown>)['baseGrossTotal']).toBeNull();
  });
});

describe('the frozen exchange rate on payments and allocations (19-S.18)', () => {
  it('freezes the rate on the payment and derives its base amount', async () => {
    const { view } = await createPayment('100.00', USD_TO_EUR);
    expect(String(view['baseCurrency'])).toBe('EUR');
    expect(String(view['baseAmount'])).toBe('90.00');
    expect(String(view['baseUnallocatedAmount'])).toBe('90.00');
    expect(view['baseAllocatedAmount'] ?? '0.00').toBeTruthy();
  });

  it('converts each allocation at the payment rate and keeps the base balances consistent', async () => {
    const { id: invoiceId } = await createInvoice('200.00', undefined, true);
    const { id: paymentId } = await createPayment('100.00', USD_TO_EUR);
    const confirmed = await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/transition`, {
      action: 'confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const allocated = await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, {
      documentEntity: 'Invoice',
      documentId: invoiceId,
      amount: '40.00',
    });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
    const allocation = allocated.body['allocation'] as Record<string, unknown>;
    expect(String(allocation['baseCurrency'])).toBe('EUR');
    expect(String(allocation['baseAmount'])).toBe('36.00');

    const after = await fix.call('GET', `/api/v1/Sales/payment/${paymentId}`);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const payment = after.body as Record<string, unknown>;
    expect(String(payment['baseAllocatedAmount'])).toBe('36.00');
    expect(String(payment['baseUnallocatedAmount'])).toBe('54.00');
    // 36.00 + 54.00 = the 90.00 the payment was frozen at: the base halves always add back up.
    expect(String(payment['baseAmount'])).toBe('90.00');
  });

  it('refuses a new rate once the payment has allocations', async () => {
    const { id: invoiceId } = await createInvoice('200.00', undefined, true);
    const { id: paymentId } = await createPayment('100.00', USD_TO_EUR);
    await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/transition`, { action: 'confirm' });
    const allocated = await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, {
      documentEntity: 'Invoice',
      documentId: invoiceId,
      amount: '10.00',
    });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);

    const reprice = await fix.call('PATCH', `/api/v1/Sales/payment/${paymentId}`, {
      exchangeRate: { ...USD_TO_EUR, rate: '0.5000', rateDate: '2027-01-01' },
    });
    expect(reprice.status, JSON.stringify(reprice.body)).toBe(422);
    expect(reasonOf(reprice)).toMatch(/exchangeRate/);
  });

  it('refuses a client-supplied base amount or snapshot through the generic record API', async () => {
    const forged = await fix.call('POST', '/api/v1/Payment', {
      name: `AGENT_TEST_${fix.runId} forged base`,
      amount: '10.00',
      currency: 'USD',
      direction: 'incoming',
      baseAmount: '9.99',
    });
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(reasonOf(forged)).toMatch(/baseAmount/);

    const forgedSnapshot = await fix.call('POST', '/api/v1/Payment', {
      name: `AGENT_TEST_${fix.runId} forged snapshot`,
      amount: '10.00',
      currency: 'USD',
      direction: 'incoming',
      exchangeRateSnapshot: '{"documentCurrency":"USD","baseCurrency":"EUR","rate":"9.00","rateDate":"2026-10-01"}',
    });
    expect(forgedSnapshot.status, JSON.stringify(forgedSnapshot.body)).toBe(422);
    expect(reasonOf(forgedSnapshot)).toMatch(/exchangeRateSnapshot/);
  });

  it('refuses a payment rate that does not describe the payment currency', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/payment', {
      amount: '100.00',
      currency: 'USD',
      direction: 'incoming',
      exchangeRate: { ...USD_TO_EUR, documentCurrency: 'GBP' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(422);
  });
});
