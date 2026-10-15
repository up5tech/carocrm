import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { type ProductGateInput, salesGate } from "../catalog/product-rules.js";
import { resolveDay } from "../clock.js";
import { currencyScale, normalizeCurrencyCode } from "../money/currency.js";
import { compare, format, parseDecimal, rescale } from "../money/decimal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  type SalesSettings,
  SalesSettingsService,
} from "../sales-settings.service.js";
import type {
  PriceRuleAction,
  PriceRuleContext,
  PriceRuleCriteria,
  PriceRuleInput,
} from "./price-rules.js";
import { applyPriceRuleAction, orderPriceRules } from "./price-rules.js";

/**
 * Phase 19-S.4 — price resolution (PLAN_Phase_19_Sales.md §4.3).
 *
 * Deterministic and explainable: the same context always resolves to the same price, and the result
 * names the exact source that won — a price book entry, an applied rule, the product's own unit
 * price, or an explicit (permitted) user price. There is no unordered SQL row order anywhere: books,
 * entries and rules are all ordered by documented keys before anything is chosen.
 *
 * A missing price is **surfaced**, never defaulted to zero (§4.3 rule 4). When the configured policy
 * is `error` the call fails with the reason; when it is `allowExplicit` the result is explicitly
 * unresolved and the caller must supply a price.
 *
 * Supplier prices are a different entity (`SupplierProductPrice`) and are never consulted here, so
 * a buying price cannot leak into a sales document by an accidental fallback (§4.3, §4.11).
 */

export interface PriceResolutionRequest {
  readonly productId: string;
  readonly quantity?: string | undefined;
  readonly currency?: string | undefined;
  readonly accountId?: string | null | undefined;
  readonly priceBookId?: string | null | undefined;
  /** Document date, `YYYY-MM-DD`; defaults to today (UTC). */
  readonly date?: string | undefined;
  readonly explicitPrice?: string | null | undefined;
}

export type PriceSource =
  "priceBookEntry" | "priceRule" | "productUnitPrice" | "explicit";

export interface PriceTraceStep {
  readonly step: string;
  readonly detail: string;
}

export interface ResolvedPrice {
  readonly resolved: true;
  readonly productId: string;
  readonly price: string;
  readonly currency: string;
  readonly scale: number;
  readonly source: PriceSource;
  readonly explanation: string;
  readonly trace: readonly PriceTraceStep[];
  readonly priceBookId: string | null;
  readonly priceBookEntryId: string | null;
  readonly priceRuleId: string | null;
  readonly listPrice: string | null;
  readonly quantity: string;
  readonly date: string;
}

export interface UnresolvedPrice {
  readonly resolved: false;
  readonly productId: string;
  readonly currency: string;
  readonly quantity: string;
  readonly date: string;
  readonly reason: string;
  readonly trace: readonly PriceTraceStep[];
}

export type PriceResolution = ResolvedPrice | UnresolvedPrice;

interface PriceBookCandidate {
  readonly row: SalesRow;
  readonly reason: string;
}

@Injectable()
export class PriceResolutionService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  async resolve(request: PriceResolutionRequest): Promise<PriceResolution> {
    const settings = await this.settings.settings();
    const product = await this.requireProduct(request.productId);
    const date = resolveDay(request.date);
    const currency = normalizeCurrencyCode(
      request.currency ?? settings.currency.defaultCurrency,
    );
    const scale = currencyScale(currency);
    const quantity = (request.quantity ?? "1").trim();
    const trace: PriceTraceStep[] = [];
    const context: PriceRuleContext = {
      productId: product.id,
      categoryId: text(product.data["categoryId"]) ?? null,
      accountId: request.accountId?.trim() || null,
      quantity,
      date,
    };

    const gate = salesGate(productGateInput(product));
    trace.push({
      step: "catalog",
      detail: gate.allowed
        ? `Product "${product.name ?? product.id}" is active and sellable.`
        : (gate.reason ?? "Product is not sellable."),
    });
    if (!gate.allowed) {
      throw new ValidationError(
        gate.reason ?? "This product cannot be added to a sales document.",
        { productId: product.id },
      );
    }

    const explicit = await this.explicitSource(
      request,
      settings,
      currency,
      scale,
      trace,
    );
    const productPrice = await this.productPriceSource(
      product,
      settings,
      trace,
    );

    const orders: ("books" | "product")[] =
      settings.pricing.resolution === "productFirst"
        ? ["product", "books"]
        : ["books", "product"];

    for (const order of orders) {
      if (order === "product") {
        if (productPrice !== null) {
          return this.resolved(
            product,
            productPrice.price,
            currency,
            scale,
            "productUnitPrice",
            productPrice.explanation,
            trace,
            {
              priceBookId: null,
              entryId: null,
              ruleId: null,
              listPrice: productPrice.listPrice,
              quantity,
              date,
            },
          );
        }
      } else {
        const bookResult = await this.bookSource(
          request,
          settings,
          context,
          currency,
          trace,
        );
        if (bookResult !== null) {
          return this.resolved(
            product,
            bookResult.price,
            currency,
            scale,
            bookResult.source,
            bookResult.explanation,
            trace,
            {
              priceBookId: bookResult.priceBookId,
              entryId: bookResult.entryId,
              ruleId: bookResult.ruleId,
              listPrice: null,
              quantity,
              date,
            },
          );
        }
      }
    }

    if (explicit !== null) {
      return this.resolved(
        product,
        explicit.amount,
        currency,
        scale,
        "explicit",
        "Explicit price permitted by the Sales settings.",
        trace,
        {
          priceBookId: null,
          entryId: null,
          ruleId: null,
          listPrice: null,
          quantity,
          date,
        },
      );
    }

    const reason = `No price could be resolved for product "${product.name ?? product.id}" in ${currency}.`;
    if (settings.pricing.missingPricePolicy === "error") {
      throw new ValidationError(reason, {
        productId: product.id,
        currency,
        date,
        trace,
      });
    }
    return {
      resolved: false,
      productId: product.id,
      currency,
      quantity,
      date,
      reason,
      trace,
    };
  }

  /** Product-level price, subject to the feature flag and field-level read access. */
  private async productPriceSource(
    product: SalesRow,
    settings: SalesSettings,
    trace: PriceTraceStep[],
  ): Promise<{
    price: string;
    explanation: string;
    listPrice: string | null;
  } | null> {
    if (!settings.features.productPrices) {
      trace.push({
        step: "productPrice",
        detail: "Product-level prices are disabled in the Sales settings.",
      });
      return null;
    }
    const unitPrice = text(product.data["unitPrice"]);
    if (unitPrice === undefined) {
      trace.push({
        step: "productPrice",
        detail: "The product has no unit price.",
      });
      return null;
    }
    const fieldAccess = await this.acl.fieldAccess("Product", "unitPrice");
    if (fieldAccess.read === "no") {
      trace.push({
        step: "productPrice",
        detail: "The product unit price is not readable by this user.",
      });
      return null;
    }
    trace.push({
      step: "productPrice",
      detail: `Product unit price ${unitPrice} applies.`,
    });
    return {
      price: unitPrice,
      explanation: "Product unit price.",
      listPrice: text(product.data["listPrice"]) ?? null,
    };
  }

  private async explicitSource(
    request: PriceResolutionRequest,
    settings: SalesSettings,
    currency: string,
    scale: number,
    trace: PriceTraceStep[],
  ): Promise<{ amount: string } | null> {
    const value = request.explicitPrice?.trim();
    if (value === undefined || value === "") {
      trace.push({
        step: "explicitPrice",
        detail: "No explicit price was supplied.",
      });
      return null;
    }
    if (!settings.pricing.allowCustomPrice) {
      throw new ValidationError(
        "This installation does not allow a manually entered price.",
        { policy: settings.pricing.allowCustomPrice },
      );
    }
    const fieldAccess = await this.acl.fieldAccess(
      "PriceBookEntry",
      "unitPrice",
    );
    if (fieldAccess.edit === "no") {
      throw new ValidationError("This user may not enter a custom price.", {
        field: "PriceBookEntry.unitPrice",
      });
    }
    const amount = normalizeAmount(value, currency, scale);
    trace.push({
      step: "explicitPrice",
      detail: `A permitted explicit price of ${amount} is available as a fallback.`,
    });
    return { amount };
  }

  /** Price books: the explicit book, else books associated with the account, in documented order. */
  private async bookSource(
    request: PriceResolutionRequest,
    settings: SalesSettings,
    context: PriceRuleContext,
    currency: string,
    trace: PriceTraceStep[],
  ): Promise<{
    price: string;
    source: "priceBookEntry" | "priceRule";
    explanation: string;
    priceBookId: string;
    entryId: string | null;
    ruleId: string | null;
  } | null> {
    if (!settings.features.priceBooks) {
      trace.push({
        step: "priceBooks",
        detail: "Price books are disabled in the Sales settings.",
      });
      return null;
    }
    const candidates = await this.priceBookCandidates(request, trace);
    if (candidates.length === 0) {
      trace.push({ step: "priceBooks", detail: "No applicable price book." });
      return null;
    }
    await this.acl.assertAccess("PriceBook", "read");
    const entryFieldAccess = await this.acl.fieldAccess(
      "PriceBookEntry",
      "unitPrice",
    );
    if (entryFieldAccess.read === "no") {
      throw new ValidationError("This user may not read price book prices.", {
        field: "PriceBookEntry.unitPrice",
      });
    }

    for (const candidate of candidates) {
      const bookCurrency = text(candidate.row.data["currency"]);
      if (bookCurrency !== undefined && bookCurrency !== currency) {
        trace.push({
          step: "priceBook",
          detail: `Price book "${candidate.row.name ?? candidate.row.id}" is in ${bookCurrency}, not ${currency}; skipped.`,
        });
        continue;
      }
      const result = await this.resolveFromBook(
        candidate.row,
        settings,
        context,
        currency,
        context.quantity,
        trace,
      );
      if (result !== null) return result;
    }
    return null;
  }

  private async priceBookCandidates(
    request: PriceResolutionRequest,
    trace: PriceTraceStep[],
  ): Promise<PriceBookCandidate[]> {
    const explicitId = request.priceBookId?.trim();
    if (explicitId !== undefined && explicitId !== "") {
      const row = await this.records.byId("PriceBook", explicitId);
      if (row === undefined)
        throw new NotFoundError(`Price book "${explicitId}" does not exist.`);
      if (row.data["active"] === false)
        throw new ValidationError(`Price book "${explicitId}" is inactive.`, {
          priceBookId: explicitId,
        });
      trace.push({
        step: "priceBook",
        detail: `Price book "${row.name ?? row.id}" was requested explicitly.`,
      });
      return [{ row, reason: "explicit" }];
    }
    const accountId = request.accountId?.trim();
    if (accountId === undefined || accountId === "") return [];
    const rows = await this.records.find("PriceBook", { accountId }, 50);
    return rows
      .filter((row) => row.data["active"] !== false)
      .sort((left, right) => {
        const priority = priorityOf(left) - priorityOf(right);
        if (priority !== 0) return priority;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .map((row) => {
        trace.push({
          step: "priceBook",
          detail: `Price book "${row.name ?? row.id}" is associated with the account.`,
        });
        return { row, reason: "account" };
      });
  }

  private async resolveFromBook(
    book: SalesRow,
    settings: SalesSettings,
    context: PriceRuleContext,
    currency: string,
    quantity: string,
    trace: PriceTraceStep[],
  ): Promise<{
    price: string;
    source: "priceBookEntry" | "priceRule";
    explanation: string;
    priceBookId: string;
    entryId: string | null;
    ruleId: string | null;
  } | null> {
    const label = book.name ?? book.id;
    const entries = await this.records.find(
      "PriceBookEntry",
      { priceBookId: book.id, productId: context.productId },
      200,
    );
    const applicable = entries.filter((entry) =>
      entryApplies(entry, book, context.date, currency, context.quantity),
    );
    const entry = selectEntry(applicable);
    const entryPrice =
      entry === undefined ? undefined : text(entry.data["unitPrice"]);

    const rules = (
      await this.records.find("PriceRule", { priceBookId: book.id }, 200)
    ).map((row) => toPriceRuleInput(row));
    const ordered = orderPriceRules(rules, context);
    const winner = ordered.applicable[0];
    const tie = ordered.ties.find(([left]) => left.id === winner?.id);
    if (winner !== undefined && tie !== undefined) {
      throw new ValidationError(
        "Two price rules match with the same priority and specificity.",
        {
          priceBookId: book.id,
          rules: [tie[0].id, tie[1].id],
        },
      );
    }

    if (winner !== undefined && winner.action.type === "setPrice") {
      trace.push({
        step: "priceRule",
        detail: `Rule "${winner.name ?? winner.id}" sets the price.`,
      });
      return {
        price: winner.action.amount,
        source: "priceRule",
        explanation: `Price rule "${winner.name ?? winner.id}" in price book "${label}" sets the price.`,
        priceBookId: book.id,
        entryId: entry?.id ?? null,
        ruleId: winner.id,
      };
    }

    if (entryPrice !== undefined) {
      if (winner === undefined) {
        trace.push({
          step: "priceBookEntry",
          detail: `Entry in "${label}" applies at quantity ${quantity}.`,
        });
        return {
          price: entryPrice,
          source: "priceBookEntry",
          explanation: `Price book entry in "${label}"${entry === undefined ? "" : ` (from ${context.date})`}.`,
          priceBookId: book.id,
          entryId: entry?.id ?? null,
          ruleId: null,
        };
      }
      const adjusted = applyPriceRuleAction(
        {
          amount: normalizeAmount(
            entryPrice,
            currency,
            currencyScale(currency),
          ),
          currency,
          scale: currencyScale(currency),
        },
        winner.action,
        settings.tax.roundingMode,
      );
      trace.push({
        step: "priceRule",
        detail: `Rule "${winner.name ?? winner.id}" adjusts the entry price ${entryPrice} to ${adjusted.amount}.`,
      });
      return {
        price: adjusted.amount,
        source: "priceRule",
        explanation: `Price rule "${winner.name ?? winner.id}" applied to the price book entry (${entryPrice} → ${adjusted.amount}).`,
        priceBookId: book.id,
        entryId: entry?.id ?? null,
        ruleId: winner.id,
      };
    }

    // A rule that adjusts but nothing to adjust: with product prices enabled the product price is
    // the documented base; otherwise the rule cannot produce a price and is reported, not guessed.
    if (winner !== undefined) {
      const product = await this.records.byId("Product", context.productId);
      const base =
        product === undefined ? undefined : text(product.data["unitPrice"]);
      if (base !== undefined && settings.features.productPrices) {
        const adjusted = applyPriceRuleAction(
          {
            amount: normalizeAmount(base, currency, currencyScale(currency)),
            currency,
            scale: currencyScale(currency),
          },
          winner.action,
          settings.tax.roundingMode,
        );
        trace.push({
          step: "priceRule",
          detail: `Rule "${winner.name ?? winner.id}" adjusts the product price ${base} to ${adjusted.amount}.`,
        });
        return {
          price: adjusted.amount,
          source: "priceRule",
          explanation: `Price rule "${winner.name ?? winner.id}" applied to the product unit price (${base} → ${adjusted.amount}).`,
          priceBookId: book.id,
          entryId: null,
          ruleId: winner.id,
        };
      }
      trace.push({
        step: "priceRule",
        detail: `Rule "${winner.name ?? winner.id}" matched but has no base price to adjust.`,
      });
    }
    return null;
  }

  private async requireProduct(productId: string): Promise<SalesRow> {
    await this.acl.assertAccess("Product", "read");
    const product = await this.records.byId("Product", productId.trim());
    if (product === undefined)
      throw new NotFoundError(`Product "${productId}" does not exist.`);
    return product;
  }

  private resolved(
    product: SalesRow,
    price: string,
    currency: string,
    scale: number,
    source: PriceSource,
    explanation: string,
    trace: readonly PriceTraceStep[],
    rest: {
      priceBookId: string | null;
      entryId: string | null;
      ruleId: string | null;
      listPrice: string | null;
      quantity: string;
      date: string;
    },
  ): ResolvedPrice {
    return {
      resolved: true,
      productId: product.id,
      price: normalizeAmount(price, currency, scale),
      currency,
      scale,
      source,
      explanation,
      trace,
      priceBookId: rest.priceBookId,
      priceBookEntryId: rest.entryId,
      priceRuleId: rest.ruleId,
      listPrice: rest.listPrice,
      quantity: rest.quantity,
      date: rest.date,
    };
  }
}

function entryApplies(
  entry: SalesRow,
  book: SalesRow,
  date: string,
  currency: string,
  quantity: string,
): boolean {
  const entryCurrency =
    text(entry.data["currency"]) ?? text(book.data["currency"]);
  if (entryCurrency !== undefined && entryCurrency !== currency) return false;
  const from = text(entry.data["effectiveFrom"]);
  const to = text(entry.data["effectiveTo"]);
  if (from !== undefined && date < from) return false;
  if (to !== undefined && date > to) return false;
  if (text(entry.data["unitPrice"]) === undefined) return false;
  const minQuantity = text(entry.data["minQuantity"]);
  if (
    minQuantity !== undefined &&
    compareDecimalStrings(quantity, minQuantity) < 0
  )
    return false;
  return true;
}

/** Quantity break: the largest `minQuantity` not above the requested quantity, then latest window. */
function selectEntry(entries: readonly SalesRow[]): SalesRow | undefined {
  return [...entries].sort((left, right) => {
    const leftMin = text(left.data["minQuantity"]) ?? "0";
    const rightMin = text(right.data["minQuantity"]) ?? "0";
    const byQuantity = compareDecimalStrings(rightMin, leftMin);
    if (byQuantity !== 0) return byQuantity;
    const leftFrom = text(left.data["effectiveFrom"]) ?? "";
    const rightFrom = text(right.data["effectiveFrom"]) ?? "";
    if (leftFrom !== rightFrom) return leftFrom < rightFrom ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0];
}

function toPriceRuleInput(row: SalesRow): PriceRuleInput {
  return {
    id: row.id,
    name: row.name,
    active: row.data["active"] !== false,
    priority:
      typeof row.data["priority"] === "number" ? row.data["priority"] : 100,
    criteria: ruleCriteria(row),
    action: ruleAction(row),
    effectiveFrom: text(row.data["effectiveFrom"]) ?? null,
    effectiveTo: text(row.data["effectiveTo"]) ?? null,
  };
}

function ruleCriteria(row: SalesRow): PriceRuleCriteria {
  return {
    productIds: stringArray(row.data["productIds"]),
    categoryIds: stringArray(row.data["categoryIds"]),
    accountIds: stringArray(row.data["accountIds"]),
    minQuantity: text(row.data["minQuantity"]),
    maxQuantity: text(row.data["maxQuantity"]),
  };
}

function ruleAction(row: SalesRow): PriceRuleAction {
  const type = text(row.data["actionType"]) ?? "percentAdjustment";
  const value = text(row.data["actionValue"]) ?? "0";
  switch (type) {
    case "percentAdjustment":
      return { type, percent: value };
    case "fixedAdjustment":
      return { type, amount: value };
    case "setPrice":
      return { type, amount: value };
    default:
      throw new ValidationError(
        `Price rule "${row.id}" has an unknown action "${type}".`,
        { ruleId: row.id },
      );
  }
}

function productGateInput(row: SalesRow): ProductGateInput {
  return {
    id: row.id,
    name: row.name,
    active: row.data["active"] !== false,
    isSellable: row.data["isSellable"] !== false,
    isPurchasable: row.data["isPurchasable"] !== false,
  };
}

function normalizeAmount(
  value: string,
  currency: string,
  scale: number,
): string {
  // Amounts are canonical fixed-scale strings; an entry with more fraction digits than the currency
  // is a configuration error the resolution reports instead of silently rounding.
  const parsed = parseDecimal(value);
  if (parsed.scale > scale) {
    throw new ValidationError(
      `Amount "${value}" has more fraction digits than ${currency} supports.`,
      { value, currency },
    );
  }
  return format(rescale(parsed, scale, "half-up"), scale);
}

function compareDecimalStrings(left: string, right: string): number {
  return compare(parseDecimal(left), parseDecimal(right));
}

function priorityOf(row: SalesRow): number {
  return typeof row.data["priority"] === "number" ? row.data["priority"] : 100;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return items.length === 0 ? undefined : items;
}
