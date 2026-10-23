# Phase 19-ES.0 — Repository audit and feature contract

> `PLAN_Phase_19_ESignature.md` §18 `Phase 19-ES.0`. Continued by
> `esignature-es1-completion-report.md` (19-ES.1), `esignature-es2-completion-report.md` (19-ES.2)
> and `esignature-es3-completion-report.md` (19-ES.3).
> Acceptance: no code or migration before this document; no assumption that a planned service
> exists; provider scope and integration contracts agreed; no test database and no duplicate
> generic entity created.

Audited: `PLAN.md`, `AGENTS.MD`, `pnpm-workspace.yaml`, `apps/api/src`, `apps/worker/src`,
`apps/web/src`, `packages/*`, `database/migrations`, `database/seed-metadata.ts`,
`docs/compatibility/*` and the existing domain modules (Advanced Integrations, Sales,
Service Desk, Customer Success, Marketing Automation, AI Agents, Voice Communications,
Projects, Portal, CRM Chat).

Provider facts re-verified against public DocuSign documentation and the npm registry on
**2026-10-22** (plan §3 requires re-checking at implementation time). See
`docs/compatibility/esignature.md` for the provider-side record.

---

## 1. What the platform already provides

| Capability | Where | What the module reuses |
| --- | --- | --- |
| Module wiring | barrel `apps/api/src/<module>/index.ts` + two spreads in `apps/api/src/app.module.ts` (controllers before `ENTITY_CONTROLLERS`, `app.module.ts:150`) | the exact registration pattern of `advanced-integrations`, `service-desk`, `sales` |
| Authentication | `apps/api/src/auth` (`AuthGuard` as `APP_GUARD` at `app.module.ts:280-284`, `@Public()`) | bearer sessions; the webhook route opts out explicitly |
| Authorization | `apps/api/src/acl/acl-api.service.ts:70` | `canUser`, `assertAccess`, `canAccessRecord`, `assertRecordAccess`, `recordPredicate`, `fieldAccess`, `stripRestricted`; module permission services map capability keys to synthetic ACL resources (`advanced-integrations-permission.service.ts:24-88` precedent) |
| Users / Teams / Roles | `users`, `teams`, `roles` (`permissions`/`field_permissions` JSONB, `001_init.sql:59-68`) | role-based capability grants; no new permission tables |
| Metadata entities | `database/seed-metadata.ts` → `metadata_entries`; `apps/api/src/metadata/metadata-store.service.ts:49-89` | optional metadata entities; validation via `packages/metadata` schemas |
| Generic record store | `entity_records` (`001_init.sql:115-134`) with `version` (optimistic concurrency) and `deleted_at` (soft delete); `packages/entity-engine` | reference representation of source records; no business record of this module needs the generic store (see §6) |
| Generic CRUD API | `apps/api/src/entity/entity.service.ts:88` (`EntityCrudService`), `ListEnvelope` | only if a metadata entity is added; not the primary surface |
| Audit | kernel `AuditSinkService` → `audit_log` (`apps/api/src/audit/audit-hooks.ts:118-214`, registered `app.module.ts:390`); module-scoped trail precedent `integration_audit_log` (`integration-audit.service.ts`, migration `060`) | kernel hook for any metadata entity; dedicated append-only `signature_audit_entry` table for lifecycle actions that are not record edits (plan §6.6) |
| Domain events + outbox | `EventBus.dispatch(tx, {type, payload})` (`apps/api/src/events/event-bus.ts:25-37`, `<module>.<event>` camelCase) → `outbox_events` same-tx → worker `OutboxPoller` → `DomainEventBus` | `ESignature.RequestSent`, `ESignature.RequestCompleted`, … with the platform's at-least-once semantics |
| Jobs | `JobsService.enqueue` (`apps/api/src/jobs/jobs.service.ts:52-64`, name `<module>.<action>`); BullMQ queue `crm-jobs` + durable `jobs` table; worker handler pattern calling the API with `x-worker-secret` (`apps/worker/src/handlers/customer-success-handlers.ts:40-79`) | async webhook processing, artifact retrieval, reconciliation; cron via `scheduled_jobs` rows in `database/seed.ts` |
| Settings | `app_settings` one validated JSON row per module (`advanced-integrations-settings.service.ts`, key `AdvancedIntegrations`); optional `SettingsRegistryService` | one `ESignature` settings document (feature flags, policy: embedded signing off by default, document size/count caps, approval policy) |
| Secret encryption | `ENCRYPTION_KEY` + AES-256-GCM `encryptSecret`/`decryptSecret` (`packages/core/src/utils/crypto.ts`); encrypted vault precedent `credential-vault.ts` → `integration_credential_secrets` (never in `entity_records.attrs`) | **Revised in ES.4:** the *cipher and the port shape* are reused; the table is not. `integration_credential_secrets.connection_id` foreign-keys `integration_connections (id)`, so an ESignature credential cannot live there — `esignature_credential_secrets` (migration `065`) mirrors the column set and `kind` vocabulary instead |
| OAuth grant machinery | `OAuthFlowService` (`apps/api/src/advanced-integrations/oauth-flow.service.ts`): unpredictable single-use hashed `state` in `integration_oauth_states`, optional PKCE, exact callback path constant, atomic state consumption, advisory-lock single-flight refresh, `reauthorization_required` transitions | the flow skeleton, reimplemented over this module's own `esignature_oauth_states` (same FK reason as the vault); DocuSign endpoints, scopes and `userinfo` account resolution in `providers/docusign/` |
| Outbound HTTP | `provider-http-client.ts` (bounded timeout, `AbortSignal`, https + SSRF private-address guard, `redirect: 'manual'`, allow-listed log headers, no body/`Authorization` logging); `ConnectorHttp` JSON wrapper | every DocuSign REST/SDK call goes through an equivalent wrapper |
| Resilience | `resilience.ts`: retry policy with jitter + `Retry-After`, DB token-bucket `ProviderRateLimiter`, DB `ProviderCircuitBreaker` | per-operation retry classes; **send must opt out of blind retry** (plan §4.3) |
| Provider error taxonomy | `provider-error.ts` categories (`transient`, `rate_limited`, `provider_outage`, `authorization`, `permanent_validation`, `conflict`, `configuration_invalid`, `account_mismatch`, `not_found`) + redaction | mapped from DocuSign fault codes; extended with `unknown_outcome` handling at the application layer |
| Webhook ingress | raw-body `preParsing` hook scoped by prefix (`apps/api/src/bootstrap.ts:141-165`); durable receipt tables with unique dedup keys (`integration_webhook_deliveries`, `marketing_provider_webhook_inbox` migration `042`, `voice_webhook_events` migration `051`); timing-safe HMAC verifiers (`connectors/kit/webhook-signatures.ts`); fast `@Public()` 202 + async job | the inbox pattern verbatim; **gap: the raw-body prefix hook must be extended for the ESignature webhook path** (§8) |
| Attachments / files | `attachments` table + `AttachmentService.download` with ACL (`attachment.service.ts:220-225`, `assertRowReadable` :293-308, parent-record ACL via `PARENT_ACL_CHECK_TOKEN` wired `app.module.ts:262-278`); `packages/files` SHA-256 `checksum`/`checksumStream` (`storage/index.ts:89-100`), local/S3 drivers, signature malware scanner; MIME/extension allowlist (`attachment.constants.ts`) | document selection, secure byte retrieval, signed-artifact storage as new attachments parented to the request |
| Immutable snapshot precedent | `apps/api/src/sales/document/snapshot.ts` — canonical JSON → SHA-256 digest in a versioned deep-frozen envelope, recompute-and-verify on read | the exact pattern for the immutable send snapshot (plan §4.3/§6.3) |
| Notifications | `notifications` table + pg trigger → SSE (`063_notification_realtime.sql`, `stream/notification-events.service.ts`); email only via `system.sendEmail` worker job | approval requests, reauthorization required, send-unknown alerts |
| Navigation | seeded page entries with `permission` (`apps/api/src/admin-panel/navigation-defaults.ts:114-124`) gated by `acl.canUser` (`navigation.service.ts:181-182`) | an `ESignature` page entry; entity groups if metadata entities are added |
| i18n | `i18n/<locale>/<module>.json` (loader `apps/api/src/i18n/i18n.service.ts`), SPA via `GET /api/v1/I18n` | `i18n/en/esignature.json` + `i18n/vi/` |
| API conventions | `/api/v1/<Module>` controllers with `@ApiTags`, Zod `.strict()` DTO shapes in `dto/*-shapes.ts`, error envelope `{ error: { code, message, details } }` (`global-exception.filter.ts:99-158`), Swagger via `@fastify/swagger` + `GET /api/v1/OpenApi` (`bootstrap.ts:167-175, 204`) | all ESignature endpoints |
| Rate limiting | global `@fastify/rate-limit` (`bootstrap.ts:181-193`) + outbound `ProviderRateLimiter` | webhook and API throttling baseline |
| Correlation | `request.id` → `RequestContext` (`common/request-context.middleware.ts`); receipt `correlation_id` precedent | audit + diagnostics correlation for sends and webhook deliveries |
| Test harness | `apps/api/test/support/boot-api.ts` boot against the configured primary database; fake provider precedents (`connectors/fake/fake-provider.adapter.ts`, voice simulator) | fake `SignatureProviderAdapter` for all automated tests (plan §17) |

**Negative findings (verified by exhaustive grep over `apps/`, `packages/`, `modules/`,
`database/`, `i18n/`, `content/`):** no DocuSign or e-signature code, entity, table, setting,
translation or metadata exists anywhere; no generic signature/e-signature entity; no provider
connection concept beyond `integration_connections` (which is generic-sync-scoped); no CRM
`Document` entity (plan scope item, unimplemented — the de-facto document store is
`attachments` parented to records); no generic `Idempotency-Key` HTTP middleware (idempotency
is per-feature via body keys, DB unique constraints, or deterministic job ids); no realtime
transport other than the notifications SSE feed.

---

## 2. Capability matrix

Legend: **Reuse** = platform service used unchanged; **Extend** = platform artifact extended
additively; **Build** = this module must implement it; **Out** = explicitly out of scope.

| Concern | Decision | Evidence / location |
| --- | --- | --- |
| AuthN / AuthZ | Reuse | `AuthGuard`, `AclApiService` |
| Record-level and field ACL | Reuse | `canAccessRecord`, `assertRecordAccess`, `recordPredicate`, `fieldAccess` |
| Provider connection records | Build (dedicated table) | `integration_connections` is generic-sync control plane, deliberately outside `entity_records` (migration `056` header); an e-signature connection carries DocuSign account/base-URI/Connect state and its own lifecycle |
| Provider adapter contract | Build | no signature-provider abstraction exists |
| DocuSign adapter | Build | no HTTP/SDK wrapper for DocuSign; wraps `provider-http-client` behavior or the official SDK behind the adapter port |
| OAuth connection lifecycle | Reuse skeleton, extend | `OAuthFlowService` state/PKCE/refresh machinery; DocuSign userinfo account/base-URI resolution is adapter work |
| Secrets / credentials | Reuse the primitive, own the table | `ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret`, `credential-vault.ts` as the pattern, `esignature_credential_secrets` as the storage (ES.4) |
| Signature requests | Build (dedicated tables) | no request/envelope entity exists; state machine must not be bypassable via generic `PATCH /api/v1/:entity` (same rationale as migration `056:6-10`) |
| Recipients / routing | Build (dedicated table) | no recipient projection exists |
| Document snapshot + hashes | Build on Reuse | `AttachmentService.download` for authorized bytes; SHA-256 via `packages/files`; immutable envelope pattern from `sales/document/snapshot.ts` |
| Completed artifacts | Reuse attachments | stored as new attachments parented to the signature request; source file untouched |
| Template catalog / role mapping | Build (dedicated tables) | `DocumentTemplate` is a CRM text/HTML template entity, unrelated to provider templates |
| Send preview / approval policy | Build | `packages/bpm` is a generic process engine; the plan scopes approval as module policy (§11), not a BPM deployment |
| Webhook ingress (Connect) | Extend | raw-body prefix hook (`bootstrap.ts:141-165`) gains the ESignature prefix; inbox table modeled on `marketing_provider_webhook_inbox` / `integration_webhook_deliveries` |
| Webhook signature verification | Build | DocuSign Connect HMAC scheme differs from Stripe/Zoom/Mailchimp verifiers in `webhook-signatures.ts`; same timing-safe primitives |
| Event dedup / ordering | Reuse pattern | unique dedup key + async processing + reconciliation job, per migration `042`/`051` precedents |
| Jobs / cron | Reuse | `JobsService`, `scheduled_jobs` row in `database/seed.ts`, worker handler calling the module API |
| Domain events | Reuse | `EventBus.dispatch(tx, …)`; consumers must stay idempotent (plan §15.1) |
| Audit | Reuse + Build | kernel hook for record edits; dedicated append-only lifecycle audit table (plan §6.6) |
| Notifications | Reuse | `notifications` table; email via `system.sendEmail` if ever needed |
| Reporting | Reuse (later) | `packages/reports` + dashlets, phase ES.19 |
| Embedded signing | Build | server-side recipient-view generation; URL never persisted/logged |
| Reconciliation | Build | no generic reconciliation framework; job + operator workbench per plan §16/§20 |
| Outbound webhook dispatch to customers | Out | `modules/webhook-integration` already covers outbound events; ESignature only publishes CRM domain events |
| Proprietary signing crypto / CA | Out | plan §2.2 |
| Test database | Out | `AGENTS.MD` §3 forbids it |

---

## 3. Existing records the module must not duplicate

| Existing | Owns | This module |
| --- | --- | --- |
| `Account` / `Contact` / `User` / `Team` | CRM identity | referenced by ID only; recipient snapshots stored on the request, never treated as authoritative Contact state (plan §6.4) |
| `attachments` | file storage, download ACL | selects authorized source files, stores immutable snapshots and signed artifacts as new rows; no second file store |
| `DocumentTemplate` | CRM text/HTML templates | untouched; provider templates are DocuSign-side objects addressed by provider template ID |
| `integration_connections` / `integration_credential_secrets` | generic sync-connector control plane and vault | not shared: both key on `integration_connections (id)`. An `ESignatureConnection` row is a separate, purpose-owned record (DocuSign account, environment, Connect config) with its own vault table — and it must not be creatable through the generic entity API either |
| Sales documents (Quote/Invoice/…) | commercial lifecycle | linked as source records; a completed signature never mutates financial state (plan §15.1); the frozen `snapshot` envelope pattern is copied, not imported |
| `Case` (Service Desk) | support tickets | optional source/link target only |
| Marketing `MarketingConsent` / suppression | email consent | untouched; DocuSign sends its own signing emails under the DocuSign account |
| `audit_log` / `outbox_events` / `jobs` / `notifications` | kernel services | consumed through their service APIs, never written ad hoc |

---

## 4. Provider scope agreed for this release

Verified 2026-10-22 (public docs + npm registry):

- **Product/API surface:** DocuSign **eSignature REST API v2.1** only
  (`https://developers.docusign.com/docs/esign-rest-api/`). CLM, Rooms, MA, Click and
  Connect *management* APIs are out of scope except the minimal Connect configuration needed
  for status events.
- **Official Node SDK:** `docusign-esign` **10.1.0** (published 2026-10-15, MIT license,
  6 direct dependencies, targets eSignature API v2.1-26.3.01.02; vendor states Node 12+
  compatibility — the repo runs Node ≥22 / pnpm 10). Decision: **evaluate-and-wrap**, not
  hard-adopt — the adapter may use the SDK for envelope/recipient/template operations after a
  dependency/license/transitive review (plan §9.3, formal review in ES.21), with a thin REST
  fallback through the platform HTTP wrapper for anything the SDK cannot express cleanly.
  SDK types never cross the adapter boundary.
- **OAuth:** OAuth 2.0 with **Confidential Authorization Code Grant as the default** (admin
  initiated; PKCE-compatible). JWT bearer grant is explicitly non-default and requires a
  separate administrator setup path + security review (plan §9.2). Hosts: demo
  `account-d.docusign.com`, production `account.docusign.com`; token endpoint `/oauth/token`;
  account context from `GET /oauth/userinfo` → `accounts[]` → `account_id` + `base_uri`;
  REST base = `{base_uri}/restapi/v2.1/accounts/{account_id}/` — **never hard-code a data
  center host**. Scopes: minimum set, starting with `signature`; `extended` only if refresh
  lifetime requires it; `impersonation` (JWT) only with approved server-to-server use.
- **Connect (webhooks):** DocuSign Connect delivers envelope/recipient status events to an
  HTTPS endpoint; verification uses the account/config secret with an HMAC signature over the
  raw body (SDK v9+ even exposes Connect secret-key management methods). Exact header/scheme
  and payload fixtures to be captured from a demo account in ES.11 — no guessing.
- **Envelope lifecycle (expected vocabulary, to be verified against live demo payloads):**
  provider `created` (draft), `sent`, `delivered`, `completed`, `declined`, `voided`,
  `deleted`/`timedout`; recipient-level statuses incl. `sent`, `delivered`, `signed`,
  `completed`, `declined`, `autoresponded`. Local mapping isolated in `DocuSignStatusMapper`
  (plan §4.7); unknown values map to `unmapped`, never to success.
- **Signing modes:** remote signing is the baseline; embedded signing via recipient view URL
  is optional, off until administrator policy enables it (plan §4.6).
- **Environment separation:** demo and production are separate integrations keys, secrets,
  redirect URIs, Connect configs and stored account identities; promotion is an explicit
  administrator action (plan §9.4).

---

## 5. Integration contracts agreed

1. **Adapter port** (`providers/SignatureProviderAdapter`): minimal, method-per-need
   (plan §5.2) — connection/account context, template list/detail, prepare, send, status,
   recipients, recipient view, resend, void, artifact/evidence download, webhook
   verify/parse. Unsupported capability ⇒ explicit `NotSupportedByProviderError`, never a
   silent no-op. A `FakeSignatureProviderAdapter` (registered outside production, mirroring
   `fake-provider.adapter.ts`) is the only adapter used by automated tests.
2. **State ownership:** the provider is the signing authority. Local terminal states
   (`completed`, `declined`, `voided`) are reachable only from a verified Connect event or a
   reconciliation API result. CRM users cannot PATCH a request to `completed`.
3. **Send semantics:** one deliberate user action ⇒ at most one provider send. A lost
   response after submission yields `send_unknown` + reconciliation, never a blind retry
   (plan §4.3, §16). Enforced with a stable `sendAttemptId` correlation token and the
   optimistic `version` check on the request row.
4. **Webhook intake:** verify signature (timing-safe) → validate account/connection mapping →
   persist durable inbox row with dedup key → `202` → async worker job processes projection
   updates + appends normalized events + publishes domain events in a transaction.
   Duplicate and out-of-order deliveries must be no-ops on the projection.
5. **Source-record linking:** `sourceEntityType` + `sourceRecordId` validated against
   metadata; read access to the linked record checked before detail/document exposure; no
   hard import of Sales/Projects/CS/ServiceDesk modules — integrations are capability
   detected (plan §2.3).
6. **Events:** `ESignature.*` camelCase events through `EventBus`/outbox; payloads carry IDs
   and timestamps only — no document bytes, tokens, signing URLs or unnecessary recipient
   PII (plan §15).
7. **Jobs:** `esignature.*` names registered in the worker; periodic reconciliation and
   connection-health refresh scheduled via `scheduled_jobs` seeded in `database/seed.ts`;
   the worker reaches module logic through authorized API calls (`x-worker-secret` door),
   per the customer-success/marketing handler pattern.
8. **Errors:** stable module error codes surfaced in the platform envelope
   (`SIGNATURE_REQUEST_INVALID_STATE`, `PROVIDER_NOT_CONNECTED`, `SIGNATURE_APPROVAL_REQUIRED`,
   `PROVIDER_OUTCOME_UNKNOWN`, `RECIPIENT_NOT_AUTHORIZED`, …) via `details` +
   `i18n/en/errors.json`-style mapping; provider internals never leak.

---

## 6. Data model decision

**Dedicated relational tables via one additive migration** (like Advanced Integrations
`056`/`057`, Voice `051`, Marketing `042`) — not `entity_records` metadata entities:

- The request **state machine and send guard must be the only mutation path**; a generic
  `PATCH /api/v1/SignatureRequest/:id` would let a caller move a request between states or
  forge `providerEnvelopeId` without passing the guard. This is the exact rationale recorded
  in `database/migrations/056_phase19_advanced_integrations.sql:6-10`.
- Append-only provider event history, webhook inbox dedup keys, recipient routing order and
  `(connectionId, providerEnvelopeId)` uniqueness are relational constraints the JSONB store
  cannot express (the Service Desk precedent adds only partial indexes on `attrs`; here the
  whole lifecycle is relational).
- Secrets must never be reachable through the generic entity API; connection rows reference
  the encrypted vault only (same invariant as `credential-vault.ts:24-26`).

Planned tables (delivered by ES.2 in `database/migrations/064_phase19_esignature.sql`):
`esignature_connections`, `signature_requests`, `signature_recipients`,
`signature_document_snapshots`, `signature_provider_events` (append-only + dedup unique key),
`signature_webhook_inbox`, `signature_template_mappings`, `signature_audit_entries`.
Source records remain ordinary CRM entities referenced by `(sourceEntityType, sourceRecordId)`.
The delivered shape, the constraints and the rules that came with them are recorded in
`docs/implementation/esignature-es2-completion-report.md`.

---

## 7. Test and database safety

- All automated tests use the **fake adapter**; no test may create a real envelope or send a
  real signing email (plan §17.3). A demo-account smoke test runs only with explicitly
  provided credentials and an approved test case (ES.22).
- Integration/API tests run against the **existing configured primary database**; no test
  database, schema, container or reset is created or added (`AGENTS.MD` §3 — this plan's
  rule takes precedence over any framework default).
- Test records use `AGENT_TEST_...` names and synthetic signer addresses
  (`@example.invalid`); cleanup is by exact IDs from the current run only.
- Webhook tests cover: valid signature, invalid signature, replay/dedup, malformed payload,
  unknown envelope, provider-account mismatch (plan §17.1).

---

## 8. Acceptance evidence for 19-ES.0

| Criterion | Evidence |
| --- | --- |
| Existing and missing prerequisites documented with repository paths | §1, §2, §3 of this document |
| No duplicate framework/entity/job system/secrets service/file service proposed without evidence of absence | §1 negative findings (exhaustive grep), §2 decisions, §3 non-duplication table |
| First provider path and security design reviewed before schema implementation | §4 (DocuSign v2.1, SDK 10.1.0 verified 2026-10-22, OAuth grant + userinfo base-URI resolution, Connect HMAC) + §5 contracts + `docs/compatibility/esignature.md` |
| No database/test setup modified in this phase | this phase changed only documentation files (`git status` shows no code/migration/seed changes) |

### Gaps the later phases must close (build list)

| Gap | First phase |
| --- | --- |
| ESignature module barrel + `app.module.ts` spreads + `/api/v1/ESignature` controller | ES.1 **done** |
| `ESignature` settings document, permissions (synthetic ACL resources), nav entry, i18n catalog | ES.1 **done** |
| Additive migration for the eight tables in §6 (+ indexes, dedup/uniqueness constraints) | ES.2 **done** (`064_phase19_esignature.sql`, applied) |
| Provider adapter port + `FakeSignatureProviderAdapter` + error taxonomy extension (`unknown_outcome`) | ES.3 **done** (`apps/api/src/esignature/providers/`) |
| Provider envelope preparation (draft envelope from the snapshot, idempotent retry, abandonment) | **Delivered ES.9** — DocuSign `POST /envelopes` with `status: 'created'`; `abandonDraftEnvelope` deletes an unsent draft |
| Send preview + preparation (immutable snapshot with a digest, approval-policy routing, invalidation on draft change) | **Delivered ES.8** — `esignature-preview.ts` (pure) + `prepare`/`preview` in `esignature-request.service.ts`; migration `066` adds the mapping binding |
| Template catalog + mapping validation (read-only catalog, roles/tabs against the live template, source fields against metadata) | **Delivered ES.7** — `esignature-template.service.ts`; nothing writes a provider template |
| Signature request draft API (list/detail/create/update, recipients, documents) with capability + record-scope ACL and linked-record ACL | **Delivered ES.6** — `esignature-request.service.ts` / `esignature-request.controller.ts`; the list is scoped by a SQL predicate mirroring `entity-record.store.ts` |
| Secure document snapshots (copy, hash, policy, derived-artifact separation) | **Delivered ES.5** — `esignature-document.service.ts` over the attachment service's ACL and the platform `FILE_STORAGE_TOKEN`; no new table |
| DocuSign OAuth (authorize/callback/refresh/userinfo account + base-URI persistence, vault storage) | **Delivered ES.4** — `esignature-connection.service.ts`, `signature-oauth-state.repository.ts`, `esignature-credential-vault.ts`, `providers/docusign/*`; verified against a stub transport, not a live demo account |
| Secure snapshot service over `AttachmentService` + `packages/files` checksums | ES.5 |
| Draft CRUD + source-record linking with linked-record ACL | ES.6 |
| Template catalog + role/field mapping validation | ES.7 |
| Immutable preview + approval invalidation on change | ES.8 |
| Provider envelope preparation (idempotent, no duplicate drafts) | ES.9 |
| Guarded send + `send_unknown` recovery | ES.10 |
| Connect webhook endpoint — **requires extending the raw-body prefix hook in `bootstrap.ts:141-165` to the ESignature webhook path** + inbox table | ES.11 |
| Status mapper + recipient projection + reconciliation | ES.12 |
| Embedded signing recipient views | ES.14 |
| Completed artifact + evidence retrieval/dedup | ES.15 |
| Reminders/resend/void/correction guards | ES.16 |
| Approval workflow + policy engine | ES.17 |
| Domain entry points + `ESignature.*` events | ES.18 |
| Search/reports/dashlets | ES.19 |
| Ops workbench (stuck/send_unknown/dead-letter views) | ES.20 |
| Hardening + SDK license/dependency review | ES.21 |
| Demo smoke test + release evidence | ES.22 |

### Initial end-to-end slice (agreed for the first demo-verified path)

One **demo** DocuSign connection (admin OAuth) → one source CRM record (synthetic
`AGENT_TEST_` Account) → one attached PDF snapshot (hash recorded) → **one signer** with
routing order 1 → review → explicit send → remote signing → Connect `sent`/`delivered`/
`completed` events update the projection → completed PDF + certificate downloaded as derived
artifacts → source attachment unchanged → full audit/event trail readable. Everything else
(templates, embedded signing, CC, approvals, correction) is deferred until this slice passes
with the fake adapter end-to-end and, deliberately, once against the demo account.

### Environment configuration (names only — no secret values ever recorded)

- Reused as-is: `ENCRYPTION_KEY` (required — vault encryption), `RATE_LIMIT_MAX`,
  `UPLOAD_MAX_MB`, `JOB_*` worker settings.
- Integration keys (decided in ES.1): the `ESignature` settings document holds the demo and
  production DocuSign client ids. `INTEGRATION_OAUTH_CLIENT_IDS` (one map keyed by provider) is not
  reused, because a DocuSign identity is per environment. Optional names a deployment may inject
  instead: `DOCUSIGN_DEMO_INTEGRATION_KEY`, `DOCUSIGN_PRODUCTION_INTEGRATION_KEY`.
- No new mandatory environment variables are expected: per-connection secrets (client secret,
  refresh token, Connect HMAC secret) belong in the encrypted vault, not in the environment.
