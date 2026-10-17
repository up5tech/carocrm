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
 * Phase 19-S.7 task 1 — raising a commercial document from a CRM **Opportunity** (§4.5 "create quotes
 * manually or from an Opportunity", §4.6 the same for sales orders, §4.7 for invoices).
 *
 * This was the last documented command that had no implementation: the link fields existed and a
 * quote could be converted onwards, but nothing turned a deal into a draft. What the suite pins:
 *
 *  - the party travels (account, first contact), the provenance travels **both** ways (`opportunityId`
 *    for the deal's own relationship panel, `sourceEntity`/`sourceId` for everything else), and the
 *    document arrives as an empty draft rather than with an invented line;
 *  - a caller cannot forge that provenance: `overrides` refines header fields and nothing else;
 *  - a retry with the same `correlationId` returns the draft it already made;
 *  - a deal may be **quoted** repeatedly — an offer is not a commitment — but an order or an invoice
 *    it already produced is refused, and so is invoicing a deal that has an order, whether the order
 *    came straight from the deal or through one of its quotes;
 *  - the deal is read under the caller's own record access, so a user who may not see it cannot turn
 *    it into a document.
 *
 * Runs against the configured primary database through the booted application (AGENTS.md §3.1). Every
 * row this suite writes is removed by exact id in `afterAll`; no test database is created and no mail
 * is sent (this suite issues no document and touches no transport).
 */

let ctx: ApiContext;
let fix: SalesFixture;

const documents: { kind: string; id: string }[] = [];
/** Records created through the generic API — the deal, its account and its contact. */
const rawIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

interface DocumentView {
  kind: string;
  id: string;
  document: Record<string, unknown>;
  items: unknown[];
  totals: { grossTotal: string };
  availableTransitions: string[];
  actions: { action: string; label: string; requiresReason: boolean; issues: boolean; to: string }[];
}

interface OpportunityFixture {
  readonly id: string;
  readonly name: string;
  readonly accountId: string;
  readonly contactId: string;
}

/**
 * A line the caller prices. The deal's own `amount` must never become one: 100.00 here against a
 * 12 500.00 deal is the assertion that the command copies no money of its own.
 */
const LINE = { name: 'AGENT_TEST line', quantity: '1', unitPrice: '100.00', taxRatePercent: '0' };

async function createOpportunity(suffix: string): Promise<OpportunityFixture> {
  const account = await fix.call('POST', '/api/v1/Account', {
    name: `AGENT_TEST_${fix.runId} ${suffix} account`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const accountId = String(account.body['id']);
  rawIds.push(accountId);

  const contact = await fix.call('POST', '/api/v1/Contact', {
    firstName: 'AGENT_TEST',
    lastName: `${fix.runId} ${suffix}`,
  });
  expect(contact.status, JSON.stringify(contact.body)).toBe(201);
  const contactId = String(contact.body['id']);
  rawIds.push(contactId);

  const name = `AGENT_TEST_${fix.runId} ${suffix} deal`;
  const opportunity = await fix.call('POST', '/api/v1/Opportunity', {
    name,
    accountId,
    contactIds: [contactId],
    // Money is a canonical decimal string at every boundary, even on a CRM Core record.
    amount: '12500.00',
    stage: 'Proposal',
  });
  expect(opportunity.status, JSON.stringify(opportunity.body)).toBe(201);
  const id = String(opportunity.body['id']);
  rawIds.push(id);
  return { id, name, accountId, contactId };
}

async function fromOpportunity(
  payload: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await fix.call(
    'POST',
    '/api/v1/Sales/document/fromOpportunity',
    { items: [LINE], ...payload },
    token,
  );
  if (result.status === 201) documents.push({ kind: String(result.body['kind']), id: String(result.body['id']) });
  return result;
}

async function transition(
  kind: string,
  id: string,
  action: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await fix.call('POST', `/api/v1/Sales/document/${kind}/${id}/transition`, { action });
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
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
  await purgeEntityEvents(ctx.database, ['Quote', 'SalesOrder', 'Invoice', 'Opportunity', 'Account', 'Contact']);
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('raising a document from an opportunity (19-S.7)', () => {
  it('creates an empty draft that carries the deal’s party and its provenance', async () => {
    const deal = await createOpportunity('quote');
    const result = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const view = result.body as unknown as DocumentView;

    expect(view.kind).toBe('quote');
    expect(view.document['status']).toBe('draft');
    expect(view.document['accountId']).toBe(deal.accountId);
    // A deal's contacts are a multi-select and a document's `contactId` is single: the first travels.
    expect(view.document['contactId']).toBe(deal.contactId);
    expect(view.document['opportunityId']).toBe(deal.id);
    expect(view.document['sourceEntity']).toBe('Opportunity');
    expect(view.document['sourceId']).toBe(deal.id);
    expect(view.document['name']).toBe(deal.name);
    expect(view.document['quoteDate']).toBe(new Date().toISOString().slice(0, 10));
    expect(String(view.document['currency'])).toMatch(/^[A-Z]{3}$/);

    // The deal's `amount` is 12 500.00 and the document's total is the line the caller priced — the
    // command copies no money of its own (§4.3 rule 4: a price is never assumed).
    expect(view.items).toHaveLength(1);
    expect(view.totals.grossTotal).toBe('100.00');
    // And it is a draft the normal quote lifecycle then owns.
    expect(view.actions.map((action) => action.action)).toEqual(['send', 'cancel']);
  });

  it('returns the same draft when the same request is retried with its correlation id', async () => {
    const deal = await createOpportunity('retry');
    const first = await fromOpportunity({
      opportunityId: deal.id,
      kind: 'quote',
      correlationId: `agent-${fix.runId}-opp-retry`,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await fromOpportunity({
      opportunityId: deal.id,
      kind: 'quote',
      correlationId: `agent-${fix.runId}-opp-retry`,
    });
    expect(retry.status).toBe(201);
    expect(String(retry.body['id'])).toBe(String(first.body['id']));
  });

  it('lets a deal be quoted again, because a quote is an offer and not a commitment', async () => {
    const deal = await createOpportunity('revision');
    const first = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' });
    const second = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(String(second.body['id'])).not.toBe(String(first.body['id']));
  });

  it('refuses a second order for the same deal', async () => {
    const deal = await createOpportunity('order');
    const first = await fromOpportunity({ opportunityId: deal.id, kind: 'salesOrder' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await fromOpportunity({ opportunityId: deal.id, kind: 'salesOrder' });
    expect(second.status).toBe(422);
    expect(reasonOf(second)).toMatch(/already produced a sales order/);
  });

  it('refuses to invoice a deal that already became an order, naming the route to take', async () => {
    const deal = await createOpportunity('invoice-after-order');
    const order = await fromOpportunity({ opportunityId: deal.id, kind: 'salesOrder' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);

    const invoice = await fromOpportunity({ opportunityId: deal.id, kind: 'invoice' });
    expect(invoice.status).toBe(422);
    expect(reasonOf(invoice)).toMatch(/invoice the order instead/);
  });

  it('sees an order produced by one of the deal’s quotes, so the same acceptance is not billed twice', async () => {
    const deal = await createOpportunity('quote-then-order');
    const quote = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    const quoteId = String(quote.body['id']);
    expect((await transition('quote', quoteId, 'send')).status).toBe(200);
    expect((await transition('quote', quoteId, 'accept')).status).toBe(200);

    const order = await fix.call('POST', `/api/v1/Sales/document/quote/${quoteId}/convert`, {
      action: 'convertToOrder',
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    documents.push({ kind: 'salesOrder', id: String(order.body['id']) });

    // The order points at the *quote*, not at the deal — which is exactly why the guard has to look
    // through the deal's quotes rather than only at deal-sourced documents.
    const direct = await fromOpportunity({ opportunityId: deal.id, kind: 'salesOrder' });
    expect(direct.status).toBe(422);
    expect(reasonOf(direct)).toMatch(/already produced a sales order/);
  });

  it('writes the provenance itself, whatever the request asks for', async () => {
    const deal = await createOpportunity('forged');
    const other = await createOpportunity('forged-other');
    const result = await fromOpportunity({
      opportunityId: deal.id,
      kind: 'quote',
      overrides: { sourceId: other.id, opportunityId: other.id, name: 'AGENT_TEST renamed draft' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const view = result.body as unknown as DocumentView;
    // A header field the caller knows better is its to refine…
    expect(view.document['name']).toBe('AGENT_TEST renamed draft');
    // …but the provenance is the command's to write.
    expect(view.document['sourceId']).toBe(deal.id);
    expect(view.document['opportunityId']).toBe(deal.id);
  });

  it('refuses a kind an opportunity cannot produce', async () => {
    const deal = await createOpportunity('kind');
    const result = await fromOpportunity({ opportunityId: deal.id, kind: 'purchaseOrder' });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/cannot be raised from an opportunity/);
  });

  it('refuses an opportunity that does not exist rather than creating an orphan draft', async () => {
    const result = await fromOpportunity({ opportunityId: `missing-${fix.runId}`, kind: 'quote' });
    expect(result.status).toBe(404);
  });
});

describe('opportunity sourcing and access (19-S.7)', () => {
  it('works for a caller who may read the deal and create the document', async () => {
    const deal = await createOpportunity('acl-allowed');
    const roleId = `role-${fix.runId}-opp-writer`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} deal writer`,
      permissions: {
        Opportunity: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        Quote: { read: 'all', create: 'all', edit: 'all', delete: 'no' },
        // A document's lines are their own records, so writing a draft needs both permissions.
        QuoteItem: { read: 'all', create: 'all', edit: 'all', delete: 'all' },
      },
    });
    const writer = await createTestUser(ctx, { userName: `sales-opp-writer-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(writer.id);

    const allowed = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' }, writer.token);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it('refuses a caller who may not create the document', async () => {
    const deal = await createOpportunity('acl-reader');
    const roleId = `role-${fix.runId}-opp-reader`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} deal reader`,
      permissions: {
        Opportunity: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        Quote: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
      },
    });
    const reader = await createTestUser(ctx, { userName: `sales-opp-reader-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(reader.id);

    const denied = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' }, reader.token);
    expect(denied.status).toBe(403);
  });

  it('refuses a caller who may not see the deal, even when they may create quotes', async () => {
    const deal = await createOpportunity('acl-blind');
    const roleId = `role-${fix.runId}-quote-only`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} quote only`,
      permissions: { Quote: { read: 'all', create: 'all', edit: 'all', delete: 'no' } },
    });
    const blind = await createTestUser(ctx, { userName: `sales-opp-blind-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(blind.id);

    const denied = await fromOpportunity({ opportunityId: deal.id, kind: 'quote' }, blind.token);
    expect(denied.status).toBe(403);
  });
});
