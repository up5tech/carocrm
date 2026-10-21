# Record page and forms (Phase 20, part B)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.4, §5.5 and sub-phase 20.13. Two surfaces: the read view
of a record and the form that edits it.

Code: `apps/web/src/pages/EntityDetailPage.tsx`, `apps/web/src/pages/EntityEditPage.tsx`.

## Record detail

- The body is driven by the entity's `detail` layout: the panels and the field order come from
  metadata, so an administrator changes the page without a code change.
- Fields the layout does not place are grouped under **Other** rather than being dropped, and the
  layout editor shows that computed group under its pool, so the settings and the page name the
  same fields. An entity with no detail layout renders one field list and no **Other** card.
- Relation panels show the related records, their counts, and a **Link / New** action so a relation
  can be attached without leaving the record.
- The Stream panel stays on the record. Posting supports `@mentions` as before; `⌘/Ctrl + Enter`
  posts without reaching for the mouse.
- Ownership is server-side. The page renders what `GET /:entity/:id` returns, which is already
  filtered by record-level ACL and field-level ACL.

## Edit form

- The form honours field-level ACL, dynamic logic and the `edit` layout order. A field the role may
  not edit is not rendered; a field dynamic logic hides is not editable.
- Validation is inline and per field, never a toast. A server validation message is mapped back to
  the field it belongs to; an error with no field becomes a form-level alert.
- The unsaved-changes guard covers browser unload (`beforeunload`) and the record's own route
  changes.
- `⌘/Ctrl + Enter` saves from anywhere in the form.
- On create, a **duplicate warning** is raised when a record with the same name already exists. The
  user confirms or cancels; the check reuses the existing `record.duplicate` metadata rather than
  introducing a second mechanism.

## Known gaps (deferred)

- **Sticky header** — the record title, status, owner and primary action are not pinned to a sticky
  header. The plan treats this as an enhancement over the guard that does exist.
- **Next-action band** — there is no computed "Log a call / Create invoice / Advance stage" band. It
  is a hint, not an automation, and it needs the activity model to be reliable.
- **Inline-editable name** — the name is edited through the form, not in the header.
- **Progressive disclosure** — the detail page renders its field panels in one column. The
  collapsible variant is not built. Relation panels can be grouped into tabs, but that is the
  entity's layout (`detailTabs`, see `docs/ux/record-tabs.md`), not a fold for field panels.
- **"Save & new"** — the form offers Save and Cancel only.
- **Smart defaults** — a new record starts empty apart from what the entity metadata provides.
- **Focus management on validation failure** — the first invalid field is not focused
  automatically.

These are recorded in `docs/compatibility/settings-ux.md` as well.

## Testing

- Backend: `apps/api/test/entity-crud.test.ts`, `apps/api/test/dynamic-logic.test.ts`,
  `apps/api/test/acl-matrix.test.ts`.
- Frontend: no frontend test runner exists in this repository, so the form is covered by the
  browser walkthrough only.
