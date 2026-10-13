-- Phase 19 — the Project Task dashlet kind (PLAN_Phase_19_Projects.md §4.16).
--
-- `dashlets.kind` carried a CHECK from the three generic Phase 12 kinds. Projects needs a fourth,
-- because "due in the next N days, owned by me or shared with me" is not expressible as a plain
-- list/chart/kpi over one entity.
--
-- The constraint is replaced by a STRICT SUPERSET of the old one, so every existing row stays valid
-- and no column, table or value is removed (AGENTS.md §3.5: additive, backward compatible).

ALTER TABLE dashlets DROP CONSTRAINT IF EXISTS chk_dashlets_kind;
ALTER TABLE dashlets
  ADD CONSTRAINT chk_dashlets_kind
  CHECK (kind IN ('list', 'chart', 'kpi', 'projectTasks'));
