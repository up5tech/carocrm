# Phase 22.16 — Browser E2E critical paths

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §15
> **Status:** In progress — the critical-path browser spec landed (`e2e/critical-paths.spec.ts`); the first browser execution is pending this environment installing the Playwright chromium binary.

---

## 1. Objective

Test the actual React SPA and its public API contracts with the browser runner the repository already selected: **Playwright**, root `playwright.config.ts`, new specs in `e2e/*.spec.ts` (no new runner, no new spec framework, no third-party production sites in ordinary runs).

The critical-path browser suites that already existed (`crud`, `lead-conversion`, `sales-documents`, `omnichannel`, `ai-agents`, `projects`, `lead-score`, `search-import-dashboards`, `home`, `accessibility`) cover the happy critical journeys. Phase 22.16 owns the boundaries those suites could not reach from a DOM-less project or from unit assertions — the error, denial and empty states, and the locale copy the login screen is built from.

## 2. What this sub-phase added

New spec: `e2e/critical-paths.spec.ts` (`test.describe('Phase 22.16 — browser E2E critical paths')`).

| # | Test | What it proves |
|---|---|---|
| 1 | A refused login answers with the error state, and a retry completes the journey | The failed-operation path (plan §15 scenario 11): the screen shows the error state and the same screen recovers through the retry. |
| 2 | The login screen renders the secondary enabled locale rather than an English fallback | The "login is English-only" finding (G66, assigned here by 22.15): the secondary enabled catalog (`vi`) is now exercised in the browser, not just the English one. |
| 3 | A filtered list with no match answers with the empty state and its clear action | The empty state (G66): a filtered result with zero rows is not mistaken for an empty entity — the clear action is part of the answer. |
| 4 | A caller without read access gets the denial card on a list surface | The denial state (G66): a 403 on a list endpoint renders the denial card, not a crash, not an empty list. |

Selectors are user-facing (`getByLabel`, `getByRole`) rather than fragile CSS classes, per the tooling policy; credentials come from `E2E_ADMIN_LOGIN` / `E2E_ADMIN_PASSWORD`.

## 3. Coverage still ahead inside Phase 22.16

- Logout round-trip (scenario 1 tail) has no browser spec yet.
- Session expiry during an edit/action (scenario 12) has no browser spec yet.
- The remaining minimum scenarios (2, 3, 5–10) are owned by the existing journey specs listed above; Phase 22.16 should not duplicate them.
- The modal-focus and column-resize assertions that G67 deferred into this phase are still open and are a browser-spec concern (G66 kept them here deliberately).

## 4. Tooling policy conformance

- Playwright only (`@playwright/test` 1.64, root config, `e2e/*.spec.ts`).
- No new runner, no new database, no external provider calls; test data uses the seeded configured database and `AGENT_TEST_` markers where the suite writes.
- Browser traffic must run with `no_proxy='*' NO_PROXY='*'` (shell `HTTP_PROXY=127.0.0.1:62112`); `test-results` output dir must be moved aside before re-runs (bulk-delete guard).

## 5. Checks run in this session

| Check | Result |
|---|---|
| `pnpm lint:changed` (e2e/critical-paths.spec.ts) | 0 errors, 0 warnings |
| `pnpm typecheck` (API + web) | clean |

## 6. Pending before phase close

- Execute the new spec: `pnpm exec playwright test e2e/critical-paths.spec.ts` (after `pnpm exec playwright install chromium` in an environment that can host the webServer).
- Record the run in `docs/quality/phase-22-test-evidence.md` and close G66 / G67 dispositions.

## 7. Acceptance criteria (plan §15)

- [~] Critical browser journeys run deterministically and can run independently — the new spec is independent; the phase's full critical-path set is not yet consolidated in one place.
- [~] No unintentional live external side effects — intended; execution evidence pending.
- [~] Test selection uses user-visible contracts and selectors stable under minor UI refactoring — intended; execution evidence pending.
- [ ] Failure artifacts are sanitized and useful for triage — pending first real run.
