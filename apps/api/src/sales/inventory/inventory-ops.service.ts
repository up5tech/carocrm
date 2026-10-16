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
import { resolveDay } from "../clock.js";
import { isNegative, isZero, parseDecimal } from "../money/decimal.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords } from "../sales-records.js";
import { InventoryService } from "./inventory.service.js";
import { type MovementContext, type MovementResult, text } from "./inventory.service.js";
import {
  actionRefusal,
  ADJUSTMENT_TRANSITIONS,
  type LedgerMovement,
  movementKeyFor,
  signedQuantity,
  TRANSFER_TRANSITIONS,
} from "./ledger.js";

/**
 * Phase 19-S.14 — the two operations that are more than a single movement: a reviewed adjustment and
 * a controlled warehouse transfer.
 *
 * Both are thin orchestrators over `InventoryService.recordMovements`, because the ledger is the only
 * way stock changes. What differs from a document confirmation is who decides:
 *
 *  - an **adjustment** is an explicit correction with a reason, optionally gated on an approval
 *    (§4.15 "reviewed corrections with reason and approval/permission requirements");
 *  - a **transfer** moves stock between two locations in two linked steps — dispatch (source outflow)
 *    and receipt (destination inflow) — so an interruption leaves the goods visibly *in transit*
 *    rather than lost (§4.15 invariant 5).
 */

export interface TransferItemInput {
  readonly productId: string;
  readonly quantity: string;
  readonly name?: string | null | undefined;
  readonly sku?: string | null | undefined;
  readonly unit?: string | null | undefined;
}

export interface CreateTransferInput {
  readonly name?: string | null | undefined;
  readonly sourceWarehouseId: string;
  readonly destinationWarehouseId: string;
  readonly transferDate?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly trackingNumber?: string | null | undefined;
  readonly items: readonly TransferItemInput[];
}

export interface TransferView {
  readonly id: string;
  readonly status: string;
  readonly transfer: Record<string, unknown>;
  readonly items: readonly Record<string, unknown>[];
}

export interface CreateAdjustmentInput {
  readonly productId: string;
  readonly quantityDelta: string;
  readonly reason: string;
  readonly warehouseId?: string | null | undefined;
}

export interface AdjustmentView {
  readonly id: string;
  readonly status: string;
  readonly transactionId: string | null;
  readonly adjustment: Record<string, unknown>;
}

export interface TransferTransitionResult {
  readonly transfer: TransferView;
  readonly movements: MovementResult;
}

const TRANSFER_ENTITY = "TransferOrder";
const TRANSFER_ITEM_ENTITY = "TransferOrderItem";
const ADJUSTMENT_ENTITY = "InventoryAdjustment";
const SCAN_LIMIT = 2_000;

@Injectable()
export class InventoryOperationsService {
  constructor(
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Adjustments (§4.15 reviewed corrections)
  // ---------------------------------------------------------------------------------------------

  /**
   * Record a stock correction. When the settings do not require approval it is applied immediately;
   * otherwise it stays `pending` and nothing moves until it is approved.
   */
  async createAdjustment(
    input: CreateAdjustmentInput,
    context: MovementContext = {},
  ): Promise<AdjustmentView> {
    await this.acl.assertAccess(ADJUSTMENT_ENTITY, "create");
    const settings = await this.inventory.requireEnabled();
    await this.inventory.assertStockManaged(input.productId);
    const reason = text(input.reason);
    if (reason === undefined) {
      throw new ValidationError("A stock adjustment requires a reason.", {
        reason: null,
      });
    }
    const warehouseId = await this.inventory.requireWarehouse(
      input.warehouseId,
      settings,
    );
    const delta = parseDecimal(input.quantityDelta);
    if (isZero(delta)) {
      throw new ValidationError("A stock adjustment must move a non-zero quantity.", {
        quantityDelta: input.quantityDelta,
      });
    }
    const actor = actorOf(context, this.scope);
    const autoApply = !settings.inventory.adjustmentApprovalRequired;
    const created = await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async () =>
        await this.entities.create(ADJUSTMENT_ENTITY, {
          name: `adjustment ${input.quantityDelta}`,
          productId: input.productId,
          warehouseId,
          quantityDelta: input.quantityDelta,
          reason,
          status: autoApply ? "applied" : "pending",
          requestedBy: actor,
          requestedAt: new Date(),
          ...(autoApply ? { decidedBy: actor, decidedAt: new Date() } : {}),
        }),
      ),
    );
    const id = String(created["id"] ?? "");
    if (!autoApply) return toAdjustmentView({ ...created, id });
    const movements = await this.applyAdjustment(id, created, context);
    return {
      id,
      status: "applied",
      transactionId: movements.transactionIds[0] ?? null,
      adjustment: {
        ...created,
        id,
        status: "applied",
        transactionId: movements.transactionIds[0] ?? null,
      },
    };
  }

  /** Approve (move the stock) or reject (leave it) a pending adjustment. */
  async transitionAdjustment(
    id: string,
    action: string,
    reason: string | undefined,
    context: MovementContext = {},
  ): Promise<AdjustmentView> {
    await this.acl.assertAccess(ADJUSTMENT_ENTITY, "edit");
    await this.inventory.requireEnabled();
    const row = await this.records.byId(ADJUSTMENT_ENTITY, id);
    if (row === undefined) {
      throw new NotFoundError(`Inventory adjustment "${id}" does not exist.`);
    }
    const status = text(row.data["status"]) ?? "pending";
    const refusal = actionRefusal(
      ADJUSTMENT_TRANSITIONS,
      "inventory adjustment",
      action,
      status,
    );
    if (refusal !== null) {
      throw new ValidationError(refusal, { id, action, status });
    }
    const transition = ADJUSTMENT_TRANSITIONS.find(
      (each) => each.action === action,
    );
    if (transition?.requiresReason === true)
      requireReason(reason, transition.label);
    const actor = actorOf(context, this.scope);
    if (action === "reject") {
      await runAsSalesInternal(() =>
        this.entities.update(ADJUSTMENT_ENTITY, id, {
          status: "rejected",
          decidedBy: actor,
          decidedAt: new Date(),
          decisionReason: reason ?? null,
        }),
      );
      return toAdjustmentView({
        ...row.data,
        id,
        status: "rejected",
        decidedBy: actor,
      });
    }
    const movements = await this.applyAdjustment(id, row.data, context);
    return {
      id,
      status: "applied",
      transactionId: movements.transactionIds[0] ?? null,
      adjustment: {
        ...row.data,
        id,
        status: "applied",
        transactionId: movements.transactionIds[0] ?? null,
      },
    };
  }

  /** Write the ledger row an approved adjustment stands for, then mark it applied. */
  private async applyAdjustment(
    id: string,
    data: Record<string, unknown>,
    context: MovementContext,
  ): Promise<MovementResult> {
    const productId = text(data["productId"]);
    const warehouseId = text(data["warehouseId"]);
    const quantityDelta = text(data["quantityDelta"]);
    if (
      productId === undefined ||
      warehouseId === undefined ||
      quantityDelta === undefined
    ) {
      throw new ValidationError(
        "This adjustment is missing its product, warehouse or quantity.",
        { id },
      );
    }
    const movement: LedgerMovement = {
      movementKey: movementKeyFor(ADJUSTMENT_ENTITY, id, "adjustment", 0),
      type: "adjustment",
      productId,
      warehouseId,
      quantityDelta,
      sourceEntity: ADJUSTMENT_ENTITY,
      sourceId: id,
      sourceNumber: null,
      reason: text(data["reason"]) ?? null,
    };
    const movements = await this.inventory.recordMovements([movement], context);
    const actor = actorOf(context, this.scope);
    await runAsSalesInternal(() =>
      this.entities.update(ADJUSTMENT_ENTITY, id, {
        status: "applied",
        decidedBy: actor,
        decidedAt: new Date(),
        transactionId: movements.transactionIds[0] ?? null,
      }),
    );
    return movements;
  }

  // ---------------------------------------------------------------------------------------------
  // Transfers (§4.15 invariant 5)
  // ---------------------------------------------------------------------------------------------

  async createTransfer(input: CreateTransferInput): Promise<TransferView> {
    await this.acl.assertAccess(TRANSFER_ENTITY, "create");
    const settings = await this.inventory.requireEnabled();
    const source = await this.inventory.requireWarehouse(
      input.sourceWarehouseId,
      settings,
    );
    const destination = await this.inventory.requireWarehouse(
      input.destinationWarehouseId,
      settings,
    );
    if (source === destination) {
      throw new ValidationError(
        "A transfer needs two different warehouses: the source and the destination are the same.",
        { warehouseId: source },
      );
    }
    if (input.items.length === 0) {
      throw new ValidationError("A transfer needs at least one line.", {
        items: [],
      });
    }
    for (const item of input.items) {
      await this.inventory.assertStockManaged(item.productId);
      const quantity = parseDecimal(item.quantity);
      if (isZero(quantity) || isNegative(quantity)) {
        throw new ValidationError("A transfer line moves a positive quantity.", {
          productId: item.productId,
          quantity: item.quantity,
        });
      }
    }
    const transferDate = resolveDay(input.transferDate ?? undefined);
    const createdId = await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async () => {
        const order = await this.entities.create(TRANSFER_ENTITY, {
          name:
            text(input.name ?? undefined) ??
            `Transfer ${transferDate}`,
          sourceWarehouseId: source,
          destinationWarehouseId: destination,
          transferDate,
          status: "draft",
          reason: text(input.reason ?? undefined) ?? null,
          trackingNumber: text(input.trackingNumber ?? undefined) ?? null,
        });
        const id = String(order["id"] ?? "");
        let position = 0;
        for (const item of input.items) {
          await this.entities.create(TRANSFER_ITEM_ENTITY, {
            transferOrderId: id,
            position,
            productId: item.productId,
            name: text(item.name ?? undefined) ?? null,
            sku: text(item.sku ?? undefined) ?? null,
            unit: text(item.unit ?? undefined) ?? null,
            quantity: item.quantity,
          });
          position += 1;
        }
        return id;
      }),
    );
    return await this.viewTransfer(createdId);
  }

  async viewTransfer(id: string): Promise<TransferView> {
    await this.acl.assertAccess(TRANSFER_ENTITY, "read");
    const order = await this.records.byId(TRANSFER_ENTITY, id);
    if (order === undefined) {
      throw new NotFoundError(`Transfer order "${id}" does not exist.`);
    }
    const items = await this.records.findByIdsIn(
      TRANSFER_ITEM_ENTITY,
      "transferOrderId",
      [id],
    );
    return {
      id,
      status: text(order.data["status"]) ?? "draft",
      transfer: { id, ...order.data },
      items: items
        .map((row): Record<string, unknown> => ({ id: row.id, ...row.data }))
        .sort(
          (left, right) =>
            Number(left["position"] ?? 0) - Number(right["position"] ?? 0),
        ),
    };
  }

  /**
   * Dispatch (`confirm`), receive (`receive`) or cancel a transfer.
   *
   * Dispatch applies the source outflow; receipt applies the destination inflow. The two are separate
   * transactions on purpose — the intermediate `inTransit` state is what makes a half-finished move
   * visible instead of silent, and each side is idempotent through its own movement key.
   */
  async transitionTransfer(
    id: string,
    action: string,
    reason: string | undefined,
    context: MovementContext = {},
  ): Promise<TransferTransitionResult> {
    await this.acl.assertAccess(TRANSFER_ENTITY, "edit");
    await this.inventory.requireEnabled();
    const row = await this.records.byId(TRANSFER_ENTITY, id);
    if (row === undefined) {
      throw new NotFoundError(`Transfer order "${id}" does not exist.`);
    }
    const status = text(row.data["status"]) ?? "draft";
    const refusal = actionRefusal(
      TRANSFER_TRANSITIONS,
      "transfer order",
      action,
      status,
    );
    if (refusal !== null) {
      throw new ValidationError(refusal, { id, action, status });
    }
    const transition = TRANSFER_TRANSITIONS.find(
      (each) => each.action === action,
    );
    if (transition?.requiresReason === true)
      requireReason(reason, transition.label);
    if (action === "cancel") {
      await runAsSalesInternal(() =>
        this.entities.update(TRANSFER_ENTITY, id, { status: "cancelled" }),
      );
      return { transfer: await this.viewTransfer(id), movements: emptyResult() };
    }
    const movements = await this.applyTransferSide(id, row.data, action, context);
    await runAsSalesInternal(() =>
      this.entities.update(TRANSFER_ENTITY, id, {
        status: action === "confirm" ? "inTransit" : "received",
        ...(action === "confirm"
          ? { confirmedAt: new Date() }
          : { receivedAt: new Date() }),
      }),
    );
    return { transfer: await this.viewTransfer(id), movements };
  }

  private async applyTransferSide(
    id: string,
    data: Record<string, unknown>,
    action: string,
    context: MovementContext,
  ): Promise<MovementResult> {
    const source = text(data["sourceWarehouseId"]);
    const destination = text(data["destinationWarehouseId"]);
    if (source === undefined || destination === undefined) {
      throw new ValidationError(
        "This transfer is missing its source or destination warehouse.",
        { id },
      );
    }
    const confirm = action === "confirm";
    const warehouseId = confirm ? source : destination;
    const type = confirm ? "transferOut" : "transferIn";
    const items = await this.records.findByIdsIn(
      TRANSFER_ITEM_ENTITY,
      "transferOrderId",
      [id],
      SCAN_LIMIT,
    );
    if (items.length === 0) {
      throw new ValidationError("A transfer with no lines cannot move stock.", {
        id,
      });
    }
    const movements: LedgerMovement[] = [];
    for (const item of items) {
      const productId = text(item.data["productId"]);
      const quantity = text(item.data["quantity"]) ?? "0";
      if (productId === undefined || isZero(parseDecimal(quantity))) continue;
      movements.push({
        movementKey: movementKeyFor(
          TRANSFER_ENTITY,
          id,
          type,
          Number(item.data["position"] ?? 0),
        ),
        type,
        productId,
        warehouseId,
        quantityDelta: signedQuantity(quantity, confirm ? -1 : 1),
        sourceEntity: TRANSFER_ENTITY,
        sourceId: id,
        sourceNumber: text(data["name"]) ?? null,
        reason: text(data["reason"]) ?? null,
        transferGroupId: `${TRANSFER_ENTITY}:${id}`,
      });
    }
    return await this.inventory.recordMovements(movements, context);
  }

  /** Transfers awaiting receipt, for the in-transit view and the availability report. */
  async listInTransit(
    warehouseId?: string | null,
  ): Promise<readonly TransferView[]> {
    await this.acl.assertAccess(TRANSFER_ENTITY, "read");
    const filters: Record<string, string> = { status: "inTransit" };
    const destination = text(warehouseId ?? undefined);
    if (destination !== undefined)
      filters["destinationWarehouseId"] = destination;
    const rows = await this.records.find(TRANSFER_ENTITY, filters, SCAN_LIMIT);
    const views: TransferView[] = [];
    for (const row of rows) views.push(await this.viewTransfer(row.id));
    return views;
  }
}

function emptyResult(): MovementResult {
  return { applied: 0, duplicates: 0, skipped: 0, transactionIds: [] };
}

function actorOf(context: MovementContext, scope: RequestScope): string | null {
  return (
    text(context.actor ?? undefined) ??
    scope.principal?.userName ??
    scope.userId ??
    null
  );
}

function toAdjustmentView(record: Record<string, unknown>): AdjustmentView {
  const transactionId = record["transactionId"];
  return {
    id: String(record["id"] ?? ""),
    status: String(record["status"] ?? "pending"),
    transactionId:
      transactionId === undefined || transactionId === null
        ? null
        : String(transactionId),
    adjustment: record,
  };
}

function requireReason(reason: string | undefined, label: string): void {
  if (text(reason ?? undefined) === undefined) {
    throw new ValidationError(`"${label}" requires a reason.`, {
      reason: reason ?? null,
    });
  }
}
