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
    exchangeRate: z
      .object({
        documentCurrency: z.string().trim().min(3).max(3),
        baseCurrency: z.string().trim().min(3).max(3),
        rate: DecimalStringSchema,
        rateDate: DaySchema,
        source: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SalesSettingsPatchSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------------------------
// Phase 19-S.6 – 19-S.12 — commercial document commands
// ---------------------------------------------------------------------------------------------

/** One requested line. The same shape the totals preview accepts; reused, not duplicated. */
export const DocumentLineSchema = PreviewLineSchema;

export const DocumentKindSchema = z.enum(IMPLEMENTED_DOCUMENT_KINDS);

/** Header fields are free-form on purpose: the descriptor decides which ones a kind understands, and
 *  the engine refuses any field the server owns. `items` may be empty while a draft is prepared. */
export const CreateDocumentSchema = z
  .object({
    kind: DocumentKindSchema,
    data: z.record(z.string(), z.unknown()).optional(),
    items: z.array(DocumentLineSchema).max(500).default([]),
    correlationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const UpdateDocumentSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).optional(),
    items: z.array(DocumentLineSchema).max(500).optional(),
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
    reference: z.string().trim().min(1).max(128).nullish(),
    memo: z.string().trim().max(2000).nullish(),
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
    reference: z.string().trim().min(1).max(128).nullish(),
    memo: z.string().trim().max(2000).nullish(),
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
export type PreviewTotalsInput = z.infer<typeof PreviewTotalsSchema>;
