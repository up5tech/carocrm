# List view (Phase 20, part B; re-measured Phase 24.10)

Scope: `plans/PLAN_Phase_20_Settings_UX.md` §5.3 and sub-phase 20.12. The list view is the surface a rep
spends the day on; it is generic over entity metadata — the same page renders Opportunities and
Knowledge Articles.

Code: `apps/web/src/pages/EntityListPage.tsx`.

> **Re-measurement (Phase 24.10):** the "Known gaps" list this document used to carry is stale —
> the row kebab, select-all-matching, bulk edit/assign, column resize and the frozen identifier
> column all shipped after it was written. The table below and the gap list are corrected against
> the current tree; the only §5.3 item still absent is cell-level inline editing, which never
> shipped (edits go through the record form or the bulk-edit modal).

## What the list page does today

| Capability | Where | Notes |
|---|---|---|
| URL state | `EntityListPage.tsx` (§20.12) | `offset`, `orderBy`, `pageSize`, `q`, `where` serialize to the query string; the page restores from them, so a pasted link reproduces the screen |
| Saved filters | `/SavedFilter` | server-side records with private/shared visibility, named and re-applied from the filter bar |
| Column manager | `Columns` dropdown | show/hide per entity, persisted in the `columns` preference (`/Preferences/columns`) |
| Column resize | header drag handle | per-column pixel widths while dragging, persisted per user per entity; the display-field column is frozen `left` while the table scrolls sideways |
| Density | density select beside the saved filters | `comfortable` / `compact`, per account, follows the user to another device |
| Sticky header | antd `sticky` + `scroll={{ x: 'max-content' }}` | the header stays put while the page scrolls |
| Selection + bulk bar | `.carocrm-bulk-bar` | a floating toolbar appears after selection: bulk edit, bulk assign, delete — each offered only when the server's action catalog says the caller may perform it |
| Select all matching | bulk bar button | appears when the whole page is selected but more records match; selects across pages through the server |
| Undo | undo toast (8 s) | bulk delete/update snapshot the previous values and restore them through the same audited `/massUpdate`; delete recreates the rows |
| Row actions | per-row kebab | Open / Edit / Assign / Follow / Delete, filtered by the server-provided action catalog |
| Board link | "View board" button | only when the entity has a board grouping field |
| Cell inline edit | — | **not built** — a cell click does not open an editor; single-record edits use the record form, multi-record edits the bulk modal |

## Rules

- The page is metadata-driven. The columns come from the entity's `list` layout and the `inList`
  flags; the filters come from the filterable fields; nothing about a specific entity is hard-coded
  here.
- Column visibility and widths are **preferences**, not layouts: they are the user's choice per
  entity and follow the account. The layout decides the default order; the preference decides what
  is shown and how wide it is.
- Bulk writes report **outcomes**, not intentions: `massUpdate`/`massDelete` return how many records
  changed and the bar says how many were skipped for lack of permission.
- The undo stack holds the row snapshot the action was taken from, so undo restores the previous
  values rather than guessing them.

## Known gaps (deferred)

These are the parts of §5.3 that are **not** built. They are recorded in
`docs/compatibility/settings-ux.md` as well.

- **Cell-level inline editing** — there is no click-to-edit cell. If it is ever added it must write
  through the same audited update path and show server field errors in the cell, which is what the
  earlier revision of this document described but the code never had.
- **Tabular figures** — numbers in cells use the default font figures; `font-variant-numeric` is not
  set on the table.
- **Virtualization** — deliberately absent: rows are server-paginated, so a page never holds more
  than `pageSize` records and there is nothing to virtualize.

## Testing

- Backend: `apps/api/test/entity-crud.test.ts` (list, filter, sort, pagination), the metadata
  layout rules in `apps/api/test/metadata-api.test.ts`.
- Frontend: `pnpm test:web` (Vitest, `apps/web/src/**/*.test.*`) covers shared state components and
  pure page logic; the list page's interactive behavior is covered by the Playwright walkthrough in
  `e2e/` — see `docs/ux/accessibility.md` for what that walkthrough covers.
