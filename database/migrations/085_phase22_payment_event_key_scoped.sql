-- Phase 22.19 — the payment provider event key is scoped by provider (G20).
--
-- Migration 024 already installed the intended key:
--   uq_payment_provider_event ON ((attrs ->> 'provider'), (attrs ->> 'providerEventId'))
--
-- Migration 083 then added a second, narrower unique index on `providerEventId` alone while closing
-- the concurrent-delivery race. That made one provider's ids collide with another provider's, which
-- is wrong: event ids are unique within a gateway's own id space, not across gateways. The scoped
-- index from 024 already makes the write the decision for concurrent deliveries of the *same*
-- provider, so the unscoped one is redundant as well as incorrect.
--
-- Additive/safe: an index is dropped, no row is read, rewritten or deleted. The service now looks
-- events up by (provider, providerEventId), which is the key this leaves in place.

DROP INDEX IF EXISTS uq_entity_records_payment_provider_event_id;
