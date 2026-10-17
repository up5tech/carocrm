import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phases 19-S.6, 19-S.8, 19-S.9 — the commercial document lifecycle through the real HTTP API.
 *
 * What this suite exists to prove, in the plan's own terms:
 *
 *  - totals are the **server's** numbers and a caller cannot set them (§5.7);
 *  - issuance is one transaction: a number, an issuer, a lock and a snapshot (§4.7);
 *  - an issued document refuses protected-field edits, and so does the **generic** record API — a
 *    crafted `PUT /api/v1/Invoice/:id` must not be able to forge a paid invoice (19-S.9 acceptance);
 *  - a conversion copies values by value and is idempotent under retries, and a second conversion of
 *    the same thing is refused rather than billed twice (§4.5, §4.6);
 *  - a due date is computed from the payment terms the document references (19-S.9);
 *  - a correction needs a reason and an unlock needs the permission (§4.7, §4.9).
 *
 * Runs against the configured primary database through the booted application (AGENTS.md §3.1). Every
 * row this suite writes is removed by exact id in `afterAll`; no test database is created.
 */

let ctx: ApiContext;
let fix: SalesFixture;

/** Documents this run created, so cleanup removes exactly them and nothing else (AGENTS.md §3.3). */
const documents: { kind: string; id: string }[] = [];
/** Records created through the generic record API (a payment-terms profile, a role's invoice). */
const rawIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

interface DocumentView {
  kind: string;
  id: string;
  document: Record<string, unknown>;
  items: { id: string; position: number; quantity: string; sourceItemId?: string | null }[];
  totals: { netTotal: string; taxTotal: string; grossTotal: string; amountDue: string };
  lock: { issuedAt: string | null; issuedBy: string | null; locked: boolean };
  fromSnapshot: boolean;
  availableTransitions: string[];
  availableConversions: string[];
  actions: { action: string; label: string; requiresReason: boolean; issues: boolean; to: string }[];
  conversions: { action: string; label: string; toKind: string }[];
}

const LINE_TAX_FREE = { taxRatePercent: '0' };

async function createDocument(
  kind: string,
  data: Record<string, unknown>,
  items: Record<string, unknown>[],
): Promise<DocumentView> {
  const result = await fix.call('POST', '/api/v1/Sales/document', { kind, data, items });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const view = result.body as unknown as DocumentView;
  documents.push({ kind, id: view.id });
  return view;
}

async function read(kind: string, id: string): Promise<DocumentView> {
  const result = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as unknown as DocumentView;
}

async function transition(
  kind: string,
  id: string,
  action: string,
  reason?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, {
    action,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function convert(
  kind: string,
  id: string,
  action: string,
  correlationId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/convert`, {
    action,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

/** A quote with two priced lines, ready to be sent. */
let draftSeq = 0;
async function draftQuote(unitPrice = '10.00'): Promise<DocumentView> {
  draftSeq += 1;
  const product = await fix.createProduct({ sku: `AGENT-${fix.runId}-Q${draftSeq}`, unitPrice });
  return await createDocument(
    'quote',
    { name: `AGENT_TEST_${fix.runId} Quote`, currency: 'USD', quoteDate: '2026-10-15' },
    [
      { productId: product, quantity: '2', unitPrice, ...LINE_TAX_FREE },
      { name: `AGENT_TEST_${fix.runId} Service`, quantity: '1', unitPrice: '50.00', ...LINE_TAX_FREE },
    ],
  );
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  // Read the item ids back from the documents before deleting, so lines are removed with their parents.
  const itemIds: string[] = [];
  for (const { kind, id } of documents) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) {
      for (const item of items) itemIds.push(String((item as { id: string }).id));
    }
  }
  const all = [...documents.map((document) => document.id), ...itemIds, ...rawIds];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, [
    'Quote',
    'QuoteItem',
    'SalesOrder',
    'SalesOrderItem',
    'Invoice',
    'InvoiceItem',
    'PaymentTermProfile',
  ]);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('creating a document (19-S.6)', () => {
  it('creates a draft, calculates its totals on the server and reports what may happen next', async () => {
    const quote = await draftQuote();

    expect(quote.document['status']).toBe('draft');
    expect(quote.items).toHaveLength(2);
    expect(quote.items.map((item) => item.position)).toEqual([1, 2]);
    // 2 × 10.00 + 1 × 50.00, no tax on either line.
    expect(quote.totals.netTotal).toBe('70.00');
    expect(quote.totals.taxTotal).toBe('0.00');
    expect(quote.totals.grossTotal).toBe('70.00');
    expect(quote.fromSnapshot).toBe(false);
    expect(quote.availableTransitions).toContain('send');
    expect(quote.availableConversions).toEqual([]);
    // The same actions, described for a screen: the label comes from the descriptor, and the flag
    // that says "this one issues" is what a UI needs to confirm before the click (19-S.17 task 8).
    expect(quote.actions).toEqual([
      { action: 'send', label: 'Send', requiresReason: false, issues: true, to: 'sent' },
      { action: 'cancel', label: 'Cancel', requiresReason: true, issues: false, to: 'cancelled' },
    ]);
    expect(quote.conversions).toEqual([]);
  });

  it('describes an issued invoice’s corrections as commands that need a reason', async () => {
    const invoice = await createDocument(
      'invoice',
      { currency: 'USD', invoiceDate: '2026-10-15' },
      [{ name: 'line', quantity: '1', unitPrice: '100.00', ...LINE_TAX_FREE }],
    );
    expect(invoice.actions.map((action) => action.action)).toEqual(['issue']);
    expect(invoice.actions[0]?.issues).toBe(true);

    const issued = await transition('invoice', invoice.id, 'issue');
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const view = issued.body as unknown as DocumentView;
    // Void and credit are the only ways out of `issued`, and both are described as such — a UI that
    // offered "edit" here would be offering something the server refuses (§4.7, §4.9).
    expect(view.actions).toEqual([
      { action: 'void', label: 'Void', requiresReason: true, issues: false, to: 'voided' },
    ]);
    expect(view.conversions).toEqual([
      { action: 'convertToCreditNote', label: 'Create credit note', toKind: 'creditNote' },
    ]);
  });

  it('refuses a client-supplied total instead of trusting it', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'quote',
      data: { currency: 'USD', grossTotal: '999.00' },
      items: [{ name: 'x', quantity: '1', unitPrice: '1.00', ...LINE_TAX_FREE }],
    });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/grossTotal/);
    expect(reasonOf(result)).toMatch(/computed by the server/);
  });

  it('refuses a line whose tax cannot be resolved, rather than assuming zero tax', async () => {
    // `tax.missingTaxPolicy` defaults to `error`: zero tax must be configured, not assumed (§4.12).
    const result = await fix.call('POST', '/api/v1/Sales/document', {
      kind: 'quote',
      data: { currency: 'USD' },
      items: [{ name: 'untaxed', quantity: '1', unitPrice: '10.00' }],
    });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/no applicable tax rate/);
  });

  it('refuses a document with no lines', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/document', { kind: 'quote', data: { currency: 'USD' }, items: [] });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/at least one line/);
  });
});

describe('issuance and locking (19-S.7, 19-S.9)', () => {
  it('issues on send: a number, an issuer, a lock and a frozen snapshot', async () => {
    const quote = await draftQuote('12.00');
    const sent = await transition('quote', quote.id, 'send');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const view = await read('quote', quote.id);
    expect(view.document['status']).toBe('sent');
    expect(String(view.document['number'])).toMatch(/^Q-\d{6}$/);
    expect(view.lock.issuedAt).not.toBeNull();
    expect(view.lock.locked).toBe(true);
    // An issued document is read from its snapshot, never recalculated from the catalog (§4.9).
    expect(view.fromSnapshot).toBe(true);
    expect(view.totals.grossTotal).toBe('74.00');
  });

  it('refuses a transition the current state does not allow, naming the allowed ones', async () => {
    const quote = await draftQuote();
    await transition('quote', quote.id, 'send');
    const again = await transition('quote', quote.id, 'send');
    expect(again.status).toBe(422);
    expect(reasonOf(again)).toMatch(/not allowed from the "sent" state/);
    expect(reasonOf(again)).toMatch(/draft/);
  });

  it('refuses a protected-field edit on a locked document, by name', async () => {
    const quote = await draftQuote();
    await transition('quote', quote.id, 'send');

    const protectedEdit = await fix.call('PATCH', `/api/v1/Sales/document/quote/${quote.id}`, {
      data: { validUntil: '2027-01-01' },
    });
    expect(protectedEdit.status).toBe(422);
    expect(reasonOf(protectedEdit)).toMatch(/validUntil/);

    const lineEdit = await fix.call('PATCH', `/api/v1/Sales/document/quote/${quote.id}`, {
      items: [{ name: 'replacement', quantity: '1', unitPrice: '1.00', ...LINE_TAX_FREE }],
    });
    expect(lineEdit.status).toBe(422);
    expect(reasonOf(lineEdit)).toMatch(/items/);
  });

  it('stops the generic record API from forging a computed field or a status', async () => {
    // The side door the plan calls out: `/api/v1/Quote/:id` reaches the same row as the command API.
    const quote = await draftQuote();

    const forgedStatus = await fix.call('POST', '/api/v1/Quote', {
      name: `AGENT_TEST_${fix.runId} Forged`,
      status: 'accepted',
    });
    expect(forgedStatus.status).toBe(422);
    expect(reasonOf(forgedStatus)).toMatch(/computed by the server/);

    const forgedTotal = await fix.call('PUT', `/api/v1/Quote/${quote.id}`, { grossTotal: '0.00' });
    expect(forgedTotal.status).toBe(422);
    expect(reasonOf(forgedTotal)).toMatch(/grossTotal/);
  });

  it('needs a reason to void and the permission to unlock', async () => {
    const product = await fix.createProduct({ sku: `AGENT-${fix.runId}-INV`, unitPrice: '100.00' });
    const invoice = await createDocument(
      'invoice',
      { name: `AGENT_TEST_${fix.runId} Invoice`, currency: 'USD', invoiceDate: '2026-10-15' },
      [{ productId: product, quantity: '1', unitPrice: '100.00', ...LINE_TAX_FREE }],
    );
    const issued = await transition('invoice', invoice.id, 'issue');
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);

    const noReason = await transition('invoice', invoice.id, 'void');
    expect(noReason.status).toBe(422);
    expect(reasonOf(noReason)).toMatch(/requires a reason/);

    const roleId = `role-${fix.runId}-invoice`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} invoice editor`,
      permissions: { Invoice: { read: 'all', create: 'no', edit: 'yes', delete: 'no', stream: 'no' } },
    });
    const editor = await createTestUser(ctx, { userName: `sales-unlock-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(editor.id);

    const denied = await fix.call(
      'POST',
      `/api/v1/Sales/document/invoice/${invoice.id}/unlock`,
      { reason: 'correcting a mistake' },
      editor.token,
    );
    expect(denied.status).toBe(403);

    const allowed = await fix.call('POST', `/api/v1/Sales/document/invoice/${invoice.id}/unlock`, {
      reason: 'correcting a mistake',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((allowed.body as unknown as DocumentView).lock.locked).toBe(false);
  });
});

describe('conversion (19-S.6, 19-S.8)', () => {
  it('copies the lines by value, keeps the lineage and is idempotent on the correlation id', async () => {
    const quote = await draftQuote();
    await transition('quote', quote.id, 'send');
    await transition('quote', quote.id, 'accept');

    const first = await convert('quote', quote.id, 'convertToOrder', 'corr-1');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const order = first.body as unknown as DocumentView;
    documents.push({ kind: 'salesOrder', id: order.id });

    expect(order.kind).toBe('salesOrder');
    expect(order.document['status']).toBe('draft');
    expect(order.document['sourceId']).toBe(quote.id);
    expect(order.document['sourceEntity']).toBe('Quote');
    expect(order.totals.grossTotal).toBe('70.00');
    // The destination's lines point back at the source's, which is what makes fulfilment derivable.
    const quoteItems = (await read('quote', quote.id)).items.map((item) => item.id);
    expect(order.items.map((item) => item.sourceItemId)).toEqual(quoteItems);

    // A retry of the same request returns the order that already exists instead of a second one.
    const retry = await convert('quote', quote.id, 'convertToOrder', 'corr-1');
    expect(retry.status).toBe(201);
    expect((retry.body as unknown as DocumentView).id).toBe(order.id);

    // A genuinely second conversion is a different request, and it is refused.
    const duplicate = await convert('quote', quote.id, 'convertToOrder', 'corr-2');
    expect(duplicate.status).toBe(422);
    expect(reasonOf(duplicate)).toMatch(/already produced a sales order/);
  });

  it('refuses a conversion from a state that does not allow it', async () => {
    const quote = await draftQuote();
    const tooEarly = await convert('quote', quote.id, 'convertToOrder', 'corr-early');
    expect(tooEarly.status).toBe(422);
    expect(reasonOf(tooEarly)).toMatch(/needs a quote in one of these states: accepted/);
  });

  it('carries a confirmed order into an invoice and issues it with its own series', async () => {
    const quote = await draftQuote();
    await transition('quote', quote.id, 'send');
    await transition('quote', quote.id, 'accept');
    const orderView = await convert('quote', quote.id, 'convertToOrder', 'corr-chain');
    const order = orderView.body as unknown as DocumentView;
    documents.push({ kind: 'salesOrder', id: order.id });

    const confirmed = await transition('salesOrder', order.id, 'confirm');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(String((await read('salesOrder', order.id)).document['number'])).toMatch(/^SO-\d{6}$/);

    const invoiceView = await convert('salesOrder', order.id, 'convertToInvoice', 'corr-invoice');
    expect(invoiceView.status, JSON.stringify(invoiceView.body)).toBe(201);
    const invoice = invoiceView.body as unknown as DocumentView;
    documents.push({ kind: 'invoice', id: invoice.id });

    const issued = await transition('invoice', invoice.id, 'issue');
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const view = await read('invoice', invoice.id);
    expect(String(view.document['number'])).toMatch(/^INV-\d{6}$/);
    expect(view.fromSnapshot).toBe(true);
    expect(view.document['paymentStatus']).toBe('unpaid');
    expect(view.totals.amountDue).toBe(view.totals.grossTotal);
  });
});

describe('due dates and expiry (19-S.7, 19-S.9)', () => {
  it('computes the due date from the payment terms the invoice references', async () => {
    const terms = await fix.call('POST', '/api/v1/PaymentTermProfile', {
      name: `AGENT_TEST_${fix.runId} Net 30`,
      dueDays: 30,
      basis: 'net',
      active: true,
    });
    expect(terms.status).toBe(201);
    const termsId = String(terms.body['id']);
    rawIds.push(termsId);

    const invoice = await createDocument(
      'invoice',
      { name: `AGENT_TEST_${fix.runId} Terms invoice`, currency: 'USD', invoiceDate: '2026-10-15', paymentTermId: termsId },
      [{ name: 'line', quantity: '1', unitPrice: '10.00', ...LINE_TAX_FREE }],
    );
    expect(invoice.document['dueDate']).toBe('2026-11-14');

    // An explicit due date always wins over the derived one.
    const explicit = await createDocument(
      'invoice',
      { name: `AGENT_TEST_${fix.runId} Explicit invoice`, currency: 'USD', invoiceDate: '2026-10-15', paymentTermId: termsId, dueDate: '2026-12-24' },
      [{ name: 'line', quantity: '1', unitPrice: '10.00', ...LINE_TAX_FREE }],
    );
    expect(explicit.document['dueDate']).toBe('2026-12-24');
  });

  it('expires quotes past their validity date, and does nothing on a second run', async () => {
    const quote = await createDocument(
      'quote',
      { name: `AGENT_TEST_${fix.runId} Stale quote`, currency: 'USD', quoteDate: '2026-01-05', validUntil: '2026-02-05' },
      [{ name: 'line', quantity: '1', unitPrice: '10.00', ...LINE_TAX_FREE }],
    );
    await transition('quote', quote.id, 'send');

    const first = await fix.call('POST', '/api/v1/Sales/action/expireQuotes', { today: '2026-10-15' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['expired']).toContain(quote.id);
    expect((await read('quote', quote.id)).document['status']).toBe('expired');

    // Idempotent by construction: an expired quote is no longer a `sent` candidate.
    const second = await fix.call('POST', '/api/v1/Sales/action/expireQuotes', { today: '2026-10-15' });
    expect(second.body['expired']).toEqual([]);
  });
});
