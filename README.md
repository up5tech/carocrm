# CaroCRM

Metadata-driven CRM platform: TypeScript + NestJS + Fastify + Kysely/PostgreSQL, a clean-room
reimplementation of EspoCRM concepts (no PHP runtime, no upstream source copied).

**Current state: CRM Kernel Alpha + five Phase 19 domain modules — Projects, Sales (19-S),
Customer Success (19-CS), Service Desk (19-SD) and Marketing Automation (19-MA.0–MA.19, complete).**

_Roadmap_ — [PLAN.md](PLAN.md) for the kernel and module roadmap, plus the phase-level plans
[Projects](PLAN_Phase_19_Projects.md) · [Sales](PLAN_Phase_19_Sales.md) ·
[Customer Success](PLAN_Phase_19_Customer_Success.md) · [Service Desk](PLAN_Phase_19_ServiceDesk.md) ·
[Marketing Automation](PLAN_Phase_19_Marketing_Automation.md).

_Kernel_ — metadata engine with DB-backed overrides, generic entity/query/ACL engines, a
metadata-driven React SPA and Entity Manager, stream, calendar, dynamic logic + sandboxed formula
engine, entity lifecycle hooks, transactional-outbox domain-event bus, audit, a BullMQ worker with
progress/logs/cancellation, attachments over a pluggable storage port (streaming, S3/MinIO,
malware-scan hook, chunked upload), outbound email over a transport port (SMTP/relay, per-account
encrypted credentials, delivery ledger, `system.sendEmail`), and the kernel-owned **document
module** (`packages/document`): `{{ }}` / `{{{ }}}` / `{{#each }}` templates, block layout to text
and an optional pdfkit adapter, exposed as `DocumentTemplate` records.

_SPA look_ — the web app follows the **Carocrm** Ant Design admin theme: tokens in
`apps/web/src/theme.ts` (ConfigProvider) plus the rules antd cannot express in
`apps/web/src/styles/carocrm.css`, and a derived-field-caption helper (`fieldLabel()` in
`state/metadata.ts`). Every record list has two views: the table and a **generic Kanban board**
(`/<Entity>/board`) whose columns are the values of any enum field, available whenever the entity
has one. Dragging a card issues an ordinary `PATCH /:entity/:id`, so validation, hooks, audit,
optimistic locking and record ACL apply unchanged and the server is the authority.

_Domain modules_ — search, saved filters, CSV import/export and dashboards (Phase 12);
extension SDK plus three sample packages under `modules/` (Phase 14); workflow engine with run
history (Phase 15); BPM approvals with user tasks, timers, gateways and an audit trail (Phase 16);
reports with preview, CSV export and owner-only scheduled delivery (Phase 17); portals with their
own role space and one-hop visibility (Phase 18); i18n catalogs for `en`/`vi` (Phase 7A).

_Phase 19_ —

- **Projects** — Plan/Kanban/Gantt views, members, groups, dependencies and cloning.
- **Sales** — document engine, pricing, inventory, payments, subscriptions and commercial analytics.
- **Customer Success** — lifecycle, health scoring, plans, risks, playbooks and renewals.
- **Service Desk** — case numbering, state machine, assignment/queues/routing, conversation
  timeline, email-to-case and web-to-case, business calendars, SLA clocks, Knowledge Base, portal
  self-service, CSAT and metrics.
- **Marketing Automation** — campaign lifecycle with send-readiness validation, audience segments
  with inclusion/exclusion, preview and sealed snapshots, consent/preferences/suppression and public
  unsubscribe, email templates with render preview and revision tracking, provider binding with
  rate/concurrency limiting and an allowlist-gated test send, `MarketingSend` definitions with dry
  run and named approval, a per-recipient delivery ledger, queue-based delivery with throttling and
  retry, provider webhooks and event normalization, campaign log and statistics, journey graphs
  with enrollment/waits/conditions/actions, public lead-capture forms, cross-module CRM events,
  attribution and funnel analytics, and retention/diagnostics (Phases 19-MA.0–19-MA.19).

_Not built yet_ — real inbound mail collection (`POST /api/v1/Email/action/pollInbound` runs a null
provider until an IMAP/Graph adapter is installed), API-user attachment policies, multi-tenancy.

Marketing Automation ships all its phases, but **sending still requires operator configuration**: the
live adapter wraps the platform's `MailTransport` and is named by the `marketingAutomation` →
`provider.key` setting (empty by default), so `campaign start`/`resume` refuses with
`PROVIDER_NOT_BOUND` until a deployment binds it and allowlists test recipients. See
[docs/runbooks/marketing-send-operations.md](docs/runbooks/marketing-send-operations.md).

Checklist, deviations and known failures: [docs/reference/alpha-status.md](docs/reference/alpha-status.md).
It documents the kernel Alpha scope and the Projects module; the Sales, Customer Success, Service
Desk and Marketing Automation modules are covered instead by the audits, gap reports and release
notes under [docs/implementation/](docs/implementation/) and [docs/compatibility/](docs/compatibility/).

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

`pnpm db:seed` never creates or drops a database — it runs the SQL migrations (up to
`043_phase19_marketing_journey_runtime.sql`) and inserts idempotent configuration (admin user, roles,
teams, entity metadata, default project board, scheduled jobs) into the database you already point
at. Sign in with `admin` / `admin` (override with `SEED_ADMIN_LOGIN` / `SEED_ADMIN_PASSWORD`; an
existing admin password is never overwritten). `pnpm db:seed -- --demo` additionally creates a
`demo` / `demo123` user with no access, for ACL checks.

`.env.example` documents every variable; the ones you are most likely to touch are
`STORAGE_DRIVER`/`S3_*` (attachments), `MAIL_TRANSPORT`/`SMTP_*` (outbound mail, and the transport
Marketing Automation sends through), `ENCRYPTION_KEY` (32-byte hex key required by email-account
credentials and extension secrets), `EXTENSIONS_DIR`, `REPORT_WORKER_SECRET` (worker-driven jobs:
scheduled report delivery and AI Agent runs, including CRM Chat) and the upload ceilings. Domain modules keep their configuration in settings
(`app_settings`), not in the environment — see `GET /api/v1/MarketingAutomation/action/settings`.

## Commands

| Command                                          | Purpose                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm dev`                                       | API with reload (`http://127.0.0.1:3030`)                                         |
| `pnpm --filter @carocrm/web dev`                 | SPA dev server (`http://127.0.0.1:8080`, proxies `/api`)                          |
| `pnpm dev:all`                                   | API + SPA together                                                                |
| `pnpm --filter @carocrm/worker dev`              | background worker (outbox + jobs + cron)                                          |
| `pnpm db:migrate` / `pnpm db:seed`               | schema migrations and idempotent seed                                             |
| `pnpm demo:projects`                             | projects demo data (`pnpm demo:projects:purge` removes exactly what it created)   |
| `pnpm lint` / `pnpm lint:fix` / `pnpm typecheck` / `pnpm -r build` | quality gates                                      |
| `npx vitest run [path…]`                         | vitest suites (`apps/api/test`, `packages/*/src`) against the configured database |
| `pnpm --filter @carocrm/worker test`             | worker suites (jobs, scheduler, outbox, uploads, mail, workflows, module handlers) |
| `pnpm test:e2e` (`scripts/e2e-smoke.sh`)         | HTTP end-to-end checks; boots its own API on a scratch port                       |
| `npx playwright test`                            | browser tests in `e2e/` (boots its own API + SPA)                                 |
| `bash scripts/worker-smoke.sh`                   | worker checks against the real Postgres + Redis, without the API                  |
| `docker compose up postgres redis`               | local infrastructure                                                              |

Test suites, smoke scripts and Playwright all run against the configured `DATABASE_URL` and tag
what they create with a run marker — see [AGENTS.MD](AGENTS.MD) §3 for the database rules that
govern them.

## Layout

```
apps/api        NestJS + Fastify REST API (/api/v1); one folder per module
                (entity, metadata, acl, auth, attachment, email, document, marketing-automation,
                projects, sales, customer-success, service-desk, portal, workflows, processes, …)
apps/worker     BullMQ worker, outbox poller, cron scheduler, per-module handlers
apps/web        metadata-driven React SPA
packages/       core, metadata, entity-engine, query-engine, acl, files, jobs, extension-sdk,
                workflow, bpm, formula, document, mail, search, reports (+ reserved api-client,
                test-kit, ui-schema placeholders)
modules/        sample extension packages (field package, integration, CRM domain module)
database/       SQL migrations, migration runner, seed data + entity metadata
i18n/           translation catalogs per locale (`en`, `vi`), loaded by the API at boot
e2e/            Playwright browser specs, one per feature area
docs/           module guide, workflows, bpm, extension SDK
  modules/      per-module guides (projects, sales, customer-success, service-desk, document)
  marketing-automation/  campaign lifecycle, consent, templates, provider adapters, sends,
                         cross-module integration
  reference/    alpha status and EspoCRM compatibility matrix
  compatibility/         per-module behaviour comparison (service-desk, marketing-automation)
  implementation/        audits, gap and release reports
  integrations/          cross-module contracts (sales)
  operations/  runbooks/  backup-restore, marketing send operations
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

Documents (kernel module):

- `GET|POST /api/v1/DocumentTemplate`, `PATCH /api/v1/DocumentTemplate/:id`
- `GET /api/v1/document/defaultTemplate?entityType=`, `POST /api/v1/document/action/preview`
  (administrator only) — see [docs/modules/document/](docs/modules/document/README.md)

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

Projects (records are ordinary entities, these are the domain commands):

- `GET /api/v1/Project/:id/action/(capabilities|plan|board|gantt|stages|members)`
- `POST /api/v1/Project/:id/action/(members|memberUpdate|memberRemove|memberBulk|groupCreate|groupUpdate|groupRemove|groupReorder|taskReorder|taskCreate|milestone|settings|clone)`
- `POST /api/v1/ProjectTask/action/bulk`,
  `POST /api/v1/ProjectTask/:id/action/(update|move|transition|dependencyUpdate|dependencyRemove|collaboratorAdd|collaboratorRemove)`,
  `GET|POST /api/v1/ProjectTask/:id/action/dependencies`, `GET /api/v1/ProjectTask/:id/action/collaborators`

Domain modules (Sales, Customer Success, Service Desk) — records are ordinary entities, these are
the domain commands:

- Sales: `/api/v1/Sales/action/*` (documents, pricing, inventory, payments, subscriptions, reports,
  dashlets, job monitoring) plus `/api/v1/:entity` records (`Product`, `Quote`, `Invoice`, …); see
  [docs/modules/sales/](docs/modules/sales/README.md)
- Customer Success: `/api/v1/CustomerSuccess/action/*` plus `CustomerSuccessProfile` and related records;
  see [docs/modules/customer-success/](docs/modules/customer-success/README.md)
- Service Desk: `/api/v1/ServiceDesk/action/*` plus the `Case` entity and configuration records;
  see [docs/modules/service-desk/](docs/modules/service-desk/README.md)

Marketing Automation (`/api/v1/MarketingAutomation`, see
[docs/marketing-automation/](docs/marketing-automation/integration.md)):

- module: `action/health`, `GET|POST action/settings`, `action/nav`, `POST action/globalSendPause`,
  `GET action/diagnostics`
- campaigns: `POST action/campaign/:id/(validate|transition|schedule|unschedule|start|pause|resume|complete|cancel|archive|duplicateAsDraft|previewContent|contentRevision)`, `GET action/campaign/:id/(capabilities|history|log|stats|contentRevisions)`
- audience: `GET|POST action/segment/:id/members`, `POST action/segment/:id/(members/remove|refresh)`,
  `GET action/campaign/:id/audiencePreview`, `POST action/campaign/:id/audienceSnapshot`,
  `GET action/snapshot/:id/entries`
- sends: `GET|POST action/campaign/:id/sends`, `GET action/send/:id(/history|/recipients)`,
  `POST action/send/:id/(dryRun|validate|approve|revokeApproval|transition|schedule|queue|pause|resume|cancel|complete)`
- delivery: `POST action/delivery/run-scheduled-batch` (driven by the worker job
  `marketing.deliveryBatch`), `POST action/campaign/:id/sendTest` (allowlist-gated)
- consent & suppression: `POST action/consent`, `GET action/consent/:id(/history)`, `POST action/suppression`,
  `GET action/suppression`, `POST action/suppression/:id/revoke`, `POST action/publicLink`
- journeys: `POST action/journey/:id/(validate|publish|enroll|trigger)`, `POST action/journey/run-batch`
  (worker job `marketing.journeyRunBatch`), `POST action/enrollment/:id/(suspend|resume|exit)`
- analytics: `GET action/campaign/:id/(attribution|funnel)`, `POST action/attribution`,
  `POST action/retention/dryRun`
- cross-module: `POST action/crossModuleEvent`, `POST action/portal/preferences`
- public, token-authenticated rather than session-authenticated:
  `GET public/preferences/:token`, `GET|POST public/unsubscribe/:token`, `POST public/confirm/:token`,
  `GET public/click`, `GET public/open`, `POST public/form/submit`
- provider webhooks: `POST webhook/:providerKey` and `POST webhooks/:providerKey`

Extensions and operations:

- `GET /api/v1/Extension`, `GET /api/v1/Extension/frontend` (any signed-in user),
  `GET /api/v1/Extension/:id`, `POST /api/v1/Extension/action/install`,
  `POST /api/v1/Extension/:id/action/(uninstall|enable|disable)` (admin) — see
  [docs/extension-sdk.md](docs/extension-sdk.md)
- `GET /api/v1/OpenApi`, `GET /health/live`, `GET /health/ready`

Auth: `Authorization: Bearer <jwt>`, `Authorization: ApiKey <keyId>:<secret>`, or the
`CRM-SESSION` cookie (unsafe methods then require `x-csrf-token` matching the `CRM-CSRF` cookie).
Every module route is authenticated and ACL-checked server-side; see
[docs/module-guide.md](docs/module-guide.md) for the runtime rules and
[docs/runbooks/](docs/runbooks/marketing-send-operations.md) for the operational runbooks.

## Documentation

| Document                                                                         | Contents                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [docs/module-guide.md](docs/module-guide.md)                                     | read before writing code: runtime rules (explicit `@Inject()` tokens under `tsx`, ESM, strict TS) |
| [docs/workflows.md](docs/workflows.md)                                           | workflow engine, authoring, execution, run history                                                |
| [docs/bpm.md](docs/bpm.md)                                                       | BPM processes, user tasks, gateways, timers, audit trail                                          |
| [docs/extension-sdk.md](docs/extension-sdk.md)                                   | manifest, contributed metadata/providers/jobs/migrations, SPA entries                             |
| [docs/modules/document/](docs/modules/document/README.md)                       | kernel document module: templates, layout, PDF adapter                                             |
| [docs/modules/projects/](docs/modules/projects/README.md)                        | Projects: data model, permissions, API, compatibility                                             |
| [docs/modules/sales/](docs/modules/sales/README.md)                             | Sales: document engine, pricing, inventory, payments, subscriptions                                |
| [docs/modules/customer-success/](docs/modules/customer-success/README.md)        | Customer Success: lifecycle, health scoring, plans, risks, playbooks, renewals                      |
| [docs/modules/service-desk/](docs/modules/service-desk/README.md)                | Service Desk: cases, state machine, assignment, conversation, SLA                                 |
| [docs/marketing-automation/](docs/marketing-automation/campaign-lifecycle.md)     | MA: campaign lifecycle, consent/suppression, templates, provider adapters, send definitions, journey runtime, metrics, security and privacy, cross-module integration |
| [docs/runbooks/marketing-send-operations.md](docs/runbooks/marketing-send-operations.md) | operating MA sending: provider binding, limits, test send, error kinds                    |
| [docs/runbooks/marketing-provider-incidents.md](docs/runbooks/marketing-provider-incidents.md) | MA provider incidents: credentials, webhooks, bounce spikes, stalled queues, safe resume |
| [docs/implementation/](docs/implementation/service-desk-release.md)               | per-module audits, gap reports and release notes                                                  |
| [docs/reference/alpha-status.md](docs/reference/alpha-status.md)                 | kernel Alpha + Projects checklist, deviations, verification actually run, web theme, Kanban board |
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