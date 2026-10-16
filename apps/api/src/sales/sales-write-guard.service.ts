import { ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../hooks/hook.registry.js";
import {
  descriptorForEntity,
  documentDescriptor,
  IMPLEMENTED_DOCUMENT_KINDS,
  type SalesDocumentDescriptor,
} from "./document/descriptors.js";
import {
  assertDocumentEditable,
  type DocumentLockState,
} from "./document/lock.js";
import {
  ADJUSTMENT_ENTITIES,
  BATCH_EDITABLE_FIELDS,
  changedKeys,
  DECIDED_WRITE_OFF_FIELDS,
  INVENTORY_LEDGER_ENTITY,
  INVENTORY_MANAGED_ENTITIES,
  isSalesInternalWrite,
  PAYMENT_ENTITIES,
  SERVER_OWNED_ADJUSTMENT_FIELDS,
  SERVER_OWNED_DOCUMENT_FIELDS,
  SERVER_OWNED_INVENTORY_FIELDS,
  SERVER_OWNED_PAYMENT_FIELDS,
  SERVER_OWNED_TRACKING_FIELDS,
} from "./sales-internal.js";
import { SalesRecords } from "./sales-records.js";

/**
 * Phase 19-S.9 / 19-S.10 — the write guard for commercial records.
 *
 * The Sales domain commands are not the only way into a document: `/api/v1/Invoice/:id` reaches the
 * very same row, and the plan's acceptance criteria are explicit that *"issued values cannot be
 * changed through generic CRUD or crafted API requests"* (§4.7, 19-S.9). A rule that only lived in the
 * command controller would be a side door.
 *
 * So this guard runs on `beforeValidate` — the phase every write passes through — and refuses:
 *
 *  - a **client** write that sets a field the server computes (`amountDue`, `grossTotal`, `number`,
 *    `status`, `snapshot`, …), on create or on update;
 *  - a **client** change to any protected field of a document that is issued or locked, naming the
 *    fields in the error instead of dropping them silently;
 *  - a **client** change to a line item of a locked document (the items carry the money facts);
 *  - a **client** change to a payment's derived balances.
 *
 * Writes performed by a Sales domain service are marked (`runAsSalesInternal`) and pass: the engine,
 * the allocation services and the issuance transaction validate their own invariants, and they are the
 * only callers allowed to move a computed field.
 */
@Injectable()
export class SalesWriteGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(SalesRecords) private readonly records: SalesRecords,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  /** Named registration, so `GET /api/v1/Hook` shows exactly what this module contributes. */
  register(): void {
    this.hooks.register({
      name: "sales.writeGuard",
      phase: "beforeValidate",
      handler: (context) => this.validate(context),
    });
  }

  private async validate(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    if (isSalesInternalWrite()) return;

    const descriptor = descriptorForEntity(context.entity);
    if (descriptor !== undefined) {
      await this.validateDocument(context, descriptor, data);
      return;
    }

    const itemDescriptor = this.itemDescriptorFor(context.entity);
    if (itemDescriptor !== undefined) {
      await this.validateItem(context, itemDescriptor, data);
      return;
    }

    if (PAYMENT_ENTITIES.includes(context.entity)) {
      refuseServerOwned(
        context.operation === "create"
          ? Object.keys(data)
          : changedKeys(data, context.previous ?? {}),
        SERVER_OWNED_PAYMENT_FIELDS,
        context.entity,
      );
      return;
    }

    if (ADJUSTMENT_ENTITIES.includes(context.entity)) {
      this.validateAdjustment(context, data);
      return;
    }

    // 19-S.14 — the ledger is append-only and module-written, and the records that move stock have
    // lifecycle fields only the inventory service may set.
    if (context.entity === INVENTORY_LEDGER_ENTITY) {
      throw new ValidationError(
        "The inventory ledger is append-only and is written only by the inventory service; a correction is a new, compensating movement.",
        { entity: context.entity },
      );
    }
    if (INVENTORY_MANAGED_ENTITIES.includes(context.entity)) {
      await this.validateInventory(context, data);
    }
  }

  /**
   * Inventory records the record API must not steer: an adjustment's decision, a reservation's
   * lifecycle, and a transfer's state once it has started moving stock.
   */
  private async validateInventory(
    context: HookContext,
    data: Record<string, unknown>,
  ): Promise<void> {
    const changed =
      context.operation === "create"
        ? Object.keys(data)
        : changedKeys(data, context.previous ?? {});
    const entity = context.entity;
    if (entity === "InventoryAdjustment") {
      refuseServerOwned(changed, SERVER_OWNED_INVENTORY_FIELDS, entity);
      const status = text(context.previous?.["status"]) ?? "pending";
      if (context.operation === "update" && status !== "pending") {
        throw new ValidationError(
          `This adjustment is "${status}"; its decision is final, so record a new adjustment instead.`,
          { entity, status },
        );
      }
      return;
    }
    if (entity === "InventoryReservation") {
      refuseServerOwned(changed, SERVER_OWNED_INVENTORY_FIELDS, entity);
      if (context.operation === "create") {
        throw new ValidationError(
          "Reservations are placed through the Sales inventory command (`POST /api/v1/Sales/inventory/reserve`) or by confirming a sales order, never through the record API.",
          { entity },
        );
      }
      return;
    }
    if (entity === "TransferOrder") {
      refuseServerOwned(changed, SERVER_OWNED_INVENTORY_FIELDS, entity);
      const status = text(context.previous?.["status"]) ?? "draft";
      if (context.operation === "update" && status !== "draft") {
        throw new ValidationError(
          `A transfer in state "${status}" can no longer be edited; its stock effects are already recorded.`,
          { entity, status },
        );
      }
      return;
    }
    if (entity === "TransferOrderItem") {
      const parentId =
        text(data["transferOrderId"]) ??
        text(context.previous?.["transferOrderId"]);
      if (parentId === undefined) return;
      const parent = await this.records.byId("TransferOrder", parentId);
      if (parent === undefined) return;
      const status = text(parent.data["status"]) ?? "draft";
      if (status !== "draft") {
        throw new ValidationError(
          `A transfer in state "${status}" cannot have its lines changed.`,
          { entity, status, transferOrderId: parentId },
        );
      }
      return;
    }
    // 19-S.15 — stock identity. A serialised unit exists only through the movement that accounts for
    // it, so the record API may neither create one nor walk its state; a lot's identity is fixed
    // while its dates stay correctable (§19-S.15 tasks 2/5, `sales-internal.ts`).
    if (entity === "InventorySerial") {
      throw new ValidationError(
        "A serialised unit is created and moved only by a stock movement (receipt, delivery, return, transfer or adjustment); the record API may not invent a unit or change its state.",
        { entity },
      );
    }
    if (entity === "InventoryBatch") {
      // Creating a lot ahead of its receipt is legitimate; its dates are validated by `sales.validate`.
      if (context.operation === "create") return;
      refuseServerOwned(changed, SERVER_OWNED_TRACKING_FIELDS, entity);
      const offending = changed.filter(
        (field) => !BATCH_EDITABLE_FIELDS.includes(field),
      );
      if (offending.length > 0) {
        throw new ValidationError(
          `A lot's identity and quantity are not editable; only ${BATCH_EDITABLE_FIELDS.join(
            ", ",
          )} may change through the record API (tried: ${offending.join(", ")}).`,
          { entity, fields: offending },
        );
      }
    }
  }

  /**
   * 19-S.11 correction records. The client path may not touch the decision fields (`status`,
   * approver/reversal trail), and a write-off that has been decided is frozen: its amount, invoice
   * and reason can no longer be rewritten — the supported route is a reversal or a new request
   * (§4.9 "credit/write-off allocations must be reversible only through a supported compensating
   * action").
   */
  private validateAdjustment(
    context: HookContext,
    data: Record<string, unknown>,
  ): void {
    const previous = context.previous ?? {};
    const changed =
      context.operation === "create"
        ? Object.keys(data)
        : changedKeys(data, previous);
    refuseServerOwned(
      changed,
      SERVER_OWNED_ADJUSTMENT_FIELDS,
      context.entity,
    );
    if (context.entity !== "WriteOff" || context.operation !== "update") {
      return;
    }
    const status = text(previous["status"]) ?? "pending";
    if (status === "pending") return;
    const violations = changed.filter((field) =>
      DECIDED_WRITE_OFF_FIELDS.includes(field),
    );
    if (violations.length === 0) return;
    throw new ValidationError(
      `This write-off is "${status}"; ${violations.join(", ")} can no longer be changed. Reverse the write-off or request a new one.`,
      {
        entity: context.entity,
        status,
        fields: violations,
      },
    );
  }

  private async validateDocument(
    context: HookContext,
    descriptor: SalesDocumentDescriptor,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (context.operation === "create") {
      refuseServerOwned(
        Object.keys(data),
        SERVER_OWNED_DOCUMENT_FIELDS,
        descriptor.entity,
      );
      return;
    }
    const previous = context.previous ?? {};
    const changed = changedKeys(data, previous);
    refuseServerOwned(changed, SERVER_OWNED_DOCUMENT_FIELDS, descriptor.entity);
    // A locked document's commercial fields are immutable; the error names them (§4.7).
    assertDocumentEditable(
      lockStateFrom(previous, descriptor),
      changed,
      descriptor.lockPolicy,
    );
  }

  /**
   * A line item is not itself locked, but the document it belongs to may be — and the item carries the
   * net, tax and gross amounts the document was issued with. So the guard asks the parent.
   */
  private async validateItem(
    context: HookContext,
    descriptor: SalesDocumentDescriptor,
    data: Record<string, unknown>,
  ): Promise<void> {
    const parentId =
      text(data[descriptor.itemParentField]) ??
      (context.operation === "update"
        ? text(context.previous?.[descriptor.itemParentField])
        : undefined);
    if (parentId === undefined) return;
    const parent = await this.records.byId(descriptor.entity, parentId);
    if (parent === undefined) return;
    assertDocumentEditable(
      lockStateFrom(parent.data, descriptor),
      ["items"],
      descriptor.lockPolicy,
    );
  }

  /** The document descriptor whose item entity this is, if any. */
  private itemDescriptorFor(
    entity: string,
  ): SalesDocumentDescriptor | undefined {
    return IMPLEMENTED_DOCUMENT_KINDS.map((kind) =>
      documentDescriptor(kind),
    ).find((descriptor) => descriptor.itemEntity === entity);
  }
}

function lockStateFrom(
  data: Record<string, unknown>,
  descriptor: SalesDocumentDescriptor,
): DocumentLockState {
  return {
    kind: descriptor.kind,
    issuedAt: isoOrNull(data["issuedAt"]),
    issuedBy: text(data["issuedBy"]) ?? null,
    lockedAt: isoOrNull(data["lockedAt"]),
    lockedBy: text(data["lockedBy"]) ?? null,
    unlockedAt: isoOrNull(data["unlockedAt"]),
    unlockedBy: text(data["unlockedBy"]) ?? null,
  };
}

function refuseServerOwned(
  keys: readonly string[],
  owned: readonly string[],
  entity: string,
): void {
  const offending = keys.filter((key) => owned.includes(key));
  if (offending.length === 0) return;
  throw new ValidationError(
    `These fields on ${entity} are computed by the server and cannot be set through the record API: ${offending.join(", ")}.`,
    {
      entity,
      fields: offending,
    },
  );
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value) ?? null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
