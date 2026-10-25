-- Phase 19-LS.18 — the Lead Score operational dashlet kind (PLAN_Phase_19_LeadScore.md §16 `19-LS.18`).
--
-- `dashlets.kind` carried a CHECK from the three generic Phase 12 kinds plus Projects' `projectTasks` and
-- ESignature's `esignature`. The Lead Score dashlet shows one of the module's curated score/conversion views,
-- so it needs its own kind: it is configured by a view name, not by an entity/groupBy pair.
--
-- The constraint is replaced by a STRICT SUPERSET of the previous one: every existing row stays valid, and no
-- column, table or value is removed (AGENTS.md §3.5). This file creates no table, drops no column, truncates
-- nothing, and touches no existing row.
--
-- The numbers themselves are not stored here. A dashlet is a *question*, and the answer is computed when the
-- dashlet runs, under the reader's own record scope — so a shared dashboard can never become a way to count
-- Leads the reader could not open (the rule the ESignature dashlet established, ES.19).

ALTER TABLE dashlets DROP CONSTRAINT IF EXISTS chk_dashlets_kind;
ALTER TABLE dashlets
  ADD CONSTRAINT chk_dashlets_kind
  CHECK (kind IN ('list', 'chart', 'kpi', 'projectTasks', 'esignature', 'leadScore'));
