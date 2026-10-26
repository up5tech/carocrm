# Settings and UX — compatibility note (Phase 20)

Reference: EspoCRM Administration documentation — the administration panel and its functional areas,
`app > adminPanel` panels, config-parameter visibility levels, and Main Menu customization under
Administration → User Interface. This project reproduces the *administrator-visible behaviour*, not
the upstream file layout, and copies no upstream source, asset or translation.

## Deliberate deviations

| Upstream concept | Here | Why |
|---|---|---|
| `app > adminPanel` metadata file with `itemList` per panel | Tab and group descriptors registered in `admin-panel.service.ts` | A tab is a lazy-loaded component. A descriptor naming a component the build does not have would render an empty tab, so the list lives with the code that can prove the component exists. A module still contributes a tab by adding one descriptor; the shell is never edited. |
| Config parameter `level`: `default/global/admin/internal/system/superAdmin` | `public`, `user`, `admin`, `sysAdmin` on each settings document | The four that a settings screen can actually honour are kept; the rest describe an account tier this instance does not have. |
| `superAdmin` account | **Same predicate as `admin`** | `users.is_admin` / `users.type = 'admin'` is the only administrative flag, plus the built-in `sysAdmin` role id, which `apps/api/src/acl/acl-api.service.ts` already folds into "administrator". There is no second tier to check, so `sysAdmin` resolves to "instance administrator" today while the level stays in the contract (documents that carry it: `security`). Adding a real tier is a user-model change, not a settings change. |
| Main menu stored as the whole ordered menu | The `navigation` document stores **only overrides** | An entry the administrator never touched keeps following the shipped default, so installing a module or hiding an entity in metadata still behaves. Deleting the override is "back to default". |
| Menu customisation is client-side | `GET /api/v1/Navigation` returns the resolved, ACL-filtered tree | The SPA used to rebuild grouping from hard-coded name sets and two per-module probes. One server-side resolution means the menu, the preview and the permission rule cannot drift. |
| `entityMenu` / module menu metadata | `nav` section on the entity definition (`hidden/order/group/quickCreate/board`) | Placement belongs to the entity, so it travels with the metadata override the Entity Manager already writes and is validated by the same `POST /Metadata/:entity` path. |
| Settings live in one `config` JSON | One `app_settings` row per document, kept from Phases 0–19 | No second settings store, and each module keeps owning its own document and validation. |
| `modifiedById` on configuration | Actor name/id inside the row JSON, plus a `schema_changes` audit row | `app_settings` has only `name/data/modified_at`; adding columns for a bookkeeping field is not worth a destructive-capable migration. The audit row records actor, document, changed key names and both versions — never values. |
| User administration is a set of separate screens (`Administration → Users`, `Teams`, `Roles`, `Api Keys`) | Four tabs in the settings shell over the **existing** `/User`, `/Team`, `/Role`, `/ApiUser`, `/ApiKey` routes | The plan's acceptance for 20.7 is "work entirely through the existing identity API". The only additions are documented: `GET /User` filters + `POST /User/:id/password-reset` + `DELETE /Role/:id` + `POST /ApiUser/:id/key` + `DELETE /Team/:id`, all of which existed as data, not as endpoints. |
| Last-administrator protection is a client-side hint | Refused by `IdentityService.assertKeepsAnAdministrator` on the state *after* the change | Hiding a control is not authorization (AGENTS §5.3). A browser tab that is stale would otherwise be able to lock everybody out. |
| Role permission matrix offers `not-own`/`own`/`all` plus position-based scopes | `no / own / team / all / yes` per `create/read/edit/delete/stream` | These are the levels `AclApiService` and `packages/acl` evaluate. The editor writes the document the ACL reads rather than a richer vocabulary the engine would ignore. |
| Team `roleList` grants access | `teams.role_ids` mirrored into `teams_roles`, which is what the ACL joins | Before 20.7 a role stored on a team was never granted. The denormalised array stays for readers, the link table stays authoritative — the same arrangement as `users_teams`. |
| An API key secret can be re-read by a super admin | Never returned after the creating response | The server stores only a hash (`auth.service.issueApiKey`), so "shown once" is a property of the data, not a UI rule. Rotation is issue-new + revoke-old, offered as one button. |
| Layout manager is an `EntityLayoutManager` per entity panel | One shared `LayoutEditor` component hosted by both the Entity Manager and a settings `layout` tab | Copying the editor into the shell would let the two drift. The tab hosts it with the shell's save bar (`usesSaveBar` descriptor flag) and an entity picker; the Entity Manager keeps its inline actions. |
| User list shows team membership | The list omits `teams`; the editor reads `GET /User/:id` | Keeping the page cheap matters more than one column, and the row the form writes is the row it read. `title` and `phone` are in both DTOs so a save cannot blank them. |
| Relation panels are administrator-defined layout panels | A **per-entity, administrator-arranged** `detailTabs` section of the entity definition: today's stacked panels, or tabs the entity's detail layout defines | Arranging relations inside the entity's detail layout follows upstream's model (the layout describes the page) rather than deviating from it. The section is entity metadata written through `POST /Metadata/:entity` next to `layouts`, not a per-user preference: a record page is a shared surface, and a page whose sections move per viewer cannot be referenced in support, training or a link. The panels themselves are untouched: the same `/Related` calls, the same ACL, the same link/unlink actions. See `docs/ux/record-tabs.md` and `PLAN_Phase_20_Settings_UX.md` §5.11. |

## Behaviour that matches upstream intent

- Hiding a menu entry is presentation only. Every endpoint keeps its own authorization, and a document
  can never widen access: the ACL filter runs after the document is applied.
- A tab the caller may not open is not rendered **and** the settings read refuses it with `403`.
- Reads of brand and language defaults stay open to any session, because the shell has to paint them.
- Icon and accent choices come from fixed allowlists; no remote or arbitrary icon source exists.

## Known limitations after sub-phases 20.1–20.10

- All §4.3 rows through 20.9 have a tab or a documented home. The "who can see what" explain helper
  (`POST /AdminPanel/action/acl-explain`) and storage-usage figures (`GET /StorageUsage`) are
  implemented. 2FA (TOTP + recovery codes) is implemented on Authentication/Profile; the Authentication
  tab's policy editor remains P2.
- The webhooks tab reads the `webhook-integration` **extension**. When it is not installed the routes
  answer 404 and the tab shows an installation hint; it is not a second endpoint API.
- The danger zone is guarded and audited, but its destructive success paths are not exercised against the
  configured database (see `docs/admin/settings.md`); the guards, refusals and the audit-no-write-on-failure
  behaviour are pinned by `apps/api/test/admin-internal.test.ts`.
- 20.10's preference resource stores `columns`, `favorites`, `lastVisited` and `dismissedSetupSteps`;
  all four now have consumers (column widths, pinned navigation, recent routes, setup-banner dismissal).
  List density/page size and the default dashboard remain the original two.
- The 20.8 layout editor covers panels and field order for `list`/`detail`/`edit`. The plan's "list
  columns, filter and mass-update fields" are per-field flags (`inList`, `inFilter`, `massUpdate`) that
  live in the Entity Manager's field forms, not in a layout; the tab previews what the layouts actually
  drive. The save bar footer shows "not changed since installation" there, because entity metadata does
  not serve a last-modified actor.
- The 20.7 tabs manage internal users, teams, roles and API keys. **Portal roles and portal-user
  linkage stay on the Portals screen** (`/admin/portals`): a portal account edited here shows only the
  fields that are safe to change, because the identity service refuses internal roles on a portal
  account and portal authority comes from portal roles.
- The role **list** pages on the server (`GET /Role?offset`), because that endpoint has no name filter.
  The role/team/user **pickers** inside the editors read a fixed 500-record window, so an instance with
  more roles than that cannot assign role #501 from the form — it can still be assigned through the API,
  and a searchable picker needs a `where` filter on `/Role` (not built here).
- The last-administrator **refusal** is asserted against `leavesNoAdministrator` plus the allowed HTTP
  path, not by deactivating the development instance's only administrator over HTTP.
- Service Desk and Customer Success documents are hosted and editable as flat policy rows; Sales keeps
  its own purpose-built form. None of the three is a registry document (§8.3 keeps their endpoints).
- `nav.quickCreate` is stored and validated but not consumed: the home hero's **Create** menu lists
  every navigable entity, so the flag still changes nothing on screen. `nav.board.enabled` is derived
  from the board grouping field rather than offered as an independent switch.
- The unsaved-changes guard covers the shell's own rail and browser unload. The app is mounted with a
  plain `BrowserRouter`, which exposes no navigation blocker, so an in-app link from outside the shell
  is not intercepted; moving to a data router is a separate change.
- The menu preview renders the *current caller's* tree. "Preview as another principal" (plan §4.4) needs
  a server-side impersonation parameter and is not built.
- Favorites, per-user UI preferences and role-scoped default menus are §5.1/§5.9 work (20.10, 20.15).

## Known limitations after sub-phases 20.11–20.17

The end-user UX half of the phase (20.11–20.16) is built, with the following parts of the plan's
§5 explicitly deferred. Each of them is a gap in the shipped behaviour, not a deviation from upstream
behaviour, so none of them is an EspoCRM compatibility question.

### List view (§5.3)

- **"Select all N matching records"** is not built. The header checkbox selects the rows of the
  current page only; there is no cross-page selection and no count of matching records.
- **Bulk actions report a count of records, not a count of outcomes.** Only mass delete is wired;
  mass assign and mass update are not, so "48 updated, 2 skipped (no permission)" is not a shape the
  list page can produce. The undo toast restores the rows the action deleted.
- **The row kebab menu** (§5.3 "Row actions") is not built. The row action column offers Edit and
  Delete; Open, Assign and Follow are absent, and the contents are not permission-filtered
  server-side.
- **Column reorder, resize and freeze** are not built. The column manager toggles visibility per
  entity and persists it in the `columns` preference; the order still comes from the entity's `list`
  layout.
- **Table ergonomics** — no sticky table header, no frozen identifier column, no tabular figures and
  no virtualization at 2 000+ rows. The table renders every row of the page.
- **The undo toast has no timeout.** It stays until the next action replaces it.

### Record page and forms (§5.4, §5.5)

- **The sticky header and the next-action band are deferred.** The record title, status, owner and
  the primary action are not pinned to a sticky header, and there is no computed "Log a call / Create
  invoice / Advance stage" band. Both need a stable record header component and an activity model to
  be reliable.
- **Progressive disclosure is not built.** The detail page renders its panels in one column; there
  are no collapsible or tabbed variants.
- **"Save & new" is not built.** The edit form offers Save and Cancel.
- **Focus is not moved to the first invalid field** after a failed save.

### Favorites (§5.1)

- **There is no Favorites UI.** The `favorites` preference is registered, validated and stored, but
  no screen writes or reads it, so there is no pinned group at the top of the sidebar. The command
  palette's Recent mode is the substitute for "recently visited".

### Command palette (§5.2)

- The palette opens with `⌘/Ctrl + K` only. The plan's `/` shortcut is not implemented.
- Results are capped at 12 per group rather than the plan's 20, and there is no "see all" deep link.
- The Recent mode is in-memory for the session; it is not the server-persisted `lastVisited`
  preference.

### Shared states and accessibility (§5.7, §5.8)

- **`PermissionDenied.tsx` and `HelpTip.tsx` were unused when 20.11–20.17 shipped; both are used
  now.** Phase 21 consumes `PermissionDenied` on a refused handbook page and in the CRM chat
  workspace, and `HelpTip` carries a `docKey` in the Main Menu tab, the docs cross-links and the two
  template designers. The permission-denied state of §5.7 is still not applied by the list, detail
  and dashboards pages, which keep their own error markup. `EmptyState`, `LoadingSkeleton` and
  `ErrorState` are used by the settings shell, the list page and the dashboards page.
- **The automated axe audit exists and passes since 2026-10-26.** `@axe-core/playwright` scans the
  four core surfaces (home, list, record, settings) under WCAG 2.0 A/AA tags and asserts zero
  violations (`npx playwright test e2e/accessibility.spec.ts --project=chromium`); the scan found
  real contrast/label defects, each fixed in the ink tokens, the selection accent, the pills, the
  footer and the list toolbar's unnamed controls. Bounds are recorded in `docs/ux/accessibility.md`:
  the audit certifies the default `blue` brand instance, the rule tags are WCAG 2.0 A/AA (not
  2.1/2.2), and keyboard/focus paths remain a manual walkthrough. `pnpm test:web` plus the
  `lint:ui` convention gate complete the quality-gate picture of 20.26.
- **No Playwright spec covers the plan's §13.5 scenarios** (1–6); `e2e/` holds specs for the
  earlier modules only, plus the §13.5 overflow/palette smoke and the axe audit itself.
- **Contrast was not measured.** The palette uses the Ant Design token set; no contrast audit was
  run against the `carocrm-*` layer.

### Setup checklist (§4.10)

- **The checklist cannot be dismissed.** §4.10 asks for a per-user dismissal; the `dismissedSetupSteps`
  preference is registered and validated but no screen writes it, so the banner on the home page stays
  until every step is complete.
- **The checklist is five checks, not the plan's eight.** `menu`, `email`, `roles`, `teams` and `users`
  are evaluated (`apps/api/src/setup-checklist/setup-checklist.service.ts`); the logo, first custom
  field and first workflow checks are not.

### Documentation

- `docs/ux/design-principles.md`, `docs/ux/list-view.md`, `docs/ux/record-page.md` and
  `docs/ux/accessibility.md` were added with the 20.17 hardening pass. They describe the shipped
  behaviour and name the gaps above.

## Known limitations after sub-phase 20.18 (record-page relation tabs)

The relation area of a record page can render as today's stacked panels or as tabs the
administrator arranges in the entity's **detail layout settings**
(PLAN_Phase_20_Settings_UX.md §5.11). The arrangement is entity metadata, written through
`POST /Metadata/:entity` next to `layouts`; the record page only renders it and offers no editor.
These are the gaps in the shipped arrangement.

- **The in-app navigation blocker for a dirty draft is missing.** A tab edit rides the layout
  editor's draft, so it inherits that editor's save bar and dirty guard; an in-app link outside the
  settings shell is not intercepted, because the app is mounted with a plain `BrowserRouter` — the
  same limitation the settings shell documents.
- **A relation cannot be reordered inside a tab.** The chip moves between tabs; the order of the
  relations within a tab follows the entity's own relation order.
- **The tab strip scrolls instead of wrapping.** A very wide arrangement scrolls horizontally rather
  than growing the record page.
- **The implicit *Other* tab cannot be renamed or moved.** It is the computed fallback pool, and
  its id is reserved so a `?tab=other` link always means the pool.
- **A tab that lost every relation to the ACL is hidden, not emptied.** Its stored arrangement is
  kept, because permissions can come back.
- **The arrangement is not per user.** It is one layout per entity: every user of that entity sees
  the same tabs. That is deliberate — the record page is a shared surface and a page whose sections
  move per viewer cannot be referenced in support, training or a link — but it is a deviation from
  the first draft of the sub-phase, which kept the strip in a per-user preference. There is no
  role-scoped or team-scoped variant either.
- **A stored section that names a relation the entity no longer has is not refused on write until it
  is edited.** The record page and the layout editor both reconcile it against
  `definition.relations`, so the stale name is dropped rather than resurfacing; a direct API patch
  that still carries it is refused with `422`.
- **A `detailTabs` preference written by the first implementation is inert.** The name was removed
  from `PREFERENCE_SCHEMAS`; an existing row stays in `user_preferences`, but no route serves it and
  the arrangement now lives in the entity's `detailTabs` metadata. No migration removes the row.
- **The UI half has no automated coverage.** This repository has no frontend test runner, so the
  components are covered by the unit tests of the pure helpers
  (`packages/metadata/src/relation-tabs.test.ts`), the API tests of the metadata section
  (`apps/api/test/entity-manager-metadata.test.ts`) and a browser walkthrough.
- **The editor is not covered by an axe audit**, for the same reason the 20.16 audit is missing.

## Status reconciliation — 2026-10-25 (UI/UX review)

The deferral lists above were written as each sub-phase closed and were never reconciled afterwards,
so several entries now describe a product that no longer exists. `docs/ux/ui-review.md` re-checked
the list against the working tree. Verified **shipped** since the entry was written:

| Entry that says "not built" | Actually shipped | Where |
|---|---|---|
| The row kebab menu (§5.3 "Row actions") | A per-row dropdown with Open / Edit / Assign / Follow / Delete, each offered only when `POST /:entity/action/rowActions` allows it | `pages/EntityListPage.tsx` (actions column) |
| Column reorder | "Move up" / "Move down" buttons per column, keyboard reachable, persisted in the `columns` preference | `components/ColumnManager.tsx` |
| Column resize | A header separator per column, width persisted per user per entity in `columnWidths`; the display field is frozen left | `pages/EntityListPage.tsx` |
| The Favorites group | The rail leads with a Favorites group resolved from the same ACL-filtered tree, written by the palette's "pin this page" | `state/favorites.ts`, `components/AppShell.tsx`, `components/CommandPalette.tsx` |
| The palette's `/` shortcut | Implemented, suppressed while the caret is in a field or a dialog is open | `components/CommandPalette.tsx` |
| The record-page sticky header and next-action band | Both: `RecordHeader` keeps name/status/owner in view, `NextActionBand` computes the next pipeline value | `components/RecordHeader.tsx`, `components/NextActionBand.tsx` |
| Bulk update and assign | One editor for both, opened from the floating bar and from the row menu | `components/BulkEditModal.tsx`, `pages/EntityListPage.tsx` |

Still open, confirmed absent at the same date: the sticky table header, table virtualization,
cross-page "select all N matching records", per-action outcome counts in the bulk result, "Save &
new", focus moved to the first invalid field after a failed save, and the whole of 20.20–20.27
(`docs/ux/ui-review.md` §5). The remaining entries were not re-verified and should be checked before
a plan revision relies on them.

### Coverage after 20.22/20.23 (2026-10-25)

The "UI half has no automated coverage" limitation above is now narrower but not closed. There is
still no frontend test runner (that is 20.26), so components remain covered by pure-helper unit tests
and manual walkthroughs. What does exist is a **convention gate**: `pnpm lint:ui` runs
`scripts/check-ui-conventions.mjs` and fails on a missing i18n key, an ISO-sliced timestamp, a raw
`<Empty>` and an internal `<a href="/…">`. Those four rules were chosen because each one was a real
shipped defect, not a style preference — six raw-key renders and fourteen UTC timestamps among them.

## Status reconciliation — 2026-10-26 (Phase 20 completion update)

The 2026-10-25 reconciliation above was re-checked against the working tree on 2026-10-26, after the
review-driven sub-phases landed. As of 2026-10-26 the following are **shipped**, so the "still open"
claims about them are withdrawn:

- **20.20** — design token layer + brand colour (token sweep incl. the TSX inline literals, brand
  `primaryColor`) shipped; only the breakpoint consolidation (task 6) is deferred as polish.
- **20.21** — dark mode shipped (preference `light` / `dark` / `system`, `data-theme`, dark tokens).
- **20.22, 20.23, 20.24, 20.25, 20.26, 20.27** — state contract/error boundary, one formatter, page frame,
  settings search, frontend quality gate + axe audit, bounded first load + optimistic writes — shipped.

Phase 20 is therefore **complete** as of 2026-10-26.
