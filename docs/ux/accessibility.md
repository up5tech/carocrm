# Accessibility (Phase 20, part B)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.8, §13.6 and sub-phase 20.16. Target: WCAG 2.2 AA.

This document records what is implemented, how it is verified, and — honestly — what is **not**
verified. As of §20.26 the SPA has an automated gate (`pnpm lint:ui` + `pnpm test:web`), but that gate
is **not** an axe audit: it checks tokens, formatters, the empty-state contract and the conventions,
not rendered contrast or ARIA on a live surface.

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

## What the gate checks (§20.26)

`pnpm lint:ui` runs `scripts/check-ui-conventions.mjs` and fails on each of these (every one was a
shipped defect first, not a style preference):

1. a `t('…')` key that is missing from `i18n/en` (the UI would render the raw key);
2. a `.slice(0, 19)` timestamp (prints UTC while the page prints the user's zone);
3. a raw `<Empty>` outside `EmptyState.tsx` (the four empty situations must stay distinct);
4. an internal `<a href="/…">` (a full page load drops SPA state);
5. a hex colour literal outside `tokens.css` (and `theme.ts` must stay literal-free);
6. a `var(--carocrm-…, #literal)` fallback — the literal wins whenever the property is missing, so
   the colour never follows the theme (this is how a light chat bubble survived into dark mode);
7. a `--carocrm-*` token that is not declared in `tokens.css`, or that has no dark value in the
   `[data-theme="dark"]` block — a token without one keeps its light colour in dark mode and paints
   a white panel in a dark shell.

`node scripts/check-ui-conventions.mjs --self-test` proves each rule still catches a seeded
violation, and a docs-truth rule refuses a "Still open" entry that names a feature the code ships.

`pnpm test:web` (Vitest, `node` environment, no jsdom) adds 15 assertions:

- **Tokens** — `carocrm.css` has zero hex literals, every `--carocrm-*` it uses is declared in
  `tokens.css`, the five themable accent tokens exist (§20.20), and every declared token has a
  dark value (§20.21).
- **Formatters** — `formatDateTime`/`formatClock`/`formatRelative`/`formatNumber` are locale- and
  timezone-aware and never emit a raw ISO slice or `Invalid Date` (§20.23).
- **Empty state** — the title is the primary line, the four variants render distinct copy, and the
  action slot renders (§20.22).
- **Gate** — the convention script passes on the tree and catches a seeded violation in every rule.

Still performed manually (a review, not a pass): a keyboard walkthrough of the settings shell, the
main menu tab, the list view, the record page and the command palette; a browser check at 1440 / 768 /
390 px. The API suite (`apps/api/test/`) covers the **server-side** half: the permission matrix, the
last-administrator rule, and settings/navigation authorization.

## What the gate does **not** check

- **The axe audit runs, and it runs on a real browser render.** Since the axe piece of §20.26 landed
  (2026-10-26), `e2e/accessibility.spec.ts` scans **home, list, record and settings** with
  `@axe-core/playwright` under the WCAG 2.0 A/AA tags and asserts **zero violations** — the
  β criterion of §20.16 ("axe passes on the four core surfaces") is now met by command
  (`npx playwright test e2e/accessibility.spec.ts --project=chromium`), not by a walkthrough.
  The same four surfaces are scanned a second time with the `theme` preference set to `dark`
  (§20.21): the dark pass is what showed that the Ant Design theme carried light-mode values —
  `Layout.bodyBg`, `colorTextBase`, the Menu/Card/Table slots — that the dark algorithm does not
  recompute, so the content area stayed light inside a dark shell. The theme is now built per mode
  from `theme/tokens.ts` and every `--carocrm-*` token has a dark value.
  The shared QA webs for it are real fixes to the shipped surfaces: ink tokens raised to AA
  (#66707a secondary/muted, #6e7681 faint), the selection accent colour moved to each accent's
  *strong* tone (the plain accent on the soft selection background was 2.98:1), `colorPrimary`
  and `colorLink` follow the strong tone (white on the plain accent was 3.2:1 on a primary
  button), the settings save-bar `Typography.Text` repainted from `colorTextDescription` —
  Ant Design's own 2.47:1 default — the footer, the status pills and the next-action label all
  repainted to AA, the unnamed antd `Select`s in the list filters, the saved-filters picker and
  every row-selection checkbox gained `aria-label`, and the antd table's measure row is now
  `visibility: hidden` so it stops hiding a tabbable element. What remains **not** certified:
  the seven *non-default* brand accent tones pass the same gate only where their `strong` tone
  clears AA (blue, purple, magenta); the scan covers WCAG 2.0 A/AA, not 2.1/2.2 rules; and the
  keyboard/first-invalid-field focus path is still asserted manually, not automatically.
- **Automated contrast beyond the axe rule.** Axe's colour-contrast rule checked the four surfaces
  above and passed; there is no separate sweep over every remaining combination of the token set.
- **Interaction and focus are partially asserted.** The axe scan covers ARIA structure and labelling
  automatically; keyboard paths and focus restoration are a manual walkthrough. The first-invalid-field
  focus move after a failed save **is** implemented (`EntityEditPage` scrolls to and focuses the first
  field with an error) but is not asserted by a test.
- **Responsive layout is partly asserted.** The 390 px overflow smoke and the axe scans are automated;
  the 1440 / 768 walkthroughs remain manual.
- **`PermissionDenied.tsx` and `HelpTip.tsx` are used now** (a refused handbook page and the CRM chat
  workspace for the first; the Main Menu tab, docs cross-links and the two template designers for the
  second). The permission-denied state of §5.7 is still not applied by the list, detail and dashboards
  pages, which keep their own error markup.
