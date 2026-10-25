-- Phase 19-LS.17 — the AI insight read path (PLAN_Phase_19_LeadScore.md §6.7, §11.1, §16 `19-LS.17`;
-- repository audit docs/implementation/lead-score-audit.md §7.3).
--
-- Additive only, and index-only (AGENTS.md §3.5). No table is created, dropped or renamed, no column is
-- added or altered, nothing is truncated, deleted, backfilled or rewritten, and no existing row is touched.
--
-- `LeadScoreInsight` is an ordinary metadata entity: its fields live in `entity_records.attrs` and its
-- physical columns are the shared ones (`id`, `name`, `version`, `team_ids`). These two indexes serve the
-- two reads the module actually performs:
--
--   1. the latest explanation for one Lead — the Lead detail surface asks "what did the AI say about this
--      score", filtered by `leadId` and ordered by `generatedAt` DESC. Without the index that is a scan of
--      every insight row on the instance;
--   2. one request key resolves to at most one row — a replayed request (a double click, a lost response)
--      must return the stored answer rather than spending a second provider call. The key is required by
--      metadata, so no `IS NOT NULL` guard is needed; keeping it partial on the entity keeps the index out
--      of the way of every other record type.
--
-- The expression form is the one 073 uses: `(attrs ->> '<field>')` text is already the order the query
-- needs for ISO-8601 timestamps, and the key is compared as text. These are constant-expression indexes,
-- so they serve the module's own literal SQL (`lead-score-records.ts`) and not the generic Entity Engine
-- path that binds the attribute name as a parameter — the same caveat recorded in 073.
--
-- No insight is created here, and nothing in this file calls a provider: an explanation appears only when
-- an operator clicks the action with the feature, the capability and a configured agent.
--
-- Idempotent by construction: `IF NOT EXISTS` throughout, so a re-run is a no-op.

CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_insight_lead
  ON entity_records ((attrs ->> 'leadId'), (attrs ->> 'generatedAt') DESC)
  WHERE entity_type = 'LeadScoreInsight' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_lead_score_insight_key
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'LeadScoreInsight';
