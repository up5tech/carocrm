# Repository Audit — Customer Success (Phase 19-CS.0)

Reference date of the first working-tree audit: 16 October 2026. Re-verified in the working tree on
17 October 2026 while completing the module; every row below was re-checked against the code at that
time. This document records what the repository already offered, what was missing, and the decisions
taken. It does **not** restate the plan.

## 1. Method

- Read `AGENTS.MD`, `PLAN.md` (Phase 19), `docs/module-guide.md`, `PLAN_Phase_19_Sales.md`,
  `docs/implementation/sales-repository-audit.md`, `PLAN_Phase_19_Projects.md` and
  `docs/modules/projects/` first, as instructed.
- Every prerequisite below is marked **verified** (read in the working tree) or **rejected** (turned
  out not to exist / not to work as assumed). Plan §3's audit table was re-verified section by
  section; drift found is recorded in §6.

## 2. Module shape — how a Phase 19 domain is built (verified)

| Fact | Evidence |
|---|---|
| Phase 19 domains are kernel directories under `apps/api/src/<domain>` with a barrel exporting `<NAME>_CONTROLLERS` / `<NAME>_PROVIDERS` | `apps/api/src/projects/index.ts`, `apps/api/src/sales/index.ts` |
| The integrator registers them once in `app.module.ts`, controllers spread **before** `ENTITY_CONTROLLERS` | `apps/api/src/app.module.ts` (`...SALES_CONTROLLERS` then the comment "Generic `/api/v1/:entity` wildcard routes stay last so static routes win") |
| A module descriptor gives a stable id, version, capabilities, optional integrations and feature flags | `apps/api/src/sales/sales-module.ts` → `SALES_MODULE`, `SALES_FEATURES` |
| A health endpoint reports the descriptor against real platform state | `apps/api/src/sales/sales-module-health.service.ts`, served at `GET /api/v1/Sales/action/health` |
| Kernel domain modules have `loadOrder`; Sales uses `320` | `sales-module.ts` |
| Domain commands live under `/api/v1/<Domain>/action/*` with a PascalCase static prefix | `docs/implementation/sales-repository-audit.md` §3; no kebab-case domain route exists in the repository |
| DTO validation uses Zod `.strict()`; a shape failure returns `400 INVALID_QUERY` with an issue list; a domain rule returns `422 VALIDATION_FAILED` | `apps/api/src/sales/dto/sales-shapes.ts`, the `parse()` helper in `sales.controller.ts` |

Decision: `CustomerSuccess` is implemented as a kernel domain directory
(`apps/api/src/customer-success/`) with the barrel `CUSTOMER_SUCCESS_CONTROLLERS` /
`CUSTOMER_SUCCESS_PROVIDERS`, registered in `app.module.ts` before `ENTITY_CONTROLLERS`. **No
`manifest.json`, nothing added to `modules/`** — the extension SDK exposes no entity CRUD facade, so
a package could only write records with raw SQL, bypassing ACL, validation, audit, stream and domain
events (AGENTS.md §5.2). The module id is `CustomerSuccess` with `loadOrder: 340` (after Sales' 320).

## 3. Persistence and metadata (verified)

| Fact | Evidence |
|---|---|
| Every generic entity record lives in `entity_records` with `attrs` JSONB holding all non-physical attributes; `version` is optimistic concurrency; `deleted_at` is soft delete | `database/migrations/001_init.sql`, `apps/api/src/entity/entity.service.ts` |
| Kernel entity metadata lives in `database/seed-metadata.ts` (54 entities before this module); extension packages use `metadata/entities.json` instead | `database/seed-metadata.ts` (`scope: 'entity'` entries) |
| The physical-index pattern for a metadata attribute is a partial expression index over `entity_records ((attrs ->> 'field')) WHERE entity_type = '...' AND deleted_at IS NULL` | `docs/implementation/sales-repository-audit.md` §4; e.g. `database/migrations/031_phase19_sales_reporting.sql` |
| Index declarations in metadata are not DDL | same entries' `indexes` arrays vs. the reviewed migrations |
| `database/migrate.ts` reads `database/migrations/`, sorts by filename, skips applied rows in `schema_migrations`, applies each file in one transaction | `database/migrate.ts` |
| `032` was the next free migration number | `ls database/migrations/` → `001_init.sql` … `031_phase19_sales_reporting.sql` |

Decision: all nine Customer Success entities are registered in `database/seed-metadata.ts`
(63 entities total afterwards) and one additive migration
`database/migrations/032_phase19_customer_success.sql` creates the partial unique index on active
profile `accountId`, the playbook-run trigger-key uniqueness and the query indexes. No table is
created, dropped or rewritten.

## 4. Platform capabilities available (verified)

Entity Engine + metadata registry (`packages/entity-engine`, `apps/api/src/entity/`), ACL
(`packages/acl`, `apps/api/src/acl/acl-api.service.ts`, tables `roles`, `users_roles`,
`roles.field_permissions`), hooks with phases `beforeValidate`/`afterSave`
(`apps/api/src/hooks/`, `KERNEL_HOOKS_TOKEN`), audit log, stream and transactional outbox
(`apps/api/src/audit/`, `apps/api/src/stream/`, `apps/api/src/common/outbox.service.ts`, tables
`audit_log`, `stream_items`, `outbox_events`), domain events (`apps/api/src/events/`,
`apps/worker/src/events/domain-event-bus.ts`), jobs and scheduled jobs (`apps/api/src/jobs/`,
`apps/worker/src/queue/`, tables `jobs`, `scheduled_jobs`, `job_logs`), activities as four metadata
entities Task/Call/Meeting/Reminder/Email, calendar (`apps/api/src/calendar/`), search/saved filters/
dashboards/import-export (`apps/api/src/search/`), reports (`apps/api/src/reports/`,
`packages/reports`), attachments (`apps/api/src/attachment/`, `packages/files`), email
(`apps/api/src/email/`, `packages/mail`), the sandboxed formula engine (`packages/formula`),
workflows and BPM (`apps/api/src/workflows`, `apps/api/src/processes`), the instance settings store
(table `app_settings`, `POST /api/v1/Settings`), portal (`apps/api/src/portal/`) and i18n
(`apps/api/src/i18n/`). All were read, not assumed.

Two integration contracts matter most and were both verified by reading the code:

1. **The shared worker→API capability.** The reports jobs already call worker-authorised API
   endpoints guarded by `x-worker-secret` compared in constant time
   (`apps/api/src/reports/…`, `config.reportWorkerSecret`; the seam is exercised by
   `apps/api/test/phase17-reports.integration.test.ts`). The Customer Success jobs reuse exactly
   this pattern rather than introducing a second one.
2. **The Sales marker contract.** `apps/api/src/sales/sales-module.ts:145-148` declares the optional
   integration `{ id: "customer-success", …, markerEntity: "CustomerSuccessProfile" }`, and
   `SalesModuleHealthService` resolves it against `metadata.registry.getEntities()`. **The entity
   name `CustomerSuccessProfile` is therefore fixed**: a silent rename turns a shipped, tested
   integration permanently "unavailable".

## 5. Platform capabilities **not** available (verified absent)

| Capability | Evidence of absence | Consequence |
|---|---|---|
| No notification service | no `apps/api/src/notification`; the `notifications` table is written by a worker handler (`apps/worker/src/handlers/job-handlers.ts:132`) | §11.3: the smallest genuinely needed writer is added *inside the module* (`CustomerSuccessNotificationService`), following the same table shape; no wrapper around a non-existent service. Documented in compatibility.md |
| No Cases / Service Desk module | no `Case` entity in `seed-metadata.ts` | no support-derived health signal; the signal family is configured but reports `unavailable`, never `failed` |
| No external adoption-analytics connector | no marker entity | adapter contract only; no vendor API calls from controllers or the scorer |
| No generic `Activity` entity | Task/Call/Meeting/Reminder/Email are separate metadata entities | a touchpoint names which of the four it reads |
| No module-level toggle | nothing in the kernel can disable a kernel domain directory | optional behaviour is gated by the module's own feature flags in the `customerSuccess` settings row (§3.6 of the plan) |
| No `User`/`Team` metadata entity | `User` and `Team` are identity rows in their own tables (`users`, `teams`), managed by `apps/api/src/auth/identity.controller.ts`; `EntityCrudService.get` refuses them with "Entity does not exist" | destination validation for CSM/team/owner reads the identity tables directly, as `apps/api/src/projects/project-member.service.ts:215` already does for project members |

Two small kernel adjustments were needed and are recorded as platform changes:

1. `EVENT_TYPE` in `apps/api/src/events/event-bus.ts` accepted only lower-case segments; the module's
   event and job names are camelCase after a dot (`customerSuccess.health.statusChanged`). The
   pattern was widened to allow an upper-case letter in any segment — the same shape `JOB_NAME` in
   `apps/api/src/jobs/jobs.service.ts` already uses — and `JOB_NAME` was widened identically so the
   API and the worker accept `customerSuccess.recalculateHealthBatch`.
2. Nothing else. No new top-level directory, no second store, no parallel ACL.

## 6. Assumptions marked verified or rejected

| Assumption (from the plan's §3) | Verdict | Note |
|---|---|---|
| Phase 19 domains are kernel directories, not packages | verified | §2 above |
| Static PascalCase prefixes, `/action/*` commands, no kebab domain route | verified | `sales.controller.ts` |
| 51 entities in `seed-metadata.ts` | verified (54 at audit time, 63 with this module) | drift in the number only |
| `032` is the next free migration number | verified | `032_phase19_customer_success.sql` created |
| Kysely via `DatabaseService` is the SQL layer | verified | `apps/api/src/database/database.service.ts` |
| Sales and Projects are present and detectable through the metadata registry | verified | `Subscription` and `Project` entities exist; detection reads `metadata.registry.getEntities()` |
| The `notifications` table exists and a worker handler is the established writer | verified | `apps/worker/src/handlers/job-handlers.ts:132` |
| There is no test-database machinery in the runner | verified | `vitest.config.ts`: `include` covers `apps/api/test/**` and `packages/*/src/**`, no `globalSetup`, no `setupFiles`, `pool: 'forks'`, `singleFork: true` |
| A unit test under `apps/api/src/**` would not run | verified | outside the include globs; pure tests live in `apps/api/test/` |
| `RequestScope.isAdmin` is the documented admin bypass | verified | `apps/api/src/common/request-scope.ts` |
| EspoCRM 9.3.x is the compatibility baseline; no first-party CS extension exists | accepted as planning baseline | no upstream code, asset, translation or schema copied |

## 7. What this audit decided

1. **Entity set (finalised):** `CustomerSuccessProfile`, `CustomerSuccessHealthSnapshot`,
   `CustomerSuccessPlan`, `CustomerSuccessGoal`, `CustomerSuccessRisk`,
   `CustomerSuccessPlaybookTemplate`, `CustomerSuccessPlaybookRun`,
   `CustomerSuccessPlaybookStepRun`, `CustomerSuccessReview`. Onboarding is represented by a
   Playbook Run + Step Runs over a seeded default template (`customer-success-defaults.ts`), not by
   separate onboarding tables — the plan's conditional option K.
2. **Scoring configuration** is a versioned slice of the module's `app_settings` row named
   `customerSuccess` (the plan's option C), not a second table.
3. **Notifications** are written by a module-local writer following the `system.sendReminders`
   table shape — the smallest facility that satisfies §11.3 without inventing a platform service.
4. **The worker twin of a domain action is a new route**, not a second implementation: each
   `customerSuccess.*` job calls its own `@Public()` endpoint guarded by the existing
   `x-worker-secret` capability, running under the documented service principal.

See `docs/modules/customer-success/compatibility.md` for the observable consequences and
`docs/implementation/customer-success-completion-report.md` for the sub-phase mapping.
