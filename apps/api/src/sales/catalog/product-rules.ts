import { ValidationError } from '@carocrm/core/errors/index.js';

import { normalizeCurrencyCode } from '../money/currency.js';
import { compare, isNegative, parseDecimal } from '../money/decimal.js';

/**
 * Phase 19-S.3 / 19-S.4 / 19-S.5 — pure catalog rules.
 *
 * Every rule here is a function of its inputs, so it can be unit-tested without a database and used
 * from the same three places with the same answer: the `beforeValidate` hook (a record save), a
 * domain command, and an admin preview. A rule that only lived in a controller would be a side door
 * through `PUT /api/v1/Product/:id` (PLAN_Phase_19_Sales.md §4.1, §4.4).
 */

export const PRODUCT_TYPES = ['Goods', 'Service'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** SKU format: starts alphanumeric, then letters/digits/`.`/`_`/`-`, up to 64 characters. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

export function validateSku(sku: string): string {
  const normalized = normalizeSku(sku);
  if (!SKU_PATTERN.test(normalized)) {
    throw new ValidationError('A SKU is 1–64 characters: letters, digits, dot, underscore or hyphen, starting alphanumeric.', { sku });
  }
  return normalized;
}

/** Any money-like field a catalog record carries is a canonical, non-negative decimal string. */
export function validateAmount(value: string, field: string): string {
  const parsed = parseDecimal(value);
  if (isNegative(parsed)) {
    throw new ValidationError(`"${field}" must not be negative.`, { field, value });
  }
  return value;
}

export function validateRatePercent(value: string, field = 'ratePercent'): string {
  const parsed = parseDecimal(value);
  if (isNegative(parsed) || compare(parsed, parseDecimal('100')) > 0) {
    throw new ValidationError(`"${field}" must be between 0 and 100.`, { field, value });
  }
  return value;
}

export function validateCurrency(value: string, field = 'currency'): string {
  try {
    return normalizeCurrencyCode(value);
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`"${field}" must be a supported currency code.`, { field, value });
    }
    throw error;
  }
}

export interface DateWindowInput {
  readonly effectiveFrom?: string | null | undefined;
  readonly effectiveTo?: string | null | undefined;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function validateDateWindow(input: DateWindowInput): void {
  const from = input.effectiveFrom ?? null;
  const to = input.effectiveTo ?? null;
  if (from !== null && !DATE_ONLY.test(from)) {
    throw new ValidationError('"effectiveFrom" must be a YYYY-MM-DD date.', { effectiveFrom: from });
  }
  if (to !== null && !DATE_ONLY.test(to)) {
    throw new ValidationError('"effectiveTo" must be a YYYY-MM-DD date.', { effectiveTo: to });
  }
  if (from !== null && to !== null && from > to) {
    throw new ValidationError('"effectiveFrom" must not be after "effectiveTo".', { effectiveFrom: from, effectiveTo: to });
  }
}

/** The catalog fields a write may carry; absent means "not being changed". */
export interface ProductWrite {
  readonly sku?: string | undefined;
  readonly productType?: string | undefined;
  readonly unitPrice?: string | undefined;
  readonly listPrice?: string | undefined;
  readonly costPrice?: string | undefined;
  readonly active?: boolean | undefined;
  readonly isSellable?: boolean | undefined;
  readonly isPurchasable?: boolean | undefined;
}

export function validateProductWrite(input: ProductWrite): void {
  if (input.sku !== undefined) validateSku(input.sku);
  if (input.productType !== undefined && !(PRODUCT_TYPES as readonly string[]).includes(input.productType)) {
    throw new ValidationError(`"productType" must be one of: ${PRODUCT_TYPES.join(', ')}.`, { productType: input.productType });
  }
  if (input.unitPrice !== undefined) validateAmount(input.unitPrice, 'unitPrice');
  if (input.listPrice !== undefined) validateAmount(input.listPrice, 'listPrice');
  if (input.costPrice !== undefined) validateAmount(input.costPrice, 'costPrice');
  for (const flag of ['active', 'isSellable', 'isPurchasable'] as const) {
    const value = input[flag];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new ValidationError(`"${flag}" must be a boolean.`, { field: flag, value: String(value) });
    }
  }
}

/** What a document line needs to know about a product before it may be added (§4.1 rules 1–2). */
export interface ProductGateInput {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly active: boolean;
  readonly isSellable: boolean;
  readonly isPurchasable: boolean;
}

export interface GateDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
}

const ALLOWED: GateDecision = { allowed: true, reason: null };

/** Never silently allow: every refusal names the reason the UI shows, and the API returns. */
export function salesGate(product: ProductGateInput): GateDecision {
  if (!product.active) return { allowed: false, reason: `Product "${product.name ?? product.id}" is inactive.` };
  if (!product.isSellable) return { allowed: false, reason: `Product "${product.name ?? product.id}" is not sellable.` };
  return ALLOWED;
}

export function purchaseGate(product: ProductGateInput): GateDecision {
  if (!product.active) return { allowed: false, reason: `Product "${product.name ?? product.id}" is inactive.` };
  if (!product.isPurchasable) return { allowed: false, reason: `Product "${product.name ?? product.id}" is not purchasable.` };
  return ALLOWED;
}

/**
 * Category hierarchy: a category cannot be its own parent, and it cannot be moved under one of its
 * own descendants. `ancestorIds` is the resolved chain of the *proposed parent* (parent, grandparent,
 * …); the check is pure so the caller only has to fetch the chain.
 */
export function validateCategoryParent(categoryId: string, parentId: string | null | undefined, ancestorIds: readonly string[]): void {
  if (parentId === null || parentId === undefined) return;
  if (parentId === categoryId) {
    throw new ValidationError('A product category cannot be its own parent.', { categoryId });
  }
  if (ancestorIds.includes(categoryId)) {
    throw new ValidationError('A product category cannot be moved under one of its own sub-categories.', {
      categoryId,
      parentId,
    });
  }
}

/** Max depth of the category tree; deep enough for real catalogs, shallow enough to bound a walk. */
export const MAX_CATEGORY_DEPTH = 32;

/** Price-book entries: an amount is required and valid, quantity breaks are positive, dates ordered. */
export interface PriceBookEntryWrite {
  readonly unitPrice?: string | undefined;
  readonly minQuantity?: string | undefined;
  readonly currency?: string | undefined;
  readonly effectiveFrom?: string | null | undefined;
  readonly effectiveTo?: string | null | undefined;
}

export function validatePriceBookEntryWrite(input: PriceBookEntryWrite): void {
  if (input.unitPrice !== undefined) validateAmount(input.unitPrice, 'unitPrice');
  if (input.currency !== undefined) validateCurrency(input.currency);
  if (input.minQuantity !== undefined) {
    const quantity = parseDecimal(input.minQuantity);
    if (compare(quantity, parseDecimal('0')) <= 0) {
      throw new ValidationError('"minQuantity" must be greater than zero.', { minQuantity: input.minQuantity });
    }
  }
  validateDateWindow(input);
}

export interface PriceBookWrite {
  readonly currency?: string | undefined;
  readonly effectiveFrom?: string | null | undefined;
  readonly effectiveTo?: string | null | undefined;
  readonly priority?: number | undefined;
}

export function validatePriceBookWrite(input: PriceBookWrite): void {
  if (input.currency !== undefined && input.currency !== '') validateCurrency(input.currency);
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10_000)) {
    throw new ValidationError('"priority" must be an integer between 0 and 10000.', { priority: input.priority });
  }
  validateDateWindow(input);
}

export interface TaxRateWrite {
  readonly ratePercent?: string | undefined;
  readonly effectiveFrom?: string | null | undefined;
  readonly effectiveTo?: string | null | undefined;
}

export function validateTaxRateWrite(input: TaxRateWrite): void {
  if (input.ratePercent !== undefined) validateRatePercent(input.ratePercent);
  validateDateWindow(input);
}

/** The most recent `effectiveFrom` wins among applicable rates; ties are a conflict, not a coin toss. */
export function laterEffectiveFrom(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}
