# Phase 19-LS.2 — Schema and metadata foundation

> `PLAN_Phase_19_LeadScore.md` §16 `Phase 19-LS.2`, on the contract in
> [`lead-score-audit.md`](lead-score-audit.md) §4–§6 and the registration in
> [`lead-score-ls1-completion-report.md`](lead-score-ls1-completion-report.md).
> Acceptance: *schema and metadata validate against the current project conventions*, verified against
> the configured database with `database/migrations` + `app_settings` checks and **no new database**.
> Followed by: `lead-score-ls3-completion-report.md` (19-LS.3, model and rule configuration).

Delivered **2026-10-24**.

---

## 1. What landed

### 1.1 One migration, index-only

[`database/migrations/073_phase19_lead_score.sql`](../../database/migrations/073_phase19_lead_score.sql)
— 15 indexes over the shared `entity_records` table, every one of them partial on
`entity_type = '…' AND deleted_at IS NULL`. Applied to the configured database and recorded once in
`schema_migrations`. No table created, no column added, no row rewritten, no default attached to
existing data, nothing dropped or truncated.

| Group | Indexes | Why |
| --- | --- | --- |
| Current-score projection on `Lead` | `idx_entity_records_lead_score_value` (`::numeric`), `_band`, `_status`, `_calculated`, `_model` | list sorting, band and freshness filters, and the batch selection a publication triggers (plan §5.3, §11.2, §14.2) |
| Models | `idx_…_model_status`, **`uq_…_model_version`** `(name, attrs->>'modelVersion')` | administration list; and a model is identified by name *plus version*, so a duplicated publication of one version is impossible rather than merely unplanned (§5.1) |
| Rules | `idx_…_rule_model`, **`uq_…_rule_reason`** `(modelId, modelVersion, reasonCode)` | rules are read model by model; one stable reason code per model version, because two rules claiming one code would make a stored breakdown ambiguous about what produced the score (§3.1, §6.5) |
| Evaluations | `idx_…_evaluation_lead` `(leadId, calculatedAt)`, `idx_…_evaluation_model`, **`uq_…_evaluation_key`** `(idempotencyKey)` | history paged newest-first per Lead; and duplicate job delivery cannot append a second identical history row (§5.4, §8.2, §10.2) |
| Conversion operations | **`uq_…_operation_key`** `(operationKey)`, `idx_…_operation_lead`, `idx_…_operation_status` `(status, requestedAt)` | the idempotency invariant of the whole conversion design, plus the Lead's conversion history and the recovery view for stuck operations (§5.5, §7.8, §14.3) |

Precedents followed: `032_phase19_customer_success.sql` (uniqueness over `attrs`, two-column history
index) and `037_phase19_marketing_automation.sql` (the `IS NOT NULL` form for an optional key).

> One honest note on how this file reached the database: `073` was applied, the two schema facts in §3
> were found by the tests, and the model-identity index was therefore redefined **before the commit** —
> `uq_entity_records_lead_score_model_version` was dropped and recreated with the corrected expression
> against the configured database. Index definition only: no table, column or row was touched, and the
> file and the database agree today (verified by reading `pg_indexes` back). A committed migration would
> never have been edited this way; it would have needed a `074`.

### 1.2 Four metadata entities, registered where the platform registers entities

[`database/seed-metadata.ts`](../../database/seed-metadata.ts) — `leadScoreEntities()` plus the shared
`leadScoreFields()` and the `LS_*` / `CONVERSION_*` vocabularies, spread into `coreMetadata`. All four
are ordinary `entity_records` metadata entities, so the Entity Engine keeps CRUD, validation, field ACL,
audit, stream, attachments, hooks and search, and the module supplies behavior instead of a second
record layer (AGENTS.md §5.2).

| Entity | Shape |
| --- | --- |
| `LeadScoreModel` | `modelVersion` (required), `status` `draft/published/archived`, `scaleMin/scaleMax/baseScore/scoreFloor/scoreCeiling`, `qualificationBands`, `dimensionWeights`, `allowedFieldPaths`, `blockedFieldPaths`, `settingsJson`, `effectiveFrom/effectiveTo`, `publishedById/publishedAt/archivedById/archivedAt`; `relations.rules` → `LeadScoreRule` through `modelId`; `record.removable: false` |
| `LeadScoreRule` | `modelId`, `modelVersion`, `reasonCode`, `dimension`, `enabled`, `condition` (JSON tree), `points`, `effect` `add/subtract/setBand`, `targetBand`, `priority`, `missingDataPolicy` (default `neutral`), `signalSource`, `eventType`, `lookbackDays`, `decayPolicy`, `decayHalfLifeDays` |
| `LeadScoreEvaluation` | `leadId`, `modelId`, `modelVersion`, `scoreValue`, `qualificationBand`, `evaluationStatus`, `calculatedAt`, `inputsAsOf`, `sourceRevision`, `trigger`, `resultState`, `coverage`, `ruleResults`, `positive/negative/skippedReasonCodes`, `errorSummary`, `signature`, `correlationId`, `jobId`, `idempotencyKey`, `durationMs`; `client.web: false`, ACL `read/edit/delete: no`, `edit: []` layout — the `CustomerSuccessHealthSnapshot` template |
| `LeadConversionOperation` | `operationKey`, `sourceLeadId`, `sourceLeadRevision`, `status`, `requestedTargets`, `previewHash`, `mappingVersion`, `selectedMatchIds`, `requestedById/requestedAt/confirmedAt/completedAt`, created *and* linked ids per target, `resultSummary`, `failureCode`, `correlationId`; module-written |

### 1.3 The core `Lead` record extended, not replaced

Sixteen server-owned attributes in `attrs` (no column, no table change): the projection
(`scoreValue`, `scoreBand`, `scoreStatus`, `scoreModelId`, `scoreModelVersion`, `scoreCalculatedAt`,
`scoreInputsAsOf`, `scorePreviousValue`, `scoreCoverage`, `scoreReasonCodes`) and the conversion result
(`convertedAt`, `convertedById`, `convertedAccountId`, `convertedContactId`, `convertedOpportunityId`,
`conversionOperationId`).

- **None is `inEdit`.** No generated form anywhere in the SPA can offer to set one.
- The projection is **not `audited`**; the conversion references are. A batch rebuild would otherwise
  write the audited value of every Lead into `audit_log`, while the evaluation rows already *are* the
  score's history, with model version, inputs and reason codes attached.
- `status` keeps its core enum `New, Assigned, In Process, Converted, Dead`. No status was added;
  `Disqualified` exists only as a **band**, reachable through a `setBand` rule or the existing `Dead`
  status (decisions D1, D6).
- New `detail` panels `main` / `score` / `converted`. `main` re-lists the fields the flat view already
  showed, so nothing moved into an "Other" card. `list` and `edit` layouts stay undeclared on purpose —
  their own phases (19-LS.7, 19-LS.14) design them.
- `Lead.relations` stays `{}`: `convertedAccountId` and friends follow the `Contact.accountId`
  convention, which is a link attribute rather than a relation entry (decision D3).

### 1.4 The write guard

[`lead-score-internal.ts`](../../apps/api/src/lead-score/lead-score-internal.ts) is the async-local
marker (`runAsLeadScoreInternal` / `isLeadScoreInternalWrite`), the single owner of
`LEADSCORE_ENTITY_TYPES`, `MODULE_WRITTEN_ENTITY_TYPES`, `SERVER_OWNED_LEAD_FIELDS`,
`SERVER_OWNED_MODEL_FIELDS` and `changedKeys`.

[`lead-score-write-guard.service.ts`](../../apps/api/src/lead-score/lead-score-write-guard.service.ts)
registers three `beforeValidate` hooks with the platform `HookRegistry` —
`leadScore.leadFieldGuard` (entity `Lead`), `leadScore.LeadScoreEvaluationGuard`,
`leadScore.LeadConversionOperationGuard` — the shape `service-desk` and `marketingAutomation` use, and
refuses with `ValidationError` (`VALIDATION_FAILED`, 422) naming `{ entity, fields }`.

Three properties worth stating, because each answers a different attack:

* **an administrator is refused too.** Field-level ACL would let `sysAdmin` through
  (`acl-api.service.ts:172-185`); ownership is not a permission, and nobody outside the module may
  assert that a conversion happened (plan §0.1-8, §7.6);
* **it stays in force while the module is switched off.** Disabling Lead Score closes its screens and
  its jobs; it must not open a way to forge a score or a conversion through the record API;
* **ordinary Lead work is untouched.** A name, status, phone or source edit changes none of the guarded
  keys, so the guard never runs against it — the 19-LS.1 "no conflict with existing Lead behavior"
  criterion is re-tested here rather than assumed.

`LeadScoreModel` and `LeadScoreRule` are deliberately *not* module-written: they are draft
administration records whose lifecycle 19-LS.3 owns.

### 1.5 Vocabulary and health

[`lead-score-vocabulary.ts`](../../apps/api/src/lead-score/lead-score-vocabulary.ts) is the code side of
the same enums (`SCORE_BANDS`, `EVALUATION_STATUSES`, `MODEL_STATUSES`, `RULE_DIMENSIONS`,
`RULE_EFFECTS`, `MISSING_DATA_POLICIES`, `SIGNAL_SOURCES`, `EVALUATION_TRIGGERS`,
`EVALUATION_RESULT_STATES`, `DECAY_POLICIES`, `CONVERSION_STATUSES`, `CONVERSION_TARGETS`,
`RULE_OUTCOMES`, `DEFAULT_SCORE_SCALE`). The duplication with the seed mirrors what Customer Success
does; the health view and the LS.2 tests are what catch a drift.

The descriptor now reports the owned entity set (`entityTypes`, one list shared with the guard, so the
two cannot disagree) and `implementedPhases` gains `19-LS.2`. The health view grew from four checks to
seven, each reading the running system: `lead-score-fields` (registered and none editable),
`lead-core-fields` (the twelve ordinary fields still editable), `schema-indexes` (all 15 names read back
from `pg_indexes`), plus the existing lifecycle, registration, guard and foundation checks. `ok` is
computed from them, so an installation missing the seed or the migration reports which.

---

## 2. Acceptance criteria with the check that was actually run

`24 passed (24)` in `apps/api/test/lead-score-schema.test.ts`, plus
`15 passed (15)` in the 19-LS.1 suite re-run against the changed metadata — both against the configured
primary database through the real HTTP API and the real entity layer. No test database, no reset, no
truncate: `afterAll` restores the `leadScore` settings row byte-for-byte and removes this run's records
by exact id.

| Criterion | Evidence |
| --- | --- |
| **Reviewed, additive migrations only** | `073` recorded once; `information_schema.tables` shows no `lead_score`/`lead_conversion` table; `entity_records` has no new column, and the only structure added is `attrs`-expression indexes |
| **Metadata for score fields, relationships and layouts** | the seven entity/field/layout assertions above: model version and scale, rule condition/effect/dimension/missing-data/lookback, evaluation status/trigger/result state/reason codes, operation key + created-vs-linked ids, Lead's 16 owned attributes, the three detail panels, and the absence of `list`/`edit` layouts by design |
| **Indexes and constraints for active model/current score, history lookup, idempotency keys and operation status** | all 15 index names present in `pg_indexes`, every definition partial on `entity_type` + `deleted_at`; the score index carries `::numeric`; three uniques present, and *enforced* — a replayed `operationKey` rejects at the storage layer while a second key on the same Lead succeeds and the count stays 2; a duplicate `reasonCode` inside one model version returns `409 DUPLICATE_RECORD` while the same code on another version is accepted; two rows claiming one `(name, modelVersion)` return 409 |
| **Migrations preserve existing records and history** | no row of any entity type carries a Lead Score attribute (`attrs ?& ARRAY[…)` finds none), so nothing was backfilled or fabricated — `not_scored` is the *absence* of the attributes, not a zero (plan §1.2, §15.1); pre-existing Leads are still undeleted and still carry their `status`; the Lead status enum is unchanged |
| **Validates against current project conventions** | the metadata passes the same Zod `EntityDefinitionSchema` the loader validates; `Model.rules` resolves through the standard `mappedBy` convention; `client.web: false` + closed ACL is the `CustomerSuccessHealthSnapshot`/`CsatSurvey` shape; guards are `beforeValidate` hooks in `HookRegistry`; the health view reads `information_schema`/`pg_indexes`/registry like `ESignature`'s |
| **Server-owned really means server-owned** | client writes of `scoreValue`/`scoreBand`/`convertedContactId`/`convertedAt` → 422 naming the field, on PATCH **and** POST, by an administrator, and while the module is switched off; the refused writes left the row unchanged; user writes of an evaluation or an operation row → 422 for create, edit **and** delete; the same writes through `runAsLeadScoreInternal` + `RequestScope.runAs` succeed and read back through the generic API |
| **Still inert** | with the module switched on, `readScore` answers `LEADSCORE_PHASE_PENDING / 19-LS.4` and `conversionExecute` answers `19-LS.13`; `ready: false`. Registering a schema did not switch on a behavior |
| **No duplicate entity or service** | `Lead`, `Contact`, `Account`, `Opportunity` are untouched apart from added attributes; the four new entities are all `LeadScore`-prefixed records of their own kind; the generic entity API serves them (`GET /api/v1/LeadScoreModel`, `…/rules` through the declared relation) |

Regression run after the metadata change: `entity-crud`, `entity-row-actions`,
`entity-manager-metadata`, `navigation`, `i18n`, `sales-entity-layouts` (64 tests) and
`acl-matrix`, `dynamic-logic`, `marketing-automation-audience-domain`,
`marketing-automation-events`, `marketing-automation-journey` (80 tests) — all green, plus the full
`apps/api/test` suite executed afterwards with the results recorded in §5.

---

## 3. Three schema facts the tests caught, and why they are now pinned

These were not known at audit time; each is encoded as an assertion so it cannot be relearned the
expensive way.

1. **`version` is not available as a metadata field name.** It is a physical column of
   `entity_records` and the optimistic-concurrency value `EntityCrudService.update` consumes
   (`entity-record.store.ts:116-136`, `entity.service.ts:229-231`). A model field called `version` would
   have been silently swallowed — the first draft of this phase proved it by writing `modelVersion: 3`
   and reading back `version: 1`. The attribute is `modelVersion`, matching `LeadScoreRule.modelVersion`
   and `Lead.scoreModelVersion`, and the test asserts no Lead Score entity declares a `version` field.
2. **`name` lives in the column, not in `attrs`.** So the model identity index keys on the `name`
   *column* plus `attrs->>'modelVersion'`; an expression index on `attrs ->> 'name'` would index NULL for
   every row and let duplicates through — which is exactly what the first run did before the test caught
   it. It is the one index in this file that mixes a column and an attribute, and it has to.
3. **A layout must place every `inDetail` field, or the field silently moves to an "Other" card.** The
   `Lead` detail layout now lists all thirteen original fields plus the two new panels, and the suite
   asserts both directions: every field a panel names is declared, and every `inDetail` field is placed.
   The first draft missed `name` — which `standardFields` marks `inDetail` — and the check caught it.
4. **`indexes` in metadata are documentation.** Nothing in `database/migrate.ts`, `database/seed.ts` or
   `packages/entity-engine` turns them into DDL; the real index is the migration. They are still declared
   on all four entities and on `Lead`, because the admin UI reads them, with a comment naming the file
   that actually creates them.

---

## 4. Deviations from the plan's data model, with reasons

| Plan | Built | Reason |
| --- | --- | --- |
| §5.3 "one current projection per Lead **and model**" | the projection is a set of attributes on the Lead row, for the active model only | plan §5.3 explicitly allows the simpler single-active-model policy; the Lead row is one row, so "one per Lead and model" holds structurally. Multi-model is deferred (compatibility §7 U7) and would need a projection entity plus its own unique index — not a reinterpretation of these attributes |
| §5.1/§5.2 structured configuration (`qualificationBands`, `dimensionWeights`, `condition`, `settingsJson`) | `text` columns holding JSON, validated by the 19-LS.3 validator | the platform has no object field type, and `CustomerSuccessHealthSnapshot.components` uses the same shape. The rules are data for the evaluator: nothing here is executable and nothing reaches SQL |
| §3.1 `positiveReasonCodes`/`negativeReasonCodes` as code lists | `text` JSON arrays on the evaluation; `Lead.scoreReasonCodes` likewise | reason codes come from the model's rules, so they are not a closed enum; the vocabulary that *is* closed (bands, statuses, triggers, dimensions, effects) is an enumerated metadata field, because those appear in filters and exports |
| §5.2 rule `decayPolicy`, `eventType`, `lookbackWindow` | `decayPolicy` enum + `decayHalfLifeDays`, `eventType` varchar, `lookbackDays` int | same meaning, spelled the way every other numeric/enum field in this repository is spelled; no new field type invented |
| §5.4 "immutable evaluation record" | an `entity_records` row with the module-written ACL and a guard that refuses record-API edit/delete | reuse over rebuild (plan §5's own instruction); the immutability is enforced by the guard plus `read: 'no'`, and the evaluation's `signature` field is where a rebuild proves it changed nothing |
| §5.1 model `settingsJson` "only for validated versioned configuration" | kept, `text`, admin-editable, validated in LS.3 | plan allows it; the validator is the safety, not the field type |

---

## 5. Verification record

| Check | Result |
| --- | --- |
| `apps/api/test/lead-score-schema.test.ts` | **24 passed** |
| `apps/api/test/lead-score-module.test.ts` (19-LS.1, re-run after the metadata change) | **15 passed** |
| Adjacent suites listed in §2 | **144 passed** across 11 files |
| `npx tsc --noEmit -p tsconfig.json` (API) | exit 0 |
| `npm run typecheck` (API + web) | exit 0 |
| `npx eslint apps/api/src/lead-score apps/api/test/lead-score-*.test.ts database/seed-metadata.ts --max-warnings=0` | exit 0 |
| Migration | applied to the configured database through `npx tsx database/migrate.ts`; recorded once in `schema_migrations`; verified by reading `pg_indexes` back |
| Full `apps/api/test` suite | **155 files, 2,159 passed / 34 failed across 7 files — both LeadScore suites fully green (15/15 and 24/24)**. The 34 are shared-database state, not this phase: `ai-agent-runs` (19), `crm-chat-docs-help` (7), `crm-chat-ai-agents-integration` (2), `crm-chat-security` (1) all refuse with `The instance allows 2 concurrent agent runs`, the `aiAgents` concurrency ceiling recorded in project memory; `service-desk` (2), `service-desk-workflow` (2) and `service-desk-sla` (1) are Service Desk residue — a `serviceDesk` settings row already present (`version: 2850`) against a test that wants none, 447 leftover `RoutingRule` rows, and the known business-hours SLA assertion. `service-desk.test.ts` and `service-desk-workflow.test.ts` were re-run with no LeadScore file in the command and failed identically; no failing assertion names a Lead, a Lead Score field or this module |
| Database policy | no new database/schema/container, no truncate/drop/reset, no broad delete; test records `AGENT_TEST_LS2_` removed by exact id; settings row restored |

## 6. Known limitations

* **Nothing computes or converts yet.** The projection attributes are never written by this build except
  through the module marker in tests; `leadScore.updated` and the evaluation-writing engine arrive in
  19-LS.4/19-LS.5, the conversion command in 19-LS.13.
* **No model or rule is publishable**: the lifecycle, the rule validator and the field-path checks are
  19-LS.3. Until then an administrator can create a draft row through the generic API and nothing will
  evaluate it — which is why every operation still refuses.
* **`blockedFieldPaths` and `allowedFieldPaths` are stored, not yet enforced.** Enforcement is the
  validator's job in 19-LS.3, and the sensitive-attribute policy is where it will be applied; declaring
  the fields now is what makes that a check rather than a redesign later.
* **Role grants are not seeded.** The four entities default to `read: 'no'` for non-administrators, and
  the administration role screen lists metadata entities, so granting `modelRead`/`modelManage` to a
  marketing-operations role is a 19-LS.3/19-LS.8 task.
* **A Lead list sorted by score will not use `idx_entity_records_lead_score_value`** — the generic store
  binds the attribute *name* as a parameter, and PostgreSQL cannot match that to a
  constant-expression index. Stated in the migration header; the fix, if the 19-LS.18 query check shows
  it matters, is a narrow read model or a generated column, not another index.
* **`scorePreviousValue` and `scoreCoverage` are unused until 19-LS.4/19-LS.7** put a trend on the panel.
  They are declared now because adding an attribute later is a metadata change that re-seeds every
  installation; they are recorded, not fabricated.

## 7. What 19-LS.3 must not forget

Done in 19-LS.2's follow-up: the lifecycle commands publish/archive/fork under
`runAsLeadScoreInternal`, `SERVER_OWNED_MODEL_FIELDS` is enforced (corrected to `status` + the four
stamps — `version` turned out to be the store's own concurrency column, see
[`lead-score-ls3-completion-report.md`](lead-score-ls3-completion-report.md) §1.4), a rule `condition` is
accepted only as the declarative tree over `Lead` paths inside the model's grant, a duplicated
`reasonCode` inside one model version is caught by the validator (`LS_RULE_REASON_CODE_DUPLICATE`) before
the database is asked, so the unique index stays the backstop rather than the user-facing answer; and
19-LS.3 added no index to `073`.

* Publish/archive/validate belong to a **model service**, reached through `runAsLeadScoreInternal`, and
  must refuse a client write of `modelVersion`, `publishedById`, `publishedAt`, `archivedById`,
  `archivedAt` — the list is already `SERVER_OWNED_MODEL_FIELDS`; the guard does not check it yet.
* A rule `condition` is accepted only as the declarative tree (`{field, operator, value}` with
  `all`/`any`/`not`) over `Lead` paths present in the model's `allowedFieldPaths`; the formula-string
  alternative and any executable value are refused (plan §6.2, audit §5.2). No operator unsupported for
  the field's declared type either.
* `LeadScoreRule.reasonCode` uniqueness is now a database fact — surface the `409` as a clear validation
  message rather than an internal error.
* Bands are an enum (`SCORE_BANDS`). A model's `qualificationBands` JSON must validate against those
  values and against non-overlapping thresholds, and `Disqualified` must stay reachable only by an
  explicit rule (or the `Dead` Lead status), never by a low number.
* The health view's `schema-indexes` list and `pg_indexes` are the reference for any index a later phase
  wants: add it to a new `074_…`, never by editing `073_phase19_lead_score.sql`.
