-- Phase 19 — Sales & Commercial Operations (`sales`), phases 19-S.2–19-S.5
-- (PLAN_Phase_19_Sales.md §5, §8.3).
--
-- Sales entities (Product, ProductCategory, PriceBook, …) are ordinary metadata entities in the
-- generic `entity_records` store, so the Entity Engine keeps CRUD, validation, audit, stream and
-- record ACL. What JSON alone cannot express — a case-insensitive unique SKU, and the atomic
-- document-number series — is expressed here.
--
-- Additive only (AGENTS.md §3.5): two new tables plus indexes and one unique constraint over rows
-- this module owns. Nothing is dropped, truncated, rewritten or backfilled.

-- ---------------------------------------------------------------------------
-- Document numbering (19-S.2, §8.3)
-- ---------------------------------------------------------------------------

-- One row per commercial document series. `next_number` is the *unallocated* next value; allocation
-- takes a row lock (`UPDATE … RETURNING`) so two concurrent issuances can never receive the same
-- number, and the ledger's unique constraint is the second line of defence.
CREATE TABLE IF NOT EXISTS sales_number_series (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  prefix      TEXT NOT NULL DEFAULT '',
  padding     INTEGER NOT NULL DEFAULT 6,
  next_number INTEGER NOT NULL DEFAULT 1,
  allocation  TEXT NOT NULL DEFAULT 'issuance',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_number_series_code UNIQUE (code),
  CONSTRAINT chk_sales_number_series_padding CHECK (padding BETWEEN 1 AND 12),
  CONSTRAINT chk_sales_number_series_next CHECK (next_number > 0),
  CONSTRAINT chk_sales_number_series_allocation CHECK (allocation IN ('issuance', 'creation'))
);

-- Every allocated number, with the document it was allocated to. A number is never reused after a
-- void; the row stays as the audit trail (§8.3).
CREATE TABLE IF NOT EXISTS sales_document_numbers (
  id             TEXT PRIMARY KEY,
  series_id      TEXT NOT NULL REFERENCES sales_number_series (id) ON DELETE RESTRICT,
  number         INTEGER NOT NULL,
  formatted      TEXT NOT NULL,
  document_type  TEXT,
  document_id    TEXT,
  allocated_by   TEXT,
  correlation_id TEXT,
  allocated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_document_numbers_series_number UNIQUE (series_id, number)
);

-- One number per document: a retried issuance command finds its allocation instead of taking a
-- second number (§4.7, §8.3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_document_numbers_document
  ON sales_document_numbers (document_type, document_id)
  WHERE document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_document_numbers_series
  ON sales_document_numbers (series_id, number DESC);

-- ---------------------------------------------------------------------------
-- Product catalog (19-S.3, §4.1)
-- ---------------------------------------------------------------------------

-- §4.1 rule 5: "SKU uniqueness must follow an explicit scope … enforced with a database constraint."
-- The audit (docs/implementation/sales-repository-audit.md §6) chose the installation-wide scope:
-- one SKU per organization, case-insensitive, soft-deleted rows excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_product_sku
  ON entity_records (lower(attrs ->> 'sku'))
  WHERE entity_type = 'Product' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_product_category
  ON entity_records ((attrs ->> 'categoryId'))
  WHERE entity_type = 'Product' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_product_category_parent
  ON entity_records ((attrs ->> 'parentId'))
  WHERE entity_type = 'ProductCategory' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Pricing (19-S.4, §4.3)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_price_book_entry_product
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'priceBookId'))
  WHERE entity_type = 'PriceBookEntry' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_price_book_rule_book
  ON entity_records ((attrs ->> 'priceBookId'))
  WHERE entity_type = 'PriceRule' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_price_book_account
  ON entity_records ((attrs ->> 'accountId'))
  WHERE entity_type = 'PriceBook' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_supplier_price_product
  ON entity_records ((attrs ->> 'productId'), (attrs ->> 'supplierId'))
  WHERE entity_type = 'SupplierProductPrice' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Taxes (19-S.5, §4.12)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_tax_rate_code
  ON entity_records ((attrs ->> 'taxCodeId'))
  WHERE entity_type = 'TaxRate' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_tax_rule_code
  ON entity_records ((attrs ->> 'taxCodeId'), ((attrs ->> 'priority')::int))
  WHERE entity_type = 'TaxRule' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_tax_rule_class
  ON entity_records ((attrs ->> 'taxClassId'))
  WHERE entity_type = 'TaxRule' AND deleted_at IS NULL;
