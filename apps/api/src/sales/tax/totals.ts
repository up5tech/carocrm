import { ValidationError } from "@carocrm/core/errors/index.js";

import type {
  LineItemInput,
  LineItemTotals,
  TaxBreakdownRow,
  TaxLineResolution,
  TaxResolutionSource,
} from "../document/types.js";
import type { ExchangeRateInput, Money } from "../money/currency.js";
import {
  currencyScale,
  normalizeCurrencyCode,
  toBaseCurrency,
  validateExchangeRateSnapshot,
} from "../money/currency.js";
import type { Decimal, RoundingMode } from "../money/decimal.js";
import {
  add,
  compare,
  divideTo,
  format,
  isNegative,
  multiply,
  netFromInclusive,
  parseDecimal,
  rescale,
  subtract,
  sum,
  zero,
} from "../money/decimal.js";

/**
 * Phase 19-S.5 — the customer/document totals engine (PLAN_Phase_19_Sales.md §4.12, §5.7).
 *
 * Pure calculation: it receives resolved tax facts per line and returns the document numbers. It
 * never reads the database, never sends mail and never trusts a client-submitted total — the server
 * recomputes every number from the inputs (§5.7 last bullet).
 *
 * Rounding stages, stated once:
 *
 *  - **line** (default): each line's discount, net and tax are rounded to the currency scale, and
 *    the document totals are the sums of those rounded values. Line arithmetic reconciles exactly
 *    (`net + tax = gross`) and the sum of lines equals the document totals.
 *  - **document**: line values are computed exactly and only the document aggregates (subtotal,
 *    per-rate tax, totals) are rounded. Per-line values in the result are reported at the currency
 *    scale for display, and their sum may differ from the rounded document total by less than one
 *    minor unit — the documented trade-off of this stage.
 *
 * Discounts: a line carries a percentage and/or a fixed discount, applied to the line amount before
 * tax. A document-level discount is distributed across lines **pro rata by net amount** with a
 * largest-remainder allocation, so the distributed parts always sum to exactly the requested amount
 * at the currency scale.
 */

export const MAX_TOTALS_LINES = 500;

export type RoundingStage = "line" | "document";

export interface TotalsRounding {
  readonly mode: RoundingMode;
  readonly stage: RoundingStage;
}

export interface TotalsLine extends LineItemInput {
  /** Resolved tax for this line; `null` is a gap the caller must have a policy for. */
  readonly tax: TaxLineResolution | null;
}

export interface TotalsShipping {
  readonly amount: string;
  readonly tax: TaxLineResolution | null;
}

export interface TotalsInput {
  readonly currency: string;
  readonly taxInclusive: boolean;
  readonly rounding: TotalsRounding;
  readonly quantityPrecision: number;
  /** `error` refuses a line without tax; `zero` records an explicit zero-tax resolution instead. */
  readonly missingTaxPolicy: "error" | "zero";
  readonly lines: readonly TotalsLine[];
  readonly shipping?: TotalsShipping | undefined;
  /** Absolute discount on the whole document, canonical decimal string. */
  readonly documentDiscountAmount?: string | undefined;
  /** Optional exchange-rate snapshot; when present the base-currency total is computed too. */
  readonly exchangeRate?: ExchangeRateInput | undefined;
}

export interface TotalsResult {
  readonly currency: string;
  readonly lines: readonly LineItemTotals[];
  /** Sum of the lines' amounts before line discounts and before document discount (tax-exclusive when exclusive pricing). */
  readonly subtotal: string;
  /** Line discounts + the document discount. */
  readonly discountTotal: string;
  readonly shippingAmount: string;
  readonly shippingTaxAmount: string;
  readonly taxBreakdown: readonly TaxBreakdownRow[];
  readonly taxTotal: string;
  /** Taxable base after all discounts, excluding tax. */
  readonly netTotal: string;
  /** Payable total including tax. */
  readonly grossTotal: string;
  /** Gross total minus allocations; a document that has just been calculated has no allocations. */
  readonly amountDue: string;
  readonly baseCurrency: string | null;
  readonly exchangeRate: string | null;
  readonly baseGrossTotal: string | null;
  readonly rounding: TotalsRounding;
  readonly taxInclusive: boolean;
  /** Non-fatal notes (for example an explicit zero tax where no rule matched). */
  readonly warnings: readonly string[];
}

interface ComputedLine {
  readonly input: TotalsLine;
  readonly effectiveTax: TaxLineResolution | null;
  readonly position: number;
  readonly amountExact: Decimal;
  readonly discountExact: Decimal;
  readonly documentDiscountExact: Decimal;
  readonly netExact: Decimal;
  readonly taxExact: Decimal;
  readonly grossExact: Decimal;
  readonly ratePercent: string;
  readonly multipliedRate: Decimal;
}

export function computeTotals(input: TotalsInput): TotalsResult {
  const currency = normalizeCurrencyCode(input.currency);
  const scale = currencyScale(currency);
  const mode = input.rounding.mode;
  const lines = input.lines;
  if (lines.length === 0) {
    throw new ValidationError("A document needs at least one line.");
  }
  if (lines.length > MAX_TOTALS_LINES) {
    throw new ValidationError(
      `A document supports at most ${MAX_TOTALS_LINES} lines.`,
      { lines: lines.length },
    );
  }
  const warnings: string[] = [];

  const computed: ComputedLine[] = lines.map((line, index) =>
    computeLine(line, index, input, currency, warnings),
  );
  const documentDiscount =
    input.documentDiscountAmount === undefined
      ? zero()
      : requireAmount(input.documentDiscountAmount, "documentDiscountAmount");
  const distributed = distributeDocumentDiscount(
    computed.map((line) => line.netExact),
    documentDiscount,
    computed.map((line) => line.documentDiscountExact),
    scale,
  );
  const withDiscount = computed.map((line, index) => {
    const extra = distributed[index] ?? zero();
    const net = subtract(line.netExact, extra);
    if (isNegative(net)) {
      throw new ValidationError(
        "The document discount would make a line negative.",
        { line: index + 1 },
      );
    }
    const tax = taxOnNet(net, line.multipliedRate, false);
    return {
      ...line,
      documentDiscountExact: extra,
      netExact: net,
      taxExact: tax,
      grossExact: add(net, tax),
    };
  });

  const stage = input.rounding.stage;
  const roundAt = (value: Decimal): Decimal =>
    stage === "line" ? rescale(value, scale, mode) : value;

  const lineTotals: LineItemTotals[] = withDiscount.map((line) =>
    toLineTotals(line, roundAt, scale),
  );
  const subtotal = sum(withDiscount.map((line) => roundAt(line.amountExact)));
  const discountTotal = sum(
    withDiscount.map((line) =>
      add(roundAt(line.discountExact), roundAt(line.documentDiscountExact)),
    ),
  );

  const shippingAmountExact =
    input.shipping === undefined
      ? zero()
      : requireAmount(input.shipping.amount, "shipping.amount");
  const shippingRate = input.shipping?.tax ?? null;
  const shippingResolution = resolveShippingTax(
    shippingRate,
    input.missingTaxPolicy,
    warnings,
  );
  const shippingScale = currencyScale(currency);
  const shippingNetExact =
    input.shipping === undefined
      ? zero()
      : input.taxInclusive
        ? netFromInclusive(
            shippingAmountExact,
            parseDecimal(shippingResolution.taxRatePercent),
            shippingScale,
            mode,
          )
        : shippingAmountExact;
  const shippingTaxExact =
    input.shipping === undefined
      ? zero()
      : taxOnNet(
          shippingNetExact,
          parseDecimal(shippingResolution.taxRatePercent),
          false,
        );
  const shippingAmount =
    stage === "line"
      ? rescale(shippingNetExact, scale, mode)
      : shippingNetExact;
  const shippingTaxAmount =
    stage === "line"
      ? rescale(shippingTaxExact, scale, mode)
      : shippingTaxExact;

  const taxRows = new Map<
    string,
    {
      taxCodeId: string | null;
      taxCodeName: string | null;
      ratePercent: string;
      base: Decimal;
      tax: Decimal;
    }
  >();
  for (const line of withDiscount) {
    const key = `${line.input.tax?.taxCodeId ?? "none"}|${line.ratePercent}`;
    const existing = taxRows.get(key);
    const base = roundAt(line.netExact);
    const tax = roundAt(line.taxExact);
    if (existing === undefined) {
      taxRows.set(key, {
        taxCodeId: line.effectiveTax?.taxCodeId ?? null,
        taxCodeName: line.effectiveTax?.taxCodeName ?? null,
        ratePercent: line.ratePercent,
        base,
        tax,
      });
    } else {
      existing.base = add(existing.base, base);
      existing.tax = add(existing.tax, tax);
    }
  }
  if (input.shipping !== undefined) {
    const key = `${shippingResolution.taxCodeId ?? "none"}|${shippingResolution.taxRatePercent}`;
    const existing = taxRows.get(key);
    if (existing === undefined) {
      taxRows.set(key, {
        taxCodeId: shippingResolution.taxCodeId,
        taxCodeName: shippingResolution.taxCodeName,
        ratePercent: shippingResolution.taxRatePercent,
        base: shippingAmount,
        tax: shippingTaxAmount,
      });
    } else {
      existing.base = add(existing.base, shippingAmount);
      existing.tax = add(existing.tax, shippingTaxAmount);
    }
  }

  const taxBreakdown: TaxBreakdownRow[] = [...taxRows.values()].map((row) => ({
    taxCodeId: row.taxCodeId,
    taxCodeName: row.taxCodeName,
    taxRatePercent: row.ratePercent,
    taxableBase: moneyString(roundAt(row.base), scale),
    taxAmount: moneyString(roundAt(row.tax), scale),
  }));

  const lineNetTotal = sum(withDiscount.map((line) => roundAt(line.netExact)));
  const netTotal = add(lineNetTotal, shippingAmount);
  const taxTotal = add(
    sum(taxBreakdown.map((row) => parseDecimal(row.taxAmount))),
    zero(),
  );
  const grossTotal = add(netTotal, taxTotal);

  const snapshot =
    input.exchangeRate === undefined
      ? null
      : validateExchangeRateSnapshot(input.exchangeRate);
  let baseGrossTotal: string | null = null;
  if (snapshot !== null) {
    if (snapshot.documentCurrency !== currency) {
      throw new ValidationError(
        `The exchange-rate snapshot converts ${snapshot.documentCurrency}, not ${currency}.`,
        {
          snapshot: snapshot.documentCurrency,
          currency,
        },
      );
    }
    const gross: Money = {
      amount: moneyString(rescale(grossTotal, scale, mode), scale),
      currency,
      scale,
    };
    baseGrossTotal = toBaseCurrency(gross, snapshot, mode).amount;
  }

  return {
    currency,
    lines: lineTotals,
    subtotal: moneyString(rescale(subtotal, scale, mode), scale),
    discountTotal: moneyString(rescale(discountTotal, scale, mode), scale),
    shippingAmount: moneyString(rescale(shippingAmount, scale, mode), scale),
    shippingTaxAmount: moneyString(
      rescale(shippingTaxAmount, scale, mode),
      scale,
    ),
    taxBreakdown,
    taxTotal: moneyString(rescale(taxTotal, scale, mode), scale),
    netTotal: moneyString(rescale(netTotal, scale, mode), scale),
    grossTotal: moneyString(rescale(grossTotal, scale, mode), scale),
    amountDue: moneyString(rescale(grossTotal, scale, mode), scale),
    baseCurrency: snapshot?.baseCurrency ?? null,
    exchangeRate: snapshot?.rate ?? null,
    baseGrossTotal,
    rounding: input.rounding,
    taxInclusive: input.taxInclusive,
    warnings,
  };
}

function computeLine(
  line: TotalsLine,
  index: number,
  input: TotalsInput,
  currency: string,
  warnings: string[],
): ComputedLine {
  const position = index + 1;
  const quantity = requirePositiveQuantity(
    line.quantity,
    position,
    input.quantityPrecision,
  );
  if (line.unitPrice === undefined || line.unitPrice.trim() === "") {
    throw new ValidationError(`Line ${position} has no unit price.`, {
      line: position,
    });
  }
  const unitPrice = requireAmount(line.unitPrice, `lines[${index}].unitPrice`);
  const amountExact = multiply(quantity, unitPrice);

  let discountExact = zero();
  if (line.discountPercent !== undefined) {
    const percent = requireAmount(
      line.discountPercent,
      `lines[${index}].discountPercent`,
    );
    if (compare(percent, parseDecimal("100")) > 0) {
      throw new ValidationError(`Line ${position} has a discount above 100%.`, {
        line: position,
      });
    }
    discountExact = divideTo(
      multiply(amountExact, percent),
      parseDecimal("100"),
      12,
      "half-up",
    );
  }
  if (line.discountAmount !== undefined) {
    discountExact = add(
      discountExact,
      requireAmount(line.discountAmount, `lines[${index}].discountAmount`),
    );
  }
  const amountAfterDiscount = subtract(amountExact, discountExact);
  if (isNegative(amountAfterDiscount)) {
    throw new ValidationError(`Line ${position} is discounted below zero.`, {
      line: position,
    });
  }

  const effectiveTax = effectiveTaxResolution(
    line.tax,
    input.missingTaxPolicy,
    position,
    warnings,
  );
  const ratePercent = effectiveTax?.taxRatePercent ?? "0";
  const multipliedRate = parseDecimal(ratePercent);
  const scale = currencyScale(currency);
  const netExact = input.taxInclusive
    ? netFromInclusive(
        amountAfterDiscount,
        multipliedRate,
        scale,
        input.rounding.mode,
      )
    : amountAfterDiscount;
  const taxExact = taxOnNet(netExact, multipliedRate, false);

  return {
    input: line,
    effectiveTax,
    position,
    amountExact,
    discountExact,
    documentDiscountExact: zero(),
    netExact,
    taxExact,
    grossExact: add(netExact, taxExact),
    ratePercent,
    multipliedRate,
  };
}

/**
 * Tax on a tax-exclusive base, exactly as `base × rate / 100` (rounded later, at the chosen stage).
 * `taxExclusive` means the base does not include tax; inclusive arithmetic happens in the caller.
 */
export function taxOnNet(
  net: Decimal,
  ratePercent: Decimal,
  taxExclusive: boolean,
): Decimal {
  if (taxExclusive) {
    throw new ValidationError(
      "taxOnNet receives a tax-exclusive base; inclusive pricing is resolved by the caller.",
    );
  }
  return divideTo(
    multiply(net, ratePercent),
    parseDecimal("100"),
    12,
    "half-up",
  );
}

/**
 * A line without a resolved tax is a policy decision, not a default: `error` refuses it, `zero`
 * records an explicit zero-tax resolution the document can show (§4.12).
 */
function effectiveTaxResolution(
  tax: TaxLineResolution | null,
  policy: "error" | "zero",
  position: number,
  warnings: string[],
): TaxLineResolution | null {
  if (tax === null) {
    if (policy === "error") {
      throw new ValidationError(
        `Line ${position} has no applicable tax rate.`,
        { line: position, policy },
      );
    }
    warnings.push(
      `Line ${position} has no applicable tax rate; the configured policy recorded zero tax.`,
    );
    return zeroResolution();
  }
  const rate = parseDecimal(tax.taxRatePercent);
  if (isNegative(rate)) {
    throw new ValidationError(`Line ${position} has a negative tax rate.`, {
      line: position,
    });
  }
  return tax;
}

function resolveShippingTax(
  tax: TaxLineResolution | null,
  policy: "error" | "zero",
  warnings: string[],
): TaxLineResolution {
  if (tax !== null) return tax;
  if (policy === "error") {
    throw new ValidationError(
      "Shipping has no applicable tax code; disable shipping tax or configure one.",
      { policy },
    );
  }
  warnings.push(
    "Shipping has no applicable tax rate; the configured policy recorded zero tax.",
  );
  return zeroResolution();
}

function zeroResolution(): TaxLineResolution {
  return {
    taxCodeId: null,
    taxCodeName: null,
    taxRatePercent: "0",
    source: "zero" satisfies TaxResolutionSource,
    ruleId: null,
  };
}

function toLineTotals(
  line: ComputedLine,
  roundAt: (value: Decimal) => Decimal,
  scale: number,
): LineItemTotals {
  const net = roundAt(line.netExact);
  const tax = roundAt(line.taxExact);
  return {
    position: line.position,
    productId: line.input.productId ?? null,
    name: line.input.name ?? null,
    sku: line.input.sku ?? null,
    unit: line.input.unit ?? null,
    quantity: line.input.quantity,
    unitPrice: line.input.unitPrice,
    discountAmount: moneyString(
      roundAt(add(line.discountExact, line.documentDiscountExact)),
      scale,
    ),
    netAmount: moneyString(net, scale),
    taxAmount: moneyString(tax, scale),
    grossAmount: moneyString(add(net, tax), scale),
    tax: line.effectiveTax,
  };
}

/**
 * Distribute a document discount across lines pro rata by net amount, exact to the minor unit.
 *
 * Largest-remainder: each line gets the floor of its share; the lines with the largest fractional
 * remainders (ties by lower line index) receive the leftover minor units. The allocation is a pure
 * function of the inputs, so the same document always distributes the same way.
 */
export function distributeDocumentDiscount(
  nets: readonly Decimal[],
  totalDiscount: Decimal,
  existing: readonly Decimal[],
  scale: number,
): readonly Decimal[] {
  const count = nets.length;
  const allocated: Decimal[] = nets.map(() => zero(scale));
  if (count === 0 || compare(totalDiscount, zero()) === 0) return allocated;
  const targetUnits = rescale(totalDiscount, scale, "half-up").units;
  if (targetUnits < 0n) {
    throw new ValidationError("A document discount must not be negative.", {
      amount: format(totalDiscount),
    });
  }
  const baseUnits = nets.map((net) => rescale(net, scale, "half-up").units);
  const baseTotal = baseUnits.reduce((total, value) => total + value, 0n);
  if (baseTotal <= 0n) {
    throw new ValidationError(
      "A document discount needs at least one line with a positive amount.",
    );
  }
  if (targetUnits > baseTotal) {
    throw new ValidationError(
      "The document discount exceeds the document amount.",
      { amount: format(totalDiscount) },
    );
  }
  let distributed = 0n;
  const fractions: { index: number; remainder: bigint }[] = [];
  for (let index = 0; index < count; index++) {
    const base = baseUnits[index] ?? 0n;
    const exact = base * targetUnits;
    const share = exact / baseTotal;
    fractions.push({ index, remainder: exact % baseTotal });
    allocated[index] = { units: share, scale };
    distributed += share;
  }
  let leftover = targetUnits - distributed;
  fractions.sort((left, right) =>
    right.remainder === left.remainder
      ? left.index - right.index
      : right.remainder > left.remainder
        ? 1
        : -1,
  );
  for (const entry of fractions) {
    if (leftover <= 0n) break;
    const current = allocated[entry.index];
    if (current === undefined) continue;
    const next = existing[entry.index] ?? zero(scale);
    // A line can never receive more discount than its net amount (plus what it already carries).
    const capacity = baseUnits[entry.index] ?? 0n;
    if (current.units + next.units >= capacity) continue;
    allocated[entry.index] = { units: current.units + 1n, scale };
    leftover -= 1n;
  }
  return allocated;
}

export function requireAmount(value: string, field: string): Decimal {
  const parsed = parseDecimal(value);
  if (isNegative(parsed)) {
    throw new ValidationError(`"${field}" must not be negative.`, {
      field,
      value,
    });
  }
  return parsed;
}

export function requirePositiveQuantity(
  value: string,
  position: number,
  precision: number,
): Decimal {
  const parsed = parseDecimal(value);
  if (compare(parsed, zero()) <= 0) {
    throw new ValidationError(
      `Line ${position} needs a quantity greater than zero.`,
      { line: position },
    );
  }
  if (parsed.scale > precision) {
    throw new ValidationError(
      `Line ${position} exceeds the configured quantity precision of ${precision}.`,
      { line: position, precision },
    );
  }
  return parsed;
}

export function moneyString(value: Decimal, scale: number): string {
  return format(rescale(value, scale, "half-up"), scale);
}
