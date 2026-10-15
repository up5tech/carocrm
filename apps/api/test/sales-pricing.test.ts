import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SalesSettingsService } from '../src/sales/sales-settings.service.js';
import type { ApiContext, TestUser } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.4 — price books, price rules, supplier prices and bulk price updates.
 *
 * Acceptance criteria exercised here: the same context always resolves to the same price and records
 * why it won, missing prices are surfaced (never zeroed), supplier prices never leak into a sales
 * price, and a bulk change is previewed and audited.
 */

let ctx: ApiContext;
let fix: SalesFixture;
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

interface ResolveBody {
  resolved: boolean;
  price?: string;
  source?: string;
  explanation?: string;
  priceBookEntryId?: string | null;
  priceRuleId?: string | null;
  trace?: { step: string; detail: string }[];
}

async function resolvePrice(payload: Record<string, unknown>): Promise<ResolveBody> {
  const result = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', payload);
  expect(result.status).toBe(200);
  return result.body as unknown as ResolveBody;
}

describe('price resolution (19-S.4)', () => {
  it('falls back to the product unit price when no price book applies', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P1`, unitPrice: '12.50' });
    const resolved = await resolvePrice({ productId });
    expect(resolved.resolved).toBe(true);
    expect(resolved.price).toBe('12.50');
    expect(resolved.source).toBe('productUnitPrice');
    expect(resolved.explanation).toBe('Product unit price.');
  });

  it('prefers a price book entry and names the book that won', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P2`, unitPrice: '12.50' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    const entryId = await fix.createEntry(bookId, productId, { unitPrice: '9.00' });
    const resolved = await resolvePrice({ productId, priceBookId: bookId });
    expect(resolved.price).toBe('9.00');
    expect(resolved.source).toBe('priceBookEntry');
    expect(resolved.priceBookEntryId).toBe(entryId);
    expect(resolved.explanation).toContain(fix.runId);
  });

  it('applies the quantity break that fits the requested quantity', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P3`, unitPrice: '20.00' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createEntry(bookId, productId, { unitPrice: '10.00', minQuantity: '1' });
    await fix.createEntry(bookId, productId, { unitPrice: '8.00', minQuantity: '10' });
    const small = await resolvePrice({ productId, priceBookId: bookId, quantity: '5' });
    expect(small.price).toBe('10.00');
    const large = await resolvePrice({ productId, priceBookId: bookId, quantity: '12' });
    expect(large.price).toBe('8.00');
  });

  it('ignores entries whose effective window does not cover the document date', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P4`, unitPrice: '15.00' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createEntry(bookId, productId, { unitPrice: '5.00', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' });
    const resolved = await resolvePrice({ productId, priceBookId: bookId, date: '2026-10-15' });
    expect(resolved.source).toBe('productUnitPrice');
    const inWindow = await resolvePrice({ productId, priceBookId: bookId, date: '2027-06-01' });
    expect(inWindow.price).toBe('5.00');
  });

  it('does not price a USD document from a EUR price book', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P5`, unitPrice: '11.00' });
    const bookId = await fix.createPriceBook({ currency: 'EUR' });
    await fix.createEntry(bookId, productId, { unitPrice: '3.00' });
    const resolved = await resolvePrice({ productId, priceBookId: bookId, currency: 'USD' });
    expect(resolved.source).toBe('productUnitPrice');
    expect(resolved.trace?.some((step) => step.detail.includes('is in EUR, not USD'))).toBe(true);
  });

  it('applies the deterministic rule that wins and reports it', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P6`, unitPrice: '10.00' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createEntry(bookId, productId, { unitPrice: '100.00' });
    const ruleId = await fix.createRule(bookId, { actionType: 'percentAdjustment', actionValue: '10' });
    const resolved = await resolvePrice({ productId, priceBookId: bookId });
    expect(resolved.price).toBe('110.00');
    expect(resolved.source).toBe('priceRule');
    expect(resolved.priceRuleId).toBe(ruleId);
  });

  it('lets a setPrice rule produce a price with no entry at all', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P7` });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createRule(bookId, { actionType: 'setPrice', actionValue: '42.50' });
    const resolved = await resolvePrice({ productId, priceBookId: bookId });
    expect(resolved.price).toBe('42.50');
    expect(resolved.source).toBe('priceRule');
  });

  it('reports two equally specific rules as a conflict instead of picking one', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P8`, unitPrice: '10.00' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createEntry(bookId, productId, { unitPrice: '10.00' });
    await fix.createRule(bookId, { productIds: [productId], priority: 5, actionType: 'percentAdjustment', actionValue: '10' });
    await fix.createRule(bookId, { productIds: [productId], priority: 5, actionType: 'percentAdjustment', actionValue: '20' });
    const result = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId, priceBookId: bookId });
    expect(result.status).toBe(422);
    expect(String((result.body['error'] as { message?: string }).message)).toMatch(/same priority and specificity/);
  });

  it('surfaces a missing price instead of defaulting it to zero', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P9`, unitPrice: null });
    // A product with `unitPrice: null` stores no price; the default policy refuses the resolution.
    const result = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId });
    expect(result.status).toBe(422);
    expect(String((result.body['error'] as { message?: string }).message)).toMatch(/No price could be resolved/);

    // With the explicit policy the same request returns an *unresolved* result, still never zero.
    const settings = ctx.app.get(SalesSettingsService);
    const before = await settings.read();
    try {
      await settings.update({ pricing: { missingPricePolicy: 'allowExplicit' } });
      const allowed = await resolvePrice({ productId });
      expect(allowed.resolved).toBe(false);
      expect(allowed.price).toBeUndefined();
    } finally {
      await settings.update({ pricing: { missingPricePolicy: before.settings.pricing.missingPricePolicy } });
      settings.invalidate();
    }
  });

  it('never uses a supplier price as a sales price', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-P10`, unitPrice: '25.00' });
    const supplierId = await fix.createSupplier();
    await fix.createSupplierPrice(supplierId, productId, { unitPrice: '4.20' });
    const resolved = await resolvePrice({ productId });
    expect(resolved.price).toBe('25.00');
    expect(resolved.source).toBe('productUnitPrice');
  });
});

describe('price resolution permissions (19-S.4)', () => {
  it('refuses resolution to a user with no product access', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-ACL1`, unitPrice: '5.00' });
    const user = await createTestUser(ctx, { userName: `sales-price-none-${fix.runId}`, roleIds: ['noAccess'] });
    cleanupUsers.push(user.id);
    const result = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId }, user.token);
    expect(result.status).toBe(403);
  });

  it('requires price-book read access when a book contributes the price', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-ACL2`, unitPrice: '5.00' });
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    await fix.createEntry(bookId, productId, { unitPrice: '1.00' });

    const roleId = `role-${fix.runId}-prodfirst`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} product-only`,
      permissions: { Product: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
    });
    const user: TestUser = await createTestUser(ctx, { userName: `sales-price-book-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(user.id);

    const withBook = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId, priceBookId: bookId }, user.token);
    expect(withBook.status).toBe(403);
    const withoutBook = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId }, user.token);
    expect(withoutBook.status).toBe(200);
    expect((withoutBook.body as unknown as ResolveBody).price).toBe('5.00');
  });
});

describe('bulk price update (19-S.4)', () => {
  it('previews the changes, applies them in one audited transaction and reports the count', async () => {
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    const first = await fix.createProduct({ sku: `AGENT-${fix.runId}-B1` });
    const second = await fix.createProduct({ sku: `AGENT-${fix.runId}-B2` });
    const firstEntry = await fix.createEntry(bookId, first, { unitPrice: '10.00' });
    const secondEntry = await fix.createEntry(bookId, second, { unitPrice: '20.50' });

    const preview = await fix.call('POST', '/api/v1/Sales/action/bulkPriceUpdate', {
      mode: 'preview',
      priceBookId: bookId,
      adjustment: { type: 'percent', value: '10' },
    });
    expect(preview.status).toBe(200);
    expect(preview.body['mode']).toBe('preview');
    expect(preview.body['applied']).toBe(false);
    const changes = preview.body['changes'] as { entryId: string; from: string; to: string }[];
    expect(changes.find((change) => change.entryId === firstEntry)?.to).toBe('11.00');
    expect(changes.find((change) => change.entryId === secondEntry)?.to).toBe('22.55');
    expect(preview.body['changedCount']).toBe(2);

    // A preview changes nothing.
    const untouched = await fix.call('GET', `/api/v1/PriceBookEntry/${firstEntry}`);
    expect(untouched.body['unitPrice']).toBe('10.00');

    const applied = await fix.call('POST', '/api/v1/Sales/action/bulkPriceUpdate', {
      mode: 'apply',
      priceBookId: bookId,
      adjustment: { type: 'percent', value: '10' },
    });
    expect(applied.status).toBe(200);
    expect(applied.body['applied']).toBe(true);
    expect(typeof applied.body['auditId']).toBe('string');

    const updated = await fix.call('GET', `/api/v1/PriceBookEntry/${firstEntry}`);
    expect(updated.body['unitPrice']).toBe('11.00');
    const audit = await ctx.database.db
      .selectFrom('audit_log')
      .select(['id', 'entity_type', 'record_id'])
      .where('id', '=', String(applied.body['auditId']))
      .executeTakeFirst();
    expect(audit?.entity_type).toBe('PriceBook');
    expect(audit?.record_id).toBe(bookId);
  });

  it('bounds the run and reports truncation', async () => {
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    for (let index = 0; index < 3; index++) {
      const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-B3-${String(index)}` });
      await fix.createEntry(bookId, productId, { unitPrice: '5.00' });
    }
    const result = await fix.call('POST', '/api/v1/Sales/action/bulkPriceUpdate', {
      mode: 'preview',
      priceBookId: bookId,
      adjustment: { type: 'set', value: '7.00' },
      limit: 2,
    });
    expect(result.status).toBe(200);
    expect(result.body['truncated']).toBe(true);
    expect(result.body['changedCount']).toBe(2);
  });

  it('refuses a bulk update to a user without edit access', async () => {
    const bookId = await fix.createPriceBook({ currency: 'USD' });
    const user = await createTestUser(ctx, { userName: `sales-bulk-none-${fix.runId}`, roleIds: ['noAccess'] });
    cleanupUsers.push(user.id);
    const result = await fix.call(
      'POST',
      '/api/v1/Sales/action/bulkPriceUpdate',
      { mode: 'preview', priceBookId: bookId, adjustment: { type: 'percent', value: '10' } },
      user.token,
    );
    expect(result.status).toBe(403);
  });
});
