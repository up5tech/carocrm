# Phase 19-LS.3 — Model and rule configuration

> `PLAN_Phase_19_LeadScore.md` §16 `Phase 19-LS.3`, on the contract in
> [`lead-score-audit.md`](lead-score-audit.md) §5 and the foundations in
> [`lead-score-ls2-completion-report.md`](lead-score-ls2-completion-report.md).
> Acceptance: **invalid models cannot be published and published versions are immutable.**
> Followed by: `lead-score-ls4-completion-report.md` (19-LS.4, the deterministic scoring engine).

Delivered **2026-10-24**.

---

## 1. What landed

### 1.1 The condition DSL — [`lead-score-condition.ts`](../../apps/api/src/lead-score/lead-score-condition.ts)

A rule condition is a tree of `{field, operator, value}` leaves joined by `all` / `any` / `not`, and
nothing else.

| | |
| --- | --- |
| Operators | the platform's own `CRITERIA_OPERATORS` (`packages/formula/src/dynamic-logic/index.ts:9-45`) — the same vocabulary the Entity Manager UI offers, so a rule and the rest of the CRM speak one language |
| Rejected by shape | a formula string, a bare literal, an array, an empty object, unknown keys, a group mixed with a leaf. The platform's `LogicCondition` union *allows* a formula string (`:59`); scoring refuses it, because a rule that can call the formula engine is a rule that can write fields (`logic/record-logic.service.ts:37-60`) — plan §5.2, §6.2 |
| Field paths | a plain `lowerCamel` name only. Dotted paths, table names and anything that is not an identifier are refused before metadata is consulted, so a configuration value can never become a query fragment (AGENTS.md §5.2) |
| Field policy | must be a declared field of the scored entity; must be inside the model's `allowedFieldPaths` when one is set; must not be on `blockedFieldPaths`; must not be `password`/`file`/`image`/`attachmentMultiple`/`formula`/`generated`; must not be a **protected characteristic or a proxy** (`PROTECTED_FIELD_NAMES`); must not be a **scoring output** (`scoreValue`, `scoreBand`, …) — reading the score back into a rule is the loop plan §10.4 names |
| Type matrix | `OPERATORS_BY_TYPE` decides per field type. `contains` on an int, `gt` on a bool and `equals` on a multi-value field are refused rather than guessed at, because 19-LS.4 must evaluate what 19-LS.3 accepted, and inventing a meaning later would rewrite what a stored score meant. `multiEnum` and every link type are limited to existence checks until their comparison semantics are defined |
| Values | scalar or bounded list; type-checked against the field; `enum` values must exist in the field's option list; dates must be ISO in the field's own shape; strings are capped by the field's `maxLength` **and** by `MAX_CONDITION_VALUE_CHARS`, because a value that can never match is a bug that reads as a rule |
| Bounds | `MAX_CONDITION_DEPTH` 2 group levels, `MAX_CONDITION_PREDICATES` 20 leaves, `MAX_CONDITION_NODES` 60, `MAX_CONDITION_LIST_VALUES` 25 (plan §9.4) |

Every refusal is an **issue with a stable code**, not an exception, so one `validate` call lists a whole
draft's problems and the editor can put each one on the right rule row.

### 1.2 The model and rule validator — [`lead-score-validator.ts`](../../apps/api/src/lead-score/lead-score-validator.ts)

Pure: no database, no clock, no I/O. `validateModel(model, rules, fields)` answers
`{valid, errors[], warnings[]}`, and `VALIDATION_CODES` names all 42 codes so the UI, the tests and the
docs switch on codes rather than sentences.

| Area | Refused (error) | Noted (warning) |
| --- | --- | --- |
| Scale | `scaleMin >= scaleMax`, a span over 1000, `scoreFloor > scoreCeiling`, a clamp band outside the scale, floor = ceiling (every Lead would score the same number), `baseScore` outside the clamp band, a non-positive `modelVersion` | — |
| Bands | empty, unparsable JSON, a band outside the scale, an **overlap**, a shape error, an unknown band name, `Unknown` (reserved for never-scored) and **`Disqualified` claimed by a numeric threshold** (plan §3.3 — a low score is not a disqualification) | a gap between bands: legal, but a score in the gap lands nowhere |
| Weights | unparsable JSON, an unknown dimension, a non-numeric or out-of-range weight | a weighted dimension with no rule, a dimension with rules and weight 0 |
| Field paths | a granted or blocked path that is not a declared field; a path in **both** lists | — |
| Model settings | any non-empty `settingsJson` (nothing reads a model setting yet, and configuration that lies about being live is worse than none — the same rule the LS.1 settings document follows) | — |
| Rule identity | a `reasonCode` outside `lower_snake`, or one **shared by two rules of the same version** (the database constraint behind it is `uq_entity_records_lead_score_rule_reason`) | — |
| Rule effect | an unknown dimension/effect/policy/source; `points` outside ±`MAX_RULE_POINTS` (50) so one rule cannot decide the scale; `setBand` without a target band, or with points; `add`/`subtract` with a target band, or with 0 points; a `negative` dimension adding points and a `fit`/`intent`/`engagement` dimension subtracting them (plan §6.3 bounded negatives); priority outside 0–1000 | — |
| Rule signal | an unknown `signalSource`; a `lookbackDays`/`eventType`/`decay` on a `lead` signal (it reads the record as stored); a half-life decay with no half-life; a rule whose `modelId`/`modelVersion` names a different row than the model being published; **any non-`lead` source on an enabled rule** — the audit found engagement lives in another module's *tables* and there is no Lead→Activity relation at all (gap G2), so 19-LS.9 owns it and plan §0.1-4 forbids assuming it exists | no enabled rule at all; disabled rules that will not be evaluated |

### 1.3 The lifecycle — [`lead-score-model.service.ts`](../../apps/api/src/lead-score/lead-score-model.service.ts)

Four commands, each entering through `LeadScoreFeatureGate` (capability → module switch → feature
effective), so nothing here can run while the module is off:

| Command | Gate capability | What it does |
| --- | --- | --- |
| `validate` | `modelManage` | reads the model and its rules and returns the report. Writes nothing |
| `publish` | `modelPublish` | draft only → **re-validates** → refuses with the issue list, or stamps `status: published`, `publishedById`, `publishedAt` |
| `archive` | `modelPublish` | any non-archived version → `status: archived`, `archivedById`, `archivedAt`; the quick off switch that destroys no history (plan §9.3) |
| `new-version` | `modelManage` | published/archived only → a **new draft row** at `max(modelVersion)+1` with **all its rules copied**, in one transaction. Refused while a draft of that name is already open |

Draft rows themselves stay ordinary metadata records edited through `/api/v1/LeadScoreModel` and
`/api/v1/LeadScoreRule`: this module adds no second CRUD layer (AGENTS.md §5.2), and the Entity Engine
keeps validation, field ACL, audit, hooks, optimistic concurrency and search. Publishing therefore
writes through `EntityCrudService.update` under `runAsLeadScoreInternal`, and `expectedVersion` is passed
straight through to the engine's `ConcurrencyConflictError`.

Routes (all `POST`, all capability-checked server-side, all in the generated OpenAPI document):
`action/model/validate`, `action/model/publish`, `action/model/archive`, `action/model/new-version`.

### 1.4 Immutability, where it actually bites

[`lead-score-write-guard.service.ts`](../../apps/api/src/lead-score/lead-score-write-guard.service.ts)
grew two more pairs of hooks — `leadScore.LeadScoreModelGuard` / `…ModelDeleteGuard` and
`leadScore.LeadScoreRuleGuard` / `…RuleDeleteGuard`:

* a client may not create a model as anything but `draft`, may not change `status`, and may not write the
  four publication stamps at all — even on a draft, because publishing is the command that validates;
* a model whose stored state is `published` or `archived` accepts **no** client create/update/delete, and
  neither does any rule attached to it (the rule's parent is read from the store, not trusted from the
  payload, so a client cannot escape the freeze by re-pointing `modelId`); deleting a published model is in
  fact refused twice — by the kernel's `record.removable: false` rule first, and by this guard behind it;
* a **delete needs its own hook**: `beforeValidate` is a write phase and `EntityManager.delete` runs only
  `beforeDelete` (`packages/entity-engine/src/entity-manager/index.ts:206-217`). The first version of this
  guard let a frozen model's rules be deleted, and the test caught it.

`SERVER_OWNED_MODEL_FIELDS` was corrected in the same pass: LS.2 declared it with `version`, which turned
out to be the store's concurrency column, and it now names `status` and the four stamps. `modelVersion` is
deliberately absent — a draft must declare the version it intends to become, and once published the whole
row is frozen, which covers it.

### 1.5 Vocabulary, gates and health

* `isScoreBand(value)` joins the vocabulary module; `lead-score-vocabulary.ts` stays the single source
  for bands, statuses, dimensions, effects, policies, triggers and signal sources.
* `LEADSCORE_FEATURES.modelAdministration.pendingPhase` is now `null` — the honest "this build has it"
  flag the settings service, the gate and the health view all read. `previewModel` was re-pointed at the
  `scoring` feature: a preview is an evaluation run, and the evaluator is 19-LS.4.
* The gate gained the `createModelVersion` operation, so all 12 operations answer from one table.
* Health's `write-guard` check now expects all five hook names, and `implementedPhases` gained
  `19-LS.3`.

---

## 2. Acceptance criteria, each with the check that was actually run

`22 passed (22)` in `apps/api/test/lead-score-model.test.ts`, `29 passed (29)` in
`apps/api/test/lead-score-validator.test.ts`, and the LS.1/LS.2 suites re-run against the changed module:
`15 passed (15)` and `24 passed (24)` — **90 LeadScore tests green**.

| Criterion | Evidence |
| --- | --- |
| **An invalid model cannot be published** | publish of a model whose rule is worth 500 points → 422 `VALIDATION_FAILED` with `details.issues` naming `LS_RULE_POINTS_OUT_OF_BOUNDS`, and the row is **still a draft** with `publishedAt: null`; a rule attached to version 4 under a model at version 5 → 422 `LS_RULE_MODEL_VERSION_MISMATCH`; a bad `dimensionWeights` JSON, empty bands, a ceiling outside the scale and a nonexistent field path all reported together (≥ 4 errors, one call) |
| **…and the check cannot be skipped** | the `validate` route is advisory and the publish route re-runs the same validator, so a client that never called `validate` is refused the same way; a rule edited *after* a good validation is caught at publish |
| **A published version is immutable** | PATCH description, PATCH `status`, PATCH `modelVersion`, PATCH a rule, DELETE a rule, and POST a rule under the frozen version → **409 `LEADSCORE_MODEL_IMMUTABLE`** on every one of them, and the model's rule list is byte-identical afterwards (one rule, still 10 points) |
| **…including a client that claims publication** | writes of `status: published`, `publishedAt`, `publishedById` on a draft → 422 naming the fields; creating a model with `status: published` → 422 `details.fields = ["status"]`. A record-API caller cannot mint a version |
| **Rollback without mutation** | `new-version` copies the published model and all three of its rules into a fresh draft at version+1, every copy validates with zero errors, and the frozen version is unchanged in state, version, bands and rule ids — so an earlier configuration can be published forward as a new version (plan §6.1) instead of rewriting history |
| **One draft per model** | a second `new-version` → 409 `LEADSCORE_DRAFT_EXISTS` whose details name the draft to edit; `new-version` of a draft → 409 `LEADSCORE_INVALID_STATE` |
| **Concurrency** | publish with the revision the editor read succeeds; the same revision replayed → 409, and a frozen version cannot be re-published (`LEADSCORE_INVALID_STATE`, state `published`); archiving twice likewise |
| **Authorization (plan §9.1)** | a role with `LeadScore:read` only → 403 on `validate`, and the denial names the capability it lacks (`modelManage`); a role with model/rule read+edit but no publish right → `validate` 200, `publish` 403 naming `modelPublish`; a caller with no rights at all gets the same 403 without learning whether the id exists |
| **Module disablement is total** | with `enabled: false`, all four commands answer 403 `LEADSCORE_MODULE_DISABLED`; with it on, `validate`/`publish`/`new-version` are admitted while `readScore`, `previewModel` (19-LS.4) and `conversionExecute` (19-LS.13) still refuse with their phase |
| **Nothing scores yet, provably** | publishing a valid model stores **no** `LeadScoreEvaluation`, and the Lead created alongside it keeps `scoreValue`/`scoreModelId`/`scoreCalculatedAt` absent with `scoreBand: Unknown` and `scoreStatus: not_scored` (plan §15.1: publication must not silently recalculate history) |
| **Auditable publication** | `audit_log` for the model row shows exactly `draft → published → archived`, one row per change, with the actor, because these were ordinary record writes on an `audited` field; `publishedById`/`archivedById` equal the record's author |
| **Guard registered** | all five hook names present in `HookRegistry`, and health's `write-guard` and `schema-indexes` checks pass with `ok: true` for the whole health view |
| **Documented** | the four lifecycle routes appear as `post` operations in `GET /api/v1/OpenApi` |

Regression: the full `apps/api/test` run — **157 files, 2,210 passed / 34 failed**, and **no
LeadScore file among the failures**: the same seven files and the same 34 tests as the 19-LS.2 baseline
(documented shared-database state — the `aiAgents` two-concurrent-runs ceiling in `ai-agent-runs`,
`crm-chat-docs-help`, `crm-chat-ai-agents-integration`, `crm-chat-security`, and Service Desk residue in
`service-desk`, `service-desk-workflow`, `service-desk-sla`). `npm run typecheck` (API + web) exit 0;
`npx eslint apps/api/src/lead-score apps/api/test/lead-score-*.test.ts --max-warnings=0` exit 0.

Database policy: no migration in this phase, no DDL, no new database, no truncate/reset. The lifecycle
suite writes only `AGENT_TEST_LS3_`-marked rows, removes them by exact id plus its own name predicate,
restores the `leadScore` settings row from the raw column, and deletes the role and users it created;
`afterAll` warns if any of its rows survive.

---

## 3. Decisions taken in this phase

1. **The scoring output fields are not inputs.** A rule may not read `scoreValue`/`scoreBand`/…, so a
   score cannot feed itself (plan §10.4). This is enforced in the validator, not left to convention.
2. **`Disqualified` cannot be a threshold band.** It is reachable from a `setBand` rule (whose condition
   may read the core `status` field, `Dead` included) — plan §3.3 says explicitly that a low score must
   not imply disqualification, and a numeric range labelled that way would say exactly that.
3. **Warnings do not block a publish; errors do.** A model with no enabled rule, a band gap, or a weighted
   dimension with no rules is a legal but questionable configuration: refusing it would hide the real
   problem behind a "why can't I publish" support question, so the answer says it out loud instead.
4. **A `lead`-sourced rule may not carry a time window or decay.** Decay and lookback describe event
   streams; on a record read they would be silently ignored, and silently ignored configuration is the
   defect this module keeps refusing to store.
5. **Non-`lead` signal sources are refused, with the phase named.** `marketingEvents` and `emailLinks`
   exist as enum values because the audit established their tables, but plan §0.1-4 forbids assuming the
   read path; 19-LS.9 unblocks them when it exists.
6. **A model version is identified by `(name, modelVersion)`** — which is why a draft declares its own
   `modelVersion` and why the `modelVersion` field is *not* in `SERVER_OWNED_MODEL_FIELDS`.
7. **Publishing does not recalculate.** No event is dispatched and no job is enqueued here: the recalculation
   command is 19-LS.6's, and `leadScore.modelPublished` is not announced before something consumes it.
8. **`activeModelId` stays out of the settings row.** No code reads it yet (the evaluator will, in
   19-LS.4), so storing it now would be a knob that lies.
9. **`settingsJson` is refused unless empty**, same reasoning as §8 and the LS.1 settings rule.
10. **Two rights, deliberately.** Publishing needs `modelPublish` *and* the entity's own `edit` ACL, because
    the write goes through the generic path. A "publisher" role that is not also an editor is refused —
    narrower publication is the point of separating them (plan §9.1).

---

## 4. Known limitations

* **No evaluation, no preview, no scores.** `validate`, `publish`, `archive` and `new-version` are the whole
  surface; the deterministic engine that turns a published version into a number is 19-LS.4, and the
  model preview (`previewModel`) is refused with that phase named.
* **A published version is not yet consumed by anything.** There is no active-model pointer, no
  recalculation trigger and no `leadScore.modelPublished` event until 19-LS.4–19-LS.6; publishing today is
  a configuration act with a visible audit trail and no runtime effect.
* **The archive path does not clear a Lead's stored projection**, because no projection is ever written
  yet. 19-LS.6 decides what a rebuild does to Leads whose model has been archived.
* **Reason codes are validated as identifiers, not as catalog keys.** The i18n entries per code are written
  by the phase that renders them (19-LS.5/19-LS.7); until then a breakdown shows the code.
* **`dimensionWeights` shape is stored but uninterpreted**; how a weight normalises a score is 19-LS.4's
  documented formula (plan §6.3), and the validator deliberately only checks the shape.
* **A field path is validated against the model's grant, not against the reading user's field ACL.**
  Plan §9.2 asks that a score must not read a field the executing principal may not see; that is a
  property of the read and explanation paths (19-LS.5), which apply `visibleFields`/`stripRestricted`
  before a breakdown reaches a caller. Validation here answers a different question: what the *model* is
  allowed to consult.
* **Rule ordering ties are possible.** Two rules may share a `priority`; 19-LS.4 breaks ties deterministically
  (by `reasonCode`) so a stored score stays re-derivable, and the validator warns nowhere because a tie is
  not invalid.
* **`enabled` rules are not capped** beyond `MAX_RULES_PER_MODEL` (200) in the read path; a model with more
  rules is truncated rather than silently mis-scored, and 19-LS.8's editor must page them.

## 5. What 19-LS.4 must not forget

* Evaluate **only** what `validateScoreCondition` accepted: the operator set per field type is the contract,
  and a semantic the matrix refused must not be introduced by the evaluator.
* `multiEnum` and link fields are existence-only today; widen the matrix and the evaluator in the same commit.
* Break `priority` ties by `reasonCode`; clamp with the model's `scoreFloor`/`scoreCeiling` and round
  deterministically, then derive the band from `qualificationBands` — a gap keeps the previous band, matching
  the warning this phase emits.
* A `setBand` rule with `targetBand: Disqualified` is the only disqualification path besides the core `Dead`
  status; keep `Unknown` unreachable by rules.
* `previewModel` maps to the `scoring` feature and stays refused until the evaluator is effective — the gate
  already derives that, so flip nothing by hand.
* Writes of the Lead projection go through `runAsLeadScoreInternal`, or the LS.2 guard will (correctly) refuse
  them.
