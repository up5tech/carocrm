import type { DocumentBlock } from '@carocrm/document';
import { describe, expect, it } from 'vitest';

import {
  quoteBlocks,
  type QuoteRenderInput,
  quoteRenderLine,
  quoteSubject,
  quoteTemplateData,
  quoteText,
  quoteTitle,
} from '../src/sales/document/quote-document.js';

/**
 * Phase 19-S.7 — the quote block model, as a pure function.
 *
 * No database, no clock, no socket: this suite exists so the *document* half of a quote can be
 * asserted on without producing a binary and without booting the API. What it pins down:
 *
 *  - the block model is the one shared vocabulary plain text and PDF both walk, so a rendered quote
 *    and an emailed quote cannot disagree;
 *  - the renderer does no arithmetic — it prints the engine's numbers verbatim (a renderer that
 *    recalculated would be a second source of truth for money);
 *  - an absent optional fact is **omitted**, not printed as an empty label.
 */

const LINE = {
  position: 1,
  productId: 'p_1',
  name: 'Widget',
  sku: 'W-1',
  unit: 'pc',
  quantity: '2',
  unitPrice: '10.00',
  discountAmount: '0.00',
  netAmount: '20.00',
  taxAmount: '0.00',
  grossAmount: '20.00',
  tax: { taxCodeId: null, taxCodeName: null, taxRatePercent: '0', source: 'line' as const, ruleId: null },
};

function input(overrides: Partial<QuoteRenderInput> = {}): QuoteRenderInput {
  return {
    number: 'Q-000123',
    status: 'sent',
    quoteDate: '2026-10-15',
    validUntil: '2026-11-15',
    accountName: 'Acme Ltd',
    contactName: 'Jane Buyer',
    billingAddress: null,
    shippingAddress: null,
    description: null,
    lines: [quoteRenderLine(LINE)],
    totals: {
      subtotal: '20.00',
      discountTotal: '0.00',
      shippingAmount: '0.00',
      shippingTaxAmount: '0.00',
      taxTotal: '0.00',
      netTotal: '20.00',
      grossTotal: '20.00',
      currency: 'USD',
    },
    ...overrides,
  };
}

function tableOf(blocks: readonly DocumentBlock[]): Extract<DocumentBlock, { kind: 'table' }> {
  const table = blocks.find((block) => block.kind === 'table');
  if (table === undefined || table.kind !== 'table') throw new Error('expected a table block in the quote layout.');
  return table;
}

function keyValueRows(blocks: readonly DocumentBlock[]): readonly { readonly key: string; readonly value: string }[] {
  return blocks.flatMap((block) => (block.kind === 'keyValue' ? block.rows : []));
}

describe('quote block model (19-S.7)', () => {
  it('lays a quote out as a heading, the party facts, the priced lines and the totals', () => {
    const blocks = quoteBlocks(input());

    expect(blocks[0]).toEqual({ kind: 'heading', text: 'Quote Q-000123' });

    const header = keyValueRows(blocks);
    expect(header).toContainEqual({ key: 'Account', value: 'Acme Ltd' });
    expect(header).toContainEqual({ key: 'Valid until', value: '2026-11-15' });

    const table = tableOf(blocks);
    expect(table.columns).toContain('Item');
    expect(table.rows).toHaveLength(1);
    // The line's numbers are printed exactly as the totals engine produced them.
    expect(table.rows[0]).toContain('Widget');
    expect(table.rows[0]).toContain('20.00');

    expect(keyValueRows(blocks)).toContainEqual({ key: 'Gross total (USD)', value: '20.00' });
  });

  it('omits an absent optional fact instead of printing an empty label', () => {
    const blocks = quoteBlocks(input({ billingAddress: null, shippingAddress: '   ', accountName: null }));

    const keys = keyValueRows(blocks).map((row) => row.key);
    expect(keys).not.toContain('Billing address');
    expect(keys).not.toContain('Shipping address');
    expect(keys).not.toContain('Account');
  });

  it('renders the same facts to plain text, which is what an email body carries', () => {
    const text = quoteText(input());

    expect(text).toContain('QUOTE Q-000123');
    expect(text).toContain('Gross total (USD): 20.00');
    expect(text).toContain('Widget');
  });

  it('titles a draft as a draft and names the number once it exists', () => {
    expect(quoteTitle(input({ number: null }))).toBe('Quote (draft)');
    expect(quoteTitle(input())).toBe('Quote Q-000123');
    expect(quoteSubject(input({ number: null }))).toBe('Quote');
    expect(quoteSubject(input())).toBe('Quote Q-000123');
  });

  it('gives a template the line array and the totals, both on the root', () => {
    const data = quoteTemplateData(input());

    expect(Array.isArray(data['lines'])).toBe(true);
    expect((data['lines'] as Record<string, unknown>[])[0]).toMatchObject({ name: 'Widget', grossAmount: '20.00' });
    // Flattened so `{{grossTotal}}` works outside an `{{#each lines}}` block.
    expect(data['grossTotal']).toBe('20.00');
    expect(data['currency']).toBe('USD');
    expect(data['title']).toBe('Quote Q-000123');
  });

  it('maps a calculated line to a printable row, with a blank rather than a null', () => {
    const row = quoteRenderLine({ ...LINE, name: null, sku: null, unit: null, tax: null });

    expect(row.name).toBe('');
    expect(row.sku).toBe('');
    expect(row.unit).toBe('');
    // A line the engine resolved no tax for reports zero, never "undefined%".
    expect(row.taxRatePercent).toBe('0');
  });
});
