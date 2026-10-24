# Phase 19-LS.8 — Scoring Model Administration UI: completion report

Delivered 2026-10-25. Scope: `PLAN_Phase_19_LeadScore.md` §6.1, §6.3, §9.4, §12, §16 `19-LS.8`; contract in
`docs/implementation/lead-score-audit.md` §5.2, §11; compatibility rows in `docs/compatibility/lead-score.md`
§3, §7 and §9.

**Acceptance, as the plan writes it:** *"admin can manage a deterministic model without editing raw JSON
manually or running code."* LS.2–LS.6 made a model a versioned, validated, publishable, scoreable thing, and
LS.7 showed a rep the result. Until this phase the only way to configure one was a `curl` of the record API
with a hand-written condition tree in a text attribute. That is what this phase removes.

---

## 1. What landed

| File | Responsibility |
| --- | --- |
| `apps/api/src/lead-score/lead-score-editor.ts` (new) | `GET action/editor` — the form's legality, answered by the module: every field of the scored entity with the operators **its type can answer** (`OPERATORS_BY_TYPE`), the value control (`valueKind`), the option list and length bound from metadata, the condition's budgets (depth, predicates, nodes, list size, value length), the module's vocabularies, the command limits, and — for a named model — which fields its own grant covers. A refused field is returned *with the validator's own reason code* rather than omitted. |
| `apps/api/src/lead-score/lead-score.controller.ts`, `dto/lead-score-shapes.ts`, `index.ts` | The route (behind `modelRead`, the same right the model list needs), its strict query schema, and the barrel exports (`LeadScoreEditorService`, `EditorCatalog`, `EditorField`, the permission-entity names, `MAX_RULES_PER_MODEL`/`MAX_VERSIONS_PER_MODEL`). |
| `apps/web/src/pages/LeadScorePage.tsx` (new) | The workspace: module state, the active model in the health view's own vocabulary, and four capability-gated tabs. `/lead-score` is a static route declared before the entity wildcard. |
| `apps/web/src/pages/lead-score/ConditionBuilder.tsx` (new) | The rule condition as a form: `Match all / any / none`, comparison rows of field + operator + the control that value needs, one level of nesting (the parser's ceiling), live predicate and depth counters against the server's budgets, and a **read-only** view of the JSON the builder produced. |
| `apps/web/src/pages/lead-score/RuleEditorModal.tsx` (new) | One rule: name, reason code, dimension, effect, points, order, enabled, the condition, the missing-data policy and the signal window — every list from the catalog, with an engagement signal labelled as the phase that owes it. |
| `apps/web/src/pages/lead-score/ModelEditorModal.tsx` (new) | One model version: scale, base, floor, ceiling, validity window, plus real controls for the three JSON attributes — band rows, one weight per declared dimension, and the allowed/blocked field pickers. |
| `apps/web/src/pages/lead-score/ModelsTab.tsx` (new) | The version list and the lifecycle: create/edit a draft, the rule table with a sentence per condition, validate, publish (confirming with the server's own report), archive, new version, compare versions, and the frozen-version notice with the way forward. |
| `apps/web/src/pages/lead-score/VersionDiffModal.tsx` (new) | Two versions of one name side by side on the platform's `carocrm-diff` grid, with the rule set classified added / removed / changed by reason code. |
| `apps/web/src/pages/lead-score/PreviewTab.tsx` (new) | The bounded preview: a model, an automatic sample or a hand-picked one, the band distribution, per-Lead score/band/coverage/reason counts/signature, and `writes: false` stated on the screen. |
| `apps/web/src/pages/lead-score/OperationsTab.tsx` (new) | The rebuild: `limit`/`chunkSize` inside the server's ceilings, an optional Lead filter built from the Lead's own metadata filter fields, the queued run, and the module's two job names with progress, cancel and a link to `/admin/jobs`. |
| `apps/web/src/pages/lead-score/SettingsTab.tsx` (new) | The control plane: the module switch, every feature with its requirements, its own switch and its pending phase, the active model picker over published versions, the recalculation delay, and the settings warnings. |
| `apps/web/src/pages/lead-score/shared.tsx` (new) | The naming and reading layer both the tabs and the builder share: the catalog hook, a label per stable code, an actionable error sentence, the validation report panel and a condition → sentence reader. |
| `apps/web/src/api/{client,types}.ts` | `leadScoreHealth`, `…Capabilities`, `…Settings`, `…Editor`, `…ValidateModel`, `…PublishModel`, `…ArchiveModel`, `…NewVersion`, `…Preview`, `…RecalculateBatch` and the mirrored view types. |
| `apps/api/src/admin-panel/navigation-defaults.ts`, `apps/api/src/app.module.ts` | The `leadScore` sidebar entry (ACL on `LeadScoreModel:read`, feature gate on the module's own `enabled` switch) and the gate branch that reads the settings row lazily. |
| `i18n/{en,vi}/leadscore.json` | `admin.*` (page, tabs, models, model, rules, rule, builder, publish, diff, preview, operations, settings), `operator.*` for all sixteen operators, `feature.*`, plus the refusal, effect, policy, source, status and decay vocabularies. |
| `apps/web/src/styles/carocrm.css` | The condition group/leaf rhythm, the band row, the selected model row, the preview statistic tile. |
| `apps/api/test/lead-score-editor.test.ts` (new, 14), `e2e/lead-score-admin.spec.ts` (new, 4) | The evidence. |

## 2. The findings that changed the design

1. **The form's legality had to be the validator's own set, or the phase would be a way to produce publish
   errors.** The first draft of the builder kept its own type→operator table. That is two sources of truth in a
   module whose whole promise is reproducibility, so `LeadScoreEditorService` was built instead on
   `OPERATORS_BY_TYPE`, the three field denylists and the parser's budgets — the same imports the validator
   uses — and the SPA kept none of them. The limits are imported from the services that enforce them
   (`MAX_PREVIEW_SAMPLE`, `MAX_BATCH_CHUNK`, `MAX_BATCH_TOTAL`, `MAX_RULES_PER_MODEL`), so a bound can move in
   one place. A refused field is returned with its reason (`never_scorable_type`, `protected`,
   `scoring_output`, `unknown_type`) and shown as an unselectable option, because "why can't I score on this?"
   is a question the screen should answer rather than leave to a validation error later.
2. **A model's grant annotates the catalog; it never overrides the denylists.** A model that names
   `scoreValue` in `allowedFieldPaths` still gets `scorable: false` and `inModelAllowlist: false` for it: the
   allowlist is a narrowing of what is permitted, not a switch for what is forbidden (plan §0.1-6, §10.4).
   A malformed grant list is reported as *no grant* rather than as a failure — `action/model/validate` is where
   a broken list is named with its code, and this endpoint's job is to describe the vocabulary.
3. **Drafts stay on the record API; only transitions are commands.** Creating a model, editing a draft and
   adding rules go through `/api/v1/LeadScoreModel` and `/LeadScoreRule`, because that is the path the LS.2
   write guard watches — it is what makes a published version immutable without this screen having to believe
   anybody, and a second write path would be a second guard to forget. `status`, `publishedAt` and the archive
   fields are not in any form: publish, archive and new-version are the only way they move.
4. **Publish asks the server first, and shows that answer.** The button calls `action/model/validate`, and the
   confirmation carries the counts, because the decision being made is "freeze this as the version every future
   score names". The command re-validates anyway, so the pass exists to inform, not to grant permission.
5. **A virtualised option list made the tenth operator unreachable — found in the browser, not in a unit
   test.** `varchar` answers ten operators; rc-select renders a window of them, so the last one existed in the
   data and not in the DOM. The operator picker is searchable now, which is also what an administrator wants on
   a narrow screen. The same pass caught a *dead* Cancel button (the platform's cancellable job state is
   `pending`, and the tab only offered Cancel for `queued`) and a header that read "No active model" beside a
   healthy published model, because `state` in the health view is the **failure** vocabulary and is null when
   the model is usable.
6. **A preview's promise belongs on the screen.** `writes: false` is the server's field, and the tab states it;
   the browser spec asserts the fixture Leads have no stored score before the run and still have none after,
   which is the audit's LS.8 check ("preview proves zero writes to `scoreValue`") made into an assertion rather
   than a comment.
7. **A published model cannot be cleaned up through the API — by design.** The e2e spec's own teardown cannot
   delete a published version or its rules: the LS.3 guard refuses it, correctly. The residue is therefore
   removed at the database level by exact run marker (`E2E_LS7_*`, `E2E_LS8_*`: 44 Leads, 12 models, 8 rules,
   69 audit rows and one cancelled job row, all created by this session's runs, all removed, residue check
   clean). This is recorded rather than worked around, because "the module protects a frozen version" and "a
   test can undo its own publication" are in genuine tension and the first is the product requirement.
8. **The nine pre-existing LeadScore files now interfere with each other, and LS.8 is not the cause.** Run as
   one group they fail six assertions in LS.1/LS.2/LS.3 that depend on the shape of the single shared
   `leadScore` settings row; the same six fail with this phase's new file excluded, and the canonical full
   `npx vitest run` (a different file order) has zero `lead-score` failures. Reported as a shared-state hazard
   for whoever touches those suites next, not papered over by a per-file database.

## 3. Verification

| Check | Result |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-editor.test.ts` | **14 passed** — per-type operators from real metadata, refusals with their codes, scorable-first ordering, the budgets and limits imported not restated, the grant annotation that never overrides a denylist, a malformed grant reported as no grant, `modelRead` on both doors (403 for a role without it, 200 for a granted non-admin), no Lead value in the body (a canary record proves it), and the strict query shape |
| The nine pre-existing LeadScore API files, run in the two groups this phase used | **90 passed** (editor + model + validator + schema) and **142 passed** (calculation, evaluator, explanation, module, preview, recalculation) — zero failures; see §2.8 for the ad-hoc ten-file grouping |
| `npx vitest run` (full: `apps/api/test` + `packages/*/src`) | **2,867 passed / 34 failed (2,901 tests, 201 files)** — the 34 are the same seven pre-existing shared-state files as the LS.6/LS.7 baseline (2,853 + this phase's 14 = 2,867), and **zero `lead-score` failures** |
| `npx vitest run --config apps/worker/vitest.config.ts` | **205 passed / 0 failed** (unchanged by this phase) |
| `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` | **7 passed** — 4 new (draft→validate→publish with no typed JSON, preview with the zero-write assertion on both sides, new version + diff, 390px + keyboard) and LS.7's 3 unchanged |
| `npm run typecheck` (API project + web project) | clean |
| `npx eslint` on `apps/api/src/lead-score`, `app.module.ts`, `navigation-defaults.ts`, `apps/web/src/pages/lead-score`, `LeadScorePage.tsx`, `apps/web/src/api`, both specs | clean (`--max-warnings=0`). Root `npm run lint` stays red from the pre-existing skills rule set, as recorded in earlier phases |
| `pnpm --filter @carocrm/web build`, `pnpm --filter @carocrm/api build` | both succeed |
| Browser pass (dev API :3030 + web :8080, `admin`) | sidebar entry appears with the module on and is gone with it off; the model list, the draft form, the rule builder, the validation report, the publish confirmation, the frozen notice, new version, the version diff, the preview with distribution and per-Lead rows, the rebuild with a queued run and a working Cancel, and the settings screen with 16 features and their switches — in English and in Vietnamese, at 1440 and 390px with zero horizontal overflow and no console error beyond the platform's pre-existing `POST /Refresh` 422 on a fresh session |
| Residue and state | every `E2E_LS7_*`/`E2E_LS8_*` record, audit row and job row removed (residue query returns nothing); the `leadScore` settings row left `enabled: false`, `activeModelId: null`, `batchRecalculation: false`; the administrator's `locale` restored to `vi` |

## 4. What this phase does not claim

* **No engagement signals.** A rule may name `marketingEvents` or `emailLinks` and the form labels it
  `19-LS.9`, exactly as the validator refuses it at publish — the option is visible because the vocabulary is
  real, and unusable because the read path is not.
* **No threshold notifications, no decay sweep, no conversion.** `features.thresholdNotifications` stays a
  pending switch on the settings screen, and the Operations tab offers no decay run at all.
* **No bulk rule import, no rule cloning, no drag-to-reorder priorities.** A model with two hundred rules is
  served by the rule table's ordering and the per-row editor; anything beyond that is a design question the
  plan does not ask yet.
* **The scale is still not shown beside a score on the Lead card.** The model form now names the scale, which
  was the LS.7 "open since" note; the card's `30 / 100` treatment remains a cosmetic follow-up.
