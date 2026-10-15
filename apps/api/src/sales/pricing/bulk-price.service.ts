import { randomUUID } from "node:crypto";

import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import { currencyScale, normalizeCurrencyCode } from "../money/currency.js";
import type { Decimal, RoundingMode } from "../money/decimal.js";
import {
  add,
  divideTo,
  format,
  isNegative,
  multiply,
  parseDecimal,
  rescale,
} from "../money/decimal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import { SalesSettingsService } from "../sales-settings.service.js";

/**
 * Phase 19-S.4 — bulk price update (PLAN_Phase_19_Sales.md §4.3 last bullets, §16.1).
 *
 * Requirements this service exists to meet: a **preview** of what would change and how many records
 * are affected, a permission check before any write, a bounded transaction, an audit record for the
 * run itself, and no silent re-pricing of an accepted or issued document (documents are a later
 * phase; nothing here touches them).
 *
 * Every write goes through `EntityCrudService`, so record-level ACL, validation, audit and the
 * domain-event hooks all still run — a bulk path is not a back door (§5.2).
 */

export const BULK_PRICE_DEFAULT_LIMIT = 200;
export const BULK_PRICE_MAX_LIMIT = 500;

export type BulkAdjustmentType = "percent" | "fixed" | "set";

export interface BulkPriceRequest {
  readonly mode: "preview" | "apply";
  readonly priceBookId: string;
  readonly adjustment: {
    readonly type: BulkAdjustmentType;
    readonly value: string;
  };
  readonly productIds?: readonly string[] | undefined;
  readonly categoryIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface BulkPriceChange {
  readonly entryId: string;
  readonly productId: string | null;
  readonly productName: string | null;
  readonly from: string;
  readonly to: string;
}

export interface BulkPriceSkipped {
  readonly entryId: string;
  readonly reason: string;
}

export interface BulkPriceResult {
  readonly mode: "preview" | "apply";
  readonly priceBookId: string;
  readonly priceBookName: string | null;
  readonly currency: string;
  readonly changes: readonly BulkPriceChange[];
  readonly skipped: readonly BulkPriceSkipped[];
  readonly changedCount: number;
  readonly applied: boolean;
  readonly truncated: boolean;
  readonly auditId: string | null;
}

@Injectable()
export class BulkPriceService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async run(request: BulkPriceRequest): Promise<BulkPriceResult> {
    const limit = clampLimit(request.limit);
    const value = requireAdjustmentValue(request.adjustment);
    const settings = await this.settings.settings();

    await this.acl.assertAccess(
      "PriceBookEntry",
      request.mode === "apply" ? "edit" : "read",
    );
    const book = await this.records.byId("PriceBook", request.priceBookId);
    if (book === undefined)
      throw new NotFoundError(
        `Price book "${request.priceBookId}" does not exist.`,
      );
    const currency = normalizeCurrencyCode(
      text(book.data["currency"]) ?? settings.currency.defaultCurrency,
    );
    const scale = currencyScale(currency);
    const mode = settings.tax.roundingMode;

    const rows = await this.records.find(
      "PriceBookEntry",
      { priceBookId: book.id },
      limit + 1,
    );
    const truncated = rows.length > limit;
    const entries = rows.slice(0, limit);
    const productIds = [
      ...new Set(
        entries
          .map((entry) => text(entry.data["productId"]))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const products = new Map(
      (await this.records.byIds("Product", productIds)).map((row) => [
        row.id,
        row,
      ]),
    );

    const changes: BulkPriceChange[] = [];
    const skipped: BulkPriceSkipped[] = [];
    for (const entry of entries) {
      const productId = text(entry.data["productId"]) ?? null;
      const product = productId === null ? undefined : products.get(productId);
      if (!matchesFilter(entry, product, request)) continue;
      const current = text(entry.data["unitPrice"]);
      if (current === undefined) {
        skipped.push({
          entryId: entry.id,
          reason: "The entry has no unit price.",
        });
        continue;
      }
      const next = adjustedPrice(
        current,
        request.adjustment,
        value,
        scale,
        mode,
      );
      if (next === null) {
        skipped.push({
          entryId: entry.id,
          reason: "The adjustment would produce a negative price.",
        });
        continue;
      }
      changes.push({
        entryId: entry.id,
        productId,
        productName: product?.name ?? null,
        from: formatPrice(parseDecimal(current), scale),
        to: formatPrice(next, scale),
      });
    }

    if (request.mode === "preview") {
      return {
        mode: "preview",
        priceBookId: book.id,
        priceBookName: book.name,
        currency,
        changes,
        skipped,
        changedCount: changes.length,
        applied: false,
        truncated,
        auditId: null,
      };
    }

    // Apply: one bounded transaction. A failure anywhere rolls every entry back, so the catalog is
    // never left with half a price change.
    const auditId = `audit_${randomUUID()}`;
    await runInTransaction(this.database.db, async () => {
      for (const change of changes) {
        await this.entities.update("PriceBookEntry", change.entryId, {
          unitPrice: change.to,
        });
      }
      await this.database.db
        .insertInto("audit_log")
        .values({
          id: auditId,
          entity_type: "PriceBook",
          record_id: book.id,
          username: this.scope.principal?.userName ?? null,
          user_id: this.scope.userId ?? null,
          action: "update",
          order: 0,
          data: JSON.stringify({
            bulkPriceUpdate: {
              adjustment: request.adjustment,
              changedCount: changes.length,
              skipped: skipped.length,
              limit,
              truncated,
              entries: changes.map((change) => ({
                id: change.entryId,
                from: change.from,
                to: change.to,
              })),
            },
          }),
          archived: false,
          created_at: new Date(),
        })
        .execute();
    });

    return {
      mode: "apply",
      priceBookId: book.id,
      priceBookName: book.name,
      currency,
      changes,
      skipped,
      changedCount: changes.length,
      applied: true,
      truncated,
      auditId,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return BULK_PRICE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(
      "A bulk price update limit must be a positive integer.",
      { limit },
    );
  }
  if (limit > BULK_PRICE_MAX_LIMIT) {
    throw new ValidationError(
      `A bulk price update is bounded to ${BULK_PRICE_MAX_LIMIT} entries per run.`,
      {
        limit,
        max: BULK_PRICE_MAX_LIMIT,
      },
    );
  }
  return limit;
}

function requireAdjustmentValue(adjustment: {
  type: BulkAdjustmentType;
  value: string;
}): Decimal {
  if (
    adjustment.type !== "percent" &&
    adjustment.type !== "fixed" &&
    adjustment.type !== "set"
  ) {
    throw new ValidationError(
      `Unknown bulk price adjustment "${String(adjustment.type)}".`,
      { type: adjustment.type },
    );
  }
  const parsed = parseDecimal(adjustment.value);
  if (adjustment.type === "set" && isNegative(parsed)) {
    throw new ValidationError('A "set" price must not be negative.', {
      value: adjustment.value,
    });
  }
  return parsed;
}

/** `null` means the entry is skipped (the resulting price would be negative). */
function adjustedPrice(
  current: string,
  adjustment: { type: BulkAdjustmentType },
  value: Decimal,
  scale: number,
  mode: RoundingMode,
): Decimal | null {
  const currentValue = parseDecimal(current);
  switch (adjustment.type) {
    case "percent": {
      // current × (100 + percent) / 100, exactly once rounded.
      const factor = add(parseDecimal("100"), value);
      const exact = multiply(currentValue, factor);
      const next = divideTo(exact, parseDecimal("100"), scale, mode);
      return isNegative(next) ? null : next;
    }
    case "fixed": {
      const next = rescale(add(currentValue, value), scale, mode);
      return isNegative(next) ? null : next;
    }
    case "set":
      return rescale(value, scale, mode);
    default:
      return null;
  }
}

function formatPrice(value: Decimal, scale: number): string {
  return format(rescale(value, scale, "half-up"), scale);
}

function matchesFilter(
  entry: SalesRow,
  product: SalesRow | undefined,
  request: BulkPriceRequest,
): boolean {
  const productIds = request.productIds;
  if (productIds !== undefined && productIds.length > 0) {
    const productId = text(entry.data["productId"]);
    if (productId === undefined || !productIds.includes(productId))
      return false;
  }
  const categoryIds = request.categoryIds;
  if (categoryIds !== undefined && categoryIds.length > 0) {
    const categoryId =
      product === undefined ? undefined : text(product.data["categoryId"]);
    if (categoryId === undefined || !categoryIds.includes(categoryId))
      return false;
  }
  return true;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
