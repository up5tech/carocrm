/**
 * Phase 19-S.12 / 19-S.13 — the internal contract for stock movement, and the return-restock disposition.
 *
 * Two things the plan asks for live here, and the real stock ledger (19-S.14) does **not**:
 *
 *  1. **A stable contract.** A confirmed delivery, return or receipt order changes stock, and the
 *     engine that owns the ledger will consume this shape rather than being passed records. The
 *     service that applies movements never has to know what a `DeliveryOrderItem` looks like.
 *  2. **The restock gate.** A returned line is not automatically saleable stock again: an operator
 *     records a *disposition* (`restock`, `scrap`, `quarantine`) per line, and only `restock` may
 *     become an inbound movement. The plan is explicit that "return items restocked only when
 *     disposition allows" — so the decision is a field on the line, captured at issuance, not a
 *     preference someone could flip afterwards.
 *
 * **Idempotency.** `movementKey` is derived from the document entity and id, never from a request
 * value, so a confirmation that is retried produces the *same* key and the ledger can refuse the
 * second application without a second row. The containing transition already refuses a second
 * confirm (the state machine), and this key is what makes that safe to rely on once 19-S.14 applies
 * the plan: one document, one key, one movement.
 *
 * Pure: no database, no clock, no SQL. Everything the caller supplies is bound data.
 */

/**
 * Why a returned line is (or is not) coming back into saleable stock.
 *
 * Mirror of the enum on `ReturnOrderItem` in `database/seed-metadata.ts` — the descriptor is the
 * authority for the state machine, and this is the authority for the restock decision. A drift
 * between the two is caught by `apps/api/test/sales-stock-movement.test.ts`.
 */
export const RESTOCK_DISPOSITIONS = [
  "restock",
  "scrap",
  "quarantine",
] as const;

export type RestockDisposition = (typeof RESTOCK_DISPOSITIONS)[number];

/** A stored line holds a bare string; the gate only accepts a disposition it knows. */
export function parseRestockDisposition(
  value: unknown,
): RestockDisposition | null {
  return RESTOCK_DISPOSITIONS.find((each) => each === value) ?? null;
}

/** A line with no recorded disposition comes back as saleable stock — the operator's default. */
export const DEFAULT_RESTOCK_DISPOSITION: RestockDisposition = "restock";

/** Whether a returned line with this disposition may produce an inbound stock movement. */
export function admitsRestock(
  disposition: string | null | undefined,
): boolean {
  return (disposition ?? DEFAULT_RESTOCK_DISPOSITION) === "restock";
}

/** Which stock effect a document has, and therefore which plan shape it produces. */
export type StockMovementKind = "delivery" | "return" | "receipt";

/** One line of a plan. `quantity` and money amounts are canonical decimal strings. */
export interface StockMovementLine {
  readonly position: number;
  readonly productId: string | null;
  /** The source line this one moved against, when the conversion recorded one. */
  readonly sourceItemId: string | null;
  readonly quantity: string;
  readonly warehouseId: string | null;
  /** Whether this line may change stock. Always true for a delivery; disposition-gated for a return. */
  readonly restocked: boolean;
  /** The return line's own disposition, when one was recorded; `null` when absent or unrecognised. */
  readonly disposition?: RestockDisposition | null | undefined;
}

/**
 * The whole change one confirmed document asks the inventory module to apply.
 *
 * Written into the issuance snapshot (frozen, integrity-checked, server-owned), so what a document
 * asked to move is auditable exactly like its totals and its parties — and a later catalog change
 * cannot rewrite it.
 */
export interface StockMovementPlan {
  /** Deterministic idempotency key: one document, one movement. */
  readonly key: string;
  readonly kind: StockMovementKind;
  readonly documentEntity: string;
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly warehouseId: string | null;
  readonly lines: readonly StockMovementLine[];
}

/** The idempotency key of a document's stock movement — entity and id, nothing request-supplied. */
export function movementKey(entity: string, documentId: string): string {
  return `${entity}:${documentId}`;
}

/** The lines of a plan that may actually change stock. */
export function restockingLines(
  plan: StockMovementPlan,
): readonly StockMovementLine[] {
  return plan.lines.filter((line) => line.restocked);
}

/** What `stock-movement.ts` needs from a stored line; `StoredItem` satisfies it structurally. */
export interface MovementLineInput {
  readonly position: number;
  readonly productId: string | null;
  readonly sourceItemId: string | null;
  readonly quantity: string;
  /** Only a return item carries one; `undefined` on a delivery line. */
  readonly disposition?: string | null | undefined;
}

interface MovementInput {
  readonly documentEntity: string;
  readonly documentId: string;
  readonly documentNumber?: string | null | undefined;
  readonly warehouseId?: string | null | undefined;
  readonly items: readonly MovementLineInput[];
}

/** A confirmed delivery order ships out every line it carries; there is no per-line gate. */
export function planDeliveryMovement(
  input: MovementInput,
): StockMovementPlan {
  return planOutbound("delivery", input);
}

/**
 * A confirmed receipt order brings a purchase in: every line arrives, and the over-receipt guard is
 * the document's own (§4.12). The plan exists so a retried confirmation asks for the movement once.
 */
export function planReceiptMovement(input: MovementInput): StockMovementPlan {
  return planOutbound("receipt", input);
}

function planOutbound(
  kind: StockMovementKind,
  input: MovementInput,
): StockMovementPlan {
  return {
    key: movementKey(input.documentEntity, input.documentId),
    kind,
    documentEntity: input.documentEntity,
    documentId: input.documentId,
    documentNumber: input.documentNumber ?? null,
    warehouseId: input.warehouseId ?? null,
    lines: input.items.map((item) => ({
      position: item.position,
      productId: item.productId,
      sourceItemId: item.sourceItemId,
      quantity: item.quantity,
      warehouseId: input.warehouseId ?? null,
      restocked: true,
    })),
  };
}

/**
 * A confirmed return order brings stock back **per line disposition only**.
 *
 * Every line is recorded — including the ones that must not be restocked — because "this line was
 * scrapped" is a fact an operator needs to see next to the ones that came back, and a plan that
 * silently drops lines cannot be audited.
 */
export function planReturnMovement(
  input: MovementInput,
): StockMovementPlan {
  return {
    key: movementKey(input.documentEntity, input.documentId),
    kind: "return",
    documentEntity: input.documentEntity,
    documentId: input.documentId,
    documentNumber: input.documentNumber ?? null,
    warehouseId: input.warehouseId ?? null,
    lines: input.items.map((item) => ({
      position: item.position,
      productId: item.productId,
      sourceItemId: item.sourceItemId,
      quantity: item.quantity,
      warehouseId: input.warehouseId ?? null,
      // Fail closed: a value this module does not recognise never becomes the default.
      restocked: admitsRestock(item.disposition),
      disposition: parseRestockDisposition(item.disposition),
    })),
  };
}
