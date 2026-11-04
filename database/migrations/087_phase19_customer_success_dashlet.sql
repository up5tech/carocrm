-- Phase 19-CS.13 — the Customer Success portfolio dashlet kind (plans/PLAN_Phase_19_Customer_Success.md §5.12).
--
-- `dashlets.kind` carried a CHECK for the three generic Phase 12 kinds plus Projects' `projectTasks`,
-- ESignature's `esignature` and Lead Score's `leadScore`. The Customer Success module already publishes a
-- dashlet catalogue (`GET action/dashlets`, 19-CS.13) but nothing consumed it: a portfolio queue is not a
-- `list` dashlet, because its rows are chosen by health, renewal and onboarding rules the generic entity
-- filter cannot express, and the portfolio aggregate is not a `chart`, because it is several counts over a
-- bounded ACL-scoped scan rather than one grouped measure.
--
-- The constraint is replaced by a STRICT SUPERSET of the previous one: every existing row stays valid, and
-- no column, table or value is removed (AGENTS.md §3.5). This file creates no table, drops no column,
-- truncates nothing, and touches no existing row.
--
-- No numbers are stored here. A dashlet is a *question* — one catalogue key plus a row limit — and the answer
-- is computed when the dashlet runs, under the reader's own record scope, so a shared dashboard can never
-- show a CSM the reader could not open (the rule the ESignature dashlet established, ES.19).

ALTER TABLE dashlets DROP CONSTRAINT IF EXISTS chk_dashlets_kind;
ALTER TABLE dashlets
  ADD CONSTRAINT chk_dashlets_kind
  CHECK (kind IN ('list', 'chart', 'kpi', 'projectTasks', 'esignature', 'leadScore', 'customerSuccess'));
