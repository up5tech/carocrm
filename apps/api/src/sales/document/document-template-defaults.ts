/**
 * Phase 19-S.17 — default document templates (PLAN_Phase_19_Sales.md §13, S.17 task 3).
 *
 * Standard PDF/email templates for each Sales document type, seeded once and never overwritten.
 * An operator can edit, deactivate or replace them through the DocumentTemplate UI; the built-in
 * block layout is always the fallback when no template is active.
 *
 * Template bodies use the @carocrm/document placeholder syntax: `{{ path }}` for escaped text,
 * `{{{ path }}}` for raw HTML, and `{{#each lines}}...{{/each}}` for line item blocks.
 */

export type DocumentTemplateSeed = {
  readonly code: string;
  readonly name: string;
  readonly targetEntity: string;
  readonly subject: string;
  readonly body: string;
  readonly format: 'html' | 'text';
  readonly locale: string | null;
  readonly active: boolean;
  readonly isDefault: boolean;
};

export const DEFAULT_DOCUMENT_TEMPLATES: readonly DocumentTemplateSeed[] = [
  {
    code: 'quoteDefault',
    name: 'Quote — default',
    targetEntity: 'Quote',
    subject: 'Quote {{number}} from {{accountName}}',
    body: `
<h2>Quote {{number}}</h2>
<p>Date: {{date}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<p>{{description}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Subtotal: {{totals.subtotal}} {{currency}}</p>
<p>Discount: {{totals.discountTotal}} {{currency}}</p>
<p>Shipping: {{totals.shippingAmount}} {{currency}}</p>
<p>Tax: {{totals.taxTotal}} {{currency}}</p>
<p><strong>Gross total: {{totals.grossTotal}} {{currency}}</strong></p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'invoiceDefault',
    name: 'Invoice — default',
    targetEntity: 'Invoice',
    subject: 'Invoice {{number}} — {{accountName}}',
    body: `
<h2>Invoice {{number}}</h2>
<p>Invoice date: {{date}}</p>
<p>Due date: {{dueDate}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<p>Currency: {{currency}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Tax</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{tax}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Subtotal: {{totals.subtotal}} {{currency}}</p>
<p>Discount: {{totals.discountTotal}} {{currency}}</p>
<p>Shipping: {{totals.shippingAmount}} {{currency}}</p>
<p>Tax: {{totals.taxTotal}} {{currency}}</p>
<p><strong>Gross total: {{totals.grossTotal}} {{currency}}</strong></p>
<p><strong>Amount due: {{amountDue}} {{currency}}</strong></p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'salesOrderDefault',
    name: 'Sales Order — default',
    targetEntity: 'SalesOrder',
    subject: 'Sales Order {{number}} — {{accountName}}',
    body: `
<h2>Sales Order {{number}}</h2>
<p>Date: {{date}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<p>{{description}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Gross total: {{totals.grossTotal}} {{currency}}</p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'creditNoteDefault',
    name: 'Credit Note — default',
    targetEntity: 'CreditNote',
    subject: 'Credit Note {{number}} — {{accountName}}',
    body: `
<h2>Credit Note {{number}}</h2>
<p>Date: {{date}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Gross total: {{totals.grossTotal}} {{currency}}</p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'deliveryOrderDefault',
    name: 'Delivery Order — default',
    targetEntity: 'DeliveryOrder',
    subject: 'Delivery Order {{number}} — {{accountName}}',
    body: `
<h2>Delivery Order {{number}}</h2>
<p>Date: {{date}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<p>Shipping address: {{shippingAddress}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'returnOrderDefault',
    name: 'Return Order — default',
    targetEntity: 'ReturnOrder',
    subject: 'Return Order {{number}} — {{accountName}}',
    body: `
<h2>Return Order {{number}}</h2>
<p>Date: {{date}}</p>
<p>Account: {{accountName}}</p>
<p>Contact: {{contactName}}</p>
<p>Reason: {{reason}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'purchaseOrderDefault',
    name: 'Purchase Order — default',
    targetEntity: 'PurchaseOrder',
    subject: 'Purchase Order {{number}} — {{supplierName}}',
    body: `
<h2>Purchase Order {{number}}</h2>
<p>Date: {{date}}</p>
<p>Supplier: {{supplierName}}</p>
<p>Expected delivery: {{expectedDeliveryDate}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Gross total: {{totals.grossTotal}} {{currency}}</p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'receiptOrderDefault',
    name: 'Receipt Order — default',
    targetEntity: 'ReceiptOrder',
    subject: 'Receipt Order {{number}} — {{supplierName}}',
    body: `
<h2>Receipt Order {{number}}</h2>
<p>Date: {{date}}</p>
<p>Supplier: {{supplierName}}</p>
<p>Warehouse: {{warehouseId}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Received quantity</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'billDefault',
    name: 'Supplier Bill — default',
    targetEntity: 'Bill',
    subject: 'Bill {{number}} — {{supplierName}}',
    body: `
<h2>Supplier Bill {{number}}</h2>
<p>Bill date: {{date}}</p>
<p>Due date: {{dueDate}}</p>
<p>Supplier: {{supplierName}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{unitPrice}} {{currency}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Gross total: {{totals.grossTotal}} {{currency}}</p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
  {
    code: 'billCreditDefault',
    name: 'Bill Credit — default',
    targetEntity: 'BillCredit',
    subject: 'Bill Credit {{number}} — {{supplierName}}',
    body: `
<h2>Bill Credit {{number}}</h2>
<p>Date: {{date}}</p>
<p>Supplier: {{supplierName}}</p>
<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Line total</th></tr></thead>
  <tbody>
  {{#each lines}}
    <tr>
      <td>{{name}}</td>
      <td>{{sku}}</td>
      <td>{{quantity}}</td>
      <td>{{lineTotal}} {{currency}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>
<h3>Totals</h3>
<p>Gross total: {{totals.grossTotal}} {{currency}}</p>
` as const,
    format: 'html',
    locale: null,
    active: true,
    isDefault: false,
  },
];
