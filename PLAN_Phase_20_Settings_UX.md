# Phase 20 — Settings, Administration and End-User UX/UI

> **Status:** 20.0 – 20.6 implemented (2026-10-18): settings document registry, admin panel
> descriptors and the tabbed shell, General/Localization/Main Menu tabs, the hosted module documents,
> `GET /Navigation` with ACL-filtered resolution, per-entity `nav` metadata and the Entity Manager
> Navigation tab. 20.7 – 20.17 (users/teams/roles/API keys, layout manager, security/messaging tabs,
> user preferences, the end-user UX pack, accessibility and release hardening) are still planned.
> This document remains the scope, architecture reference and implementation roadmap for Phase 20.
> Implemented behaviour is documented in `docs/admin/settings.md`, `docs/admin/navigation.md` and the
> deviations in `docs/compatibility/settings-ux.md`.
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

### 1.2 Explicit scope boundary

This phase does **not** re-implement or redesign:

- The Entity Engine, Metadata Registry, relation engine, query engine, layouts engine or field
  validation. UX work is expressed **through** those subsystems, never around them.
- Authentication, sessions, global Role/Team ACL, record-level ACL or field-level ACL. The settings
  area configures and displays them; it never bypasses them.
- The Stream/timeline, attachments, audit/history, notifications, Activities, Calendar, dashboards,
  jobs, search, import/export, formulas, dynamic logic, workflows or BPM engines.
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
- No unsaved-changes guard on edit forms; no save-and-new flow.
- Empty/loading/error states are implemented ad hoc per page rather than through shared components.
- No accessibility audit record; keyboard support is partial (Escape on the drawer, Enter on the
  collapse toggle).
- No onboarding, setup checklist or first-run experience.

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
- Touch targets ≥ 44 × 44 px on narrow viewports.
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

### 9.3 Design system

- Continue with Ant Design 5 primitives and the existing `carocrm-*` CSS layer and
  `theme.ts` tokens; no new component library (see `AGENTS.MD` §8).
- Add tokens for density, spacing scale and state colors to `theme.ts` rather than scattering inline
  styles.
- The settings shell, list view and record page must not look like untouched Ant Design demos: keep
  the existing card and page-head conventions, and give the tab rail a distinct treatment.

### 9.4 State management

- TanStack Query, already used, owns all server state: `['adminPanel']`, `['settings', name]`,
  `['navigation']`, `['userPreferences']`, `['records', …]` for lists.
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

### 13.2 Repository/integration tests (existing primary database)

- Document read/write/reset/version/conflict against `app_settings`.
- `GET /Navigation` for an admin, a regular user with limited roles, and a portal user.
- Settings audit rows written with secrets redacted.
- Setup checklist evaluation with incomplete and complete installations.

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

- `docs/admin/settings.md` — tab catalog, levels, document registry, how to add a tab/document.
- `docs/admin/navigation.md` — menu model, keys, resolution pipeline, per-entity nav metadata.
- `docs/ux/design-principles.md` — the UX principles of §5 with concrete do/don't examples.
- `docs/ux/list-view.md` and `docs/ux/record-page.md` — the two highest-traffic surfaces.
- `docs/ux/accessibility.md` — keyboard map, focus rules, contrast tokens, known gaps.
- `docs/compatibility/settings-ux.md` — deviations from upstream administration behavior.
- Update `docs/reference/alpha-status.md` and `docs/reference/compatibility-matrix.md`.
- Update `PLAN.md` §57 status once the phase lands.

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

### Phase 20.7 — Users, teams, roles and API keys

Tasks: Users tab (paginated, role/team assignment, activate/deactivate, password reset); Teams tab;
Roles tab with permission matrix and last-admin protection; API keys tab with show-once secrets.

Acceptance: the four tabs work entirely through the existing identity API; no new user-management
endpoint beyond a documented minimal addition; secrets never returned twice.

### Phase 20.8 — Layout manager

Tasks: per-entity list/detail/edit layout editing in the `layout` tab, live preview, keyboard
alternative to drag & drop, validation against the layout schema.

Acceptance: a layout referencing an unknown field is rejected with a clear message; changes render in
list/detail without a code change.

### Phase 20.9 — Security, Messaging, Integrations and Internal tabs

Tasks: authentication policy document; read-only permissions summary; email accounts; notification
defaults; extensions/webhooks relocation; internal tab with cache info and the guarded danger zone.

Acceptance: secrets are masked and never persisted in `app_settings`; danger-zone actions require
typed confirmation and are audited.

### Phase 20.10 — User preferences

Tasks: per-user preference resource, endpoint and client; density, columns, favorites, default
dashboard; enforcement that only the owner may read/write.

Acceptance: preferences follow the user across devices and never leak between users.

### Phase 20.11 — Shared state components

Tasks: `EmptyState`, `LoadingSkeleton`, `ErrorState`, `PermissionDenied`, `HelpTip`; adopt them in
the settings shell, list page, detail page and dashboards.

Acceptance: the four states exist as reusable components with documented usage; no page invents its
own loading/error markup.

### Phase 20.12 — List view power pack

Tasks: URL-encoded filter/sort/page state; column manager; density; inline edit with in-cell
validation; scoped select-all; floating bulk action bar; undo for reversible bulk actions; row kebab
menu filtered server-side; virtualization at 2 000+ rows.

Acceptance: a pasted URL reproduces the exact list; bulk actions report updated/skipped counts and
are undoable; inline errors never appear as toasts.

### Phase 20.13 — Record page and forms

Tasks: sticky header with inline-editable name; next-action band; progressive disclosure panels;
relation panel quick-add; save/save-and-new/cancel; unsaved guard; keyboard `⌘/Ctrl+Enter` save;
duplicate warning.

Acceptance: field-level ACL and dynamic logic still govern the form; server validation maps back to
fields.

### Phase 20.14 — Command palette and global search

Tasks: `⌘/Ctrl+K` palette with command/record/recent modes; keyboard-first navigation; focus
restore; debounce and result cap.

Acceptance: the palette reveals nothing the user could not see at a URL; it works from every screen.

### Phase 20.15 — Dashboards, setup checklist and onboarding

Tasks: role-scoped default dashboards; KPI context (comparison/target/trend); setup checklist
service + admin home panel; empty-state CTAs across the product.

Acceptance: a fresh installation shows a working checklist with deep links; first-use empty states
offer the primary CTA.

### Phase 20.16 — Accessibility and responsive hardening

Tasks: keyboard pass over every new surface; focus management; ARIA on menu/tabs/table/dialog;
contrast tokens; 44 px touch targets; `prefers-reduced-motion`; drawer/tab strip behavior on narrow
viewports.

Acceptance: axe passes on the four core surfaces; keyboard-only walkthrough of §13.5 scenarios 1–5
passes.

### Phase 20.17 — Hardening, compatibility, and release readiness

Tasks: complete unit/integration/API/frontend/a11y/e2e tests; run lint, typecheck, build and the
existing smoke scripts; verify migrations and upgrade path; translations for `en`/`vi`; OpenAPI and
`api-spec/` updates; documentation; diff review for secrets, unsafe SQL and upstream assets.

Acceptance: all P0/P1 items are implemented and verified; deferrals and deviations are listed; no
extra database was created and no destructive setup was introduced.

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
- List view: URL state, column manager, density, scoped bulk actions.
- Record page sticky header and unsaved-changes guard.
- Security tests for the settings and navigation endpoints.
- Migrations, docs, translations, OpenAPI.

### P1 — Required for comfortable daily use

- Command palette with command/record/recent modes.
- Inline editing in list views with in-cell validation.
- Layout manager.
- User preferences server-side (columns, density, favorites).
- Setup checklist and first-run empty states.
- Undo for reversible bulk actions.
- Authentication/Email/Notifications/Attachments tabs.
- Accessibility pass (WCAG 2.2 AA) and responsive hardening.
- API keys, portals and extensions hosted in the shell.

### P2 — Post-first-release enhancements

- Role-scoped default menus and dashboards.
- Dark mode and density themes.
- 2FA management UI.
- Saved view sharing beyond team visibility, and view templates.
- Personalized "next best action" scoring.
- Admin audit diff viewer for settings documents.
- Automated UX metrics (palette success rate, list-view abandonment) if telemetry is ever added.

---

## 19. Definition of Done

Phase 20 is complete when all applicable checks below pass:

- [x] `/admin/settings` is a tabbed, permissioned shell; no single page holds every setting. (20.2, `AdminSettingsPage.tsx` deleted)
- [x] Every settings capability in the §4.3 catalog is reachable from a tab **or a documented deferral** — see `docs/compatibility/settings-ux.md` (users, teams, roles, API keys, layout manager, authentication, email, notifications, attachments, internal and webhooks are 20.7–20.10).
- [x] Settings documents live in `app_settings` with schema validation, versioning, concurrency and
      reset-to-default; no second settings store exists. (20.1)
- [x] The main menu is administrator-configurable and resolved server-side with ACL filtering. (20.4, 20.5)
- [x] Menu configuration can never widen access; forbidden entities never appear. (asserted by `apps/api/test/navigation.test.ts`)
- [x] Entity navigation behavior is metadata-driven (`nav` section + Entity Manager tab); the SPA's hard-coded name sets are gone. (20.6)
- [ ] Users, teams, roles and API keys are manageable without raw API calls, with last-admin
      protection and show-once secrets.
- [ ] The navigation tree and favorites are server-persisted and permission-filtered.
- [ ] List views support URL-shareable state, columns, density, scoped bulk actions and undo.
- [ ] Record pages have a sticky header, next-action affordance and unsaved-changes guard.
- [ ] A command palette is reachable by keyboard from every screen and reveals nothing unauthorized.
- [ ] Empty, loading, error and permission-denied states exist as shared components and are used.
- [ ] Keyboard operability and WCAG 2.2 AA contrast are verified on the four core surfaces.
- [ ] Users can work on desktop, tablet and phone without losing function.
- [ ] Tests cover happy paths, invalid input, permission denial, conflicts and bulk-action edge cases.
- [ ] Lint, typecheck, build and the existing test/smoke suites were run; skipped checks documented.
- [x] Migration `044_phase20_settings_documents.sql` is additive, reviewed and applied without data loss.
- [x] Translations added for `en` and `vi`; the new UI strings resolve through `t()`. (20.2–20.6 scope)
- [ ] OpenAPI and `api-spec/` updated; documentation and compatibility notes written.
- [x] No extra database was created; no reset, truncate or broad delete was performed.
- [x] No upstream PHP source, unlicensed assets or third-party branding were copied.

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