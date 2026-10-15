import { ValidationError } from "@carocrm/core/errors/index.js";

/**
 * Phase 19-S.13 — the purchasing twin of `fulfilment.ts`.
 *
 * A purchase order's receipt state is *derived* from its confirmed receipt orders, exactly the way a
 * sales order's fulfilment state is derived from its confirmed delivery orders (§4.12): "partially
 * received" is a function of what was ordered and what actually arrived, not a status somebody types.
 * Keeping the rule here — a pure function of the numbers — is what lets the engine be idempotent
 * (a second run computes the same state, writes nothing, emits nothing) and testable without a
 * database.
 *
 * The mirror is deliberate but not identical: a purchase order can also be **cancelled**, which is
 * a terminal state no refresh may leave, and a **draft** has no receipt state yet.
 */

export type ReceiptState = "confirmed" | "partiallyReceived" | "received";

export interface ReceiptSummary {
  readonly state: ReceiptState;
  readonly totalLines: number;
  readonly fullyReceivedLines: number;
  /** Lines that have had some, but not all, of their ordered quantity received. */
  readonly partiallyReceivedLines: number;
  readonly unreceivedLines: number;
  /** Lines whose received quantity would exceed what was ordered. Never true for validated input. */
  readonly overReceived: boolean;
}

/** The derived receipt state of one line, from what was ordered and what arrived. */
export type LineReceiptState =
  | "unreceived"
  | "partiallyReceived"
  | "fullyReceived"
  | "overReceived";

/** What one line of a purchase order contributes to the summary. */
export interface ReceiptLineInput {
  readonly orderedQuantity: string;
  readonly receivedQuantities: readonly string[];
}

/**
 * Classify one line, refusing a received quantity above the ordered quantity rather than clamping.
 *
 * A clamp would receive a different quantity than the operator confirmed, which is the same refusal
 * `assertWithinRemaining` makes (19-S.12) — it lives here because the numbers arrive here first.
 */
export function lineReceiptState(
  orderedQuantity: string,
  receivedQuantities: readonly string[],
): LineReceiptState {
  const ordered = Number.parseFloat(orderedQuantity);
  if (!Number.isFinite(ordered))
    throw new ValidationError(
      `"${orderedQuantity}" is not a quantity a receipt can be measured against.`,
      { quantity: orderedQuantity },
    );
  let received = 0;
  for (const quantity of receivedQuantities) {
    const parsed = Number.parseFloat(quantity);
    if (!Number.isFinite(parsed))
      throw new ValidationError(
        `"${quantity}" is not a canonical decimal quantity.`,
        { quantity },
      );
    received += parsed;
  }
  if (received > ordered + Number.EPSILON) return "overReceived";
  if (received <= Number.EPSILON) return "unreceived";
  if (received >= ordered - Number.EPSILON) return "fullyReceived";
  return "partiallyReceived";
}

/** The receipt state of a whole purchase order from its lines. */
export function receiptSummary(
  lines: readonly ReceiptLineInput[],
): ReceiptSummary {
  const states = lines.map((line) =>
    lineReceiptState(line.orderedQuantity, line.receivedQuantities),
  );
  const count = (state: LineReceiptState): number =>
    states.filter((each) => each === state).length;
  const overReceived = count("overReceived");
  if (overReceived > 0)
    throw new ValidationError(
      `${String(overReceived)} line(s) of this purchase order have been received for more than they ordered.`,
      { lines: overReceived },
    );
  const totalLines = lines.length;
  const fullyReceived = count("fullyReceived");
  const partiallyReceived = count("partiallyReceived");
  const unreceived = count("unreceived");
  const state: ReceiptState =
    unreceived === totalLines
      ? "confirmed"
      : fullyReceived === totalLines
        ? "received"
        : "partiallyReceived";
  return {
    state,
    totalLines,
    fullyReceivedLines: fullyReceived,
    partiallyReceivedLines: partiallyReceived,
    unreceivedLines: unreceived,
    overReceived: false,
  };
}

const RECEIPT_STATES: readonly ReceiptState[] = [
  "confirmed",
  "partiallyReceived",
  "received",
];

/**
 * Whether a purchase order may move to `next`.
 *
 * `received` is terminal: the order is what it says it is, and a later correction is a new document
 * or a credit, never a quiet rewind (§4.9). `confirmed` is where an order with nothing received
 * sits, so an order that had a partial receipt cannot go back to it — the receipt stays on record.
 */
export function receiptTransitionRefusal(
  current: string,
  next: string,
): string | null {
  if (current === next) return null;
  if (!RECEIPT_STATES.includes(next as ReceiptState))
    return `A purchase order has no receipt state "${next}".`;
  if (current === "received")
    return `A fully received purchase order stays received; correct it with a credit note or a new order.`;
  if (current === "partiallyReceived" && next === "confirmed")
    return `A purchase order with a partial receipt cannot go back to confirmed; the receipt stays on record.`;
  return null;
}
