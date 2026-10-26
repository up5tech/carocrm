# UI/UX review — 2026-10-25

A read-only audit of the shipped SPA (`apps/web`), taken after Phase 20.19, to decide what the
Phase 20 UX half still needs. It is a **review plus a proposal**, not a redesign: everything below is
expressed in the existing `carocrm-*` design language and the existing kernel (metadata, ACL,
`/Preferences`, admin descriptors). The proposed sub-phases 20.20–20.27 are written into
`PLAN_Phase_20_Settings_UX.md` §17.

Every number in this document was measured on the working tree at commit time; the command that
produces it is listed in §7 so the review can be re-run instead of trusted.

**Status (2026-10-26):** F1, F2, F8, F14, F15 and F16 are fixed, F3 is partly fixed — sub-phases
20.22 and 20.23 shipped. F11 (no token layer) is addressed by **20.20** (tokens + brand colour, shipped
2026-10-26); F12 (breakpoints) is deferred within 20.20. F4–F7, F9–F10, F13 remain open and are
scheduled as 20.24, 20.25, 20.26, 20.27 (and 20.21, dark mode, a decision).

---

## 1. Scope and method

| Area | What was inspected |
|---|---|
| Shell and navigation | `components/AppShell.tsx`, `state/favorites.ts`, `components/CommandPalette.tsx` |
| Home workspace | `pages/HomePage.tsx`, `pages/home/*` |
| List and board | `pages/EntityListPage.tsx`, `pages/EntityBoardPage.tsx`, `components/ColumnManager.tsx` |
| Record page and forms | `pages/EntityDetailPage.tsx`, `pages/EntityEditPage.tsx`, `components/RecordHeader.tsx`, `components/NextActionBand.tsx`, `components/fields.tsx` |
| Administration | `admin/AdminSettingsShell.tsx`, `admin/tabs.ts`, `admin/tabs/*` |
| Module surfaces | Sales, Service Desk, Customer Success, Voice, Chat, E-signature, Lead Score, Projects, Docs, AI Agents |
| States and feedback | `components/{EmptyState,ErrorState,PermissionDenied,LoadingSkeleton}.tsx` and their adoption |
| Design system | `styles/carocrm.css` (7 972 lines), `theme.ts` |
| Output | built `dist/assets`, `i18n/{en,vi}` |

Method: static inspection of the source, plus the built bundle and the i18n catalogues. No product
surface was changed by this review. Interactive checks (keyboard walkthrough, screen sizes) are
listed as *unverified* where this review could not run them.

---

## 2. Scorecard

Scored 1–5 on "would a daily user call this good", against the bar the phase itself set (WCAG 2.2 AA,
keyboard reachable, designed states everywhere).

| Surface | Score | Why |
|---|---|---|
| Shell and navigation | 4 | Server-resolved menu, favorites group, drawer on mobile, skip link, palette. |
| Command palette | 4 | ⌘K and `/`, three modes, capping, focus restore. |
| Home workspace | 4 | Role-aware, bounded requests, designed empty states. |
| List view | 4 | URL state, saved views, column manager, resize, inline edit, bulk + undo, kebab. |
| Board (Kanban) | 3 | Keyboard sensor present, but a drop reloads the whole board (no optimistic write). |
| Record page | 4 | Sticky header, next-action band, relation tabs, unsaved guard. |
| Forms | 3 | Works, but no "Save & new", no focus move to the first invalid field. |
| Administration | 3 | Strong shell, 21 tabs, **no search** — finding one setting is guesswork. |
| Design system | 2 | 733 hex literals, no token layer, 986 inline styles, 16 breakpoints. |
| States and feedback | 3 | Boundary, offline banner and one empty state landed in 20.22; adoption is now enforced by `pnpm lint:ui`. |
| Data presentation | 4 | 20.23 routed every admin/ops timestamp through the locale/timezone formatter. |
| Performance | 2 | One 2.62 MB initial chunk carrying every module screen. |
| i18n | 4 | 4 666 of 4 668 keys translated; locale-aware dates and numbers with a real timezone. |
| Accessibility | 3 | 210 `aria-label`s, skip link, live region, reduced-motion, focus-visible; heading outline and route-change focus are the gaps. |

---

## 3. Findings

Severity: **P0** = a user can be blocked or shown something false · **P1** = friction on every use ·
**P2** = polish.

### P0

**F1 — One thrown render white-screens the whole SPA.** ✅ fixed in 20.22 (`AppErrorBoundary`,
root + per route).
`grep -rn "componentDidCatch|ErrorBoundary|getDerivedStateFromError"` over `apps/web/src` returns
nothing. React unmounts the tree on an uncaught render error, so a single bad field definition, a
`null` dereference in a dashlet, or a malformed record payload leaves a blank page with no recovery
path but a manual reload. The shell is otherwise careful about failure (per-panel 403 handling), so
this is the one hole in an otherwise defensive surface.
*Fix:* a root boundary plus a per-route boundary that keeps the chrome and offers Reload / Back.

**F2 — Admin and ops screens print UTC as if it were local time.** ✅ fixed in 20.23 (14 call sites;
`pnpm lint:ui` keeps it fixed).
`formatDateTime` / `formatClock` in `state/i18n.ts` are correct — locale-aware and timezone-aware.
Fourteen call sites skip them and slice the ISO string instead
(`value.slice(0, 19).replace('T', ' ')`), in 10 files: `AdminAuditPage`, `AdminJobsPage`,
`AdminExtensionsPage`, `WorkflowsPage`, `WorkflowEditorPage`, `ProcessesPage`, `ProcessEditorPage`,
`TasksPage`, `ProcessPanel`, `ProcessTrailModal`. An operator in UTC+7 reading the audit log sees a
timestamp seven hours earlier than the one the same record shows on its own page. The instance's
`defaultTimezone` setting has no effect on any of them.
*Fix:* route them through `formatDateTime`; add a convention check so the pattern cannot return.

**F3 — A failed fetch on several pages is indistinguishable from "no data".** ✅ partly fixed in
20.22 (`AdminAuditPage` has an error path; 41 raw `<Empty>` migrated and gated).
`AdminAuditPage` has `try { … } finally { setLoading(false) }` and no `catch`: a 500 leaves an empty
table and no message. The same shape (load flag + silent empty) appears in other admin screens. The
shared `ErrorState` exists and is used correctly in `AdminSettingsShell`, `EntityListPage` and a few
modules — adoption, not capability, is the problem: **9 files** import `EmptyState` while **54**
raw `<Empty>` remain; `LoadingSkeleton` reaches 16 files while 15 still use a bare `Spin`.
*Fix:* make the shared components the only legal path (see 20.22).

**F4 — The initial bundle carries every module screen.**
`dist/assets/index-*.js` is **2.62 MB**; only the 21 admin tabs and the email editor are split
(27 chunks total). `AppRoutes.tsx` statically imports all 46 page modules across its 67 routes, so opening the
sign-in page downloads Projects, Gantt, Voice, Chat, AI Agents and the Docs reader. On a phone over 4G this
is the difference between "opens" and "loads".

### P1

**F5 — The page title has three different implementations.**
18 files render a real `<h1>` (12 of them with the shared `carocrm-page-title` class); 14 places
render that class on `Typography.Title level={4}` or `level={5}`; the remaining page modules have no
page head at all (they are workspaces with their own head — legitimate — or admin cards, which are
not). The heading distribution across the SPA is h1 ×19, h2 ×9, h3 ×4, and **h5 ×33**: the level used
for a page title, a section title and a card title is the same. For a screen-reader user the document
outline carries no information.

**F6 — Every browser tab says "CaroCRM".**
`document.title` is written in exactly one place (`state/settings.ts`), from the instance brand. No
screen contributes its page name. With five records open, the tab strip is five identical titles, and
a bookmark or a history entry cannot be told apart.

**F7 — SPA navigation is silent to assistive technology.**
`#carocrm-content` has `tabIndex={-1}` and a skip link points at it, but nothing focuses it on a
route change and nothing announces the new page. A keyboard user who activates a sidebar link lands
on a new page with focus still in the sidebar; a screen-reader user hears nothing.

**F8 — No offline state.** ✅ fixed in 20.22 (`OfflineBanner` on `onlineManager`).
Phase 20 §1.1 asks for "offline states everywhere". There is no `navigator.onLine` listener and no
"you are offline" affordance anywhere in the SPA; a rep in a lift gets a red toast per request and no
explanation. `refetchOnWindowFocus: false` compounds it: a tab left open overnight shows yesterday's
pipeline until the user reloads by hand.

**F9 — Settings cannot be searched.**
21 tabs behind a rail with no filter. "Where is the timezone?" / "where is SMTP?" / "where do I set
the default dashboard?" are all answered by clicking. Every leading CRM puts a find-a-setting box on
this screen, and the palette — which already exists and already knows how to filter — does not index
settings at all.

**F10 — Every write waits for a round trip, then toasts.**
171 `message.success` calls and **0** `onMutate`: no optimistic update anywhere. Dragging a card on
the board re-fetches the board; toggling a task re-fetches the list; inline edit re-fetches the page.
The interaction feels slower than the server is.

### P2

**F11 — The design system has no tokens.** `carocrm.css` contains **733** hex literals and **27**
`var(--…)` uses; the only custom properties in the file are five `--home-*` values scoped to
`.carocrm-home` (added in 20.19). `theme.ts` repeats the same colours in TypeScript. Five off-palette
blues (`#3d6fbf`, `#7cb0ff`, `#1f6fe0`, `#8b939d`, `#a7aeb8`) appear in the CSS but not in the theme,
which is how a palette drifts. 986 inline `style={{…}}` objects in TSX, including 17 hardcoded
`#438eff`. Consequence: the brand setting can change the logo and the page title but **not the
colour**, and a dark theme is not reachable at all.

**F12 — 16 distinct breakpoints across 49 media queries**, including near-duplicate pairs
(767/768/769, 899/900, 991/992, 1179/1180) and one-offs (480, 520, 640, 720, 1024, 1280). A layout
bug at 768 has to be fixed in four places.

**F13 — Two data-fetching paradigms.** 80 files use React Query; 41 pages fetch in a `useEffect` with
their own `loading` flag. The second pattern is where the missing error states (F3) and the stale
screens live.

**F14 — `EmptyState`'s own hierarchy is inverted.** ✅ fixed in 20.22 (title above hint, four
variants, action slot). It passes `title` into antd `Empty`'s *children*
slot, which renders **below** the description in the action area. The component added to standardise
empty states renders the primary line as a footnote.

**F16 — A shared list link lost its search term on reload.** ✅ fixed in 20.22 (found while verifying
it). `/Account?q=acme` ran the search, then a second, unfiltered request replaced it and the address
bar lost `q`. The query was held twice — component state seeded from the URL, and the URL written back
by a sync effect — so a remount that read a stale `useSearchParams()` seeded the state with `''` and
the sync effect then deleted the parameter. This is the one failure the phase's own "a link is the
unit of sharing" principle cannot tolerate: the recipient saw a different list than the sender.

**F15 — The deferral list is stale.** ✅ reconciled on 2026-10-25
(`docs/compatibility/settings-ux.md`, "Status reconciliation"). `docs/compatibility/settings-ux.md` still lists the row kebab
menu, column resize/reorder, the Favorites group, the `/` shortcut, the sticky record header and the
next-action band as "not built". All six ship today. A deferral list nobody reconciles stops being a
contract and becomes a false statement about the product.

---

## 4. What already works, and should not be touched

Worth stating explicitly so the upgrade list does not turn into a rewrite:

- **The server decides what exists.** Menu, admin rail, row actions and tab visibility all come from
  the API. No client-side role guessing anywhere. This is the single best structural decision in the
  UI and every proposal below preserves it.
- **List state lives in the URL**, saved views are server records, columns and widths are per-account
  preferences. Sharing a link shares the screen.
- **The record page** has the pieces most CRMs take years to add: sticky identity header, computed
  next action, relation tabs arranged by the entity's layout, unsaved-changes guard.
- **Keyboard coverage** is real: palette, `⌘/Ctrl+Enter` save, `Enter`/`Esc` inline edit, dnd-kit
  keyboard sensor in the layout editor, "move up/down" buttons instead of drag in the column manager.
- **i18n is nearly complete** (4 666 / 4 668 keys, `en` + `vi`) and dates, numbers and clocks are
  locale- and timezone-aware — which is exactly what makes F2 a bug rather than a gap.
- **Responsive work is deliberate**: 260 px rail → off-canvas drawer under 768, two separate state
  variables so a resize cannot open the drawer, `prefers-reduced-motion`, `pointer: coarse` targets,
  print styles for documents.

---

## 5. Proposed upgrade path

Seven sub-phases, ordered by dependency and by how much they unlock. Full scope, acceptance criteria
and verification plans are in `PLAN_Phase_20_Settings_UX.md` §17.

| # | Sub-phase | Priority | Depends on | Why it is worth the work |
|---|---|---|---|---|
| 20.20 | Design token layer + brand colour | P0 | — | Turns 733 hex literals into one token set; makes the brand setting real; unblocks 20.21. |
| 20.22 | State contract and error boundary | P0 | — | Closes F1/F3/F8/F14: no white screens, no silent failures, one way to render a state. |
| 20.23 | One formatter for time, numbers, durations | P0 | — | Closes F2 with a convention check, not a code review habit. |
| 20.24 | Page frame: header, title, focus, headings | P1 | — | Closes F5/F6/F7; one component replaces three patterns. |
| 20.25 | Find a setting (search + palette group) | P1 | — | Closes F9 with descriptors the server already owns. |
| 20.26 | Frontend quality gate | P0 | 20.20–20.25 | The plan's own 20.16 acceptance ("axe passes") is unmet because there is no runner. Without this, everything above regresses. |
| 20.27 | Route-level code splitting and optimistic writes | P1 | — | Closes F4/F10: 2.62 MB → a bounded first chunk; drags and toggles that answer instantly. |
| 20.21 | Dark mode | P2 | 20.20 | The only item the current plan calls out of scope; becomes cheap once tokens exist, and expensive to retrofit later. |

Deliberately **not** proposed: a visual redesign, a second component library, per-user page layouts,
or a mobile app. The design language holds up; what it lacks is a foundation under it.

---

## 6. Suggested order of execution

1. **20.22** and **20.23** first — they are small, they fix defects users hit today, and they touch
   files nothing else is moving.
2. **20.20** next — the token sweep is mechanical but wide; do it before adding any new surface.
3. **20.26** immediately after, so the sweep above is locked in by a check that fails on regression.
4. **20.24**, then **20.25** — both are additive and independent.
5. **20.27**, measured before and after on the built bundle.
6. **20.21** last, and only as a decision — it is the one item that changes the product's look, so it
   should be approved explicitly rather than slipped in with a refactor.

---

## 7. Measurement appendix

Re-runnable, from the repository root:

```bash
# design system
wc -l apps/web/src/styles/carocrm.css                      # 7972
grep -cE '#[0-9a-fA-F]{3,8}\b' apps/web/src/styles/carocrm.css   # 733
grep -c 'var(--' apps/web/src/styles/carocrm.css           # 27
grep -c '^\.carocrm-' apps/web/src/styles/carocrm.css      # 717 selectors
grep -c '@media' apps/web/src/styles/carocrm.css           # 49 queries, 16 distinct breakpoints
grep -rc 'style={{' apps/web/src --include=*.tsx           # 986 inline style objects

# states
grep -rn '<Empty' apps/web/src --include=*.tsx | wc -l     # 54 raw, 9 files use EmptyState
grep -rn 'ErrorBoundary\|componentDidCatch' apps/web/src   # 0
grep -rn "slice(0, 19)" apps/web/src                       # 14 call sites, 10 files

# output
ls -l apps/web/dist/assets/index-*.js                      # 2.62 MB, 27 chunks total

# i18n parity
# compare flattened key sets of i18n/en/*.json and i18n/vi/*.json → 4668 / 4666 (2 missing)
```

## 8. Unverified in this review

Honest about what static inspection cannot answer:

- The keyboard-only walkthrough and the 1440 / 1180 / 768 / 390 px checks were **not** re-run here;
  they are still the ones recorded in `docs/ux/accessibility.md`.
- No axe scan was executed (there is no runner — see 20.26), so contrast and landmark findings are
  inferred from the source, not measured.
- The perceived-cost claims in F10 come from the absence of `onMutate` in the source, not from a
  profile.
- `docs/compatibility/settings-ux.md` items not listed in F15 were **not** re-verified; the remaining
  deferrals should be confirmed before the next plan revision relies on them.
