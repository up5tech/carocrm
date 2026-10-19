-- Phase 19-AI.10 — approval decision invariant correction.
--
-- 045 required `decided_by_user_id IS NULL` for every `expired` or `invalidated` row. That is wrong
-- for the two transitions AI.10 actually performs:
--
--   * an approval the reviewer already approved is invalidated when its target disappeared or the
--     tool was disabled before execution — the reviewer's decision must stay attributable, so
--     `decided_by_user_id` remains set;
--   * a pending approval invalidated by a canceled run legitimately has no decider.
--
-- The corrected invariant is the one that matters: a *pending* row has not been decided. Additive
-- and idempotent; no row is rewritten, no column is dropped, and the old constraint is replaced in
-- place.

ALTER TABLE ai_agent_approvals
  DROP CONSTRAINT IF EXISTS ai_agent_approvals_decision_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_approvals_pending_undecided_check'
  ) THEN
    ALTER TABLE ai_agent_approvals
      ADD CONSTRAINT ai_agent_approvals_pending_undecided_check
      CHECK (status <> 'pending' OR decided_by_user_id IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN ai_agent_approvals.decided_by_user_id IS
  'Set when a reviewer decides; retained if the decision is later invalidated. NULL only while pending.';
