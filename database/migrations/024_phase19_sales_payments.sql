-- Phase 19-S.10 – 19-S.11 — payments, allocations and the records that adjust a balance
-- (PLAN_Phase_19_Sales.md §4.8, §5.8).
--
-- Payments and allocations are ordinary metadata entities in `entity_records`. What JSON alone cannot
-- express is here: the unique key that makes provider-event ingestion idempotent, and the indexes the
-- allocation editor, the outstanding-balance queries and the payment history need.
--
-- Additive only (AGENTS.md §3.5): indexes and one unique constraint over rows this module owns.
-- Nothing is dropped, truncated, rewritten or backfilled.

-- ---------------------------------------------------------------------------
-- Provider event idempotency (§4.8, §6.3)
-- ---------------------------------------------------------------------------
--
-- The provider's own event id is the idempotency key. A webhook delivered twice must find the existing
-- row instead of settling an invoice twice; this unique index is what makes that true even if two
-- deliveries race past the service's own check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_event
  ON entity_records ((attrs ->> 'provider'), (attrs ->> 'providerEventId'))
  WHERE entity_type = 'PaymentProviderEventLog' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Payments (§16.1)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payment_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'Payment' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_account
  ON entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'Payment' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_date
  ON entity_records ((attrs ->> 'paymentDate')) WHERE entity_type = 'Payment' AND deleted_at IS NULL;
-- The "which payments are not fully applied" list.
CREATE INDEX IF NOT EXISTS idx_payment_allocation_status
  ON entity_records ((attrs ->> 'allocationStatus')) WHERE entity_type = 'Payment' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Allocations — the two lookups are "by payment" and "by document"
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payment_allocation_payment
  ON entity_records ((attrs ->> 'paymentId'), (attrs ->> 'allocatedAt'))
  WHERE entity_type = 'PaymentAllocation' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_allocation_document
  ON entity_records ((attrs ->> 'documentId'), (attrs ->> 'allocatedAt'))
  WHERE entity_type = 'PaymentAllocation' AND deleted_at IS NULL;
-- An outstanding-balance query filters by document type as well as by id.
CREATE INDEX IF NOT EXISTS idx_payment_allocation_document_type
  ON entity_records ((attrs ->> 'documentEntity'), (attrs ->> 'documentId'))
  WHERE entity_type = 'PaymentAllocation' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transfer_from
  ON entity_records ((attrs ->> 'fromPaymentId')) WHERE entity_type = 'PaymentTransferAllocation' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_transfer_to
  ON entity_records ((attrs ->> 'toPaymentId')) WHERE entity_type = 'PaymentTransferAllocation' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Payment requests and provider events
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payment_request_status
  ON entity_records ((attrs ->> 'status')) WHERE entity_type = 'PaymentRequest' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_request_account
  ON entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'PaymentRequest' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_request_invoice
  ON entity_records ((attrs ->> 'invoiceId')) WHERE entity_type = 'PaymentRequest' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_event_request
  ON entity_records ((attrs ->> 'paymentRequestId'))
  WHERE entity_type = 'PaymentProviderEventLog' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_provider_event_status
  ON entity_records ((attrs ->> 'processedStatus'))
  WHERE entity_type = 'PaymentProviderEventLog' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Credits and write-offs (19-S.11) — both reduce a receivable, both are read per invoice
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_credit_note_allocation_invoice
  ON entity_records ((attrs ->> 'invoiceId')) WHERE entity_type = 'CreditNoteAllocation' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_credit_note_allocation_note
  ON entity_records ((attrs ->> 'creditNoteId')) WHERE entity_type = 'CreditNoteAllocation' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_write_off_invoice
  ON entity_records ((attrs ->> 'invoiceId'), (attrs ->> 'status'))
  WHERE entity_type = 'WriteOff' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lookups a payment references
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payment_method_active
  ON entity_records ((attrs ->> 'active')) WHERE entity_type = 'PaymentMethod' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_channel_active
  ON entity_records ((attrs ->> 'active')) WHERE entity_type = 'PaymentChannel' AND deleted_at IS NULL;
