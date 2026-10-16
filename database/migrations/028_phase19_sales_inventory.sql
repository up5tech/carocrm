-- Phase 19-S.14 — Warehouses, the stock ledger, adjustments, transfers and reservations
-- (PLAN_Phase_19_Sales.md §4.15, §5.5, §5.8).
--
-- The ledger (`InventoryTransaction`), its corrections (`InventoryAdjustment`), transfers
-- (`TransferOrder`/`TransferOrderItem`) and reservations (`InventoryReservation`) are ordinary
-- metadata entities in the generic `entity_records` store, so list/detail/search/ACL/audit come from
-- the Entity Engine. What JSON alone cannot express is persisted here:
--
--   * the **projection** the concurrency rules lock (`sales_inventory_stock`), which is reconciled
--     against the ledger rather than trusted blindly (§4.15 invariant 1);
--   * the **idempotency** of a movement — one source document, one movement key (§4.15 invariant 2);
--   * the indexes the availability, history and in-transit reads need.
--
-- Additive only (AGENTS.md §3.5): one new table plus indexes over rows this module owns. Nothing is
-- dropped, truncated or rewritten.

-- ---------------------------------------------------------------------------
-- Stock projection (§4.15 invariant 1, invariant 7)
-- ---------------------------------------------------------------------------
--
-- A rigorously maintained projection of the movement ledger, keyed by (product, warehouse). It is
-- the lock target that makes concurrent reservations safe: an operation locks the pair's row
-- (`SELECT … FOR UPDATE`) before it reads `on_hand`/`reserved` and writes the new values, so two
-- confirmations cannot both promise the last unit. `reserved` is never allowed to go negative — a
-- release/consume of more than was reserved is a bug, not a policy.
CREATE TABLE IF NOT EXISTS sales_inventory_stock (
  product_id   TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  on_hand      NUMERIC(28, 10) NOT NULL DEFAULT 0,
  reserved     NUMERIC(28, 10) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_sales_inventory_stock PRIMARY KEY (product_id, warehouse_id),
  CONSTRAINT chk_sales_inventory_stock_reserved CHECK (reserved >= 0)
);

-- Where product stock sits across the warehouses — the list a stock report walks.
CREATE INDEX IF NOT EXISTS idx_sales_inventory_stock_warehouse
  ON sales_inventory_stock (warehouse_id, product_id);

-- ---------------------------------------------------------------------------
-- Movement ledger idempotency (§4.15 invariant 2)
-- ---------------------------------------------------------------------------
--
-- `movementKey` is derived from the source document and line (never from a request), so a retried
-- confirmation asks for the same movement once. This unique index is the second line of defence
-- behind the service's pre-check: a replay that races the check still cannot write a second row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_inventory_movement_key
  ON entity_records ((attrs ->> 'movementKey'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL
    AND (attrs ->> 'movementKey') IS NOT NULL;

-- The three reads the ledger must stay fast for: one product's history, one warehouse's history,
-- and a reconciliation scan ordered by time.
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_product
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'occurredAt'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_warehouse
  ON entity_records ((attrs ->> 'warehouseId'), (attrs ->> 'occurredAt'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL;
-- The source lookup: "what did this document move" and the reconciliation join.
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_source
  ON entity_records ((attrs ->> 'sourceEntity'), (attrs ->> 'sourceId'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL;
-- Both halves of a transfer, read back together.
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_transfer_group
  ON entity_records ((attrs ->> 'transferGroupId'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Warehouses (§4.15)
-- ---------------------------------------------------------------------------

-- A warehouse code identifies the location; like a SKU the scope is the installation, and a
-- soft-deleted warehouse must not reserve its code forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_warehouse_code
  ON entity_records (lower(attrs ->> 'code'))
  WHERE entity_type = 'Warehouse' AND deleted_at IS NULL
    AND (attrs ->> 'code') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_warehouse_active
  ON entity_records ((attrs ->> 'active'))
  WHERE entity_type = 'Warehouse' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Adjustments (§4.15 "reviewed corrections")
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_inventory_adjustment_status
  ON entity_records ((attrs ->> 'status'))
  WHERE entity_type = 'InventoryAdjustment' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_adjustment_product
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'warehouseId'))
  WHERE entity_type = 'InventoryAdjustment' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Transfers (§4.15 invariant 5)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_transfer_order_status
  ON entity_records ((attrs ->> 'status'))
  WHERE entity_type = 'TransferOrder' AND deleted_at IS NULL;
-- The in-transit read that feeds `incoming`: which transfers are destined for this warehouse.
CREATE INDEX IF NOT EXISTS idx_transfer_order_destination
  ON entity_records ((attrs ->> 'destinationWarehouseId'), (attrs ->> 'status'))
  WHERE entity_type = 'TransferOrder' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_order_item_parent
  ON entity_records ((attrs ->> 'transferOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'TransferOrderItem' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reservations (§4.15 invariant 7)
-- ---------------------------------------------------------------------------

-- The active reservations for a product/warehouse pair, which is what a consume walks, and what the
-- availability figure is built from.
CREATE INDEX IF NOT EXISTS idx_inventory_reservation_active
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'warehouseId'), (attrs ->> 'status'))
  WHERE entity_type = 'InventoryReservation' AND deleted_at IS NULL;
-- The reservations an order placed, so cancelling the order can release exactly them.
CREATE INDEX IF NOT EXISTS idx_inventory_reservation_source
  ON entity_records ((attrs ->> 'sourceEntity'), (attrs ->> 'sourceId'), (attrs ->> 'status'))
  WHERE entity_type = 'InventoryReservation' AND deleted_at IS NULL;
