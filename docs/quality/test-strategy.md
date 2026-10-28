# Phase 22.1 — Test Infrastructure and Safety

> **Date:** 2026-10-28
> **Depends on:** `docs/quality/phase-22-capability-inventory.md` (Phase 22.0)
> **Status:** Implemented (policy + focused script guards). No new test database was created; no destructive command was run.
> **Governing rules:** `AGENTS.md` §3 (Database and Testing Policy), `PLAN_Phase_22_Integration_E2E_Hardening.md` §6 and §26.

---

## 1. Command matrix (verified)

All commands run against the **configured primary database** (`carocrm_dev`) under `AGENTS.md` §3.1 — no `*_test`, `test_db`, shadow, container, schema, or per-run database is created by any command.

| Command | What it does | DB writes | External effects | Safe to run locally? |
|---|---|---|---|---|
| `pnpm install` | Install deps (pnpm) | no | no | ✅ |
| `pnpm lint` | UI-convention check + eslint (`.agents/**` excluded) | no | no | ✅ |
| `pnpm lint:ui` | `check-ui-conventions.mjs` only | no | no | ✅ |
| `pnpm typecheck` | `tsc --noEmit` (root + web) | no | no | ✅ |
| `pnpm test` | Vitest run (`apps/api/test`, `packages`) | via helpers (seeds + test rows) | none (mail memory; fake providers) | ✅ against configured dev DB |
| `pnpm test:web` | Vitest web config | no (component tests) | no | ✅ |
| `pnpm test:coverage` | Vitest + coverage | same as `pnpm test` | none | ✅ |
| `pnpm dev` / `dev:all` | run API + web dev servers | no (until you act) | no | ✅ |
| `pnpm db:migrate` | apply pending SQL migrations (transactional per file, tracked in `schema_migrations`) | migrates schema | no | ✅ (additive, non-destructive) |
| `pnpm db:seed` | `seed()` — idempotent inserts/upserts (roles, admin, scheduled jobs, metadata) | yes (overwrites role **permissions** via `DO UPDATE`) | no | ⚠️ now **refuses NODE_ENV=production** unless `SEED_FORCE=1` |
| `pnpm demo:projects` | demo data + purge | yes (demo-scoped `DELETE`s) | no | ⚠️ now **refuses NODE_ENV=production** unless `--force` |
| `pnpm test:e2e` | `scripts/e2e-smoke.sh` (Playwright API smoke vs booted server) | yes (run-marker rows, cleaned in `finally`) | mail `memory`, queue `crm-jobs-test` (isolated) | ⚠️ now **requires `E2E_ALLOW_PRIMARY_DB=1`** (set by the script alias) |
| `bash scripts/worker-smoke.sh` | worker outbox/queue/CRON smoke | yes (`smoke-worker-<runId>`-scoped deletes) | no | ✅ (prefix-scoped, idempotent) |
| `pnpm --filter @carocrm/worker test:smoke` | same as worker-smoke | same | no | ✅ |

### Test runner facts

- **Vitest** config (`vitest.config.ts`): `pool: 'forks'`, `singleFork: true`, `include: ['apps/api/test/**/*.test.ts','packages/*/src/**/*.test.ts']`, no `globalSetup` that creates a DB. The single shared fork **leaks `process.env`** (memory note): suites that set `MAIL_TRANSPORT`/`SMTP_FROM` must restore them in `afterAll`.
- **Playwright** config (`playwright.config.ts`, root): 21 specs in `e2e/`. **Known gotchas** (shipped defects): the shell exports `HTTP_PROXY=127.0.0.1:62112`, so browser runs must set `no_proxy='*' NO_PROXY='*'`; Playwright's output-dir cleanup trips the safe-delete bulk guard (>50 files), so `mv test-results test-results-old-$(date +%s)` before re-running a spec.
- **Existing shared test helpers** (do not duplicate): `apps/api/test/helper.ts` (`bootTestApp`, `getAdminToken`, `authHeader`), `apps/api/test/module-test-app.ts` (throwaway module harness, `buildMultipart`), `apps/api/test/support/{boot-api,projects-fixtures,sales-fixtures,settings-snapshot}.ts`. New convention seed: `apps/api/test/support/test-run.ts` (run id + owned-record tracking).
- **Test seams** (`apps/api/test/helper.ts`): `bootTestApp` calls `migrateDb` + `seed` against the configured DB, then logs in as `admin/admin`. `seed` overwrites role permissions — see §4.

---

## 2. Test-data policy (Phase 22.1 §26)

1. **Run id.** Every write-capable test run records a unique id. Use `agentTestRunId()` from `apps/api/test/support/test-run.ts` (override with `AGENT_TEST_RUN_ID` to correlate across files/forks).
2. **Name marker.** Records with a `name` field MUST use `testName(purpose)` → `AGENT_TEST_<runId>_<purpose>`. (The Phase 22.0 audit found **25,847 leftover `AGENT_TEST_%` rows**, proving cleanup was historically incomplete — this convention is the fix.)
3. **Exact-ID tracking.** Register created ids with `trackRecord(table, id)` and clean up **only** those ids in `finally`/`afterAll`. Never issue broad `DELETE`/cleanup to "reset" the environment.
4. **Ownership, not guesswork.** If cleanup fails on a row, report the exact id and leave it untouched (AGENTS §3.3). Do not delete records you cannot positively attribute to your run.
5. **Transactions & async.** Prefer transaction rollback for isolated repository tests; do **not** assume queue jobs, files, emails, webhooks, or provider effects roll back with the DB transaction.

---

## 3. External-effect policy (Phase 22.1 §28)

External boundaries are represented by interfaces with production and **fake/stub** adapters; automated tests use fakes by default:

- **Mail:** default `mailTransport: none`; test harness uses `memory`. No SMTP server is reached.
- **Providers (e-signature, AI, voice, connectors, payments):** non-production deployments silently substitute fake adapters; production uses the real adapter only. Tests must not set production secrets.
- **Webhooks/callbacks:** signed test fixtures or deterministic local secrets; never bypass the verifier.
- **Queue:** e2e-smoke uses a separate `JOB_QUEUE_NAME=crm-jobs-test`, so test jobs never reach the real `crm-jobs` queue.

Never send real customer email/SMS/WhatsApp, place real calls, charge/refund, issue real signature requests, or publish live webhooks from automated tests.

---

## 4. Unsafe-command findings and the focused fixes applied

Phase 22.0 flagged three scripts that write to the configured primary database without a guard. Per plan §6 task 4, the following **focused, reviewed** changes were made (no unrelated coverage removed):

| Script/command | Risk (pre-fix) | Fix (Phase 22.1) | File |
|---|---|---|---|
| `pnpm db:seed` → `database/seed.ts` | Seeds against whatever DB is configured; overwrites **role permissions** via `DO UPDATE`. A prod misconfig silently resets permissions. | `seed()` now **throws** if `NODE_ENV=production` and `SEED_FORCE!==1`. | `database/seed.ts` |
| `pnpm test:e2e` → `scripts/e2e-smoke.sh` | Seeds + writes the configured primary DB; sets a fixed test `JWT_SECRET` and `NODE_ENV=production` with no opt-in. | Requires `E2E_ALLOW_PRIMARY_DB=1`; script alias sets it; also sets `SEED_FORCE=1` so the new seed guard passes. | `scripts/e2e-smoke.sh`, `package.json` |
| `pnpm demo:projects` → `scripts/projects-demo.ts` | `main()` calls `purge()` unconditionally (demo-scoped `DELETE`s) then seeds. | Refuses if `NODE_ENV=production` unless `--force`. | `scripts/projects-demo.ts` |
| `bash scripts/worker-smoke.sh` | Already prefix-scoped (`smoke-worker-<runId>` deletes) + `no TRUNCATE/DROP`. | **No change** — compliant by design. | — |

`scripts/e2e-smoke.sh` and `scripts/worker-smoke.sh` already use `trap cleanup EXIT`, exact run-marker deletion, and `hide_credentials`/`credentials hidden` redaction. Those were kept.

---

## 5. Sanitization rules (Phase 22.1 §10)

- Never print `DATABASE_URL`, API tokens, `JWT_SECRET`, `ENCRYPTION_KEY`, signature headers, or full customer payloads in logs/output.
- `.env` is read for **key names only** in audits; values never echoed. Scripts print the DB **name** (`${DATABASE_URL##*/}`) not the URL.
- Repo already redacts in `scripts/worker-smoke.sh` (`hide_credentials`) and `apps/worker/src/app.ts` (`redactUrl`). Keep it that way.

---

## 6. Safe vs sandbox classification

- **Safe locally (configured dev DB, fakes):** `pnpm test`, `pnpm test:web`, `pnpm lint*`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm test:e2e` (with `E2E_ALLOW_PRIMARY_DB=1`), `bash scripts/worker-smoke.sh`.
- **Requires opt-in / non-production DB:** `pnpm db:seed` (now prod-guarded), `pnpm demo:projects` (now prod-guarded).
- **Sandbox-only (not in this repo's CI):** live DocuSign/Stripe/WhatsApp/Twilio/Google connectors — driven by fakes here; real sandbox verification is separately classified and never reported as production certification.
- **Blocked until environment approved:** Backup/restore rehearsal (Phase 22.23) — needs an approved non-prod recovery environment.

---

## 7. New developer quick-start (safe)

```bash
pnpm install
pnpm lint:ui && pnpm typecheck        # no DB
pnpm test                             # Vitest vs configured dev DB (seeds + run-marker rows)
pnpm test:e2e                         # now requires E2E_ALLOW_PRIMARY_DB=1 (set by the alias)
```

No step above provisions an extra database, a container, or a schema.

---

## 8. Acceptance criteria (plan §6)

- [x] One documented, non-destructive test command matrix exists (§1).
- [x] External effects are disabled by default in automated tests (§3).
- [x] The database configuration used by each command is obvious without revealing secrets (§1, §5).
- [x] A new developer can run safe checks without automatically provisioning another database (§7).
- [x] The three flagged unsafe scripts now have reviewed, focused guards; unrelated coverage untouched (§4).
- [x] Test-data policy + run-id/ownership helpers added (`apps/api/test/support/test-run.ts`, §2).
