# Phase 24 — Test Evidence

> **Entry:** Phase 24.1 — Single-Tenant Charter and Documentation Reconciliation (2026-11-14)
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §7; deliverable registered in §4.1
> **Predecessor:** `docs/quality/phase-24-priority-decisions.md` (24.0 audit, 2026-11-14)
> **Database policy:** none of the commands below contacted a database, recovery target, provider,
> live mailbox or sandbox. No migration was added, no business data was changed, and no extra database
> was created. The gate is DB-free by `vitest.ci.config.ts` and `docs/quality/ci-gates.md`.

## 1. What 24.1 delivered

| §7 task | Artifact / change |
|---|---|
| 1 — product charter | New `docs/reference/product-charter.md`: one deployment = one organisation, target operator, non-goals, differentiator, and the rule that a feature assuming a tenant id is rejected at review |
| 2 — security decision | `docs/security/tenancy-decision.md` status changed from "deferred to a separate phase" to **decided product boundary**; §2's five deployment conditions and §5's residual risks kept; §4 converted from a trigger list into a change-control guard requiring a new owner decision and a separate plan |
| 3 — `plans/PLAN.md` | §43 rewritten as the boundary (the superseded `tenant_id` draft is named as history, not a roadmap); §9 context snippet, §12.2, §38.4, §42, §48, §49, §56.5, §57, §60 and §81 reconciled; §48 "Tenant isolation" kept and marked **Not applicable by decision** |
| 4 — status documents | `docs/reference/alpha-status.md`, `docs/reference/compatibility-matrix.md`, `README.md` ("Not built yet" and doc index), `docs/security/security-controls-matrix.md`, `docs/security/exception-register.md`, `docs/security/phase-23-security-baseline.md` D2, `docs/quality/phase-23-security-test-evidence.md`, `docs/quality/phase-22-observability-runbooks.md`, and the Phase 19/23 plans |
| 5 — dead tenant surface | **Removal chosen.** `tenantId?` and `getTenantId()` removed from `packages/core/src/context/index.ts`, `tenantId?` from `packages/acl/src/types/index.ts`, and the logger emission from `packages/core/src/logger/index.ts`. New `packages/core/src/context/index.test.ts` (3 tests) asserts the accessor is gone, no running context carries the field, and the three sources stay clean. Provider-account labels `tenant_ref` / `tenantRef` (migration 056 and the Advanced Integrations connectors) were **not** touched |
| 6 — regression guard | Rule 8 added to the repo-owned `scripts/check-ui-conventions.mjs` (already running inside `pnpm lint` and covering docs truth in its §20.26 rule). It scans `docs/`, `plans/`, `content/`, `README.md`, `AGENTS.MD` and `CHANGELOG.md`, including new untracked files, and fails on positive multi-tenancy promise phrases. Five boundary/audit documents that must quote those phrases to prohibit or reconcile them are allowlisted. `AGENTS.MD` §11 gained the matching reviewed checklist item |

## 2. Commands actually run

| Command | Result |
|---|---|
| `pnpm exec vitest run --config vitest.ci.config.ts packages/core/src/context/index.test.ts` | **Exit 0** — 1 file, 3 tests passed |
| `node scripts/check-ui-conventions.mjs` (clean tree, before and after the probe) | **Exit 0** — `ui conventions: clean (5178 keys checked)` |
| Negative probe: create `docs/_tenancy-guard-probe.md` with a sentence claiming a tenant-ready architecture and multi-tenancy support, then run the checker | **Exit 1** — 2 violations, each naming `docs/_tenancy-guard-probe.md:3` and the boundary. Probe removed afterwards; checker returned to exit 0. This proves a **new, untracked** document fails the gate |
| `pnpm ci:gate` (first run) | **Exit 1 at the web build** — `apps/web` Vite `emptyDir(dist)` hit the workspace bulk-delete guard (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`, 299 generated files in `apps/web/dist/assets`). This is an environment guard, not a code failure. Resolved by **moving** the ignored generated directory to `/tmp/carocrm-web-dist-<timestamp>` (a move, not a delete) so Vite had nothing to clear |
| `pnpm ci:gate` (re-run, 4m 01s) | **Exit 0, green.** `pnpm lint` (rule 8 clean, 5,178 keys), `pnpm lint:arch` (2 known exceptions), `pnpm typecheck`, `pnpm build` (25 workspace projects), `pnpm ci:migrations`, `pnpm ci:api-spec`, `pnpm test:ci` **89 files / 1,424 tests**, `pnpm test:worker` **24 files / 248 tests**, `pnpm test:web` **15 files / 86 tests** (includes `apps/web/src/__tests__/conventions.test.ts`, which re-runs the UI/docs gate), `pnpm ci:secrets` **2,498 tracked files, clean** |
| `pnpm ci:api-spec` | **Exit 0** — 4 files, 63 documented endpoints, 63 matched, 0 problems; 915 `/api` routes in source, 852 not yet documented (owned by 24.4, unchanged by 24.1) |
| `pnpm ci:migrations` | **Exit 0** — 94 migration files, highest `094_phase23_retention_schedules.sql`; no migration added |
| `git grep -n -E '\btenantId\b\|\bgetTenantId\b' -- '*.ts'` (excluding `dist`) | **No matches** in tracked TypeScript source |
| `git grep -l -E 'tenantRef\|tenant_ref'` in `apps/api/src` + `database/migrations` | **19 files** still using provider-account labels — preserved as required |
| Documentation phrase sweep over `README.md`, `AGENTS.MD`, `plans/`, `docs/`, `content/` | Only the five allowlisted boundary/audit documents contain the guarded phrases, always to prohibit or reconcile them |

`apps/web/dist` was regenerated by the successful build and is git-ignored; the moved copy lives outside the repository in `/tmp`. The change set is the 18 modified files plus the 3 new files listed in §5.

## 3. Acceptance criteria (§7)

| Criterion | Result |
|---|---|
| No tracked document claims tenant-ready APIs, shared tenancy, or an upcoming tenant-isolation phase | **Met.** Rule 8 plus a manual sweep. Historical Phase 23 records were reworded where they read as forward-looking; the 24.0 audit and 24 plan remain as dated evidence and are allowlisted |
| Charter, security decision, compatibility matrix, alpha status and README state the same boundary | **Met.** All five now say one deployment = one organisation, isolation is deployment-owned, and shared tenancy is a permanent non-goal |
| No tenant id, tenant predicate, per-tenant schema, or cross-tenant test exists in the change set | **Met.** Three dead declarations removed, regression test added, no migration or query change |
| `pnpm ci:gate` remains green | **Met** on the re-run, after the non-destructive dist move described above |

## 4. What this entry does not claim

- **Production remains NO-GO.** 24.1 is documentation plus dead-code cleanup. The Phase 23 release blockers are untouched: G80/G81 backup/restore is still Blocked on D4, there is no `LICENSE`/distribution decision, and the High exceptions are unsigned. Those belong to 24.2 and to the owner/legal decision, not to an agent.
- `pnpm ci:api-spec --strict` still fails by design (852 undocumented routes); 24.4 owns it. Nightly-only CI (G78/D7), SAML/SCIM deferral and the no-GraphQL decision were not reopened.
- No database-backed integration suite, Playwright/browser e2e, live provider call or `pnpm verify` was run. Those are out of scope for a documentation sub-phase and would require the configured primary database.
- The dated Phase 19 plan task lists still contain conditional wording about isolation checks. The 24.0 audit §2.2 classifies those as historical/conditional context rather than implemented product promises; they were reviewed here, and the one line that read as a future capability ("when the platform supports multi-tenancy") was corrected in `plans/PLAN_Phase_19_AI_Agents.md`. They are not claims of shared-tenancy support or of a scheduled phase.
- The first gate failure is recorded rather than hidden. It was an environment bulk-delete guard on stale generated output, reproducible and resolved without deleting anything.
- 24.11 task 2 ("complete the dead tenant cleanup decided in 24.1 and assert no caller depends on `tenantId`") is already satisfied here by the removal plus `packages/core/src/context/index.test.ts`; 24.11 should re-assert the invariant, not repeat the edit.

## 5. Changed files

New: `docs/reference/product-charter.md`, `packages/core/src/context/index.test.ts`,
`docs/quality/phase-24-test-evidence.md` (this file).

Modified: `AGENTS.MD`, `README.md`, `docs/quality/phase-22-observability-runbooks.md`,
`docs/quality/phase-23-security-test-evidence.md`, `docs/reference/alpha-status.md`,
`docs/reference/compatibility-matrix.md`, `docs/security/exception-register.md`,
`docs/security/phase-23-security-baseline.md`, `docs/security/security-controls-matrix.md`,
`docs/security/tenancy-decision.md`, `packages/acl/src/types/index.ts`,
`packages/core/src/context/index.ts`, `packages/core/src/logger/index.ts`, `plans/PLAN.md`,
`plans/PLAN_Phase_19_AI_Agents.md`, `plans/PLAN_Phase_23_Security_Hardening.md`,
`scripts/check-ui-conventions.mjs`, and the project memory file `.workbuddy-ai/memory/MEMORY.md`
(compaction required by the workspace; no product content removed).
