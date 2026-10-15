import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-S.2 — issuance locking, as a contract the later document phases enforce (19-S.9+).
 *
 * An issued document is not an ordinary editable record (PLAN_Phase_19_Sales.md §4.7). This module
 * holds the parts that do not depend on any particular document table: which kinds exist, which
 * fields are protected once the document is issued, whether a given lock policy locks an issued
 * document, and who may unlock it. The per-document state machines stay with their own services —
 * there is deliberately no shared status enum here.
 */

export type SalesDocumentKind =
  | 'quote'
  | 'salesOrder'
  | 'invoice'
  | 'creditNote'
  | 'deliveryOrder'
  | 'returnOrder'
  | 'purchaseOrder'
  | 'receiptOrder'
  | 'bill'
  | 'billCredit';

export const SALES_DOCUMENT_KINDS: readonly SalesDocumentKind[] = [
  'quote',
  'salesOrder',
  'invoice',
  'creditNote',
  'deliveryOrder',
  'returnOrder',
  'purchaseOrder',
  'receiptOrder',
  'bill',
  'billCredit',
];

/** Commercial fields that produced the document's numbers; they never change after issuance. */
const COMMERCIAL_FIELDS: readonly string[] = [
  'number',
  'accountId',
  'contactId',
  'supplierId',
  'currency',
  'exchangeRateSnapshot',
  'items',
  'subtotal',
  'discountTotal',
  'shippingAmount',
  'taxTotal',
  'netTotal',
  'grossTotal',
];

/** Extra fields protected per document kind, on top of the commercial core. */
const EXTRA_PROTECTED_FIELDS: Readonly<Record<SalesDocumentKind, readonly string[]>> = {
  quote: ['validUntil', 'priceBookId'],
  salesOrder: ['orderDate', 'priceBookId', 'paymentTermId', 'warehouseId'],
  invoice: ['invoiceDate', 'deliveryDate', 'servicePeriodStart', 'servicePeriodEnd', 'paymentTermId', 'dueDate', 'amountDue', 'issuedAt', 'issuedBy'],
  creditNote: ['creditDate', 'invoiceId', 'amountDue', 'issuedAt', 'issuedBy'],
  deliveryOrder: ['deliveryDate', 'warehouseId'],
  returnOrder: ['returnDate', 'warehouseId', 'deliveryOrderId'],
  purchaseOrder: ['orderDate', 'expectedDeliveryDate', 'paymentTermId', 'warehouseId'],
  receiptOrder: ['receiptDate', 'warehouseId'],
  bill: ['billDate', 'dueDate', 'paymentTermId', 'amountDue', 'issuedAt', 'issuedBy'],
  billCredit: ['creditDate', 'billId', 'amountDue', 'issuedAt', 'issuedBy'],
};

export function protectedFields(kind: SalesDocumentKind): readonly string[] {
  return [...COMMERCIAL_FIELDS, ...EXTRA_PROTECTED_FIELDS[kind]];
}

/**
 * Lock policy. `lockOnIssue` is the configured default (PLAN_Phase_19_Sales.md §13, feature
 * `issuanceLocking`); `unlockRequiresPermission` keeps an administrator's unlock a dedicated,
 * audited action instead of an ordinary edit.
 */
export interface DocumentLockPolicy {
  readonly lockOnIssue: boolean;
  readonly unlockRequiresPermission: boolean;
}

export const DEFAULT_LOCK_POLICY: DocumentLockPolicy = { lockOnIssue: true, unlockRequiresPermission: true };

/** The lock-relevant slice of a document row. Timestamps are ISO strings or null. */
export interface DocumentLockState {
  readonly kind: SalesDocumentKind;
  readonly issuedAt: string | null;
  readonly issuedBy: string | null;
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  /** Set only by a privileged unlock; kept as history, never cleared. */
  readonly unlockedAt: string | null;
  readonly unlockedBy: string | null;
}

export function emptyLockState(kind: SalesDocumentKind): DocumentLockState {
  return { kind, issuedAt: null, issuedBy: null, lockedAt: null, lockedBy: null, unlockedAt: null, unlockedBy: null };
}

export function isIssued(state: DocumentLockState): boolean {
  return state.issuedAt !== null;
}

export function isLocked(state: DocumentLockState, policy: DocumentLockPolicy = DEFAULT_LOCK_POLICY): boolean {
  if (state.lockedAt !== null) return true;
  return policy.lockOnIssue && isIssued(state);
}

/**
 * Refuse an edit to protected fields of a locked document. `changedFields` are the fields the
 * caller actually intends to change — a no-op save of the same value is not a violation.
 */
export function protectedFieldViolations(
  state: DocumentLockState,
  changedFields: readonly string[],
  policy: DocumentLockPolicy = DEFAULT_LOCK_POLICY,
): string[] {
  if (!isLocked(state, policy)) return [];
  const protectedSet = new Set(protectedFields(state.kind));
  return [...new Set(changedFields)].filter((field) => protectedSet.has(field));
}

export function assertDocumentEditable(
  state: DocumentLockState,
  changedFields: readonly string[],
  policy: DocumentLockPolicy = DEFAULT_LOCK_POLICY,
): void {
  const violations = protectedFieldViolations(state, changedFields, policy);
  if (violations.length === 0) return;
  throw new ValidationError(
    `This ${state.kind} is ${state.lockedAt !== null ? 'locked' : 'issued'}; ${violations.join(', ')} cannot be changed. Use a credit note or the documented correction flow.`,
    { kind: state.kind, fields: violations, issuedAt: state.issuedAt, lockedAt: state.lockedAt },
  );
}

/**
 * Unlock is a privileged action: it needs the dedicated permission (or a system administrator) and
 * the caller must keep the reason in the audit record.
 */
export function assertUnlockAllowed(
  state: DocumentLockState,
  actor: { readonly isAdmin: boolean; readonly canUnlock: boolean },
  policy: DocumentLockPolicy = DEFAULT_LOCK_POLICY,
): void {
  if (!isLocked(state, policy)) {
    throw new ValidationError(`This ${state.kind} is not locked.`, { kind: state.kind });
  }
  if (policy.unlockRequiresPermission && !actor.isAdmin && !actor.canUnlock) {
    throw new AuthorizationDeniedError('Unlocking an issued document requires the "unlock issued documents" permission.', {
      kind: state.kind,
    });
  }
}

/** Consequences of a privileged unlock, for the caller to write in one transaction. */
export interface UnlockResult {
  readonly state: DocumentLockState;
  readonly reason: string;
}

export function applyUnlock(state: DocumentLockState, actor: { userId: string }, reason: string, at: string): UnlockResult {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new ValidationError('Unlocking an issued document requires a reason.');
  }
  return {
    state: { ...state, lockedAt: null, lockedBy: null, unlockedAt: at, unlockedBy: actor.userId },
    reason: trimmed,
  };
}
