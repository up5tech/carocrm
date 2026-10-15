import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { resolveDay, storedDay } from "../clock.js";
import { currencyScale, normalizeCurrencyCode } from "../money/currency.js";
import { compare, format, parseDecimal, rescale } from "../money/decimal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import { SalesSettingsService } from "../sales-settings.service.js";

/**
 * Phase 19-S.13 — the buying side of pricing (§4.11, §4.12).
 *
 * `SupplierProductPrice` is the only source this reads, and `pricing/price-resolution.service.ts` is
 * the only place sales prices are resolved. The two never consult each other's entities, which is how
 * the plan's acceptance criterion *"supplier prices cannot leak into sales pricing"* holds: there is no
 * shared resolver that could fall through from one to the other.
 *
 * The rules are the documented price-book rules, restricted to what a supplier price row has: only
 * active rows, only the document's own currency, only a window that covers the document date, and the
 * quantity break with the highest `minOrderQuantity` that the ordered quantity still reaches. Two
 * equally specific winners are a **conflict**, not a coin toss — the same policy price rules use.
 */

export interface SupplierPriceCandidate {
  readonly id: string;
  readonly unitPrice: string;
  readonly currency: string;
  readonly minOrderQuantity: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly active: boolean;
}

export interface SupplierPriceRequest {
  readonly supplierId: string;
  readonly productId: string;
  readonly quantity: string;
  readonly currency: string;
  readonly date: string;
}

export interface ResolvedSupplierPrice {
  readonly resolved: true;
  readonly supplierProductPriceId: string;
  readonly price: string;
  readonly currency: string;
  readonly quantity: string;
  readonly date: string;
  readonly explanation: string;
}

export interface UnresolvedSupplierPrice {
  readonly resolved: false;
  readonly reason: string;
  readonly currency: string;
  readonly quantity: string;
  readonly date: string;
}

export type SupplierPriceResolution =
  ResolvedSupplierPrice | UnresolvedSupplierPrice;

/** Pure: the winner among a supplier's price rows for one product, or the reason there is none. */
export function selectSupplierPrice(
  candidates: readonly SupplierPriceCandidate[],
  request: SupplierPriceRequest,
): SupplierPriceResolution {
  const quantity = parseDecimal(request.quantity);
  const eligible = candidates.filter(
    (candidate) =>
      candidate.active &&
      candidate.currency.toUpperCase() === request.currency.toUpperCase() &&
      (candidate.effectiveFrom === null ||
        candidate.effectiveFrom <= request.date) &&
      (candidate.effectiveTo === null || candidate.effectiveTo >= request.date) &&
      (candidate.minOrderQuantity === null ||
        compare(parseDecimal(candidate.minOrderQuantity), quantity) <= 0),
  );
  if (eligible.length === 0) {
    return {
      resolved: false,
      reason:
        candidates.length === 0
          ? "This supplier has no price row for this product."
          : "No active supplier price for this product covers the currency, quantity and date requested.",
      currency: request.currency,
      quantity: request.quantity,
      date: request.date,
    };
  }
  // The most specific quantity break wins; ties are ordered by id so the result is deterministic.
  const ranked = [...eligible].sort((left, right) => {
    const byQuantity = compare(
      parseDecimal(right.minOrderQuantity ?? "0"),
      parseDecimal(left.minOrderQuantity ?? "0"),
    );
    if (byQuantity !== 0) return byQuantity;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const winner = ranked[0] as SupplierPriceCandidate;
  const best = winner.minOrderQuantity ?? "0";
  const rivals = ranked.filter(
    (candidate) =>
      compare(parseDecimal(candidate.minOrderQuantity ?? "0"), parseDecimal(best)) ===
      0,
  );
  if (rivals.length > 1) {
    throw new ValidationError(
      "Two supplier prices are equally specific for this product, quantity and date; the winner is not guessed.",
      {
        supplierProductPriceIds: rivals.map((candidate) => candidate.id),
        productId: request.productId,
        supplierId: request.supplierId,
      },
    );
  }
  const scale = currencyScale(request.currency);
  return {
    resolved: true,
    supplierProductPriceId: winner.id,
    price: format(
      rescale(parseDecimal(winner.unitPrice), scale, "half-up"),
      scale,
    ),
    currency: request.currency,
    quantity: request.quantity,
    date: request.date,
    explanation:
      winner.minOrderQuantity === null
        ? `Supplier price ${winner.id} (no quantity break).`
        : `Supplier price ${winner.id} at the ${winner.minOrderQuantity} quantity break.`,
  };
}

export interface SupplierPriceQuery {
  readonly supplierId: string;
  readonly productId: string;
  readonly quantity?: string | undefined;
  readonly currency?: string | null | undefined;
  readonly date?: string | undefined;
}

@Injectable()
export class SupplierPriceService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  /**
   * The buying price of one product from one supplier. Never a sales price, and a missing price is
   * reported rather than zeroed — the same policy `PriceResolutionService` states for selling (§4.3).
   */
  async resolve(query: SupplierPriceQuery): Promise<SupplierPriceResolution> {
    await this.acl.assertAccess("SupplierProductPrice", "read");
    if ((await this.records.byId("Supplier", query.supplierId)) === undefined)
      throw new ValidationError(
        `Supplier "${query.supplierId}" does not exist.`,
        { supplierId: query.supplierId },
      );
    const settings = await this.settings.settings();
    const currency = normalizeCurrencyCode(
      query.currency ?? settings.currency.defaultCurrency,
    );
    const rows = await this.records.find(
      "SupplierProductPrice",
      { supplierId: query.supplierId, productId: query.productId },
      500,
    );
    return selectSupplierPrice(rows.map(toCandidate), {
      supplierId: query.supplierId,
      productId: query.productId,
      quantity: (query.quantity ?? "1").trim(),
      currency,
      date: resolveDay(query.date),
    });
  }
}

function toCandidate(row: SalesRow): SupplierPriceCandidate {
  return {
    id: row.id,
    unitPrice: text(row.data["unitPrice"]) ?? "0",
    currency: text(row.data["currency"]) ?? "USD",
    minOrderQuantity: text(row.data["minOrderQuantity"]) ?? null,
    effectiveFrom: storedDay(row.data["effectiveFrom"]) ?? null,
    effectiveTo: storedDay(row.data["effectiveTo"]) ?? null,
    active: row.data["active"] !== false,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
