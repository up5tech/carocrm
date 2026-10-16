import {
  DuplicateRecordError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../../hooks/hook.registry.js";
import { storedDay, utcDay } from "../clock.js";
import { normalizeIdentity, validateLotDates } from "../inventory/picking.js";
import type {
  PriceRuleAction,
  PriceRuleCriteria,
} from "../pricing/price-rules.js";
import { priceRuleIssues } from "../pricing/price-rules.js";
import { changedKeys } from "../sales-internal.js";
import {
  type SalesEntityType,
  SalesRecords,
  type SalesRow,
} from "../sales-records.js";
import { SalesSettingsService } from "../sales-settings.service.js";
import {
  taxRateIssues,
  type TaxRuleCriteria,
  taxRuleIssues,
} from "../tax/tax-rules.js";
import {
  assertSupplierEditable,
  MAX_CATEGORY_DEPTH,
  normalizeVariantAttributes,
  normalizeVariantFamily,
  SUPPLIER_IDENTITY_FIELDS,
  validateCategoryParent,
  validateDateWindow,
  validatePriceBookEntryWrite,
  validatePriceBookWrite,
  validateProductWrite,
  validateSku,
  variantAttributesSignature,
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
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
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
          effectiveFrom: storedDay(data["effectiveFrom"]) ?? null,
          effectiveTo: storedDay(data["effectiveTo"]) ?? null,
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
      case "Supplier":
        await this.validateSupplier(data, context);
        break;
      case "InventoryBatch":
        await this.validateBatch(data, context);
        break;
      default:
        break;
    }
  }

  /**
   * §4.12: a supplier that an issued purchasing document already names keeps its identity, because
   * renaming it or moving its currency or tax id would rewrite what that document said about the party
   * it was raised against. The check runs on the record path too — the generic `PUT /api/v1/Supplier`
   * is the same write.
   */
  private async validateSupplier(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    if (context.operation !== "update" || context.record === undefined) return;
    const changed = changedKeys(data, context.previous ?? {});
    if (!changed.some((field) => SUPPLIER_IDENTITY_FIELDS.includes(field)))
      return;
    const referenced = await this.supplierIsReferenced(context.record.id);
    assertSupplierEditable({ referenced, changedFields: changed });
  }

  /** Whether any document that has committed money or goods already names this supplier. */
  private async supplierIsReferenced(supplierId: string): Promise<boolean> {
    const references: readonly [SalesEntityType, string][] = [
      ["Bill", "issued"],
      ["BillCredit", "issued"],
      ["PurchaseOrder", "confirmed"],
      ["PurchaseOrder", "partiallyReceived"],
      ["PurchaseOrder", "received"],
      ["ReceiptOrder", "confirmed"],
    ];
    for (const [entity, status] of references) {
      const rows = await this.records.find(entity, { supplierId, status }, 1);
      if (rows.length > 0) return true;
    }
    return false;
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
    await this.validateVariants(data, context);
  }

  /**
   * §4.2 / 19-S.15 task 1 — a product that joins a variant family carries the configured attribute
   * values, and no two products of one family are the same variant.
   *
   * The rules run only while `features.productVariants` is on: with the flag off the fields are
   * inert and Tier 1 cataloguing works exactly as before (§4.2 last bullet). SKU uniqueness itself
   * stays the installation-wide, case-insensitive rule the database enforces (migration 021) — a
   * variant's SKU *is* a product SKU, so it gets no separate scope.
   */
  private async validateVariants(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    const touchesFamily =
      Object.prototype.hasOwnProperty.call(data, "variantFamily") ||
      Object.prototype.hasOwnProperty.call(data, "variantAttributes");
    if (!touchesFamily) return;
    const settings = await this.settings.settings();
    const previous = context.previous ?? {};
    const family = Object.prototype.hasOwnProperty.call(data, "variantFamily")
      ? normalizeVariantFamily(data["variantFamily"])
      : normalizeVariantFamily(previous["variantFamily"]);
    if (!settings.features.productVariants) {
      // Flag off: store what was sent, unvalidated — the fields mean nothing until it is on.
      if (family !== null) data["variantFamily"] = family;
      return;
    }
    const raw = Object.prototype.hasOwnProperty.call(data, "variantAttributes")
      ? data["variantAttributes"]
      : previous["variantAttributes"];
    if (family === null) {
      if (raw !== undefined && raw !== null && variantAttributesSignature(raw) !== "{}" &&
          variantAttributesSignature(raw) !== "") {
        throw new ValidationError(
          "Variant attributes need a variant family; set \"variantFamily\" first or clear the attributes.",
          { field: "variantAttributes" },
        );
      }
      data["variantFamily"] = null;
      if (Object.prototype.hasOwnProperty.call(data, "variantAttributes"))
        data["variantAttributes"] = null;
      return;
    }
    const attributes = normalizeVariantAttributes({
      raw,
      definitions: settings.variants.attributes,
      requireAll: settings.variants.requireAllAttributes,
    });
    const selfId =
      context.operation === "update" ? context.record?.id : undefined;
    const siblings = await this.records.find(
      "Product",
      { variantFamily: family },
      500,
    );
    const conflict = siblings.find(
      (row) =>
        row.id !== selfId &&
        variantAttributesSignature(row.data["variantAttributes"]) ===
          variantAttributesSignature(attributes),
    );
    if (conflict !== undefined) {
      throw new DuplicateRecordError(
        `Another product of family "${family}" already has this exact combination of variant attributes.`,
        { field: "variantAttributes", productId: conflict.id, variantFamily: family },
      );
    }
    data["variantFamily"] = family;
    data["variantAttributes"] = JSON.stringify(attributes);
  }

  /**
   * 19-S.15 task 3 — a lot's dates must make sense together, against each other and against today.
   * The check reads the stored dates for anything the patch does not carry, so an update that only
   * moves the expiry cannot walk past the manufacturing date it already has.
   */
  private async validateBatch(
    data: Record<string, unknown>,
    context: HookContext,
  ): Promise<void> {
    const batchNumber = text(data["batchNumber"]);
    if (batchNumber !== undefined) {
      data["batchNumber"] = normalizeIdentity(batchNumber, "batchNumber");
      if (text(data["name"]) === undefined)
        data["name"] = data["batchNumber"];
      // One lot per (product, number) — the database index (migration 029) is the backstop; this
      // turns the race into the clear 409 the operator can act on.
      const productId =
        text(data["productId"]) ?? text(context.previous?.["productId"]);
      const selfId =
        context.operation === "update" ? context.record?.id : undefined;
      if (productId !== undefined) {
        const duplicates = await this.records.findByCode(
          "InventoryBatch",
          "batchNumber",
          data["batchNumber"] as string,
          10,
        );
        const conflict = duplicates.find(
          (row) =>
            row.id !== selfId && text(row.data["productId"]) === productId,
        );
        if (conflict !== undefined) {
          throw new DuplicateRecordError(
            `Lot "${String(data["batchNumber"])}" already exists for this product.`,
            { field: "batchNumber", batchId: conflict.id },
          );
        }
      }
    }
    const previous = context.previous ?? {};
    validateLotDates({
      manufacturingDate:
        storedDay(data["manufacturingDate"]) ??
        storedDay(previous["manufacturingDate"]),
      expiryDate:
        storedDay(data["expiryDate"]) ?? storedDay(previous["expiryDate"]),
      today: utcDay(),
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
      effectiveFrom: storedDay(data["effectiveFrom"]) ?? null,
      effectiveTo: storedDay(data["effectiveTo"]) ?? null,
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
      effectiveFrom: storedDay(data["effectiveFrom"]) ?? null,
      effectiveTo: storedDay(data["effectiveTo"]) ?? null,
    });
    if (issues.length > 0)
      throw new ValidationError("Invalid tax rate.", { issues });
    const taxCodeId = text(data["taxCodeId"]);
    const effectiveFrom = storedDay(data["effectiveFrom"]);
    if (taxCodeId === undefined) return;
    const selfId =
      context.operation === "update" ? context.record?.id : undefined;
    const jurisdiction = text(data["jurisdiction"]) ?? null;
    const rows = await this.records.find("TaxRate", { taxCodeId }, 500);
    const conflict = rows.find(
      (row) =>
        row.id !== selfId &&
        (text(row.data["jurisdiction"]) ?? null) === jurisdiction &&
        // Stored and incoming dates are both normalized to their UTC day: the engine stores a `date`
        // field as an instant, and a raw string comparison would never match.
        (storedDay(row.data["effectiveFrom"]) ?? null) ===
          (storedDay(effectiveFrom) ?? null) &&
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
    effectiveFrom: storedDay(data["effectiveFrom"]) ?? null,
    effectiveTo: storedDay(data["effectiveTo"]) ?? null,
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
    effectiveFrom: storedDay(data["effectiveFrom"]) ?? null,
    effectiveTo: storedDay(data["effectiveTo"]) ?? null,
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
