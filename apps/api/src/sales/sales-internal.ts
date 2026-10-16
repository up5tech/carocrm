import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Phase 19-S.10 — the "this write comes from a Sales domain service" marker, and the field lists the
 * write guard protects.
 *
 * Two different callers write the same records: a user through the generic `/api/v1/:entity` API, and
 * a Sales domain service through `EntityCrudService` (issuing an invoice, allocating a payment). The
 * rules differ — an allocation *must* move an issued invoice's `amountDue`, a user must never be able
 * to — and the only honest way to tell them apart is for the domain services to say so.
 *
 * So a domain service wraps its writes in `runAsSalesInternal()`, and the `beforeValidate` guard
 * (`sales-write-guard.service.ts`) refuses server-owned fields and protected-field edits for every
 * caller that is *not* marked. This is the same shape as `entity/tx-context.ts`: one async-local flag,
 * no second entity layer, and nothing to configure.
 */

const storage = new AsyncLocalStorage<true>();

/**
 * Mark every record write performed by `work` as an internal Sales write.
 *
 * The guard's checks are about protecting the *client* path; the domain services validate their own
 * inputs and their own invariants, so they opt out explicitly rather than being trusted by accident.
 */
export function runAsSalesInternal<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}

export function isSalesInternalWrite(): boolean {
  return storage.getStore() === true;
}

/**
 * Fields the server computes on a commercial document. A caller may never set them, on create or on
 * update: totals are recomputed on every save, the number comes from the series, and the issuance and
 * lock fields come from the transition (§5.7, §4.7).
 */
export const SERVER_OWNED_DOCUMENT_FIELDS: readonly string[] = [
  "subtotal",
  "discountTotal",
  "shippingTaxAmount",
  "taxBreakdown",
  "taxTotal",
  "netTotal",
  "grossTotal",
  "amountDue",
  "baseCurrency",
  "exchangeRate",
  "baseGrossTotal",
  "roundingStage",
  "roundingMode",
  "taxInclusive",
  "settingsVersion",
  "itemsCount",
  "number",
  "status",
  "issuedAt",
  "issuedBy",
  "lockedAt",
  "lockedBy",
  "unlockedAt",
  "unlockedBy",
  "snapshot",
  // The credit note's derived remainder (19-S.11): written at issuance and by every allocation or
  // reversal, never by a client.
  "unallocatedAmount",
];

/** Entities whose money the allocation services maintain, not the client. */
export const PAYMENT_ENTITIES: readonly string[] = [
  "Payment",
  "PaymentAllocation",
  "PaymentTransferAllocation",
  "PaymentRequest",
  "PaymentProviderEventLog",
];

/**
 * Fields the server computes on a payment or an allocation. `allocatedAmount`/`unallocatedAmount` and
 * the derived statuses are the whole point: a client-supplied balance would let a payment claim to be
 * settled without any allocation behind it (§4.8).
 */
export const SERVER_OWNED_PAYMENT_FIELDS: readonly string[] = [
  "allocatedAmount",
  "unallocatedAmount",
  "allocationStatus",
  "processedAt",
  "processedStatus",
  "status",
];

/**
 * The 19-S.11 correction records whose lifecycle is driven by domain commands.
 *
 * `WriteOff` is grantable as a *request* (a `create` with the status left pending), but its approval,
 * rejection and reversal — and the allocation reversal fields — are server-owned: a client must not
 * be able to approve its own write-off or fabricate the reversal trail through the record API.
 */
export const ADJUSTMENT_ENTITIES: readonly string[] = [
  "WriteOff",
  "CreditNoteAllocation",
  // The supplier-side credit (19-S.13): the same lifecycle, its own records.
  "BillCreditAllocation",
];

export const SERVER_OWNED_ADJUSTMENT_FIELDS: readonly string[] = [
  "status",
  "requestedBy",
  "approvedBy",
  "approvedAt",
  "reversedBy",
  "reversedAt",
  "reversalReason",
];

/**
 * Phase 19-S.14 — the inventory decision fields a client may never set.
 *
 * A reservation's status and its consumption/release trail, an adjustment's decision, and a
 * transfer's lifecycle are all moved by the inventory service; the record API must not be a way to
 * release a reservation nobody released or to mark a transfer received without the stock moving.
 */
export const SERVER_OWNED_INVENTORY_FIELDS: readonly string[] = [
  "status",
  "consumedQuantity",
  "releasedAt",
  "releasedBy",
  "releaseReason",
  "decidedBy",
  "decidedAt",
  "decisionReason",
  "transactionId",
];

/** The append-only ledger: a correction is a new compensating row, never an edit (§4.15). */
export const INVENTORY_LEDGER_ENTITY = "InventoryTransaction";

/**
 * 19-S.15 — the stock-identity records, and the only lot fact a client may correct.
 *
 * A serial is created and walked (`inStock → inTransit → shipped → retired`) only by the movement
 * that physically accounts for the unit: the write guard refuses *every* client write to
 * `InventorySerial`, because a unit no ledger row stands for would break the identity
 * reconciliation, and a status flipped through the record API would claim stock that never moved.
 *
 * A lot's identity is equally fixed (one `productId` + `batchNumber` is the same physical lot —
 * migration 029 makes it unique), but its *dates* stay correctable: a mis-typed expiry is a fact to
 * fix before it matters, not a movement. Nothing here touches quantities — those live in
 * `sales_inventory_batch_stock` and are written only with the ledger.
 */
export const SERVER_OWNED_TRACKING_FIELDS: readonly string[] = [
  "serialNumber",
  "productId",
  "warehouseId",
  "status",
  "receivedAt",
  "lastMovementAt",
  "sourceEntity",
  "sourceId",
  "sourceNumber",
  "batchNumber",
];

/** The only lot facts a client may edit: the dates and the free-text note. */
export const BATCH_EDITABLE_FIELDS: readonly string[] = [
  "manufacturingDate",
  "expiryDate",
  "description",
];

/** Entities whose lifecycle the inventory service owns rather than the record API. */
export const INVENTORY_MANAGED_ENTITIES: readonly string[] = [
  "InventoryAdjustment",
  "InventoryReservation",
  "TransferOrder",
  "TransferOrderItem",
  // 19-S.15: stock identity — a serial never, a lot only as dates (see above).
  "InventoryBatch",
  "InventorySerial",
];

/** Write-off request fields that stop being client-editable once the decision is made. */
export const DECIDED_WRITE_OFF_FIELDS: readonly string[] = [
  "invoiceId",
  "amount",
  "currency",
  "reason",
];

/**
 * Phase 19-S.16 — the subscription records, and what the record API may not forge.
 *
 * A period's status, its invoice link and its attempt trail are produced by the billing service. If a
 * client could set them, it could mark a period `invoiced` with an `invoiceId` that no invoice backs
 * — which is exactly the "the record says it was billed but nothing was issued" state that makes a
 * billing run unsafe to retry (§4.14). So those fields are server-owned, like an allocation balance
 * and an inventory decision.
 *
 * A subscription's `status` is server-owned for the same reason: the lifecycle is moved by the
 * pause/resume/cancel commands, not by editing a record behind them.
 */
export const SUBSCRIPTION_ENTITIES: readonly string[] = [
  "Subscription",
  "SubscriptionPeriod",
];

export const SERVER_OWNED_SUBSCRIPTION_FIELDS: readonly string[] = [
  "status",
  // The period's billing outcome — only the billing service may claim or complete it.
  "invoiceId",
  "generatedInvoiceId",
  "invoiceDate",
  "attemptCount",
  "failureCode",
  "retryState",
  // The window identity and its idempotency key: a period is a computed schedule, not a typed range.
  "periodStart",
  "periodEnd",
  "plannedInvoiceDate",
  "idempotencyKey",
];

/** Keys whose value actually differs from the stored record — a no-op save is not a change. */
export function changedKeys(
  data: Record<string, unknown>,
  previous: Record<string, unknown>,
): string[] {
  return Object.keys(data).filter(
    (key) => !sameValue(data[key], previous[key]),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (
    typeof left === "object" &&
    typeof right === "object" &&
    left !== null &&
    right !== null
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}
