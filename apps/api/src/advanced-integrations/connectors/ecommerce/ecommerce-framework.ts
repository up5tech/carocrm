import type { ExternalFieldSchema } from '../../connector-adapter.port.js';

/**
 * Phase 19-INT.22 — the ecommerce connector framework
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.7; `19-INT.22`).
 *
 * The plan asks for a **framework** and *one* first provider, not a family of half-implemented
 * stores. This file holds the parts that are the same for every store, so the first provider only
 * has to describe its own URLs and field names.
 *
 * The framework's rules, and why each one exists:
 *
 *  1. **A store is a source, not a mirror.** An ecommerce connector is **inbound** by default.
 *     The plan says plainly: *"Do not push CRM edits back to an online store by default."* A
 *     provider may opt into outbound for products and customers, but the default direction is
 *     inbound and the framework states it in the capability declaration.
 *  2. **An external delete is never a CRM delete.** A store that removes an order does not erase
 *     the CRM's commercial history. The framework's deletion visibility is `tombstoned`, and the
 *     mapping's deletion policy decides whether the CRM record is unlinked, voided or archived.
 *  3. **Money is a decimal string.** A price is carried as the provider's own decimal string and
 *     is never parsed into a binary float. The CRM's decimal layer does the arithmetic; this
 *     framework only moves the value.
 *  4. **The store's identifiers are kept.** The store id, the order number and the webhook
 *     delivery id are all part of the object, so a record can be traced back and a delivery can be
 *     recognised as a duplicate.
 */

/** The object families an ecommerce connector may offer. */
export const ECOMMERCE_OBJECT_FAMILIES = ['order', 'customer', 'product'] as const;
export type EcommerceObjectFamily = (typeof ECOMMERCE_OBJECT_FAMILIES)[number];

/**
 * The order fields the framework expects.
 *
 * A provider maps its own names onto these; the framework holds the *meaning*.
 */
export const ECOMMERCE_ORDER_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Order ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'name', label: 'Order number', type: 'string', required: true, unique: true, identifier: false, sensitive: false },
  { name: 'store_id', label: 'Store ID', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'created_at', label: 'Placed at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'currency', label: 'Currency', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'total_price', label: 'Total', type: 'decimal', required: true, unique: false, identifier: false, sensitive: true },
  { name: 'subtotal_price', label: 'Subtotal', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'tax_total', label: 'Tax', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'shipping_total', label: 'Shipping', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'discount_total', label: 'Discount', type: 'decimal', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'financial_status', label: 'Payment status', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'fulfillment_status', label: 'Fulfilment status', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'customer_id', label: 'Store customer ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'email', label: 'Customer email', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'line_items', label: 'Lines', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'source_metadata', label: 'Source metadata', type: 'object', required: false, unique: false, identifier: false, sensitive: false },
];

/** The customer fields the framework expects. */
export const ECOMMERCE_CUSTOMER_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Customer ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'store_id', label: 'Store ID', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'email', label: 'Email', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'first_name', label: 'First name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'last_name', label: 'Last name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'phone', label: 'Phone', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'created_at', label: 'Created at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'source_metadata', label: 'Source metadata', type: 'object', required: false, unique: false, identifier: false, sensitive: false },
];

/** The product fields the framework expects. */
export const ECOMMERCE_PRODUCT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Product ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'store_id', label: 'Store ID', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'title', label: 'Title', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'handle', label: 'Handle', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'vendor', label: 'Vendor', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'variants', label: 'Variants', type: 'array', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created_at', label: 'Created at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'updated_at', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
];

/**
 * The source metadata every ecommerce object carries.
 *
 * It is the traceability the plan asks for: which store, which connector, which delivery.
 */
export interface EcommerceSourceMetadata {
  readonly providerKey: string;
  readonly storeId: string;
  readonly deliveryId?: string | undefined;
  readonly externalUrl?: string | undefined;
}

/** The money of an ecommerce object, as decimal strings. */
export interface EcommerceMoney {
  readonly currency: string;
  readonly total: string;
  readonly subtotal: string | null;
  readonly tax: string | null;
  readonly shipping: string | null;
  readonly discount: string | null;
}

/**
 * Build the source metadata of an ecommerce object.
 *
 * The delivery id is included when the object arrived by webhook, so a record can be traced to
 * the exact delivery that produced it.
 */
export function ecommerceSourceMetadata(
  providerKey: string,
  storeId: string,
  deliveryId?: string | undefined,
  externalUrl?: string | undefined,
): Record<string, unknown> {
  return {
    providerKey,
    storeId,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(externalUrl === undefined ? {} : { externalUrl }),
  };
}

/**
 * Normalize a money value into a decimal string.
 *
 * A provider's number is converted through its own textual form, never through a binary float, so
 * `19.90` does not become `19.899999999999999`.
 */
export function decimalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  return null;
}
