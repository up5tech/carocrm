# CRM Kernel Alpha — status report (PLAN §73)

Date: 2026-10-10. Scope agreed with the user: **CRM Kernel Alpha only** (PLAN tasks 01–16, 19–20 of §87).
Tasks 17–18 (generic React UI + Entity Manager) were completed afterwards, together with stream,
calendar and the PLAN §21–§22 dynamic logic + formula engine, §23 hooks + domain events, §24 jobs,
§25 attachments/file storage, the §28 outbound email subsystem, Phase 12 (search, saved filters,
CSV import/export, dashboards — see the sections at the end of this file), Phase 14 (extension
SDK, `packages/extension-sdk` + the `modules/` sample packages) and Phase 15 (workflow engine,
`packages/workflow` + the admin builder);
BPM, reports and portals remain
unimplemented; see PLAN §72 for the remaining priority matrix.

## Checklist from PLAN §73

| Item | State | Evidence |
|---|---|---|
| NestJS API running | done | `apps/api` (Nest 11 + Fastify 5), `pnpm dev` |
| PostgreSQL running | done | local server, schema in `database/migrations/001_init.sql` |
| Redis running | done | `docker-compose.yml` + `REDIS_URL`, used by worker/BullMQ |
| User authentication working | done | argon2id, JWT access + rotating refresh, cookie session + CSRF, API keys |
| Roles working | done | `roles` table + `POST/PATCH /api/v1/Role` |
| Teams working | done | `teams` + `users_teams` + team-scoped ACL |
| ACL working | done | `apps/api/src/acl/acl-api.service.ts`; levels `yes/all/team/own/no`, entity+field+record scope |
| Metadata service working | done | `GET/POST /api/v1/Metadata[/:entity]`, DB-backed overrides, version header |
| Generic entity CRUD working | done | `/api/v1/:entity` (list/get/create/update/patch/delete/restore/mass) |
| Dynamic fields working | done | admin adds a field via metadata patch → usable in records without new code |
| Dynamic relations working | done | link/linkMultiple fields + `/api/v1/:entity/:id/:relation` link/unlink/list |
| Generic React CRUD UI working | done | `apps/web`: nav, list (filter/sort/paging/mass delete), detail with relationship panels, create/edit forms — all rendered from `GET /Metadata` |
| Entity Manager admin UI working | done | `apps/web/src/pages/EntityManagerPage.tsx`: labels, add/disable fields, add relations, enable/disable and create entities |
| Attachments working | done | `POST /api/v1/Attachment/upload`, MIME/size/extension checks, local FS storage |
| Outbound email working | done | `MailTransport` port (SMTP + generic relay + disabled/memory), `POST /api/v1/Email/:id/action/send` queues `system.sendEmail`, `email_deliveries` ledger; inbound (§28.2) not implemented |
| Audit working | done | field-level rows in `audit_log`, `GET /api/v1/AuditLog`, secrets redacted |
| Global and entity search working | done | `GET /api/v1/Search[/:entity]?q=`, ACL-filtered, trigram-indexed (see Phase 12 section) |
| Saved filters working | done | `/api/v1/SavedFilter` CRUD + `action/run`, private/shared ownership columns |
| CSV import/export working | done | `POST /:entity/action/import`, `POST|GET /:entity/action/export`, formula-injection guarded |
| Dashboards and dashlets working | done | `/api/v1/Dashboard` + dashlets (`list`/`chart`/`kpi`), SPA `/dashboards` |
| Extension packages working | done | `packages/extension-sdk` + `modules/` sample packages, `/api/v1/Extension`, `/admin/extensions` |
| Workflows working | done | `packages/workflow` engine, worker execution + run history, `/api/v1/Workflow`, `/admin/workflows` |
| OpenAPI working | done | `GET /api/v1/OpenApi` (generated from controllers) |
| API integration tests working | done | 300 vitest tests in `apps/api/test` (+193 package unit tests) |
| Playwright login/CRUD tests working | done | `e2e/crud.spec.ts` (`npx playwright test`) |
| Docker deployment working | partial | `docker-compose.yml` provides postgres/redis/api; images not built yet |
| Backup and restore documented | done | `docs/operations/backup-restore.md` |

## Verification commands

```bash
pnpm install
pnpm db:seed          # applies migrations and seeds admin/roles/metadata into the configured DATABASE_URL
pnpm lint             # eslint, 0 warnings allowed
pnpm typecheck        # tsc --noEmit over the whole workspace
pnpm -r build         # all packages + api + worker
npx vitest run        # 493 tests: 300 API/integration (apps/api/test) + 193 package unit; runs on the configured DATABASE_URL, no extra database
bash scripts/e2e-smoke.sh   # 142 checks: HTTP end-to-end, incl. attachments, scan hook, chunked upload, outbound email, search/filters/import/export/dashboards, extensions, workflows
bash scripts/worker-smoke.sh # 34 checks: outbox, BullMQ jobs, cron, graceful shutdown, job progress/logs/cancellation, upload cleanup, system.sendEmail
npx playwright test    # browser specs (CRUD/Entity Manager/relations/stream/calendar/dynamic logic/jobs/email/phase-12 search+csv+dashboards/extensions/workflows); starts API+SPA itself
pnpm --filter @carocrm/worker test  # 143 worker tests (jobs, scheduler, outbox, reminder job, upload cleanup, sendEmail job, domain-event subscribers, extension config, workflow engine)
```

## Deviations from PLAN (deliberate, for Alpha)

- `docker-compose.yml` is dev-oriented (source mount, no built images); PLAN §65 production topology not built.
- Query grammar is EspoCRM-like JSON criteria translated to Kysely; raw SQL is never accepted (PLAN §15.2).
- Metadata overrides are stored in `metadata_entries` + `app_settings('entity')` rather than files.
- Attachment parent-ACL check uses the record-level ACL predicate; portal/API-user policies are future work (PLAN §37).
- Multi-tenancy columns are absent: repositories are single-tenant for Alpha (PLAN §43 wanted tenant-aware APIs — deferred).

## Notable bug found and fixed during build

`IdentityService.updateUser` was missing its `WHERE` clause, so a single
`PATCH /api/v1/User/:id {"isActive":false}` deactivated **every user row** in the database.
Fixed, and the test suite now asserts that admin stays active after such a PATCH; a repo-wide
audit of `updateTable` calls confirmed every mutation is keyed.

## Stream and calendar (PLAN tasks 21–22, added 2026-10-11)

- `database/migrations/002_stream.sql` adds `stream_items`, `stream_mentions`,
  `stream_followers`, `stream_attachments` and `notifications`.
- `apps/api/src/stream/` implements posts/notes, follow + global activity stream, @mentions
  (which create notifications) and generated `Update` items from the per-field `audited` flag.
  Posting needs the per-entity `stream` ACL action; reading a stream needs `read` on the record,
  and global-stream items are dropped when the parent record is not readable.
- `apps/api/src/calendar/` adds Task/Call/Meeting/Reminder metadata, `GET /Calendar` with
  recurrence expansion (`recurrence.ts`, pure and unit-tested) and IANA day bucketing.
  `system.sendReminders` in the worker delivers due reminders as notifications.
- SPA: Stream panel on every record page, `/stream` activity page, `/calendar` month grid with
  drag-to-reschedule.

## Dynamic logic and the formula engine (PLAN §21–§22, added 2026-10-11)

- New workspace package `packages/formula` (`@carocrm/formula`): tokenizer → recursive-descent parser
  → typed AST → tree-walking evaluator, with an explicit function allowlist (`ifThen`, `concat`,
  `substring`, `split`, `join`, `round`, `numberFormat`, `sum`, `avg`, `min`, `max`, `inArray`,
  `arrayAddUnique`, `isEmpty`, `field`, `recordId`, `now`, `currentDate`, `addDays`, `addMonths`,
  `diffDays`, `formatDate`, `yearOf`, `weekdayOf`, …) and hard budgets for source length, node count,
  nesting depth, evaluation steps and produced value size. Date/time output comes from the injected
  context clock plus an IANA zone, so it is deterministic and never reads the host clock.
- Declarative rules live on entity metadata as `dynamicLogic.rules`. Conditions accept either a formula
  string or the structured `{field, operator, value}` shape from PLAN §21 (composable with
  `all`/`any`/`not`). Actions: `show`, `hide`, `setRequired`, `setReadOnly`, `setValues`,
  `showPanels`, `hidePanels`, `error`.
- Enforcement is doubled on purpose: `POST /Metadata/:entity` refuses rules that do not parse or
  reference unknown fields, and `RecordLogicService.apply()` re-evaluates the same rule set on every
  create/update (and through it, mass update) — required fields, computed values, read-only fields
  and blocking business conditions all fail closed with `422 VALIDATION_FAILED`.
- Field type `formula` with a `formula` expression is computed server-side; such fields are excluded
  from the generated edit form and a client-supplied value that contradicts the computation is rejected.
- Admin tooling: `POST /api/v1/Formula/validate` and `POST /api/v1/Formula/evaluate` (admin only),
  plus a rule builder in Entity Manager and a formula-field type in the add-field form.
- SPA: `apps/web/src/state/logic.ts` evaluates the same rules from live form values, so fields hide,
  become required, lock or fill themselves while the user types; the detail view hides invisible fields.
- Config: the global HTTP rate limit is now `RATE_LIMIT_MAX` (default 300/min, unchanged); the browser
  suite raises it because seven specs share one server.

## Hooks and domain events (PLAN §23, added 2026-10-11)

- `HookRegistry` (API) dispatches the PLAN §23.1 phases — `beforeValidate`, `beforeCreate`,
  `beforeUpdate`, `beforeDelete`, `beforeSave`, `afterCreate`, `whenCreated`, `whenUpdated`,
  `whenDeleted`, `afterSave` — to named, optionally entity-scoped handlers. A `before*` handler can
  change the data being written (including the value of a dynamic-logic/formula field), and any
  handler can abort the write by throwing an `AppError`. The phase list is open (`HookPhase` is a
  string with `HOOK_PHASES` as the recommended set), as PLAN §23.1 asks.
- Domain events now go through the **transactional outbox** for real: `entity.created`,
  `entity.updated`, `entity.deleted` and `entity.restored` are written into `outbox_events` inside
  the same transaction as the record mutation (`EntityEventHookService` on `KERNEL_HOOKS_TOKEN`),
  replacing the previous post-commit `emit()` that could lose an event when the process died after
  the commit. Payload is `{ entityType, entityId, changed[], userId, version }`; the catalog is in
  `@carocrm/core` so the API and worker agree.
- The worker fans a claimed event out to `DomainEventBus` subscribers (registration order, `'*'`
  wildcard, at-least-once so subscribers must be idempotent) — `app.domainEvents.subscribe(...)` or
  the `subscribeToMutation` helper.
- Introspection endpoints (admin only): `GET /api/v1/Hook`, `GET /api/v1/DomainEvent`.
- Restore is now transactional too (row + audit + event commit together) and emits `entity.restored`.
- Not covered yet: events for relation link/unlink, and any UI for browsing events (the API is the
  interface for now).

## Background jobs and scheduled jobs (PLAN §24, added 2026-10-11)

The worker already had queue, retries, backoff, cron and dead-letter handling; this round added the
parts of §24 that were missing — progress, logs, cancellation, the job API and the admin UI:

- New migration `003_jobs.sql` (additive): `jobs.progress/message/last_error/queue_job_id/attempt/
  max_attempts/cancel_requested` plus the `job_logs` table (cascades from `jobs`).
- `JobContext` gained `progress(percent, message?)`, `log(message, level?)` and `shouldStop()`;
  `system.cleanupOutbox`, `system.pruneSessions` and `system.sendReminders` now report through them.
- The Jobs API (`apps/api/src/jobs/`) inserts a `pending` row, produces to BullMQ, and lets the
  worker adopt that row, so one submitted job stays one record while retries keep their own.
  Endpoints (admin only): `POST/GET /api/v1/Job`, `GET /Job/{id}`, `GET /Job/{id}/log`,
  `POST /Job/{id}/action/cancel`, `GET/POST /api/v1/ScheduledJob`, `POST /ScheduledJob/{id}/enable`,
  `.../disable`, `.../action/runNow`, `POST /ScheduledJob/action/preview`.
- Cancellation is cooperative: a waiting queue entry is removed, a running attempt is flagged and
  sees it through `shouldStop()`; a job cancelled before the worker woke up never runs.
- Retry/backoff settings moved to `JOB_QUEUE_NAME`, `JOB_ATTEMPTS`, `JOB_BACKOFF_BASE_MS` (`.env`),
  matching the worker's `WORKER_*` equivalents.
- Admin UI at `/admin/jobs`: job list (status, progress, attempt, message, duration), status filter,
  queue counts, run-a-job modal, cancel, log drawer with refresh, and the schedule table with save /
  enable / disable / run-now and live cron validation.
- Verification: 13 API tests (`apps/api/test/jobs.test.ts`), 12 new worker tests, 2 browser specs,
  and 8 new checks in `scripts/worker-smoke.sh` (adoption, progress, logs, cancelled-never-starts).

## Attachments and file storage (PLAN §25, added 2026-10-11)

The attachment module existed as a single-request, buffer-in-memory upload on local disk. This round
turned it into the storage layer PLAN §25 describes:

- `packages/files` now owns the port (`FileStorage`: `put/get/openRead/delete/exists/signDownloadUrl?`)
  with two drivers — local disk and S3-compatible (S3 + MinIO via `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE`).
  Both stream in and out; `put` takes a `Buffer` or a `Readable`.
- Uploads stream through `StreamProbe`, which sniffs the head, counts bytes and hashes sha256 in one
  pass. The ceiling is applied to the multipart parser per request **and** to the probe, and
  `file.truncated` is checked afterwards — that last part fixed a real hole: a body cut at the
  transport limit used to be stored as a complete file of exactly the maximum size.
- Malware scanning hook: `SignatureScanner` (EICAR, executable magic behind a benign MIME type, NUL in
  declared text, non-image served as `image/*`), `CompositeScanner` fails closed, a ClamAV scanner
  plugs in behind `MALWARE_SCANNER_TOKEN`.
- Read path enforces admin / uploader / parent-ACL per attachment, on both `GET /Attachment/:id/file`
  and `GET /Attachment/:id`; `GET /Attachment/action/info` tells the UI the driver, ceiling and scanner.
- Chunked upload for large files: `/api/v1/AttachmentUpload` init → part (any order) → complete. The
  `parts` JSONB ledger makes a retried chunk replace rather than double count, completion requires
  contiguous chunks and an exact total, and assembly replays the parts through the normal upload path.
- Abandoned reservations are cleaned by the new `system.cleanupUploads` worker job (hourly in the seed).
- Migrations: `004_file_uploads.sql` (reservations) and `005_file_upload_parts.sql` (the chunk ledger,
  additive `ALTER … ADD COLUMN IF NOT EXISTS` because `004` was already applied to the dev database).
- Not done here: no attachment UI (no file field/panel in the SPA). Parent-record permission is
  enforced — `AppModule` wires `PARENT_ACL_CHECK_TOKEN` to `AclApiService` and the record store.
- Verification: 17 new API tests (`apps/api/test/attachments-storage.test.ts`), 21 package tests
  (storage/S3/scanner), 4 worker tests, 19 new `scripts/e2e-smoke.sh` checks, 4 new
  `scripts/worker-smoke.sh` checks; totals moved to 250 vitest / 91 worker / 68 + 26 smoke checks and
  10 Playwright specs still green.

## Outbound email (PLAN §28, added 2026-10-11)

`packages/mail` was a two-line placeholder. It is now the email platform service PLAN §28 describes,
outbound side only:

- `MailTransport` port (`prepare` / `send` / `verify` + an `info` block the UI can read) with four
  implementations: `smtp` (authenticating submission mailbox), `relay` (generic SMTP relay — refuses
  credentials at boot because a relay trusts the network), `memory` (holds messages, delivers nothing)
  and `none` (default). `createMailTransport(mode, env)` selects it; SES/SendGrid/Graph stay PLAN §28
  "later" and drop behind the same token.
- Normalization is shared, not per transport: quoted display names, comma-outside-angle splitting,
  case-insensitive dedupe across to/cc/bcc, `MAIL_MAX_RECIPIENTS` ceiling, Message-Id/thread
  generation, and rejection of headers the envelope owns or whose values carry CR/LF (SMTP header
  injection). `SMTP_STRICT_FROM` (default on) refuses a From that is not the configured account.
- Pipeline: `POST /api/v1/Email/:id/action/send` validates with `transport.prepare()`, writes one
  `email_deliveries` row per recipient (`006_email_deliveries.sql`, unique on `(email_id, recipient)`),
  enqueues `system.sendEmail` as an ordinary §24 job and only then flips the record to `Queued`.
  Nothing sends from the API process. With `MAIL_TRANSPORT=none` the API answers `FEATURE_DISABLED`
  rather than queueing work that can never deliver.
- The worker (`system.sendEmail`) rebuilds the message from the record plus its §25 attachments, sends
  it, and writes the outcome per recipient: transient/4xx failures are re-thrown so BullMQ retries with
  backoff and the record returns to `Queued`; 5xx/`EENVELOPE` is final (`Failed` + `deliveryError`);
  an already-`Sent` record is a no-op, so a duplicate queue entry cannot send twice.
- `Email` is a metadata entity (`database/seed-metadata.ts`), so its ACL, audit, stream and domain
  events come from the kernel and the generic SPA renders it; the module only owns the ledger, the
  ceiling and the queue. Attachments link through the §25 attachment table (`parentType: 'Email'`).
- Credentials live in the environment, never in a table, so PLAN §28.3's "encrypted at rest" requirement
  has nothing to encrypt — recorded as a deliberate deviation rather than half-implementing a secret
  store.
- Not built: inbound collection (PLAN §28.2 IMAP/POP3/Graph/Gmail — PLAN itself defers it) and the later
  providers above. There is no email-specific UI (no compose screen, mailbox list or thread view), but
  `Email` is a metadata entity, so the generated list/detail/edit views already work for drafts and the
  send is an API action.
- Verification: 63 package unit tests with a fake sender (no socket is ever opened), 12 API tests
  (`apps/api/test/email.test.ts`), 20 worker job tests, 1 browser spec (`e2e/email.spec.ts`: draft in the
  generated form → queue → ledger → cancel), 24 new `scripts/e2e-smoke.sh` checks and 8 new
  `scripts/worker-smoke.sh` checks; every suite deletes only the records it created.

## Search, saved filters, import/export and dashboards (Phase 12, PLAN §30/§32/§33, added 2026-10-11)

`apps/api/src/search` (search, saved filter, import/export, dashboard services + controllers), wired
into `AppModule` before the generic `:entity` wildcard, and three SPA pages (`/search`,
`/dashboards`, plus the search/filter/import/export row on every record list). Migration `008`
created the tables and ownership columns, `009` corrected the search indexes.

- Every read goes through `EntityCrudService`, so entity/record/field ACL, audit, stream and dynamic
  logic apply exactly as on a normal list. Search never builds SQL itself; it composes criteria the
  Query Engine validates (PLAN §15.3).
- Global search iterates the enabled entities the caller may read, silently skipping unreadable ones
  so it cannot leak which entities exist, and caps query length, entity count and per-entity rows.
- The searched expression set is `name`, the four standard contact attributes and an exact `id`
  match — precisely the expressions that carry a trigram index. PostgreSQL can only use an index for
  a disjunction when *every* branch is indexable, so one unindexed custom key in the OR would make
  the whole search a sequential scan. Verified with `EXPLAIN` on the configured database: the OR now
  plans as `BitmapOr` over `entity_records_pkey` + the four trigram indexes. Widening coverage means
  adding the key to `SEARCH_INDEXED_ATTRS` **and** indexing it in a new migration.
- CSV import maps header names to metadata fields (unknown or non-importable columns are rejected up
  front), coerces per field type, updates by `id` when the column is present, optionally upserts on
  `name`, and returns a per-row validation report; bytes and rows are both bounded.
- CSV export pages the Query Engine (`EXPORT_PAGE_SIZE`, because one list page clamps to 500 rows) so
  a filter on a large entity exports the whole result rather than the first page, and every cell is
  guarded against spreadsheet formula injection (`= + - @` get a leading `'`, AGENTS §5.3).
- Dashlets are configuration-driven (`list`/`chart`/`kpi` with entity, saved-filter or ad-hoc where,
  `groupBy`, numeric `measure`, `count|sum|avg`) and execute through the Query Engine — no raw SQL
  from configuration (PLAN §33). An ungrouped KPI asks the engine for `total`, so it reports the real
  number on a 100k table; a grouped chart aggregates over a bounded scan and returns `truncated` +
  `scanned`, which the SPA surfaces instead of silently showing a capped bar chart.
- Not built from §32: XLSX/JSON export, field-mapping UI, import preview and background (queued)
  import for oversized files — imports are synchronous up to 2,000 rows. §33 dashlet kinds `Calendar`,
  `Stream` and `Custom`, and the §30 Stage 2 search-provider abstraction (OpenSearch/Elasticsearch),
  are also not built. Export enforces entity `read` ACL; there is no separate `export` ACL action in
  the role vocabulary yet (record- and field-level rules still apply through the list path).
- Verification: 12 API/unit tests (`apps/api/test/phase12-search-import-dashboards.test.ts`), 29 new
  `scripts/e2e-smoke.sh` checks (search by name/email/id, filter run, import/export round-trip with
  the formula guard, dashlet run and dashboard delete) and 3 browser specs
  (`e2e/search-import-dashboards.spec.ts`) covering the header-search deep link, the list search /
  saved-filter / CSV round-trip and the dashboard dashlet + delete flow.

## Extension SDK (Phase 14, PLAN §38/§39, added 2026-10-11)

`packages/extension-sdk` was a placeholder comment; it is now the contract the API and the worker
both load from, and `modules/` holds three working packages built against it (PLAN §38 acceptance:
three independent extensions without touching the core).

- **Contract** (`packages/extension-sdk`): `manifest` (strict zod schema — a typo such as
  `dependancies` fails the install), `semver` (dependency + platform windows), `resolver`
  (dependencies first, then ascending `order`, with cycles/missing/duplicate ids failing fast),
  `loader` (directory scan, metadata documents, ordered `*.sql`, dynamic backend import, paths
  resolved inside the package), `metadata` (partial-contribution validation and merge rules) and
  `host` (the loaded set, shared by both processes).
- **Host**: `loadExtensions()` runs in `bootstrap.ts` *before* `NestFactory.create` and produces an
  `ExtensionHost`, because providers, controllers and metadata precedence are fixed at container
  build time. `createExtensionHostModule()` imports `AppModule` and adds the packages' providers and
  controllers; `AppModule` exposes the host and the `EXTENSION_*` tokens (database, ACL, metadata,
  job enqueuer, principal) so a package never imports the application.
- **Metadata precedence** is now core `metadata_entries` → extensions (load order) → admin overrides
  in `app_settings`. Extension contributions merge fields/relations/layouts and concatenate index
  declarations; a contributed entity is served by the generic CRUD API, ACL, audit, stream and the
  generated SPA screens with no new code.
- **Installation** is an audited admin action (`POST /api/v1/Extension/action/install`): it checks
  dependencies and the platform window, applies the package's migrations with their own
  `extension_migrations` ledger (migration `010`, additive), records the activation row and asks for
  a restart. Uninstall is refused while a dependent is installed and never rolls SQL back.
  Packages come from `EXTENSIONS_DIR` — there is deliberately no upload endpoint.
- **Worker**: loads the same packages, registers their `jobs` and `domainEvents` before any loop
  starts and runs `setup()` during `start()`.
- **SPA**: `/admin/extensions` lists packages with their state (`available` / `installed` / `running`)
  and contributions; installed packages contribute sidebar entries through
  `GET /api/v1/Extension/frontend` (admin-only entries are filtered server-side).
- **Sample packages**: `modules/account-health-fields` (metadata only — fields, layouts, an index
  declaration and a `formula` field), `modules/webhook-integration` (provider, admin controller,
  `webhook.deliver` job, domain-event subscriber, own migration, encrypted signing secrets and an
  SSRF guard), `modules/project-domain` (a custom `Project` entity plus one derived summary endpoint
  that asks the host's ACL evaluator, and a declared dependency on the webhook package).
- **Not built**: package signing/integrity verification, an upload flow, and React components shipped
  from a package (that needs a build-time Vite plugin). Documentation: `docs/extension-sdk.md`.
- Verification: 46 SDK unit tests, 17 API integration tests covering the whole lifecycle
  (list → guard → install → restart → merge → CRUD → nav → uninstall), 5 worker tests, 6 new
  `scripts/e2e-smoke.sh` checks and 1 browser spec (`e2e/extensions.spec.ts`, not executed in this
  environment).

## Workflow engine (Phase 15, PLAN §35, added 2026-10-12)

`packages/workflow` is a pure engine — definition types, validation, trigger matching and the
executor, with every effect behind a port — and the API (`apps/api/src/workflows`) and the worker
(`apps/worker/src/workflows`) are thin wiring around it. Three sample automations can be built
entirely in the new `/admin/workflows` UI; nothing in the kernel knows they exist.

- **Triggers** are matched against the existing domain-event stream (`entity.created|updated|deleted|
  restored` plus an entity type or `*`), so automation reuses the §23.2 outbox rather than adding a
  second event mechanism.
- **Conditions** reuse the §22 sandboxed formula engine rather than inventing a second expression
  language; **actions** are a closed catalog (`updateRecord`, `createRecord`, `createNotification`,
  `sendEmail`, `runJob`) with a schema per action, so unknown keys and unknown actions are refused.
- **Delays** park a run (`waiting`) and enqueue `workflow.resume`, so a delayed automation survives a
  worker restart; **branching** is the `then`/`otherwise` pair of a condition node.
- **Versioning**: `current_version_id` is the editable draft, `published_version_id` is immutable and
  is what runs execute, and editing a published workflow forks the next version. Validation runs at
  save, at publish **and** at execution, so a hand-edited row cannot be half-run.
- **Retries are idempotent**: `workflow_run_steps` is the ledger the executor reads before acting, so
  a redelivered job resumes at the failed node instead of repeating completed ones — a notification
  is not sent twice. `system.cleanupWorkflowRuns` prunes finished runs after 30 days.
- **Execution is worker-only**; the trigger merely enqueues, so automation never slows a request.
- **Deviation**: nodes/edges live in `workflow_versions.definition` (JSONB) rather than separate
  node/edge tables, so a version is one atomic snapshot.
- Not built: schedule/cron triggers, relation-change triggers, per-workflow ACL beyond admin-only,
  manual "run now", and condition/action branching over relation queries. Documentation:
  `docs/workflows.md`.
- Verification: 42 engine unit tests, 27 worker tests, 19 API integration tests and 15 new
  `scripts/e2e-smoke.sh` checks.

## Web UI theme (Lizant)

`apps/web` follows the Lizant Ant Design admin look. Design tokens live in
`apps/web/src/theme.ts` (ConfigProvider) and the few rules antd cannot express in
`apps/web/src/styles/lizant.css`:

- primary `#438eff`, success `#55c27f`, warning `#f8ac59`, error `#fa626b`, text `#31373d`,
  secondary text `#737b85`, Inter, radius 8, no shadows.
- 70px white header (brand mark, collapse toggle, filled search field, avatar menu),
  260px white sider with uppercase `RECORDS` / `ADMINISTRATION` menu groups and an
  `#f0f8ff` active item, `#f5f5f5` canvas, 24px content padding, white bordered cards.

Field captions are derived, not authored: metadata has no per-field `label`, so
`fieldLabel()` in `apps/web/src/state/metadata.ts` uses the target entity label for link
fields (`accountId` → "Account") and otherwise humanizes the camelCase name
(`billingAddressCity` → "Billing Address City"). Relation panel titles use the same helper
(`contacts` → "Contacts").

The record list follows the Lizant `ui-table` / `app-apikey` pattern measured on 2026-10-11:
one card with 22px body padding, a title row (entity label left, actions right), a filter grid
with the label above each `operator + value` control, then the table at antd's default density
(`th` `#fafafa` 14px/600 with 16px padding, `td` 12px/16px, row border `#f0f0f0`), the display
column rendered as the record link, and right-aligned 32px pagination items with a 6px radius.


