# CaroCRM

Metadata-driven CRM platform: TypeScript + NestJS + Fastify + Kysely/PostgreSQL, a clean-room
reimplementation of EspoCRM concepts (no PHP runtime, no upstream source copied).
Roadmap: [PLAN.md](PLAN.md); Phase 19 detail: [PLAN_Phase_19_Projects.md](PLAN_Phase_19_Projects.md).

**Current state: CRM Kernel Alpha + domain modules (through Phase 19, including Sales 19-S, Customer Success 19-CS and Service Desk 19-SD).**

_Kernel_ — metadata engine with DB-backed overrides, generic entity/query/ACL engines, a
metadata-driven React SPA and Entity Manager, stream, calendar, dynamic logic + sandboxed formula
engine, entity lifecycle hooks, transactional-outbox domain-event bus, audit, a BullMQ worker with
progress/logs/cancellation, attachments over a pluggable storage port (streaming, S3/MinIO,
malware-scan hook, chunked upload), outbound email over a transport port (SMTP/relay, per-account
encrypted credentials, delivery ledger, `system.sendEmail`).

_Domain modules_ — search, saved filters, CSV import/export and dashboards (Phase 12);
extension SDK plus three sample packages under `modules/` (Phase 14); workflow engine with run
history (Phase 15); BPM approvals with user tasks, timers, gateways and an audit trail (Phase 16);
reports with preview, CSV export and owner-only scheduled delivery (Phase 17); portals with their
own role space and one-hop visibility (Phase 18); projects with Plan/Kanban/Gantt views, members,
dependencies and cloning (Phase 19); sales pack with the document engine, pricing, inventory, payments,
subscriptions and commercial analytics (Phase 19-S); customer success with lifecycle, health scoring,
plans, risks, playbooks and renewals (Phase 19-CS); service desk with case numbering, state machine,
assignment/queues/routing, conversation timeline, email-to-case, business calendars and SLA clocks
(Phase 19-SD); i18n catalogs for `en`/`vi` (Phase 7A).
Not built yet: real inbound mail collection (`POST /api/v1/Email/action/pollInbound` runs a null
provider until an IMAP/Graph adapter is installed), API-user attachment policies, multi-tenancy.
Full checklist, deviations and known failures: [docs/reference/alpha-status.md](docs/reference/alpha-status.md).
## Requirements

- Node.js >= 22 (tested on 24) and pnpm >= 9
- PostgreSQL reachable via `DATABASE_URL`
- Redis reachable via `REDIS_URL` (worker/queues only)

## Quick start

```bash
cp .env.example .env          # then set at least JWT_SECRET and DATABASE_URL
docker compose up -d postgres redis
pnpm install
pnpm db:seed                  # applies migrations + idempotent seed to DATABASE_URL
pnpm dev:all                  # API on http://127.0.0.1:3030, SPA on http://127.0.0.1:8080
pnpm --filter @carocrm/worker dev   # outbox poller, BullMQ worker, cron scheduler
```

`pnpm db:seed` never creates or drops a database — it runs the SQL migrations and inserts
idempotent configuration (admin user, roles, teams, entity metadata, default project board,
scheduled jobs) into the database you already point at. Sign in with `admin` / `admin`
(override with `SEED_ADMIN_LOGIN` / `SEED_ADMIN_PASSWORD`; an existing admin password is never
overwritten). `pnpm db:seed -- --demo` additionally creates a `demo` / `demo123` user with no
access, for ACL checks.

`.env.example` documents every variable; the ones you are most likely to touch are
`STORAGE_DRIVER`/`S3_*` (attachments), `MAIL_TRANSPORT`/`SMTP_*` (outbound mail),
`ENCRYPTION_KEY` (32-byte hex key required by email-account credentials and extension secrets),
`EXTENSIONS_DIR`, `REPORT_WORKER_SECRET` (scheduled report delivery) and the upload ceilings.

## Commands

| Command                                          | Purpose                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm dev`                                       | API with reload (`http://127.0.0.1:3030`)                                         |
| `pnpm --filter @carocrm/web dev`                 | SPA dev server (`http://127.0.0.1:8080`, proxies `/api`)                          |
| `pnpm dev:all`                                   | API + SPA together                                                                |
| `pnpm --filter @carocrm/worker dev`              | background worker (outbox + jobs + cron)                                          |
| `pnpm db:migrate` / `pnpm db:seed`               | schema migrations and idempotent seed                                             |
| `pnpm lint` / `pnpm typecheck` / `pnpm -r build` | quality gates                                                                     |
| `npx vitest run [path…]`                         | vitest suites (`apps/api/test`, `packages/*/src`) against the configured database |
| `pnpm --filter @carocrm/worker test`             | worker suites (jobs, scheduler, outbox, uploads, mail, workflows)                 |
| `pnpm test:e2e` (`scripts/e2e-smoke.sh`)         | HTTP end-to-end checks; boots its own API on a scratch port                       |
| `npx playwright test`                            | browser tests in `e2e/` (boots its own API + SPA)                                 |
| `bash scripts/worker-smoke.sh`                   | worker checks against the real Postgres + Redis, without the API                  |
| `docker compose up postgres redis`               | local infrastructure                                                              |

Test suites, smoke scripts and Playwright all run against the configured `DATABASE_URL` and tag
what they create with a run marker — see [AGENTS.MD](AGENTS.MD) §3 for the database rules that
govern them.

## Layout

```
apps/api        NestJS + Fastify REST API (/api/v1)
apps/worker     BullMQ worker, outbox poller, cron scheduler
apps/web        metadata-driven React SPA
packages/       core, metadata, entity-engine, query-engine, acl, files, jobs, extension-sdk,
                workflow, bpm, formula, mail, search, reports (+ reserved api-client, test-kit,
                ui-schema placeholders)
modules/        sample extension packages (field package, integration, CRM domain module)
database/       SQL migrations, migration runner, seed data + entity metadata
i18n/           translation catalogs per locale (`en`, `vi`), loaded by the API at boot
e2e/            Playwright browser specs, one per feature area
docs/           module guide, workflows, bpm, extension SDK, module docs, reference, operations
```

## API surface (Alpha)

Authentication and identity:

- `POST /api/v1/Authentication`, `/Refresh`, `/Logout`, `GET /api/v1/AppUser/me` (`PATCH` too)
- `GET|POST /api/v1/User`, `GET|PATCH|PUT|DELETE /api/v1/User/:id`, `POST /api/v1/ApiUser`,
  `GET /api/v1/ApiKey/:apiUserId`, `DELETE /api/v1/ApiKey/:keyId`
- `GET /api/v1/Role[/:id]`, `POST /api/v1/Role`, `PATCH|PUT /api/v1/Role/:id`, `GET /api/v1/Team[/:id]`

Metadata and generic records:

- `GET /api/v1/Metadata`, `GET|POST /api/v1/Metadata/:entity`, `DELETE /api/v1/Metadata/:entity/Field/:field`
- `GET|POST /api/v1/:entity`, `GET|PUT|PATCH|DELETE /api/v1/:entity/:id`
- `POST /api/v1/:entity/:id/restore`, `POST /api/v1/:entity/action/massUpdate|massDelete`
- `GET|PUT|DELETE /api/v1/:entity/:id/:relation[/:relatedId]`
- `POST|GET /api/v1/:entity/action/export`, `POST /api/v1/:entity/action/import`,
  `GET /api/v1/:entity/action/exportColumns`
- `GET /api/v1/I18n?locale=` (public catalog + instance locale/timezone settings),
  `POST /api/v1/Formula/validate|evaluate`, `GET /api/v1/Hook`, `GET /api/v1/DomainEvent`

Collaboration and activity:

- `GET /api/v1/Stream`, `GET /api/v1/:entityType/:entityId/stream`,
  `GET|PUT|DELETE /api/v1/:entityType/:entityId/subscription`, `POST|DELETE /api/v1/Note[/:id]`
- `GET /api/v1/Notification`, `POST /api/v1/Notification/Read-all`, `POST /api/v1/Notification/:id/Read`
- `GET /api/v1/Calendar`, `GET /api/v1/AuditLog[/:id]`

Attachments:

- `POST /api/v1/Attachment/upload`, `GET /api/v1/Attachment/:id`, `GET /api/v1/Attachment/:id/file`,
  `GET /api/v1/Attachment/:id/url` (object storage only), `DELETE /api/v1/Attachment/:id`,
  `GET /api/v1/Attachment/action/info`
- `POST /api/v1/AttachmentUpload/init`, `POST /api/v1/AttachmentUpload/:id/part`,
  `GET /api/v1/AttachmentUpload/:id`, `POST /api/v1/AttachmentUpload/:id/complete|abort`

Email:

- drafts are ordinary `POST|GET|PUT|PATCH|DELETE /api/v1/Email` records; delivery is queued
  `GET /api/v1/Email/action/transport`, `POST /api/v1/Email/action/verify`,
  `POST /api/v1/Email/action/pollInbound` (null provider today), `POST /api/v1/Email/:id/action/send`,
  `GET /api/v1/Email/:id/deliveries`
- `GET|POST /api/v1/EmailAccount`, `GET|PATCH|DELETE /api/v1/EmailAccount/:id`,
  `POST /api/v1/EmailAccount/:id/action/verify`

Search, filters and dashboards:

- `GET /api/v1/Search`, `GET|POST /api/v1/Search/:entity`
- `GET|POST /api/v1/SavedFilter`, `GET|PATCH|DELETE /api/v1/SavedFilter/:id`, `POST /api/v1/SavedFilter/:id/action/run`
- `GET|POST /api/v1/Dashboard`, `GET|PATCH|DELETE /api/v1/Dashboard/:id`, dashlet routes under
  `/api/v1/Dashboard/:id/dashlets[/:dashletId]` including `action/run`

Jobs and scheduling:

- `GET|POST /api/v1/Job`, `GET|POST /api/v1/ScheduledJob`, `POST /api/v1/ScheduledJob/action/preview`,
  `POST /api/v1/ScheduledJob/:id/(enable|disable)`, `POST /api/v1/ScheduledJob/:id/action/runNow`

Reports:

- `GET|POST /api/v1/Report`, `GET|PATCH|DELETE /api/v1/Report/:id`, `POST /api/v1/Report/:id/action/run`,
  `GET /api/v1/Report/:id/action/export`, `POST /api/v1/Report/action/preview`,
  `GET|POST /api/v1/Report/:id/schedule`, `POST /api/v1/Report/:id/schedule/(enable|disable)`,
  `DELETE /api/v1/Report/:id/schedule` (delivery runs in the worker through
  `POST /api/v1/Report/action/deliver-scheduled`)

Workflows and processes:

- `GET|POST /api/v1/Workflow`, `GET|PUT|DELETE /api/v1/Workflow/:id`,
  `POST /api/v1/Workflow/action/validate`, `GET /api/v1/Workflow/action/catalog`,
  `POST /api/v1/Workflow/:id/action/(publish|enable|disable)`, `GET /api/v1/Workflow/:id/runs`,
  `GET /api/v1/WorkflowRun[/:id]`
- `GET|POST /api/v1/Process`, `GET|PUT|DELETE /api/v1/Process/:id`,
  `POST /api/v1/Process/action/validate`, `GET /api/v1/Process/action/catalog`,
  `POST /api/v1/Process/:id/action/(publish|enable|disable)`
- `GET|POST /api/v1/ProcessInstance`, `GET /api/v1/ProcessInstance/:id`, `POST /api/v1/ProcessInstance/:id/action/cancel`,
  `GET /api/v1/ProcessTask[/:id]`, `POST /api/v1/ProcessTask/:id/action/complete`

Portals:

- `GET /api/v1/Portal/me|nav|dashboard`, `POST /api/v1/Portal/dashboard/dashlets/:dashletId/action/run`
- admin-only: `GET|POST /api/v1/Portal`, `GET|PUT|PATCH|DELETE /api/v1/Portal/:id`, portal role and
  navigation/dashboard/dashlet routes under `/api/v1/Portal/:id/…`, and `GET|POST /api/v1/PortalRole`

Projects (Phase 19; records are ordinary entities, these are the domain commands):

- `GET /api/v1/Project/:id/action/(capabilities|plan|board|gantt|stages|members)`
- `POST /api/v1/Project/:id/action/(members|memberUpdate|memberRemove|memberBulk|groupCreate|groupUpdate|groupRemove|groupReorder|taskReorder|taskCreate|milestone|settings|clone)`
- `POST /api/v1/ProjectTask/action/bulk`,
  `POST /api/v1/ProjectTask/:id/action/(update|move|transition|dependencyUpdate|dependencyRemove|collaboratorAdd|collaboratorRemove)`,
  `GET|POST /api/v1/ProjectTask/:id/action/dependencies`, `GET /api/v1/ProjectTask/:id/action/collaborators`

Domain modules (Sales, Customer Success, Service Desk):

- Sales: `/api/v1/Sales/action/*` (documents, pricing, inventory, payments, subscriptions, reports,
  dashlets, job monitoring) plus the ordinary `/api/v1/:entity` records (`Product`, `Quote`, `Invoice`,
  …); see [docs/modules/sales/](docs/modules/sales/README.md)
- Customer Success: `/api/v1/CustomerSuccess/action/*` plus `CustomerSuccessProfile` and related records;
  see [docs/modules/customer-success/](docs/modules/customer-success/README.md)
- Service Desk: `/api/v1/ServiceDesk/action/*` plus the `Case` entity and configuration records;
  see [docs/modules/service-desk/](docs/modules/service-desk/README.md)

Extensions and operations:

- `GET /api/v1/Extension`, `GET /api/v1/Extension/frontend` (any signed-in user),
  `GET /api/v1/Extension/:id`, `POST /api/v1/Extension/action/install`,
  `POST /api/v1/Extension/:id/action/(uninstall|enable|disable)` (admin) — see
  [docs/extension-sdk.md](docs/extension-sdk.md)
- `GET /api/v1/OpenApi`, `GET /health/live`, `GET /health/ready`

Auth: `Authorization: Bearer <jwt>`, `Authorization: ApiKey <keyId>:<secret>`, or the
`CRM-SESSION` cookie (unsafe methods then require `x-csrf-token` matching the `CRM-CSRF` cookie).

## Documentation

| Document                                                                         | Contents                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [docs/module-guide.md](docs/module-guide.md)                                     | read before writing code: runtime rules (explicit `@Inject()` tokens under `tsx`, ESM, strict TS) |
| [docs/workflows.md](docs/workflows.md)                                           | workflow engine, authoring, execution, run history                                                |
| [docs/bpm.md](docs/bpm.md)                                                       | BPM processes, user tasks, gateways, timers, audit trail                                          |
| [docs/extension-sdk.md](docs/extension-sdk.md)                                   | manifest, contributed metadata/providers/jobs/migrations, SPA entries                             |
| [docs/modules/projects/](docs/modules/projects/README.md)                        | Projects module: data model, permissions, API, compatibility                                      |
| [docs/modules/sales/](docs/modules/sales/README.md)                             | Sales module: document engine, pricing, inventory, payments, subscriptions                        |
| [docs/modules/customer-success/](docs/modules/customer-success/README.md)        | Customer Success module: lifecycle, health scoring, plans, risks, playbooks, renewals              |
| [docs/modules/service-desk/](docs/modules/service-desk/README.md)                | Service Desk module: cases, state machine, assignment, conversation, SLA                          |
| [docs/reference/alpha-status.md](docs/reference/alpha-status.md)                 | what is built, deviations, verification actually run                                              |
| [docs/reference/compatibility-matrix.md](docs/reference/compatibility-matrix.md) | behaviour compared against the EspoCRM 9.3.x baseline                                             |
| [docs/operations/backup-restore.md](docs/operations/backup-restore.md)           | what to back up and how to restore it                                                             |

## Contributing

Read [AGENTS.MD](AGENTS.MD) first. It fixes the rules this repository is developed under:
smallest coherent change, no unrelated refactors, migrations reviewed before they are applied, and
tests that run against the configured database and only touch records they created themselves.

## Licensing

EspoCRM upstream is AGPL-3.0-or-later. This repository is a clean-room reimplementation
(PLAN §2): behavior and public API contracts were used as reference, no upstream source,
assets or translations were copied. A formal compliance review is required before distribution.
