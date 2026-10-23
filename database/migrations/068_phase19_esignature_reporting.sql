-- Phase 19-ES.19 — the ESignature operational dashlet kind (PLAN_Phase_19_ESignature.md §14).
--
-- `dashlets.kind` carried a CHECK from the three generic Phase 12 kinds plus Projects' `projectTasks`.
-- The ESignature dashlet is configured by a curated report key, not by an entity/groupBy pair, so it
-- needs its own kind. The constraint is replaced by a STRICT SUPERSET of the previous one: every
-- existing row stays valid, and no column, table or value is removed (AGENTS.md §3.5).

ALTER TABLE dashlets DROP CONSTRAINT IF EXISTS chk_dashlets_kind;
ALTER TABLE dashlets
  ADD CONSTRAINT chk_dashlets_kind
  CHECK (kind IN ('list', 'chart', 'kpi', 'projectTasks', 'esignature'));
