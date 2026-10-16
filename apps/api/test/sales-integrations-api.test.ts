import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.19 — the read contracts other modules consume (§11.2–§11.4).
 *
 * What has to be true for these to be a contract rather than a convenience:
 *
 *  - **an issued document answers from its snapshot**, so an accounting consumer posts what the
 *    customer was actually billed even after the catalog, tax rates or settings move on;
 *  - **the conversion travels with it** — the frozen rate, its date and source, and the base figures
 *    derived at that rate, never a re-rated history (§4.13);
 *  - **settlement rows are reported in the currency they were recorded in**, with their own base
 *    amounts, and a reversed row is reported as history rather than as money;
 *  - **access control is the same as the UI's**, not a parallel policy: a reader who cannot read the
 *    document or the ledger gets `403`, and the summary refuses rather than showing a partial book;
 *  - the envelope carries `contractVersion`, so a consumer can tell what shape it is speaking to.
 *
 * Configured primary database only (AGENTS.MD §3.1); `AGENT_TEST_` rows deleted by exact id (§3.3).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documentIds: { kind: string; id: string }[] = [];
const paymentIds: string[] = [];
const extraIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

const USD_TO_EUR = {
  documentCurrency: 'USD',
  baseCurrency: 'EUR',
  rate: '0.9',
  rateDate: '2026-10-01',
  source: 'AGENT_TEST contract',
};

async function issuedInvoice(accountId: string, amount: string): Promise<string> {
  const product = await fix.createProduct({
    sku: `AGENT-${fix.runId}-CONTRACT${documentIds.length}`,
    unitPrice: amount,
  });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'invoice',
    data: {
      name: `AGENT_TEST_${fix.runId} contract invoice`,
      accountId,
      currency: 'USD',
      invoiceDate: '2026-10-15',
      dueDate: '2026-11-14',
    },
    items: [{ productId: product, quantity: '1', unitPrice: amount, taxRatePercent: '10' }],
    exchangeRate: USD_TO_EUR,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  documentIds.push({ kind: 'invoice', id });
  const issued = await fix.call('POST', `/api/v1/Sales/document/invoice/${id}/transition`, {
    action: 'issue',
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return id;
}

async function confirmedPayment(accountId: string, amount: string): Promise<string> {
  const created = await fix.call('POST', '/api/v1/Sales/payment', {
    amount,
    currency: 'USD',
    direction: 'incoming',
    accountId,
    exchangeRate: USD_TO_EUR,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  paymentIds.push(id);
  const confirmed = await fix.call('POST', `/api/v1/Sales/payment/${id}/transition`, {
    action: 'confirm',
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const { kind, id } of documentIds) {
    await fix.call('DELETE', `/api/v1/Sales/document/${kind}/${id}`).catch(() => undefined);
  }
  const all = [...paymentIds, ...extraIds];
  if (paymentIds.length > 0) {
    await sql`
      delete from entity_records
      where entity_type = 'PaymentAllocation'
        and (attrs ->> 'paymentId') in (${sql.join(paymentIds)})
    `
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (all.length > 0) {
    await sql`delete from audit_log where record_id in (${sql.join(all)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`delete from entity_records where id in (${sql.join(all)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (cleanupUsers.length > 0) {
    await sql`delete from users_roles where user_id in (${sql.join(cleanupUsers)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`delete from users where id in (${sql.join(cleanupUsers)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (cleanupRoles.length > 0) {
    await sql`delete from roles where id in (${sql.join(cleanupRoles)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  await fix.cleanup().catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['Invoice', 'Payment', 'CreditNote']).catch(() => undefined);
  await shutdownApi();
});

describe('the accounting export contract (19-S.19, §11.3)', () => {
  it('answers from the frozen snapshot, with the conversion and the tax breakdown', async () => {
    const accountId = await fix.create('Account', { name: `AGENT_TEST_${fix.runId} Acme` });
    const invoiceId = await issuedInvoice(accountId, '200.00');

    const result = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'invoice',
      id: invoiceId,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['contractVersion']).toBe(1);

    const document = result.body['document'] as Record<string, unknown>;
    expect(document['entity']).toBe('Invoice');
    expect(document['fromSnapshot']).toBe(true);
    expect(document['status']).toBe('issued');
    expect(String(document['number'])).toMatch(/^INV-/);
    // 200.00 net + 10% tax = 220.00 gross, converted at the rate this invoice was issued with.
    const totals = document['totals'] as Record<string, unknown>;
    expect(String(totals['netTotal'])).toBe('200.00');
    expect(String(totals['taxTotal'])).toBe('20.00');
    expect(String(totals['grossTotal'])).toBe('220.00');
    expect(String(document['baseCurrency'])).toBe('EUR');
    expect(String(document['baseGrossTotal'])).toBe('198.00');

    const snapshot = JSON.parse(String(document['exchangeRateSnapshot'])) as Record<string, unknown>;
    expect(String(snapshot['rateDate'])).toBe('2026-10-01');
    expect(String(snapshot['source'])).toBe('AGENT_TEST contract');

    const breakdown = document['taxBreakdown'] as Record<string, unknown>[];
    expect(breakdown).toHaveLength(1);
    expect(String(breakdown[0]?.['taxAmount'])).toBe('20.00');

    const lines = document['lines'] as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.['netAmount'])).toBe('200.00');
    expect(String(lines[0]?.['taxAmount'])).toBe('20.00');
    expect(String(lines[0]?.['grossAmount'])).toBe('220.00');
    // The line carried its rate explicitly, and that is what the snapshot says it was charged.
    expect(String(lines[0]?.['taxSource'])).toBe('line');
  });

  it('reports settlement rows in their own currency, with their base amounts', async () => {
    const accountId = await fix.create('Account', { name: `AGENT_TEST_${fix.runId} Settled` });
    const invoiceId = await issuedInvoice(accountId, '100.00');
    const paymentId = await confirmedPayment(accountId, '60.00');

    const allocated = await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, {
      documentEntity: 'Invoice',
      documentId: invoiceId,
      amount: '60.00',
    });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);

    const result = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'invoice',
      id: invoiceId,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const settledBy = result.body['settledBy'] as Record<string, unknown>;
    const allocations = settledBy['allocations'] as Record<string, unknown>[];
    expect(allocations).toHaveLength(1);
    expect(String(allocations[0]?.['amount'])).toBe('60.00');
    expect(String(allocations[0]?.['currency'])).toBe('USD');
    expect(String(allocations[0]?.['baseAmount'])).toBe('54.00');
    expect(String(allocations[0]?.['baseCurrency'])).toBe('EUR');
    // A write-off nobody requested, and no credit: the buckets exist and are empty, not missing.
    expect(settledBy['writeOffs']).toEqual([]);
    expect(settledBy['credits']).toEqual([]);

    const remaining = result.body['document'] as Record<string, unknown>;
    const totals = remaining['totals'] as Record<string, unknown>;
    expect(String(totals['amountDue'])).toBe('50.00');
  });

  it('keeps the sync fields null: Sales does not claim what an accounting system did', async () => {
    const accountId = await fix.create('Account', { name: `AGENT_TEST_${fix.runId} Unsynced` });
    const invoiceId = await issuedInvoice(accountId, '50.00');
    const result = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'invoice',
      id: invoiceId,
    });
    expect(result.body['externalSync']).toEqual({ accountingReference: null, syncedAt: null });
  });

  it('refuses an unknown document kind or id instead of exporting nothing quietly', async () => {
    const badKind = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'purchaseInvoice',
      id: 'whatever',
    });
    expect(badKind.status).toBe(400);

    const missing = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'invoice',
      id: 'AGENT_TEST_does_not_exist',
    });
    expect(missing.status).toBe(404);
  });
});

describe('the customer commercial summary (19-S.19, §11.4)', () => {
  it('answers in the currency the records were recorded in, and never adds across currencies', async () => {
    const accountId = await fix.create('Account', { name: `AGENT_TEST_${fix.runId} Summary` });
    await issuedInvoice(accountId, '120.00');
    const invoiceId = await issuedInvoice(accountId, '80.00');
    const paymentId = await confirmedPayment(accountId, '50.00');
    await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, {
      documentEntity: 'Invoice',
      documentId: invoiceId,
      amount: '50.00',
    });

    const result = await fix.call('POST', '/api/v1/Sales/action/customerSummary', { accountId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['contractVersion']).toBe(1);
    expect(result.body['accountId']).toBe(accountId);

    const receivables = result.body['receivables'] as Record<string, unknown>;
    expect(receivables['openInvoiceCount']).toBe(2);
    const byCurrency = receivables['outstandingByCurrency'] as Record<string, unknown>[];
    expect(byCurrency).toHaveLength(1);
    expect(String(byCurrency[0]?.['currency'])).toBe('USD');
    // (120 + 10% tax) + (80 + 10% tax settled by a 50 payment) = 132.00 + 38.00
    expect(String(byCurrency[0]?.['amount'])).toBe('170.00');
    expect(byCurrency[0]?.['count']).toBe(2);

    const payments = result.body['recentPayments'] as Record<string, unknown>[];
    expect(payments.length).toBeGreaterThanOrEqual(1);
    expect(String(payments[0]?.['baseCurrency'])).toBe('EUR');
    expect(String(payments[0]?.['baseAmount'])).toBe('45.00');
    expect(result.body['truncated']).toBe(false);
  });

  it('refuses a reader who cannot read the ledger it would summarise', async () => {
    await createTestRole(ctx, {
      id: 'r_agent_sales_contract_viewer',
      name: 'AGENT_TEST Sales contract viewer',
      permissions: {
        Invoice: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
        CreditNote: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
        Payment: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
        Subscription: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
      },
    });
    cleanupRoles.push('r_agent_sales_contract_viewer');
    const viewer = await createTestUser(ctx, {
      userName: 'agent_sales_contract_viewer',
      roleIds: ['r_agent_sales_contract_viewer'],
    });
    cleanupUsers.push(viewer.id);

    const summary = await fix.call('POST', '/api/v1/Sales/action/customerSummary', {
      accountId: 'anything',
    }, viewer.token);
    expect(summary.status, JSON.stringify(summary.body)).toBe(403);

    const exportResult = await fix.call('POST', '/api/v1/Sales/action/accountingExport', {
      kind: 'invoice',
      id: documentIds[0]?.id ?? 'x',
    }, viewer.token);
    expect(exportResult.status, JSON.stringify(exportResult.body)).toBe(403);
    expect(reasonOf(exportResult)).toMatch(/Invoice/);
  });

  it('requires an account id', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/action/customerSummary', { accountId: '  ' });
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(reasonOf(result)).toMatch(/not valid/);
  });
});
