-- Phase 19-S.15 — Product variants, batch/serial tracking and removal policies
-- (PLAN_Phase_19_Sales.md §4.2, §4.15, §5.5).
--
-- The lot (`InventoryBatch`) and serial (`InventorySerial`) records are ordinary metadata entities in
-- the generic `entity_records` store, so list/detail/search/ACL/audit come from the Entity Engine,
-- exactly like the 19-S.14 inventory records. What JSON alone cannot express is persisted here:
--
--   * the **attributed stock** per lot (`sales_inventory_batch_stock`), the projection the removal
--     policy picks from and the lock the level already owns (all attribution happens while the
--     (product, warehouse) row is locked, so no second lock discipline is introduced);
--   * the **identity** constraints: one batch per (product, lot number) and one serial record per
--     (product, serial number), case-insensitively — a lot that could be created twice would split
--     its stock across two records, and a serial that could be created twice would claim one unit
--     exists twice. This installation is single-organization, so the organization scope of a serial
--     is the installation itself and the product is what keeps a vendor's numbering usable across
--     different products (§19-S.15 task 5);
--   * the indexes the picking reads (lots of one product, serials of one pair, lookups by number)
--   * need, so an outbound confirmation stays one bounded query.
--
-- Additive only (AGENTS.md §3.5): one new table plus indexes over rows this module owns. Nothing is
-- dropped, truncated or rewritten.

-- ---------------------------------------------------------------------------
-- Attributed batch stock (§4.15, §19-S.15 task 4/6)
-- ---------------------------------------------------------------------------
--
-- On-hand quantity attributed to one lot of one product in one warehouse. Derived from the movement
-- ledger exactly like `sales_inventory_stock` is: every attribution change happens inside the same
-- transaction that locks the (product, warehouse) level, so the two projections cannot drift through
-- concurrency. `on_hand` may only be forced negative by the explicit negative-stock override; the
-- service refuses it under the default policy, mirroring the product-level rule.
CREATE TABLE IF NOT EXISTS sales_inventory_batch_stock (
  product_id   TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  batch_number TEXT NOT NULL,
  on_hand      NUMERIC(28, 10) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_sales_inventory_batch_stock PRIMARY KEY (product_id, warehouse_id, batch_number)
);

-- The removal policy walks one product's lots in one warehouse, ordered by date then number.
CREATE INDEX IF NOT EXISTS idx_sales_inventory_batch_stock_pair
  ON sales_inventory_batch_stock (product_id, warehouse_id);

-- ---------------------------------------------------------------------------
-- Identity (§19-S.15 tasks 1/2/5)
-- ---------------------------------------------------------------------------

-- One batch record per (product, lot number). Case-insensitive so "LOT-1" and "lot-1" are the same
-- physical lot; the stored value keeps the form the operator typed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_batch_identity
  ON entity_records ((attrs ->> 'productId'), lower(attrs ->> 'batchNumber'))
  WHERE entity_type = 'InventoryBatch' AND deleted_at IS NULL;

-- One serial record per (product, serial number). Deliberately not scoped by warehouse: a serial
-- travels between warehouses and must stay the same unit while it does (§19-S.15 task 5).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_serial_identity
  ON entity_records (lower(attrs ->> 'serialNumber'), (attrs ->> 'productId'))
  WHERE entity_type = 'InventorySerial' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reads the picking and traceability paths need (§19-S.15 tasks 4/6)
-- ---------------------------------------------------------------------------

-- The candidate list an outbound movement picks from: every lot of one product.
CREATE INDEX IF NOT EXISTS idx_inventory_batch_product
  ON entity_records ((attrs ->> 'productId'))
  WHERE entity_type = 'InventoryBatch' AND deleted_at IS NULL;

-- Serial lookup by number (case-insensitive), which is how a line's named units are resolved.
CREATE INDEX IF NOT EXISTS idx_inventory_serial_number
  ON entity_records (lower(attrs ->> 'serialNumber'))
  WHERE entity_type = 'InventorySerial' AND deleted_at IS NULL;

-- The candidate list per pair: serials of one product in one warehouse by status.
CREATE INDEX IF NOT EXISTS idx_inventory_serial_lookup
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'warehouseId'), (attrs ->> 'status'))
  WHERE entity_type = 'InventorySerial' AND deleted_at IS NULL;

-- "Which movements touched this lot?" — the batch traceability read behind a recall question.
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_batch
  ON entity_records ((attrs ->> 'batchNumber'))
  WHERE entity_type = 'InventoryTransaction' AND deleted_at IS NULL
    AND (attrs ->> 'batchNumber') IS NOT NULL;
