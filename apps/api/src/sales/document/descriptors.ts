import { ValidationError } from "@carocrm/core/errors/index.js";

import type { SalesEntityType } from "../sales-records.js";
import { DEFAULT_LOCK_POLICY, type DocumentLockPolicy } from "./lock.js";

/**
 * Phase 19-S.6 — the document-type descriptors every commercial document is driven by.
 *
 * Quotes, sales orders, invoices, credit notes, delivery orders and return orders do **not** share one
 * status machine (PLAN_Phase_19_Sales.md §4.4: "Each document type must own its allowed transitions
 * and its own validation"), but they do share the same *shape* of problem: an entity, a child item
 * entity, a number series, a set of states, a set of named transitions, and the conversions that may
 * produce another document from them.
 *
 * That shape is data. Declaring it here — instead of writing six near-identical services — is what
 * lets `SalesDocumentService` implement create/update/recalculate/transition/issue/lock/unlock once,
 * while each document type still owns its own states and its own rules. Adding a document type is
 * adding a descriptor, not a new copy of the engine.
 *
 * Purchasing kinds (`purchaseOrder`, `receiptOrder`, `bill`, `billCredit`) are the same shape of
 * problem with the supplier in the account's seat: an entity, child items, a number series, states,
 * transitions and conversions (§4.12). The descriptor registry is what makes adding all four a
 * matter of data rather than four more services.
 */

/** The document kinds this module actually serves today, in the order the plan delivers them. */
export const IMPLEMENTED_DOCUMENT_KINDS = [
  "quote",
  "salesOrder",
  "invoice",
  "creditNote",
  "deliveryOrder",
  "returnOrder",
  "purchaseOrder",
  "receiptOrder",
  "bill",
  "billCredit",
] as const;

export type ImplementedDocumentKind =
  (typeof IMPLEMENTED_DOCUMENT_KINDS)[number];

/**
 * The kinds that belong to the purchasing half of the module, gated by the `purchases` feature
 * (§4.13 "each sub-module gated by settings and permissions").
 */
export const PURCHASING_KINDS: readonly ImplementedDocumentKind[] = [
  "purchaseOrder",
  "receiptOrder",
  "bill",
  "billCredit",
];

/**
 * The kinds whose confirmation stands for a physical stock change: a sale order reserves, a delivery
 * ships out, a return and a receipt bring goods in (§4.10, §4.12). With `features.inventory` on the
 * ledger applies the movement the snapshot froze (19-S.14); a confirmation it cannot honour — no stock
 * managed for the product, an over-issue, an unavailable warehouse — is refused rather than pretended.
 */
export const STOCK_MOVING_KINDS: readonly ImplementedDocumentKind[] = [
  "salesOrder",
  "deliveryOrder",
  "returnOrder",
  "receiptOrder",
];

const IMPLEMENTED_SET: ReadonlySet<string> = new Set(
  IMPLEMENTED_DOCUMENT_KINDS,
);

export function isImplementedDocumentKind(
  value: string,
): value is ImplementedDocumentKind {
  return IMPLEMENTED_SET.has(value);
}

/**
 * One named state change. `from` lists every state it may start in — a transition is refused from any
 * other state, which is what makes the machine a machine instead of a free-form status field.
 */
export interface DocumentTransition {
  readonly action: string;
  readonly label: string;
  readonly from: readonly string[];
  readonly to: string;
  /**
   * Marks the transition that **issues** the document: it validates and recalculates, captures the
   * immutable snapshot, allocates the official number, records issuer/time, applies the lock policy
   * and writes the outbox event — all in one transaction (§4.7).
   */
  readonly issues?: boolean;
  /** A privileged correction (void, unlock-style actions) that must carry an audit reason. */
  readonly requiresReason?: boolean;
}

/** A supported source → destination conversion. */
export interface DocumentConversion {
  readonly action: string;
  readonly label: string;
  readonly toKind: ImplementedDocumentKind;
  /** Source states that allow the conversion. */
  readonly from: readonly string[];
  /**
   * Fields copied **by value** into the destination. Everything else is either recomputed or taken
   * from the caller, so the destination never depends on the source staying unchanged (§4.6).
   */
  readonly copyFields: readonly string[];
  /**
   * A destination field that links back to the source row by id — the provenance link an issued
   * credit note keeps to the invoice it credits (§4.9), and the link a delivery order keeps to the
   * order line it moves against (§4.10).
   */
  readonly linkToSource?: { readonly field: string };
}

export interface SalesDocumentDescriptor {
  readonly kind: ImplementedDocumentKind;
  readonly label: string;
  /** Metadata entity served by the Entity Engine. */
  readonly entity: SalesEntityType;
  /** Child item entity; items are real records, not an opaque JSON blob (§4.4). */
  readonly itemEntity: SalesEntityType;
  /** Item field that points back at the document. */
  readonly itemParentField: string;
  /** `sales_number_series.code` this kind allocates from. */
  readonly seriesCode: string;
  readonly states: readonly string[];
  readonly initialState: string;
  readonly transitions: readonly DocumentTransition[];
  readonly conversions: readonly DocumentConversion[];
  readonly lockPolicy: DocumentLockPolicy;
  readonly minItems: number;
  readonly maxItems: number;
  /** The document's own date field, used as the pricing/tax effective date. */
  readonly dateField: string;
  /**
   * The field a due date is written to, when the kind has one (19-S.9). The engine fills it from the
   * referenced `PaymentTermProfile` whenever the caller did not supply one, so a due date is never
   * left to an operator's arithmetic.
   */
  readonly dueDateField?: string;
  /**
   * True for the kinds one source can produce more than once, because each one moves part of it: a
   * sales order ships in several deliveries, a purchase order arrives in several receipts (§4.10,
   * §4.12). For every other kind a second generated document is the same commercial act twice, and
   * the conversion refuses it; what bounds these is the remaining-quantity guard, not the count.
   */
  readonly multipleFromSource?: boolean;
  /**
   * The field that links this kind back to the CRM **Opportunity** it was raised from (19-S.7,
   * §4.5 "create quotes … from an Opportunity").
   *
   * Only the kinds whose entity carries that link declare it. A document that has no such field still
   * records its provenance in `sourceEntity`/`sourceId` — the same two columns every generated
   * document uses — but the Opportunity's own relationship panel can only list the kinds that point
   * back at it, which is why an invoice raised from a deal is documented as visible from the invoice
   * and not from the deal.
   */
  readonly opportunityField?: string;
}

/**
 * The kinds an Opportunity may be turned into a draft of (§4.5 quotes, §4.6 sales orders, §4.7
 * invoices). Purchase-side kinds are absent: a supplier is not a deal.
 */
export const OPPORTUNITY_SOURCE_KINDS: readonly ImplementedDocumentKind[] = [
  "quote",
  "salesOrder",
  "invoice",
];

/** The CRM Core entity an Opportunity-sourced document records as its source. */
export const OPPORTUNITY_ENTITY = "Opportunity";

/** Fields every commercial document copies from its source; each descriptor may extend it. */
const PARTY_FIELDS: readonly string[] = [
  "accountId",
  "contactId",
  "currency",
  "priceBookId",
  "paymentTermId",
  "shippingAddress",
  "billingAddress",
  "shippingAmount",
  "documentDiscountAmount",
];

/**
 * The purchasing equivalent (§4.12): a supplier instead of an account, and no price book — a
 * purchase price is a `SupplierProductPrice`, never a sales one. The distinction is what keeps
 * supplier prices out of sales pricing: the two field lists do not overlap except in the terms and
 * addresses that both sides genuinely share.
 */
const PURCHASE_PARTY_FIELDS: readonly string[] = [
  "supplierId",
  "currency",
  "paymentTermId",
  "shippingAddress",
  "billingAddress",
  "shippingAmount",
  "documentDiscountAmount",
];

const MAX_ITEMS = 500;

/**
 * Quote — §4.5.
 *
 * `send` issues the quote: it takes the number, captures the snapshot and locks the commercial fields,
 * because what was emailed must not change silently afterwards. A later revision is either a
 * privileged unlock (audited, with a reason) or a new quote — never a quiet edit.
 */
const QUOTE: SalesDocumentDescriptor = {
  kind: "quote",
  label: "Quote",
  entity: "Quote",
  itemEntity: "QuoteItem",
  itemParentField: "quoteId",
  seriesCode: "quote",
  states: [
    "draft",
    "sent",
    "accepted",
    "rejected",
    "expired",
    "converted",
    "cancelled",
  ],
  initialState: "draft",
  transitions: [
    {
      action: "send",
      label: "Send",
      from: ["draft"],
      to: "sent",
      issues: true,
    },
    { action: "accept", label: "Accept", from: ["sent"], to: "accepted" },
    { action: "reject", label: "Reject", from: ["sent"], to: "rejected" },
    { action: "expire", label: "Expire", from: ["sent"], to: "expired" },
    {
      action: "cancel",
      label: "Cancel",
      from: ["draft", "sent"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      action: "convertToOrder",
      label: "Convert to sales order",
      toKind: "salesOrder",
      from: ["accepted"],
      copyFields: [...PARTY_FIELDS, "opportunityId", "validUntil"],
    },
    {
      // §4.7 lists a quote as a valid invoice source. The service refuses this while a generated sales
      // order exists, because invoicing from both sides of the same acceptance is double billing.
      action: "convertToInvoice",
      label: "Create invoice",
      toKind: "invoice",
      from: ["accepted"],
      copyFields: [...PARTY_FIELDS, "opportunityId"],
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "quoteDate",
  opportunityField: "opportunityId",
};

/** Sales order — §4.6. Confirmation issues the order and freezes what was promised. */
const SALES_ORDER: SalesDocumentDescriptor = {
  kind: "salesOrder",
  label: "Sales Order",
  entity: "SalesOrder",
  itemEntity: "SalesOrderItem",
  itemParentField: "salesOrderId",
  seriesCode: "salesOrder",
  states: [
    "draft",
    "confirmed",
    "partiallyFulfilled",
    "fulfilled",
    "cancelled",
  ],
  initialState: "draft",
  transitions: [
    {
      action: "confirm",
      label: "Confirm",
      from: ["draft"],
      to: "confirmed",
      issues: true,
    },
    {
      action: "cancel",
      label: "Cancel",
      from: ["draft", "confirmed"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      action: "convertToInvoice",
      label: "Create invoice",
      toKind: "invoice",
      from: ["confirmed", "partiallyFulfilled", "fulfilled"],
      copyFields: [...PARTY_FIELDS, "opportunityId"],
      linkToSource: { field: "salesOrderId" },
    },
    {
      action: "convertToDeliveryOrder",
      label: "Create delivery order",
      toKind: "deliveryOrder",
      from: ["confirmed", "partiallyFulfilled"],
      copyFields: [...PARTY_FIELDS, "warehouseId"],
      linkToSource: { field: "salesOrderId" },
    },
    {
      // A return against the order rather than one shipment: what bounds it is what was delivered,
      // not what was ordered (§4.10).
      action: "convertToReturnOrder",
      label: "Create return order",
      toKind: "returnOrder",
      from: ["confirmed", "partiallyFulfilled", "fulfilled"],
      copyFields: [...PARTY_FIELDS, "warehouseId"],
      linkToSource: { field: "salesOrderId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "orderDate",
  opportunityField: "opportunityId",
};

/**
 * Invoice — §4.7. Issuance is the one transaction that matters most: validate, recalculate, snapshot
 * parties/lines/tax/rates, allocate the number, record issuer and time, apply the lock, emit the
 * event. Document state and payment state stay separate concepts: `status` never stands in for
 * "paid", which is a derived `paymentStatus` maintained by the allocation services.
 */
const INVOICE: SalesDocumentDescriptor = {
  kind: "invoice",
  label: "Invoice",
  entity: "Invoice",
  itemEntity: "InvoiceItem",
  itemParentField: "invoiceId",
  seriesCode: "invoice",
  states: ["draft", "issued", "voided"],
  initialState: "draft",
  transitions: [
    {
      action: "issue",
      label: "Issue",
      from: ["draft"],
      to: "issued",
      issues: true,
    },
    {
      action: "void",
      label: "Void",
      from: ["issued"],
      to: "voided",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      action: "convertToCreditNote",
      label: "Create credit note",
      toKind: "creditNote",
      from: ["issued"],
      copyFields: [...PARTY_FIELDS],
      linkToSource: { field: "invoiceId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "invoiceDate",
  dueDateField: "dueDate",
};

/** Credit note — §4.9. Reduces a receivable through an explicit allocation, never a silent edit. */
const CREDIT_NOTE: SalesDocumentDescriptor = {
  kind: "creditNote",
  label: "Credit Note",
  entity: "CreditNote",
  itemEntity: "CreditNoteItem",
  itemParentField: "creditNoteId",
  seriesCode: "creditNote",
  states: ["draft", "issued", "voided"],
  initialState: "draft",
  transitions: [
    {
      action: "issue",
      label: "Issue",
      from: ["draft"],
      to: "issued",
      issues: true,
    },
    {
      action: "void",
      label: "Void",
      from: ["issued"],
      to: "voided",
      requiresReason: true,
    },
  ],
  conversions: [],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "creditDate",
};

/** Delivery order — §4.10. Confirmation is the stock-moving action and is idempotent. */
const DELIVERY_ORDER: SalesDocumentDescriptor = {
  kind: "deliveryOrder",
  label: "Delivery Order",
  entity: "DeliveryOrder",
  itemEntity: "DeliveryOrderItem",
  itemParentField: "deliveryOrderId",
  seriesCode: "deliveryOrder",
  states: ["draft", "confirmed", "delivered", "cancelled"],
  initialState: "draft",
  transitions: [
    {
      action: "confirm",
      label: "Confirm shipment",
      from: ["draft"],
      to: "confirmed",
      issues: true,
    },
    {
      action: "markDelivered",
      label: "Mark delivered",
      from: ["confirmed"],
      to: "delivered",
    },
    {
      action: "cancel",
      label: "Cancel",
      // Confirmation is the stock-moving act, so it is not undone by a cancellation: the supported
      // correction is a return order, and the order's fulfilment stays what was delivered (§4.10).
      from: ["draft"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      // The customer sends part of a shipment back. The delivery's own order link is copied by value,
      // so the return keeps both references (§4.10).
      action: "convertToReturnOrder",
      label: "Create return order",
      toKind: "returnOrder",
      from: ["confirmed", "delivered"],
      copyFields: [...PARTY_FIELDS, "warehouseId", "salesOrderId"],
      linkToSource: { field: "deliveryOrderId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  multipleFromSource: true,
  dateField: "deliveryDate",
};

/** Return order — §4.10. Confirmation records the return; restocking follows the item disposition. */
const RETURN_ORDER: SalesDocumentDescriptor = {
  kind: "returnOrder",
  label: "Return Order",
  entity: "ReturnOrder",
  itemEntity: "ReturnOrderItem",
  itemParentField: "returnOrderId",
  seriesCode: "returnOrder",
  states: ["draft", "confirmed", "cancelled"],
  initialState: "draft",
  transitions: [
    {
      action: "confirm",
      label: "Confirm return",
      from: ["draft"],
      to: "confirmed",
      issues: true,
    },
    {
      action: "cancel",
      label: "Cancel",
      from: ["draft"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  multipleFromSource: true,
  dateField: "returnDate",
};

/**
 * Purchase order — §4.12. Confirming is the organisation's commitment; the receipt state
 * (`partiallyReceived` / `received`) is **derived** from confirmed receipt orders, never typed.
 *
 * The permission boundary is the entity's own ACL: this command needs `edit` on `PurchaseOrder`, and
 * nothing else — receipt confirmation is `ReceiptOrder`, bill issue is `Bill`, payment is `Payment`,
 * so the five capabilities §4.12 separates are five independent grants rather than one flag.
 */
const PURCHASE_ORDER: SalesDocumentDescriptor = {
  kind: "purchaseOrder",
  label: "Purchase Order",
  entity: "PurchaseOrder",
  itemEntity: "PurchaseOrderItem",
  itemParentField: "purchaseOrderId",
  seriesCode: "purchaseOrder",
  states: ["draft", "confirmed", "partiallyReceived", "received", "cancelled"],
  initialState: "draft",
  transitions: [
    {
      action: "confirm",
      label: "Confirm",
      from: ["draft"],
      to: "confirmed",
      issues: true,
    },
    {
      action: "cancel",
      label: "Cancel",
      from: ["draft", "confirmed"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      action: "convertToReceiptOrder",
      label: "Create receipt order",
      toKind: "receiptOrder",
      from: ["confirmed", "partiallyReceived"],
      copyFields: [...PURCHASE_PARTY_FIELDS, "warehouseId"],
      linkToSource: { field: "purchaseOrderId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "orderDate",
};

/**
 * Receipt order — §4.12. Confirmation is the receiving event; it is what a purchase order's receipt
 * state is derived from, and the same confirmation guards against receiving more than a line ordered.
 */
const RECEIPT_ORDER: SalesDocumentDescriptor = {
  kind: "receiptOrder",
  label: "Receipt Order",
  entity: "ReceiptOrder",
  itemEntity: "ReceiptOrderItem",
  itemParentField: "receiptOrderId",
  seriesCode: "receiptOrder",
  states: ["draft", "confirmed", "cancelled"],
  initialState: "draft",
  transitions: [
    {
      action: "confirm",
      label: "Confirm receipt",
      from: ["draft"],
      to: "confirmed",
      issues: true,
    },
    {
      action: "cancel",
      label: "Cancel",
      from: ["draft"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      // The bill for what arrived. Both references travel: `purchaseOrderId` by value from the
      // receipt, `receiptOrderId` as the provenance link (§4.12 purchase-to-bill traceability).
      action: "convertToBill",
      label: "Create supplier bill",
      toKind: "bill",
      from: ["confirmed"],
      copyFields: [...PURCHASE_PARTY_FIELDS, "purchaseOrderId", "warehouseId"],
      linkToSource: { field: "receiptOrderId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  multipleFromSource: true,
  dateField: "receiptDate",
};

/**
 * Supplier bill — §4.12. Issued from a receipt order or on its own; `dueDate` comes from the payment
 * terms like every other payable, and what is still owed is a derived `amountDue` maintained by the
 * allocation services (19-S.10's machinery, with the supplier as the counterparty).
 */
const BILL: SalesDocumentDescriptor = {
  kind: "bill",
  label: "Bill",
  entity: "Bill",
  itemEntity: "BillItem",
  itemParentField: "billId",
  seriesCode: "bill",
  states: ["draft", "issued", "voided"],
  initialState: "draft",
  transitions: [
    {
      action: "issue",
      label: "Issue",
      from: ["draft"],
      to: "issued",
      issues: true,
    },
    {
      action: "void",
      label: "Void",
      from: ["issued"],
      to: "voided",
      requiresReason: true,
    },
  ],
  conversions: [
    {
      action: "convertToBillCredit",
      label: "Create bill credit",
      toKind: "billCredit",
      from: ["issued"],
      copyFields: [...PURCHASE_PARTY_FIELDS],
      linkToSource: { field: "billId" },
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "billDate",
  dueDateField: "dueDate",
};

/** Bill credit (a debit note) — §4.12. Reduces a payable through an explicit allocation, never an edit. */
const BILL_CREDIT: SalesDocumentDescriptor = {
  kind: "billCredit",
  label: "Bill Credit",
  entity: "BillCredit",
  itemEntity: "BillCreditItem",
  itemParentField: "billCreditId",
  seriesCode: "billCredit",
  states: ["draft", "issued", "voided"],
  initialState: "draft",
  transitions: [
    {
      action: "issue",
      label: "Issue",
      from: ["draft"],
      to: "issued",
      issues: true,
    },
    {
      action: "void",
      label: "Void",
      from: ["issued"],
      to: "voided",
      requiresReason: true,
    },
  ],
  conversions: [],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "creditDate",
};

export const DOCUMENT_DESCRIPTORS: Readonly<
  Record<ImplementedDocumentKind, SalesDocumentDescriptor>
> = {
  quote: QUOTE,
  salesOrder: SALES_ORDER,
  invoice: INVOICE,
  creditNote: CREDIT_NOTE,
  deliveryOrder: DELIVERY_ORDER,
  returnOrder: RETURN_ORDER,
  purchaseOrder: PURCHASE_ORDER,
  receiptOrder: RECEIPT_ORDER,
  bill: BILL,
  billCredit: BILL_CREDIT,
};

export function documentDescriptor(
  kind: ImplementedDocumentKind,
): SalesDocumentDescriptor {
  return DOCUMENT_DESCRIPTORS[kind];
}

/** The descriptor that owns an entity name, or `undefined` when the entity is not a document. */
export function descriptorForEntity(
  entity: string,
): SalesDocumentDescriptor | undefined {
  return IMPLEMENTED_DOCUMENT_KINDS.map(
    (kind) => DOCUMENT_DESCRIPTORS[kind],
  ).find((descriptor) => descriptor.entity === entity);
}

/** The transition a command names, or `undefined` when the document type has no such command. */
export function findTransition(
  descriptor: SalesDocumentDescriptor,
  action: string,
): DocumentTransition | undefined {
  return descriptor.transitions.find(
    (transition) => transition.action === action,
  );
}

/** The conversion a command names, or `undefined`. */
export function findConversion(
  descriptor: SalesDocumentDescriptor,
  action: string,
): DocumentConversion | undefined {
  return descriptor.conversions.find(
    (conversion) => conversion.action === action,
  );
}

/**
 * Whether a transition may run from the document's current state. Returns the reason instead of a
 * bare `false`, because "why can't I confirm this order" is the question a user actually asks.
 */
export function transitionRefusal(
  descriptor: SalesDocumentDescriptor,
  action: string,
  currentState: string,
): string | null {
  const transition = findTransition(descriptor, action);
  if (transition === undefined) {
    return `A ${descriptor.label.toLowerCase()} has no "${action}" action.`;
  }
  if (!transition.from.includes(currentState)) {
    return `"${transition.label}" is not allowed from the "${currentState}" state of a ${descriptor.label.toLowerCase()}; allowed from: ${transition.from.join(", ")}.`;
  }
  return null;
}

/** Same question for a conversion, so the error names the state the user is stuck in. */
export function conversionRefusal(
  descriptor: SalesDocumentDescriptor,
  action: string,
  currentState: string,
): string | null {
  const conversion = findConversion(descriptor, action);
  if (conversion === undefined) {
    return `A ${descriptor.label.toLowerCase()} cannot be converted with "${action}".`;
  }
  if (!conversion.from.includes(currentState)) {
    return `"${conversion.label}" needs a ${descriptor.label.toLowerCase()} in one of these states: ${conversion.from.join(", ")}; this one is "${currentState}".`;
  }
  return null;
}

/** Every conversion that targets a kind, used to reject an unsupported destination early. */
export function conversionsToKind(
  toKind: ImplementedDocumentKind,
): readonly {
  readonly from: SalesDocumentDescriptor;
  readonly conversion: DocumentConversion;
}[] {
  const found: {
    from: SalesDocumentDescriptor;
    conversion: DocumentConversion;
  }[] = [];
  for (const descriptor of IMPLEMENTED_DOCUMENT_KINDS.map(
    (kind) => DOCUMENT_DESCRIPTORS[kind],
  )) {
    for (const conversion of descriptor.conversions) {
      if (conversion.toKind === toKind)
        found.push({ from: descriptor, conversion });
    }
  }
  return found;
}

/** Narrow an arbitrary string to an implemented kind, refusing anything else with a clear message. */
export function requireDocumentKind(value: string): ImplementedDocumentKind {
  if (!isImplementedDocumentKind(value)) {
    throw new ValidationError(
      `"${value}" is not an implemented Sales document kind.`,
      {
        kind: value,
        implemented: IMPLEMENTED_DOCUMENT_KINDS,
      },
    );
  }
  return value;
}
