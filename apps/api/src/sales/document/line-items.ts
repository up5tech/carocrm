import { ValidationError } from "@carocrm/core/errors/index.js";

import type { Decimal } from "../money/decimal.js";
import {
  add,
  compare,
  format,
  parseDecimal,
  subtract,
  zero,
} from "../money/decimal.js";
import type {
  LineItemInput,
  LineItemTotals,
  TaxResolutionSource,
} from "./types.js";

/**
 * Phase 19-S.6 — typed line items, shared by every commercial document (§4.4, §4.6).
 *
 * A line item is a **real record** (`QuoteItem`, `InvoiceItem`, …), not an entry in an opaque JSON
 * blob, so item-level filtering, reporting, ACL, audit and custom fields keep working. These helpers
 * are the pure half: what a requested line must look like, how a calculated line becomes a stored
 * record, and how stored records come back as inputs for a recalculation.
 *
 * Nothing here reads the database and nothing here trusts a client-submitted total: the numbers that
 * get stored are the ones the server computed.
 */

export const MAX_LINE_ITEMS = 500;

/** What a caller may send as one line. Amounts and quantities are canonical decimal strings. */
export interface RequestedLine {
  readonly productId?: string | undefined;
  readonly name?: string | undefined;
  readonly sku?: string | undefined;
  readonly unit?: string | undefined;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent?: string | undefined;
  readonly discountAmount?: string | undefined;
  readonly taxCodeId?: string | undefined;
  readonly taxRatePercent?: string | undefined;
  /**
   * The source line this one came from, set by a conversion. It is what lets a delivery order move
   * quantity against a specific order line, and therefore what makes partial fulfilment derivable
   * (§4.10).
   */
  readonly sourceItemId?: string | undefined;
}

export interface LineValidationLimits {
  /** Fraction digits accepted for a quantity (the `quantityPrecision` setting). */
  readonly quantityPrecision: number;
  readonly minItems: number;
  readonly maxItems: number;
  /**
   * A document whose lines may legitimately have no price yet (a draft quote being prepared) sets
   * this to `false`. Every issuing transition re-checks with `true`, so an unpriced line can never be
   * issued (§4.3 rule 4: a missing price is surfaced, never defaulted to zero).
   */
  readonly requireUnitPrice: boolean;
}

/**
 * Validate the requested lines of a document. Returns the lines in their given order — the caller's
 * order *is* the document order, so reordering is an explicit act rather than a side effect of
 * however the rows came back.
 */
export function validateRequestedLines(
  lines: readonly RequestedLine[],
  limits: LineValidationLimits,
): readonly RequestedLine[] {
  if (lines.length < limits.minItems) {
    throw new ValidationError(
      `A document needs at least ${String(limits.minItems)} line(s).`,
      { lines: lines.length },
    );
  }
  if (lines.length > limits.maxItems) {
    throw new ValidationError(
      `A document supports at most ${String(limits.maxItems)} lines.`,
      {
        lines: lines.length,
        max: limits.maxItems,
      },
    );
  }
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    requirePositiveQuantity(line.quantity, position, limits.quantityPrecision);
    if (
      limits.requireUnitPrice &&
      (typeof line.unitPrice !== "string" || line.unitPrice.trim() === "")
    ) {
      throw new ValidationError(`Line ${String(position)} has no unit price.`, {
        line: position,
      });
    }
    if (line.unitPrice !== undefined && line.unitPrice.trim() !== "") {
      requireNonNegative(line.unitPrice, `lines[${String(index)}].unitPrice`);
    }
    if (line.discountPercent !== undefined) {
      const percent = requireNonNegative(
        line.discountPercent,
        `lines[${String(index)}].discountPercent`,
      );
      if (compare(percent, parseDecimal("100")) > 0) {
        throw new ValidationError(
          `Line ${String(position)} has a discount above 100%.`,
          { line: position },
        );
      }
    }
    if (line.discountAmount !== undefined)
      requireNonNegative(
        line.discountAmount,
        `lines[${String(index)}].discountAmount`,
      );
    if (line.taxRatePercent !== undefined) {
      const rate = requireNonNegative(
        line.taxRatePercent,
        `lines[${String(index)}].taxRatePercent`,
      );
      if (compare(rate, parseDecimal("100")) > 0) {
        throw new ValidationError(
          `Line ${String(position)} has a tax rate above 100%.`,
          { line: position },
        );
      }
    }
  }
  return lines;
}

/** A quantity must be strictly positive and no more precise than the installation allows. */
export function requirePositiveQuantity(
  value: string,
  position: number,
  precision: number,
): void {
  const parsed = parseQuantity(value, position);
  if (compare(parsed, parseDecimal("0")) <= 0) {
    throw new ValidationError(
      `Line ${String(position)} needs a quantity greater than zero.`,
      { line: position },
    );
  }
  if (parsed.scale > precision) {
    throw new ValidationError(
      `Line ${String(position)} exceeds the configured quantity precision of ${String(precision)}.`,
      {
        line: position,
        precision,
      },
    );
  }
}

function parseQuantity(value: string, position: number): Decimal {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(
      `Line ${String(position)} is missing a quantity.`,
      { line: position },
    );
  }
  try {
    return parseDecimal(value);
  } catch {
    throw new ValidationError(
      `Line ${String(position)} has a quantity that is not a canonical decimal string.`,
      {
        line: position,
        quantity: value,
      },
    );
  }
}

function requireNonNegative(value: string, field: string): Decimal {
  const parsed = parseDecimal(value);
  if (compare(parsed, parseDecimal("0")) < 0) {
    throw new ValidationError(`"${field}" must not be negative.`, {
      field,
      value,
    });
  }
  return parsed;
}

/**
 * The stored shape of one item record. Every field a historical document needs is captured here, so
 * renaming or deactivating the product later cannot rewrite what the document says (§4.4 last
 * bullets, §5.8).
 */
export interface ItemRecordPayload extends Record<string, unknown> {
  readonly position: number;
  readonly productId: string | null;
  readonly name: string | null;
  readonly sku: string | null;
  readonly unit: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent: string | null;
  readonly discountAmount: string;
  readonly taxCodeId: string | null;
  readonly taxRatePercent: string;
  readonly taxSource: TaxResolutionSource;
  readonly taxRuleId: string | null;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
}

/** Turn one calculated line into the record an item entity stores. */
export function itemRecordPayload(
  input: LineItemInput,
  totals: LineItemTotals,
): ItemRecordPayload {
  return {
    position: totals.position,
    productId: totals.productId ?? input.productId ?? null,
    name: totals.name ?? input.name ?? null,
    sku: totals.sku ?? input.sku ?? null,
    unit: totals.unit ?? input.unit ?? null,
    quantity: totals.quantity,
    unitPrice: totals.unitPrice,
    discountPercent: input.discountPercent ?? null,
    discountAmount: totals.discountAmount,
    taxCodeId: totals.tax?.taxCodeId ?? input.taxCodeId ?? null,
    taxRatePercent: totals.tax?.taxRatePercent ?? input.taxRatePercent ?? "0",
    taxSource: totals.tax?.source ?? "none",
    taxRuleId: totals.tax?.ruleId ?? null,
    netAmount: totals.netAmount,
    taxAmount: totals.taxAmount,
    grossAmount: totals.grossAmount,
  };
}

/**
 * The same payload, built from a **stored** item plus its freshly calculated line.
 *
 * Used when a document is issued: the stored item already carries the product/name/SKU snapshots, so
 * they are carried forward unchanged and only the calculated money and tax facts are refreshed.
 */
export function itemRecordPayloadFromStored(
  item: StoredItem,
  totals: LineItemTotals,
): ItemRecordPayload {
  return {
    position: totals.position,
    productId: item.productId,
    name: item.name ?? totals.name,
    sku: item.sku ?? totals.sku,
    unit: item.unit ?? totals.unit,
    quantity: totals.quantity,
    unitPrice: totals.unitPrice,
    discountPercent: item.discountPercent,
    discountAmount: totals.discountAmount,
    taxCodeId: totals.tax?.taxCodeId ?? item.taxCodeId,
    taxRatePercent: totals.tax?.taxRatePercent ?? item.taxRatePercent ?? "0",
    taxSource: totals.tax?.source ?? "none",
    taxRuleId: totals.tax?.ruleId ?? null,
    netAmount: totals.netAmount,
    taxAmount: totals.taxAmount,
    grossAmount: totals.grossAmount,
  };
}

/** The item fields a recalculation reads back; anything else in the record is display-only. */
export interface StoredItem {
  readonly id: string;
  readonly position: number;
  readonly productId: string | null;
  readonly name: string | null;
  readonly sku: string | null;
  readonly unit: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent: string | null;
  readonly discountAmount: string;
  readonly taxCodeId: string | null;
  readonly taxRatePercent: string | null;
}

/** Ordered by `position`, so a recalculation reproduces the document's own order. */
export function orderItems(
  items: readonly StoredItem[],
): readonly StoredItem[] {
  return [...items].sort(
    (left, right) =>
      left.position - right.position ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/** Stored items back into the inputs the pricing/tax/totals engine consumes. */
export function itemsToLineInputs(
  items: readonly StoredItem[],
): readonly LineItemInput[] {
  return orderItems(items).map((item) => ({
    productId: item.productId ?? undefined,
    name: item.name ?? undefined,
    sku: item.sku ?? undefined,
    unit: item.unit ?? undefined,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    discountPercent: item.discountPercent ?? undefined,
    discountAmount:
      item.discountAmount === "0" || item.discountAmount === ""
        ? undefined
        : item.discountAmount,
    taxCodeId: item.taxCodeId ?? undefined,
    taxRatePercent: item.taxRatePercent ?? undefined,
  }));
}

/**
 * The same inputs, each carrying the id of the line it came from.
 *
 * Used by a conversion: the destination's lines point back at the source's, so a delivery order can
 * move quantity against the exact order line it fulfils and the remaining quantity is answerable.
 */
export function itemsToLineInputsWithSource(
  items: readonly StoredItem[],
): readonly RequestedLine[] {
  return orderItems(items).map((item, index) => ({
    ...(itemsToLineInputs(items)[index] as LineItemInput),
    sourceItemId: item.id,
  }));
}

/** Sum of the line quantities; the document's item count is a different number and is not derived here. */
export function totalQuantity(items: readonly StoredItem[]): string {
  let total: Decimal = zero(0);
  for (const item of orderItems(items))
    total = add(total, parseDecimal(item.quantity));
  return format(total);
}

/**
 * How much of one ordered line is still available for a further stock-moving document.
 *
 * Used by delivery orders, return orders and partial invoicing (§4.10): the result is `null` when the
 * caller already moved at least the ordered amount, which the callers report as "nothing left to
 * fulfil" rather than treating it as an error.
 */
export function remainingQuantity(
  orderedQuantity: string,
  alreadyMoved: readonly string[],
): string | null {
  let remaining = parseDecimal(orderedQuantity);
  for (const moved of alreadyMoved)
    remaining = subtract(remaining, parseDecimal(moved));
  return compare(remaining, parseDecimal("0")) <= 0 ? null : format(remaining);
}

/**
 * Validate that a stock-moving document does not exceed what the source line still allows.
 *
 * `requested` maps a source item id to the quantity this document moves; `alreadyMoved` maps the same
 * id to the quantities earlier confirmed documents already moved. Over-moving is refused with the
 * remaining amount attached — never silently clamped, because a clamp would ship a different quantity
 * than the operator confirmed.
 */
export function assertWithinRemaining(
  requested: ReadonlyMap<string, string>,
  alreadyMoved: ReadonlyMap<string, readonly string[]>,
  ordered: ReadonlyMap<string, string>,
): void {
  for (const [itemId, quantity] of requested) {
    const orderedQuantity = ordered.get(itemId);
    if (orderedQuantity === undefined) {
      throw new ValidationError(
        `Line "${itemId}" does not belong to the source document.`,
        { item: itemId },
      );
    }
    const remaining = remainingQuantity(
      orderedQuantity,
      alreadyMoved.get(itemId) ?? [],
    );
    if (remaining === null) {
      throw new ValidationError(
        "This line is already fully fulfilled; there is nothing left to move.",
        { item: itemId },
      );
    }
    if (compare(parseDecimal(quantity), parseDecimal(remaining)) > 0) {
      throw new ValidationError(
        `This line would move ${quantity}, more than the ${remaining} still outstanding.`,
        {
          item: itemId,
          requested: quantity,
          remaining,
        },
      );
    }
  }
}
