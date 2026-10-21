# Record-page relation tabs (Phase 20.18)

Scope: `PLAN_Phase_20_Settings_UX.md` §5.11 and sub-phase 20.18. One surface: the **relation area**
of a record page — the cards that list the records related to the one being viewed.

Code: `apps/web/src/components/RelationTabs.tsx`, `apps/web/src/state/detail-tabs.ts`,
`packages/metadata/src/relation-tabs.ts`, `apps/web/src/pages/EntityDetailPage.tsx`
(`RelationSection`).

## What the user chooses

A record page used to stack one card per relationship. For an Account or an Opportunity with eight
relations that pushes the record's own content several screens down, and nothing on the page could
be reordered by the person who actually works the record.

The user now picks, **per user and per entity**, between two renderings:

| Mode | Rendering |
|---|---|
| `stacked` (**default**) | Today's behaviour: one card per relation, metadata order. Unchanged. |
| `tabs` | A tab strip above the relation area; only the active tab's panels mount and fetch. |

The choice lives in a **preference**, not in entity metadata and not in a settings document: two
people opening the same Account legitimately want different arrangements, so the arrangement is
owned by the account, follows it to the next device and is never shared with a role.

A user who never touches the control sees today's page: no preference row → `stacked` → the same
cards in the same order, and no extra request is made for the control.

## The arrangement

- A tab has a **label** the user typed, a **stable id** and an **order**. The id is slugified from
  the label once and never changes again, so a `?tab=people` link survives a rename.
- A relation belongs to **at most one** tab. Moving a relation to another tab removes it from the
  previous one in the same mutation — a move, never a copy. A write that lists a relation twice is
  refused with `422`.
- **No relation can be lost.** A relation the user placed in no tab renders in an implicit,
  non-deletable **Other** tab that is computed on read and never stored. Deleting a tab returns its
  relations to that pool — it never deletes them, and the confirmation says exactly that.
- **Empty tabs are allowed while editing** (create the tab first, move the relations in later) and
  are hidden in read mode, where there would be nothing to show.
- **Switching back keeps the arrangement.** `stacked` is a rendering mode, not a reset: switching
  forward again restores the tabs exactly as they were.

### The default arrangement

An entity the user has never arranged starts from **one tab per relation**, computed from the
entity's own relations and never stored: switching an entity to tab mode materializes that
arrangement, so the strip the user sees is the arrangement that is stored, and the first edit
rewrites it.

A single *Other* tab holding everything was rejected: it would be today's stacked page under
another name, and it would fetch every relation on the first paint — the cost the mode exists to
remove.

## Reading a stored arrangement

The stored value is the **source of truth for writes**; the *view* is reconciled against the
entity's own relations on read:

- a relation name the entity no longer has disappears from the screen but stays in the stored
  preference — a renamed relation must not start failing with `422`, and permissions can come back;
- a relation listed in two tabs keeps its first tab;
- the tab order is preserved.

Unknown relation names are therefore dropped on read and never refused on write — the same rule the
`favorites` preference already follows.

## Interactions

- A compact toolbar sits above the relation area, right-aligned: a `Segmented` (**Panels** /
  **Tabs**) and, in tab mode, an **Edit tabs** button. Nothing else on the page moves.
- The strip uses antd `Tabs`, so the roving tabindex, the arrow keys and the ARIA `tablist`
  pattern come with it. It scrolls horizontally rather than wrapping, and its label shows the
  number of **panels** in the tab — never record counts, which would cost one query per relation.
- **Manage mode** (`Edit tabs`): one block per tab plus the computed *Other* pool. A tab can be
  renamed, deleted and reordered; a relation is a chip that moves by **drag** (dnd-kit, the stack
  the layout editor already uses) **or** through its `Move to…` select — no drag-only interaction
  anywhere (§5.8). The move-up / move-down buttons on a tab header are the keyboard equivalent of
  dragging a tab.
- Writes are **batched into one `PUT /Preferences/detailTabs`** when leaving manage mode and issued
  immediately on a mode switch. A rejected write restores the previous arrangement and shows an
  inline error; the draft is never silently dropped.
- Leaving the record page with an unsaved tab draft warns, reusing the guard the record form uses.
- `?tab=<id>` is written to the URL on tab change, so a refresh and a pasted link land on the same
  tab; an unknown id falls back to the first tab and the URL is corrected. Only tab mode carries
  the parameter — a stacked page keeps today's clean URL.
- **Use tabs for all record types** in manage mode writes the top-level default in one action
  instead of entity by entity.

## What it deliberately does not change

- **The relation model.** Every panel is the same `/Related` call as today's stacked panel; tabs
  are presentation over them. No new endpoint, no new table, no migration.
- **ACL.** A relation the caller cannot read renders nothing in tab mode, and a tab whose
  relations are all unreadable is hidden — but the stored arrangement is left intact, because
  permissions can come back. The stacked page keeps today's empty card, so a user who never opens
  the control sees the same page as before.
- **The panels that are not link lists.** A commercial document's `items` panel (the money the
  document is calculated from) stays in front of the tab area, and Stream and Communications keep
  their fixed position below it (§5.4).
- **The portal.** Customer-facing surfaces stay stacked and never even fetch the arrangement
  (§5.11 rule 9).

## Performance

Tab mode is *cheaper* than the stacked page on first paint: only the active tab mounts, so an
entity with eight relations issues one `/Related` call instead of eight, and a tab that is never
opened is never mounted. While the preference is still being read the area waits for it — rendering
the panels immediately would fetch every relation and then fetch them again when the stored mode
turned out to be `tabs`.

## Accessibility

- The strip is a real `tablist` with arrow-key navigation (antd `Tabs`).
- Every relation chip and every tab action carries an ARIA label naming the tab or relation it
  acts on, so the editor is usable without reading the layout.
- The relation chip's `Move to…` select and the move-up / move-down buttons give the whole
  arrangement a **pointer-free path**: a tab can be created, filled and reordered with the keyboard
  alone.
- At 390 px the chip takes the full width and its select grows with it, so the editor stays
  readable without horizontal scrolling.

## Known gaps (deferred)

- **No in-app navigation blocker for a dirty draft.** The `beforeunload` guard warns on a browser
  unload; an in-app link from outside the record page is not intercepted, because the app is
  mounted with a plain `BrowserRouter` (the same limitation the settings shell documents).
- **No drag-and-drop of a relation *within* a tab.** The chip moves between tabs; the order of the
  relations inside a tab follows the entity's relation order.
- **The strip does not wrap.** A very wide arrangement scrolls horizontally instead of growing the
  page; the tab count is what identifies a tab, and a wrapped strip changes the height of the
  record page on every rename.
- **The "Other" pool cannot be renamed.** It is the computed fallback, and a user tab may not take
  its id.
- **No frontend test runner** in this repository (see the compatibility note), so the UI half of
  this sub-phase is covered by the unit tests of the pure helpers plus a browser walkthrough.

These are recorded in `docs/compatibility/settings-ux.md` as well.

## Testing

- Unit: `packages/metadata/src/relation-tabs.test.ts` — the schema, the limits, the one-relation-
  one-tab rule, the reconciliation, the moves, the default arrangement.
- API: `apps/api/test/user-preferences.test.ts` — the round-trip of the `detailTabs` preference, the
  `422` on a duplicated relation and the leniency about unknown relation names.
- Frontend: no frontend test runner exists in this repository, so the component is covered by the
  browser walkthrough only.
