# Advanced Integrations — provider matrix

> Phase 19-INT.0 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §3.3, §4.2, §19 `19-INT.0`).
> Updated by 19-INT.16–19-INT.24: **nine connectors are implemented.**
> Parent document: `docs/compatibility/advanced-integrations.md`.
> Repository audit: `docs/implementation/advanced-integrations-audit.md`.
> Per-connector contracts: `docs/compatibility/advanced-integrations/providers.md`.

This matrix records **which providers this module supports, in what order, and what each one is
expected to do**.

## How to read the status column

| Status | Meaning |
| --- | --- |
| `not started` | No adapter, no tests, no documentation. The provider does not exist in the product. |
| `contract pending` | The provider's behaviour has been specified at the level of *what the platform must do*, but the provider-side facts (exact object names, scopes, version, pagination, quota) have **not** been pinned from the vendor's current official documentation. |
| `pinned` | The provider's contract has been verified against current official documentation and recorded in `providers.md`, `oauth-scopes.md`, `sync-semantics.md` and `webhook-security.md`. |
| `implemented` | The connector exists, honours the connector contract, and is covered by the platform's own test suite. **Not** the same as `pinned`: see §5. |

**Nothing in this repository is `pinned` yet.** No connector was verified against a live vendor
account, so no provider-side fact here is an observed fact. A provider reaches `pinned` only when
somebody confirms it against the vendor's current official documentation and the four artifacts are
updated accordingly.

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
| 0 | **Generic REST API** connector | 0 | API key / bearer token, or none | Inbound → CRM | **Yes — 1st** | `implemented` — read-only |
| 0 | **Generic outbound event/webhook** connector | 0 | n/a (the CRM is the sender) | CRM → external endpoint | No | `not started` — deliberately: outbound needs a reviewed decision about which data may leave the CRM |
| 1 | **Google Workspace** — Calendar, Contacts | 1 | OAuth 2.0 | Inbound → CRM; outbound for writes | **Yes — 2nd** | `implemented` |
| 2 | **Microsoft 365** — Outlook/365, People | 1 | OAuth 2.0 | Inbound → CRM; outbound for writes | No | `implemented` |
| 3 | **Zoom** | 1 | OAuth 2.0 | Outbound (CRM → Zoom) + inbound webhooks | No | `implemented` — meetings only, no recordings |
| 4 | **Stripe** | 1 | Restricted API key | Inbound webhooks → CRM; payment transitions through `Sales` | No | `implemented` — read-only |
| 5 | **Mailchimp** | 2 | OAuth 2.0 | Audience/member/campaign signals → CRM | No | `implemented` |
| 6 | **Meta Lead Ads** | 2 | OAuth 2.0 | Lead signals → CRM | No | `implemented` |
| 7 | **Shopify** | 3 | Access token (custom app) | Orders/customers/products → CRM | **Yes — the first ecommerce provider** | `implemented` — inbound only |
| 8 | **WooCommerce** | 3 | REST API key + secret (Basic) | Orders/customers → CRM | No | `not started` |
| 9 | **QuickBooks Online** | 3 | OAuth 2.0 | Customers/invoices/payments → CRM | **Yes — the first accounting provider** | `implemented` — read-only |
| 10 | **Xero** | 3 | OAuth 2.0 | Invoices / payments / contacts → CRM | No | `not started` |
| 11 | **Data enrichment** | 3 | API key | CRM records → enrichment provider → CRM | No | `implemented` — one bounded provider (`rest-enrichment`) |

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

### 1.2 The two first-provider decisions (19-INT.22, 19-INT.23)

The plan asks for the ecommerce and accounting first providers to be chosen after the audit, with
the user's business priority and a confirmed sandbox recorded.

| Family | Chosen | Why | What was *not* available |
| --- | --- | --- | --- |
| Ecommerce | **Shopify** | It publishes a documented Admin API with a versioned endpoint scheme, a signed webhook scheme and a per-webhook event id. WooCommerce's REST API is a WordPress plugin whose availability depends on the site's configuration, which makes a "framework plus one provider" release less verifiable. | **No Shopify store and no test-store credentials.** The connector is therefore verified by the contract suite and by unit tests against recorded provider shapes, never against a live store. No store credential is in the repository. |
| Accounting | **QuickBooks Online** | It publishes a documented query endpoint that returns a company's customers, invoices and payments with a per-record `LastUpdatedTime` — exactly the watermark the platform's checkpoint model needs. | **No Intuit sandbox account.** The connector is verified by the contract suite and by unit tests. The environment defaults to the **sandbox**, so a half-configured installation cannot post to a production ledger. |

Both decisions are recorded here rather than left implicit, and both are honest about what was
missing. A deployment that has a store or a sandbox in hand should confirm the endpoint, the
scope names and the signature algorithm against the vendor's current documentation before it
enables the connector.

### 1.3 Explicitly out of scope

| Not a connector | Why |
| --- | --- |
| Gmail / Outlook **mail transport** | Mail delivery stays with `packages/mail` + `email_accounts`. `packages/mail` exposes an `InboundMailProvider` port — that is the seam for a mail adapter, not a provider registry |
| Telephony / SMS / WhatsApp | Owned by `VoiceCommunications` with its own `VoiceProviderRegistry` |
| Model providers | Owned by `AIAgents` with its own `AIProviderRegistry` |
| Marketing sending / consent | Owned by `MarketingAutomation`. A connector may sync audience signals but **never** overrides consent or sends on the CRM's behalf. The Mailchimp connector routes an external unsubscribe to the consent service; it never decides one. |
| Telephony-style outbound events to arbitrary endpoints | Already provided by `modules/webhook-integration`; `AdvancedIntegrations` reuses it rather than forking a second delivery job |
| Zoom **recordings** | The plan requires a separate privacy and retention decision before a recording is downloaded or retained. That decision has not been made, so the connector does not implement recordings at all. |

---

## 2. Capability matrix

The columns below describe **what the platform must do for that provider**. The delivered cells
are the implementation's own pins, recorded in `providers.md`, `oauth-scopes.md`,
`sync-semantics.md` and `webhook-security.md`; the `— to pin —` cells are provider-side facts
that must still be read from the vendor's current official documentation.

| Capability | Generic REST | Google Workspace | Microsoft 365 | Zoom | Stripe | Mailchimp | Meta Lead Ads | Shopify | WooCommerce | QuickBooks | Xero | Enrichment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OAuth 2.0 authorization-code | no | yes | yes | yes | no | yes | yes | no (access token) | no | yes | — to pin — | no |
| API key / secret auth | yes | — | — | — | yes | — | — | yes | yes | — | — to pin — | yes |
| Token refresh handled by platform | n/a | yes | yes | yes | n/a | yes | yes | n/a | n/a | yes | — to pin — | n/a |
| Incremental / delta sync | cursor field | `syncToken` | Graph delta | list-based | event-based | event-based | event-based | list-based | — to pin — | `LastUpdatedTime` | — to pin — | snapshot |
| Page-token pagination | yes | `nextPageToken` | `@odata.nextLink` | `next_page_token` | `starting_after` | offset | `after` | `Link` header | — to pin — | `startPosition` | — to pin — | — |
| Inbound webhook | no | **no** | yes | yes | yes | yes | yes | yes | no | **no** | — to pin — | no |
| Raw-body signature required | n/a | n/a | no | yes | yes | yes | no | yes | n/a | n/a | — to pin — | n/a |
| Endpoint validation challenge | n/a | n/a | yes | yes | no | no | yes | no | n/a | n/a | — to pin — | n/a |
| Provider-side object id → CRM record | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | — to pin — | n/a |
| Two-way sync supported | **inbound only** | optional | optional | outbound only | **no** | optional | no | **no** | no | **no** | — to pin — | no |
| Deletion semantics | unlink default | unlink default | unlink default | n/a | not synchronized | unlink default | unlink default | unlink default | — to pin — | not synchronized | — to pin — | n/a |
| Rate-limit class | configurable | fixed window | provider header | fixed window | fixed window | fixed window | provider header | fixed window | — to pin — | fixed window | — to pin — | quota + cache |
| Marker entity to register | — | — | — | — | `PaymentProviderEvent` (used) | — | — | — | — | `AccountingExport` (not yet) | — | — |
| Audit trail required | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | — to pin — | yes |
| Scope must be pinned at connector audit | no | yes | yes | yes | yes | yes | yes | yes | yes | yes | — to pin — | yes |

Two cells changed in a way worth naming:

- **Google Workspace has no inbound webhook.** Google Calendar's push notification is a channel
  with a verification token rather than a signed payload; the incremental sync covers the
  requirement instead. See `providers.md` §3.1.
- **QuickBooks Online has no inbound webhook.** A QBO app registers one notification URL for the
  whole app, so a per-connection endpoint cannot be expressed without a proxy. The
  `LastUpdatedTime` watermark covers the requirement. See `providers.md` §3.8.

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

**The implementation's answers to these questions are recorded** in `providers.md`,
`oauth-scopes.md`, `sync-semantics.md` and `webhook-security.md` — but they are the
implementation's own pins, derived from the vendor's published documentation, and **not**
observations of a live account. Section 5 says what that means.

## 5. What `implemented` does and does not mean

| `implemented` means | `implemented` does **not** mean |
| --- | --- |
| The adapter exists, honours the connector contract, and is covered by the platform's own test suite. | That the connector was verified against a live vendor account. |
| The provider's endpoints, field names, scopes and signature scheme are pinned in the code and in the four artifacts. | That those pins are current. The vendor may have changed them. |
| The connector is registered in the catalog. | That the connector is **enabled**. A registered connector is available; a connection still has to be created, authorized and mapped, and no provider is enabled by default. |
| The security properties hold as the code implements them: the raw body is signed, the comparison is constant-time, the timestamp window is enforced, the delivery id deduplicates. | That a real deployment's network, proxy and secret-management arrangement preserve them. That is a deployment review, not a code property. |
| The connector cannot do what the plan forbids — Stripe creates no charge, the generic REST connector reads only, the Mailchimp connector cannot silently resubscribe. | That the connector is complete. Each has documented limitations, listed in `providers.md` §4. |

**The next honest step for a provider is not more code — it is a live verification.** Somebody with
a store, a sandbox or a partner account confirms the pins against the vendor's current
documentation, updates the four artifacts, and moves the row from `implemented` to `pinned`.

