-- 099_phase25_workflow_trigger.sql — permit the workflow AI door (Phase 25.5).
--
-- Additive in meaning: no row, column or table is removed or rewritten. The existing
-- `ai_agent_runs_trigger_check` is replaced with the same constraint plus one additional
-- value, `workflow`, so a run started by an in-product workflow can be attributed honestly
-- instead of masquerading as an integration trigger. All prior values stay valid.
--
-- No data backfill is needed: no existing row can carry the new value until 25.5 code ships.

ALTER TABLE ai_agent_runs
  DROP CONSTRAINT IF EXISTS ai_agent_runs_trigger_check;

ALTER TABLE ai_agent_runs
  ADD CONSTRAINT ai_agent_runs_trigger_check
  CHECK (trigger IN ('manual', 'record', 'event', 'schedule', 'integration', 'workflow'));
