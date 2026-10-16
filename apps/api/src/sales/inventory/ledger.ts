import { ValidationError } from "@carocrm/core/errors/index.js";

import {
  add,
  compare,
  format,
  isNegative,
  isZero,
  negate,
  parseDecimal,
  subtract,
} from "../money/decimal.js";

/**
 * Phase 19-S.14 — the pure half of inventory: the movement ledger's vocabulary, the availability
 * arithmetic and the two small state machines (transfer, adjustment).
 *
 * `PLAN_Phase_19_Sales.md` §4.15 makes the ledger the source of truth: "Physical stock is derived
 * from immutable stock movements or a rigorously maintained projection reconciled to that ledger."
 * The persisted projection (`sales_inventory_stock`) exists for locking and for fast reads, and
 * `reconcileStock` below is what proves it still equals the ledger.
 *
 * Nothing here touches a database, a clock or a socket: the signed quantity of a movement, the
 * available-to-promise figure, a transfer's allowed states and the reconciliation comparison are all
 * pure functions of their arguments, so every invariant can be exercised in a unit test.
 */

// -----------------------------------------------------------------------------------------------
// The ledger's vocabulary
// -----------------------------------------------------------------------------------------------

/**
 * Why physical stock moved. The list is closed on purpose: an unknown type is refused rather than
 * stored, because a report that has to guess what a row means cannot be a ledger (§4.15 invariant 1).
 *
 * `adjustment` and `correction` are the only two that may carry either sign — everything else is a
 * physical event whose direction is fixed by what happened (goods in, or goods out).
 */
export const INVENTORY_TRANSACTION_TYPES = [
  "openingBalance",
  "receipt",
  "delivery",
  "return",
  "adjustment",
  "transferOut",
  "transferIn",
  "correction",
] as const;

export type InventoryTransactionType =
  (typeof INVENTORY_TRANSACTION_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(INVENTORY_TRANSACTION_TYPES);

export function isInventoryTransactionType(
  value: string,
): value is InventoryTransactionType {
  return TYPE_SET.has(value);
}

/** Who a movement belongs to, and why — everything a traceable ledger row needs beyond the delta. */
export const MOVEMENT_SOURCES = [
  "DeliveryOrder",
  "ReturnOrder",
  "ReceiptOrder",
  "TransferOrder",
  "InventoryAdjustment",
  "manual",
] as const;

/** The sign a movement type must have; `0` means either sign is legitimate. */
const TYPE_SIGN: Readonly<Record<InventoryTransactionType, 1 | -1 | 0>> = {
  openingBalance: 1,
  receipt: 1,
  return: 1,
  transferIn: 1,
  delivery: -1,
  transferOut: -1,
  adjustment: 0,
  correction: 0,
};

export function signOf(type: InventoryTransactionType): 1 | -1 | 0 {
  return TYPE_SIGN[type];
}

/**
 * The signed canonical decimal string for `quantity` (a positive magnitude) moved in `sign`'s
 * direction.
 *
 * A caller never passes a signed quantity to mean "out": the direction of the physical event is the
 * type's, and this is where the two are combined once.
 */
export function signedQuantity(quantity: string, sign: 1 | -1): string {
  const value = parseDecimal(quantity);
  if (isNegative(value)) {
    throw new ValidationError(
      "A moved quantity is a positive magnitude; use the movement type to say which way it went.",
      { quantity },
    );
  }
  const signed = sign === 1 ? value : negate(value);
  return format(signed, signed.scale);
}

/**
 * Refuse a delta whose sign contradicts its type. `"delivery"` moving `+5` on-hand is a bug in the
 * caller, not a business case, so it is rejected instead of written.
 */
export function assertDeltaSign(
  type: InventoryTransactionType,
  delta: string,
): void {
  const sign = TYPE_SIGN[type];
  if (sign === 0) return;
  const value = parseDecimal(delta);
  if (isZero(value)) return;
  if ((sign === 1 && isNegative(value)) || (sign === -1 && !isNegative(value))) {
    throw new ValidationError(
      `A "${type}" movement must be ${sign === 1 ? "inbound" : "outbound"}, not ${delta}.`,
      { type, delta },
    );
  }
}

/**
 * One movement as it will be written. `movementKey` is the idempotency key: derived from the source
 * document or command, never from the request, so a retried confirmation asks for the *same* row
 * (the unique index behind it is the second line of defence).
 */
export interface LedgerMovement {
  readonly movementKey: string;
  readonly type: InventoryTransactionType;
  readonly productId: string;
  readonly warehouseId: string;
  /** Signed canonical decimal string. */
  readonly quantityDelta: string;
  readonly sourceEntity: string;
  readonly sourceId: string;
  readonly sourceNumber: string | null;
  readonly reason: string | null;
  /** Pairs the two sides of one transfer, so neither half can be lost. */
  readonly transferGroupId?: string | null | undefined;
  readonly occurredAt?: string | undefined;
}

/** The idempotency key of a document's movement line: one document + one line + one direction. */
export function movementKeyFor(
  sourceEntity: string,
  sourceId: string,
  type: InventoryTransactionType,
  position: number,
): string {
  return `${sourceEntity}:${sourceId}:${type}:${position}`;
}

// -----------------------------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------------------------

/**
 * What a warehouse/product pair holds.
 *
 * The four numbers §4.15 invariant 8 requires reports to keep apart:
 *
 *  - `onHand`   physical, derived from applied movements;
 *  - `reserved` promised to confirmed documents but not yet shipped;
 *  - `available` `onHand - reserved` — what a new order may still promise;
 *  - `incoming`  expected but not arrived (confirmed purchase orders, in-transit transfers).
 */
export interface StockLevel {
  readonly onHand: string;
  readonly reserved: string;
  readonly available: string;
  readonly incoming: string;
}

/** Available-to-promise is always derived, never stored: a stored copy is a second truth. */
export function availableToPromise(onHand: string, reserved: string): string {
  return format(subtract(parseDecimal(onHand), parseDecimal(reserved)));
}

export function stockLevel(
  onHand: string,
  reserved: string,
  incoming: string,
): StockLevel {
  return {
    onHand,
    reserved,
    available: availableToPromise(onHand, reserved),
    incoming,
  };
}

/** Whether a quantity may resolve to this level under the configured stocking policy. */
export function wouldGoNegative(onHand: string, delta: string): boolean {
  return isNegative(add(parseDecimal(onHand), parseDecimal(delta)));
}

// -----------------------------------------------------------------------------------------------
// Reservations
// -----------------------------------------------------------------------------------------------

export const RESERVATION_POLICIES = ["none", "soft", "hard"] as const;
export type ReservationPolicy = (typeof RESERVATION_POLICIES)[number];

export const RESERVATION_STATUSES = ["active", "consumed", "released"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Why a reservation cannot be placed, or `null` when it can. The reason is what the API returns. */
export function reservationRefusal(input: {
  readonly policy: ReservationPolicy;
  readonly available: string;
  readonly quantity: string;
}): string | null {
  const requested = parseDecimal(input.quantity);
  if (isZero(requested) || isNegative(requested)) {
    throw new ValidationError("A reservation must be a positive quantity.", {
      quantity: input.quantity,
    });
  }
  if (input.policy === "none") {
    return "Stock reservation is disabled by the Sales inventory settings.";
  }
  if (
    input.policy === "hard" &&
    compare(requested, parseDecimal(input.available)) > 0
  ) {
    return `Only ${input.available} of this product is available in the warehouse; ${input.quantity} was requested.`;
  }
  return null;
}

// -----------------------------------------------------------------------------------------------
// Transfer state machine (§4.15 invariant 5)
// -----------------------------------------------------------------------------------------------

/**
 * A transfer's states. `inTransit` is the safe intermediate state §4.15 asks for: the source outflow
 * has been applied and the destination inflow has not, so neither half is ever silently missing —
 * it is visible as an in-transit transfer rather than as stock that vanished.
 */
export const TRANSFER_STATES = [
  "draft",
  "inTransit",
  "received",
  "cancelled",
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export interface NamedAction {
  readonly action: string;
  readonly label: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly requiresReason?: boolean;
}

export const TRANSFER_TRANSITIONS: readonly NamedAction[] = [
  {
    action: "confirm",
    label: "Dispatch",
    from: ["draft"],
    to: "inTransit",
  },
  { action: "receive", label: "Receive", from: ["inTransit"], to: "received" },
  {
    action: "cancel",
    label: "Cancel",
    from: ["draft"],
    to: "cancelled",
    requiresReason: true,
  },
];

// -----------------------------------------------------------------------------------------------
// Adjustment state machine (§4.15 "reviewed corrections")
// -----------------------------------------------------------------------------------------------

/**
 * A correction is `pending` until a decision is recorded, then `applied` (the compensating movement
 * exists) or `rejected` (nothing moved). Applying is what writes the ledger row — the request alone
 * never changes stock.
 */
export const ADJUSTMENT_STATES = ["pending", "applied", "rejected"] as const;
export type AdjustmentState = (typeof ADJUSTMENT_STATES)[number];

export const ADJUSTMENT_TRANSITIONS: readonly NamedAction[] = [
  { action: "approve", label: "Approve", from: ["pending"], to: "applied" },
  {
    action: "reject",
    label: "Reject",
    from: ["pending"],
    to: "rejected",
    requiresReason: true,
  },
];

/** The named action, or `undefined` when the machine has no such transition. */
export function findNamedAction(
  actions: readonly NamedAction[],
  action: string,
): NamedAction | undefined {
  return actions.find((each) => each.action === action);
}

/**
 * Why an action is refused, worded for a user ("why can't I receive this transfer"), or `null`.
 * Shared by both small state machines; a document's is `document/descriptors.ts`.
 */
export function actionRefusal(
  actions: readonly NamedAction[],
  label: string,
  action: string,
  current: string,
): string | null {
  const named = findNamedAction(actions, action);
  if (named === undefined) return `A ${label} has no "${action}" action.`;
  if (!named.from.includes(current)) {
    return `"${named.label}" is not allowed from the "${current}" state of a ${label}; allowed from: ${named.from.join(", ")}.`;
  }
  return null;
}

// -----------------------------------------------------------------------------------------------
// Reconciliation (§4.15 task 10)
// -----------------------------------------------------------------------------------------------

export interface LevelKey {
  readonly productId: string;
  readonly warehouseId: string;
}

export interface ProjectedLevel extends LevelKey {
  readonly onHand: string;
  readonly reserved: string;
}

export interface LedgerLevel extends LevelKey {
  /** Sum of the signed deltas for the pair, as a canonical decimal string. */
  readonly quantity: string;
}

export interface ReconciliationRow extends LevelKey {
  readonly projected: string;
  readonly ledger: string;
  readonly difference: string;
  readonly ok: boolean;
}

export function levelKey(productId: string, warehouseId: string): string {
  // A NUL is impossible in an id, so it cannot be forged to collide two different pairs.
  return `${productId}\u0000${warehouseId}`;
}

/**
 * Compare the persisted projection with the ledger it is supposed to equal.
 *
 * Rows that exist on one side only are reported with `0` on the other — a projection row with no
 * movement behind it, or movements never projected, are both discrepancies. Nothing is corrected
 * here: §4.15 requires review before a discrepancy is written away.
 */
export function reconcileStock(
  projection: readonly ProjectedLevel[],
  ledger: readonly LedgerLevel[],
): ReconciliationRow[] {
  const projected = new Map<string, ProjectedLevel>();
  const summed = new Map<string, LedgerLevel>();
  const keys = new Map<string, LevelKey>();
  for (const row of projection) {
    projected.set(levelKey(row.productId, row.warehouseId), row);
    keys.set(levelKey(row.productId, row.warehouseId), row);
  }
  for (const row of ledger) {
    summed.set(levelKey(row.productId, row.warehouseId), row);
    keys.set(levelKey(row.productId, row.warehouseId), row);
  }
  const rows: ReconciliationRow[] = [];
  for (const [key, identity] of keys) {
    const left = projected.get(key);
    const right = summed.get(key);
    const projectedValue = parseDecimal(left?.onHand ?? "0");
    const ledgerValue = parseDecimal(right?.quantity ?? "0");
    const difference = subtract(projectedValue, ledgerValue);
    rows.push({
      productId: identity.productId,
      warehouseId: identity.warehouseId,
      projected: format(projectedValue),
      ledger: format(ledgerValue),
      difference: format(difference),
      ok: isZero(difference),
    });
  }
  return rows.sort(
    (a, b) =>
      a.productId.localeCompare(b.productId) ||
      a.warehouseId.localeCompare(b.warehouseId),
  );
}
