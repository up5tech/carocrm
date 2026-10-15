import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../../acl/acl-api.service.js';
import { resolveDay } from '../clock.js';
import type { LineItemInput, TaxLineResolution } from '../document/types.js';
import type { ExchangeRateInput } from '../money/currency.js';
import { normalizeCurrencyCode } from '../money/currency.js';
import { parseDecimal } from '../money/decimal.js';
import { SalesRecords, type SalesRow } from '../sales-records.js';
import { SalesSettingsService } from '../sales-settings.service.js';
import type { TaxContext, TaxRateInput, TaxRuleInput } from './tax-rules.js';
import { orderTaxRules, selectTaxRate } from './tax-rules.js';
import type { TotalsLine, TotalsResult, TotalsShipping } from './totals.js';
import { computeTotals, requireAmount, requirePositiveQuantity } from './totals.js';

/**
 * Phase 19-S.5 — tax resolution and totals preview (PLAN_Phase_19_Sales.md §4.12, §7.2).
 *
 * The engine is the pure pair in `tax-rules.ts` / `totals.ts`; this service is the only place that
 * reads rows and hands them in. It answers one question per line — "which tax code and rate apply
 * to this product, for this account, on this date?" — and records *why* in the resolution
 * (`source`, `ruleId`). A missing or ambiguous configuration is an error with the conflicting ids
 * attached, never a silent zero tax (§4.12).
 */

export interface TaxLineContext {
  readonly date: string;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly accountId: string | null;
  readonly taxClassId: string | null;
  readonly jurisdiction: string | null;
  /** Explicit line input wins over every rule; that is the documented precedence. */
  readonly explicitTaxCodeId?: string | null | undefined;
  readonly explicitRatePercent?: string | null | undefined;
}

export interface TaxPreviewLine extends LineItemInput {
  readonly categoryId?: string | undefined;
}

export interface TaxPreviewRequest {
  readonly currency?: string | undefined;
  readonly date?: string | undefined;
  readonly taxInclusive?: boolean | undefined;
  readonly accountId?: string | null | undefined;
  readonly jurisdiction?: string | null | undefined;
  readonly lines: readonly TaxPreviewLine[];
  readonly shipping?: { readonly amount: string; readonly taxCodeId?: string | null | undefined } | undefined;
  readonly documentDiscountAmount?: string | undefined;
  readonly exchangeRate?: ExchangeRateInput | undefined;
}

@Injectable()
export class SalesTaxService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  /**
   * Resolve the tax for one line.
   *
   * Order: an explicit line rate, then the product's default tax code (with its applicable rate),
   * then the matching tax rule. `null` means "nothing matched" — the caller applies the configured
   * missing-tax policy, which defaults to refusing the line.
   */
  async resolveLineTax(input: TaxLineContext): Promise<TaxLineResolution | null> {
    const context: TaxContext = {
      date: input.date,
      productId: input.productId,
      categoryId: input.categoryId,
      accountId: input.accountId,
      taxClassId: input.taxClassId,
      jurisdiction: input.jurisdiction,
    };

    const explicitRate = input.explicitRatePercent?.trim();
    if (explicitRate !== undefined && explicitRate !== '') {
      parseDecimal(explicitRate);
      const code = input.explicitTaxCodeId?.trim();
      const taxCode = code === undefined || code === '' ? undefined : await this.taxCode(code);
      return {
        taxCodeId: code === undefined || code === '' ? null : code,
        taxCodeName: taxCode?.name ?? null,
        taxRatePercent: explicitRate,
        source: 'line',
        ruleId: null,
        rateId: null,
      };
    }

    const explicitCode = input.explicitTaxCodeId?.trim();
    if (explicitCode !== undefined && explicitCode !== '') {
      return this.resolutionForCode(explicitCode, context, 'taxCode', null);
    }

    const rules = await this.taxRules();
    const ordered = orderTaxRules(rules, context);
    const winner = ordered.applicable[0];
    if (winner !== undefined) {
      const tie = ordered.conflicts.find(([left]) => left.id === winner.id);
      if (tie !== undefined) {
        throw new ValidationError('Two tax rules match this line with the same priority and specificity.', {
          rules: [tie[0].id, tie[1].id],
          productId: input.productId,
        });
      }
      if (winner.taxCodeId === null) {
        throw new ValidationError(`Tax rule "${winner.name ?? winner.id}" has no tax code.`, { ruleId: winner.id });
      }
      return this.resolutionForCode(winner.taxCodeId, context, 'taxRule', winner.id);
    }
    return null;
  }

  /** Product default tax code comes from the product row; the service keeps that lookup here. */
  async resolveForProduct(product: SalesRow, context: Omit<TaxLineContext, 'productId' | 'categoryId' | 'taxClassId'>): Promise<TaxLineResolution | null> {
    const defaultCode = text(product.data['defaultTaxCodeId']);
    if (defaultCode !== undefined) {
      return this.resolutionForCode(defaultCode, {
        date: context.date,
        productId: product.id,
        categoryId: text(product.data['categoryId']) ?? null,
        accountId: context.accountId,
        taxClassId: text(product.data['taxClassId']) ?? null,
        jurisdiction: context.jurisdiction,
      }, 'taxCode', null);
    }
    return this.resolveLineTax({
      ...context,
      productId: product.id,
      categoryId: text(product.data['categoryId']) ?? null,
      taxClassId: text(product.data['taxClassId']) ?? null,
    });
  }

  /**
   * Preview the totals of a document fragment. Server-side only: every number is recomputed here,
   * client-submitted totals are not accepted at all (§5.7).
   */
  async preview(request: TaxPreviewRequest): Promise<TotalsResult> {
    const settings = await this.settings.settings();
    const date = resolveDay(request.date);
    const currency = normalizeCurrencyCode(request.currency ?? settings.currency.defaultCurrency);
    const accountId = request.accountId?.trim() || null;
    const jurisdiction = request.jurisdiction?.trim() || null;
    const taxInclusive = request.taxInclusive ?? settings.features.taxInclusivePrices;

    const productIds = [...new Set(request.lines.map((line) => line.productId).filter((id): id is string => typeof id === 'string' && id.trim() !== ''))];
    if (productIds.length > 0) await this.acl.assertAccess('Product', 'read');
    const products = await this.records.byIds('Product', productIds);
    const byId = new Map(products.map((row) => [row.id, row]));
    for (const id of productIds) {
      if (!byId.has(id)) throw new NotFoundError(`Product "${id}" does not exist.`);
    }

    const lines: TotalsLine[] = [];
    for (const [index, line] of request.lines.entries()) {
      const position = index + 1;
      const product = line.productId === undefined ? undefined : byId.get(line.productId);
      let tax: TaxLineResolution | null;
      if (line.taxRatePercent !== undefined && line.taxRatePercent !== '') {
        tax = await this.resolveLineTax({
          date,
          productId: product?.id ?? null,
          categoryId: product === undefined ? null : text(product.data['categoryId']) ?? null,
          accountId,
          taxClassId: product === undefined ? null : text(product.data['taxClassId']) ?? null,
          jurisdiction,
          explicitTaxCodeId: line.taxCodeId ?? null,
          explicitRatePercent: line.taxRatePercent,
        });
      } else if (line.taxCodeId !== undefined && line.taxCodeId !== '') {
        tax = await this.resolveLineTax({
          date,
          productId: product?.id ?? null,
          categoryId: product === undefined ? null : text(product.data['categoryId']) ?? null,
          accountId,
          taxClassId: product === undefined ? null : text(product.data['taxClassId']) ?? null,
          jurisdiction,
          explicitTaxCodeId: line.taxCodeId,
        });
      } else if (product !== undefined) {
        tax = await this.resolveForProduct(product, { date, accountId, jurisdiction });
      } else {
        tax = await this.resolveLineTax({ date, productId: null, categoryId: null, accountId, taxClassId: null, jurisdiction });
      }
      lines.push({
        ...line,
        tax,
      });
      if (typeof line.quantity !== 'string' || line.quantity.trim() === '') {
        throw new ValidationError(`Line ${position} is missing a quantity.`, { line: position });
      }
      requirePositiveQuantity(line.quantity, position, settings.quantityPrecision);
    }

    let shipping: TotalsShipping | undefined;
    if (request.shipping !== undefined) {
      requireAmount(request.shipping.amount, 'shipping.amount');
      const shippingCode = request.shipping.taxCodeId?.trim() || settings.tax.shippingTaxCode;
      const tax = shippingCode === null || shippingCode === undefined || shippingCode === ''
        ? null
        : await this.resolutionForCode(shippingCode, { date, productId: null, categoryId: null, accountId, taxClassId: null, jurisdiction }, 'taxCode', null);
      shipping = { amount: request.shipping.amount, tax };
    }

    return computeTotals({
      currency,
      taxInclusive,
      rounding: { mode: settings.tax.roundingMode, stage: settings.tax.roundingStage },
      quantityPrecision: settings.quantityPrecision,
      missingTaxPolicy: settings.tax.missingTaxPolicy,
      lines,
      shipping,
      documentDiscountAmount: request.documentDiscountAmount,
      exchangeRate: request.exchangeRate,
    });
  }

  /** Rate for a tax code on a date; a code without an applicable rate is an error, not zero. */
  private async resolutionForCode(
    taxCodeId: string,
    context: TaxContext,
    source: 'taxRule' | 'taxCode',
    ruleId: string | null,
  ): Promise<TaxLineResolution> {
    const code = await this.taxCode(taxCodeId);
    if (code === undefined) {
      throw new ValidationError(`Tax code "${taxCodeId}" does not exist.`, { taxCodeId });
    }
    const rows = await this.records.find('TaxRate', { taxCodeId }, 200);
    const rates = rows.map((row) => toRateInput(row));
    const selection = selectTaxRate(rates, taxCodeId, context);
    if (selection.conflict !== null) {
      throw new ValidationError(`Tax code "${code.name ?? taxCodeId}" has two applicable rates starting on the same date.`, {
        taxCodeId,
        rates: [selection.conflict[0].id, selection.conflict[1].id],
      });
    }
    if (selection.rate === null) {
      if (source === 'taxCode') {
        throw new ValidationError(`Tax code "${code.name ?? taxCodeId}" has no rate applicable on ${context.date}.`, { taxCodeId, date: context.date });
      }
      throw new ValidationError(`Tax rule "${ruleId ?? ''}" resolved to tax code "${code.name ?? taxCodeId}", which has no applicable rate on ${context.date}.`, {
        taxCodeId,
        ruleId,
        date: context.date,
      });
    }
    return {
      taxCodeId,
      taxCodeName: code.name,
      taxRatePercent: selection.rate.ratePercent,
      source,
      ruleId,
      rateId: selection.rate.id,
    };
  }

  private async taxCode(id: string): Promise<SalesRow | undefined> {
    return this.records.byId('TaxCode', id);
  }

  private async taxRules(): Promise<TaxRuleInput[]> {
    const rows = await this.records.allLive('TaxRule');
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: row.data['active'] !== false,
      priority: typeof row.data['priority'] === 'number' ? row.data['priority'] : 100,
      taxCodeId: text(row.data['taxCodeId']) ?? null,
      criteria: {
        taxClassIds: listOrUndefined(row.data['taxClassId']),
        productIds: stringArray(row.data['productIds']),
        categoryIds: stringArray(row.data['categoryIds']),
        accountIds: stringArray(row.data['accountIds']),
        jurisdictions: listOrUndefined(row.data['jurisdiction']),
      },
      effectiveFrom: text(row.data['effectiveFrom']) ?? null,
      effectiveTo: text(row.data['effectiveTo']) ?? null,
    }));
  }
}

function toRateInput(row: SalesRow): TaxRateInput {
  return {
    id: row.id,
    name: row.name,
    active: row.data['active'] !== false,
    taxCodeId: text(row.data['taxCodeId']) ?? null,
    ratePercent: text(row.data['ratePercent']) ?? '0',
    jurisdiction: text(row.data['jurisdiction']) ?? null,
    effectiveFrom: text(row.data['effectiveFrom']) ?? null,
    effectiveTo: text(row.data['effectiveTo']) ?? null,
  };
}

function listOrUndefined(value: unknown): string[] | undefined {
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return items.length === 0 ? undefined : items;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
