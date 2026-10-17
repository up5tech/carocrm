# Customer Success — completion report (Phase 19-CS)

Maps every sub-phase of `PLAN_Phase_19_Customer_Success.md` to what was built, the checks that
actually ran, their results, and what remains open. Date of this report: 17 October 2026.

**Module id** `CustomerSuccess` (no prefix); **entities keep the `CustomerSuccess` prefix**, and
`CustomerSuccessProfile` is the exact marker the shipped Sales integration declares — verified in
this session (§12.8). Implementation lives in `apps/api/src/customer-success/`, registered once in
`apps/api/src/app.module.ts`, metadata in `database/seed-metadata.ts`, seed rows in
`database/seed.ts`, one additive migration `database/migrations/032_phase19_customer_success.sql`.

## 1. Sub-phase → files

| Sub-phase | Delivered by |
|---|---|
| 19-CS.0 audit & contract | `docs/implementation/customer-success-repository-audit.md`, `docs/modules/customer-success/compatibility.md` |
| 19-CS.1 scaffold & registration | `customer-success/index.ts`, `customer-success-module.ts`, `customer-success-module-health.service.ts`, `customer-success-settings.service.ts`, registration in `app.module.ts` (controllers before `ENTITY_CONTROLLERS`) |
| 19-CS.2 metadata, schema, profile | `database/seed-metadata.ts` (9 entities, fields/relations/layouts/ACL), `032_phase19_customer_success.sql`, `customer-success-profile.service.ts`, `customer-success-write-guard.service.ts`, `customer-success-internal.ts`, `customer-success-records.ts` |
| 19-CS.3 portfolio, assignment, lifecycle | `customer-success-portfolio.service.ts`, `customer-success-lifecycle.service.ts`, `customer-success-records.ts`, controller actions |
| 19-CS.4 scoring config & signals | `customer-success-domain.ts` (pure rules), `customer-success-signals.ts` (`HealthSignalProvider`/`HealthSignalRegistry`), settings schema in `customer-success-settings.service.ts` |
| 19-CS.5 snapshots, explanation, history | `customer-success-health.service.ts`, `customer-success-health-snapshot.service.ts`, controller health actions |
| 19-CS.6 plans & goals | `customer-success-plan.service.ts`, `customer-success-goal.service.ts`, `customer-success-defaults.ts` |
| 19-CS.7 risks & escalation | `customer-success-risk.service.ts` |
| 19-CS.8 onboarding & playbook core | `customer-success-playbook.service.ts`, seeded default template (`customer-success-defaults.ts` + `database/seed.ts`) |
| 19-CS.9 reviews & touchpoints | `customer-success-touchpoint.service.ts`, `CustomerSuccessReview` entity |
| 19-CS.10 renewal readiness & adapters | `customer-success-renewal.service.ts` (marker-detected Subscription/Opportunity adapters) |
| 19-CS.11 jobs, triggers, notifications | `apps/worker/src/handlers/customer-success-handlers.ts`, `customer-success-jobs.ts`, `customer-success-notification.service.ts`, cron rows in `database/seed.ts`, worker registration in `apps/worker/src/app.ts` |
| 19-CS.13 dashboards, search, bulk | `customer-success-dashlet.service.ts`, `GET …/action/dashlets`, bulk actions (`transitionLifecycleBulk`, `bulkRecalculateHealth`) |
| 19-CS.14 security & compatibility review | `customer-success-write-guard.service.ts`, `permissions.md`, `compatibility.md`, updated Sales marker test |
| — tests | `apps/api/test/customer-success-domain.test.ts` (28), `apps/api/test/customer-success.test.ts` (21), `apps/worker/src/handlers/customer-success-handlers.test.ts` |
| — docs | `docs/modules/customer-success/{README,api,data-model,permissions,admin-guide,operations,compatibility}.md` |

**19-CS.12 (dedicated React screens) is deliberately not built** and is not claimed in
`CUSTOMER_SUCCESS_MODULE.implementedPhases`: entities with `layouts` render through the generic
metadata-driven UI, and dedicated screens are optional polish per §10 of the plan.
`CUSTOMER_SUCCESS_MODULE.loadOrder` is `340` (after Sales' `320`).

## 2. Migration and seed

- `database/migrations/032_phase19_customer_success.sql` — additive only: the partial unique index
  on active profile `accountId`, the unique playbook-run trigger key, and 16 query indexes. Applied
  to the configured primary database (18 CS indexes verified present).
- `database/seed.ts` — 8 `customerSuccess.*` `scheduled_jobs` rows and the default onboarding
  template `csTemplateOnboarding`, all `ON CONFLICT DO NOTHING`. Executed this session; verified
  present. No destructive statement exists in the seed.

## 3. Checks actually run (all against the configured primary database; no other database created)

| Check | Result |
|---|---|
| `pnpm typecheck` (api + web) | pass |
| `pnpm build` (all workspaces) | pass |
| `pnpm exec eslint` on every changed/new file | pass — the only repo-wide lint failure is the pre-existing `.trail/hook.cjs` (committed at HEAD, unrelated) |
| `apps/api/test/customer-success-domain.test.ts` | **28/28 pass** |
| `apps/api/test/customer-success.test.ts` | **21/21 pass** |
| `apps/worker` package suite (`pnpm test` in `apps/worker`) | **179/179 pass** (18 files, incl. the CS handlers) |
| `pnpm vitest run packages` | **299/299 pass** (28 files) |
| Regression sweep — every remaining api suite, one file per invocation | **36 pass / 4 fail initially**; see flake note below |
| `apps/api/test/sales-module.test.ts` (the §12.8 marker test) | **11/11 pass after the fix in §4** |
| `bash scripts/e2e-smoke.sh` (configured DB, memory mail, scratch queue) | **196 ok / 0 fail** |
| Sales marker verification | `GET /api/v1/Sales/action/health` reports `customer-success: available` (asserted in the CS suite and in the Sales suite) |

### The full-suite flake (pre-existing, not caused by this module)

`pnpm test` (the whole api suite in one fork) aborts at a random file boundary with a native V8
abort, before or between suites. Proven pre-existing by control runs with the module's tracked
changes stashed and its tests excluded — the crash still occurred (even earlier, after one file).
Individual suites pass reliably, so the regression sweep above ran every remaining suite one file
per invocation. Three suites (`attachments`, `attachments-storage`, `audit`) crash at boot in this
environment **with and without** this module registered — control-verified — and need no code
change here; they are listed as an environment issue to investigate separately.

## 4. Changes made to existing files this session (beyond the module)

1. `apps/api/src/customer-success/customer-success.controller.ts` — completed the two helpers the
   routes referenced (`assertDestination`, `resolveProfileForCommand`): destination checks read the
   `users`/`teams` identity tables (a `User`/`Team` is not a metadata entity — the entity API
   refuses them), and an Account-named plan/risk command resolves its profile *before* the
   permission check.
2. `apps/api/test/sales-module.test.ts` — the Sales health test asserted
   `customer-success: unavailable` (the absence case, written before this module shipped). With the
   marker entity registered it now asserts `available` and `present: true`, exactly as plan §12.8
   prescribes; a comment records why the name is fixed.
3. `apps/api/test/customer-success.test.ts` — the suite's cleanup left two kinds of rows behind:
   engine-written health snapshots (no tracked id) and rows the entity ACL refuses to delete
   (templates/runs/step runs carry `delete: 'no'`). Both are now removed by exact predicate — the
   snapshot sweep keys on this run's profile ids, the history sweep on the tracked ids — and the
   suite still passes 21/21 with the cleanup verified in the database afterwards.

## 5. Data writes performed

- Migration `032` applied (additive indexes only); verified in `pg_indexes`.
- Seed rows installed: 8 scheduled jobs + the default onboarding template (idempotent, verified).
- Test records: the CS suite's own records (creates tracked, deletes by exact id); this session's
  untracked leftovers (54 health snapshots, 93 run/step-run rows, 15 test templates — identified by
  entity type + this session's time window + `AGENT_TEST_` marker, with the seeded default template
  preserved) were removed; 7 live `AGENT_TEST_` rows left by the passing sales-stock-movement suite
  were soft-deleted by exact predicate. No real customer record was read, modified or deleted; no
  outbound mail, notification delivery or webhook was triggered.

## 6. Open items

1. **19-CS.12 dedicated React screens** — intentionally deferred (documented in `compatibility.md`);
   the generic metadata UI covers list/detail/edit for every entity.
2. **The full-suite native abort** — pre-existing, control-verified; needs an environment- or
   runner-level investigation (suspicion: fork resource exhaustion across ~50 sequential app boots
   in one fork). Not a module defect: every suite passes when run on its own.
3. `attachments` / `attachments-storage` / `audit` suites crash at boot in this environment
   regardless of this module; to be re-run in a healthy environment.
