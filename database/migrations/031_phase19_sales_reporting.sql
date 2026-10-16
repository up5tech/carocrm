-- Phase 19-S.18 — the report and operational reads that were doing a sequential scan.
--
-- The curated Sales datasets (§12) filter and group on attributes the earlier phases indexed for
-- their own commands, so three paths were new here: the credit-side lists (which credit is still
-- unapplied), the monthly allocation ledger, and the payable side of purchasing. Money is summed by
-- the report engine through `EntityCrudService.aggregate`, so these indexes exist for the *selection*
-- each dataset starts from, not for the arithmetic.
--
-- Additive only (AGENTS.MD §3.5): partial expression indexes over rows this module owns. Nothing is
-- dropped, rewritten or backfilled, and no table is touched.

CREATE INDEX IF NOT EXISTS idx_credit_note_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'CreditNote' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bill_credit_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'BillCredit' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bill_payment_status
  ON entity_records ((attrs ->> 'paymentStatus')) WHERE entity_type = 'Bill' AND deleted_at IS NULL;

-- The "what was applied this month" ledger read, and the same rows found from the credit side.
CREATE INDEX IF NOT EXISTS idx_payment_allocation_allocated_at
  ON entity_records ((attrs ->> 'allocatedAt')) WHERE entity_type = 'PaymentAllocation' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_credit_note_allocation_allocated_at
  ON entity_records ((attrs ->> 'allocatedAt')) WHERE entity_type = 'CreditNoteAllocation' AND deleted_at IS NULL;

-- The upcoming-billing list (19-S.16) reads periods by planned invoice date within a status.
CREATE INDEX IF NOT EXISTS idx_subscription_period_planned
  ON entity_records ((attrs ->> 'plannedInvoiceDate'))
  WHERE entity_type = 'SubscriptionPeriod' AND deleted_at IS NULL;
