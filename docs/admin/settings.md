# Settings and Administration (Phase 20)

Scope: `PLAN_Phase_20_Settings_UX.md` §4, §7, §8. Implemented: 20.1 registry and documents, 20.2 the
tabbed shell, 20.3 General/Localization and the hosted module documents, 20.4 navigation resolution,
20.5 the Main Menu tab, 20.6 per-entity navigation metadata.

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
  tabs/                             general, localization, menu, sales, serviceDesk, customerSuccess
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

## Levels

`public` (any session, e.g. brand), `admin` and `sysAdmin`. The instance has one administrative tier
today, so `admin` and `sysAdmin` resolve to the same predicate — recorded in
`docs/compatibility/settings-ux.md`. The `internal`/danger-zone tab, users/teams/roles/API keys, the
layout manager and the messaging tabs are later sub-phases of the same plan (20.7–20.10); the
descriptors and endpoints are shaped for them.
