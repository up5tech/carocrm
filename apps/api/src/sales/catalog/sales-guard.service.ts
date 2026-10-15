import {
  DuplicateRecordError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../../hooks/hook.registry.js";
import type {
  PriceRuleAction,
  PriceRuleCriteria,
} from "../pricing/price-rules.js";
import { priceRuleIssues } from "../pricing/price-rules.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  taxRateIssues,
  type TaxRuleCriteria,
  taxRuleIssues,
} from "../tax/tax-rules.js";
import {
  MAX_CATEGORY_DEPTH,
  validateCategoryParent,
  validateDateWindow,
  validatePriceBookEntryWrite,
  validatePriceBookWrite,
  validateProductWrite,
  validateSku,
} from "./product-rules.js";

/**
 * Phase 19-S.3 – 19-S.5 — the Sales validation engine.
 *
 * Every catalog/pricing/tax invariant that one record can break is enforced here, on the
 * `beforeValidate` phase of the Entity Engine, because a record can arrive through the generic
 * `POST/PUT /api/v1/:entity` routes exactly as easily as through a domain command. A rule that
 * only lived in a command would be a side door (PLAN_Phase_19_Sales.md §4.1–§4.4, §8).
 *
 * The database constraints in migration 021 remain the backstop for the invariants that are
 * expressible there (the case-insensitive unique SKU); the hooks turn them into a clear 409/422
 * before the write happens, and cover what SQL cannot say (category cycles, price-book currency
 * agreement, overlapping tax rates).
 */
@Injectable()
export class SalesCatalogGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(SalesRecords) private readonly records: SalesRecords,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  /** Named registrations, so `GET /api/v1/Hook` shows exactly what this module contributes. */
  register(): void {
    this.hooks.register({
      name: "sales.validate",
      phase: "beforeValidate",
      handler: (context) => this.validate(context),
    });
  }

  private async validate(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    switch (context.entity) {
      case "Product":
        await this.validateProduct(data, context);
        break;
      case "ProductCategory":
        await this.validateCategory(data, context);
        break;
      case "PriceBook":
        validatePriceBookWrite({
          currency: text(data["currency"]),
          effectiveFrom: text(data["effectiveFrom"]) ?? null,
          effectiveTo: text(data["effectiveTo"]) ?? null,
          priority: numberOrUndefined(data["priority"]),
        });
        break;
      case "PriceBookEntry":
        await this.validatePriceBookEntry(data);
        break;
      case "PriceRule":
        validatePriceRuleWrite(data);
        break;
      case "TaxRate":
        await this.validateTaxRate(data, context);
        break;
      case "TaxRule":
        validateTaxRuleWrite(data);
        break;
      default:
        break;
    }
  }

  /** §4.1: SKU format and installation-wide, case-insensitive uniqueness, normalized on save. */
  private async validateProduct(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    const sku = text(data["sku"]);
    if (sku !== undefined) {
      const normalized = validateSku(sku);
      const selfId =
        context.operation === "update" ? context.record?.id : undefined;
      const duplicates = await this.records.findByCode(
        "Product",
        "sku",
        normalized,
      );
      const conflict = duplicates.find((row) => row.id !== selfId);
      if (conflict !== undefined) {
        throw new DuplicateRecordError(
          `SKU "${normalized}" is already used by another product.`,
          {
            field: "sku",
            sku: normalized,
            productId: conflict.id,
          },
        );
      }
      data["sku"] = normalized;
    }
    validateProductWrite({
      sku: undefined,
      productType: text(data["productType"]),
      unitPrice: text(data["unitPrice"]),
      listPrice: text(data["listPrice"]),
      costPrice: text(data["costPrice"]),
      active: booleanOrUndefined(data["active"]),
      isSellable: booleanOrUndefined(data["isSellable"]),
      isPurchasable: booleanOrUndefined(data["isPurchasable"]),
    });
  }

  /** §4.2: no self-parenting and no cycles; depth is bounded so a walk cannot loop forever. */
  private async validateCategory(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    const parentId = text(data["parentId"]) ?? null;
    const id = context.operation === "update" ? context.record?.id : undefined;
    if (id === undefined || parentId === null) return;
    const ancestors = await this.categoryAncestors(parentId);
    validateCategoryParent(id, parentId, ancestors);
  }

  private async categoryAncestors(parentId: string): Promise<string[]> {
    const chain: string[] = [];
    let cursor: string | undefined = parentId;
    const seen = new Set<string>();
    for (
      let depth = 0;
      depth < MAX_CATEGORY_DEPTH && cursor !== undefined && cursor !== "";
      depth++
    ) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      chain.push(cursor);
      const parent = await this.records.byId("ProductCategory", cursor);
      cursor = parent === undefined ? undefined : text(parent.data["parentId"]);
    }
    return chain;
  }

  /** §4.3: an entry's currency must agree with its price book, and the book must exist. */
  private async validatePriceBookEntry(
    data: Record<string, unknown>,
  ): Promise<void> {
    validatePriceBookEntryWrite({
      unitPrice: text(data["unitPrice"]),
      minQuantity: text(data["minQuantity"]),
      currency: text(data["currency"]),
      effectiveFrom: text(data["effectiveFrom"]) ?? null,
      effectiveTo: text(data["effectiveTo"]) ?? null,
    });
    const priceBookId = text(data["priceBookId"]);
    const entryCurrency = text(data["currency"]);
    if (priceBookId === undefined || entryCurrency === undefined) return;
    const book = await this.records.byId("PriceBook", priceBookId);
    if (book === undefined) {
      throw new ValidationError(`Price book "${priceBookId}" does not exist.`, {
        field: "priceBookId",
      });
    }
    const bookCurrency = text(book.data["currency"]);
    if (bookCurrency !== undefined && bookCurrency !== entryCurrency) {
      throw new ValidationError(
        `Price book "${bookCurrency}" entries cannot carry ${entryCurrency} prices.`,
        { field: "currency", priceBook: bookCurrency, entry: entryCurrency },
      );
    }
  }

  /** §4.12: an ambiguous tax rate (same code, jurisdiction and effective date) is refused, not guessed. */
  private async validateTaxRate(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    const issues = taxRateIssues({
      ratePercent: text(data["ratePercent"]) ?? "",
      effectiveFrom: text(data["effectiveFrom"]) ?? null,
      effectiveTo: text(data["effectiveTo"]) ?? null,
    });
    if (issues.length > 0)
      throw new ValidationError("Invalid tax rate.", { issues });
    const taxCodeId = text(data["taxCodeId"]);
    const effectiveFrom = text(data["effectiveFrom"]) ?? null;
    if (taxCodeId === undefined) return;
    const selfId =
      context.operation === "update" ? context.record?.id : undefined;
    const jurisdiction = text(data["jurisdiction"]) ?? null;
    const rows = await this.records.find("TaxRate", { taxCodeId }, 500);
    const conflict = rows.find(
      (row) =>
        row.id !== selfId &&
        (text(row.data["jurisdiction"]) ?? null) === jurisdiction &&
        (text(row.data["effectiveFrom"]) ?? null) === effectiveFrom &&
        row.data["active"] !== false,
    );
    if (conflict !== undefined) {
      throw new ValidationError(
        "Another active tax rate for this code, jurisdiction and start date exists.",
        {
          field: "effectiveFrom",
          conflictingRateId: conflict.id,
        },
      );
    }
  }

  /** Small helpers used by both the service layer and the hooks. */
  static ruleCriteriaOf(data: Record<string, unknown>): PriceRuleCriteria {
    return {
      productIds: stringArray(data["productIds"]),
      categoryIds: stringArray(data["categoryIds"]),
      accountIds: stringArray(data["accountIds"]),
      minQuantity: text(data["minQuantity"]),
      maxQuantity: text(data["maxQuantity"]),
    };
  }

  static ruleActionOf(data: Record<string, unknown>): PriceRuleAction {
    const type = text(data["actionType"]) ?? "percentAdjustment";
    const value = text(data["actionValue"]) ?? "0";
    switch (type) {
      case "percentAdjustment":
        return { type, percent: value };
      case "fixedAdjustment":
      case "setPrice":
        return { type, amount: value };
      default:
        throw new ValidationError(`Unknown price action "${type}".`, {
          field: "actionType",
        });
    }
  }

  static taxRuleCriteriaOf(data: Record<string, unknown>): TaxRuleCriteria {
    const jurisdiction = text(data["jurisdiction"]);
    return {
      taxClassIds:
        text(data["taxClassId"]) === undefined
          ? undefined
          : [text(data["taxClassId"]) as string],
      productIds: stringArray(data["productIds"]),
      categoryIds: stringArray(data["categoryIds"]),
      accountIds: stringArray(data["accountIds"]),
      jurisdictions: jurisdiction === undefined ? undefined : [jurisdiction],
    };
  }
}

function validatePriceRuleWrite(data: Record<string, unknown>): void {
  const issues = priceRuleIssues({
    criteria: SalesCatalogGuardService.ruleCriteriaOf(data),
    action: SalesCatalogGuardService.ruleActionOf(data),
  });
  if (issues.length > 0)
    throw new ValidationError("Invalid price rule.", { issues });
  validateDateWindow({
    effectiveFrom: text(data["effectiveFrom"]) ?? null,
    effectiveTo: text(data["effectiveTo"]) ?? null,
  });
}

function validateTaxRuleWrite(data: Record<string, unknown>): void {
  const issues = taxRuleIssues({
    criteria: SalesCatalogGuardService.taxRuleCriteriaOf(data),
    priority: numberOrUndefined(data["priority"]) ?? 0,
    taxCodeId: text(data["taxCodeId"]) ?? null,
  });
  if (issues.length > 0)
    throw new ValidationError("Invalid tax rule.", { issues });
  validateDateWindow({
    effectiveFrom: text(data["effectiveFrom"]) ?? null,
    effectiveTo: text(data["effectiveTo"]) ?? null,
  });
  if (numberOrUndefined(data["priority"]) === undefined) data["priority"] = 10;
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return items.length === 0 ? undefined : items;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Read a module-owned record's attribute as a string; used by the services. */
export function rowText(
  row: SalesRow | undefined,
  field: string,
): string | undefined {
  return row === undefined ? undefined : text(row.data[field]);
}
