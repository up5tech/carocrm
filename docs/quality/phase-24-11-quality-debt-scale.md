# Phase 24.11 — Quality Debt and Single-Tenant Scale

> **Status:** In progress — the quality-debt and scale inventory and the task status are recorded here (2026-11-16);
> implementation has not started. **No code change has been made in this pass.**
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §17 (Phase 24.11 — Quality Debt and Single-Tenant Scale, P2)
> **Predecessor:** Phase 24.10 — UX completion (`docs/quality/phase-24-10-ux-completion.md`).

## 1. Objective

Close residual gaps and prove the single JSONB store holds up for one organisation at realistic size.

## 2. Task status

1. Work the open exception list with owners and review dates (G48/G49/G77/G89/G90/G91/G92/G95/G97/G98).
   Fix what can be fixed with a regression test; re-date or escalate the rest. Do not silently accept an
   exception. **Not started.**
2. Complete the dead tenant cleanup decided in 24.1 and assert no caller depends on `tenantId`.
   **Partially done:** the unused `tenantId`/`getTenantId` surface was removed in Phase 24.1 (with regression
   test); the remaining task is the no-caller-dependency assertion and any follow-up disposition.
   **Follow-up not started.**
3. Establish JSONB/EAV performance baselines for a single large installation: list/detail/related queries,
   global search, exports, reports, dashboards and bulk actions against the configured primary database with
   uniquely marked synthetic records. **Not started.**
4. Decide G71 (offset pagination is a live window, not a snapshot) with evidence; implement keyset/cursor
   pagination only where the measured behaviour is a real defect. **Not started.**
5. Revisit G69/G75/G79 shared-database flakes and make `pnpm verify` a reliable single run, or document
   precisely why the DB-free `pnpm ci:gate` plus focused suites is the required gate. **Not started.**
6. Reconcile test counts and status drift across `docs/quality/*`, `docs/reference/alpha-status.md` and
   `plans/PLAN.md` §60. **Not started.**
7. Refresh the knowledge graph (`graphify update .` and the trail graph) after the code changes, per `AGENTS.MD`.
   **Not started** (no code changes yet in this pass).

## 3. Acceptance criteria status (task / plan §17)

| Criterion | Status |
| --- | --- |
| Every open exception has an owner, a review date and either a fix or a written rationale. | **Open** — task 1 not started. |
| Performance baselines are measured, recorded and linked to the affected surfaces. | **Open** — task 3 not started. |
| No tenant id or tenant predicate was introduced, and no extra database was created. | **Open** — task 2 assertion pending; no new database in this pass. |

## 4. Outstanding work

1. Owner/review-date disposition for G48/G49/G77/G89/G90/G91/G92/G95/G97/G98 (fixes + regression tests where possible; re-date or escalate the rest).
2. Dead-tenant cleanup assertion (24.1 cleanup landed; verify no caller depends on `tenantId`).
3. JSONB/EAV performance baselines on the configured primary database with synthetic records.
4. G71 decision with evidence; keyset/cursor pagination only if a real defect.
5. G69/G75/G79 flake handling / gate documentation.
6. Test-count and status drift reconciliation.
7. Knowledge-graph refresh after code changes.

## 5. Verification

- `node scripts/check-ui-conventions.mjs` — docs gate, run after this record landed.
- No code, migration, database, provider or deployment change in this pass.
