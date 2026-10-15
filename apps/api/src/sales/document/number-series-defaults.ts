/**
 * Phase 19-S.2 — default document number series (PLAN_Phase_19_Sales.md §4.4, §8.3).
 *
 * Kept free of Nest and database imports on purpose: the installer seed (`database/seed.ts`) writes
 * these rows with its raw pool, and the runtime service reads the same list, so the seeded series
 * and the ones a fresh install creates can never drift apart.
 */

export type AllocationTiming = 'issuance' | 'creation';

export interface NumberSeriesSeed {
  readonly code: string;
  readonly label: string;
  readonly prefix: string;
  readonly padding?: number;
  readonly allocation?: AllocationTiming;
}

/** The series every Sales document type allocates from, seeded once and never overwritten. */
export const DEFAULT_NUMBER_SERIES: readonly NumberSeriesSeed[] = [
  { code: 'quote', label: 'Quote', prefix: 'Q-' },
  { code: 'salesOrder', label: 'Sales Order', prefix: 'SO-' },
  { code: 'invoice', label: 'Invoice', prefix: 'INV-' },
  { code: 'creditNote', label: 'Credit Note', prefix: 'CN-' },
  { code: 'deliveryOrder', label: 'Delivery Order', prefix: 'DO-' },
  { code: 'returnOrder', label: 'Return Order', prefix: 'RO-' },
  { code: 'purchaseOrder', label: 'Purchase Order', prefix: 'PO-' },
  { code: 'receiptOrder', label: 'Receipt Order', prefix: 'GRN-' },
  { code: 'bill', label: 'Supplier Bill', prefix: 'BILL-' },
  { code: 'billCredit', label: 'Bill Credit', prefix: 'BC-' },
];

/** `prefix` + zero-padded number, e.g. `INV-000042`. */
export function formatDocumentNumber(prefix: string, number: number, padding: number): string {
  return `${prefix}${String(number).padStart(padding, '0')}`;
}
