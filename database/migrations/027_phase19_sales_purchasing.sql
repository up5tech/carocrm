-- Phase 19-S.12 – 19-S.13 — delivery/return orders and the purchasing documents
-- (PLAN_Phase_19_Sales.md §4.10, §4.12, §5.8).
--
-- Documents and items stay ordinary metadata entities in `entity_records`; what JSON alone cannot
-- express is the uniqueness a commercial document number needs and the indexes the list, detail,
-- fulfilment, receipt and ageing queries need.
--
-- Additive only (AGENTS.md §3.5). The single non-additive statement is the document-number index
-- below, which is dropped and recreated over a **superset** of the same predicate so the four new
-- purchasing kinds get the same guarantee the first six already had. No row is changed, and no
-- existing index loses a column it had before.

-- ---------------------------------------------------------------------------
-- Document numbers (§4.7)
-- ---------------------------------------------------------------------------
--
-- `sales_document_numbers` remains the primary guarantee (a number is allocated under a row lock and
-- `(series_id, number)` is unique). This partial index is the second line of defence across every
-- kind the document engine now serves — including PurchaseOrder, ReceiptOrder, Bill and BillCredit.
DROP INDEX IF EXISTS uq_sales_document_number;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_document_number
  ON entity_records (entity_type, (attrs ->> 'number'))
  WHERE deleted_at IS NULL
    AND (attrs ->> 'number') IS NOT NULL
    AND entity_type IN (
      'Quote', 'SalesOrder', 'Invoice', 'CreditNote', 'DeliveryOrder', 'ReturnOrder',
      'PurchaseOrder', 'ReceiptOrder', 'Bill', 'BillCredit'
    );

-- ---------------------------------------------------------------------------
-- Delivery and return orders (§4.10)
-- ---------------------------------------------------------------------------
--
-- A return may reference a specific shipment, and that is the read the "what was actually delivered"
-- bound is answered from.
CREATE INDEX IF NOT EXISTS idx_return_order_delivery
  ON entity_records ((attrs ->> 'deliveryOrderId')) WHERE entity_type = 'ReturnOrder' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Purchasing (§4.12)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_purchase_order_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'PurchaseOrder' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_order_supplier
  ON entity_records ((attrs ->> 'supplierId')) WHERE entity_type = 'PurchaseOrder' AND deleted_at IS NULL;

-- "What has this order already received", which is where the derived receipt state comes from.
CREATE INDEX IF NOT EXISTS idx_receipt_order_purchase
  ON entity_records ((attrs ->> 'purchaseOrderId'), (attrs ->> 'status'))
  WHERE entity_type = 'ReceiptOrder' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bill_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_supplier
  ON entity_records ((attrs ->> 'supplierId')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;
-- Bill ageing, and the list a supplier payment or bill credit can still be allocated to.
CREATE INDEX IF NOT EXISTS idx_bill_due_date
  ON entity_records ((attrs ->> 'dueDate')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_outstanding
  ON entity_records ((attrs ->> 'supplierId'), (attrs ->> 'paymentStatus'))
  WHERE entity_type = 'Bill' AND deleted_at IS NULL;
-- The purchase-to-receipt-to-bill trace.
CREATE INDEX IF NOT EXISTS idx_bill_purchase_order
  ON entity_records ((attrs ->> 'purchaseOrderId')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_receipt_order
  ON entity_records ((attrs ->> 'receiptOrderId')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bill_credit_bill
  ON entity_records ((attrs ->> 'billId')) WHERE entity_type = 'BillCredit' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_credit_supplier
  ON entity_records ((attrs ->> 'supplierId')) WHERE entity_type = 'BillCredit' AND deleted_at IS NULL;

-- A supplier payment, and the bills it settles.
CREATE INDEX IF NOT EXISTS idx_payment_supplier
  ON entity_records ((attrs ->> 'supplierId')) WHERE entity_type = 'Payment' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Line items (§4.4)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_purchase_order_item_parent
  ON entity_records ((attrs ->> 'purchaseOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'PurchaseOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipt_order_item_parent
  ON entity_records ((attrs ->> 'receiptOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'ReceiptOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_item_parent
  ON entity_records ((attrs ->> 'billId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'BillItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bill_credit_item_parent
  ON entity_records ((attrs ->> 'billCreditId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'BillCreditItem' AND deleted_at IS NULL;

-- Receipt lines are read by the source line they received, for both the derived receipt state and the
-- over-receipt refusal.
CREATE INDEX IF NOT EXISTS idx_receipt_order_item_source
  ON entity_records ((attrs ->> 'sourceItemId'))
  WHERE entity_type = 'ReceiptOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_order_item_source
  ON entity_records ((attrs ->> 'sourceItemId'))
  WHERE entity_type = 'DeliveryOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_return_order_item_source
  ON entity_records ((attrs ->> 'sourceItemId'))
  WHERE entity_type = 'ReturnOrderItem' AND deleted_at IS NULL;

-- Product-level reporting across every document kind the engine now serves. Recreated over a superset
-- of the predicate it had (the four purchasing item entities), so the old coverage is unchanged.
DROP INDEX IF EXISTS idx_sales_document_item_product;
CREATE INDEX IF NOT EXISTS idx_sales_document_item_product
  ON entity_records ((attrs ->> 'productId'))
  WHERE deleted_at IS NULL
    AND entity_type IN (
      'QuoteItem', 'SalesOrderItem', 'InvoiceItem', 'CreditNoteItem',
      'DeliveryOrderItem', 'ReturnOrderItem', 'PurchaseOrderItem',
      'ReceiptOrderItem', 'BillItem', 'BillCreditItem'
    );
