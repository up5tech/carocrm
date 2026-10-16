import { z } from "zod";

import { IMPLEMENTED_DOCUMENT_KINDS } from "../document/descriptors.js";

/**
 * Phase 19-S.2 – 19-S.5 — request shapes for the `/api/v1/Sales` domain commands.
 *
 * Validation happens here, at the boundary, and nowhere trusts a client-submitted total or price
 * (PLAN_Phase_19_Sales.md §7.3). Monetary and quantity values are canonical decimal strings; the
 * domain services parse them with the exact decimal engine, so a JSON `number` never reaches money
 * arithmetic.
 */

/** A canonical decimal string: optional sign, digits, optional fraction, no exponent. */
export const DecimalStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^-?\d+(\.\d+)?$/,
    'Must be a canonical decimal string like "10" or "10.25".',
  );

const DaySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date.");

export const ResolvePriceSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    quantity: DecimalStringSchema.optional(),
    currency: z.string().trim().min(3).max(3).optional(),
    accountId: z.string().trim().min(1).max(64).nullish(),
    priceBookId: z.string().trim().min(1).max(64).nullish(),
    date: DaySchema.optional(),
    explicitPrice: DecimalStringSchema.nullish(),
  })
  .strict();

/**
 * The **buying** price of one product from one supplier (19-S.13). A separate command from
 * `resolvePrice` on purpose: the two read different entities and must never fall through to each
 * other, so a supplier price cannot become a sales price by an accidental fallback.
 */
export const ResolveSupplierPriceSchema = z
  .object({
    supplierId: z.string().trim().min(1).max(64),
    productId: z.string().trim().min(1).max(64),
    quantity: DecimalStringSchema.optional(),
    currency: z.string().trim().min(3).max(3).nullish(),
    date: DaySchema.optional(),
  })
  .strict();

export const BulkPriceUpdateSchema = z
  .object({
    mode: z.enum(["preview", "apply"]),
    priceBookId: z.string().trim().min(1).max(64),
    adjustment: z
      .object({
        type: z.enum(["percent", "fixed", "set"]),
        value: DecimalStringSchema,
      })
      .strict(),
    productIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
    categoryIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * The conversion snapshot a caller may freeze on a money-bearing record (§4.13). The convention is
 * stated once in `money/currency.ts`: `rate` is base-currency units per one document-currency unit.
 */
export const ExchangeRateInputSchema = z
  .object({
    documentCurrency: z.string().trim().min(3).max(3),
    baseCurrency: z.string().trim().min(3).max(3),
    rate: DecimalStringSchema,
    rateDate: DaySchema,
    source: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type ExchangeRateInputDto = z.infer<typeof ExchangeRateInputSchema>;

const PreviewLineSchema = z
  .object({
    productId: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    sku: z.string().trim().min(1).max(64).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
    quantity: DecimalStringSchema,
    unitPrice: DecimalStringSchema,
    discountPercent: DecimalStringSchema.optional(),
    discountAmount: DecimalStringSchema.optional(),
    taxCodeId: z.string().trim().min(1).max(64).optional(),
    taxRatePercent: DecimalStringSchema.optional(),
  })
  .strict();

export const PreviewTotalsSchema = z
  .object({
    currency: z.string().trim().min(3).max(3).optional(),
    date: DaySchema.optional(),
    taxInclusive: z.boolean().optional(),
    accountId: z.string().trim().min(1).max(64).nullish(),
    jurisdiction: z.string().trim().min(1).max(120).nullish(),
    lines: z.array(PreviewLineSchema).min(1).max(500),
    shipping: z
      .object({
        amount: DecimalStringSchema,
        taxCodeId: z.string().trim().min(1).max(64).nullish(),
      })
      .strict()
      .optional(),
    documentDiscountAmount: DecimalStringSchema.optional(),
    exchangeRate: ExchangeRateInputSchema.optional(),
  })
  .strict();

export const SalesSettingsPatchSchema = z.record(z.string(), z.unknown());

/**
 * The serials a line names (19-S.15): the array the API sends, or the JSON text a stored line holds.
 * Membership and count rules belong to the domain (`picking.ts`), which refuses them with the reason
 * the operator needs; this only bounds the shape.
 */
export const SerialNumbersInputSchema = z.union([
  z.array(z.string().trim().min(1).max(128)).max(1_000),
  z.string().max(64_000),
]);

// ---------------------------------------------------------------------------------------------
// Phase 19-S.6 – 19-S.13 — commercial document commands
// ---------------------------------------------------------------------------------------------

/** One requested line. The same shape the totals preview accepts, plus the kind-specific facts. */
export const DocumentLineSchema = PreviewLineSchema.extend({
  /**
   * The source document's line this line moves against. A conversion writes it automatically; an
   * operator editing a partial delivery or receipt names it, because without it there is no line to
   * bound the quantity against (§4.10, §4.12).
   */
  sourceItemId: z.string().trim().min(1).max(64).optional(),
  /** A return line's restock disposition — the only one that may bring stock back (19-S.12). */
  disposition: z.enum(["restock", "scrap", "quarantine"]).optional(),
  /** Which supplier price a purchasing line was agreed at (19-S.13). Never a sales price. */
  supplierProductPriceId: z.string().trim().min(1).max(64).optional(),
  /** 19-S.15 stock identity: the lot, the units, and the lot dates a receipt records. */
  batchNumber: z.string().trim().min(1).max(64).optional(),
  serialNumber: z.string().trim().min(1).max(128).optional(),
  serialNumbers: SerialNumbersInputSchema.optional(),
  manufacturingDate: DaySchema.optional(),
  expiryDate: DaySchema.optional(),
});

export const DocumentKindSchema = z.enum(IMPLEMENTED_DOCUMENT_KINDS);

/** Header fields are free-form on purpose: the descriptor decides which ones a kind understands, and
 *  the engine refuses any field the server owns. `items` may be empty while a draft is prepared. */
export const CreateDocumentSchema = z
  .object({
    kind: DocumentKindSchema,
    data: z.record(z.string(), z.unknown()).optional(),
    items: z.array(DocumentLineSchema).max(500).default([]),
    /**
     * The conversion to freeze on this document (§4.13). It is a command field rather than a `data`
     * key because `data` carries only editable header fields and the snapshot is server-owned: the
     * engine validates it, stores it as `exchangeRateSnapshot`, and every later recalculation reuses
     * *this* rate rather than a newer one.
     */
    exchangeRate: ExchangeRateInputSchema.optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const UpdateDocumentSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).optional(),
    items: z.array(DocumentLineSchema).max(500).optional(),
    /** Supplying a rate replaces the frozen one; omitting it keeps what the record already has. */
    exchangeRate: ExchangeRateInputSchema.optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const DocumentTransitionSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    /** Required by the transitions that correct or cancel something already issued. */
    reason: z.string().trim().min(1).max(500).optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const DocumentUnlockSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/**
 * Expire the quotes whose validity window has passed (19-S.7). `today` is injectable so the behaviour
 * can be exercised without waiting for a clock.
 */
export const ExpireQuotesSchema = z
  .object({ today: DaySchema.optional() })
  .strict();

/** The date-driven operations all take the same shape: an optional day, so they are testable. */
export const TodaySchema = z.object({ today: DaySchema.optional() }).strict();

export const DocumentConvertSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    /** The idempotency key: the same value twice returns the document that already exists. */
    correlationId: z.string().trim().min(1).max(128).optional(),
    /** Values the destination takes from the caller rather than the source (a date, a warehouse). */
    overrides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Phase 19-S.7 — rendering and sending a quote
// ---------------------------------------------------------------------------------------------

/**
 * Addresses are deliberately **not** validated here. The mail transport's own parser
 * (`@carocrm/mail`) is the single authority on what an address is, and it rejects an unusable one with
 * a clear 422 when the send is queued — duplicating the rule here would only let the two disagree.
 */
const AddressListSchema = z.array(z.string().trim().min(3).max(320)).max(50);

/** Render a quote against a template; the response is the preview the UI shows before sending. */
export const RenderQuoteSchema = z
  .object({
    /** The `DocumentTemplate` code; the entity type's default is used when omitted. */
    templateCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** Render a credit note against a `DocumentTemplate` (or the built-in block layout). */
export const RenderCreditNoteSchema = z
  .object({
    /** The `DocumentTemplate` code; the `CreditNote` default is used when omitted. */
    templateCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** Send a quote: issue it if it is still a draft, then email it through the mail module. */
export const SendQuoteSchema = z
  .object({
    to: AddressListSchema.optional(),
    cc: AddressListSchema.optional(),
    bcc: AddressListSchema.optional(),
    templateCode: z.string().trim().min(1).max(64).optional(),
    subject: z.string().trim().min(1).max(998).optional(),
    /** A covering note prepended to the rendered document. */
    message: z.string().trim().min(1).max(5000).optional(),
    /** Sending mailbox; the configured default account is used when omitted. */
    emailAccountId: z.string().trim().min(1).max(64).optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
    /** Attach a rendered PDF of the issued quote to the stored email (19-S.7 task 5). */
    attachPdf: z.boolean().optional(),
  })
  .strict();

export type DocumentLineInput = z.infer<typeof DocumentLineSchema>;
export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
export type DocumentTransitionInput = z.infer<typeof DocumentTransitionSchema>;
export type DocumentConvertInput = z.infer<typeof DocumentConvertSchema>;

// ---------------------------------------------------------------------------------------------
// Phase 19-S.10 — payment commands
// ---------------------------------------------------------------------------------------------

const IdSchema = z.string().trim().min(1).max(64);

export const CreatePaymentSchema = z
  .object({
    amount: DecimalStringSchema,
    currency: z.string().trim().min(3).max(3).optional(),
    direction: z.enum(["incoming", "outgoing"]),
    date: DaySchema.optional(),
    paymentMethodId: IdSchema.nullish(),
    paymentChannelId: IdSchema.nullish(),
    accountId: IdSchema.nullish(),
    contactId: IdSchema.nullish(),
    /** The payee of an outgoing payment (§4.12). */
    supplierId: IdSchema.nullish(),
    reference: z.string().trim().min(1).max(128).nullish(),
    memo: z.string().trim().max(2000).nullish(),
    /**
     * The conversion to freeze on this payment (§4.13, 19-S.18). Without it the payment is money in
     * its own currency and no base-currency figure is claimed for it.
     */
    exchangeRate: ExchangeRateInputSchema.optional(),
  })
  .strict();

/** A payment patch. Amount and currency are refused by the service once allocations exist. */
export const UpdatePaymentSchema = z
  .object({
    amount: DecimalStringSchema.optional(),
    paymentDate: DaySchema.optional(),
    paymentMethodId: IdSchema.nullish(),
    paymentChannelId: IdSchema.nullish(),
    accountId: IdSchema.nullish(),
    contactId: IdSchema.nullish(),
    supplierId: IdSchema.nullish(),
    reference: z.string().trim().min(1).max(128).nullish(),
    memo: z.string().trim().max(2000).nullish(),
    /** Replaces the frozen snapshot — only while the payment still has no allocations. */
    exchangeRate: ExchangeRateInputSchema.optional(),
  })
  .strict();

export const AllocatePaymentSchema = z
  .object({
    documentId: IdSchema,
    documentEntity: z.string().trim().min(1).max(64).optional(),
    amount: DecimalStringSchema,
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const PaymentTransferSchema = z
  .object({ toPaymentId: IdSchema, amount: DecimalStringSchema })
  .strict();

export const PaymentTransitionSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const CreatePaymentRequestSchema = z
  .object({
    amount: DecimalStringSchema,
    currency: z.string().trim().min(3).max(3).optional(),
    accountId: IdSchema,
    invoiceId: IdSchema.nullish(),
    salesOrderId: IdSchema.nullish(),
    expiresAt: DaySchema.nullish(),
    providerReference: z.string().trim().min(1).max(128).nullish(),
  })
  .strict();

/**
 * A provider event. The payload is a **summary**: the service refuses any key that looks like card
 * data, a mandate or a reusable secret, so a CRM never becomes the place that holds them.
 */
export const ProviderEventSchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    providerEventId: z.string().trim().min(1).max(191),
    eventType: z.string().trim().min(1).max(128),
    paymentRequestId: IdSchema.nullish(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * 19-S.19 — the two read contracts other modules call (§11.3, §11.4). Both are read-only and both are
 * answered with `contractVersion`, so a consumer can tell whether it is speaking to a shape it was
 * written against.
 */
export const SalesCustomerSummarySchema = z
  .object({ accountId: IdSchema })
  .strict();

export const SalesAccountingExportSchema = z
  .object({
    kind: DocumentKindSchema,
    id: IdSchema,
  })
  .strict();

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof UpdatePaymentSchema>;
export type AllocatePaymentInput = z.infer<typeof AllocatePaymentSchema>;
export type PaymentTransferInput = z.infer<typeof PaymentTransferSchema>;
export type PaymentTransitionInput = z.infer<typeof PaymentTransitionSchema>;
export type CreatePaymentRequestInput = z.infer<
  typeof CreatePaymentRequestSchema
>;
export type ProviderEventInput = z.infer<typeof ProviderEventSchema>;

export type ResolvePriceInput = z.infer<typeof ResolvePriceSchema>;
export type BulkPriceUpdateInput = z.infer<typeof BulkPriceUpdateSchema>;

// ---------------------------------------------------------------------------------------------
// Phase 19-S.11 — credit notes and write-offs
// ---------------------------------------------------------------------------------------------

/** Allocate part of a credit note (id in the path) to one issued invoice. */
export const CreditNoteAllocateSchema = z
  .object({
    invoiceId: z.string().trim().min(1).max(64),
    amount: DecimalStringSchema,
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** Request a write-off; the reason is required and stays on the record (§4.9). */
export const WriteOffCreateSchema = z
  .object({
    invoiceId: z.string().trim().min(1).max(64),
    amount: DecimalStringSchema,
    reason: z.string().trim().min(1).max(255),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const WriteOffApproveSchema = z
  .object({
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** A rejection note is optional; the decision itself is audited either way. */
export const WriteOffRejectSchema = z
  .object({
    reason: z.string().trim().min(1).max(255).optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** Undoing an approved write-off is a privileged correction, so its reason is mandatory. */
export const WriteOffReverseSchema = z
  .object({
    reason: z.string().trim().min(1).max(255),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** Reversing a credit-note allocation records an optional reason in the audit trail. */
export const CreditNoteUnallocateSchema = z
  .object({
    reason: z.string().trim().min(1).max(255).optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type CreditNoteAllocateInput = z.infer<typeof CreditNoteAllocateSchema>;

// ---------------------------------------------------------------------------------------------
// Phase 19-S.13 — purchasing: the receipt state, supplier bills and the credits that reduce them
// ---------------------------------------------------------------------------------------------

/** Allocate part of an issued bill credit (id in the path) to one issued bill. */
export const BillCreditAllocateSchema = z
  .object({
    billId: IdSchema,
    amount: DecimalStringSchema,
    correlationId: IdSchema.optional(),
  })
  .strict();

/** Reversing a bill-credit allocation records an optional reason, like its customer-side twin. */
export const BillCreditUnallocateSchema = z
  .object({
    reason: z.string().trim().min(1).max(255).optional(),
    correlationId: IdSchema.optional(),
  })
  .strict();

/** Render any commercial document kind against a template, or the built-in block layout. */
export const RenderDocumentSchema = z
  .object({
    /** The `DocumentTemplate` code; the entity type's default is used when omitted. */
    templateCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type BillCreditAllocateInput = z.infer<typeof BillCreditAllocateSchema>;
export type BillCreditUnallocateInput = z.infer<typeof BillCreditUnallocateSchema>;
export type RenderDocumentInput = z.infer<typeof RenderDocumentSchema>;
export type WriteOffCreateInput = z.infer<typeof WriteOffCreateSchema>;
export type WriteOffApproveInput = z.infer<typeof WriteOffApproveSchema>;
export type WriteOffRejectInput = z.infer<typeof WriteOffRejectSchema>;
export type WriteOffReverseInput = z.infer<typeof WriteOffReverseSchema>;
export type CreditNoteUnallocateInput = z.infer<
  typeof CreditNoteUnallocateSchema
>;
export type PreviewTotalsInput = z.infer<typeof PreviewTotalsSchema>;

// ---------------------------------------------------------------------------------------------
// Phase 19-S.14 — inventory commands
// ---------------------------------------------------------------------------------------------

/** One transfer line. A positive magnitude; the direction is the transfer's, not the line's. */
export const TransferLineSchema = z
  .object({
    productId: IdSchema,
    quantity: DecimalStringSchema,
    name: z.string().trim().min(1).max(255).optional(),
    sku: z.string().trim().min(1).max(64).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
    /** 19-S.15: what travels — or nothing, and the removal policy picks at dispatch. */
    batchNumber: z.string().trim().min(1).max(64).optional(),
    serialNumbers: SerialNumbersInputSchema.optional(),
  })
  .strict();

/** Create a draft warehouse transfer; `confirm`/`receive` move each side. */
export const CreateTransferSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    sourceWarehouseId: IdSchema,
    destinationWarehouseId: IdSchema,
    transferDate: DaySchema.optional(),
    reason: z.string().trim().min(1).max(255).optional(),
    trackingNumber: z.string().trim().min(1).max(64).optional(),
    items: z.array(TransferLineSchema).min(1).max(500),
  })
  .strict();

/** `confirm` dispatches (source outflow), `receive` completes it, `cancel` needs a reason. */
export const TransferTransitionSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Request a stock correction. The reason is required; approval is a separate decision. */
export const CreateAdjustmentSchema = z
  .object({
    productId: IdSchema,
    quantityDelta: DecimalStringSchema,
    reason: z.string().trim().min(1).max(255),
    warehouseId: IdSchema.nullish(),
    /** 19-S.15: identity for a lot/serial-tracked product — required of an inbound correction. */
    batchNumber: z.string().trim().min(1).max(64).nullish(),
    serialNumbers: SerialNumbersInputSchema.nullish(),
  })
  .strict();

export const AdjustmentTransitionSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Place a reservation against a product/warehouse; the service applies the configured policy. */
export const ReserveStockSchema = z
  .object({
    productId: IdSchema,
    quantity: DecimalStringSchema,
    warehouseId: IdSchema.nullish(),
    sourceEntity: z.string().trim().min(1).max(64).nullish(),
    sourceId: IdSchema.nullish(),
    sourceNumber: z.string().trim().min(1).max(64).nullish(),
    expiresAt: DaySchema.nullish(),
  })
  .strict();

/** Release a reservation, freeing the stock it promised (id in the path). */
export const ReleaseReservationSchema = z
  .object({ reason: z.string().trim().min(1).max(255).optional() })
  .strict();

/** Compare the projection with the ledger, optionally narrowed to one warehouse/product. */
export const InventoryReconcileSchema = z
  .object({
    warehouseId: IdSchema.nullish(),
    productId: IdSchema.nullish(),
  })
  .strict();

export type TransferLineInput = z.infer<typeof TransferLineSchema>;
export type CreateTransferInput = z.infer<typeof CreateTransferSchema>;
export type TransferTransitionInput = z.infer<typeof TransferTransitionSchema>;
export type CreateAdjustmentInput = z.infer<typeof CreateAdjustmentSchema>;
export type AdjustmentTransitionInput = z.infer<
  typeof AdjustmentTransitionSchema
>;
export type ReserveStockInput = z.infer<typeof ReserveStockSchema>;
export type ReleaseReservationInput = z.infer<
  typeof ReleaseReservationSchema
>;
