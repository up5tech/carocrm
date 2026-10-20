import type { ExternalFieldSchema } from '../../connector-adapter.port.js';

/**
 * Phase 19-INT.23 — the accounting connector framework
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.8; `19-INT.23`).
 *
 * The plan asks for a framework and *one* first provider. This file holds the parts that are the
 * same for every accounting package, so the first provider only describes its own endpoints and
 * field names.
 *
 * The framework's rules, and why each one exists:
 *
 *  1. **The CRM's Sales module owns the business document.** An invoice that CRM issued is issued
 *     by CRM. The accounting package is told about it; it does not decide whether it is issued.
 *     So an accounting connector's objects are **read-only references** by default, and a write
 *     that would create or post a document is not part of the connector's first release.
 *  2. **A posted document is not an ordinary editable object.** A correction follows the
 *     provider's credit/void workflow, not a `PATCH`. The framework records the document's state
 *     so the CRM can tell a draft from a posted document and refuse to treat them alike.
 *  3. **Money is a decimal string with its currency.** The framework never parses an amount into
 *     a binary float and never re-rates it. The value and the currency travel together.
 *  4. **Reconciliation, not duplication.** An ambiguous timeout must not create a second
 *     document, so an accounting write carries the CRM document's own identifier and the
 *     framework records it.
 *  5. **No automatic financial operation.** A financial operation runs only after an
 *     administrator enabled and reviewed it. The framework therefore marks every accounting
 *     operation as requiring an explicit opt-in.
 */

/** The object families an accounting connector may offer. */
export const ACCOUNTING_OBJECT_FAMILIES = ['customer', 'invoice', 'payment', 'creditNote'] as const;
export type AccountingObjectFamily = (typeof ACCOUNTING_OBJECT_FAMILIES)[number];

/** The document states the framework distinguishes. */
export const ACCOUNTING_DOCUMENT_STATES = ['draft', 'posted', 'paid', 'void', 'unknown'] as const;
export type AccountingDocumentState = (typeof ACCOUNTING_DOCUMENT_STATES)[number];

/** The customer fields the framework expects. */
export const ACCOUNTING_CUSTOMER_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Customer ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'display_name', label: 'Name', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'email', label: 'Email', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'reference', label: 'Reference', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'currency', label: 'Currency', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'source_metadata', label: 'Source metadata', type: 'object', required: false, unique: false, identifier: false, sensitive: false },
];

/** The invoice fields the framework expects. */
export const ACCOUNTING_INVOICE_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Invoice ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'doc_number', label: 'Document number', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'customer_id', label: 'Customer ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'currency', label: 'Currency', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'total_amount', label: 'Total', type: 'decimal', required: true, unique: false, identifier: false, sensitive: true },
  { name: 'balance_amount', label: 'Balance', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'tax_total', label: 'Tax', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'state', label: 'Document state', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'due_date', label: 'Due date', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'source_metadata', label: 'Source metadata', type: 'object', required: false, unique: false, identifier: false, sensitive: false },
];

/** The payment fields the framework expects. */
export const ACCOUNTING_PAYMENT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Payment ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'customer_id', label: 'Customer ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'currency', label: 'Currency', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'total_amount', label: 'Amount', type: 'decimal', required: true, unique: false, identifier: false, sensitive: true },
  { name: 'state', label: 'Document state', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'payment_date', label: 'Payment date', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'reference', label: 'Reference', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'source_metadata', label: 'Source metadata', type: 'object', required: false, unique: false, identifier: false, sensitive: false },
];

/**
 * The state of an accounting document.
 *
 * A document the provider has posted is not editable, and a correction follows the provider's
 * credit/void workflow. The CRM therefore records the state rather than treating every document
 * as the same kind of record.
 */
export function accountingDocumentState(raw: string | null): AccountingDocumentState {
  if (raw === null) return 'unknown';
  const value = raw.trim().toLowerCase();
  if (value === 'draft' || value === 'notposted' || value === 'not_posted') return 'draft';
  if (value === 'posted') return 'posted';
  if (value === 'paid' || value === 'settled') return 'paid';
  if (value === 'void' || value === 'voided' || value === 'cancelled' || value === 'canceled') return 'void';
  return 'unknown';
}

/**
 * Normalize an accounting amount into a decimal string.
 *
 * The provider's own textual form is kept: `"100.00"` stays `"100.00"`. A number is formatted with
 * two decimals, which is the accounting default, and never parsed into a binary float.
 */
export function accountingDecimal(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  return null;
}

/** The source metadata every accounting object carries. */
export function accountingSourceMetadata(
  providerKey: string,
  realmId: string,
  deliveryId?: string | undefined,
): Record<string, unknown> {
  return {
    providerKey,
    realmId,
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
}
