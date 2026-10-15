import { ValidationError } from "@carocrm/core/errors/index.js";

import type { Decimal } from "../money/decimal.js";
import { add, compare, format, parseDecimal, zero } from "../money/decimal.js";
import { remainingQuantity } from "./line-items.js";

/**
 * Phase 19-S.8 — how much of a sales order has been fulfilled (§4.6, §4.10).
 *
 * An order's fulfilment state is **derived**, not set by hand: it is a function of the quantities the
 * order asked for and the quantities its confirmed delivery orders have actually moved. That is the
 * only way "partially fulfilled" can be trusted — a status an operator can type is a status that can
 * be wrong.
 *
 * Pure, so the three cases can be tested without a database, a delivery order or a warehouse.
 */

export type FulfilmentState = "confirmed" | "partiallyFulfilled" | "fulfilled";

export interface FulfilmentLine {
  /** The order line's ordered quantity, canonical decimal string. */
  readonly orderedQuantity: string;
  /** Quantities of this line already moved by **confirmed** delivery orders. */
  readonly movedQuantities: readonly string[];
}

export interface FulfilmentLineSummary {
  readonly index: number;
  readonly ordered: string;
  readonly moved: string;
  /** `null` when the line is fully moved — the same convention `remainingQuantity` uses. */
  readonly remaining: string | null;
}

export interface FulfilmentSummary {
  readonly state: FulfilmentState;
  readonly lines: readonly FulfilmentLineSummary[];
  readonly fullyMovedLines: number;
  readonly totalLines: number;
}

/**
 * Summarise fulfilment.
 *
 *  - no line has moved → `confirmed` (nothing shipped yet);
 *  - every line fully moved → `fulfilled`;
 *  - anything in between → `partiallyFulfilled`.
 *
 * A line moved *beyond* its ordered quantity is a data error, not "more fulfilled": it is refused here
 * rather than silently clamped, because a clamp would hide a delivery that shipped the wrong quantity.
 */
export function fulfilmentSummary(
  lines: readonly FulfilmentLine[],
): FulfilmentSummary {
  if (lines.length === 0) {
    throw new ValidationError(
      "A sales order with no lines has no fulfilment state.",
    );
  }

  const summaries: FulfilmentLineSummary[] = [];
  let anyMoved = false;

  for (const [index, line] of lines.entries()) {
    const ordered = parseDecimal(line.orderedQuantity);
    let moved: Decimal = zero(0);
    for (const quantity of line.movedQuantities)
      moved = add(moved, parseDecimal(quantity));

    if (compare(moved, ordered) > 0) {
      throw new ValidationError(
        `Line ${String(index + 1)} has moved ${format(moved)} against an ordered quantity of ${line.orderedQuantity}.`,
        {
          line: index + 1,
          ordered: line.orderedQuantity,
          moved: format(moved),
        },
      );
    }
    if (compare(moved, zero(0)) > 0) anyMoved = true;
    summaries.push({
      index,
      ordered: line.orderedQuantity,
      moved: format(moved),
      remaining: remainingQuantity(line.orderedQuantity, line.movedQuantities),
    });
  }

  const fullyMovedLines = summaries.filter(
    (line) => line.remaining === null,
  ).length;
  const state: FulfilmentState =
    fullyMovedLines === summaries.length
      ? "fulfilled"
      : anyMoved
        ? "partiallyFulfilled"
        : "confirmed";

  return {
    state,
    lines: summaries,
    fullyMovedLines,
    totalLines: summaries.length,
  };
}

/**
 * Whether a fulfilment transition is allowed from the order's current state.
 *
 * An order that is `fulfilled` never goes back to `partiallyFulfilled`: a return is a new document, not
 * a silent un-shipment (§4.10 "a cancelled/voided source document does not simply delete a stock
 * movement; use a compensating transaction").
 */
export function fulfilmentTransitionRefusal(
  current: string,
  next: FulfilmentState,
): string | null {
  if (current === next) return null;
  if (current === "fulfilled") {
    return "This order is already fulfilled; a return is recorded as a return order, not by changing the order.";
  }
  if (current === "cancelled") {
    return "A cancelled order has no fulfilment state.";
  }
  if (current === "draft") {
    return "An order must be confirmed before it can be fulfilled.";
  }
  return null;
}
