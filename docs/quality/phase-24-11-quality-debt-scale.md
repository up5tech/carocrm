# Phase 24.11 — Quality Debt and Single-Tenant Scale

> **Status:** Implemented 2026-11-17 — every task is dispositioned below. Two exceptions were **fixed with
> regression tests** (G64's SPA half landed in 24.10; G95 here), one measurement programme ran against the
> configured primary database with synthetic records and full cleanup, and the remaining exceptions keep
> their owners and review dates. **No tenant id or tenant predicate was introduced; no extra database was
> created.**
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §17 (Phase 24.11 — Quality Debt and Single-Tenant Scale, P2)
> **Predecessor:** Phase 24.10 — UX completion (`docs/quality/phase-24-10-ux-completion.md`).

## 1. Objective

Close residual gaps and prove the single JSONB store holds up for one organisation at realistic size.

## 2. Task status

1. **Exception dispositions — done.**
   - **Fixed this phase:** **G95** — both AI-agent trigger doors scanned only the first 20 published agents
     ordered by a random UUID, so a matching agent could be invisible. Both doors now use
     `publishedTriggerAgents()` (`apps/api/src/ai-agents/runs/triggers.ts`): one join of `ai_agents` to
     `ai_agent_versions` on `version = current_version` across **all** published agents; the five-start
     fan-out cap per event is unchanged. Regression: `apps/api/test/ai-agent-triggers.test.ts` seeds 25
     published filler agents whose ids sort below every real UUID and proves the matcher still fires
     (16/16 pass).
   - **Already fixed earlier, register updated:** **G64** — the ~150 raw `error.message` SPA sites now render
     through the shared code-aware `errorMessage()` helper with a convention-gate rule (24.10).
   - **Standing exceptions (owners + review dates unchanged, re-verified 2026-11-17):**
     - **G48 / G49** (advanced-integrations, review 2026-12-09): the resilience layer is not engaged on the
       sync path; `deletionPolicy: 'archive'` equals `'unlink'`. Both are scoped, mitigated and owned; no
       cheap correct fix exists without redesigning the sync contract — they stay live exceptions.
     - **G77** (platform/operations, review 2026-12-09): no metrics/tracing exporter; module metric endpoints
       remain the interim answer. Accepted in 22.21.
     - **G89** (worker/platform, review 2026-12-13): worker BPM/workflow handlers write CRM records through
       worker DB access, bypassing API ACL — documented system-scoped automation; user-scoped async work
       goes through `runAsUser`.
     - **G90 / G91** (platform, review 2026-12-13): anonymous `/OpenApi` inventory and `/health/ready`
       database-reachability probe. Both are **owner decisions**, not agent-fixable: G90's D3 disposition is
       recorded but unsigned; G91 is intended for deployment-internal probes.
     - **G92** (platform/CI, review 2026-12-13): the DB-free nightly lane has no API authorization assertion;
       ACL/BOLA suites stay sandbox-only by design (`vitest.ci.config.ts`).
     - **G97 / G98** (platform/extensions, review 2027-03-31): manual `pnpm audit` and unsigned sample
       extensions — both fail closed or are covered by the release checklist.
   - No exception was accepted, closed-by-agent or re-dated by this pass; High/Critical rows still await
     owner signatures (`docs/security/exception-register.md` §5).
2. **Dead-tenant cleanup assertion — done.** `scripts/check-single-tenant.mjs` scans `apps/api/src`,
   `apps/web/src` and `packages/*/src` for `getTenantId` / `tenantId` / `tenant_id` and fails the build on a
   hit. It is wired into `pnpm lint`. The only surviving uses are the **Microsoft Graph/Entra tenant id** on
   inbound mail connections (`apps/api/src/email/inbound-connections.service.ts`,
   `packages/mail/src/inbound/graph.ts`, and the row type in `database.service.ts`) — a different domain
   concept, allowlisted by file with the reason in the script header. Run: `single-tenant check: clean`.
3. **JSONB/EAV performance baselines — measured.** New harness `scripts/perf-jsonb-scale.ts` (same in-process
   boot pattern as `scripts/perf-baseline.ts`) inserted **12 000 uniquely marked synthetic Contact rows**
   (`attrs->>'agentPerfRun' = <run marker>`) into the configured primary database — 16 130 live Contacts at
   measurement time — timed the load, representative SQL and HTTP statements, printed `EXPLAIN` (no ANALYZE),
   and deleted exactly its own rows afterwards (`cleanup: deleted 12000 synthetic rows`). Two runs produced
   consistent numbers; the table below is the second run (2026-11-17, PostgreSQL 16.6 local container,
   Apple-silicon macOS, Node 24).

   | Statement | p50 ms | p95 ms | Reading |
   |---|---:|---:|---|
   | Batched insert load | — | — | 0.05 ms/row (12 000 rows in ~0.6 s) |
   | List page (`entity_type` + `modified_at desc`, limit 20) | 0.5 | 1.6 | index-ordered; fine |
   | `attrs->>'email' =` equality | 6.8 | 8.4 | seq scan over Contact rows — no jsonb expression index; acceptable at 16 k, revisit ~100 k |
   | `(attrs->field) @> jsonb` containment | 3.5 | 10.8 | early-exit after 20 matches |
   | `attrs->>'lastName' ilike` | 2.4 | 5.2 | scan + filter; fine at this size |
   | `order by attrs->>'lastName'` | 7.5 | 10.0 | full sort of the entity's rows — the known JSONB-sort cost |
   | Deep offset page (`offset 5000`, limit 20) | 9.1 | 12.3 | see G71 decision below |
   | Single-row `jsonb_set` attrs update | 2.6 | 3.5 | fine |
   | `GET /api/v1/Contact` list (20) | 25.6 | 28.1 | handler + ACL + metadata overhead dominates the SQL |
   | `GET /api/v1/Contact` `where` attrs equals / like | 23.1 / 20.4 | 29.7 / 22.1 | same envelope cost |
   | `GET /api/v1/Search?q=perf` (3 entities) | 43.4 | 53.0 | trigram path; consistent with 22.20 baseline |

   `EXPLAIN`: list page uses `Limit → Index Scan` on `idx_entity_records_modified_at`; the attrs predicates
   are filter nodes over the entity scan (cost ~4 200 total at 16 k rows). **Interpretation:** at a realistic
   single-tenant volume (tens of thousands of rows per entity) every measured path is single-digit-to-low-
   tens of milliseconds; the two shapes to watch are unindexed attrs-key sorts and deep offsets, both linear
   and both bounded by page size in practice. No defect found that justifies a storage redesign; if a
   deployment exceeds ~100 k rows per entity, the follow-up is expression indexes on hot attrs keys, not a
   schema change.
4. **G71 decision — offset pagination stays.** Evidence: at 16 130 Contacts a `limit 20 offset 5000` page
   costs ~9 ms p50 / ~12 ms p95 — the "live window" semantics are a documentation matter, not a performance
   defect. Offset remains correct for the entity list's use (jump-to-page, filtered result sets); where a
   stable snapshot walk is genuinely required the product already has keyset — `GET
   /api/v1/Sales/inventory/history` ships `?cursor` over `(created_at desc, id asc)` (22.27). **No cursor
   pagination was added**; the threshold that would justify it is a measured defect, and none was found.
   `docs/quality/known-gaps.md` G71 updated with the measurement.
5. **G69/G75/G79 reliability — dispositioned.** All three are already **Fixed** in `known-gaps.md`
   (G69 stock-history truncation and G75 allocation-picker 500-cap fixed in 22.26 with keyset history in
   22.27; G79 `hooks-events` flake fixed in 22.26). The verification path that must stay green:
   `pnpm ci:gate` (DB-free lane: lint, arch boundaries, typecheck, build, migrations, api-spec strict,
   api-client, `test:ci`, `test:worker`, `test:web`, secrets) plus the sandbox-only integration batch —
   `pnpm verify` — before release sign-off. Known shared-database flake behaviour is documented per-finding;
   no flake was re-observed in this pass's focused runs (`ai-agent-triggers` 16/16, web 98/98).
6. **Test-count/status reconciliation — done where verifiable.**
   - `docs/reference/alpha-status.md`: stale "300 vitest tests / 493 total / 142 smoke checks" replaced with
     measured file counts (246 API test files on disk) and pointers to `phase-24-test-evidence.md` for
     authoritative per-run counts; smoke-check counts corrected to ~190 (e2e) / ~34 (worker).
   - `plans/PLAN.md` §58: route count corrected 920 → **927** (24.8 added 7 extension routes; strict gate
     unchanged).
   - `docs/quality/phase-24-test-evidence.md`: 24.10/24.11 entry appended with the checks actually run.
   - Authoritative full-suite numbers remain the last `pnpm ci:gate` run (24.8: `test:ci` 94 files / 1 462
     tests, worker 24 / 248, web 15 / 86); this pass adds web files/tests (17 / 98 measured locally) and one
     API test — a fresh `ci:gate` is required before 24.12 can quote final numbers.
7. **Knowledge graphs — refreshed after the code changes** (`graphify update .` and trail graph; see
   commit-time `trail check`).

## 3. Acceptance criteria status (task / plan §17)

| Criterion | Status |
| --- | --- |
| Every open exception has an owner, a review date and either a fix or a written rationale. | **Met** — G64/G95 fixed with tests; the rest keep named owners, scopes, mitigations and review dates in `docs/security/exception-register.md`. |
| Performance baselines are measured, recorded and linked to the affected surfaces. | **Met** — §2.3 table + `scripts/perf-jsonb-scale.ts`; affects the generic entity list/detail/search/export surfaces. |
| No tenant id or tenant predicate was introduced, and no extra database was created. | **Met** — `check-single-tenant.mjs` clean and wired into `pnpm lint`; all measurements ran on the configured primary database; synthetic rows were marker-scoped and deleted. |

## 4. Outstanding work

1. Full `pnpm ci:gate` / `pnpm verify` re-run for authoritative final counts (24.12 owns the release gate).
2. Owner signatures on the unsigned High/Critical exceptions (unchanged, `exception-register.md` §5).
3. Expression indexes on hot attrs keys only if a deployment measurably exceeds ~100 k rows/entity.

## 5. Verification actually run (2026-11-17)

- `node scripts/check-single-tenant.mjs` — clean; wired into `pnpm lint`.
- `pnpm tsx scripts/perf-jsonb-scale.ts` (`PERF_CONTACTS=12000`, two runs) — completed, 12 000 synthetic rows
  inserted and deleted per run; tables above.
- `pnpm --filter @carocrm/api typecheck` — clean (G95 change).
- `pnpm exec vitest run apps/api/test/ai-agent-triggers.test.ts` — 16/16 pass.
- `pnpm --filter @carocrm/web test` — 17 files / 98 tests pass.
- `node scripts/check-ui-conventions.mjs` — clean (5 179 keys).
- `pnpm verify` / `pnpm ci:gate` — **not run** in this pass; required before 24.12 sign-off.
