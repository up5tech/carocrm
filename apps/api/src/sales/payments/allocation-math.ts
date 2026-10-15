import { ValidationError } from '@carocrm/core/errors/index.js';

import { add, compare, format, isNegative, parseDecimal, subtract, zero } from '../money/decimal.js';
import type { Decimal } from '../money/decimal.js';

/**
 * Phase 19-S.10 — the arithmetic and the rules behind payment allocation (§4.8).
 *
 * Everything here is a pure function of its inputs, so the four things the phase is judged on can be
 * tested without a database, a gateway or a clock:
 *
 *  1. a payment's remaining allocatable balance is its amount minus what it has already been
 *     allocated, and it can never go negative;
 *  2. an allocation may not exceed either the payment's remaining balance or the document's remaining
 *     eligible balance;
 *  3. amounts in different currencies are never combined without an explicit conversion snapshot;
 *  4. a document's payment status is *derived* from its balances and its due date, never stored by a
 *     client (a `status` field must not stand in for "paid" — §4.7).
 */

export type PaymentDirection = 'incoming' | 'outgoing';

export const PAYMENT_DIRECTIONS: readonly PaymentDirection[] = ['incoming', 'outgoing'];

/** How much of a payment has been applied. Derived, never client-supplied. */
export type PaymentAllocationStatus = 'unallocated' | 'partiallyAllocated' | 'allocated';

/** The payment-state concept that stays separate from the document's own `status` (§4.7). */
export type InvoicePaymentStatus = 'unpaid' | 'partiallyPaid' | 'paid' | 'overdue';

export const PAYMENT_TRANSITIONS = [
  { action: 'confirm', label: 'Confirm', from: ['draft'], to: 'confirmed' },
  { action: 'cancel', label: 'Cancel', from: ['draft', 'confirmed'], to: 'cancelled' },
] as const;

export const PAYMENT_STATES: readonly string[] = ['draft', 'confirmed', 'cancelled'];

export interface PaymentBalance {
  readonly amount: string;
  readonly allocated: string;
  /** What is still available to allocate. Never negative. */
  readonly unallocated: string;
  readonly status: PaymentAllocationStatus;
}

/**
 * A payment's balance. Allocations that exceed the payment's own amount are refused here — an
 * "over-allocated" payment is not a state this module represents; an overpayment is modelled as an
 * unapplied amount instead (§4.8).
 */
export function paymentBalance(amount: string, allocatedAmounts: readonly string[]): PaymentBalance {
  const total = requireNonNegative(amount, 'amount');
  let allocated: Decimal = zero(total.scale);
  for (const value of allocatedAmounts) {
    allocated = add(allocated, requireNonNegative(value, 'allocation.amount'));
  }
  const unallocated = subtract(total, allocated);
  if (isNegative(unallocated)) {
    throw new ValidationError(
      `The allocations (${format(allocated)}) exceed the payment amount (${format(total)}). Allocate less, or record the excess as an unapplied amount.`,
      { amount: format(total), allocated: format(allocated) },
    );
  }
  return {
    amount: format(total),
    allocated: format(allocated),
    unallocated: format(unallocated),
    status: allocationStatus(total, allocated),
  };
}

function allocationStatus(amount: Decimal, allocated: Decimal): PaymentAllocationStatus {
  if (compare(allocated, zero(allocated.scale)) === 0) return 'unallocated';
  return compare(allocated, amount) >= 0 ? 'allocated' : 'partiallyAllocated';
}

/**
 * The amount of a document still open to allocation: its payable total minus what payments, credits
 * and write-offs have already settled.
 *
 * Returned as a canonical decimal string, and never negative — a document cannot be "over-paid" in
 * this model; the excess belongs to the payment's unapplied amount.
 */
export function documentOutstanding(
  payableTotal: string,
  allocations: readonly string[],
  credits: readonly string[] = [],
  writeOffs: readonly string[] = [],
): string {
  const total = requireNonNegative(payableTotal, 'grossTotal');
  let settled: Decimal = zero(total.scale);
  for (const value of [...allocations, ...credits, ...writeOffs]) {
    settled = add(settled, requireNonNegative(value, 'settledAmount'));
  }
  const outstanding = subtract(total, settled);
  return isNegative(outstanding) ? format(zero(total.scale)) : format(outstanding);
}

/**
 * Refuse an allocation that would take either side past its remaining balance.
 *
 * The message carries both remaining amounts, because "why was my allocation refused" is answered by
 * those two numbers and nothing else.
 */
export function assertAllocatable(input: {
  readonly amount: string;
  readonly paymentRemaining: string;
  readonly documentRemaining: string;
  readonly paymentId: string;
  readonly documentId: string;
}): void {
  const amount = requirePositive(input.amount, 'allocation.amount');
  const paymentRemaining = requireNonNegative(input.paymentRemaining, 'paymentRemaining');
  const documentRemaining = requireNonNegative(input.documentRemaining, 'documentRemaining');

  if (compare(amount, paymentRemaining) > 0) {
    throw new ValidationError(
      `This allocation of ${format(amount)} exceeds the ${format(paymentRemaining)} still unallocated on payment "${input.paymentId}".`,
      { paymentId: input.paymentId, amount: format(amount), remaining: format(paymentRemaining) },
    );
  }
  if (compare(amount, documentRemaining) > 0) {
    throw new ValidationError(
      `This allocation of ${format(amount)} exceeds the ${format(documentRemaining)} still outstanding on "${input.documentId}".`,
      { documentId: input.documentId, amount: format(amount), remaining: format(documentRemaining) },
    );
  }
}

/**
 * Currency agreement. A cross-currency allocation needs a conversion snapshot; without one the two
 * amounts are not comparable and must not be combined (§4.13 "prevent allocations across currencies
 * without an explicit conversion snapshot and policy").
 */
export function assertSameCurrency(input: {
  readonly paymentCurrency: string;
  readonly documentCurrency: string;
  readonly allocationCurrency: string;
  readonly hasConversion: boolean;
}): void {
  const payment = input.paymentCurrency.toUpperCase();
  const document = input.documentCurrency.toUpperCase();
  const allocation = input.allocationCurrency.toUpperCase();
  if (payment !== allocation) {
    throw new ValidationError(`A payment in ${payment} cannot carry an allocation in ${allocation}.`, {
      paymentCurrency: payment,
      allocationCurrency: allocation,
    });
  }
  if (document !== allocation && !input.hasConversion) {
    throw new ValidationError(
      `Allocating ${allocation} to a ${document} document needs an exchange-rate snapshot; without one the amounts are not comparable.`,
      { documentCurrency: document, allocationCurrency: allocation },
    );
  }
}

/**
 * The document's payment status, derived from its balances and its due date.
 *
 * `overdue` is a *payment* status, not a document status: an invoice that is past its due date with
 * something outstanding is still an issued invoice. Keeping the two apart is what §4.7 asks for.
 */
export function invoicePaymentStatus(input: {
  readonly grossTotal: string;
  readonly amountDue: string;
  readonly dueDate: string | null;
  readonly today: string;
}): InvoicePaymentStatus {
  const gross = requireNonNegative(input.grossTotal, 'grossTotal');
  const due = requireNonNegative(input.amountDue, 'amountDue');
  if (compare(due, zero(due.scale)) === 0) return 'paid';
  const overdue = input.dueDate !== null && input.dueDate !== '' && input.dueDate < input.today;
  if (overdue) return 'overdue';
  return compare(due, gross) < 0 ? 'partiallyPaid' : 'unpaid';
}

/** How much of a document a single payment can still settle, given everything already allocated. */
export function allocatableToDocument(grossTotal: string, alreadyAllocated: readonly string[], credits: readonly string[] = []): string {
  return documentOutstanding(grossTotal, alreadyAllocated, credits);
}

/** A payment direction decides which document types it may settle (§4.8). */
export const PERMITTED_DOCUMENT_TYPES: Readonly<Record<PaymentDirection, readonly string[]>> = {
  // Money received settles what a customer owes.
  incoming: ['Invoice'],
  // Money paid settles what the organisation owes. Supplier bills arrive with 19-S.13.
  outgoing: [],
};

export function assertDirectionAllows(direction: PaymentDirection, documentEntity: string): void {
  const permitted = PERMITTED_DOCUMENT_TYPES[direction];
  if (permitted.length === 0) {
    throw new ValidationError(
      `A ${direction} payment cannot be allocated yet: the payable documents it would settle arrive with 19-S.13 (supplier bills).`,
      { direction, documentEntity },
    );
  }
  if (!permitted.includes(documentEntity)) {
    throw new ValidationError(`A ${direction} payment settles ${permitted.join(', ')}; "${documentEntity}" is not one of them.`, {
      direction,
      documentEntity,
      permitted,
    });
  }
}

function requireNonNegative(value: string, field: string): Decimal {
  const parsed = parseDecimal(value);
  if (isNegative(parsed)) {
    throw new ValidationError(`"${field}" must not be negative.`, { field, value });
  }
  return parsed;
}

function requirePositive(value: string, field: string): Decimal {
  const parsed = parseDecimal(value);
  if (compare(parsed, zero(parsed.scale)) <= 0) {
    throw new ValidationError(`"${field}" must be greater than zero.`, { field, value });
  }
  return parsed;
}
