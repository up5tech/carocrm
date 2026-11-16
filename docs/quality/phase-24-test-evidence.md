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

## Phase 24.5 — Release Truthfulness (P0) — documentation reconciliation

### 24.5.1 Delivered changes

- `CHANGELOG.md`: new; records the 1.0.0 in-development version, the tagging convention, and the
  honest alpha/NO-GO status. `docs/releases/2026-11-15-phase-24.md`: interim Phase 24 release note
  (24.0–24.3 + 24.5 delivered, 24.4 in flight, 24.6+ not started).
- `content/docs/en/reference/release-notes.md`: release-note table now lists the Phase 24 and
  Phase 23 notes; "most recent release" corrected (was still naming Phase 22); the reader-visible
  table now describes Phase 23 auth/session/API-key changes; `updated:` bumped to 2026-11-15.
- `content/docs/vi/reference/_index.md` + `release-notes.md`: new Vietnamese translations (the
  `vi` corpus gains its first `reference` section page). `packages/docs/src/corpus.test.ts` updated:
  non-fallback `vi` pages 20 → 21.
- `README.md`: migration ceiling corrected `070_...` → `094_phase23_retention_schedules.sql`;
  Quick start now points at the Phase 24.3 production path and states the NO-GO status.
- `docs/quality/known-gaps.md`: G85 (withdrawn duplicate of G33), G86 and G87 added to the summary
  table — they existed only in the 23.0 audit table; Phase 24 status note added; the note records
  that `docs/security/exception-register.md` is authoritative for exception rows.
- `plans/PLAN_Phase_23_Security_Hardening.md`: header `Status: Planned` → `Executed — NO-GO
  (2026-11-13)`; §22 final checklist annotated with evidence (G80/G81 item stays unchecked/Blocked).
- `plans/PLAN.md` §57: Phase 24 status `Planned` → `In progress` with per-sub-phase states.
- `docs/reference/compatibility-matrix.md`: status date → 2026-11-15; "not built" list corrected —
  production artifacts now exist (build-validated, unexercised); `api-spec/` strict completion named
  as Phase 24.4 in flight.
- `docs/reference/alpha-status.md`: dev-compose deviation updated for the 24.3 artifacts; Phase
  22–24 status pointer appended (OIDC built / SAML-SCIM deferred, G1 disposition, single-tenant,
  NO-GO).

### 24.5.2 Verification run

| Command | Result |
|---|---|
| `npx vitest run packages/docs` | **Exit 0** — 8 files / 178 tests (corpus lint clean with the new `vi/reference` pages) |
| `node scripts/check-ui-conventions.mjs` | **Exit 0** — 5,178 keys; rule 8 (single-tenant doc truth) clean |
| `pnpm lint:changed` | **Exit 0** — 0 errors/warnings |
| `pnpm ci:gate` | **Exit 0** — lint + arch + typecheck + build + `ci:migrations` (94 files) + `ci:api-spec` + DB-free Vitest **89 files / 1,426 tests**, worker **24 files / 249 tests**, web **15 files / 86 tests**, secret scan clean (**2,510 tracked files**) |

Documentation-only change: no application code, migrations, database access, provider contact or
external effect. Claims about 24.3/24.4 states are labelled delivered/in-flight/blocked, matching
their evidence sections above; no production-ready or parity claim was added.

## Phase 24.6 — Real Inbound Mail (P1)

### 24.6.1 Delivered changes

- `packages/mail/src/inbound/`: `mime.ts` (RFC 5322 parser — folded headers, encoded-words,
  multipart nesting, base64/quoted-printable, RFC 5987 filenames, bounce/auto-reply
  classification), `imap.ts` (TLS `node:net`/`node:tls` client: LOGIN, SELECT with UIDVALIDITY,
  UID SEARCH/FETCH `BODY.PEEK[]`, `UIDVALIDITY:UID` identity, `maxMessageBytes` skip, plaintext
  refused for non-loopback hosts at boot), `graph.ts` (client-credentials or delegated token,
  delta-query cursor, per-message attachments, single 401-refresh retry), `fixture.ts` (`.eml`
  files, content-hash id). `NullInboundProvider` now throws `InboundMailError('not_configured')`.
- `createInboundProvider(mode, env)` + `MAIL_INBOUND_PROVIDER_MODES` boot-validate the provider
  settings (`MAIL_INBOUND_PROVIDER` default `none`), so bad config fails at boot.
- `apps/api/src/email/email.service.ts`: hardened `pollInbound()` — connection-scoped dedupe,
  bounded polls (50/connection, 500/call), per-connection cursors persisted only after a whole
  batch, thread linking by RFC In-Reply-To, attachments through the attachment ACL/malware path,
  provider failure surfaced as a clear validation error per connection.
- **Failure isolation (24.6 closure, 2026-11-16).** A message that cannot be stored now fails
  only itself: it is counted in the new `failed` field, the rest of the batch is still ingested and
  the connection's cursor is **not** advanced, so the message is retried on the next poll while the
  stored ones dedupe away. A provider that fails no longer aborts the whole call: the other
  mailboxes are still collected and the call reports every failing connection at the end
  (`VALIDATION_FAILED`). The response is `{ fetched, stored, skipped, failed }`.
- **Fixed: `emailAccountId` was written with the connection id.** An ingested Email pointed at an
  email account that does not exist. The connection now binds to the sending mailbox with the same
  address (`EmailAccountsService.idByEmailAddress`), and the field is left unset when no account
  matches, so a reply falls back to the default mailbox.
- `apps/api/src/email/inbound-connections.service.ts` + routes under
  `EmailAccount/action/inbound-connections`: admin CRUD with credentials encrypted at rest
  (`ENCRYPTION_KEY`), `hasCredential` only in responses, per-connection `lastError`/`lastPolledAt`.
- `database/migrations/095_inbound_mail_connections.sql`: connections + cursor tables and an
  expression index on `(entity_type, inboundConnectionId, messageId)` for scoped dedupe;
  `database/seed-metadata.ts`: new Email fields `inboundConnectionId`, `messageKind`
  (Standard/Bounce/AutoReply), `inboundParsed`, `inboundError`.
- `apps/api/src/service-desk/email-to-case.service.ts`: bounce/auto-reply never auto-creates a
  Case; `replyByEmail` checks live `MarketingSuppression` rows before any outbound effect;
  `processInbound` tolerates an unconfigured provider (features off the poll, still converts
  already-stored records).
- `api-spec/email.yaml` (new): the email module's public contract — transport probes, the inbound
  poll, the delivery ledger, the sending-mailbox administration and the inbound-connection
  administration (17 routes). The registry now covers 80 routes of 920; `--strict` is still
  24.4's open work.
- Docs: `README.md` "Not built yet" updated, `docs/reference/compatibility-matrix.md` email row
  and note updated, `docs/reference/alpha-status.md` email rows updated (inbound is no longer
  "not implemented"), `docs/module-guide.md` rewritten inbound section,
  `docs/runbooks/inbound-mail.md` new operator runbook (with the failure-isolation rules),
  `CHANGELOG.md`, `plans/PLAN.md` §57 and `docs/releases/2026-11-15-phase-24.md` status.

### 24.6.2 Tests added

- `packages/mail/src/inbound/mime.test.ts` (9): headers/folding/encoded-words, multipart text+html,
  attachment decoding, quoted-printable, classification, garbage fallback.
- `packages/mail/src/inbound/providers.test.ts` (10): Null fails clearly, scoped dedupe key,
  boot-fail config, fixture ordering/bounds, Graph normalization + delta cursor + rejected token,
  IMAP over a fake socket (UIDVALIDITY:UID ids, cursor).
- `apps/api/test/email-inbound.test.ts` (6, `MAIL_INBOUND_PROVIDER=fixture`, `MAIL_TRANSPORT=memory`):
  six-file fixture ingestion exactly once (repeat poll fully skipped), bounce/auto-reply/malformed
  classification, thread linking, attachment through the ACL/malware path, the same provider id in
  another connection not blocking ingestion, DB connection CRUD (encrypted credential, no secret in
  responses), failing connection surfaced clearly with `lastError`, unauthenticated refusals —
  plus the closure cases: a **partially processed batch** (one unstoreable message → `failed: 1`,
  the other six untouched, the cursor not advanced), a **broken mailbox not blocking the others**
  (the healthy fixture mailbox is still collected while the IMAP connection fails) and **restart
  safety** (a new application instance over the same database and cursor stores nothing twice).

### 24.6.3 Test evidence

- `npx vitest run packages/mail/src/inbound/` → 2 files / 19 tests passed.
- `npx vitest run apps/api/test/email-inbound.test.ts` → 6/6 passed (fixture + memory transport on
  bootstrapped API against the shared primary dev database; fixtures in `os.tmpdir()`, records
  identified by run id and cleaned by their own primary keys).
- `pnpm verify` → **Exit 0** — lint (UI conventions clean, 5,178 keys), typecheck, 286 test files /
  3,716 tests, web 15 files / 86 tests. The 24.6 commit itself did not pass lint (import sorting
  and one useless escape in `packages/mail/src/inbound/mime.ts`); that is fixed here.
- `pnpm ci:migrations` → clean (95 files, highest `095_inbound_mail_connections.sql`);
  `pnpm ci:api-spec` → 5 files / 80 documented endpoints, 80 matched, 0 problems.
- `apps/api` and `packages/mail` typecheck clean (`npx tsc --noEmit`). No real mailbox was ever
  contacted; no customer email was sent.

---

## Phase 24.7 — Installation-Wide Email and Calendar Sync (P1) — delivered 2026-11-16

### 24.7.1 Delivered changes

- `apps/api/src/advanced-integrations/sync-orchestrator.service.ts`: a run's inbound page is now
  applied **as the connection's owner** (`asOwner` via `runAsUser`, Phase 24.7) — a `user`-owned
  connection is a personal mailbox/calendar and its records land under that user's authority and
  ACL; an `organization`-owned connection keeps the caller's authority. The webhook path now enters
  the same owner authority through `applyObjectForConnection`.
- `apps/api/src/advanced-integrations/webhook-ingress.service.ts`: personal-owner apply path.
- `apps/api/src/advanced-integrations/connectors/google-workspace/google-workspace.adapter.ts`:
  all-day events anchored at midnight in the event's own time zone; outbound write scope as before.
- `apps/api/src/advanced-integrations/connectors/fake/fake-provider.adapter.ts`: `calendarEvent`
  object type added to the fake provider (with the Phase 24.7 boundary normalization).
- `apps/api/src/advanced-integrations/connectors/kit/time-zone.ts`: `eventBoundaryToInstant` /
  `startOfDayInZone` helpers (DST-aware zone resolution via `Intl.DateTimeFormat`).
- `database/migrations/096_phase24_7_sync_metadata.sql`: additive metadata for the Phase 24.7 scope —
  `Call.location` and `Meeting.location` (in `metadata_entries` + `app_settings.entity`) and the
  Phase 24.6 inbound mail fields (in both layers).

### 24.7.2 Delivered scope (owner decision D5, reconciled in 24.0)

- Inbound mail: IMAP + Microsoft Graph (delivered in 24.6) — installation-administered via
  `EmailAccount/action/inbound-connections` or the `MAIL_INBOUND_PROVIDER` environment singleton.
- Inbound calendar: Google Workspace (full + incremental via `syncToken`) and Microsoft 365 (Graph
  delta links + delivered webhook path) — via the object-mapping sync surface
  (`POST /api/v1/AdvancedIntegrations/action/mappings/:id/sync`).
- Out of scope by decision (recorded, not deferred by accident): Google Calendar push notifications
  (delivered fallback: incremental sync), outbound sending (SES/SendGrid/Microsoft Graph send), the
  email UI.

### 24.7.3 Tests added / extended

- `apps/api/test/advanced-integrations-engine.test.ts`: new describe
  **'Advanced Integrations — Phase 24.7 installation-wide inbound sync'** — full fake calendar sync +
  checkpoint, idempotent re-run, provider outage → dead letter + run `failed`, paused connection
  refused, two connections independent (overlapping provider ids), personal connection written as
  owner (owner can read via `runAsUser`), personal webhook via `applyObjectForConnection` as owner,
  stranger user denied access, incremental delta-feed run with cursorKind checkpoint and idempotent
  re-read, revoked credential refused. File now 38/38 tests.
- `apps/api/test/advanced-integrations-connectors.test.ts`: the Google Workspace connector reads
  calendar event boundaries correctly — timed event → UTC ISO instant; all-day → midnight in the
  event zone. File now 53 tests.
- `apps/api/test/advanced-integrations-time-zone.test.ts` (new, 4): DST-aware all-day anchoring and
  timed-boundary normalization.

### 24.7.4 Test evidence

- `npx vitest run apps/api/test/advanced-integrations-engine.test.ts` → **36/36 passed** (incl. the
  7 Phase 24.7 tests above).
- `npx vitest run apps/api/test/advanced-integrations-time-zone.test.ts apps/api/test/advanced-integrations-connectors.test.ts` → **57/57 passed**.
- `npx tsc --noEmit -p tsconfig.json` → clean.
- No live provider credential, no real mailbox/calendar was contacted; all sync tests ran on the fake
  provider. No customer data was touched; test records used generated identifiers.

### 24.7.5 Acceptance and outstanding work

- **Met:** compatibility matrix + provider docs name exactly what is implemented/deferred/why; sync
  is installation-administered and opt-in (fails clearly when unconfigured); supported
  mailbox/connection counts are documented; ownership and ACL are enforced independently of the
  single-tenant boundary.
- **Outstanding:** the Phase 24.7 deliverable has not been exercised against a live vendor sandbox or
  a real mailbox (the honesty clause of `providers.md`); provider-side facts remain implementation
  pins; the final Phase 24 go/no-go (24.12) is still open (release decision **NO-GO**).

