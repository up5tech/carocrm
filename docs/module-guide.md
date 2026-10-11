# Module Guide (CRM Kernel Alpha)

Read this before adding code. Scope: PLAN.md tasks 01–22 (CRM Kernel Alpha, PLAN §73, plus the SPA,
stream/calendar and the PLAN §21–§22 dynamic logic + formula engine).

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
| Formula engine | `packages/formula` (`@carocrm/formula`) | `FormulaEngine` (parser → AST → evaluator), `FunctionRegistry`, `DEFAULT_LIMITS`; pure, no I/O |
| Dynamic logic | `apps/api/src/logic/` | `FormulaService` (metadata guard), `RecordLogicService` (write path), `POST /api/v1/Formula/{validate,evaluate}` (admin) |
| Hook phases | `apps/api/src/hooks/` | `HookRegistry` (named handlers, optional entity scope), `GET /api/v1/Hook` (admin); phases from `@carocrm/entity-engine` `HOOK_PHASES` |
| Domain events | `apps/api/src/events/` | `EventBus.dispatch(tx, event)` writes `outbox_events` in-tx, `EntityEventHookService` on `KERNEL_HOOKS_TOKEN`, `GET /api/v1/DomainEvent` (admin) |
| Event consumers | `apps/worker/src/events/` | `DomainEventBus.subscribe({eventType, name, handler})`, `'*'` wildcard; wired to the outbox registry by `createKernelOutboxSetup` |
| Background jobs (API) | `apps/api/src/jobs/` | `JobsService` + `JobQueueService` (BullMQ producer); `POST/GET /api/v1/Job`, `GET /Job/:id`, `GET /Job/:id/log`, `POST /Job/:id/action/cancel`, `GET/POST /api/v1/ScheduledJob[/:id/{enable,disable,action/runNow}]`, `POST /ScheduledJob/action/preview` (all admin) |
| Job execution (worker) | `apps/worker/src/queue/` | `runJob` adopts the API's `pending` row, writes `progress`/`message` and `job_logs`, honours `shouldStop()`; `job-handlers.ts` is the registry extension point |
| Kernel hooks | `apps/api/src/entity/hooks.ts` | `KERNEL_HOOKS_TOKEN` → `AfterSaveHook[]` with `operation: 'create'\|'update'\|'delete'\|'restore'`; audit, stream-update and domain-event hooks each register one |

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

## Dynamic logic + formula contracts (PLAN §21, §22)

- `@carocrm/formula` is **pure**: parser → AST → tree-walking evaluator. It never touches the
  network, filesystem, `require`, `eval` or a host object. Functions come from an explicit allowlist
  (`FunctionRegistry`), and every evaluation runs under `DEFAULT_LIMITS` (source length, node count,
  nesting depth, step budget, produced string/array size). Custom functions can be registered with
  `registry.register(fn)` — the extension SDK hook (PLAN §22.2 "later").
- Dates are **context-driven**: `now()`/`currentDate()` read `FormulaContext.now` and the IANA
  `timezone`, defaulting to UTC. Never pass an ambient clock into metadata evaluation.
- Metadata carries the rules on the entity: `dynamicLogic: { rules: [...] }`. A rule is
  `{ name?, description?, disabled?, when, then }` where `when` is either a formula string or the
  criteria object `{ field, operator, value }` (composable with `all` / `any` / `not`), and `then`
  is one or more of `show`, `hide`, `setRequired`, `setReadOnly`, `setValues` (field → formula),
  `showPanels`, `hidePanels`, `error: { message, fields? }`. A metadata patch **replaces** the whole
  rule list; send `{ dynamicLogic: { rules: [] } }` to clear it.
- `FormulaService.validateDefinition()` runs on **every** metadata write and on `MetadataStoreService.load()`:
  conditions and field formulas must parse, must only call allowlisted functions, and must only
  reference fields that exist. `POST /Metadata/:entity` therefore answers 422 with an `issues` list.
- `RecordLogicService.apply()` is the single write-path hook, called from `EntityCrudService.create`
  and `.update` (so `massUpdate` inherits it): it fills rule `setValues`, evaluates `formula` fields,
  rejects a client write that contradicts a computed/read-only field, enforces rule-required fields,
  and turns `error` rules into a 422. Failures to evaluate a condition are fail-closed (the write is
  rejected, never treated as "rule did not match").
- Fields of type `formula` / `generated` are **not editable**: `editEntries()` in the SPA drops them,
  `metadata.dynamicLogic` hides/shows the rest, and the detail view renders the stored value.
- Controllers: `LOGIC_CONTROLLERS` owns `/api/v1/Formula/*` (static prefix) and must be spread
  before `ENTITY_CONTROLLERS`, like stream/calendar.
- `RATE_LIMIT_MAX` (`.env`, default 300 req/min) is the global HTTP limit; the browser suite raises
  it because a single SPA screen issues many small calls.

## Hooks and domain events (PLAN §23)

Two seams, deliberately different:

- **`HookRegistry`** (`apps/api/src/hooks/`) — the §23.1 *phases*. Handlers are named, optional per
  entity, and dispatched by `EntityManager` outside the mutation transaction, so a handler may
  mutate `context.data` (before phases) or react to the stored `context.record` (after phases).
  Throwing an `AppError` aborts the request. `packages/entity-engine` exports `HOOK_PHASES` as a
  **list, not a closed enum** (`HookPhase = string`) so new phases can be added as the product needs.
  `EntityCrudService` builds its `EntityManager` per mutation on purpose — a cached manager would
  freeze the handler set at first use.
- **`KERNEL_HOOKS_TOKEN`** — transaction-scoped work. Audit rows, stream `Update` items and domain
  events all need the *same* transaction as the record write, so they run here and receive
  `{ entityType, record, previous?, userId?, operation, tx }`. Do not do I/O in these hooks.

Domain events (PLAN §23.2) follow the outbox pattern end to end:

```
HTTP request → EntityManager phases → PostgresRecordStore.withTransaction
  → entity row + audit + stream + outbox_events row  (one transaction)
  → commit → worker OutboxPoller claims → OutboxHandlerRegistry → DomainEventBus.publish
  → subscribers (registration order; first failure rethrows so the poller retries)
```

- Catalog lives in `@carocrm/core` (`DOMAIN_EVENT_TYPES`, `entityEventType`, `changedFields`,
  `EntityEventPayload`) so producer and consumer share one definition. Types:
  `entity.created|updated|deleted|restored`, payload `{ entityType, entityId, changed[], userId, version }`.
- Publishing is automatic for generic record mutations; other producers call
  `EventBus.dispatch(tx, { type, payload })` with their own transaction.
- Relation link/unlink and stream/notification writes do **not** publish domain events yet.
- Delivery is at-least-once; subscribers must be idempotent (the outbox `id` is a stable key).
  An event type with no subscriber is logged and marked processed, so the queue cannot clog.
- Subscribe from worker composition before `start()`: `app.domainEvents.subscribe({ ... })`
  (`apps/worker/src/events/domain-event-bus.ts`, helper `subscribeToMutation`).
- Introspection: `GET /api/v1/Hook` (phases + installed handlers) and
  `GET /api/v1/DomainEvent?status=&eventType=&offset=&limit=` (outbox rows, newest first) —
  both admin-only, both registered before `ENTITY_CONTROLLERS`.

## Background jobs and scheduled jobs (PLAN §24)

- `jobs` is the durable record (one row per attempt), `scheduled_jobs` is the cron metadata the
  scheduler polls, `job_logs` holds `context.log(...)` lines. Redis only carries the queue.
- **Row adoption**: the Jobs API inserts a `pending` row and puts its `jobRowId` into the BullMQ
  payload; `runJob` adopts that row (`WHERE status='pending' AND cancel_requested = FALSE`). A
  retry attempt or a scheduler run therefore creates its own row, and an admin who cancelled before
  the worker woke up is never executed. `scripts/worker-smoke.sh` asserts all of this.
- **Handler contract** (`packages/jobs`): `JobContext = { data, userId?, progress(%), log(msg, level?), shouldStop() }`.
  `progress()` is throttled (only changed percents are written, clamped 0..100) and cannot resurrect
  a finished row (the update filters `status = 'running'`). `shouldStop()` polls the cancel flag with a
  1s cache, so a long job checks it between batches — cancellation is cooperative, never a kill.
- **Retries**: BullMQ `attempts` + exponential backoff, configurable through `JOB_ATTEMPTS`,
  `JOB_BACKOFF_BASE_MS`, `JOB_QUEUE_NAME` (must equal the worker's `WORKER_QUEUE_NAME`; the API test
  suite pins it to `crm-jobs-test`). The last attempt leaves the row `failed` with `last_error`, which
  is the dead-letter trail.
- **Names**: `<module>.<action>` (`system.cleanupOutbox`). The API validates the shape and refuses a
  payload over ~32 KB; only a registered name can ever run — metadata stores names, never code.
- **Admin UI**: `apps/web/src/pages/AdminJobsPage.tsx` at `/admin/jobs` (admin nav only) — job list
  with status/progress/attempt/message, status filter, queue counts, log drawer, cancel, run-a-job
  modal, and the schedule table with enable/disable/run-now/save (cron is validated against the
  `ScheduledJob/action/preview` endpoint while typing).
- Tests that submit jobs must cancel what they created: `e2e/jobs.spec.ts` snapshots pending ids
  around each action, and `purgeEntityEvents()` in `apps/api/test/support/boot-api.ts` removes the
  domain events an API suite generated (no worker runs during vitest).

## Attachments and file storage (PLAN §25)

- **Storage port** (`packages/files`): `FileStorage = { driver, supportsSignedUrls, put, get,
  openRead, delete, exists, signDownloadUrl? }`. Keys are POSIX-relative paths validated by
  `assertSafeStorageKey` (no absolute paths, no `.`/`..`, restricted segment charset) — every driver
  re-checks that the resolved target stays inside its own root. `put` accepts a `Buffer` **or** a
  `Readable`; both drivers stream, so an upload is never buffered whole in the process.
- **Drivers**: `LocalFsStorage` (`STORAGE_DRIVER=local`, root `STORAGE_ROOT`) and `S3FileStorage`
  (`STORAGE_DRIVER=s3`, `S3_BUCKET/REGION/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE`).
  MinIO is the s3 driver with an endpoint and path-style addressing; a missing bucket/region fails at
  boot, not on the first upload. Only the s3 driver sets `supportsSignedUrls`, because local disk has
  no public read path.
- **Upload pipeline**: `StreamProbe` (a `Transform`) captures the head for sniffing, counts bytes and
  hashes sha256 in one pass, and raises `OversizedUploadError` the moment the ceiling is crossed. The
  multipart parser is then given the *same* ceiling per request (`request.file({ limits: { fileSize } })`)
  and `file.truncated` is checked afterwards — otherwise a body cut at the transport limit would be
  stored as a complete file of exactly the maximum size.
- **File safety**: blocked extensions (`.exe .sh .bat .cmd .js .jar .msi .apk .dll .so`), an allowlist
  of MIME types plus `image/*`/`text/*`, and a malware hook (`MALWARE_SCANNER_TOKEN`). The built-in
  `SignatureScanner` catches EICAR, executable magic behind a benign MIME type, NUL bytes in declared
  text and non-images declared as images; `CompositeScanner` fails closed, so a broken scanner rejects
  rather than accepts. An installation with ClamAV registers its own scanner behind the same token.
- **Access checks** run on every read, not only on upload: admin, the uploader, or a caller whose
  parent record passes `PARENT_ACL_CHECK_TOKEN` may download. The default checker is permissive until
  the entity ACL is wired in — swap it in `ATTACHMENT_PROVIDERS`.
- **Chunked uploads** (`/api/v1/AttachmentUpload`): `init` reserves `{name, mimeType, totalSize,
  chunkSize?}` in `file_uploads`, `:id/part` takes `index` + `file` in any order, `:id/complete`
  replays the parts in index order through the *same* attachment path (so the checks are identical),
  `:id/abort` deletes them. The `parts` JSONB ledger records each accepted index with its size, so a
  retried chunk replaces its bytes instead of double counting, and completion requires contiguous
  indexes plus an exact `received == totalSize`.
- **Expiry**: `expires_at` is stamped at init (`UPLOAD_EXPIRY_HOURS` grace). `system.cleanupUploads`
  (hourly in `database/seed.ts`) claims rows past deadline + grace (`WHERE id = $1 AND status='open'`,
  so two workers never fight) and deletes their part files. The job is only registered when the
  process can reach the storage, so an API-only deployment does not advertise it.
- **Migrations**: `004_file_uploads.sql` creates the reservation table; `005_file_upload_parts.sql`
  adds the `parts` ledger. `004` had already been applied to the development database when the ledger
  was designed, so the column arrived as an additive `ALTER … ADD COLUMN IF NOT EXISTS` instead of an
  edit to an applied migration.
- Tests: `apps/api/test/attachments-storage.test.ts` (driver info, ceilings, scan hook, per-record
  download ACL, chunked flow), `packages/files/src/{storage,s3,scanner}/index.test.ts`, the attachment
  block in `scripts/e2e-smoke.sh`, and section 5 of `scripts/worker-smoke.sh`.

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
