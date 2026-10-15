import { ValidationError } from "@carocrm/core/errors/index.js";

import type { Decimal, RoundingMode } from "./decimal.js";
import {
  add,
  compare,
  decimalFromInteger,
  format,
  isNegative,
  multiply,
  multiplyTo,
  parseDecimal,
  rescale,
  subtract,
  zero,
} from "./decimal.js";

/**
 * Phase 19-S.2 / 19-S.5 — the module's currency facts.
 *
 * The audit (`docs/implementation/sales-repository-audit.md` §5) recorded that the kernel has
 * **no currency registry and no exchange-rate facility**: `currency` is a metadata field type that
 * stores a canonical decimal *string* and is cast to `numeric` inside query expressions, nothing
 * more. Until a platform-level currency module exists, the Sales module owns the two facts a money
 * calculation needs — how many fraction digits a currency has, and how a document rate snapshot is
 * validated — and states them as an explicit contract instead of guessing.
 *
 * Amounts are decimal strings at every boundary (PLAN_Phase_19_Sales.md §4.13, §5.7): no function
 * here accepts or returns a JavaScript `number`.
 */

/** ISO 4217 minor-unit digits for the currencies an installation can select. */
export const CURRENCY_SCALES: Readonly<Record<string, number>> = {
  // Zero-decimal currencies.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal currencies.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Four-decimal fund/cash units.
  CLF: 4,
  UYW: 4,
  // Two-decimal currencies.
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BGN: 2,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHF: 2,
  CNY: 2,
  COP: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IRR: 2,
  JMD: 2,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KPW: 2,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  USD: 2,
  UYU: 2,
  UZS: 2,
  VES: 2,
  WST: 2,
  XCD: 2,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2,
};

export const KNOWN_CURRENCIES: readonly string[] =
  Object.keys(CURRENCY_SCALES).sort();

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Uppercase and structurally validate a currency code; unknown codes are refused. */
export function normalizeCurrencyCode(code: string): string {
  if (typeof code !== "string") {
    throw new ValidationError("A currency code must be a string.", {
      currency: String(code),
    });
  }
  const normalized = code.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new ValidationError(
      `"${code}" is not a three-letter currency code.`,
      { currency: code },
    );
  }
  if (CURRENCY_SCALES[normalized] === undefined) {
    throw new ValidationError(
      `Currency "${normalized}" is not in the supported currency table.`,
      { currency: normalized },
    );
  }
  return normalized;
}

export function isKnownCurrency(code: string): boolean {
  if (typeof code !== "string") return false;
  const normalized = code.trim().toUpperCase();
  return (
    CURRENCY_PATTERN.test(normalized) &&
    CURRENCY_SCALES[normalized] !== undefined
  );
}

/** Fraction digits of a currency, e.g. `2` for USD, `0` for JPY. */
export function currencyScale(code: string): number {
  const normalized = normalizeCurrencyCode(code);
  return CURRENCY_SCALES[normalized] ?? 2;
}

/**
 * A money value at an API boundary: a canonical decimal string, the currency it is expressed in,
 * and the scale that string is fixed at. `amount` is always `format(value, scale)`.
 */
export interface Money {
  readonly amount: string;
  readonly currency: string;
  readonly scale: number;
}

/**
 * Parse an amount for a currency.
 *
 * The amount may name fewer fraction digits than the currency (`"10"` for USD) and is normalized
 * to the currency scale (`"10.00"`). It may **not** name more: silently rounding a client-supplied
 * amount would change the value without saying so (PLAN_Phase_19_Sales.md §5.7). Internal
 * calculations use {@link moneyFromDecimal} and state their rounding mode instead.
 */
export function parseMoney(amount: string, currency: string): Money {
  const code = normalizeCurrencyCode(currency);
  const scale = currencyScale(code);
  const value = parseDecimal(amount);
  if (value.scale > scale) {
    throw new ValidationError(
      `A ${code} amount supports at most ${scale} fraction digits.`,
      { amount, currency: code },
    );
  }
  return {
    amount: format(rescale(value, scale, "half-up"), scale),
    currency: code,
    scale,
  };
}

export function moneyDecimal(value: Money): Decimal {
  return parseDecimal(value.amount);
}

/** Round an exact decimal into a currency amount, with a named rounding mode. */
export function moneyFromDecimal(
  value: Decimal,
  currency: string,
  mode: RoundingMode = "half-up",
): Money {
  const code = normalizeCurrencyCode(currency);
  const scale = currencyScale(code);
  return {
    amount: format(rescale(value, scale, mode), scale),
    currency: code,
    scale,
  };
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new ValidationError(
      `Cannot combine ${left.currency} and ${right.currency} amounts without an exchange-rate snapshot.`,
      {
        left: left.currency,
        right: right.currency,
      },
    );
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  const sum = add(moneyDecimal(left), moneyDecimal(right));
  return {
    amount: format(rescale(sum, left.scale, "half-up"), left.scale),
    currency: left.currency,
    scale: left.scale,
  };
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  const difference = subtract(moneyDecimal(left), moneyDecimal(right));
  return {
    amount: format(rescale(difference, left.scale, "half-up"), left.scale),
    currency: left.currency,
    scale: left.scale,
  };
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  return compare(moneyDecimal(left), moneyDecimal(right));
}

export function isZeroMoney(value: Money): boolean {
  return compareMoney(value, zeroMoney(value.currency)) === 0;
}

export function isNegativeMoney(value: Money): boolean {
  return isNegative(moneyDecimal(value));
}

export function zeroMoney(currency: string): Money {
  const code = normalizeCurrencyCode(currency);
  const scale = currencyScale(code);
  return { amount: format(zero(scale), scale), currency: code, scale };
}

/**
 * `quantity × unitPrice` rounded once to the currency scale. Quantity is an exact decimal (it may
 * carry the configured quantity precision), the price is a money value, and the single rounding
 * happens here — the calculation stage every line uses.
 */
export function lineAmount(
  quantity: string,
  unitPrice: Money,
  mode: RoundingMode = "half-up",
): Money {
  const quantityValue = parseDecimal(quantity);
  const product = multiply(quantityValue, moneyDecimal(unitPrice));
  return {
    amount: format(rescale(product, unitPrice.scale, mode), unitPrice.scale),
    currency: unitPrice.currency,
    scale: unitPrice.scale,
  };
}

/** Sum money values; they must share a currency. An empty list is zero in `currency`. */
export function sumMoney(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>(
    (total, value) => addMoney(total, value),
    zeroMoney(currency),
  );
}

/**
 * Exchange-rate snapshot (PLAN_Phase_19_Sales.md §4.13).
 *
 * **Convention, stated once and used everywhere:** `rate` is the number of *base-currency* units
 * for ONE *document-currency* unit (`document → base`). A document snapshot therefore converts with
 * `base = round(document × rate)`.
 */
export interface ExchangeRateSnapshot {
  readonly documentCurrency: string;
  readonly baseCurrency: string;
  /** Base-currency units per one document-currency unit, as a canonical decimal string. */
  readonly rate: string;
  /** The day the rate was quoted, `YYYY-MM-DD`. */
  readonly rateDate: string;
  /** Where the rate came from (provider name, manual entry, …). */
  readonly source: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Caller-supplied snapshot before validation: `source` defaults to `manual`. */
export interface ExchangeRateInput {
  readonly documentCurrency: string;
  readonly baseCurrency: string;
  readonly rate: string;
  readonly rateDate: string;
  readonly source?: string | undefined;
}

/** Validate and normalize a snapshot; anything ambiguous is refused rather than guessed. */
export function validateExchangeRateSnapshot(input: {
  readonly documentCurrency: string;
  readonly baseCurrency: string;
  readonly rate: string;
  readonly rateDate: string;
  readonly source?: string | undefined;
}): ExchangeRateSnapshot {
  const documentCurrency = normalizeCurrencyCode(input.documentCurrency);
  const baseCurrency = normalizeCurrencyCode(input.baseCurrency);
  const rate = parseDecimal(input.rate);
  if (compare(rate, zero()) <= 0) {
    throw new ValidationError("An exchange rate must be greater than zero.", {
      rate: input.rate,
    });
  }
  if (
    documentCurrency === baseCurrency &&
    compare(rate, decimalFromInteger(1)) !== 0
  ) {
    throw new ValidationError(
      "The exchange rate between a currency and itself must be exactly 1.",
      { rate: input.rate },
    );
  }
  if (!DATE_PATTERN.test(input.rateDate)) {
    throw new ValidationError(
      "An exchange-rate date must be a YYYY-MM-DD date.",
      { rateDate: input.rateDate },
    );
  }
  const source = (input.source ?? "manual").trim();
  if (source === "" || source.length > 120) {
    throw new ValidationError(
      "An exchange-rate source must be 1–120 characters.",
      { source: input.source },
    );
  }
  return {
    documentCurrency,
    baseCurrency,
    rate: format(rate),
    rateDate: input.rateDate,
    source,
  };
}

/** `amount × rate` into the base currency, rounded once at the base currency's scale. */
export function toBaseCurrency(
  amount: Money,
  snapshot: ExchangeRateSnapshot,
  mode: RoundingMode = "half-up",
): Money {
  if (amount.currency !== snapshot.documentCurrency) {
    throw new ValidationError(
      `The snapshot converts ${snapshot.documentCurrency}, not ${amount.currency}.`,
      {
        amount: amount.currency,
        snapshot: snapshot.documentCurrency,
      },
    );
  }
  const converted = multiplyTo(
    moneyDecimal(amount),
    parseDecimal(snapshot.rate),
    currencyScale(snapshot.baseCurrency),
    mode,
  );
  return {
    amount: format(converted, currencyScale(snapshot.baseCurrency)),
    currency: snapshot.baseCurrency,
    scale: currencyScale(snapshot.baseCurrency),
  };
}
