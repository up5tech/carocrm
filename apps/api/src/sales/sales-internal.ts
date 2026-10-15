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

/** Write-off request fields that stop being client-editable once the decision is made. */
export const DECIDED_WRITE_OFF_FIELDS: readonly string[] = [
  "invoiceId",
  "amount",
  "currency",
  "reason",
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
