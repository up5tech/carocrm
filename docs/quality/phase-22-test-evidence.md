# Phase 22 — Test Evidence

> **Date:** 2026-10-29
> **Sub-phase under this record:** Phase 22.16 — Browser E2E critical paths (`PLAN_Phase_22_Integration_E2E_Hardening.md` §15)
> **Status:** Browser execution completed green for the Phase 22.16 critical-path spec (2026-10-29); full workstream evidence still to be accumulated through 22.24.

---

## Phase 22.16 — `e2e/critical-paths.spec.ts` (2026-10-29)

| Check | Command | Result |
|---|---|---|
| Lint (changed file) | `pnpm lint:changed` | 0 errors / 0 warnings (after `eslint --fix` on the import order) |
| Typecheck | `pnpm typecheck` | clean |
| Collection | `pnpm exec playwright test e2e/critical-paths.spec.ts --list` | 4 tests collected |
| Execution (with PostgreSQL + Redis up) | `pnpm exec playwright test e2e/critical-paths.spec.ts` | **4 passed (7.7s)** |
| Execution (before DB was reachable) | `pnpm exec playwright test e2e/critical-paths.spec.ts` | blocked at webServer (`pnpm db:seed` → `ECONNREFUSED 127.0.0.1:5432`) |

### 22.16 run detail — 4/4 passed

1. **a refused login answers with the error state and a retry completes the journey** — passed (888ms).
   - Failed sign-in renders the error state; retry with the real credentials completes the journey to `/home`.
2. **the login screen renders the secondary enabled locale rather than an English fallback** — passed (817ms).
   - Login screen copy resolves from the `vi` catalog (`Tên đăng nhập`, `Mật khẩu`, `Đăng nhập`); sign-in completes.
3. **a filtered list with no match answers with the empty state and its clear action** — passed (2.0s).
   - Filtered (text search) result with no rows renders the empty state and the clear action.
4. **a caller without read access gets the denial card on a list surface** — passed (1.4s).
   - Reader user created through the API (`AGENT_TEST_p22_noaccess_*`, `noAccess` role) is denied on a list surface with the denial card; cleanup deleted it.

### Environment notes

- PostgreSQL (5432) and Redis (6379) were started during this session and are required by the Playwright `webServer` (API seed/migrations + queue).
- Browser traffic needs `no_proxy='*' NO_PROXY='*'` (shell exports `HTTP_PROXY=127.0.0.1:62112`).
- `test-results` output dir must be moved aside before re-runs (Playwright bulk-delete guard).

### Known limitations for 22.16

- Logout round-trip and session-expiry-during-edit scenarios (plan §15) still have no browser spec.
- The full critical-path matrix (scenarios 2–10, 12) continues to live in the existing journey specs; 22.16 adds the error/denial/empty/locality boundaries.
