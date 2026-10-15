import { ValidationError } from "@carocrm/core/errors/index.js";

/**
 * Phase 19-S.2 — exact decimal arithmetic for commercial documents.
 *
 * The kernel has no decimal library: `numeric` JSON attributes are only cast to `numeric` inside
 * query expressions (`entity-record.store.ts` `attrCast`), and JavaScript `number` arithmetic is
 * binary floating point. Money must never travel through it (PLAN_Phase_19_Sales.md §5.7), so the
 * Sales module carries its own exact representation:
 *
 *   value = units / 10^scale      (`units` is a `bigint`, `scale` a non-negative integer)
 *
 * Every operation is defined on that integer pair, so addition and multiplication are exact and the
 * only inexact step is an explicit division (percentage, inclusive-tax split, currency conversion),
 * which always names a rounding mode. Canonical decimal **strings** are the only accepted input and
 * the only output — never a `number`.
 */

/** How a value that does not fall exactly on the target scale is rounded. */
export type RoundingMode = "half-up" | "half-even" | "floor" | "ceil";

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "half-up",
  "half-even",
  "floor",
  "ceil",
];

/** Largest supported scale (rates use 4, quantities 6, money 0–3). */
export const MAX_DECIMAL_SCALE = 12;

/** Reject absurd magnitudes before they reach `bigint` arithmetic or the database. */
export const MAX_DECIMAL_DIGITS = 28;

/** An exact decimal: `units / 10^scale`. `units` is signed; `scale` is never negative. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const CANONICAL_PATTERN = /^-?\d+(\.\d+)?$/;

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new ValidationError(
      `Decimal scale must be an integer between 0 and ${MAX_DECIMAL_SCALE}.`,
      { scale },
    );
  }
}

function assertUnits(units: bigint): void {
  const digits = (units < 0n ? -units : units).toString().length;
  if (digits > MAX_DECIMAL_DIGITS) {
    throw new ValidationError(
      `Decimal magnitude exceeds ${MAX_DECIMAL_DIGITS} digits.`,
    );
  }
}

const TEN = 10n;

/** Internal power used by exact arithmetic; intermediates may exceed the public scale limit. */
const INTERNAL_MAX_EXPONENT = 60;

function tenPow(exponent: number): bigint {
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > INTERNAL_MAX_EXPONENT
  ) {
    throw new ValidationError(
      `Decimal exponent must be between 0 and ${INTERNAL_MAX_EXPONENT}.`,
      { exponent },
    );
  }
  return TEN ** BigInt(exponent);
}

/** Public power at the supported scale, for callers that scale values themselves. */
export function pow10(exponent: number): bigint {
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > MAX_DECIMAL_SCALE
  ) {
    throw new ValidationError(
      `Decimal exponent must be between 0 and ${MAX_DECIMAL_SCALE}.`,
      { exponent },
    );
  }
  return TEN ** BigInt(exponent);
}

/**
 * Parse a canonical decimal string. Exponent notation, thousands separators, leading `+`, `NaN`
 * and Infinity are all refused — the caller must send the exact value it means.
 */
export function parseDecimal(input: string): Decimal {
  if (typeof input !== "string") {
    throw new ValidationError("A decimal value must be a string.", {
      value: String(input),
    });
  }
  const text = input.trim();
  if (text === "" || !CANONICAL_PATTERN.test(text)) {
    throw new ValidationError(`"${input}" is not a canonical decimal value.`, {
      value: input,
    });
  }
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);
  if (fraction.length > MAX_DECIMAL_SCALE) {
    throw new ValidationError(
      `A decimal value supports at most ${MAX_DECIMAL_SCALE} fraction digits.`,
      { value: input },
    );
  }
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS + MAX_DECIMAL_SCALE) {
    throw new ValidationError(
      `Decimal magnitude exceeds ${MAX_DECIMAL_DIGITS} digits.`,
      { value: input },
    );
  }
  const units =
    BigInt(`${whole}${fraction}`) *
    (negative && (whole !== "0" || /[1-9]/.test(fraction)) ? -1n : 1n);
  return { units, scale: fraction.length };
}

/** Integer to exact decimal at scale 0. */
export function decimalFromInteger(value: number | bigint): Decimal {
  const big = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  assertUnits(big);
  return { units: big, scale: 0 };
}

export function zero(scale = 0): Decimal {
  assertScale(scale);
  return { units: 0n, scale };
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function isNegative(value: Decimal): boolean {
  return value.units < 0n;
}

export function negate(value: Decimal): Decimal {
  return { units: -value.units, scale: value.scale };
}

export function abs(value: Decimal): Decimal {
  return value.units < 0n ? negate(value) : value;
}

/** Compare two exact decimals. Returns -1, 0 or 1. Exact: no rounding is involved. */
export function compare(left: Decimal, right: Decimal): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const a = left.units * tenPow(scale - left.scale);
  const b = right.units * tenPow(scale - right.scale);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Change the scale of an exact value.
 *
 * Going up is exact (multiply the integer). Going down divides and applies `mode`; the caller
 * chooses the mode per rounding stage, so the same input always produces the same output
 * (PLAN_Phase_19_Sales.md §4.12 "deterministic and explainable").
 */
export function rescale(
  value: Decimal,
  targetScale: number,
  mode: RoundingMode,
): Decimal {
  assertScale(targetScale);
  if (value.scale === targetScale) return value;
  if (targetScale > value.scale) {
    return {
      units: value.units * tenPow(targetScale - value.scale),
      scale: targetScale,
    };
  }
  return {
    units: divideRounded(value.units, tenPow(value.scale - targetScale), mode),
    scale: targetScale,
  };
}

export function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const units =
    left.units * tenPow(scale - left.scale) +
    right.units * tenPow(scale - right.scale);
  assertUnits(units);
  return { units, scale };
}

export function subtract(left: Decimal, right: Decimal): Decimal {
  return add(left, negate(right));
}

/** Sum an exact list; an empty list is zero at scale 0. */
export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((total, value) => add(total, value), zero());
}

/** Exact product. The result scale is the sum of both scales (no rounding). */
export function multiply(left: Decimal, right: Decimal): Decimal {
  const units = left.units * right.units;
  assertUnits(units);
  return { units, scale: left.scale + right.scale };
}

/**
 * Exact product rounded once to `targetScale` — the shape every money calculation wants:
 * `quantity × unitPrice`, `amount × rate`, `base × (1 + tax)`. Rounding exactly once, after the
 * exact product, is what keeps totals reproducible.
 */
export function multiplyTo(
  left: Decimal,
  right: Decimal,
  targetScale: number,
  mode: RoundingMode,
): Decimal {
  return rescale(multiply(left, right), targetScale, mode);
}

/** `value × percent / 100`, rounded once to `targetScale`. `percent` is exact (e.g. `"12.5"`). */
export function percentageOf(
  value: Decimal,
  percent: Decimal,
  targetScale: number,
  mode: RoundingMode,
): Decimal {
  const product = multiply(value, percent);
  return rescale(
    { units: product.units, scale: product.scale + 2 },
    targetScale,
    mode,
  );
}

/**
 * `value / divisor` at the requested scale, with **one** rounding step. Division by zero is a
 * validation error. The intermediate is exact by construction:
 * `(units / 10^scale) / (units2 / 10^scale2) = (units × 10^scale2) / (units2 × 10^scale)`.
 */
export function divideTo(
  value: Decimal,
  divisor: Decimal,
  targetScale: number,
  mode: RoundingMode,
): Decimal {
  assertScale(targetScale);
  if (isZero(divisor)) {
    throw new ValidationError("Division by zero in a decimal calculation.");
  }
  const numerator = value.units * tenPow(divisor.scale + targetScale);
  const denominator = divisor.units * tenPow(value.scale);
  return {
    units: divideRounded(numerator, denominator, mode),
    scale: targetScale,
  };
}

/** Unit price paid for an inclusive amount: `gross × 100 / (100 + rate)`. */
export function netFromInclusive(
  gross: Decimal,
  ratePercent: Decimal,
  targetScale: number,
  mode: RoundingMode,
): Decimal {
  const hundred = decimalFromInteger(100);
  const denominator = add(hundred, ratePercent);
  if (compare(denominator, zero()) <= 0) {
    throw new ValidationError(
      "An inclusive tax rate must be greater than -100%.",
      { ratePercent: format(ratePercent) },
    );
  }
  // gross × 100 keeps the exact representation: multiplying by 100 adds two integer digits, not scale.
  return divideTo(multiply(gross, hundred), denominator, targetScale, mode);
}

/** Smallest / largest of an exact list; an empty list is `undefined`. */
export function minOf(values: readonly Decimal[]): Decimal | undefined {
  return values.reduce<Decimal | undefined>(
    (smallest, value) =>
      smallest === undefined || compare(value, smallest) < 0 ? value : smallest,
    undefined,
  );
}

export function maxOf(values: readonly Decimal[]): Decimal | undefined {
  return values.reduce<Decimal | undefined>(
    (largest, value) =>
      largest === undefined || compare(value, largest) > 0 ? value : largest,
    undefined,
  );
}

/**
 * Canonical decimal string.
 *
 * Without `scale` the trailing fraction zeros are trimmed (`1.500` → `1.5`, `2.00` → `2`). Money at
 * an API boundary always names its scale (`format(value, currencyScale)`), so an amount string is
 * `"10.00"` and never `"10"` — the two are the same number but only one is a stable contract.
 */
export function format(value: Decimal, scale?: number): string {
  assertScale(scale ?? value.scale);
  const target = scale ?? value.scale;
  if (scale !== undefined && scale < value.scale) {
    // Formatting never rounds: an amount is rounded at a named calculation stage, then formatted.
    throw new ValidationError(
      `Cannot format a value with scale ${value.scale} at scale ${scale}; round it first.`,
    );
  }
  const scaled = scale === undefined ? value : rescale(value, scale, "half-up");
  const negative = scaled.units < 0n;
  const digits = (negative ? -scaled.units : scaled.units)
    .toString()
    .padStart(target + 1, "0");
  const whole = digits
    .slice(0, digits.length - target)
    .replace(/^0+(?=\d)/, "");
  const rawFraction = target === 0 ? "" : digits.slice(digits.length - target);
  // Without an explicit scale the result is the canonical *shortest* form, so equal values format
  // to equal strings; with a scale the caller asked for that many digits and keeps them.
  const fraction =
    scale === undefined ? rawFraction.replace(/0+$/, "") : rawFraction;
  const signed =
    negative && (whole !== "0" || /[1-9]/.test(fraction)) ? `-${whole}` : whole;
  return fraction === "" ? signed : `${signed}.${fraction}`;
}

/**
 * Round `numerator / denominator` to an integer with the named mode.
 * `remainder` keeps the sign of the numerator, which is how `floor`/`ceil` know their direction.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n)
    throw new ValidationError("Division by zero in a decimal calculation.");
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let magnitude = quotient;
  switch (mode) {
    case "floor":
      if (negative) magnitude += 1n;
      break;
    case "ceil":
      if (!negative) magnitude += 1n;
      break;
    case "half-up":
      if (remainder * 2n >= absDenominator) magnitude += 1n;
      break;
    case "half-even": {
      const twice = remainder * 2n;
      if (twice > absDenominator) magnitude += 1n;
      else if (twice === absDenominator && magnitude % 2n === 1n)
        magnitude += 1n;
      break;
    }
    default: {
      const exhaustive: never = mode;
      throw new ValidationError(
        `Unsupported rounding mode "${String(exhaustive)}".`,
      );
    }
  }
  return negative ? -magnitude : magnitude;
}
