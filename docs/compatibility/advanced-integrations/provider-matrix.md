# Advanced Integrations — provider matrix (initial version)

> Phase 19-INT.0 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §3.3, §4.2, §19 `19-INT.0`).
> Status: **initial version — provider selection confirmed, per-provider contracts not yet pinned.**
> Parent document: `docs/compatibility/advanced-integrations.md`.
> Repository audit: `docs/implementation/advanced-integrations-audit.md`.

This matrix records **which providers this module intends to support, in what order, and what each
one is expected to do**. It is a planning artifact, not a statement of current capability.

## How to read the status column

| Status | Meaning |
| --- | --- |
| `not started` | No adapter, no tests, no documentation. The provider does not exist in the product. |
| `contract pending` | The provider's behaviour has been specified at the level of *what the platform must do*, but the provider-side facts (exact object names, scopes, version, pagination, quota) have **not** been pinned from the vendor's current official documentation. |
| `pinned` | The provider's contract has been verified against current official documentation and recorded in `providers.md`, `oauth-scopes.md`, `sync-semantics.md` and `webhook-security.md`. |

**Nothing in this repository is `pinned` yet.** A provider reaches `pinned` only during its own
audit phase, because the plan (§3.2) requires each adapter to match the provider's *current*
official API documentation, and those details change. Publishing an unverified scope list or an
unverified API version here would be worse than an explicit gap.

## Tier legend

| Tier | Meaning | Plan §2.4 |
| --- | --- | --- |
| 0 | The shared control plane and the generic connector | Framework, not a vendor |
| 1 | Productivity and payments | Google Workspace, Microsoft 365, Zoom, Stripe |
| 2 | Marketing signals | Mailchimp, Meta Lead Ads |
| 3 | Commerce, accounting, enrichment | Shopify / WooCommerce, QuickBooks / Xero, data enrichment |

---

## 1. Provider × tier

| # | Provider | Tier | Auth model | CRM direction | First release? | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | **Generic REST API** connector | 0 | API key / bearer token, or none | Inbound → CRM (default), outbound optional | **Yes — 1st** | `contract pending` |
| 0 | **Generic outbound event/webhook** connector | 0 | n/a (the CRM is the sender) | CRM → external endpoint | **Yes — 1st** | `contract pending` |
| 1 | **Google Workspace** — Calendar, Contacts | 1 | OAuth 2.0 | Inbound → CRM; optional outbound | **Yes — 2nd** | `contract pending` |
| 2 | **Microsoft 365** — Outlook/365, People, Teams (subset) | 1 | OAuth 2.0 | Inbound → CRM; optional outbound | No | `contract pending` |
| 3 | **Zoom** | 1 | OAuth 2.0 | Outbound (CRM → Zoom) + inbound webhooks | No | `contract pending` |
| 4 | **Stripe** | 1 | Restricted API key | Inbound webhooks → CRM; outbound payment requests | No | `contract pending` |
| 5 | **Mailchimp** | 2 | OAuth 2.0 | Audience/member/campaign signals → CRM | No | `contract pending` |
| 6 | **Meta Lead Ads** | 2 | OAuth 2.0 + system-user token | Lead signals → CRM | No | `contract pending` |
| 7 | **Shopify** | 3 | OAuth 2.0 (custom app) | Orders/customers/products → CRM | No | `contract pending` |
| 8 | **WooCommerce** | 3 | REST API key + secret (Basic) | Orders/customers → CRM | No | `contract pending` |
| 9 | **QuickBooks Online** | 3 | OAuth 2.0 | Invoices / payments / customers → CRM | No | `contract pending` |
| 10 | **Xero** | 3 | OAuth 2.0 | Invoices / payments / contacts → CRM | No | `contract pending` |
| 11 | **Data enrichment** | 3 | API key | CRM records → enrichment provider → CRM | No | `contract pending` |

### 1.1 Why this order

1. **The generic REST connector is first.** It exercises every seam of the framework — object
   model, mapping and transformation, cursor/checkpoint, conflict detection, rate limiting,
   retry and idempotency — **with no vendor credentials, no OAuth and no external account**. It is
   fully testable against a fake adapter, which is what AGENTS.MD §3.3 and the plan's
   non-negotiable testing rules require. Nothing else can be validated this cheaply.
2. **Google Workspace is second.** OAuth 2.0 is the platform's single largest gap — there is no
   OAuth client, no state/nonce, no PKCE, no refresh lock and no scope persistence anywhere in the
   repository (audit §1.1). Validating that risk late is the mistake this ordering avoids. Google
   Calendar also provides a real incremental cursor and a real partial-failure mode (per-calendar
   selection), which the generic connector cannot provide.
3. **Stripe is the first payment connector** and the first to need the `PaymentProviderEvent`
   marker entity (audit §3.3). It is Tier 1, but it is the most sensitive connector (money,
   webhook signatures, idempotency) and should not be first.
4. **The Tier 2/3 families wait for the framework to be proven.** The plan explicitly requires
   that the first provider of each Tier 2/3 family be chosen *after* this audit.

### 1.2 Explicitly out of scope

| Not a connector | Why |
| --- | --- |
| Gmail / Outlook **mail transport** | Mail delivery stays with `packages/mail` + `email_accounts`. `packages/mail` exposes an `InboundMailProvider` port — that is the seam for a mail adapter, not a provider registry |
| Telephony / SMS / WhatsApp | Owned by `VoiceCommunications` with its own `VoiceProviderRegistry` |
| Model providers | Owned by `AIAgents` with its own `AIProviderRegistry` |
| Marketing sending / consent | Owned by `MarketingAutomation`. A connector may sync audience signals but **never** overrides consent or sends on the CRM's behalf |
| Telephony-style outbound events to arbitrary endpoints | Already provided by `modules/webhook-integration`; `AdvancedIntegrations` reuses it rather than forking a second delivery job |

---

## 2. Capability matrix

The columns below describe **what the platform must do for that provider**. Cells marked
`— to pin —` are provider-side facts that must be read from the vendor's current official
documentation during that connector's audit phase.

| Capability | Generic REST | Google Workspace | Microsoft 365 | Zoom | Stripe | Mailchimp | Meta Lead Ads | Shopify | WooCommerce | QuickBooks | Xero | Enrichment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OAuth 2.0 authorization-code | no | yes | yes | yes | no | yes | yes | yes | no | yes | yes | no |
| API key / secret auth | yes | — | — | — | yes | — | — | — | yes | — | — | yes |
| Token refresh handled by platform | n/a | yes | yes | yes | n/a | yes | yes | yes | n/a | yes | yes | n/a |
| Incremental / delta sync | cursor field | — to pin — | — to pin — | list-based | event-based | event-based | event-based | — to pin — | — to pin — | — to pin — | — to pin — | snapshot |
| Page-token pagination | yes | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — |
| Inbound webhook | no | yes | yes | yes | yes | yes | — to pin — | yes | no | — to pin — | — to pin — | no |
| Raw-body signature required | n/a | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | n/a | — to pin — | — to pin — | n/a |
| Endpoint validation challenge | n/a | — to pin — | — to pin — | yes | — to pin — | — to pin — | — to pin — | — to pin — | n/a | — to pin — | — to pin — | n/a |
| Provider-side object id → CRM record | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | n/a |
| Two-way sync supported | optional | optional | optional | no | no | no | no | no | no | no | no | no |
| Deletion semantics | unlink default | unlink default | unlink default | n/a | archive default | unlink default | unlink default | unlink default | unlink default | unlink default | unlink default | n/a |
| Rate-limit class | configurable | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — | — to pin — |
| Marker entity to register | — | — | — | — | `PaymentProviderEvent` | — | — | — | — | `AccountingExport` | `AccountingExport` | — |
| Audit trail required | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Scope must be pinned at connector audit | no | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |

---

## 3. First release set

| Connector | Why it is in the first release | Which framework seams it validates |
| --- | --- | --- |
| **Generic REST API** | No vendor credentials, no OAuth, no external account; fully testable with a fake adapter | Adapter contract · mapping and transformation · cursor/checkpoint · conflict detection · rate limit · retry and idempotency · sync-run history |
| **Generic outbound event/webhook** | Reuses the existing `modules/webhook-integration` delivery path rather than forking it | Outbound delivery · redaction · echo prevention |
| **Google Workspace** (Calendar, Contacts) | De-risks OAuth, the platform's largest gap; provides a real incremental cursor and a real partial-failure mode | OAuth state machine · secret storage and rotation · token refresh · scope persistence · incremental sync · webhook ingress with raw-body signature |

A connector ships only when its adapter, its mapping, its sync semantics, its conflict policy and
its tests exist. No provider is enabled by default in the product.

---

## 4. What this matrix does not yet answer

These are the questions a connector's own audit phase must answer from current official
documentation before that provider can move to `pinned`:

1. The exact API version and base URL in use.
2. The exact OAuth scope list, and which scopes are *minimum necessary* for the mapped objects.
3. The provider's object model: field names, types, required-ness, and pagination semantics.
4. The incremental-sync mechanism: cursor type, lifetime, expiry, and 410-style invalidation
   handling.
5. The webhook scheme: signature algorithm, header names, timestamp/replay window, ordering
   guarantees, and any endpoint-validation challenge.
6. The provider's quota model: limits, headers that report them, and backoff expectations.
7. Rate-limit and error semantics that the platform's rate limiter and retry policy must honour
   (including `Retry-After`).
8. Whether the provider supports idempotent write requests, and the idempotency key's scope.
9. Deletion and tombstone semantics, and how a provider-side delete maps onto a CRM record.
10. Sandbox/test-environment availability and the difference between sandbox and production
    credentials.

Each answer is recorded in the matching artifact under `docs/compatibility/advanced-integrations/`
as listed in `docs/compatibility/advanced-integrations.md` §5.
