# Phase 19-INT.0 — Repository audit and feature contract

> `PLAN_Phase_19_Advanced_Integrations.md` §4 (Repository Audit and Architecture Decisions),
> §19 `19-INT.0`.
> Acceptance: repository findings cite concrete paths/services; scope is reduced to confirmed gaps;
> no code or schema changes are made until this audit is reviewed against actual conventions.
>
> **This phase changed no code, no migration and no schema.** The only database access was a
> read-only connectivity check against the configured primary project database (AGENTS.MD §3.1).

Audited: `AGENTS.MD`, `PLAN.md` (Phase 19), `PLAN_Phase_19_Advanced_Integrations.md`,
`PLAN_Phase_19_Sales.md`, `PLAN_Phase_19_Projects.md`, `PLAN_Phase_19_Customer_Success.md`,
`PLAN_Phase_19_ServiceDesk.md`, `PLAN_Phase_19_Marketing_Automation.md`,
`PLAN_Phase_19_AI_Agents.md`, `PLAN_Phase_19_Voice_Communications.md`, plus the whole working
tree: `apps/api` (357 TS files), `apps/web` (118 files), `apps/worker`, `packages/*` (18),
`modules/*` (3), `database/migrations` (55 files), `database/seed-metadata.ts`, `i18n/`,
`e2e/` (12 specs), `scripts/`.

---

## 1. What the platform already provides

| Capability | Where | What the module reuses |
| --- | --- | --- |
| Authentication | `apps/api/src/auth/auth.guard.ts` (`AuthGuard`, `@Public()`), `auth.service.ts` | Bearer sessions; a provider callback route opts out with `@Public()` |
| Authorization | `apps/api/src/acl/acl-api.service.ts` | `canUser`, `assertAccess`, `fieldAccess`, `visibleFields`, `stripRestricted`, `assertFieldWrites`, `recordPredicate`, `canAccessRecord`, `assertRecordAccess` |
| Users / Teams / Roles | `users`, `teams`, `roles`, `users_roles`, `users_teams` tables | Connection ownership and assignment targets |
| Generic record CRUD | `apps/api/src/entity/entity.service.ts` (`EntityCrudService`) | `list`, `get`, `related`, `create`, `update`, `remove`, `restore`, `massUpdate`, `massDelete`, `link`, `unlink` — the only write path a connector may use |
| Generic record API | `apps/api/src/entity/entity.controller.ts` | `GET/POST/PUT/PATCH/DELETE /api/v1/:entity` |
| Metadata / Entity Engine | `packages/entity-engine`, `packages/metadata`, `apps/api/src/metadata/metadata-store.service.ts`, `database/seed-metadata.ts` → `metadata_entries` | Metadata entities, relations, validation, layouts, ACL defaults, unique indexes on `entity_records` |
| Persistence | `kysely ^0.28.0` + `pg ^8.13.0` | SQL-first, parameterized query builder; `apps/api/src/database/database.service.ts` holds the typed `Database`/`DbTx` |
| Migrations | `database/migrate.ts` + `database/migrations/NNN_*.sql` | Ordered, transactional, tracked in `schema_migrations`; no reset/truncate path exists |
| Module settings | `app_settings` (one JSONB row per module) | `VoiceCommunicationsSettingsService` is the pattern: one validated, zod-shaped row |
| Job queue | `packages/jobs` (`JobRegistry`, `JobQueuePort`), `apps/api/src/jobs/jobs.service.ts` (`JobsService.enqueue`, `JOB_NAME` = 2–4 dot segments) | Durable `jobs`/`job_logs` rows; BullMQ + Redis carry the queue only |
| Scheduler | `apps/api/src/jobs/cron.ts` (`isValidCronExpression`), `apps/worker/src/schedule/scheduler.ts`, `scheduled_jobs` table, `cron-parser ^4.9.0` | Recurring schedules; `JobsService.schedule` |
| Retry / backoff | BullMQ `attempts` + exponential backoff (`jobAttempts`, `jobBackoffBaseMs` in `apps/api/src/config.ts`) | Bounded job retries — **no dead-letter store** |
| Transactional outbox | `outbox_events` table, `apps/api/src/common/outbox.service.ts`, `apps/api/src/events/event-bus.ts` (`EventBus.dispatch(tx, {type,payload})`) | Event row committed with the data that caused it |
| Outbox dispatcher | `apps/worker/src/outbox/outbox-poller.ts` (`CLAIM_SQL`, `MARK_RETRY_SQL` → `failed` at `maxAttempts`) | Read side, `attempts`/`available_at`/`last_error`. **Separate Postgres polling loop from the BullMQ queue** — the outbox is *not* enqueued as a job |
| Domain event catalog | `packages/core/src/domain-events/index.ts` | `entity.created|updated|deleted|restored`; `EventBus` accepts any `ns.Event` shape |
| Audit | `apps/api/src/audit` (`AuditHookService`, `registerAuditHook`), `audit_log` table | Every **metadata entity** mutation is audited by the **kernel hook**. A module that writes its **own tables** is *not* auto-audited — it must write `audit_log` rows itself |
| Module authorization | `apps/api/src/ai-agents/ai-agents-permission.service.ts` (synthetic permission resource per module right), `ADMIN_PERMISSION_ENTITY = "VoiceProviderAccount"` (`voice-communications-domain.ts:589`) | The platform's way to add module rights without a parallel role table: evaluate a synthetic resource through `AclApiService`, so the same role snapshot, `sysAdmin` bypass and wildcard rule apply |
| Activity stream | `apps/api/src/stream`, `stream_items` | Per-record feed |
| Secrets at rest | `packages/core/src/utils/crypto.ts` (`encryptSecret`/`decryptSecret`, AES-256-GCM, self-describing `v1:` payload), key from `ENCRYPTION_KEY` | Precedent in `email_accounts.smtp_password_encrypted`, `ai_provider_connections.api_key_encrypted`, `voice_provider_accounts.credential_encrypted` / `webhook_secret_encrypted` |
| Attachments / files | `apps/api/src/attachment`, `packages/files` | Not needed in INT.0; available later |
| Notifications | `notifications` table | Expiry / reauthorization notices |
| Provider adapter contract | `apps/api/src/ai-agents/ai-provider.ts` (`AIProviderAdapter`, `AIProviderRegistry`, `AIProviderError`, `categorizeHttpStatus`), `apps/api/src/voice-communications/voice-provider.ts` (`VoiceProviderAdapter`, `VoiceProviderRegistry`, `VoiceProviderError`) | **Two independent precedents, both fail-closed to `disabled`** |
| Provider account storage | `ai_provider_connections` (migration 045), `voice_provider_accounts` (migration 051) | Both encrypt the credential and expose only a *hint* |
| Optional-module detection | `OPTIONAL_INTEGRATIONS` + `markerEntity`/`markerTable` in each `*-module.ts`, detected by the matching `*-module-health.service.ts` | A connector that registers a marker entity makes the consumer report `available` with **no change to the consumer** |
| Outbound webhook delivery | `modules/webhook-integration` (`WebhookEndpointService`, `deliverWebhook` job, `assertPublicUrl` SSRF guard, `signBody` HMAC, delivery ledger) | Generic outbound event delivery already exists |
| Extension SDK | `packages/extension-sdk` | `db`, `enqueue`, `metadata`, `acl`, `principal`, `logger` — **no HTTP client, no secret store** |
| Test harness | `apps/api/test/helper.ts` (`bootTestApp`) | Boots against the **configured primary DB** (`buildConfig()` → `migrateDb` + `seed`); no test DB is created |
| Unit tests | `vitest.config.ts` → `apps/api/test/**/*.test.ts` + `packages/*/src/**/*.test.ts` | 103 API integration specs + 23 package unit specs |
| Browser tests | `playwright.config.ts` → `e2e/` (12 specs) | `webServer` boots the existing configured DB; creates no database |
| Frontend | `apps/web` (Vite 6 + React 18 + antd 5 + TanStack Query 5 + react-router-dom 7 + i18next) | See §5 |
| i18n | `i18n/{en,vi}/*.json` (7 catalogs), `apps/api/src/i18n/i18n.service.ts` | See §5.4 |

### 1.1 Negative findings (as important as the positive ones)

These are **absent**. No connector may assume them.

| Missing | Evidence |
| --- | --- |
| **OAuth 2.0 client** | No OAuth library in any `package.json`. `grep -i oauth` across `apps/`, `packages/`, `modules/` hits only `auth/auth.controller.ts`, `auth/auth.guard.ts`, `auth/auth.service.ts`, `config.ts`, `packages/core/src/logger/index.ts` — all CRM session auth, no authorization-code flow, no state/nonce/PKCE, no token refresh, no scope persistence |
| **Provider SDKs** | `googleapis`, `@microsoft/microsoft-graph-client`, `zoom`, `stripe`, `mailchimp`, `shopify`, `twilio`, `sendgrid` — none installed |
| **Generic inbound webhook ingress** | Two provider-specific implementations only, both email/voice-shaped (§3) |
| **External-ID registry** | `entity_links` is a *relation* store (`entity_type_a`, `record_id_a`, `relation_name`, `entity_type_b`, `record_id_b`) with a uniqueness constraint on the **link**, not on an external identifier. Nothing links "provider + provider object id" to a CRM record |
| **Sync cursor / checkpoint / watermark store** | No `syncToken`, `pageToken`, `checkpoint`, `cursor`, `watermark` column or table anywhere |
| **Generic idempotency-key store** | Idempotency is per-feature: `marketing_recipient_deliveries.idempotencyKey`, `MarketingJourneyStepExecution.idempotencyKey` (unique index `uq_entity_records_marketing_journey_step_idem`), and client-generated keys in Voice. No shared service |
| **Circuit breaker** | None |
| **Per-provider rate limiter** | `@fastify/rate-limit` is a global inbound limit (`RATE_LIMIT_MAX`, default 300/min) on the API, not an outbound per-connection provider quota. `apps/api/src/marketing-automation/marketing-provider-limiter.ts` is marketing-specific and not reusable as-is |
| **Metrics / telemetry** | No `prom-client`, no OpenTelemetry, no counters. Observability is `pino` logs, `audit_log`, `job_logs`, `stream_items` |
| **Shared provider HTTP client** | Outbound HTTP is global `fetch` (`modules/webhook-integration/src/delivery.ts`). `apps/api/src/ai-agents/ai-provider-url.ts` validates a URL but is AI-specific. No client with timeout + restricted redirect + per-host rate limit + retry hints |
| **Vendor connector code** | See §3.2 — **none** |
| **Dead-letter queue** | `outbox_events` reaches `failed` and is swept by `CLEANUP_OUTBOX_SQL` in `apps/worker/src/handlers/job-handlers.ts`. That is a cleanup, not a replayable dead-letter store |
| **Encryption key rotation** | One `ENCRYPTION_KEY` for all secrets; no key id / version column, no rotation path |

---

## 2. Capability matrix (PLAN §4.2)

Legend: **Reuse** = used unchanged · **Extend** = platform artifact extended additively · **Build** = this module implements it · **Out** = explicitly out of scope.

| Capability | Exists? | Reusable contract | Concrete gap | Action |
| --- | --- | --- | --- | --- |
| Authentication (CRM session) | Yes | `AuthGuard`, `@Public()` (`apps/api/src/auth/auth.guard.ts`) | — | Reuse |
| Authorization / ACL / field ACL | Yes | `AclApiService` (`apps/api/src/acl/acl-api.service.ts`) | No role scoped to integration administration yet | Reuse + Extend (new role/permission set) |
| OAuth 2.0 authorization-code flow | **No** | — | No state/nonce, no PKCE, no callback binding, no scope persistence, no refresh lock, no revocation | **Build** (19-INT.5) — ADR required |
| API-key / service-account credentials | Partial | `encryptSecret`/`decryptSecret` (`packages/core/src/utils/crypto.ts`); `ai_provider_connections.api_key_encrypted` | No vault, no key version, no rotation, no per-connection reference indirection | **Extend** the existing crypto primitive behind a narrow port; ADR required |
| Secret redaction helpers | Partial | `voice_provider_accounts.credential_hint`; provider adapters never log secrets | No shared redactor | Build (small, shared) |
| Job queue | Yes | `JobsService.enqueue` (`apps/api/src/jobs/jobs.service.ts`), `JOB_NAME` regex | None | Reuse |
| Scheduler / cron | Yes | `JobsService.schedule`, `apps/worker/src/schedule/scheduler.ts` | None | Reuse |
| Bounded job retry | Yes | BullMQ `attempts` (default 3) + `settings.backoffStrategy = min(2^attemptsMade * backoffBaseMs, backoffMaxMs)` (`apps/worker/src/queue/job-consumer.ts:42-45`) | Exponential **without jitter**; no `Retry-After` handling; no per-connection concurrency cap | Extend |
| Dead-letter store + replay | **No** | The worker logs `'bullmq job permanently failed (dead letter)'` (`job-consumer.ts:75`) and each attempt is its own `jobs` row | There is **no DLQ table** and no replay path. `outbox_events.failed` is swept by `CLEANUP_OUTBOX_SQL`, not replayable | **Build** (19-INT.11) |
| Rate limiting (outbound, per provider) | **No** | — | No per-connection/per-host quota. The closest shape is `apps/api/src/marketing-automation/marketing-provider-limiter.ts` — an in-memory sliding window exposing `check`/`run`/`reset`/`window`/`retryAfterSeconds` — but it is marketing-specific, in-memory (lost on restart) and not per-connection | **Build** (19-INT.11), reusing the limiter's *shape* |
| Circuit breaker | **No** | — | — | **Build** (19-INT.11) |
| Transactional outbox | Yes | `EventBus.dispatch` (`apps/api/src/events/event-bus.ts`) | None | Reuse |
| Outbound event delivery | Yes | `modules/webhook-integration` (`WebhookEndpointService`, `deliverWebhook`, `assertPublicUrl`, `signBody`) | Endpoint-based only; not connector-scoped; no per-connection egress policy | **Extend** / reuse for the generic outbound connector |
| Generic inbound webhook ingress | **No** | — | Two provider-specific implementations, different route shapes, different signature schemes, different dedup | **Build** a shared ingress + per-connector signature adapters (19-INT.12) |
| Raw-body capture for signature verification | **No** | — | `ProviderWebhookRequest.rawBody` exists in the Voice **contract** (`voice-provider.ts:74`) and the ingress reads it (`voice-webhook-ingress.service.ts:89`), but **no controller supplies it** and Fastify is built with `new FastifyAdapter({ logger: false, bodyLimit: 32 * 1024 * 1024 })` (`apps/api/src/bootstrap.ts:117`) — no raw-body plugin. HMAC-over-raw-body, which nearly every real provider requires, is impossible today | **Build** (19-INT.12) — confirm the plugin choice before 19-INT.5 |
| External-ID registry | **No** | `entity_links` is a relation store, not an ID registry | No provider+object→CRM record uniqueness | **Build** (19-INT.7) |
| Sync cursor / checkpoint store | **No** | — | — | **Build** (19-INT.9) |
| Domain events for CRM changes | Yes | `packages/core/src/domain-events/index.ts` (`entity.created` etc.) | No per-field "origin" marker to break echo loops | Reuse + Extend |
| Audit | Yes | Kernel `AuditHookService` + `audit_log` | Module-level actions (rotate, replay, resolve conflict) need explicit audit rows | Reuse + Extend |
| Metrics | **No** | — | No counters/histograms | **Build** a minimal one, or defer and rely on `jobs`/`audit_log` (ADR) |
| Logging | Yes | `packages/core/src/logger` (pino) | No redaction filter | Reuse + Extend |
| Connector adapter contract | Yes (×2) | `AIProviderAdapter` / `VoiceProviderAdapter` | Two divergent shapes; neither models pagination/cursor/objects | **Build one** `AdvancedIntegrations` contract modeled on both; ADR (19-INT.1) |
| Provider registry + capability model | Partial | `AIProviderRegistry` (code-only registration), `VoiceProviderRegistry` (`describeAll()`) | Not shared; no capability schema | **Build** (19-INT.3) |
| Provider account / connection storage | Partial | `ai_provider_connections`, `voice_provider_accounts` | Two shapes; no OAuth token/refresh/expiry columns; no ownership model | **Build** a dedicated table (do not overload either) |
| CRM record write path | Yes | `EntityCrudService.create/update` (`apps/api/src/entity/entity.service.ts`) | — | Reuse — a connector never writes `entity_records` directly |
| Metadata / Entity Engine | Yes | `packages/entity-engine`, `packages/metadata`, `database/seed-metadata.ts` | — | Reuse |
| Optional-module detection by marker | Yes | `OPTIONAL_INTEGRATIONS` + `markerEntity` in six modules | `PaymentProviderEvent` and `AccountingExport` are **reserved and absent** | Reuse — register those markers |
| Module settings | Yes | `app_settings` + `VoiceCommunicationsSettingsService` | — | Reuse |
| Admin navigation / panel | Yes | `apps/api/src/admin-panel/admin-panel.service.ts` (`ADMIN_PANEL_TABS`, has an `integrations` group), `navigation-defaults.ts` (`NAVIGATION_PAGES`, `NAVIGATION_ADMIN_ENTRIES`) | — | Reuse |
| Frontend admin shell | Yes | `apps/web/src/admin/AdminSettingsShell.tsx`, `apps/web/src/admin/tabs.ts` (`TAB_COMPONENTS`) | — | Reuse |
| Email transport | Yes | `packages/mail` (nodemailer), `email_accounts` | — | Reuse for notifications only |
| Test database | — | — | — | **Out** (AGENTS.MD §3.1) — use the configured primary DB |
| Vendor connectors (Google / Microsoft / Zoom / Stripe / Mailchimp / Meta / ecommerce / accounting / enrichment) | **No** | — | Everything | Build per tier (§4) |

---

## 3. Module boundaries

### 3.1 What `AdvancedIntegrations` owns

Provider registry · connection lifecycle and health · credential storage (encrypted, referenced) ·
OAuth state machine · external-object links · field mappings and transformations · sync runs,
operations and checkpoints · conflict records · inbound webhook receipts · outbound deliveries ·
rate limits, retry, dead letters · integration audit and run history.

### 3.2 What it must not own or duplicate

| Existing | Owns | `AdvancedIntegrations` |
| --- | --- | --- |
| `entity_records` + metadata entities | All CRM records | Reads/writes **only** through `EntityCrudService` |
| `SalesIntegrationService` (`apps/api/src/sales/integrations/sales-integration.service.ts`, `SALES_CONTRACT_VERSION = 1`) | Sales read contracts | Consumes; never reads Sales tables |
| `MarketingIntegrationService` (`apps/api/src/marketing-automation/marketing-integration.service.ts`) | Marketing cross-module surface | Consumes; never overrides consent |
| `VoiceProviderRegistry` / `VoiceProviderAccountsService` | Telephony providers | Separate registry; a telephony provider is **not** an integration connector |
| `AIProviderRegistry` (`apps/api/src/ai-agents/ai-provider.ts`) | Model providers | Separate registry; model providers are not connectors |
| `modules/webhook-integration` | Generic **outbound** webhook endpoints | May reuse; must not fork the delivery job |
| `audit_log`, `stream_items`, `outbox_events`, `jobs`, `app_settings` | Platform | Reuse |

### 3.3 The marker contract — already wired, waiting for a producer

Six modules declare optional integrations detected by a **metadata entity** (or a physical table).
Two of them name exactly what this module will produce:

| Consumer | Declared integration | Marker entity | Status today |
| --- | --- | --- | --- |
| Sales | `stripe-integration` | `PaymentProviderEvent` | **absent** — asserted `unavailable` in `apps/api/test/sales-module.test.ts:70,74` |
| Sales | `accounting-integration` | `AccountingExport` | **absent** |

Detection is `registered.has(integration.markerEntity)` over the metadata registry
(`apps/api/src/sales/sales-module-health.service.ts:144`); the AI Agents, Marketing, Voice,
Customer Success and Service Desk health services use the same pattern with a
`markerTable` fallback.

**Consequence:** when `AdvancedIntegrations` registers `PaymentProviderEvent` and
`AccountingExport` as metadata entities, Sales' health report flips both to `available`
**without a single change to Sales code**. This is the platform's intended integration seam and
must be used rather than inventing another one.

### 3.4 The existing webhook ingress implementations (the duplication surface)

There is **no shared generic webhook subsystem**. Two independent ingress implementations exist,
plus one outbound-only package:

| | Voice ingress | Marketing ingress | `modules/webhook-integration` |
| --- | --- | --- | --- |
| Route | `POST /api/v1/integrations/voice-communications/:providerKey/:accountKey/:kind` | `POST /api/v1/MarketingAutomation/webhook/:providerKey` (+ `webhooks/` alias) | `GET/POST/PUT/DELETE /api/v1/WebhookEndpoint` |
| Public | Yes (`@Public()`, `202`) | Yes (`@Public()`, `200`) | Admin-only, **outbound** |
| Signature | Delegated to the provider adapter (`adapter.validateWebhook`) — the ingress never invents a scheme | **Plain string equality** of the `x-webhook-signature` header against `MARKETING_WEBHOOK_SECRET` (`marketing-event-ingestion.service.ts:73-83`) — not an HMAC over the body | `signBody` HMAC on the **outbound** body |
| Replay window | Yes — `WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000` | No — `x-webhook-timestamp` is accepted but never used for verification | n/a |
| Body ceiling | Yes — `WEBHOOK_MAX_BODY_BYTES = 256 * 1024` | No | n/a |
| Raw body | Contract only; never supplied | No | n/a |
| Dedup | `webhookDedupKey()` → unique index `(account_key, dedup_key)`, `on conflict do nothing` | `dedup_key` = provider event id, else a composite; unique index `(provider, dedup_key)` | n/a |
| Receipt table | `voice_webhook_events` | `marketing_provider_webhook_inbox` | delivery ledger |
| Redaction | `redactPayload` (`voice-communications-domain.ts:531`) | `redactPayload` (`marketing-event-ingestion.service.ts:297`) — **duplicated** | — |

**Reading of this for `AdvancedIntegrations`:** the Voice ingress is the better-designed of the two
and is the natural template — signature delegated to a per-connector adapter, replay window, body
ceiling, idempotent dedup, an operator-visible receipt table. The Marketing ingress's plain string
comparison is a **security weakness** and must not be copied into a new connector.

**Scope decision:** `AdvancedIntegrations` builds a *third*, shared ingress rather than migrating
the existing two. Migrating Voice or Marketing webhooks would be unrelated scope for this module
and would risk live integrations; the two stay where they are.

**The raw-body dependency.** Almost every real provider signs the **exact bytes** it sent
(Stripe, Google, Mailchimp, Zoom, Meta, Shopify). Fastify is currently created without a
raw-body plugin (`apps/api/src/bootstrap.ts:117`), and the Voice controller reads only `@Body()`.
**A raw-body capture path must be designed and reviewed before 19-INT.5**, because the OAuth and
webhook verification contracts both depend on it.

---

## 4. Existing records the module must not duplicate

| Existing | Why it is not reusable here |
| --- | --- |
| `ai_provider_connections` | Model providers: `kind` is `openai-compatible`/`fake`; one base URL + models list. No OAuth, no scopes, no token refresh, no objects, no sync |
| `voice_provider_accounts` | Telephony: `environment`, `capabilities`, one credential + one webhook secret. No token set, no object mapping |
| `marketing_provider_webhook_inbox` | Email-specific: `campaign_id`, `send_id`, `recipient_entity_*`. A general receipt store needs provider, connection, object and delivery key |
| `voice_webhook_events` | Voice event kinds only |
| `entity_links` | A relation store (uniqueness is on the **link**, not on an external identifier). `entity_records.attrs->>'sourceEntity'` / `->>'sourceId'` is **internal CRM provenance** (record → parent), not a provider-object link |
| `saved_filters` | Saved UI filters, not sync checkpoints |
| `api_keys` | CRM API keys for the CRM's own API — not provider credentials |
| `email_accounts` | SMTP/IMAP mailboxes. A Gmail connector must not create a mailbox row. `packages/mail` does expose an `InboundMailProvider` port, which is the intended seam for a Gmail/Graph mail adapter |

### 4.1 Revised by 19-INT.1–19-INT.5

Two decisions in this table were **provisional** and were revised once the implementation began. The
reasoning is recorded in `docs/modules/advanced-integrations/feature-contract.md` §7.

| Provisional | Revised to | Why |
| --- | --- | --- |
| Connections live in `entity_records` as a metadata entity | Connections live in a **dedicated table** (`integration_connections`, migration 056) | A metadata entity is reachable through the generic `/api/v1/:entity` API. A `PATCH /api/v1/IntegrationConnection/:id` would move a connection between states **without passing the state machine**. Control-plane state must not be reachable that way |
| The plan's §6.1 `IntegrationDefinition` is a database row | Provider definitions are **code-registered** in `IntegrationRegistry` | It matches the repository's own precedent (`AIProviderRegistry`, `VoiceProviderRegistry`), it cannot drift from the adapter that implements it, and it needs no seeding on every start (AGENTS.md §3.3) |

The credential storage decision (ADR 0001 — the existing AES-256-GCM primitive behind a narrow
vault port) was **confirmed unchanged**.

---

## 5. Frontend conventions (for 19-INT.14/15)

`apps/web` has 118 files: `admin/`, `pages/`, `components/`, `api/`, `state/`, `styles/`, `types/`.

1. **Routing** — `apps/web/src/AppRoutes.tsx`. A static route must be declared **before** the
   entity wildcard (`<Route path="/:entity" …>`), otherwise the first segment is read as an entity
   name. Comments at `AppRoutes.tsx:114-119`.
2. **Navigation is server-owned.** Sidebar pages come from `NAVIGATION_PAGES`
   (`apps/api/src/admin-panel/navigation-defaults.ts:45`); admin rail tabs from `ADMIN_PANEL_TABS`
   (`apps/api/src/admin-panel/admin-panel.service.ts:46`). The `integrations` group **already
   exists** — a new module tab belongs there. `permission: { entity, action }` gates visibility;
   the server still enforces every endpoint.
3. **Admin tab = three edits** — a row in `ADMIN_PANEL_TABS`, a lazy entry in
   `apps/web/src/admin/tabs.ts` (`TAB_COMPONENTS`), and the component in `apps/web/src/admin/tabs/`.
   The shell owns the Save/Discard/Reload bar (`apps/web/src/admin/shell.tsx`,
   `usePublishTabActions`); a tab never draws its own button row.
4. **API client** — the real client is `apps/web/src/api/client.ts` (relative `/api/v1`, bearer
   token from `localStorage['carocrm.accessToken']`, 401 → `POST /api/v1/Refresh` → replay).
   `packages/api-client` is a **one-line placeholder stub** — do not put new client code there.
   Types go in `apps/web/src/api/types.ts` (`<Thing>View` / `<Thing>Row` / `<Thing>ListResult`).
5. **UI primitives** — antd 5 only. `Table` (server-paged on the generic entity list, client-paged
   on module pages), antd `Form` (`react-hook-form` is declared but **completely unused** — do not
   use it), `Card className="carocrm-card"`, `Typography.Title level={4} className="carocrm-page-title"`.
   Shared states: `components/EmptyState.tsx`, `ErrorState.tsx`, `PermissionDenied.tsx`,
   `LoadingSkeleton.tsx`. Toasts via `AntApp.useApp()` → `message`.
6. **Never render a secret** — the established pattern is `hasCredential` + `credentialHint`
   (`apps/web/src/api/types.ts:1876-1879`, `VoiceCommunicationsPage.tsx`,
   `AIAgentsProviderConnection`).
7. **Status is never colour-alone** — pair the antd `Tag` colour with a text label
   (`apps/web/src/pages/ai-agents/shared.tsx:5-10`).
8. **No frontend unit-test harness.** `vitest.config.ts` includes only `apps/api/test/**` and
   `packages/*/src/**`; `apps/web` is excluded and there is no jsdom/`@testing-library` setup.
   Frontend verification today is **Playwright only** (`e2e/`, 12 specs).

### 5.4 i18n namespace — a real constraint

`apps/api/src/i18n/i18n.service.ts` enforces two rules:

- the catalog **file** name must match `/^[a-z][a-z0-9]*$/` (`:78-80`) → `advancedintegrations.json`
  is valid, `advancedIntegrations.json` is not;
- every key must match `KEY_RE = /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/` (`:22`) → the
  **first** segment is lowercase, later segments may be camelCase.

Precedent: dedicated lowercase namespace files exist for domain modules — `voice.json` → `voice.*`,
`sales.json` → `sales.*`, `marketing.json` → `marketing.*` — while the SPA-wide `web.json` holds
`web.aiAgents.*`, `web.serviceDesk.*`, `web.marketingAutomation.*`.

**Decision for INT.0:** a dedicated `i18n/{en,vi}/advancedintegrations.json` with
`advancedintegrations.*` keys, matching the `voice`/`sales`/`marketing` precedent. A camelCase
top-level `advancedIntegrations.*` namespace is **not expressible** without changing `KEY_RE`.

---

## 6. Persistence, migrations and the test harness

- **Driver** — Kysely `^0.28.0` over `pg ^8.13.0`. `apps/api/src/database/database.service.ts`
  exposes the typed `Database` and `DbTx`; queries are built through the query builder
  (parameterized). Raw `sql` templates appear where a builder cannot express the statement and
  are still parameterized.
- **Migrations** — `database/migrations/NNN_*.sql`, 55 files, applied in filename order by
  `database/migrate.ts`, each inside its own transaction, tracked in `schema_migrations`.
  **There is no reset/truncate/drop path anywhere in the repository.** A new module's migration
  must be additive (`056_*.sql` onward) and reviewed before it is applied.
- **Records** — two shapes are in use and both are precedented:
  * *metadata entities* in `entity_records` (`database/seed-metadata.ts` → `metadata_entries`),
    with `acl.permissions` defaults and unique indexes such as
    `uq_entity_records_marketing_journey_step_idem`;
  * *dedicated physical tables* for provider-specific state
    (`voice_provider_accounts`, `ai_provider_connections`, `marketing_provider_webhook_inbox`).
  Integration connections, mappings, sync runs and conflicts are **control-plane state, not CRM
  records** — dedicated tables (like `voice_provider_accounts`) are the right home; only the
  CRM-side linked record belongs in `entity_records`.
- **Tests** — `apps/api/test/helper.ts` `bootTestApp()` calls `buildConfig()` → `migrateDb(config.databaseUrl)`
  → `seed(...)` → `createApp(config, { skipMigrations: true })`. It therefore runs against the
  **configured primary project database** and creates no test database, exactly as AGENTS.MD §3.1
  requires. New integration specs must follow the established convention: unique run markers
  (`AGENT_TEST_…`), targeted cleanup by known id, no global deletes.
- **Verified during this audit** (read-only): the configured database is reachable, has 95 tables
  in `public`, 55 applied migrations and 110 `metadata_entries` rows. No database was created,
  dropped, truncated or migrated.

---

## 7. First release provider set

The plan asks to "confirm the first release provider set with tiers; prefer one end-to-end
connector path to validate the framework before expanding" (§19 `19-INT.0`).

### 7.1 Recommendation

| Order | Connector | Tier | Why it is in the first release |
| --- | --- | --- | --- |
| 1 | **Generic REST API** connector | Tier 0 | Validates the whole framework — mapping, transformation, cursor/checkpoint, conflicts, retry, idempotency — with **no vendor credentials, no OAuth and no external account**. Fully testable against a fake adapter, which is what AGENTS.MD §3.3 and the plan's non-negotiable rules require of tests |
| 2 | **Google Workspace** (Calendar + Contacts) | Tier 1 | The first **OAuth** connector. OAuth is the platform's single largest gap (§1.1) and the riskiest thing to validate last. Google Calendar also exercises a real incremental cursor (`syncToken`) and a real partial-failure mode (per-calendar selection) |

Everything else stays at its plan tier (§7.2) and is not started until the framework is proven.

### 7.2 Tier assignment (from plan §2.4, unchanged)

| Tier | Providers | Notes |
| --- | --- | --- |
| 0 | Generic REST / outbound webhook; the shared control plane | The framework itself |
| 1 | Google Workspace, Microsoft 365, Zoom, Stripe | Productivity + payments. Gmail/Outlook transport stays with `packages/mail` |
| 2 | Mailchimp, Meta Lead Ads | Marketing signals only; consent stays with `MarketingAutomation` |
| 3 | Ecommerce (Shopify/WooCommerce), accounting (QuickBooks/Xero), data enrichment | First provider of each family is chosen **after** this audit. `AccountingExport` is already reserved as a Sales marker |

**Not decided here, deliberately:** the ecommerce, accounting and enrichment providers, the live
API versions and the exact OAuth scopes for each connector. The plan requires those to be pinned
from each vendor's **current official documentation** during that connector's own audit phase
(§3.2), so claiming them now would be unverified. The provider matrix
(`docs/compatibility/advanced-integrations/provider-matrix.md`) records the scope of each
connector and marks those fields "to be pinned at connector audit".

---

## 8. Gaps to build, in dependency order

| # | Gap | Lands in |
| --- | --- | --- |
| 1 | Connector adapter contract (objects, pagination, cursor, normalized errors) | 19-INT.6 |
| 2 | Connection + credential storage, redaction | 19-INT.4 |
| 3 | OAuth state machine (state, nonce, PKCE, refresh lock, revocation) | 19-INT.5 |
| 4 | External-ID registry + record resolution | 19-INT.7 |
| 5 | Mapping + safe transformation compiler | 19-INT.8 |
| 6 | Sync orchestrator + checkpoint store | 19-INT.9 |
| 7 | Conflict records + deletion policy | 19-INT.10 |
| 8 | Retry / rate limit / circuit breaker / dead letters | 19-INT.11 |
| 9 | Shared inbound webhook ingress + per-connector signature adapters | 19-INT.12 |
| 10 | Outbound sync, echo prevention, outbox wiring | 19-INT.13 |
| 11 | Admin UX (catalog, wizard, mapping builder, runs, conflicts) | 19-INT.14 / 19-INT.15 |
| 12 | Google Workspace connector | 19-INT.16 |
| 13 | Microsoft 365 connector | 19-INT.17 |

The provider registry / capability model (19-INT.3) and module registration (19-INT.2) sit between
(1) and (2) and are prerequisites for the admin UX.

---

## 9. Open decisions carried into 19-INT.1 (ADRs)

1. **Secrets storage** — extend `encryptSecret` with a key-version column, or introduce a vault
   port with a local implementation? *Recommendation: narrow vault port + the existing AES-256-GCM
   primitive behind it, with key id stored alongside the payload.*
2. **Generic adapter contract** — one shape covering every connector, or a shared core plus
   per-family extensions? *Recommendation: one shape; the two existing precedents
   (`AIProviderAdapter`, `VoiceProviderAdapter`) are inputs, not templates to fork.*
3. **Job topology** — one job per run, or per-page/per-object jobs? What is the retry unit?
   *Recommendation: per-run job with per-object operations persisted; retry at the operation level
   so a retry never re-reads a whole page.*
4. **Webhook ingestion reuse** — extend the two existing provider ingresses, or add a third shared
   one? *Recommendation: a third shared ingress; the existing two stay where they are and are not
   migrated in this phase (that would be unrelated scope).*
5. **Connection ownership** — organization-level only, or user-level too? The plan permits both
   "only where required". *Recommendation: organization-level for the first release; user-level
   deferred until a connector requires it.*
6. **Metrics** — build a minimal counter facility, or rely on `jobs` + `audit_log` + logs?
   *Recommendation: no new telemetry dependency in the first release; derive run health from
   `jobs`/`job_logs` and an `audit_log` trail.*
7. **CRM-side record shape for links** — metadata entities in `entity_records` with unique
   indexes, or dedicated tables? *Recommendation: dedicated tables for control-plane state;
   `entity_records` only for CRM records.*

---

## 10. Verification performed in this phase

| Check | Result |
| --- | --- |
| `git status` before/after | Clean — **no code, no migration, no schema change** |
| Database connectivity (read-only) | OK — configured primary DB `carocrm_dev`, 95 tables, 55 migrations applied, 110 metadata entries |
| Database creation / reset / truncate | **None performed, none exists in the repository** |
| Vendor-code sweep (`googleapis`, `graph.microsoft`, `zoom`, `stripe`, `mailchimp`, `facebook`, `shopify`, `woocommerce`, `quickbooks`, `xero`, `twilio`, `sendgrid`, `slack`, `hubspot`, `salesforce`) | **No vendor integration code.** Every hit is a comment, a documentation reference or an unrelated identifier (e.g. `MAX_STEPS_SLACK` in `packages/bpm/src/advance/index.ts`, `"stripe"` as a generic word in `apps/api/src/sales/payments/payment.service.ts:41`) |
| OAuth sweep | No OAuth client exists; only CRM session auth |
| Dependency sweep (`package.json` of all 21 workspaces) | No OAuth library, no provider SDK, no metrics/telemetry library; `kysely`, `bullmq`, `ioredis`, `cron-parser`, `zod`, `jose`, `argon2`, `pino` present |
| Baseline typecheck | `pnpm typecheck` → **PASS** (`tsc --noEmit` for the API and the web app) |
| Baseline test suite | `pnpm test` → **PASS — 131 test files, 1682 tests, 0 failures**, 83.9 s, against the configured primary database |
| Baseline lint | `pnpm lint` → **FAIL — 6 errors, all pre-existing** in files this phase did not touch: `apps/api/src/app.module.ts` (import sort), `apps/api/src/setup-checklist/index.ts` (export sort), `apps/web/src/admin/AdminSettingsShell.tsx` (import sort), `apps/web/src/pages/DashboardsPage.tsx:51` and `apps/web/src/pages/EntityListPage.tsx:376-377` (forbidden non-null assertion). `git status` confirms all five are unmodified. Left unfixed on purpose — fixing unrelated lint is outside this phase's scope |

### 10.1 Repository-wide database-safety review

Every script and hook in the repository was inspected for database creation or destruction. The
result is that **no code path in this repository creates, drops, truncates, resets or shadows a
database**:

| Script | Behaviour | Classification |
| --- | --- | --- |
| `pnpm db:migrate` (`database/migrate.ts`) | Applies pending `database/migrations/NNN_*.sql` in order, each in its own transaction, tracked in `schema_migrations` | **Safe** — additive only |
| `pnpm db:seed` (`database/seed.ts`) | Seeds the admin user and metadata | **Safe** — no table clearing |
| `pnpm test` (`vitest run`) | `apps/api/test/helper.ts` boots against `buildConfig().databaseUrl` — the configured primary DB | **Safe** — no test database |
| `pnpm test:e2e` (`scripts/e2e-smoke.sh`) | Boots a server on a scratch port against the configured DB, `RUN_ID="e2e-$(date -u +%Y%m%d%H%M%S)-$$"`, `MAIL_TRANSPORT=memory`, `JOB_QUEUE_NAME=crm-jobs-test`, `STORAGE_ROOT=".data/e2e-${RUN_ID}"` | **Safe** — the script itself documents AGENTS.MD §3.1/§5.5 compliance |
| `pnpm demo:projects` / `:purge` (`scripts/projects-demo.ts`) | Seeds and purges a demo set identified by a `demo` id prefix | **Narrow** — a precise-prefix delete, not a global one. Not run in this phase |
| `pnpm build` / `lint` / `typecheck` | No database access | **Safe** |

There is no `docker compose down -v`, no `DROP DATABASE`, no `TRUNCATE`, no `prisma migrate reset`
and no shadow-database configuration anywhere in the tree.

**Not verified:** no runtime behaviour was exercised. Every statement above is from source
inspection or a read-only query.

### 10.2 Test-run residue and its cleanup

`pnpm test` writes to the configured primary database, and the existing suite leaves `jobs` rows
behind (rows from runs on 2026-10-11 through 2026-10-19 were already present before this phase).
After this phase's run, **21** job rows created inside the run window
(`2026-10-20T00:52:00Z` – `00:56:00Z`, all from the test suites'
`marketing.deliveryBatch`, `voiceCommunications.processWebhookEvent`,
`voiceCommunications.fetchMedia`, `customerSuccess.recalculateHealthBatch` and `system.sendEmail`
jobs) were removed **by exact primary key**, together with any `job_logs` rows referencing them
(none existed). The removal ran inside a transaction with a `FOR UPDATE` selection and was
committed only after verifying the row count.

Post-cleanup state, identical to the pre-run reading:

| Measure | Before the run | After the run |
| --- | --- | --- |
| Tables in `public` | 95 | 95 |
| Applied migrations | 55 | 55 |
| `metadata_entries` rows | 110 | 110 |
| Job rows in the run window | — | 0 |

No table was created, dropped, truncated or migrated; no metadata was changed; no record outside
the 21 identified rows was touched.

---

## 11. Delivery after 19-INT.5

The audit's §2 capability matrix is now partly implemented. What changed since it was written, and
what the implementation verified.

### 11.1 What the implementation confirmed

| Audit finding | Outcome |
| --- | --- |
| No OAuth client exists | **Now exists** — a platform-owned OAuth flow (`oauth-flow.service.ts`) with a hashed single-use state, PKCE, an allowlisted redirect URI and a per-connection refresh lock. The *provider-side* HTTP work is still 19-INT.6's job |
| No raw-body capture | **Still absent** — unresolved dependency **U-1**. It gates 19-INT.12, not the OAuth flow |
| No external-ID registry / no cursor store | **Still absent** — 19-INT.7 and 19-INT.9 |
| No DLQ, no circuit breaker, no per-provider rate limiter | **Still absent** — 19-INT.11 |
| No metrics facility | **Still absent** — health is derived from `jobs`, `audit_log` and the module's own rows |
| Two provider-specific webhook ingresses, no shared one | **Unchanged** — ADR 0004 keeps both where they are and adds a third in 19-INT.12 |
| Connections as `entity_records` | **Revised** — dedicated table, so the generic entity API cannot bypass the state machine (§4.1) |
| Provider definitions as database rows | **Revised** — code-registered, so capabilities cannot drift from the adapter (§4.1) |
| Secrets at rest via the existing primitive | **Confirmed unchanged** — ADR 0001 |

### 11.2 Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **PASS** (root + `apps/api/tsconfig.json`, which also covers the test files) |
| `pnpm lint` | **5 errors, all pre-existing** in files this work did not touch: `apps/api/src/setup-checklist/index.ts`, `apps/web/src/admin/AdminSettingsShell.tsx`, `apps/web/src/pages/DashboardsPage.tsx:51`, `apps/web/src/pages/EntityListPage.tsx:376-377`. The 9 errors this work introduced were autofixed in the module's own files only |
| `pnpm test` | **PASS — 132 test files, 1708 tests, 0 failures**, 94.5 s. The new suite contributes 26 tests in `apps/api/test/advanced-integrations.test.ts` |
| Migration `056` | Applied to the configured primary database; verified column-by-column against the file; re-running `pnpm db:migrate` reports *up to date* |
| Database safety | 98 tables (95 + 3 new), 56 migrations (55 + 1), `metadata_entries` unchanged at 110. **No database created, dropped, truncated or reset.** After the suite: 0 rows in all three new tables, 0 module notifications, 0 leftover test users or roles |
| i18n parity | `i18n/en/advancedintegrations.json` and `i18n/vi/advancedintegrations.json` — 58 keys each, no key missing on either side |

### 11.3 What was deliberately left out

| Omitted | Why | Lands in |
| --- | --- | --- |
| The sidebar navigation entry and the admin panel tab | A navigation entry names a real SPA route. Registering it before the page exists ships a dead link | 19-INT.14 |
| The `PaymentProviderEvent` / `AccountingExport` marker entities | Registering them now would make Sales report `stripe-integration` as **available** while no Stripe connector exists | 19-INT.19 / 19-INT.23 |
| A metadata entity for the module | The module's state is control-plane and must not be reachable through the generic entity API | — |
| Any connector | No connector is enabled by default (19-INT.1 acceptance) | 19-INT.16+ |

