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
import { nowIso } from "../clock.js";
import type { StockMovementPlan } from "../document/stock-movement.js";
import {
  add,
  compare,
  type Decimal,
  format,
  isNegative,
  isZero,
  parseDecimal,
  subtract,
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
}

interface StockLockRow {
  readonly onHand: Decimal;
  readonly reserved: Decimal;
}

const LEDGER_ENTITY: SalesEntityType = "InventoryTransaction";
const RESERVATION_ENTITY: SalesEntityType = "InventoryReservation";
const SCAN_LIMIT = 2_000;

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
          });
          const id = text(created["id"]);
          if (id !== undefined) transactionIds.push(id);
          await this.writeOnHand(
            tx,
            movement.productId,
            movement.warehouseId,
            nextOnHand,
          );
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
   * Compare the projection with the ledger, product by product (§4.15 task 10).
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
    return { checked: rows.length, mismatches, ok: mismatches.length === 0 };
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
