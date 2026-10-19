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

## Behaviour that matches upstream intent

- Hiding a menu entry is presentation only. Every endpoint keeps its own authorization, and a document
  can never widen access: the ACL filter runs after the document is applied.
- A tab the caller may not open is not rendered **and** the settings read refuses it with `403`.
- Reads of brand and language defaults stay open to any session, because the shell has to paint them.
- Icon and accent choices come from fixed allowlists; no remote or arbitrary icon source exists.

## Known limitations after sub-phases 20.1–20.8

- Only the platform documents (`brand`, `i18n`, `navigation`, `security`, `fileStorage`,
  `notifications`) are registered; the authentication, attachments, notifications, internal and
  messaging tabs are the plan's later sub-phases (20.9–20.10).
  The `security`, `fileStorage` and `notifications` rows exist and are readable/writable now, so those
  tabs need only UI.
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
- `nav.quickCreate` is stored and validated but not yet consumed: the global create menu arrives with
  the command palette (20.14). `nav.board.enabled` is derived from the board grouping field rather than
  offered as an independent switch.
- The unsaved-changes guard covers the shell's own rail and browser unload. The app is mounted with a
  plain `BrowserRouter`, which exposes no navigation blocker, so an in-app link from outside the shell
  is not intercepted; moving to a data router is a separate change.
- The menu preview renders the *current caller's* tree. "Preview as another principal" (plan §4.4) needs
  a server-side impersonation parameter and is not built.
- Favorites, per-user UI preferences and role-scoped default menus are §5.1/§5.9 work (20.10, 20.15).
