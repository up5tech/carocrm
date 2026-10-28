-- Phase 22.12 — an attributed conversion is recorded once per correlation id
-- (PLAN_Phase_22_Integration_E2E_Hardening.md §13.5 step 8, and the §12 rule this closes: "a duplicate
-- delivery never produces a second business effect").
--
-- `POST /api/v1/MarketingAutomation/action/attribution` is how another module tells Marketing Automation
-- that a campaign's work paid off. It inserted a `conversion` event unconditionally: the same call made
-- twice — a retried job, a replayed webhook handler, an operator pressing the button again — counted the
-- conversion twice and added its amount to the campaign's influenced revenue twice, so the report a
-- marketer acts on could be inflated by nothing but a duplicate request.
--
-- The index makes the write itself the decision, exactly as 083 did for payment provider events: a second
-- delivery of the same outcome is refused by the database and answered as the duplicate it is.
--
-- It is additive and deliberately narrow:
--   * only an internally-recorded conversion takes part, so a provider's own events are untouched;
--   * only an outcome that names a correlation id takes part — a caller that records two different
--     conversions without one is describing two different facts, and both stand;
--   * it is scoped by campaign, because attribution is many-to-one by design: the same outcome may be
--     credited to two campaigns, and that is a report, not a duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_events_internal_attribution
  ON marketing_events (campaign_id, provider_event_id)
  WHERE provider = 'internal'
    AND normalized_type = 'conversion'
    AND provider_event_id IS NOT NULL;
