-- Phase 19-ES.17 — approval workflow columns (PLAN_Phase_19_ESignature.md §11, §18 `19-ES.17`).
--
-- Additive only: four nullable columns on signature_requests. No row is rewritten and no existing
-- meaning changes. `approved_at`, `approved_by_id`, `approved_digest` and `approval_reason` already
-- carried the decision; these columns add **when the review was requested**, **by whom**, and **which
-- exact request version/digest the reviewer decided on**. The digest is kept even for a rejection so
-- the evidence says what was refused, while `approved_digest` remains only a granted approval (the
-- send gate reads it).
--
-- No new index: the existing partial index `idx_signature_requests_approval` already covers the
-- pending queue (`approval_status = 'pending'`).

ALTER TABLE signature_requests
  ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_requested_by_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_reviewed_version INTEGER,
  ADD COLUMN IF NOT EXISTS approval_reviewed_digest TEXT;
