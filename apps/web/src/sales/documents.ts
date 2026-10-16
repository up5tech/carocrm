/**
 * Phase 19-S.17 — the document kinds the Sales commands understand, keyed by the metadata entity the
 * generic screens navigate by.
 *
 * The backend owns this list (`sales/document/descriptors.ts`); this is only the entity → kind lookup
 * the UI needs to decide whether a record it is rendering is a commercial document whose lines must go
 * through the document command. A kind added to the engine without appearing here simply keeps the
 * generic relationship panel, which is the safe default rather than a broken one.
 */
export const SALES_DOCUMENT_KIND_BY_ENTITY: Readonly<Record<string, string>> = {
  Quote: 'quote',
  SalesOrder: 'salesOrder',
  Invoice: 'invoice',
  CreditNote: 'creditNote',
  DeliveryOrder: 'deliveryOrder',
  ReturnOrder: 'returnOrder',
  PurchaseOrder: 'purchaseOrder',
  ReceiptOrder: 'receiptOrder',
  Bill: 'bill',
  BillCredit: 'billCredit',
};

export function salesDocumentKind(entity: string): string | undefined {
  return SALES_DOCUMENT_KIND_BY_ENTITY[entity];
}

/**
 * The field that carries each kind's own date — what prices, tax rates and payment terms are resolved
 * as of. It is named per kind (`invoiceDate`, `orderDate`, …), so the editor asks for it by name
 * instead of guessing from whichever date happens to be filled in.
 */
const SALES_DOCUMENT_DATE_FIELD: Readonly<Record<string, string>> = {
  quote: 'quoteDate',
  salesOrder: 'orderDate',
  invoice: 'invoiceDate',
  creditNote: 'creditDate',
  deliveryOrder: 'deliveryDate',
  returnOrder: 'returnDate',
  purchaseOrder: 'orderDate',
  receiptOrder: 'receiptDate',
  bill: 'billDate',
  billCredit: 'creditDate',
};

/** The document date as `YYYY-MM-DD`, or null when it has not been filled in yet. */
export function salesDocumentDate(kind: string, document: Record<string, unknown>): string | null {
  const field = SALES_DOCUMENT_DATE_FIELD[kind];
  if (field === undefined) return null;
  const value = document[field];
  return typeof value === 'string' && value !== '' ? value.slice(0, 10) : null;
}
