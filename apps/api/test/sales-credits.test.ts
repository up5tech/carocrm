import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import {
  bootApi,
  createTestRole,
  createTestUser,
  purgeEntityEvents,
  shutdownApi,
} from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.11 — credit notes, write-offs and financial corrections through the real HTTP API.
 *
 * The acceptance criteria, one by one:
 *
 *  - an issued invoice's and credit note's amounts cannot be silently rewritten (the write guard,
 *    exercised on the record API);
 *  - an applied credit cannot exceed either side's remaining balance, and only live (unreversed)
 *    allocations count;
 *  - write-offs are permission-gated (administrator approval) and audited — a request changes no
 *    balance until it is approved, and the balance is re-checked at approval time;
 *  - every reversal keeps the original and the compensating entry on record.
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documents: { kind: string; id: string }[] = [];
const itemIds: string[] = [];
const otherIds: string[] = [];
const creditAllocationIds: string[] = [];
const writeOffIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

interface CreditAllocationResult {
  allocation: {
    id: string;
    creditNoteId: string;
    invoiceId: string;
    amount: string;
    status: 'active' | 'reversed';
    reversedAt: string | null;
    reversalReason: string | null;
  };
  creditNote: { id: string; unallocated: string };
  invoice: { id: string; amountDue: string; paymentStatus: string };
}

interface WriteOffResult {
  writeOff: {
    id: string;
    status: string;
    amount: string;
    requestedBy: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    reversedAt: string | null;
    reversalReason: string | null;
  };
  invoice: { id: string; amountDue: string; paymentStatus: string } | null;
}

let productSeq = 0;

async function issueInvoice(amount: string, currency = 'USD'): Promise<string> {
  productSeq += 1;
  const product = await fix.createProduct({
    sku: `AGENT-${fix.runId}-C${productSeq}`,
    unitPrice: amount,
  });
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'invoice',
    data: {
      name: `AGENT_TEST_${fix.runId} Invoice ${productSeq}`,
      currency,
      invoiceDate: '2026-10-15',
    },
    items: [
      {
        productId: product,
        quantity: '1',
        unitPrice: amount,
        taxRatePercent: '0',
      },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const invoiceId = String(created.body['id']);
  documents.push({ kind: 'invoice', id: invoiceId });
  const issued = await fix.call(
    'POST',
    `/api/v1/Sales/document/invoice/${invoiceId}/transition`,
    { action: 'issue' },
  );
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return invoiceId;
}

/** A manual credit note (draft), for amounts that do not mirror an invoice. */
async function createCreditNote(amount: string, currency = 'USD'): Promise<string> {
  productSeq += 1;
  const created = await fix.call('POST', '/api/v1/Sales/document', {
    kind: 'creditNote',
    data: {
      name: `AGENT_TEST_${fix.runId} Credit ${productSeq}`,
      currency,
      creditDate: '2026-10-15',
      reason: 'AGENT_TEST correction',
    },
    items: [
      {
        name: `AGENT_TEST_${fix.runId} credit line`,
        quantity: '1',
        unitPrice: amount,
        taxRatePercent: '0',
      },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  documents.push({ kind: 'creditNote', id });
  return id;
}

async function issueCreditNote(id: string): Promise<void> {
  const issued = await fix.call(
    'POST',
    `/api/v1/Sales/document/creditNote/${id}/transition`,
    { action: 'issue' },
  );
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
}

/** The supported creation path from an invoice: the conversion, which links the source. */
async function convertInvoiceToCreditNote(invoiceId: string): Promise<string> {
  const converted = await fix.call(
    'POST',
    `/api/v1/Sales/document/invoice/${invoiceId}/convert`,
    { action: 'convertToCreditNote' },
  );
  expect(converted.status, JSON.stringify(converted.body)).toBe(201);
  const id = String(converted.body['id']);
  documents.push({ kind: 'creditNote', id });
  return id;
}

async function allocateCredit(creditNoteId: string, invoiceId: string, amount: string) {
  return await fix.call('POST', `/api/v1/Sales/creditNote/${creditNoteId}/allocate`, {
    invoiceId,
    amount,
  });
}

async function readDocument(kind: string, id: string) {
  const result = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const { kind, id } of documents) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) {
      for (const item of items) itemIds.push(String((item as { id: string }).id));
    }
  }
  const all = [
    ...documents.map((document) => document.id),
    ...itemIds,
    ...otherIds,
    ...creditAllocationIds,
    ...writeOffIds,
  ];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  // Sales domain events carry their own ids, not an `entityType` — remove exactly the ones this run wrote.
  const eventIds = [...documents.map((document) => document.id), ...creditAllocationIds, ...writeOffIds];
  if (eventIds.length > 0) {
    await ctx.database.db
      .deleteFrom('outbox_events')
      .where((eb) =>
        eb.or([
          eb('payload', '->>', 'creditNoteId', 'in', eventIds as never),
          eb('payload', '->>', 'writeOffId', 'in', eventIds as never),
          eb('payload', '->>', 'allocationId', 'in', eventIds as never),
          eb('payload', '->>', 'invoiceId', 'in', eventIds as never),
        ]),
      )
      .execute()
      .catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, [
    'Invoice',
    'InvoiceItem',
    'CreditNote',
    'CreditNoteItem',
    'CreditNoteAllocation',
    'WriteOff',
    'Payment',
    'PaymentAllocation',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('credit notes from an invoice (19-S.11)', () => {
  it('converts an issued invoice into a linked, issued credit note with its whole value unallocated', async () => {
    const invoiceId = await issueInvoice('100.00');
    const creditNoteId = await convertInvoiceToCreditNote(invoiceId);

    const draft = await readDocument('creditNote', creditNoteId);
    expect(draft['document']).toMatchObject({
      status: 'draft',
      invoiceId,
      sourceEntity: 'Invoice',
      sourceId: invoiceId,
      currency: 'USD',
    });
    expect((draft['items'] as { unitPrice: string }[])[0]?.unitPrice).toBe('100.00');

    await issueCreditNote(creditNoteId);
    const issued = await readDocument('creditNote', creditNoteId);
    expect(issued['document']).toMatchObject({
      status: 'issued',
      unallocatedAmount: '100.00',
      invoiceId,
    });
    expect(String(issued['document']?.['number'] ?? '')).toMatch(/^CN-/);
  });

  it('refuses a second conversion of the same invoice (double-credit guard)', async () => {
    const invoiceId = await issueInvoice('40.00');
    await convertInvoiceToCreditNote(invoiceId);
    const again = await fix.call(
      'POST',
      `/api/v1/Sales/document/invoice/${invoiceId}/convert`,
      { action: 'convertToCreditNote' },
    );
    expect(again.status).toBe(422);
    expect(reasonOf(again)).toMatch(/already produced a credit note/);
  });

  it('refuses a client rewrite of an issued credit note through the record API', async () => {
    const creditNoteId = await createCreditNote('30.00');
    await issueCreditNote(creditNoteId);

    const serverOwned = await fix.call('PATCH', `/api/v1/CreditNote/${creditNoteId}`, {
      grossTotal: '1.00',
    });
    expect(serverOwned.status).toBe(422);
    expect(reasonOf(serverOwned)).toMatch(/computed by the server/);

    const forgedBalance = await fix.call('PATCH', `/api/v1/CreditNote/${creditNoteId}`, {
      unallocatedAmount: '999.00',
    });
    expect(forgedBalance.status).toBe(422);
    expect(reasonOf(forgedBalance)).toMatch(/computed by the server/);

    const lockedField = await fix.call('PATCH', `/api/v1/CreditNote/${creditNoteId}`, {
      creditDate: '2026-01-01',
    });
    expect(lockedField.status).toBe(422);
    expect(reasonOf(lockedField)).toMatch(/cannot be changed/);
  });
});

describe('allocating a credit note (19-S.11)', () => {
  it('applies part of a credit to an invoice and both balances follow', async () => {
    const invoiceId = await issueInvoice('100.00');
    const creditNoteId = await createCreditNote('40.00');
    await issueCreditNote(creditNoteId);

    const applied = await allocateCredit(creditNoteId, invoiceId, '30.00');
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result = applied.body as unknown as CreditAllocationResult;
    creditAllocationIds.push(result.allocation.id);
    expect(result.allocation.status).toBe('active');
    expect(result.creditNote).toEqual({ id: creditNoteId, unallocated: '10.00' });
    expect(result.invoice).toMatchObject({ amountDue: '70.00', paymentStatus: 'partiallyPaid' });

    // The stored view agrees with the response (both sides recomputed, not echoed).
    const invoice = await readDocument('invoice', invoiceId);
    expect(invoice['document']).toMatchObject({ status: 'issued', amountDue: '70.00', paymentStatus: 'partiallyPaid' });
    const creditNote = await readDocument('creditNote', creditNoteId);
    expect(creditNote['document']).toMatchObject({ unallocatedAmount: '10.00' });

    // The eligible-invoice list names the credit note's currency and what is still owed.
    const open = await fix.call('GET', `/api/v1/Sales/creditNote/allocatableInvoices?creditNoteId=${creditNoteId}`);
    expect(open.status).toBe(200);
    const row = (open.body['list'] as { id: string; outstanding: string; currency: string }[]).find(
      (item) => item.id === invoiceId,
    );
    expect(row).toMatchObject({ outstanding: '70.00', currency: 'USD' });
  });

  it("refuses an allocation beyond the credit note's remainder", async () => {
    const invoiceId = await issueInvoice('100.00');
    const creditNoteId = await createCreditNote('10.00');
    await issueCreditNote(creditNoteId);

    const tooMuch = await allocateCredit(creditNoteId, invoiceId, '20.00');
    expect(tooMuch.status).toBe(422);
    expect(reasonOf(tooMuch)).toMatch(/still unallocated on credit note/);
  });

  it('refuses an allocation beyond what the invoice still owes', async () => {
    const invoiceId = await issueInvoice('20.00');
    const creditNoteId = await createCreditNote('100.00');
    await issueCreditNote(creditNoteId);

    const tooMuch = await allocateCredit(creditNoteId, invoiceId, '30.00');
    expect(tooMuch.status).toBe(422);
    expect(reasonOf(tooMuch)).toMatch(/still outstanding/);
  });

  it('refuses a cross-currency allocation without a conversion snapshot', async () => {
    const invoiceId = await issueInvoice('50.00');
    const creditNoteId = await createCreditNote('50.00', 'EUR');
    await issueCreditNote(creditNoteId);

    const refused = await allocateCredit(creditNoteId, invoiceId, '10.00');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/exchange-rate snapshot/);
  });

  it('refuses allocations against a draft credit note', async () => {
    const invoiceId = await issueInvoice('50.00');
    const creditNoteId = await createCreditNote('50.00');
    // Not issued on purpose.
    const refused = await allocateCredit(creditNoteId, invoiceId, '10.00');
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/Only an issued credit note/);
  });

  it('reverses an allocation as a compensating entry and restores both sides', async () => {
    const invoiceId = await issueInvoice('100.00');
    const creditNoteId = await createCreditNote('40.00');
    await issueCreditNote(creditNoteId);

    const applied = await allocateCredit(creditNoteId, invoiceId, '30.00');
    const original = (applied.body as unknown as CreditAllocationResult).allocation;
    creditAllocationIds.push(original.id);

    const reversed = await fix.call('DELETE', `/api/v1/Sales/creditNote/allocation/${original.id}`, {
      reason: 'duplicate request',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    const after = reversed.body as unknown as CreditAllocationResult;
    expect(after.allocation.status).toBe('reversed');
    expect(after.allocation.reversedAt).not.toBeNull();
    expect(after.allocation.reversalReason).toBe('duplicate request');
    expect(after.creditNote.unallocated).toBe('40.00');
    expect(after.invoice).toMatchObject({ amountDue: '100.00', paymentStatus: 'unpaid' });

    // History is kept: the original row still exists, marked — not deleted.
    const kept = await fix.call('GET', `/api/v1/CreditNoteAllocation/${original.id}`);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body['reversedAt']).not.toBeNull();
    expect(kept.body['reversalReason']).toBe('duplicate request');

    // Reversing again is refused; the trail already says what happened.
    const twice = await fix.call('DELETE', `/api/v1/Sales/creditNote/allocation/${original.id}`, {});
    expect(twice.status).toBe(422);
    expect(reasonOf(twice)).toMatch(/already been reversed/);

    // The credit is allocatable again; the replacement is a *new* row.
    const reapplied = await allocateCredit(creditNoteId, invoiceId, '25.00');
    expect(reapplied.status, JSON.stringify(reapplied.body)).toBe(201);
    const replacement = (reapplied.body as unknown as CreditAllocationResult).allocation;
    creditAllocationIds.push(replacement.id);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.status).toBe('active');
  });
});

describe('rendering a credit note (19-S.11)', () => {
  it('renders through a named template and reports an unresolved placeholder instead of blanking it', async () => {
    const invoiceId = await issueInvoice('100.00');
    const creditNoteId = await convertInvoiceToCreditNote(invoiceId);
    await issueCreditNote(creditNoteId);

    const code = `agent_test_credit_${fix.runId}`;
    const template = await fix.call('POST', '/api/v1/DocumentTemplate', {
      name: `AGENT_TEST_${fix.runId} credit template`,
      code,
      entityType: 'CreditNote',
      subject: 'Credit {{number}}',
      body: '<h1>{{title}}</h1><p>Unallocated: {{{unallocatedAmount}}} {{currency}}</p><p>{{unknownPlaceholder}}</p>',
      format: 'html',
      active: true,
      isDefault: false,
    });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    otherIds.push(String(template.body['id']));

    const rendered = await fix.call(
      'POST',
      `/api/v1/Sales/creditNote/${creditNoteId}/render`,
      { templateCode: code },
    );
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
    const result = rendered.body as {
      templateCode: string | null;
      subject: string;
      body: string;
      text: string;
      blocks: unknown[];
      warnings: string[];
      fromSnapshot: boolean;
      pdf: { available: boolean };
    };

    expect(result.templateCode).toBe(code);
    expect(result.fromSnapshot).toBe(true);
    expect(result.subject).toMatch(/^Credit CN-/);
    expect(result.body).toContain('Credit Note CN-');
    expect(result.body).toContain('Unallocated: 100.00 USD');
    // The kernel renderer's rule: an unanswerable placeholder stays visible and is reported.
    expect(result.body).toContain('{{unknownPlaceholder}}');
    expect(result.warnings.some((warning) => warning.includes('unknownPlaceholder'))).toBe(true);
    // The block model travels with the result, so a PDF renderer gets the same document.
    expect(result.blocks.length).toBeGreaterThan(0);
    // The plain-text rendering walks the same blocks; its headings are uppercased.
    expect(result.text).toMatch(/CREDIT NOTE CN-/);
    expect(typeof result.pdf.available).toBe('boolean');
  });
});

describe('write-offs (19-S.11)', () => {
  it('requests a pending write-off that changes no balance', async () => {
    const invoiceId = await issueInvoice('100.00');
    const requested = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '25.00',
      reason: 'AGENT_TEST uncollectible',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const result = requested.body as unknown as WriteOffResult;
    writeOffIds.push(result.writeOff.id);
    expect(result.writeOff).toMatchObject({ status: 'pending', amount: '25.00', requestedBy: 'admin' });
    expect(result.invoice).toBeNull();

    // A pending request is not money: the invoice is untouched.
    const invoice = await readDocument('invoice', invoiceId);
    expect(invoice['document']).toMatchObject({ amountDue: '100.00', paymentStatus: 'unpaid' });
  });

  it('approves a pending write-off, reducing the invoice, with the event and audit trail on record', async () => {
    const invoiceId = await issueInvoice('100.00');
    const requested = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '25.00',
      reason: 'AGENT_TEST uncollectible',
    });
    const writeOffId = (requested.body as unknown as WriteOffResult).writeOff.id;
    writeOffIds.push(writeOffId);

    const approved = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const result = approved.body as unknown as WriteOffResult;
    expect(result.writeOff).toMatchObject({ status: 'approved', approvedBy: 'admin' });
    expect(result.writeOff.approvedAt).not.toBeNull();
    expect(result.invoice).toMatchObject({ amountDue: '75.00', paymentStatus: 'partiallyPaid' });

    const invoice = await readDocument('invoice', invoiceId);
    expect(invoice['document']).toMatchObject({ status: 'issued', amountDue: '75.00' });

    const events = await ctx.database.db
      .selectFrom('outbox_events')
      .select(['event_type'])
      .where('event_type', '=', 'sales.writeOff.approved')
      .where(sql<boolean>`payload ->> 'writeOffId' = ${writeOffId}`)
      .execute();
    expect(events.length).toBe(1);

    const audits = await ctx.database.db
      .selectFrom('audit_log')
      .select(['id'])
      .where('entity_type', '=', 'WriteOff')
      .where('record_id', '=', writeOffId)
      .execute();
    expect(audits.length).toBeGreaterThan(0);
  });

  it('rejects a pending write-off without touching the invoice', async () => {
    const invoiceId = await issueInvoice('100.00');
    const requested = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '10.00',
      reason: 'AGENT_TEST doubtful',
    });
    const writeOffId = (requested.body as unknown as WriteOffResult).writeOff.id;
    writeOffIds.push(writeOffId);

    const rejected = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/reject`, {
      reason: 'not justified',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((rejected.body as unknown as WriteOffResult).writeOff.status).toBe('rejected');

    const invoice = await readDocument('invoice', invoiceId);
    expect(invoice['document']).toMatchObject({ amountDue: '100.00' });
    // The request stays on record.
    const kept = await fix.call('GET', `/api/v1/WriteOff/${writeOffId}`);
    expect(kept.status).toBe(200);
    expect(kept.body['status']).toBe('rejected');
  });

  it('reverses an approved write-off, restoring the receivable and keeping both entries', async () => {
    const invoiceId = await issueInvoice('80.00');
    const requested = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '30.00',
      reason: 'AGENT_TEST written off in error',
    });
    const writeOffId = (requested.body as unknown as WriteOffResult).writeOff.id;
    writeOffIds.push(writeOffId);
    await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/approve`, {});

    const reversed = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/reverse`, {
      reason: 'customer paid after all',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    const result = reversed.body as unknown as WriteOffResult;
    expect(result.writeOff.status).toBe('reversed');
    expect(result.writeOff.reversalReason).toBe('customer paid after all');
    expect(result.writeOff.reversedAt).not.toBeNull();
    expect(result.invoice).toMatchObject({ amountDue: '80.00', paymentStatus: 'unpaid' });

    // Both entries: the write-off row is still there with the reversal trail.
    const kept = await fix.call('GET', `/api/v1/WriteOff/${writeOffId}`);
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ status: 'reversed', reversalReason: 'customer paid after all' });

    // Only an approved write-off can be reversed; the state machine refuses the second attempt.
    const again = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/reverse`, { reason: 'again' });
    expect(again.status).toBe(422);
    expect(reasonOf(again)).toMatch(/can only be reversed/);
  });

  it('refuses a write-off beyond the outstanding balance, and re-checks it at approval', async () => {
    const invoiceId = await issueInvoice('100.00');
    const tooMuch = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '150.00',
      reason: 'AGENT_TEST too much',
    });
    expect(tooMuch.status).toBe(422);
    expect(reasonOf(tooMuch)).toMatch(/exceeds the 100\.00 still outstanding/);

    const zero = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId,
      amount: '0.00',
      reason: 'AGENT_TEST zero',
    });
    expect(zero.status).toBe(422);
    expect(reasonOf(zero)).toMatch(/greater than zero/);

    // Request what is left, then settle the invoice with a payment: approval must notice.
    const invoiceTwo = await issueInvoice('60.00');
    const requested = await fix.call('POST', '/api/v1/Sales/write-off', {
      invoiceId: invoiceTwo,
      amount: '60.00',
      reason: 'AGENT_TEST full amount',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const writeOffId = (requested.body as unknown as WriteOffResult).writeOff.id;
    writeOffIds.push(writeOffId);

    const payment = await fix.call('POST', '/api/v1/Sales/payment', {
      amount: '60.00',
      currency: 'USD',
      direction: 'incoming',
      date: '2026-10-15',
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const paymentId = String(payment.body['id']);
    otherIds.push(paymentId);
    await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/transition`, { action: 'confirm' });
    const allocated = await fix.call('POST', `/api/v1/Sales/payment/${paymentId}/allocate`, {
      documentId: invoiceTwo,
      amount: '60.00',
    });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
    otherIds.push(String((allocated.body as { allocation: { id: string } }).allocation.id));

    const late = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/approve`, {});
    expect(late.status).toBe(422);
    expect(reasonOf(late)).toMatch(/exceeds the 0\.00 still outstanding/);
  });

  it('gates approval on an administrator and the decision fields on the write guard', async () => {
    const invoiceId = await issueInvoice('100.00');

    const roleId = `role-${fix.runId}-writeoff`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} write-off requester`,
      permissions: {
        Invoice: { read: 'all', create: 'no', edit: 'yes', delete: 'no', stream: 'no' },
        // `edit` is granted on purpose: ACL is not the layer that must stop a forged decision — the
        // write guard is, and this role proves it.
        WriteOff: { read: 'all', create: 'yes', edit: 'yes', delete: 'no', stream: 'no' },
      },
    });
    const requester = await createTestUser(ctx, {
      userName: `s11requester${fix.runId}`,
      roleIds: [roleId],
    });
    cleanupUsers.push(requester.id);

    // A granted role may *request* — create asks for the tenant's write-off permission, not an admin.
    const requested = await fix.call(
      'POST',
      '/api/v1/Sales/write-off',
      { invoiceId, amount: '10.00', reason: 'AGENT_TEST dusty invoice' },
      requester.token,
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const writeOffId = (requested.body as unknown as WriteOffResult).writeOff.id;
    writeOffIds.push(writeOffId);

    // …but approving, rejecting and reversing are administrator decisions.
    const deniedApprove = await fix.call(
      'POST',
      `/api/v1/Sales/write-off/${writeOffId}/approve`,
      {},
      requester.token,
    );
    expect(deniedApprove.status, JSON.stringify(deniedApprove.body)).toBe(403);
    expect(reasonOf(deniedApprove)).toMatch(/Administrator access is required for approving write-offs/);

    const deniedReverse = await fix.call(
      'POST',
      `/api/v1/Sales/write-off/${writeOffId}/reverse`,
      { reason: 'nope' },
      requester.token,
    );
    expect(deniedReverse.status).toBe(403);

    // The write guard refuses forging the decision fields, on create or update.
    const forgedCreate = await fix.call(
      'POST',
      '/api/v1/WriteOff',
      {
        name: `AGENT_TEST_${fix.runId} forged write-off`,
        invoiceId,
        amount: '1.00',
        reason: 'forged',
        status: 'approved',
      },
      requester.token,
    );
    expect(forgedCreate.status).toBe(422);
    expect(reasonOf(forgedCreate)).toMatch(/computed by the server/);

    const forgedUpdate = await fix.call(
      'PATCH',
      `/api/v1/WriteOff/${writeOffId}`,
      { status: 'approved' },
      requester.token,
    );
    expect(forgedUpdate.status).toBe(422);
    expect(reasonOf(forgedUpdate)).toMatch(/computed by the server/);

    // A decided write-off is frozen: its amount cannot be rewritten through the record API either.
    const approved = await fix.call('POST', `/api/v1/Sales/write-off/${writeOffId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const rewrite = await fix.call('PATCH', `/api/v1/WriteOff/${writeOffId}`, { amount: '1.00' });
    expect(rewrite.status).toBe(422);
    expect(reasonOf(rewrite)).toMatch(/can no longer be changed/);
  });
});
