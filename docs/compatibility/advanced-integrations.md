# Advanced Integrations — compatibility and behavior reference

> Phase 19-INT.0 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §3.3, §4.2, §19 `19-INT.0`).
> Status: **audit complete; no connector implemented**.
> Canonical module name: `AdvancedIntegrations` (no `Ua` prefix). API prefix:
> `/api/v1/AdvancedIntegrations`; proposed webhook prefix:
> `/api/v1/integrations/advanced-integrations`.
> Repository audit: `docs/implementation/advanced-integrations-audit.md`.
> Provider matrix: `docs/compatibility/advanced-integrations/provider-matrix.md`.

This document records the external behavior this module reimplements, the decisions taken against
the repository as it actually exists, and the compatibility limits a deploying organization must
know. A provider is **not** listed as supported until its connector and its end-to-end behavior
pass the relevant tests.

---

## 1. Functional reference

The product behavior is CRM-oriented connectivity — connecting approved third-party systems to
CRM records and keeping them in sync — not a general-purpose integration platform.

| Behavior | Reference | Implementation status |
| --- | --- | --- |
| Browse a registry of supported providers, their capabilities and setup requirements | Plan §1.1.1 | **Delivered (19-INT.3)** — `GET /api/v1/AdvancedIntegrations/action/providers` |
| Create, validate, enable, pause, reconnect, rotate and revoke a connection | Plan §1.1.2 | **Delivered (19-INT.4)** — the state machine, the vault and the lifecycle service |
| Organization-level and user-level connection ownership | Plan §1.1.3 | **Delivered (19-INT.4)** — organization-level is the default; user-level is supported by the data model (feature contract §4) |
| OAuth 2.0 authorization, refresh, minimum-scope consent, expiry, revocation, reconnect | Plan §1.1.4 | **Delivered (19-INT.5)** — single-use hashed state, PKCE, allowlisted redirect, scope verification, per-connection refresh lock. Still **no connector is registered**, so no provider can use it yet |
| One-way and two-way sync per supported object | Plan §1.1.5 | Not started (19-INT.9) |
| Map CRM entities and fields to provider objects, with transformations, defaults and filters | Plan §1.1.6 | Not started (19-INT.8) |
| Initial full sync, then incremental/delta sync where the provider supports it | Plan §1.1.7 | Not started (19-INT.9) |
| Queue inbound and outbound changes asynchronously with rate limits, bounded retries, backoff, idempotency and dead letters | Plan §1.1.8 | Platform job queue is reused; dead letters, provider rate limits and circuit breaking are **new** (audit §2) |
| Detect duplicates and conflicts without silently overwriting CRM data | Plan §1.1.9 | Not started (19-INT.10) |
| Receive provider webhooks through a secure endpoint with signature validation, replay protection, deduplication and fast acknowledgement | Plan §1.1.10 | Not started (19-INT.12). No generic ingress exists today (audit §1.1) |
| Inspect connection health, sync lag, error rates, quotas, next runs and webhook failures | Plan §1.1.11 | Partly delivered — the module health endpoint exists (19-INT.2); sync lag, quotas and webhook failures arrive with 19-INT.14. **No metrics facility exists** (audit §1.1) |
| Keep a redacted audit trail of credential, configuration, sync, conflict and replay actions | Plan §1.1.12 | Kernel audit hook is reused; module-level actions need explicit rows (audit §2) |
| Use connector-specific integration points with the named providers by delivery tier | Plan §1.1.13 | Not started; see the provider matrix |
| Add future connector packages through a documented adapter contract | Plan §1.1.14 | The **capability declaration** and the registry contract landed in 19-INT.3; the full typed port lands in 19-INT.6 |

Reference pages (unchanged from the plan §3.1/§3.2): EspoCRM extension catalog, EspoCRM Google /
Outlook / Zoom / Stripe / Mailchimp integrations, EspoCRM webhook administration; Google Calendar
incremental sync, Google OAuth 2.0, Microsoft Graph delta query and change notifications, Zoom
webhooks, Stripe webhooks and idempotent requests, Mailchimp webhooks, Meta Lead Ads, Shopify
webhooks and delivery verification, QuickBooks Online, Xero accounting.

This is a clean-room reimplementation. No EspoCRM PHP class, frontend asset, icon, translation or
branding is copied. Provider behavior is treated as a versioned external contract; each adapter
must verify the provider's current documentation when it is implemented.

---

## 2. Decisions taken from the repository audit

The audit is `docs/implementation/advanced-integrations-audit.md`. The decisions that shape every
later sub-phase:

| Decision | Outcome | Evidence |
| --- | --- | --- |
| Where the module lives | A directory under `apps/api/src/advanced-integrations`, registered through an `index.ts` barrel exporting `ADVANCED_INTEGRATIONS_CONTROLLERS` / `ADVANCED_INTEGRATIONS_PROVIDERS`, spread into `AppModule` **before** `ENTITY_CONTROLLERS` | `apps/api/src/voice-communications/index.ts`, `apps/api/src/app.module.ts:126-135` |
| Where the module's state lives | Dedicated physical tables (`integration_connections`, `integration_credential_secrets`, `integration_oauth_states`); CRM records stay in `entity_records` | Precedent: `voice_provider_accounts`, `ai_provider_connections` vs `entity_records`; migration `056_phase19_advanced_integrations.sql` |
| Persistence | Kysely over the existing `DatabaseService`; no second ORM | `kysely ^0.28.0` in every relevant `package.json` |
| Migrations | One additive file, `056_phase19_advanced_integrations.sql`, reviewed before it is applied | `database/migrate.ts`, `database/migrations/` |
| How a connector registers itself | **Code-registered** in `IntegrationRegistry`, with a versioned capability declaration validated at registration and at startup | `apps/api/src/advanced-integrations/integration-registry.service.ts`, `provider-capabilities.ts` |
| How a consumer module detects a connector | The marker-entity contract still applies — `PaymentProviderEvent` and `AccountingExport` are registered when the Stripe and Accounting connectors arrive (19-INT.19 / 19-INT.23) | `OPTIONAL_INTEGRATIONS` in six `*-module.ts` files; `apps/api/src/sales/sales-module-health.service.ts:144` |
| Credentials | AES-256-GCM through the existing `encryptSecret`/`decryptSecret`, behind a narrow `CredentialVaultPort`, exposed only as `hasCredential` + `credentialHint` | `packages/core/src/utils/crypto.ts`; `apps/api/src/advanced-integrations/credential-vault.ts` |
| Where background work runs | The existing `JobsService` + BullMQ; job names follow `JOB_NAME` = 2–4 dot segments, camelCase allowed | `apps/api/src/jobs/jobs.service.ts:22`; `apps/worker/src/handlers/advanced-integrations-handlers.ts` |
| Where CRM changes come from | The transactional outbox (`entity.created`/`updated`/`deleted`/`restored`) | `packages/core/src/domain-events/index.ts`, `apps/api/src/events/event-bus.ts` |
| How a connector writes a CRM record | Only through `EntityCrudService` — never directly into `entity_records` | `apps/api/src/entity/entity.service.ts:191,207` |
| How a connector is authorized | The kernel ACL through synthetic permission resources, plus a capability gate | `apps/api/src/acl/acl-api.service.ts`, `advanced-integrations-permission.service.ts` |
| Where the admin UI lives | A tab in the **existing** `integrations` group of the admin panel, plus a sidebar page seed — **registered with 19-INT.14**, together with the SPA page they point at | `apps/api/src/admin-panel/admin-panel.service.ts:46`, `navigation-defaults.ts:45` |
| How the admin UI talks to the API | `apps/web/src/api/client.ts`; types in `apps/web/src/api/types.ts` | `packages/api-client` is a placeholder stub |
| Translation namespace | A dedicated lowercase catalog `i18n/{en,vi}/advancedintegrations.json` → `advancedintegrations.*` | `apps/api/src/i18n/i18n.service.ts:22,78-80`; precedent `voice.json`, `sales.json`, `marketing.json` |
| Testing | Unit tests in `packages/*/src/**` or `apps/api/test/**`; fake provider adapters only; the configured primary database only | AGENTS.MD §3; `apps/api/test/helper.ts`; plan non-negotiable rules |

---

## 3. Compatibility limits a deployment must know

1. **No connector is enabled by default.** A fresh installation has the module, an empty provider
   registry and no connections.
2. **No vendor credentials, partner approval or production account is implied** by a provider
   appearing in the matrix. The matrix records *intent*, not availability.
3. **Provider API versions and OAuth scopes are pinned at each connector's own audit phase**, from
   the vendor's current official documentation. Until a row in the provider matrix is marked
   *pinned*, treat that connector's contract as undefined.
4. **Two-way sync is never implicit.** Every mapping states the authority per direction and per
   field; enabling a bidirectional mapping requires an explicit confirmation.
5. **A provider delete never hard-deletes a CRM record** by default. Deletion semantics are
   per-mapping and default to unlink or archive.
6. **Secrets are never returned by an API response.** Read endpoints expose `hasCredential` and a
   non-secret `credentialHint` only.
7. **A missing or misconfigured provider fails closed.** An unknown connector key resolves to a
   disabled adapter that performs no external call, following the existing
   `VoiceProviderRegistry` behavior.
8. **Webhook endpoints are unauthenticated by design** (a provider holds no CRM session) and are
   authenticated by the provider's own signature, verified before any effect occurs. An endpoint
   key is a routing identifier, not a secret.
9. **The platform has no metrics/telemetry facility.** Health and lag reporting in the first
   release are derived from `jobs`, `job_logs` and `audit_log` unless the metrics ADR says
   otherwise.
10. **No test database exists and none will be created.** Integration specs run against the
    configured primary project database with uniquely identifiable records.

---

## 4. Module boundary summary

| Concern | Owner | `AdvancedIntegrations` responsibility |
| --- | --- | --- |
| Provider registry, credentials, connection state | `AdvancedIntegrations` | Owns |
| Generic sync jobs, checkpoints, cursors, retry, idempotency | `AdvancedIntegrations` | Owns, on the platform's job/outbox infrastructure |
| CRM entity data and business rules | Core / domain module | Calls `EntityCrudService` and honors domain validation |
| Product / quote / order / invoice / payment lifecycle | `Sales` | Maps provider objects onto `SalesIntegrationService` read contracts; never into Sales tables |
| Projects and activity business objects | `Projects` / core Activities | Maps supported provider objects onto stable contracts |
| Onboarding, health score, customer risk | `CustomerSuccess` | May sync approved fields; never computes CSM health |
| Tickets and support conversations | `ServiceDesk` | May sync ticket fields/events through supported contracts |
| Campaigns, journeys, consent, unsubscribe | `MarketingAutomation` | May sync audience/member/campaign signals; never overrides consent |
| Telephony, SMS, WhatsApp, inbox | `VoiceCommunications` | Never implements communication delivery |
| Agent runtime and tool execution | `AIAgents` | Optional protected assistive use only |
| Auth, ACL, audit, jobs, attachments, outbox, settings, navigation | CRM Core | Reuses; extends only through approved interfaces |

---

## 5. Compatibility artifacts still to be authored

The plan §3.3 lists six artifacts. This phase delivers the first two; the remaining four are
**per-connector** documents and are deliberately **not** written here, because their content
(authentication type, exact scopes, object coverage, pagination model, signature scheme, cursor
expiry, quota behaviour) can only be recorded truthfully after each vendor's current official
documentation is reviewed at that connector's audit phase.

| Artifact | Status |
| --- | --- |
| `docs/compatibility/advanced-integrations.md` | **This document** |
| `docs/compatibility/advanced-integrations/provider-matrix.md` | **Delivered** (initial version) |
| `docs/compatibility/advanced-integrations/providers.md` | Pending — authored per connector in 19-INT.16/17/18/19 |
| `docs/compatibility/advanced-integrations/oauth-scopes.md` | Pending — the OAuth **mechanism** is delivered (19-INT.5, ADR 0001–0004); the per-provider scope lists need each vendor's current documentation |
| `docs/compatibility/advanced-integrations/sync-semantics.md` | Pending — the **consistency contract** is delivered (feature contract §5.2–§5.7); the per-provider pagination/cursor facts need each vendor's current documentation |
| `docs/compatibility/advanced-integrations/webhook-security.md` | Pending — requires per-provider signature schemes; the shared ingress contract lands in 19-INT.12 |

A placeholder that asserts unverified scope lists would be worse than an honest gap, so these
remain unwritten until they can be correct.

---

## 6. Delivered state after 19-INT.5

| Area | Delivered |
| --- | --- |
| Module registration | `apps/api/src/advanced-integrations/`, registered in `AppModule` **before** `ENTITY_CONTROLLERS`; routes, module settings, translation catalogs (`i18n/{en,vi}/advancedintegrations.json`), and a capability gate over synthetic ACL resources. **No role is created** — `sysAdmin` holds the platform wildcard and the default user role holds nothing |
| Provider registry | `IntegrationRegistry` with code-registered definitions and a **versioned capability declaration** (`provider-capabilities.ts`). A malformed declaration, an impossible combination and a declaration the adapter cannot satisfy are all refused at registration |
| Connections | `integration_connections` with a validated state machine; `paused`, `revoked` and `reauthorization_required` are never permission to call the provider |
| Credentials | `integration_credential_secrets` behind `CredentialVaultPort`, AES-256-GCM through the platform's existing primitive. Read paths expose `hasCredential` and a `credentialHint`; a credential-shaped configuration key is refused |
| OAuth | `integration_oauth_states` with a **hashed, single-use** state, PKCE (S256), an allowlisted redirect URI, minimum-necessary scopes, granted-vs-required scope verification, and a **per-connection advisory lock** around the refresh |
| Background work | `advancedIntegrations.notifyExpiringCredentials` in the worker, calling the API's worker-authorised endpoint under the documented service authority |
| Log hygiene | The OAuth callback's `code` and `state` are redacted from any logged request URL (`redactUrl` in `apps/api/src/common/global-exception.filter.ts`) |

### 19-INT.6–19-INT.13 — the engine

| Area | Delivered |
| --- | --- |
| Connector SDK | A typed `ConnectorAdapter` port, a normalized `ProviderError` model with stable codes and categories, a provider HTTP client with a bounded timeout, **no redirect following**, an SSRF address check and redacted logging, and a reusable **contract conformance suite** with a deterministic fake connector |
| External id links | `integration_external_links` with database-enforced uniqueness per `(connection, object type, external id)` and per CRM record; idempotent linking, resolution by either side, and unlink that **keeps the CRM record** |
| Mappings | `integration_object_mappings` / `integration_field_mappings` with versioning, one active mapping per object type, and a **dry-run preview** that writes nothing. The transformation set is **allowlisted** — no expression, script or template is ever evaluated |
| Sync engine | `integration_sync_runs` / `integration_sync_operations` / `integration_sync_checkpoints`; pagination with a clamped page size, a checkpoint that advances only past a successful operation, idempotent re-runs, and a provider-side delete that unlinks without deleting the CRM record |
| Conflicts | `integration_conflicts` with the four policies, per-field authority, and an explicit resolution. The default `manual` policy **never overwrites a CRM field silently** |
| Resilience | Bounded retry with exponential backoff **and jitter**, a shared token-bucket rate limiter, a shared circuit breaker, and `integration_dead_letters` with an explicit replay |
| Webhook ingress | A shared endpoint at `/api/v1/integrations/advanced-integrations/{provider}/{webhookKey}/{kind}` with scoped raw-body capture, connector-owned signature verification, a receipt written **only after verification**, delivery-id deduplication, and fast acknowledgement with asynchronous processing |
| Outbound sync | A domain-event subscriber, `integration_outbound_operations` with an event-derived idempotency key, and a **record-origin** table that prevents an inbound sync from echoing back to the provider |

### 19-INT.14 / 19-INT.15 — the administration UX

| Surface | Delivered |
| --- | --- |
| Connector catalog | A searchable, scannable list — not a card grid. Each row leads with a **status rail**, then the name, then the facts that decide whether it is worth connecting: object count, authentication, connection count, required scopes and a documentation link. A visible row never implies the connector is configured; the action says exactly what happens |
| Connection wizard | Eight explicit steps: ownership → permissions → credentials → test → objects → mapping → preview → publish. The permissions are reviewed **before** anything is stored, a secret is write-only, and a draft cannot trigger a sync |
| Connection detail | Two columns: identity and state on the left, **what needs attention** on the right. The actions are Test, Pause, Resume, Reconcile, Rotate secret and Revoke; the destructive one asks for confirmation and states the impact |
| Mapping builder | A two-pane view with a wire between them — the provider's fields on the left, the CRM's on the right, the transformation in the middle. Unmapped required fields, lossy conversions and sensitive targets are listed **above** the panes, before publishing |
| Sync runs | The run list shows state, counts, duration, cursor, mapping version and error. The drawer shows the **operations**, and a failed operation can be retried **on its own** — the run and the checkpoint are untouched |
| Conflict workbench | The two sides side by side, field by field, with the changed fields marked and the field-authority rule beside each. A **stale** conflict refuses the provider's value, and the reason is stated before the operator tries |

**Colour is never the only signal** anywhere in the module: the status rail is always paired with a
text label (AGENTS.md §8, plan §15.6).

**Still not delivered, and deliberately so:** no provider connector and no cross-module contract
routing. Those are 19-INT.16 and 19-INT.25.
