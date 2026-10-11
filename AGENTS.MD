# AGENTS.MD — Coding Agent Instructions

These instructions apply to all coding agents working in this repository. Read this file and `PLAN.md` before implementing features, changing database schemas, or running tests.

## 1. Project Goal and Source of Truth

This repository is a clean-room reimplementation of EspoCRM using NestJS and TypeScript. The goal is to reproduce documented product behavior and architectural concepts, not to translate PHP files line by line.

- Treat `PLAN.md` as the product scope, architecture reference, and implementation roadmap.
- Treat this `AGENTS.MD` as the operating rules for coding, testing, and database safety.
- **Database and test-lifecycle rules in this file take precedence over any general plan or framework default that would create extra test databases.** If `PLAN.md`, a package script, a test framework, or a generated template suggests creating a test database, do not do so automatically. Use the existing configured primary project database as described in Section 3.
- Inspect the existing repository and its conventions before making changes. Do not assume a planned directory, package, script, or dependency already exists.
- Make the smallest coherent change that solves the task. Avoid unrelated refactors, broad file rewrites, and speculative abstractions.
- Do not report work as complete unless the relevant checks were actually run or clearly identify what could not be run.

## 2. Expected Technology Direction

Follow the stack selected in `PLAN.md`, adapting only when the repository already has an established, deliberate choice:

- Node.js and TypeScript with strict type checking.
- NestJS for the backend; Fastify may be used as the HTTP adapter where already configured.
- PostgreSQL as the first-class database, with SQL-first persistence (Kysely or the repository's explicitly adopted equivalent) for the metadata-driven Entity Engine.
- React and TypeScript for the SPA, where the frontend exists.
- Redis and BullMQ for background work, where required by the implemented feature.
- OpenAPI for documenting the public API.

Do not introduce a second ORM, validation framework, state manager, package manager, or competing architecture without a concrete need. Check `package.json`, workspace configuration, lockfiles, and existing modules before adding dependencies. Use the repository's selected package manager and lockfile; do not create a second lockfile.

## 3. CRITICAL: Database and Testing Policy

### 3.1 Use the existing primary project database

**The user explicitly permits the coding agent to test directly against the already-configured primary project database. Use that configured database as the default integration/API/smoke-test target. Do not create a new database merely because a tool or testing framework calls for a test database.**

Before running database-backed tests:

1. Inspect the existing configuration and test scripts to understand what they will do.
2. Use the existing database connection configuration (for example, the project's configured `DATABASE_URL` or equivalent). Do not silently replace it with a generated `*_test`, `*_e2e`, `test_db`, shadow, temporary, or per-agent database.
3. Never print or expose database passwords, tokens, or the full connection URL in logs, test output, commits, or the final response.
4. If the configuration explicitly points to a production environment, or the target cannot be identified confidently, do not run potentially destructive or broad write operations. Limit activity to safe checks and narrowly scoped operations unless the task explicitly authorizes more.

Do not create additional databases, database containers, schemas, or database copies for routine tests. Do not add scripts or CI steps that create them automatically. This restriction applies to local scripts, Docker Compose, test setup/teardown hooks, migrations, CI, and generated configuration.

A test runner must not reset or recreate the configured database as part of its normal setup. If an existing test command does that, inspect and replace/disable the destructive setup before running it. Prefer unit tests that do not require database access, and run required integration tests against the existing configured database without rebuilding it.

### 3.2 Permitted direct testing

The configured primary project database may be used for normal, targeted development verification, including:

- Checking connectivity and schema state.
- Running API and repository integration tests.
- Creating, reading, updating, and deleting records that the agent created specifically for its test.
- Verifying transactions, relations, constraints, indexes, query behavior, and supported metadata operations.
- Applying a reviewed, non-destructive migration required by the task, when appropriate for the configured environment.

Testing directly against the primary database does **not** grant permission to damage existing data, clear tables, replace the database, or remove user-created records.

### 3.3 Test-data rules

- Use unmistakably identifiable test records, such as names beginning with `AGENT_TEST_` or a unique `agentTestRunId`/marker when the entity supports it.
- Generate unique values to avoid colliding with existing contacts, users, accounts, emails, external IDs, or other business records.
- Do not use or modify real customer records to test an operation. Create a dedicated test record and operate only on that record.
- Prefer transactions and rollback for tests when the operation and database behavior make that reliable. Do not assume a transaction can roll back external effects such as emails, webhooks, queue jobs, or file uploads.
- Disable or mock outbound email, SMS, webhook delivery, payment calls, and other external side effects during tests where feasible. Never send real messages to customers as a side effect of a test.
- Clean up only test records that the current run created and can positively identify. Use precise primary keys or a unique run marker. Never delete records merely because their names look similar.
- Never run global cleanup queries or broad deletes to remove test data. If ownership of a record is uncertain, leave it untouched and report it.
- Avoid large fixture loads or mass seeding unless the task requires them. Do not seed default/demo data repeatedly on each app start or test run.

### 3.4 Forbidden database operations without explicit, task-specific approval

Never execute or add automation for any of the following just to make tests pass:

- `DROP DATABASE`, `DROP SCHEMA`, destructive schema replacement, or database recreation.
- `TRUNCATE` on application tables.
- Broad `DELETE` or `UPDATE` statements without a verified, narrow predicate.
- `prisma migrate reset`, force-reset commands, `db push --force-reset`, or equivalent destructive ORM commands.
- Migration rollback or schema changes that remove/rename columns, drop tables, destroy data, or change data meaning without an explicit migration plan and approval.
- `docker compose down -v` or volume deletion when it can remove the database's persistent data.
- Restoring a backup over the current database, deleting database volumes, or wiping persisted application data.
- Running a seed script that clears tables before inserting fixtures.

Before running an unfamiliar command, inspect its script definition and any hooks it invokes. Do not assume commands named `test`, `reset`, `clean`, `seed`, `migrate`, or `e2e` are safe.

### 3.5 Schema and migration discipline

- Keep schema changes in version-controlled migration files using the repository's migration system.
- Review the migration SQL/code before applying it to the configured database.
- Prefer additive, backward-compatible changes: new nullable columns, new tables, indexes, and staged data backfills.
- Preserve existing records and data values. Do not regenerate schema from scratch to resolve a migration error.
- Do not mark a migration as applied, edit migration history, or skip a failed migration merely to get a green test.
- If a destructive migration is genuinely required, stop before applying it, explain the impact, and request explicit task-specific approval. Do not interpret permission to test against the primary database as permission for destructive migrations.
- After a schema change, verify the resulting schema and the relevant read/write behavior against the configured database.

### 3.6 Prevent test-database sprawl

Before adding or changing test infrastructure, confirm that it will not create another database. In particular:

- Do not add per-feature, per-agent, per-run, or per-branch databases.
- Do not configure automatic database creation in Jest, Vitest, Playwright, Testcontainers, Docker Compose, CI, or migration hooks.
- Do not enable ORM shadow-database behavior unless it is explicitly required, approved, and already part of the chosen design.
- Do not create a new database as a workaround for a permissions error, migration error, missing table, failing test, or inconsistent seed data. Diagnose and fix the actual issue against the configured database.
- If a tool cannot run safely without creating another database, do not run that mode. Use an equivalent non-destructive test path and document any limitation.

## 4. Implementation Workflow

For each task, follow this sequence:

1. **Inspect**: read the relevant implementation, types, tests, scripts, configuration, and applicable parts of `PLAN.md`.
2. **Understand**: identify the feature boundary, callers, data flow, permissions, migration implications, and side effects.
3. **Plan briefly**: for a non-trivial change, outline the smallest implementation and verification steps before editing.
4. **Implement**: follow existing conventions and keep the change focused.
5. **Verify**: run relevant linting, type checks, unit tests, and safe integration/API checks. Follow Section 3 for all database work.
6. **Review**: inspect the diff for unrelated changes, secrets, unsafe SQL, missing authorization, unhandled errors, and accidental generated files.
7. **Report**: summarize what changed, the checks run and their outcomes, and any remaining limitations. Be explicit if a check was skipped.

Never make a test pass by weakening an assertion, skipping a meaningful test, disabling authorization, swallowing exceptions, or changing expected behavior without justification.

## 5. Architecture Rules

### 5.1 Modular monolith first

- Keep the initial system a modular monolith as specified in `PLAN.md`; do not introduce microservices without an explicit architectural decision.
- Place code in the existing package/module boundaries. Keep domain logic out of controllers and React components.
- Use clear interfaces for persistence, metadata, ACL, event dispatch, jobs, files, email, and extension points.
- Avoid circular dependencies. Shared kernel packages must not import application-specific modules.

### 5.2 Metadata-driven entity system

The Entity Engine is a central product capability, not a collection of hard-coded CRUD controllers.

- Keep entity definitions, field definitions, relations, layouts, validation, and access behavior driven by metadata where required by `PLAN.md`.
- Validate metadata and user-supplied field values at runtime.
- Do not build SQL from untrusted entity names, field names, sort keys, filter values, or metadata. Use allowlists, safe identifier handling, parameterized values, and validated query plans.
- Keep serialization, relation loading, field-level permissions, and record-level ACL consistent across list, detail, search, export, and API paths.
- Do not bypass the Entity Engine with ad hoc table logic when the feature belongs to the generic entity layer.

### 5.3 Security and access control

- Enforce authentication and authorization on the server; hiding a frontend control is not authorization.
- Apply record-level and field-level permissions consistently, including related records, bulk actions, exports, imports, reports, and background jobs.
- Validate all external input. Use parameterized SQL and safe file handling.
- Do not log passwords, bearer tokens, API keys, session secrets, full database URLs, or sensitive personal data unnecessarily.
- Use secure password hashing and established authentication libraries; do not invent cryptographic primitives.
- Treat formulas, custom scripts, uploaded files, imported data, webhook payloads, and extension code as untrusted inputs.
- Do not disable security checks to simplify implementation or tests.

### 5.4 API conventions

- Follow the documented `/api/v1` API approach in `PLAN.md` and preserve consistent response/error formats.
- Validate request DTOs and reject invalid input with clear, stable error responses.
- Maintain pagination, sorting, filtering, and relation behavior consistently.
- Update OpenAPI definitions and API tests when public contracts change.
- Do not expose internal stack traces, SQL statements, secrets, or sensitive metadata in public responses.

### 5.5 Background work and external effects

- Make jobs idempotent where practical and design retries to avoid duplicate side effects.
- Use explicit timeouts and bounded retries for network calls.
- Record job failures with safe diagnostic context.
- Tests must not accidentally send real email, trigger production webhooks, or call external services that create charges or irreversible actions.

## 6. Clean-Room and License Compliance

- Use EspoCRM public documentation and documented behavior as references, consistent with `PLAN.md`.
- Do not copy or mechanically translate EspoCRM PHP source files, frontend assets, translations, icons, branding, or other upstream copyrighted materials into this repository unless the intended use is explicitly reviewed and permitted by the applicable license.
- Implement equivalent behavior independently in TypeScript.
- Keep references to compatibility behavior in project documentation and report any unresolved licensing/compliance question rather than making legal assumptions.

## 7. Code Quality and Maintainability

- Prefer readable, explicit code over clever abstractions.
- Use strict types. Avoid `any`; when unavoidable at a boundary, isolate it, validate it, and document why it is needed.
- Handle errors deliberately. Do not swallow exceptions or return success for failed operations.
- Use structured logging with request/correlation IDs where available.
- Add tests for bug fixes and for non-trivial business logic.
- Add or update migrations, DTOs, API schemas, metadata, translations, and documentation when the feature changes them.
- Keep naming and file organization consistent with adjacent code.
- Do not add dependencies for functionality the platform already provides.
- Do not check in `.env` files, credentials, generated build output, local database dumps, or test artifacts unless explicitly required.
- Do not reformat or rewrite unrelated files as a side effect of a focused change.

## 8. Frontend Rules

Where the React frontend exists:

- Use the existing component library, routing, query/state management, and form conventions.
- Keep business rules and authorization enforcement on the backend.
- Consume entity and layout metadata from the API where required; do not hard-code the entire CRM schema in frontend components.
- Include loading, empty, error, and permission-denied states.
- Make forms keyboard accessible and provide useful validation messages.
- Avoid duplicating API requests or introducing hidden writes during rendering.

## 9. Testing Expectations

Choose the lowest-cost test that verifies the behavior, then add broader tests for important flows:

- **Unit tests**: pure business logic, validation, ACL evaluation, query planning, metadata merging, formulas, serialization.
- **Integration tests**: persistence, transactions, metadata loading, relations, file storage, queue behavior. Use the existing configured primary database; do not create another database.
- **API tests**: successful, invalid, unauthenticated, and unauthorized requests, including ownership/team/field access where relevant.
- **Browser tests**: critical user flows when Playwright or an equivalent tool is configured. Do not allow browser-test setup to provision extra databases.
- **Security tests**: authorization bypasses, IDOR, injection, unsafe uploads, token leakage, and formula sandbox boundaries where applicable.

Before running test commands, inspect their setup and teardown behavior. Report actual command results; do not claim tests passed if they were not run.

## 10. Git and Workspace Safety

- Inspect `git status` before editing and before finalizing.
- Preserve the user's existing changes. Do not discard, overwrite, reset, stash, or clean them unless explicitly asked.
- Never use `git reset --hard`, `git clean -fd`, or broad deletion commands as routine cleanup.
- Do not commit unless explicitly asked.
- Keep generated artifacts and local secrets out of source control.

## 11. Definition of Done

A task is complete when, as applicable:

- The implementation follows `PLAN.md` and existing repository conventions.
- Validation, authorization, error handling, and observability are addressed.
- Database changes use reviewed, version-controlled migrations and preserve existing data.
- Tests are added or updated and the relevant safe checks have been run.
- No extra test database was created.
- No unrelated changes, secrets, or destructive setup scripts were introduced.
- Documentation and API contracts are updated where necessary.
- The final report states the implementation, verification performed, and known limitations honestly.

## 12. Final Reminder

**Use the existing configured primary project database for direct development testing when database verification is needed. Do not create extra test databases. Never reset, truncate, drop, or broadly delete data to make a test pass. Keep all test writes identifiable and narrowly scoped, and preserve existing project data.**

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
