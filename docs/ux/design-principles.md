# UX design principles (Phase 20, part B)

Scope: `PLAN_Phase_20_Settings_UX.md` §5. This document turns the plan's UX section into rules a
change can be reviewed against. It describes the principles the current SPA already follows; it is
not a redesign proposal.

The product is a CRM used for hours at a time by people who do not want to read a manual. Every
principle below trades polish for speed, and speed for correctness where the two conflict.

## 1. The server decides what exists

The SPA renders what the API returns. It never computes access, never invents a menu entry, never
decides that a record "should" be visible.

- The sidebar comes from `GET /Navigation` (server-resolved, ACL-filtered). The hard-coded name sets
  that used to live in `AppShell.tsx` are gone.
- The administration rail comes from `GET /AdminPanel`. A tab the caller may not open is not rendered
  **and** the settings read refuses it with `403`.
- A menu entry is presentation. Hiding an entity never disables it — a direct URL keeps working, and
  the endpoint keeps its own authorization.

**Do:** add a new screen by adding a server endpoint and a tab descriptor.
**Don't:** gate a UI element on a client-side guess about the role.

## 2. One place to change a value

A value that can be changed from two screens will be changed from the wrong one. Settings live in
the settings shell; record data lives on the record; the two never overlap.

- Every settings document has one owner: the registry (platform documents) or the owning module
  (Sales, Service Desk, Customer Success). The shell hosts both through the same save bar.
- Preferences that only affect the browser (density, columns, page size, default dashboard) are
  per-user resources, not instance settings, and are stored server-side so they follow the account.

## 3. The keyboard is a first-class input

Every drag has a button. Every icon-only control has a label. Every modal returns focus.

- `⌘/Ctrl + K` opens the command palette from any screen; `⌘/Ctrl + Enter` saves a form;
  `Enter` saves an inline cell, `Esc` cancels it.
- The layout editor lifts a row with `Space` and moves it with the arrow keys (dnd-kit's keyboard
  sensor) — no pointer is required anywhere.
- `aria-label` on every icon-only control, `aria-current` on the selected tab, `role="toolbar"` on
  the bulk action bar.

See `docs/ux/accessibility.md`.

## 4. Feedback belongs where the problem is

An error that belongs to a field is rendered in that field. An error that belongs to the screen is
rendered on the screen. A toast is for confirmations and background results only.

- Inline edit validation renders **in the cell**, never as a toast.
- A server validation message is mapped back to its field; a field-less error becomes a form-level
  alert.
- A permission problem is an explanatory empty state, not a bare `403`.

## 5. Destructive actions state the cost

Before something is deleted, deactivated, reset or purged, the user is told what is lost and has to
confirm it. Typed confirmation is used where the action cannot be undone.

- Mass delete in the list asks for a confirmation that names the count.
- The danger zone (`/AdminInternal`) requires the exact typed phrase (`RESET METADATA` /
  `PURGE QUEUE`), refuses non-administrators, and audits every execution.
- A password reset, a user deactivation and a key revocation state what happens to the sessions.

## 6. Nothing happens silently on the server

A write that changed something says so, and says who changed it and when.

- Every settings write appends a `schema_changes` row with the actor, the changed key names and the
  before/after versions — never the values.
- The settings shell shows "last changed by … at …" and the document version.
- Concurrency is optimistic: a stale version is refused with `409` and the current version, so a
  second administrator's change is never silently overwritten.

## 7. Density is a preference, not a theme

Repetitive list work wants compact rows; reading wants comfortable ones. The choice is the user's,
it is per account, and it survives a new device.

- `comfortable` and `compact` are the two densities; the list page reads `density` and `listPageSize`
  from `/Preferences`.
- The design language stays one language: Ant Design 5 primitives, the `carocrm-*` CSS layer and the
  `--carocrm-*` tokens. No second component library.
- A colour is named in `theme/tokens.ts`, or it does not exist (§20.20). Every literal colour lives in
  `styles/tokens.css`; `scripts/check-ui-conventions.mjs` (`pnpm lint:ui`) refuses a hex outside it.
  The brand colour is a named accent, never a free hex, so the server and the SPA validate against the
  same eight names. Dark mode is out of scope for now but becomes cheap once tokens exist.

## 8. Empty is a state, not an absence

An empty list is a screen with a job: say what is missing, and offer the one action that fixes it.

- `EmptyState` is the only empty state. Its `variant` names the situation, because the four need
  different actions: `no-records` (create one), `no-results` (change the query), `filtered` (clear
  the filters), `denied` (nothing to do — explain). One sentence for all four tells the reader the
  wrong thing three times out of four.
- A raw `<Empty>` outside `EmptyState.tsx` fails `pnpm lint:ui`. The title is the primary line and
  the hint is secondary; `action` (or `children`) holds the one control that changes the situation.
- The setup checklist tells a first-run administrator what is still missing, with deep links.
- The home page is a workspace, not an inventory: it states the day first (what needs an answer, what
  is on today), then a couple of curated KPI numbers and the followed activity. It never lists every
  module with a count, so "nothing here" is said once, in one sentence, instead of a wall of zeros.
- The dashboard opens on the user's starred default, falling back to a role-scoped one, then to the
  first dashboard.

## 9. Share the state, not the screen

A link is the unit of sharing. Filters, sort, page size, page and the saved view live in the query
string, so a colleague lands on the same screen.

- The list page serializes its state to the URL and restores from it.
- Saved filters are server-side records with private or shared visibility, not browser state.

## 10. Deferral is a documented decision, not a silent gap

Anything the plan asks for that the product does not do yet is written down in
`docs/compatibility/settings-ux.md`, with the reason and the condition for building it. A deferral
that is not written down is treated as a defect.

## 11. Failure is a screen, not a blank page

A user who cannot see what happened cannot tell a bug from an empty record (added in 20.22).

- A thrown render is caught by `AppErrorBoundary`: the route boundary keeps the shell and offers
  *Try again* / *Back to home*, the root boundary offers a reload. Nothing renders a white page.
- A failed read shows `ErrorState` with a retry. A silent empty table is the one wrong answer.
- Being offline is a state, not a run of failed toasts: `OfflineBanner` follows React Query's
  `onlineManager`, so the queries pause and resume with the banner.
- Time is formatted by `formatDateTime` / `formatClock` / `formatRelative` and nothing else. A
  timestamp cut out of an ISO string prints UTC while the rest of the page prints the user's zone.
  `formatRelative` is for judging recency (an inbox, a run list); an audited screen keeps the instant.

## 12. The conventions are executable

`pnpm lint:ui` (`scripts/check-ui-conventions.mjs`) fails on a missing i18n key, an ISO-sliced
timestamp, a raw `<Empty>`, and an internal `<a href="/…">`. A rule that only lives in this document
is a rule that will be broken by the next screen; the four above were each a real defect first.
