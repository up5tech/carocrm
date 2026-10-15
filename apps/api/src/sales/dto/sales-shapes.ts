import { z } from 'zod';

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
  .regex(/^-?\d+(\.\d+)?$/, 'Must be a canonical decimal string like "10" or "10.25".');

const DaySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date.');

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
    mode: z.enum(['preview', 'apply']),
    priceBookId: z.string().trim().min(1).max(64),
    adjustment: z
      .object({
        type: z.enum(['percent', 'fixed', 'set']),
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

export type ResolvePriceInput = z.infer<typeof ResolvePriceSchema>;
export type BulkPriceUpdateInput = z.infer<typeof BulkPriceUpdateSchema>;
export type PreviewTotalsInput = z.infer<typeof PreviewTotalsSchema>;
