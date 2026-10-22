# PLAN — Phase 19: ESignature Module (`ESignature`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Module name:** `ESignature`  
> **Module key / slug:** `esignature`  
> **Backend module class:** `ESignatureModule`  
> **Frontend route:** `/esignature` (follow the repository's established routing convention)  
> **Target stack:** NestJS, strict TypeScript, PostgreSQL, Kysely (or the repository's already-adopted SQL layer), React, and the existing CRM platform services.  
> **First provider adapter:** `DocuSignAdapter` using DocuSign eSignature REST API v2.1 and the official Node.js SDK where appropriate.  
> **Implementation approach:** Clean-room domain implementation. Reuse existing CRM kernel and module services; do not port PHP source or recreate existing infrastructure.

---

## 0. Instructions for the Coding Agent

Read these files before implementation:

1. `AGENTS.MD`
2. `PLAN.md`
3. Any existing plans for `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `AdvancedIntegrations`, `AIAgents`, and `CRMChat` if they are present in the repository.
4. The actual repository code, module manifests, migration history, API conventions, frontend conventions, and test scripts.

**Start with Phase 19-ES.0 only.** Do not implement later phases until the repository audit has identified what is already available and recorded the feature contract. Plans are intended requirements, not proof that a class, entity, service, or infrastructure component already exists.

### Non-negotiable rules

- The module's public name is **`ESignature`**. Do not prepend `Ua` to module, class, route, entity, package, or event names.
- Build an independent TypeScript/NestJS implementation based on public APIs and documented behavior. Do not copy or mechanically translate EspoCRM source files, upstream assets, translations, icons, or branding.
- Reuse existing authentication, Users, Teams, ACL, Entity Engine, metadata, API response conventions, validation, Audit/History, Attachments/Documents, Activities, notifications, job queue, logging, settings, encryption/secrets infrastructure, and module registration when available.
- Do not create duplicate CRM `Account`, `Contact`, `User`, `Document`, `Activity`, or generic attachment systems. `ESignature` owns signature workflow records and provider-specific mapping, not generic CRM identity or file storage.
- Keep e-signature provider calls behind an adapter contract. **DocuSign is the first concrete adapter and the initial delivery target.** Do not add another provider before the DocuSign end-to-end path is stable.
- Use the official DocuSign Node.js SDK when it fits the repository's Node/runtime/security requirements; confirm the current stable package version at implementation time, use the existing package manager and lockfile, and avoid hand-rolling API types unnecessarily.
- Use DocuSign's supported OAuth flows and server-side token handling. Never expose access tokens, refresh tokens, private keys, OAuth client secrets, HMAC secrets, or raw credentials to the browser.
- Verify webhook authenticity, process webhook events idempotently, tolerate duplicate and out-of-order notifications, and preserve event evidence needed to reconcile state changes.
- Never claim that the application itself provides a legally qualified electronic signature or guaranteed jurisdictional compliance. Product/legal stakeholders must identify the applicable jurisdictions, signature level, identity verification requirements, retention policy, and contract requirements.
- Review every migration before applying it. Prefer additive, backwards-compatible changes.
- **Do not create a test database, shadow database, test schema, temporary database, per-agent database, or per-run database.** Follow `AGENTS.MD`; use the existing configured primary database for targeted, safe integration checks when appropriate.
- Do not issue real signature envelopes or send real signing invitations from automated tests. Use a fake adapter by default, and use only an explicitly configured DocuSign developer/demo account for deliberate provider sandbox verification.
- Do not test with real customer contracts or real personal data. Create clearly marked `AGENT_TEST_...` records and use synthetic documents and email addresses.
- Do not report a phase as complete without recording evidence for its acceptance criteria and tests actually run.

---

## 1. Purpose and Product Outcome

Implement a secure, auditable e-signature domain module that allows authorized CRM users to prepare documents, select signers, send signature requests through DocuSign, track progress, retrieve completed documents and completion evidence, and link every signature transaction to the relevant CRM record.

The first release is deliberately **DocuSign-first**, while the domain model and adapter boundary should make a future provider possible without forcing the rest of the CRM to speak DocuSign's API directly.

### 1.1 Primary user outcomes

Authorized users must be able to:

1. Connect the CRM to a DocuSign account using an administrator-approved configuration and supported OAuth flow.
2. Verify the connection, selected account, environment, granted scopes, and last successful authentication.
3. Start a signature request from a supported CRM record or from the ESignature workspace.
4. Use a configured DocuSign template or attach approved documents from existing CRM document/attachment services.
5. Configure signer identity, recipient roles, routing order, carbon-copy recipients, and supported recipient authentication requirements.
6. Preview the request, documents, recipients, and field/template mapping before sending.
7. Send an envelope to remote signers and, where supported, let a CRM user launch an embedded signing experience for an identified recipient.
8. See lifecycle status, outstanding recipients, timestamps, recent events, errors, and next actions without needing to open DocuSign separately for routine tracking.
9. Receive near-real-time status updates through DocuSign Connect webhooks.
10. Download completed documents and available completion certificates/audit evidence subject to CRM ACL and provider permissions.
11. Resend or remind recipients, void envelopes, or correct a still-editable envelope only when the provider and local state permit it.
12. Search, filter, and report on signature requests across supported CRM modules.
13. Keep a complete local audit trail of who prepared, approved, sent, modified, cancelled, downloaded, and linked each request.
14. Continue to access the CRM when DocuSign is temporarily unavailable; provider errors must not corrupt the local record or block unrelated CRM modules.

### 1.2 Key product principles

- **Provider-neutral domain, provider-specific adapter:** business UI and CRM entities must not depend directly on DocuSign payload models.
- **Provider is the signing authority:** CRM users cannot mark a document as signed by merely changing a local status. Signed/completed state must be confirmed by an authenticated provider event or a validated provider API response.
- **Immutable send snapshot:** preserve the exact document versions, signer configuration, recipients, metadata, and content hashes submitted to the provider.
- **Explicit human intent:** sending an envelope is an external legal/business side effect. Require a deliberate UI action and enforce confirmation/approval policy before sending.
- **No silent document substitution:** after an envelope is sent, editing the source CRM document must not change the content already sent for signature.
- **Least privilege:** provider credentials, envelope data, completed documents, and signing links are available only to authorized users.
- **Webhook-first synchronization:** prefer authenticated event delivery; use bounded reconciliation jobs rather than aggressive per-envelope polling.
- **Auditable lifecycle:** preserve immutable transition/event history instead of overwriting evidence.
- **No legal overclaim:** support operational workflows and store provider evidence, but do not represent the module as a legal opinion or a substitute for DocuSign's compliance and signature certification.

---

## 2. Scope and Boundaries

### 2.1 In scope

- ESignature module registration, configuration, permissions, and administration.
- Provider adapter contract and initial `DocuSignAdapter`.
- DocuSign OAuth connection lifecycle and token/secret protection.
- Signature requests and provider envelope mappings.
- Document selection, immutable snapshots, checksums, and secure provider upload.
- Template selection and template-role mapping.
- Signer, recipient type, recipient routing order, and supported authentication configuration.
- Remote signing and embedded recipient view generation.
- Envelope state synchronization and Connect webhook intake.
- Completed-document and completion-evidence retrieval.
- Provider error mapping, retries, reconciliation, operational diagnostics, and audit trail.
- CRM record linking and optional integration entry points from Sales, Projects, CustomerSuccess, and other domains.
- Admin UI, request list/detail UI, send flow, signer progress view, and permitted actions.
- API documentation, migrations, tests, security review, and runbooks.

### 2.2 Explicitly out of scope for the first release

- Building a proprietary cryptographic signature engine.
- Acting as a certificate authority, identity provider, trust-service provider, or legal authority.
- Claiming qualified electronic signature status, universal enforceability, or automatic compliance with ESIGN, UETA, eIDAS, HIPAA, SOC 2, or other regimes.
- Recreating the full DocuSign web application inside the CRM.
- Provider marketplace/billing and automatic installation of provider extensions.
- Supporting every DocuSign API product. The first adapter targets the eSignature REST API capabilities needed for the agreed CRM workflows.
- Automatic AI interpretation or acceptance of legal terms without a human decision.
- Generating complex legal contracts from scratch. Document generation can be a future integration or use an existing document-generation module if one exists.
- Implementing multiple signature providers in the first delivery. Add an additional adapter only after the adapter contract has been validated by the DocuSign implementation.

### 2.3 Important boundary with adjacent modules

| Capability | Owner | ESignature responsibility |
|---|---|---|
| Accounts, Contacts, Users, Teams | CRM Core | Reference IDs and use existing ACL; never duplicate these entities |
| Generic files, attachments, documents | Existing Document/Attachment service | Select, snapshot, store, and retrieve files through the existing secure file API |
| Quotes, orders, invoices, subscriptions | `Sales` | Offer explicit entry points and links; never mutate financial state merely because a signature completed |
| Project agreements or approvals | `Projects` / relevant module | Provide a signature action using a stable integration contract |
| Customer success plans | `CustomerSuccess` | Optional agreement or renewal signature integration; no hard dependency |
| Tickets and service cases | `ServiceDesk` | Optional attachment/linking to a case if approved by the business rules |
| OAuth/credentials common infrastructure | CRM Core / `AdvancedIntegrations` if already implemented | Reuse secure storage and OAuth utilities, while keeping DocuSign-specific scopes and connection lifecycle in this adapter |
| Generic AI agents | `AIAgents` | May help prepare/review metadata only if specifically enabled; must not impersonate signers or send contracts without required human approval |
| Workflow/job execution | Existing Jobs/Workflow services | Enqueue safe work and react to domain events without duplicate queue infrastructure |
| Signature workflow and envelope mapping | `ESignature` | Owns request state, recipient status projection, provider event history, policy, audit, and UI |

**Optional means truly optional:** `ESignature` must be installable and usable without `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `AIAgents`, or `AdvancedIntegrations` being installed. Integrations must be capability-detected and registered through interfaces/events, not imported as mandatory modules.

---

## 3. Reference Baseline and Documentation

Use official product documentation as the behavioral source of truth. Re-check the documentation and selected SDK version during Phase 19-ES.0 rather than pinning plan content to an old SDK release.

### 3.1 DocuSign references

- eSignature REST API overview: https://developers.docusign.com/docs/esign-rest-api/
- eSignature how-to guides: https://developers.docusign.com/docs/esign-rest-api/how-to/
- Authentication overview: https://developers.docusign.com/platform/auth/
- Confidential Authorization Code Grant: https://developers.docusign.com/platform/auth/confidential-authcode-get-token/
- Embedded signing overview: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/
- DocuSign Connect webhooks: https://developers.docusign.com/platform/webhooks/connect/
- Document generation and templates: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/documents/document-generation/
- Official Node.js eSignature SDK: https://github.com/docusign/docusign-esign-node-client
- Recipient API reference: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/enveloperecipients/list/

### 3.2 Source-backed implementation notes

- DocuSign eSignature API uses OAuth 2.0 and REST API v2.1. The platform offers multiple OAuth grant types; the right option depends on whether the application acts on behalf of an individual user or performs server-to-server operations under an approved consent model.
- The user's account-specific API base URI must be discovered from OAuth user information and stored/used correctly. Do not assume every account's REST API base URI is identical.
- Remote signing and embedded signing are different user experiences. Embedded signing requires generating a recipient view URL for a validated signer and returning the browser to an allowlisted CRM URL. The application must never collect or simulate the signature itself.
- DocuSign Connect is the preferred event-driven mechanism for envelope status updates. Avoid frequent polling; use event delivery plus bounded reconciliation for missed or inconsistent states.
- The official Node.js SDK is available and should be evaluated for compatibility with the project's runtime and package-management choices before deciding which low-level calls require a small REST wrapper.
- Templates are reusable provider-side objects. Template role names and CRM field mappings must be explicit and validated; do not assume the order or identity of template recipients.

### 3.3 Compatibility documentation

Create `docs/compatibility/esignature.md` (or the repository's established equivalent) containing:

- The exact DocuSign product/API surface being implemented.
- Supported OAuth flows and why each is enabled.
- Supported envelope, recipient, template, signing, and document lifecycle behavior.
- The mapping between local signature states and provider envelope/recipient states.
- Known provider-plan/account limitations.
- A list of unsupported cases and tested account configurations.
- Links to upstream documentation and date last verified.

---

## 4. Functional Requirements

### 4.1 Provider connection and administration

An administrator must be able to:

- Create a named DocuSign connection/profile.
- Select Demo/Sandbox or Production environment explicitly.
- Configure the integration/client ID, redirect URI, requested scopes, account selection, and consent status.
- Complete OAuth through the backend-controlled callback flow.
- Verify that the returned account is the intended account before activation.
- View connection health, account ID, permitted user/account, token expiry metadata, last successful API call, last webhook, and last error in redacted form.
- Re-authorize, rotate credentials, deactivate, or disconnect a provider safely.
- Configure Connect webhook verification and event delivery for the chosen account/environment.
- Set policy such as which CRM roles may send envelopes, who may void requests, maximum document size/count, retention rules, and whether embedded signing is enabled.

The provider connection must not reveal secrets in the UI after saving. Use an existing KMS/encryption/secrets service if available. If no such service exists, Phase 19-ES.1 must document an explicit safe secret-storage implementation before credentials are persisted.

### 4.2 Signature request lifecycle

A request flow must support:

1. Selecting the CRM record to associate with the signature request.
2. Choosing an approved document source or configured DocuSign template.
3. Resolving field values from a controlled mapping, with an editable preview where policy permits.
4. Adding one or more recipients and assigning signer/CC/other supported recipient roles.
5. Configuring sequential or parallel routing where supported.
6. Reviewing documents, recipients, routing, and provider account.
7. Saving a local draft.
8. Requiring any configured review/approval.
9. Sending the request to DocuSign after explicit confirmation.
10. Tracking status changes, recipient completion, declines, delivery failures, expiry, voiding, and completion.
11. Retrieving the final signed documents and completion certificate/audit evidence where available and authorized.
12. Linking the resulting artifacts to the source CRM record.

### 4.3 Draft, send and sent-state separation

Keep local draft configuration separate from an actual provider envelope. A local request in Draft must not mean that a provider envelope exists. Once sent:

- Store the provider envelope ID and provider account mapping.
- Persist an immutable outgoing snapshot, provider response identifiers, sender, timestamp, document checksums, and recipient routing snapshot.
- Do not silently edit the snapshot. If a correction flow is supported by provider state, implement a dedicated action with fresh preview and full audit.
- Do not create duplicate envelopes when a request times out after the provider may already have accepted it. Use idempotency/correlation strategy, query reconciliation, and an explicit ambiguous-send state instead of blindly retrying an irreversible send call.

### 4.4 Signers and recipient routing

The module should support, where applicable to the first provider and chosen account plan:

- One or more signers.
- Sequential or parallel routing order.
- Carbon-copy recipients.
- Template role mapping.
- Predefined recipient identity/authentication methods supported by the configured account and provider.
- Recipient email/name validation and explicit confirmation of intended signer.
- Recipient status, date sent, date delivered, date completed, decline/cancel reason when available.

Do not treat the CRM's record owner, current logged-in user, or Contact primary email as proof that the person is authorized to sign. The sender must affirm the recipient mapping in the review step.

### 4.5 Document integrity

For each selected document:

- Validate MIME type, extension, size, count, and provider-supported format.
- Retrieve the file only through the existing document/file authorization service.
- Record immutable version ID or byte snapshot reference, SHA-256 (or repository-standard secure hash) of the exact bytes sent, file name, MIME type, size, and the user who selected it.
- Do not overwrite the original CRM file with the signed file.
- Store provider-returned signed documents as new derived artifacts associated with the request.
- Store completion certificate/audit evidence as a separate derived artifact when available.
- Check permissions on every download request; possession of an envelope ID or file ID is not sufficient access.
- Avoid logging file contents or including signed document bytes in traces.

### 4.6 Embedded and remote signing

- Remote signing is the baseline: DocuSign notifies the recipients and controls their signing journey.
- Embedded signing is optional and must be disabled until the administrator configures it.
- For embedded signing, the backend must validate that the current CRM user can access the signature request and is initiating the view for the matching recipient. Do not let callers pass arbitrary recipient names/emails without matching them to the persisted request.
- Generate the recipient view URL server-side, with a short-lived provider URL and allowlisted return/cancel URLs.
- Do not store or log the full recipient view URL after creation; do not return it from general list/detail endpoints.
- Never expose embedded signing URLs in a third-party analytics event.
- Respect provider restrictions and account configuration, and test both the success return path and cancel/decline path.
- The actual signature action remains inside the provider-controlled signing experience.

### 4.7 Envelope state and recipient state

Maintain an explicit local normalized lifecycle, while preserving the raw provider status for troubleshooting and forward compatibility.

Suggested local request states:

- `draft`
- `pending_approval`
- `ready_to_send`
- `sending`
- `send_unknown` (the provider might have accepted the request but the local process did not receive confirmation)
- `sent`
- `delivered` (optional aggregate status only if unambiguous)
- `partially_signed`
- `completed`
- `declined`
- `voided`
- `expired`
- `provider_error`
- `reconciliation_required`

State mapping must be verified against current DocuSign documentation and actual webhook/API payloads. Provider status vocabulary may evolve. Keep mapping code isolated in `DocuSignStatusMapper`.

Rules:

- `completed` requires evidence from a trusted Connect event or provider API reconciliation.
- A single recipient completing does not imply the envelope is complete if more recipients remain.
- Out-of-order events must not move a terminal state backward without a validated provider reconciliation result.
- Store raw event metadata needed for audit with a retention policy, but minimize secrets and unnecessary personal data.
- If the local projection conflicts with authoritative provider state, place it into a reconciliation path and log the reason.

### 4.8 CRM associations

- A signature request may be linked to one primary CRM record plus optional related records, subject to existing relation semantics.
- Use canonical record IDs and the existing Entity Engine relation service.
- Store source record type and ID in a validated, platform-approved representation. Never interpolate untrusted entity/table identifiers into SQL.
- Support starting a request from Sales documents, Accounts, Contacts, Opportunities, Projects, CustomerSuccess records, or other allowed modules when those modules are present.
- Module-specific entry points must be registered conditionally; there must be no hard dependency on those modules.
- A signature event may publish domain events (for example `ESignature.RequestCompleted`) for consumers. Consumers decide whether a Sales document status should change; ESignature must not independently mark an invoice paid, close a sales opportunity, or treat every signed document as an accepted order.

---

## 5. Architecture

### 5.1 Suggested module boundaries

Adapt names and directories to repository conventions after audit. A conceptual layout is:

```text
ESignatureModule
├── application/
│   ├── commands/
│   │   ├── CreateSignatureRequest
│   │   ├── PrepareSignatureRequest
│   │   ├── SubmitForApproval
│   │   ├── ApproveSignatureRequest
│   │   ├── SendSignatureRequest
│   │   ├── VoidSignatureRequest
│   │   ├── ResendSignatureNotification
│   │   ├── CreateEmbeddedSigningView
│   │   ├── ReconcileProviderState
│   │   └── RetrieveCompletedDocuments
│   ├── queries/
│   │   ├── ListSignatureRequests
│   │   ├── GetSignatureRequestDetail
│   │   ├── GetRecipientProgress
│   │   └── GetProviderConnectionHealth
│   └── services/
├── domain/
│   ├── SignatureRequest
│   ├── SignatureDocument
│   ├── SignatureRecipient
│   ├── SignatureProviderConnection
│   ├── SignatureEvent
│   ├── SignatureTemplateMapping
│   ├── SignaturePolicy
│   └── state-machine/
├── providers/
│   ├── SignatureProviderAdapter
│   └── docusign/
│       ├── DocuSignAdapter
│       ├── DocuSignOAuthService
│       ├── DocuSignStatusMapper
│       ├── DocuSignConnectVerifier
│       ├── DocuSignPayloadMapper
│       └── DocuSignErrorMapper
├── infrastructure/
│   ├── persistence/
│   ├── jobs/
│   ├── webhook-inbox/
│   ├── documents/
│   ├── audit/
│   └── telemetry/
├── api/
│   ├── controllers/
│   ├── dto/
│   └── openapi/
├── metadata/
├── permissions/
└── tests/
```

This is a logical guide, not a directive to create these directories if the repository uses another structure.

### 5.2 Provider adapter contract

Define a minimal contract that expresses the domain operations ESignature actually needs. Keep DocuSign-specific request/response types inside `providers/docusign`.

Conceptual capabilities:

- `getConnectionStatus()`
- `getAccountContext()`
- `listTemplates()`
- `getTemplateDetails(templateId)`
- `prepareEnvelope(input)`
- `sendEnvelope(preparedEnvelope)`
- `getEnvelopeStatus(providerEnvelopeId)`
- `listRecipients(providerEnvelopeId)`
- `createRecipientView(input)`
- `resendNotifications(providerEnvelopeId, recipientIds?)`
- `voidEnvelope(providerEnvelopeId, reason)`
- `correctEnvelope(input)` only for supported non-terminal states
- `downloadCompletedDocuments(providerEnvelopeId)`
- `downloadCompletionEvidence(providerEnvelopeId)`
- `verifyAndParseWebhook(request)`

Only implement methods needed by current phases. Do not add empty no-op methods merely to make a generic interface appear comprehensive. Capability flags or explicit `NotSupportedByProviderError` responses are preferable to silently doing nothing.

Provider adapter requirements:

- No frontend or domain-layer access to SDK objects.
- Bounded timeouts and retry rules by operation type.
- Avoid retrying non-idempotent actions such as send until the result is known or reconciled.
- Centralized rate-limit handling and API response redaction.
- Map provider errors into stable internal categories while preserving safe diagnostic codes.
- Resolve account base URI from authenticated account context, not from a hard-coded global host.
- Keep Demo and Production environments separate and unmistakably labeled.

### 5.3 Domain/application separation

- Domain entities and services define invariants, state changes, authorization requirements, and allowed transitions.
- Application commands coordinate the domain, transaction boundary, provider calls, jobs, and audit records.
- Controllers validate/authenticate/authorize requests and map results to the established API response shape.
- Provider adapters translate between internal commands and provider protocols.
- React components must not call DocuSign directly or keep provider secrets.
- Webhook controllers should perform minimal synchronous work: verify authenticity, validate envelope/account mapping, persist an inbox item, and acknowledge promptly. Process business state asynchronously after persistence.

---

## 6. Data Model

Implement this model using the project's existing persistence and metadata patterns. Names are logical candidates, not a mandate to bypass the generic Entity Engine.

### 6.1 `ESignatureConnection`

Purpose: non-secret connection configuration plus reference to securely stored credentials.

Suggested fields:

- `id`
- `name`
- `providerKey` — first release: `docusign`
- `environment` — `demo` or `production`
- `status` — `not_connected`, `connected`, `reauthorization_required`, `disabled`, `error`
- `oauthClientId` (not secret)
- `secretReference` or encrypted credential storage reference
- `docusignAccountId`
- `docusignBaseUri`
- `docusignUserId` / subject identifier when available and useful
- `grantedScopes`
- `consentStatus`
- `connectWebhookConfigurationReference`
- `lastAuthAt`, `lastSuccessfulApiAt`, `lastWebhookAt`, `lastErrorAt`
- `lastErrorCode` (sanitized)
- `createdById`, `createdAt`, `updatedAt`
- `isActive`

Never persist access or refresh tokens in ordinary JSON settings, browser storage, source-controlled config, logs, or unencrypted text columns. Prefer the existing secrets service. If encryption-at-rest is implemented by this module, use envelope encryption or the platform-approved cryptographic service with key rotation; do not create a custom crypto primitive.

### 6.2 `SignatureRequest`

Suggested fields:

- `id`, `name`, `description`
- `status`
- `providerKey`, `connectionId`
- `providerEnvelopeId` (nullable until provider accepts/creates envelope)
- `providerStatusRaw`
- `sourceEntityType`, `sourceRecordId` (validated relation representation)
- `relatedRecords` only if the current generic relation service supports it safely
- `subject`, `message`, `emailBlurb`/provider-supported message data
- `createdById`, `preparedById`, `approvedById`, `sentById`
- `sentAt`, `completedAt`, `declinedAt`, `voidedAt`, `expiresAt`
- `approvalRequired`, `approvalStatus`, `approvalReason`
- `sendAttemptId` / stable correlation token
- `outgoingSnapshotId`
- `lastReconciledAt`, `lastProviderSyncAt`
- `failureCategory`, `failureCode`, `failureMessageSafe`
- timestamps and record version for optimistic concurrency

No provider `envelopeId` should be assumed globally unique. Use a unique constraint including provider/account context, for example `(connectionId, providerEnvelopeId)` when non-null.

### 6.3 `SignatureDocumentSnapshot`

Suggested fields:

- `id`, `signatureRequestId`
- `sourceAttachmentId` or `sourceDocumentId`
- `sourceVersionId` where supported
- `displayName`, `mimeType`, `byteSize`
- `contentHashSha256`
- secure snapshot file reference
- `documentOrder`
- `providerDocumentId` when returned
- `artifactKind` — `source_snapshot`, `provider_signed_document`, `completion_evidence`, `supporting_document`
- `createdAt`, `createdById`
- retention classification

Persist the exact bytes submitted to DocuSign or a content-addressed immutable version reference. Hashing the current file on display is not enough if the file can later be replaced.

### 6.4 `SignatureRecipient`

Suggested fields:

- `id`, `signatureRequestId`
- `providerRecipientId` / recipient ID mapping
- `recipientType` — signer, carbon copy, approver, or other explicitly supported type
- `crmContactId` (nullable for external signers)
- `name`, `email` snapshot as submitted
- `roleName` for template roles
- `routingOrder`
- `status`, `providerStatusRaw`
- timestamps for sent, delivered, completed, declined, authentication challenge where supplied
- `declineReasonSafe`
- `authenticationMethod` (non-secret configuration)
- `lastStatusEventId`
- audit timestamps

Snapshot recipient details when the request is prepared/sent, because a Contact email may change later. Never treat a snapshot as the authoritative current Contact value outside the request's evidence context.

### 6.5 `SignatureProviderEvent`

Purpose: append-only normalized event history.

Suggested fields:

- `id`, `connectionId`, `signatureRequestId` (nullable until linked)
- `providerKey`, `providerAccountId`, `providerEnvelopeId`
- `providerEventId` or stable deduplication key
- `eventTypeNormalized`, `providerEventTypeRaw`
- `providerOccurredAt`, `receivedAt`, `processedAt`
- `payloadHash`
- safe, minimized event payload or reference to secure raw payload storage
- `signatureVerificationStatus`
- `processingStatus`, `attemptCount`, `lastProcessingErrorSafe`

Use a uniqueness constraint for the provider-specific deduplication key. If the payload includes personal data, apply retention and access controls; do not retain full webhook bodies forever by default.

### 6.6 `SignatureAuditEntry`

Record application-level actions that matter independently of provider events:

- request created/edited/prepared
- document added/removed/replaced before send
- recipients configured/changed
- approval requested/granted/rejected
- send confirmed or send outcome unknown
- provider event accepted/rejected
- embedded signing view created (record metadata only, not the URL)
- reminder/resend requested
- void/correct requested and completed
- completed artifact fetched/viewed/downloaded
- connection enabled/disabled/re-authorized
- manual reconciliation started/completed

Entries should be append-only to application code and include actor/service identity, timestamp, correlation ID, target, result, and safe reason. Do not log secrets, raw signature tokens, full signing URLs, or document contents.

### 6.7 `SignatureTemplateMapping`

Map a local CRM workflow/document type to a provider template:

- local mapping name and type
- connection ID
- provider template ID
- provider template display name snapshot
- supported CRM source entity types
- role-to-recipient mapping
- field/tab mapping definition validated against an allowlist
- default message/subject values
- active/version information
- created/updated by and timestamps

Do not allow arbitrary unvalidated paths or expression execution in a mapping definition. If a mapping expression feature exists elsewhere in the platform, reuse its sandboxed/validated subset instead of evaluating arbitrary JavaScript.

---

## 7. Database and Migration Requirements

1. Inspect actual migration conventions and existing tables before proposing schema changes.
2. Add only tables/columns that are necessary and not already represented by an existing generic entity or module.
3. Use repository-standard IDs, timestamps, soft-delete policy, indexes, foreign keys, audit conventions, and tenancy boundaries.
4. Index common access paths: status, created/sent/completed dates, source record association, connection, provider account/envelope ID, and recipient status.
5. Add uniqueness constraints for provider envelope mappings and webhook event deduplication.
6. Consider transactional outbox/inbox patterns using the current queue architecture. Do not introduce a second messaging platform.
7. Design migrations as additive/backwards-compatible; avoid destructive renames or column removal in the initial rollout.
8. Keep provider-specific opaque IDs as strings with appropriate length and constraints; do not assume integer identifiers.
9. Use UTC timestamps stored consistently; render localized timestamps in the UI.
10. Do not use the schema to encode untrusted entity names or provider payloads as executable rules.
11. Migration tests must run against the existing configured database and must not rebuild/reset it. Follow `AGENTS.MD` exactly.

---

## 8. API Contract

Follow the established `/api/v1` routing, DTO validation, authentication, pagination, error envelope, and OpenAPI conventions. Route names below are conceptual; align them with repository conventions.

### 8.1 Connection administration

- `GET /api/v1/esignature/connections`
- `POST /api/v1/esignature/connections`
- `GET /api/v1/esignature/connections/:id`
- `PATCH /api/v1/esignature/connections/:id`
- `POST /api/v1/esignature/connections/:id/authorize`
- `GET /api/v1/esignature/oauth/docusign/callback`
- `POST /api/v1/esignature/connections/:id/test`
- `POST /api/v1/esignature/connections/:id/re-authorize`
- `POST /api/v1/esignature/connections/:id/disable`
- `POST /api/v1/esignature/connections/:id/disconnect`

Requirements:

- Only administrators/integration managers with the dedicated permission can change connections.
- OAuth `state` must be unpredictable, short-lived, bound to the initiating CRM session/connection, and single-use.
- Validate redirect URI exactly against configured allowlisted URIs.
- Callback responses must not leak OAuth codes or tokens into browser logs or analytics.
- Do not expose secret values in GET/PATCH responses.

### 8.2 Signature requests

- `GET /api/v1/esignature/requests`
- `POST /api/v1/esignature/requests`
- `GET /api/v1/esignature/requests/:id`
- `PATCH /api/v1/esignature/requests/:id` — Draft state only unless a dedicated correction action explicitly permits more.
- `POST /api/v1/esignature/requests/:id/prepare`
- `POST /api/v1/esignature/requests/:id/request-approval`
- `POST /api/v1/esignature/requests/:id/approve`
- `POST /api/v1/esignature/requests/:id/reject`
- `POST /api/v1/esignature/requests/:id/send`
- `POST /api/v1/esignature/requests/:id/resend-notification`
- `POST /api/v1/esignature/requests/:id/void`
- `POST /api/v1/esignature/requests/:id/correct` — if supported by provider state and policy.
- `POST /api/v1/esignature/requests/:id/reconcile`
- `GET /api/v1/esignature/requests/:id/events`
- `GET /api/v1/esignature/requests/:id/recipients`
- `GET /api/v1/esignature/requests/:id/documents`
- `POST /api/v1/esignature/requests/:id/documents/:documentId/download` or use the existing secure file endpoint.
- `POST /api/v1/esignature/requests/:id/embedded-view` — server creates recipient view only after authorization and recipient matching.

Every command endpoint must:

- Check access to the request and linked CRM record.
- Check record-level and relevant field-level ACL.
- Validate allowed lifecycle transition.
- Use idempotency/concurrency controls when an operation can have side effects.
- Write an audit entry and correlation ID.
- Return stable errors such as `SIGNATURE_REQUEST_INVALID_STATE`, `PROVIDER_NOT_CONNECTED`, `SIGNATURE_APPROVAL_REQUIRED`, `PROVIDER_OUTCOME_UNKNOWN`, and `RECIPIENT_NOT_AUTHORIZED` without leaking provider internals.

### 8.3 Webhook endpoint

- `POST /api/v1/esignature/webhooks/docusign/:connectionPublicId` (or repository-equivalent opaque routing ID).

Requirements:

- Use a random, non-secret-in-itself endpoint identifier and/or verified provider configuration identity; never rely on the URL alone for authentication.
- Verify DocuSign Connect authentication/signature using the configured supported mechanism before accepting a payload.
- Enforce body-size and content-type limits.
- Persist a webhook inbox item and return a prompt success acknowledgement after durable acceptance.
- Reject invalid signatures without revealing details that help forge requests.
- Deduplicate deliveries and queue asynchronous processing.
- Do not accept provider status changes from a general public CRUD endpoint.

### 8.4 API documentation

- Document all request and response schemas in OpenAPI.
- Do not expose raw provider SDK types.
- Document side effects, idempotency requirements, authorization, allowed states, and whether a route may enqueue asynchronous work.
- Include safe examples with synthetic document IDs and recipients.

---

## 9. DocuSign Adapter — First Provider Integration

### 9.1 Adapter responsibilities

`DocuSignAdapter` translates ESignature domain commands into DocuSign eSignature API v2.1 operations. It must not own CRM business rules, local ACL decisions, local document authorization, or the decision to approve an envelope for sending.

Implement only the API operations needed by supported feature phases, such as:

- Resolve authenticated user/account and account-specific base URI.
- List and inspect templates.
- Create a draft envelope from a template and/or documents.
- Set recipient roles, recipients, routing order, email subject/body and supported tabs/fields.
- Send an envelope after local command authorization has succeeded.
- Query current envelope status and recipient status for reconciliation.
- Generate a recipient view for embedded signing.
- Resend notifications/reminders where supported.
- Void an envelope where provider state allows it.
- Correct a sent envelope only through an explicit, guarded exception flow.
- Download completed documents and completion evidence where supported.
- Verify/parse Connect webhook notifications.

Avoid implementing generic DocuSign administration, billing, bulk sending or other APIs unless a documented acceptance criterion requires them.

### 9.2 OAuth strategy

The adapter must support a documented, deliberate authentication mode rather than providing every grant indiscriminately.

**Default user-authorized integration:** evaluate Confidential Authorization Code Grant first when the CRM administrator/user authorizes the application. Use state/nonce protections, exact redirect URI validation, minimum necessary scopes, safe refresh-token storage, and explicit reauthorization handling.

**Server-to-server JWT grant:** consider only where the target DocuSign organization/account has correctly configured the required consent and certificate/key model, and where the use case genuinely requires acting without a user present. Require an administrator-only setup path, private key protection, rotation/revocation documentation, and a security review. Do not make JWT the default merely because it seems easier for background jobs.

Rules:

- Never use deprecated/unsupported OAuth grants for a new implementation.
- Discover and persist account ID and base URI returned by the authenticated DocuSign user information call.
- Separate demo and production clients, redirect URIs, secrets, event configurations, and stored provider identities.
- Handle token refresh and expiration without racing concurrent requests; use a lock/single-flight mechanism if necessary.
- On `consent_required`, `invalid_grant`, revoked authorization, or changed account permissions, set `reauthorization_required` and stop affected operations safely.
- Use minimum necessary scopes and explain them in admin UI.
- Never request account-wide administrative scopes unless separately justified and approved.

### 9.3 SDK and HTTP behavior

- Prefer the official `docusign-esign` Node SDK for supported eSignature calls, after checking current package compatibility, licensing, transitive dependencies, and project runtime requirements.
- Wrap it in an internal adapter so SDK churn does not spread to the domain.
- Use a bounded HTTP timeout, request correlation, safe retries, and provider-specific rate-limit handling.
- Do not log full request bodies if they include signer PII, document data, auth codes, bearer tokens, or envelope content.
- Redact provider responses before storing diagnostics.
- Parse provider errors into stable internal categories, but preserve safe error codes and request IDs for support.
- Do not use raw provider URLs received from untrusted payloads without URL allowlisting and expected-host validation.

### 9.4 Environment promotion

Support a controlled progression:

1. Local/unit tests with a fake adapter.
2. DocuSign developer/demo account validation.
3. Explicit administrator review of scopes, account ID, templates, Connect configuration, recipient settings, and document retention.
4. Production credentials and webhook configuration provisioned securely.
5. Production enablement by an authorized administrator.

The application must display the active environment prominently and never silently switch an existing connection from Demo to Production.

---

## 10. DocuSign Connect Webhook Processing

### 10.1 Event intake

Implement a durable webhook inbox pattern:

1. Read the raw request bytes/body using the framework's safe raw-body option when required by verification.
2. Verify the configured DocuSign Connect message authentication before trusting any payload field.
3. Validate the event schema, expected provider account/configuration, envelope ID, and basic bounds.
4. Compute or extract a stable deduplication key; if the provider format does not supply a unique event ID, construct a deterministic key from verified event fields and payload hash without treating hash alone as perfect semantic identity.
5. Persist the accepted delivery with verification result and safe metadata.
6. Acknowledge only after durable acceptance.
7. Process asynchronously through the existing job queue.
8. Update request/recipient projections transactionally, append normalized provider event, and publish domain events through the existing event/outbox system.
9. Mark the inbox item as processed, ignored, retryable, or dead-lettered with a safe reason.

### 10.2 Security controls

- Configure and verify the currently supported DocuSign Connect authentication mechanism, including HMAC/signature-based verification where configured.
- Compare signatures in constant time using established libraries.
- Support secret rotation with overlap only if the provider mechanism permits safe dual-key validation.
- Validate timestamps/replay windows if the provider event format and signature mechanism support them; do not invent timestamp fields that DocuSign does not guarantee.
- Apply payload size, request rate, schema, and content-type limits.
- Do not trust `envelopeId`, account ID, recipient email, or event type until message authentication succeeds.
- Ensure the webhook listener cannot mutate arbitrary CRM records based on untrusted payload identifiers.
- Audit authentication failures without logging secret headers or excessive payload contents.

### 10.3 Idempotency, order and retry

- Duplicate webhook deliveries must not create duplicate signatures, tasks, files, notifications, audit actions, or state transitions.
- Events may arrive after a later event, or the same event may be retried. Preserve the complete accepted event history while keeping the current projection monotonic where appropriate.
- On an event whose meaning is ambiguous, use a provider reconciliation query rather than guessing.
- Use capped retries with exponential backoff and jitter for transient processing errors; never retry permanently invalid schema or authentication failures indefinitely.
- Maintain a dead-letter/reconciliation view for events that cannot be applied automatically.
- Do not use high-frequency polling as a replacement for Connect. Schedule reconciliation for stuck requests and missed webhook cases within the provider's documented limits.

### 10.4 Supported event categories

Map only the statuses/events needed for initial functionality, for example:

- Envelope sent/created when exposed.
- Delivered/viewed where the provider supplies reliable data.
- Recipient signed/completed.
- Envelope completed.
- Recipient declined.
- Envelope voided.
- Envelope expired.
- Provider or delivery failure.
- Corrected/resend events where relevant.

The exact event schema must be validated against current DocuSign Connect documentation and real demo-account fixtures. Unknown event types must be preserved safely and handled as `unmapped`, not treated as success.

---

## 11. Approval and Governance

### 11.1 Send policy

All sends require an explicit user action. Configure additional approval policies, such as:

- Approval required for selected source entities or contract types.
- Approval required above a configured monetary amount or for sensitive agreement categories.
- Approval required when recipients are external or outside approved domains, if the business policy requires it.
- Approval required when a document was modified after the last review.
- Separate permission to prepare, approve, send, void, correct, download completed artifacts, and administer connections.

Do not infer legal approval solely from CRM admin role. Approver eligibility must be explicit and auditable.

### 11.2 Confirmation UI

Before sending, show:

- Provider and environment.
- Source CRM record with navigation link.
- Document names, versions, and hashes/immutable version indication.
- Signer names/emails and routing order.
- CC recipients.
- Template and field mapping used.
- Subject/message and expiry/reminder configuration if supported.
- Required approvals and any policy warnings.
- The fact that an external signature request will be sent.

Require the sender to confirm. Use a stable request version or concurrency token so a stale preview cannot send a modified draft without review.

### 11.3 Automation and AI integration

- Workflow or `AIAgents` may prepare a signature request draft, recommend a template, or prefill metadata only if an explicit integration has been enabled.
- Automated sending must be disabled by default and require an administrator-defined policy, narrow use case, audit, and idempotent execution.
- AI must not invent signer details, choose recipients silently, claim that signing has occurred, or bypass human approvals.
- Any automated send policy must specify scope, allowed source types, recipient restrictions, maximum amount/contract class, and failure handling.
- CRMChat can surface status and offer actions, but it must use ESignature APIs and confirmation workflow rather than contacting DocuSign directly.

---

## 12. Permissions and Security

Define dedicated permissions using the repository's established ACL model. Suggested permissions:

- `ESignature.request.read`
- `ESignature.request.create`
- `ESignature.request.prepare`
- `ESignature.request.send`
- `ESignature.request.approve`
- `ESignature.request.void`
- `ESignature.request.correct`
- `ESignature.request.downloadCompleted`
- `ESignature.connection.read`
- `ESignature.connection.manage`
- `ESignature.templateMapping.manage`
- `ESignature.audit.read`

Requirements:

1. Enforce permissions server-side for every API, download, background job, webhook-driven side effect, and relation lookup.
2. Check linked-record ACL before exposing signature request details or documents. The existence of a request must not leak the content of a restricted source record.
3. Restrict connection administration and credentials to administrators/integration managers.
4. Enforce field-level policy for signer email, document content, authentication configuration, and audit data where the platform supports it.
5. Treat IDs and provider envelope identifiers as untrusted input and prevent insecure direct object reference (IDOR) access.
6. Keep signing links short-lived, recipient-specific, and outside logs/analytics.
7. Protect OAuth state, callback endpoints, CSRF, redirects, and session-bound actions.
8. Verify webhook signatures before processing any side effect.
9. Set upload/download size limits and defend against decompression bombs, malformed PDFs, unexpected MIME types, and malicious document attachments according to existing file security controls.
10. Avoid parsing macros/scripts or executing document content. Document preview must use existing sandboxed viewing capabilities.
11. Encrypt provider credentials and signing-sensitive secrets at rest using the platform's approved mechanism.
12. Use secret rotation and revocation procedures; never keep private keys in the repository or frontend build configuration.
13. Redact tokens, auth codes, signer access codes, signature URLs, document bytes, and unnecessary PII from logs.
14. Ensure API responses and audit exports don't reveal hidden recipients or attachments to unauthorized users.
15. Apply secure headers and restrictive referrer policies to any pages where the provider signing URL is opened.

### 12.1 Privacy and retention

- Minimize stored provider payloads to what the product needs for audit and reconciliation.
- Define configurable retention for raw webhook data, completed documents, completion certificates, and event metadata.
- Do not delete the authoritative audit/evidence artifact automatically without a configured retention policy and stakeholder review.
- Support user/data deletion requests only under an explicit business/legal policy, taking into account contract retention obligations and legal hold requirements.
- Record data residency and provider environment assumptions in admin documentation.
- Do not treat provider completion evidence as a legal conclusion; make it available to an authorized reviewer.

---

## 13. UI / UX Requirements

### 13.1 Navigation

Add a first-class `ESignature` entry following existing CRM menu/layout rules:

- Signature Requests
- My Requests / Requests I Need to Review
- Provider Connections (permission-gated)
- Template Mappings (permission-gated)
- Failed / Needs Reconciliation (permission-gated)
- Reporting (if reporting UI exists)

Do not create a second global document manager.

### 13.2 Signature request list

Support server-side filtering, sorting, and pagination for:

- Status
- Source module / source record
- Provider connection/environment
- Request owner / sender
- Created, sent, completed, declined, and voided dates
- Recipient status
- Needs approval / failed / needs reconciliation

List entries should display a normalized status label, source record link, signer-progress summary, sent date, and last update. Avoid exposing signer emails to users without permission.

### 13.3 Create/send wizard

Recommended steps:

1. **Source:** choose linked CRM record or create without a source record if policy allows.
2. **Documents/template:** select a provider template and/or permitted document versions.
3. **Field mapping:** preview mapped values and resolve missing required fields.
4. **Recipients:** assign template roles, validate email/name, and configure routing.
5. **Options:** subject, message, allowed authentication, reminders/expiration if supported.
6. **Review:** final snapshot preview, policy warnings, approval requirement.
7. **Send:** explicit confirmation and progress state.
8. **Result:** show provider envelope reference, next steps, and request record link.

If a step fails, preserve the local draft and report what can safely be retried. Never hide an ambiguous external send result behind a generic failure message.

### 13.4 Detail view

Show:

- Local request status and raw provider status (admin/debug permissions only for raw details).
- Source record, sender, approver and timestamps.
- Document snapshot list and final artifacts.
- Recipient progress in routing order.
- Event/activity timeline.
- Safe provider diagnostics and reconciliation status.
- Available actions based on current state and ACL.

### 13.5 Connection administration UI

Include:

- Demo/Production environment badge.
- Connect/Reconnect, Test Connection, Disable, and Disconnect actions.
- Account and user identity returned by OAuth.
- Scope list and consent status.
- Connect webhook verification/configuration status.
- Last successful API call and last received event.
- Redacted last error and a link to troubleshooting help.
- No secret values after initial configuration.

### 13.6 Accessibility and localization

- Use existing design system, responsive layout, keyboard navigation, focus management, and screen-reader labels.
- Make signing state understandable without relying on color alone.
- Localize dates and status text using existing i18n infrastructure.
- Support recipient names, organization names, and document names in Unicode.

---

## 14. Reporting and Operational Visibility

Minimum useful reports:

- Signature requests by status and date.
- Completion/decline/void/expiry rates.
- Median and average time to completion, with documented timestamp logic.
- Requests waiting on a specific recipient.
- Pending approvals.
- Provider errors and send-unknown requests.
- Requests requiring reconciliation.
- Volume by CRM module/source type and owner.

Operational metrics:

- Provider API latency and error rate (without PII).
- OAuth refresh/reauthorization failures.
- Connect webhook accepted/rejected/duplicate counts.
- Webhook processing lag and dead-letter count.
- Provider queue depth and oldest job age.
- Send operations whose outcome is unknown.
- Reconciliation drift between local projection and provider state.
- Artifact download failure rate.

Do not record document content, tokens, signer access codes, or full signing URLs in metrics labels.

---

## 15. Events and Integration Contracts

Define domain events using the repository's existing event/outbox infrastructure. Suggested events:

- `ESignature.RequestCreated`
- `ESignature.RequestPrepared`
- `ESignature.RequestApprovalRequested`
- `ESignature.RequestApproved`
- `ESignature.RequestRejected`
- `ESignature.RequestSent`
- `ESignature.RecipientCompleted`
- `ESignature.RequestCompleted`
- `ESignature.RequestDeclined`
- `ESignature.RequestVoided`
- `ESignature.RequestExpired`
- `ESignature.RequestNeedsReconciliation`
- `ESignature.CompletedArtifactAvailable`

Each event should include local request ID, provider key, connection ID, source reference (subject to ACL and schema convention), occurrence timestamp, correlation ID, and schema version. Avoid including document bytes, tokens, signing URLs, or unnecessary recipient PII.

### 15.1 Consumer behavior

- Consumers must be idempotent.
- A completed signature does not automatically mean a quote is accepted, an order is fulfilled, an invoice is paid, a project is approved, or a subscription is active. Each consumer must have an explicit business rule.
- Do not create duplicate Activities, notifications, or documents when an event is replayed.
- Keep optional integrations behind module capability registration.

---

## 16. Jobs and Failure Recovery

Use the project's existing job queue/scheduler.

Potential jobs:

- `ESignature.ProcessProviderWebhook`
- `ESignature.RefreshEnvelopeProjection`
- `ESignature.ReconcileStuckRequests`
- `ESignature.RetrieveCompletedArtifacts`
- `ESignature.RefreshProviderConnectionHealth`
- `ESignature.CleanupExpiredTemporaryArtifacts`

Rules:

- All event processing, artifact retrieval, and reconciliation jobs must be idempotent.
- Bound retries and use exponential backoff/jitter for transient faults.
- Never retry a send as if it were a harmless GET. If the response is lost after submission, mark `send_unknown`, reconcile against the provider using correlation/reference details where supported, and require controlled recovery if the result cannot be resolved.
- Distinguish transient, permanent, authorization, rate-limit, invalid-payload, provider-account and unknown-result failures.
- Respect provider rate limits and Retry-After where applicable.
- Add dead-letter handling and operator-visible retry/reconcile actions.
- Re-running an artifact-download job must not create duplicate attachments; use provider document IDs, content hashes, and a stable artifact key.
- A provider outage must not block ordinary CRM requests unrelated to ESignature.

---

## 17. Testing Strategy

### 17.1 Test categories

- Unit tests for domain state machine, permission decisions, status mapping, recipient routing validation, template field mapping, error translation, and idempotency keys.
- Adapter contract tests using a fake DocuSign client/HTTP client.
- API tests for all permission-gated endpoints and expected error states.
- Database integration tests against the existing configured primary database, following `AGENTS.MD` without resetting or recreating it.
- Webhook tests for valid signatures, invalid signatures, replay/deduplication, malformed payloads, duplicate events, and out-of-order events.
- E2E tests with the fake provider covering draft → review → approval → send → recipient updates → completed artifact.
- Deliberate sandbox tests against a DocuSign demo account only when credentials are explicitly provided and the test case is approved.
- Security tests for IDOR, SSRF, OAuth CSRF/state, redirect validation, secret leakage, webhook spoofing, and unauthorized document download.

### 17.2 Required lifecycle test scenarios

1. Create a draft request linked to a synthetic CRM record.
2. Add an existing CRM attachment and verify that the immutable snapshot is captured.
3. Verify a document replacement after preview invalidates the previous approval/review.
4. Map a DocuSign template role to a synthetic signer and validate required fields.
5. Send using a fake adapter; verify exactly one provider send operation for a confirmed request.
6. Simulate provider timeout after accepting the request and verify `send_unknown` plus reconciliation rather than blind duplicate sending.
7. Process an authenticated `sent` event and verify local status and event history.
8. Deliver the same webhook twice and verify one effective transition and no duplicate artifacts/notifications.
9. Deliver events out of order and verify a safe projection/reconciliation behavior.
10. Complete the final recipient and verify that the envelope becomes completed only when the whole envelope does.
11. Retrieve signed documents and completion evidence, preserving source file and access permissions.
12. Verify an unauthorized user cannot list, read, void, send, or download the request.
13. Verify the `DocuSignAdapter` refuses embedded signing for a recipient that is not part of the request.
14. Verify disabled connections and expired/revoked authorization produce safe actionable errors.
15. Confirm tests do not send real signing emails or place real envelopes in production.

### 17.3 Database safety

- Do not create a test database, schema, container, or copy.
- Never run destructive reset/truncate/drop commands.
- Use unique `AGENT_TEST_...` record identifiers and synthetic signer addresses.
- Clean up only test data created by the current test run and confirmed by exact IDs.
- External provider side effects must use a fake adapter except for explicit sandbox verification.

---

## 18. Delivery Roadmap — Sub-Phases

Each sub-phase must be implemented and accepted separately. The numbering is for this plan; align with the repository roadmap if a different numbering convention is already in use.

### Phase 19-ES.0 — Repository Audit and Feature Contract

**Goal:** determine actual prerequisites and define a reviewed implementation contract.

Tasks:

- Read `AGENTS.MD`, `PLAN.md`, existing module plans and implemented code.
- Inspect module registry/manifests, API conventions, metadata/Entity Engine, record ACL, file storage, Activities, notifications, jobs, audit, secrets/encryption, outbound request wrapper, and OAuth integrations.
- Identify existing document/version/download services; do not design parallel file storage.
- Identify whether generic signature/e-signature entities or provider connections already exist.
- Verify DocuSign API docs, current SDK stable version, runtime compatibility, and OAuth/Connect requirements.
- Document required environment variables/config settings by name only; never output secret values.
- Create `docs/compatibility/esignature.md` and a capability gap matrix.
- Define the initial end-to-end slice: one connection, one local document or template, one signer, send through Demo, Connect status updates, and retrieval of signed artifact/evidence.

**Acceptance criteria:**

- Existing and missing prerequisites are documented with repository paths.
- No duplicate framework, entity, job system, secrets service, or file service is proposed without evidence of absence.
- The first provider path and security design are reviewed before schema implementation.
- No database/test setup is modified in this phase.

### Phase 19-ES.1 — Module Registration and Security Contract

Tasks:

- Register `ESignature` using existing module conventions.
- Define module settings, feature flags, metadata, permissions, route registration, navigation metadata, translation keys and audit actions.
- Define secret-handling contract and environment-specific config.
- Define the dedicated permission set and policy points for document/source-record ACL.
- Define supported provider capabilities and error taxonomy.

**Acceptance criteria:**

- Module appears only for authorized users and is disabled cleanly when unconfigured.
- No provider operations are possible before a connection is enabled.
- Naming uses `ESignature`, `esignature`, `ESignatureModule`; no `Ua` prefix.

### Phase 19-ES.2 — Database Schema and Domain Entities

Tasks:

- Design/additive migrations for connection, request, recipient, document snapshot, provider event/inbox, audit and template mapping records as justified by audit.
- Add uniqueness constraints and indexes for provider references and event deduplication.
- Implement domain entities, repositories, state machine and optimistic concurrency/version checks.
- Define retention/data-minimization behavior and soft-delete rules, if applicable.

**Acceptance criteria:**

- Migration is reviewed and applied safely according to `AGENTS.MD`.
- Request state transitions are unit-tested.
- Provider envelope IDs are unique in the appropriate connection/account context.

### Phase 19-ES.3 — Provider Adapter Contract and Fake Adapter

Tasks:

- Define the minimal provider contract based on the initial use cases.
- Implement `FakeSignatureProviderAdapter` for predictable unit/API/E2E tests.
- Define provider error categories, capabilities, correlation IDs and idempotency behavior.
- Keep provider SDK types outside the application/domain layer.

**Acceptance criteria:**

- End-to-end domain workflow can run with the fake provider.
- No test needs production provider credentials.
- Unsupported capability requests return explicit safe errors.

### Phase 19-ES.4 — DocuSign OAuth and Connection Lifecycle

Tasks:

- Implement administrator-started authorization flow using the selected supported OAuth grant.
- Securely store refresh token or server-to-server key reference through approved secrets infrastructure.
- Resolve and persist account ID and account-specific base URI.
- Handle state verification, redirect allowlists, reauthorization, revoke/disconnect, and token refresh concurrency.
- Implement Test Connection and connection health view.

**Acceptance criteria:**

- Demo account can authorize and connection test succeeds.
- Credentials are absent from logs, frontend bundles, API responses and normal configuration output.
- Expired/revoked consent changes connection state and disables unsafe sends.

### Phase 19-ES.5 — Secure Document Snapshot Service

Tasks:

- Integrate existing file/document ACL, retrieval, versioning and storage.
- Validate file type, count, size and provider restrictions.
- Create immutable snapshot references and checksum records.
- Ensure signed artifacts will be stored separately from source artifacts.

**Acceptance criteria:**

- Source files cannot be overwritten by a provider result.
- Snapshot hash/version is stable for the exact submitted bytes.
- Unauthorized source documents cannot be attached to a request.

### Phase 19-ES.6 — Signature Request Draft and CRUD

Tasks:

- Implement request list/detail/create/update for draft records.
- Link request to supported CRM records using the established relationship mechanism.
- Implement draft document and recipient configuration.
- Validate state and ACL on every operation.

**Acceptance criteria:**

- User can create, edit and view a draft request.
- Sent requests cannot be modified through generic PATCH endpoints.
- Linked-record ACL is enforced.

### Phase 19-ES.7 — Template Catalog and Field/Role Mapping

Tasks:

- Add DocuSign template list/detail refresh through the adapter.
- Persist local mapping from provider template role names to CRM recipient sources/roles.
- Map only allowlisted source fields into supported template tabs/fields.
- Validate missing required recipient roles and template fields before send.
- Do not update provider templates without a separate future requirement.

**Acceptance criteria:**

- Administrator can refresh template catalog and configure a mapping.
- Mapping validation rejects unknown or unauthorized field references.
- Templates and IDs remain associated with the correct provider account.

### Phase 19-ES.8 — Recipient Routing and Send Preview

Tasks:

- Support signer and CC types, routing order, required recipient fields, and supported auth options.
- Build an immutable preview snapshot.
- Invalidate prior approval/preview when a relevant document, recipient or mapping changes.
- Validate explicit sender confirmation and policy requirements.

**Acceptance criteria:**

- Multi-recipient preview accurately reflects final request.
- Wrong/ambiguous signer mappings are blocked.
- No external send occurs during draft/preparation.

### Phase 19-ES.9 — DocuSign Envelope Preparation

Tasks:

- Implement creation of a provider-side draft envelope using selected template/documents.
- Populate role, routing and field data using documented SDK/API operations.
- Persist provider IDs and correlate the draft without prematurely marking the local request sent.
- Support safe cleanup/abandonment of unsent provider drafts where the provider permits it.

**Acceptance criteria:**

- Demo provider accepts a draft envelope for the synthetic test document.
- Retrying preparation cannot create uncontrolled duplicate provider drafts.
- Provider state maps to local draft/prepared state accurately.

### Phase 19-ES.10 — Controlled Send and Ambiguous Outcome Recovery

Tasks:

- Implement guarded send command with permissions, approvals, confirmation version and audit.
- Use a stable operation/correlation identifier where supported.
- Distinguish definite rejection from timeout/unknown outcome.
- Reconcile ambiguous requests before allowing another send attempt.
- Persist immutable send snapshot and provider response metadata.

**Acceptance criteria:**

- One deliberate action results in at most one effective send in tested retry scenarios.
- Ambiguous outcome results in `send_unknown` or reconciliation state, not an unsafe blind retry.
- All sends record sender, time, source, documents and recipients.

### Phase 19-ES.11 — DocuSign Connect Webhook Intake

Tasks:

- Configure webhook endpoint and supported signature/authentication verification.
- Implement raw body handling, payload limits, inbox persistence, deduplication, fast acknowledgement and async processing.
- Add tests for invalid signature, duplicate delivery, unknown envelope, malformed payload and provider-account mismatch.

**Acceptance criteria:**

- Invalid webhook cannot change request state or create side effects.
- Duplicate delivery creates no duplicate artifacts or notifications.
- Accepted event is durable before success acknowledgement.

### Phase 19-ES.12 — Envelope and Recipient State Synchronization

Tasks:

- Implement `DocuSignStatusMapper` and recipient status projection.
- Process sent, delivered/viewed when reliable, completed, declined, voided, expired and relevant failure transitions.
- Preserve raw provider status and accepted event history.
- Implement reconciliation query for out-of-order/ambiguous states.

**Acceptance criteria:**

- Completed is shown only after trusted event/reconciliation proves envelope completion.
- Recipient completion does not incorrectly complete a multi-recipient envelope.
- State cannot move backwards because of a duplicate older event.

### Phase 19-ES.13 — Remote Signing Progress UI

Tasks:

- Build request list/detail views, signer progress and event timeline.
- Provide links to source CRM records and actions permitted for current status/user.
- Surface safe diagnostics and a clear retry/reconcile path.

**Acceptance criteria:**

- User can track signer progress without direct provider dashboard access for routine cases.
- Restricted users cannot view hidden recipient data, source records or event payloads.

### Phase 19-ES.14 — Embedded Signing

Tasks:

- Implement server-side recipient view generation for eligible, matched recipients.
- Validate current user, request ACL, recipient identity and allowlisted return/cancel URLs.
- Ensure signing URL is short-lived and excluded from logs/history/analytics.
- Handle return, cancel, error and post-signing status refresh paths.

**Acceptance criteria:**

- Authorized recipient can start embedded signing in the Demo environment.
- Unrelated users cannot request a view for another recipient.
- Completing the browser view does not itself mark the local request completed; provider event/status does.

### Phase 19-ES.15 — Completed Documents and Completion Evidence

Tasks:

- Download completed documents and completion certificate/evidence through the adapter.
- Store them using existing file services as new derived artifacts.
- Deduplicate by request/provider document identity/content hash.
- Link artifacts to the request and source record according to access policy.

**Acceptance criteria:**

- Signed copy and completion evidence are available to authorized users only.
- Original source document remains unchanged.
- Retrying a download does not create duplicate artifacts.

### Phase 19-ES.16 — Reminders, Resend, Void and Correction

Tasks:

- Implement provider-supported resend/reminder actions with permission and rate policy.
- Implement void/cancel with reason and explicit confirmation.
- Implement envelope correction only as an exception path and only when provider state permits it.
- Disable unavailable/invalid state actions in both UI and backend.

**Acceptance criteria:**

- Unsupported or terminal-state actions fail clearly and do not call the provider.
- Void/correction actions are audited with actor and reason.
- Completion cannot be reversed by a local status edit.

### Phase 19-ES.17 — Approval Workflow and Policy Engine

Tasks:

- Add optional approval workflow before send, driven by configured source type/value/risk policy.
- Store reviewer decision, reason and request snapshot version.
- Re-invalidate approval when relevant document, recipient, mapping or terms change.
- Support role-based approver eligibility and separation-of-duties policy if required.

**Acceptance criteria:**

- Request cannot be sent while required approval is pending/rejected.
- Approval applies only to the exact reviewed snapshot.
- Every decision is auditable.

### Phase 19-ES.18 — CRM Domain Entry Points and Events

Tasks:

- Add optional integration buttons/actions to supported modules through extension hooks/capability registry.
- Publish ESignature lifecycle events through the existing domain event/outbox mechanism.
- Add consumer examples for Sales documents only if Sales provides a documented service contract.
- Ensure downstream modules decide their own business state changes.

**Acceptance criteria:**

- `ESignature` works if optional modules are not installed.
- A signed file does not automatically mark invoices paid or opportunities won.
- Event replay does not duplicate downstream actions.

### Phase 19-ES.19 — Search, Reports and Dashlets

Tasks:

- Add authorized search/filter for requests.
- Add completion rates, pending approvals, waiting recipients, time-to-completion and exception reports.
- Add dashboard cards/dashlets only using the existing reporting/dashboard API.

**Acceptance criteria:**

- Reports obey record and field ACL.
- Aggregate results do not leak inaccessible record details.
- Date and status definitions are documented.

### Phase 19-ES.20 — Admin Operations and Recovery Workbench

Tasks:

- Build connection health and webhook diagnostics.
- Add failed, stuck, `send_unknown`, dead-letter and reconciliation views.
- Add manual retry/reconcile actions with guardrails and audit.
- Add health checks and runbooks for token refresh, Connect setup, provider outage and credential rotation.

**Acceptance criteria:**

- Operators can diagnose common integration problems without secret exposure.
- Manual retry is unavailable where it could create duplicate sends.
- Provider outage does not block unrelated CRM features.

### Phase 19-ES.21 — Security, Privacy, Performance and Release Hardening

Tasks:

- Perform threat-model review for OAuth, callbacks, embedded signing, webhook spoofing, IDOR, file download, SSRF and secret leakage.
- Verify all ACL paths, retention policies, payload limits, audit coverage, timeout/retry behavior, and rate-limit handling.
- Review dependency/license posture for the official SDK and transitive packages.
- Verify frontend accessibility and error handling.
- Add monitoring dashboards and operational documentation.

**Acceptance criteria:**

- High-risk findings are fixed or explicitly documented and accepted by the responsible owner.
- No secrets or signing URLs appear in app logs, API responses or frontend telemetry.
- Security and provider tests pass without using production credentials.

### Phase 19-ES.22 — End-to-End QA and Release Readiness

Tasks:

- Run the complete fake-adapter E2E lifecycle.
- Run an approved Demo account smoke test for OAuth, template lookup, send to synthetic signer, Connect event update and final artifact retrieval.
- Confirm production setup steps, rollback/disable procedure, support runbook and known limitations.
- Verify OpenAPI, migrations, module registration, permissions, translations and clean deployment.
- Record test evidence and remaining limitations in the module delivery report.

**Acceptance criteria:**

- All required scenarios in Section 17 pass.
- Production remains disabled until an administrator explicitly configures and enables the production connection.
- No new database/test schema was created.
- A release checklist and support runbook are available.

---

## 19. Definition of Done

The module is considered complete only when all applicable items below are satisfied:

- [ ] `ESignature` is installed/registered using existing conventions and no `Ua` prefix is introduced.
- [ ] DocuSign is the first and fully tested provider adapter.
- [ ] Connection setup uses supported OAuth, account context is resolved dynamically, and credentials are stored securely.
- [ ] A user can create a draft, select a document/template, configure recipients, review, and send a request in DocuSign Demo.
- [ ] Remote signing progress is reflected through authenticated Connect webhook events.
- [ ] Duplicate, delayed, out-of-order, invalid and unknown webhook events are handled safely.
- [ ] The system prevents accidental duplicate sends when a provider outcome is ambiguous.
- [ ] Completed documents and completion evidence are downloaded and stored as separate derived artifacts with ACL.
- [ ] Requests are linked to source CRM records without duplicating core entities.
- [ ] Permissions are tested for list/detail/send/approve/void/correct/download/connection administration.
- [ ] Optional integrations with Sales, Projects, CustomerSuccess, ServiceDesk, AIAgents and CRMChat do not create mandatory dependencies.
- [ ] API contracts and OpenAPI docs are updated.
- [ ] Migrations are reviewed and backwards-compatible.
- [ ] Unit, adapter, webhook, API and E2E tests pass; any unrun checks are reported honestly.
- [ ] No automated test sends a real signing invitation or uses a production DocuSign account.
- [ ] No database, schema, container, or copy was created for tests.
- [ ] `AGENTS.MD` and security/secret handling rules are followed.
- [ ] `docs/compatibility/esignature.md`, admin setup guide, troubleshooting runbook and release evidence are complete.

---

## 20. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Duplicate envelope due to timeout/retry | `send_unknown` state, durable operation correlation, provider reconciliation before resend |
| Forged/replayed Connect event | Verify provider-supported authentication, deduplicate delivery, process only after durable verified intake |
| Wrong signer or template role | Explicit signer review, role mapping validation, immutable outgoing snapshot |
| Source document changed after review | Immutable version/hash, invalidate approval on changed input, never replace sent content |
| OAuth token or key leakage | Existing secrets service, server-only handling, redaction, rotation and revocation procedure |
| Incorrect local state due to event ordering | Append-only event history, guarded state machine, provider reconciliation |
| Unauthorized access to signed contract | Check request and source-record ACL for every API/download, short-lived signing URL |
| Provider outage or rate limit | bounded retry, queue backoff, safe error state, retry workbench; no blanket polling |
| Downstream module changes business state incorrectly | Domain events with explicit consumer contract; ESignature emits facts, not business conclusions |
| Overstated legal compliance | Clear product boundaries, jurisdiction-specific stakeholder/legal review, provider evidence retained |
| Provider SDK incompatibility | Verify SDK/package/runtime during audit, isolate SDK behind adapter, pin with project lockfile |
| Test creates real envelope or email | Fake provider by default; only explicit Demo sandbox smoke tests with synthetic data |

---

## 21. Administrator Setup and Operational Runbook

The module's docs must explain, at minimum:

1. Create/configure a DocuSign developer/demo integration application.
2. Choose the supported OAuth grant and configure redirect URI exactly.
3. Define the minimum scopes required by the implemented operations.
4. Configure the CRM secret store for client secret, refresh token or private-key reference.
5. Connect and verify account ID, user and account-specific API base URI.
6. Configure DocuSign Connect to call the CRM webhook endpoint and configure its supported authentication/signature mechanism.
7. Test webhook delivery and verify that the local inbox records authenticated test events.
8. Configure template-role mappings and test with synthetic documents and signers.
9. Enable embedded signing only after return/cancel URLs and recipient matching have been reviewed.
10. Promote from Demo to Production only through an explicit administrator action and a reviewed checklist.
11. Rotate credentials/secrets and re-authorize safely.
12. Disable a connection during an incident without deleting existing request history or signed artifacts.
13. Investigate `send_unknown`, webhook dead-letter, token refresh, artifact download and reconciliation errors.
14. Configure retention for signed documents, certificates and webhook records with stakeholder/legal guidance.

Never put real secret values into example `.env` files, screenshots, documentation, test snapshots, or commits.

---

## 22. Final Coding-Agent Execution Rule

The coding agent must proceed in small accepted increments:

1. Complete only `Phase 19-ES.0` and report repository findings and the gap matrix.
2. Wait for the normal task/phase handoff before implementing the next increment; do not generate the entire module in one large code pass.
3. For each subsequent phase, list the exact files/entities/endpoints to change, follow local conventions, implement one coherent slice, and run relevant safe checks.
4. Review the diff for duplicated platform capabilities, missing ACL, unsafe provider retries, unverified webhook handling, secrets in logs, and unintended file/database changes.
5. Report exactly what was implemented, which tests were executed, which provider environment was used, and any remaining blockers.

**Primary principle:** ESignature is a secure orchestration and evidence layer around DocuSign; DocuSign remains responsible for the signing experience and provider-side envelope/signature status. The CRM must preserve an auditable local record, enforce its own access controls, and never pretend that an unverified local action is a completed signature.
