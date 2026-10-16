import { describe, expect, it } from 'vitest';

import {
  normalizeVariantAttributes,
  normalizeVariantFamily,
  validateProductWrite,
  variantAttributesSignature,
} from '../src/sales/catalog/product-rules.js';
import {
  allocateBatches,
  allocateSerials,
  assertSerialCountMatch,
  isExpired,
  normalizeIdentity,
  orderBatches,
  orderSerials,
  parseSerialNumbers,
  validateLotDates,
} from '../src/sales/inventory/picking.js';
import {
  DEFAULT_SALES_SETTINGS,
  SalesSettingsSchema,
  settingsWarnings,
} from '../src/sales/sales-settings.service.js';

/**
 * Phase 19-S.15 — the pure stock-identity rules: which unit a removal policy consumes, what a
 * lot/serial line must look like, and how a variant is validated. No database, no clock: today's
 * date and every candidate are arguments, so the exact ordering, the expiry gate and every refusal
 * are pinned rather than observed (PLAN_Phase_19_Sales.md §4.2, §4.15, §19-S.15).
 *
 * Every rule gets its negative case (AGENTS.MD §9): an expired lot under an excluding policy, a
 * shortage, a fractional serial quantity, an unknown variant code, a duplicate serial in one line.
 */

const FRESH = { today: '2026-10-16', excludeExpired: true } as const;

function batch(
  batchNumber: string,
  onHand: string,
  expiryDate?: string | null,
  receivedAt?: string | null,
) {
  return { batchNumber, onHand, expiryDate, receivedAt };
}

describe('removal policy — deterministic ordering', () => {
  const lots = [
    batch('LOT-2', '3', '2027-01-31', '2026-10-01T00:00:00.000Z'),
    batch('LOT-1', '4', '2026-12-31', '2026-09-01T00:00:00.000Z'),
    batch('LOT-3', '2', null, '2026-08-01T00:00:00.000Z'),
  ];

  it('FIFO consumes the oldest receipt first and falls back to the lot number', () => {
    const ordered = orderBatches('fifo', lots, FRESH);
    expect(ordered.map((each) => each.batchNumber)).toEqual([
      'LOT-3',
      'LOT-1',
      'LOT-2',
    ]);
    const tied = orderBatches(
      'fifo',
      [batch('LOT-B', '1', null, '2026-10-01T00:00:00.000Z'), batch('LOT-A', '1', null, '2026-10-01T00:00:00.000Z')],
      FRESH,
    );
    expect(tied.map((each) => each.batchNumber)).toEqual(['LOT-A', 'LOT-B']);
  });

  it('LIFO consumes the newest receipt first, unknown age last', () => {
    const ordered = orderBatches('lifo', lots, FRESH);
    expect(ordered.map((each) => each.batchNumber)).toEqual([
      'LOT-2',
      'LOT-1',
      'LOT-3',
    ]);
  });

  it('FEFO consumes the earliest expiry first and puts lots without an expiry last', () => {
    const ordered = orderBatches('fefo', lots, FRESH);
    expect(ordered.map((each) => each.batchNumber)).toEqual([
      'LOT-1',
      'LOT-2',
      'LOT-3',
    ]);
  });

  it('is stable: the same stock picture always yields the same order', () => {
    const once = orderBatches('fefo', lots, FRESH).map((each) => each.batchNumber);
    const again = orderBatches('fefo', [...lots].reverse(), FRESH).map((each) => each.batchNumber);
    expect(again).toEqual(once);
  });

  it('keeps expired lots out when the setting forbids them, in every policy', () => {
    const withExpired = [
      batch('LOT-OLD', '9', '2026-01-01', '2026-01-01T00:00:00.000Z'),
      batch('LOT-NEW', '1', '2027-01-01', '2026-10-10T00:00:00.000Z'),
    ];
    for (const policy of ['fifo', 'fefo', 'lifo'] as const) {
      const eligible = orderBatches(policy, withExpired, FRESH);
      expect(eligible.map((each) => each.batchNumber)).toEqual(['LOT-NEW']);
    }
    // The operator's explicit override: with the gate off, FEFO really does pick the expired lot.
    const allowed = orderBatches('fefo', withExpired, { ...FRESH, excludeExpired: false });
    expect(allowed.map((each) => each.batchNumber)).toEqual(['LOT-OLD', 'LOT-NEW']);
  });

  it('treats a lot expiring today as still eligible — the expiry date is the last good day', () => {
    expect(isExpired('2026-10-15', '2026-10-16')).toBe(true);
    expect(isExpired('2026-10-16', '2026-10-16')).toBe(false);
    expect(isExpired(null, '2026-10-16')).toBe(false);
  });
});

describe('batch allocation', () => {
  it('splits a movement across lots in policy order until it is satisfied', () => {
    const pick = allocateBatches(
      'fifo',
      [batch('LOT-2', '5', null, '2026-10-02T00:00:00.000Z'), batch('LOT-1', '2', null, '2026-10-01T00:00:00.000Z')],
      '4',
      FRESH,
    );
    expect(pick.shortage).toBe('0');
    expect(pick.allocations).toEqual([
      { batchNumber: 'LOT-1', quantity: '2' },
      { batchNumber: 'LOT-2', quantity: '2' },
    ]);
  });

  it('reports a shortage instead of pretending the rest exists', () => {
    const pick = allocateBatches('fifo', [batch('LOT-1', '3', null, null)], '5', FRESH);
    expect(pick.shortage).toBe('2');
    expect(pick.allocations).toEqual([{ batchNumber: 'LOT-1', quantity: '3' }]);
  });

  it('refuses a non-positive allocation quantity', () => {
    expect(() => allocateBatches('fifo', [batch('LOT-1', '3')], '0', FRESH)).toThrow(/positive/i);
    expect(() => allocateBatches('fifo', [batch('LOT-1', '3')], '-1', FRESH)).toThrow(/positive/i);
  });
});

describe('serial allocation', () => {
  const units = [
    { serialNumber: 'SN-2', receivedAt: '2026-10-02T00:00:00.000Z' },
    { serialNumber: 'SN-1', receivedAt: '2026-10-01T00:00:00.000Z' },
  ];

  it('picks whole units in policy order', () => {
    const fifo = allocateSerials('fifo', units, '2');
    expect(fifo).toEqual({ serialNumbers: ['SN-1', 'SN-2'], shortage: '0' });
    const lifo = allocateSerials('lifo', units, '1');
    expect(lifo).toEqual({ serialNumbers: ['SN-2'], shortage: '0' });
    expect(orderSerials('fefo', units).map((each) => each.serialNumber)).toEqual(['SN-1', 'SN-2']);
  });

  it('reports how many units are missing rather than inventing them', () => {
    const pick = allocateSerials('fifo', units, '3');
    expect(pick.serialNumbers).toHaveLength(2);
    expect(pick.shortage).toBe('1');
  });

  it('refuses a fractional quantity — a serial is a whole unit', () => {
    expect(() => allocateSerials('fifo', units, '1.5')).toThrow(/whole units/i);
    expect(() => assertSerialCountMatch('2.5', ['SN-1'])).toThrow(/whole units/i);
  });

  it('refuses a line whose serial count is not its quantity', () => {
    expect(() => assertSerialCountMatch('2', ['SN-1'])).toThrow(/serial number/i);
    expect(() => assertSerialCountMatch('1', ['SN-1', 'SN-2'])).toThrow(/serial number/i);
    expect(() => assertSerialCountMatch('1', ['SN-1'])).not.toThrow();
  });
});

describe('lot identity and dates', () => {
  it('canonicalizes a lot/serial number (trim, upper-case) so one identity has one key', () => {
    expect(normalizeIdentity('  lot-7 ', 'batchNumber')).toBe('LOT-7');
    expect(() => normalizeIdentity('   ', 'batchNumber')).toThrow(/1–64/);
    expect(() => normalizeIdentity('x'.repeat(65), 'serialNumber')).toThrow(/1–64/);
    expect(() => normalizeIdentity('bad\u0000name', 'batchNumber')).toThrow(/control characters/);
  });

  it('parses the serials of a line from an array or their stored JSON, refusing repeats', () => {
    expect(parseSerialNumbers([' sn-1 ', 'SN-2'])).toEqual(['SN-1', 'SN-2']);
    expect(parseSerialNumbers('["SN-1","SN-2"]')).toEqual(['SN-1', 'SN-2']);
    expect(parseSerialNumbers(null)).toEqual([]);
    expect(parseSerialNumbers('')).toEqual([]);
    expect(() => parseSerialNumbers(['SN-1', 'sn-1'])).toThrow(/twice/i);
    expect(() => parseSerialNumbers('not json')).toThrow(/array/i);
    expect(() => parseSerialNumbers('{"a":1}')).toThrow(/array/i);
  });

  it('validates lot dates against each other and against today', () => {
    expect(() =>
      validateLotDates({ manufacturingDate: '2026-01-01', expiryDate: '2026-12-31', today: '2026-10-16' }),
    ).not.toThrow();
    expect(() =>
      validateLotDates({ manufacturingDate: '2026-12-31', expiryDate: '2026-01-01' }),
    ).toThrow(/must not be after/i);
    expect(() => validateLotDates({ expiryDate: '31/12/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => validateLotDates({ manufacturingDate: '2027-01-01', today: '2026-10-16' })).toThrow(
      /future/i,
    );
    expect(() => validateLotDates({ expiryDate: null, manufacturingDate: null })).not.toThrow();
  });
});

describe('product variants (§4.2)', () => {
  const definitions = [
    { code: 'size', label: 'Size' },
    { code: 'color', label: 'Colour' },
  ];

  it('normalizes the family label', () => {
    expect(normalizeVariantFamily('  T-Shirt ')).toBe('T-Shirt');
    expect(normalizeVariantFamily('   ')).toBeNull();
    expect(normalizeVariantFamily(undefined)).toBeNull();
    expect(() => normalizeVariantFamily('x'.repeat(65))).toThrow(/64/);
  });

  it('accepts the configured attributes, canonicalized and sorted', () => {
    const attributes = normalizeVariantAttributes({
      raw: { COLOR: 'red', size: ' M ' },
      definitions,
      requireAll: true,
    });
    expect(attributes).toEqual({ color: 'red', size: 'M' });
    // Stored JSON round-trips through the same rule.
    expect(
      normalizeVariantAttributes({
        raw: JSON.stringify({ size: 'M', color: 'red' }),
        definitions,
        requireAll: true,
      }),
    ).toEqual(attributes);
  });

  it('refuses an attribute nobody configured, naming what is configured', () => {
    expect(() =>
      normalizeVariantAttributes({ raw: { material: 'cotton' }, definitions, requireAll: false }),
    ).toThrow(/Unknown variant attribute/i);
    expect(() =>
      normalizeVariantAttributes({ raw: { material: 'cotton' }, definitions, requireAll: false }),
    ).toThrow(/size, color/);
  });

  it('refuses a missing required attribute and an empty value', () => {
    expect(() =>
      normalizeVariantAttributes({ raw: { size: 'M' }, definitions, requireAll: true }),
    ).toThrow(/Missing variant attribute/i);
    expect(() =>
      normalizeVariantAttributes({
        raw: { size: 'M', color: '  ' },
        definitions,
        requireAll: false,
      }),
    ).toThrow(/needs a value/);
    expect(() =>
      normalizeVariantAttributes({ raw: { size: 'M', color: 'red' }, definitions, requireAll: false }),
    ).not.toThrow();
  });

  it('refuses a non-object attribute value', () => {
    expect(() =>
      normalizeVariantAttributes({ raw: 'not json', definitions, requireAll: false }),
    ).toThrow(/object/i);
    expect(() =>
      normalizeVariantAttributes({ raw: ['size'], definitions, requireAll: false }),
    ).toThrow(/object/i);
  });

  it('signatures compare stored forms canonically — the sibling-uniqueness rule', () => {
    expect(variantAttributesSignature('{"color":"red","size":"M"}')).toBe(
      variantAttributesSignature({ SIZE: 'M', color: ' red ' }),
    );
    expect(variantAttributesSignature('{"size":"L","color":"red"}')).not.toBe(
      variantAttributesSignature({ size: 'M', color: 'red' }),
    );
    expect(variantAttributesSignature(null)).toBe('{}');
    expect(variantAttributesSignature('')).toBe('{}');
  });

  it('keeps SKU validation unchanged for variants — a variant SKU is a product SKU', () => {
    expect(() => validateProductWrite({ sku: 'VARIANT-1' })).not.toThrow();
    expect(() => validateProductWrite({ sku: 'has space' })).toThrow();
  });
});

describe('tracking settings', () => {
  it('defaults the removal policy to FIFO with expired stock excluded', () => {
    expect(DEFAULT_SALES_SETTINGS.inventory.removalPolicy).toBe('fifo');
    expect(DEFAULT_SALES_SETTINGS.inventory.excludeExpiredStock).toBe(true);
    expect(DEFAULT_SALES_SETTINGS.features.productVariants).toBe(false);
    expect(DEFAULT_SALES_SETTINGS.variants.attributes).toEqual([]);
  });

  it('rejects an unknown removal policy and a malformed attribute code', () => {
    expect(
      SalesSettingsSchema.safeParse({ inventory: { removalPolicy: 'fejo' } }).success,
    ).toBe(false);
    expect(
      SalesSettingsSchema.safeParse({
        variants: { attributes: [{ code: '1st', label: 'First' }] },
      }).success,
    ).toBe(false);
    expect(
      SalesSettingsSchema.safeParse({
        variants: { attributes: [{ code: 'size', label: 'Size' }, { code: 'SIZE', label: 'Size' }] },
      }).success,
    ).toBe(false);
  });

  it('warns when variants are enabled without attributes to validate against', () => {
    const settings = SalesSettingsSchema.parse({ features: { productVariants: true } });
    expect(settingsWarnings(settings).map((warning) => warning.code)).toContain(
      'productVariantsWithoutAttributes',
    );
    expect(settingsWarnings(DEFAULT_SALES_SETTINGS).map((warning) => warning.code)).not.toContain(
      'productVariantsWithoutAttributes',
    );
  });
});
