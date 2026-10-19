-- Phase 19-AI.13 — soft-limit warning threshold on budget policies
-- (PLAN_Phase_19_AI_Agents.md §12.3: "soft limits should emit warnings … not silently become
-- hard limits"). Additive and nullable: an existing policy keeps its hard limits and simply
-- never warns until an administrator sets a threshold.

ALTER TABLE ai_agent_budget_policies
  ADD COLUMN IF NOT EXISTS warn_percent INTEGER;

ALTER TABLE ai_agent_budget_policies
  DROP CONSTRAINT IF EXISTS ai_agent_budget_policies_warn_percent_check;

ALTER TABLE ai_agent_budget_policies
  ADD CONSTRAINT ai_agent_budget_policies_warn_percent_check
  CHECK (warn_percent IS NULL OR (warn_percent >= 1 AND warn_percent <= 100));
