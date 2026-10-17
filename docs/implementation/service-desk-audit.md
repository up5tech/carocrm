# Repository Audit — Service Desk (Phase 19-SD.0)

Audit reference date: 17 October 2026. Every prerequisite below was **read in the working tree** at
that time, not inferred from a plan. The document records what the repository already offered, what
was missing, and the decisions taken for 19-SD.1 – 19-SD.3. It does not restate the plan.

## 1. Method

- Read `AGENTS.MD`, `PLAN.md` (Phase 19), `PLAN_Phase_19_ServiceDesk.md`, `docs/module-guide.md`,
  `docs/implementation/customer-success-repository-audit.md`, `docs/modules/projects/` and
  `docs/modules/sales/` first, as instructed.
- Checked specifically for a pre-existing canonical Case/ticket entity, an existing mail-to-case
  capability, an internal Stream, attachments, a portal case scope and a Knowledge Base.
- Inspected every test command and its setup/teardown for database creation or reset.

## 2. Module shape — how a Phase 19 domain is built (verified)

| Fact | Evidence |
|---|---|
| Phase 19 domains are kernel directories under `apps/api/src/<domain>` with a barrel exporting `<NAME>_CONTROLLERS` / `<NAME>_PROVIDERS` | `apps/api/src/projects/index.ts`, `apps/api/src/sales/index.ts`, `apps/api/src/customer-success/index.ts` |
| The integrator registers them once in `app.module.ts`, controllers spread **before** `ENTITY_CONTROLLERS` so a static prefix beats the generic `:entity` wildcard | `apps/api/src/app.module.ts` |
| A module descriptor gives a stable id, version, `loadOrder`, capabilities, optional integrations and feature flags | `apps/api/src/sales/sales-module.ts`, `apps/api/src/customer-success/customer-success-module.ts` |
| A health endpoint reports the descriptor against real platform state (entities, tables, columns, hook phases, sequences) | `apps/api/src/customer-success/customer-success-module-health.service.ts`, `sales-module-health.service.ts` |
| Domain commands live under `/api/v1/<Domain>/action/*` | every Phase 19 controller |
| DTO validation uses Zod `.strict()`; a shape failure is `400 INVALID_QUERY`, a domain-rule failure is `422 VALIDATION_FAILED` | `apps/api/src/sales/dto/sales-shapes.ts`, shared `parse()` helpers |

Decision: `ServiceDesk` is a kernel domain directory (`apps/api/src/service-desk/`) with the barrel
`SERVICE_DESK_CONTROLLERS` / `SERVICE_DESK_PROVIDERS`, registered in `app.module.ts` before
`ENTITY_CONTROLLERS`. No `manifest.json`, nothing added to `modules/` or under an extension package:
the extension SDK exposes no entity CRUD facade, so a package could only write records with raw SQL,
bypassing ACL, validation, audit, stream and domain events (AGENTS.md §5.2).

## 3. The canonical Case entity decision

| Fact | Evidence |
|---|---|
| **No** canonical Case/ticket entity existed | `git show HEAD:database/seed-metadata.ts` has no `Case` entity; no migration references `entity_type = 'Case'` |
| Customer Success already declares an optional `service-desk` integration whose marker is the entity `Case` | `apps/api/src/customer-success/customer-success-module.ts` (`markerEntity: "Case"`) |
| The `Email` entity's display field *is* its subject | `database/seed-metadata.ts` (`Email` entity, `record.displayField: 'name'`) |
| `Account` and `Contact` already expose one-to-many relations to records that reference them, resolved through `mappedBy` | `apps/api/src/entity/entity.service.ts` `attrMatchFor` resolves `mappedBy: 'account'` → the `accountId` link field |

Decision: register **one** canonical `Case` entity in `database/seed-metadata.ts`. There is no
parallel `ServiceDeskCase`. Registering `Case` flips the Customer Success `service-desk` optional
integration to `available` with no change to Customer Success code — the marker detection is exactly
the mechanism §12.8 of that plan anticipated. `Case.name` is the case **subject** (label "Subject"),
mirroring `Email`, so lists, search and stream posts read what an agent recognises without a second
field. `Account.relations.cases` and `Contact.relations.cases` are added so a customer's cases are
reachable from the record they belong to.

## 4. Persistence and metadata (verified)

| Fact | Evidence |
|---|---|
| Every generic entity record lives in `entity_records` with all non-physical attributes in JSONB `attrs`; `version` is optimistic concurrency; `deleted_at` is soft delete | `database/migrations/001_init.sql`, `apps/api/src/entity/entity-record.store.ts` |
| `modifiedAt`, `assignedUserId`, `createdById` are **physical columns**, not `attrs` values | `entity-record.store.ts` (`PHYSICAL_KEYS`) — so a recency/assignee index uses the column, not `attrs ->> …` |
| The physical-index pattern for a metadata attribute is a partial expression index over `entity_records ((attrs ->> 'field')) WHERE entity_type = '…' AND deleted_at IS NULL` | `database/migrations/018_phase19_projects.sql`, `032_phase19_customer_success.sql` |
| Index declarations in metadata are **not** DDL | the `indexes` arrays vs. the reviewed migrations |
| `database/migrate.ts` sorts `database/migrations/*.sql`, skips applied rows in `schema_migrations`, applies each file in one transaction | `database/migrate.ts` |
| `033` was the next free migration number | `ls database/migrations/` → `001_init.sql` … `032_phase19_customer_success.sql` |
| A Postgres sequence is already the repository's own advice for atomic identifiers where a gapless ledger is not required | `PLAN_Phase_19_ServiceDesk.md` §5.1 ("use a sequence or a transaction-safe allocation service") |

Decision: one additive migration, `database/migrations/033_phase19_service_desk.sql`, creates the
sequence `service_desk_case_number_seq`, a partial unique index on the stored case number, and the
query indexes (status+recency, assignee+status, account, contact). No table is created, dropped,
truncated or rewritten; every statement is `IF NOT EXISTS` and the file is safe to run once through
the official runner. Entity metadata and the DDL agree: the metadata `indexes` array names match the
migration's index names.

**Deliberately deferred tables.** The plan lists queues, routing, SLA policy versions, SLA clocks,
business calendars and mail-idempotency mappings (§5.5 – §5.8, §7.4). None is created here: their
behaviour arrives in later sub-phases (queues in 19-SD.5, email-to-case idempotency in 19-SD.7, SLA
in 19-SD.8, calendars with SLA), and a table with no reader is speculative schema. SD.1 – SD.3
deliver the case entity and its numbering; the deferred tables are added by the migration of the
sub-phase that first reads them.

## 5. Reuse decisions (§7.1)

| Capability | Reuse or build | Evidence |
|---|---|---|
| Entity Engine CRUD, validation, field ACL, audit, stream, search, export, import | **Reuse** — `Case` is an ordinary metadata entity | `apps/api/src/entity/`, `packages/entity-engine` |
| Record/field ACL | **Reuse** — permissions declared in entity metadata and evaluated by `AclApiService` | `apps/api/src/acl/acl-api.service.ts`, `database/seed-metadata.ts` |
| Hook phases for numbering and the write guard | **Reuse** — one `beforeValidate` handler registered through `HookRegistry` | `apps/api/src/hooks/hook.registry.ts`, `packages/entity-engine/src/types/index.ts` |
| Settings document | **Reuse** — a validated `serviceDesk` row in the existing `app_settings` store | `apps/api/src/sales/sales-settings.service.ts` pattern |
| Instance numbering | **Build the smallest thing** — a Postgres sequence, not a new ledger table | §4 above |
| Stream, attachments, activities | **Reuse** — activity links use the generic `entity_links` relations (`emails`/`calls`/`meetings`/`tasks`); attachments use the `parentType: 'Case'` column | `database/seed-metadata.ts` (`emailRelations`), `apps/api/src/attachment/` |
| Portal / Email / Knowledge Base | **Not built in these sub-phases.** `Email` is a registered entity (so email-to-case is reportable as available-for-later), but there is no `Portal` or `KnowledgeArticle` entity and no portal case scope — both are reported honestly as unavailable optional integrations | `database/seed-metadata.ts`; `GET /api/v1/ServiceDesk/action/health` |

## 6. Naming (verified)

The module id is `ServiceDesk`, the API prefix is `/api/v1/ServiceDesk`, the directory is
`apps/api/src/service-desk`, and the settings row is `serviceDesk`. There is no `Ua` prefix and no
`Sd` alias. Naming across manifest, controller tags, routes, health output and documentation follows
the `ServiceDesk` / `service-desk` convention of the other Phase 19 modules.

## 7. Safe test path (verified)

| Fact | Evidence |
|---|---|
| The integration runner boots `AppModule` against the configured primary database, running migrations and the seed first | `apps/api/test/support/boot-api.ts` |
| No test script creates, resets, truncates or drops a database, schema or container | `vitest.config.ts` (`globalSetup: []`), `boot-api.ts` |
| Test records carry a unique `AGENT_TEST_<runId>` marker and are removed by exact id | `apps/api/test/customer-success.test.ts` pattern |

Decision: `apps/api/test/service-desk.test.ts` (API/integration) and
`apps/api/test/service-desk-domain.test.ts` (pure helpers) run against the existing configured
database, create only marked records, and clean up by exact id. The number sequence is intentionally
not reclaimed — gaps are normal for a ticket sequence and the consumed values are not this run's data
to recover.

## 8. Implementation sequence and status

| Sub-phase | Deliverable | Status |
|---|---|---|
| 19-SD.0 | this audit + the canonical Case decision | done |
| 19-SD.1 | module scaffold (`service-desk/` barrel, descriptor, controller, health), registration in `app.module.ts`, metadata, module smoke test, docs stub | done |
| 19-SD.2 | additive migration `033`, defaults in metadata, settings document, no extra test database | done |
| 19-SD.3 | `Case` metadata, sequence-backed numbering, `beforeValidate` write guard, CRUD/list/search via the generic API, ACL and audit (reused) | done |
| 19-SD.4+ | state machine, queues, email-to-case, SLA, portal, KB, CSAT, UI | not started |
