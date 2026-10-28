# Phase 22.15 — Shared UI/API consistency

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §14 (tasks 1–10) and its acceptance criteria
> **Tests:** `apps/api/test/error-payload-hygiene.test.ts` (6), `apps/web/src/lib/serverFieldErrors.test.ts` (6), `apps/web/src/components/SharedStates.test.tsx` (4), `node scripts/check-ui-conventions.mjs` (9 gate rules, `--self-test` included)
> **Depends on:** `docs/compatibility/settings-ux.md` (the Phase 20 shared-surface contract), `docs/quality/phase-22-capability-inventory.md` (22.3)
> **Status:** Implemented. Every check this sub-phase owns passes; the full gate is red on one pre-existing Sales test file (G69), which is not collateral of these changes — see §4.

---

## 1. What this sub-phase checked

§14 asks for something narrower than "test the frontend": that a **user-visible answer is the server's
answer**, on the shared surfaces every module renders through. So the pass went seam by seam:

| Seam | What was read | What it found |
|---|---|---|
| The error envelope | `global-exception.filter.ts` → `api/client.ts unwrap` → the ~150 `catch` sites | one envelope, correctly shaped, and **one leak**: a 5xx put the internal message into `details.reason`, which four components render by design (G54) |
| The shared list | `EntityListPage.tsx` (one component for every entity, server-side paging, race guard, `rowActions` from the server) | loading / empty / filtered / denied / error are five distinct states and are shared, not per module ✓; a throttled list ignored the number the server sent it (G56) |
| The shared edit form | `EntityEditPage.tsx` | no optimistic write at all (success is only announced after the response resolves) ✓; a refused save named its fields in the response and marked **none** of them on screen (G55) |
| Revalidation after high-impact actions | conversion, sales transitions, case handoff, agent runs, chat actions, record rename | five of the seven revalidate correctly; the chat action card rendered its own decision instead of the server's (G62); a core rename/delete leaves module panels stale until refetch (G68 — bounded by `refetchOnWindowFocus: 'always'`, recorded not patched) |
| Route guard vs API authorization | `AppRoutes.tsx`, `AppShell` navigation, per-module `action/capabilities` | menu and data are server-filtered ✓; the routes themselves are guarded only by session (G63), and three home components pick content from `principal.roles`, a rule no server check mirrors (G65) |
| Locale, timezone, edge cases | `state/i18n.ts` formatters, `EmptyState`, long names, `—` for a missing value | thirteen screens formatted dates with the **host** locale/zone and seven with the host number format (G57); the placeholder dash was black-on-black in dark mode (G58) |
| Leaking internals | `.stack`, `SQLSTATE`, raw `JSON.stringify(response)`, `AppErrorBoundary` | nothing renders a stack or a payload; the boundary shows `error.message` only in `DEV`; one site decided "module not installed" from a message containing `"404"` (G60) and one chat string was hard-coded English (G61) |
| Accessibility of shared states | `ErrorState`, `PermissionDenied`, `LoadingSkeleton`, modals, bulk bar | `Alert` already answers `role="alert"` ✓; the loading skeleton said nothing at all (G59); column resize is mouse-only and modal focus rests on antd defaults with no assertion (G67) |

## 2. The fixes

Every one is at the seam that owns it, and every one is small enough to read in place.

| # | Fix | Where |
|---|---|---|
| 1 | A 5xx answers from a fixed sentence with no `details.reason`, in either catalog state. The internal text stays where it belongs — the log line with the request id | [global-exception.filter.ts:126](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/common/global-exception.filter.ts#L126) |
| 2 | `serverFieldErrors(error, fieldNames)` — maps a 400/422 refusal onto the fields this form renders, from both shapes the API uses (`details.<field>` and `details.errors.<field>`), and answers nothing for 403/404/409/5xx | [serverFieldErrors.ts](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/lib/serverFieldErrors.ts) |
| 3 | The shared edit page marks those inputs, scrolls to the first and focuses it, and reserves the toast for the case with no field to blame | [EntityEditPage.tsx:399](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/pages/EntityEditPage.tsx#L399) |
| 4 | A throttled list names the wait using the server's own `details.retryAfterSeconds` | [EntityListPage.tsx:307](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/pages/EntityListPage.tsx#L307) |
| 5 | Twenty-two date sites and seven number sites now go through `formatDateTime` / `formatClock` / `formatNumber` | 15 files in `apps/web/src` |
| 6 | Three theme-breaking alpha literals replaced by tokens that carry dark values (`--carocrm-c-8c8c8c`, `--carocrm-surface-sunken`) | `components/fields.tsx`, `crm-chat/CRMChatActionCard.tsx`, `admin/tabs/ESignatureSettingsTab.tsx` |
| 7 | The loading skeleton announces itself: `role="status"`, a polite live region, a visually hidden label in the reader's language | [LoadingSkeleton.tsx](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/components/LoadingSkeleton.tsx) |
| 8 | The webhooks tab reads the HTTP **status** to decide the module is not installed; the chat composer's failure string is a catalog key in both locales | `admin/tabs/WebhooksTab.tsx`, `crm-chat/CRMChatComposer.tsx` |
| 9 | A chat decision invalidates the action's own query, so the card shows the server's answer rather than the response that produced it | [CRMChatActionCard.tsx:48](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/pages/crm-chat/CRMChatActionCard.tsx#L48) |

## 3. The gate, so the two silent classes cannot come back

`scripts/check-ui-conventions.mjs` grew from five rules to seven (its `--self-test`, which `pnpm test:web`
runs, is now nine checks). The two additions are the two defects this pass found that no existing rule
could see:

- **No host-locale date formatting outside `state/i18n.ts`.** `new Date(x).toLocaleString()` is a claim
  about the browser's zone, printed beside a page that speaks the user's. Numbers are exempt — only a
  date is a timezone claim.
- **No black or white alpha literal as a `color`/`background`.** Shadows are exempt because they read the
  same in both themes by design; a text or surface literal is a colour that stops following the theme,
  which is precisely how an empty-field dash became invisible.

The old rule set already refused a hex literal outside `tokens.css`, so `rgba(0,0,0,0.25)` was the
working loophole. Both rules carry a seeded-violation case in `--self-test`, so a broken regex fails the
build instead of quietly stopping enforcing.

## 4. Evidence

| Check | Result |
|---|---|
| `pnpm exec vitest run --config vitest.web.config.ts` | **7 files / 31 tests passed** (was 5 / 21; +`serverFieldErrors`, +`SharedStates`) |
| `pnpm exec vitest run apps/api/test/error-payload-hygiene.test.ts` | **6 passed** |
| `node scripts/check-ui-conventions.mjs` | `ui conventions: clean (4916 keys checked)` |
| `node scripts/check-ui-conventions.mjs --self-test` | `ok (9 rules each catch a seeded violation)` |
| `pnpm typecheck` (API project + `apps/web/tsconfig.json`) | no diagnostics |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| Success-before-confirmation scan over `apps/web/src` (every `message.success` against its own call) | no site announces success before the server answers; the one optimistic write (`WebhooksTab` toggle) restores the previous cache on failure |
| `pnpm verify` | **Red on one pre-existing file.** lint 0/0, typecheck (both projects) clean, `pnpm test:web` 7 files / 31 tests ✓; `pnpm test` 244 files / 3,283 tests passed and `apps/api/test/sales-tracking.test.ts` failed (`19-S.15` lot traceability, `expected undefined to be 'LOT-A'`). Reproduced with this sub-phase's only API change reverted to `HEAD`, so it is not collateral of 22.15 — recorded as G69 with what was and was not diagnosed, rather than skipped or worked around. |

## 5. Known limitations

1. The web test project has no DOM (`environment: 'node'`, no jsdom or testing-library in the
   dependency set), so component tests assert **structure** — roles, live regions, the presence of the
   action — through `renderToStaticMarkup`. Interaction (focus return, keyboard resize, a refusal that
   renders on the input it belongs to) is a browser assertion and belongs to Phase 22.16, where
   G66 records it.
2. `t()` returns the key when no catalog is loaded, which is the node project's state, so wording is
   deliberately not asserted here.
3. The route-guard question (G63) is recorded, not fixed: a capability→route map is a product decision,
   and today's behaviour fails safe because the data call under it is still refused.
4. ~150 call sites still render `error.message` directly (G64). This pass fixed the cases that were
   *wrong* — fields, rate limit, internals — not the style of every `catch`.
5. Nothing here was checked in a browser by me; the visual result of the token and formatter changes
   should be seen once in light and dark mode before release.

## 6. Acceptance criteria (plan §14)

- [x] **Shared components handle success, validation error, permission denied, conflict and server
  failure consistently.** The validation case is now field-level and shared; the denial case is one card;
  the conflict case stays a decision rather than a red field; the server-failure case answers a code and
  a fixed sentence and shows nothing else (G54–G56).
- [x] **A critical action button cannot display success before the server confirms completion.** Scanned
  across the SPA and confirmed by reading every flagged site; the optimistic exception restores the
  previous state on failure, and the one card that showed its *own* result rather than the server's is
  fixed (G62).
- [~] **Loading, empty, partial, retry, success and failure are distinguishable** — distinguishable and
  shared ✓, and now announced to a screen reader in the loading case; the browser assertion is G66.
- [ ] **Route guards and API authorization agree.** They agree on outcome; they do not yet agree on the
  moment, and the client-side role checks on the home page are recorded (G63, G65) rather than patched.
