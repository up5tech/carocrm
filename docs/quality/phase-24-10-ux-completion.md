# Phase 24.10 — UX Completion

> **Status:** In progress — the UX gap inventory and the task status are recorded here (2026-11-16);
> implementation has not started. **No UX change has been made in this pass.**
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §16 (Phase 24.10 — UX Completion, P2)
> **Predecessor:** Phase 24.9 — provider sandbox certification (`docs/quality/phase-24-9-sandbox-certification.md`).

## 1. Objective

Close the experience gaps that make a capable single-tenant product feel slower and less complete than it is.

## 2. Task status (task 1 — re-measure)

`docs/ux/ui-review.md` (audit of the shipped SPA, dated 2026-10-25) and `docs/ux/list-view.md` (Phase 20, part B).

1. Re-measure both documents against the current tree, mark shipped items and correct stale status text.
   **Finding:** the shipped-item set the task names (dark mode, tokens, lazy routes, settings search,
   `document.title`, `EmptyState`) is covered by the Phase 20.20–20.27 sub-phases the audit already names;
   the audit itself is dated 2026-10-25, so a re-measure refresh of its status text is still owed before task 2
   starts.
2. Optimistic writes for the highest-value interactions first (board drag, inline edit, task toggle) via
   React Query `onMutate` with rollback and conflict handling. **Not started.**
3. Converge the two data-fetching paradigms (migrate `useEffect` fetch pages to React Query incrementally).
   **Not started.**
4. Chart library / rich-text editor decisions; replace hand-built CSS bar dashlets in `DashboardsPage.tsx`.
   **Not started.**
5. i18n beyond `en`/`vi` with reviewed translations and `pnpm lint:ui` parity. **Not started.**
6. Close G64 (142 SPA call sites rendering raw `error.message`) with the code-aware helper. **Not started.**
7. Browser specs for optimistic rollback, denied/empty/error states and rich-text sanitisation; refresh
   `docs/ux/*` with actual measurements. **Not started.**

## 3. Acceptance criteria status (task / plan §16)

| Criterion | Status |
| --- | --- |
| Key interactions no longer wait for a round trip before showing success, and a failed write rolls back visibly. | **Open** — task 2 not started. |
| No new XSS surface: rich text is sanitised and `pnpm lint:ui` passes. | **Open** — task 4/7 pending. |
| UX docs state measured, current numbers rather than 2026-10-25 numbers. | **Open** — task 1 refresh pending. |

## 4. Outstanding work

1. Re-measure and refresh `docs/ux/ui-review.md` and `docs/ux/list-view.md` status text.
2. Add optimistic writes (board drag, inline edit, task toggle) with rollback and conflict handling.
3. Converge data fetching to React Query incrementally.
4. Chart/rich-text/locale decisions; close G64.
5. Browser specs; refresh UX docs with actual measurements.

## 5. Verification

- `node scripts/check-ui-conventions.mjs` — docs gate, run after this record landed.
- No code, migration, database, provider or deployment change in this pass.
