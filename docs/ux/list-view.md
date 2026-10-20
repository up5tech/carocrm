# List view (Phase 20, part B)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.3 and sub-phase 20.12. The list view is the surface a rep
spends the day on; it is generic over entity metadata — the same page renders Opportunities and
Knowledge Articles.

Code: `apps/web/src/pages/EntityListPage.tsx`.

## What the list page does today

| Capability | Where | Notes |
|---|---|---|
| URL state | `EntityListPage.tsx` (§20.12) | `offset`, `orderBy`, `pageSize`, `q`, `where` serialize to the query string; the page restores from them, so a pasted link reproduces the screen |
| Saved filters | `/SavedFilter` | server-side records with private/shared visibility, named and re-applied from the filter bar |
| Column manager | `Columns` dropdown | show/hide per entity, persisted in the `columns` preference (`/Preferences/columns`) |
| Density | density select beside the saved filters | `comfortable` / `compact`, per account, follows the user to another device |
| Inline editing | cell click or `Enter` | saves with `Enter`, cancels with `Esc`, the validation message renders **in the cell** |
| Selection + bulk bar | `.carocrm-bulk-bar` | a floating bar appears after selection, with a delete action and an undo toast |
| Undo | undo toast | the deleted rows are restored from the snapshot the action took |
| Row actions | per-row action column | Edit / Delete |
| Board link | "View board" button | only when the entity has a board grouping field |

## Rules

- The page is metadata-driven. The columns come from the entity's `list` layout and the `inList`
  flags; the filters come from the filterable fields; nothing about a specific entity is hard-coded
  here.
- Column visibility is a **preference**, not a layout: it is the user's choice per entity and
  follows the account. The layout decides the default order; the preference decides what is shown.
- An inline edit writes through `POST /:entity/action/mass-update` with a single id. A field that
  feeds a calculation, a forecast or a document keeps the record form.
- The undo stack holds the row snapshot the action was taken from, so undo restores the previous
  values rather than guessing them.

## Known gaps (deferred)

These are the parts of §5.3 that are **not** built. They are recorded in
`docs/compatibility/settings-ux.md` as well.

- **"Select all N matching records"** — the header checkbox selects the rows of the current page
  only. There is no cross-page selection and no count of matching records.
- **Bulk action reporting** — the bulk bar reports the selected count, not "48 updated, 2 skipped
  (no permission)". Only mass delete is wired; mass assign / mass update are not.
- **Row kebab menu** — the row action column offers Edit and Delete. Open, Assign and Follow are not
  there, and the menu is not filtered server-side.
- **Column reorder, resize and freeze** — the column manager toggles visibility. Reordering,
  resizing and freezing the identifier column are not implemented.
- **Table ergonomics** — no sticky table header, no frozen identifier column, no tabular figures,
  and no virtualization at 2 000+ rows (the table renders every row of the page).
- **Undo timeout** — the undo toast has no countdown; it stays until another action replaces it.

## Testing

- Backend: `apps/api/test/entity-crud.test.ts` (list, filter, sort, pagination), the metadata
  layout rules in `apps/api/test/metadata-api.test.ts`.
- Frontend: there is **no** frontend test runner in this repository (the Vitest config covers
  `apps/api/test` and `packages/*/src` only). The list view is therefore covered by the browser
  walkthrough, not by an automated test — see `docs/ux/accessibility.md` for what that walkthrough
  covers.
