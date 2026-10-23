# ESignature — compatibility and behavior reference

> Phase 19-ES.0 to 19-ES.22 deliverables (`PLAN_Phase_19_ESignature.md` §3.3, §18).
> Status: **19-ES.0 through 19-ES.22 delivered** (ES.1 registers the module and the security contract;
> ES.2 adds the schema and the domain rules; ES.3 adds the provider contract, the registry and the
> in-process fake; ES.4 adds DocuSign's OAuth grant, the connection lifecycle and the live adapter;
> ES.5–ES.10 add documents, drafts, templates, preparation and the controlled send; ES.11–ES.16 add
> Connect intake and projection, the progress UI, embedded signing, completed artifacts, and
> reminders/void; ES.17 adds the approval policy and decision workflow; ES.18 adds the lifecycle outbox events and the CRM record entry point; ES.19 adds authorized request search, the operational reports and the ESignature dashlet; ES.20 adds the operations and recovery workbench, guarded webhook retry and the runbook; ES.21 records the threat-model/security review, retention and release hardening; ES.22 records the fake-adapter end-to-end QA, verification matrix and release readiness). **Nothing in this module has
> been verified against a live DocuSign account**: every
> provider behaviour below was proved against an injected stub transport or the fake adapter, and the
> demo-account validation is ES.22's.
> Evidence: `docs/implementation/esignature-es1-completion-report.md` through
> `esignature-es20-completion-report.md` (one report per delivered sub-phase);
> operations procedures: `docs/runbooks/esignature-operations.md`.
> Canonical module name: `ESignature` (no `Ua` prefix). API prefix: `/api/v1/ESignature`.
> Webhook prefix: `/api/v1/integrations/esignature`.
> Note: the Connect HMAC scheme is implemented from DocuSign's documented
> `X-DocuSign-Signature-1` (base64 HMAC-SHA-256 over the raw body); ES.22 must confirm it against a
> captured demo-account delivery before an installation is called verified.

This document records the exact provider surface this module reimplements, the decisions taken
against the repository as it actually exists, and the compatibility limits a deploying
organization must know. A feature is **not** listed as supported until its adapter and
end-to-end behavior pass the relevant tests (plan §17). Provider facts below were verified on
**2026-10-22** against public documentation and the npm registry; each later sub-phase that
touches provider behavior must re-verify and update the date.

This is a clean-room reimplementation. No EspoCRM PHP class, frontend asset, icon, translation
or branding is copied. DocuSign product names are used only to describe the external contract.

---

## 1. Provider product/API surface implemented

| Item | Decision |
| --- | --- |
| Provider | DocuSign (reference adapter, `available`). The module is provider-neutral: a catalog lists every provider this build knows, and `dropbox_sign` is listed as `declared` but not installed |
| API | **eSignature REST API v2.1** (`/restapi/v2.1/accounts/{accountId}/…`) — envelopes, recipients, templates, views, combined documents |
| Out of surface | CLM, Rooms, MA, Click, Connect *management* APIs (beyond minimal Connect event configuration), billing, bulk send, eSign admin APIs |
| API base URI | Discovered per account from `GET {authHost}/oauth/userinfo` → `accounts[]` → `base_uri`; REST calls go to `{base_uri}/restapi/v2.1/accounts/{account_id}/`. A data-center host is never hard-coded |
| Auth hosts | Demo: `https://account-d.docusign.com` · Production: `https://account.docusign.com` |
| Node SDK | `docusign-esign` **10.1.0** (2026-10-15, MIT, targets API v2.1-26.3.01.02, vendor states Node 12+). Adopted **behind the adapter** after dependency/license review (ES.21); SDK types never cross the adapter boundary; a thin REST fallback via the platform HTTP wrapper is allowed where the SDK lags |

### 1.1 Provider catalog

`SIGNATURE_PROVIDER_CATALOG` (`apps/api/src/esignature/providers/signature-provider.catalog.ts`) is
the single source for provider keys, display names, authentication style, document limits and
declared availability. It is exposed read-only at `GET /api/v1/ESignature/action/provider-catalog`
(`connectionRead`) and drives the admin picker and the per-provider settings fields.

| Provider key | Label | Auth style | Status | Connectable |
| --- | --- | --- | --- | --- |
| `docusign` | DocuSign | OAuth 2.0 authorization code (PKCE, confidential client) | `available` | Yes — auth strategy and adapter are bound |
| `dropbox_sign` | Dropbox Sign | API key (planned) | `declared` | No — no adapter, auth strategy or webhook verification is installed |

Rules enforced by code, not documentation:

- A connection may only name an `available` provider that has an authorization strategy registered.
  `dropbox_sign` is refused at create time with a 400 validation refusal that names the missing
  integration, not at the first send.
- Capability support is answered by the bound adapter, falling back to the catalog declaration. A
  `declared` provider declares nothing, so the gate refuses every operation for it.
- A request fixes its provider when its draft is created (or inherits it from the chosen connection)
  and cannot be rebound to a connection of another provider.
- Stored OAuth client ids are per provider and per environment (`provider.clients.<key>.demo` /
  `.production`). The pre-catalog `provider.demoIntegrationKey` / `provider.productionIntegrationKey`
  pair is still read as a fallback for DocuSign so an upgrade does not orphan existing connections.
- Database allowlists were widened by `database/migrations/069_phase19_esignature_provider_catalog.sql`
  (additive; no row is rewritten).

## 2. Supported OAuth flows

| Flow | Status | Why |
| --- | --- | --- |
| Confidential Authorization Code Grant | **Delivered ES.4, unverified against a live account** | An administrator explicitly connects a CRM-owned confidential client with `signature` + `impersonation` (`extended` optional, `agent`/`admin` never requested). Single-use hashed `state`, mandatory PKCE S256, an allowlisted absolute redirect URI stored per connection, `userinfo` deciding the account id and data-center base URI, and an advisory-lock single-flight refresh — the machinery of `apps/api/src/advanced-integrations/oauth-flow.service.ts`, over this module's own state and vault tables. |
| Server-to-server JWT grant | **Not implemented, deliberately** | Plan §9.2 makes it non-default: it needs an approved consent model, a private key in the vault and a separate security review. Adding it later is a new client in `providers/docusign/`, not a flag on this one. |
| JWT bearer grant | Not default; out of the first release | Only for approved server-to-server consent + certificate/key model; requires a separate admin setup path and security review (plan §9.2) |
| Any other grant | Never | DocuSign deprecates legacy grants; a new integration must not use them |

Rules enforced by design: minimum scopes (starting `signature`; `extended` only if refresh
lifetime requires it; `impersonation` only with an approved JWT use case); refresh-token
storage in the encrypted vault (`integration_credential_secrets` + `ENCRYPTION_KEY`), never in
settings, logs, responses or the browser; `consent_required` / `invalid_grant` → connection
moves to `reauthorization_required` and sends are disabled; demo and production clients,
redirect URIs, secrets and stored account identities are fully separate.

## 3. Envelope / recipient / template / signing / document behavior

| Behavior | Status | Notes |
| --- | --- | --- |
| Controlled send + ambiguous outcome recovery | **Delivered ES.10** | `POST /api/v1/ESignature/requests/:id/send` (`{version, confirm}`), `…/send/recover`, `…/reconcile`. One action claims one attempt under a unique index and one provider send; a 4xx is a definite refusal (`provider_error`), a lost answer or 5xx is `send_unknown` and is **never** resent — only reconciliation can conclude it (sent, or provably unsent → recoverable). |
| Provider draft envelope + abandonment | **Delivered ES.9** | `POST /api/v1/ESignature/requests/:id/envelope` (`{version}`) and `…/envelope/abandon`. The envelope is created with `status: 'created'` (no email, no invitation); the local request stays `ready_to_send`. A retry returns the recorded envelope without a second provider call; an edit after preparation is refused with `PREVIEW_OUTDATED`. Sending is ES.10. |
| Send preview and preparation (immutable snapshot, digest, approval routing) | **Delivered ES.8** | `GET /api/v1/ESignature/requests/:id/preview` and `POST …/prepare` (body `{version, confirm}`). Preparation refuses with a named problem list (no document, no signer, duplicate signer address, past expiry, unfilled template role, missing tab value, foreign/inactive mapping); it makes **no provider call**. A draft edit after preparation returns the request to `draft` and drops the snapshot and approval. |
| Provider template catalog and the CRM mapping (roles → recipients, tabs → CRM fields) | **Delivered ES.7** | `POST /api/v1/ESignature/templates/catalog/refresh`, `GET templates/catalog/:connectionId/:templateId`, and `GET/POST/PATCH templates/mappings`. The catalog is read-only; a mapping is validated against that connection's **live** template and the metadata registry, so an unknown role, tab or field is refused when it is saved. |
| Draft request CRUD, recipients and documents, with record-scope ACL and a linked-record check | **Delivered ES.6** | `GET/POST /api/v1/ESignature/requests`, `GET/PATCH /:id`, recipients and documents sub-routes. The prefix is the module's own (`/api/v1/ESignature`), not the lower-case spelling in the plan. A request that left the draft answers 409 `SIGNATURE_REQUEST_INVALID_STATE`, and there is no generic `/api/v1/SignatureRequest` route at all. |
| Immutable document snapshot (copy + SHA-256 of the submitted bytes) | **Delivered ES.5** | `esignature-document.service.ts` copies through `AttachmentService.download`, so the parent record's ACL is the gate, and verifies the copy against the attachment's own checksum. A snapshot survives its source: replacing or deleting the attachment changes nothing about what was recorded. |
| Provider-signed documents and completion certificates as separate artifacts | **Delivered ES.15** | `storeDerivedArtifact` accepts only the derived kinds and writes under a kind-segmented key, so a provider result cannot address a source object. Idempotent by content hash and provider document id (plan §16). |
| DocuSign per-document size and format limits | **Expected, not verified** | `DOCUSIGN_DOCUMENT_RESTRICTIONS` (25 MiB, the documented accepted formats) is the ceiling the settings cannot lift. The ES.0 audit verified the API surface, not these numbers; ES.22 re-checks them against a live account. |
| Connection record and its lifecycle rules | **Delivered ES.2 (storage) + ES.4 (authorization, test, switch, disconnect)** | The row stores environment, account id, base URI, granted scopes and health stamps; no credential column exists — `esignature_credential_secrets` holds those, encrypted, and no read path returns a value. `reauthorization_required` also clears `is_active`, which is what stops a send after a revoked consent. |
| Local request persistence and the guarded lifecycle | Delivered ES.2 | Dedicated tables plus the state machine; an envelope id is unique per connection, and a CRM command cannot enter a provider-owned state |
| Local draft request (no provider call) | Storage ES.2, API ES.6 | A draft is local only; a provider envelope does not exist until preparation |
| Envelope preparation (provider draft) | **Delivered ES.9** | Idempotent via the snapshot digest; unsent provider drafts are abandoned safely (ES.9). |
| Documents from CRM attachments | **Delivered ES.5** (the draft UI that drives it: ES.6) | Authorized bytes only — the attachment service's own ACL is the sole reader; immutable snapshot plus the SHA-256 of the exact submitted bytes; the source file is never overwritten, and the snapshot outlives it |
| Provider templates + role mapping | Planned ES.7 | Template IDs stay bound to the owning account; roles validated against an allowlist |
| Signers, CC, routing order | **Delivered ES.8** | Sequential/parallel routing; explicit sender affirmation of signer identity. |
| Remote signing | **Delivered ES.10; progress UI ES.13** | DocuSign controls the signing journey and sends signing emails. The CRM shows the signer progress and the event/audit timeline without opening the provider dashboard. |
| Embedded signing (recipient view) | **Delivered ES.14, off by default** | A recipient marked `embedded` at preparation gets a server-generated view only when the signed-in user is that recipient and the return/cancel host is allowlisted; the URL is never persisted, audited or logged. |
| Reminders / resend | **Delivered ES.16** | Requires `send`, an open envelope, the `remindersEnabled` policy and the configured cooldown; only a successful provider call starts the window. |
| Void with reason | **Delivered ES.16** | Only `sent`/`delivered`/`partially_signed`; an explicit confirmation and reason are required and audited before and after the provider call. |
| Correction | **Refused by name (ES.16)** | The service checks state and the `correct` right, audits the refusal, and never calls the provider: `correctEnvelope` stays capability-false until ES.22 verifies the live behaviour. |
| Completed documents + certificate | **Delivered ES.15** | Stored as new derived artifacts on the request under the `artifacts` feature; deduped by provider document identity and content hash; download requires `downloadCompleted`. |
| Connect status events | **Delivered ES.11/ES.12** | Raw-body HMAC verification before parsing, a durable unique inbox, best-effort queue hand-off, one normalized event per delivery, monotonic recipient/envelope projection and a reconciliation command for gaps. |
| Status/recipient reconciliation | **Delivered ES.12 (operator action)** | `POST …/reconcile` reads the envelope and recipients from the provider and projects them; terminal drift moves only through reconciliation. No scheduled sweep is registered yet (ES.20). |
| Approval before send | **Delivered ES.17** | Source-type and value/risk rules are evaluated at preparation; a covered request stops in `pending_approval`. The decision binds to the stored digest and reviewed version; any edit (or a change to the reviewed source values) invalidates it. `SignatureApprove` is the explicit approver right, with separation of duties on by default; decisions are audited. |
| Lifecycle domain events | **Delivered ES.18** | `esignature.requestCreated/prepared/approvalRequested/approved/rejected/sent/recipientCompleted/completed/declined/voided/expired/needsReconciliation/completedArtifactAvailable` are written to `outbox_events` in the transaction that caused them. Payloads carry request/provider/source references, status, correlation id and a schema version — no bytes, tokens, signing URLs or recipient emails. The semantic `dedupeKey` is stable across replays and across the send path vs a Connect event for the same fact. |
| CRM record entry points | **Delivered ES.18** | `GET /api/v1/ESignature/action/record-entry` answers availability for a record detail page. Account/Contact are core; Opportunity/Quote/SalesOrder/Invoice, Project/ProjectTask, Case, Campaign and CustomerSuccessProfile are candidates only while their metadata entity exists. The generic SPA card disappears on `available:false`; no optional module is imported by ESignature and no downstream business state is changed automatically. |
| Authorized request search and filters | **Delivered ES.19** | `GET /api/v1/ESignature/requests` accepts `q` (request name/subject/source record id), `recipient` (signer snapshot name/email), status/approval/attention filters and ISO `createdFrom/To`, `sentFrom/To`, `completedFrom/To` bounds. Every predicate is applied **after** the caller's record scope, so a search can never reveal that a request outside their rows exists. |
| Operational reports and dashlet | **Delivered ES.19** | `GET /api/v1/ESignature/action/reports?days=N` returns the curated aggregates; `…/action/reports/:key` runs one. The dashboard's existing `POST /Dashboard/:id/dashlets` accepts the `esignature` kind (`{view, days}`), and `…/action/run` executes it **as the reader**, not the dashboard owner. No aggregate returns a request name, recipient name/email, message, document or URL. |
| Operations and recovery workbench | **Delivered ES.20** | `GET /api/v1/ESignature/action/operations?staleAfterHours&limit` returns connection health (token/webhook/credential facts, no values), webhook inbox counters and deliveries, four request queues (failed, stuck, send_unknown, reconciliation) and failed `esignature.%` jobs. Request rows obey the caller's `SignatureRequest` record scope; the panel requires `SignatureConnection:read`. No provider call is made to build the view. |
| Guarded webhook retry | **Delivered ES.20** | `POST …/action/operations/webhooks/:id/retry` requires `connectionManage`, a verified (or explicitly unrequired) signature, and a `retryable`/`dead_letter` state. It resets the attempt window and re-runs `processDelivery`; it never calls a provider send. A repeated retry is refused by state, and every attempt writes `webhook.retryRequested`. There is no request-send retry route; `provider_error` rows are recover→send from the detail page, and `send_unknown`/stuck rows are reconcile-only. |
| ES.20 health checks | **Delivered ES.20** | `/action/health` adds `token_refresh`, `webhook_secrets`, `provider_errors`, `webhook_inbox` and `credential_age`, derived from stored stamps and credential metadata. They report `ok:false` as data; a provider outage cannot fail the endpoint. |

### 3.1 Report date and status definitions (delivered ES.19)

Each aggregate states which timestamp its window applies to. `days=N` is a rolling window ending at
the request's own clock; `days=0` means all time. All aggregates first apply the caller's
`SignatureRequest:read` record scope (`own`, `team`, `all` or the administrator wildcard), exactly
like the request list.

| Report key | Population and window | What is counted |
| --- | --- | --- |
| `status` | Requests **created** in the window; the **current** status is reported | Count per normalized status (`draft` … `reconciliation_required`). A request created earlier and completed inside the window does not appear here — `rates` is the outcome view. |
| `rates` | Cohort **sent** in the window (`sent_at`), whatever the current status | `completed`, `declined`, `voided`, `expired`, `inFlight` counts and rates with the sent cohort as denominator. In-flight requests are in no numerator, so the rates do not claim to sum to 100%. |
| `approvals` | **Current** queue; window-independent | `status = pending_approval` **and** `approval_status = pending`; aged from `approval_requested_at` (older than 24 h / 3 days bins). |
| `waiting` | **Current** state; window-independent | Requests in `sent`, `delivered` or `partially_signed` with recipients in `pending`, `sent`, `delivered` or `viewed`. Optional `recipient` narrows by signer name/email inside the caller's scope. |
| `completionTime` | Requests **completed** in the window (`completed_at`) | Duration `completed_at − sent_at` in hours, only when both timestamps exist and the order is valid. Average is the arithmetic mean; median and p90 use `percentile_cont(0.5)` / `percentile_cont(0.9)`. |
| `exceptions` | **Current** queue; window-independent | `send_unknown`, `provider_error`, `reconciliation_required`, split by status and by the sanitized `failure_category`. |
| `volume` | Requests **created** in the window | Counts by CRM `source_entity_type` (empty = no linked record) and by `assigned_user_id` (empty = unassigned), top 50 each, opaque ids only. |

Status meanings are the ES.12 vocabulary documented in §4 below. "Completed" here always means the
local status `completed`, reachable only from a verified provider event or reconciliation — never an
inference from all recipients signing.

### 3.2 Recovery queue and retry definitions (delivered ES.20)

- **Stuck** — `sending` for more than 15 minutes, or an in-flight request (`sent`, `delivered`,
  `partially_signed`) whose `coalesce(last_provider_sync_at, sent_at, modified_at)` is older than the
  workbench's `staleAfterHours` (default 24), or whose `expires_at` has passed.
- **Failed / send-unknown / reconciliation** — the exact statuses `provider_error`, `send_unknown`
  and `reconciliation_required`. They are disjoint, not inferred.
- **Reconcile** is offered for a stuck or ambiguous request and is the only recovery for
  `send_unknown`. A `provider_error` row explicitly reports `reconcileAllowed: false`; its recovery is
  the deliberate recover→send path on the detail page, which re-runs approval and the send guard.
- **Webhook retry** applies only to a `verified` (or explicitly `not_required`) receipt in
  `retryable` or `dead_letter`. It resets the bounded attempt window and re-runs the normal
  projection; the dedup key is unchanged. An `invalid` receipt is never applied.
- **No request-send retry exists** in any API. This is the structural answer to duplicate sends.

## 4. Local state ↔ provider state mapping (delivered ES.12 — live fixtures pending ES.22)

Local request states (plan §4.7): `draft`, `pending_approval`, `ready_to_send`, `sending`,
`send_unknown`, `sent`, `delivered` (aggregate, only if unambiguous), `partially_signed`,
`completed`, `declined`, `voided`, `expired`, `provider_error`, `reconciliation_required`.

The vocabulary below is what the ES.12 mapper (`esignature-status-mapper.ts`) implements. It is
proved against the fake and stub transports; **captured demo-account payloads in ES.22 remain the
authority** and any correction lands in that one mapper.

| Provider envelope status | Local target | Rule |
| --- | --- | --- |
| `created` (draft, unsent) | `ready_to_send` / prepared | provider draft exists; request not yet sent |
| `sent` | `sent` | first trusted event after send |
| `delivered` | `delivered` or stay `partially_signed` | aggregate only when unambiguous |
| (recipients signed, envelope open) | `partially_signed` | a recipient completing never completes the envelope |
| `completed` | `completed` | **only** from a verified Connect event or reconciliation API result |
| `declined` | `declined` | recipient decline reason stored, sanitized |
| `voided` | `voided` | |
| `deleted` / `timedout` / expiry | `expired` / terminal per evidence | |
| unmapped / unknown | keep prior state + `unmapped` event | unknown is never success |

Recipient statuses expected: `created`, `sent`, `delivered`, `signed`, `completed`,
`declined`, `autoresponded` (to verify). Out-of-order or duplicate events never move a
terminal state backwards; ambiguity triggers reconciliation (plan §4.7, §10.3).

## 5. Known provider-plan / account limitations

- Feature availability (embedded signing, bulk, advanced recipient auth, Connect
  configuration options, certificate of completion retention) depends on the DocuSign account
  plan and account settings; the admin runbook must verify the account's capabilities before
  enabling dependent features.
- The Connect HMAC **mechanism** (base64 SHA-256 over the raw body, constant-time compare) is implemented
  in `providers/signature-provider-signature.ts`; the **exact header layout and payload fixture** are
  captured from a demo account in ES.11 before any installation is called verified. The fake adapter
  signs with the same mechanism and is not evidence about DocuSign's wire format.
- Connect must be configured on the DocuSign account (or via an approved management path) to
  point at the CRM webhook URL; event coverage and delivery guarantees are the provider's.
- Provider status vocabulary and payload shapes evolve; stored raw event metadata is
  minimized and versioned, and the status mapper is the single translation point.
- Rate limits, throttling and Retry-After behavior are the provider's; the adapter honors
  them through the platform resilience layer.

## 6. Unsupported / explicitly excluded (initial release)

- Any non-DocuSign provider (adapter contract only until DocuSign is end-to-end stable).
- JWT grant, multi-provider failover, provider template authoring/editing, bulk sending,
  CLM/Rooms/Click, marketplace/billing.
- Automated/AI-initiated sends (disabled by default; human approval required — plan §11.3).
- Any claim of qualified electronic signature status, jurisdictional compliance (ESIGN/UETA/
  eIDAS/…) or legal enforceability — DocuSign remains the signing authority and compliance
  provider; this module is an operational orchestration and evidence layer (plan §1.2, §2.2).

## 7. Tested account configurations

| Configuration | Status |
| --- | --- |
| Fake adapter (no provider) — full lifecycle | **Delivered ES.3** — the initial slice runs end to end against it, including the lost-send/`send_unknown` recovery (`apps/api/test/esignature-flow.test.ts`). It is bound outside production, so a development install answers a Test Connection from the fake and the API says so (`adapterMode`). |
| Live DocuSign adapter | **Delivered ES.4–ES.16** — every operation except `correctEnvelope` | Connection, templates, envelope preparation/send, status and recipients, recipient view, resend, void, signed documents, certificate and Connect verification are implemented; correction remains declared `false`, so the gate refuses it by name (plan §5.2). |
| DocuSign demo/developer account, single account, authorization-code grant, remote signing, Connect events | Operator step for ES.22; not executed in this environment (no credentials). Fake-adapter E2E passed. Record date and outcome here when performed |
| Production account | Not tested; remains disabled until an explicit administrator enablement (plan §9.4) |

## 8. Environment and secret handling (names only)

- Reused env: `ENCRYPTION_KEY` (vault), `RATE_LIMIT_MAX`, `UPLOAD_MAX_MB`, worker `JOB_*`.
- Non-secret integration keys: **the `ESignature` settings document**, now keyed per provider
  (`provider.clients.<providerKey>.demo` / `.production`). The original DocuSign pair
  (`provider.demoIntegrationKey`, `provider.productionIntegrationKey`) is still read as a fallback so
  an upgrade keeps its connections. `INTEGRATION_OAUTH_CLIENT_IDS` is not reused:
  it is one JSON map keyed by provider, and DocuSign identities are per environment (demo and
  production never share a client). `DOCUSIGN_DEMO_INTEGRATION_KEY` /
  `DOCUSIGN_PRODUCTION_INTEGRATION_KEY` are recorded as names a deployment may inject instead; both
  are public client ids, and no new mandatory variable was added.
- Per-connection secrets (client secret, refresh token, Connect HMAC secret) live only in
  the encrypted credential vault. No secret values are ever committed, logged, returned by
  the API, or embedded in frontend builds or documentation (plan §4.1, §21).

## 9. Upstream references (verified 2026-10-22)

- eSignature REST API overview: https://developers.docusign.com/docs/esign-rest-api/
- eSignature how-to guides: https://developers.docusign.com/docs/esign-rest-api/how-to/
- Authentication overview: https://developers.docusign.com/platform/auth/
- Confidential Authorization Code Grant: https://developers.docusign.com/platform/auth/confidential-authcode-get-token/
- Embedded signing: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/
- DocuSign Connect webhooks: https://developers.docusign.com/platform/webhooks/connect/
- Node.js SDK: https://github.com/docusign/docusign-esign-node-client (npm `docusign-esign` 10.1.0)
- Recipients API: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/enveloperecipients/list/
- API endpoint base paths / go-live: https://developers.docusign.com/docs/esign-rest-api/go-live/
