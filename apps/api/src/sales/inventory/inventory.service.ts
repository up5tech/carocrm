import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService, type DbTx } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import { nowIso, storedDay, utcDay } from "../clock.js";
import type { StockMovementPlan } from "../document/stock-movement.js";
import { currencyScale } from "../money/currency.js";
import {
  abs,
  add,
  compare,
  type Decimal,
  format,
  isNegative,
  isZero,
  parseDecimal,
  rescale,
  subtract,
  sum,
  zero,
} from "../money/decimal.js";
import { runAsSalesInternal } from "../sales-internal.js";
import {
  type SalesEntityType,
  SalesRecords,
} from "../sales-records.js";
import {
  type SalesSettings,
  SalesSettingsService,
} from "../sales-settings.service.js";
import {
  actionRefusal,
  ADJUSTMENT_TRANSITIONS,
  assertDeltaSign,
  availableToPromise,
  type InventoryTransactionType,
  type LedgerMovement,
  levelKey,
  movementKeyFor,
  type ProjectedLevel,
  reconcileStock,
  type ReconciliationRow,
  type ReservationPolicy,
  reservationRefusal,
  signedQuantity,
  signOf,
  type StockLevel,
  stockLevel,
  TRANSFER_TRANSITIONS,
} from "./ledger.js";
import {
  allocateBatches,
  allocateSerials,
  assertSerialCountMatch,
  type BatchAllocation,
  type BatchCandidate,
  isExpired,
  normalizeIdentity,
  parseSerialNumbers,
  type RemovalPolicy,
  type SerialCandidate,
  validateLotDates,
} from "./picking.js";

/**
 * Phase 19-S.14 — the stock ledger and the projection it is reconciled against.
 *
 * `PLAN_Phase_19_Sales.md` §4.15 asks for an append-only movement ledger, availability that
 * distinguishes on-hand/reserved/available/incoming, concurrency-safe reservations and a
 * reconciliation against the ledger. This service is where those meet the database:
 *
 *  - every physical change is an `InventoryTransaction` row whose delta sign is fixed by its type
 *    (`ledger.ts`), written through the Entity Engine so audit/stream/search/ACL come from the
 *    kernel;
 *  - the fast, lockable figures live in `sales_inventory_stock`, which is **derived** — a projection
 *    of the ledger, never a second truth, and `reconcile()` is what proves it (task 10: a
 *    discrepancy is *reported*, never auto-corrected);
 *  - a reservation is a soft promise: it reduces `available` and never touches `on_hand`.
 *
 * Concurrency (§4.15 invariant 7) is a row lock: every operation that reads-and-writes a pair's
 * level calls `lockLevel()`, which takes `SELECT … FOR UPDATE` on the (product, warehouse) row, so
 * two confirmations cannot both promise the last unit. Movements are idempotent by `movementKey`,
 * which is derived from the source document and line — never from a request (§4.15 invariant 2).
 *
 * No provider, clock or socket is involved; the one external effect (an outbox event) is written in
 * the same transaction as the row that caused it.
 */

export interface MovementContext {
  readonly actor?: string | null | undefined;
  readonly correlationId?: string | null | undefined;
}

export interface MovementResult {
  readonly applied: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly transactionIds: readonly string[];
}

export interface ReservationView {
  readonly id: string;
  readonly status: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly quantity: string;
  readonly consumedQuantity: string;
  readonly reservation: Record<string, unknown>;
}

export interface AvailableStockView extends StockLevel {
  readonly productId: string;
  readonly warehouseId: string;
}

export interface StockLevelRow extends AvailableStockView {
  readonly name: string | null;
}

export interface ReserveStockInput {
  readonly productId: string;
  readonly quantity: string;
  readonly warehouseId?: string | null | undefined;
  readonly sourceEntity?: string | null | undefined;
  readonly sourceId?: string | null | undefined;
  readonly sourceNumber?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
}

export interface ReconcileResult {
  readonly checked: number;
  readonly mismatches: readonly ReconciliationRow[];
  readonly ok: boolean;
  /** 19-S.15: how many tracked (product, warehouse) pairs were compared against their identity. */
  readonly identityChecked: number;
  /** Lots/serials attributed versus physical on-hand — a difference is reported, never corrected. */
  readonly identityMismatches: readonly IdentityRow[];
  readonly identityOk: boolean;
}

/** 19-S.15 — physical on-hand versus the stock attributed to lots/serials for a tracked pair. */
export interface IdentityRow {
  readonly productId: string;
  readonly warehouseId: string;
  readonly tracking: "batch" | "serial";
  /** Sum of lot stock (batch) or the count of units whose status is `inStock` (serial). */
  readonly attributed: string;
  readonly onHand: string;
  readonly difference: string;
  readonly ok: boolean;
}

/** How a product's stock is identified when it moves (19-S.15 `Product.stockTracking`). */
export type ProductTracking = "none" | "batch" | "serial";

/** A bounded page of lot stock with the lot's dates, for the stock/batch views (19-S.15). */
export interface BatchStockRow {
  readonly productId: string;
  readonly warehouseId: string;
  readonly batchNumber: string;
  readonly onHand: string;
  readonly expiryDate: string | null;
  readonly manufacturingDate: string | null;
  readonly receivedAt: string | null;
}

/** What the configured removal policy would pick right now — the line editor's suggestion (task 7). */
export interface PickingSuggestionView {
  readonly productId: string;
  readonly warehouseId: string;
  readonly tracking: ProductTracking;
  readonly policy: RemovalPolicy;
  readonly requested: string;
  readonly allocations: readonly BatchAllocation[];
  readonly serialNumbers: readonly string[];
  /** Unfulfilled units (batches) or unit count (serials); `"0"` when the pick is complete. */
  readonly shortage: string;
  /** What the configured policy considers eligible right now (lots with stock / units in stock). */
  readonly attributedAvailable: string;
  readonly onHand: string;
}

interface StockLockRow {
  readonly onHand: Decimal;
  readonly reserved: Decimal;
}

const LEDGER_ENTITY: SalesEntityType = "InventoryTransaction";
const RESERVATION_ENTITY: SalesEntityType = "InventoryReservation";
const BATCH_ENTITY: SalesEntityType = "InventoryBatch";
const SERIAL_ENTITY: SalesEntityType = "InventorySerial";
const SCAN_LIMIT = 2_000;

/** Identity resolved for a movement whose product is not tracked — the 19-S.14 behaviour. */
const NO_IDENTITY = { batches: null, serials: null } as const;

interface ResolvedIdentity {
  /** Positive lot quantities this movement accounts for, or `null` when the product is not lot-tracked. */
  readonly batches: readonly BatchAllocation[] | null;
  readonly serials: readonly string[] | null;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------------------------------------
  // Enablement and warehouses
  // ---------------------------------------------------------------------------------------------

  /**
   * The explicit enablement guard (§4.15 "enable inventory only through an explicit setting").
   *
   * With the flag off the module behaves exactly as it did before 19-S.14: a confirmed document
   * records the movement it stands for in its snapshot and nothing is applied. A command that only
   * exists because inventory is on is refused with the setting named, not silently no-op'd.
   */
  async requireEnabled(): Promise<SalesSettings> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) {
      throw new ValidationError(
        "Inventory is not enabled. Turn on the Sales inventory feature before using stock commands.",
        { feature: "inventory" },
      );
    }
    return settings;
  }

  /**
   * Resolve the warehouse a movement applies to: the one the document/command named, otherwise the
   * configured default. A stock movement without a location is refused rather than guessed.
   */
  async requireWarehouse(
    id: string | null | undefined,
    settings: SalesSettings,
  ): Promise<string> {
    const candidate =
      text(id ?? undefined) ?? settings.inventory.defaultWarehouseId ?? undefined;
    if (candidate === undefined) {
      throw new ValidationError(
        "Inventory is enabled, so a stock movement must name a warehouse (or a default warehouse must be configured in Sales settings).",
        { warehouseId: id ?? null },
      );
    }
    const warehouse = await this.records.byId("Warehouse", candidate);
    if (warehouse === undefined) {
      throw new ValidationError(`Warehouse "${candidate}" does not exist.`, {
        warehouseId: candidate,
      });
    }
    if (warehouse.data["active"] === false) {
      throw new ValidationError(`Warehouse "${candidate}" is inactive.`, {
        warehouseId: candidate,
      });
    }
    return candidate;
  }

  /** Refuse a product that is not stock-managed, for a command that only makes sense for stock. */
  async assertStockManaged(productId: string): Promise<void> {
    const settings = await this.requireEnabled();
    if (!(await this.isStockManaged(productId, settings))) {
      throw new ValidationError(
        `Product "${productId}" is not stock-managed, so it cannot take part in a stock movement.`,
        { productId },
      );
    }
  }

  /** Whether this product takes part in stock at all (`inventory.stockManagedProductTypes`). */
  private async isStockManaged(
    productId: string,
    settings: SalesSettings,
  ): Promise<boolean> {
    const product =
      productId === ""
        ? undefined
        : await this.records.byId("Product", productId);
    if (product === undefined) {
      throw new ValidationError(`Product "${productId}" does not exist.`, {
        productId,
      });
    }
    const type = text(product.data["productType"]) ?? "Goods";
    return settings.inventory.stockManagedProductTypes.includes(type);
  }

  // ---------------------------------------------------------------------------------------------
  // Applying movements
  // ---------------------------------------------------------------------------------------------

  /**
   * Apply the movement plan a confirmed delivery/return/receipt froze into its snapshot.
   *
   * Returns without writing anything when inventory is off — the plan is still recorded on the
   * document, which is the honest state for "this install does not track stock".
   */
  async applyMovementPlan(
    plan: StockMovementPlan,
    context: MovementContext = {},
  ): Promise<MovementResult> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) return emptyResult();
    const incoming = text(plan.warehouseId);
    const warehouseId =
      incoming === undefined ? undefined : await this.requireWarehouse(incoming, settings);
    const movements: LedgerMovement[] = [];
    for (const line of plan.lines) {
      if (plan.kind === "return" && !line.restocked) continue;
      const productId = text(line.productId);
      if (productId === undefined || line.quantity === "0") continue;
      const type: InventoryTransactionType =
        plan.kind === "delivery"
          ? "delivery"
          : plan.kind === "return"
            ? "return"
            : "receipt";
      const sign = signOf(type);
      movements.push({
        movementKey: movementKeyFor(
          plan.documentEntity,
          plan.documentId,
          type,
          line.position,
        ),
        type,
        productId,
        warehouseId: text(line.warehouseId) ?? warehouseId ?? "",
        quantityDelta: signedQuantity(line.quantity, sign === -1 ? -1 : 1),
        sourceEntity: plan.documentEntity,
        sourceId: plan.documentId,
        sourceNumber: plan.documentNumber,
        reason: null,
        // 19-S.15: the identity this line froze into the snapshot — the lot/units named on the
        // document, or `null` for "pick by the configured removal policy when the movement applies".
        batchNumber: line.batchNumber,
        serialNumbers: line.serialNumbers,
        manufacturingDate: line.manufacturingDate,
        expiryDate: line.expiryDate,
      });
    }
    return await this.recordMovements(movements, context);
  }

  /** Reserve stock for the lines of a confirmed sales order (§6.2 "confirmation plus reservation"). */
  async reserveForSalesOrder(
    orderId: string,
    orderNumber: string | null,
    warehouseId: string | null,
    lines: readonly {
      readonly productId: string | null;
      readonly quantity: string;
    }[],
    context: MovementContext = {},
  ): Promise<number> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) return 0;
    if (settings.inventory.reservationPolicy === "none") return 0;
    const resolved = await this.requireWarehouse(warehouseId, settings);
    const actor = actorOf(context, this.scope);
    return await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) => {
        let created = 0;
        for (const line of lines) {
          const productId = text(line.productId ?? undefined);
          if (productId === undefined || line.quantity === "0") continue;
          if (!(await this.isStockManaged(productId, settings))) continue;
          await this.placeReservation(
            tx,
            {
              productId,
              warehouseId: resolved,
              quantity: line.quantity,
              sourceEntity: "SalesOrder",
              sourceId: orderId,
              sourceNumber: orderNumber,
            },
            settings,
            actor,
          );
          created += 1;
        }
        return created;
      }),
    );
  }

  /**
   * Consume the reservations a shipment fulfils, bounded by what is reserved.
   *
   * Called with the delivery's own movement plan inside the same transaction, so the physical move
   * and the reservation it settles commit together (or not at all).
   */
  async consumeReservationsForMove(
    plan: StockMovementPlan,
    source: { readonly entity: string; readonly id: string },
    context: MovementContext = {},
  ): Promise<number> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) return 0;
    let consumed = 0;
    await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) => {
        for (const line of plan.lines) {
          if (plan.kind === "return" && !line.restocked) continue;
          const productId = text(line.productId);
          const warehouseId = text(line.warehouseId) ?? text(plan.warehouseId);
          if (productId === undefined || warehouseId === undefined) continue;
          consumed += await this.consumeFrom(
            tx,
            productId,
            warehouseId,
            line.quantity,
            source,
            context,
          );
        }
      }),
    );
    return consumed;
  }

  /** Release every active reservation a source document placed — an order was cancelled. */
  async releaseReservationsForSource(
    sourceEntity: string,
    sourceId: string,
    reason: string | null,
    context: MovementContext = {},
  ): Promise<number> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) return 0;
    const active = await this.records.find(
      RESERVATION_ENTITY,
      { sourceEntity, sourceId, status: "active" },
      SCAN_LIMIT,
    );
    if (active.length === 0) return 0;
    const actor = actorOf(context, this.scope);
    await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) => {
        for (const row of active) {
          const productId = text(row.data["productId"]);
          const warehouseId = text(row.data["warehouseId"]);
          const quantity = text(row.data["quantity"]) ?? "0";
          await this.entities.update(RESERVATION_ENTITY, row.id, {
            status: "released",
            releasedAt: new Date(),
            releasedBy: actor,
            releaseReason: reason ?? null,
          });
          if (productId !== undefined && warehouseId !== undefined)
            await this.adjustReserved(tx, productId, warehouseId, quantity, -1);
        }
      }),
    );
    return active.length;
  }

  /**
   * The one write path for the ledger. Every movement is idempotent (its `movementKey`), its sign is
   * checked against its type, and a movement that would take a warehouse below zero is refused
   * unless the policy explicitly allows it (§4.15 invariants 2 and 3).
   */
  async recordMovements(
    movements: readonly LedgerMovement[],
    context: MovementContext = {},
  ): Promise<MovementResult> {
    const settings = await this.settings.settings();
    if (!settings.features.inventory) return emptyResult();
    if (movements.length === 0) return emptyResult();
    const actor = actorOf(context, this.scope);
    const occurredAt = nowIso();

    return await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) => {
        const transactionIds: string[] = [];
        let duplicates = 0;
        let skipped = 0;
        const stockManaged = new Map<string, boolean>();
        for (const movement of movements) {
          assertDeltaSign(movement.type, movement.quantityDelta);
          const managed =
            stockManaged.get(movement.productId) ??
            (await this.isStockManaged(movement.productId, settings));
          stockManaged.set(movement.productId, managed);
          if (!managed) {
            skipped += 1;
            continue;
          }
          if (movement.warehouseId === "") {
            throw new ValidationError(
              "A stock movement must name a warehouse.",
              { movementKey: movement.movementKey },
            );
          }
          const existing = await this.records.idsMatching(
            LEDGER_ENTITY,
            "movementKey",
            movement.movementKey,
          );
          if (existing.length > 0) {
            duplicates += 1;
            continue;
          }
          const level = await this.lockLevel(
            tx,
            movement.productId,
            movement.warehouseId,
          );
          const delta = parseDecimal(movement.quantityDelta);
          const nextOnHand = add(level.onHand, delta);
          if (
            isNegative(nextOnHand) &&
            !settings.inventory.allowNegativeStock
          ) {
            throw new ValidationError(
              `Warehouse "${movement.warehouseId}" would go negative: it holds ${format(level.onHand)} and this movement is ${movement.quantityDelta}. Enable negative stock, or receive/adjust stock first.`,
              {
                productId: movement.productId,
                warehouseId: movement.warehouseId,
                onHand: format(level.onHand),
                quantityDelta: movement.quantityDelta,
              },
            );
          }
          // 19-S.15 — stock identity. Resolved under the pair's lock, so a policy pick can never
          // race another movement for the same lot/unit, and refused before the row is written
          // (this transaction rolls the whole confirmation back).
          const identity = await this.resolveIdentity(movement, delta, settings);
          const created = await this.entities.create(LEDGER_ENTITY, {
            name: `${movement.type} ${movement.quantityDelta}`,
            transactionType: movement.type,
            productId: movement.productId,
            warehouseId: movement.warehouseId,
            quantityDelta: movement.quantityDelta,
            balanceAfter: format(nextOnHand),
            sourceEntity: movement.sourceEntity,
            sourceId: movement.sourceId,
            sourceNumber: movement.sourceNumber,
            movementKey: movement.movementKey,
            transferGroupId: movement.transferGroupId ?? null,
            reason: movement.reason,
            occurredAt: movement.occurredAt ?? occurredAt,
            actor,
            ...(identity.batches !== null && identity.batches.length > 0
              ? {
                  // The first lot for a fast filter, the full split for the audit trail.
                  batchNumber: identity.batches[0]?.batchNumber ?? null,
                  batchAllocations: JSON.stringify(identity.batches),
                }
              : {}),
            ...(identity.serials !== null
              ? { serialNumbers: JSON.stringify(identity.serials) }
              : {}),
          });
          const id = text(created["id"]);
          if (id !== undefined) transactionIds.push(id);
          await this.writeOnHand(
            tx,
            movement.productId,
            movement.warehouseId,
            nextOnHand,
          );
          await this.applyIdentity(tx, movement, identity, delta, settings);
          await this.outbox.insertMany(tx, [
            {
              eventType: "sales.inventory.transaction.created",
              payload: {
                transactionId: id ?? null,
                type: movement.type,
                productId: movement.productId,
                warehouseId: movement.warehouseId,
                quantityDelta: movement.quantityDelta,
                balanceAfter: format(nextOnHand),
                sourceEntity: movement.sourceEntity,
                sourceId: movement.sourceId,
                actor,
                correlationId: context.correlationId ?? null,
                occurredAt,
                ...(identity.batches !== null && identity.batches.length > 0
                  ? { batchNumber: identity.batches[0]?.batchNumber ?? null }
                  : {}),
                ...(identity.serials !== null
                  ? { serialCount: identity.serials.length }
                  : {}),
              },
            },
          ]);
        }
        return {
          applied: transactionIds.length,
          duplicates,
          skipped,
          transactionIds,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Stock identity (19-S.15): lots and serials
  // ---------------------------------------------------------------------------------------------

  /** How this product's stock is identified — `Product.stockTracking`, defaulting to `none`. */
  private async trackingOf(productId: string): Promise<ProductTracking> {
    const product = await this.records.byId("Product", productId);
    if (product === undefined) {
      throw new ValidationError(`Product "${productId}" does not exist.`, {
        productId,
      });
    }
    const value = text(product.data["stockTracking"]);
    return value === "batch" || value === "serial" ? value : "none";
  }

  /**
   * Which lots/units this movement accounts for, decided while the pair's row lock is held.
   *
   * Rules (§4.15, §19-S.15):
   *  - a product that is not tracked keeps the exact 19-S.14 behaviour — identity is ignored;
   *  - an **inbound** movement must name its identity (there is nothing to pick from when goods
   *    arrive), a lot for a lot-tracked product and every unit for a serialised one;
   *  - an **outbound** movement that named nothing is split by the configured removal policy —
   *    FIFO/FEFO/LIFO, expired lots excluded, ties broken by the lot number (deterministic);
   *  - a shortage on a document movement is a refusal; only a reviewed *adjustment* may leave an
   *    unattributed remainder, because unattributed stock is exactly what such a correction fixes —
   *    and the identity reconciliation then reports the difference instead of hiding it.
   */
  private async resolveIdentity(
    movement: LedgerMovement,
    delta: Decimal,
    settings: SalesSettings,
  ): Promise<ResolvedIdentity> {
    if (isZero(delta)) return NO_IDENTITY;
    const tracking = await this.trackingOf(movement.productId);
    if (tracking === "none") return NO_IDENTITY;
    const inbound = !isNegative(delta);
    const magnitude = format(abs(delta));
    return tracking === "batch"
      ? await this.resolveBatchIdentity(movement, inbound, magnitude, settings)
      : await this.resolveSerialIdentity(movement, inbound, magnitude, settings);
  }

  private async resolveBatchIdentity(
    movement: LedgerMovement,
    inbound: boolean,
    magnitude: string,
    settings: SalesSettings,
  ): Promise<ResolvedIdentity> {
    const source = `${movement.sourceEntity} "${movement.sourceId}"`;
    // A transfer receive re-applies exactly what its dispatch recorded — same lots, same splits —
    // which is what keeps both halves traceable to the same units (§19-S.15 acceptance).
    const preResolved = movement.batchAllocations;
    if (preResolved !== null && preResolved !== undefined && preResolved.length > 0) {
      const allocations: BatchAllocation[] = [];
      let total = zero(0);
      for (const allocation of preResolved) {
        const batchNumber = normalizeIdentity(allocation.batchNumber, "batchNumber");
        const quantity = parseDecimal(allocation.quantity);
        if (isNegative(quantity) || isZero(quantity)) {
          throw new ValidationError(
            "A lot allocation must be a positive quantity.",
            { batchNumber, quantity: allocation.quantity },
          );
        }
        allocations.push({ batchNumber, quantity: format(quantity, quantity.scale) });
        total = add(total, quantity);
      }
      if (compare(total, parseDecimal(magnitude)) !== 0) {
        throw new ValidationError(
          `The recorded lot split (${format(total)}) does not match the moved quantity (${magnitude}).`,
          { movementKey: movement.movementKey },
        );
      }
      if (inbound)
        for (const allocation of allocations)
          await this.ensureBatch(movement, allocation.batchNumber);
      return { batches: allocations, serials: null };
    }
    const explicit = text(movement.batchNumber ?? undefined);
    if (inbound) {
      if (explicit === undefined) {
        throw new ValidationError(
          `Product "${movement.productId}" is lot-tracked: this "${movement.type}" movement must name the lot it brings stock into (batchNumber on ${source}).`,
          {
            productId: movement.productId,
            movementKey: movement.movementKey,
            batchNumber: null,
          },
        );
      }
      const batchNumber = normalizeIdentity(explicit, "batchNumber");
      validateLotDates({
        manufacturingDate: storedDay(movement.manufacturingDate ?? undefined),
        expiryDate: storedDay(movement.expiryDate ?? undefined),
        today: utcDay(),
      });
      await this.ensureBatch(movement, batchNumber);
      return {
        batches: [{ batchNumber, quantity: magnitude }],
        serials: null,
      };
    }
    if (explicit !== undefined) {
      // An explicitly named lot is the operator's decision — including a lot the policy would not
      // auto-pick. Its stock is still checked against the movement when the delta is applied.
      return {
        batches: [
          { batchNumber: normalizeIdentity(explicit, "batchNumber"), quantity: magnitude },
        ],
        serials: null,
      };
    }
    const candidates = await this.batchCandidates(
      movement.productId,
      movement.warehouseId,
    );
    const pick = allocateBatches(
      settings.inventory.removalPolicy,
      candidates,
      magnitude,
      {
        today: utcDay(),
        excludeExpired: settings.inventory.excludeExpiredStock,
      },
    );
    if (compare(parseDecimal(pick.shortage), zero(0)) > 0) {
      if (movement.type === "adjustment") {
        return { batches: [...pick.allocations], serials: null };
      }
      throw await this.batchShortageError(
        movement,
        magnitude,
        pick.shortage,
        candidates,
        settings,
      );
    }
    return { batches: pick.allocations, serials: null };
  }

  /** The refusal an unattributable outbound document movement gets, worded for the operator. */
  private async batchShortageError(
    movement: LedgerMovement,
    magnitude: string,
    shortage: string,
    candidates: readonly BatchCandidate[],
    settings: SalesSettings,
  ): Promise<ValidationError> {
    const today = utcDay();
    const inEligible = candidates.filter(
      (candidate) =>
        !settings.inventory.excludeExpiredStock ||
        !isExpired(candidate.expiryDate, today),
    );
    const eligible = format(
      sum(inEligible.map((candidate) => parseDecimal(candidate.onHand))),
    );
    const attributed = format(
      sum(candidates.map((candidate) => parseDecimal(candidate.onHand))),
    );
    const level = await this.readLevel(
      movement.productId,
      movement.warehouseId,
    );
    const onHand = format(level.onHand);
    const excluded =
      settings.inventory.excludeExpiredStock &&
      inEligible.length !== candidates.length
        ? " Expired lots are excluded (inventory.excludeExpiredStock)."
        : "";
    const unattributed = subtract(level.onHand, parseDecimal(attributed));
    const hint =
      isNegative(unattributed) || isZero(unattributed)
        ? ""
        : ` Product on-hand is ${onHand}, so ${format(unattributed)} of it is not attributed to any lot — receive it with a batchNumber, or correct it with a reviewed adjustment that names the lot.`;
    return new ValidationError(
      `Under the "${settings.inventory.removalPolicy}" removal policy only ${eligible} of product "${movement.productId}" in warehouse "${movement.warehouseId}" sits in eligible lots, and the movement needs ${magnitude} (${shortage} short).${excluded}${hint}`,
      {
        productId: movement.productId,
        warehouseId: movement.warehouseId,
        requested: magnitude,
        eligible,
        attributed,
        shortage,
        policy: settings.inventory.removalPolicy,
        movementKey: movement.movementKey,
      },
    );
  }

  private async resolveSerialIdentity(
    movement: LedgerMovement,
    inbound: boolean,
    magnitude: string,
    settings: SalesSettings,
  ): Promise<ResolvedIdentity> {
    const source = `${movement.sourceEntity} "${movement.sourceId}"`;
    const explicit =
      movement.serialNumbers === null || movement.serialNumbers === undefined
        ? null
        : parseSerialNumbers(movement.serialNumbers);
    if (inbound) {
      if (explicit === null || explicit.length === 0) {
        throw new ValidationError(
          `Product "${movement.productId}" is serial-tracked: this "${movement.type}" movement must name the serial numbers it creates (serialNumbers on ${source}).`,
          {
            productId: movement.productId,
            movementKey: movement.movementKey,
            serialNumbers: null,
          },
        );
      }
      assertSerialCountMatch(magnitude, explicit);
      for (const serial of explicit) await this.assertInboundSerial(serial, movement);
      return { batches: null, serials: explicit };
    }
    if (explicit === null) {
      const candidates = await this.serialCandidates(
        movement.productId,
        movement.warehouseId,
      );
      const pick = allocateSerials(settings.inventory.removalPolicy, candidates, magnitude);
      if (Number(pick.shortage) > 0) {
        throw new ValidationError(
          `Only ${String(candidates.length)} serialised unit(s) of product "${movement.productId}" are in stock in warehouse "${movement.warehouseId}" and this movement needs ${magnitude}; ${pick.shortage} unit(s) are not accounted for. Reconcile the serial records before moving stock.`,
          {
            productId: movement.productId,
            warehouseId: movement.warehouseId,
            requested: magnitude,
            inStock: String(candidates.length),
            shortage: pick.shortage,
            movementKey: movement.movementKey,
          },
        );
      }
      return { batches: null, serials: pick.serialNumbers };
    }
    assertSerialCountMatch(magnitude, explicit);
    for (const serial of explicit) await this.assertOutboundSerial(serial, movement);
    return { batches: null, serials: explicit };
  }

  /** The stored serial record for one number within one product, case-insensitively. */
  private async findSerialRecord(
    serialNumber: string,
    productId: string,
  ): Promise<{ readonly id: string; readonly data: Record<string, unknown> } | undefined> {
    const rows = await this.records.findByCode(
      SERIAL_ENTITY,
      "serialNumber",
      serialNumber,
      10,
    );
    const match = rows.find(
      (row) =>
        text(row.data["productId"]) === productId &&
        (text(row.data["serialNumber"]) ?? "").toUpperCase() === serialNumber,
    );
    return match === undefined ? undefined : { id: match.id, data: match.data };
  }

  /** An inbound movement may only name units that are not already counted here (§19-S.15). */
  private async assertInboundSerial(
    serialNumber: string,
    movement: LedgerMovement,
  ): Promise<void> {
    const existing = await this.findSerialRecord(serialNumber, movement.productId);
    if (existing === undefined) return; // A new unit — the receive creates its record.
    const status = text(existing.data["status"]) ?? "inStock";
    if (status === "inStock") {
      throw new ValidationError(
        `Serial "${serialNumber}" is already in stock in warehouse "${text(existing.data["warehouseId"]) ?? "?"}"; receiving it again would count the unit twice.`,
        {
          serialNumber,
          productId: movement.productId,
          movementKey: movement.movementKey,
        },
      );
    }
    if (status === "retired") {
      throw new ValidationError(
        `Serial "${serialNumber}" was retired; a retired unit does not come back into stock. Receive it as a new serial, or record the movement that accounts for it.`,
        {
          serialNumber,
          productId: movement.productId,
          movementKey: movement.movementKey,
        },
      );
    }
    // `shipped` (a customer return) and `inTransit` (a transfer arriving) may come back in.
  }

  /** An outbound movement may only consume units that are in stock *here* (§19-S.15 task 5). */
  private async assertOutboundSerial(
    serialNumber: string,
    movement: LedgerMovement,
  ): Promise<void> {
    const existing = await this.findSerialRecord(serialNumber, movement.productId);
    if (existing === undefined) {
      throw new ValidationError(
        `Serial "${serialNumber}" does not exist for product "${movement.productId}"; a unit cannot leave stock without its record.`,
        {
          serialNumber,
          productId: movement.productId,
          movementKey: movement.movementKey,
        },
      );
    }
    const status = text(existing.data["status"]) ?? "inStock";
    const warehouseId = text(existing.data["warehouseId"]);
    if (status !== "inStock" || warehouseId !== movement.warehouseId) {
      throw new ValidationError(
        `Serial "${serialNumber}" is ${status}${warehouseId === null || warehouseId === undefined ? "" : ` in warehouse "${warehouseId}"`}, so it cannot move out of warehouse "${movement.warehouseId}".`,
        {
          serialNumber,
          status,
          serialWarehouseId: warehouseId ?? null,
          movementKey: movement.movementKey,
        },
      );
    }
  }

  /** Create the lot record a receive brings stock into, or reconcile its dates with the receive. */
  private async ensureBatch(
    movement: LedgerMovement,
    batchNumber: string,
  ): Promise<void> {
    const manufacturing = storedDay(movement.manufacturingDate ?? undefined) ?? null;
    const expiry = storedDay(movement.expiryDate ?? undefined) ?? null;
    const productId = movement.productId;
    const existing = (
      await this.records.findByCode(BATCH_ENTITY, "batchNumber", batchNumber, 10)
    ).find((row) => text(row.data["productId"]) === productId);
    if (existing === undefined) {
      await this.entities.create(BATCH_ENTITY, {
        name: batchNumber,
        productId,
        batchNumber,
        manufacturingDate: manufacturing,
        expiryDate: expiry,
        receivedAt: movement.occurredAt ?? nowIso(),
        sourceEntity: movement.sourceEntity,
        sourceId: movement.sourceId,
        sourceNumber: movement.sourceNumber,
      });
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const [field, value] of [
      ["manufacturingDate", manufacturing],
      ["expiryDate", expiry],
    ] as const) {
      if (value === null) continue;
      const stored = storedDay(existing.data[field]);
      if (stored === undefined) {
        patch[field] = value;
      } else if (stored !== value) {
        throw new ValidationError(
          `Lot "${batchNumber}" was already recorded with ${field} ${stored}; a later receive cannot re-date it to ${value}. Correct the batch record deliberately instead.`,
          {
            batchNumber,
            field,
            receivedValue: value,
            storedValue: stored,
          },
        );
      }
    }
    if (Object.keys(patch).length > 0)
      await this.entities.update(BATCH_ENTITY, existing.id, patch);
  }

  /** Write the lot/unit state changes the movement stands for — same transaction as the ledger row. */
  private async applyIdentity(
    tx: DbTx,
    movement: LedgerMovement,
    identity: ResolvedIdentity,
    delta: Decimal,
    settings: SalesSettings,
  ): Promise<void> {
    const inbound = !isNegative(delta);
    if (identity.batches !== null) {
      const sign: 1 | -1 = inbound ? 1 : -1;
      for (const allocation of identity.batches) {
        await this.applyBatchDelta(
          tx,
          movement.productId,
          movement.warehouseId,
          allocation.batchNumber,
          signedQuantity(allocation.quantity, sign),
          settings,
        );
      }
    }
    if (identity.serials !== null) {
      const status = inbound
        ? "inStock"
        : movement.type === "delivery"
          ? "shipped"
          : movement.type === "transferOut"
            ? "inTransit"
            : "retired";
      const occurredAt = movement.occurredAt ?? nowIso();
      for (const serialNumber of identity.serials) {
        const existing = await this.findSerialRecord(serialNumber, movement.productId);
        const trail = {
          status,
          lastMovementAt: occurredAt,
          sourceEntity: movement.sourceEntity,
          sourceId: movement.sourceId,
          sourceNumber: movement.sourceNumber,
        };
        if (existing === undefined) {
          // Only an inbound movement reaches here — an outbound one was asserted to exist above.
          await this.entities.create(SERIAL_ENTITY, {
            name: serialNumber,
            serialNumber,
            productId: movement.productId,
            warehouseId: movement.warehouseId,
            receivedAt: occurredAt,
            ...trail,
          });
        } else {
          await this.entities.update(SERIAL_ENTITY, existing.id, {
            ...trail,
            // Inbound stock arrives *here*; outbound stock keeps its last known location until the
            // receiving side of a transfer names the destination (§19-S.15 traceability).
            ...(inbound ? { warehouseId: movement.warehouseId } : {}),
          });
        }
      }
    }
  }

  /**
   * Move a lot's attributed stock by a signed quantity (upsert), then hold it to the negative-stock
   * policy. Called with the pair's row lock already held, so lot totals cannot drift through races.
   */
  private async applyBatchDelta(
    tx: DbTx,
    productId: string,
    warehouseId: string,
    batchNumber: string,
    quantity: string,
    settings: SalesSettings,
  ): Promise<void> {
    const rows = await sql<{ on_hand: string }>`
      insert into sales_inventory_batch_stock (product_id, warehouse_id, batch_number, on_hand)
      values (${productId}, ${warehouseId}, ${batchNumber}, ${quantity})
      on conflict (product_id, warehouse_id, batch_number)
      do update set on_hand = sales_inventory_batch_stock.on_hand + ${quantity},
                    modified_at = now()
      returning on_hand::text as on_hand
    `.execute(tx);
    const next = parseDecimal(rows.rows[0]?.on_hand ?? "0");
    if (isNegative(next) && !settings.inventory.allowNegativeStock) {
      throw new ValidationError(
        `Lot "${batchNumber}" would go negative in warehouse "${warehouseId}": ${format(next)} after this movement. Pick another lot, name one that holds stock, or use a reviewed adjustment with negative stock enabled.`,
        { productId, warehouseId, batchNumber, onHand: format(next) },
      );
    }
  }

  /** The lots of one product in one warehouse that hold stock, with the dates the policy orders by. */
  private async batchCandidates(
    productId: string,
    warehouseId: string,
  ): Promise<BatchCandidate[]> {
    const rows = await sql<{ batch_number: string; on_hand: string }>`
      select batch_number, on_hand::text as on_hand
      from sales_inventory_batch_stock
      where product_id = ${productId} and warehouse_id = ${warehouseId}
        and on_hand > 0
      order by batch_number asc
    `.execute(this.db);
    if (rows.rows.length === 0) return [];
    const metadata = new Map<string, Record<string, unknown>>();
    for (const record of await this.records.find(
      BATCH_ENTITY,
      { productId },
      SCAN_LIMIT,
    )) {
      const number = text(record.data["batchNumber"]);
      if (number !== undefined) metadata.set(number.toUpperCase(), record.data);
    }
    return rows.rows.map((row) => {
      const lot = metadata.get(row.batch_number.toUpperCase());
      return {
        batchNumber: row.batch_number,
        onHand: format(parseDecimal(row.on_hand)),
        expiryDate: storedDay(lot?.["expiryDate"]) ?? null,
        receivedAt: instantOf(lot?.["receivedAt"]),
      };
    });
  }

  /** The units of one product in one warehouse whose status is `inStock`. */
  private async serialCandidates(
    productId: string,
    warehouseId: string,
  ): Promise<SerialCandidate[]> {
    const rows = await this.records.find(
      SERIAL_ENTITY,
      { productId, warehouseId, status: "inStock" },
      SCAN_LIMIT,
    );
    return rows.map((row) => ({
      serialNumber: text(row.data["serialNumber"]) ?? row.id,
      receivedAt: instantOf(row.data["receivedAt"]),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Reservations
  // ---------------------------------------------------------------------------------------------

  async reserve(input: ReserveStockInput): Promise<ReservationView> {
    await this.acl.assertAccess(RESERVATION_ENTITY, "create");
    const settings = await this.requireEnabled();
    const warehouseId = await this.requireWarehouse(input.warehouseId, settings);
    if (!(await this.isStockManaged(input.productId, settings))) {
      throw new ValidationError(
        `Product "${input.productId}" is not stock-managed, so it cannot be reserved.`,
        { productId: input.productId },
      );
    }
    const actor = actorOf({}, this.scope);
    return await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) =>
        toReservationView(
          await this.placeReservation(
            tx,
            {
              productId: input.productId,
              warehouseId,
              quantity: input.quantity,
              sourceEntity: input.sourceEntity ?? null,
              sourceId: input.sourceId ?? null,
              sourceNumber: input.sourceNumber ?? null,
              expiresAt: input.expiresAt ?? null,
            },
            settings,
            actor,
          ),
        ),
      ),
    );
  }

  /**
   * Create the reservation row and move the projection's `reserved` figure, under the pair's lock.
   *
   * Shared by the manual `reserve` command and an order's confirmation, so the over-reservation
   * policy is applied in exactly one place.
   */
  private async placeReservation(
    tx: DbTx,
    input: {
      readonly productId: string;
      readonly warehouseId: string;
      readonly quantity: string;
      readonly sourceEntity?: string | null | undefined;
      readonly sourceId?: string | null | undefined;
      readonly sourceNumber?: string | null | undefined;
      readonly expiresAt?: string | null | undefined;
    },
    settings: SalesSettings,
    actor: string | null,
  ): Promise<Record<string, unknown>> {
    const level = await this.lockLevel(tx, input.productId, input.warehouseId);
    const available = availableToPromise(
      format(level.onHand),
      format(level.reserved),
    );
    const refusal = reservationRefusal({
      policy: settings.inventory.reservationPolicy as ReservationPolicy,
      available,
      quantity: input.quantity,
    });
    if (refusal !== null) {
      throw new ValidationError(refusal, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        available,
        quantity: input.quantity,
      });
    }
    const created = await this.entities.create(RESERVATION_ENTITY, {
      name: `reservation ${input.quantity}`,
      productId: input.productId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      consumedQuantity: "0",
      sourceEntity: input.sourceEntity ?? null,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      status: "active",
      reservedAt: new Date(),
      reservedBy: actor,
      expiresAt: input.expiresAt ?? null,
    });
    await this.writeReserved(
      tx,
      input.productId,
      input.warehouseId,
      add(level.reserved, parseDecimal(input.quantity)),
    );
    return created;
  }

  /** Release one reservation, freeing the stock it promised. Idempotent for a non-active row. */
  async releaseReservation(
    id: string,
    reason: string | null,
  ): Promise<ReservationView> {
    await this.acl.assertAccess(RESERVATION_ENTITY, "edit");
    await this.requireEnabled();
    const row = await this.records.byId(RESERVATION_ENTITY, id);
    if (row === undefined) {
      throw new ValidationError(`Reservation "${id}" does not exist.`, { id });
    }
    const status = text(row.data["status"]) ?? "active";
    if (status !== "active") {
      throw new ValidationError(
        `This reservation is "${status}"; only an active reservation can be released.`,
        { id, status },
      );
    }
    const actor = actorOf({}, this.scope);
    const productId = text(row.data["productId"]);
    const warehouseId = text(row.data["warehouseId"]);
    const quantity = text(row.data["quantity"]) ?? "0";
    const updated = await runAsSalesInternal(() =>
      runInTransaction(this.db, async (tx) => {
        const record = await this.entities.update(RESERVATION_ENTITY, id, {
          status: "released",
          releasedAt: new Date(),
          releasedBy: actor,
          releaseReason: reason,
        });
        if (productId !== undefined && warehouseId !== undefined) {
          await this.adjustReserved(tx, productId, warehouseId, quantity, -1);
        }
        return record;
      }),
    );
    return toReservationView({ ...row.data, ...updated, id });
  }

  async listReservations(filters: {
    readonly productId?: string | null | undefined;
    readonly warehouseId?: string | null | undefined;
    readonly status?: string | null | undefined;
    readonly sourceId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly Record<string, unknown>[]> {
    await this.acl.assertAccess(RESERVATION_ENTITY, "read");
    const query: Record<string, string> = {};
    if (text(filters.productId ?? undefined) !== undefined)
      query["productId"] = filters.productId as string;
    if (text(filters.warehouseId ?? undefined) !== undefined)
      query["warehouseId"] = filters.warehouseId as string;
    if (text(filters.status ?? undefined) !== undefined)
      query["status"] = filters.status as string;
    if (text(filters.sourceId ?? undefined) !== undefined)
      query["sourceId"] = filters.sourceId as string;
    const rows = await this.records.find(
      RESERVATION_ENTITY,
      query,
      Math.min(filters.limit ?? 200, SCAN_LIMIT),
    );
    return rows.map((row) => ({ id: row.id, ...row.data }));
  }

  private async consumeFrom(
    tx: DbTx,
    productId: string,
    warehouseId: string,
    movedQuantity: string,
    source: { readonly entity: string; readonly id: string },
    context: MovementContext,
  ): Promise<number> {
    const active = await this.records.find(
      RESERVATION_ENTITY,
      {
        productId,
        warehouseId,
        status: "active",
        sourceEntity: source.entity,
        sourceId: source.id,
      },
      SCAN_LIMIT,
    );
    if (active.length === 0) return 0;
    const actor = actorOf(context, this.scope);
    let remaining: Decimal = parseDecimal(movedQuantity);
    let consumed = 0;
    for (const row of active) {
      if (isZero(remaining) || isNegative(remaining)) break;
      const reserved = parseDecimal(text(row.data["quantity"]) ?? "0");
      const take =
        compare(reserved, remaining) <= 0 ? reserved : remaining;
      const left = subtract(reserved, take);
      const cumulative = add(
        parseDecimal(text(row.data["consumedQuantity"]) ?? "0"),
        take,
      );
      await this.entities.update(RESERVATION_ENTITY, row.id, {
        quantity: format(left),
        consumedQuantity: format(cumulative),
        ...(isZero(left)
          ? {
              status: "consumed",
              releasedAt: new Date(),
              releasedBy: actor,
              releaseReason: context.correlationId ?? null,
            }
          : {}),
      });
      await this.adjustReserved(tx, productId, warehouseId, format(take), -1);
      remaining = subtract(remaining, take);
      consumed += 1;
    }
    return consumed;
  }

  // ---------------------------------------------------------------------------------------------
  // Availability, history and reconciliation
  // ---------------------------------------------------------------------------------------------

  /** One product's level in one warehouse (or the configured default). */
  async availability(
    productId: string,
    warehouseId?: string | null | undefined,
  ): Promise<AvailableStockView> {
    await this.acl.assertAccess(LEDGER_ENTITY, "read");
    const settings = await this.requireEnabled();
    const resolved = await this.requireWarehouse(warehouseId, settings);
    const level = await this.readLevel(productId, resolved);
    const incoming = await this.incomingFor(productId, resolved, settings);
    return {
      productId,
      warehouseId: resolved,
      ...stockLevel(format(level.onHand), format(level.reserved), incoming),
    };
  }

  /** A bounded page of levels, for a warehouse view or a stock report. */
  async stockList(filters: {
    readonly warehouseId?: string | null | undefined;
    readonly productId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StockLevelRow[]> {
    await this.acl.assertAccess(LEDGER_ENTITY, "read");
    await this.requireEnabled();
    const limit = Math.min(filters.limit ?? 200, SCAN_LIMIT);
    const rows = await this.readProjection(filters.warehouseId, filters.productId, limit);
    const incoming = new Map<string, string>();
    if (rows.length > 0) {
      const warehouseIds = [...new Set(rows.map((row) => row.warehouseId))];
      for (const warehouseId of warehouseIds) {
        const perProduct = await this.incomingMap(warehouseId);
        for (const [productId, quantity] of perProduct)
          incoming.set(levelKey(productId, warehouseId), quantity);
      }
    }
    return rows.map((row) => ({
      ...row,
      incoming: incoming.get(levelKey(row.productId, row.warehouseId)) ?? "0",
    }));
  }

  /**
   * 19-S.18 — on-hand stock valued at each product's cost price (§12.2).
   *
   * This is a valuation *of the projection*, not a second ledger: it reads the same
   * `sales_inventory_stock` rows `stockList` serves. A product whose cost price is missing or
   * unparsable contributes its quantity to `unpricedOnHand` and nothing to `value`, so an incomplete
   * catalog surfaces as a stated gap instead of silently cheap stock. Products carry no currency of
   * their own, so the figure is expressed in the installation's default Sales currency and labelled
   * with it. Cost visibility is enforced: a reader who cannot see `Product.costPrice` gets a refusal,
   * not a derived total (§12.4).
   */
  async valuation(filters: {
    readonly warehouseId?: string | null | undefined;
    readonly productId?: string | null | undefined;
  }): Promise<{
    readonly currency: string;
    readonly value: string;
    readonly onHand: string;
    readonly unpricedOnHand: string;
    readonly levels: number;
  }> {
    await this.acl.assertAccess("Product", "read");
    const visible = await this.acl.visibleFields("Product");
    if (!visible.includes("costPrice")) {
      throw new ValidationError(
        "Stock valuation needs read access to the product cost price.",
        { field: "costPrice" },
      );
    }
    const settings = await this.requireEnabled();
    const warehouse = text(filters.warehouseId ?? undefined);
    const product = text(filters.productId ?? undefined);
    const rows = await sql<{
      levels: number;
      on_hand: string;
      unpriced: string;
      value: string;
    }>`
      select count(*)::int as levels,
             coalesce(sum(s.on_hand), 0)::text as on_hand,
             coalesce(sum(case when cost.value is null
                               then s.on_hand else 0 end), 0)::text as unpriced,
             coalesce(sum(s.on_hand * cost.value), 0)::text as value
      from sales_inventory_stock s
      join entity_records p
        on p.id = s.product_id
       and p.entity_type = 'Product'
       and p.deleted_at is null
      left join lateral (
        select (p.attrs ->> 'costPrice')::numeric as value
        where p.attrs ->> 'costPrice' ~ '^-?[0-9]+(\\.[0-9]+)?$'
      ) cost on true
      where ${warehouse !== undefined ? sql`s.warehouse_id = ${warehouse}` : sql`true`}
        and ${product !== undefined ? sql`s.product_id = ${product}` : sql`true`}
    `.execute(this.db);
    const row = rows.rows[0];
    const scale = currencyScale(settings.currency.defaultCurrency);
    return {
      currency: settings.currency.defaultCurrency,
      value: format(rescale(parseDecimal(row?.value ?? "0"), scale, "half-up"), scale),
      onHand: format(parseDecimal(row?.on_hand ?? "0")),
      unpricedOnHand: format(parseDecimal(row?.unpriced ?? "0")),
      levels: row?.levels ?? 0,
    };
  }

  /** Movement history for a product and/or warehouse, newest first. */
  async history(filters: {
    readonly productId?: string | null | undefined;
    readonly warehouseId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly Record<string, unknown>[]> {
    await this.acl.assertAccess(LEDGER_ENTITY, "read");
    const query: Record<string, string> = {};
    if (text(filters.productId ?? undefined) !== undefined)
      query["productId"] = filters.productId as string;
    if (text(filters.warehouseId ?? undefined) !== undefined)
      query["warehouseId"] = filters.warehouseId as string;
    const rows = await this.records.find(
      LEDGER_ENTITY,
      query,
      Math.min(filters.limit ?? 200, SCAN_LIMIT),
    );
    return rows
      .map((row): Record<string, unknown> => ({ id: row.id, ...row.data }))
      .sort((left, right) =>
        String(right["occurredAt"] ?? "").localeCompare(
          String(left["occurredAt"] ?? ""),
        ),
      );
  }

  /**
   * Compare the projection with the ledger, product by product (§4.15 task 10), and the physical
   * on-hand of every tracked pair with the stock its lots/serials account for (19-S.15).
   *
   * A discrepancy is reported, never corrected: writing a correction here would erase the evidence of
   * whatever caused it, and a stock correction must be an explicit, reviewed adjustment.
   */
  async reconcile(input: {
    readonly warehouseId?: string | null | undefined;
    readonly productId?: string | null | undefined;
  } = {}): Promise<ReconcileResult> {
    await this.acl.assertAccess(LEDGER_ENTITY, "read");
    await this.requireEnabled();
    const projection = await this.readProjection(
      input.warehouseId,
      input.productId,
      SCAN_LIMIT,
    );
    const ledger = await this.readLedgerSums(
      input.warehouseId,
      input.productId,
    );
    const rows = reconcileStock(
      projection.map<ProjectedLevel>((row) => ({
        productId: row.productId,
        warehouseId: row.warehouseId,
        onHand: row.onHand,
        reserved: row.reserved,
      })),
      ledger,
    );
    const mismatches = rows.filter((row) => !row.ok);
    const identity = await this.identityRows(projection, input);
    const identityMismatches = identity.filter((row) => !row.ok);
    return {
      checked: rows.length,
      mismatches,
      ok: mismatches.length === 0,
      identityChecked: identity.length,
      identityMismatches,
      identityOk: identityMismatches.length === 0,
    };
  }

  /**
   * Attributed-versus-physical stock for lot/serial-tracked products (§19-S.15 acceptance:
   * "inventory identity remains correct per product variant, batch or serial").
   *
   * A product that is not tracked is skipped — it has no attribution to compare. A difference means
   * stock that no lot/unit accounts for (or the reverse) and is reported for review only.
   */
  private async identityRows(
    projection: readonly {
      readonly productId: string;
      readonly warehouseId: string;
      readonly onHand: string;
    }[],
    input: {
      readonly warehouseId?: string | null | undefined;
      readonly productId?: string | null | undefined;
    },
  ): Promise<IdentityRow[]> {
    const tracked = new Map<string, "batch" | "serial">();
    for (const mode of ["batch", "serial"] as const) {
      for (const record of await this.records.find(
        "Product",
        { stockTracking: mode },
        SCAN_LIMIT,
      )) {
        tracked.set(record.id, mode);
      }
    }
    const product = text(input.productId ?? undefined);
    const warehouse = text(input.warehouseId ?? undefined);
    const batchTotals = new Map<string, Decimal>();
    const serialTotals = new Map<string, Decimal>();
    const register = (
      target: Map<string, Decimal>,
      key: string,
      value: Decimal,
    ): void => {
      target.set(key, add(target.get(key) ?? zero(0), value));
    };
    const batchClauses = [sql<boolean>`true`];
    if (product !== undefined) batchClauses.push(sql<boolean>`product_id = ${product}`);
    if (warehouse !== undefined)
      batchClauses.push(sql<boolean>`warehouse_id = ${warehouse}`);
    const batchRows = await sql<{
      product_id: string;
      warehouse_id: string;
      total: string;
    }>`
      select product_id, warehouse_id, sum(on_hand)::text as total
      from sales_inventory_batch_stock
      where ${sql.join(batchClauses, sql` and `)}
      group by product_id, warehouse_id
    `.execute(this.db);
    for (const row of batchRows.rows)
      register(
        batchTotals,
        levelKey(row.product_id, row.warehouse_id),
        parseDecimal(row.total),
      );
    const serialClauses = [
      sql<boolean>`entity_type = 'InventorySerial'`,
      sql<boolean>`deleted_at is null`,
      sql<boolean>`(attrs ->> 'status') = 'inStock'`,
    ];
    if (product !== undefined)
      serialClauses.push(sql<boolean>`(attrs ->> 'productId') = ${product}`);
    if (warehouse !== undefined)
      serialClauses.push(sql<boolean>`(attrs ->> 'warehouseId') = ${warehouse}`);
    const serialRows = await sql<{
      product_id: string | null;
      warehouse_id: string | null;
      total: string;
    }>`
      select (attrs ->> 'productId') as product_id,
             (attrs ->> 'warehouseId') as warehouse_id,
             count(*)::text as total
      from entity_records
      where ${sql.join(serialClauses, sql` and `)}
      group by (attrs ->> 'productId'), (attrs ->> 'warehouseId')
    `.execute(this.db);
    for (const row of serialRows.rows) {
      if (row.product_id === null || row.warehouse_id === null) continue;
      register(
        serialTotals,
        levelKey(row.product_id, row.warehouse_id),
        parseDecimal(row.total),
      );
    }
    const physical = new Map<string, string>();
    for (const row of projection)
      physical.set(levelKey(row.productId, row.warehouseId), row.onHand);
    const keys = new Map<string, { productId: string; warehouseId: string }>();
    for (const row of projection) {
      if (tracked.has(row.productId))
        keys.set(levelKey(row.productId, row.warehouseId), row);
    }
    for (const map of [batchTotals, serialTotals]) {
      for (const key of map.keys()) {
        if (keys.has(key)) continue;
        const [productId, warehouseId] = key.split("\u0000");
        if (productId !== undefined && warehouseId !== undefined && tracked.has(productId))
          keys.set(key, { productId, warehouseId });
      }
    }
    const rows: IdentityRow[] = [];
    for (const [key, identity] of keys) {
      const mode = tracked.get(identity.productId);
      if (mode === undefined) continue;
      const attributed =
        mode === "batch"
          ? batchTotals.get(key) ?? zero(0)
          : serialTotals.get(key) ?? zero(0);
      const onHand = parseDecimal(physical.get(key) ?? "0");
      const difference = subtract(onHand, attributed);
      rows.push({
        productId: identity.productId,
        warehouseId: identity.warehouseId,
        tracking: mode,
        attributed: format(attributed),
        onHand: format(onHand),
        difference: format(difference),
        ok: isZero(difference),
      });
    }
    return rows.sort(
      (left, right) =>
        left.productId.localeCompare(right.productId) ||
        left.warehouseId.localeCompare(right.warehouseId),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Lots, serials and picking suggestions (19-S.15)
  // ---------------------------------------------------------------------------------------------

  /** A bounded page of lot stock with the lot's dates — the batch view behind a product/warehouse. */
  async batchStock(filters: {
    readonly productId?: string | null | undefined;
    readonly warehouseId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly BatchStockRow[]> {
    await this.acl.assertAccess(BATCH_ENTITY, "read");
    await this.requireEnabled();
    const clauses = [sql<boolean>`on_hand > 0`];
    const product = text(filters.productId ?? undefined);
    const warehouse = text(filters.warehouseId ?? undefined);
    if (product !== undefined) clauses.push(sql<boolean>`product_id = ${product}`);
    if (warehouse !== undefined)
      clauses.push(sql<boolean>`warehouse_id = ${warehouse}`);
    const rows = await sql<{
      product_id: string;
      warehouse_id: string;
      batch_number: string;
      on_hand: string;
    }>`
      select product_id, warehouse_id, batch_number, on_hand::text as on_hand
      from sales_inventory_batch_stock
      where ${sql.join(clauses, sql` and `)}
      order by product_id asc, batch_number asc
      limit ${Math.min(filters.limit ?? 200, SCAN_LIMIT)}
    `.execute(this.db);
    if (rows.rows.length === 0) return [];
    const metadata = new Map<string, Record<string, unknown>>();
    for (const productId of [...new Set(rows.rows.map((row) => row.product_id))]) {
      for (const record of await this.records.find(
        BATCH_ENTITY,
        { productId },
        SCAN_LIMIT,
      )) {
        const number = text(record.data["batchNumber"]);
        if (number !== undefined) metadata.set(number.toUpperCase(), record.data);
      }
    }
    return rows.rows.map((row) => {
      const lot = metadata.get(row.batch_number.toUpperCase());
      return {
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        batchNumber: row.batch_number,
        onHand: format(parseDecimal(row.on_hand)),
        expiryDate: storedDay(lot?.["expiryDate"]) ?? null,
        manufacturingDate: storedDay(lot?.["manufacturingDate"]) ?? null,
        receivedAt: instantOf(lot?.["receivedAt"]),
      };
    });
  }

  /** Serial records by product/warehouse/status — the unit view for a tracked product. */
  async serialList(filters: {
    readonly productId?: string | null | undefined;
    readonly warehouseId?: string | null | undefined;
    readonly status?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly Record<string, unknown>[]> {
    await this.acl.assertAccess(SERIAL_ENTITY, "read");
    await this.requireEnabled();
    const query: Record<string, string> = {};
    const product = text(filters.productId ?? undefined);
    const warehouse = text(filters.warehouseId ?? undefined);
    const status = text(filters.status ?? undefined);
    if (product !== undefined) query["productId"] = product;
    if (warehouse !== undefined) query["warehouseId"] = warehouse;
    if (status !== undefined) query["status"] = status;
    const rows = await this.records.find(
      SERIAL_ENTITY,
      query,
      Math.min(filters.limit ?? 200, SCAN_LIMIT),
    );
    return rows.map((row) => ({ id: row.id, ...row.data }));
  }

  /**
   * What the configured removal policy would pick for this line *right now* (§19-S.15 task 7:
   * "expose availability/picking suggestions in the line editor when enabled").
   *
   * A suggestion never moves stock and never reserves it — it is the same pure allocation the
   * confirmation will run, evaluated against current stock, so what the editor shows and what the
   * ledger later writes agree. A shortage is returned as data, not thrown: an unfilled line is what
   * the editor exists to show.
   */
  async pickingSuggestions(input: {
    readonly productId: string;
    readonly warehouseId?: string | null | undefined;
    readonly quantity: string;
  }): Promise<PickingSuggestionView> {
    await this.acl.assertAccess(LEDGER_ENTITY, "read");
    const settings = await this.requireEnabled();
    const warehouseId = await this.requireWarehouse(input.warehouseId, settings);
    const quantity = parseDecimal(input.quantity);
    if (compare(quantity, zero(0)) <= 0) {
      throw new ValidationError("A picking suggestion needs a positive quantity.", {
        quantity: input.quantity,
      });
    }
    const requested = format(quantity, quantity.scale);
    const tracking = await this.trackingOf(input.productId);
    const level = await this.readLevel(input.productId, warehouseId);
    const policy = settings.inventory.removalPolicy;
    if (tracking === "batch") {
      const candidates = await this.batchCandidates(input.productId, warehouseId);
      const pick = allocateBatches(policy, candidates, requested, {
        today: utcDay(),
        excludeExpired: settings.inventory.excludeExpiredStock,
      });
      return {
        productId: input.productId,
        warehouseId,
        tracking,
        policy,
        requested,
        allocations: pick.allocations,
        serialNumbers: [],
        shortage: pick.shortage,
        attributedAvailable: format(
          sum(candidates.map((candidate) => parseDecimal(candidate.onHand))),
        ),
        onHand: format(level.onHand),
      };
    }
    if (tracking === "serial") {
      const candidates = await this.serialCandidates(input.productId, warehouseId);
      const pick = allocateSerials(policy, candidates, requested);
      return {
        productId: input.productId,
        warehouseId,
        tracking,
        policy,
        requested,
        allocations: [],
        serialNumbers: pick.serialNumbers,
        shortage: pick.shortage,
        attributedAvailable: String(candidates.length),
        onHand: format(level.onHand),
      };
    }
    return {
      productId: input.productId,
      warehouseId,
      tracking,
      policy,
      requested,
      allocations: [],
      serialNumbers: [],
      shortage: "0",
      attributedAvailable: "0",
      onHand: format(level.onHand),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Projection internals
  // ---------------------------------------------------------------------------------------------

  /**
   * Lock a (product, warehouse) level row and read it.
   *
   * The insert-then-select-for-update is the whole concurrency guarantee: PostgreSQL serializes
   * everything after the lock, so a read-modify-write of `on_hand`/`reserved` cannot interleave with
   * another one (§4.15 invariant 7).
   */
  private async lockLevel(
    tx: DbTx,
    productId: string,
    warehouseId: string,
  ): Promise<StockLockRow> {
    await sql`
      insert into sales_inventory_stock (product_id, warehouse_id)
      values (${productId}, ${warehouseId})
      on conflict (product_id, warehouse_id) do nothing
    `.execute(tx);
    const rows = await sql<{ on_hand: string; reserved: string }>`
      select on_hand::text as on_hand, reserved::text as reserved
      from sales_inventory_stock
      where product_id = ${productId} and warehouse_id = ${warehouseId}
      for update
    `.execute(tx);
    const row = rows.rows[0];
    return {
      onHand: parseDecimal(row?.on_hand ?? "0"),
      reserved: parseDecimal(row?.reserved ?? "0"),
    };
  }

  private async readLevel(
    productId: string,
    warehouseId: string,
  ): Promise<StockLockRow> {
    const rows = await sql<{ on_hand: string; reserved: string }>`
      select on_hand::text as on_hand, reserved::text as reserved
      from sales_inventory_stock
      where product_id = ${productId} and warehouse_id = ${warehouseId}
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return {
      onHand: parseDecimal(row?.on_hand ?? "0"),
      reserved: parseDecimal(row?.reserved ?? "0"),
    };
  }

  private async writeOnHand(
    tx: DbTx,
    productId: string,
    warehouseId: string,
    value: Decimal,
  ): Promise<void> {
    await sql`
      update sales_inventory_stock
      set on_hand = ${format(value)}, modified_at = now()
      where product_id = ${productId} and warehouse_id = ${warehouseId}
    `.execute(tx);
  }

  private async writeReserved(
    tx: DbTx,
    productId: string,
    warehouseId: string,
    value: Decimal,
  ): Promise<void> {
    await sql`
      update sales_inventory_stock
      set reserved = ${format(value)}, modified_at = now()
      where product_id = ${productId} and warehouse_id = ${warehouseId}
    `.execute(tx);
  }

  /** Move `reserved` by a signed quantity, locking the row and floor-ing the arithmetic at zero. */
  private async adjustReserved(
    tx: DbTx,
    productId: string,
    warehouseId: string,
    quantity: string,
    direction: 1 | -1,
  ): Promise<void> {
    const level = await this.lockLevel(tx, productId, warehouseId);
    const delta = signedQuantity(quantity, direction);
    const next = add(level.reserved, parseDecimal(delta));
    await this.writeReserved(
      tx,
      productId,
      warehouseId,
      isNegative(next) ? zero(level.reserved.scale) : next,
    );
  }

  private async readProjection(
    warehouseId: string | null | undefined,
    productId: string | null | undefined,
    limit: number,
  ): Promise<
    readonly {
      productId: string;
      warehouseId: string;
      name: string | null;
      onHand: string;
      reserved: string;
      available: string;
      incoming: string;
    }[]
  > {
    const clauses = [sql<boolean>`true`];
    const warehouse = text(warehouseId ?? undefined);
    const product = text(productId ?? undefined);
    if (warehouse !== undefined)
      clauses.push(sql<boolean>`s.warehouse_id = ${warehouse}`);
    if (product !== undefined)
      clauses.push(sql<boolean>`s.product_id = ${product}`);
    const rows = await sql<{
      product_id: string;
      warehouse_id: string;
      on_hand: string;
      reserved: string;
      name: string | null;
    }>`
      select s.product_id, s.warehouse_id, s.on_hand::text as on_hand,
             s.reserved::text as reserved, p.name
      from sales_inventory_stock s
      left join entity_records p
        on p.id = s.product_id and p.entity_type = 'Product' and p.deleted_at is null
      where ${sql.join(clauses, sql` and `)}
      order by s.warehouse_id asc, p.name asc nulls last, s.product_id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map((row) => {
      // The stored `numeric` comes back at the column's scale ("10.0000000000"); every API value is
      // the canonical decimal string, so it is normalized once here.
      const onHand = format(parseDecimal(row.on_hand));
      const reserved = format(parseDecimal(row.reserved));
      return {
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        name: row.name,
        onHand,
        reserved,
        available: availableToPromise(onHand, reserved),
        incoming: "0",
      };
    });
  }

  private async readLedgerSums(
    warehouseId: string | null | undefined,
    productId: string | null | undefined,
  ): Promise<readonly { productId: string; warehouseId: string; quantity: string }[]> {
    const clauses = [sql<boolean>`entity_type = 'InventoryTransaction'`, sql<boolean>`deleted_at is null`];
    const warehouse = text(warehouseId ?? undefined);
    const product = text(productId ?? undefined);
    if (warehouse !== undefined)
      clauses.push(sql<boolean>`(attrs ->> 'warehouseId') = ${warehouse}`);
    if (product !== undefined)
      clauses.push(sql<boolean>`(attrs ->> 'productId') = ${product}`);
    const rows = await sql<{
      product_id: string | null;
      warehouse_id: string | null;
      quantity: string;
    }>`
      select (attrs ->> 'productId') as product_id,
             (attrs ->> 'warehouseId') as warehouse_id,
             coalesce(sum((attrs ->> 'quantityDelta')::numeric), 0)::text as quantity
      from entity_records
      where ${sql.join(clauses, sql` and `)}
      group by (attrs ->> 'productId'), (attrs ->> 'warehouseId')
    `.execute(this.db);
    return rows.rows
      .filter(
        (row) => row.product_id !== null && row.warehouse_id !== null,
      )
      .map((row) => ({
        productId: row.product_id as string,
        warehouseId: row.warehouse_id as string,
        quantity: row.quantity,
      }));
  }

  // ---------------------------------------------------------------------------------------------
  // Incoming (§4.15 invariant 8)
  // ---------------------------------------------------------------------------------------------

  private async incomingFor(
    productId: string,
    warehouseId: string,
    settings: SalesSettings,
  ): Promise<string> {
    if (!(await this.isStockManaged(productId, settings))) return "0";
    const map = await this.incomingMap(warehouseId, settings);
    return map.get(productId) ?? "0";
  }

  private async incomingMap(
    warehouseId: string,
    provided?: SalesSettings,
  ): Promise<Map<string, string>> {
    const settings = provided ?? (await this.settings.settings());
    const totals = new Map<string, Decimal>();
    const addTo = (productId: string, quantity: string): void => {
      const current = totals.get(productId) ?? zero(0);
      totals.set(productId, add(current, parseDecimal(quantity)));
    };
    // In-transit transfers are already out of the source and not yet at the destination.
    const transfers = await this.records.find(
      "TransferOrder",
      { destinationWarehouseId: warehouseId, status: "inTransit" },
      SCAN_LIMIT,
    );
    if (transfers.length > 0) {
      const items = await this.records.findByIdsIn(
        "TransferOrderItem",
        "transferOrderId",
        transfers.map((row) => row.id),
      );
      for (const item of items) {
        const productId = text(item.data["productId"]);
        if (productId !== undefined)
          addTo(productId, text(item.data["quantity"]) ?? "0");
      }
    }
    // Confirmed purchase orders destined here, net of what already arrived.
    if (settings.features.purchases) {
      const orders = [
        ...(await this.records.find(
          "PurchaseOrder",
          { status: "confirmed" },
          SCAN_LIMIT,
        )),
        ...(await this.records.find(
          "PurchaseOrder",
          { status: "partiallyReceived" },
          SCAN_LIMIT,
        )),
      ].filter((row) => (text(row.data["warehouseId"]) ?? null) === warehouseId);
      if (orders.length > 0) {
        const orderIds = orders.map((row) => row.id);
        const ordered = new Map<string, Decimal>();
        for (const item of await this.records.findByIdsIn(
          "PurchaseOrderItem",
          "purchaseOrderId",
          orderIds,
        )) {
          const productId = text(item.data["productId"]);
          if (productId !== undefined)
            ordered.set(
              productId,
              add(
                ordered.get(productId) ?? zero(0),
                parseDecimal(text(item.data["quantity"]) ?? "0"),
              ),
            );
        }
        const received = new Map<string, Decimal>();
        const receipts = (
          await this.records.findByIdsIn("ReceiptOrder", "purchaseOrderId", orderIds)
        ).filter((row) => text(row.data["status"]) === "confirmed");
        if (receipts.length > 0) {
          for (const item of await this.records.findByIdsIn(
            "ReceiptOrderItem",
            "receiptOrderId",
            receipts.map((row) => row.id),
          )) {
            const productId = text(item.data["productId"]);
            if (productId !== undefined)
              received.set(
                productId,
                add(
                  received.get(productId) ?? zero(0),
                  parseDecimal(text(item.data["quantity"]) ?? "0"),
                ),
              );
          }
        }
        for (const [productId, orderedQuantity] of ordered) {
          const outstanding = subtract(
            orderedQuantity,
            received.get(productId) ?? zero(0),
          );
          if (!isNegative(outstanding) && !isZero(outstanding))
            addTo(productId, format(outstanding));
        }
      }
    }
    const result = new Map<string, string>();
    for (const [productId, quantity] of totals)
      result.set(productId, format(quantity));
    return result;
  }

  /** The named action from either ledger state machine, for the controller's message shape. */
  static transferRefusal(current: string, action: string): string | null {
    return actionRefusal(TRANSFER_TRANSITIONS, "transfer order", action, current);
  }

  static adjustmentRefusal(current: string, action: string): string | null {
    return actionRefusal(
      ADJUSTMENT_TRANSITIONS,
      "inventory adjustment",
      action,
      current,
    );
  }
}

function emptyResult(): MovementResult {
  return { applied: 0, duplicates: 0, skipped: 0, transactionIds: [] };
}

function actorOf(
  context: MovementContext,
  scope: RequestScope,
): string | null {
  return (
    text(context.actor ?? undefined) ??
    scope.principal?.userName ??
    scope.userId ??
    null
  );
}

function toReservationView(record: Record<string, unknown>): ReservationView {
  return {
    id: String(record["id"] ?? ""),
    status: String(record["status"] ?? "active"),
    productId: String(record["productId"] ?? ""),
    warehouseId: String(record["warehouseId"] ?? ""),
    quantity: String(record["quantity"] ?? "0"),
    consumedQuantity: String(record["consumedQuantity"] ?? "0"),
    reservation: record,
  };
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A stored instant (a `Date` in memory, an ISO string after JSON round-trip), or `null`. */
function instantOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}
