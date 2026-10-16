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
 * Phase 19-S.17 — sending **any** commercial document by mail, through the real HTTP API.
 *
 * Quotes got their own send path in 19-S.7; this is the same contract for the other nine kinds
 * (`POST /api/v1/Sales/document/:kind/:id/send`), and the things worth proving are the ones that only
 * appear once the surface is wide:
 *
 *  - sending **issues** a draft through the kind's own transition, so the number, the frozen snapshot,
 *    the lock and the outbox event come from the engine rather than from this route;
 *  - the email is a real `Email` record linked to the document, queued through the mail module — the
 *    durable side effects, not just a status code;
 *  - **a stock-moving draft refuses to be issued by pressing "send"**: confirming a delivery is a
 *    warehouse act, and an email button must not perform it;
 *  - **a purchasing document goes to its supplier** while a selling one goes to its contact or account,
 *    and a document with no addressable counterparty is refused instead of mailed to nobody;
 *  - a PDF attachment is refused *before* the document is issued, so nothing claims to be sent with an
 *    attachment that never materialised; the attachment that is produced carries the allocated number;
 *  - with no mail transport configured, nothing is issued at all;
 *  - the quote keeps its own route, so this one points there instead of quietly double-implementing it.
 *
 * Runs against the configured primary database (AGENTS.md §3.1); every row this suite writes is
 * removed by exact id in `afterAll` and no test database is created.
 */

/**
 * A test must never send real mail (AGENTS.md §3.3): `memory` keeps the messages in the transport and
 * `SMTP_FROM` gives it the sending mailbox every message needs. Both are read once when the app is
 * built, so they are set here and restored in `afterAll`.
 */
const previousTransport = process.env.MAIL_TRANSPORT;
const previousFrom = process.env.SMTP_FROM;
process.env.MAIL_TRANSPORT = 'memory';
process.env.SMTP_FROM = 'documents@example.com';

let ctx: ApiContext;
let fix: SalesFixture;

const documents: { kind: string; id: string }[] = [];
/** Records created through the generic record API (accounts, suppliers, templates). */
const rawIds: string[] = [];
const emailIds: string[] = [];
const attachmentIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];
let templateCounter = 0;

interface DocumentView {
  kind: string;
  id: string;
  document: Record<string, unknown>;
  items: { id: string }[];
  lock: { issuedAt: string | null; locked: boolean };
  availableTransitions: string[];
}

interface SendResult {
  kind: string;
  document: DocumentView;
  email: Record<string, unknown>;
  rendered: { number: string | null; subject: string; body: string; text: string; format: string };
  transport: { name: string };
  job: { id: string; name: string; status: string };
  issued: boolean;
  pdfAttachment: { id: string; filename: string; mimeType: string; size: number } | null;
}

const LINE = { name: 'Consulting', quantity: '2', unitPrice: '10.00', taxRatePercent: '0' };

async function createDocument(kind: string, data: Record<string, unknown>): Promise<DocumentView> {
  const result = await fix.call('POST', '/api/v1/Sales/document', {
    kind,
    data: { name: `AGENT_TEST_${fix.runId} ${kind}`, currency: 'USD', ...data },
    items: [LINE],
  });
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

async function transition(kind: string, id: string, action: string, reason?: string) {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, {
    action,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function send(
  kind: string,
  id: string,
  payload: Record<string, unknown> = {},
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/send`, payload, token);
}

/** A counterparty that can be mailed: an account or a supplier with an address of its own. */
async function createParty(entity: 'Account' | 'Supplier', email: string): Promise<string> {
  const result = await fix.call('POST', `/api/v1/${entity}`, {
    name: `AGENT_TEST_${fix.runId} ${entity}`,
    emailAddress: email,
    ...(entity === 'Supplier' ? { active: true } : {}),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const id = String(result.body['id']);
  rawIds.push(id);
  return id;
}

/** A `DocumentTemplate` for one entity type; the code is what a send command refers to. */
async function createTemplate(entityType: string): Promise<string> {
  templateCounter += 1;
  const code = `agent_test_send_${fix.runId}_${String(templateCounter)}`;
  const result = await fix.call('POST', '/api/v1/DocumentTemplate', {
    name: `AGENT_TEST_${fix.runId} ${entityType} template`,
    code,
    entityType,
    subject: `${entityType} {{number}}`,
    body: '<p>{{title}} — {{{grossTotal}}} {{currency}}</p><p>{{unknownPlaceholder}}</p>',
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
  // Purchasing is a feature, off by default; the supplier-bill case needs it and puts it back after.
  await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: true } });
  // The send path queues `system.sendEmail` through BullMQ. This suite asserts the durable effects —
  // the document's new state, the Email record, the attachment — so the queue hop is stubbed instead
  // of requiring a Redis server (AGENTS.md §3.3).
  const jobs = ctx.app.get(JobsService);
  jobs.enqueue = async (input) => ({ id: 'agent-test-job', job: input.job, status: 'pending' }) as unknown as JobView;
}, 120_000);

afterAll(async () => {
  await fix.call('POST', '/api/v1/Sales/action/settings', { features: { purchases: false } }).catch(() => undefined);
  const itemIds: string[] = [];
  for (const { kind, id } of documents) {
    const view = await fix.call('GET', `/api/v1/Sales/document/${kind}/${id}`);
    const items = view.body['items'];
    if (Array.isArray(items)) {
      for (const item of items) itemIds.push(String((item as { id: string }).id));
    }
  }
  // The PDF is deleted through the API so the stored file goes with its row (nothing is left on disk).
  for (const id of attachmentIds) {
    await fix.call('DELETE', `/api/v1/Attachment/${id}`).catch(() => undefined);
  }
  const all = [...documents.map((document) => document.id), ...itemIds, ...rawIds, ...emailIds];
  if (emailIds.length > 0) {
    await ctx.database.db.deleteFrom('email_deliveries').where('email_id', 'in', emailIds).execute().catch(() => undefined);
  }
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('record_id', 'in', all).execute().catch(() => undefined);
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

describe('sending a document by mail (19-S.17)', () => {
  it('issues an invoice, links and queues its email, then re-sends without re-issuing', async () => {
    const templateCode = await createTemplate('Invoice');
    const accountId = await createParty('Account', `buyer-${fix.runId}@example.com`);
    const invoice = await createDocument('invoice', { accountId, invoiceDate: '2026-10-15' });

    const first = await send('invoice', invoice.id, { templateCode, message: 'Please find attached.' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const sent = first.body as unknown as SendResult;

    expect(sent.issued).toBe(true);
    expect(sent.document.document['status']).toBe('issued');
    const number = String(sent.document.document['number']);
    expect(number).toMatch(/^INV-\d{6}$/);
    expect(sent.document.lock.issuedAt).not.toBeNull();

    // The email is an ordinary record the mail module owns, addressed from the account, rendered after
    // issuance so it carries the number that was just allocated.
    emailIds.push(String(sent.email['id']));
    expect(sent.email['parentType']).toBe('Invoice');
    expect(sent.email['parentId']).toBe(invoice.id);
    expect(sent.email['toAddressList']).toBe(`buyer-${fix.runId}@example.com`);
    expect(sent.email['status']).toBe('Queued');
    expect(String(sent.email['body'])).toContain('Please find attached.');
    expect(String(sent.email['name'])).toBe(`Invoice ${number}`);
    expect(sent.transport.name).toBe('memory');
    expect(sent.job.name).toBe('system.sendEmail');
    expect(sent.rendered.number).toBe(number);
    expect(sent.rendered.body).toContain(number);
    // The kernel renderer's rule holds for every kind: an unanswerable placeholder stays visible.
    expect(sent.rendered.body).toContain('{{unknownPlaceholder}}');

    // A second send is a re-send: same document and number, a new email, no second issuance.
    const second = await send('invoice', invoice.id, { templateCode, to: [`other-${fix.runId}@example.com`] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const resent = second.body as unknown as SendResult;
    expect(resent.issued).toBe(false);
    emailIds.push(String(resent.email['id']));
    expect(resent.email['id']).not.toBe(sent.email['id']);
    expect(resent.email['toAddressList']).toBe(`other-${fix.runId}@example.com`);
    expect(String(resent.document.document['number'])).toBe(number);
  });

  it('sends a supplier bill to its supplier, not to a customer', async () => {
    const supplierId = await createParty('Supplier', `goods-${fix.runId}@example.com`);
    const bill = await createDocument('bill', { supplierId, billDate: '2026-10-15' });

    const result = await send('bill', bill.id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const sent = result.body as unknown as SendResult;

    expect(sent.issued).toBe(true);
    expect(String(sent.document.document['number'])).toMatch(/^BILL-\d{6}$/);
    emailIds.push(String(sent.email['id']));
    expect(sent.email['parentType']).toBe('Bill');
    expect(sent.email['toAddressList']).toBe(`goods-${fix.runId}@example.com`);
    expect(sent.rendered.text).toContain('Supplier: AGENT_TEST_');
    // The shipped default template renders clean: every placeholder it uses is data the renderer
    // actually supplies, so an operator gets no warning about a blank field they can see.
    expect(sent.rendered.warnings).toEqual([]);
  });

  it('refuses to issue a stock-moving draft by sending it, and says which command does', async () => {
    const accountId = await createParty('Account', `ship-${fix.runId}@example.com`);
    const delivery = await createDocument('deliveryOrder', { accountId, deliveryDate: '2026-10-15' });

    const refused = await send('deliveryOrder', delivery.id);
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/confirming it moves stock/i);
    expect(reasonOf(refused)).toMatch(/confirm/i);
    // Sending must not have taken the number or the state the confirmation owns.
    expect((await read('deliveryOrder', delivery.id)).document['status']).toBe('draft');
    expect((await read('deliveryOrder', delivery.id)).document['number']).toBeNull();
  });

  it('refuses a document nobody can be mailed, and leaves it a draft', async () => {
    const orphan = await createDocument('invoice', { invoiceDate: '2026-10-15' });

    const refused = await send('invoice', orphan.id);
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/needs a recipient/);
    expect((await read('invoice', orphan.id)).document['status']).toBe('draft');
  });

  it('refuses a document that is neither a draft nor official', async () => {
    const accountId = await createParty('Account', `void-${fix.runId}@example.com`);
    const invoice = await createDocument('invoice', { accountId, invoiceDate: '2026-10-15' });
    await transition('invoice', invoice.id, 'issue');
    await transition('invoice', invoice.id, 'void', 'AGENT_TEST issued in error');
    expect((await read('invoice', invoice.id)).document['status']).toBe('voided');

    const refused = await send('invoice', invoice.id);
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/Only a draft or an issued invoice/);
  });

  it('refuses a quote and points at the quote route that already serves it', async () => {
    const quote = await createDocument('quote', { quoteDate: '2026-10-15' });

    const refused = await send('quote', quote.id, { to: [`q-${fix.runId}@example.com`] });
    expect(refused.status).toBe(422);
    expect(reasonOf(refused)).toMatch(/quote\/:id\/send/);
    expect((await read('quote', quote.id)).document['status']).toBe('draft');
  });

  it('attaches a PDF named after the allocated number', async () => {
    const accountId = await createParty('Account', `pdf-${fix.runId}@example.com`);
    const invoice = await createDocument('invoice', { accountId, invoiceDate: '2026-10-15' });

    const result = await send('invoice', invoice.id, { attachPdf: true });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const sent = result.body as unknown as SendResult;
    const number = String(sent.document.document['number']);

    expect(sent.pdfAttachment).not.toBeNull();
    expect(sent.pdfAttachment?.filename).toBe(`Invoice-${number}.pdf`);
    expect(sent.pdfAttachment?.mimeType).toBe('application/pdf');
    expect((sent.pdfAttachment?.size ?? 0)).toBeGreaterThan(0);
    attachmentIds.push(String(sent.pdfAttachment?.id));
    emailIds.push(String(sent.email['id']));

    // The attachment is a §25 child of the email, so the worker picks it up without knowing about Sales.
    const stored = await fix.call('GET', `/api/v1/Attachment/${String(sent.pdfAttachment?.id)}`);
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body['parentId']).toBe(String(sent.email['id']));
    expect(stored.body['role']).toBe('invoice-pdf');
  });

  it('refuses to send when no mail transport is configured, and leaves the invoice a draft', async () => {
    const emails = ctx.app.get(EmailService);
    const original = emails.info.bind(emails);
    emails.info = () => ({ ...original(), name: 'none', mode: 'disabled' });
    try {
      const accountId = await createParty('Account', `nomail-${fix.runId}@example.com`);
      const invoice = await createDocument('invoice', { accountId, invoiceDate: '2026-10-15' });

      const refused = await send('invoice', invoice.id);
      expect(refused.status).toBe(403);
      expect(String((refused.body['error'] as { code?: string }).code)).toBe('FEATURE_DISABLED');
      expect((await read('invoice', invoice.id)).document['status']).toBe('draft');
      expect((await read('invoice', invoice.id)).document['number']).toBeNull();
    } finally {
      emails.info = original;
    }
  });

  it('refuses a caller who may not create the email, without issuing anything', async () => {
    const roleId = `role-${fix.runId}-invoice-reader`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} invoice reader`,
      // May read invoices, but may not create the Email record a send needs.
      permissions: { Invoice: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
    });
    const reader = await createTestUser(ctx, { userName: `sales-send-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(reader.id);

    const accountId = await createParty('Account', `acl-${fix.runId}@example.com`);
    const invoice = await createDocument('invoice', { accountId, invoiceDate: '2026-10-15' });

    const denied = await send('invoice', invoice.id, {}, reader.token);
    expect(denied.status).toBe(403);
    expect((await read('invoice', invoice.id)).document['status']).toBe('draft');
  });
});
