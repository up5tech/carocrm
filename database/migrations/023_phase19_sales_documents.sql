-- Phase 19-S.6 – 19-S.12 — commercial documents and their line items (PLAN_Phase_19_Sales.md §5.8).
--
-- Documents and items are ordinary metadata entities in `entity_records`, so what JSON alone cannot
-- express — the uniqueness a commercial document number needs, and the indexes the list/detail,
-- ageing and fulfilment queries need — is expressed here.
--
-- Additive only (AGENTS.md §3.5): indexes and one unique backstop over rows this module owns.
-- Nothing is dropped, truncated, rewritten or backfilled.

-- ---------------------------------------------------------------------------
-- Document numbers (§4.7)
-- ---------------------------------------------------------------------------
--
-- `sales_document_numbers` is the primary guarantee: a number is allocated under a row lock and
-- `(series_id, number)` is unique. This partial index is the second line of defence, so a duplicate
-- number is impossible even if a row is ever written outside the issuance service. Drafts carry no
-- number, which is why the predicate excludes NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_document_number
  ON entity_records (entity_type, (attrs ->> 'number'))
  WHERE deleted_at IS NULL
    AND (attrs ->> 'number') IS NOT NULL
    AND entity_type IN ('Quote', 'SalesOrder', 'Invoice', 'CreditNote', 'DeliveryOrder', 'ReturnOrder');

-- ---------------------------------------------------------------------------
-- Conversion idempotency (§4.5, §4.6)
-- ---------------------------------------------------------------------------
--
-- A conversion records where it came from and under which correlation. One destination per
-- (source, correlation) is what makes a retried conversion return the existing document instead of
-- creating a second one — enforced here as well as in the service.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_document_conversion
  ON entity_records (entity_type, (attrs ->> 'sourceEntity'), (attrs ->> 'sourceId'), (attrs ->> 'correlationId'))
  WHERE deleted_at IS NULL AND (attrs ->> 'correlationId') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Document list / detail / ageing queries (§16.1)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_quote_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'Quote' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quote_account
  ON entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'Quote' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quote_valid_until
  ON entity_records ((attrs ->> 'validUntil')) WHERE entity_type = 'Quote' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_order_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'SalesOrder' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_order_account
  ON entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'SalesOrder' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'Invoice' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_account
  ON entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'Invoice' AND deleted_at IS NULL;
-- Invoice ageing and overdue detection read this one.
CREATE INDEX IF NOT EXISTS idx_invoice_due_date
  ON entity_records ((attrs ->> 'dueDate')) WHERE entity_type = 'Invoice' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_payment_status
  ON entity_records ((attrs ->> 'paymentStatus')) WHERE entity_type = 'Invoice' AND deleted_at IS NULL;
-- The list of invoices a payment or credit can still be allocated to.
CREATE INDEX IF NOT EXISTS idx_invoice_outstanding
  ON entity_records ((attrs ->> 'accountId'), (attrs ->> 'paymentStatus'))
  WHERE entity_type = 'Invoice' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_credit_note_invoice
  ON entity_records ((attrs ->> 'invoiceId')) WHERE entity_type = 'CreditNote' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_order_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'DeliveryOrder' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_order_source
  ON entity_records ((attrs ->> 'salesOrderId')) WHERE entity_type = 'DeliveryOrder' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_return_order_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'ReturnOrder' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_return_order_source
  ON entity_records ((attrs ->> 'salesOrderId')) WHERE entity_type = 'ReturnOrder' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Line items (§4.4)
-- ---------------------------------------------------------------------------
--
-- Every item lookup is "the items of this document", ordered by `position`, so each item entity gets
-- one parent index. `position` is part of the key so the ordering is served by the index itself.
CREATE INDEX IF NOT EXISTS idx_quote_item_parent
  ON entity_records ((attrs ->> 'quoteId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'QuoteItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_order_item_parent
  ON entity_records ((attrs ->> 'salesOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'SalesOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_item_parent
  ON entity_records ((attrs ->> 'invoiceId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'InvoiceItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_credit_note_item_parent
  ON entity_records ((attrs ->> 'creditNoteId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'CreditNoteItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_order_item_parent
  ON entity_records ((attrs ->> 'deliveryOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'DeliveryOrderItem' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_return_order_item_parent
  ON entity_records ((attrs ->> 'returnOrderId'), ((attrs ->> 'position')::int))
  WHERE entity_type = 'ReturnOrderItem' AND deleted_at IS NULL;

-- Product-level reporting and "which documents contain this product" questions.
CREATE INDEX IF NOT EXISTS idx_sales_document_item_product
  ON entity_records ((attrs ->> 'productId'))
  WHERE deleted_at IS NULL
    AND entity_type IN ('QuoteItem', 'SalesOrderItem', 'InvoiceItem', 'CreditNoteItem', 'DeliveryOrderItem', 'ReturnOrderItem');
