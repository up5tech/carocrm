import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailService } from '../src/email/email.service.js';
import type { JobView } from '../src/jobs/job.views.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.7 — quotes through the real HTTP API: rendering and sending.
 *
 * What this suite exists to prove, in the plan's own terms:
 *
 *  - a quote renders through the kernel `document` module, and an unresolved placeholder is reported
 *    rather than silently blanked (19-S.7 task 5);
 *  - sending **issues** the quote (a number, a lock, a frozen snapshot) and stores a linked `Email`
 *    record that the mail module queues — the side effects, not just a status code;
 *  - sending is refused outright when no mail transport is configured, and the quote is *not* issued
 *    in that case, so nothing claims a quote was sent with no email behind it;
 *  - a price that was resolved from a price book and written onto a quote line is frozen at issuance:
 *    moving the catalog afterwards changes what a *new* quote would get, never the issued one;
 *  - an expired quote cannot be sent — the state machine is the guard, not a flag on the route;
 *  - conversion is idempotent under retries and a quote that already produced an order cannot also be
 *    invoiced directly (no double billing by two routes);
 *  - ACL: a caller without the permissions the send needs is refused *before* anything is issued.
 *
 * Runs against the configured primary database through the booted application (AGENTS.md §3.1). Every
 * row this suite writes is removed by exact id in `afterAll`; no test database is created.
 */

/**
 * A test must never send real mail (AGENTS.md §3.3). `memory` keeps the messages in the transport and
 * `SMTP_FROM` gives the transport the sending mailbox every message must come from — without it the
 * mail module correctly refuses to build a message with no From at all. Both are read once, when
 * `bootApi()` builds the configuration, so they are set here and restored in `afterAll`.
 */
const previousTransport = process.env.MAIL_TRANSPORT;
const previousFrom = process.env.SMTP_FROM;
process.env.MAIL_TRANSPORT = 'memory';
process.env.SMTP_FROM = 'quotes@example.com';

let ctx: ApiContext;
let fix: SalesFixture;

/** Documents this run created, so cleanup removes exactly them and nothing else (AGENTS.md §3.3). */
const documents: { kind: string; id: string }[] = [];
/** Records created through the generic record API (accounts, templates, price book entries). */
const rawIds: string[] = [];
const emailIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];
/** Distinguishes the products this suite creates, because a SKU is unique and prices repeat. */
let skuCounter = 0;
/** Distinguishes the templates this suite creates, because a template code is unique. */
let templateCounter = 0;

interface DocumentView {
  kind: string;
  id: string;
  document: Record<string, unknown>;
  items: { id: string; position: number; quantity: string }[];
  totals: { netTotal: string; taxTotal: string; grossTotal: string; amountDue: string };
  lock: { issuedAt: string | null; locked: boolean };
  fromSnapshot: boolean;
  availableTransitions: string[];
}

interface RenderResult {
  quoteId: string;
  number: string | null;
  status: string;
  fromSnapshot: boolean;
  templateCode: string | null;
  format: string;
  subject: string;
  body: string;
  text: string;
  blocks: unknown[];
  warnings: string[];
  pdf: { available: boolean; reason: string | null };
}

interface SendResult {
  quote: DocumentView;
  email: Record<string, unknown>;
  rendered: RenderResult;
  transport: { name: string };
  job: { id: string; name: string; status: string };
  issued: boolean;
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

async function transition(kind: string, id: string, action: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, { action });
}

async function renderQuote(id: string, templateCode?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/quote/${id}/render`, templateCode === undefined ? {} : { templateCode });
}

async function sendQuote(id: string, payload: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/quote/${id}/send`, payload);
}

/** A quote with one priced line; `accountId` links it to a customer when one is needed. */
async function draftQuote(unitPrice = '10.00', extra: Record<string, unknown> = {}): Promise<DocumentView> {
  // The SKU carries a counter as well as the price: a product SKU is unique, and this suite asks for
  // the same price more than once.
  skuCounter += 1;
  const product = await fix.createProduct({ sku: `AGENT-${fix.runId}-Q${String(skuCounter)}`, unitPrice });
  return await createDocument(
    'quote',
    { name: `AGENT_TEST_${fix.runId} Quote`, currency: 'USD', quoteDate: '2026-10-15', ...extra },
    [{ productId: product, quantity: '2', unitPrice, ...LINE_TAX_FREE }],
  );
}

/** An account that carries an email address, which is where a quote's recipient is derived from. */
async function createAccount(email: string): Promise<string> {
  const result = await fix.call('POST', '/api/v1/Account', {
    name: `AGENT_TEST_${fix.runId} Account`,
    emailAddress: email,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const id = String(result.body['id']);
  rawIds.push(id);
  return id;
}

/** A `DocumentTemplate` for the Quote entity type, returning its code (what a command refers to). */
async function createTemplate(body: string, subject = 'Quote {{number}}'): Promise<string> {
  // A template code is unique, and this suite creates more than one.
  templateCounter += 1;
  const code = `agent_test_quote_${fix.runId}_${String(templateCounter)}`;
  const result = await fix.call('POST', '/api/v1/DocumentTemplate', {
    name: `AGENT_TEST_${fix.runId} quote template ${String(templateCounter)}`,
    code,
    entityType: 'Quote',
    subject,
    body,
    format: 'html',
    active: true,
    // Never the default: another suite's default template must not decide what this one renders.
    isDefault: false,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  rawIds.push(String(result.body['id']));
  return code;
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  // The send path queues `system.sendEmail` through BullMQ. This suite asserts the *durable* side
  // effects — the Email record, its recipient ledger and the quote's new state — so the queue hop is
  // stubbed instead of requiring a Redis server, the same "mock the external side effect" rule the
  // worker suites follow with an injected fetcher (AGENTS.md §3.3).
  const jobs = ctx.app.get(JobsService);
  jobs.enqueue = async (input) => ({ id: 'agent-test-job', job: input.job, status: 'pending' }) as unknown as JobView;
}, 120_000);

afterAll(async () => {
  const itemIds: string[] = [];
  for (const { kind, id } of documents) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) {
      for (const item of items) itemIds.push(String((item as { id: string }).id));
    }
  }
  const all = [...documents.map((document) => document.id), ...itemIds, ...rawIds, ...emailIds];
  if (emailIds.length > 0) {
    await ctx.database.db.deleteFrom('email_deliveries').where('email_id', 'in', emailIds).execute().catch(() => undefined);
  }
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
    // Sales document events carry `id`; the kernel's entity events carry `entityId`. Both are matched
    // by the exact ids this run created, so nothing outside this suite is touched.
    await ctx.database.db
      .deleteFrom('outbox_events')
      .where(sql<boolean>`payload ->> 'id' in (${sql.join(all)}) or payload ->> 'entityId' in (${sql.join(all)})`)
      .execute()
      .catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await fix.cleanup();
  await shutdownApi();
  if (previousTransport === undefined) delete process.env.MAIL_TRANSPORT;
  else process.env.MAIL_TRANSPORT = previousTransport;
  if (previousFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = previousFrom;
}, 120_000);

describe('rendering a quote (19-S.7)', () => {
  it('renders through a named template and reports an unresolved placeholder instead of blanking it', async () => {
    const code = await createTemplate('<h1>{{title}}</h1><p>Total: {{{grossTotal}}} {{currency}}</p><p>{{unknownPlaceholder}}</p>');
    const quote = await draftQuote('10.00');

    const result = await renderQuote(quote.id, code);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const rendered = result.body as unknown as RenderResult;

    expect(rendered.templateCode).toBe(code);
    expect(rendered.format).toBe('html');
    expect(rendered.fromSnapshot).toBe(false);
    expect(rendered.body).toContain('Quote (draft)');
    expect(rendered.body).toContain('Total: 20.00 USD');
    // The rule the kernel renderer exists to keep: an unanswerable placeholder stays visible.
    expect(rendered.body).toContain('{{unknownPlaceholder}}');
    expect(rendered.warnings.some((warning) => warning.includes('unknownPlaceholder'))).toBe(true);
    // The block model travels with the result, so a PDF renderer gets the same document.
    expect(rendered.blocks.length).toBeGreaterThan(0);
    expect(typeof rendered.pdf.available).toBe('boolean');
  });

  it('renders a draft from live data and an issued quote from its frozen snapshot', async () => {
    const accountId = await createAccount(`billing-${fix.runId}@example.com`);
    const quote = await draftQuote('10.00', { accountId });

    const draft = (await renderQuote(quote.id)).body as unknown as RenderResult;
    expect(draft.fromSnapshot).toBe(false);
    expect(draft.number).toBeNull();
    expect(draft.text).toContain('Account: AGENT_TEST_');

    await transition('quote', quote.id, 'send');

    const issued = (await renderQuote(quote.id)).body as unknown as RenderResult;
    expect(issued.fromSnapshot).toBe(true);
    expect(issued.number).toMatch(/^Q-\d{6}$/);
    expect(issued.text).toContain(String(issued.number));
  });

  it('freezes the price that was resolved for the quote, even after the price book moves', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-STALE`, unitPrice: '12.50' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    const entryId = await fix.createEntry(bookId, productId, { unitPrice: '9.00' });

    // What the UI does: resolve the price, then put the resolved value on the line.
    const resolved = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId, priceBookId: bookId });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const quotePrice = String(resolved.body['price']);
    expect(quotePrice).toBe('9.00');

    const quote = await createDocument(
      'quote',
      { name: `AGENT_TEST_${fix.runId} Priced quote`, currency: 'USD', quoteDate: '2026-10-15' },
      [{ productId, quantity: '1', unitPrice: quotePrice, ...LINE_TAX_FREE }],
    );
    await transition('quote', quote.id, 'send');

    // Move the catalog underneath the quote.
    const repriced = await fix.call('PATCH', `/api/v1/PriceBookEntry/${entryId}`, { unitPrice: '42.00' });
    expect(repriced.status, JSON.stringify(repriced.body)).toBe(200);
    const nowResolved = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId, priceBookId: bookId });
    expect(String(nowResolved.body['price'])).toBe('42.00');

    // A *new* quote gets the new price; the issued one still shows what was sent.
    const issued = (await renderQuote(quote.id)).body as unknown as RenderResult;
    expect(issued.fromSnapshot).toBe(true);
    expect(issued.text).toContain('9.00');
    expect(issued.text).not.toContain('42.00');

    const fresh = await draftQuote('42.00');
    expect((await read('quote', fresh.id)).totals.grossTotal).toBe('84.00');
  });
});

describe('sending a quote (19-S.7)', () => {
  it('issues the quote, stores a linked email and queues it, then re-sends without re-issuing', async () => {
    const code = await createTemplate('<p>{{title}} — {{{grossTotal}}} {{currency}}</p>');
    const accountId = await createAccount(`buyer-${fix.runId}@example.com`);
    const quote = await draftQuote('10.00', { accountId });

    const first = await sendQuote(quote.id, { templateCode: code });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const sent = first.body as unknown as SendResult;

    expect(sent.issued).toBe(true);
    expect(sent.quote.document['status']).toBe('sent');
    const number = String(sent.quote.document['number']);
    expect(number).toMatch(/^Q-\d{6}$/);
    expect(sent.quote.lock.issuedAt).not.toBeNull();

    // The side effects, not just the status: an Email record linked to the quote, addressed from the
    // account's own address, accepted by the mail module and queued.
    emailIds.push(String(sent.email['id']));
    expect(sent.email['parentType']).toBe('Quote');
    expect(sent.email['parentId']).toBe(quote.id);
    expect(sent.email['toAddressList']).toBe(`buyer-${fix.runId}@example.com`);
    expect(sent.email['status']).toBe('Queued');
    expect(String(sent.email['name'])).toContain(number);
    expect(sent.transport.name).toBe('memory');
    expect(sent.job.name).toBe('system.sendEmail');
    // The email was rendered *after* issuance, so it carries the allocated number.
    expect(sent.rendered.number).toBe(number);
    expect(sent.rendered.body).toContain(number);

    // A second send is a re-send: the same document and number, a new email, no second issuance.
    const second = await sendQuote(quote.id, { templateCode: code, to: [`other-${fix.runId}@example.com`] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const resent = second.body as unknown as SendResult;
    expect(resent.issued).toBe(false);
    emailIds.push(String(resent.email['id']));
    expect(resent.email['id']).not.toBe(sent.email['id']);
    expect(resent.email['toAddressList']).toBe(`other-${fix.runId}@example.com`);
    expect(String(resent.quote.document['number'])).toBe(number);
  });

  it('refuses to send when no mail transport is configured, and leaves the quote a draft', async () => {
    const emails = ctx.app.get(EmailService);
    const original = emails.info.bind(emails);
    emails.info = () => ({ ...original(), name: 'none', mode: 'disabled' });
    try {
      const quote = await draftQuote('10.00');
      const refused = await sendQuote(quote.id, { to: [`nobody-${fix.runId}@example.com`] });

      expect(refused.status).toBe(403);
      expect(String((refused.body['error'] as { code?: string }).code)).toBe('FEATURE_DISABLED');
      // The refusal happens *before* issuance: nothing claims the quote was sent.
      expect((await read('quote', quote.id)).document['status']).toBe('draft');
      expect((await read('quote', quote.id)).document['number']).toBeNull();
    } finally {
      emails.info = original;
    }
  });

  it('refuses a send the caller may not perform, without issuing anything', async () => {
    const roleId = `role-${fix.runId}-quote-reader`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} quote reader`,
      // May read quotes, but may not create the Email record a send needs.
      permissions: { Quote: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
    });
    const reader = await createTestUser(ctx, { userName: `sales-quote-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(reader.id);

    const quote = await draftQuote('10.00');
    const denied = await fix.call(
      'POST',
      `/api/v1/Sales/quote/${quote.id}/send`,
      { to: [`x-${fix.runId}@example.com`] },
      reader.token,
    );
    expect(denied.status).toBe(403);
    expect((await read('quote', quote.id)).document['status']).toBe('draft');
  });

  it('refuses to render a quote the caller may not read', async () => {
    const outsider = await createTestUser(ctx, { userName: `sales-quote-none-${fix.runId}`, roleIds: ['noAccess'] });
    cleanupUsers.push(outsider.id);

    const quote = await draftQuote('10.00');
    const denied = await fix.call('POST', `/api/v1/Sales/quote/${quote.id}/render`, {}, outsider.token);
    expect(denied.status).toBe(403);
    const deniedSend = await fix.call(
      'POST',
      `/api/v1/Sales/quote/${quote.id}/send`,
      { to: [`x-${fix.runId}@example.com`] },
      outsider.token,
    );
    expect(deniedSend.status).toBe(403);
  });
});

describe('quote expiry and conversion (19-S.7)', () => {
  it('expires a quote past its validity date, and an expired quote cannot be sent', async () => {
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

    // Sending is guarded by the state machine, not by a flag on the route.
    const refused = await sendQuote(quote.id, { to: [`x-${fix.runId}@example.com`] });
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/Only a draft or a sent quote/);
  });

  it('converts a quote to an order idempotently and refuses to also invoice it directly', async () => {
    const quote = await draftQuote('10.00');
    await transition('quote', quote.id, 'send');
    await transition('quote', quote.id, 'accept');

    const first = await fix.call('POST', `/api/v1/Sales/document/quote/${quote.id}/convert`, {
      action: 'convertToOrder',
      correlationId: 'agent-test-corr',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const order = first.body as unknown as DocumentView;
    documents.push({ kind: 'salesOrder', id: order.id });
    expect(order.document['sourceId']).toBe(quote.id);

    // A retry of the same request returns the order that already exists instead of a second one.
    const retry = await fix.call('POST', `/api/v1/Sales/document/quote/${quote.id}/convert`, {
      action: 'convertToOrder',
      correlationId: 'agent-test-corr',
    });
    expect(retry.status).toBe(201);
    expect((retry.body as unknown as DocumentView).id).toBe(order.id);

    // The same acceptance must not reach the customer twice by two routes.
    const double = await fix.call('POST', `/api/v1/Sales/document/quote/${quote.id}/convert`, {
      action: 'convertToInvoice',
      correlationId: 'agent-test-corr-invoice',
    });
    expect(double.status).toBe(422);
    expect(reasonOf(double)).toMatch(/already became a sales order/);
  });
});
