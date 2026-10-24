-- Phase 19-LS.2 — Lead Score schema foundation (PLAN_Phase_19_LeadScore.md §5, §16 `19-LS.2`;
-- repository audit docs/implementation/lead-score-audit.md §4, decisions D3/D7).
--
-- What this file is.
--
-- Every Lead Score record — the score model, its rules, the evaluation history and the lead
-- conversion operation — is an ordinary metadata entity, so it lives in `entity_records` with its
-- non-physical attributes in the `attrs` JSONB column. The split that decides what is a column and
-- what is an attribute is `PHYSICAL_KEYS` in apps/api/src/entity/entity-record.store.ts, and nothing
-- here changes it.
--
-- Additive only (AGENTS.md §3.5). No table is created, dropped or renamed; no column is added to
-- `entity_records`; nothing is truncated, deleted, backfilled or rewritten; no `DEFAULT` value is
-- attached to an existing row. No Lead gains a score from this migration — plan §15.1 forbids
-- calculating scores during a schema change, and the first score appears only after an
-- administrator configures and publishes a model (19-LS.3) and a controlled recalculation runs
-- (19-LS.6). Before that, a Lead simply has no score attribute, which is the `not_scored` state.
--
-- What these indexes are for.
--
-- 1. the current-score projection (plan §5.3) is read by every Lead list: sorting and filtering by
--    score, band, evaluation status, model and freshness must not degrade into a sequential scan as
--    the Lead set grows (§14.2);
-- 2. score history is paged per Lead in time order (§5.4, §8.2);
-- 3. the invariants that make recalculation and conversion safe to retry are enforced by the
--    database, not by an application check that a second writer can race past (§7.8, §0.1-11):
--    one rule reason code per model version, one evaluation per idempotency key, and one conversion
--    operation per operation key. The operation-key index is what makes a replayed conversion return
--    the original result instead of creating a second Contact and Account.
--
-- The unique indexes on a nullable key ignore rows where that key is absent (`... IS NOT NULL`), so two
-- evaluations or operations written without an idempotency key — legal, because a key describes an intent
-- a caller may not have named yet — do not collide with each other. An operation's own key is required by
-- metadata, so its `IS NOT NULL` guard is belt-and-braces for a row written before that check. This follows
-- database/migrations/032_phase19_customer_success.sql, which is the repository's precedent for
-- uniqueness over `entity_records.attrs`, and database/migrations/037_phase19_marketing_automation.sql
-- for the nullable-key form.
--
-- Expression form. The text form `(attrs ->> '<field>')` is used everywhere except `scoreValue`,
-- because an attribute holds an ISO-8601 timestamp or a band name whose text order is already the
-- order the query needs, while 0-100 is not text-orderable ('100' < '20' < '9') and a score-range
-- filter has to compare numbers. `scoreValue` is therefore indexed as
-- `((attrs ->> 'scoreValue')::numeric)`, which is also the cast the Entity Engine itself applies to
-- an `int` attribute (`leftExpr`/`attrCast` over `NUMERIC_FIELD_TYPES`,
-- apps/api/src/entity/entity-record.store.ts, `NUMERIC_FIELD_TYPES` at :135 and `attrCast` at :751).
--
-- What these indexes do NOT do, stated here so a later phase does not assume it: the generic store
-- binds the attribute *name* as a parameter (`attrs ->> $1`), and PostgreSQL cannot match a
-- parameterized key against a constant-expression index. So they serve the module's own literal SQL —
-- history paging, the operation lookup, the batch selection — exactly as `signature-request.repository.ts`
-- writes its own predicates today. A Lead list sorted by score goes through the generic path and is
-- covered by the existing `attrs` GIN index plus the bounded page size; if the 19-LS.18 query check
-- shows that path needing more, the answer is a narrow read model or a stored generated column, not
-- another speculative index.
--
-- Idempotent by construction: `IF NOT EXISTS` throughout, so a re-run is a no-op.

-- ---------------------------------------------------------------------------
-- 1. The current-score projection on Lead (plan §5.3)
-- ---------------------------------------------------------------------------
--
-- One projection for the active published model (audit §4): `scoreModelId` and `scoreModelVersion`
-- name the version that produced the value, so a score always states what computed it.
--
-- There is deliberately no unique index here. The projection lives on the Lead row itself, which is
-- one row per Lead, so "one current score per Lead and model" holds structurally rather than by
-- constraint. Plan §5.3 explicitly permits this simpler single-active-model policy; widening it to
-- several live models at once is a documented deferral (compatibility §7 U7), not something a partial
-- index can pretend to cover.

-- List sorting by score value, and the score-range filters plan §11.2 asks for.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_value
  ON entity_records (((attrs ->> 'scoreValue')::numeric))
  WHERE entity_type = 'Lead' AND deleted_at IS NULL;

-- Saved filters by qualification band (Hot Leads, Sales Ready, Needs Qualification).
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_band
  ON entity_records ((attrs ->> 'scoreBand'))
  WHERE entity_type = 'Lead' AND deleted_at IS NULL;

-- The "Stale Scores" filter and the recovery sweep for evaluations stuck in `pending` or `failed`
-- (plan §14.3). Both select on evaluation status, never on a score value.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_status
  ON entity_records ((attrs ->> 'scoreStatus'))
  WHERE entity_type = 'Lead' AND deleted_at IS NULL;

-- Freshness display and the decay window: which Leads were calculated before a given moment.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_calculated
  ON entity_records ((attrs ->> 'scoreCalculatedAt'))
  WHERE entity_type = 'Lead' AND deleted_at IS NULL;

-- The bounded batch rebuild (§6.1, §14.2) selects the Leads carrying a given model's projection, and
-- the model archive/pause path has to count them.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_model
  ON entity_records ((attrs ->> 'scoreModelId'))
  WHERE entity_type = 'Lead' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Score models and rules (plan §5.1, §5.2)
-- ---------------------------------------------------------------------------

-- The administration list is filtered by lifecycle state, and publishing has to find the published
-- version quickly to refuse a second concurrent publication.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_model_status
  ON entity_records ((attrs ->> 'status'))
  WHERE entity_type = 'LeadScoreModel' AND deleted_at IS NULL;

-- A published model version is immutable and is copied forward when a draft is published (plan §5.1),
-- so a model is identified by name plus version. Two rows claiming the same name and version would
-- make stored evaluations ambiguous about what produced them, which plan §0.1-5 forbids.
--
-- The attribute is `modelVersion`, never `version`: `version` is this table's own optimistic-concurrency
-- column (`entity-record.store.ts:116-136`), so a model's version number lives beside it under its own
-- name. `LeadScoreRule` and the Lead projection already spell it that way.
--
-- The name side of the identity is the table's `name` COLUMN, not `attrs ->> 'name'`. `name` is a
-- physical key (`PHYSICAL_KEYS`, :116-136), so it is stored in the column and never in `attrs` — an
-- expression index on `attrs ->> 'name'` would be indexing NULL and would let duplicates through. This is
-- the one index here that mixes a column and an attribute, and it is the one that has to.
--
-- A draft shares the name of the version it will become and carries the next version number, so this
-- constraint does not block editing: it blocks a duplicated publication.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_lead_score_model_version
  ON entity_records (name, ((attrs ->> 'modelVersion')))
  WHERE entity_type = 'LeadScoreModel' AND deleted_at IS NULL;

-- A rule set is read model by model, both in evaluation and in the administration editor.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_rule_model
  ON entity_records ((attrs ->> 'modelId'))
  WHERE entity_type = 'LeadScoreRule' AND deleted_at IS NULL;

-- `reasonCode` is the stable identifier the UI localizes and the history stores (plan §3.1, §6.5). A
-- duplicate code inside one model version would make a stored breakdown ambiguous — two rules claiming
-- the same reason — so the database refuses it rather than trusting an editor check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_lead_score_rule_reason
  ON entity_records ((attrs ->> 'modelId'), (attrs ->> 'modelVersion'), (attrs ->> 'reasonCode'))
  WHERE entity_type = 'LeadScoreRule'
    AND deleted_at IS NULL
    AND (attrs ->> 'reasonCode') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Evaluation history (plan §5.4)
-- ---------------------------------------------------------------------------

-- `GET /api/v1/leads/:leadId/score/history` is paginated newest-first per Lead (§8.2); this is the
-- one access pattern the history table must always serve, and the precedent is
-- `idx_cs_snapshot_profile` + `idx_cs_snapshot_calculated` in
-- database/migrations/032_phase19_customer_success.sql.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_evaluation_lead
  ON entity_records ((attrs ->> 'leadId'), (attrs ->> 'calculatedAt'))
  WHERE entity_type = 'LeadScoreEvaluation' AND deleted_at IS NULL;

-- Model-scoped analytics: rule contribution and score movement for one published version (§12).
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_score_evaluation_model
  ON entity_records ((attrs ->> 'modelId'), (attrs ->> 'calculatedAt'))
  WHERE entity_type = 'LeadScoreEvaluation' AND deleted_at IS NULL;

-- A recalculation may be delivered twice (§10.2 "safe under duplicate delivery"). The evaluation's
-- idempotency key is derived from the intent — lead, model version and trigger — not generated per
-- attempt, so a duplicate job cannot append a second identical history row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_lead_score_evaluation_key
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'LeadScoreEvaluation'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Lead conversion operations (plan §5.5, §7.8)
-- ---------------------------------------------------------------------------

-- The idempotency invariant of the whole conversion design: one operation per key, so a retry after a
-- timeout, a double click or a page refresh returns the recorded result instead of creating a second
-- Contact or Account (§0.1-11). This is the constraint the conversion command in 19-LS.13 relies on,
-- and it is why the key is scoped here and not checked in the application first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_lead_conversion_operation_key
  ON entity_records ((attrs ->> 'operationKey'))
  WHERE entity_type = 'LeadConversionOperation'
    AND deleted_at IS NULL
    AND (attrs ->> 'operationKey') IS NOT NULL;

-- The Lead's conversion history and the "was this Lead already converted?" re-check that runs inside
-- the conversion transaction (§4.3 step 5).
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_conversion_operation_lead
  ON entity_records ((attrs ->> 'sourceLeadId'))
  WHERE entity_type = 'LeadConversionOperation' AND deleted_at IS NULL;

-- The administrator-visible recovery view: operations stuck in `processing` or left `failed_retryable`
-- (§7.8, §14.3). Ordered by request time so the oldest stuck operation surfaces first.
CREATE INDEX IF NOT EXISTS idx_entity_records_lead_conversion_operation_status
  ON entity_records ((attrs ->> 'status'), (attrs ->> 'requestedAt'))
  WHERE entity_type = 'LeadConversionOperation' AND deleted_at IS NULL;
