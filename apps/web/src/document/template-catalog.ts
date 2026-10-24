/**
 * Document template design catalog.
 *
 * The document engine renders a body against the data its owning module hands in — for the Sales
 * documents that is `templateData` in `apps/api/src/sales/document/render.service.ts`. The designer
 * offers those names as a palette and renders previews against one representative sample, so the
 * screen can answer "what will this page look like" without reading a live record.
 *
 * This is presentation data, not the contract: the server still decides what a token resolves to and
 * reports anything the sample cannot answer.
 */

/** A representative Sales document, used for previews only. */
export const DOCUMENT_SAMPLE_DATA: Record<string, unknown> = {
  entityLabel: 'Invoice',
  title: 'Invoice INV-2026-0042',
  number: 'INV-2026-0042',
  status: 'Issued',
  date: '2026-10-24',
  accountName: 'Acme International',
  contactName: 'Jordan Lee',
  supplierName: 'Northwind Supply',
  billingAddress: '120 Market Street, San Francisco, CA',
  shippingAddress: '88 Harbor Road, Oakland, CA',
  description: 'Annual support renewal covering the production workspace.',
  currency: 'USD',
  amountDue: '4,860.00',
  dueDate: '2026-11-23',
  reason: 'Damaged on arrival',
  trackingNumber: 'TRK-882140',
  warehouseId: 'Main warehouse',
  requiredDeliveryDate: '2026-11-02',
  expectedDeliveryDate: '2026-11-05',
  facts: { 'Due date': '2026-11-23' },
  lines: [
    { name: 'Enterprise support', sku: 'SUP-ENT', quantity: '1', unitPrice: '4,500.00', lineTotal: '4,500.00', tax: '360.00' },
    { name: 'Onboarding workshop', sku: 'SRV-ONB', quantity: '2', unitPrice: '0.00', lineTotal: '0.00', tax: '0.00' },
  ],
  totals: {
    subtotal: '4,500.00',
    discountTotal: '0.00',
    shippingAmount: '0.00',
    shippingTaxAmount: '0.00',
    taxTotal: '360.00',
    netTotal: '4,500.00',
    grossTotal: '4,860.00',
  },
  subtotal: '4,500.00',
  discountTotal: '0.00',
  shippingAmount: '0.00',
  shippingTaxAmount: '0.00',
  taxTotal: '360.00',
  netTotal: '4,500.00',
  grossTotal: '4,860.00',
};

/** The entity types the Sales module renders documents for; also the target-entity choices. */
export const DOCUMENT_TARGET_ENTITIES = [
  'Quote',
  'Invoice',
  'SalesOrder',
  'CreditNote',
  'DeliveryOrder',
  'ReturnOrder',
  'PurchaseOrder',
  'ReceiptOrder',
  'Bill',
  'BillCredit',
] as const;

export interface DocumentToken {
  /** What is inserted, without braces: `number` or `totals.grossTotal`. */
  value: string;
  /** i18n key under `web.documentTemplate.tokens`. */
  labelKey: string;
}

export interface DocumentTokenGroup {
  key: string;
  /** i18n key under `web.documentTemplate.tokenGroups`. */
  labelKey: string;
  /** Shown only for line-item tokens, which resolve inside `{{#each lines}}`. */
  loop?: boolean;
  tokens: DocumentToken[];
}

export const DOCUMENT_TOKEN_GROUPS: DocumentTokenGroup[] = [
  {
    key: 'document',
    labelKey: 'document',
    tokens: [
      { value: 'title', labelKey: 'title' },
      { value: 'number', labelKey: 'number' },
      { value: 'date', labelKey: 'date' },
      { value: 'status', labelKey: 'status' },
      { value: 'entityLabel', labelKey: 'entityLabel' },
      { value: 'description', labelKey: 'description' },
      { value: 'currency', labelKey: 'currency' },
    ],
  },
  {
    key: 'parties',
    labelKey: 'parties',
    tokens: [
      { value: 'accountName', labelKey: 'accountName' },
      { value: 'contactName', labelKey: 'contactName' },
      { value: 'supplierName', labelKey: 'supplierName' },
      { value: 'billingAddress', labelKey: 'billingAddress' },
      { value: 'shippingAddress', labelKey: 'shippingAddress' },
    ],
  },
  {
    key: 'line',
    labelKey: 'line',
    loop: true,
    tokens: [
      { value: 'name', labelKey: 'lineName' },
      { value: 'sku', labelKey: 'sku' },
      { value: 'quantity', labelKey: 'quantity' },
      { value: 'unitPrice', labelKey: 'unitPrice' },
      { value: 'lineTotal', labelKey: 'lineTotal' },
      { value: 'tax', labelKey: 'tax' },
    ],
  },
  {
    key: 'totals',
    labelKey: 'totals',
    tokens: [
      { value: 'totals.subtotal', labelKey: 'subtotal' },
      { value: 'totals.discountTotal', labelKey: 'discountTotal' },
      { value: 'totals.shippingAmount', labelKey: 'shippingAmount' },
      { value: 'totals.taxTotal', labelKey: 'taxTotal' },
      { value: 'totals.grossTotal', labelKey: 'grossTotal' },
      { value: 'amountDue', labelKey: 'amountDue' },
    ],
  },
  {
    key: 'other',
    labelKey: 'other',
    tokens: [
      { value: 'dueDate', labelKey: 'dueDate' },
      { value: 'reason', labelKey: 'reason' },
      { value: 'trackingNumber', labelKey: 'trackingNumber' },
      { value: 'requiredDeliveryDate', labelKey: 'requiredDeliveryDate' },
      { value: 'expectedDeliveryDate', labelKey: 'expectedDeliveryDate' },
      { value: 'warehouseId', labelKey: 'warehouseId' },
    ],
  },
];
