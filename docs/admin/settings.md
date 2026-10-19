# Settings and Administration (Phase 20)

Scope: `PLAN_Phase_20_Settings_UX.md` §4, §7, §8. Implemented: 20.1 registry and documents, 20.2 the
tabbed shell, 20.3 General/Localization and the hosted module documents, 20.4 navigation resolution,
20.5 the Main Menu tab, 20.6 per-entity navigation metadata, 20.7 users/teams/roles/API keys, 20.8 the
layout manager tab, 20.9 the security, messaging, integrations and internal tabs.

## Where things live

```
apps/api/src/admin-panel/
  settings-registry.service.ts      the catalog: name → schema, levels, defaults, owner
  settings-document.service.ts      read / write / reset with version + optimistic concurrency
  settings-documents.controller.ts  /api/v1/Settings/documents[/:name][/reset]
  settings-shapes.ts                Zod schemas for the documents
  platform-settings.ts              registers the documents this platform owns
  admin-panel.service.ts            group and tab descriptors
  admin-panel.controller.ts         /api/v1/AdminPanel, /api/v1/Navigation
  navigation.service.ts             the resolution pipeline
  navigation-defaults.ts            the shipped menu (formerly hard-coded in the SPA)
  navigation-warnings.ts            configuration problems reported, never enforced
apps/web/src/admin/
  AdminSettingsShell.tsx            rail, lazy tab, sticky save bar, unsaved guard
  shell.tsx                         the tab ↔ shell action contract
  document-form.ts                  one document edited as a draft
  module-document.ts                the same for a module-owned document
  tabs/                             general, localization, menu, sales, serviceDesk, customerSuccess,
                                    users, teams, roles, apiKeys (+ identity.ts shared ACL vocabulary),
                                    layout (hosts the shared LayoutEditor)
apps/api/src/auth/
  identity.service.ts               /User /Role /Team /ApiUser /ApiKey business rules
  identity.controller.ts            the same routes, with the 20.7 filters and actions
apps/web/src/components/
  LayoutEditor.tsx                  the drag & drop layout editor shared by the Entity Manager and the
                                    settings Layout tab (draft + pool + live preview + keyboard sensor)
```

## Storage

One `app_settings` row per document — the Phase 0–19 convention. There is no second settings store.

| Row | Shape | Owner | Read | Write |
|---|---|---|---|---|
| `brand` | flat value keys + bookkeeping | `BrandService` | any session | admin |
| `i18n` | flat value keys + bookkeeping | `I18nService` | any session | admin |
| `navigation` | `{version, value, updatedAt, updatedBy, updatedById}` | the registry | admin | admin |
| `security` | envelope | the registry | admin | sysAdmin |
| `fileStorage` | envelope | the registry | admin | admin |
| `notifications` | envelope | the registry | admin | admin |

`brand` and `i18n` keep the flat shape and the validation of the service that owns them (the logo has
to be an image, a locale has to exist as a catalog, a timezone has to resolve). The registry
delegates to that service instead of absorbing its rules, and only adds the version bookkeeping to
the same row — which those services ignore, so the pre-Phase-20 route keeps working.

Module documents (`sales`, `serviceDesk`, `customerSuccess`) are **not** registry documents: they keep
their own endpoints (`GET/POST /:Module/action/settings`) and the shell hosts them in a tab. See
`docs/compatibility/settings-ux.md`.

## Writing a document

```http
POST /api/v1/Settings/documents/navigation
{ "value": { "items": [ … ] }, "version": 3 }
```

- `value` is merged onto the stored value: objects merge key by key, arrays and scalars replace.
- `version` is the one the caller read. A mismatch answers `409 CONCURRENCY_CONFLICT` with
  `details.currentVersion`; the stored row is untouched, so the client can offer reload-and-reapply.
- An invalid document answers `422 VALIDATION_FAILED` with `details.issues[]` paths, before the row is
  touched.
- `POST /api/v1/Settings/documents/:name/reset` writes the registered defaults, never `null`.
- Every successful write appends a `schema_changes` row (`operation = settings.document.update`) with
  the actor, the changed key names and the before/after versions — no values — and publishes the
  `settings.document.updated` domain event.

## Adding a document

1. Write its Zod schema and defaults in `settings-shapes.ts` (or keep them in the owning module).
2. Register it from `platform-settings.ts` for a platform document, or from the owning module's
   registrar for a module document: name, group, label key, read/write level, schema, defaults,
   `storage` (`envelope` for a new document), optional `write` delegate and optional `warnings`.
3. Seed an idempotent default row in a migration if an install should have one visible in the
   database (`database/migrations/044_phase20_settings_documents.sql` is the pattern).
4. Add a tab descriptor to `admin-panel.service.ts` and a lazy component in `apps/web/src/admin/tabs`.

`warnings` are how a document reports a configuration problem without refusing it: a menu label key
that does not resolve, a key an upgrade removed. The tab lists them; the value still saves.

## Identity administration (20.7)

Users, teams, roles and API keys are tabs in the same shell, but they are **record** editors: each
action writes one record through the existing identity API, so the shell hides the sticky save bar for
a tab that has no `document` and no `moduleEndpoint` (`AdminSettingsShell.tsx`).

| Tab | Endpoints | Rules the server owns |
|---|---|---|
| `users` | `GET/POST /User`, `GET/PATCH/DELETE /User/:id`, `POST /User/:id/password-reset` | last-administrator guard, team sync, portal linkage, session revocation on reset |
| `teams` | `GET/POST /Team`, `GET/PATCH/DELETE /Team/:id` | `users_teams` is authoritative, `teams_roles` is what the ACL reads |
| `roles` | `GET/POST /Role`, `GET/PATCH/DELETE /Role/:id` | a role still assigned cannot be deleted (`details.rule = roleInUse`) |
| `apiKeys` | `GET/POST /ApiUser`, `POST /ApiUser/:id/key`, `GET /ApiKey/:id`, `DELETE /ApiKey/:keyId` | the secret exists only in the response that created it |

`GET /User` accepts `where`, `isActive`, `type`, `roleId` and `teamId`; a value it cannot interpret
answers `400 INVALID_QUERY` rather than quietly widening the list an administrator is reading.

The last-administrator rule is evaluated on the state **after** the change — deactivating, demoting or
deleting the account that would leave no active administrator is what is refused
(`422 VALIDATION_FAILED`, `details.rule = lastAdministrator`). "Administrator" is the same three ways
`AclApiService` decides it: `is_admin`, `type = 'admin'`, or the built-in `sysAdmin` role.

## Layout manager (20.8)

The `layout` tab hosts the same `LayoutEditor` the Entity Manager uses — one editing behavior, two
hosts. The tab picks an entity (kept in the URL as `?entity=`), and the editor manages list/detail/edit
panels per view: drag fields between panels and the disabled pool, drag a panel by its handle to
reorder, add/rename/remove panels, with a live preview built from the draft (a list layout previews as
the table's column order; detail and edit preview as stacked panels).

- The keyboard alternative is dnd-kit's `KeyboardSensor`: focus a row, `Space` to lift, arrows to move,
  `Space` to drop. No pointer is required anywhere in the editor.
- The editor reports its draft to the shell (`onState`), so Save/Discard/Reload and the dirty guard come
  from the shared save bar — the descriptor opts in with `usesSaveBar: true`, and the editor draws no
  button row of its own in this host. Switching entity with a dirty draft asks first.
- Writes go through `POST /Metadata/:entity` (`layouts` section). The server validates the patch
  (`metadata.controller.validateLayouts`): an unknown view, a panel without a name, or a panel listing a
  field the entity does not have is refused with `422` naming the field. The same validation is pinned by
  `apps/api/test/metadata-api.test.ts`.
- A `list` layout only reorders columns (`orderByLayout`); a field's presence stays governed by its
  `inList` flag. detail/edit layouts drive the panels of the record screens (`layoutPanelsFor`), so a
  saved change renders without a code change.

## Security, messaging, integrations and internal tabs (20.9)

| Tab | Backing | Notes |
|---|---|---|
| `authentication` (Security, sysAdmin) | `security` document | password policy, session policy, sign-in notice |
| `permissions` (Security, admin) | read-only from metadata + `/Role` | the composition rule, each role's stated scope, and the mandatory defaults metadata ships; no editor — the Roles tab is the editor |
| `attachments` (System, admin) | `fileStorage` document | upload limit + extension allowlist; the storage driver itself stays in server configuration |
| `email` (Messaging, admin) | `/EmailAccount`, `/Email/action/transport` | mailbox CRUD + "test settings"; a mailbox password is write-only — the API never returns it, the view can only say whether one is stored |
| `notifications` (Messaging, admin) | `notifications` document | the defaults new users start from, not a mandate |
| `webhooks` (Integrations, admin) | `/WebhookEndpoint` (the `webhook-integration` extension) | endpoint CRUD, deliveries; when the extension is not installed the tab shows that as a state, not an error |
| `internal` (System, sysAdmin) | `/AdminInternal` | instance facts (metadata version, override count, queue counts, extensions) and the guarded danger zone |

**The danger zone.** `POST /AdminInternal/action/metadata-reset` and
`POST /AdminInternal/action/queue-purge` each require the exact typed confirmation
(`RESET METADATA` / `PURGE QUEUE` — a mismatch answers `422` with `details.expected`), refuse
non-administrators with `403`, and write an `admin.internal.*` row to `schema_changes` when they run.
The reset drops the `app_settings.entity` override row (the Entity Manager's per-entity changes) and
invalidates the metadata cache — records are never touched; the purge drains the BullMQ waiting list
only. Refusals write no audit row; success is always audited. The destructive paths are not exercised
against the configured database — `apps/api/test/admin-internal.test.ts` pins the guards and asserts
that a refusal leaves both the overrides and the audit count untouched.

## Levels

`public` (any session, e.g. brand), `admin` and `sysAdmin`. The instance has one administrative tier
today, so `admin` and `sysAdmin` resolve to the same predicate — recorded in
`docs/compatibility/settings-ux.md`. The remaining catalog rows — user preferences (20.10) and the
end-user UX pack — are the plan's later sub-phases.
