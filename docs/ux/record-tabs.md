# Record-page relation tabs (Phase 20.18)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.11 and sub-phase 20.18. Two surfaces, one arrangement:

- the **record page's relation area** — the cards that list the records related to the one being
  viewed;
- the entity's **detail layout settings** — where an administrator arranges those cards into tabs.

Code: `apps/web/src/components/RelationTabs.tsx` (the record page's renderer),
`apps/web/src/components/RelationTabsEditor.tsx` (the editor),
`apps/web/src/components/LayoutEditor.tsx` (where the editor is hosted),
`packages/metadata/src/relation-tabs.ts` (schema + pure helpers),
`apps/api/src/metadata/metadata.controller.ts` (validation of the section).

## Where the arrangement lives

The arrangement is **entity metadata**, not a per-user preference. It is the `detailTabs` section of
the entity definition, next to the panels it sits under, so:

- it is written through the **same** `POST /api/v1/Metadata/:entity` route as `layouts`;
- it is configured once, by an administrator, in **Entity Manager → Layout → detail** — the same
  editor the settings shell's **Layout** tab hosts;
- everyone who opens a record of that entity sees the same tabs, which is what makes a tab a place
  people can talk about ("the invoice is on the *Commercial* tab").

The record page has **no editor, no mode switch and no preference**. It renders what the metadata
says and nothing else.

```jsonc
{
  "detailTabs": {
    "mode": "tabs",                      // or "stacked" — absent means stacked
    "tabs": [
      { "id": "people",     "label": "People",     "order": 0, "relations": ["contacts"] },
      { "id": "commercial", "label": "Commercial", "order": 1, "relations": ["quotes", "invoices"] }
    ]
  }
}
```

`mode: "stacked"` is today's page: one card per relation, metadata order. It is also the default for
an entity whose definition has no `detailTabs` section, so nothing changes until an administrator
arranges something.

## The arrangement

- A tab has a **label** the administrator typed, a **stable id** and an **order**. The id is
  slugified from the label once and never changes again, so a `?tab=people` link survives a rename.
- A relation belongs to **at most one** tab. Moving a relation to another tab removes it from the
  previous one in the same mutation — a move, never a copy. A section that lists a relation twice is
  refused with `422`, by the schema itself.
- **No relation can be lost.** A relation no tab names renders in an implicit, non-deletable
  **Other** tab that is computed on read and never stored. Deleting a tab returns its relations to
  that pool — it never deletes them, and the confirmation says exactly that.
- **Empty tabs are allowed while editing** (create the tab first, move the relations in later) and
  are hidden on the record page, where there would be nothing to show.
- **Switching back to panels keeps the arrangement.** `mode` is a rendering choice, not a reset:
  switching to tabs again restores the tabs exactly as they were.
- **A renamed relation does not break the section.** The record page reconciles the stored
  arrangement against the entity's own relations, and the editor does the same before it saves, so a
  stale relation name is dropped rather than sent back and refused.

### The default arrangement

An entity switched to tab mode before it has an arrangement shows **one tab per relation**, computed
from the entity's own relations and never stored. The first edit materializes it.

A single *Other* tab holding everything was rejected: it would be today's stacked page under
another name, and it would fetch every relation on the first paint — the cost the mode exists to
remove.

## The editor (Layout settings → detail)

The section appears under the detail layout, next to the panels, and only for an entity with **two
or more relations**: with zero or one there is nothing to arrange.

- A `Segmented` (**Panels** / **Tabs**) sets the entity's `mode`. It is the first thing in the
  section, because it decides whether the rest matters.
- One block per tab, plus the computed **Other** pool. A tab can be renamed, deleted and reordered;
  a relation is a chip that moves by **drag** (dnd-kit, the stack the layout editor already uses)
  **or** through its `Move to…` select — no drag-only interaction anywhere (§5.8). The move-up /
  move-down buttons on a tab header are the keyboard equivalent of dragging a tab.
- Edits join the editor's ordinary draft: they set the same **dirty** state, and the shell's
  **Save** writes `detailTabs` (only when it changed) in the same `POST /Metadata/:entity` as the
  panels. **Discard** restores the stored arrangement with everything else.
- A tab label is **administrator data** and is deliberately not translated. The chrome around it is
  (`web.detail.tabs.*`, `web.detail.panels` in `en` and `vi`).

## Reading the arrangement on the record page

- The stored value is the source of truth for writes; the *view* is reconciled against the entity's
  own relations on read: a relation the entity no longer has disappears from the screen, a relation
  listed twice keeps its first tab, and the tab order is preserved.
- Only the **active** tab mounts, so an entity with eight relations makes one `/Related` call
  instead of eight; a tab that is never opened never fetches.
- The strip uses antd `Tabs` (roving tabindex, arrow keys, ARIA `tablist`), scrolls horizontally
  rather than wrapping, and its label shows the number of **panels** in the tab — never record
  counts, which would cost one query per relation.
- `?tab=<id>` is written on tab change, so a refresh and a pasted link land on the same tab; an
  unknown id falls back to the first tab and the URL is corrected. Only tab mode carries the
  parameter — a stacked page keeps today's clean URL.
- **ACL is untouched.** A relation the caller cannot read renders nothing in tab mode, and a tab
  whose relations are all unreadable is hidden — the stored arrangement is left intact, because
  permissions can come back. The stacked page keeps today's empty card.

## What it deliberately does not change

- **The relation model.** Every panel is the same `/Related` call as today's stacked panel; tabs
  are presentation over them. No new endpoint, no new table, no migration.
- **The panels that are not link lists.** A commercial document's `items` panel (the money the
  document is calculated from) stays in front of the tab area, and Stream and Communications keep
  their fixed position below it (§5.4).
- **The portal.** Customer-facing surfaces stay stacked; the record page ignores the section there
  (§5.11 rule 9).

## Why not per-user

An earlier design stored the arrangement in a `detailTabs` user preference so each person could
arrange their own record page. It was dropped: the tab strip is part of the page's structure, and a
page whose sections move per viewer cannot be referenced in support, training or a link. A record
page is a shared surface; the layout that describes it belongs to the entity.

## Known gaps (deferred)

- **No in-app navigation blocker for a dirty draft.** A dirty tab edit rides the layout editor's
  draft; the settings shell warns through its own guard, and the browser unload guard comes from the
  same shell. An in-app link outside the shell is not intercepted (the same limitation the settings
  shell documents).
- **No drag-and-drop of a relation *within* a tab.** The chip moves between tabs; the order of the
  relations inside a tab follows the entity's relation order.
- **The strip does not wrap.** A very wide arrangement scrolls horizontally instead of growing the
  page.
- **The "Other" pool cannot be renamed.** It is the computed fallback, and an arranged tab may not
  take its id.
- **No frontend test runner** in this repository (see the compatibility note), so the UI half of
  this sub-phase is covered by the unit tests of the pure helpers plus a browser walkthrough.

These are recorded in `docs/compatibility/settings-ux.md` as well.

## Testing

- Unit: `packages/metadata/src/relation-tabs.test.ts` — the schema, the limits, the
  one-relation-one-tab rule, the reconciliation, the moves, the default arrangement.
- API: `apps/api/test/entity-manager-metadata.test.ts` — the round-trip through
  `POST /Metadata/:entity` and both read routes, the `422` on a duplicated relation, the `422` on a
  relation the entity does not have, and that a refused write leaves the stored section untouched.
- Frontend: no frontend test runner exists in this repository, so the components are covered by the
  browser walkthrough only.
