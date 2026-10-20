# Phase 19 — Advanced Integrations Module (`AdvancedIntegrations`)

> **Status:** 🟡 **In progress** (2026-10-20): 19-INT.0–19-INT.24 implemented and verified.
> The control plane, the sync engine, the administration UX and **nine connectors** are delivered:
> Google Workspace, Microsoft 365, Zoom, Stripe, Mailchimp, Meta Lead Ads, Shopify (the first
> ecommerce provider), QuickBooks Online (the first accounting provider), the generic REST
> connector, plus the bounded data-enrichment provider.
> **Remaining:** 19-INT.25 (cross-module contracts for the remaining modules), 19-INT.26
> (observability, retention, threat model) and 19-INT.27 (end-to-end release evidence).
> **No connector was verified against a live vendor account** — the provider-side facts are the
> implementation's own pins. Deferrals and limitations: `docs/compatibility/advanced-integrations.md`
> and `docs/compatibility/advanced-integrations/providers.md` §4.
> This document remains the scope, architecture reference and implementation roadmap.
>
> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Module name:** `AdvancedIntegrations`  
> **Module class:** `AdvancedIntegrationsModule`  
> **Module slug:** `advanced-integrations`  
> **API namespace:** `/api/v1/AdvancedIntegrations` (adapt to the repository's established API conventions)  
> **Runtime:** NestJS / TypeScript, existing React SPA  
> **Persistence:** Existing PostgreSQL and the repository's established SQL-first persistence layer (Kysely unless repository audit proves otherwise)  
> **Queueing:** Reuse the existing job/queue infrastructure; use the current Redis/BullMQ integration if already adopted  
> **Planning baseline:** Documented EspoCRM integration behavior plus current official provider API documentation reviewed on 2026-10-19  
> **Implementation approach:** Clean-room implementation; no PHP runtime dependency and no copying or mechanical translation of upstream code.

---

## 0. Instructions for the Coding Agent

Read these documents before changing the repository:

1. `AGENTS.MD`
2. `PLAN.md`
3. The completed or planned module plans for `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, `AIAgents`, and `VoiceCommunications`.
4. Existing integration plans or code for Google, Microsoft 365/Outlook, Zoom, Stripe, Mailchimp, Meta/Facebook Lead Ads, ecommerce, accounting, data enrichment, and webhooks, if any exist in the repository.

**Start with Phase `19-INT.0` only.** Audit the actual repository before designing tables, installing packages, or implementing providers. This plan describes desired behavior; it is not proof that a prerequisite service or entity already exists.

### Non-negotiable rules

- Use the exact module name **`AdvancedIntegrations`**. Do not add the `Ua` prefix to module names, class names, database objects, route namespaces, translation namespaces, or frontend slugs.
- Reuse platform facilities for authentication, ACL, metadata, Entity Engine, Accounts, Contacts, Leads, Users, Teams, Activities, Attachments, audit, notifications, jobs, reports, email, webhooks, and settings. Do not create competing versions of these facilities.
- Reuse the domain modules that already exist: `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, `AIAgents`, and `VoiceCommunications`. Integrate through documented interfaces, domain events, and service contracts; do not reach into another module's private tables.
- `AdvancedIntegrations` is a shared integration control plane and connector framework. It is not a replacement for each domain module and must not absorb their business logic.
- Do not create a test database, shadow database, temporary database, test schema, per-agent database, per-run database, or database container for routine testing. Follow `AGENTS.MD` and use the configured primary database only for safe, targeted integration checks.
- Do not reset, truncate, drop, or broadly delete existing data. Review every migration before applying it. Use only uniquely identifiable `AGENT_TEST_...` data for test writes and clean up only records created by the current test run whose exact IDs are known.
- Never place access tokens, refresh tokens, client secrets, signing secrets, API keys, authorization headers, or full connection strings in logs, test output, API responses, frontend bundles, commits, or documentation.
- Automated tests must use fake/stub provider adapters. Do not make real OAuth connections, send actual payments, create external customer records, send marketing campaigns, create real meetings, or trigger live webhooks during tests.
- Use provider official documentation to define the current API contract. Pin supported API versions and explicitly plan deprecation/review rather than relying on undocumented behavior.
- Never report a phase as complete unless its acceptance criteria and verification results have been recorded.

---

## 1. Purpose and Product Outcome

Implement a first-class `AdvancedIntegrations` module that lets administrators securely connect approved third-party systems to the CRM, configure supported data flows, map external records to CRM entities, monitor synchronization, inspect failures, resolve conflicts, and safely replay operations.

This module must provide a **common integration control plane** plus independently testable provider adapters. It should allow additional providers to be added without re-implementing OAuth, secret storage, sync scheduling, field mapping, retries, idempotency, webhook verification, observability, or administration UI for every provider.

### 1.1 Business outcomes

At completion, authorized administrators and integration operators can:

1. Browse a registry of supported providers and see each connector's capabilities, required scopes, supported objects, and setup requirements.
2. Create, validate, enable, pause, reconnect, rotate credentials for, and revoke an integration connection.
3. Support organization-level connections and, only where required, user-owned connections without mixing their ownership models.
4. Securely complete OAuth 2.0 authorization, token refresh, minimum-scope consent, expiry handling, revocation, and reconnect flows.
5. Configure one-way or two-way synchronization for supported object types, where the provider and object allow it.
6. Map CRM entities and fields to provider objects, including transformations, defaults, required fields, filters, and controlled custom-field mapping.
7. Run an initial full synchronization followed by incremental/delta synchronization where the provider supports it.
8. Queue and process inbound and outbound changes asynchronously with rate limiting, bounded retries, backoff, idempotency, dead-letter handling, and operator-visible run history.
9. Detect and resolve duplicate records and synchronization conflicts without silently overwriting important CRM data.
10. Receive provider webhooks through a secure endpoint with signature validation, replay protection, deduplication, and fast acknowledgement.
11. Inspect connection health, last successful sync, sync lag, error rates, quotas, next scheduled runs, webhook failures, and provider API usage.
12. Keep a complete, redacted audit trail for credential changes, configuration changes, sync runs, conflict resolutions, replay actions, and administrative operations.
13. Use connector-specific integration points with Google Workspace, Microsoft 365, Zoom, Stripe, Mailchimp, Meta Lead Ads, ecommerce, accounting, and data-enrichment services according to the configured delivery tiers.
14. Add future connector packages using a documented adapter contract rather than modifying the core runtime for every new provider.

### 1.2 Product principles

- **Control plane, not a monolith of business logic:** the module owns connections, mapping, sync execution, webhook delivery, integration logs, and connector lifecycle. The domain module owns its business records and rules.
- **Explicit authority:** every mapping states which system is authoritative per direction and field where practical. Two-way sync is not enabled implicitly.
- **Safe by default:** minimum OAuth scopes, least privilege, explicit enablement, bounded rate, bounded payload size, and no silent destructive action.
- **Idempotent processing:** webhook retries and job retries must not create duplicate records or repeated side effects.
- **Explainable sync:** show what was attempted, what changed, why a record was skipped, and what requires human resolution.
- **Resumable, incremental data flow:** persist provider cursors, continuation tokens, page tokens, watermarks, and checkpoints where supported.
- **No secret leakage:** store only encrypted secret material or references to a managed secret store; reveal credentials only through one-time setup or a deliberate rotation path.
- **Provider-neutral core:** do not let provider-specific payload formats leak into shared domain services or public API contracts.
- **Optional connectors:** an unavailable provider must not prevent the CRM or unrelated connectors from operating.
- **Clean-room implementation:** use documented API behavior and public contract information; do not copy upstream source code or assets.

---

## 2. Scope and Boundaries

### 2.1 In scope

- Integration and provider registry.
- Integration connection lifecycle and health state.
- Organization-level and user-level connection ownership where justified.
- OAuth 2.0 flows, state/nonce checks, PKCE where supported, token refresh, revocation, scope tracking, and connection reauthorization.
- Secure credential storage abstraction and secret redaction.
- Connector adapter SDK and capability descriptors.
- External object and external ID registry.
- Field mapping, value transformations, defaults, lookup mapping, and import/export filters.
- Full, incremental, and event-driven synchronization.
- Conflict detection, configurable resolution policies, duplicate detection, and operator review queue.
- Inbound webhooks and outbound webhook/event delivery where not already provided by a generic platform service.
- Provider rate limits, retry policy, backoff, retry-after handling, circuit breaker, timeout, and dead-letter recovery.
- Connection health, run history, per-record operation history, audit logs, metrics, and dashboards.
- Admin UX for connection setup, mapping, preview, test connection, sync status, failures, conflicts, and replay.
- Initial connector family roadmap: Google Workspace, Microsoft 365, Zoom, Stripe, Mailchimp, Meta Lead Ads, ecommerce, accounting, data enrichment, and a generic REST/webhook connector.
- Documentation, provider configuration templates, testing, runbooks, and API contracts.

### 2.2 Explicit non-goals

Do **not** use this module to:

- Reimplement CRM entities such as Accounts, Contacts, Leads, Opportunities, Cases, Projects, products, orders, invoices, subscriptions, or Activities.
- Rebuild MarketingAutomation campaign/journey orchestration, consent management, campaign sending, audience segmentation, or unsubscribe processing. For Mailchimp, this module only synchronizes supported audiences/contacts and approved performance/engagement data through contracts exposed by `MarketingAutomation` where relevant.
- Rebuild VoiceCommunications capabilities for telephony, calls, SMS, MMS, WhatsApp, unified inbox, call recording, or conversation management. Connectors that send messages or provide communications must integrate through `VoiceCommunications` contracts.
- Rebuild AI agent runtime, tool permissions, memory, or agent orchestration. AI-assisted mapping or troubleshooting may call `AIAgents` through a protected interface, but it must not bypass normal permissions.
- Build a general-purpose ETL warehouse, full data lake, enterprise service bus, or arbitrary visual programming system.
- Provide a new identity provider or replace CRM authentication/authorization.
- Store payment card primary account numbers, CVV values, bank credentials, or other unnecessary high-risk payment secrets. Payment actions must remain delegated to approved providers and `Sales` contracts.
- Build a general ledger, tax engine, order management system, or ecommerce storefront.
- Guarantee bidirectional sync for every object. Connector capabilities and object-specific limitations must be explicit.
- Execute arbitrary user-supplied JavaScript, SQL, shell commands, templates with unrestricted evaluation, or arbitrary outbound HTTP from mapping expressions.

### 2.3 Module boundary matrix

| Capability | Owning module | `AdvancedIntegrations` responsibility |
|---|---|---|
| Provider registry, credentials, connection state | `AdvancedIntegrations` | Owns |
| Generic sync jobs, checkpoints, cursors, retry, idempotency | `AdvancedIntegrations` | Owns or reuses shared platform infrastructure |
| CRM entity data and business rules | Core/domain module | Calls module service contracts and honors domain validation |
| Product/quote/order/invoice/payment business lifecycle | `Sales` | Maps provider objects to supported `Sales` APIs/events |
| Projects and calendar/activity business objects | `Projects` / Core Activities | Maps supported provider objects to stable contracts |
| Onboarding, health score, customer risks | `CustomerSuccess` | May sync approved fields; does not calculate CSM health |
| Tickets and support conversations | `ServiceDesk` | May sync ticket fields/events through supported contracts |
| Marketing campaigns, journeys, consent and unsubscribe | `MarketingAutomation` | May sync external audience/member/campaign signals; never overrides consent policies |
| Telephony, SMS, WhatsApp and communications inbox | `VoiceCommunications` | Does not implement communication delivery independently |
| Agent runtime and autonomous tool execution | `AIAgents` | Optional protected assistive integration only |
| Shared authentication/ACL/audit/jobs/attachments/webhook engine | CRM Core | Reuses; extends only through approved interfaces |

### 2.4 Delivery tiers

Use these tiers to avoid treating every provider as equally mandatory.

**Tier 0 — Core integration control plane**

- Provider and connection registry.
- Credentials/OAuth security.
- Connector SDK/capability contract.
- External ID mapping.
- Mapping and transformation engine.
- Full/incremental sync runtime.
- Webhook processing.
- Retry/idempotency/rate limiting.
- Error/conflict views, metrics, audit, and admin UI.
- Generic REST API and generic outbound event/webhook connector where safe.

**Tier 1 — Core business productivity connectors**

- Google Workspace: Calendar and Contacts, with Gmail OAuth/email features delegated to shared email infrastructure if present.
- Microsoft 365: Outlook Calendar and Contacts, with email OAuth delegated to shared email infrastructure if present.
- Zoom: meeting creation/link synchronization and meeting metadata, not telephony.
- Stripe: approved payment/status/reference synchronization with `Sales`; no card data handling.

**Tier 2 — Marketing and acquisition connectors**

- Mailchimp: audience/member sync and campaign activity/statistics where compatible with `MarketingAutomation`.
- Meta Lead Ads: retrieve lead form submissions and map them to CRM Leads with consent/source tracking.
- Optional form/ad-platform providers can follow the same connector contract.

**Tier 3 — Commerce, accounting, and enrichment connectors**

- Ecommerce connector interface with the first one or two providers selected after repository audit (e.g., Shopify and/or WooCommerce).
- Accounting connector interface with the first one or two providers selected after repository audit (e.g., QuickBooks Online and/or Xero).
- Data enrichment provider interface with consent, provenance, field-level opt-in, quota, and attribution.

Provider-specific delivery dates/versions and rollout order must be recorded in a compatibility matrix. The presence of a connector in this plan does not mean its vendor credentials, partner approval, or production account have been obtained.

---

## 3. Reference Behavior and Compatibility Policy

`AdvancedIntegrations` is a project-specific integration framework informed by documented EspoCRM integrations and current public provider API contracts. It is not a claim that EspoCRM ships one upstream extension with this exact combined scope.

### 3.1 EspoCRM functional references

- EspoCRM extension catalog: https://www.espocrm.com/extensions/
- Google Integration overview: https://www.espocrm.com/extensions/google-integration/
- Google Integration setup: https://docs.espocrm.com/extensions/google-integration/setting-up/
- Google Calendar synchronization: https://docs.espocrm.com/extensions/google-integration/calendar/
- Google Contacts integration: https://docs.espocrm.com/extensions/google-integration/contacts/
- Outlook/Microsoft 365 Integration: https://www.espocrm.com/extensions/outlook-integration/
- Outlook integration setup: https://docs.espocrm.com/extensions/outlook-integration/setting-up/
- Outlook calendar sync: https://docs.espocrm.com/extensions/outlook-integration/calendar/
- Outlook email integration: https://docs.espocrm.com/extensions/outlook-integration/email/
- Zoom Integration: https://www.espocrm.com/extensions/zoom-integration/
- Stripe Integration: https://www.espocrm.com/extensions/stripe-integration/
- Mailchimp Integration: https://www.espocrm.com/features/mailchimp-integration/
- Webhooks: https://docs.espocrm.com/administration/webhooks/
- Developer documentation: https://docs.espocrm.com/development/

### 3.2 Official provider references

Use official vendor documentation, and update links/version notes during each connector's audit phase:

- Google Calendar API incremental sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Google OAuth 2.0: https://developers.google.com/identity/protocols/oauth2
- Microsoft Graph delta query: https://learn.microsoft.com/graph/delta-query-overview
- Microsoft Graph change notifications: https://learn.microsoft.com/graph/change-notifications-overview
- Zoom webhooks: https://developers.zoom.us/docs/api/webhooks/
- Stripe webhooks: https://docs.stripe.com/webhooks
- Stripe idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Mailchimp webhooks: https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/
- Meta Lead Ads: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/
- Shopify webhooks: https://shopify.dev/docs/apps/build/webhooks
- Shopify webhook verification: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- QuickBooks Online API: https://developer.intuit.com/app/developer/qbo/docs/get-started
- Xero API: https://developer.xero.com/documentation/api/accounting/overview

The provider documentation is authoritative for request semantics, scopes, webhook signature verification, pagination, cursor expiry, quotas, and deprecation. Never depend on third-party examples alone when official documentation is available.

### 3.3 Compatibility artifacts

Create and maintain:

- `docs/compatibility/advanced-integrations.md`
- `docs/compatibility/advanced-integrations/providers.md`
- `docs/compatibility/advanced-integrations/provider-matrix.md`
- `docs/compatibility/advanced-integrations/oauth-scopes.md`
- `docs/compatibility/advanced-integrations/sync-semantics.md`
- `docs/compatibility/advanced-integrations/webhook-security.md`

Every connector must document:

- Provider API version and deprecation policy.
- Supported objects and operations.
- Direction(s) supported per object.
- Authentication type and minimum scopes.
- Pagination and incremental change strategy.
- Rate limit and quota behavior.
- External ID strategy.
- Conflict and deletion semantics.
- Webhook event coverage and signature verification method.
- Data classification, retention, and compliance considerations.
- Known limitations and acceptance test examples.

---

## 4. Repository Audit and Architecture Decisions

Before implementation, inspect the actual repository and record findings. Do not assume a generic facility exists just because the plan mentions it.

### 4.1 Audit checklist

Inspect:

- NestJS module naming/registration patterns and current route naming.
- Entity Engine, metadata registration, relation service, validation, and schema migration pattern.
- ACL and role/record/field-level permissions.
- User, Team, Account, Contact, Lead, Opportunity, Activities, Email, Product, Invoice, Payment, Subscription, Project, Case, Campaign, and other relevant entities.
- `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, `AIAgents`, and `VoiceCommunications` public service/event contracts.
- Existing shared OAuth, external-account, provider credential, email, webhook, queue, retry, cron, audit, notification, and settings infrastructure.
- Existing integrations or partial connector implementations.
- Existing secret-management approach, environment configuration, encryption key lifecycle, and deployment secrets.
- The existing `package.json`, workspace files, lockfile, unit-test runner, integration-test helpers, and scripts that might create/drop databases.
- Existing application-level idempotency keys, outbox pattern, background-job trace IDs, and metrics/logging facilities.
- Existing frontend routing, forms, administration pages, data tables, filtering, toast/error pattern, and translation mechanism.

### 4.2 Audit deliverables

Before moving beyond `19-INT.0`, create a concise implementation matrix with:

| Capability | Exists? | Reusable contract | Gap | Action |
|---|---|---|---|---|
| OAuth / connection credentials | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Secret storage | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Job queue and scheduler | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Generic webhook ingress | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Outbound event delivery | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| External ID registry | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Sync cursor/checkpoint storage | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Domain integration events | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Audit/metrics/logging | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |
| Google/Microsoft/Zoom/Stripe/other connector | Yes/No/Partial | Concrete module/service | Concrete gap | Reuse/extend/build |

Do not duplicate existing capabilities. Record any deferred connector with its reason and prerequisites.

---

## 5. Module Architecture

### 5.1 Suggested logical structure

Adapt paths to the repository's existing convention; do not force this exact directory layout if the workspace uses a different established structure.

```text
advanced-integrations/
  advanced-integrations.module.ts
  api/
    admin-integrations.controller.ts
    connections.controller.ts
    mappings.controller.ts
    sync-runs.controller.ts
    conflicts.controller.ts
    webhooks.controller.ts
  application/
    integration-registry.service.ts
    connection-lifecycle.service.ts
    oauth-flow.service.ts
    sync-orchestrator.service.ts
    sync-run.service.ts
    mapping-compiler.service.ts
    conflict-resolution.service.ts
    webhook-ingress.service.ts
    webhook-delivery.service.ts
    integration-health.service.ts
  domain/
    integration-definition.ts
    integration-connection.ts
    connector-capabilities.ts
    sync-plan.ts
    sync-checkpoint.ts
    conflict-policy.ts
    provider-error.ts
  ports/
    connector-adapter.port.ts
    credential-vault.port.ts
    crm-entity.port.ts
    job-queue.port.ts
    webhook-verifier.port.ts
    integration-event.port.ts
  infrastructure/
    persistence/
    secrets/
    queue/
    http/
  connectors/
    google-workspace/
    microsoft-365/
    zoom/
    stripe/
    mailchimp/
    meta-lead-ads/
    ecommerce/
    accounting/
    data-enrichment/
    generic-rest/
  metadata/
    entities/
    fields/
    layouts/
    scopes/
  frontend/ (or the established SPA module location)
  tests/
```

Keep provider-specific HTTP requests, payloads, token quirks, cursors, and webhook signature algorithms inside each connector. The shared runtime consumes typed adapter contracts and normalized operations.

### 5.2 Core responsibilities

`AdvancedIntegrations` owns:

- Integration definitions and provider capability metadata.
- Connection lifecycle and credential references.
- Authorization grants and minimum granted-scope verification.
- Object/field mapping and transformation configuration.
- External ID links and record correlation.
- Sync run orchestration, checkpoints, sync operation ledger, and conflict records.
- Webhook receipt/delivery records and delivery retry state if not owned by shared infrastructure.
- Operator-facing error reporting, health status, and diagnostics.
- A connector SDK and provider acceptance contract.

It does not own the underlying CRM customer, invoice, contact, event, campaign, or ticket data.

### 5.3 Connector adapter contract

Define a typed, versioned interface conceptually similar to:

```ts
interface ConnectorAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;
  getCapabilities(): Promise<ConnectorCapabilities> | ConnectorCapabilities;
  validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult>;
  authorize?(context: OAuthContext): Promise<AuthorizationStartResult>;
  refreshCredentials?(context: ConnectorContext): Promise<CredentialRefreshResult>;
  revokeCredentials?(context: ConnectorContext): Promise<void>;
  listObjectSchemas(context: ConnectorContext): Promise<ExternalObjectSchema[]>;
  listFields(context: ConnectorContext, objectType: string): Promise<ExternalFieldSchema[]>;
  fetchPage?(input: FetchPageInput): Promise<FetchPageResult>;
  fetchChanges?(input: FetchChangesInput): Promise<FetchChangesResult>;
  upsertObject?(input: UpsertObjectInput): Promise<ExternalMutationResult>;
  deleteObject?(input: DeleteObjectInput): Promise<ExternalMutationResult>;
  verifyWebhook?(input: VerifyWebhookInput): Promise<WebhookVerificationResult>;
  normalizeWebhook?(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]>;
  testMapping?(input: MappingTestInput): Promise<MappingTestResult>;
}
```

The actual interface must be derived from repository conventions and the minimum requirements of the first selected providers. Do not force unsupported operations onto every connector. Represent optional capabilities explicitly and reject unsupported operations before dispatch.

### 5.4 Capability declaration

Every provider/object pair must declare:

- Read, create, update, delete, upsert, and/or webhook support.
- Supported sync directions.
- Initial full sync and incremental sync availability.
- Required scopes/permissions.
- Maximum page size or batch size where known.
- Provider rate-limit strategy.
- External identifier fields and unique constraints.
- Whether provider deletions are visible, tombstoned, or not synchronized.
- Whether operations are transactional or may be partially applied.
- Whether data is personal, financial, communication, or otherwise sensitive.

The admin UI must not offer unsupported sync directions or operations.

---

## 6. Domain Model and Persistence

Use the existing migration system and conventions. Names below are conceptual; align actual table names with repository rules and metadata requirements. Prefer additive migrations and preserve existing business records.

### 6.1 `IntegrationDefinition`

Represents a connector type available to administrators.

Suggested fields:

- `id`, `provider_key`, `display_name`, `description`, `category`.
- `adapter_version`, `provider_api_version`.
- `status` (available, disabled, deprecated, unsupported).
- `capabilities_json` validated against a versioned schema.
- `required_scopes_json`, `optional_scopes_json`.
- `docs_url`, `setup_instructions_key`, `icon_key` using approved project-owned UI assets.
- `created_at`, `updated_at`.

Do not store secrets on this global definition record.

### 6.2 `IntegrationConnection`

Represents a configured installation/account/tenant connection.

Suggested fields:

- `id`, `provider_key`, `name`, `owner_type`, `owner_id`, `tenant_or_account_ref` (provider-specific, non-secret).
- `status` (draft, pending_authorization, connected, degraded, reauthorization_required, paused, revoked, error).
- `enabled`, `last_validated_at`, `last_successful_sync_at`, `last_error_code`.
- `granted_scopes_json`, `connection_options_json`, `adapter_version`.
- `created_by`, `updated_by`, timestamps and soft-delete state if supported.
- `credential_reference_id`; never plain-text tokens.
- `health_status`, `health_summary_code`.

Define uniqueness for a provider connection according to whether multiple accounts per organization/user are allowed. Do not assume one connection per provider globally.

### 6.3 Credential/secret reference

Use the repository's established secrets mechanism. If none exists, add a vault abstraction rather than embedding encryption throughout the domain.

Conceptual fields:

- Secret reference ID and connection ID.
- Secret kind (OAuth access token, refresh token, client secret, API key, webhook secret, signing secret).
- Encrypted payload or external secrets-manager reference.
- Encryption/key version and token expiry metadata where applicable.
- Created/rotated/revoked timestamps.
- Access policy / owner scope.

Requirements:

- Never return secret values in normal GET endpoints.
- Never log credential payloads.
- Support rotation without exposing the old credential.
- Support key rotation and re-encryption, or a managed vault reference strategy.
- Clear or revoke secret values when a connection is deleted/revoked according to the provider contract and retention policy.
- Do not invent cryptography. Use established platform/KMS/vault primitives.

### 6.4 `ExternalObjectLink`

Correlates one CRM record with one provider object.

Suggested fields:

- `id`, `connection_id`, `crm_entity_type`, `crm_record_id`.
- `external_object_type`, `external_object_id`, `external_parent_id` when needed.
- `provider_updated_at`, `crm_updated_at`, `last_synced_at`.
- `last_seen_sync_run_id`, `sync_state`, optional version/etag/hash metadata.
- `created_at`, `updated_at`.

Constraints:

- Unique `(connection_id, external_object_type, external_object_id)` unless a provider explicitly permits duplicate keys across containers.
- Add an appropriate uniqueness constraint for CRM record linkage only when the selected policy allows one-to-one mapping.
- Ensure indexes support external ID lookup, CRM record lookup, and connection sync queries.
- Treat external IDs as opaque strings. Do not parse numeric-looking IDs into JavaScript numbers.

### 6.5 `IntegrationObjectMapping`

Defines a sync binding between provider object type and CRM entity type.

Suggested fields:

- `id`, `connection_id`, `provider_object_type`, `crm_entity_type`.
- `sync_direction` (inbound, outbound, bidirectional).
- `enabled`, `filter_config_json`, `deletion_policy`.
- `conflict_policy`, `schedule_config`, `batch_size` bounded by provider capabilities.
- `mapping_version`, `configuration_version`, `last_published_at`.

When mapping is changed, preserve prior run configuration snapshots so existing sync history remains interpretable.

### 6.6 `IntegrationFieldMapping`

Stores individual field-level mapping rules.

Suggested fields:

- `object_mapping_id`, `source_field_path`, `target_field_path`.
- `direction`, `transform_kind`, `transform_config_json`.
- `required`, `default_value_json`, `null_policy`, `format_policy`.
- `lookup_mapping_ref`, `sensitivity_class`, `enabled`, `sort_order`.

Only support allowlisted transformations (trim, normalize email/phone, date/time conversion, enum mapping, explicit lookup resolution, safe concatenation, numeric/string conversion with validation). Do not support arbitrary expression execution.

### 6.7 `IntegrationSyncRun`

Represents a complete sync attempt.

Suggested fields:

- `id`, `connection_id`, `object_mapping_id`, `trigger_type` (manual, schedule, webhook, event, retry, backfill).
- `status` (queued, running, succeeded, partially_succeeded, failed, cancelled, awaiting_review).
- `started_at`, `finished_at`, `duration_ms`.
- `cursor_before`, `cursor_after`, `checkpoint_ref` (store encrypted if provider tokens are sensitive).
- `records_read`, `created_count`, `updated_count`, `skipped_count`, `deleted_count`, `conflict_count`, `failed_count`.
- `error_code`, redacted error summary, trace/correlation ID.
- Mapping/configuration version and adapter version snapshots.

Do not store unbounded raw provider payloads in this table.

### 6.8 `IntegrationSyncOperation`

Represents a single externally visible item operation or bounded batch item.

Suggested fields:

- `id`, `sync_run_id`, `external_object_link_id`, operation type, outcome.
- CRM entity/record reference where safe.
- Provider object type/ID.
- Idempotency key, retry count, next retry time.
- Redacted error code/message and timestamps.
- Optional payload digest and encrypted or short-retention diagnostic reference.

Maintain a retention policy so per-record logs cannot grow indefinitely without operator control.

### 6.9 `IntegrationConflict`

Represents a field, record, or deletion conflict needing a policy decision or human resolution.

Suggested fields:

- `id`, `connection_id`, `object_mapping_id`, external link and CRM record references.
- Conflict type (both_changed, duplicate_match, validation, delete_vs_update, enum_mismatch, ownership, stale_cursor).
- Field paths, before/after digest or redacted values as permitted, detected timestamps.
- Suggested resolution, selected resolution, resolver user, resolved timestamp, audit reference.
- Status (open, snoozed, resolved, ignored, superseded).

Avoid storing sensitive values twice in conflict payloads. Apply ACL before displaying conflict details.

### 6.10 `IntegrationWebhookDelivery`

If a generic platform webhook subsystem does not already own this data, store:

- `id`, provider/connection reference, provider delivery/event ID, event type.
- Received timestamp, signature validation result, payload digest, redacted/encrypted payload reference.
- Processing status, deduplication status, retry count, trace ID, final outcome.

Use a unique delivery key with the provider account/connection scope. Do not assume one universal event ID format across providers.

### 6.11 `IntegrationDeadLetter`

Represents a terminal job/webhook operation that cannot be retried automatically.

Fields should include operation/run reference, classified reason, attempts, last attempt time, redacted diagnostic, replay eligibility, and operator resolution. Never expose credentials or unrestricted raw payloads through dead-letter detail endpoints.

### 6.12 Reuse the platform outbox when available

Outbound sync should use the platform's transactional outbox/domain events if available. Avoid a transaction that commits a CRM record but loses the corresponding provider sync intent. Do not create a second generalized outbox if the kernel already offers one; add integration-specific metadata to the existing contract where appropriate.

---

## 7. Connection Lifecycle and OAuth Security

### 7.1 Connection state machine

Implement and test an explicit state machine such as:

```text
DRAFT
  -> PENDING_AUTHORIZATION
  -> CONNECTED
  -> DEGRADED <-> CONNECTED
  -> REAUTHORIZATION_REQUIRED
  -> CONNECTED (after successful reconnect)
  -> PAUSED -> CONNECTED
  -> REVOKED / DELETED
```

Additional states may be introduced when a provider needs them, but state changes must be validated. A job must not interpret `paused`, `revoked`, or `reauthorization_required` as permission to make provider API calls.

### 7.2 OAuth requirements

For connectors using OAuth:

- Use authorization code flow with PKCE when supported/recommended by the provider and client type.
- Generate cryptographically random, single-use `state`; validate it and bind it to the initiating user/session/connection draft.
- Validate redirect URI against exact allowlisted values. Never accept arbitrary callback URLs from request input.
- Validate OAuth callback ownership and prevent cross-tenant connection takeover.
- Request minimum necessary scopes; show human-readable scope descriptions before consent.
- Persist granted scopes and compare them with required scopes before enabling a capability.
- Store access/refresh tokens only in the secret vault/secure storage abstraction.
- Refresh tokens under per-connection locking to prevent refresh races; handle token rotation and invalidation as the provider specifies.
- Redact authorization codes and tokens from access logs, tracing, errors, analytics, and URLs.
- Support reconnect/revocation and surface the exact missing permission class without exposing credentials.
- Apply CSRF protection and strict origin/callback validation to the OAuth workflow.
- Do not request broad admin scopes by default. Provider administrators must deliberately approve organization-wide permissions if they are actually required.

### 7.3 API key and service-account credentials

For API keys, service accounts, signed assertions, or private-key providers:

- Provide a credential type-specific configuration flow.
- Validate credentials with a low-impact test endpoint where available.
- Never put credentials into query strings.
- Support rotation and revocation.
- Keep private keys out of ordinary database JSON settings; store a vault reference instead.
- Mask credential values in the UI after save and never return full values in subsequent API calls.

### 7.4 Connection test

A `Test Connection` action should:

1. Check whether the connection is enabled and has required scopes.
2. Perform the provider's lowest-cost, read-only verification call.
3. Validate tenant/account identity and permissions where possible.
4. Report actionable errors such as `TOKEN_EXPIRED`, `SCOPE_MISSING`, `ACCOUNT_MISMATCH`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, or `CONFIGURATION_INVALID`.
5. Never create, update, charge, send, or delete a real provider object just to test credentials.

---

## 8. Provider-Neutral Sync Engine

### 8.1 Supported sync patterns

The framework must support these patterns when each connector declares them:

- Initial full sync.
- Incremental sync using cursor/sync token/delta link/updated-since marker.
- Scheduled polling.
- Webhook-triggered incremental fetch.
- CRM event-triggered outbound upsert.
- Manual one-off run.
- Scoped backfill over a date range or selected records.
- Reconciliation runs to detect missed updates or webhook gaps.
- Safe retry of failed operations.

Do not force every connector to implement every pattern. The connector capability manifest decides what is supported.

### 8.2 Cursor and checkpoint behavior

- Persist provider cursors per connection, object mapping, and sync direction.
- Store provider cursors exactly as opaque values; do not decode or fabricate cursor contents.
- Advance a cursor only after the page/batch has been durably processed according to the connector's correctness model.
- If an API returns a continuation token/link, follow it only according to the vendor contract and validate any server-provided host/URL before outbound requests.
- Handle cursor expiration or invalidation by pausing incremental sync and requiring a bounded rebaseline/full sync; never silently mark missing data as deleted.
- Record the old/new cursor references and sync configuration version in run history without exposing secret tokens.
- Use checkpoints so a large run can resume from a known boundary.

### 8.3 Pagination and batching

- Respect provider page sizes and maximum batch sizes.
- Handle all pages even when a page returns zero records but a continuation token is present.
- Use bounded concurrency and per-provider/per-connection rate limiting.
- Persist operations or idempotent batches before acknowledging completion.
- Use memory-bounded streams/iterators for large data sets; do not load the entire external dataset into memory.
- Handle partial batch errors per provider semantics.

### 8.4 Idempotency and duplicate prevention

- Calculate deterministic operation IDs from connection, object type, external ID, action, and source version/event ID where possible.
- Enforce database uniqueness constraints in addition to application-level checks.
- Make create/upsert retries safe; re-read by external link/unique key before creating again after ambiguous timeouts.
- Use provider idempotency keys for mutations where supported, but do not assume an arbitrary provider supports them.
- Store inbound event delivery IDs and deduplicate webhooks before side effects.
- Ensure queue retries cannot create duplicate CRM records, duplicate invoices, duplicate external payment objects, or repeated notifications.
- Avoid coupling idempotency solely to the job queue's job ID; queue jobs may be re-enqueued under different IDs.

### 8.5 Directionality and source-of-truth policy

Every object mapping must explicitly define:

- Inbound, outbound, or bidirectional direction.
- Whether create, update, and delete are enabled per direction.
- Authoritative source for each mapped field where feasible.
- Conflict policy and null behavior.
- Which changes are ignored to prevent an infinite echo loop.

Bidirectional mode must require explicit admin confirmation and a preview of likely overwrites. Fields without a defined authority should default to manual conflict resolution rather than last-write-wins.

### 8.6 Echo-loop prevention

- Tag changes with an internal integration origin/operation context when written through domain services or the outbox.
- Record provider version/etag and external updated timestamps where available.
- When a sync write causes a CRM event, suppress only the corresponding echo for the same connection/object/operation; do not globally suppress domain events.
- Apply a maximum hop count or correlation marker for chained integrations.
- Keep loop-prevention metadata out of ordinary end-user forms unless explicitly useful.

### 8.7 Conflict policies

Support a controlled set of policies:

- `CRM_WINS`: overwrite the external field from CRM when permissions/capabilities allow.
- `PROVIDER_WINS`: apply the provider value only to explicitly configured fields.
- `LATEST_TIMESTAMP`: use timestamps only when the provider timestamp is reliable and a field-level rule permits it.
- `FIELD_AUTHORITY`: use each field's configured source of truth.
- `MANUAL_REVIEW`: open a conflict record and do not apply the ambiguous update.
- `IGNORE_FIELD`: never sync the field.

The policy must not bypass validation, domain invariants, ACL, consent, record ownership, or issued-document rules. `PROVIDER_WINS` must not modify protected financial fields or locked business records without the owning domain service allowing it.

### 8.8 Deletion semantics

- Never map a provider tombstone to a hard CRM delete by default.
- Offer safe policies: ignore delete, mark inactive/archived, unlink external mapping, soft-delete only through domain API when explicitly configured, or create a conflict for human review.
- Keep provider deletion, unlinking, archival, and CRM deletion distinct concepts.
- For CRM-origin deletion, call provider delete only when it is explicitly enabled, supported, auditable, and allowed by the provider/domain policy.
- Preserve audit history and comply with retention/erasure requirements; never erase unrelated data when a provider object disappears.

---

## 9. Field Mapping and Data Transformation

### 9.1 Mapping builder

Provide an admin mapping workflow that supports:

- CRM entity selection and provider object selection.
- Readable source/target field labels, types, required state, and supported operations.
- Direction-specific source-to-target mapping.
- Required target field validation.
- Default values and null policies.
- Explicit value mapping for enum/status/category fields.
- Lookup resolution (e.g., map an external company identifier to an Account using a configured unique field).
- Field filtering and exclusion of sensitive/unwanted fields.
- Sample preview with redacted representative payloads.
- Test transformation without writing external or CRM data.
- Versioning and publication so in-flight jobs can finish with the configuration version they started with.

### 9.2 Transformation safety

Allowed built-in transformation kinds should include, when relevant:

- String trim/case normalization.
- Email/phone normalization using established validators.
- Date/time parsing with an explicit timezone rule.
- Decimal-safe number/string conversion.
- Enum mapping and fallback choice.
- Boolean mapping with explicit true/false sets.
- Split/join only with explicit delimiters.
- Safe concatenation from allowlisted field paths.
- Explicit lookup resolution.
- Fixed literals/defaults.
- Safe JSON path extraction from validated schemas.

Do not implement raw JavaScript/TypeScript `eval`, dynamic function constructors, arbitrary SQL, shell calls, unrestricted templates, or arbitrary outbound network lookups in transformations. If expression support is ever added, it requires a separately reviewed, sandboxed, versioned capability and is out of scope for the first release.

### 9.3 Validation and error handling

- Validate transformed values against the CRM field type, enum definition, metadata constraints, and owning domain service.
- Report errors by field path and stable error code.
- Allow an item-level failure to be quarantined without failing every unrelated item when the connector's consistency model permits that.
- Do not coerce invalid values silently into zero, empty strings, or the first enum option.
- Preserve original provider values only where required for diagnostics, with data minimization, encryption, access controls, and retention limits.

---

## 10. Webhook Ingress and Outbound Event Delivery

### 10.1 Inbound webhook flow

For provider-sent events:

1. Identify the configured provider connection from a trusted route/connection key, but do not treat the route key alone as authentication.
2. Capture raw request bytes if the provider's signature algorithm requires them.
3. Validate request size/content type and signature using the provider adapter's exact algorithm.
4. Validate timestamp window/replay rules where the provider supports them.
5. Deduplicate using provider delivery/event ID scoped to the connection.
6. Persist a minimal receipt record and enqueue processing.
7. Respond with the provider-required success code quickly after durable acknowledgement, before slower CRM processing.
8. Process event asynchronously with normal idempotency, ACL/domain validation, payload schema validation, and correlation ID.
9. Track processing result and retry/dead-letter state.

Invalid signatures must be rejected before trusted event processing. Do not accept a webhook merely because its source IP appears on an allowlist when the provider supports cryptographic signature verification.

### 10.2 Raw-body and signature requirements

- Preserve raw body before JSON parsing for providers whose signature requires raw bytes.
- Implement timing-safe signature comparison and correct encodings.
- Respect provider-specific signature headers, timestamp units, signing secret versions, and canonical payload format.
- Keep the verification code isolated and accompanied by official test vectors/fixture tests.
- Implement provider endpoint challenge/validation flows where required.
- Rate-limit untrusted ingress and bound body sizes before parsing.

### 10.3 Outbound webhook/event delivery

If the existing CRM Core already supplies secure outgoing webhooks, extend/reuse it rather than creating a competing subsystem. Add integration-specific routing or payload mapping only where needed.

Requirements for any outgoing destination:

- Administrator-created and ACL-protected endpoint definitions.
- HTTPS by default. Any exception requires explicit admin policy and an approved internal destination model.
- SSRF protection: block loopback, link-local, private, metadata-service, and prohibited network destinations unless a carefully controlled internal-integration allowlist explicitly permits one.
- Validate DNS resolution and revalidate destination policy on connection as appropriate to mitigate rebinding.
- Sign payloads, timestamp deliveries, and document the signature format.
- Retry delivery with bounded exponential backoff and stable delivery IDs.
- Support endpoint timeout, pause, rotation of signing secret, redacted logs, and operator replay.
- Never blindly follow redirects to unvalidated destinations.
- Send the minimum fields necessary; apply field-level privacy filters.

### 10.4 Webhook replay and manual retry

- Store event/delivery IDs, received time, signature result, payload digest, processor version, and retry outcome.
- Require a privileged scope for replay; record actor, reason, and replayed delivery ID.
- Replay must pass the same current ACL/domain validation and idempotency path as first-time processing.
- Replaying a delivery must not automatically bypass a current suppression/consent rule, a provider scope failure, or a locked financial record.

---

## 11. Runtime Resilience, Scheduling, and Rate Limits

### 11.1 Queue design

Use the repository's established job queue and scheduling pattern. Jobs should be partitionable by provider, connection, object mapping, and operation group. Avoid one global serial queue for every external API.

Queue jobs should carry only references and minimal metadata, not raw secrets or full personal-data payloads. Fetch payloads by controlled reference when the job runs.

### 11.2 Retry policy

- Classify failures into transient, rate-limited, authorization, permanent validation, conflict, and provider outage categories.
- Use provider `Retry-After` or equivalent guidance when present.
- For transient failures, use bounded exponential backoff with jitter and an upper limit.
- Do not endlessly retry invalid credentials, missing scopes, invalid payloads, or permission failures.
- On expired/revoked OAuth grant, transition the connection to reauthorization-required and pause affected jobs.
- Record attempt count, next retry time, and last error code.
- Define maximum attempts, maximum elapsed retry window, and dead-letter behavior per provider/case.

### 11.3 Rate limits and concurrency

- Maintain a provider/connection-level concurrency and rate limit based on official quota guidance.
- Honor request and tenant quotas. Use adaptive backoff when rate limits are hit repeatedly.
- Prevent one noisy integration connection from starving other connections.
- Use separate bounded pools for interactive validation and background sync so long backfills do not block UI operations.
- Display rate-limit or quota state to administrators without exposing provider tokens.

### 11.4 Circuit breaker and provider degradation

- When provider failure rates exceed a defined threshold, pause non-critical outbound work for a cooldown window.
- Continue accepting durable webhook receipts if doing so is safe and capacity permits.
- Expose a degraded status and provider outage notice in integration health UI.
- Do not mark each queued operation as permanently failed solely because the provider has a temporary outage.
- Make circuit-breaker state observable and safely resettable by an authorized operator.

### 11.5 Backfill and reconciliation

- Support bounded date/ID ranges and resumable backfills.
- Require previews for large backfills and potentially overwriting operations.
- Support a dry-run that reports planned create/update/skip/conflict counts without writing business records.
- Use reconciliation jobs to recover missed webhook events where providers expose list/delta APIs.
- Enforce quotas and clear operator warnings for large or expensive jobs.

---

## 12. Connector Specifications

All connectors use the core adapter contract, connection security, mapping engine, sync runtime, logs, and error framework. Each connector must be developed and released independently so a problem in one provider does not disable others.

### 12.1 Google Workspace connector

**Primary use cases:** calendar synchronization and contact synchronization; Gmail OAuth/email behavior only by connecting to the shared email subsystem where available.

Phase scope:

- Google OAuth consent and minimum scopes for selected features.
- Calendar resource discovery and selection.
- Calendar event import/export with explicit sync direction per calendar/object mapping.
- Attendee mapping to supported CRM Contacts/Leads/Users where allowed.
- Contact synchronization with configured field allowlists and duplicate rules.
- Incremental synchronization with provider sync tokens where supported.
- Token refresh, revocation, permission loss, calendar deletion, and stale-sync recovery.
- Private event policy: never sync private event details unless an explicit approved policy/provider capability permits it.
- Event timezone, recurring events, exceptions, attendee updates, cancellation, and deletion semantics documented per supported API behavior.
- Calendar ownership and record ACL must be honored; user-private events must never leak to other users through sync.

Acceptance criteria:

- Initial sync plus incremental changes do not duplicate calendar events or contacts.
- Expired/invalid sync token causes a controlled resync path without mass deletion.
- A user can disconnect Google and see the resulting connection/sync state.
- Unsupported recurring-event behavior is visibly documented rather than silently corrupting recurrence data.

References:

- https://docs.espocrm.com/extensions/google-integration/calendar/
- https://docs.espocrm.com/extensions/google-integration/contacts/
- https://developers.google.com/workspace/calendar/api/guides/sync
- https://developers.google.com/identity/protocols/oauth2

### 12.2 Microsoft 365 connector

**Primary use cases:** Outlook calendar and contact synchronization; email account authentication must use the shared email subsystem rather than duplicating mail transport.

Phase scope:

- OAuth and scope consent for Calendar/Contacts; request mail-related scopes only if the shared email integration explicitly requires them.
- Calendar and contact synchronization with supported one-way/two-way policies.
- Microsoft Graph delta queries/change notifications where supported by the chosen object/API version.
- Handle pagination tokens, delta links, subscription renewal/expiry, resource changes, throttling and retry guidance.
- Support Microsoft 365 tenant context and explicit delegated/application permission distinction.
- Attendee mapping for contacts/leads/users where supported.
- Document recurring event/meeting limitations and do not discard unsupported provider properties silently.
- Microsoft Teams meeting metadata may be attached to CRM Activities where the selected Microsoft permissions and service contract support it; this is not a replacement for the Zoom connector.
- Keep mailbox/email transport behavior in the shared email subsystem.

Acceptance criteria:

- Delta sync processes all continuation pages and persists the final delta link.
- Expired subscriptions are renewed or marked for repair; event gaps can be recovered by delta/reconciliation sync.
- Missing scopes produce an actionable reauthorization error rather than an opaque provider failure.

References:

- https://docs.espocrm.com/extensions/outlook-integration/calendar/
- https://docs.espocrm.com/extensions/outlook-integration/contacts/
- https://docs.espocrm.com/extensions/outlook-integration/email/
- https://learn.microsoft.com/graph/delta-query-overview
- https://learn.microsoft.com/graph/change-notifications-overview

### 12.3 Zoom connector

**Primary use case:** attach Zoom meeting details/join links to CRM meetings and synchronize allowed meeting metadata. Voice, call center, SMS, and messaging remain in `VoiceCommunications`.

Phase scope:

- OAuth/provider app setup and permission validation.
- Create a Zoom meeting from an allowed CRM meeting/activity.
- Persist external meeting ID and join URL securely according to application policy.
- Update allowed meeting fields and detect cancellation/deletion events where subscriptions are configured.
- Webhook endpoint validation, signature verification, timestamp checks, deduplication, and event handling.
- Handle meeting update/recording-availability events only where specifically enabled and authorized.
- Do not download or retain recordings by default; if future recording support is required, it needs a distinct privacy/retention decision and an explicit permission policy.

Acceptance criteria:

- Retry after an ambiguous timeout does not create duplicate Zoom meetings.
- Invalid signatures and stale/replayed webhook events are rejected or ignored safely.
- Disconnecting the account prevents new provider operations and documents what happens to previously created meetings.

References:

- https://www.espocrm.com/extensions/zoom-integration/
- https://developers.zoom.us/docs/api/webhooks/

### 12.4 Stripe connector

**Primary use case:** synchronize approved payment intents/payment statuses, customer references, checkout/payment links, and webhook status changes with the `Sales` domain contract.

Scope and constraints:

- Confirm the existing `Sales` payment model and any current Stripe implementation during audit before creating any Stripe-specific model.
- Use Stripe's official SDK or approved HTTP client patterns, pin API version deliberately, and store API keys restricted to the minimum capabilities required.
- Use provider idempotency keys for create/update operations where supported.
- Verify Stripe webhook signatures with the official library and the unmodified raw request body.
- Deduplicate webhook events and handle out-of-order delivery by retrieving the current object state when appropriate.
- Map provider IDs to `Sales` payment/request records via external links.
- Use domain services to apply payment state transitions; never mutate issued invoices/payments directly through generic mapping.
- Never store PAN, CVV, raw payment credentials, or unnecessary sensitive payment instrument fields.
- Keep test mode separate by credential configuration, never by creating a separate CRM test database.
- Never issue a live charge, refund, payment link or customer-facing request during tests.

Acceptance criteria:

- Duplicate and out-of-order webhook events do not duplicate payments or reverse a terminal state incorrectly.
- Signature verification failure rejects the webhook before business processing.
- Payment state is changed only through the `Sales` domain service and an auditable external event.
- Provider outage and retry do not double-charge a customer.

References:

- https://www.espocrm.com/extensions/stripe-integration/
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/idempotent_requests

### 12.5 Mailchimp connector

**Primary use case:** optional synchronization of permitted contacts/audience membership and campaign result/activity signals between Mailchimp and `MarketingAutomation`.

Boundaries:

- Do not implement campaign builder, journeys, send queues, unsubscribe UI, suppression lists, or marketing-consent policy here.
- `MarketingAutomation` remains authoritative for consent and suppression rules within the CRM.
- An external unsubscribe or complaint event must be propagated to the consent/suppression service promptly, using its explicit contract; it must not be overwritten by a later ordinary profile sync.
- Define conflict handling for member status, normalized email, tags, audience membership and source attribution.
- Use Mailchimp's webhook/event mechanism to detect external membership changes and campaign completion/activity where available.
- Use periodic reconciliation to recover missed webhook events.
- Do not expose all provider campaign analytics as customer-visible CRM data without a permissions and data-minimization decision.

Acceptance criteria:

- Subscribe/unsubscribe status cannot be changed from unsubscribed to subscribed by ordinary profile sync without the appropriate consent evidence and allowed workflow.
- Duplicate webhook delivery produces one effective CRM event.
- Marketing activity is attached to the correct contact and campaign mapping where supported.

References:

- https://www.espocrm.com/features/mailchimp-integration/
- https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/

### 12.6 Meta Lead Ads connector

**Primary use case:** import approved lead form submissions into CRM Leads or a configured lead-capture workflow.

Scope:

- OAuth/business asset authorization and least-privilege permissions.
- Select approved pages, forms, and lead retrieval configuration.
- Import lead submission IDs, submitted fields, form/page references, source timestamps, campaign/ad metadata where available and permitted.
- Map fields to CRM Lead fields with validation and a configurable duplicate policy.
- Preserve source and consent evidence fields needed by the business and applicable policy.
- Store only necessary fields, apply retention limits, and avoid importing fields not mapped/approved.
- Deduplicate by the provider's stable lead/submission ID scoped to the page/form connection.
- Support delayed polling/reconciliation if webhooks are missed or the provider app permissions change.
- Never circumvent provider review, permission, or platform policy requirements.

Acceptance criteria:

- The same provider submission imported twice updates/links the same lead according to the configured policy.
- Missing/revoked lead access is surfaced as a connection error without repeatedly retrying permanently failing requests.
- Provider metadata and consent provenance remain traceable after field mapping.

Reference:

- https://developers.facebook.com/docs/marketing-api/guides/lead-ads/

### 12.7 Ecommerce connector framework

The exact first provider must be selected after the repository audit and the user's business priority is recorded. Shopify and WooCommerce are candidate adapters; do not assume both must be implemented in the same sprint.

Supported object families may include:

- Customers and customer addresses.
- Products and variants.
- Orders, order lines, refunds, fulfilment/shipment events.
- Store/catalog identifiers, currencies, tax/shipping summaries, and source metadata.

Rules:

- Map orders to `Sales` order/invoice/payment contracts only after an explicit mapping review; do not create duplicate commercial documents if a linked external order already exists.
- External ecommerce orders and CRM quotes/orders have different lifecycle semantics; do not equate their statuses without a mapping table.
- Keep external order IDs, store IDs and webhook delivery IDs.
- Verify webhooks with vendor-prescribed raw-body HMAC/signature process and deduplicate by vendor delivery ID.
- Acknowledge webhooks quickly and process heavier work asynchronously.
- Configure whether the external store or CRM is authoritative for product, customer and order fields.
- Do not push CRM edits back to an online store by default.
- Use test stores/sandbox credentials for provider-side tests and fake adapters for routine tests; do not create another CRM database.
- Do not delete an order or invoice because it was deleted externally; apply an explicit archival/void/conflict policy.

Candidate references:

- https://shopify.dev/docs/apps/build/webhooks
- https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- https://woocommerce.github.io/woocommerce-rest-api-docs/

### 12.8 Accounting connector framework

Select the first provider after the repository audit and record the accounting product/version, region and available sandbox. QuickBooks Online and Xero are candidates.

Supported object families may include:

- Customers/contacts with controlled matching.
- Items/services, if needed by the accounting mapping.
- Invoices, payments, credit notes and accounting references from `Sales`.
- Tax/account codes only as external mappings, not as a replacement for the CRM Sales tax calculation engine.
- Reconciliation status and provider error messages.

Rules:

- CRM Sales remains authoritative for its own business document lifecycle unless an explicit per-object authority decision says otherwise.
- Never bypass `Sales` issue/lock/credit rules.
- A sent/posted accounting invoice is not an ordinary editable object. Corrections must follow the provider's supported credit/void workflow and local accounting rules.
- Use decimal-safe amount/currency handling; validate currency, tax codes, rounding, account codes and document totals before export.
- Store external IDs and posted status, and reconcile rather than creating duplicates after ambiguous API timeouts.
- Do not claim tax/accounting compliance based solely on technical sync success; provider mapping and local requirements need explicit review.
- No financial operation is triggered automatically until an administrator enables and reviews that operation.

Candidate references:

- https://developer.intuit.com/app/developer/qbo/docs/get-started
- https://developer.xero.com/documentation/api/accounting/overview

### 12.9 Data enrichment connectors

Provide a bounded adapter pattern for one selected enrichment provider at a time.

Requirements:

- Admin-controlled enrichment profiles and entity/field allowlists.
- Explicit per-field opt-in rather than global overwrite.
- Preserve the old value, new value, provider/source, retrieval time, confidence (only if provider supplies a meaningful one), and user approval where applicable.
- Never overwrite verified CRM data automatically unless field-level policy explicitly allows it.
- Show a before/after preview and offer accept/reject actions for risky changes.
- Apply provider quota limits, per-record rate limiting, caching with a documented TTL, and cost controls.
- Check legal basis, consent, contractual restrictions and data retention before enrichment is enabled.
- Do not infer or fabricate attributes that the provider did not return.
- Keep sensitive classes of data excluded unless separately reviewed.

### 12.10 Generic REST/API connector

Offer a restricted connector for vetted external REST APIs and outbound webhooks. This is not an arbitrary “connect to any URL” escape hatch.

Requirements:

- Admin-configured base URL and allowlisted paths/methods.
- HTTPS by default and SSRF-safe hostname/IP checks.
- Authentication modes limited to reviewed schemes (OAuth 2.0, bearer secret, API key header, or signed request where required).
- Explicit request/response JSON schema and maximum payload/body sizes.
- Per-connection timeout, response-size limit, concurrency and rate limit.
- No user-controlled URL fragments, redirects, headers, or authentication destination.
- Secret values are referenced through the secure credential store.
- Allowlist methods and fields; validate response schema before mapping.
- No user-defined JavaScript or SQL transformations.
- Full request/response content logging is disabled by default; only redacted metadata/digests are retained.

---

## 13. API Contract

Use the established API response envelope, error format, pagination, validation, OpenAPI, and authorization conventions. The paths below are illustrative; audit and conform to the repository before implementing.

### 13.1 Integration registry and connections

- `GET /api/v1/AdvancedIntegrations/providers` — list providers visible to the current administrator and connector capabilities.
- `GET /api/v1/AdvancedIntegrations/providers/:providerKey` — retrieve provider setup/capability metadata (never secrets).
- `GET /api/v1/AdvancedIntegrations/connections` — list authorized connections with health summaries.
- `POST /api/v1/AdvancedIntegrations/connections` — create a draft connection.
- `GET /api/v1/AdvancedIntegrations/connections/:id` — retrieve configuration with secret fields masked/omitted.
- `PATCH /api/v1/AdvancedIntegrations/connections/:id` — update mutable configuration.
- `POST /api/v1/AdvancedIntegrations/connections/:id/test` — validate connection safely.
- `POST /api/v1/AdvancedIntegrations/connections/:id/authorize` — begin approved OAuth flow where applicable.
- `POST /api/v1/AdvancedIntegrations/connections/:id/reconnect` — start reauthorization.
- `POST /api/v1/AdvancedIntegrations/connections/:id/pause` — pause jobs.
- `POST /api/v1/AdvancedIntegrations/connections/:id/resume` — resume only after health/authorization checks.
- `POST /api/v1/AdvancedIntegrations/connections/:id/revoke` — revoke/disconnect.
- `DELETE /api/v1/AdvancedIntegrations/connections/:id` — remove configuration according to retention rules; must not implicitly delete synced CRM records.

### 13.2 Mapping and sync

- `GET /api/v1/AdvancedIntegrations/connections/:id/object-mappings`
- `POST /api/v1/AdvancedIntegrations/connections/:id/object-mappings`
- `GET /api/v1/AdvancedIntegrations/object-mappings/:id`
- `PATCH /api/v1/AdvancedIntegrations/object-mappings/:id`
- `POST /api/v1/AdvancedIntegrations/object-mappings/:id/validate`
- `POST /api/v1/AdvancedIntegrations/object-mappings/:id/preview`
- `POST /api/v1/AdvancedIntegrations/object-mappings/:id/publish`
- `POST /api/v1/AdvancedIntegrations/object-mappings/:id/dry-run`
- `POST /api/v1/AdvancedIntegrations/object-mappings/:id/sync`
- `POST /api/v1/AdvancedIntegrations/connections/:id/reconcile`
- `GET /api/v1/AdvancedIntegrations/sync-runs`
- `GET /api/v1/AdvancedIntegrations/sync-runs/:id`
- `POST /api/v1/AdvancedIntegrations/sync-runs/:id/cancel`
- `POST /api/v1/AdvancedIntegrations/sync-runs/:id/retry-failed`

### 13.3 Conflict management

- `GET /api/v1/AdvancedIntegrations/conflicts`
- `GET /api/v1/AdvancedIntegrations/conflicts/:id`
- `POST /api/v1/AdvancedIntegrations/conflicts/:id/resolve`
- `POST /api/v1/AdvancedIntegrations/conflicts/:id/ignore`
- `POST /api/v1/AdvancedIntegrations/conflicts/:id/snooze`

Resolve endpoints must validate current permissions and current record state. They must reject stale resolutions when either the external record or CRM record changed since conflict detection.

### 13.4 Webhook and diagnostics endpoints

- Provider webhook ingress routes should use provider-specific routing conventions and be excluded from normal browser-session assumptions only where required; signature validation remains mandatory.
- `GET /api/v1/AdvancedIntegrations/connections/:id/webhook-deliveries`
- `GET /api/v1/AdvancedIntegrations/dead-letters`
- `POST /api/v1/AdvancedIntegrations/dead-letters/:id/replay`
- `GET /api/v1/AdvancedIntegrations/health`
- `GET /api/v1/AdvancedIntegrations/metrics` — only for authorized administrative diagnostics; no public sensitive metrics.

### 13.5 API requirements

- Every endpoint must check authentication, module scope, record ACL, ownership and operation-specific privileges.
- OAuth callback routes must validate one-time `state` and the intended connection/user/session.
- Do not return tokens, secrets, raw authorization codes or full provider response bodies by default.
- Manual sync, reconciliation, backfill, replay and deletion are privileged actions, audited with actor and reason.
- Bulk sync actions must have limits and preview/dry-run options.
- Rate-limit administrative test/replay endpoints to prevent provider cost or abuse.

---

## 14. Authorization, Privacy, and Audit

### 14.1 Suggested permissions

Align these scopes with the existing ACL model rather than inventing a parallel authorization system.

- `advancedIntegrations.read` — see connections and redacted status.
- `advancedIntegrations.manageConnections` — create/edit/pause/resume/revoke connections.
- `advancedIntegrations.manageCredentials` — initiate OAuth and rotate credentials; never read stored secret values.
- `advancedIntegrations.manageMappings` — configure, validate, publish field/object mappings.
- `advancedIntegrations.runSync` — launch manual sync/backfill/reconciliation.
- `advancedIntegrations.resolveConflicts` — view sensitive conflict details and resolve them.
- `advancedIntegrations.replayWebhooks` — replay failed webhook deliveries/dead letters.
- `advancedIntegrations.viewLogs` — view redacted diagnostics within allowed scope.
- `advancedIntegrations.manageProviders` — enable/disable connector definitions and change global policy.

Connection ownership and access can be further restricted by team/tenant where the current ACL supports it. A connection that contains user-owned calendar data must not become globally visible solely because the integration module is enabled.

### 14.2 Domain ACL is mandatory

Integration execution must not be a privilege-escalation back door. For each imported/updated CRM record:

- Invoke the owning domain service or approved internal integration contract.
- Apply validation, record-level permissions, field-level restrictions, and business invariants.
- Explicitly distinguish system automation identity from human attribution.
- Audit the provider/connection/run that initiated the change.
- Do not allow imported payload fields to assign owners, teams, permissions, roles, payment status, consent, or other protected values unless an explicit reviewed mapping and owning-service policy permits it.
- Honor locked/issued financial-document state from `Sales`.
- Honor unsubscribe/suppression from `MarketingAutomation`.
- Honor communication opt-outs and provider sending policies through `VoiceCommunications`.

### 14.3 Data minimization and retention

- Store only fields needed for the configured integration.
- Provide per-provider/payload retention periods and purge routines for raw payload diagnostics.
- Encrypt sensitive payload references or redact them before persistence.
- Support access logging for sensitive integration details.
- Avoid logging full contact records, calendar descriptions, payment details, full email bodies or bearer tokens.
- Make provider disconnection behavior explicit: stop jobs, revoke grants where possible, retain audit/external ID links as configured, and do not delete synced CRM objects by default.
- Support access/export/deletion requests under a project-approved retention/legal policy without promising unsupported provider-side erasure.

### 14.4 Audit events

Record events for:

- Connection created, updated, enabled, paused, resumed, reauthorized, revoked, or deleted.
- Credential reference created/rotated/revoked (never secret values).
- OAuth scope changes and consent renewal.
- Mapping draft/publish/version changes.
- Manual sync, backfill, reconcile, cancel, retry, replay, conflict resolve, and dead-letter action.
- Large data export/import or a broad field mapping being enabled.
- Security signature failures and repeated connection failures, with rate-limited logs.

---

## 15. Administration UX

### 15.1 Integration catalog

Provide a searchable provider catalog with:

- Provider name/category and concise description.
- Availability and maturity tier (core, optional, experimental, deprecated).
- Capabilities and supported object types.
- Required scopes and setup prerequisites.
- Connection count and health summary where permitted.
- Vendor documentation link.
- Explicit `Configure`/`Connect` action; do not imply a provider is installed/configured merely because its card is visible.

### 15.2 Connection setup wizard

Suggested steps:

1. Choose provider and connection ownership scope.
2. Review required capabilities and permissions.
3. Enter provider identifiers or begin OAuth.
4. Complete consent or secure credential configuration.
5. Test connection and verify expected provider account/tenant.
6. Select objects and sync direction.
7. Configure field mappings, filters, conflict policy and deletion policy.
8. Preview changes and run a dry-run.
9. Enable schedule/webhook subscriptions and publish.

Save progress only if secrets are stored securely and draft status cannot trigger sync jobs before explicit enablement.

### 15.3 Connection detail page

Display:

- Provider, provider account/tenant, owner, connection state, scopes, adapter/API version.
- Last test result, last successful sync, sync lag, next run, last webhook receipt.
- Current warnings: token expiry, missing scopes, rate limit, webhook failures, mapping errors.
- Object mappings and per-mapping on/off status.
- Actions: Test, Reconnect, Pause, Resume, Run Sync, Reconcile, View Logs, Rotate Secret, Revoke.

Mask all credentials. Provide clear confirmation and impact preview for destructive/large operations.

### 15.4 Mapping builder

- Display provider field and CRM field lists with types.
- Warn about required unmapped fields and potentially lossy type conversion.
- Allow admins to preview mapping on redacted sample payloads.
- Highlight protected fields and any mapping that writes to sensitive domain properties.
- Make inbound/outbound directions separately visible.
- Show mapping version and require publish to affect new jobs.

### 15.5 Sync runs and conflict workbench

Sync list/detail views should show status, counts, timing, source/target object, cursor/checkpoint, version, errors, and actions. Conflict UI should show a safe summary of both sides, identify the field authority rule, and require a deliberate resolution. Raw payload access requires a privileged permission and should be time-limited/redacted.

### 15.6 Usability and accessibility

- Follow existing React/TypeScript design and frontend coding standards.
- Support keyboard navigation, visible focus, accessible labels and status announcements.
- Use neutral status indicators with text labels, not color alone.
- Provide localized messages through the project translation system.
- Handle empty, loading, partial, disconnected, degraded, failed, and unauthorized states explicitly.

---

## 16. Observability and Operations

### 16.1 Metrics

Where the existing metrics stack supports them, expose:

- Active connections by provider/status.
- Sync runs by outcome, duration, backlog and queue age.
- Records read/created/updated/skipped/failed/conflicted.
- Provider API request count, latency, throttles, retry counts and circuit-breaker state.
- OAuth refresh failures and connections needing reauthorization.
- Webhook deliveries received, signature failures, duplicate deliveries, processing latency and dead letters.
- Incremental sync lag and cursor age.
- Provider quota usage where exposed.
- Estimated provider cost/usage only where the vendor supplies reliable data and the module is configured to collect it.

Avoid high-cardinality labels that include contact IDs, tokens, raw URLs or other sensitive data.

### 16.2 Structured logs and tracing

- Use structured logs with correlation/trace IDs for connection, sync run, operation, and webhook receipt.
- Log stable error codes and provider request IDs where useful.
- Redact secrets, authorization headers, email bodies, phone numbers, personal data, and sensitive payload fields.
- Do not log complete raw provider payloads by default.
- Provide controlled debug mode with expiry, explicit admin authorization, and additional redaction; do not expose debug mode to ordinary users.

### 16.3 Admin runbooks

Create operational runbooks for:

- OAuth token expired or refresh rejected.
- Required provider scope removed.
- Provider API outage/rate limiting.
- Invalid webhook signature spike.
- Webhook subscription expired or disabled.
- Cursor invalidated and reconciliation required.
- Duplicate records or infinite echo loop detected.
- Large sync stuck or producing too many failures.
- Provider API version sunset/deprecation.
- Credential/key rotation and connection revocation.
- Data retention cleanup and incident response.

---

## 17. Testing Strategy

Tests must follow `AGENTS.MD` exactly. Do not add a framework setup hook that creates a new database or clears the configured database.

### 17.1 Unit tests

- Connector capability validation and registry lookup.
- Connection state transitions and permissions.
- OAuth state validation, callback ownership, token refresh lock, missing scopes, token redaction.
- Mapping compilation, allowed transformations, null/enum/date/decimal conversion, schema validation.
- Cursor persistence, incremental checkpoint advancement and cursor expiration.
- Conflict-policy decision matrix.
- Idempotency key generation and external-link uniqueness behavior.
- Retry classification/backoff/rate-limit handling and circuit breaker.
- Provider webhook signature tests using official fixtures or deterministic synthetic examples.
- Payload-size limits, malformed bodies, replay window and duplicate-delivery handling.
- Data minimization/redaction and retention policy.
- Provider adapter contract compliance.

### 17.2 Integration tests with fake providers

- Complete connection lifecycle without real OAuth.
- Initial full sync followed by incremental changes.
- Multiple pages and opaque cursor persistence.
- CRM record creation/update through owning domain service.
- Repeated webhook delivery and job retry do not create duplicate state.
- Provider timeout after a mutation does not cause duplicate external object creation when retried.
- Conflict records require authorized resolution.
- Pause/revoke connection prevents further external API calls.
- Token refresh failure pauses affected syncs and marks reauthorization required.
- Outbox/job failures can be replayed safely.
- Cross-connection external IDs cannot collide in a way that links the wrong CRM record.

### 17.3 Provider contract tests

Each connector should include contract tests for:

- Request construction, pagination, timeouts and retry classification.
- OAuth scopes and token refresh shape.
- Mapping of representative API responses to normalized objects.
- Webhook signature validation, endpoint validation challenge, event type parsing and delivery deduplication.
- Provider-specific error codes and rate-limit headers.

Use recorded, scrubbed fixtures. Do not check in real user/customer data or live secrets. Where sandbox integration tests exist, make them explicit opt-in and prevent them from running in ordinary CI.

### 17.4 API and UI tests

- ACL coverage for every connection, mapping, sync, conflict, webhook and replay endpoint.
- Admin wizard setup, validation, and masked credentials.
- Mapping preview/dry-run and required-field warnings.
- Sync detail, filter, sorting, pagination and status labels.
- Conflict resolution, stale conflict detection and audit trail.
- Responsive/loading/empty/error/unauthorized states.
- OAuth state mismatch, expired state, wrong user and callback replay attempts.
- SSRF protections for generic REST connector and outbound webhook destinations.

### 17.5 Safe database policy

- Prefer pure unit tests for mapping and runtime policies.
- For integration checks, use the configured primary project database and only additive migrations after review.
- Create isolated test records with a unique `AGENT_TEST_...` marker and unique run ID.
- Cleanup only exact records created by that test. Never truncate tables or globally delete records.
- Never create a second database, shadow database, temporary schema, test container database, or separate database per provider/test.
- Do not run tests against a production connection if the target environment is uncertain.
- Provider integrations must be mocked/stubbed so tests do not send real emails, create real payments, invite users, create Zoom meetings, or mutate live third-party accounts.

### 17.6 Test quality gates

- Type checking and linting pass.
- Unit tests cover core domain rules and critical security branches.
- Integration tests prove idempotency, retry safety, connection state transitions and ACL.
- No secrets, live payloads, or sensitive fixtures in repository.
- OpenAPI and provider compatibility documentation match actual behavior.
- At least one adapter contract test suite can be run against every connector implementation.

---

## 18. Security Threat Model and Required Controls

Threat-model these trust boundaries: CRM users, provider admins, OAuth callbacks, webhook providers, connector adapters, background jobs, external APIs, uploaded/imported payloads, generic REST destinations, and AI-assisted configuration helpers.

### Required controls

- OAuth `state`, PKCE where supported, strict callback URLs, minimal scopes and safe token refresh.
- Encrypted-at-rest credentials or managed secret references, rotation and secret redaction.
- Provider webhook signature verification against the exact required input bytes/canonical string.
- Timestamp/replay checks where supported and durable idempotency for all provider events.
- SSRF defenses, DNS/IP validation, redirect restrictions, scheme/port allowlists and outbound network policy.
- Strict payload size, schema, content type and timeout limits.
- Parameterized SQL and safe identifiers; external names and IDs must never be concatenated into SQL identifiers or expressions.
- ACL checks at both API boundary and domain write/read boundary.
- Rate limiting on provider connect/test/replay/manual sync endpoints.
- No arbitrary code execution in field mappings.
- No card data storage or bypass of Sales payment rules.
- Consent/suppression/opt-out checks through owning modules.
- Audit trail for privileged operations.
- Dependency scanning and regular provider SDK updates according to repository policy.
- Secret and privacy incident response runbook.

### Security acceptance scenarios

1. A regular user cannot view an administrator-owned provider token or connection secret.
2. A malicious OAuth callback cannot attach a provider account to another user's session or connection draft.
3. A forged or replayed webhook cannot trigger CRM updates.
4. A malicious external URL cannot use the generic connector to access cloud metadata endpoints or private network services.
5. A mapping cannot change a locked invoice, privileged owner, unsubscribe status, or field outside the allowed policy.
6. A provider outage cannot cause unbounded retry storms or repeated payment/creation actions.
7. An operator can pause a connection and verify that all related workers stop issuing new provider requests.
8. Secret values and raw personal data do not appear in logs, metrics labels, or API error messages.

---

## 19. Implementation Roadmap

**Execute the phases in order.** Do not implement all connectors in a single pass. Phase 19-INT.0 must produce a repository audit and dependency matrix before any later phase is started.

### Phase 19-INT.0 — Repository Audit and Feature Contract

- Read `PLAN.md`, `AGENTS.MD`, and all relevant completed/planned module plans.
- Inspect module registration, API conventions, metadata, ACL, queue/jobs, external account storage, secrets, email, webhooks, outbox, audit and frontend admin patterns.
- Locate any partial integrations or provider-specific code already present.
- Document existing/partial/missing capability matrix and module boundaries.
- Confirm the first release provider set with tiers; prefer one end-to-end connector path to validate the framework before expanding.
- Create `docs/compatibility/advanced-integrations.md` and the initial provider matrix.
- Run only safe baseline checks; do not create databases or modify schema in this phase.

**Acceptance:** repository findings cite concrete paths/services; scope is reduced to confirmed gaps; no code or schema changes are made until audit is reviewed by the agent itself against actual conventions.

### Phase 19-INT.1 — Feature Contract, Connector Priorities, and ADRs

- Write use cases, out-of-scope list, role matrix and connector tiers.
- Decide organization-level vs user-level connection ownership.
- Define sync consistency, conflict, deletion, retry, cursor, idempotency and retention contracts.
- Create ADRs for secrets storage, generic adapter contract, job topology, and webhook ingestion reuse.
- Define acceptance criteria for one simple provider connector.

**Acceptance:** decisions and unresolved dependencies are documented; no connector is enabled by default.

### Phase 19-INT.2 — Module Registration and Permissions

- Add `AdvancedIntegrationsModule` using the repository's actual module manifest/registry.
- Register routes, metadata, admin navigation, translations and permission scopes according to current conventions.
- Add tests for module disabled/feature unavailable behavior if the project supports module toggles.
- Ensure no prefix `Ua` appears in new identifiers.

**Acceptance:** module loads cleanly, route/metadata registration is tested, no duplicate registrations, and default ACL grants no broad administrative privileges.

### Phase 19-INT.3 — Provider Registry and Capability Model

- Define versioned provider definitions and capability schemas.
- Register provider keys and setup metadata without enabling provider operations automatically.
- Validate connector declarations on module startup or registry initialization.
- Provide a provider capability query to the admin UI.

**Acceptance:** unknown capability/operation combinations are rejected early; unsupported capabilities do not appear as executable UI actions.

### Phase 19-INT.4 — Connection Lifecycle and Secret Storage Adapter

- Implement connection states and domain services.
- Integrate the existing secret store; if none exists, implement a narrow vault port and reviewed encrypted storage adapter.
- Add secret reference lifecycle, masking, rotation, revocation and deletion behavior.
- Add redaction helpers for structured logs and API responses.

**Acceptance:** secrets never appear in normal read responses/logs; connection state transitions are tested; credential access is permission-gated.

### Phase 19-INT.5 — OAuth Authorization and Reconnect

- Implement stateful OAuth initiation and callback flow with correct user/connection binding.
- Add PKCE for selected providers when supported/recommended.
- Implement scope persistence, mismatch handling, token refresh locking, revocation and reconnect.
- Add expiry and reauthorization notifications using existing notification/jobs systems.

**Acceptance:** callback forgery, replay, CSRF, scope mismatch and token refresh races are tested with fake provider responses.

### Phase 19-INT.6 — Connector SDK and HTTP Reliability

- Implement the typed adapter port, normalized error model, provider capabilities, timeout handling, retry hints and logging hooks.
- Add provider HTTP client factory with restricted redirect behavior, configured timeouts, safe logging and rate-limit support.
- Add adapter contract tests and a fake provider adapter.

**Acceptance:** a fake connector can validate, list schemas, fetch pages and return normalized errors without depending on a vendor SDK.

### Phase 19-INT.7 — External ID Links and Record Resolution

- Implement external object links and uniqueness constraints.
- Define duplicate matching and stable external identifier handling.
- Route CRM creates/updates through the owning domain service.
- Add ownership/tenant isolation checks to external record lookup.

**Acceptance:** repeated import of the same external ID links to the same permitted CRM record; ambiguous duplicates create a review result instead of random matching.

### Phase 19-INT.8 — Mapping Builder and Transformation Compiler

- Implement object mappings, field mappings, mapping versioning and a safe allowlisted transformation compiler.
- Validate CRM/provider schema compatibility, required fields, enum mappings, decimal/date/time semantics, and null behavior.
- Add redacted preview and dry-run endpoints.
- Prevent mapping changes from altering configuration used by already-running jobs.

**Acceptance:** preview/dry-run executes no provider mutation and no CRM write; invalid mapping is blocked at publish time.

### Phase 19-INT.9 — Sync Orchestrator and Checkpoints

- Implement full/incremental sync interfaces, run/operation persistence and checkpoint storage.
- Add pagination/batching, bounded concurrency, pause/cancel behavior and durable run status.
- Ensure checkpoint advancement happens only after successful durable processing.

**Acceptance:** fake-provider full and incremental sync is resumable, memory bounded, idempotent, and observable through run details.

### Phase 19-INT.10 — Conflict Resolution and Deletion Policy

- Implement conflict records, field authority, safe conflict policies and resolution actions.
- Implement explicit deletion/unlink/archive behavior per object mapping.
- Require confirmation for bidirectional sync and high-impact overwrite policies.

**Acceptance:** ambiguous field conflicts do not silently overwrite data; stale resolution requests are rejected; provider deletes do not trigger hard CRM deletion by default.

### Phase 19-INT.11 — Retry, Rate Limit, Circuit Breaker, and Dead Letters

- Add bounded retries with exponential backoff/jitter and provider Retry-After handling.
- Add connection/provider concurrency limits and fairness.
- Add dead-letter persistence, replay policy, manual retry and circuit-breaker status.
- Pause permanently invalid connections rather than repeatedly consuming quota.

**Acceptance:** tests prove no unbounded retry, no duplicate operations after retry, fair queueing and reliable pause/revoke handling.

### Phase 19-INT.12 — Webhook Ingress and Event Processing

- Reuse the core webhook subsystem where available; add provider-specific adapters for signature validation and payload normalization.
- Capture raw bodies where necessary, verify signatures, check replay window and enforce unique delivery keys.
- Persist and enqueue event processing before acknowledging delivery.
- Implement provider challenge/validation handshakes where required.

**Acceptance:** invalid signatures are rejected; duplicate/out-of-order events are idempotent; the endpoint responds within provider-required limits; expensive processing runs asynchronously.

### Phase 19-INT.13 — Outbound Sync, Outbox, and Echo Prevention

- Connect CRM domain events/outbox to connector outbound operations.
- Add field-level authority, origin markers, echo-loop prevention and outbound queue records.
- Use provider idempotency support where available.
- Add explicit outbound opt-in and dry-run for each mapping.

**Acceptance:** changing a synced CRM record results in one intended provider operation; provider-originated updates do not create an infinite sync loop.

### Phase 19-INT.14 — Admin UX: Catalog, Connection Wizard, and Health

- Build provider catalog, setup wizard, connection details/health and masked credential UX.
- Add test connection, scope display, reauthorize, pause/resume, revoke, and operator warnings.
- Follow existing SPA navigation, forms, tables, localization, accessibility and error-state conventions.

**Acceptance:** an administrator can configure a fake connector end-to-end with clear permission/scope feedback; no secret appears after save.

### Phase 19-INT.15 — Admin UX: Mapping Builder, Sync Runs, and Conflicts

- Build object/field mapping UI, preview/dry-run and publish/version behavior.
- Build sync run/operation details, filters, logs and retry controls.
- Build conflict workbench with before/after summaries and stale-record detection.

**Acceptance:** admins can identify why a record failed, change a mapping safely, and retry only eligible operations without resetting the whole sync.

### Phase 19-INT.16 — Google Workspace Connector

- Implement Calendar/Contacts through the adapter SDK and the selected official API versions.
- Implement OAuth scopes, calendar selection, event/attendee mapping, sync tokens and private-event policy.
- Add reconciliation and cursor invalidation handling.

**Acceptance:** connector contract and fake-provider tests pass; optional sandbox tests are opt-in; limitations are documented.

### Phase 19-INT.17 — Microsoft 365 Connector

- Implement Outlook Calendar/Contacts through Microsoft Graph as selected during audit.
- Add delta query/change notification flow where supported, subscription renewal and Graph throttling handling.
- Delegate mailbox transport/authentication to shared email infrastructure where available.

**Acceptance:** delta paging/cursor persistence, subscription renewal, missing-scope state and duplicate event handling are tested.

### Phase 19-INT.18 — Zoom Connector

- Implement meeting creation/link metadata and approved event synchronization.
- Add Zoom webhook signature verification and endpoint validation challenge.
- Keep recordings disabled unless a separate privacy/retention decision is approved.

**Acceptance:** timeouts/retries do not duplicate external meetings; invalid/replayed webhooks do not modify CRM.

### Phase 19-INT.19 — Stripe Connector

- Implement approved Stripe-to-Sales object mapping and payment event reconciliation.
- Add raw-body webhook verification, provider event deduplication, idempotency keys, test/live mode separation and audited domain transitions.
- Verify no generic sync path bypasses Sales financial invariants.

**Acceptance:** duplicate/out-of-order events are safe; tests use stubs or Stripe test mode only when explicitly opted in; no real charge occurs.

### Phase 19-INT.20 — Mailchimp Connector

- Implement audience/member sync and selected campaign activity/statistics synchronization.
- Define exact `MarketingAutomation` consent/suppression contract and preserve unsubscribe/complaint status.
- Add webhook ingestion and periodic reconciliation.

**Acceptance:** ordinary profile sync cannot silently resubscribe a suppressed member; duplicate deliveries are idempotent; campaign metrics map to documented CRM objects.

### Phase 19-INT.21 — Meta Lead Ads Connector

- Implement authorized lead form selection, retrieval, field mapping and source metadata.
- Add stable submission ID mapping, duplicate policy, consent/source provenance and permission-expiry diagnostics.
- Add rate-limit handling and reconciliation path for missed events.

**Acceptance:** repeated submission import is idempotent; unsupported/missing provider permissions pause the connector safely.

### Phase 19-INT.22 — Ecommerce Connector Framework and First Provider

- Select Shopify or WooCommerce first based on user priorities and confirmed sandbox/access.
- Implement customer, product/variant and order events limited to the chosen first-release mapping.
- Verify webhooks using the provider's current algorithm, raw-body requirements and unique delivery identifiers.
- Route order/invoice/payment transitions through Sales domain contracts.

**Acceptance:** duplicate webhook deliveries do not duplicate orders; external deletes do not hard-delete CRM financial records; test store credentials are kept outside committed config.

### Phase 19-INT.23 — Accounting Connector Framework and First Provider

- Select QuickBooks Online or Xero first after repository audit and region/sandbox review.
- Implement the minimum approved object set: customer matching plus outbound invoice/payment references or the specific contract agreed with `Sales`.
- Preserve currency, decimal, tax/account mappings and locked-document behavior.
- Add reconciliation for ambiguous timeouts and provider-side edits.

**Acceptance:** duplicate invoices are prevented; financial state changes pass through Sales services; accounting-specific limitations and deployment setup are documented.

### Phase 19-INT.24 — Data Enrichment and Generic REST Connector

- Implement a bounded enrichment-provider interface, field opt-in, preview/accept/reject and cost/quota tracking where supported.
- Implement generic REST only with allowlisted domains/paths, reviewed auth modes, schemas, SSRF guards and strict payload limits.
- Do not make arbitrary outbound HTTP or raw code execution available to ordinary users.

**Acceptance:** enrichment cannot overwrite protected values outside policy; generic REST SSRF/security tests pass; malformed provider responses are rejected safely.

### Phase 19-INT.25 — Cross-Module Integration Contracts

- Add explicit contracts/adapters with `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, `AIAgents`, and `VoiceCommunications` as applicable.
- Publish integration events only through approved contracts/outbox.
- Preserve each module's ownership of consent, communication delivery, financial transitions, and customer workflows.
- Add cross-module tests for ACL propagation and event-loop prevention.

**Acceptance:** integrations remain optional and isolated; disabling one dependent module does not crash core CRM or unrelated providers.

### Phase 19-INT.26 — Observability, Security Hardening, and Retention

- Add metrics, logs, trace/correlation IDs, redaction, health state, alert thresholds and operator runbooks.
- Implement retention jobs for sync logs/raw payload references/conflicts/dead letters according to approved policy.
- Run threat model review including OAuth, SSRF, provider webhook forgery, replay, secrets, tenant isolation and data exports.
- Verify all administrative actions are audited and permission-checked.

**Acceptance:** security scenarios in Section 18 pass; operational failures are diagnosable without exposing secrets or unnecessary personal data.

### Phase 19-INT.27 — End-to-End QA, Documentation, and Release Readiness

- Run type checks, lint, unit tests, adapter contracts, safe DB integration tests, API tests and UI tests.
- Validate migration compatibility against the existing configured database without resetting/recreating it.
- Verify provider setup docs, credentials/secrets runbook, supported API versions, limitations, incident response and rollback/disable plans.
- Confirm feature flags/provider enablement defaults are safe.
- Record acceptance evidence and known gaps per provider.

**Acceptance:** a reviewer can install/configure a provider from documentation, understand its data flows and permissions, inspect sync errors, disable it safely, and recover from a failed operation without data loss.

---

## 20. Definition of Done

The module is complete only when all applicable criteria are satisfied:

- [ ] `AdvancedIntegrations` is registered using repository conventions and no new identifier uses a `Ua` prefix.
- [ ] Repository audit and integration dependency matrix are committed.
- [ ] Provider definitions declare version, capabilities, scopes, limits, and limitations.
- [ ] Connections have explicit lifecycle and ownership; credentials are encrypted or managed by the approved secret store.
- [ ] OAuth flows validate state/callback ownership and handle refresh/revocation safely.
- [ ] Connector contract tests run against every implemented adapter.
- [ ] External ID links and unique constraints prevent duplicate records.
- [ ] Mapping supports only validated, allowlisted transformations; dry-run and preview do not write data.
- [ ] Full/incremental sync uses durable cursors/checkpoints and handles cursor expiration.
- [ ] Retries, rate limits, circuit breaker, cancellation, dead letters and replay are bounded and auditable.
- [ ] Webhook signatures, replay protections, idempotency and asynchronous processing are implemented per provider.
- [ ] Conflict and deletion policies are explicit; no hard delete happens by default.
- [ ] Admin users can diagnose and safely operate integrations without seeing raw secrets.
- [ ] ACL is applied at API, mapping, sync, webhook replay and domain-write levels.
- [ ] Integration behavior does not bypass `Sales`, `MarketingAutomation`, `VoiceCommunications`, or other owning modules' business rules.
- [ ] Secrets/raw payloads/sensitive data are redacted and subject to documented retention.
- [ ] No automated tests send live messages, create real meetings, or generate real financial effects.
- [ ] No test database, shadow database, test schema, or per-run database has been created.
- [ ] Migrations are additive and reviewed; the existing primary database was not reset or broadly cleaned.
- [ ] Documentation and OpenAPI accurately reflect what is implemented, not merely what is planned.
- [ ] Unimplemented providers and known limitations are explicitly recorded.

---

## 21. Suggested First Release

To prove the shared framework before implementing all providers, the recommended first release is:

1. Provider registry and connection lifecycle.
2. Secure credential storage and OAuth callback handling.
3. Adapter contract and fake provider.
4. External ID mapping, field mapping, and preview/dry-run.
5. Sync run/checkpoint/retry/idempotency.
6. Webhook receipt and signature-verification contract.
7. Integration admin UI, logs, and health.
8. One productivity connector (Google Workspace **or** Microsoft 365) chosen based on actual user priority and available provider app credentials.

Only after this vertical slice is stable should the agent build the remaining provider adapters. This avoids implementing several providers on top of an unproven sync/credential framework.

Do not silently reduce the intended scope: record later connectors in the provider matrix with status `planned`, `blocked`, or `deferred` and a reason.

---

## 22. Final Implementation Rules

- Build in the roadmap order and complete one sub-phase at a time.
- `19-INT.0` is an audit/documentation phase, not a license to rewrite existing code.
- Use existing platform services and module contracts; do not duplicate CRM kernel or owning-domain business rules.
- Use the real repository's package manager, scripts, migration process, and conventions.
- Keep secrets out of code, logs, API payloads, screenshots, fixtures, and final summaries.
- Never assume a planned provider connection or vendor permission is available; document setup prerequisites.
- Never auto-enable two-way sync, provider writes, destructive sync, or broad OAuth scopes.
- Never use generic mapping to override consent, payment states, locked invoices, access controls, or other protected domain state.
- Follow `AGENTS.MD` for every database operation and all test runs.
- Report exactly what was implemented, what tests were actually run, what provider sandbox checks were skipped, and what limitations remain.

