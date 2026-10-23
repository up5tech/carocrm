-- Phase 19-ES.8 — the template mapping a draft uses, if it uses one.
-- (PLAN_Phase_19_ESignature.md §4.3, §6.2, §6.7, §11.2, §18 `19-ES.8`.)
--
-- ADDITIVE ONLY (AGENTS.md §3.5): one nullable column and one partial index. No existing column, row or
-- constraint is touched, and every request that predates this migration simply has no mapping.
--
-- Why the binding lives on the request and not only in the snapshot: the sender chooses the mapping in
-- the draft (so a mapping role can be filled and previewed), and the preparation snapshot then records
-- *which* mapping — and which version of it — the review was built from. Recording it only at prepare
-- time would make a mapping change unobservable in the draft, which is exactly the change the plan asks
-- to invalidate a preview for.
--
-- No foreign key on purpose: `signature_template_mappings` rows are retired (soft-deleted or
-- deactivated), never removed, and a request must keep naming the mapping it was prepared from even when
-- an administrator retires it. The row is a reference for the audit, not a cascade target.

ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS template_mapping_id TEXT;

-- "Which requests use this mapping" — the operator question when a mapping is retired.
CREATE INDEX IF NOT EXISTS idx_signature_requests_mapping
  ON signature_requests (template_mapping_id) WHERE template_mapping_id IS NOT NULL;
