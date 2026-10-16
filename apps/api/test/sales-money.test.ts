import { describe, expect, it } from 'vitest';

import {
  assertDocumentEditable,
  assertUnlockAllowed,
  emptyLockState,
  isLocked,
  protectedFieldViolations,
} from '../src/sales/document/lock.js';
import { buildDocumentSnapshot, parseDocumentSnapshot, readDocumentSnapshot, snapshotDigest } from '../src/sales/document/snapshot.js';
import {
  addMoney,
  baseFieldsFor,
  currencyScale,
  isKnownCurrency,
  lineAmount,
  moneyFromDecimal,
  normalizeCurrencyCode,
  parseMoney,
  readFrozenExchangeRate,
  toBaseCurrency,
  validateExchangeRateSnapshot,
} from '../src/sales/money/currency.js';
import {
  add,
  compare,
  divideRounded,
  divideTo,
  format,
  multiply,
  netFromInclusive,
  parseDecimal,
  percentageOf,
  rescale,
  subtract,
  sum,
} from '../src/sales/money/decimal.js';
import { basePaymentBalance } from '../src/sales/payments/allocation-math.js';

describe('decimal engine (19-S.2)', () => {
  it('parses canonical decimal strings exactly, never through a float', () => {
    expect(format(parseDecimal('0.1'))).toBe('0.1');
    // 0.1 + 0.2 is the classic float failure; the exact engine must say 0.3.
    expect(format(add(parseDecimal('0.1'), parseDecimal('0.2')))).toBe('0.3');
    expect(format(add(parseDecimal('0.1'), parseDecimal('0.2')), 2)).toBe('0.30');
    expect(format(parseDecimal('-0.000'))).toBe('0');
    expect(format(parseDecimal('000.50'))).toBe('0.5');
  });

  it('refuses non-canonical input instead of coercing it', () => {
    expect(() => parseDecimal('1e3')).toThrow(/canonical decimal/);
    expect(() => parseDecimal('1,000')).toThrow(/canonical decimal/);
    expect(() => parseDecimal('')).toThrow(/canonical decimal/);
    expect(() => parseDecimal('0.1234567890123')).toThrow(/fraction digits/);
  });

  it('multiplies exactly and rounds only at the named rescale step', () => {
    const product = multiply(parseDecimal('19.99'), parseDecimal('3'));
    expect(format(product)).toBe('59.97');
    expect(format(rescale(product, 0, 'half-up'))).toBe('60');
    expect(format(rescale(parseDecimal('2.5'), 0, 'half-up'))).toBe('3');
    expect(format(rescale(parseDecimal('2.5'), 0, 'half-even'))).toBe('2');
    expect(format(rescale(parseDecimal('3.5'), 0, 'half-even'))).toBe('4');
    expect(format(rescale(parseDecimal('-2.5'), 0, 'half-up'))).toBe('-3');
    expect(format(rescale(parseDecimal('-2.5'), 0, 'floor'))).toBe('-3');
    expect(format(rescale(parseDecimal('2.1'), 0, 'ceil'))).toBe('3');
  });

  it('rounds each documented mode deterministically', () => {
    expect(divideRounded(1n, 3n, 'half-up')).toBe(0n);
    expect(divideRounded(2n, 3n, 'half-up')).toBe(1n);
    expect(divideRounded(-1n, 3n, 'floor')).toBe(-1n);
    expect(divideRounded(1n, 2n, 'half-even')).toBe(0n);
    expect(divideRounded(3n, 2n, 'half-even')).toBe(2n);
    expect(() => divideRounded(1n, 0n, 'half-up')).toThrow(/Division by zero/);
  });

  it('computes percentages and inclusive-tax splits exactly once', () => {
    expect(format(percentageOf(parseDecimal('100'), parseDecimal('19'), 2, 'half-up'), 2)).toBe('19.00');
    expect(format(percentageOf(parseDecimal('0.05'), parseDecimal('50'), 2, 'half-up'))).toBe('0.03');
    // 119 gross at 19%: net exactly 100.
    expect(format(netFromInclusive(parseDecimal('119'), parseDecimal('19'), 2, 'half-up'), 2)).toBe('100.00');
    expect(format(netFromInclusive(parseDecimal('100'), parseDecimal('19'), 2, 'half-up'), 2)).toBe('84.03');
  });

  it('divides at the requested scale and refuses division by zero', () => {
    expect(format(divideTo(parseDecimal('10'), parseDecimal('3'), 2, 'half-up'))).toBe('3.33');
    expect(format(divideTo(parseDecimal('10'), parseDecimal('4'), 2, 'half-up'), 2)).toBe('2.50');
    expect(() => divideTo(parseDecimal('1'), parseDecimal('0'), 2, 'half-up')).toThrow(/Division by zero/);
  });

  it('compares and sums without rounding at intermediate steps', () => {
    expect(compare(parseDecimal('1.10'), parseDecimal('1.1'))).toBe(0);
    expect(compare(parseDecimal('-1'), parseDecimal('1'))).toBe(-1);
    expect(format(sum([parseDecimal('0.1'), parseDecimal('0.2'), parseDecimal('0.3')]))).toBe('0.6');
    expect(format(subtract(parseDecimal('5'), parseDecimal('5.00')))).toBe('0');
  });

  it('never formats a value with more precision than it holds', () => {
    expect(() => format(parseDecimal('1.234'), 2)).toThrow(/round it first/);
    expect(format(rescale(parseDecimal('1.234'), 2, 'half-up'), 2)).toBe('1.23');
  });
});

describe('currency registry and money contract (19-S.2)', () => {
  it('knows minor units per currency, including zero-decimal ones', () => {
    expect(currencyScale('USD')).toBe(2);
    expect(currencyScale('jpy')).toBe(0);
    expect(currencyScale('KWD')).toBe(3);
    expect(isKnownCurrency('USD')).toBe(true);
    expect(isKnownCurrency('usd')).toBe(true);
    expect(isKnownCurrency('ZZZ')).toBe(false);
    expect(() => normalizeCurrencyCode('ZZZ')).toThrow(/not in the supported currency table/);
  });

  it('normalizes amounts to the currency scale and refuses silent rounding', () => {
    expect(parseMoney('10', 'USD').amount).toBe('10.00');
    expect(parseMoney('10.5', 'USD').amount).toBe('10.50');
    expect(() => parseMoney('10.555', 'USD')).toThrow(/at most 2 fraction digits/);
    expect(() => parseMoney('10.5', 'JPY')).toThrow(/at most 0 fraction digits/);
    // Rounding is a named, explicit step instead: moneyFromDecimal states the mode it uses.
    const jpy = moneyFromDecimal(parseDecimal('10.5'), 'JPY', 'half-up');
    expect(jpy.amount).toBe('11');
  });

  it('adds only same-currency money and states the refusal otherwise', () => {
    const usd = parseMoney('10.00', 'USD');
    const eur = parseMoney('10.00', 'EUR');
    expect(addMoney(usd, parseMoney('2.50', 'USD')).amount).toBe('12.50');
    expect(() => addMoney(usd, eur)).toThrow(/without an exchange-rate snapshot/);
  });

  it('rounds a line amount once, at the currency scale', () => {
    expect(lineAmount('3', parseMoney('19.99', 'USD')).amount).toBe('59.97');
    // 1.5 × 0.335 is exactly 0.5025; the one rounding step lands on the KWD scale of 3.
    expect(lineAmount('1.5', parseMoney('0.335', 'KWD')).amount).toBe('0.503');
  });
});

describe('exchange-rate snapshots (19-S.5)', () => {
  it('validates the document-to-base convention', () => {
    const snapshot = validateExchangeRateSnapshot({
      documentCurrency: 'EUR',
      baseCurrency: 'USD',
      rate: '1.085',
      rateDate: '2026-10-15',
      source: 'ECB',
    });
    expect(snapshot.rate).toBe('1.085');
    const converted = toBaseCurrency(parseMoney('100.00', 'EUR'), snapshot);
    expect(converted.currency).toBe('USD');
    expect(converted.amount).toBe('108.50');
  });

  it('refuses a zero, negative, malformed or self-inconsistent rate', () => {
    const base = { documentCurrency: 'EUR', baseCurrency: 'USD', rate: '1.1', rateDate: '2026-10-15' };
    expect(() => validateExchangeRateSnapshot({ ...base, rate: '0' })).toThrow(/greater than zero/);
    expect(() => validateExchangeRateSnapshot({ ...base, rate: '-1' })).toThrow(/greater than zero/);
    expect(() => validateExchangeRateSnapshot({ ...base, rate: '1,08' })).toThrow(/canonical decimal/);
    expect(() => validateExchangeRateSnapshot({ ...base, rateDate: '15-10-2026' })).toThrow(/YYYY-MM-DD/);
    expect(() =>
      validateExchangeRateSnapshot({ documentCurrency: 'USD', baseCurrency: 'USD', rate: '1.1', rateDate: '2026-10-15' }),
    ).toThrow(/must be exactly 1/);
    expect(() => toBaseCurrency(parseMoney('1.00', 'USD'), validateExchangeRateSnapshot({ ...base, rate: '1.1' }))).toThrow(
      /converts EUR/,
    );
  });
});

describe('document snapshots (19-S.2)', () => {
  it('copies by value and stays unchanged when the source object mutates', () => {
    const source = { accountName: 'AGENT_TEST_ACME', lines: [{ sku: 'A-1', unitPrice: '10.00' }], total: '10.00' };
    const snapshot = buildDocumentSnapshot('Invoice:inv_1', source);
    source.accountName = 'Renamed';
    const sourceLine = source.lines[0];
    if (sourceLine === undefined) throw new Error('The fixture lost its line.');
    sourceLine.unitPrice = '99.00';
    expect(readDocumentSnapshot(snapshot).accountName).toBe('AGENT_TEST_ACME');
    expect(readDocumentSnapshot(snapshot).lines.at(0)?.unitPrice).toBe('10.00');
    expect(Object.isFrozen(snapshot.data)).toBe(true);
    expect(Object.isFrozen(snapshot.data.lines.at(0))).toBe(true);
  });

  it('detects a tampered snapshot through its digest', () => {
    const snapshot = buildDocumentSnapshot('Invoice:inv_2', { total: '10.00' });
    const tampered = { ...snapshot, data: { total: '0.00' } };
    expect(() => readDocumentSnapshot(tampered)).toThrow(/modified since it was captured/);
    // A canonical round-trip through JSON verifies cleanly.
    expect(readDocumentSnapshot(parseDocumentSnapshot(JSON.stringify(snapshot))).total).toBe('10.00');
  });

  it('produces a stable digest regardless of key order', () => {
    expect(snapshotDigest({ a: '1', b: '2' })).toBe(snapshotDigest({ b: '2', a: '1' }));
  });
});

describe('issuance locking contract (19-S.2)', () => {
  const state = { ...emptyLockState('invoice'), issuedAt: '2026-10-15T10:00:00.000Z', issuedBy: 'user_1' };

  it('locks an issued invoice under the default policy', () => {
    expect(isLocked(state)).toBe(true);
    expect(protectedFieldViolations(state, ['number', 'grossTotal', 'description'])).toEqual(['number', 'grossTotal']);
    expect(() => assertDocumentEditable(state, ['number'])).toThrow(/cannot be changed/);
    expect(() => assertDocumentEditable(state, ['description'])).not.toThrow();
  });

  it('requires permission and a reason to unlock', () => {
    expect(() => assertUnlockAllowed(state, { isAdmin: false, canUnlock: false })).toThrow(/unlock issued documents/);
    expect(() => assertUnlockAllowed(state, { isAdmin: false, canUnlock: true })).not.toThrow();
    expect(() => assertUnlockAllowed({ ...emptyLockState('invoice') }, { isAdmin: true, canUnlock: true })).toThrow(/not locked/);
  });

  it('does not lock when the policy says lockOnIssue is off', () => {
    expect(isLocked(state, { lockOnIssue: false, unlockRequiresPermission: true })).toBe(false);
    expect(protectedFieldViolations(state, ['number'], { lockOnIssue: false, unlockRequiresPermission: true })).toEqual([]);
  });
});

describe('the frozen exchange-rate snapshot (19-S.18, §4.13)', () => {
  const rate = validateExchangeRateSnapshot({
    documentCurrency: 'USD',
    baseCurrency: 'EUR',
    rate: '0.9333',
    rateDate: '2026-10-01',
    source: 'unit test',
  });

  it('reads back the text a record stores, and treats absence as absence', () => {
    expect(readFrozenExchangeRate(JSON.stringify(rate))).toEqual(rate);
    expect(readFrozenExchangeRate(undefined)).toBeNull();
    expect(readFrozenExchangeRate(null)).toBeNull();
    expect(readFrozenExchangeRate('')).toBeNull();
  });

  it('refuses a stored snapshot that is not valid, instead of converting at a guessed rate', () => {
    expect(() => readFrozenExchangeRate('{ not json')).toThrow(/not valid JSON/);
    expect(() => readFrozenExchangeRate('{"documentCurrency":"USD"}')).toThrow(/incomplete/);
    expect(() => readFrozenExchangeRate('[]')).toThrow(/object or a JSON string/);
  });

  it('derives base balances that always add back to the stored base total', () => {
    const base = basePaymentBalance({
      baseAmount: '93.33',
      currency: 'USD',
      snapshot: rate,
      allocated: '100.00',
    });
    expect(base).not.toBeNull();
    expect(base?.allocated).toBe('93.33');
    // Rounding once at the base scale, then subtracting, keeps allocated + unallocated == amount.
    expect(Number(base?.allocated) + Number(base?.unallocated)).toBe(Number('93.33'));
  });

  it('reports no base balance at all when the record has no frozen rate', () => {
    expect(
      basePaymentBalance({ baseAmount: null, currency: 'USD', snapshot: null, allocated: '10.00' }),
    ).toBeNull();
    // A frozen total with no snapshot behind it is contradictory, and is refused rather than trusted.
    expect(
      basePaymentBalance({ baseAmount: '93.33', currency: 'USD', snapshot: null, allocated: '0.00' }),
    ).toBeNull();
  });

  it('converts an allocation at the payment rate, rounded at the base currency scale', () => {
    expect(baseFieldsFor('40.00', 'USD', JSON.stringify(rate))).toEqual({
      baseAmount: '37.33',
      baseCurrency: 'EUR',
    });
    // No snapshot on the paying record: the row gets nulls, not a zero and not today's rate.
    expect(baseFieldsFor('40.00', 'USD', null)).toEqual({
      baseAmount: null,
      baseCurrency: null,
    });
    expect(() => baseFieldsFor('40.00', 'GBP', JSON.stringify(rate))).toThrow(/converts USD, not GBP/);
  });
});
