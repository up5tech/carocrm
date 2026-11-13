# CI quality gates

> Phase 22.22 (`plans/PLAN_Phase_22_Integration_E2E_Hardening.md` §21). This document is the contract for
> what runs in CI, what is deliberately sandbox-only, and what is still manual.

## 1. Decisions

| Decision | Value | Why |
|---|---|---|
| CI provider | **GitHub Actions** | The repository remote is GitHub; no other CI convention exists (`.github/` held only `copilot-instructions.md`). |
| Trigger | **Scheduled + manual dispatch only** (`workflow_dispatch`) | Owner decision for 22.22. The gate is a nightly integrity check, not a per-PR gate. **Re-affirmed by the owner on 2026-11-09 (Phase 23.0 decision D3):** the nightly-only trigger stands; G78 is **not** closed. |
| Integration layer | **Not in CI** | Owner decision. Layer 3 runs against the configured primary database under AGENTS.md §3; a hosted runner must not be handed that database, and CI must never provision another one. |
| Browser layer | **Not in CI** | No Playwright browser is cached in this environment; 22.16 records functional evidence separately. A browser job needs an approved app environment and sanitized artifacts. |
| Observability/metrics backend | Not part of CI | G77; the gate is test-based. |

The workflow is `.github/workflows/quality-gate.yml`: one job, `contents: read`, no `services:`,
no secrets, no deploy, no provider callback, no artifact upload, 45-minute timeout.

## 2. Supported runtime

- Node **24** on `ubuntu-latest` (the package requires Node >= 22; the workflow pins 24).
- pnpm **10.0.0** (`packageManager`), installed by `pnpm/action-setup` and reading
  `pnpm-lock.yaml` with `--frozen-lockfile`.
- No database, Redis, browser or provider credential is needed by the gate.

## 3. Layers and commands

| Layer | In the scheduled gate? | Command | What it proves |
|---|---|---|---|
| 1 — fast | **Required** | `pnpm lint` (UI conventions + eslint), `pnpm lint:arch`, `pnpm typecheck`, `pnpm build` | Formatting/static rules, module boundaries, strict types in both projects, production build. |
| 1 — unit | **Required** | `pnpm test:ci` | **88 files / 1 419 pure tests**: every `packages/*/src` suite plus **47** API contract/domain suites that import no boot helper, `DatabaseService` or pool. Phase 23.8 added the adversarial/SSRF and security-event suites. |
| 1 — worker | **Required** | `pnpm test:worker` | **248** worker tests against `FakeDb`, fake queues and fake providers (no Postgres/Redis). |
| 2 — contract | **Required** (the pure subset) | included in `test:ci`, plus `pnpm ci:migrations` | Provider adapter conformance (`phase22-provider-contract`), job payload round-trips (`test:worker`), domain contracts, money/decimal rules, event-formatter pure tests. The migration check reads the SQL files only: unique/increasing numeric prefixes, no empty file, and no `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE`/unqualified `DELETE` without a reviewed `-- migration-safety: allow-destructive` marker. It never connects to a database. |
| 3 — integration | **Sandbox-only** | `pnpm verify` against the configured DB, or a focused `vitest run` | Persistence, API, ACL, provider fakes with the real database. Never in CI: no DB service, no `DATABASE_URL` secret, no migration. |
| 4 — browser | **Manual/approved** | `pnpm test:e2e`, Playwright specs | Critical UI journeys; browser cache and a booting app are prerequisites. Artifacts sanitized and failure-only. |
| 5 — extended | **Manual/approved** | `scripts/perf-baseline.ts`, backup/restore rehearsal, sandbox provider checks | Performance baselines, recovery exercise, provider sandbox — see 22.20/22.23. |
| Secret scan | **Required** | `pnpm ci:secrets` | 2 244 tracked files scanned for private keys, AWS/GitHub/Slack/Stripe/Google/OpenAI token shapes and a tracked `.env` file. Values are never printed. |

`pnpm ci:gate` is the exact sequence: `lint` → `lint:arch` → `typecheck` → `build` → `ci:migrations` →
`test:ci` → `test:worker` → `test:web` → `ci:secrets`.

### Why `test:ci` is a separate config

The root `vitest.config.ts` collects `apps/api/test/**` and most of those files boot the API against
the configured database. `vitest.ci.config.ts` includes:

- `packages/*/src/**/*.test.ts` (pure logic, filesystem, fake clients);
- an explicit list of 47 API suites, each verified to contain no `bootApi`, `bootTestApp`,
  `bootModuleTestApp`, `createApp`, `DatabaseService`, `ctx.database`, `new Pool` or `pool.query`.

Adding a suite to that list is a deliberate reviewed act; if it boots the app or touches Postgres it
belongs to Layer 3 and runs sandbox-only. The list lives in `vitest.ci.config.ts` so the reason is
visible next to the include.

**Proof the gate is DB-free.** Running `pnpm test:ci` with
`DATABASE_URL=postgres://nobody:nobody@127.0.0.1:1/none REDIS_URL=redis://127.0.0.1:1` passes
**88 files / 1 419 tests**; the suites never open a connection. The worker suite is pure by design
(`FakeDb`), and `test:web` is a node-environment project with no API.

## 4. Cache correctness

The only cache is the pnpm store, keyed by `pnpm-lock.yaml` through `actions/setup-node` (`cache:
pnpm`). No `dist/`, `node_modules` from another lockfile, test result or coverage artifact is cached;
a stale build output cannot be mistaken for the current source. The CI job runs `build` from source
after a frozen install.

## 5. Secrets and artifacts

- The workflow needs no repository secret. `permissions: contents: read` is the whole token scope.
- `.env` files are not tracked; `ci:secrets` fails if one is.
- The logger redacts credential shapes (22.21); the secret scan covers the checkout, not runtime logs.
- **No artifacts are uploaded.** There is no browser job in CI. If a browser layer is added later, it
  must upload only on failure, with traces/videos/storage state sanitized and a short retention; it
  must never upload a CRM record, a session token, a provider payload or an unsanitized screenshot.
- Logs are plain step output; the workflow performs no provider call, campaign, signature, deployment
  or live callback.

## 6. Actionable failures

- Each `ci:gate` stage is a named step in the workflow; a red run says which layer failed.
- A test failure prints the file, test name and assertion output; the module owner is the directory
  named in the path (`apps/api/src/<module>`, `apps/worker/src`, `packages/*`).
- There is no HTTP request in the gate, so there is no correlation id to attach; correlation ids are
  covered by the 22.21 tests and apply to sandbox/browser evidence.
- Failure output is the test runner's; the secret scan never prints a matched value.

## 7. Flaky tests (explicit register)

CI is DB-free, so the database-backed flakes below do **not** run in the scheduled gate. They still
gate `pnpm verify` locally, so they are tracked rather than ignored:

| ID | Test | Owner | Window | Action |
|---|---|---|---|---|
| G69 | `sales-tracking.test.ts` — "transfers and returns keep lot traceability" | Sales / 19-S.15 | Closed 22.26 | **Resolved, not flaky:** `GET /Sales/inventory/history` returned an arbitrary 200-row UUID sample, so the movement the test read back was often missing. Fixed by reading the page newest-first in SQL. |
| G75 | `sales-credits.test.ts` — "applies part of a credit to an invoice…" | Sales / 19-S.11 | Closed 22.26 | **Resolved, not flaky:** the picker capped the read at 500 unordered rows, so 71 existing invoices were unreachable once the database passed 500. Fixed by the paged `collectAllocatable` read; the register entry stays as history. |
| G79 | `hooks-events.test.ts` — "publishes entity.restored for a restore" (parallel-suite ordering) | platform / event tests | Closed 22.26 | **Resolved, cause unconfirmed:** both helpers read the entire `outbox_events` table and filtered in memory (and counted it globally). They now filter by entity/record in SQL and count only this suite's entity, so the assertion no longer depends on the table's size or on other files' writes. A future red here is a new diagnosis. |

A new flaky test must be entered here with an owner, a review date and whether it is quarantined;
"passes on rerun" is not a resolution.

## 8. What is still not covered

- **OpenAPI schema diff** is not generated (G1): the public API contract is exercised by sandbox
  integration tests, not by a machine-checked schema in CI. **Corrected (Phase 23.0, 2026-11-09):** a route-level
  document *is* served at `GET /api/v1/OpenApi`, but it carries no DTO-derived schemas, no request/response
  bodies and no security scheme — so the schema diff still cannot be generated. See
  `docs/security/phase-23-security-baseline.md` §3, contradiction C1.
- **No authorization assertion runs in CI** (G92): every DB-backed ACL/BOLA/injection suite is excluded from
  `vitest.ci.config.ts`, and the trigger is nightly-only (G78, re-affirmed by the owner on 2026-11-09).
  **Phase 23.8 narrowed this:** the DB-free `ai-agent-adversarial.test.ts`, `phase23-5-ssrf.test.ts` and
  `phase23-8-security-events.test.ts` now run in the lane, so provider-URL/SSRF and the security-event contract
  are checked nightly. Authorization itself remains DB-backed and therefore sandbox-only until 23.10.
- **Migrations are not executed in CI** (no DB). A static scan (`ci:migrations`) now guards numbering
  and destructive statements; the migration audit (22.5) and `db:migrate` on the configured
  environment remain the runtime check.
- **Browser E2E** is manual/approved (22.16), not scheduled.
- **Integration/ACL/provider journeys** are sandbox-only; `pnpm verify` is the local gate.

## 9. Security event telemetry (Phase 23.8)

There is still no metrics/tracing exporter (G77), so security events are observable in two bounded forms:

1. **Structured log lines.** `apps/api/src/common/security-events.ts` emits one `security event` warning with a
   fixed name, outcome, optional provider/reason label, and the logger's request correlation id. The vocabulary is
   allowlisted (`access.denied`, `auth.login.failed`, `auth.lockout`, `auth.refresh.reuse`, `csrf.rejected`,
   `webhook.signature.rejected`, `webhook.replay`, `secret.rotated`). Details that are not short labels are dropped,
   and no payload, address or token is accepted by the API.
2. **Counts in the operations snapshot.** `GET /api/v1/AdminInternal/action/operations` now carries
   `security.events` (this process's counters and their `since` time) plus `loginFailures24h`,
   `signatureRejections24h`, `voiceRejections24h` and `marketingSignatureRejections24h`, derived from the receipt
   tables. The endpoint remains administrator-only and returns counts, never actors or content.

Wiring: denial audit (`access.denied`), auth guard (`csrf.rejected`), auth service (`auth.login.failed`,
`auth.lockout`, `auth.refresh.reuse`), the ESignature/Voice/Advanced Integrations/Marketing webhook doors
(`webhook.signature.rejected`, `webhook.replay`), and `scripts/rotate-encryption-key.mjs` (`secret.rotated`, counts
only). The `logs -> correlation id -> worker/outbox` path is still the trace; there are no spans.

**What remains missing:** the `events` map is process-local (it resets on restart and is not shared across API
instances); the 24-hour counters are point-in-time database counts with no history; there is no alerting rule.
That is G77, not a claim that exporter-grade telemetry exists.

### Gate-detection proof (23.8 task 5)

A temporary DB-free test with one deliberately false security assertion was added to `packages/core/src`, and
`pnpm test:ci` exited **1** with `Test Files 1 failed | 88 passed` and `Tests 1 failed | 1419 passed`. The file was
removed immediately; no regression was committed. This proves the **local command** the nightly workflow invokes
fails on a security regression. A real GitHub scheduled run was **not** performed from this environment (no
throwaway branch was pushed), so the workflow-trigger half of task 5 remains deployment evidence, not claimed here.

## 10. Local equivalents

| Purpose | Command |
|---|---|
| What CI runs (no DB) | `pnpm ci:gate` |
| The full local gate (configured DB, AGENTS.md §3) | `pnpm verify` |
| Focused pure tests | `pnpm test:ci <path>` |
| Worker only | `pnpm test:worker` |
| Browser security spec (23.10) | `no_proxy='*' NO_PROXY='*' npx playwright test e2e/security-session-storage.spec.ts` |

## 11. Phase 23.10 additions and the layer they belong to

- `apps/api/test/phase23-10-security-regression.test.ts` boots the API and the configured database, so it is a
  **sandbox-layer** suite (like `acl-matrix.test.ts`). It is deliberately **not** in `vitest.ci.config.ts`: the
  nightly lane has no database service, and adding it would either provision one or silently skip the assertions.
  G92 therefore remains an exception.
- `e2e/security-session-storage.spec.ts` is a **Playwright** spec. It runs only where the browser stack is
  available (`npx playwright test` with the `no_proxy` workaround above); it is not part of `pnpm ci:gate` and its
  absence in CI is not a passing check.
- The DB-free gate is unchanged by 23.10: `pnpm test:ci` still runs the explicit `PURE_API_TESTS` include list, and
  no new security suite was added to it because none of the new assertions is DB-free.
