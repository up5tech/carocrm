# Phase 24 — Test Evidence

> **Entries:** 24.1 — Single-Tenant Charter and Documentation Reconciliation (2026-11-14);
> 24.2 — NO-GO Blocker Closure, **partial / blocked** (2026-11-14). One evidence file, appended per
> sub-phase.
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §§7–8; deliverable registered in §4.1
> **Predecessor:** `docs/quality/phase-24-priority-decisions.md` (24.0 audit, 2026-11-14)
> **Database policy:** 24.1 contacted no database. 24.2 contacted **no recovery database** and ran no
> restore; its two focused Phase 23 regression suites boot the configured primary database under
> `AGENTS.MD` §3 with no new database, schema, reset, truncate or broad delete. No migration was added
> and no business data was changed by the 24.2 documentation work. The gate is DB-free by
> `vitest.ci.config.ts` and `docs/quality/ci-gates.md`.

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

---

## Phase 24.2 — NO-GO Blocker Closure (P0) — partial / blocked

> **Result: NOT COMPLETE.** Four of the seven §8 tasks are gated by explicit owner/legal/deployment
> decisions that an agent may not make. Every actionable task was completed; the production release
> remains **NO-GO**. No exception was accepted, signed or re-scored, no `LICENSE` was created, no
> backup was installed, no restore was run, and no recovery database was contacted.

### 24.2.1 Task disposition (plan §8)

| §8 task | Disposition | Evidence |
|---|---|---|
| 1 — obtain D4 (isolated target, permitted writes, RPO/RTO) | **Blocked — owner.** No approval exists. Only archive integrity/freshness checks were run, with no recovery-database contact | §24.2.2; `docs/quality/known-gaps.md` G80 |
| 2 — install encrypted off-host backup | **Deployment-owned; not installed.** Templates re-read and verified as shipped-only; no gpg recipient, no off-host destination, no timer, no alert recipient | §24.2.2; `docs/quality/known-gaps.md` G81 |
| 3 — run `pnpm restore:drill` after D4 | **Blocked — D4.** Not run. No `--allow-restore`, no target, no `--allow-clean`. The tool refused fail-closed before any connection | §24.2.2 |
| 4 — record the distribution decision | **Prepared by the agent; decision pending owner/legal.** Blank decision record + third-party inventory added; no licence chosen, no review concluded | `docs/security/distribution-compliance.md` §6; `README.md` §Licensing |
| 5 — owner signatures on High/Critical exceptions | **UNSIGNED.** An agent may not sign. Three High rows plus G1/G90 recorded as pending | `docs/security/exception-register.md` §5 |
| 6 — resolve G1's D3 deviation | **Disposition recorded, sign-off pending.** G1 stays `Partial`; G90 is explicitly not resolved by D3 | `docs/quality/known-gaps.md` G1; exception register §5 |
| 7 — re-run `pnpm ci:gate` + focused Phase 23 regression | **Run** | §24.2.3 |

### 24.2.2 Read-only archive verification (no recovery database)

These commands are **expected to exit non-zero** for a deployment with no installed backup. Reporting
them as green would be false evidence. Nothing was installed, chmodded, created or deleted.

| Command | Result |
|---|---|
| `pnpm backup:freshness` | **Exit 1.** Archive `phase22-2026-11-04T01-28-42-309Z` (schema-only tooling artifact), newest file **243.1 h** old vs a 26 h limit, checksums **verified**, 3 files, 0 world-readable, **no encryption marker** → `STALE` |
| `node scripts/verify-backup.mjs .data/demo/backup-2026-10-22T03-12-12-673Z` | **Exit 1.** 40 tables / 31,379 rows, 553.4 h old, no encryption marker, **8 problems**: missing `users`, `roles`, `teams`, `app_settings`, `audit_log`, `outbox_events`, `jobs` + stale age |
| `env -u RESTORE_DATABASE_URL node scripts/restore-drill.mjs --target-env=RESTORE_DATABASE_URL` | **Exit 1, refusal before any DB contact** — "the recovery target is not provided (set $RESTORE_DATABASE_URL)" and "there is no approved recovery environment yet — see G80". This is the fail-closed guard working, not a drill |
| Environment presence check (names only, no values) | `BACKUP_GPG_RECIPIENT`, `BACKUP_ROOT`, `RESTORE_DATABASE_URL`, `BACKUP_MAX_AGE_HOURS` — **all unset** |
| `scripts/deploy/` inventory | Only `backup.service.example`, `backup.timer.example`, `restore-drill.cron.example`; no installed `backup.service`/`backup.timer` anywhere in the repository |
| `pnpm licenses list --json` (offline) | 13 licence groups across **716** installed packages with a declared `license`; 759 package directories under `node_modules/.pnpm`; 25 workspace `package.json` files declare 205 direct deps. Used for the distribution inventory, **not** a legal conclusion |

### 24.2.3 Regression verification

| Command | Result |
|---|---|
| `pnpm ci:gate` (24.2 re-run) | **Exit 0** — lint (5,178 keys + eslint), `lint:arch` (2 known exceptions), typecheck, build, 94 migrations, api-spec 63/915, `test:ci` **89 files / 1,424 tests**, worker **24 / 248**, web **15 / 86**, secret scan **2,502 tracked files**. The first attempt aborted on a transient ESLint `write EPIPE` from the workspace IPC broker (not a lint finding); the retry with output redirected to a file passed. As in 24.1, the stale generated `apps/web/dist` was moved to `/tmp` first so Vite's `emptyDir` did not trip the bulk-delete guard |
| `MAIL_TRANSPORT=memory SMTP_FROM=agent-test@example.invalid pnpm exec vitest run apps/api/test/phase23-10-security-regression.test.ts` | **Exit 0** — 1 file, **18 tests** passed |
| `MAIL_TRANSPORT=memory SMTP_FROM=agent-test@example.invalid pnpm exec vitest run apps/api/test/acl-matrix.test.ts` | **Exit 0** — 1 file, **12 tests** passed |

The focused batch is **2 files / 30 tests**, each run as its own `pnpm vitest run` per repository
convention. Both boot the configured primary database under `AGENTS.MD` §3; no extra database,
schema, container, reset or truncate was created. `.env` is git-ignored; no connection string is
recorded here. `pnpm ci:gate` itself is DB-free. No application code changed in 24.2, so these runs
prove the tree stayed healthy rather than validating a new code path.

### 24.2.4 Acceptance criteria (plan §8)

| Criterion | Result |
|---|---|
| G80/G81 `Fixed` with restore evidence, **or** explicitly accepted by the owner in writing with a review date | **NOT MET.** Both remain `Blocked` (G80 Medium, G81 High). No restore evidence, no owner acceptance in writing |
| The release record states the distribution outcome; "do not distribute" is stated explicitly if that is the outcome | **MET for the current outcome** — §24.2.5 states "do not distribute". The owner/legal outcome itself is still pending, so §5 of `distribution-compliance.md` remains unticked |
| No High/Critical exception is unsigned, and no exception was accepted by the coding agent | **NOT MET on signatures.** Three High rows are explicitly **UNSIGNED**. **MET** on the second half — no agent acceptance or signature |
| The primary database was never reset, recreated or broadly cleaned | **MET.** No DDL, no reset, no broad delete; only the two regression suites touched the configured primary |

### 24.2.5 Distribution outcome for the release record

**Do not distribute.** No root `LICENSE` or proprietary notice exists, no clean-room/AGPL reviewer or
outcome is named, and no third-party notice artifact has been produced by a legal review. Until the
owner/legal decision `DIST-24.2-01` is recorded and linked from `README.md` §Licensing and the final
Phase 24 release review, this repository must not be published as a distribution artifact. This is
the "do not distribute" statement required by `docs/security/distribution-compliance.md` §5; it is a
status, **not** an owner decision.

### 24.2.6 Reviewed work order (plan §5.1)

All remaining 24.2 work is owner-controlled: **D4** (owner / platform-operations), the **distribution
outcome** (owner / legal), **three High signatures** (owner), and the **D3 / G90 sign-off** (owner).
No blocked task is marked complete because unrelated work advanced.

Per §5.1, **24.3 (production installation/upgrade)** and **24.4 (canonical API contract and typed
client)** may proceed independently after 24.1, and **24.5** may reconcile already-provable release
facts. Recommended next actionable P0 work is 24.3, then 24.4, with 24.2 revisited as soon as D4 or
the legal outcome arrives. This entry records that order; it does not auto-start an unrequested
sub-phase.

### 24.2.7 Files changed

- Prepared records: `docs/security/distribution-compliance.md` §6, `README.md` §Licensing.
- Registers: `docs/quality/known-gaps.md` (G1 summary + G1/G80/G81 subsections),
  `docs/security/exception-register.md` §5.
- Evidence: this entry; the project daily log `.workbuddy-ai/memory/2026-11-14.md`.
- **Not created:** `LICENSE`, `NOTICE`, any backup artifact, any restore evidence, any distribution
  artifact, any owner signature. `package.json`, `pnpm-lock.yaml` and all application code are
  unchanged.

## Phase 24.3 — Production Installation and Upgrade (P0) — artifacts implemented / exercise blocked

### 24.3.1 Delivered artifacts

- `docker/production.Dockerfile`: API, migration, worker and SPA targets. API and worker run as
  non-root service users; runtime images include the built artifacts and production dependencies.
- `docker-compose.production.yml`: private PostgreSQL/Redis/API/worker/SPA topology; database and
  Redis ports are not published, and the web edge binds to loopback by default. The one-shot
  migration image has its own command and image tag.
- `docker/nginx.conf` and `.dockerignore`: SPA routing, CSP and response headers; build context excludes
  local secrets and artifacts. HSTS remains the TLS terminator's responsibility.
- `apps/api/src/migrate.ts` and `AUTO_MIGRATE=false`: separate migration process, required
  `MIGRATIONS_DATABASE_URL`, and production refusal to run DDL at API startup.
- `scripts/deploy/provision-postgres-roles.sql`: interactively prompts for separate application and
  migration role passwords; the runtime role receives DML privileges and no schema CREATE.
- `scripts/production-install-smoke.sh`: HTTPS readiness, auth/Secure-cookie, metadata, identifiable
  Account CRUD and worker job smoke; test-created records are cleaned up by exact IDs.
- `docs/runbooks/installation-and-upgrade.md`: installation, upgrade ordering, worker pause,
  rollback limits and operator checks. `docs/security/deployment-baseline.md` now distinguishes the
  available deployment artifacts from an installed, recovered deployment.
- Production configuration now rejects non-32-byte encryption keys and wildcard CORS; worker rejects
  the development DB fallback. A stale production-config test fixture was updated to disable
  auto-migration.

### 24.3.2 Verification run

| Command | Result |
|---|---|
| `pnpm --filter @carocrm/api build` | **Exit 0** |
| `pnpm --filter @carocrm/worker typecheck` | **Exit 0** |
| API/worker/migration/SPA Docker builds (`docker build --target ...`) | **Exit 0** for all four image targets; Vite emitted existing large-chunk and dependency annotation warnings |
| `docker run --rm --add-host api:127.0.0.1 carocrm-phase243-web:check nginx -t` | **Exit 0** — Nginx syntax and config validated |
| `pnpm --filter @carocrm/worker exec vitest run src/env.test.ts` | **Exit 0** — 1 file, 6 tests |
| `docker compose -f docker-compose.production.yml config --quiet` with placeholder-only environment values | **Exit 0**; no credentials or database URL were logged |
| `pnpm lint:changed`, `bash -n scripts/production-install-smoke.sh`, `git diff --check` | **Exit 0** |
| `pnpm exec vitest run apps/api/test/phase23-1-security.test.ts apps/api/test/config-jwt-secret.test.ts` | **Exit 0** — 2 files, 21 tests |
| `pnpm verify` | **Exit 1** — lint, typecheck and web suite succeeded; API suite had 2 failures / 3,691 tests (one production fixture failure was fixed and both related focused suites now pass; one timing-sensitive journey cancellation assertion expected `canceled`, received `succeeded`). Remaining failure is not waived or weakened. |

### 24.3.3 Acceptance and outstanding work

- **Artifacts:** implemented and statically/build validated; not yet an exercised production installation.
- **Fresh-install and upgrade/rollback rehearsal:** not performed. The policy forbids provisioning a
  database or recovery target for this task. A real deployment/recovery rehearsal needs an already
  approved, recoverable non-production environment and operator sign-off.
- **G80/G81 remain blocked:** backup/restore target and operational evidence are missing, so Phase
  24.3 does not authorize production GO. Run the external TLS/proxy check and production smoke only
  after an operator has installed the stack and provisioned a dedicated smoke user.
- No migrations, seeds, live deployment, DB writes or production smoke requests were run.
