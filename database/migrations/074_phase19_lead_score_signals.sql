-- Phase 19-LS.9 — the engagement-signal read path (PLAN_Phase_19_LeadScore.md §6.3, §6.4, §10.1,
-- §16 `19-LS.9`; repository audit docs/implementation/lead-score-audit.md §7.1, gap G6).
--
-- Additive only, and index-only (AGENTS.md §3.5). No table is created, dropped or renamed, no column is
-- added or altered, nothing is truncated, deleted, backfilled or rewritten, and no existing row is touched.
-- `marketing_events` keeps belonging to Marketing Automation: Lead Score reads it and writes nothing here.
--
-- Why an index is part of this phase rather than a later optimisation.
--
-- 19-LS.9 lets a scoring rule read the engagement a *recipient record* received — "this Lead opened three
-- of our emails in the last 30 days". That query filters on `recipient_entity_type` + `recipient_entity_id`
-- and orders by `occurred_at`, and today every read of this table in the repository is campaign-scoped
-- (`marketing-campaign-log.service.ts:58-65`, `marketing-attribution.service.ts:46-61`), which is why the
-- only indexes are `(campaign_id, received_at)`, `(send_id, received_at)` and the webhook-inbox uniqueness
-- (`042_phase19_marketing_webhook_inbox.sql:44-48`). A recipient-scoped read without a matching index is a
-- sequential scan of the whole event log, and Lead Score runs it while scoring a Lead — interactively, and
-- in a chunk of up to 50 Leads during a rebuild (plan §14.2: "list and recalculation performance").
--
-- The index is partial on `recipient_entity_id IS NOT NULL` because a provider event that never resolved a
-- recipient carries no recipient at all, and Lead Score must not read those rows (audit gap G6: attribution
-- is by recipient record, never by address, so a shared mailbox cannot lend one Lead another's engagement).
--
-- `occurred_at` is DESC because every reader asks for the most recent events inside a bounded lookback
-- window and stops there; the column is nullable (a provider may report an event without a timestamp), and
-- NULLs sort last in a DESC scan, which is the safe place for a row whose age cannot be computed.
--
-- No score is calculated by this file, and nothing here changes what a stored score means: a rule that
-- reads an engagement signal cannot be published until 19-LS.9's code is deployed, and the feature switch
-- (`features.engagementSignals`) decides whether the read happens at all.

CREATE INDEX IF NOT EXISTS idx_marketing_events_lead_score_recipient
  ON marketing_events (recipient_entity_type, recipient_entity_id, occurred_at DESC)
  WHERE recipient_entity_id IS NOT NULL;
