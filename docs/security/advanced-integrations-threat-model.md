# Advanced Integrations — security threat model

> Phase 19-INT.26 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §18; `19-INT.26`).
> Scope: the `AdvancedIntegrations` module, its connectors and its cross-module contracts.
> Runbook: `docs/runbooks/advanced-integrations.md`.
> Compatibility: `docs/compatibility/advanced-integrations.md` · `webhook-security.md`.

This is the module's own review of the trust boundaries the plan names in §18: CRM users, provider
admins, OAuth callbacks, webhook providers, connector adapters, background jobs, external APIs,
uploaded/imported payloads, generic REST destinations and AI-assisted configuration helpers.

It is a review of **what the code does**, not a claim that the code is perfect. Every control
below names the file that implements it, so a reviewer can check the claim rather than trust it.

## 1. The trust boundaries

| # | Boundary | What crosses it | Who is untrusted |
| --- | --- | --- | --- |
| B1 | CRM user → the module's API | Connection, mapping, sync, conflict and replay commands | A user without the right capability |
| B2 | The module → a domain module | A cross-module contract call | A connector that wants to change something it does not own |
| B3 | The module → a provider (outbound) | A request built from mapped CRM data | The CRM data, and the provider's answer |
| B4 | A provider → the module (inbound) | A webhook delivery | The provider, the network and anybody who can replay a captured delivery |
| B5 | The module → a generic REST destination | A request to an admin-configured endpoint | The endpoint, and anybody who can edit the endpoint configuration |
| B6 | A provider → a background job | A job payload | The queue, and a payload that was written by an older run |
| B7 | An imported payload → a CRM record | Mapped field values | The provider's data, entirely |
| B8 | The module → the operator | The metrics, the trail, the diagnostics | The operator is trusted; the *content* is not |

## 2. The controls, boundary by boundary

### B1 — a CRM user and the module's API

| Control | Where |
| --- | --- |
| Every route checks a capability server-side. A hidden control is never authorization. | `advanced-integrations-permission.service.ts` |
| The capabilities are synthetic ACL resources, so the platform's own engine, the `sysAdmin` bypass and the wildcard rule apply unchanged. | `advanced-integrations-module.ts` |
| The metrics, the audit trail and the diagnostics need a **separate** capability, because they show more than the catalog does. | `INTEGRATION_DIAGNOSTIC_PERMISSION_ENTITY` |
| A privileged action is **audited** with its actor, its reason and its outcome. | `integration-audit.service.ts` |
| A connection the caller does not own is not listed and not readable. | `connection-lifecycle.service.ts` |
| A manual sync is bounded: `maxRecords` ≤ 1000, `pageSize` ≤ 1000. | `dto/advanced-integrations-shapes.ts` |

**Residual risk.** A user who holds `connectionAdmin` can create a connection to any registered
provider. That is the intended power, and the audit trail records it.

### B2 — the module and a domain module

| Control | Where |
| --- | --- |
| A connector never imports a domain service. It calls a **named, versioned contract** that names its owner. | `integration-contracts.ts` |
| A contract that nobody published is **absent**, and the caller is told so rather than getting a silent success. | `IntegrationContractRegistry.apply` |
| A contract is **optional**: a module that is not installed publishes none, and the caller degrades instead of crashing. | `contracts/*.ts` |
| A contract's result names the **records it changed**, so the platform can mark their origin. | `IntegrationContractResult.affectedRecords` |
| An imported payload may not write a **protected field** — owner, team, roles, permissions, payment status, consent — unless the mapping recorded the review, and the mapping cannot go live without it. | `protected-fields.ts`, `mapping.service.ts` |

**The event loop.** A contract that changes a CRM record produces a domain event like any other
change, and the outbound path would push it back to the provider — which would report it again,
forever. The contract therefore names the records it touched, and the bridge records their
**origin** as the provider's own. The outbound path then recognises the change as an echo and skips
it. This is the same guard an inbound sync uses.

### B3 — the module and a provider

| Control | Where |
| --- | --- |
| A connection in a non-callable state is refused **before** the adapter is reached. | `connector-executor.service.ts` |
| The credential is resolved from the vault, handed to the adapter, and never logged. | `credential-vault.ts`, `provider-http-client.ts` |
| The HTTP client logs the method, the host, the path and the status — never the `Authorization` header, the body or the query string. | `provider-http-client.ts` |
| A redirect is **not** followed. A `302` to a metadata endpoint would turn a connector into an SSRF gadget. | `provider-http-client.ts` |
| The destination address is checked: no private, loopback, link-local or cloud-metadata address; `https` only. | `provider-http-client.ts` |
| A request carries a bounded timeout and a bounded body. | `provider-http-client.ts`, `connectors/kit/connector-kit.ts` |
| Retries are bounded, with exponential backoff **and** jitter; `Retry-After` is honoured. | `resilience.ts` |
| A rate limiter and a circuit breaker refuse a call before it leaves the process. | `resilience.ts` |
| A provider's own idempotency key is used where the provider supports one. | `connectors/kit/connector-kit.ts` |

**The Stripe case.** The Stripe connector declares **no write operation at all**, so no generic sync
path can create a charge, a refund or a payment link. A Stripe payment event is claimed by the
`Sales` contract and applied through `PaymentService.ingestProviderEvent`, which is idempotent on
the provider's event id, writes the audit row and the outbox event in the same transaction, and
never moves a payment out of a terminal state. The connector sends a **summary**, never the
provider's raw object, so the domain service's refusal of card-shaped payloads is never triggered
by accident.

**The Zoom case.** Zoom's create endpoint has no idempotency key, so a retry after an ambiguous
timeout would create a second meeting. The connector therefore **reconciles** before it creates:
the meeting carries a `tracking_fields` marker holding the platform's operation id, and a create
first looks for a meeting that already carries it.

### B4 — a provider and the module (inbound)

| Control | Where |
| --- | --- |
| The endpoint key is 24 random bytes with a unique index. The endpoint cannot be enumerated. | `connection-lifecycle.service.ts` |
| The signature is verified **before anything is recorded**. An unverified payload is not written, not normalised and not enqueued. | `webhook-ingress.service.ts` |
| The signature is computed over the **exact bytes** the provider sent. | `connectors/kit/webhook-signatures.ts` |
| The comparison is **constant-time**. | `connectors/kit/webhook-signatures.ts` |
| A timestamp window is enforced where the scheme has one. | `connectors/kit/webhook-signatures.ts` |
| A missing signature is a **rejection**, never a pass. | `connectors/kit/webhook-signatures.ts` |
| The delivery id deduplicates, atomically, so two concurrent deliveries of the same event cannot both be processed. | `integration_webhook_deliveries` unique index |
| A rejected delivery records the **verdict**, never the payload. | `webhook-ingress.service.ts` |
| The endpoint acknowledges fast and processes asynchronously. | `webhook-ingress.service.ts` |
| The signing secret is per connection and lives in the vault. | `credential-vault.ts` |

**Mailchimp's weak primitive.** Mailchimp's documented scheme is an MD5 digest. That is the
vendor's algorithm, not the platform's, and it is weak. The platform compensates: the comparison
is constant-time, the secret is per connection rather than shared, and a Mailchimp delivery is
treated as a hint that must be reconciled rather than as sufficient authorization. A deployment that
cannot accept a weak vendor primitive should not enable the connector, and should say so in its
risk register.

**The Graph case.** Graph does not sign its notifications. The subscriber chooses a `clientState`
and the platform compares it in constant time; a delivery without it is refused.

### B5 — a generic REST destination

| Control | Where |
| --- | --- |
| The base URL is validated when the configuration is **saved**: `https` only, no credentials in the URL, no fragment, no query string, and no loopback or cloud-metadata host. | `connectors/generic-rest/generic-rest-endpoint.ts` |
| The address check runs again on **every request**. | `provider-http-client.ts` |
| The paths are allowlisted, with at most one `{id}` segment, and `..` is refused. | `connectors/generic-rest/generic-rest-endpoint.ts` |
| The methods are allowlisted. | `connectors/generic-rest/generic-rest-endpoint.ts` |
| The response is read through **explicit dotted pointers**. A pointer is a sequence of object keys — not an expression, so it can never reach a prototype or run code. | `readPointer` |
| A malformed answer is refused rather than half-read. | `connectors/generic-rest/generic-rest.adapter.ts` |
| The payload is bounded, and the timeout is finite. | `connectors/generic-rest/generic-rest-endpoint.ts` |
| The credential goes **only** to the endpoint's own host. There is no way to point an authentication header elsewhere. | `connectors/generic-rest/generic-rest.adapter.ts` |
| There is **no write operation**, so no arbitrary outbound request is possible. | `connectors/generic-rest/generic-rest.adapter.ts` |
| No configuration key that looks like a credential is accepted. | `assertConfigIsSafe` |

**The enrichment endpoint** is vetted the same way, and its field maps are the allowlist: the
provider receives only the fields the profile opted in to, and only the fields the response map
names can be written.

### B6 — a provider and a background job

| Control | Where |
| --- | --- |
| The webhook job carries the provider's delivery id, which is the deduplication key. | `apps/worker/src/handlers/advanced-integrations-handlers.ts` |
| The outbound job carries the operation id, whose idempotency key is already recorded. | `apps/worker/src/handlers/advanced-integrations-handlers.ts` |
| The domain-event subscriber carries the event id, and the outbound key is derived from it. | `apps/worker/src/handlers/advanced-integrations-handlers.ts` |
| A claimed event is **not** applied twice: the generic mapping path skips it. | `webhook-ingress.service.ts` |
| The worker calls the API under a **shared capability**, and the API's routes are the authority. | `advanced-integrations.controller.ts` |

### B7 — an imported payload and a CRM record

| Control | Where |
| --- | --- |
| The transformation set is **allowlisted**. No expression, script or template is ever evaluated. | `transformation-compiler.ts` |
| A **protected field** is never written by an imported payload without a recorded review. | `protected-fields.ts` |
| A provider-side delete **unlinks**; it never hard-deletes a CRM record. | `sync-orchestrator.service.ts` |
| A conflict never overwrites silently: the default `manual` policy opens a conflict. | `conflict.service.ts` |
| A stale conflict is refused: the provider's value is not applied when the record changed again. | `conflict.service.ts` |
| The CRM write goes through the ACL-aware entity service, so the platform's own record rules apply. | `sync-orchestrator.service.ts` |

### B8 — the module and the operator

| Control | Where |
| --- | --- |
| The metrics carry **no high-cardinality label**: a provider key, a status, an error code or a state — never a record id, a token or a URL. The circuit breaker is reported per **provider**, not per connection. | `integration-metrics.service.ts` |
| The audit trail's detail is passed through `redactSecrets`, so a credential a caller carelessly put in a reason string never reaches the trail. | `integration-audit.service.ts` |
| The **debug mode** is off by default, expires, needs the diagnostics capability and exposes only field **names**. | `advanced-integrations-settings.service.ts` |
| The retention purge is off by default, removes by primary key in a bounded batch, and never touches a CRM record. | `integration-retention.service.ts` |

## 3. The plan's security acceptance scenarios

The eight scenarios of plan §18, and where each one is answered.

| # | Scenario | Where it is answered | Test |
| --- | --- | --- | --- |
| 1 | A regular user cannot view an administrator-owned provider token or connection secret. | The vault exposes `hasCredential` and a non-secret hint; the credential read path is permission-gated. | `apps/api/test/advanced-integrations.test.ts` |
| 2 | A malicious OAuth callback cannot attach a provider account to another user's session or connection draft. | The callback derives the connection from the **hashed, single-use state**, and a user-scoped connection must still belong to the user that started the flow. | `apps/api/test/advanced-integrations.test.ts` |
| 3 | A forged or replayed webhook cannot trigger CRM updates. | The signature is verified before anything is recorded; the window bounds the replay; the delivery id deduplicates the rest. | `apps/api/test/advanced-integrations-connectors.test.ts` |
| 4 | A malicious external URL cannot use the generic connector to reach a cloud metadata endpoint or a private service. | The base URL is checked at save time **and** at request time; the paths are allowlisted; a foreign link is refused. | `apps/api/test/advanced-integrations-connectors.test.ts` |
| 5 | A mapping cannot change a locked invoice, a privileged owner, an unsubscribe status, or a field outside the allowed policy. | The Stripe connector declares no write; the Mailchimp connector refuses a resubscribe without evidence; the enrichment service skips protected fields; a mapping cannot activate with an unreviewed protected target. | `apps/api/test/advanced-integrations-contracts.test.ts` |
| 6 | A provider outage cannot cause unbounded retry storms or repeated payment or creation actions. | Bounded retries with backoff and jitter, a rate limiter, a circuit breaker, dead letters; a Zoom create reconciles before it creates. | `apps/api/test/advanced-integrations-engine.test.ts` |
| 7 | An operator can pause a connection and verify that all related workers stop issuing new provider requests. | A connection in a non-callable state is refused by the executor before the adapter is reached. | `apps/api/test/advanced-integrations-engine.test.ts` |
| 8 | Secret values and raw personal data do not appear in logs, metrics labels or API error messages. | The HTTP client logs no header, body or query; a rejected delivery stores no payload; the Stripe summary carries no card data; the metrics carry no id. | `apps/api/test/advanced-integrations-connectors.test.ts`, `apps/api/test/advanced-integrations-contracts.test.ts` |

## 4. AI-assisted configuration helpers

The plan names this boundary. The module's answer is a **refusal**:

The module ships **no** AI-assisted configuration helper. A helper that generated a mapping, an
endpoint configuration or a transformation from a natural-language instruction would be a path
that turns a prompt into a privileged write, and the platform's transformation compiler is an
allowlist by design — there is no expression language for a model to produce. The `AIAgents`
module may later expose a **read-only** provider lookup as a tool, but that is a separate, reviewed
decision with its own approval model, and it is not part of this release.

## 5. The known gaps

| Gap | Why it is still a gap |
| --- | --- |
| No connector was verified against a live vendor account. | A deployment must confirm the pins before enabling a connector in production. |
| Mailchimp's webhook primitive is MD5. | The vendor's algorithm. The platform compensates but cannot replace it. |
| The generic REST connector is read-only. | Outbound needs a reviewed decision about which data may leave the CRM. |
| The debug mode exposes field names, not values. | Deliberate: a value is a fact about a person, a field name is a fact about the provider's API. |
| The platform has no metrics facility. | The metrics here are **derived** from the module's own tables. A real telemetry stack would replace them. |
| The provider cost and quota figures are not reported. | No delivered provider publishes a reliable figure, and the plan says to report it only where the vendor does. |
| The AI-assisted configuration helper does not exist. | Deliberate. See §4. |
