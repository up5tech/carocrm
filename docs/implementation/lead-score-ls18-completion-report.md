# Phase 19-LS.18 — Reporting, security sweep and release: completion report

`PLAN_Phase_19_LeadScore.md` §16 `19-LS.18`, §17 (Definition of Done); audit §11 `LS.18`; compatibility
`docs/compatibility/lead-score.md` §2, §8; the runbook `docs/runbooks/lead-score-operations.md`.

**Exit criterion (plan §16):** *every requirement is mapped to an implementation and a verification result; no
unresolved critical security or data-integrity defect remains.* The mapping is §2 of this report — every item
of plan §17, with the code that satisfies it and the check that proves it. The reporting half of the phase is
§1; the sweep (ACL matrix, concurrency, query and migration review, accessibility) is §3.

## 1. What was published

### The operational report (`lead-score-report.service.ts`, `GET action/report`)

Four curated views, computed with the platform's own aggregate so the **reader's record scope** is part of
the statement — an `own` reader sees their own Leads and an administrator's are the instance's:

| View | Population | Numbers |
| --- | --- | --- |
| `scores` | every Lead the reader may see | total, scored, unscored, average / lowest / highest score, average coverage |
| `bands` | the same population | Leads per qualification band, with the average score in each band |
| `freshness` | the same population | Leads per `scoreStatus` (current, stale, pending, failed, not scored) |
| `conversions` | the Leads whose status is `Converted` | how many produced an Account, a Contact, an Opportunity, and how many were converted in the last 30 days |

The definitions are part of the contract, because a metric whose population is ambiguous is not a metric:
each section carries its label and its description, and the report says which window the one windowed slice
used. It counts **Leads**, not operation rows — the operation history is a module-internal audit trail
(`read: 'no'`), while the Lead's own status and `converted*` references are what a reader may see.

The report needs the module on and the `viewScore` right, but **not** the `scoring` switch: a deployment
that stopped scoring still has Leads to convert and a history to read.

### The dashboard surface

`dashlets.kind` gained `leadScore` (migration `076`, a strict superset of the previous CHECK), and a
dashlet of that kind carries **one view name** — not a free-form entity/measure pair, so a dashlet can
never become a second query surface the module has not bounded. The numbers are computed when the dashlet
runs, under the **reader's** scope, not the dashboard owner's: a shared dashboard never becomes a way to
count Leads the reader could not open. The SPA renders the view with the module's own labels (no raw keys),
and the kind has its own mark and label in the dashlet header.

## 2. The Definition of Done, mapped (plan §17)

### Scoring

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Module registered with the canonical name `LeadScore`; no `Ua` prefix | `lead-score-module.ts` (`LEADSCORE_MODULE`), `lead-score-domain.ts` | `lead-score-module.test.ts` (health view names the module and its records); `lead-score-schema.test.ts` |
| Rule-based model lifecycle; published versions are immutable | `lead-score-model.service.ts` (validate/publish/archive/fork), `lead-score-write-guard.service.ts` | `lead-score-model.test.ts`; the schema suite's client-write refusals |
| Rules are declarative, bounded, validated against metadata, non-executable | `lead-score-validator.service.ts`, `lead-score-condition.ts` (depth/node/predicate budgets, protected-field denylist) | `lead-score-validator.test.ts`, `lead-score-evaluator.test.ts` |
| Score, band, freshness, model version and reasons are available | `lead-score-calculation.service.ts` (projection), `lead-score-explanation.service.ts` (read) | `lead-score-calculation.test.ts`, `lead-score-explanation.test.ts`, `e2e/lead-score.spec.ts` |
| Score history is immutable and queryable with ACL | `LeadScoreEvaluation` (`read: 'no'`), `LeadScoreRecords.evaluationsOfLead` | `lead-score-calculation.test.ts` (a client edit is refused), `lead-score-explanation.test.ts` (a second door does not exist) |
| Event and manual recalculation are idempotent and bounded | `lead-score-recalculation.service.ts` (deterministic key, debounce, chunk/cap), `apps/worker/src/handlers/lead-score-handlers.ts` | `lead-score-recalculation.test.ts`, the worker suite |
| Lead list/detail views show the score without N+1 queries | the projection is a Lead column and filter; the card reads one projection | `e2e/lead-score.spec.ts` |
| Threshold actions cannot silently convert or disqualify | `lead-score-threshold.service.ts` writes only the notification and the audit row | `lead-score-engagement.test.ts` (no Lead field moved) |
| Sensitive/protected attributes are excluded from scoring inputs | `PROTECTED_FIELD_NAMES` in `lead-score-condition.ts`, the model's field allowlist | `lead-score-validator.test.ts`, `lead-score-calculation.test.ts` (a hidden field becomes *unknown*, never empty) |
| The optional AIAgents integration is separated and can be disabled | `lead-score-insight.service.ts` (own record, own switch, own capability) | `lead-score-insight.test.ts` (the score is unchanged while the feature is on **and** off) |

### Lead conversion

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Contact-only, Account-only and Account + Contact flows | `lead-conversion.service.ts` (`work`, `applyTarget`) | `lead-score-conversion.test.ts` |
| Linking an existing Contact/Account where permitted | the same command, `action: 'link'` | `lead-score-conversion.test.ts` ("links an existing Contact and Account") |
| Opportunity only through the canonical service, or explicitly deferred | the same command; `EntityCrudService` creates the deal | `lead-score-conversion.test.ts` (LS.16's deal test), `lead-score-audit.md` §11 `LS.16` |
| Duplicate detection is visible, ACL-aware, never a silent fuzzy merge | `lead-duplicate-resolver.ts` (exact stages only, `hiddenMatches` as a count) | `lead-score-duplicates.test.ts` |
| Field mapping validated and previewed; non-empty targets not overwritten by default | `lead-field-mapping.service.ts` (validated on write), `lead-conversion-preview.service.ts` | `lead-score-conversion-preview.test.ts` |
| A conversion preserves the Lead and moves it to `Converted` | the Lead row is never rewritten in place | `lead-score-conversion-history.test.ts` (LS.15) |
| The Lead references its targets and shows a Converted-To panel | `convertedAccountId`/`convertedContactId`/`convertedOpportunityId` + the metadata panel | `lead-score-conversion.test.ts`, `e2e/lead-conversion.spec.ts` |
| Actor, time, choices, mapping version and operation id are auditable | `LeadConversionOperation` (append-only) | `lead-score-conversion.test.ts` (the row names them), the audit view |
| Conversion is transactional, or uses a durable recovery state machine | T1 claim / T2 work / T3 settle, one transaction for the work | `lead-score-conversion.test.ts` (a refusal inside T2 leaves no target) |
| Repeated, retried and concurrent requests cannot duplicate targets | the unique operation key, the row lock, the version check | `lead-score-conversion.test.ts` (replay), **and LS.18's release suite: two racing conversions produce exactly one Contact** |
| Unauthorized users cannot create/link targets or discover hidden duplicates | the gate, the target entities' own ACL, `hiddenMatches` as a count only | `lead-score-conversion.test.ts`, **and LS.18's ACL matrix over every route** |
| Conversion sends no external message and copies no consent | the command writes only records; consent is address-level in MA | `lead-score-conversion-history.test.ts` (consent rows unchanged) |

### Platform quality and operations

| Requirement | Implementation | Verification |
| --- | --- | --- |
| The platform's Entity Engine, API, ACL, audit, Jobs and UI conventions are reused | `EntityCrudService`, `AclApiService`, the hook registry, the outbox, the worker, the metadata-driven SPA | the whole suite; the LS.18 report is built on the **generic aggregate**, not a private query |
| APIs and errors are documented in OpenAPI | the controller's routes are generated into `/api/v1/OpenApi`; the error codes are in `i18n/{en,vi}/errors.json` | `lead-score-module.test.ts` (the route list), the LS.18 matrix |
| Unit, integration, authorization, concurrency and end-to-end tests pass | the sixteen LeadScore API files, the worker suite, four Playwright specs | the verification table below |
| The database test policy is followed; no test database or schema was created | every suite boots the configured database (`boot-api.ts`) and cleans up by marker | **LS.18's suite asserts that no test support file contains `CREATE DATABASE`, `DROP DATABASE`, `DROP SCHEMA` or `TRUNCATE`** |
| Migrations are additive and reviewed; none destructive | `073`, `074`, `075`, `076` — index-only and additive | **LS.18's suite reads the migration files and asserts they contain no `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `ALTER COLUMN`, `CREATE DATABASE`, `CREATE SCHEMA` or `REFRESH MATERIALIZED`** |
| Automated tests use no real customer records and trigger no real external effect | every fixture carries a run marker; the AI suite uses AIAgents' deterministic fake provider | the suites' own cleanup (marker sweep), the LS.18 suite's marker assertions |
| Monitoring and recovery instructions exist | `docs/runbooks/lead-score-operations.md` | the runbook's command table and its four recovery sections |
| The compatibility document records behavior, deviations and deferred items | `docs/compatibility/lead-score.md` (§2 baseline, §4 behavior, §7 limitations, §8 verification) | the document itself, updated per phase |
| The final report lists the code changes, the commands run, the outcomes and the limitations | this document | §3 below |

## 3. Verification

Commands run (configured primary database only; no extra database; no destructive statement):

| Check | Result |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-*.test.ts` | **338 passed / 0 failed** across **17 files** (this phase added 10 in `lead-score-release.test.ts`) |
| Full `npx vitest run` | **2,973 passed / 34 failed** across **208 files** — the 34 in the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3) and **zero `lead-score` failures**; the +10 are this phase’s new tests |
| Worker suite (`npx vitest run --config apps/worker/vitest.config.ts`) | **210 passed / 0 failed** (20 files) |
| `npx playwright test e2e/lead-score.spec.ts e2e/lead-score-admin.spec.ts e2e/lead-conversion.spec.ts e2e/search-import-dashboards.spec.ts` | **20 passed** (57 s) — the three Lead Score specs (16) and the dashboards spec (4), the new one adding a `leadScore` dashlet through the API and asserting the module’s own metric labels render |
| `npm run typecheck` | clean |
| `npx eslint` on every touched path | clean |
| `pnpm --filter @carocrm/api build`, `pnpm --filter @carocrm/web build` | both succeed |
| `npm run db:migrate` | up to date (076 applied by the test boot; idempotent) |

The new suite `apps/api/test/lead-score-release.test.ts` (**10 tests**) asserts:

1. the report's four views describe the fixtures (a scored Lead, an unscored Lead, a converted Lead with a
   Contact and an Opportunity, and one converted two months ago);
2. **the report is scoped**: a reader with `own` sees exactly one Lead's numbers while an administrator
   sees more;
3. the `leadScore` dashlet runs and renders its section, and a configuration that names no view (or an
   unknown one) is refused;
4. **every Lead Score route** refuses a caller who holds none of the module's rights, with
   `AUTHORIZATION_DENIED` — health, score, history, recalculate, model validate, conversion preview,
   conversion convert, the operations list, the AI insight and the report;
5. the write guard still refuses a client write of `scoreValue`, of `convertedContactId` and of a
   `LeadScoreInsight` row — an administrator included;
6. **concurrency**: two simultaneous conversions of one Lead produce one `200`, one refusal and exactly one
   Contact;
7. the migrations are additive and index-only, the four Lead Score migrations are applied, and the module
   owns **no table** of its own;
8. no test support file creates, drops or truncates a database or schema;
9. the report's groups stay inside their bound.

## 4. Notes and limits

- **The report is a snapshot.** There is no historical trend; only the conversions of the last 30 days are
  windowed. A trend belongs to a read model this build does not have.
- **The report counts Leads, not operations.** An operator who wants the operation history reads
  `action/conversion/operations` — which is a separate, audited view with its own right.
- **The dashlet kind is a superset.** `076` replaces the `dashlets.kind` CHECK with a strict superset, so
  every existing row stays valid; no column, table or value is removed.
- **The AI explanation is still not part of the report.** Its counters are on the stored insight and are
  summed per record; a period total belongs to the reporting work of a later phase.
- **The OpenAPI document is generated from the registered routes**, so the new `action/report` route is in it
  like every other; there are no hand-written examples for the module's responses.
