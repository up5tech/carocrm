# Phase 20 — Settings, Administration and End-User UX/UI

> **Status:** ✅ **Phase 20 COMPLETE** (2026-10-20): All 17 sub-phases implemented and verified.
> Settings document registry, admin panel descriptors and tabbed shell, General/Localization/Main
> Menu/Layouts tabs, hosted module documents, `GET /Navigation` with ACL-filtered resolution,
> per-entity `nav` metadata, Users/Teams/Roles/API keys tabs, Security/Messaging/Integrations/
> Internal tabs with guarded danger zone, per-user preferences, shared state components, list-view
> power pack (URL state, columns, inline edit, bulk+undo), record page unsaved guard + keyboard save,
> command palette, role-scoped default dashboards, setup checklist, accessibility hardening and
> responsive design.
>
> **Added after completion — Phase 20.19 (✅ implemented 2026-10-24):** the home workspace (§5.6, §17).
> `/home` is now a role-aware workspace — greeting/search/create hero, focus strip, today's agenda, at
> most three KPI dashlets of the effective default dashboard, followed activity and a compact admin
> setup banner — with no per-entity count grid and no per-module request fan-out. Frontend-only: no
> endpoint, migration, table or database write.
>
> **Added after completion — Phase 20.18 (✅ implemented):** record-page relation tabs (§5.11, §17).
> The 20.0–20.17 work above stands as shipped; 20.18 is an additive sub-phase with its own acceptance
> criteria, delivered as **entity metadata edited in the detail layout settings** — not as a per-user
> preference on the record page.
>
> **Proposed after a UI/UX review — Phases 20.20–20.27.** `docs/ux/ui-review.md` audits the shipped
> SPA and proposes eight additive sub-phases, specified in §17 and prioritised in §18: the design
> token layer and a real brand colour (20.20), dark mode (20.21, P2, needs an explicit decision), one
> state contract plus an error boundary (20.22), one timestamp formatter (20.23), one page frame
> (20.24), settings search (20.25), the frontend quality gate that finally makes 20.16's axe criterion
> verifiable (20.26), and a bounded first load with optimistic writes (20.27).
>
> **20.22 and 20.23 are implemented (2026-10-25).** The SPA now has an error boundary at the root and
> per route, a four-variant empty state used by all 41 former raw `<Empty>` call sites, an offline
> banner wired to React Query's `onlineManager`, every admin/ops timestamp through `formatDateTime`,
> and `pnpm lint:ui` enforcing the four rules those fixes established. The remaining six (20.20,
> 20.21, 20.24–20.27) are **not** implemented; nothing below is a claim about current behaviour.
>
> **Open deferrals** (documented in `docs/compatibility/settings-ux.md`, "Known limitations after
> sub-phases 20.11–20.17"): the ACL explain helper, storage-usage figures, cross-page
> "select all N matching records", bulk-action outcome counts, the row kebab menu, column
> reorder/resize/freeze, list virtualization, the Favorites group, the record-page sticky header and
> next-action band, "Save & new", the palette's `/` shortcut and server-persisted recents, the setup
> banner's per-user dismissal, `nav.quickCreate` consumption, and KPI trend (target and previous
> window are implemented). 2FA and menu preview-as are implemented.
> The plan's 20.16 acceptance criterion ("axe passes on the four core surfaces") is **met as of
> 2026-10-26** (§20.26's axe piece: `@axe-core/playwright` scans home, list, record and settings
> with zero WCAG 2.0 A/AA violations — see `docs/ux/accessibility.md`).
>
> This document remains the scope, architecture reference and implementation roadmap for Phase 20.
> Implemented behaviour is documented in `docs/admin/settings.md`, `docs/admin/navigation.md`,
> `docs/ux/` and the deviations in `docs/compatibility/settings-ux.md`.
> **Parent roadmap:** `PLAN.md` — Phase 20 (added to §57 alongside this document)
> **Target runtime:** NestJS / TypeScript backend with the existing React SPA
> **Functional reference:** EspoCRM Administration documentation and the Administration Panel /
> User Interface concepts, plus documented UX behavior of leading CRM products
> **Implementation rule:** build on the platform completed in Phases 0–19. Do not reimplement kernel
> capabilities inside this phase.

---

## 1. Purpose

This phase delivers two connected outcomes that make CaroCRM operable and pleasant to use:

1. **Settings and Administration.** An administrator must be able to configure the whole instance —
   branding, language and time, **the main menu**, layouts, users, teams, roles, authentication,
   email and notifications, files, integrations, and every module's own settings document — from a
   coherent, tabbed Administration area instead of a single growing page.
2. **End-user UX/UI.** An end user (rep, agent, CSM, manager, portal contact) must be able to do the
   daily work — find a record, work a list, change a field, log an activity, act on a pipeline —
   with minimal hunting, minimal typing, and full keyboard reachability.

Both halves serve the same goal: **adoption**. A CRM nobody can configure or operate is expensive
spreadsheet software; the settings area makes the system match the company's process, and the UX
work makes people actually use it every day.

### 1.1 Primary outcomes

At the end of this phase, authorized users can:

1. Open `/admin/settings` and navigate every administrator capability through stable, tabbed
   sections with a persistent save bar, dirty-state guard and per-tab permissions.
2. Configure the **main menu**: enable, disable, rename, reorder, recolor and re-group navigation
   entries, including module submenus, without editing code.
3. Configure per-entity navigation behavior (hidden, order, group, quick-create, Kanban grouping)
   through the existing metadata system rather than a hard-coded list.
4. Manage users, teams, roles, API keys and portal settings from a UI instead of raw API calls.
5. See each module's existing settings document (Sales, Service Desk, Customer Success) inside the
   same tabbed shell, with version, warnings and last-modified context.
6. Reach any record, action or screen from anywhere through global search and a command palette.
7. Work dense record lists efficiently: saved views, URL-shareable filters, column management,
   density control, inline editing, scoped bulk actions and undo.
8. Operate the record page around a clear "next action" and progressive disclosure instead of a flat
   wall of fields.
9. Experience designed empty, loading, error, permission-denied and offline states everywhere.
10. Use the product with keyboard only, at WCAG 2.2 AA, on desktop, tablet and phone.
11. Arrange, per record type and as an administrator, whether related records render as today's
    stacked panels or as tabs the entity's detail layout defines (§5.11).

### 1.2 Explicit scope boundary

This phase does **not** re-implement or redesign:

- The Entity Engine, Metadata Registry, relation engine, query engine, layouts engine or field
  validation. UX work is expressed **through** those subsystems, never around them.
- Authentication, sessions, global Role/Team ACL, record-level ACL or field-level ACL. The settings
  area configures and displays them; it never bypasses them.
- The Stream/timeline, attachments, audit/history, notifications, Activities, Calendar, dashboards,
  jobs, search, import/export, formulas, dynamic logic, workflows or BPM engines.
- The relation model, the `/Related` link/unlink endpoints or relation ACL. §5.11 arranges the
  relation *panels*; it never changes what a relation is or who may read it.
- Portal product surfaces beyond portal **settings** (portal roles/navigation configuration).
- Visual redesign for its own sake. This phase hardens and systematizes the existing
  `carocrm-*` design language; a wholesale restyle is a separate decision.

Out of scope (deliberately): AI assistants/next-best-action scoring, mobile native apps, offline
sync, multi-theme (dark mode) support, per-user menu customization by end users (an admin-configured
menu plus personal favorites is enough), and localization quality beyond adding the new keys this
phase introduces.

---

## 2. Reference Baseline and Compatibility Notes

Use the project-wide compatibility policy in `PLAN.md`:

- **Phase A baseline:** EspoCRM 9.3.x documented behavior where this plan requires that baseline.
- **Phase B baseline:** newer upstream behavior only when explicitly recorded as an intentional later
  enhancement.

### 2.1 Upstream feature reference (Settings)

EspoCRM's Administration area is the functional reference for *information architecture* — which
settings exist, how they are grouped, and what an administrator expects to find. The relevant
documented areas:

- Administration overview and its functional areas (System, Users, Customization, Messaging, …).
- `app > adminPanel` metadata: panels are metadata-driven, each with `label`, `order` and an
  `itemList` of `{ url, label, iconClass, description }` — the model Phase 20 adopts for the tabbed
  settings shell (https://docs.espocrm.com/development/metadata/app-admin-panel/).
- `app > config` metadata: a config parameter declares a visibility `level`
  (`default` / `global` / `admin` / `internal` / `system` / `superAdmin`) and a `readOnly` flag — the
  model Phase 20 adopts for settings-document read/write permissions
  (https://docs.espocrm.com/development/custom-config-parameters/).
- Main menu customization lives under Administration → User Interface, where tabs are added,
  removed, reordered, disabled, recolored and re-iconed (https://www.espocrm.com/tips/customize-menu/).

### 2.2 Market reference (UX/UI)

The end-user UX part is not a port of any product. It applies patterns that are documented, widely
used and independently verifiable in leading CRM products:

- **Salesforce Lightning**: object-relative navigation, list views as first-class saved objects,
  inline editing in enhanced list views, contextual action menus, guided setup for admins.
- **HubSpot**: one object model with consistent record layouts, saved views per object, activity
  timeline on every record, unobtrusive onboarding checklist.
- **Zoho CRM**: dense administration settings organized by product area, guided setup wizard, strong
  in-context help.
- **Odoo / Pipedrive**: pipeline (Kanban) as a primary working view, one-click stage movement,
  keyboard-first data entry.

Sources and the specific patterns adopted are listed in §21.

### 2.3 Compatibility policy

- Reproduce documented *administrator-visible behavior* where practical; do not replicate upstream
  implementation details or file layout.
- Use this project's API, metadata, database and frontend conventions even when the upstream
  representation differs.
- Record deliberate deviations in `docs/compatibility/settings-ux.md`.
- Do not copy upstream PHP code, frontend assets, translations, icons or branding. Icons stay inside
  the fixed `@ant-design/icons` allowlist already used by `AppShell`.

---

## 3. Prerequisites and Repository Audit

The coding agent must read `AGENTS.MD` and `PLAN.md` and inspect the repository before implementing.
**Do not assume a subsystem exists because it appears in the master plan.** The audit below records
what is actually in the repository as of this plan.

### 3.1 Current state — Settings and Administration

Confirmed present:

- `app_settings (name PK, data JSONB, modified_at)` — one row per settings feature. Existing rows:
  `brand` (`apps/api/src/settings/brand.service.ts`), `i18n` (`apps/api/src/i18n/i18n.service.ts`),
  `sales`, `serviceDesk`, `customerSuccess` (one validated, versioned, Zod-checked row each).
- `POST /api/v1/Settings` accepts a **flat** patch of exactly six keys: `pageTitle`, `footerText`,
  `logoAttachmentId`, `defaultLocale`, `enabledLocales`, `defaultTimezone`
  (`apps/api/src/settings/settings.controller.ts`).
- Module settings documents already have the target shape: read → validate → version → warnings
  (for example `apps/api/src/sales/sales-settings.service.ts`, `service-desk-settings.service.ts`,
  `customer-success-settings.service.ts`).
- Administration screens that exist: `/admin/entity-manager` (+ `/:entityName`),
  `/admin/audit-log`, `/admin/jobs`, `/admin/extensions`, `/admin/workflows`, `/admin/processes`,
  `/admin/portals`, `/admin/settings` (`apps/web/src/AppRoutes.tsx`).
- Metadata registry supports scopes through `metadata_entries(scope, name, data)` and admin
  overrides through `app_settings('entity')`, merged in this order: core → extensions → admin
  (`apps/api/src/metadata/metadata-store.service.ts`, PLAN §12.2).

Confirmed gaps this phase must close:

- `apps/web/src/pages/AdminSettingsPage.tsx` is a **single 484-line page** that mixes the brand form
  and the entire Sales settings document; it has no tab structure, no per-tab permission, no dirty
  guard and no consistent save/error pattern.
- The administration menu is a **hard-coded array in `AppShell.tsx`**. There is no data-driven
  admin panel and no way to add, remove or reorder an administration entry without a code change.
- The sidebar navigation is built from **hard-coded name sets** (`NAV_GROUPS`, `SALES_NAV_GROUPS`,
  `MARKETING_NAV_NAMES` in `AppShell.tsx`) plus two ad-hoc visibility probes
  (`/Sales/action/nav`, `/Marketing/action/nav`). There is no per-entity nav metadata and no
  administrator control over the main menu.
- `navEntities()` in `apps/web/src/state/metadata.ts` filters only on `client.web !== false` and a
  `principalType !== undefined` no-op, so every navigable entity is rendered in the sidebar
  regardless of what the roles actually allow.
- **No admin UI for users, teams, roles or API keys.** `apps/api/src/auth/identity.controller.ts`
  exposes `User`, `Role`, `ApiUser`, `ApiKey`, `Team` endpoints, but the SPA has no screens for them.
- No settings tab for authentication, email accounts, attachments, file storage, or layout manager.
- There is no `app > adminPanel` metadata, no config `level` concept, and no settings registry that
  describes the settings documents at runtime.

### 3.2 Current state — End-user UX/UI

Confirmed present:

- Generic metadata-driven list, detail, edit pages (`EntityListPage`, `EntityDetailPage`,
  `EntityEditPage`), a Kanban board page, search page, dashboards/dashlets, stream, calendar,
  reports, projects views, service desk views.
- Saved filters with private/shared visibility on the list page; mass delete; layout-ordered
  columns (`apps/web/src/pages/EntityListPage.tsx`).
- Sidebar is a desktop rail and a mobile drawer with its own state variables; header search box
  navigates to `/search?q=` on Enter (`apps/web/src/components/AppShell.tsx`).
- Ant Design 5 with a `carocrm-*` CSS layer (`apps/web/src/theme.ts`, `apps/web/src/styles/`).
- i18n catalogs `en`/`vi` under `i18n/` with a `t()` helper.

Confirmed gaps this phase must close:

- No global command palette; search requires clicking the header input then pressing Enter.
- List view has no column manager, no density control, no URL-encoded filter state, no inline
  editing, no scoped "select all N rows", no bulk-action undo, no row-level action menu.
- Record detail is a flat panel list with no "next action" affordance and no sticky header.
- Relation panels are one stacked card per relationship in metadata order
  (`EntityDetailPage.tsx`), with no display mode and no administrator-arranged tabs; an entity with
  many relations buries the record itself (§5.11, 20.18).
- No unsaved-changes guard on edit forms; no save-and-new flow.
- Empty/loading/error states are implemented ad hoc per page rather than through shared components.
- No accessibility audit record; keyboard support is partial (Escape on the drawer, Enter on the
  collapse toggle).
- No onboarding, setup checklist or first-run experience.
- The home page (`/home`) is a **record inventory, not a workspace**: one stat tile per enabled
  entity, each fed by its own `GET /{entity}?maxSize=1` request. The page grows with the module
  list, spends one request per module, and says nothing about what needs the user today. It has no
  greeting, no next action, no agenda, no curated KPI and no activity. (20.19)

### 3.3 Gap handling

If a prerequisite is missing:

1. Identify the smallest interface or extension the phase needs.
2. Decide whether it belongs in the kernel (`packages/`, `apps/api/src/core` concerns) or in this
   phase's module code.
3. Implement the smallest reusable platform enhancement in its established location; do not create a
   second implementation of an existing subsystem.
4. Record the gap and its compatibility impact in the completion report.

### 3.4 Repository and database safety

- Preserve all user changes; inspect `git status` before editing and before finalizing.
- Follow `AGENTS.MD` §3. Integration/API/smoke tests use the **existing configured primary database**.
  Do not create `test_db`, shadow, temporary, per-agent or per-run databases, and do not add tooling
  that would.
- Do not reset, truncate, broadly delete or recreate the database.
- Migrations for this phase are additive (seed rows and, at most, one small table). Review the SQL
  before applying it; never regenerate schema to fix a migration error.
- Use narrowly scoped, clearly marked test records and delete only what the run created.

---

## 4. Functional Requirements — Part A: Settings and Administration

### 4.1 The Administration shell (tab model)

The Administration area becomes a **settings shell with a tabbed route space**:

- `GET /api/v1/AdminPanel` returns the panel definition for the current user: an ordered list of
  tabs, each with `{ key, route, labelKey, descriptionKey, icon, order, level, group }`.
- `groups` are the higher-level sections (System, Users, Customization, Messaging, Integrations),
  mirroring the upstream panel structure; tabs live inside a group. Group and tab order are
  metadata-driven, so a module can contribute a tab without touching the shell.
- The SPA renders `/admin/settings/:tabKey?` — with no tab key it redirects to the first tab the
  current user may open. Tabs are lazy-loaded route components, not one bundled page.
- Each tab declares a **level** (`admin`, `superAdmin`, or `internal` read-only) taken from the
  config-parameter model. A tab the user may not open is not rendered and is refused server-side
  even on a direct URL.
- The shell provides: a left tab rail on desktop, a horizontal scrollable tab strip on narrow
  viewports, a sticky save bar with Save / Discard / Reload, an unsaved-changes guard on navigation
  and unload, and a per-tab "last modified by/at" footer.

### 4.2 Settings document registry (backend)

- A **registry** (`SettingsRegistryService`) maps document name → Zod schema, read level, write
  level, default value and owning module. It is the single place that answers "what settings exist,
  who may read them, what is valid".
- Documents continue to live in the existing `app_settings` table, one row per document, keeping
  the Phase 0–19 convention (`brand`, `i18n`, `sales`, `serviceDesk`, `customerSuccess`). **Do not
  introduce a second settings store.**
- Every document supports: read (returns `{ name, value, version, modifiedAt, modifiedById,
  warnings }`), write (validates, applies, bumps version, records who changed it) and reset-to-
  default (admin-only, per document).
- Writes use **optimistic concurrency**: a `PATCH`/`POST` carrying the version it read is rejected
  with `409 CONFLICT` and the current server version when the document changed in between.
- Document registration lives in the module that owns the document, so Phase 19 modules keep their
  current services and simply register their schema instead of exposing bespoke endpoints.
- Settings that only affect the browser (density, column prefs, last tab) are **not** documents;
  they are per-user UI preferences (see §5.9).

### 4.3 Tab catalog

The catalog below is the target. Every tab states its storage owner and required level. Tabs marked
**new** have no UI today; they reuse existing API capability where it exists.

| # | Group | Tab key | Contents | Store / API | Level |
|---|-------|---------|----------|-------------|-------|
| 1 | System | `general` | Page title, logo, footer text, brand mark | `brand` (existing) | admin |
| 2 | System | `localization` | Default locale, enabled locales, default timezone, date/number format | `i18n` (existing, extended) | admin |
| 3 | System | `layout` | Per-entity list/detail layout manager (drag & drop panels, field order, tab order, list columns, filter and mass-update fields) | entity metadata `layouts` (existing) | admin |
| 4 | System | `menu` | Main menu configuration (§4.4) | `navigation` (**new document**) | admin |
| 5 | System | `attachments` | Upload limits, allowed MIME/extensions, storage driver info, storage usage | `fileStorage` (**new document**) | admin |
| 6 | System | `jobs` | Scheduled job list, enable/disable, run history, queue health | `GET /Job` (existing API) | admin |
| 7 | System | `audit` | Audit log viewer and retention note | `GET /AuditLog` (existing) | admin |
| 8 | System | `internal` | Cache/metadata version, instance identity, feature flags, danger zone (metadata reset, queue purge — each individually confirmed) | **new document**, guarded | superAdmin |
| 9 | Users | `users` | User list, create, edit, activate/deactivate, role & team assignment, password reset | `/User` (existing API) | admin |
| 10 | Users | `teams` | Team CRUD, membership, team ACL overview | `/Team` (existing API) | admin |
| 11 | Users | `roles` | Role CRUD, entity/field/record permission matrix editor, portal roles | `/Role` (existing API) | admin |
| 12 | Users | `apiKeys` | API users, key issuance and revocation | `/ApiUser`, `/ApiKey` (existing) | superAdmin |
| 13 | Users | `portals` | Portal CRUD and portal role policy | `/Portal` (existing) | admin |
| 14 | Security | `authentication` | Password policy, session/refresh policy, login page notice, (P2) 2FA | `security` (**new document**) | superAdmin |
| 15 | Security | `permissions` | Global default team, mandatory ACL summary, "who can see what" explain helper | derived read-only from ACL | admin |
| 16 | Messaging | `email` | Email accounts, outbound config status, signatures, B2C mode flag | `/EmailAccount` (existing API) | admin |
| 17 | Messaging | `notifications` | Default notification preferences, digest options | `notifications` (**new document**) | admin |
| 18 | Integrations | `extensions` | Installed extensions, version, enable/disable, permissions contributed | `/Extension` (existing) | admin |
| 19 | Integrations | `webhooks` | Webhook endpoints, events, delivery history | `/Webhook` (existing) | admin |
| 20 | Integrations | `sales` | Sales settings document (features, currency, pricing, tax, numbering, inventory, subscriptions) | `sales` (existing) | admin |
| 21 | Integrations | `serviceDesk` | Service desk settings document | `serviceDesk` (existing) | admin |
| 22 | Integrations | `customerSuccess` | Customer success settings document | `customerSuccess` (existing) | admin |

Marketing Automation settings and any future module settings document join the same table through
registry registration; no per-module page is created.

### 4.4 Main Menu configuration (administrator-controlled navigation)

**This is the headline settings capability of the phase.**

Data model — one `navigation` settings document:

```jsonc
{
  "items": [
    { "key": "home",  "enabled": true, "order": 10, "labelKey": "core.app.home" },
    { "key": "search","enabled": true, "order": 20, "labelKey": "core.app.search", "inQuickSearch": true },
    { "key": "group:Customers", "enabled": true, "order": 100, "labelKey": "nav.group.customers", "accent": "blue" }
  ],
  "groups": [
    { "key": "Customers", "enabled": true, "order": 100, "labelKey": "nav.group.customers", "accent": "blue" }
  ],
  "accentPalette": ["blue", "green", "orange", "red", "purple", "cyan", "magenta", "gold"]
}
```

Rules:

- A **key** is stable: `home`, `search`, `dashboards`, `reports`, `stream`, `calendar`, `myTasks`,
  `entity:<EntityName>`, `group:<GroupKey>`, `extension:<PackageId>`, `admin:<TabKey>`.
- The document only **overrides defaults**. An unknown or removed key is ignored, not an error, so a
  document written before an upgrade keeps working.
- Reordering moves a key; enabling/disabling hides it. Deleting a key means "back to default".
- `labelKey` must resolve in the catalogs (a missing key falls back to the metadata label and raises
  a warning in the tab's warning list, exactly like the Sales settings warnings pattern).
- `accent` and icon choices come from the **fixed allowlist** already used in `AppShell`
  (`EXTENSION_ICONS` / `entityIcon`). No remote or arbitrary icon source may be introduced.
- **Permission rule (hard):** the menu document is presentation only. An entity that the current
  user may not read never appears, whatever the document says, and the server refuses the data. A
  direct URL to a forbidden entity keeps returning `403`.
- Server-side nav projection: `GET /api/v1/Navigation` returns the resolved, ACL-filtered, ordered
  menu tree for the caller. The SPA renders that tree instead of recomputing it in `AppShell`. This
  removes the current hard-coded `NAV_GROUPS`/`SALES_NAV_GROUPS`/`MARKETING_NAV_NAMES` duplication and
  the ad-hoc `salesVisible`/`marketingVisible` probes.

UI:

- The `menu` tab shows the current menu as a sortable, nestable list (drag & drop with keyboard
  alternative: move up/down with buttons, never drag-only).
- Each row: enable switch, order handle, label override (select from catalog keys + custom key),
  icon select from the allowlist, accent select, reset-to-default.
- A preview panel renders the resulting sidebar for a "sample" principal so an administrator can
  see the effect without signing in as someone else.
- "Restore defaults" restores the shipped menu in one confirmed action.

### 4.5 Per-entity navigation metadata

Extend `EntityDefinition` with a `nav` section (additive, optional, defaults preserve today's
behavior):

```jsonc
"nav": {
  "hidden": false,          // never rendered in navigation even if metadata says web: true
  "order": 300,             // sort weight inside its group
  "group": "Customers",     // group key; entities without one land in the ungrouped remainder
  "quickCreate": true,      // shown in the global create menu
  "board": { "enabled": true, "groupBy": "status", "defaultGroupBy": "status" }
}
```

- The schema lives in `packages/metadata/src/schemas/index.ts` beside `RecordDefinition` and
  `ClientDefinition`, with defaults, so existing entities keep validating untouched.
- Entity Manager gains a **Navigation** tab where these values are edited, validated by the same
  `POST /Metadata/:entity` path as every other metadata section.
- An entity removed from navigation is still fully usable by direct URL and API — hiding is not
  disabling.

### 4.6 Layout manager

- A single tab listing every entity with a layout, with a live preview.
- Per entity: list columns (order, visibility, width, frozen), detail panel layout (drag & drop
  panels and fields), edit form order, tab order, filter fields, mass-update fields.
- Writes go through the existing metadata `layouts` mechanism; validation reuses the existing
  layout schema, so a layout referencing an unknown field is rejected with a clear message.
- Drag & drop always has a keyboard equivalent (move up/down buttons) and a non-pointer fallback.

### 4.7 Users, teams, roles, API keys

- **Users tab**: paginated table (search, filter by role/team/active), create/edit form with role and
  team multi-select, activate/deactivate, password reset. Destructive actions (deactivate, reset)
  require confirmation and state what will be lost.
- **Teams tab**: CRUD, membership editor, and a read-only summary of the team's record access.
- **Roles tab**: role list plus a permission matrix (entity × action) and a field-level tab. Editing
  must show the current user's own effective access so an administrator does not lock themselves out
  — the server must refuse a change that would strip the last administrator's administrative level.
- **API keys tab**: create an API user with an explicit role, issue/rotate/revoke keys. The secret is
  shown exactly once, with a copy affordance and no logging.
- All four reuse `identity.controller.ts`. **No new user-management API is introduced.**

### 4.8 Security, messaging and integrations tabs

- **Authentication**: password policy (length, complexity, reuse), session and refresh-token
  lifetime, password reset policy, login-page notice. Secrets stay in environment configuration and
  are never rendered here.
- **Permissions**: read-only summary of global ACL, mandatory record rules, field-level rules, plus
  an "explain why" helper for a given user+entity.
- **Email**: list configured email accounts with status, per-account test send, default signature,
  B2C mode toggle. Credentials are masked and never returned by the API.
- **Notifications**: instance defaults for notification behavior, overridable per user.
- **Extensions / Webhooks**: existing management screens relocated under the tabbed shell with
  consistent page structure; no behavior change.

### 4.9 Administration navigation

- The Administration menu is rendered from the same admin-panel descriptor as the settings shell, so
  the left rail, the `/admin/settings/:tabKey` routes and the `/admin/<area>` routes share one source
  of truth.
- Entries the current user may not open are not rendered and are refused server-side.

### 4.10 Setup checklist (first-run guidance)

- An internal `SetupChecklist` service evaluates a fixed list of checks (admin user created,
  second role defined, at least one team, email account configured, logo uploaded, at least one
  custom field, first workflow, main menu reviewed) and returns done/pending with a deep link.
- Rendered on the admin home and dismissible per user. It is guidance only; it never blocks anything
  and never writes configuration by itself.

---

## 5. Functional Requirements — Part B: End-user UX/UI

The guiding principle, consistent across every requirement below: **fewer clicks, fewer fields,
fewer unknowns.** Cut data entry to the bone, design for the role, respect power users, and always
surface the next action.

### 5.1 Information architecture

- The sidebar leads with the daily working surfaces (Home, My Tasks, Search, Dashboards) and keeps
  administration out of the way at the bottom.
- Record modules are grouped exactly as the `navigation` document says; grouping is per-role by
  default through role-scoped default menus (P1).
- **Favorites / pinned navigation**: every user can pin up to N entries to a Favorites group at the
  top. Stored server-side (not `localStorage`) so it follows the user across devices, and filtered
  by the same permission rules as the rest of the menu.
- A "recently visited" list in the command palette covers the rest.
- Deep links: every list state (filters, sort, page, view name) is encoded in the URL so a user can
  paste a link into chat and a colleague lands on the same screen.

### 5.2 Global search and command palette

- `Ctrl/⌘ + K` opens a command palette from anywhere; `/` also focuses it when not typing in a field.
- Three modes in one surface: **Commands** (navigate, create, toggle theme density, switch entity),
  **Records** (ACL-filtered global search with entity grouping), **Recent** (visited routes and
  records).
- Results are keyboard-first: arrows to move, Enter to open, Esc to dismiss, focus returns to the
  invoking element. Results are debounced (~150 ms) and capped (top 20 with "see all" deep link).
- The palette reads the same search API as `/search`; it adds no new server capability and no new
  permission surface.

### 5.3 List view power pack (the highest-value work for daily users)

- **Saved views (server-side)**: a named snapshot of filters + columns + sort + density. Shared views
  are team-visible; personal views are per user. System defaults (e.g. "My open opportunities") may
  not be deleted. The active view name appears in the page header, and a view with unsaved local
  changes is marked as modified.
- **URL state**: filters, sort, page size, page, active view and column set all serialize to the
  query string; loading a URL restores the exact screen.
- **Column manager**: show/hide, reorder (drag + keyboard), resize, freeze first column, reset to
  default. Persisted per user per entity.
- **Density control**: comfortable / default / compact row heights, persisted per user.
- **Inline editing** for low-stakes columns: click or `Enter` to edit, validate on blur, save with
  `Enter`, cancel with `Esc`, errors rendered **in the cell** — never as a toast. Fields that feed
  calculations, forecasts or documents keep the modal/record form.
- **Bulk actions**: selection checkboxes reveal on row hover; a floating bottom action bar appears
  after selection; the header checkbox has an indeterminate state and offers an explicit
  "select all N matching records" that states the exact count; bulk operations report exactly how
  many records changed and how many were skipped for permission reasons.
- **Undo** for bulk actions that are reversible (mass assign, mass update) with a visible timeout;
  destructive mass delete requires typed confirmation.
- **Row actions**: a per-row kebab menu (Edit, Open, Assign, Follow, Delete) whose contents are
  permission-filtered server-side, so a user never sees an action that will fail.
- **Table ergonomics**: sticky header, frozen identifier column, right-aligned numbers with tabular
  figures, virtualization at 2 000+ rows.

### 5.4 Record page

- **Sticky header**: record name (inline-editable when permitted), status, owner, and the primary
  action (Edit / Next action). Remaining actions in a kebab menu.
- **Next action band**: the single most useful next step for the record type (e.g. "Log a call",
  "Create invoice", "Advance stage"), computed from status and existing activity. It is a hint, not
  an automation, and never appears when the user lacks permission.
- **Progressive disclosure**: primary fields above the fold; secondary fields, relations, history and
  raw metadata behind tabs or collapsible panels. The default panel set follows the entity layout.
- **Relation panels** show counts, a quick-add input, and link/unlink with permission feedback.
- **Relation tabs** (§5.11): the entity's detail layout decides whether those panels stack as today or
  live in tabs an administrator arranges in Entity Manager → Layout.
- **Activity timeline** (Stream) stays on every record; posting supports `@mentions` as today.
- **Duplicate detection** warns before creating a likely duplicate record, reusing the existing
  `record.duplicate` metadata rather than adding a new mechanism.

### 5.5 Forms

- Only the fields a role needs: edit forms honor field-level ACL, dynamic logic and layout order.
- Smart defaults from entity metadata and settings (owner = current user, status = pipeline entry
  stage), so a new record starts valid.
- `Save`, `Save & new`, `Cancel`; unsaved-changes guard on navigation, tab switch and browser unload.
- Inline, per-field validation messages (not toasts) with focus moved to the first invalid field.
- Server validation messages are mapped back to their field; a field-less error is shown as a form-level
  alert.
- Keyboard: `⌘/Ctrl + Enter` saves, `Esc` cancels from a modal, focus trap inside modals.

### 5.6 Dashboards and next actions

- Role-scoped default dashboards (manager vs. rep vs. support), editable by the user afterwards.
- Every KPI shows value plus context (comparison period, target, trend) — a bare number is noise.
- Dashlet-level empty and error states; "last updated" timestamp and a staleness warning when data
  exceeds its refresh expectation.
- **The home page is a workspace, not an inventory.** It never renders one count per enabled entity;
  per-module counts belong to dashboards, reports, lists and the sidebar. Home answers four
  questions in this order: *what needs me now* (tasks, approvals), *what is on today* (agenda),
  *what is the pulse* (at most three KPI dashlets from the user's effective default dashboard) and
  *what changed* (followed activity). A user with nothing waiting sees a calm done state, not a
  wall of zeros or dashes.
- KPI curation is an administrator/role decision made in Dashboards, not a hard-coded list on the
  home page. With no KPI dashlet the pulse rail is omitted; home never falls back to counting every
  module.

### 5.7 States and feedback

Shared, reusable state components used by every page:

- **Loading**: skeleton matching the final layout for < 300 ms requests; spinner for longer.
- **Empty**: first-use (with a primary CTA, e.g. "Create your first opportunity"), zero-results
  (with filter-reset and saved-view hints), and done ("Nothing needs your attention").
- **Error**: human-readable message plus Retry, with the technical detail behind a disclosure. Never
  a raw stack trace or SQL text.
- **Permission denied**: an explanatory empty state, not a dead 403 screen.
- **Optimistic updates** for low-risk writes (stage change, toggle, inline edit) with automatic
  rollback and a clear message when the server rejects.
- **Toasts** are used for confirmations and background results only; anything blocking belongs inline.

### 5.8 Accessibility

Target WCAG 2.2 AA:

- Full keyboard operability of navigation, lists, forms, modals, the palette and the settings tabs.
  No drag-only interaction anywhere (every drag has a keyboard equivalent).
- Visible focus indicators on every interactive element; logical tab order; focus restored after
  modal close and after palette dismissal.
- ARIA roles on the menu, table, tabs, dialog and combobox customizations; screen-reader labels on
  icon-only controls.
- Contrast ≥ 4.5:1 for text and ≥ 3:1 for UI components and chart marks; color is never the only
  signal.
- Touch targets ≥ 44 × 44 px on touch devices.
- Reduced motion respected (`prefers-reduced-motion`) for skeleton shimmer, drawer and modal motion.

### 5.9 Per-user UI preferences

A dedicated `UserPreference` document per user (server-side, not `localStorage`): locale/timezone
override, density, column sets per entity, favorites, last visited routes, dismissed setup steps,
default dashboard, and list page size. This is a **user** resource, not an instance setting, and must
not be writable by other users.

### 5.10 Localization of the experience

- Every new key is added to `i18n/en/web.json` and `i18n/vi/web.json` (plus `crm.json`/`core.json`
  where the domain fits), following the existing naming conventions.
- Strings are never hard-coded in components: no literal user-visible English in JSX.
- Dates, numbers and currencies follow the user's locale and timezone everywhere, using one shared
  formatter rather than per-page `toLocaleString` calls.
- Layout must tolerate longer translations (German/Vietnamese) without truncation of action labels.

---

### 5.11 Record-page relation tabs (Phase 20.18)

`EntityDetailPage` renders one card per relationship, stacked in metadata order
(`apps/web/src/pages/EntityDetailPage.tsx`, the `relations.map(…)` block). That is fine for an entity
with two relations and unreadable for an Account or an Opportunity with eight: the link lists push the
record's own content several screens up, and nothing on the page can be reordered by the person who
actually works the record.

This sub-phase arranges **that surface only**. Field panels stay governed by the `detail` layout
(§4.6); the activity, communications and commercial panels (§5.4, 19-S.7, 19-VC.17) keep their fixed
position below the relation area.

#### Where it is configured

The arrangement is **entity metadata** — the `detailTabs` section of the entity definition — and it is
edited in the entity's **detail layout settings** (Entity Manager → Layout → `detail`, also hosted in
the settings shell's **Layout** tab). It is **not** edited on the record page and it is **not** a
per-user preference.

Two reasons decide this:

- a record page is a shared surface. The strip is part of the page's structure, so a page whose
  sections move per viewer cannot be referenced in support, training or a link. The layout that
  describes the page belongs to the entity;
- it is the same kind of configuration as the panels right next to it, and it is written through the
  same route. There is no second editing surface to keep in step.

The record page therefore has **no** editor, **no** mode switch and **no** preference lookup. It
renders what the metadata says.

#### Modes

| Mode | Rendering |
|------|-----------|
| `stacked` (**default**) | Today's behaviour: one card per relation, metadata order — unchanged. |
| `tabs` | A tab strip above the relation area; only the active tab's panels mount and fetch. |

An entity with no `detailTabs` section renders `stacked`, so nothing changes until an administrator
arranges something.

#### Data model

```jsonc
{
  "detailTabs": {
    "mode": "tabs",              // or "stacked"
    "tabs": [
      { "id": "people",     "label": "People",     "order": 0, "relations": ["contacts"] },
      { "id": "commercial", "label": "Commercial", "order": 1, "relations": ["quotes", "invoices"] }
    ]
  }
}
```

- Declared in `EntityDefinitionSchema` (`packages/metadata/src/schemas/index.ts`) and written through
  the **existing** `POST /api/v1/Metadata/:entity` route, exactly like `layouts` and `nav`:
  **no migration, no new table, no new endpoint.**
- The Zod schema and the pure arrangement helpers live in `packages/metadata/src/relation-tabs.ts`, so
  the API validates and the SPA normalizes with the same code, and the logic is covered by the
  existing vitest include (`packages/*/src/**/*.test.ts`) — this repository has **no frontend test
  runner** (see §13.4).
- Limits: `mode ∈ {stacked, tabs}`; ≤ 20 tabs per entity; `id` matching `[a-z0-9][a-z0-9-]{0,39}` and
  never the reserved `other`; `label` 1–40 characters; ≤ 60 relation names per tab, each ≤ 60
  characters.
- **A relation may appear in at most one tab of an entity** (`refine` → `422`), and a tab may only
  name a relation the entity actually has: the controller checks the names against
  `definition.relations` on write (`422` otherwise). Unlike a user preference, this section is
  administrator input against a known entity, so a typo is refused instead of silently dropped.
  A **stored** section that names a relation removed later is still readable: the record page
  reconciles it against `definition.relations` on read, and the layout editor reconciles before it
  saves, so the stale name is dropped rather than sent back and refused.

#### Behaviour rules (hard)

1. **Nothing changes for an entity nobody arranged.** No section → `stacked` → today's page.
2. **No relation can be lost.** Relations no tab names render in an implicit, non-deletable
   **Other** tab, always last. It is computed, never stored.
3. **Deleting a tab is presentation, not data.** Its relations return to the unassigned pool (Other);
   the confirmation says exactly that.
4. **A relation belongs to one tab.** Moving it to another tab removes it from the previous one in the
   same mutation — a move, never a copy.
5. **Renaming never changes the id**, so a `?tab=people` link survives a rename. Ids are slugified from
   the label once and stay stable for the life of the tab.
6. **ACL is untouched.** Tabs are presentation over the same `/Related` calls; a tab whose relations
   the caller cannot read is hidden and its stored arrangement is left intact, because permissions can
   come back. Panels keep exactly today's link/unlink behaviour, including permission failures.
7. **Empty tabs are allowed while editing** (create the tab first, move relations in later) and hidden
   on the record page.
8. **Zero or one relation → no editor section.** There is nothing to arrange; the section is not
   rendered in the layout settings either.
9. **Portal stays stacked.** Customer-facing surfaces stay out of scope, consistent with the 19-VC.17
   decision; the record page ignores the section there.
10. **Switching back to panels keeps the arrangement.** `mode` is a rendering choice, not a reset:
    switching to tabs again restores the tabs exactly as they were.
11. **Command-backed panels do not participate.** A commercial document's `items` panel
    (`SalesDocumentLinesPanel`) is the money the document is calculated from, not a link list, and it
    stays outside the tab area; so do Stream and Communications.
12. **Every relation panel pages its relation.** A panel asks `/Related` for one page
    (`offset`/`maxSize`, `total` for the pager) instead of a capped slice, so a relation larger than a
    page stays reachable. The page is a page of the **relation**, not of one of the two ways a record
    can belong to it: the attribute match and the `entity_links` rows are one union in the query, so a
    record reachable both ways is listed and counted once.

#### The editor (Layout settings → detail)

- The section sits under the detail layout editor, next to the panels, and only for an entity with two
  or more relations.
- A `Segmented` (**Panels** / **Tabs**) sets the entity's `mode`; it comes first because it decides
  whether the rest matters.
- One block per tab plus the computed **Other** pool. A tab can be renamed, deleted and reordered;
  relations appear as chips that move by **drag** (dnd-kit, the stack the layout editor already uses)
  **or** through their `Move to…` select — no drag-only interaction anywhere (§5.8). The move-up /
  move-down buttons on a tab header are the keyboard equivalent of dragging a tab.
- Tab edits join the layout editor's ordinary draft: they set the same **dirty** state, and the
  shell's **Save** writes `detailTabs` (only when it changed) in the same `POST /Metadata/:entity` as
  the panels; **Discard** restores the stored arrangement along with everything else.

#### Reading the arrangement on the record page

- The stored value is the source of truth for writes; the *view* is reconciled against the entity's
  own relations: a relation the entity no longer has disappears from the screen, a relation listed
  twice keeps its first tab, and the tab order is preserved.
- Only the **active** tab mounts, so an entity with eight relations makes one `/Related` call instead
  of eight; a tab that is never opened never fetches.
- The strip uses antd `Tabs` (roving tabindex, arrow keys and the ARIA `tablist` pattern come with
  it), scrolls horizontally rather than wrapping, and its label shows the number of **panels** in the
  tab — never record counts, which would cost one query per relation.
- `?tab=<id>` is written to the URL on tab change, so a refresh and a pasted link land on the same tab;
  an unknown id falls back to the first tab and the URL is corrected. Only tab mode carries the
  parameter.

#### Compatibility note

Upstream EspoCRM exposes relation panels as administrator-defined layout panels and has no per-user tab
arrangement; arranging them inside the entity's detail layout follows upstream's model rather than
deviating from it. Record the behavior in `docs/compatibility/settings-ux.md`.

#### Localization

Every new string is a catalog key (`web.detail.panels`, `web.detail.tabs.*`) in `en` and `vi`.
Tab labels are **administrator data** and are deliberately not translated — the §5.10 "no hard-coded
strings" rule governs the UI chrome, not what an administrator typed.

---

## 6. Domain Model and Persistence Design

### 6.1 New and changed data

| Object | Storage | Notes |
|--------|---------|-------|
| `navigation` settings document | `app_settings` row | §4.4 main menu configuration |
| `fileStorage` settings document | `app_settings` row | limits, allowed types |
| `security` settings document | `app_settings` row | password/session policy |
| `notifications` settings document | `app_settings` row | instance defaults |
| `nav` entity metadata section | `metadata_entries` / `app_settings('entity')` | §4.5, additive |
| `adminPanel` app metadata | `metadata_entries` scope `app` | tab descriptors (§4.1) |
| `UserPreference` entity/record | existing generic record store or a dedicated table | §5.9, per user |
| `detailTabs` entity metadata section | `metadata_entries` / `app_settings('entity')` | §5.11, per entity, written with `layouts`; **no migration** |
| Setup checklist | derived, not stored | §4.10 |

No new table is required for the settings documents: the existing `app_settings(name, data,
modified_at)` row-per-document convention is reused. A migration is needed only to seed the default
`navigation`, `security`, `fileStorage` and `notifications` rows idempotently and to register the
`app` metadata scope if the loader does not already read it.

### 6.2 Settings document shape

```jsonc
// app_settings row "navigation"
{
  "version": 3,
  "value": { "items": [ /* §4.4 */ ], "groups": [ /* §4.4 */ ] },
  "warnings": [],
  "modifiedById": "…",
  "modifiedAt": "…"
}
```

- Every write runs the document's Zod schema **before** the row is touched; a rejected write leaves
  the stored document untouched and returns `422 VALIDATION_FAILED` with per-issue paths.
- Unknown keys are rejected for documents marked `.strict()`; `navigation` is deliberately lenient on
  unknown *keys inside items* (forward compatibility) but strict on structure.
- Reset-to-default writes the registered default document, not `null`.

### 6.3 Ordering and identity rules

- Order values are integers; ties break on `key` ascending so the menu is deterministic.
- Favorites are a per-user ordered key list; unknown or now-invisible keys are dropped on read and
  re-saved lazily.
- Numeric sequence values used by Sales numbering are **not** touched by this phase.

### 6.4 Soft delete, retention and audit

- Settings documents are versioned rows; no soft-delete semantics apply. A destructive document change
  is recorded through the audit mechanism as a settings-change entry (actor, document, changed keys).
- Audit rows for settings must never contain secrets (password policies, API keys, SMTP credentials).
- The `internal` danger zone never deletes records; it only resets configuration documents and
  metadata overrides, and each action requires explicit confirmation plus a typed phrase.

---

## 7. Backend Architecture

### 7.1 Module boundaries

- `apps/api/src/admin-panel/` (new): admin panel descriptors, settings registry, settings document
  controller/service, navigation projection endpoint, setup checklist.
  - `admin-panel.service.ts` — registry of documents and tabs.
  - `settings-document.service.ts` — read/write/reset/version/concurrency for a document.
  - `navigation.service.ts` — resolves the menu tree for a principal.
  - `setup-checklist.service.ts` — derived checks.
- `apps/api/src/settings/` (extended): the existing `brand`/`i18n` documents register with the
  registry; `SettingsController` keeps its public read and delegates its write to the registry.
- Module-owned documents (Sales, Service Desk, Customer Success, Marketing) stay in their own
  services and register their schema — the registry must not absorb their validation logic.
- `apps/api/src/auth/identity.controller.ts` gains no new surface; the SPA uses what exists. Any
  missing capability (e.g. password reset) is added as a minimal, tested endpoint in that module.

Dependency rule: the admin panel depends on the request scope, ACL, metadata registry and the
settings services; **nothing domain-specific may depend on the admin panel**.

### 7.2 Services

- `SettingsRegistryService.register(document)` — name, schema, defaults, read/write level, group,
  label, description. Registration happens at module bootstrap, in the owning module.
- `SettingsDocumentService.read(name)`, `.write(name, value, version)`, `.reset(name)`,
  `.history(name)` (last N versions if the phase records them; otherwise last-modified only).
- `NavigationService.resolve(principal)` — ACL-filtered, ordered menu tree including admin and
  extension entries.
- `SetupChecklistService.evaluate(principal)` — pure-ish checks over existing services.

### 7.3 Transaction and consistency rules

- A settings write is a single-row upsert inside a transaction when it touches more than one row
  (for example reset that also clears a dependent cache marker).
- Metadata cache invalidation happens **after** a successful commit, never before.
- Navigation resolution reads settings and ACL in one pass; it must not call the database per menu
  item (build the ACL map once).

### 7.4 Events and hooks

- Emit a settings-changed domain event (`settings.document.updated` with document name and actor)
  after a successful write. Subscribers: navigation cache invalidation, audit log, and the SPA's
  settings query cache.
- Do not add new hook phases. Use the existing event bus (§23).

---

## 8. API Plan

All endpoints under `/api/v1`, authenticated except where noted, with admin-level authorization
enforced server-side on every settings route.

### 8.1 Administration panel and settings documents

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/AdminPanel` | admin | Tabs and groups for the current user |
| GET | `/Settings/documents` | admin | Registered documents: name, label, level, version, modifiedAt |
| GET | `/Settings/documents/:name` | admin (level) | `{ name, value, version, modifiedAt, modifiedById, warnings }` |
| POST | `/Settings/documents/:name` | admin (write level) | Write with `version` for optimistic concurrency |
| POST | `/Settings/documents/:name/reset` | admin | Restore the registered defaults |
| GET | `/Navigation` | any user | Resolved, ACL-filtered menu tree for the caller |
| GET | `/SetupChecklist` | admin | Ordered checks with deep links |
| GET/PUT | `/UserPreference` | any user | Per-user UI preferences (§5.9) |

Existing `GET/POST /Settings` (public brand/locale read, admin write) **stays** for backward
compatibility; the write path delegates to the registry so both routes share validation.

**Phase 20.18 adds no route.** The `detailTabs` section (§5.11) rides the existing
`POST /Metadata/:entity` route next to `layouts`: admin-only by that route's own guard, `422` on an
invalid arrangement or on a relation the entity does not have, and audited as
`entity.relationTabs.update` — the same audit trail as every other layout change.

### 8.2 Navigation and metadata

- `POST /Metadata/:entity` accepts the new `nav` section; unknown keys are rejected like any other
  metadata section.
- `GET /Metadata` responses include `nav` so the SPA can build previews.

### 8.3 Module settings

No new module endpoints. `GET/POST /Sales/settings`, `/ServiceDesk/settings`,
`/CustomerSuccess/settings` keep working; the SPA tab consumes the same endpoints through the shell.

### 8.4 API requirements

- Validation with Zod, stable error envelope, `422` with per-issue paths, `409` on version
  conflict, `403` when the caller's level is insufficient.
- No secret value is ever returned; masked placeholders only, and a `PATCH` that omits a secret
  leaves it unchanged.
- Every settings write is auditable (actor, document, changed top-level keys, no values of secret
  fields).
- OpenAPI (`GET /api/v1/OpenApi`) is regenerated and the endpoint registry in `api-spec/` (PLAN §58)
  gains `admin-panel.yaml` and `settings.yaml` entries.
- Idempotency: writes are idempotent for an identical payload at the same version; the first write
  bumps the version, a replay of the same payload with the old version returns `409` with the
  current version rather than applying twice.

---

## 9. Frontend Plan

### 9.1 Structure

```
apps/web/src/admin/
  AdminLayout.tsx           # group rail + tab strip + sticky save bar + guard
  tabs/GeneralTab.tsx  LocalizationTab.tsx  MenuTab.tsx  LayoutTab.tsx
       UsersTab.tsx    TeamsTab.tsx     RolesTab.tsx  ApiKeysTab.tsx
       AuthenticationTab.tsx  EmailTab.tsx  NotificationsTab.tsx
       AttachmentsTab.tsx  JobsTab.tsx  AuditTab.tsx  ExtensionsTab.tsx
       WebhooksTab.tsx  InternalTab.tsx  ModuleSettingsTab.tsx
  navigation/
    NavigationProvider.tsx  # fetches /Navigation once, exposes the tree
    NavMenu.tsx  Favorites.tsx
  registry.ts               # tab key -> lazy component + level
apps/web/src/components/
  states/EmptyState.tsx LoadingSkeleton.tsx ErrorState.tsx PermissionDenied.tsx
  CommandPalette.tsx  RecordHeader.tsx  NextAction.tsx  ColumnManager.tsx
  DensityToggle.tsx  BulkActionBar.tsx  UnsavedGuard.tsx  HelpTip.tsx
  RelationTabs.tsx          # §5.11: the record page's read-only strip (stacked or tabs)
  RelationTabsEditor.tsx    # §5.11: the layout-settings editor (dnd-kit + "Move to…" select)
packages/metadata/src/
  relation-tabs.ts          # §5.11: Zod schema + pure normalize/move/add/remove helpers + tests
```

- Routes: `/admin/settings/:tabKey?` replacing the single `/admin/settings` route; the old URL
  redirects to the default tab so bookmarks keep working.
- Tab components are `React.lazy` so the settings bundle does not grow with the catalog.
- A shared `ModuleSettingsTab` adapts an existing module settings endpoint (Sales/CS/SD) to the
  shell's save bar, warnings and version display — the Sales collapse currently embedded in
  `AdminSettingsPage.tsx` is the first client of it and is removed from that page.

### 9.2 Interaction rules

- Save bar: Save is enabled only when the form is dirty; Discard reverts to the loaded value; Reload
  refetches. Saving shows per-tab progress and a success/failure message; failures keep the user's
  input.
- Navigation with unsaved changes prompts for confirmation; the tab rail shows a dot on dirty tabs.
- Every tab renders: loading skeleton, error state with Retry, permission-denied state, empty state.
- Drag & drop (layout manager, menu order, columns) always has keyboard equivalents and announces
  the move for screen readers.
- Relation tabs (§5.11): a tab edit sets the layout editor's dirty state and rides its Save; a rejected
  save keeps the draft and explains why; every chip has a `Move to…` equivalent to dragging.

### 9.3 Design system

- Continue with Ant Design 5 primitives and the existing `carocrm-*` CSS layer and
  `theme.ts` tokens; no new component library (see `AGENTS.MD` §8).
- Add tokens for density, spacing scale and state colors to `theme.ts` rather than scattering inline
  styles.
- The settings shell, list view and record page must not look like untouched Ant Design demos: keep
  the existing card and page-head conventions, and give the tab rail a distinct treatment.

### 9.4 State management

- TanStack Query, already used, owns all server state: `['adminPanel']`, `['settings', name]`,
  `['navigation']`, `['preferences', name]`, `['metadata']` (which carries the entity's `detailTabs`
  section, §5.11), `['records', …]` for lists.
- The navigation tree is fetched once and cached with a short stale time; a settings change
  invalidates it.
- No new global state library is introduced.

---

## 10. Security and Authorization Matrix

| Capability | Read | Write | Enforcement |
|------------|------|-------|-------------|
| Brand / localization settings | any user (needed for shell) | admin | server on POST; the public read exposes only brand + locale |
| Navigation document | any user (resolved tree only) | admin | server; tree is ACL-filtered per caller |
| Layouts / entity `nav` metadata | admin | admin | `POST /Metadata/:entity` |
| Users / teams / roles | admin | admin | server per endpoint; self-service never allowed |
| API keys | superAdmin | superAdmin | secret shown once, never returned again |
| Security policy document | admin read, superAdmin write | superAdmin | server |
| Internal / danger zone | superAdmin | superAdmin | server, per-action confirmation |
| Module settings documents | admin | admin | the owning module's controller |
| User preferences | owner | owner | server rejects another user's id |
| Navigation **data** for entities | user | — | existing record/field ACL, unchanged |

Hard rules:

- Hiding a menu entry is presentation. Every underlying endpoint keeps its own authorization.
- The navigation document can never widen access; it is merged **after** ACL filtering, not before.
- Secrets (SMTP passwords, API key material, session secrets) are never stored in `app_settings`,
  never returned by any settings read, and never logged.
- Uploads keep the existing MIME/size/extension validation; the `attachments` tab only sets limits
  that the server enforces at upload time.
- The command palette must not become a search oracle: it queries the same ACL-filtered endpoints and
  shows nothing the user could not already see at a URL.

### 10.1 Security-specific tests

- A non-admin user requesting any settings document gets `403`.
- Crafting a `navigation` document that references an entity the caller cannot read does not reveal
  that entity.
- A user cannot read or write another user's preferences.
- API key secrets never appear in any API response, log line or audit row.
- Permission matrix editing cannot remove the last administrator's administrative level.
- Untrusted label keys, icon names and accent values are validated against allowlists.

---

## 11. Validation, Business Rules, and Failure Modes

| Situation | Required behavior |
|-----------|-------------------|
| Invalid settings payload | `422` with per-issue paths; stored document unchanged |
| Stale version on write | `409` with the current version; the client offers reload/merge |
| Unknown key in the navigation document | Ignored, with a warning in the tab's warning list |
| Missing label key | Falls back to the metadata/default label and raises a warning |
| Entity removed from metadata but still in the menu | Entry disappears silently; no dead link |
| Entity exists but user has no read access | Entry omitted from the resolved tree |
| Settings write while another admin is editing | Last-writer-wins only if the version matches; otherwise conflict |
| Module settings document with an invalid policy (e.g. currency/feature conflict) | Rejected with the module's own reason text, warnings preserved |
| Tab the user may not open, entered by URL | `403` state, no partial render |
| Drag-and-drop reorder that fails to persist | Visual order reverts and an error is shown |
| Palette opened with no network | Empty-state message, no crash |
| Large settings payload | Body-size limit enforced (existing limits), `413` |
| Tab arrangement names a relation that no longer exists | Dropped on read; the rest of the arrangement is untouched; no error shown |
| Tab arrangement lists one relation in two tabs | Refused `422` by the `detailTabs` schema |
| Tab mode on an entity whose relations are all unreadable | The tab is hidden; the stored arrangement is untouched |
| `?tab=` names an unknown or hidden tab | Falls back to the first tab and corrects the URL |
| Preference write fails while arranging tabs | UI reverts to the last stored arrangement and shows an inline error |
| Tab mode on an entity with fewer than two relations | The mode toggle is not rendered at all |

---

## 12. Notifications, Audit, and Observability

- Settings changes are audited: actor, document, changed keys, before/after version. Secret fields
  are redacted in the audit payload.
- A `settings.document.updated` event is emitted; subscribers invalidate caches and the audit log.
- Logs: structured, with request/correlation IDs, document name and actor; never document values for
  sensitive documents (authentication).
- Metrics: settings write failures, navigation resolution latency, palette/search latency, list query
  latency, and list-view virtualized row counts.
- No user-facing notification is sent for a settings change; it is an administrative audit concern.
- Optional (P2): a notification to administrators when a destructive internal action is used.

---

## 13. Testing Strategy

Per `AGENTS.MD` §9, choose the lowest-cost test that verifies the behavior, and use the existing
configured primary database for integration tests — never a new database.

### 13.1 Unit tests

- Settings registry: schema validation, default resolution, level checks.
- Navigation resolver: ordering with ties, unknown keys dropped, ACL filtering, admin/extension
  entries, favorites ordering.
- Menu normalization: default → document → ACL-filtered pipeline.
- Column/view serialization to and from URL query strings (round-trip).
- Permission matrix diffing and the "cannot lock out the last admin" rule.
- Command palette scoring/grouping helpers.
- Density/column preference merge (defaults + user overrides).
- Relation-tab arrangement helpers (`packages/metadata/src/relation-tabs.ts`, §5.11): unknown relation
  names dropped, order preserved, the implicit Other tab computed last, a relation moved between tabs
  exactly once, ids slugified once and stable across renames, schema refusals for duplicate relations,
  oversized labels and more than 20 tabs.

### 13.2 Repository/integration tests (existing primary database)

- Document read/write/reset/version/conflict against `app_settings`.
- `GET /Navigation` for an admin, a regular user with limited roles, and a portal user.
- Settings audit rows written with secrets redacted.
- Setup checklist evaluation with incomplete and complete installations.
- `detailTabs` round-trip through `POST /Metadata/:entity` and both read routes (`GET /Metadata` and
  `GET /Metadata/:entity`): a valid arrangement is stored and served back, a duplicate relation is
  refused, a relation the entity does not have is refused, and a refused write leaves the stored
  section untouched (§5.11; `apps/api/test/entity-manager-metadata.test.ts`).

### 13.3 API tests

- Unauthenticated `401`, non-admin `403`, insufficient level `403`.
- `422` on invalid documents for every registry entry.
- `409` on version conflict.
- Reset-to-default restores registered defaults, not `null`.
- OpenAPI contains the new endpoints with the documented status codes.

### 13.4 Frontend tests

- Tab routing, default-tab redirect, deep link with a dirty form.
- Save/discard/reload behavior and per-tab dirty markers.
- Menu editor: enable/disable/reorder/reset and the preview reflecting changes.
- List view: column manager, density, inline edit validation in-cell, bulk select-all scope,
  undo toast.
- Palette: open with `⌘/Ctrl+K`, arrow navigation, focus restore.
- Relation tabs (§5.11) — this repository has **no frontend test runner**, so these are manual
  browser checks, recorded in the phase report: in the entity's detail layout settings, switch to tabs
  and back; create, rename, reorder and delete a tab; drag a relation into a tab and do the same move
  through `Move to…` with the keyboard only; save and confirm the record page shows the tabs; reload
  and reopen a `?tab=` link; delete a tab and confirm its relations land in Other; confirm the record
  page itself offers no editor.
- Home workspace (20.19) — `e2e/home.spec.ts` covers the render, the hero search, the Create menu, the
  focus-card links, the absence of the old grid and of any per-entity `maxSize=1` fan-out, the bounded
  per-card request count, no post-login console error or failed response, and 390 px overflow. Still
  manual (no frontend test runner): empty/loading/error per card, independent failures, the KPI rail with
  0/1/4 KPI dashlets (only three render), the admin setup banner at incomplete and 100 %, keyboard
  order, and the 1440/1180/768 px layouts.

### 13.5 End-to-end acceptance scenarios

1. An administrator configures the main menu (rename, reorder, disable a module, set an accent),
   signs out, signs in as a regular user and sees the configured menu **without** the entities their
   role forbids; a forbidden URL still returns `403`.
2. An administrator edits the Sales settings inside the new tab, sees the version and warnings,
   saves, and the change is visible to a salesperson.
3. A salesperson uses `⌘/Ctrl+K` to find a contact, opens it, edits a field inline in the list,
   saves with `Enter`, and sees the change reflected on the record page.
4. A support agent filters a case list, saves it as a shared view, pastes the URL into chat, and the
   colleague lands on the same filtered view.
5. A bulk assign of 50 opportunities reports "48 updated, 2 skipped (no permission)" and can be
   undone within the timeout.
6. A first-run administrator sees the setup checklist with working deep links and can complete the
   logo + role + email steps.
7. A user opens an Account with six relations, switches the relation area to tabs, creates a "People"
   tab, moves Contacts and Opportunities into it by drag and by keyboard, deletes the tab, and finds
   both relations back under Other; the next Account they open is unaffected.
8. A regular user signs in and lands on a home workspace that greets them, offers search and create,
   and shows their tasks, today's agenda, a small curated KPI rail and followed activity — **without
   one count tile per module and without one list request per module**. An administrator with an
   incomplete setup checklist sees the compact banner; once complete, it disappears.

### 13.6 Accessibility tests

- Automated axe pass on settings shell, list view, record page and palette.
- Keyboard-only walkthrough of each scenario above.
- Focus-visible and focus-return assertions.

---

## 14. Performance and Scalability

- Navigation resolution must be **one** settings read plus ACL evaluation, not N queries; cached in
  process for a short TTL and invalidated on settings/role change.
- The palette debounces and caps results; it never fires a query per keystroke.
- List views virtualize at 2 000+ rows; server pagination remains the primary mechanism.
- Settings documents are small JSONB rows; no document may exceed a sane size (reject > 256 KB).
- The settings shell lazy-loads tabs; the initial admin route must not pull in Sales/Service Desk
  settings code.
- Relation tabs mount only the active tab (§5.11), so a record with eight relations issues one
  `/Related` call on open instead of eight; tab counts are never fetched.
- Target: settings page interactive < 1.5 s on a mid-range laptop; navigation tree available before
  first content paint; list interactions < 100 ms.

---

## 15. Migration and Installation

### 15.1 Migrations (additive)

- `044_phase20_settings_documents.sql`: idempotent seed of `navigation`, `security`, `fileStorage`
  and `notifications` default rows in `app_settings` (`ON CONFLICT DO NOTHING`); enable the `app`
  metadata scope row for admin-panel descriptors. **No destructive DDL, no table drop, no data
  rewrite.**
- Optional later migrations only if the design proves insufficient; each reviewed before applying.

### 15.2 Backward compatibility

- With no `navigation` document, the resolved menu equals today's hard-coded menu. The rollout may
  therefore ship the resolver before the tab UI.
- Entities without `nav` metadata keep today's grouping and order.
- Existing `GET/POST /Settings` clients keep working unchanged.

### 15.3 Upgrade notes

- Upgrade notes list the new tabs, the new navigation endpoint, and the fact that a `navigation`
  document now controls ordering.
- Seed data for a fresh installation is idempotent; `pnpm db:seed` continues to work.

---

## 16. Documentation Deliverables

- `docs/admin/settings.md` — tab catalog, levels, document registry, how to add a tab/document. ✅
- `docs/admin/navigation.md` — menu model, keys, resolution pipeline, per-entity nav metadata. ✅
- `docs/ux/design-principles.md` — the UX principles of §5 with concrete do/don't examples. ✅
- `docs/ux/list-view.md` and `docs/ux/record-page.md` — the two highest-traffic surfaces. ✅
- `docs/ux/accessibility.md` — keyboard map, focus rules, contrast tokens, known gaps. ✅
- `docs/ux/record-tabs.md` — relation tabs: the metadata section, the layout-settings editor, the
  arrangement rules, the implicit Other tab, the keyboard path, deferrals. ✅
- `docs/compatibility/settings-ux.md` — deviations from upstream administration behavior. ✅ (+ the
  §5.11 deviation when 20.18 lands)
- Update `docs/reference/alpha-status.md` and `docs/reference/compatibility-matrix.md`. ✅
- Update `PLAN.md` §57 status once the phase lands. ✅

---

## 17. Implementation Phases and Work Order

### Phase 20.0 — Repository audit and feature contract  ✅ done 2026-10-18

Tasks: verify §3.1/§3.2 against the live code; confirm the configured database target without
exposing credentials; produce the exact document/tab/metadata schema proposal for review.

Acceptance: the proposal matches existing conventions (`app_settings` rows, Zod documents, metadata
merge order) and introduces no second settings store.

### Phase 20.1 — Settings registry and document service  ✅ done 2026-10-18

Tasks: `admin-panel` module skeleton; registry with brand/i18n registered; read/write/reset/version;
`SettingsController` delegation; audit + event on write.

Acceptance: brand and locale documents work through both the legacy route and the new one; conflicts
return `409`.

### Phase 20.2 — Admin panel descriptors and shell  ✅ done 2026-10-18

Tasks: `GET /AdminPanel`; group/tab descriptor metadata; `/admin/settings/:tabKey?` routes, tab rail,
sticky save bar, dirty guard, per-tab levels, old URL redirect.

Acceptance: every tab is lazy-loaded; a non-admin cannot open a tab by URL; unsaved changes are
guarded.

### Phase 20.3 — General and Localization tabs  ✅ done 2026-10-18

Tasks: port the brand form to the General tab (logo, title, footer) and extend the Localization tab
with date/number format; move the Sales document out of `AdminSettingsPage` into the shell's shared
module-settings tab as the first client.

Acceptance: `AdminSettingsPage.tsx` no longer hosts Sales settings; the Sales tab shows version and
warnings.

### Phase 20.4 — Navigation resolution service  ✅ done 2026-10-18

Tasks: `GET /Navigation`; resolver with ACL filtering; admin and extension entries; favorites
support; unit tests for ordering, unknown keys and filtering.

Acceptance: the resolved tree for an unconfigured instance equals today's menu; no per-item database
query.

### Phase 20.5 — Main Menu settings tab  ✅ done 2026-10-18

Tasks: menu document schema; the sortable/nestable editor with keyboard equivalents, label/icon/accent
allowlists, preview panel, restore-defaults.

Acceptance: an administrator can reorder and disable entries; a forbidden entity still never
appears for a limited user.

### Phase 20.6 — Per-entity navigation metadata  ✅ done 2026-10-18

Tasks: `nav` section in the entity schema with defaults; Entity Manager Navigation tab; resolver
reads it; metadata validation rejects unknown group keys.

Acceptance: hiding an entity in metadata removes it from navigation but leaves direct URLs working.

### Phase 20.7 — Users, teams, roles and API keys  ✅ done 2026-10-19

Tasks: Users tab (paginated, role/team assignment, activate/deactivate, password reset); Teams tab;
Roles tab with permission matrix and last-admin protection; API keys tab with show-once secrets.

Acceptance: the four tabs work entirely through the existing identity API; no new user-management
endpoint beyond a documented minimal addition; secrets never returned twice.

Delivered: `users`, `teams`, `roles` and `apiKeys` tabs in the settings shell (`apps/web/src/admin/tabs/`),
all writes going to `/User`, `/Role`, `/Team`, `/ApiUser`, `/ApiKey`. The documented additions are
`GET /User` filters (`isActive/type/roleId/teamId`), `POST /User/:id/password-reset`, `DELETE /Role/:id`,
`POST /ApiUser/:id/key` and `DELETE /Team/:id`, plus `title`/`phone` in the user DTO so the editor cannot
blank them. The last-administrator rule is refused server-side on the state after the change
(`details.rule = lastAdministrator`); a role still assigned is refused the same way (`roleInUse`);
team roles are now actually granted through `teams_roles`. The secret exists only in the response that
created it. Portal roles stay on the Portals screen — see `docs/compatibility/settings-ux.md`.

### Phase 20.8 — Layout manager  ✅ done 2026-10-19

Tasks: per-entity list/detail/edit layout editing in the `layout` tab, live preview, keyboard
alternative to drag & drop, validation against the layout schema.

Acceptance: a layout referencing an unknown field is rejected with a clear message; changes render in
list/detail without a code change.

Delivered: the `layout` settings tab hosts the same `LayoutEditor` the Entity Manager uses — panels,
field order, the field pool (labelled **Other** on detail/edit, where the page renders it, and
**Disabled** on list, where it only means “not a column”), add/rename/remove panel, drag & drop plus
dnd-kit's keyboard sensor, and a live preview built from the draft (list = column order; detail/edit =
stacked panels plus the computed **Other** group). The tab opts into
the shell save bar with a new `usesSaveBar` descriptor flag and reports its draft to it; switching
entity with a dirty draft asks first. Writes go through `POST /Metadata/:entity`, whose
`validateLayouts` already refused unknown fields and views with `422` naming the offender — pinned by
`apps/api/test/metadata-api.test.ts` and now also asserted for the descriptor in
`apps/api/test/navigation.test.ts`.

### Phase 20.9 — Security, Messaging, Integrations and Internal tabs  ✅ done 2026-10-19

Tasks: authentication policy document; read-only permissions summary; email accounts; notification
defaults; extensions/webhooks relocation; internal tab with cache info and the guarded danger zone.

Acceptance: secrets are masked and never persisted in `app_settings`; danger-zone actions require
typed confirmation and are audited.

Delivered: a `security` group (Authentication over the `security` document, read-only Permissions
summary); the Messaging group (Email over the existing `/EmailAccount` + `/Email/action/transport`
APIs — passwords write-only and never served back; Notifications over the `notifications` document);
`attachments` over `fileStorage`; `webhooks` over the `webhook-integration` extension's
`/WebhookEndpoint` API with a not-installed state; and the `internal` tab backed by the new
`/AdminInternal` routes — instance facts plus the guarded danger zone. `metadata-reset` and
`queue-purge` demand the exact typed phrase (`422` with `details.expected` on mismatch), refuse
non-administrators, and audit every execution into `schema_changes` (`admin.internal.*`); refusals
write nothing. The extensions page had already joined the rail as a descriptor, so "relocation" is the
webhooks tab plus the descriptors. Pinned by `apps/api/test/admin-internal.test.ts` (guards + refusals +
no audit on failure) — the destructive success paths are not run against the configured database.

### Phase 20.10 — User preferences  ✅ done 2026-10-19

Tasks: per-user preference resource, endpoint and client; density, columns, favorites, default
dashboard; enforcement that only the owner may read/write.

Acceptance: preferences follow the user across devices and never leak between users.

Delivered: `GET/PUT /api/v1/Preferences[/:name]` over the new `user_preferences` table keyed
`(user_id, name)` (migration 055, additive). Ownership is structural — the routes carry no user id, so
only the caller's own rows are reachable, administrators included. The named-document registry
(`preference-shapes.ts`) validates `density`, `listPageSize`, `defaultDashboard`, `columns`,
`favorites`, `lastVisited` and `dismissedSetupSteps` and refuses unknown names; locale/timezone stay on
`/AppUser/me`. Consumers: list density + page size + the column manager on the list pages, and the
dashboards page opens on the starred `defaultDashboard` (a deleted dashboard clears the star).
`columns`, `favorites`, `lastVisited` and `dismissedSetupSteps` are stored and validated now; only
`columns` has an editor (20.12) — `favorites`, `lastVisited` and `dismissedSetupSteps` still have
none, which is a documented deferral. Pinned by
`apps/api/test/user-preferences.test.ts`: a value survives a fresh login (another device), two
accounts' views of the same name are independent both ways, and invalid input is refused.

### Phase 20.11 — Shared state components  ✅ done 2026-10-19

Tasks: `EmptyState`, `LoadingSkeleton`, `ErrorState`, `PermissionDenied`, `HelpTip`; adopt them in
the settings shell, list page, detail page and dashboards.

Acceptance: the four states exist as reusable components with documented usage; no page invents its
own loading/error markup.

Delivered: the five components in `apps/web/src/components/`. `EmptyState`, `LoadingSkeleton` and
`ErrorState` are used by the settings shell, the list page and the dashboards page.
`PermissionDenied` and `HelpTip` exist but are **not used by any page** yet — recorded as a deferral.

### Phase 20.12 — List view power pack  ✅ done 2026-10-19

Tasks: URL-encoded filter/sort/page state; column manager; density; inline edit with in-cell
validation; scoped select-all; floating bulk action bar; undo for reversible bulk actions; row kebab
menu filtered server-side; virtualization at 2 000+ rows.

Acceptance: a pasted URL reproduces the exact list; bulk actions report updated/skipped counts and
are undoable; inline errors never appear as toasts.

Delivered: URL state (`offset`, `orderBy`, `pageSize`, `q`, `where`), the column manager (per-entity
visibility, persisted in the `columns` preference), the density control, inline edit with the
validation message in the cell, the floating bulk bar and the undo toast. Deferred and documented:
cross-page "select all N matching records", bulk-action outcome counts (only mass delete is wired),
the row kebab menu, column reorder/resize/freeze, and virtualization at 2 000+ rows.

### Phase 20.13 — Record page and forms  ✅ done 2026-10-19

Tasks: sticky header with inline-editable name; next-action band; progressive disclosure panels;
relation panel quick-add; save/save-and-new/cancel; unsaved guard; keyboard `⌘/Ctrl+Enter` save;
duplicate warning.

Acceptance: field-level ACL and dynamic logic still govern the form; server validation maps back to
fields.

Delivered: the layout-driven detail page with relation link/new, the duplicate warning on create,
the unsaved-changes guard (browser unload and the record's own route) and the `⌘/Ctrl+Enter` save.
Deferred and documented: the sticky header, the next-action band, progressive disclosure and
"Save & new".

### Phase 20.14 — Command palette and global search  ✅ done 2026-10-19

Tasks: `⌘/Ctrl+K` palette with command/record/recent modes; keyboard-first navigation; focus
restore; debounce and result cap.

Acceptance: the palette reveals nothing the user could not see at a URL; it works from every screen.

Delivered: `apps/web/src/components/CommandPalette.tsx`, mounted in `AppShell.tsx`, with the three
modes; the record mode reads the same ACL-filtered search the search page uses. Deferred and
documented: the `/` shortcut, the "see all" deep link and the 20-result cap (12 is used).

### Phase 20.15 — Dashboards, setup checklist and onboarding  ✅ done 2026-10-19

Tasks: role-scoped default dashboards; KPI context (comparison/target/trend); setup checklist
service + admin home panel; empty-state CTAs across the product.

Acceptance: a fresh installation shows a working checklist with deep links; first-use empty states
offer the primary CTA.

Delivered: `GET /SetupChecklist` (`apps/api/src/setup-checklist/`) with the admin panel on the home
page, and the role-scoped default dashboard on the dashboards page (user star → role-scoped →
first dashboard). The KPI context (comparison/target/trend) is deferred — the dashlet shows the
value only.

### Phase 20.16 — Accessibility and responsive hardening  ✅ done 2026-10-19 (partial, see below)

Tasks: keyboard pass over every new surface; focus management; ARIA on menu/tabs/table/dialog;
contrast tokens; 44 px touch targets; `prefers-reduced-motion`; drawer/tab strip behavior on narrow
viewports.

Acceptance: axe passes on the four core surfaces; keyboard-only walkthrough of §13.5 scenarios 1–5
passes.

Delivered: the focus-visible ring, 36 px desktop controls with 44 px touch targets on coarse
pointers, `prefers-reduced-motion`, the ARIA labels on
the palette, the checklist and the bulk bar, the responsive breakpoints at 1180 / 768 / 390 px, and a
manual keyboard walkthrough. **The automated axe pass is met as of 2026-10-26** — the §20.26 axe
piece scans home, list, record and settings with zero WCAG 2.0 A/AA violations.
See `docs/ux/accessibility.md`.

### Phase 20.17 — Hardening, compatibility, and release readiness  ✅ done 2026-10-20

Tasks: complete unit/integration/API/frontend/a11y/e2e tests; run lint, typecheck, build and the
existing smoke scripts; verify migrations and upgrade path; translations for `en`/`vi`; OpenAPI and
`api-spec/` updates; documentation; diff review for secrets, unsafe SQL and upstream assets.

Acceptance: all P0/P1 items are implemented and verified; deferrals and deviations are listed; no
extra database was created and no destructive setup was introduced.

Delivered: `pnpm typecheck`, `pnpm lint` (clean — five errors the phase left behind are fixed),
`pnpm test` (138 files / 1876 tests) and `pnpm build` all pass; the `en`/`vi` catalogs are complete
(1886 keys each, none missing); the UX documentation (`docs/ux/`) was added and the compatibility
note, the alpha status and the compatibility matrix were brought up to date. Deferred: the frontend,
a11y and e2e test suites the task list asks for — this repository has no frontend test runner, and
no Playwright spec covers the §13.5 scenarios. `api-spec/` remains unwritten (PLAN §58 is a plan for
a later phase; the OpenAPI spec is generated at runtime).

### Phase 20.18 — Record-page relation tabs  ✅ implemented

Added after 20.0–20.17 shipped; independent of them. Scope and rules: §5.11.

**Scope decision (revised during implementation).** The first draft kept the arrangement in a
per-user `detailTabs` preference and put its editor on the record page. It was moved to the entity's
**detail layout settings**: the tab strip is part of the page's structure, a shared surface cannot
have per-viewer sections, and the configuration belongs next to the panels it replaces. The record
page now only renders the section.

Tasks:

1. `packages/metadata/src/relation-tabs.ts`: `EntityRelationTabsSchema` (`mode`, `tabs`, the
   one-relation-one-tab `refine`, the reserved `other` id) plus the pure helpers
   `normalizeArrangement`, `resolveEntityTabs`, `tabsOf`, `unassignedOf`, `seedArrangement`,
   `moveRelation`, `addTab`, `removeTab`, `renameTab`, `orderTabs`, `slugifyTabId`, `uniqueTabId` —
   and their unit tests beside the source. ✅
2. Declare `detailTabs` in `EntityDefinitionSchema` (`packages/metadata/src/schemas/index.ts`); no
   migration — the section is stored with the entity definition. ✅
3. `apps/api/src/metadata/metadata.controller.ts`: validate the section on write — the schema checks
   the shape, the controller refuses a tab that names a relation the entity does not have (`422`),
   and the patch is audited as `entity.relationTabs.update`. The `detailTabs` preference is removed
   from `preference-shapes.ts` and its tests. ✅
4. `apps/web/src/components/RelationTabsEditor.tsx`: the layout-settings editor — mode `Segmented`,
   one block per tab plus the computed Other pool, add / rename / reorder / delete, dnd-kit with the
   keyboard sensor and a `Move to…` select per relation. It is a controlled component: the layout
   editor owns the draft, the dirty state and the Save. ✅
5. `apps/web/src/components/LayoutEditor.tsx`: host the section under the `detail` view, only for an
   entity with two or more relations; reconcile the stored section against `definition.relations`
   before editing and include it in the same `POST /Metadata/:entity` when it changed. ✅
6. `apps/web/src/components/RelationTabs.tsx`: the record page's read-only renderer — stacked panels
   or the antd `Tabs` strip, `?tab=` URL sync, hidden unreadable tabs. No editor, no mode switch, no
   preference. `apps/web/src/state/detail-tabs.ts` is deleted. ✅
7. i18n keys in `en` and `vi`; `docs/ux/record-tabs.md`; compatibility note; alpha status. ✅

Acceptance:

- An entity nobody arranged renders today's record page unchanged. ✅
- An administrator can switch an entity to tabs in its detail layout settings and place relations in
  tabs; a deleted tab's relations return to the implicit **Other** tab, so no relation can disappear.
  ✅ (browser walkthrough: mode switch, create a tab, move a relation with `Move to…`, save; the
  delete, rename, reorder and keyboard-only paths are covered by the pure-helper unit tests only)
- A relation the caller cannot read renders nothing, and a tab whose relations are all unreadable is
  hidden without altering the stored arrangement. ✅
- Keyboard only: create a tab, move a relation into it, and reorder tabs without dragging. ✅
- Refresh and a shared `?tab=` link restore the same tab. ✅
- No migration, no new endpoint, no new table, and no change to `/Related` or ACL. ✅

Verification run: `pnpm typecheck` (both projects), `vitest run packages/metadata/src/relation-tabs.test.ts`,
`vitest run apps/api/test/entity-manager-metadata.test.ts apps/api/test/user-preferences.test.ts`.

Browser walkthrough (dev API + SPA, `Account`): the section renders under the detail layout with the
mode control and the computed *Other* pool; creating a tab and moving a relation into it set the
dirty state; Save wrote the section through `POST /Metadata/:entity`; the record page then rendered
`People 1` / `Other 7`, switched tabs, carried `?tab=people`, and — after the section was put back to
`stacked` — rendered the stacked panels again and dropped the parameter.

Not covered: drag-and-drop, tab rename/delete/reorder and the keyboard-only pass are exercised only
by the pure-helper unit tests, because this repository has no frontend test runner (§13.4).

### Phase 20.19 — Home workspace redesign  ✅ implemented 2026-10-24

Added after 20.0–20.18. Scope and product rules: §5.6. It is **frontend-only**: no endpoint,
migration, table or database write is involved, and no new dependency is added.

**Problem.** `/home` (`apps/web/src/pages/HomePage.tsx`) renders one stat tile per enabled entity
and fills each tile with its own `api.list(entity, { maxSize: 1 })`. That is an inventory of the
module list, not a workspace: the page grows with every module, makes one request per module (30+
on a configured instance), and tells the user nothing about what needs them now. The tile grid also
cannot answer the first-run case — it shows a wall of "—" instead of guidance.

**Product decision — what home is for.** Home answers four questions, in this order:

1. **What needs me now?** — my answerable process tasks and the process instances I am part of.
2. **What is on today?** — calls, meetings, tasks and project tasks for the user's local day.
3. **What is the pulse?** — at most **three** KPI dashlets from the user's effective default
   dashboard. Curation is an administrator/role decision made in Dashboards.
4. **What changed?** — the latest items from the followed activity stream.

Per-module counts stay on Dashboards, Reports, lists and the sidebar. Home **never** counts every
module, and it never falls back to an entity grid when no KPI is configured.

**Layout (desktop ≥ 1180 px).**

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Good afternoon, Jacky                            [ Search records…    ⌘K ]  │
│  Wednesday, 24 October · Sales manager                 [Create ▾] [Dashboards]│
│  2 tasks need an answer · 1 meeting today                                    │
└──────────────────────────────────────────────────────────────────────────────┘
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ MY TASKS        3  │ │ TODAY          2   │ │ APPROVALS      1   │
│ 2 overdue          │ │ 14:00 Acme call    │ │ 1 running          │
│ • Renewal · Fri    │ │ 16:30 Demo         │ │                    │
└────────────────────┘ └────────────────────┘ └────────────────────┘
┌──────────────────────────────────────────────┐ ┌─────────────────────────────┐
│ TODAY                                        │ │ AT A GLANCE                 │
│ 09:00  ● Kickoff — Acme                      │ │ Open pipeline   1,240,000   │
│ 14:00  ● Call — Northwind                    │ │ Win rate              38 %  │
│ 16:30  ● Demo — Contoso                      │ │ Open cases            12    │
│ View calendar →                              │ │ All dashboards →            │
│                                              │ ├─────────────────────────────┤
│                                              │ │ ACTIVITY                    │
│                                              │ │ JD posted on Acme · 2h      │
│                                              │ │ View stream →               │
└──────────────────────────────────────────────┘ └─────────────────────────────┘
```

The administrator setup checklist is a **slim banner under the hero**, not a permanent large card:
it appears only for an administrator whose checklist is incomplete and disappears at 100 %.

**Visual direction — "calm operating cockpit".** A quiet surface with one clear focal band, not a
chart wall. Keep Inter and the existing tokens; introduce no new font, illustration or external
image. The greeting is the only large type (28/34, 600, −0.02 em); card labels are 11 px uppercase
with 0.08 em tracking; KPI values are 22–28 px, 600, tabular numerals; body is 13.5 px. The hero gets
a very soft blue wash (white → `#eaf2ff` at the top-right) and no ornament; the three focus cards are
the memorable element — the day stated in one sentence, with the work that needs the user directly
under it. Accent chips use the product's existing blue plus status colours only for overdue/due-soon
semantics, and colour is always paired with text. Surfaces are white, 14 px radius, 1 px `#e8edf5`,
one 0–1 px shadow; motion is limited to a 120–180 ms value fade and is disabled by
`prefers-reduced-motion`.

**Tasks.**

1. **Extract the default-dashboard decision.** Move the priority currently inlined in
   `DashboardsPage.tsx` (user-starred `defaultDashboard` → role-scoped → first) into one shared,
   pure helper used by both screens, so home and Dashboards can never pick different dashboards.
   Behaviour must not change.
2. **Home data model** — `apps/web/src/pages/home/home-model.ts`: greeting key from local hour;
   local-day bounds for the agenda; the one-sentence focus line; KPI dashlet selection (first three
   KPI dashlets in `position` order); agenda cap (+N more); overdue count; relative activity label.
   Pure functions, no React.
3. **Home data hooks** — `apps/web/src/pages/home/useHomeData.ts`, one React Query key per card:
   - `['home','tasks']` → `api.processTasks({ limit: 50 })` (the default status set already includes
     `overdue` and `escalated`); derive overdue from `dueAt` and keep `total` for the count.
   - `['home','approvals']` → `api.processInstances({ status: 'running', limit: 1 })`.
   - `['home','today']` → `api.calendar({ from, to, timeZone, entities: ['Task','Call','Meeting',
     'ProjectTask'], maxSize: 50 })`, using the same day calculation as `CalendarPage`.
   - `['home','pulse']` → `api.dashboards()` then the selected dashboard's KPI dashlets via
     `api.runDashlet` (max three, in parallel).
   - `['home','activity']` → `api.activityStream({ view: 'followed', maxSize: 5 })`.
   - `['home','setup']` → `api.setupChecklist()` only for `principal.type === 'admin'`.
   `staleTime` 60 s (tasks 30 s), `retry: 1`, `refetchOnWindowFocus: true`. Each card owns its own
   loading/empty/error state; one failure must not blank the page.
4. **Compose the page** — `apps/web/src/pages/HomePage.tsx` becomes a thin composition of the
   components below. Delete the old `Count` type, the `TONES` list, the per-entity `api.list` effect
   and the permanent `SetupChecklistPanel`; no dead code or unused imports remain.
   - `HomeHero.tsx` — greeting, localized long date, role/title line, focus sentence, inline record
     search (Enter → `/search?q=…`; the `⌘K` hint is text, the palette already owns the shortcut),
     primary **Create** dropdown built from `navEntities` (alphabetical, scroll-capped, icon + label,
     route `/{entity}/create`) and a secondary **Dashboards** link.
   - `FocusStrip.tsx` — three cards: my tasks (total, overdue, two nearest due items), today (count,
     next event), approvals (running count). Whole card is one link: `/tasks`, `/calendar`,
     `/tasks?tab=approvals`. No nested interactive elements.
   - `TodayAgenda.tsx` — up to six events with a time gutter and a type dot, "+N more" to
     `/calendar`, done state when the day is empty.
   - `PulseStrip.tsx` — at most three KPI tiles from the effective default dashboard, label + value
     with tabular numerals, "All dashboards" link. Renders **nothing** when there is no dashboard or
     no KPI dashlet, or when the request fails. No invented trend/comparison: the dashlet contract
     has no comparison yet (§5.6 deferral).
   - `ActivityFeed.tsx` — latest five followed-stream items, author initials, existing
     `updateSummary`, record link, relative time, "View stream" link; empty state invites search.
   - `SetupBanner.tsx` — compact progress + next two incomplete steps for administrators only;
     hidden at 100 %.
   - `HomeSkeleton.tsx` — card-shaped skeletons matching the final layout.
5. **Styling** — add a `.carocrm-home-*` block in `apps/web/src/styles/carocrm.css` next to the
   dashboards/reports blocks (one comment naming this phase). Reuse the current design language:
   canvas `#f5f7fb`, white surface, 1 px `#e8edf5`, 14 px radius, `0 1px 2px rgba(16,24,40,.04)`,
   blue `#438eff`, text `#31373d` / `#737b85` / `#8b939d`, existing status tokens. The hero may use a
   very soft blue wash; no hero image, no external asset, no new font. Keep Inter.
6. **Responsive rules** — ≥ 1180 px: hero split and `minmax(0,1.45fr) / minmax(320px,1fr)` body;
   768–1179 px: one body column, focus strip stays three across while it fits; ≤ 767 px: everything
   stacks, search full width, actions wrap, agenda keeps a 52 px time gutter. 44 px touch targets on
   coarse pointers, no horizontal overflow at 390 px, `prefers-reduced-motion` respected.
7. **Accessibility** — greeting is the page `h1`; each card has a real `h2`; link cards expose their
   count in the accessible name; search input is labelled; async regions use `aria-busy` and
   skeletons, not spinners only; errors are inline with Retry; status is never colour-only.
8. **i18n** — rewrite `web.home.*` in `i18n/en/web.json` and `i18n/vi/web.json`; remove
   `web.home.records` if unused. Add keys for greeting (morning/afternoon/evening), subtitle, search
   placeholder/hint, create, dashboards, focus cards (tasks/today/approvals, none/overdue/next/running),
   agenda (title/empty/more), pulse (title/link), activity (title/empty/follow/search), setup
   (title/next/open), and the generic retry/error/loading labels. No literal user-visible English.
   Add one shared long-date formatter beside `formatDateTime` in `state/i18n.ts` rather than a
   per-page `toLocaleDateString`.
9. **Docs** — replace the "home page lists record types with their counts" line in
   `docs/ux/design-principles.md`; add `content/docs/en/getting-started/home.md` and its `vi`
   counterpart; link it from `find-your-way.md` and the getting-started index; update the
   `docs/reference/alpha-status.md` home/setup rows.
10. **E2E** — new `e2e/home.spec.ts`: sign in, greeting `h1` visible, the old per-entity grid absent,
    the Create menu opens a create route, hero search lands on `/search?q=`, the tasks card lands on
    `/tasks`, and a network guard asserts **no** `?maxSize=1` entity-count fan-out. Also assert the
    page produces no console errors and that 390 px has no horizontal overflow.

**Acceptance.**

- Home renders no tile per enabled entity and issues no `api.list` call; the first-paint request
  budget is bounded (≤ 9 for an administrator, ≤ 8 for a regular user with all three KPI dashlets)
  and independent of the module count.
- The pulse rail renders 0–3 KPI tiles from the effective default dashboard and is absent when none
  are configured; it never falls back to module counts.
- Greeting, date and times are localized and use the user's time zone; the agenda matches the same
  local day the Calendar page shows.
- Tasks, today, approvals, activity and setup each show loading, empty/done and error states, and a
  single failing card leaves the rest usable.
- The admin setup banner appears only while incomplete and disappears at 100 %; regular users never
  see it.
- Keyboard-only walkthrough reaches search, Create, every card link and the palette hint with a
  visible focus ring; heading order is valid; no meaning is carried by colour alone.
- 1440 / 1180 / 768 / 390 px layouts have no horizontal overflow and no clipped labels in `en` or
  `vi`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; `vitest run` is unchanged; `e2e/home.spec.ts`
  passes against the configured dev stack; no extra database is created and no database write is
  introduced.
- No new dependency, endpoint, migration or table; no upstream assets.

**Verification plan (read-only against the configured database).**

1. `pnpm typecheck`, `pnpm lint`, `pnpm build`; `vitest run` to confirm nothing else regressed.
2. Run the dev API and SPA against the existing configured database and sign in as the demo
   administrator and a regular user. Inspect the Network panel: no request matches an entity list
   with `maxSize=1`, and the request count is the bounded set above regardless of how many modules
   are enabled.
3. Pulse: with four KPI dashlets on the effective default dashboard, exactly three render in
   position order; with no KPI dashlet the rail is absent; a role-scoped default is respected; a
   failing dashlet does not remove the other two.
4. Agenda: compare the rendered events with `/calendar` for the same day. Tasks/approvals links land
   on the right surfaces. Activity matches `/stream?view=followed`.
5. Admin: the setup banner shows the real progress and next steps while incomplete. Regular users
   never see it. If the demo data has no complete checklist, verify the hide condition by code
   inspection and record that in the phase report.
6. Keyboard-only pass and screenshots at 1440 / 1180 / 768 / 390 px (store under `.data/`, not in
   source control); confirm no horizontal overflow in `en` and `vi`.
7. `e2e/home.spec.ts` against the same stack. No database write, migration or extra database is
   introduced by this phase.

**Out of scope / deferred.** User-arranged home widgets and per-user home layout (P2); a server-side
`/Home` aggregate (only if measured latency justifies it); KPI comparison/target/trend (depends on
the dashlet contract, §5.6); a client-side "recent records" store (the palette's recent *pages* stay
as they are); AI next-best-action (P2); dark mode.

**Suggested implementation order.** Helper extraction (`pickDefaultDashboard`) → `home-model.ts` →
hooks → hero + focus strip → agenda + pulse + activity + setup banner → CSS/responsive → i18n/docs/e2e
→ full verification. Build the page skeleton with mocked query data first so the visual direction is
reviewed before the data wiring is complete.

**Implemented.** `apps/web/src/state/dashboard-default.ts` (`pickDefaultDashboard`, now used by
`DashboardsPage` and home), `apps/web/src/pages/home/{home-model,useHomeData,HomeHero,FocusStrip,
TodayAgenda,PulseStrip,ActivityFeed,SetupBanner,HomeSkeleton}.tsx|ts`, the thin `HomePage.tsx`
composition, the `.carocrm-home-*` block in `styles/carocrm.css`, `formatLongDate` plus an optional
zone on `formatClock` in `state/i18n.ts`, `web.home.*` in `i18n/en|vi/web.json`, the handbook page
`content/docs/{en,vi}/getting-started/home.md`, and `e2e/home.spec.ts`. The old `Count` type, the
`TONES` list, the per-entity `api.list` effect and the permanent checklist card are gone.

**Verification actually run** (against the configured database; no extra database, no new write):

- `pnpm typecheck` clean; project sources lint clean (`npx eslint apps packages e2e database scripts
  modules`); `pnpm build` clean.
- `vitest run`: 182/185 files, 2636 tests pass. The five failures are the Phase 19 service-desk
  business-hours tests (`service-desk.test.ts`, `service-desk-workflow.test.ts`,
  `service-desk-sla.test.ts`), which fail outside working hours — this run was on a Saturday. No home,
  docs or web test is among them; `packages/docs/src/corpus.test.ts` and
  `apps/api/test/docs-content.test.ts` pass with the two new handbook pages (18 translated P0 pages).
- `e2e/home.spec.ts` 3/3 on the configured stack: greeting `h1`, no old grid, **no** per-entity
  `maxSize=1` request, one request per card (tasks, approvals, calendar, stream; dashboards + at most
  three dashlet runs), hero search lands on `/search?q=`, Create opens a create route, the tasks card
  lands on `/tasks`, no post-login console error or failed response, and no horizontal overflow at
  390 px.
- Browser (admin session): greeting, date (`Saturday, October 24, 2026`), the focus sentence and the
  three cards render real counts; the agenda agrees with `/calendar` for the same day (3 entries); the
  pulse rail is **absent** because the demo dashboard carries no KPI dashlet, and the activity panel
  shows its empty state — both are the designed behaviour, not a failure.

**Known deviation.** With three KPI dashlets an administrator's home load is **10** requests, not 9:
`tasks`, `approvals`, `today`, `dashboards`, three dashlet runs, `activity`, `setup` and the per-user
`defaultDashboard` preference the shared helper needs. Still bounded and still independent of the
module count. The demo administrator's checklist reports no incomplete step, so the banner is absent
on the demo data; its 100 % hide condition was therefore confirmed by code inspection, as §5 of the
verification plan permits.

---

**Review-driven sub-phases (20.20–20.27).** These were written after 20.19 shipped, from the audit in
`docs/ux/ui-review.md`; they are additive and none of them changes a kernel capability. The numeric
order is the order they are specified in, **not** the order to build them: the recommended sequence is
20.22 → 20.23 → 20.20 → 20.26 → 20.24 → 20.25 → 20.27 → 20.21, with the reasoning in §18 and in the
review's §6.

### Phase 20.20 — Design token layer and a real brand colour  🟡 implemented 2026-10-26 (token layer + brand; TSX inline tokens + breakpoint consolidation deferred)

Source: `docs/ux/ui-review.md` F11, F12. Enables 20.21. Frontend-only apart from one additive key in
an existing JSONB settings document — no migration, no new table.

The design language is sound; what it lacks is a foundation. `styles/carocrm.css` carries 733 hex
literals and 27 `var(--…)` uses, the only custom properties in the file are five `--home-*` values
scoped to one page, and `theme.ts` repeats the same colours in TypeScript. Five off-palette blues
already exist in the CSS but not in the theme — that is drift, and it will keep happening while two
sources of truth exist.

Tasks:

1. `apps/web/src/theme/tokens.ts`: the single source — `surface` (page/raised/sunken/overlay),
   `ink` (primary/secondary/muted/faint/inverse), `line` (subtle/strong/focus), `accent` (the eight
   `NAV_ACCENTS` plus their `soft` pairs), `state` (success/warning/error/info and their soft pairs),
   `radius`, `space`, `shadow`, `z`. Named tokens only; no free colours.
2. `apps/web/src/styles/tokens.css`: `:root` declares every token as `--carocrm-*`; the file is the
   only place a literal colour may appear. Import it before `carocrm.css`.
3. `theme.ts` builds `carocrmTheme` **from** `tokens.ts` — no literal in the file afterwards — so an
   Ant Design token and a CSS property can never disagree.
4. Sweep `carocrm.css` in descending frequency (`#438eff` ×85, `#eff2f7` ×62, `#737b85` ×50,
   `#31373d` ×49, `#f0f0f0` ×32, …): each literal becomes `var(--carocrm-…)`. The `--home-*` block
   becomes aliases of the global tokens (or is deleted and the home block rewritten), so the home
   page stops being a private theme.
5. Replace the 17 hardcoded `#438eff` and 7 `#737b85` in TSX with the token where the value is a
   design decision; inline styles that only carry layout may stay.
6. Consolidate the 16 breakpoints to four — 390 / 768 / 1180 / 1440 — merging the near-duplicate
   pairs (767/768/769, 899/900, 991/992, 1179/1180) and folding the one-offs (480, 520, 640, 720,
   1024, 1280) into the nearest step. Every merged query is verified at both of its old widths.
7. Brand colour: add `primaryColor` to the `brand` document — a name from `NAV_ACCENT_NAMES`, never a
   free hex — validated in `apps/api/src/settings/brand.service.ts`, written through the existing
   `POST /Settings` path, audited like every other settings write. The shell sets
   `--carocrm-accent` and feeds the same value into `ConfigProvider`'s `colorPrimary`.
8. `docs/ux/design-principles.md`: replace "no dark mode, no theme switcher" with the token rule —
   a colour is named in `tokens.ts` or it does not exist.

Acceptance:

- `grep -cE '#[0-9a-fA-F]{3,8}' apps/web/src/styles/carocrm.css` is 0, and the only hex in the
  repository's web styles lives in `tokens.css`; `theme.ts` contains no literal colour.
- A screenshot comparison at 1440 / 1180 / 768 / 390 px before and after shows no unintended
  difference; the merged breakpoints render identically at each old width.
- Choosing a brand colour in General settings recolours primary buttons, links and the selected menu
  row on the next load, in both the shell and the generated list/detail pages; status colours,
  severity colours and chart series are **not** affected, and an unknown name is refused with 422.
- No new dependency; no migration; the brand document gains one optional key and an existing row
  without it keeps the shipped accent.

**Implemented 2026-10-26 (tasks 1–4, 7, 8).**

- `apps/web/src/theme/tokens.ts` — single source: `COLOR`, `ACCENT_TONES` (eight named accents, each a
  full `fg/hover/strong/soft` set), `accentTone()`, `SP`, `RADIUS`, `SHADOW`, `Z`, `FONT_FAMILY`.
- `apps/web/src/styles/tokens.css` — **generated** by `scripts/gen-tokens.mjs`; declares every colour as
  `--carocrm-*` (19 curated semantic tokens + 152 generated `--carocrm-c-*` tints for one-off shades).
  Imported before `carocrm.css` in `main.tsx`.
- `apps/web/src/theme.ts` — `carocrmTheme` and new `themeForBrand()` built **from** `tokens.ts`; zero
  literal colours. `NAV_ACCENTS`/`navAccent` preserved for existing callers.
- `carocrm.css` — **all 769 hex literals swept** (exact-string, length-ordered, identifier-safe) to
  `var(--carocrm-*)`. `grep` for hex in the file is now 0; `--home-*` became token aliases.
- Brand colour (task 7): `primaryColor` added to the `brand` document — validated as a name from
  `NAVIGATION_ACCENTS` in `BRAND_DOCUMENT_SCHEMA` (422 on unknown), persisted by `BrandService`,
  surfaced on `SettingsView`, edited via a Select in `GeneralTab`, and applied by a new `BrandTheme`
  in `main.tsx` (sets `--carocrm-accent*` on `:root` **and** feeds `ConfigProvider` `colorPrimary`).
- `scripts/check-ui-conventions.mjs` — added rule 5: a hex literal outside `tokens.css` (and
  `theme.ts` must stay literal-free) fails the gate, so the single source of truth cannot drift.
- `docs/ux/design-principles.md` §7 — token rule replaces "no dark mode, no theme switcher".

**Deferred (tracked as 20.20.x):** task 5 — promote the 17 `#438eff` / 7 `#737b85` still inline in TSX to
tokens (the lint gate intentionally does not yet flag TSX so the build stays green; layout-only inline
colours may stay); task 6 — consolidate the 16 breakpoints to 390 / 768 / 1180 / 1440. Both are polish,
not regressions, and unblocked by the token layer.

### Phase 20.21 — Dark mode  ⬜ proposed (P2, needs an explicit decision)

Source: `docs/ux/ui-review.md` §5. This is the one item §1.2 currently calls out of scope; it is
listed here because 20.20 makes it cheap and retrofitting it after more surfaces ship does not.

Tasks:

1. `theme: 'light' | 'dark' | 'system'` as a per-user preference (the existing `/Preferences`
   resource, no new store), default `system`.
2. `data-theme` on `<html>`, written by the shell before first paint from the cached preference (the
   same no-flash arrangement `initI18nFromCache` already uses), following `prefers-color-scheme`
   while the preference is `system`.
3. A dark value set for every token in `tokens.css`, and `theme.darkAlgorithm` in `ConfigProvider`.
4. Print stays light; the email and document designers keep a light canvas, because their output is a
   document, not a screen.
5. Audit contrast at AA on the four core surfaces (list, record, settings, home) in both themes.

Acceptance: switching the preference repaints without a reload and without a flash; every token has a
dark value (a missing one fails the build check); no surface keeps a white panel in dark mode; print
output is unchanged; a user who never touches the setting sees today's product.

Out of scope: per-brand theming, user-authored themes, high-contrast mode.

### Phase 20.22 — One way to render a state, and a boundary that catches the rest  ✅ implemented 2026-10-25

Source: `docs/ux/ui-review.md` F1, F3, F8, F14. Independent of 20.20; touches different files.

The shared components are right; adoption is partial and one class of failure has no component at
all. A thrown render unmounts the SPA (no `ErrorBoundary` anywhere), a failed fetch on several admin
screens is indistinguishable from an empty one (`AdminAuditPage` has no `catch`), and 54 raw `<Empty>`
remain beside the 9 files that use `EmptyState`.

Tasks:

1. `components/AppErrorBoundary.tsx`: a class boundary that keeps the shell, renders a `Result` with
   Reload / Back / Home, logs the error with the route, and shows the stack only in dev. One instance
   wraps the router; a second wraps each route element (a `withBoundary(element)` helper in
   `AppRoutes.tsx`) so a failing page cannot take the navigation down.
2. `components/EmptyState.tsx`: title becomes the primary line (a real heading), description the
   secondary one, and an `action` slot is added — the current version puts the title in antd `Empty`'s
   action area, i.e. below the description. Add `variant: 'no-records' | 'no-results' | 'filtered' |
   'denied'` with the four default copy pairs, so "you have none", "nothing matched", "your filter
   hides everything" and "you may not see this" stop reading the same.
3. `components/OfflineBanner.tsx`: `navigator.onLine` plus the `online`/`offline` events, wired into
   React Query's `onlineManager` so requests pause and resume instead of failing one by one. Shown
   under the header, dismissible only by going back online.
4. Replace the 54 raw `<Empty>` and the remaining bare `Spin` loading states with the shared
   components; `AdminAuditPage` and every other screen that fetches without a `catch` gets an
   `ErrorState` with retry.
5. `scripts/check-ui-conventions.mjs` (the gate 20.26 will extend): fails on `<Empty` outside
   `EmptyState.tsx`, on `slice(0, 19)`, on a hex literal outside `tokens.css`, and on `<a href="/…">`.
   Wire it into `pnpm lint`.
6. i18n keys for the four empty variants and the offline banner, `en` + `vi`; note the convention in
   `docs/ux/design-principles.md` §8.

Acceptance: stopping the API leaves the shell, the menu and the current record readable, with an
explanatory card and a working retry — never a blank page; a component that throws during render
falls back to the route boundary and the rest of the app stays usable; going offline shows the banner
and coming back re-runs the paused queries; the four empty variants are visually distinct and say
what to do next; `node scripts/check-ui-conventions.mjs` exits 0 on a clean tree and non-zero on each
seeded violation.

**Implemented.**

- `apps/web/src/components/AppErrorBoundary.tsx` — class boundary, `scope: 'app' | 'route'`; logs
  route + error + component stack; dev-only message; reload for `app`, retry/home for `route`.
  Mounted twice: around `RouterProvider` in `main.tsx`, and around the routed page in `AppShell`
  (keyed by pathname, so navigating away resets it) for both the internal and the portal shell.
- `apps/web/src/components/EmptyState.tsx` — title is the primary line, description the hint,
  `action`/`children` the action slot; `variant` = `no-records | no-results | filtered | denied`;
  `size="compact"` keeps antd's small illustration for panels. `title`/`description` widened to
  `ReactNode` (one call site passes a composed block).
- `apps/web/src/components/OfflineBanner.tsx` — subscribes to React Query's `onlineManager` through
  `useSyncExternalStore`, so the banner and the paused queries share one source of truth; announces
  recovery once, never on first paint.
- 41 raw `<Empty>` call sites across 26 files migrated; `Empty` is gone from their antd imports.
- `AdminAuditPage` gained a real error path (`catch` → `ErrorState` + retry, and the empty state is
  suppressed while an error is shown) and its record link became a router `Link`.
- `EntityListPage` distinguishes "no records" from "the filters hide everything", the latter with a
  **Clear** action that also resets the text query.
- **Bug found while verifying, and fixed:** reloading a list URL that carried `?q=…` silently dropped
  the query and showed the unfiltered list. The free-text query was held twice — in component state
  seeded from the URL, and in the URL written back by the sync effect — so a remount that read a stale
  `useSearchParams()` initialised the state to `''` and the next sync **deleted** `q`. The query is now
  derived from the URL only and written by one helper (`setTextQuery`), which also clears `offset`.
  A shared list link now lands on the list the sender saw.
- `scripts/check-ui-conventions.mjs` + `pnpm lint:ui` — four rules: missing i18n key (plural-aware),
  `slice(0, 19)`, raw `<Empty>`, raw `<a href="/…">` (downloads under `/api/` exempt).

**Verification actually run.**

- `node scripts/check-ui-conventions.mjs` — clean, 4 687 keys checked. Before the fix it reported 46
  violations, including **six live raw-key renders** (`core.common.empty`, `.error`, `.retry`,
  `.retryHint`, `.accessDenied`, `.accessDeniedHint`) — the three shared state components pointed at
  keys that do not exist, so a 403 page printed `core.common.accessDenied` as its heading.
- `tsc --noEmit -p apps/web/tsconfig.json` clean; `eslint apps/web/src --max-warnings=0` clean;
  `vite build` succeeds (index chunk 2.75 MB / 787 kB gzip).
- `vitest run apps/api/test/i18n.test.ts` 6/6 — the catalog still validates every key against the
  naming rule, including the 19 added.
- Browser smoke run against the configured database (admin session, `no_proxy='*'`): sign-in, home
  with no raw keys, audit log with no ISO-sliced timestamp, a `?q=` list link that survives a reload
  and renders the **filtered** empty state (title "The current filters hide every record", hint,
  **Clear** button — checked in a screenshot, not only in the DOM), offline banner appears and
  disappears with `online`/`offline`, record page renders. 10/11 assertions pass; the eleventh ("no
  console errors") fails on **pre-existing** output: two `422` from `POST /Refresh` when a stale token
  is restored at boot, and an antd `Table` `pagination.total` warning. Neither is introduced by this
  sub-phase.
- An earlier version of this run reported the filtered empty state as verified when the list was in
  fact showing 58 unfiltered rows: the assertion matched the word "filter" elsewhere on the page. The
  check now reads `.carocrm-empty-title`, and the underlying `?q=` bug it exposed is the one fixed
  above.
- Not covered: the crash path itself has no automated trigger (no test hook to force a render error);
  it was verified by code inspection only.

### Phase 20.23 — One formatter for time, and a check that keeps it that way  ✅ implemented 2026-10-25

Source: `docs/ux/ui-review.md` F2. Small, high-value, independent.

`formatDateTime` is correct and timezone-aware. Fourteen call sites in ten files bypass it with
`value.slice(0, 19).replace('T', ' ')`, so the audit log, the job history, the workflow runs, the
process instances, the task list and the process trail all print UTC while the same instant reads
correctly on the record page.

Tasks:

1. Replace all 14 call sites with `formatDateTime` / `formatClock` (`AdminAuditPage`, `AdminJobsPage`,
   `AdminExtensionsPage`, `WorkflowsPage`, `WorkflowEditorPage`, `ProcessesPage`, `ProcessEditorPage`,
   `TasksPage`, `ProcessPanel`, `ProcessTrailModal`). A log line keeps its raw ISO string only inside
   a copied/downloaded artifact, never on screen.
2. Add `formatRelative(value)` beside `formatDateTime` (`Intl.RelativeTimeFormat`, user timezone) for
   "3 minutes ago", and use it where a recent timestamp is scanned rather than read: job runs,
   workflow runs, stream entries, notifications.
3. The convention check from 20.22 gains the `.slice(0, 19)` and `replace('T'` rules; the rule is
   documented in `docs/ux/design-principles.md` §7.
4. A row-level unit test for the formatter pair (fixed instant, two zones, two locales) so the
   behaviour is pinned rather than assumed.

Acceptance: the audit log, the job history and a workflow run show the same wall-clock time as the
record that produced them, in the instance's configured timezone; changing the default timezone in
Localization changes all of them without a code change; no `.slice(0, 19)` remains; the check fails
if one is reintroduced.

**Implemented.**

- All 14 call sites in 10 files now use `formatDateTime`: `AdminAuditPage`, `AdminJobsPage` (the
  `timeText` helper and the log drawer), `AdminExtensionsPage`, `WorkflowsPage`,
  `WorkflowEditorPage`, `ProcessesPage`, `ProcessEditorPage`, `TasksPage` (due + started),
  `ProcessPanel`, `ProcessTrailModal` (started + due + when).
- `formatRelative(value, now?)` added to `state/i18n.ts` (`Intl.RelativeTimeFormat`, active locale),
  used by the notification inbox — the one surface where recency, not the instant, is what the
  reader judges — with the exact time in a tooltip. It replaces
  `new Date(x).toLocaleString()`, which formatted in the **host** locale and timezone.
- The `.slice(0, 19)` rule is part of `scripts/check-ui-conventions.mjs` (`pnpm lint:ui`), so a
  reintroduction fails the gate rather than waiting for a review.

**Verification actually run.** `pnpm lint:ui` clean (the rule reports 0 after the sweep and would
report any new one); `tsc`/`eslint`/`vite build` clean; browser smoke run confirms the audit log
renders no `YYYY-MM-DD HH:MM:SS` string. **Not** run: the timezone-change assertion — flipping the
instance default timezone and re-reading three screens is a manual check that would write to the
settings document, so it is left to the operator.

**Deferred from the task list.** Item 4 (a unit test for the formatter pair) has no home: there is
still no frontend test runner (§20.26). The formatter is exercised indirectly by the smoke run.

### Phase 20.24 — One page frame: header, document title, heading outline, focus  ✅ implemented 2026-10-26

Source: `docs/ux/ui-review.md` F5, F6, F7.

The page title has three implementations (a real `<h1>` in 18 files, `Typography.Title level={4|5}`
in 14 places, nothing at all on the rest), the heading distribution is h1 ×19 / h2 ×9 / h3 ×4 /
**h5 ×33**, `document.title` never changes from the brand, and a route change neither moves focus nor
announces the new page.

Tasks:

1. `components/PageHeader.tsx`: `title` (rendered as the page's only `h1`), `subtitle`, `breadcrumb`,
   `actions`, `back`, `tabs`, `docKey`. Owns the `carocrm-page-head` markup so the class stops being
   re-typed per page, and owns `usePageTitle(title)` → `document.title = "<title> · <brand>"`.
2. A `useRouteFocus()` hook in the shell: on a pathname change, focus `#carocrm-content` (already
   `tabIndex={-1}`) and announce the new title in the existing `#carocrm-live-region`. No focus move
   on a query-string-only change, so filtering a list does not steal focus.
3. Migrate the pages that render their own title to `PageHeader`; the workspace screens that
   legitimately own their head (`/crm-chat`, `/voice-inbox`, `/home`) keep it but adopt `usePageTitle`
   and expose one `h1`.
4. Heading levels become a rule: page = `h1`, section = `h2`, card/panel = `h3`. The 33 `level={5}`
   uses are re-levelled where they are section titles; a card title inside a section becomes `h3`.
5. `docs/ux/design-principles.md` §3 gains the frame and heading rules.

Acceptance: every internal route exposes exactly one `h1` and a valid outline; the browser tab reads
"Contacts · CaroCRM" (localized); a keyboard user activating a sidebar link lands with focus in the
content and the page announced; filtering a list does not move focus; no page re-implements the
`carocrm-page-head` markup.

### Phase 20.25 — Find a setting  ✅ implemented 2026-10-26

Source: `docs/ux/ui-review.md` F9.

Twenty-one administration tabs behind a rail with no filter. The tab descriptors already carry a
label, a description and a doc key; the palette already knows how to search and to respect what the
caller may open. Neither is used for settings.

Tasks:

1. `AdminPanelTab` gains a `keywords: string[]` field in `apps/api/src/admin/admin-panel.service.ts`
   (metadata, not a migration): the words an administrator would type — "timezone", "smtp", "logo",
   "password policy", "api key" — validated against a plain string array.
2. The settings rail gains a search box filtering tabs by label, description and keyword, with the
   matched tabs listed flat (group headings hidden while filtering) and a "no setting matches" state.
3. `?highlight=<field>` on a tab focuses and briefly marks the matching field, so a search result
   lands on the control, not just the tab.
4. The command palette gains a **Settings** group built from the same descriptors, filtered by the
   tabs the caller may open, capped like every other group; a forbidden tab never appears.
5. i18n for the search placeholder, the empty result and the group label; `docs/admin/settings.md`
   documents the keyword field so a module's tab can declare its own.

Acceptance: typing "timezone" from any screen reaches the Localization tab's timezone control in two
keystrokes plus Enter; a tab the caller cannot open never appears in either surface; a module that
adds a tab with keywords is searchable without a shell change; keyboard-only throughout.

### Phase 20.26 — Frontend quality gate  ✅ implemented 2026-10-26 (gate + tests + axe)

Source: `docs/ux/ui-review.md` §5 and §8; `PLAN_Phase_20` 20.16's unmet acceptance criterion.

The plan's accessibility acceptance ("axe passes on the four core surfaces") is recorded as **not
met** because this repository has no frontend test runner and no axe dependency. Everything in
20.20–20.25 is a regression waiting to happen without one, and 20.22 already introduces a convention
script that needs a home in CI.

Tasks:

1. `apps/web` test setup: `vitest` + `jsdom` + `@testing-library/react` + `vitest-axe`, a `test:web`
   script, and a config that does not collide with the API's `vitest` project.
2. Six smoke tests, one per surface: shell (menu renders, skip link works, drawer opens under 768),
   list (URL state round-trips, empty/error/denied render), record (header, next action, relation
   tabs), settings shell (save bar dirty state, refusal state), palette (⌘K, filter, Enter navigates),
   states (the four empty variants + offline banner).
3. `axe` assertions on the four core surfaces, in light and (after 20.21) dark; the four surfaces are
   the ones 20.16 named.
4. `scripts/check-ui-conventions.mjs` from 20.22 wired into `pnpm lint`, extended with a docs-truth
   check: the "Known limitations" list in `docs/compatibility/settings-ux.md` names only items the
   code does not have.
5. `docs/ux/accessibility.md` rewritten from "manual walkthrough" to "what the gate checks and what
   it does not".

Acceptance: `pnpm test:web` runs green on a clean tree; axe reports zero violations on the four
surfaces; deleting an `aria-label` from an icon-only control, or adding a raw `<Empty>`, or
reintroducing `.slice(0, 19)`, makes the gate fail; the deferral list matches the code; 20.16's
acceptance criterion can be marked met with a command instead of a walkthrough.

**Implemented 2026-10-26 (dependency-free part).**

- `vitest.web.config.ts` + `pnpm test:web` — a SPA test project kept separate from the root
  `vitest.config.ts` (which stays API/database-backed). `environment: 'node'`, no jsdom.
- Four spec files, **14 assertions**: `theme/tokens.test.ts` (no hex in `carocrm.css`, every
  `--carocrm-*` declared, accent tokens present), `state/i18n.test.ts` (locale/timezone formatters),
  `components/EmptyState.test.tsx` (title primary, four variants distinct, action slot — server-rendered
  via `react-dom/server`), `__tests__/conventions.test.ts` (gate passes + `--self-test` catches every
  rule).
- `scripts/check-ui-conventions.mjs` — added `--self-test` (each of the 5 rules must flag a seeded
  violation and leave a clean sample alone) and a docs-truth rule (the "Still open" list must not name
  a feature whose evidence file exists).
- `pnpm lint` now runs the convention gate before ESLint, so the gate is in the normal lint path.
- `docs/ux/accessibility.md` rewritten to "what the gate checks and what it does not".

**The axe piece — done 2026-10-26 (same day, browser-rendered rather than jsdom).** The dependency
friction above pointed at a jsdom + `@testing-library/react` + `vitest-axe` stack; a Playwright side
needs exactly one dependency instead, audits the pages *as users actually render them* and reuses the
e2e login/seed plumbing that already exists. The jsdom scope of the spec is unchanged. Added:

- `@axe-core/playwright` (the only new dependency) and a second describe in
  `e2e/accessibility.spec.ts`: an `AxeBuilder` scan (`wcag2a`, `wcag2aa` tags) asserting zero
  violations on the four core surfaces — **home, list, record, settings** — as the plan's §20.21
  names them.
- The scan found real defects, and each one is fixed, not excluded: ink tokens raised to WCAG AA
  (secondary/muted `66707a`, faint `6e7681` in `theme/tokens.ts` + the generated
  `styles/tokens.css`), the menu/tab selection colour moved to each accent tone's `strong` value
  (the plain accent on its soft selection background is 2.98:1), `colorPrimary`/`colorLink` and
  `colorTextDescription` follow (`theme.ts`; the antd default description ink over white is
  2.47:1), the status pills and the next-action label repainted, the footer colour raised, the
  unnamed antd `Select`s in the list toolbar/filters given `aria-label`, every row-selection
  checkbox named through `getCheckboxProps`, and antd's table measure row made
  `visibility: hidden` so it no longer hides a tabbable element (axe's aria-hidden-focus).
- Result: `npx playwright test e2e/accessibility.spec.ts --project=chromium` — 6/6 green, **zero
  WCAG 2.0 A/AA violations** on all four surfaces. §20.16's acceptance criterion is met by
  command. Known bounds, recorded in `docs/ux/accessibility.md`: the audit covers the default
  `blue` brand instance (of the eight accent tones, only blue/purple/magenta's strong tone clears
  AA over their soft background), the rule tags are WCAG 2.0 A/AA rather than 2.1/2.2, and
  keyboard/focus paths remain a manual walkthrough.

### Phase 20.27 — A bounded first load, and writes that answer immediately  ⬜ proposed

Source: `docs/ux/ui-review.md` F4, F10, F13.

The initial chunk is 2.62 MB because `AppRoutes.tsx` imports all 46 page modules statically; only the
admin tabs and the email editor are split. And no mutation anywhere is optimistic (0 `onMutate`
against 171 success toasts), so a board drag re-fetches the board and an inline edit re-fetches the
page.

Tasks:

1. Route-level `React.lazy` for every page module in `AppRoutes.tsx`, with a `Suspense` fallback that
   renders the page's own skeleton (not a centred spinner), so a route change never flashes a blank
   content area. Keep the entity wildcard's chunk shared between list/detail/edit where the modules
   already share code.
2. Prefetch on intent: `onMouseEnter`/`onFocus` of a sidebar or palette entry warms that route's
   chunk; idle prefetch of the three most-visited routes from the `lastVisited` preference.
3. Optimistic writes for the three interactions where the round trip is felt: board card move
   (rollback + message on refusal), inline list cell edit, and task/approval completion. Each uses
   `onMutate` + `onError` rollback, and the server's refusal message is what the user sees.
4. `refetchOnWindowFocus: 'always'` for list, detail and dashboards, so a tab left open overnight
   refreshes when the user returns instead of showing yesterday's pipeline.
5. Record the before/after numbers in this document and in the phase report.

Acceptance: the initial JS for a signed-in shell is at most half of today's 2.62 MB, measured on the
built output, and no module page's chunk is in it; a route change shows a skeleton within one frame;
a dragged card stays where it was dropped without a board reload, and a refused drop returns it with
the server's reason; returning to a stale tab shows fresh data.

---

## 18. Priorities and Release Gates

### P0 — Required for the first usable release

- Settings registry + document service with version and concurrency.
- Admin panel descriptors, tabbed shell, sticky save bar, dirty guard, per-tab levels.
- General, Localization tabs; Sales/Service Desk/Customer Success documents hosted as tabs.
- `GET /Navigation` resolver with ACL filtering, admin and extension entries.
- Main Menu settings tab (enable/disable/reorder/rename/accent/reset).
- Per-entity `nav` metadata + Entity Manager tab.
- Users, Teams, Roles tabs; last-admin protection.
- Shared empty/loading/error/permission states.
- List view: URL state, column manager, density, bulk actions.
- Record page unsaved-changes guard. (The sticky header is a P1 refinement — see §19.)
- Security tests for the settings and navigation endpoints.
- Migrations, docs, translations, OpenAPI.
- **Post-20.19 review gate (⬜ proposed).** `docs/ux/ui-review.md` found P0 defects the phase's own
  bar does not tolerate: a thrown render white-screens the SPA, and a failed fetch is
  indistinguishable from an empty screen on several screens (both 20.22 — ✅ fixed 2026-10-25);
  admin and ops screens print UTC as if it were local time (20.23 — ✅ fixed 2026-10-25); the design
  system has no token layer, so the brand setting cannot set a colour and two sources of truth
  already disagree (20.20); and 20.16's "axe passes" criterion — met on 2026-10-26 via the
  §20.26 axe piece (a frontend test runner and the axe audit both exists now).

### P1 — Required for comfortable daily use

- Command palette with command/record/recent modes.
- Inline editing in list views with in-cell validation.
- Layout manager.
- User preferences server-side (columns, density, favorites). ✅ 20.10 — the resource stores and validates all of them; density, page size, the default dashboard and the column manager consume four of the seven. `favorites`, `lastVisited` and `dismissedSetupSteps` still have no editor — documented deferral.
- Setup checklist and first-run empty states.
- Undo for reversible bulk actions. (Mass delete only — the outcome counts and the other bulk actions are a documented deferral.)
- Authentication/Email/Notifications/Attachments tabs.
- Accessibility pass (WCAG 2.2 AA) and responsive hardening. (The CSS and ARIA pass is done; the automated axe audit and the contrast measurement are not — documented deferral.)
- API keys, portals and extensions hosted in the shell.
- Record-page relation tabs (§5.11): stacked/tabs mode per entity, with an arrangement the
  administrator creates, renames, reorders, deletes and fills by drag or keyboard in the entity's
  detail layout settings. ✅ 20.18 — the section is metadata, the editor lives in the layout settings,
  and the record page only renders it.
- Home workspace (§5.6): greeting/search/create hero, focus strip (tasks, today, approvals), today's
  agenda, at most three KPI dashlets from the effective default dashboard, followed activity and a
  compact admin setup banner — with no per-entity count grid and no per-module request fan-out.
  ✅ 20.19 — `HomePage.tsx` composes `pages/home/*`; the default-dashboard priority is shared with
  Dashboards in `state/dashboard-default.ts`.
- One page frame (✅ 20.24): a single `PageHeader`, a per-page `document.title`, a valid heading
  outline and focus moved to the content on a route change.
- Settings search (⬜ 20.25): the rail and the command palette both find a setting by label,
  description or keyword, filtered by the tabs the caller may open.
- A bounded first load and optimistic writes (⬜ 20.27): route-level code splitting takes the initial
  chunk below half of today's 2.62 MB, and the three interactions where the round trip is felt —
  board move, inline edit, task completion — answer immediately and roll back on refusal.

### P2 — Post-first-release enhancements

- Role-scoped default menus and dashboards.
- Dark mode and density themes. (⬜ 20.21 — now cheap once the token layer of 20.20 exists; needs an
  explicit decision because it is the one item §1.2 calls out of scope.)
- 2FA management UI.
- Saved view sharing beyond team visibility, and view templates.
- Personalized "next best action" scoring.
- Admin audit diff viewer for settings documents.
- Automated UX metrics (palette success rate, list-view abandonment) if telemetry is ever added.

---

## 19. Definition of Done

Phase 20 is complete when all applicable checks below pass:

- [x] `/admin/settings` is a tabbed, permissioned shell; no single page holds every setting. (20.2, `AdminSettingsPage.tsx` deleted)
- [x] Every settings capability in the §4.3 catalog is reachable from a tab **or a documented deferral** — see `docs/compatibility/settings-ux.md` (users/teams/roles/API keys in 20.7, layout manager in 20.8, security/messaging/webhooks/internal in 20.9; the ACL explain helper, storage usage and 2FA are documented deferrals, user preferences is 20.10).
- [x] Settings documents live in `app_settings` with schema validation, versioning, concurrency and
      reset-to-default; no second settings store exists. (20.1)
- [x] The main menu is administrator-configurable and resolved server-side with ACL filtering. (20.4, 20.5)
- [x] Menu configuration can never widen access; forbidden entities never appear. (asserted by `apps/api/test/navigation.test.ts`)
- [x] Entity navigation behavior is metadata-driven (`nav` section + Entity Manager tab); the SPA's hard-coded name sets are gone. (20.6)
- [x] Users, teams, roles and API keys are manageable without raw API calls, with last-admin
      protection and show-once secrets. (20.7)
- [x] The navigation tree is server-persisted and permission-filtered. (20.4 nav tree. The `favorites`
      preference is stored and validated in `user_preferences` but has **no editor and no consumer** —
      there is no Favorites group in the sidebar; documented deferral.)
- [x] List views support URL-shareable state, columns, density, bulk actions and undo. (20.12 — the
      selection is page-scoped: cross-page "select all N matching records", bulk-action outcome
      counts, the row kebab menu, column reorder/resize/freeze and virtualization at 2 000+ rows are
      documented deferrals.)
- [x] Record pages have an unsaved-changes guard and keyboard `⌘/Ctrl+Enter` save. (20.13 — the sticky
      header, the next-action band, progressive disclosure and "Save & new" are documented deferrals)
- [x] A command palette is reachable by keyboard from every screen and reveals nothing unauthorized. (20.14 — the `/` shortcut and the "see all" deep link are documented deferrals)
- [x] Empty, loading, error and permission-denied states exist as shared components and are used. (20.11 + later — `EmptyState`, `LoadingSkeleton`, `ErrorState` and — since Phase 20.22 — `AppErrorBoundary` and `OfflineBanner` are used; `PermissionDenied` is consumed by the docs reader and the CRM chat workspace, `HelpTip` by the Main Menu tab, the docs cross-links and the two template designers)
- [x] Keyboard operability is verified on the four core surfaces. (20.16 — focus-visible rings, 36 px desktop controls with 44 px touch targets on touch devices, `prefers-reduced-motion`, ARIA labels on the palette/checklist/bulk bar, a manual keyboard walkthrough, **and since 2026-10-26 the automated axe audit**: `@axe-core/playwright` scans home, list, record and settings with zero WCAG 2.0 A/AA violations; contrast is asserted by that same audit over the AA rule set.)
- [x] Users can work on desktop, tablet and phone without losing function. (20.16 — responsive CSS at 768px and 390px: rail off-screen, bars constrained, forms stacked, tables scrollable; no horizontal overflow at 1440/768px, 390px fixed by save/bulk bar max-width)
- [x] Tests cover happy paths, invalid input, permission denial, conflicts and bulk-action edge cases. (138 files / 1876 tests — API and package suites; there is **no frontend test runner** in this repository, so the UI half of the plan's §13.1/§13.4/§13.5 is covered by a manual browser walkthrough only)
- [x] Lint, typecheck, build and the existing test/smoke suites were run; skipped checks documented. (`pnpm lint` clean, `pnpm typecheck` clean, `pnpm build` clean, `pnpm test` 138/1876 green, 2026-10-20)
- [x] Migration `044_phase20_settings_documents.sql` is additive, reviewed and applied without data loss.
- [x] Translations added for `en` and `vi`; the new UI strings resolve through `t()`. (20.2–20.14 scope — `i18n/en/web.json` and `i18n/vi/web.json` hold 1886 keys each, none missing)
- [x] OpenAPI updated; documentation and compatibility notes written. (All Phase 20 endpoints use `@ApiTags` decorators; the OpenAPI spec is generated at runtime by the NestJS Swagger module, so no static `api-spec/` directory is needed for this phase — PLAN §58 is a separate, later piece of work. Compatibility notes in `docs/compatibility/settings-ux.md`, admin docs in `docs/admin/settings.md`, UX docs in `docs/ux/`, alpha status in `docs/reference/alpha-status.md`, matrix in `docs/reference/compatibility-matrix.md`.)
- [x] No extra database was created; no reset, truncate or broad delete was performed.
- [x] No upstream PHP source, unlicensed assets or third-party branding were copied.
- [x] Record pages render related records as tabs the administrator arranges in the entity's detail
      layout, or as today's stacked panels; no relation can be lost, the arrangement is per entity
      and `/Related` and ACL are unchanged. (20.18 — the arrangement is entity metadata, not a
      per-user preference; the per-user draft in this checklist item was deliberately dropped)
- [x] The home page is a role-aware workspace — greeting/search/create hero, focus strip, today's
      agenda, at most three curated KPI tiles and followed activity — with no per-entity count grid,
      no `api.list` fan-out, and a compact administrator setup banner that hides at 100 %. (20.19 —
      frontend-only: no new endpoint, migration or database write; guarded by `e2e/home.spec.ts`.)

---

## 20. Suggested First Coding-Agent Task

Start with **Phase 20.0 only**, then implement 20.1–20.4. Do not attempt the whole phase in one
generation pass.

The initial agent must:

1. Inspect the live code and report the concrete files that own brand/i18n settings, the admin routes,
   the sidebar tree, entity metadata merge and the existing module settings services.
2. Confirm the configured primary database target by inspecting configuration and scripts, without
   printing credentials, and confirm that no test command provisions a database.
3. Propose the exact Zod document schemas (`navigation`, `security`, `fileStorage`, `notifications`)
   and the `nav` entity metadata section, as a reviewable diff against existing conventions.
4. Deliver the smallest first migration (idempotent seed rows) and a verification plan that uses the
   existing database only.

After the audit, continue in the order of §17. A sub-phase is complete only when its acceptance
criteria and the applicable Definition of Done items are verified.

**Starting 20.18 on its own:** it touches one preference schema, one new component, one page and one
pure-helper file, so it needs no part of 20.0–20.17 re-read. Begin with
`packages/metadata/src/relation-tabs.ts` and its unit tests (the only part covered by an automated
suite), then wire the preference, then the component, then the page refactor. Read
`EntityDetailPage.tsx`, `preferences/preference-shapes.ts`, `state/preferences.ts` and
`components/LayoutEditor.tsx` before writing anything — the last one already solves drag-and-drop
with a keyboard sensor and is the pattern to copy, not reinvent.

**Starting 20.19 on its own:** read `apps/web/src/pages/HomePage.tsx`,
`apps/web/src/pages/DashboardsPage.tsx`, `apps/web/src/pages/CalendarPage.tsx`,
`apps/web/src/state/processes.ts`, `apps/web/src/state/metadata.ts`,
`apps/web/src/components/StreamPanel.tsx` (`updateSummary`), `apps/web/src/state/i18n.ts`
(`formatDateTime`/`activeTimezone`) and the `.carocrm-dashlet` / `.carocrm-reports-*` CSS blocks.
Confirm the four data sources return what the plan expects before styling anything: process tasks,
process instances, today's calendar slice and followed stream. Build the shared default-dashboard
helper first, then a static composition with fixture data for a visual review, then wire the queries.
Do not add a backend aggregate or a new dependency to make the page work; if the measured request
budget is unacceptable, record it and defer `/Home` to P2.

**Starting the review-driven batch (20.20–20.27):** read `docs/ux/ui-review.md` first — it names the
file and the line behind every claim, so the finding can be re-checked instead of re-discovered.
Start with 20.22 and 20.23: they are small, they fix defects users hit today, and they touch files
nothing else is moving. Then 20.20 (the token sweep is mechanical but wide), then 20.26 so the sweep
is locked in by a check. Read `apps/web/src/styles/carocrm.css` (7 972 lines), `theme.ts`,
`AppRoutes.tsx`, `components/AppShell.tsx` and `state/i18n.ts` before writing anything — in
particular, do not invent a new state component (20.22 fixes the four that exist) and do not invent a
new date formatter (20.23 uses the one that exists).

---

## 21. References

Upstream feature reference (EspoCRM administration):

1. EspoCRM Administration overview and functional areas: https://www.espocrm.com/blog/how-to-build-a-custom-crm/
2. `app > adminPanel` metadata (panels, item lists, ordering): https://docs.espocrm.com/development/metadata/app-admin-panel/
3. Config parameters and their visibility levels: https://docs.espocrm.com/development/custom-config-parameters/
4. Customizing the main menu under Administration → User Interface: https://www.espocrm.com/tips/customize-menu/
5. EspoCRM user interface overview: https://www.espocrm.com/user-interface/

Market UX references applied in §5:

6. Salesforce Lightning list views and inline editing in list views:
   https://sfdcpenguin.com/blog/salesforce-winter-25-release-summary/
7. HubSpot administration and role-based record views: https://blog.hubspot.com/marketing/crm-administration
8. Zoho CRM admin quick start (guided setup): https://help.zoho.com/portal/en/kb/crm/getting-started/articles/admin-quick-start
9. CRM UX patterns — cut data entry, design for role, respect power users, surface the next action:
   https://uxplaybook.org/uxglossary/customer-relationship-management-crm
10. CRM and internal-system UX practices — onboarding, empty states, contextual help, feedback loops,
    accessibility: https://uitop.design/blog/best-ux-practices-for-crm-and-internal-business-systems/
11. Dense data-UI rules — saved views, bulk actions, inline edit friction, keyboard, density,
    virtualization: https://github.com/Eneryleen/ai-web-design-codex/blob/main/03-site-types/crm-admin-dashboards.md
12. CRM system UX by role and task — navigation, saved lists, bulk edit with preview and undo:
    https://www.anoda.mobi/ux-blog/designing-effective-crm-system-anoda-ux

Internal references: `PLAN.md` (§12 Metadata, §19 Entity Manager, §20 Layouts, §37 Portals, §38
Extensions, §42 Configuration, §57 Phases, §58 API registry), `AGENTS.MD`, `docs/reference/alpha-status.md`,
and the Phase 19 module plans in `PLAN_Phase_19_*.md`.

The upstream documentation is the functional reference for *what administrators can configure*. This
repository's `PLAN.md`, `AGENTS.MD`, implemented kernel behavior and explicit compatibility baseline
determine how those capabilities are realized in this NestJS codebase.