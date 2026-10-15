import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocumentSnapshot, readDocumentSnapshot } from '../src/sales/document/snapshot.js';
import { SalesSettingsService } from '../src/sales/sales-settings.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.5 — tax codes, tax rules, rounding stages and totals.
 *
 * Acceptance criteria exercised here: deterministic server-calculated totals, snapshot stability
 * after a rule changes, clear errors for conflicting or missing tax configuration, and reportable
 * tax code/rate data per line.
 */

let ctx: ApiContext;
let fix: SalesFixture;

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

interface TotalsBody {
  currency: string;
  lines: { position: number; netAmount: string; taxAmount: string; grossAmount: string; discountAmount: string; tax: { source: string; taxRatePercent: string; taxCodeId: string | null } | null }[];
  subtotal: string;
  discountTotal: string;
  shippingAmount: string;
  shippingTaxAmount: string;
  taxBreakdown: { taxCodeId: string | null; taxRatePercent: string; taxableBase: string; taxAmount: string }[];
  taxTotal: string;
  netTotal: string;
  grossTotal: string;
  amountDue: string;
  baseCurrency: string | null;
  baseGrossTotal: string | null;
  warnings: string[];
}

async function previewTotals(payload: Record<string, unknown>): Promise<TotalsBody> {
  const result = await fix.call('POST', '/api/v1/Sales/action/previewTotals', payload);
  expect(result.status).toBe(200);
  return result.body as unknown as TotalsBody;
}

describe('totals with explicit tax rates (19-S.5)', () => {
  it('calculates exclusive tax line by line and in the document', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      lines: [
        { name: 'AGENT_TEST line 1', quantity: '1', unitPrice: '100.00', taxRatePercent: '19' },
        { name: 'AGENT_TEST line 2', quantity: '2', unitPrice: '50.00', taxRatePercent: '19' },
      ],
    });
    expect(totals.subtotal).toBe('200.00');
    expect(totals.taxTotal).toBe('38.00');
    expect(totals.netTotal).toBe('200.00');
    expect(totals.grossTotal).toBe('238.00');
    expect(totals.amountDue).toBe('238.00');
    expect(totals.taxBreakdown).toHaveLength(1);
    expect(totals.taxBreakdown[0]!.taxableBase).toBe('200.00');
    expect(totals.taxBreakdown[0]!.taxAmount).toBe('38.00');
    expect(totals.lines[0]!.tax?.source).toBe('line');
  });

  it('splits gross prices when the document is tax-inclusive', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      taxInclusive: true,
      lines: [{ name: 'AGENT_TEST inclusive', quantity: '1', unitPrice: '119.00', taxRatePercent: '19' }],
    });
    expect(totals.netTotal).toBe('100.00');
    expect(totals.taxTotal).toBe('19.00');
    expect(totals.grossTotal).toBe('119.00');
  });

  it('groups multiple rates into one breakdown row per code and rate', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      lines: [
        { name: 'AGENT_TEST standard', quantity: '1', unitPrice: '100.00', taxRatePercent: '19' },
        { name: 'AGENT_TEST reduced', quantity: '1', unitPrice: '100.00', taxRatePercent: '7.5' },
      ],
    });
    expect(totals.taxBreakdown).toHaveLength(2);
    const reduced = totals.taxBreakdown.find((row) => row.taxRatePercent === '7.5');
    expect(reduced?.taxAmount).toBe('7.50');
    expect(totals.taxTotal).toBe('26.50');
  });

  it('applies line discounts before tax', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      lines: [{ name: 'AGENT_TEST discounted', quantity: '1', unitPrice: '100.00', discountPercent: '10', taxRatePercent: '19' }],
    });
    expect(totals.lines[0]!.discountAmount).toBe('10.00');
    expect(totals.lines[0]!.netAmount).toBe('90.00');
    expect(totals.lines[0]!.taxAmount).toBe('17.10');
    expect(totals.grossTotal).toBe('107.10');
    expect(totals.discountTotal).toBe('10.00');
  });

  it('distributes a document discount exactly across the lines', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      documentDiscountAmount: '30.00',
      lines: [
        { name: 'AGENT_TEST d1', quantity: '1', unitPrice: '100.00', taxRatePercent: '0' },
        { name: 'AGENT_TEST d2', quantity: '1', unitPrice: '100.00', taxRatePercent: '0' },
      ],
    });
    expect(totals.lines.map((line) => line.discountAmount)).toEqual(['15.00', '15.00']);
    expect(totals.discountTotal).toBe('30.00');
    expect(totals.netTotal).toBe('170.00');
  });

  it('gives the leftover minor unit to the first line when a discount cannot split evenly', async () => {
    const totals = await previewTotals({
      currency: 'USD',
      documentDiscountAmount: '10.00',
      lines: [
        { name: 'AGENT_TEST e1', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' },
        { name: 'AGENT_TEST e2', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' },
        { name: 'AGENT_TEST e3', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' },
      ],
    });
    const parts = totals.lines.map((line) => line.discountAmount);
    expect(parts).toEqual(['3.34', '3.33', '3.33']);
    expect(totals.discountTotal).toBe('10.00');
  });

  it('taxes shipping with its own tax code', async () => {
    const taxCodeId = await fix.createTaxCode();
    await fix.createTaxRate(taxCodeId, { ratePercent: '19' });
    const totals = await previewTotals({
      currency: 'USD',
      lines: [{ name: 'AGENT_TEST shipping line', quantity: '1', unitPrice: '10.00', taxRatePercent: '0' }],
      shipping: { amount: '50.00', taxCodeId },
    });
    expect(totals.shippingAmount).toBe('50.00');
    expect(totals.shippingTaxAmount).toBe('9.50');
    expect(totals.taxBreakdown.some((row) => row.taxCodeId === taxCodeId && row.taxAmount === '9.50')).toBe(true);
    expect(totals.grossTotal).toBe('69.50');
  });
});

describe('rounding policy (19-S.5)', () => {
  it('rounds each line under the line stage and the document once under the document stage', async () => {
    const settings = ctx.app.get(SalesSettingsService);
    const before = await settings.read();
    try {
      const lines = [
        { name: 'AGENT_TEST r1', quantity: '1', unitPrice: '0.005', taxRatePercent: '0' },
        { name: 'AGENT_TEST r2', quantity: '1', unitPrice: '0.005', taxRatePercent: '0' },
      ];
      await settings.update({ tax: { roundingStage: 'line' } });
      const lineStage = await previewTotals({ currency: 'USD', lines });
      expect(lineStage.netTotal).toBe('0.02');

      await settings.update({ tax: { roundingStage: 'document' } });
      const documentStage = await previewTotals({ currency: 'USD', lines });
      expect(documentStage.netTotal).toBe('0.01');
    } finally {
      await settings.update({ tax: { roundingStage: before.settings.tax.roundingStage } });
      settings.invalidate();
    }
  });

  it('uses zero-decimal currencies without inventing decimals', async () => {
    const totals = await previewTotals({
      currency: 'JPY',
      lines: [{ name: 'AGENT_TEST yen', quantity: '1', unitPrice: '1000', taxRatePercent: '10' }],
    });
    expect(totals.currency).toBe('JPY');
    expect(totals.lines[0]!.netAmount).toBe('1000');
    expect(totals.lines[0]!.taxAmount).toBe('100');
    expect(totals.grossTotal).toBe('1100');
  });

  it('converts to the base currency with the stored rate snapshot', async () => {
    const totals = await previewTotals({
      currency: 'EUR',
      lines: [{ name: 'AGENT_TEST fx', quantity: '1', unitPrice: '100.00', taxRatePercent: '0' }],
      exchangeRate: { documentCurrency: 'EUR', baseCurrency: 'USD', rate: '1.085', rateDate: '2026-10-15', source: 'AGENT_TEST provider' },
    });
    expect(totals.baseCurrency).toBe('USD');
    expect(totals.baseGrossTotal).toBe('108.50');
  });
});

describe('tax resolution from the configuration (19-S.5)', () => {
  it('resolves the product default tax code and its applicable rate', async () => {
    const taxCodeId = await fix.createTaxCode();
    const rateId = await fix.createTaxRate(taxCodeId, { ratePercent: '7.5' });
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-T1`, defaultTaxCodeId: taxCodeId });
    const totals = await previewTotals({
      currency: 'USD',
      lines: [{ productId, quantity: '1', unitPrice: '100.00' }],
    });
    expect(totals.lines[0]!.tax?.source).toBe('taxCode');
    expect(totals.lines[0]!.tax?.taxCodeId).toBe(taxCodeId);
    expect(totals.lines[0]!.tax?.taxRatePercent).toBe('7.5');
    expect(totals.taxTotal).toBe('7.50');
    void rateId;
  });

  it('falls back to a matching tax rule for a product with no default code', async () => {
    const taxCodeId = await fix.createTaxCode();
    await fix.createTaxRate(taxCodeId, { ratePercent: '5' });
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-T2` });
    const ruleId = await fix.createTaxRule(taxCodeId, { productIds: [productId], priority: 5 });
    const totals = await previewTotals({
      currency: 'USD',
      lines: [{ productId, quantity: '1', unitPrice: '100.00' }],
    });
    expect(totals.lines[0]!.tax?.source).toBe('taxRule');
    expect(totals.lines[0]!.tax?.taxRatePercent).toBe('5');
    expect(totals.taxTotal).toBe('5.00');
    void ruleId;
  });

  it('refuses a line with no applicable tax instead of assuming zero', async () => {
    const result = await fix.call('POST', '/api/v1/Sales/action/previewTotals', {
      currency: 'USD',
      lines: [{ name: 'AGENT_TEST untaxed', quantity: '1', unitPrice: '100.00' }],
    });
    expect(result.status).toBe(422);
    expect(String((result.body['error'] as { message?: string }).message)).toMatch(/no applicable tax rate/);
  });

  it('records an explicit zero tax only under the configured policy', async () => {
    const settings = ctx.app.get(SalesSettingsService);
    const before = await settings.read();
    try {
      await settings.update({ tax: { missingTaxPolicy: 'zero' } });
      const totals = await previewTotals({
        currency: 'USD',
        lines: [{ name: 'AGENT_TEST zero policy', quantity: '1', unitPrice: '100.00' }],
      });
      expect(totals.taxTotal).toBe('0.00');
      expect(totals.lines[0]!.tax?.source).toBe('zero');
      expect(totals.warnings.some((warning) => warning.includes('zero tax'))).toBe(true);
    } finally {
      await settings.update({ tax: { missingTaxPolicy: before.settings.tax.missingTaxPolicy } });
      settings.invalidate();
    }
  });

  it('refuses a tax code whose rate is missing on the document date', async () => {
    const taxCodeId = await fix.createTaxCode();
    await fix.createTaxRate(taxCodeId, { ratePercent: '9', effectiveFrom: '2027-01-01' });
    const result = await fix.call('POST', '/api/v1/Sales/action/previewTotals', {
      currency: 'USD',
      date: '2026-10-15',
      lines: [{ name: 'AGENT_TEST future rate', quantity: '1', unitPrice: '100.00', taxCodeId }],
    });
    expect(result.status).toBe(422);
    expect(String((result.body['error'] as { message?: string }).message)).toMatch(/no rate applicable/);
  });

  it('refuses an ambiguous tax rate at save time', async () => {
    const taxCodeId = await fix.createTaxCode();
    await fix.createTaxRate(taxCodeId, { ratePercent: '9', effectiveFrom: '2026-01-01' });
    const duplicate = await fix.call('POST', '/api/v1/TaxRate', {
      name: `AGENT_TEST_${fix.runId} duplicate rate`,
      taxCodeId,
      ratePercent: '10',
      effectiveFrom: '2026-01-01',
      active: true,
    });
    expect(duplicate.status).toBe(422);
    expect(String((duplicate.body['error'] as { message?: string }).message)).toMatch(/Another active tax rate/);
  });

  it('refuses an invalid tax rule at save time', async () => {
    const taxCodeId = await fix.createTaxCode();
    const invalid = await fix.call('POST', '/api/v1/TaxRule', {
      name: `AGENT_TEST_${fix.runId} invalid rule`,
      taxCodeId,
      priority: -1,
      active: true,
    });
    expect(invalid.status).toBe(422);
  });
});

describe('historical snapshots survive rule changes (19-S.5)', () => {
  it('keeps a captured totals snapshot unchanged when the tax rate is edited', async () => {
    const taxCodeId = await fix.createTaxCode();
    const rateId = await fix.createTaxRate(taxCodeId, { ratePercent: '19' });
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-T3`, defaultTaxCodeId: taxCodeId });
    const first = await previewTotals({ currency: 'USD', lines: [{ productId, quantity: '1', unitPrice: '100.00' }] });
    expect(first.taxTotal).toBe('19.00');
    const snapshot = buildDocumentSnapshot('Invoice:AGENT_TEST_snapshot', first);

    const updated = await fix.call('PUT', `/api/v1/TaxRate/${rateId}`, { ratePercent: '25' });
    expect(updated.status).toBe(200);
    const second = await previewTotals({ currency: 'USD', lines: [{ productId, quantity: '1', unitPrice: '100.00' }] });
    expect(second.taxTotal).toBe('25.00');

    // The recorded snapshot still says what was issued, independently of the new rule.
    expect(readDocumentSnapshot(snapshot).taxTotal).toBe('19.00');
  });
});

describe('preview authorization (19-S.5)', () => {
  it('refuses an unauthenticated totals preview', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Sales/action/previewTotals',
      payload: { lines: [{ quantity: '1', unitPrice: '1.00', taxRatePercent: '0' }] },
    });
    expect(response.statusCode).toBe(401);
  });
});
