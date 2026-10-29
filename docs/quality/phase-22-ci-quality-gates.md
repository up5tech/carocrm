# Phase 22.22 — CI Quality Gates

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §21
> **Status:** Complete for the owner-selected model — **GitHub Actions, scheduled/manual, DB-free**.
> Layers 1 and 2 run nightly; Layer 3 is sandbox-only by decision; browser/extended layers remain
> manual. G78 records the consequence (no PR gate).

---

## 1. Objective

Establish repeatable, layered CI checks that give a fast feedback loop and prevent known regression
classes from merging.

## 2. Owner decisions (task 0)

| Decision | Choice | Consequence |
|---|---|---|
| CI provider | **GitHub Actions** | `.github/workflows/quality-gate.yml`; the remote is GitHub. |
| Trigger | **Scheduled + manual dispatch** | The nightly run is an integrity check, not a merge gate (G78). |
| Integration layer | **Not in CI** | No Postgres/Redis service, no database secret, no migration execution; `pnpm verify` against the configured DB remains the sandbox/local gate. |
| Browser layer | **Not in CI** | Browser cache and an approved app environment are prerequisites; 22.16 owns functional evidence. |

The workflow was written only after these choices; task 0 explicitly requires that.

## 3. Tasks (plan §21) and status

1. **Inspect existing conventions** — done: `.github/` held only `copilot-instructions.md`, so there
   was no CI convention to preserve.
2. **Standardize command names** — added `test:ci`, `test:worker`, `ci:migrations`, `ci:secrets`,
   `ci:gate`; existing documented scripts (`test`, `verify`, `test:e2e`, `db:migrate`) are unchanged.
3. **Deterministic, time-bounded PR gates** — the scheduled job has `timeout-minutes: 45`; every layer
   is deterministic (no live provider, no clock-dependent test added by this phase).
4. **Safe cache keys** — only the pnpm store keyed by `pnpm-lock.yaml`; no `dist`/test-result cache.
5. **No parallel DB-writing tests** — CI has no database at all; the decision removes the class.
6. **No secrets in logs/artifacts** — no secret is used; `ci:secrets` scans tracked files and never
   prints a matched value; no artifact upload.
7. **Selective, sanitized failure artifacts** — none in CI (no browser); the rule for a future
   browser layer is documented and failure-only.
8. **No implicit external actions** — no deploy, provider callback, campaign, signature or real email.
9. **Actionable failures** — named steps; test output names file/test; module owner is the path;
   correlation ids apply to the sandbox/browser evidence, not to the DB-free gate.
10. **Document required/optional/sandbox/manual** — `docs/quality/ci-gates.md` §3.

## 4. What changed

### 4.1 `.github/workflows/quality-gate.yml`

One job on `ubuntu-latest`, Node 24, pnpm 10.0.0, `pnpm install --frozen-lockfile`, then
`pnpm ci:gate`. `permissions: contents: read`; `concurrency` cancels a superseded run; no `services:`,
no secrets, no artifacts, no deploy. Triggered at 02:00 UTC and via `workflow_dispatch`.

### 4.2 `vitest.ci.config.ts`

The root config collects `apps/api/test/**` and most of it boots the configured database. The CI
project includes:

- every `packages/*/src/**/*.test.ts`;
- an explicit list of **39 API suites** that import no boot helper, `DatabaseService`, `ctx.database`,
  `new Pool` or `pool.query` (provider contract, domain logic, money/decimal, recurrence, docs, etc.).

`test:worker` runs the worker's own 228 pure tests (`FakeDb`, fake queues/providers); `test:web` runs
the 31 node-environment SPA tests. The list is deliberately explicit: a new DB-backed suite must not
silently join the DB-free layer.

### 4.3 `scripts/check-migrations.mjs` (`ci:migrations`)

Reads `database/migrations/*.sql` without connecting anywhere and fails on: missing/duplicate/non-
increasing numeric prefix, empty file, or `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE`/unqualified
`DELETE FROM` without the reviewed marker `-- migration-safety: allow-destructive`. Current tree:
**86 files, clean**.

### 4.4 `scripts/check-secrets.mjs` (`ci:secrets`)

Scans **tracked** files (2 244) for high-confidence credential shapes (private key blocks, AWS/GitHub/
Slack/Stripe/Google/OpenAI token patterns) and a tracked `.env` file; masks findings and never prints
the value; skips binaries and files larger than 1 MB. Current tree: **clean**.

### 4.5 Documentation

`docs/quality/ci-gates.md` is the CI contract: decisions, runtime, layers, commands, cache, secrets,
artifacts, actionable failures, the flake register (G69/G75 with owner and 2026-11-15 review), gaps and
local equivalents.

## 5. Evidence

The gate was run with an **unreachable** database and Redis to prove it does not depend on either:

```
DATABASE_URL=postgres://nobody:nobody@127.0.0.1:1/none \
REDIS_URL=redis://127.0.0.1:1 CI=true NODE_ENV=test LOG_LEVEL=error \
pnpm ci:gate
```

Exit **0**:

| Stage | Result |
|---|---|
| `lint` (UI conventions + eslint) | clean |
| `lint:arch` (module boundaries) | clean |
| `typecheck` (root + web) | clean |
| `build` (all workspaces) | clean |
| `ci:migrations` | clean, 86 files, highest 086 |
| `test:ci` | **78 files / 1 311 tests passed** |
| `test:worker` | **22 files / 228 tests passed** |
| `test:web` | **7 files / 31 tests passed** |
| `ci:secrets` | clean, 2 244 tracked files |

Workflow YAML parsed successfully (Ruby YAML): `name`, trigger, `permissions`, `concurrency`, `jobs`;
the gate job has no `services`. No database row was read or written by this run.

## 6. Acceptance criteria (plan §21)

- [x] **Required gates are documented and work on the supported runtime.** `ci-gates.md` §1–§3; Node 24
  + pnpm 10; the local run above is the same sequence the workflow executes.
- [x] **CI never creates extra databases or runs live external actions implicitly.** No `services`, no
  `DATABASE_URL`/Redis secret, no migration execution, no provider call, no deploy, no artifact.
- [x] **Flaky tests are tracked and not silently ignored.** G69/G75/G79 are in the register with owner
  and review date; they do not run in DB-free CI, and the local `pnpm verify` still reports them
  instead of retrying (the 22.22 closing verify hit G69/G79, the next full run G75; each passes solo).

## 7. Known limitations

- **No PR gate** (G78): the nightly run detects a regression up to ~24 h late; the local `pnpm verify`
  remains the pre-merge habit. The closing `pnpm verify` was red on G69/G79 and the immediate full
  rerun on G75 — all shared-database flakes that pass solo — which is why they are tracked separately
  from the DB-free CI gate.
- **Integration/ACL/provider journeys are not in CI** (owner decision): use `pnpm verify` against the
  approved configured DB or a sandbox.
- **Browser E2E is manual/approved**; no browser is installed in the CI gate and no artifact is
  uploaded.
- **OpenAPI schema is not generated** (G1), so the public contract is not machine-diffed in CI.
- **Migrations are checked statically, not executed**; database migration rehearsal is 22.23.
- **Job queue/worker integration is not in CI**: the worker suite uses fakes; a real Redis round-trip
  stays sandbox-only.
