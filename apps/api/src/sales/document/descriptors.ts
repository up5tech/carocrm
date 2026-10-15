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
 * Purchasing kinds (`purchaseOrder`, `receiptOrder`, `bill`, `billCredit`) already have a lock policy
 * in `lock.ts` but no descriptor yet: they arrive with 19-S.13, together with their entities.
 */

/** The document kinds this module actually serves today, in the order the plan delivers them. */
export const IMPLEMENTED_DOCUMENT_KINDS = [
  "quote",
  "salesOrder",
  "invoice",
  "creditNote",
  "deliveryOrder",
  "returnOrder",
] as const;

export type ImplementedDocumentKind =
  (typeof IMPLEMENTED_DOCUMENT_KINDS)[number];

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
  /** Dedicated permission, on top of the entity's normal `edit` access. */
  readonly permission?: string;
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
}

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
    },
    {
      action: "convertToDeliveryOrder",
      label: "Create delivery order",
      toKind: "deliveryOrder",
      from: ["confirmed", "partiallyFulfilled"],
      copyFields: [...PARTY_FIELDS, "warehouseId"],
    },
  ],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
  dateField: "orderDate",
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
  conversions: [],
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
      from: ["draft", "confirmed"],
      to: "cancelled",
      requiresReason: true,
    },
  ],
  conversions: [],
  lockPolicy: DEFAULT_LOCK_POLICY,
  minItems: 1,
  maxItems: MAX_ITEMS,
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
  dateField: "returnDate",
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
