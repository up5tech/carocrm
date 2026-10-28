-- Phase 22.7 — the provider's event id is the idempotency key of a payment event
-- (PLAN_Phase_22_Integration_E2E_Hardening.md §12 tasks 2 and 3).
--
-- A provider payment event is ingested twice whenever the provider retries, and two deliveries can
-- also arrive at the same time. The check ("has this event id been recorded before?") and the write
-- ("record it") were two separate statements, so two concurrent deliveries could both pass the check
-- and both write — and a payment request that is settled twice is money that moved twice.
--
-- The unique index makes the *write* the decision instead of the check: the loser of the race is
-- refused by the database and is answered as the duplicate it is.
--
-- The index is additive and partial:
--   * only a live log row takes part, so a soft-deleted row never blocks a new event;
--   * only a row that carries an event id takes part, so the index stays small.
--
-- The key is the provider's event id on its own, which is exactly what the service looked up before.
-- It is not scoped by provider, which is harmless today (the payment path has one provider) and is
-- recorded as a known gap rather than silently changed here.

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_payment_provider_event_id
  ON entity_records ((attrs ->> 'providerEventId'))
  WHERE entity_type = 'PaymentProviderEventLog'
    AND deleted_at IS NULL
    AND (attrs ->> 'providerEventId') IS NOT NULL;
