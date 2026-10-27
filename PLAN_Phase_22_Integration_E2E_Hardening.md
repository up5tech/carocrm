# PLAN — Phase 22: Integration & E2E Hardening

> **Status:** Planned  
> **Workstream type:** Cross-cutting quality, integration, security, reliability, and release-readiness initiative — not a new business module  
> **Target platform:** Existing NestJS / TypeScript modular monolith, React SPA, PostgreSQL, established SQL/persistence layer, and existing job/queue infrastructure  
> **Canonical workstream key:** `integration-e2e-hardening`  
> **Scope baseline:** The real repository and implemented behavior at the start of Phase 22; plans alone are not proof that code exists  
> **Naming rule:** Do not introduce a `Ua` prefix, a duplicate integration module, a second test framework, or replacement business entities  
> **Primary output:** A verified capability inventory, cross-module contracts, repeatable regression suites, secure end-to-end business journeys, recovery tests, CI quality gates, and operational runbooks  
> **Database policy:** Follow `AGENTS.MD` exactly. Do not create a new database, shadow database, test schema, temporary database, or per-run/per-agent database.

---

## 0. Instructions for the Coding Agent

Read these documents and inspect the corresponding implementation before modifying anything:

1. `AGENTS.MD`.
2. `PLAN.md`.
3. Every relevant module plan that exists in the repository, including Plans for Projects, Sales, CustomerSuccess, ServiceDesk, MarketingAutomation, AIAgents, VoiceCommunications, AdvancedIntegrations, CRMChat, ESignature, Omnichannel, and LeadScore.
4. The actual NestJS module registry, API routes, DTOs, domain services, Entity Engine, metadata, ACL, event definitions, queue processors, migrations, test scripts, frontend routing, and existing CI workflows.
5. Existing implementation notes, compatibility documents, release notes, known-issue lists, and test reports.

This plan defines required outcomes. It does **not** imply every listed module, shared service, event, endpoint, or workflow is implemented. Begin with **Phase 22.0 only**. Do not start large code changes or invent missing modules before the audit produces evidence.

### 0.1 Non-negotiable rules

- This is a cross-cutting hardening workstream, not a reason to recreate CRM domain services or build another generic integration framework.
- Use the real repository as the source of truth. Verify implementation, route registration, database migrations, permissions, UI behavior, and tests. Do not infer completion from a plan file, a class name, a TODO, a placeholder endpoint, or a green build alone.
- Preserve the modular-monolith architecture unless an explicit, separate architectural decision authorizes a change.
- Keep existing naming and module boundaries. Do not add the `Ua` prefix.
- Follow the repository's selected package manager, test runner, query builder/ORM, validation library, logging system, and frontend tooling. Do not introduce competing tools merely to match examples in this document.
- Do not weaken assertions, turn off authorization, skip meaningful tests, swallow errors, or alter expected product behavior just to make CI pass.
- Every failing test must be classified as a product defect, test defect, environment/dependency issue, or intentionally unsupported capability. Record the classification and evidence.
- Do not claim a test passed unless it was executed. Include test command, environment assumptions, result, and any skipped tests in the completion report.
- **Do not create a new database, database container, schema, shadow database, test database, per-feature database, per-agent database, or per-run database.** Routine verification must use the configured existing database with narrow, identifiable test data when database writes are needed.
- Never reset, truncate, drop, recreate, or broadly clean the configured database. Never use real customer records as test fixtures. Follow all test-data and migration restrictions in `AGENTS.MD`.
- If the configured connection points to production, or the environment cannot be identified confidently, do not run broad or potentially destructive write tests. Restrict verification to safe checks and request environment clarification only when the test cannot safely proceed.
- Do not create database containers or use Testcontainers for routine tests. Do not add CI steps that provision extra databases. Do not let test setup invoke reset/seed/clean scripts until those scripts have been reviewed.
- All external effects must use fakes, stubs, recorded fixtures, local simulators, or provider sandboxes intended for testing. Never send real customer email/SMS/WhatsApp messages, initiate calls, issue a real signature request, charge/refund money, create real external records, trigger live marketing campaigns, or publish production webhooks from automated tests.
- Preserve sensitive data. Test artifacts, traces, screenshots, video recordings, HAR/network dumps, and logs must not contain secrets or unredacted CRM data.
- Do not perform broad unrelated refactors. Fix the smallest coherent set of defects, and add regression coverage for the defect.

### 0.2 Required audit labels

Each audited feature or contract must receive exactly one current assessment label:

- `Implemented and verified` — implementation exists and relevant automated or documented manual verification actually passed.
- `Implemented, insufficiently verified` — implementation exists, but evidence does not yet prove its behavior.
- `Partial` — some behavior exists; explicit gaps remain.
- `Missing` — no usable implementation was found.
- `Blocked` — cannot safely evaluate or verify due to a documented dependency/environment blocker.
- `Not applicable` — only when justified by scope and accepted by the workstream owner.

For every row, record source paths, related tests, public routes/events, data/migration evidence, ACL evidence, known gaps, owner module, and next action. Do not mark an item complete based on documentation alone.

---

## 1. Purpose and Expected Outcome

Phase 22 hardens the existing CRM so that independently implemented modules behave like one coherent product. The goal is not simply to add more tests. It is to prove that cross-module flows preserve data integrity, authorization, idempotency, auditability, user-visible correctness, and recoverability when components or providers fail.

The workstream must establish a dependable test and verification strategy for the completed or partially completed modules, including:

- Core CRM entities and the Entity Engine.
- `Portal`.
- `Projects`.
- `Sales`.
- `CustomerSuccess`.
- `ServiceDesk`.
- `MarketingAutomation`.
- `AIAgents`.
- `VoiceCommunications`.
- `AdvancedIntegrations`.
- `CRMChat`.
- `ESignature`.
- `Omnichannel`.
- `LeadScore`.
- Shared identity, ACL, metadata, attachments, activities, streams, audit, notifications, jobs, email, search, reports, workflow/BPM, storage, and provider abstractions wherever they actually exist.

### 1.1 Primary outcomes

At completion, the team must be able to:

1. State accurately which domain and platform capabilities are implemented, partially implemented, missing, blocked, or verified.
2. Describe and enforce stable module-to-module contracts rather than relying on undocumented imports or shared database assumptions.
3. Run deterministic unit, contract, integration, API E2E, browser E2E, security, failure-recovery, and selected performance checks using the repository's existing test infrastructure.
4. Verify real user journeys across modules, including identity, permissions, field mappings, status transitions, side effects, audit history, and error handling.
5. Demonstrate that webhook re-delivery, queue retries, network timeouts, duplicate events, and worker restarts do not create duplicate business effects.
6. Demonstrate that every user-initiated read, write, export, search, report, background job, and agent action enforces the right user/service identity and authorization policy.
7. Ensure the React SPA surfaces honest statuses, validation errors, partial failures, retry opportunities, and confirmation requirements.
8. Make failures diagnosable through correlation IDs, structured logs, metrics, traces, run identifiers, job identifiers, and safe operational diagnostics.
9. Add CI quality gates that are fast enough to run frequently and reliable enough to block regressions.
10. Produce a release-readiness report with explicit residual risks instead of claiming complete parity without evidence.

### 1.2 Product principles

- **Evidence over assumptions:** test implementation, not intentions in a plan.
- **End-to-end means end-to-end:** include UI, API, domain behavior, database state, jobs, events, and provider boundaries where applicable.
- **Reuse canonical owners:** a domain writes its own state through its application/domain API; other modules use contracts rather than reaching into its tables.
- **Authorization follows the user:** async work must preserve the appropriate initiating principal and the exact permissions policy for the action.
- **No duplicate side effects:** retries and replays must be safe by design.
- **Failure is a first-class path:** timeout, stale data, conflict, provider outage, denied access, and partial completion require tested outcomes.
- **No live surprises:** automatic tests must not create externally visible or irreversible effects.
- **Small, traceable fixes:** every change ties to an observed gap, a test, and acceptance evidence.
- **Production readiness is operational:** logs, backups, migrations, runbooks, restore evidence, monitoring, and support procedures matter as much as passing tests.

### 1.3 Scope boundaries

This workstream:

- Does strengthen shared platform contracts and add missing testability hooks where required.
- Does fix integration defects and missing cross-module error handling discovered during the audit.
- Does establish cross-module regression suites and CI gates.
- Does not rewrite every module, rebuild the Entity Engine, introduce a new workflow engine, or rebuild every provider connector.
- Does not require every optional connector to have live credentials. External integrations are verified with fakes/fixtures, with sandbox verification recorded separately when an account is available.
- Does not treat a module as verified merely because its individual CRUD tests pass.
- Does not substitute a green end-to-end smoke test for unit or contract testing.
- Does not require exact upstream database compatibility with EspoCRM.

---

## 2. Reference Documents and Standards

Use current primary documentation while implementing the matching sub-phase; pin relevant versions in the repository's dependency lockfile and record any compatibility constraints.

- NestJS Testing: https://docs.nestjs.com/fundamentals/testing
- Playwright Best Practices: https://playwright.dev/docs/best-practices
- OpenTelemetry Observability Primer: https://opentelemetry.io/docs/concepts/observability-primer/
- OWASP Application Security Verification Standard: https://asvs.owasp.org/
- OWASP API Security Top 10: https://owasp.org/www-project-api-security/
- PostgreSQL documentation: https://www.postgresql.org/docs/
- Node.js test runner documentation if already selected by the repository: https://nodejs.org/api/test.html

Current repository selections (verified): **Vitest** for API/integration tests (`apps/api/test/*.test.ts`) and **Playwright** for browser E2E (root `playwright.config.ts`, specs in `e2e/*.spec.ts`). Do not introduce another runner.
- Existing project architecture and compatibility references: `PLAN.md`, `AGENTS.MD`, the implemented module plans, API/OpenAPI documents, and migration history.

Do not add a testing tool because a referenced document uses it. First audit the current stack. Keep one standard approach for each test level unless a concrete compatibility or technical reason requires an exception.

---

## 3. Workstream Governance and Artifacts

Create or update the following artifacts using the repository's established documentation layout. Do not introduce duplicate documents if an equivalent already exists.

### 3.1 Required deliverables

1. `docs/quality/phase-22-capability-inventory.md` — evidence-based inventory by module and capability.
2. `docs/architecture/module-contracts.md` or the established equivalent — module ownership, APIs, events, and dependency direction.
3. `docs/quality/integration-journeys.md` — end-to-end journey definitions and success/failure paths.
4. `docs/quality/test-strategy.md` — test pyramid, commands, fixtures, isolation, coverage policy, and database safety.
5. `docs/quality/known-gaps.md` — defects and gaps discovered during the workstream, with impact and disposition.
6. `docs/quality/phase-22-test-evidence.md` — commands actually run, test counts, failures, skipped checks, evidence locations, and limitations.
7. `docs/runbooks/integration-failure-runbook.md` — safe diagnostics and recovery instructions for queues, webhooks, connectors, and agent runs. The repository already keeps runbooks in `docs/runbooks/` (advanced-integrations, esignature, marketing, lead-score); extend those and add this file rather than creating a parallel runbook location.
8. `docs/operations/release-readiness-checklist.md` — release gate and rollback/mitigation considerations, alongside the existing `docs/operations/backup-restore.md`.
9. Automated test code following existing workspace conventions.
10. CI workflow changes only where required to execute the selected gates reliably.

### 3.2 Defect tracking

Each gap or defect must include:

- Unique issue/reference ID.
- Owning module and affected contract.
- User impact and severity.
- Reproduction steps or failing assertion.
- Expected behavior and observed behavior.
- Root cause when known.
- Fix commit/change reference when available.
- Regression test path.
- Verification result.
- Remaining risk or follow-up action.

Use the project's existing issue tracker if present. Do not invent a second issue-management system solely for this phase.

### 3.3 Definition of complete

A sub-phase is complete only when:

- Its scope and evidence are documented.
- Tests are implemented for meaningful behavior and relevant failure modes.
- Tests were actually run under the allowed environment.
- New migrations, API contracts, events, and permissions were reviewed.
- Test side effects and cleanup are safe.
- The change does not introduce an unreviewed architecture dependency.
- A brief report lists passed, failed, skipped, and blocked checks.

---

## 4. Phase 22 Roadmap Overview

Implement the workstream incrementally. Each sub-phase must end with a short audit/test report and must not automatically continue into the next sub-phase if the audit exposes a high-risk architectural issue.

| Sub-phase | Name | Key output |
|---|---|---|
| 22.0 | Repository and capability audit | Evidence-based inventory; no speculative coding |
| 22.1 | Test infrastructure and safety audit | Safe commands, provider fakes, test data contract |
| 22.2 | Module ownership and dependency map | Approved boundaries, dependency direction, no accidental cycles |
| 22.3 | API and event contract catalog | Versioned request/response/event contracts |
| 22.4 | Shared identity, ACL, and tenant-context verification | Security invariants proven across sync/async paths |
| 22.5 | Persistence and migration verification | Schema state, transaction boundaries, additive migration discipline |
| 22.6 | Domain contract tests | Module adapters and owner APIs verified |
| 22.7 | Idempotency, outbox/inbox, and retry hardening | Duplicate-safe side effects and replay tests |
| 22.8 | Cross-module journey: lead to customer | LeadScore, conversion, Sales, and identity correctness |
| 22.9 | Cross-module journey: quote to signed document | Sales and ESignature; optionally payment integration |
| 22.10 | Cross-module journey: onboarding and renewal | Projects, CustomerSuccess, Sales and optional ServiceDesk |
| 22.11 | Cross-module journey: customer support | Omnichannel, VoiceCommunications, ServiceDesk, Portal and KB if present |
| 22.12 | Cross-module journey: marketing and acquisition | MarketingAutomation, LeadScore, consent, suppression and CRM attribution |
| 22.13 | Cross-module journey: AI and CRM Chat | CRMChat, AIAgents, ACL, approval, tool execution, audit |
| 22.14 | AdvancedIntegrations connector recovery | OAuth, mapping, sync, webhooks, conflicts and retry tests |
| 22.15 | Shared UI/API behavior consistency | Forms, lists, permissions, optimistic updates, errors and navigation |
| 22.16 | Browser E2E critical paths | Playwright or existing browser test runner with stable user-facing selectors |
| 22.17 | Security and privacy regression suite | BOLA/IDOR, field ACL, injection, secrets, unsafe redirects and exports |
| 22.18 | Resilience and chaos-lite tests | Timeouts, provider outages, worker restart, duplicate and out-of-order events |
| 22.19 | Data integrity and concurrency verification | Race conditions, optimistic locking, uniqueness and transactions |
| 22.20 | Performance and capacity baselines | Selected load profiles, query budgets, queue latency and UI latency |
| 22.21 | Observability and runbooks | Correlation, metrics, traces, safe diagnostics and recovery procedure |
| 22.22 | CI quality gates | Layered pipeline; stable required checks |
| 22.23 | Backup, restore, and migration rehearsal | Verified recovery using approved non-production environment and safe artifacts |
| 22.24 | Release readiness and residual risk review | Final evidence pack and go/no-go recommendation |

The numbering is a suggested Phase 22 workstream convention. If the repository already uses a different established phase numbering scheme, preserve completed phase labels and adapt filenames/IDs without renumbering historical work.

---

## 5. Phase 22.0 — Repository and Capability Audit

### Objective

Determine what actually exists, what is functional, and what needs verification before designing cross-module tests.

### Tasks

1. Read `AGENTS.MD` and the relevant parts of `PLAN.md`.
2. Inventory package/workspace structure, package manager, runtime, test runner, lint/type-check tools, build scripts, frontend build, migrations, queue, cache, storage, mail, and provider configuration.
3. Inventory every registered NestJS module and frontend route. Confirm whether its UI is reachable and its APIs are registered.
4. For each module, inspect representative create/read/update flows, validations, ACL, migrations, background tasks, emitted events, and existing tests.
5. Search for placeholder methods, TODOs, fake success responses, unimplemented endpoints, broad exception swallowing, test skips, overly permissive guards, and test scripts that delete data.
6. Review existing tests for false confidence: mocked domain behavior where the integration contract itself needs coverage, tests that only assert HTTP 200, tests that bypass guards, and tests with no assertions on persisted state.
7. Inspect database migrations and the current schema using the configured existing connection without printing credentials or modifying data.
8. Record current failures before making fixes. Do not “clean up” the baseline by changing expectations.
9. Mark each capability with the audit labels defined in Section 0.2 and include concrete evidence.
10. Produce a dependency matrix indicating `Reuse`, `Extend`, `Build`, `External prerequisite`, or `Defer` for each integration concern.

### Required module inventory

At minimum, assess the following. If a module is not present in the repository, mark it missing rather than assuming the plan's existence means implementation exists.

- CRM Core: Accounts, Contacts, Leads, Opportunities, Users, Teams, Roles, ACL, metadata, entity/query engine, relationships, Activities, Stream, Attachments, audit, notifications, search, reports, workflow/BPM, jobs, email, portal, and extension/module registration.
- `Projects`.
- `Sales`.
- `CustomerSuccess`.
- `ServiceDesk`.
- `MarketingAutomation`.
- `AIAgents`.
- `VoiceCommunications`.
- `AdvancedIntegrations`.
- `CRMChat`.
- `ESignature`.
- `Omnichannel`.
- `LeadScore`.

### Acceptance criteria

- The inventory includes source paths, migration evidence, API routes, registered frontend routes, tests, authorization implementation, and concrete status for each item.
- All dangerous test scripts are identified before any such command is run.
- No business data is modified during the audit.
- The next sub-phase is based on observed repository structure, not assumptions.

---

## 6. Phase 22.1 — Test Infrastructure and Safety Audit

### Objective

Create a reliable testing approach that follows `AGENTS.MD` and does not produce extra test databases or unsafe external effects.

### Tasks

1. List current commands for install, lint, format check, type check, unit tests, integration tests, API tests, browser E2E, build, and migration status.
2. Inspect every command/script and lifecycle hook that can affect the database, files, queue, provider accounts, or persistent Docker volumes.
3. Confirm that test setup does not create `*_test`, `test_db`, shadow databases, new database containers, new schemas, or per-run copies.
4. Remove or disable unsafe automatic reset/setup only through a reviewed, focused change; do not delete unrelated test coverage.
5. Define a test data policy using `AGENT_TEST_` prefixes or a unique `agentTestRunId` persisted on records where possible.
6. Define exact-ID cleanup and ownership tracking. Cleanup must delete only records created by that test run and only after verifying the marker and IDs.
7. Prefer transaction rollback for isolated repository tests where reliable, but do not assume it rolls back queue jobs, files, emails, webhooks, or provider effects.
8. Add a shared test helper only if it fits existing conventions, for request IDs, fake clocks, deterministic IDs, fake providers, API authentication, and test-owned record tracking.
9. Provide fake or stub implementations for external boundaries already represented by interfaces. Do not build a parallel mock framework.
10. Keep test logs sanitized. Never print database URLs, API tokens, credentials, signature headers, full customer content, or sensitive provider payloads.
11. Document which test suites are safe to run locally against the existing configured database and which require a separately authorized sandbox environment.
12. Ensure test execution can be interrupted without leaving unowned side effects. Use `finally`/teardown hooks for resources and precise test-record cleanup.

### Database safety rules

- Use the configured primary project database only as authorized by `AGENTS.MD`.
- If it is explicitly production or environment identity is unclear, do not run write-intensive tests.
- Never run `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`, broad deletes, `migrate reset`, volume deletion, or generated reset commands.
- Do not add Testcontainers or Docker Compose database services for routine tests.
- Schema migrations are application changes, not test setup. Review SQL and verify additive/non-destructive behavior before applying.
- No repeated destructive seed scripts or large fixture imports.

### Acceptance criteria

- One documented, non-destructive test command matrix exists.
- External effects are disabled by default in automated tests.
- The database configuration used by each test command is obvious without revealing secrets.
- A new developer can run safe checks without automatically provisioning another database.

---

## 7. Phase 22.2 — Module Ownership and Dependency Map

### Objective

Make ownership boundaries explicit and prevent cross-module coupling through direct table access or duplicate business logic.

### Tasks

1. Draw the actual module dependency graph from imports, NestJS module declarations, event subscribers, and service injection.
2. Separate generic platform services from domain-owned capabilities.
3. For each entity, state its canonical owner. Example: Lead is owned by CRM core; conversion orchestration may live in the canonical CRM/Lead domain or a dedicated service, but must not be duplicated by `LeadScore` and `Sales`.
4. Record public service interfaces and API/event contracts used between modules.
5. Identify circular module imports, bidirectional dependencies, private repository imports, and direct cross-domain table writes.
6. Replace direct internal coupling with the smallest stable domain service interface or event contract where justified.
7. Ensure optional integrations are feature-detected and degrade safely when a module or provider is disabled.
8. Document transactional boundaries and ownership of side effects.
9. Confirm that the shared core does not import business-specific modules.
10. Add architecture tests or static checks if the repository's existing tooling supports them without introducing a competing system.

### Desired interaction model

- Synchronous domain APIs are used when the caller needs a validated result before proceeding.
- Domain events are used for downstream notifications and non-blocking reactions.
- Queued jobs are used for slow or retryable work, external provider calls, enrichment, and bulk processing.
- A domain module remains authoritative for its records and state transitions.
- Event payloads contain stable identifiers and minimal necessary data, not unrestricted ORM entities or secrets.

### Acceptance criteria

- An updated architecture diagram and module ownership table exist.
- No newly introduced circular dependency remains without an explicit, reviewed exception.
- Cross-module writes occur through owner services/contracts.
- Optional modules can be disabled without the application failing to bootstrap unless the dependency is explicitly required.

---

## 8. Phase 22.3 — API, Event, and Schema Contract Catalog

### Objective

Make integration assumptions explicit, typed, versioned where necessary, and testable.

### Tasks

1. Inventory public API routes and internal module service contracts used across domains.
2. Inventory domain events and queue job payloads, including who publishes, who consumes, retry behavior, and deduplication key.
3. Confirm OpenAPI reflects actual DTO validation and response/error envelopes.
4. Add or update contract tests for stable API request/response shapes and required error semantics.
5. Define event schema versioning rules consistent with existing code. Prefer additive changes and tolerate unknown optional fields.
6. Ensure date/time values have an explicit timezone convention, IDs have consistent types, and monetary values remain decimal-safe.
7. Confirm error codes are stable enough for UI and retry policy. Do not expose stack traces or raw provider errors publicly.
8. Test pagination, sort/filter allowlists, invalid fields, invalid IDs, optimistic concurrency, and relation visibility consistently.
9. Test API compatibility for the frontend API client and internal module consumers.
10. Record intentional deviations and unsupported fields/features explicitly.

### Minimum contract test cases

- Required field missing.
- Invalid enum or unsupported state transition.
- Invalid/unauthorized relation ID.
- Record not found versus not permitted, following the existing disclosure policy.
- Field-level ACL removes or rejects restricted values.
- Stale version/optimistic concurrency conflict.
- Duplicate idempotency key.
- Unknown optional event field.
- Malformed webhook payload.
- Safe serialization of decimal, date, null, attachment, and relation values.

### Acceptance criteria

- Contract catalog maps each contract to producer, consumer, schema source, owner, versioning strategy, and tests.
- All critical contracts have at least one positive and one negative contract test.
- Generated OpenAPI/docs are current if generated documentation is part of the current workflow.

---

## 9. Phase 22.4 — Identity, Authorization, and Context Propagation

### Objective

Prove that synchronous APIs, background jobs, provider callbacks, and AI-agent actions do not bypass the effective security model.

### Tasks

1. Identify the authoritative user identity and request context mechanisms.
2. Test record-level, field-level, team, role, ownership, and portal scope for representative entities.
3. Confirm background jobs do not run as an unrestricted superuser by accident.
4. For user-requested async work, preserve a minimal initiating principal reference and re-evaluate the policy required at execution time.
5. For provider webhooks, use a verified integration identity and constrain the action to the authenticated provider/account/event context.
6. Prevent a portal user from using a CRM internal ID to read another Contact, Account, Case, attachment, message, or signed document.
7. Prevent chat/agents from gaining more authority than the current authenticated user. Tool calls must be authorized on the server for each operation.
8. Ensure exports, reports, global search, batch actions, relation loading, autocomplete, and background-generated files apply the same ACL expectations.
9. Add regression tests for cross-team and cross-account data leakage.
10. Review audit records to ensure actor, effective identity, target, operation, decision, and correlation/run IDs are recorded without excess sensitive payloads.

### Acceptance criteria

- A documented authorization matrix maps roles/user types to read/create/update/delete/export/execute permissions for representative high-risk entities.
- Cross-user, cross-team, and cross-account negative tests pass.
- No hidden frontend-only permission is treated as enforcement.

---

## 10. Phase 22.5 — Persistence, Transactions, and Migration Verification

### Objective

Verify that cross-module operations are atomic where possible and recoverable where distributed/external side effects make full transactions impossible.

### Tasks

1. Inventory multi-record operations and identify their required transaction boundaries.
2. Verify transaction usage for lead conversion, quote/order/invoice state changes, signature request setup, case linking, journey enrollment, conversation handoff, and agent approval execution where implemented.
3. Ensure validation runs before irreversible effects.
4. Verify foreign keys and unique constraints for relationships and deduplication keys where required by the real schema.
5. Check optimistic concurrency/version fields for records subject to concurrent edits.
6. Inspect migrations for additive changes, index needs, lock risks, backfill strategy, rollback/forward-fix plan, and compatibility with the currently deployed code.
7. Test migration status and schema expectations without recreating the database.
8. Verify the application behavior when a transaction fails midway.
9. Confirm that file/object storage writes and queue enqueues are not assumed to roll back with a database transaction. Use an existing outbox/after-commit pattern if present or introduce a narrowly scoped one only where needed.
10. Avoid speculative schema redesign. Fix only defects backed by evidence.

### Acceptance criteria

- Critical multi-record operations have documented transaction boundaries.
- Migrations have been reviewed and checked against the existing schema.
- No test or CI command resets or recreates the configured database.

---

## 11. Phase 22.6 — Domain Contract Tests

### Objective

Exercise each module's public integration contracts independently from full browser journeys.

### Tasks

1. Create a contract-test matrix for every producer/consumer pair discovered in Phase 22.0.
2. Use the existing test runner and dependency injection facilities to substitute only external boundaries, not the domain behavior being tested.
3. Keep tests at the public service/API/event boundary; do not assert private method names or incidental table/query-builder details unless the repository explicitly treats them as contracts.
4. Verify permission checks and error envelopes at the boundary.
5. Verify domain event payloads reflect committed state and cannot be emitted before a failed transaction is known to have rolled back.
6. Verify consumer behavior for unknown optional fields and event versions according to the defined contract.
7. Verify provider adapter conformance using a shared provider contract suite where adapters implement the same interface.
8. Verify external ID mappings and field mapping validation for AdvancedIntegrations.
9. Verify the LeadScore conversion contract creates/links the requested Contact/Account correctly without duplicating records.
10. Verify `ESignature` and Sales contracts can be exercised using fake DocuSign/payment adapters.

### Acceptance criteria

- Contract tests cover every critical cross-module edge and are deterministic.
- Fake providers simulate success, validation failures, timeout, rate-limit response, authentication expiry, and retry-safe event delivery.

---

## 12. Phase 22.7 — Idempotency, Outbox/Inbox, and Retry Hardening

### Objective

Prove repeated processing cannot silently create duplicate or contradictory business effects.

### Tasks

1. Inventory webhook handlers, queue consumers, scheduled jobs, integration syncs, agent tool executions, conversation messages, campaigns, signature envelopes, call/message status callbacks, and conversion commands.
2. Record the idempotency key and uniqueness rule for each high-risk operation.
3. Verify that repeated delivery of the same event returns a safe acknowledgement and does not duplicate state transitions, record creation, or notifications.
4. Verify out-of-order events cannot move a state machine backward without explicit provider semantics.
5. Ensure retry policy is bounded, jittered where appropriate, observable, and restricted to retryable errors.
6. Confirm dead-letter or failed-job handling exists where required and is operable without manually editing database rows.
7. Verify deduplication records have an appropriate retention policy; they must not be deleted before duplicate delivery is no longer plausible.
8. For external APIs with ambiguous timeouts, query/reconcile state or use provider idempotency support before retrying a potentially duplicating operation.
9. For bulk operations, store per-item outcome so that retries can resume incomplete items without redoing successful ones.
10. Where the current architecture lacks durable event publishing, evaluate transactional outbox/inbox patterns. Add one only after documenting the gap and fitting the existing persistence/job system.

### Required scenarios

- Same webhook delivered at least twice.
- Same job retried after the operation committed but before acknowledgement.
- Worker stops after provider success but before local status update.
- Provider returns timeout after potentially accepting a request.
- Older status event arrives after a newer event.
- Two users issue the same conversion or send command concurrently.
- An idempotency key is reused with a different request body.

### Acceptance criteria

- High-risk operations document their at-most-once illusion / at-least-once processing strategy.
- Replays do not cause duplicate business records or external actions.
- Ambiguous results are marked `unknown`/`reconciliation required`, not falsely reported as success or failure.

---

## 13. Cross-Module Journey Test Design

All journeys must be driven by real user-visible behavior or public application contracts. Use fake provider adapters for external services. Do not hard-code the assumption that every optional module is enabled; the audit must label the capability as required, optional, or deferred.

Each journey must have:

- Preconditions and required capabilities.
- Test actor and permissions.
- Identifiable test-owned data.
- Main path and at least one negative path.
- Expected UI/API behavior.
- Expected persisted state and event history.
- Expected audit entries.
- Job/provider interactions and deduplication behavior.
- Cleanup strategy limited to exact test-owned records.
- Evidence and known limitations.

### 13.1 Phase 22.8 — Lead acquisition, scoring, qualification, and conversion

**Representative path**

1. Create a test-owned Lead through a public CRM API or UI.
2. Attach a source/campaign reference when the MarketingAutomation contract supports it.
3. Verify LeadScore calculates a score using the active scoring model and records explainable score history.
4. Cause a deterministic fake engagement signal or direct field change; verify recalculation is safe and does not overcount repeated signals.
5. Confirm the lead qualification state does not automatically grant Sales access or cause a conversion without a configured rule and permission.
6. Convert the Lead using the supported conversion command, creating or linking Contact and Account according to explicit user selection.
7. Verify duplicate suggestions, field mapping, relationship correctness, source/history preservation, and converted status on the original Lead.
8. Retry the conversion command with the same idempotency key and verify no duplicate Contact/Account is created.
9. Verify restricted users cannot convert or access the resulting records if ACL denies it.
10. Verify failures roll back local changes or produce a clear recoverable status.

**Acceptance assertions**

- Score and conversion history match executed operations.
- Canonical Lead, Contact, and Account identities remain linked correctly.
- Duplicate handling requires explicit policy and does not silently merge unrelated people/organizations.

### 13.2 Phase 22.9 — Sales document through e-signature

**Representative path**

1. Create a test-owned Account/Contact and the minimum Sales records required by the actual implementation.
2. Create and validate a quote or contract document using the implemented document generation path.
3. Generate an immutable document snapshot and verify its content hash/version metadata.
4. Prepare a signature request through the `ESignature` domain service using a fake DocuSign adapter.
5. Verify recipients, template mapping, permissions, and approval policy before send.
6. Have the fake adapter emit accepted, sent, completed, declined, voided, and duplicate/out-of-order webhook events as separate test cases.
7. Confirm that only authenticated and valid provider events update the signature lifecycle.
8. Verify signed artifacts are stored separately from the source snapshot and linked to the correct commercial record.
9. Verify Sales state transitions happen only when contractually appropriate; do not assume an invoice is paid merely because a document was signed.
10. Test ambiguous timeout and reconciliation without sending a real envelope.

**Acceptance assertions**

- Exactly one logical signature request is created for one idempotency key.
- Document versions and signature evidence remain immutable and auditable.
- Invalid webhooks cannot advance the workflow.

### 13.3 Phase 22.10 — Project onboarding, Customer Success, and renewal

**Representative path**

1. Create an Account and any required test-owned Sales/subscription record.
2. Create a CustomerSuccess profile linked to the canonical Account.
3. Start an onboarding or success plan and create linked project/tasks only if the actual contract supports this integration.
4. Verify ownership, assigned users, target dates, task status, and activity creation.
5. Simulate a completed milestone through the supported Project domain API.
6. Confirm CustomerSuccess progress/health reacts only through configured rules and persisted evidence, not hidden direct table changes.
7. Simulate an approaching renewal or an unresolved risk; verify expected task/notification generation once only.
8. Verify a user lacking access cannot inspect the project's private tasks or customer-success risk details.
9. Test partial failure: project creation succeeds but the downstream customer-success update/job fails. Confirm retry/recovery behavior and visible status.

**Acceptance assertions**

- Project and CustomerSuccess records remain consistent with their ownership contracts.
- Duplicate milestone events do not produce duplicate tasks or notifications.

### 13.4 Phase 22.11 — Omnichannel conversation to ServiceDesk case

**Representative path**

1. Create or select a test Contact with a synthetic identifier and consent state appropriate to the test channel.
2. Ingest a synthetic inbound event through the channel's provider fake/webhook contract.
3. Verify event authenticity path is exercised (for signed requests, use generated test keys/signatures; never bypass the verification code).
4. Verify the event is deduplicated and mapped to the correct canonical conversation/contact.
5. Assign the conversation through the supported routing/queue service.
6. Escalate or hand off the conversation to ServiceDesk using its public contract.
7. Confirm the correct Case is linked and conversation context is shared only at the allowed privacy level.
8. Add an internal note and prove that it is never included in customer-visible thread/API/payloads.
9. Simulate webhook duplicate, delayed delivery, provider outage, and a contact identity collision.
10. Verify a portal user can view only authorized cases and message attachments.

**Acceptance assertions**

- No duplicate conversation or Case is created from event replay.
- Internal-only content remains private in all serialization and notification paths.
- Identity conflicts remain unresolved/manual instead of silently merging contacts.

### 13.5 Phase 22.12 — Marketing automation, consent, and attribution

**Representative path**

1. Create synthetic Contacts/Leads and deterministic consent fixtures using the supported consent service.
2. Build a small draft campaign/journey in the actual module, if implemented.
3. Validate the audience and review suppression exclusions.
4. Execute using a fake email/message provider. Do not connect the test to live campaign delivery.
5. Simulate queued, accepted, delivered, bounce, complaint, unsubscribe, and duplicate tracking events.
6. Verify suppression wins over a queued send if an unsubscribe is recorded before actual provider transmission.
7. Verify retries do not send duplicate messages.
8. Track a synthetic conversion outcome and verify attribution is labeled as configured/inferred and not represented as proof of causation.
9. Confirm LeadScore consumes only supported engagement events and repeated events do not multiply a score incorrectly.
10. Confirm communication metrics do not expose contacts to unauthorized teams or users.

**Acceptance assertions**

- Consent is checked server-side at the last responsible moment before outbound send.
- Suppressed recipients receive no automated test message, and all provider behavior remains simulated.

### 13.6 Phase 22.13 — CRMChat and AIAgents controlled actions

**Representative path**

1. Authenticate as a regular CRM user with limited access.
2. Ask CRMChat a question about records the user is allowed to see.
3. Verify the answer uses real tool results, includes source links/record evidence, and does not invent data.
4. Ask for an analysis spanning two or more implemented modules. Verify each data source is ACL-filtered.
5. Ask for a write action such as creating a follow-up task; verify the system previews the proposed changes and awaits user confirmation under the configured policy.
6. Change the record or permissions after preview but before confirmation; verify server-side revalidation rejects stale or now-unauthorized execution.
7. Confirm the action and inspect AIAgents trace, audit result, and created record.
8. Simulate tool timeout, model/provider error, malformed tool arguments, prompt injection in a CRM note, and partial multi-step completion.
9. Verify cancellation stops future eligible steps and reports any already committed effects accurately.
10. Confirm no direct SQL access or elevated service identity is available to the model.

**Acceptance assertions**

- An AI action never bypasses the authenticated user's authorization.
- Proposed, approved, executed, failed, and partially completed states are distinct and inspectable.

### 13.7 Phase 22.14 — AdvancedIntegrations connector recovery

**Representative path**

1. Use a fake OAuth/provider server or existing sandbox contract; never print tokens.
2. Test connection setup, credential encryption/reference, authorization expiry, refresh, revoke, and invalid credentials.
3. Run a deterministic synthetic sync with field mappings and external IDs.
4. Verify external updates do not overwrite protected CRM fields without policy/approval.
5. Simulate pagination, delta tokens, rate limits, partial pages, schema changes, duplicate webhooks, and conflict resolution.
6. Stop/restart the relevant worker or simulate an interrupted job and verify resume behavior.
7. Verify sync operations record a run ID, checkpoint, counts, skipped/error records, and a safe diagnostic summary.
8. Verify module disablement stops new work and handles already queued jobs according to documented policy.

**Acceptance assertions**

- A sync can be retried or resumed without duplicating records or losing the checkpoint.
- Mapping conflicts and partial failures are visible and recoverable.

---

## 14. Phase 22.15 — Shared UI/API Consistency

### Objective

Ensure user-visible behavior is consistent across modules and that frontend controls reflect server results rather than optimistic assumptions.

### Tasks

1. Audit shared list, detail, edit, relationship, search, filter, pagination, bulk action, modal, notification, and attachment components.
2. Verify standard error messages, validation details, conflict handling, access-denied states, and not-found behavior.
3. Ensure loading, empty, partial, retry, success, and failure states are distinguishable.
4. Ensure an optimistic update is rolled back if the server rejects the operation.
5. Ensure stale data is revalidated after high-impact actions such as conversion, invoice transitions, signature completion, case handoff, and agent action execution.
6. Confirm keyboard accessibility, focus behavior in modals, meaningful labels, and stable accessible names for important controls.
7. Confirm UI visibility does not replace backend authorization.
8. Verify route guards and API authorization agree on user permissions.
9. Test long names, missing optional fields, empty results, localization, timezone display, and large record counts.
10. Ensure frontend errors do not surface raw SQL, stack traces, provider secrets, or sensitive payloads.

### Acceptance criteria

- Shared components handle standard success, validation error, permission denied, conflict, and server failure states consistently.
- Critical action buttons cannot display success before the server confirms completion.

---

## 15. Phase 22.16 — Browser End-to-End Critical Paths

### Objective

Test the actual React SPA and public API contracts with a browser runner already used or approved by the repository.

### Tooling policy

- **Playwright is already the selected browser E2E runner**: root `playwright.config.ts` with existing specs in `e2e/*.spec.ts` (login, CRUD, lead-conversion, sales-documents, omnichannel, ai-agents, accessibility, and others). Do not evaluate or install a different runner; extend the existing suite and keep new specs in `e2e/`.
- Known environment gotchas for this repository (already-shipped defects): the shell exports `HTTP_PROXY=127.0.0.1:62112`, so Playwright's webServer availability check and browser traffic to localhost must run with `no_proxy='*' NO_PROXY='*'` or the run dies waiting on the webServer; Playwright's output-dir cleanup can trip the safe-delete bulk guard (>50 files), so move `test-results` aside (`mv test-results test-results-old-$(date +%s)`) before re-running a spec.
- Do not test third-party production websites as part of ordinary E2E. Route external calls to deterministic fakes or explicitly selected provider sandboxes.
- Do not derive selectors from fragile internal CSS classes where accessible roles/labels or established test IDs are available.
- Ensure screenshots, traces, browser storage state, and videos cannot expose real CRM records or credentials.
- Browser E2E must use the existing configured application/database environment under `AGENTS.MD` and must not provision extra databases or schemas.

### Minimum browser scenarios

1. Login and logout.
2. Role-specific navigation and denial of restricted routes/actions.
3. Search a Lead and open its detail page.
4. Inspect LeadScore explanation and complete a Lead conversion preview using synthetic records.
5. Navigate a Sales quote/order flow using safe test data and fake integrations.
6. Inspect a CustomerSuccess profile and a linked Project where available.
7. Open a conversation in Omnichannel and verify a linked ServiceDesk Case.
8. Review an ESignature request in fake-provider mode without dispatching a real envelope.
9. Ask CRMChat a grounded question; view evidence links and an action preview.
10. Approve or cancel a non-destructive AI action using a dedicated test-owned record.
11. Observe a failed operation and confirm the UI presents an accurate error/retry state.
12. Test session expiry during an edit/action and ensure unsaved changes/authorization are handled correctly.

### Acceptance criteria

- Critical browser journeys run deterministically and can run independently.
- The suite has no unintentional live external side effects.
- Test selection uses user-visible contracts and selectors stable under minor UI refactoring.
- Failure artifacts are sanitized and useful for triage.

---

## 16. Phase 22.17 — Security and Privacy Regression Suite

### Objective

Turn the highest-risk security invariants into automated tests, guided by the current OWASP ASVS/API security guidance and the project's threat model.

### Threat areas

- Broken object-level authorization (BOLA/IDOR).
- Broken function-level authorization.
- Field-level permission bypass.
- Cross-team/cross-account/cross-portal-user data leakage.
- Insecure direct object access to attachments, recordings, transcripts, signed documents, message media, export files, and audit history.
- Injection through filters, sort keys, dynamic field names, templates, custom formulas, webhook payloads, and external identifiers.
- SSRF through integration URLs, webhooks, media URLs, import URLs, OAuth callbacks, or user-specified endpoints.
- Cross-site scripting in CRM fields, chat transcripts, email/WhatsApp content, rendered templates, and rich text.
- CSRF/session handling issues where relevant to the authentication model.
- Unsafe redirect and OAuth callback validation.
- Replay attacks and unsigned/invalid provider events.
- Prompt injection and tool misuse in AIAgents/CRMChat.
- Secret exposure in logs, traces, errors, browser state, and provider diagnostics.
- Rate-limit bypass, brute force, resource exhaustion, and unbounded bulk operations.
- Unsubscribe/consent bypass and external communication without policy validation.
- Race conditions that violate authorization or one-time action semantics.

### Tasks

1. Build a risk-based test matrix rather than relying only on a generic security checklist.
2. For each key entity, test access as owner, team member, unrelated user, administrator, API user, portal user, and unauthenticated caller as applicable.
3. Test attachment/media downloads independently from the parent record endpoint.
4. Test bulk API, exports, reports, search/autocomplete, related-record selectors, and async jobs for the same authorization constraints.
5. Test malformed and malicious query filters without executing arbitrary SQL.
6. Test HTML/script payload rendering as text or sanitized content as appropriate; ensure no executable untrusted content reaches privileged contexts.
7. Test OAuth `state`, redirect URI validation, token refresh/revocation, and least-privilege scopes where adapters support OAuth.
8. Test provider webhook signatures with valid, invalid, stale, duplicated, and malformed payloads.
9. Verify secrets and personal data are redacted in logs by automated assertions against representative failure cases.
10. Verify CRMChat/AIAgents outputs cannot change tool schemas, bypass approvals, or access records outside ACL.
11. Verify user-facing errors do not disclose whether a protected record exists where project policy requires non-disclosure.
12. Link failures to the relevant OWASP requirement/category and add a regression test for each fixed defect.

### Acceptance criteria

- No known critical/high authorization or injection issue introduced by this workstream remains open without a documented exception and mitigation.
- Security tests cover the critical entity/API/provider paths, not only login.
- Any exception is recorded with an owner, scope, mitigation, and review date.

---

## 17. Phase 22.18 — Resilience and Chaos-Lite Tests

### Objective

Verify graceful behavior under realistic, controlled failures without destabilizing the primary project environment.

### Tasks

1. Add deterministic fault injection at existing provider/client/queue abstractions where available.
2. Simulate network timeout before request, during request, and after provider acceptance but before response.
3. Simulate HTTP 429, 5xx, invalid credentials, expired OAuth token, malformed provider payload, slow response, and provider unavailability.
4. Simulate duplicate and out-of-order webhook delivery.
5. Simulate a worker interruption after committing local state but before acknowledging the job.
6. Simulate Redis/queue unavailability only in an isolated test double or approved non-production environment; do not disrupt shared infrastructure used by other developers.
7. Simulate object storage upload failure, download failure, and expired media URL.
8. Simulate AI provider failure, partial tool execution, approval timeout, and cancellation.
9. Simulate a DB serialization/deadlock/constraint error through controlled repository/transaction test boundaries; do not intentionally damage live schema.
10. Verify retries are bounded, backoff is applied where needed, permanent failures are not retried forever, and exhausted jobs become visible for operator intervention.
11. Verify user-visible state accurately distinguishes failed, pending, unknown, partially completed, and successful outcomes.
12. Verify reconciliation tools can repair ambiguous state using authoritative provider status without duplicating external actions.

### Acceptance criteria

- Each critical asynchronous workflow has at least one retry/replay test and one permanent-failure test.
- No test uses uncontrolled failure injection against shared production-like infrastructure.
- Recovery procedures are documented for failures that cannot be automatically repaired.

---

## 18. Phase 22.19 — Data Integrity and Concurrency

### Objective

Identify race conditions across cross-module workflows and confirm invariants hold under concurrent operations.

### Tasks

1. Identify high-contention records and uniqueness constraints: Lead conversion, external ID mappings, inbound message deduplication, signature request creation, payment state, journey enrollment, task creation, and webhook event processing.
2. Test concurrent duplicate conversion attempts for the same Lead.
3. Test simultaneous webhook/job processing for the same provider event.
4. Test a record update racing with AI action preview/confirmation; confirmation must revalidate version and permissions.
5. Test optimistic locking/version conflicts where supported.
6. Test unique external identity/mapping constraints and conflict handling.
7. Verify transactions do not leave orphaned relations or inconsistent statuses after controlled failures.
8. Test pagination/order stability if records are concurrently inserted or modified.
9. Verify monetary/financial fields remain decimal-safe and no float rounding regression is introduced.
10. Verify time-zone and date-boundary logic for scheduled actions, SLAs, renewals, and journey delays.
11. Confirm duplicate notifications/events are avoided through idempotency, not merely frontend button disabling.

### Acceptance criteria

- Each identified invariant has a test or a documented reason it cannot be fully automated.
- Parallel execution produces valid, explainable outcomes, including conflict responses where appropriate.
- No workaround depends solely on client-side serialization.

---

## 19. Phase 22.20 — Performance and Capacity Baselines

### Objective

Establish measurable baselines for critical user journeys and integration pipelines without running unsafe stress tests against the primary database or live providers.

### Tasks

1. Record current local/staging machine and dataset constraints before any benchmark.
2. Choose representative query and workflow profiles from actual usage, not arbitrary large stress workloads.
3. Measure API latency for common list/detail/search requests, representative cross-module reads, lead scoring, conversation loading, and background job processing.
4. Inspect query plans for expensive queries using safe, read-only `EXPLAIN` where practical. Avoid `EXPLAIN ANALYZE` on expensive or side-effecting statements without an approved environment.
5. Check pagination caps, query timeouts, bounded fan-out, request body limits, attachment size limits, and rate limiting.
6. Measure queue waiting time, processing duration, retry rate, failure rate, and job age for supported queues.
7. Measure browser performance for the critical routes using sanitized synthetic data.
8. Verify bulk actions and exports are bounded, permission-filtered, cancellable where supported, and do not hold long transactions unnecessarily.
9. Define targets from observed product needs and existing SLOs; do not invent a universal latency target disconnected from deployment resources.
10. Run load or stress tools only against a clearly identified non-production environment with approved synthetic data and a bounded request rate.
11. Document baseline, environment, method, result, variance, and bottleneck evidence.

### Acceptance criteria

- A baseline report exists for selected API, UI, query, and queue paths.
- No uncontrolled load test or destructive benchmark is run against the configured primary database or live providers.
- Each accepted performance target has a measurement method and owner.

---

## 20. Phase 22.21 — Observability and Operational Runbooks

### Objective

Make integration failures diagnosable while keeping logs and traces safe for CRM data.

### Tasks

1. Verify request IDs and trace/correlation IDs are generated and propagated across HTTP requests, domain events, jobs, provider calls, webhooks, and agent runs where infrastructure permits.
2. Define structured log fields such as service/module, operation, entity type/ID when safe, user/actor ID, job/run ID, provider key, retry count, duration, outcome, and normalized error code.
3. Redact passwords, tokens, OAuth codes, database URLs, signatures, full message bodies, prompt contents, attachments, and other sensitive values by default.
4. Add or reuse metrics for request latency/error rates, job queue age/failure/retry counts, webhook failures/duplicates, provider health, integration sync outcomes, AI usage, and high-risk action counts.
5. Use OpenTelemetry only if compatible instrumentation exists or there is a clear need; do not add a second metrics/tracing system.
6. Add safe health/readiness checks that do not leak secrets or perform expensive provider calls on every probe.
7. Create runbooks for: stuck job, failed webhook, provider authentication expiry, duplicate sync conflict, unknown signature state, ambiguous payment/communications result, agent partial completion, and failed migration.
8. Run a tabletop recovery exercise for at least one event-processing failure and one external-provider failure.
9. Ensure operator actions are authenticated, authorized, and audited.
10. Document log retention, trace retention, and handling of test artifacts containing synthetic CRM records.

### Acceptance criteria

- Critical failures include correlation identifiers that let an operator trace from request to job/provider operation.
- Runbooks describe diagnostics and safe recovery steps without destructive shortcuts.
- Logs/traces are checked for secret leakage in failure-path tests.

---

## 21. Phase 22.22 — CI Quality Gates

### Objective

Establish repeatable, layered CI checks that provide a fast feedback loop and prevent known regression classes from merging.

### Pipeline layers

**Layer 1 — Fast checks**

- Formatting/lint checks using the repository's current tooling.
- Type checking and build.
- Unit tests for changed packages/modules.
- Static architecture/boundary checks already adopted by the repository.

**Layer 2 — Contract checks**

- Public API schema/contract tests.
- Event/job payload contract tests.
- Provider adapter conformance tests with fake providers.
- Migration/static checks that do not create or reset a database.

**Layer 3 — Safe integration checks**

- Run only using an explicitly configured, approved environment and the existing database connection policy in `AGENTS.MD`.
- No automated DB provisioning, schema cloning, `TRUNCATE`, test DB, shadow DB, or implicit reset.
- Use narrowly scoped test records, unique run identifiers, safe cleanup, and faked external effects.
- Skip or block write paths if environment identity indicates production or is ambiguous.

**Layer 4 — Browser E2E**

- Run critical UI journeys against the existing testable app environment.
- Use stable selectors and deterministic fixtures/providers.
- Store sanitized traces/artifacts only on failure and with safe retention.

**Layer 5 — Scheduled/extended checks**

- Expanded role/ACL matrix, selected performance baselines, provider sandbox verification, longer resilience suites, and backup/restore rehearsal where approved.

### Tasks

0. **Note on current state:** as of the start of Phase 22 the repository has **no CI workflows** (`.github/` contains only `copilot-instructions.md`). Selecting the CI platform/provider and the trigger model (PR-gated vs scheduled) is an explicit Phase 22.22 decision to be made with the project owner before any workflow file is written.
1. Inspect existing CI provider and workflow conventions before changing files.
2. Standardize command names only when current commands are genuinely inconsistent; do not break documented scripts.
3. Keep critical PR gates deterministic and time-bounded.
4. Cache dependencies/build outputs only where cache keys are safe and correct.
5. Avoid parallel database-writing tests against the same configured primary database unless they use disjoint, uniquely marked records and the operations are concurrency-safe.
6. Do not expose repository secrets in logs or artifacts.
7. Upload failure artifacts selectively and sanitize them.
8. Ensure CI does not automatically deploy, run real provider callbacks, send campaigns, or issue signatures as a side effect of tests.
9. Make failures actionable with test name, module owner, correlation ID, and sanitized output.
10. Document which checks are required, optional, sandbox-only, or manually approved.

### Acceptance criteria

- Required CI gates are documented and work on the project's supported runtime.
- CI never creates extra databases or runs live external actions implicitly.
- Flaky tests are tracked and fixed or quarantined with explicit, time-bounded justification; they are not silently ignored.

---

## 22. Phase 22.23 — Backup, Restore, and Migration Rehearsal

### Objective

Prove the system can recover from failures and evolve its schema without losing existing CRM data.

### Tasks

1. Review existing backup policy and identify the configured database and file/object-storage backup processes.
2. Confirm backup completion, retention, encryption, access controls, and monitoring where these mechanisms already exist.
3. Define recovery point objective (RPO) and recovery time objective (RTO) with the project owner; do not invent business-approved values.
4. Validate restore procedure in an approved isolated recovery environment. This is an operational recovery exercise, not routine test-database creation; obtain explicit environment approval and do not alter the configured primary database.
5. Verify that restored files/attachments align with restored database metadata and that signatures/recordings have not become publicly accessible.
6. Rehearse representative additive migrations against a disposable/recoverable non-production deployment only if approved; never provision a routine test database to do so.
7. Verify application startup and health checks after a migration and check for schema/version mismatch.
8. Document how to pause workers/integrations during a recovery if required to prevent duplicate external effects.
9. Document reconciliation for records whose external provider actions occurred after the restored database snapshot.
10. Record evidence, duration, blockers, and data consistency checks.

### Acceptance criteria

- A restore exercise is documented with evidence and the primary database remains untouched.
- Recovery instructions include database, files, queues/jobs, provider reconciliation, secrets/configuration, and post-restore validation.
- If an approved recovery environment is unavailable, the phase is marked blocked with an explicit gap; do not silently create a new database.

---

## 23. Phase 22.24 — Release Readiness and Residual Risk Review

### Objective

Produce a trustworthy go/no-go recommendation for the hardened system.

### Tasks

1. Re-run required CI gates from a clean checkout/environment or the documented standard runner.
2. Review the capability inventory and update each status from actual test evidence.
3. Review cross-module journey coverage and open defects.
4. Review security findings, authorization exceptions, provider sandbox limitations, migration risks, flaky tests, performance gaps, and restore evidence.
5. Confirm no secrets, real customer records, database dumps, browser storage, or unsafe test artifacts were committed.
6. Verify the release notes include behavior changes, migration requirements, known issues, and operational actions.
7. Confirm feature flags/provider settings default to safe modes; disabled/unconfigured optional providers must fail clearly rather than create fake success.
8. Confirm all external side effects require explicit configuration and are not accidentally enabled by development/test defaults.
9. Produce a concise go/no-go report with evidence links/paths and the owner of each residual risk.
10. Do not claim complete EspoCRM parity; report only the verified scope.

### Release gate

**Go** only when all blocking criteria are met, or an authorized owner explicitly accepts a documented exception with mitigation and deadline.

Blocking criteria include:

- Any known critical vulnerability or unbounded authorization bypass.
- Data corruption or loss in a critical cross-module path.
- Duplicate irreversible external actions under ordinary retry/replay.
- Unsafe database reset or migration behavior in automated commands.
- Critical user journeys without reliable evidence.
- Unhandled migration failure that prevents startup or corrupts data.
- Secrets or sensitive CRM content exposed by logs/artifacts.
- Tests falsely report success when a provider/action has failed or remains ambiguous.

---

## 24. Cross-Module Contract Matrix

Populate this matrix during Phase 22.0 using actual repository evidence. Mark a cell `Required`, `Optional`, `Missing`, or `Not applicable`; add a link to the contract/test evidence. Do not assume all modules are fully implemented just because they have plans.

| Producer / Owner | Consumer | Expected contract to verify | Main failure risks |
|---|---|---|---|
| CRM Core / Lead | LeadScore | lead-created/updated signals, model version, score history | duplicate scoring, stale scores, score race |
| Lead / conversion service | Sales, Contacts, Accounts | validated conversion command, duplicate handling, relation mapping | duplicate contacts/accounts, lost history |
| MarketingAutomation | LeadScore, CRM Core | engagement signal and source attribution | repeated events, suppressed-contact leaks |
| Sales | ESignature | immutable document snapshot, eligible state, record reference | wrong document version, duplicate envelope |
| ESignature | Sales | verified signature state and signed artifact reference | forged event, stale status, artifact overwrite |
| Sales / subscription | CustomerSuccess | account commercial/renewal signals | incorrect renewal state, cross-account leakage |
| Projects | CustomerSuccess | task/milestone progress signal | duplicate action generation, stale progress |
| Omnichannel | VoiceCommunications | provider/channel event contract and conversation references | duplicate messages, lost ordering |
| Omnichannel | ServiceDesk | authorized case handoff and link contract | duplicate Case, leaked internal notes |
| Portal | ServiceDesk / Knowledge Base if present | scoped self-service access | BOLA/IDOR, private attachment exposure |
| VoiceCommunications | Omnichannel | call/message/conversation linkage | event mapping mismatch, replay |
| AdvancedIntegrations | Domain modules | external mapping, sync lifecycle, conflict contract | overwritten CRM fields, duplicate imports |
| CRMChat | AIAgents | typed intent/tool request, trace ID, progress and result | duplicate execution, false success |
| AIAgents | CRM domain services | tool authorization, approval, idempotency | privilege escalation, partial workflow |
| Workflow/BPM | Domain modules | validated commands/events and job lifecycle | recursion, duplicate trigger, unbounded loops |
| Reports/search | All permitted entities | ACL-filtered reads and aggregation | data leakage through aggregation/export |
| Shared Jobs | All async consumers | retry, dedupe, context and outcome contract | duplicate side effects, lost job |
| Shared Files/Attachments | All domains | authorized metadata and download path | broken access control, orphaned file |

---

## 25. Cross-Cutting Test Matrix

Every critical test should identify which layers are exercised. Do not mark a journey covered if the test skips its central behavior through an over-broad mock.

| Test layer | Goal | Typical scope | External boundaries | Database behavior |
|---|---|---|---|---|
| Unit | Pure domain rules | scoring, transitions, mapping, policy, parsers | Fake/stub | No DB unless existing conventions require it |
| Repository integration | SQL behavior and constraints | joins, filters, transactions, unique constraints | None | Existing configured DB, narrow owned records |
| Domain contract | Module boundary behavior | service API/event/queue payload | Fake provider where appropriate | Actual domain path where safe |
| API E2E | HTTP and security behavior | auth, DTOs, route, serialization, ACL | Fake providers | Existing configured DB under `AGENTS.MD` |
| Browser E2E | User-visible workflows | navigation, forms, confirmation, status/error display | Intercepted/fake | Existing app/database; no destructive setup |
| Resilience | Retry and recovery | timeout, replay, worker restart | Simulated faults | Controlled, narrow writes only |
| Security | Threat-driven invariants | ACL, injection, webhook auth, secret redaction | Fake/signature fixtures | Safe test-owned records |
| Performance | Baselines and budgets | query latency, browser, queue | Fakes or approved sandbox | Only approved environment |
| Operations/recovery | Restore and runbooks | backup, restore, reconciliation | Approved controlled environment | Never restore over primary DB |

---

## 26. Test Data and Fixture Contract

### 26.1 Test ownership

Each write-capable test run must record:

- A unique `agentTestRunId` or equivalent value.
- Exact IDs of records created by the run.
- Parent/child relations created by the run.
- Files or job IDs created by the run where they can be safely tracked.
- Whether external side effects are mocked, sandboxed, or disabled.

Use names such as `AGENT_TEST_<run-id>_<purpose>` when the entity has a suitable name field. Prefer a dedicated marker/metadata field when the current schema supports it. Never store secrets in markers.

### 26.2 Cleanup

- Clean up only exact records that the current run created and can positively identify.
- Prefer dependency-aware cleanup of child records before parent records where deletion is permitted and safe.
- Use transactions and rollback where valid, but do not assume asynchronous tasks or storage writes participate in the transaction.
- If cleanup fails, report exact IDs and leave uncertain data untouched. Do not issue broad delete queries to “clean up” the test environment.
- Do not clean up or delete records created by a prior run unless a reliable ownership marker proves that the current authorized cleanup process owns them.

### 26.3 Fixture content

- Use fictional names, reserved domains where appropriate, synthetic phone numbers, fake external identifiers, and non-routable test destinations.
- Never use production customer emails/phone numbers to receive messages.
- Do not use real payment instruments, active DocuSign recipients, live WhatsApp destinations, or live provider credentials in automated tests.
- Redact or synthesize content in HTML email, messages, attachments, audio recordings, transcripts, and CRM notes used by tests.

---

## 27. Contract Design Rules for Cross-Module Events

Use the repository's existing event system where possible. The following is a conceptual checklist, not a mandate to create these exact event names.

Each event should define:

- Stable event ID.
- Event type and schema version.
- Occurrence time in UTC and any business-effective time needed.
- Producer module and aggregate/entity identifier.
- Minimal payload required by consumers.
- Correlation/causation ID where relevant.
- Idempotency/deduplication key when re-delivery is expected.
- Actor/initiator reference and security context classification where needed.
- Data classification and retention constraints.

### Rules

1. Do not publish sensitive bodies, credentials, signed URLs, or unnecessary PII in shared event payloads.
2. Do not treat event payload claims as authorization. Consumers must load authoritative data and re-check policy for sensitive operations.
3. Do not assume events arrive exactly once, in order, or at the same time as the database commit.
4. Do not issue an event before the owning transaction has committed unless a documented transactional outbox architecture ensures consistency.
5. Consumers must tolerate duplicate delivery and supported additive schema changes.
6. Event consumers must record normalized failure state and retry where appropriate.
7. Prevent self-trigger loops; define causation depth or loop protection for Workflow/BPM reactions.
8. Keep a clear distinction between event occurrence time and processing time.
9. Never publish a successful event for a failed business transaction.
10. Verify contracts with automated tests instead of relying only on TypeScript interface compilation.

---

## 28. External Provider Test Policy

### 28.1 Fake mode is the default

All testable providers should be represented behind existing interfaces. Automated tests must use fake providers by default for:

- Email and marketing delivery.
- SMS/MMS, WhatsApp, telephony/call initiation.
- DocuSign envelopes and signing sessions.
- Stripe or other payment operations.
- Google/Microsoft/Zoom external writes and calendar changes.
- Ecommerce/accounting syncs.
- AI model calls and agent tool execution where live calls would be costly or nondeterministic.

If a provider currently lacks an adapter interface, add the smallest interface at the correct domain boundary and retain the current production behavior through an adapter. Do not let the fake provider bypass the application service under test.

### 28.2 Provider sandbox verification

- A provider sandbox test is optional and separately classified from CI.
- It requires explicit configuration, dedicated sandbox credentials, known test recipients/accounts, rate limits, and an operator who understands the effects.
- A sandbox result must not be misreported as production-provider certification.
- Never silently fall back from a sandbox to production if credentials or environment indicators are missing.

### 28.3 Webhook fixtures

- Generate valid test signatures through provider test helpers or deterministic local test secrets.
- Keep fixtures minimal and synthetic.
- Test invalid signature, wrong account, replay, stale timestamp, duplicate event, malformed JSON, and unsupported event type.
- Do not test signature validation only by stubbing the verifier to always return true.

---

## 29. API and UI Error Semantics

Across all critical workflows, distinguish the following states when applicable:

- `Succeeded` — operation is confirmed complete by the canonical owner/provider.
- `Accepted` or `Queued` — work was accepted but has not completed.
- `InProgress` — work is actively executing.
- `NeedsApproval` — a user or authorized approver must confirm the next action.
- `PartiallyCompleted` — some steps committed; exact completed and outstanding steps are listed.
- `FailedRetryable` — retry may succeed without duplicating the operation.
- `FailedPermanent` — action requires correction or operator intervention.
- `OutcomeUnknown` — the external result is ambiguous and must be reconciled before any potentially duplicating retry.
- `Cancelled` — cancellation succeeded, with already committed effects disclosed.
- `Conflict` — stale state, duplicate resource, or concurrency condition requires refresh/resolution.

Use existing status conventions if the project already has stable enums; do not create duplicate state machines solely to adopt these labels.

### Acceptance checks

- The backend response and frontend status agree.
- An accepted job is not shown as completed.
- Provider timeout is not automatically shown as failure if the provider may have accepted the action.
- Retry controls do not blindly repeat an irreversible request with unknown outcome.
- Partial workflow completion identifies committed effects and safe next steps.

---

## 30. Performance, Scalability, and Test Stability Rules

1. Test correctness before increasing parallelism.
2. Do not run database-writing E2E tests in parallel against the same records or shared external resources.
3. Use unique test-run identifiers and disjoint record sets where parallelism is safe.
4. Do not add fixed sleeps where a state-based condition or job-completion poll can be used.
5. Use bounded polling with clear timeouts and diagnostic output.
6. Freeze time for deterministic due dates, SLA deadlines, scheduled journeys, renewal windows, and expiration tests where the current architecture supports a clock abstraction.
7. Avoid exact assertions on nondeterministic ordering unless the API contract defines the order.
8. Do not use real LLM outputs as the only source of deterministic assertions; inject a fake model or stable structured response for CI tests.
9. Use seeded pseudo-random test inputs only when the seed is recorded and useful for reproducibility.
10. Track test duration and flakiness by suite. Fix root causes rather than merely increasing all timeouts.
11. Avoid excessive UI screenshots or trace upload; store artifacts only where necessary and sanitize them.
12. Keep load tests bounded and away from live providers, production data, and the configured primary database unless explicitly approved.

---

## 31. Coverage and Quality Policy

Coverage percentages are not a substitute for behavioral evidence. Use existing coverage tools and current repository baselines; establish targets after measuring the baseline rather than setting arbitrary percentages that encourage superficial tests.

### Minimum behavioral coverage

- Every critical domain transition has a positive test and at least one invalid-transition test.
- Every public write route has authentication and authorization coverage.
- Every integration event handler has valid, invalid, and duplicate-delivery coverage where applicable.
- Every external side-effect adapter has success, retryable failure, permanent failure, and ambiguous-timeout tests where the provider semantics allow it.
- Every cross-module journey has a happy path, permission-denied path, and recoverable failure path.
- Every migration is reviewed and gets a relevant schema/data compatibility check.
- Every high-risk security finding fixed in this phase gets a regression test.
- Every browser E2E path asserts meaningful visible state and at least one persisted/business outcome through a supported interface.

### Avoid weak coverage

Do not count as adequate evidence:

- A test that only asserts status 200 while ignoring returned data and persisted state.
- A UI test that stubs the entire server behavior and never tests the application contract.
- A domain test that mocks the logic it is supposed to test.
- A security test that bypasses the actual guard or verifier.
- A test that passes because it is skipped or marked todo.
- A test suite that runs only on an empty database created/reset by setup.

---

## 32. Suggested Repository Organization

Adapt this to existing project conventions; do not restructure the repository only to match this example.

```text
docs/
  quality/            # new in Phase 22 (inventory, journeys, test strategy, known gaps, evidence)
  architecture/       # exists — add module-contracts.md here
  runbooks/           # exists — add integration-failure-runbook.md here
  operations/         # exists (backup-restore.md) — add release-readiness-checklist.md here

e2e/                  # existing Playwright browser E2E specs (root level)

apps/api/test/        # existing Vitest API/integration/contract tests (flat directory)

packages/             # only if the repository already has these boundaries
  test-kit/           # optional helpers, not a parallel test framework
```

Keep feature tests close to the relevant module when that is the established convention. Store cross-module journeys in a dedicated location when tests cannot be owned sensibly by one domain.

---

## 33. Example Evidence Record

Use the repository's existing format if one exists. An evidence entry should contain equivalent information to this template:

```markdown
## Evidence: Lead conversion duplicate protection

- Requirement: Phase 22.8 — retrying a conversion must not create duplicate Contact/Account records.
- Owner: CRM Lead/conversion domain.
- Test path: `<actual repository test path>`.
- Command: `<actual command executed>`.
- Environment: `<safe environment identifier; no credentials>`.
- Test data: `AGENT_TEST_<run-id>` records with exact IDs recorded by setup.
- External effects: Fake providers; none delivered externally.
- Result: PASS / FAIL / BLOCKED / NOT RUN.
- Evidence: `<sanitized log, assertion summary, trace, or CI run link>`.
- Remaining limitation: `<none or explicit explanation>`.
```

Do not copy this literal placeholder as completed evidence. Replace it only with values from actual execution.

---

## 34. Operational Runbook Requirements

Create or update runbooks for at least these scenarios:

### 34.1 Queue backlog or stuck job

- Identify queue, job ID, correlation ID, owner module, age, retry count, and normalized error.
- Determine whether processing is safe to retry.
- Verify idempotency key or provider state before retrying external side effects.
- Avoid direct database edits except through approved recovery procedures.
- Record operator action and outcome.

### 34.2 Duplicate or invalid webhook

- Verify provider/account identity and signature result.
- Inspect deduplication result and event timeline.
- Determine whether the event was applied, ignored, rejected, or queued for reconciliation.
- Never disable signature verification as a troubleshooting shortcut.

### 34.3 Provider timeout with unknown outcome

- Mark the result as unknown pending reconciliation.
- Query provider status via the existing adapter if safe and supported.
- Retry only when duplicate prevention is guaranteed.
- Record any manual reconciliation outcome.

### 34.4 Inconsistent cross-module state

- Identify authoritative owner for each record/state.
- Inspect correlation IDs, event history, transaction and job state.
- Re-run an idempotent reconciliation command if supported.
- Do not manually update multiple domain tables to make the UI look consistent.

### 34.5 Failed migration

- Stop new deployments and identify migration stage/error.
- Do not edit migration history or apply destructive rollback without approval.
- Determine whether application code is still compatible with the actual schema.
- Follow a reviewed forward-fix or approved restore plan.
- Verify data and critical user journeys before resuming background jobs.

### 34.6 AI partial completion

- Inspect run ID, completed steps, approvals, tool results, and outstanding effects.
- Do not restart the entire workflow blindly.
- Resume or compensate through supported run controls.
- Verify authorization at each resumed step and document effects that cannot be rolled back.

---

## 35. Final Acceptance Checklist

Phase 22 may be declared complete only when the following checklist has evidence, an accepted exception, or a clearly documented blocker.

### Repository and contracts

- [ ] Actual capability inventory completed; no plan-only assumptions remain.
- [ ] Module ownership and dependency map reviewed.
- [ ] Critical API/event/job contracts cataloged and tested.
- [ ] No unreviewed circular dependency or direct cross-domain write was introduced.

### Testing

- [ ] Unit tests cover critical domain rules and transitions.
- [ ] Repository integration tests cover important SQL constraints and transaction boundaries.
- [ ] API/contract tests cover authentication, authorization, validation, and error semantics.
- [ ] Each critical cross-module journey has success, denial, and failure/recovery coverage.
- [ ] Browser E2E covers key real user paths using the existing/approved runner.
- [ ] Retry, replay, duplicate, out-of-order, timeout, and partial-failure scenarios are covered where relevant.
- [ ] Tests use fake providers for external side effects by default.
- [ ] No meaningful test is silently skipped or weakened to obtain green CI.

### Security and privacy

- [ ] Record and field ACL tests cover critical paths.
- [ ] Portal scope and attachment/media access are tested.
- [ ] Webhook authenticity and replay protection are tested.
- [ ] CRMChat/AIAgents approval and authorization are tested.
- [ ] Consent/suppression and externally visible actions are tested.
- [ ] Logs, traces, screenshots, and artifacts are checked for secrets/sensitive data.

### Data and operations

- [ ] No test or CI step creates an extra test database/schema or resets the primary database.
- [ ] Migrations reviewed and verified as safe for existing data.
- [ ] Test data has unique ownership markers and exact-ID cleanup.
- [ ] Observability links requests, jobs, provider calls, and agent runs where applicable.
- [ ] Operational runbooks are reviewed.
- [ ] Backup/restore rehearsal is completed in an approved recovery environment or documented as blocked.
- [ ] Performance baseline exists for selected critical paths.

### Release

- [ ] Required CI gates pass in the intended release configuration.
- [ ] Open defects and exceptions have owners and risk acceptance.
- [ ] Release notes and known limitations are accurate.
- [ ] Final evidence report distinguishes tests run, tests skipped, tests blocked, and unverified capabilities.
- [ ] Go/no-go recommendation is recorded.

---

## 36. Final Coding-Agent Instructions

Implement the workstream in order and in small increments.

1. **Start with Phase 22.0 only.** Return an inventory and a recommended implementation sequence based on observed code.
2. Do not write a huge suite of fragile E2E tests before fixing the contracts and test safety issues.
3. For each sub-phase, list the intended files, tests, migration impact, external effects, and risk before editing.
4. Implement only the current sub-phase unless a blocker requires a narrowly scoped prerequisite fix.
5. Run the smallest relevant checks first; then run broader safe checks after the change.
6. Use the configured existing database only under the exact constraints in `AGENTS.MD`. Never provision an extra test database/schema, and never reset or truncate the configured database.
7. Use synthetic test records and fake providers. Do not send real customer communications, calls, payments, or signature requests.
8. Review changed files for security, unrelated diffs, secrets, migration risks, accidental test side effects, and disabled assertions.
9. Update the inventory and test-evidence report with actual results.
10. Report passed/failed/skipped/blocked checks honestly and stop at the end of the requested sub-phase.

**First task to execute:** `Phase 22.0 — Repository and Capability Audit`. Do not begin implementing fixes until the inventory, high-risk gaps, test safety risks, and cross-module dependency map have been presented for review.
