# Module Guide (CRM Kernel Alpha)

Read this before adding code. Scope: PLAN.md tasks 01–22 (CRM Kernel Alpha, PLAN §73, plus the SPA and stream/calendar).

## Runtime rules (IMPORTANT)

- The API runs under `tsx` (esbuild): **`emitDecoratorMetadata` does not work**. Every
  constructor injection MUST use an explicit token:
  `constructor(@Inject(AuthService) private readonly a: AuthService, @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}`
- `verbatimModuleSyntax` is on: type-only imports MUST use `import type`.
- ESM: every relative import needs a `.js` extension.
- `exactOptionalPropertyTypes` is on: optional interface props are declared `x?: T | undefined`
  and objects must be built with conditional assignment, not `prop: maybeUndefined`.
- Cross-package imports resolve to built `dist/` (exports map). Run
  `pnpm --filter @carocrm/<pkg> build` after editing a package.
- ESLint: no `for..in`, no `any`, `import/no-default-export`, simple-import-sort enforced.
  No `console.*` (use `log` from `@carocrm/core/logger/index.js`).
- Tests: vitest, files under `apps/api/test/*.test.ts`, boot the app with
  `bootTestApp()` from `apps/api/test/helper.ts` (uses DATABASE_URL from `.env`, DB `carocrm_dev`).
  Tests hit the API via `app.inject({ method, url, headers, payload })`.

## Existing kernel pieces

| Piece | Where | Token |
|---|---|---|
| Config | `apps/api/src/config.ts` | `CONFIG_TOKEN` → `AppConfig` |
| Kysely/pg | `apps/api/src/database/database.service.ts` | `DatabaseService` (class token), `.db` is `Kysely<Database>`, full table types defined there |
| Request scope | `apps/api/src/common/request-scope.ts` | `REQUEST_SCOPE_TOKEN` → `RequestScope` (principal, isAdmin, roleIds(), teamIds()) |
| Metadata | `apps/api/src/metadata/metadata-store.service.ts` | `METADATA_STORE` → `MetadataStoreService` (registry + cache, `.load()` at bootstrap) |
| Auth | `apps/api/src/auth/*` | `AuthService`, `AuthGuard` (global APP_GUARD), `@Public()` decorator |
| Outbox | `apps/api/src/common/outbox.service.ts` | `OutboxService.insertMany(txOrDb, events)` |
| Errors | `@carocrm/core/errors/index.js` | `AppError` subclasses; `GlobalExceptionFilter` renders PLAN §47 envelope |
| Entities metadata | `database/seed-metadata.ts` | Account/Contact/Lead/Opportunity + activities (Task/Call/Meeting/Reminder), scope 'entity' |
| Stream | `apps/api/src/stream/` | `StreamService`; routes `GET /Stream`, `GET /:type/:id/stream`, `POST /Note`, `PUT\|DELETE /:type/:id/subscription`, `GET /Notification` |
| Calendar | `apps/api/src/calendar/` | `CalendarService` + pure `expandOccurrences()` in `recurrence.ts`; route `GET /Calendar` |
| Kernel hooks | `apps/api/src/entity/hooks.ts` | `KERNEL_HOOKS_TOKEN` → `AfterSaveHook[]`; audit and stream-update each register one |

## API conventions

- Root: `/api/v1`. Auth: `Authorization: Bearer <jwt>` or `Authorization: ApiKey <keyId>:<secret>` or
  cookie `CRM-SESSION` (unsafe methods also need `x-csrf-token` matching `CRM-CSRF` cookie).
- List envelope: `{ list, total, offset, count }`. Record JSON: flat object,
  `id, name, createdAt, modifiedAt, assignedUserId, createdById, modifiedById, teams` plus fields.
- Errors: `{ "error": { "code", "message", "details?" } }` with matching HTTP status
  (handled by the global filter when you throw `AppError` subclasses).

## Data model decisions (Alpha)

- All generic entity records live in `entity_records`: physical columns listed above,
  everything else in `attrs` JSONB. `version` column for optimistic concurrency, `deleted_at` for soft delete.
- Relations of record = link fields stored in `attrs` (`accountId`, `contactIds`).
  Related-records endpoints (e.g. `GET /Account/{id}/contacts`) resolve through metadata:
  a parent relation `contacts` (oneToMany, target Contact, mappedBy 'account') means
  child records whose `attrs->>'accountId'` (or `attrs->'contactIds'` containment for multiples) match.
  `entity_links` backs explicit link/unlink endpoints from PLAN §16.1.
- ACL levels per role per entity/action: `yes | all | team | own | no` (see `packages/acl`).
  Role `permissions`: `{ "Account": { "read": "all" }, "*": { ... } }` (wildcard `*` = default for all entities;
  role ids `sysAdmin` = full access). Field restrictions via `field_permissions`
  `{ "Entity": { "field": { "read": "no", "edit": "no" } } }`; a role with a field entry at level
  `no` for `read` must not see the field in responses and cannot write it.
- `RequestScope.isAdmin` (userType `admin`) bypasses ACL checks.

## Files to register new modules

- Add providers to `providers` and controllers to `controllers` in `apps/api/src/app.module.ts`.
- Exports list already includes DatabaseService, AuthService, IdentityService, METADATA_STORE,
  OutboxService, REQUEST_SCOPE_TOKEN.

## Cross-module contracts (agreed for this build)

- `KERNEL_HOOKS_TOKEN` (apps/api/src/entity/entity.module or exported via barrel):
  provider value is `AfterSaveHook[]` where
  `type AfterSaveHook = (args: { entityType: string; record: EntityRecord; previous?: Record<string, unknown>; userId?: string; tx: Db | DbTx }) => Promise<void>`.
  The generic entity store invokes all registered hooks inside the mutation transaction after
  insert/update. The audit module registers its hook there.
- `FILE_STORAGE_TOKEN`: `FileStorage` interface from `packages/files` (put/get/delete/exists).
- `STORAGE_ROOT` comes from `AppConfig.storageRoot`.
- Each module exposes `export const <NAME>_PROVIDERS: Provider[]` and `<NAME>_CONTROLLERS: unknown[]`
  from its barrel file; the integrator adds them to AppModule once.
- `STREAM_METADATA_LOOKUP` mirrors `AUDIT_METADATA_LOOKUP`: AppModule supplies the entity field
  definitions, and the default provider returns `undefined` (no generated Update items).
- Controller order matters: `STREAM_CONTROLLERS` and `CALENDAR_CONTROLLERS` declare
  `/api/v1/:entityType/:entityId/{stream,subscription}` routes and MUST be spread before
  `ENTITY_CONTROLLERS`, whose `:entity/:id/:relation` wildcard would otherwise swallow them.
- Activity reminders: `system.sendReminders` (apps/worker/src/handlers) scans due activities and
  writes `notifications`; the seed installs the `scheduledReminders` cron row (`* * * * *`).

## Test database policy (AGENTS.md §3 — mandatory)

Tests run against the **configured primary database** (`DATABASE_URL` from `.env`).
Never create, reset, truncate or drop a database for tests, and never add per-run,
per-agent or per-feature databases. `apps/api/test/helper.ts` and
`apps/api/test/support/boot-api.ts` only apply migrations and the idempotent seed.

Consequences for test code:
- Every record a test creates must carry a unique run marker (e.g. `emp-<random>`,
  `PW Account <runId>`) and tests may only delete/modify records they created.
- Never deactivate or delete the shared `admin` account — create a temporary admin instead.
- Sessions are minted per call (`getAdminToken()`), so one test logging out cannot break another.
