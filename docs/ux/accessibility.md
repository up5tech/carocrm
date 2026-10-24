# Accessibility (Phase 20, part B)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.8, §13.6 and sub-phase 20.16. Target: WCAG 2.2 AA.

This document records what is implemented, how it is verified, and — honestly — what is **not**
verified. The automated axe pass the plan asks for does not exist in this repository.

## Implemented

### Keyboard

| Surface | Keys | Where |
|---|---|---|
| Command palette | `⌘/Ctrl + K` opens it from any screen; arrows move, `Enter` opens, `Esc` dismisses | `apps/web/src/components/CommandPalette.tsx` |
| Edit form | `⌘/Ctrl + Enter` saves | `apps/web/src/pages/EntityEditPage.tsx` |
| Inline cell edit | `Enter` starts and saves, `Esc` cancels | `apps/web/src/pages/EntityListPage.tsx` |
| Stream post | `⌘/Ctrl + Enter` posts | `apps/web/src/pages/EntityDetailPage.tsx` |
| Layout editor | `Space` lifts a row, arrows move it, `Space` drops it (dnd-kit `KeyboardSensor`) | `apps/web/src/components/LayoutEditor.tsx` |

No interaction is drag-only. Every list that can be dragged also has move-up / move-down buttons.

### Focus

- `*:focus-visible { outline: 2px solid #1890ff; outline-offset: 2px; }` — a visible ring on
  keyboard navigation, absent on mouse click (`apps/web/src/styles/carocrm.css`).
- Modals are Ant Design dialogs, which trap focus and restore it on close.
- The palette returns focus to the invoking element on dismissal.

### ARIA

- `aria-label` on every icon-only control (the list's row delete, the palette input, the density
  select, the bulk bar).
- `role="toolbar"` on the floating bulk action bar, with `aria-live="polite"` on the selection count.
- `aria-current="page"` on the selected administration tab; the tab rail is a `<nav>` with a label.
- The settings shell renders a real `<button>` per tab, so tab order and activation follow the
  browser's defaults.

### Touch targets and motion

- Interactive controls follow the theme's 36 px control height, which clears the WCAG 2.5.8 AA
  24 × 24 target minimum without distorting dense rows. A blanket 44 px minimum was removed
  because it overrode `controlHeight`, stretched icon buttons into 44 px squares and pushed
  checkbox inputs outside their 16 px box. On coarse-pointer devices, fields and buttons grow
  together to a 44 px height so touch targets are larger without breaking row alignment.
- `@media (prefers-reduced-motion: reduce)` neutralises animations and transitions globally, and the
  administration tab / menu row transitions explicitly.

### Responsive

- ≥ 1180 px: the administration rail is a permanent column; below that it becomes an off-canvas
  drawer.
- ≤ 768 px: filters stack, the save bar and the bulk bar are constrained to the viewport, tables
  scroll horizontally instead of overflowing the page.
- ≤ 390 px: the save bar and the bulk bar get a `max-width` so they cannot cause horizontal
  overflow.

## Verification actually performed

- A manual keyboard walkthrough of the settings shell, the main menu tab, the list view, the record
  page and the command palette.
- A browser check at 1440 px, 768 px and 390 px for overflow and for the responsive rules above.
- The API test suite (`apps/api/test/`) covers the **server-side** half of accessibility: the
  permission matrix, the last-administrator rule, and the settings/navigation authorization rules.

## Known gaps

- **No automated axe audit.** The plan's acceptance for 20.16 ("axe passes on the four core
  surfaces") is **not met** — `axe-core` is not a dependency and no axe run exists. The manual
  walkthrough is a review, not a pass.
- **No frontend test runner.** `vitest.config.ts` includes `apps/api/test/**/*.test.ts` and
  `packages/*/src/**/*.test.ts` only, so there are no component tests and no focus/ARIA assertions.
- **Playwright smoke for Phase 20.** `e2e/accessibility.spec.ts` checks 390px overflow on list/detail/
  settings and a keyboard path to the command palette. It is a smoke test, not an axe audit.
- **Focus is not moved to the first invalid field** after a failed save.
- **The palette does not accept `/`** as a focus shortcut, and it caps results at 12 per group
  rather than the plan's 20.
- **Contrast was not measured.** The palette follows the Ant Design token set; no contrast audit
  was run against the `carocrm-*` layer.
- **`PermissionDenied.tsx` and `HelpTip.tsx` were unused at the time of this pass; both are used
  now** (a refused handbook page and the CRM chat workspace for the first, the Main Menu tab, the
  docs cross-links and the two template designers for the second). The permission-denied state of
  §5.7 is still not applied by the list, detail and dashboards pages.
