# Phase 19-AI.0 — `AIAgents` repository audit

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §3 (required audit), §20 Phase 19-AI.0.
> **Status:** delivered in 19-AI.0. This document is the snapshot the later sub-phases build on.
> It was produced by reading this checkout, not from `PLAN.md` claims.
> **Naming:** the module is `AIAgents`, the registry key and route slug are `ai-agents`, and no name
> carries a `Ua` prefix.

---

## 1. Headline

There is **no AI provider abstraction, no model credential store, no agent definition, no run
engine, no tool registry, no quota ledger and no evaluation framework** in this repository. The
only "provider" code is marketing's outbound-mail adapter, which is unrelated to model providers.

Everything else the module needs already exists and is reused: the NestJS modular monolith, Kysely +
PostgreSQL, the metadata/Entity Engine, RBAC/ACL, the encrypted-secret primitive, durable jobs, the
transactional outbox, audit and stream, navigation/settings, and the React + Ant Design SPA.

The first release therefore **adds a new domain directory and additive tables**, and duplicates no
kernel infrastructure.

---

## 2. Reusable building blocks (verified paths)

| Capability | Actual component | Import / token | Notes for `AIAgents` |
| --- | --- | --- | --- |
| HTTP app + DI | NestJS 11, Fastify adapter | `apps/api/src/app.module.ts`, `apps/api/src/bootstrap.ts` | Module providers/controllers are spread in `AppModule`; static route groups must precede `ENTITY_CONTROLLERS` (`app.module.ts:119`). |
| Database | Kysely over `pg` | `DatabaseService` (`apps/api/src/database/database.service.ts`), `Database` interface | Add table interfaces + `Database` keys. SQL-first; no second ORM. |
| Migrations | Ordered SQL files, one transaction each | `database/migrate.ts`, `database/migrations/*.sql` | Next free number is `045`. Additive `IF NOT EXISTS` only. |
| Metadata / Entity Engine | `MetadataStoreService` (`apps/api/src/metadata/metadata-store.service.ts:28`), `EntityCrudService`, `PostgresRecordStore` | `METADATA_STORE` | Agent definitions are **not** generic records; tools call the Entity Engine rather than reimplementing it. |
| ACL | `AclApiService` (`apps/api/src/acl/acl-api.service.ts:70`) | class token | Entity/record/field checks plus portal and project scoping. `sysAdmin` role and `users.is_admin` are all-access. Actions are `create/read/edit/delete/stream`; a role's `*` entry is the per-entity default. |
| Request principal | `RequestScope` (`apps/api/src/common/request-scope.ts`) | `REQUEST_SCOPE_TOKEN` | Carries user id, type, roles, teams, portal/contact ids, correlation id. Background work must not rely on it being present. |
| Auth guard | `AuthGuard` (`apps/api/src/auth/auth.guard.ts`) | global `APP_GUARD` | `@Public()` is the only bypass; all agent routes stay authenticated. |
| Background jobs | `JobsService` (`apps/api/src/jobs/jobs.service.ts:41`), `JobQueueService`, worker `runJob` | `JOB_PROVIDERS` | Postgres is the durable record; Redis/BullMQ carries the queue. Job names are `<module>.<action>` (2–4 dot segments). |
| Scheduler | `scheduled_jobs` + `ScheduledJobController`, worker cron | `JOB_PROVIDERS` | Available for retention sweeps and scheduled triggers later. |
| Domain events | `EventBus` / transactional outbox | `DOMAIN_EVENT_PROVIDERS` | At-least-once delivery; consumers must be idempotent. |
| Audit | `AuditHookService`, `audit_log` | `AUDIT_PROVIDERS` | Generic record audit is automatic. Agent configuration changes must also write audit entries (planned in AI.5). |
| Stream / notifications | `StreamService`, `notifications` | `STREAM_PROVIDERS` | Reused for approval notifications; no second notification system. |
| Secret encryption | `encryptSecret` / `decryptSecret` (`packages/core/src/utils/crypto.ts:32,40`) | `@carocrm/core/utils/crypto.js` | AES-256-GCM, `ENCRYPTION_KEY` (64 hex chars). `email_accounts.smtp_password_encrypted` is the precedent; secrets are write-only and read paths return `hasPassword` only. |
| Settings | `app_settings` row + module settings services | `DatabaseService` | Marketing/Sales/ServiceDesk each own one validated row. `AIAgents` will own the `aiAgents` row. |
| Settings registry (Phase 20) | `SettingsRegistryService`, `SettingsDocumentService` | `ADMIN_PANEL_PROVIDERS` | Admin document registry. A module settings tab reads its own endpoint (`moduleEndpoint`). Not required for 19-AI.4. |
| Navigation | `NAVIGATION_PAGES` / `NavigationService` (`apps/api/src/admin-panel/navigation-defaults.ts`, `navigation.service.ts`) | — | Menu is resolved server-side: defaults → document → ACL. Add an `aiAgents` page seed gated by a permission. |
| i18n | JSON catalogs `i18n/en`, `i18n/vi` | `I18nService` | Add `aiAgents.*` labels under `web.json` (namespace `web`). |
| Errors | `AppError` subclasses | `@carocrm/core/errors/index.js` | `AuthorizationDeniedError`, `ValidationError`, `FeatureDisabledError`, `RateLimitError`, `NotFoundError`, `ConcurrencyConflictError` already cover the policy surface. |
| Logging | `log` from `@carocrm/core/logger` | — | Structured logger; never log secrets, prompts or full records. |
| SPA | React + Vite + Ant Design + TanStack Query | `apps/web/src` | Server-driven navigation; static routes must precede `/:entity`. |

### 2.1 Optional domain contracts to integrate with later

All five modules are kernel directories, not extension packages. Their public surfaces are Nest
services, not shared TypeScript interfaces, so later phases must depend on **services** (or domain
events) and never import their tables.

| Module | Entry point | Useful read surface | Ownership boundary |
| --- | --- | --- | --- |
| `Sales` | `apps/api/src/sales/index.ts` | document/payment/subscription services, reporting | Financial calculations, numbering, tax, currency, locking stay in Sales. |
| `CustomerSuccess` | `apps/api/src/customer-success/index.ts` | `customer-success-profile.service.ts`, `customer-success-health.service.ts`, `customer-success-renewal.service.ts` | Health/lifecycle/risk rules stay there. |
| `ServiceDesk` | `apps/api/src/service-desk/index.ts` | `CaseLifecycleService`, `ServiceDeskMetricsService`, conversation service | SLA, queue, case workflow and internal-note visibility stay there. |
| `MarketingAutomation` | `apps/api/src/marketing-automation/index.ts` | campaign/send/consent/suppression services | Consent, suppression, frequency caps and dispatch stay there. |
| `Projects` | `apps/api/src/projects/index.ts` | project policy/scope, project services | Project roles, stages and task dependencies stay there. |
| `Portal` | `apps/api/src/portal/index.ts` | `PortalPolicyService` | Portal visibility and per-contact scoping stay there. |

**Rule:** an AI tool adapter calls one of these services. It never writes `entity_records` directly
for a module-owned concept, and it never reaches another module's tables.

---

## 3. What is missing (smallest acceptable additions)

| Missing capability | Smallest addition | Phase |
| --- | --- | --- |
| Agent definition + immutable version persistence | `ai_agents`, `ai_agent_versions`, `ai_agent_tool_grants` tables and services | AI.3 / AI.5 |
| Durable run + event timeline | `ai_agent_runs`, `ai_agent_run_events` | AI.3 / AI.7 |
| Tool-call ledger + approvals | `ai_agent_tool_calls`, `ai_agent_approvals` | AI.3 / AI.10 |
| Provider configuration + credential storage | `ai_provider_connections` table; AES-GCM secret column; provider registry/gateway | AI.3 / AI.4 |
| Model request ledger | `ai_agent_provider_requests` | AI.3 / AI.13 |
| Budget policies + quota ledger | `ai_agent_budget_policies` now; usage counters on runs and the provider ledger; atomic reservation in AI.13 | AI.3 / AI.13 |
| Module settings / kill switch | `aiAgents` row in `app_settings`, validated by Zod, `features.execution` default **off** | AI.2 |
| Module permissions | Synthetic permission resources checked through the existing `AclApiService` (see §4) | AI.2 |
| Provider-neutral gateway | `AIProviderAdapter` contract, OpenAI-compatible adapter, fake adapter, normalized errors | AI.4 |
| Agent tool registry | Typed code-registered tools with Zod schemas | AI.6 |
| Run engine | Durable state machine on top of `jobs` | AI.7 |
| Memory / evaluation | Deferred; tables are added only when their phase needs them | AI.12 / AI.14 |

No new database, schema, container, queue or ORM is introduced. No second email or notification
system is introduced. No vector database is introduced.

---

## 4. Permissions: how the module expresses its separate rights

The platform has **no arbitrary-permission mechanism**: `roles.permissions` is an entity→action map
and `AclApiService.canUser(entity, action)` is the only evaluator. Module-specific rights are
therefore expressed as **synthetic permission resources** evaluated by the same service — the same
technique Marketing/Service Desk use for admin-gated commands, but with named resources so each right
is separable:

| Capability | Resource | Action |
| --- | --- | --- |
| Use agents / start a run | `AIAgent` | `read` |
| Create/edit drafts | `AIAgent` | `create` / `edit` |
| Publish versions | `AIAgentVersion` | `edit` |
| Pause/resume/archive | `AIAgentLifecycle` | `edit` |
| Tool administration | `AIAgentTool` | `edit` |
| Policy/limits/quota admin | `AIAgentPolicy` | `edit` |
| Provider configuration | `AIAgentProvider` | `edit` |
| Review approvals | `AIAgentApproval` | `read` / `edit` |
| Audit/timeline viewing | `AIAgentAudit` | `read` |
| Usage reporting | `AIAgentUsage` | `read` |
| Evaluation management | `AIAgentEvaluation` | `read` / `edit` |

Consequences, stated explicitly because they follow from the shared ACL:

- `sysAdmin` and `users.is_admin` hold every capability.
- A role with a `*` entry at `edit`/`yes` grants the new resources too, exactly as it already grants
  every future entity. This is the platform's documented wildcard rule, not an agent-specific bypass.
- A role with no `AIAgent` entry has **no** agent access at all (`AclApiService` returns `no`).
- Record-level and field-level checks are not applicable to synthetic resources; the **tools** that
  touch CRM records must still call `assertRecordAccess` / `canAccessRecord` per record.

---

## 5. Database and migration proposal

Next migration: `database/migrations/045_phase19_ai_agents.sql`.

Additive tables (all `CREATE TABLE IF NOT EXISTS`, no drops, no rewrites):

1. `ai_agents` — stable identity, draft config, lifecycle status, current published version pointer.
2. `ai_agent_versions` — immutable published configuration snapshot + checksum.
3. `ai_agent_tool_grants` — per-version tool grants and constraints.
4. `ai_agent_runs` — durable execution record, counters, lease, idempotency key, terminal state.
5. `ai_agent_run_events` — append-only ordered timeline (`run_id`, `seq`).
6. `ai_agent_tool_calls` — proposal/validation/execution ledger with argument hash and idempotency key.
7. `ai_agent_approvals` — proposed action, risk class, decision, revalidation result.
8. `ai_agent_provider_requests` — model request ledger with usage/cost and **no prompts by default**.
9. `ai_agent_budget_policies` — scoped request/token/cost/concurrency ceilings.
10. `ai_provider_connections` — provider endpoint + model allowlist + encrypted API key (write-only).

Deferred until their first consumer exists: conversations/messages, memory items, evaluation
suites/cases/runs. This follows §20 Phase 19-AI.3 ("only when their first implementation phase
needs them") and avoids empty tables that no code reads.

Retention/deletion semantics are defined in `architecture.md` §7; the sweeper job lands in AI.12/AI.19.

---

## 6. Security findings that constrain the implementation

1. **Secrets.** `ENCRYPTION_KEY` is optional and empty by default. Provider credential writes must
   fail with a clear message when it is absent; they must never fall back to plaintext
   (`email-accounts.service.ts` is the precedent).
2. **No prompt storage by default.** `ai_agent_provider_requests` stores hashes, counts, latency and
   normalized outcome, not raw prompts/completions.
3. **SSRF.** A provider `baseUrl` is administrator-supplied. Both `http` and `https` are accepted; credentials in   the URL are rejected; loopback is allowed only outside production and only when explicitly
   enabled for a self-hosted provider; redirects are not followed.
4. **Wildcard ACL.** A role's `*` entry grants the synthetic resources as described in §4. This is
   documented rather than hidden; high-risk actions still require approval policy in later phases.
5. **Prompt injection.** Retrieved CRM text is untrusted data. Nothing in this foundation treats model
   output as authority; the gateway only normalizes it.
6. **No arbitrary execution.** No SQL, shell, filesystem, browser or custom-code tool is added.
7. **Data minimisation.** Provider requests carry only the fields the caller sends; the gateway does
   not enrich them from the database.
8. **Test safety.** Routine tests use the fake adapter and never call a billable API. The configured
   primary database is used; no test database is created.

---

## 7. Safe verification commands

| Check | Command | Notes |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | API + web tsconfigs. |
| Lint | `pnpm lint` | `eslint . --max-warnings=0`. |
| Unit/integration tests | `pnpm test` | Vitest; boots the configured `DATABASE_URL`; no reset. |
| Build | `pnpm build` | Workspace build. |
| Migration | `pnpm db:migrate` | Applies pending **additive** files only. Inspect `045` first. |

Do **not** run anything that resets, truncates or recreates the database. The repository contains no
such test hook, and none may be added.

---

## 8. Dependency map

```text
                         +---------------------------+
                         |        AIAgentsModule     |
                         |  definitions / runs /     |
                         |  tools / approvals /      |
                         |  usage / evaluations      |
                         +------+------+------+------+
                                |      |      |
              +-----------------+      |      +------------------+
              |                        |                         |
      +-------v--------+      +--------v---------+      +--------v--------+
      |  AclApiService |      |   DatabaseService |      |   JobsService    |
      |  RequestScope  |      |   (Kysely/pg)     |      |   JobQueueService|
      +-------+--------+      +--------+----------+      +--------+---------+
              |                        |                         |
      +-------v--------+      +--------v----------+      +--------v---------+
      |  Metadata /    |      |  audit_log,       |      | worker runJob    |
      |  Entity Engine |      |  outbox_events    |      | job handlers     |
      +----------------+      +-------------------+      +------------------+
              ^
              |  tools call
      +-------+----------------------------------------------------------+
      | Sales | CustomerSuccess | ServiceDesk | MarketingAutomation |    |
      | Projects | Portal | Activities | Notifications                  |
      +------------------------------------------------------------------+

      AIProviderGateway --> AIProviderAdapter (openai-compatible | fake)
                          --> ai_provider_connections (encrypted key)
                          --> ai_agent_provider_requests (ledger, no prompts)
```

No arrow points from an owning domain back into `AIAgents`; optional integrations are one-way and
detected by metadata/table markers, never by imports.
