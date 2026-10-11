# CRM Kernel Alpha — status report (PLAN §73)

Date: 2026-10-10. Scope agreed with the user: **CRM Kernel Alpha only** (PLAN tasks 01–16, 19–20 of §87).
Tasks 17–18 (generic React UI + Entity Manager) were completed afterwards, together with stream,
calendar and the PLAN §21–§22 dynamic logic + formula engine (see the sections at the end of this file);
email, import/export, dashboards, extension SDK, workflow, reports, BPM and portal remain
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
| Audit working | done | field-level rows in `audit_log`, `GET /api/v1/AuditLog`, secrets redacted |
| OpenAPI working | done | `GET /api/v1/OpenApi` (generated from controllers) |
| API integration tests working | done | 77 vitest tests, 6 files (`apps/api/test`) |
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
npx vitest run        # 212 tests: 153 API/integration (apps/api/test) + 59 formula unit tests; runs on the configured DATABASE_URL, no extra database
bash scripts/e2e-smoke.sh   # HTTP end-to-end checks against a booted server
bash scripts/worker-smoke.sh # 22 checks: outbox, BullMQ jobs, cron, graceful shutdown, job progress/logs/cancellation
npx playwright test    # 10 browser specs (CRUD/Entity Manager/relations/stream/calendar/dynamic logic/jobs); starts API+SPA itself
pnpm --filter @carocrm/worker test  # 87 worker tests (jobs, scheduler, outbox, reminder job, domain-event subscribers)
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


