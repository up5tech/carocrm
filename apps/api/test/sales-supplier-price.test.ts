import { describe, expect, it } from 'vitest';

import {
  selectSupplierPrice,
  type SupplierPriceCandidate,
} from '../src/sales/pricing/supplier-price.js';

/**
 * Phase 19-S.13 — supplier (buying) price selection, pure.
 *
 * The rules the plan states for purchasing prices, with no database: only active rows, only the
 * document's currency, only a window covering the document date, the quantity break the ordered
 * quantity reaches, and an ambiguity that is **refused** rather than won by row order. A missing price
 * is surfaced, never zeroed — the same policy the sales resolver follows (§4.3, §4.11, §4.12).
 */

const request = {
  supplierId: 'sup1',
  productId: 'p1',
  quantity: '10',
  currency: 'USD',
  date: '2026-10-15',
};

function candidate(overrides: Partial<SupplierPriceCandidate> = {}): SupplierPriceCandidate {
  return {
    id: 'sp1',
    unitPrice: '4.20',
    currency: 'USD',
    minOrderQuantity: null,
    effectiveFrom: null,
    effectiveTo: null,
    active: true,
    ...overrides,
  };
}

describe('selectSupplierPrice', () => {
  it('resolves the single applicable price at the document scale', () => {
    const result = selectSupplierPrice([candidate()], request);
    expect(result).toMatchObject({
      resolved: true,
      supplierProductPriceId: 'sp1',
      price: '4.20',
      currency: 'USD',
    });
  });

  it('prefers the quantity break the ordered quantity reaches', () => {
    const result = selectSupplierPrice(
      [candidate({ id: 'spBase' }), candidate({ id: 'spBulk', unitPrice: '3.80', minOrderQuantity: '5' })],
      request,
    );
    expect(result).toMatchObject({ resolved: true, supplierProductPriceId: 'spBulk', price: '3.80' });
  });

  it('ignores a break the quantity has not reached', () => {
    const result = selectSupplierPrice(
      [candidate({ id: 'spBase' }), candidate({ id: 'spBulk', unitPrice: '3.80', minOrderQuantity: '50' })],
      request,
    );
    expect(result).toMatchObject({ resolved: true, supplierProductPriceId: 'spBase' });
  });

  it('excludes inactive rows, other currencies and windows that do not cover the date', () => {
    for (const rejected of [
      candidate({ active: false }),
      candidate({ currency: 'EUR' }),
      candidate({ effectiveFrom: '2026-11-01' }),
      candidate({ effectiveTo: '2026-10-14' }),
    ]) {
      const result = selectSupplierPrice([rejected], request);
      expect(result.resolved).toBe(false);
      if (!result.resolved) expect(result.reason).toMatch(/no price row|covers the currency/);
    }
  });

  it('reports the reason, and never invents a zero price', () => {
    const result = selectSupplierPrice([], request);
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.reason).toMatch(/no price row/);
  });

  it('refuses two equally specific winners instead of guessing', () => {
    expect(() =>
      selectSupplierPrice(
        [candidate({ id: 'spA' }), candidate({ id: 'spB', unitPrice: '4.00' })],
        request,
      ),
    ).toThrow(/equally specific/);
  });

  it('compares currencies case-insensitively, the way every other money boundary here does', () => {
    const result = selectSupplierPrice([candidate({ currency: 'usd' })], request);
    expect(result.resolved).toBe(true);
  });
});
