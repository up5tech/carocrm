-- Phase 19-OM.22 — security hardening: diagnostic/processing payload split
-- (PLAN_Phase_19_Omnichannel.md §14 OM.22; docs/omnichannel/security-hardening.md).
--
-- The webhook receipt stores two payloads from now on:
--   * `payload_redacted` — the diagnostic copy returned by operations inspection. Credential-like
--     fields are dropped and message bodies, addresses and contact handles are masked.
--   * `payload_internal` — the processing copy the event worker normalizes. It is never returned by
--     an API response; the receipt row is the only holder, and receipt retention removes both.
-- The worker falls back to `payload_redacted` for rows written before this migration.
--
-- Also indexes the visitor-session abuse budget (`ip_hash`, `first_seen_at`), which the per-address
-- session cap counts. Additive only; no rows are rewritten.

BEGIN;

ALTER TABLE voice_webhook_events
  ADD COLUMN IF NOT EXISTS payload_internal JSONB;

CREATE INDEX IF NOT EXISTS idx_omnichannel_visitor_sessions_ip_first_seen
  ON omnichannel_visitor_sessions (ip_hash, first_seen_at);

COMMIT;
