# Phase 24.10 — UX Completion

> **Status:** Implemented 2026-11-17 — all seven tasks are dispositioned below with evidence; two items are
> recorded as deliberate non-changes (chart library, additional locales) rather than silently skipped.
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §16 (Phase 24.10 — UX Completion, P2)
> **Predecessor:** Phase 24.9 — provider sandbox certification (`docs/quality/phase-24-9-sandbox-certification.md`).

## 1. Objective

Close the experience gaps that make a capable single-tenant product feel slower and less complete than it is.

## 2. Task status

1. **Re-measure UX docs — done.** `docs/ux/ui-review.md` and `docs/ux/list-view.md` were re-measured against the
   current tree on 2026-11-17: CSS/token counts, inline-style and `<Empty>` usage, i18n key parity (5 179/5 179
   `en`/`vi`), bundle sizes, breakpoint inventory and shipped-vs-open status text all reflect the present code.
   `docs/ux/list-view.md` was rewritten; it previously described a list view without the bulk bar, undo and
   column management that `EntityListPage.tsx` now ships.
2. **Optimistic writes — done for the surfaces that exist.**
   - Project plan drag-and-drop and task transitions (start/complete/cancel): optimistic cache updates through
     the shared `useOptimisticProjectMutation` helper in `apps/web/src/pages/projects/projectShared.tsx`,
     built on React Query `onMutate` — queries cancelled, prior cache snapshotted, optimistic transform
     applied, snapshot restored on error, invalidate on settle. `ProjectPlanPage.tsx`, `ProjectBoardPage.tsx`.
   - Process task completion toggle: already optimistic in `TasksPage.tsx` (cancel/snapshot/rollback/invalidate);
     its error path now reports through the shared `errorMessage` helper.
   - "Inline edit": the SPA has **no cell-level inline-edit surface** — record editing is a guarded form
     (`EntityDetailPage` → edit screen) where the plan forbids disabling server validation or the
     unsaved-changes guard, so there is nothing to make optimistic. List-page quick writes (bulk update,
     delete, follow) already carry undo snapshots. If a cell-inline editor is added later it must reuse the
     same `onMutate` rollback pattern; this is recorded so the gap is not mistaken for an omission.
   - Conflict/authorization refusal: server refusals (including `version` conflicts on project tasks) roll the
     cache back to the snapshot and surface a code-aware message; `e2e/optimistic-writes.spec.ts` proves the
     rollback path in a real browser (task deleted server-side → transition refused → pill returns to
     "Not Started").
3. **React Query migration — incremental, three pages done.** `SearchPage` (executed search as query state),
   `StreamPage` (`useInfiniteQuery` for load-more paging) and `ServiceDeskDashboardPage` now fetch through
   React Query with the same loading/empty/error/denied states. The remaining `useEffect` fetch pages are a
   long tail; migrating them is mechanical and tracked as ongoing debt, not a Phase 24.10 blocker — the
   plan asked for incremental convergence, not a flag-day rewrite.
4. **Chart / rich-text decisions — recorded, no new dependencies.**
   - *Chart:* the only chart surface is the dashboard `chart` dashlet, which renders grouped counts as
     horizontal bars (`DashletResult.tsx`). That is sufficient for the dashlet kinds that exist (bar list,
     KPI progress, table); a chart library (recharts/chart.js, ~100 KB+ parsed) buys axis/legend/tooltip
     features no current dashlet needs. **Decision: no chart dependency**; revisit if line/pie/time-series
     dashlets are scheduled.
   - *Rich text:* the SPA has no rich-text field type and zero `dangerouslySetInnerHTML` paths — `FieldValue`
     renders through React escaping, `DocInline` builds React elements, and email-template preview is
     server-rendered. **Decision: no editor or sanitizer dependency**; `fields.test.tsx` locks the
     escaping behaviour in with an XSS-payload regression test.
5. **i18n — parity maintained, no new locales.** `en`/`vi` sit at exact key parity (5 179 each) and pass
   `check-ui-conventions.mjs`. **Decision: no additional locales** — each new locale multiplies the parity
   surface for a single-tenant deployment whose users are covered by the existing two; add one when a real
   customer locale is requested.
6. **G64 closed.** ~150 raw `error.message` render sites now go through `apps/web/src/lib/errors.ts`
   `errorMessage()`, which understands `ApiError` codes and `details.issues` in both string and
   `{path, message}` form. `check-ui-conventions.mjs` rule 9 rejects the old pattern. See
   `docs/quality/known-gaps.md` G64 and `docs/security/exception-register.md`.
7. **Browser coverage — done where the product has the surface.** `e2e/optimistic-writes.spec.ts` (new,
   passing) covers optimistic rollback against the real API. Denied/empty/error browser states were already
   covered by `e2e/critical-paths.spec.ts` (refused login error state, filtered empty state, 403 denial
   card, Vietnamese locale login). Rich-text sanitisation is covered by `fields.test.tsx` — appropriate
   because no browser-reachable rich-text surface exists (see task 4).

## 3. Acceptance criteria status (task / plan §16)

| Criterion | Status |
| --- | --- |
| Key interactions no longer wait for a round trip before showing success, and a failed write rolls back visibly. | **Met** for board drag, task transitions/toggles; see task 2 for the inline-edit interpretation. |
| No new XSS surface: rich text is sanitised and `pnpm lint:ui` passes. | **Met** — no rich-text surface was added; escaping is regression-tested; `check-ui-conventions.mjs` clean. |
| UX docs state measured, current numbers rather than 2026-10-25 numbers. | **Met** — both docs re-measured 2026-11-17. |

## 4. Outstanding work

1. The `useEffect` → React Query tail (incremental, not blocking).
2. G66/G67 residuals: modal focus-trap assertions and keyboard-operable column resize remain open in
   `docs/quality/known-gaps.md`.

## 5. Verification actually run (2026-11-17)

- `pnpm --filter @carocrm/web typecheck` — clean.
- `pnpm --filter @carocrm/web lint` — clean (after `eslint --fix` import sorting).
- `pnpm --filter @carocrm/api typecheck` — clean (includes the G95 trigger change).
- `node scripts/check-ui-conventions.mjs` — clean, 9 rules incl. the new error-render rule (5 179 keys).
- `pnpm --filter @carocrm/web test` — 17 files / 98 tests pass (incl. new `fields.test.tsx`,
  `projectShared.test.ts`).
- `pnpm exec vitest run apps/api/test/ai-agent-triggers.test.ts` — 16/16 pass (incl. the G95 regression).
- `pnpm exec playwright test e2e/optimistic-writes.spec.ts` — 1/1 pass (chromium).
- `pnpm verify` (full repo) — **not run** in this pass; run it before release sign-off.
