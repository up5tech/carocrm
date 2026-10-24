# Main menu and navigation (Phase 20)

Scope: `PLAN_Phase_20_Settings_UX.md` §4.4, §4.5, §7.2, §14. Files: `apps/api/src/admin-panel/`
(`navigation.service.ts`, `navigation-defaults.ts`, `navigation-warnings.ts`, `settings-shapes.ts`) and
`apps/web/src/admin/tabs/MenuTab.tsx`.

## Pipeline

`GET /api/v1/Navigation` answers the menu for the caller. The order of operations is fixed:

```text
shipped defaults  →  `navigation` document  →  ACL filter  →  order
```

- **Shipped defaults** (`navigation-defaults.ts`) are the entries the SPA used to hard-code: the seven
  working pages, the module submenus inside RECORDS, the extension contributions and the
  administration entries.
- **The document only overrides.** An entry it does not name keeps its default. An entry it names that
  no longer exists is dropped, and a key it does not recognise is ignored with a warning. That is what
  lets a document written before an upgrade keep working.
- **The ACL runs last.** An entity the caller may not read is never in the tree, whatever the document
  says, and the underlying endpoint still answers `403`. A direct URL is unaffected by hiding.
- **Order** is an integer; a tie breaks on the key, so the menu is deterministic across restarts.

Cost: one `app_settings` read, one role snapshot (memoised per request) and no query per menu item.
Cached in process for 30 s per user, keyed on the metadata version, and dropped the moment the
`navigation` document is written.

## Keys

| Key | Names |
|---|---|
| `home` `search` `dashboards` `reports` `stream` `calendar` `myTasks` | a fixed page |
| `entity:<EntityName>` | a record entity's list route |
| `group:<key>` | a submenu or a container group (`group:records`, `group:crm`, `group:sales-catalog`) |
| `extension:<packageId>:<route>` | a nav entry an installed package contributed |
| `admin:<tabKey>` | an administration screen |

`extension:` keys carry the route as well as the package id, because one package may contribute
several entries and each needs to be addressable on its own.

## Document

```jsonc
{
  "items":  [ { "key": "home", "enabled": true, "order": 10, "labelKey": "core.app.home" } ],
  "groups": [ { "key": "crm", "enabled": true, "order": 90, "accent": "blue" } ],
  "accentPalette": ["blue", "green", "orange", "red", "purple", "cyan", "magenta", "gold"]
}
```

`items` and `groups` are the same shape; a `groups` entry addresses `group:<key>`. Structure is strict
(unknown top-level keys are refused with `422`), but a key inside an entry is kept and reported as the
`unrecognizedProperty` warning, so a future property does not break an existing document.

Validated values: `labelKey` must resolve in the catalogs (otherwise the entry keeps its default label
and the tab warns), `icon` must be in `NAVIGATION_ICONS`, `accent` in `NAVIGATION_ACCENTS`. Both lists
are fixed allowlists; nothing remote or arbitrary is ever named.

## Per-entity behaviour

An entity's own placement lives in its metadata (`nav`, §4.5), edited on the Entity Manager's
Navigation tab and saved through `POST /Metadata/:entity` like any other section:

```jsonc
"nav": { "hidden": false, "order": 300, "group": "customers", "board": { "enabled": true, "defaultGroupBy": "stage" } }
```

- `group` must name a group this instance renders; the metadata writer refuses an unknown one through
  the `NAVIGATION_GROUP_KEYS` seam, so an administrator cannot type a group that would silently drop
  the entity into the ungrouped remainder.
- `order`, `group` and `board` accept `null` to mean "no override", which the Entity Manager sends when
  a field is left empty.
- `hidden` removes the entry from the menu only. The list, the records and the API keep working.
- `board.defaultGroupBy` is the field `/<Entity>/board` opens grouped by.

## The tab

The Main Menu tab builds its rows from the caller's own resolved tree, so it can only offer entries
that really exist, and lists an entry the document switched off at the end so it can be switched back
on. Only what the administrator changes is written: an entry left alone emits no override and keeps
following the platform default, including a new module installed later. Reordering has both a pointer
(drag) and a keyboard path (up/down buttons, with the move announced in the live region).
