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

## Behaviour that matches upstream intent

- Hiding a menu entry is presentation only. Every endpoint keeps its own authorization, and a document
  can never widen access: the ACL filter runs after the document is applied.
- A tab the caller may not open is not rendered **and** the settings read refuses it with `403`.
- Reads of brand and language defaults stay open to any session, because the shell has to paint them.
- Icon and accent choices come from fixed allowlists; no remote or arbitrary icon source exists.

## Known limitations after sub-phases 20.1–20.6

- Only the platform documents (`brand`, `i18n`, `navigation`, `security`, `fileStorage`,
  `notifications`) are registered; the authentication, attachments, notifications, jobs, audit, users,
  teams, roles, API keys, layout manager and internal tabs are the plan's later sub-phases (20.7–20.10).
  The `security`, `fileStorage` and `notifications` rows exist and are readable/writable now, so those
  tabs need only UI.
- Service Desk and Customer Success documents are hosted and editable as flat policy rows; Sales keeps
  its own purpose-built form. None of the three is a registry document (§8.3 keeps their endpoints).
- `nav.quickCreate` is stored and validated but not yet consumed: the global create menu arrives with
  the command palette (20.14). `nav.board.enabled` is derived from the board grouping field rather than
  offered as an independent switch.
- The unsaved-changes guard covers the shell's own rail and browser unload. The app is mounted with a
  plain `BrowserRouter`, which exposes no navigation blocker, so an in-app link from outside the shell
  is not intercepted; moving to a data router is a separate change.
- The menu preview renders the *current caller's* tree. "Preview as another principal" (plan §4.4) needs
  a server-side impersonation parameter and is not built.
- Favorites, per-user UI preferences and role-scoped default menus are §5.1/§5.9 work (20.10, 20.15).
