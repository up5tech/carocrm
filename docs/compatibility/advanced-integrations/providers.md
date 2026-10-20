# Advanced Integrations — the delivered connector contracts

> Phase 19-INT.16–19-INT.24 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §3.3, §12;
> `19-INT.16`–`19-INT.24`).
> Status: **nine connectors implemented; every contract verified by the platform's own test
> suite, none verified against a live vendor sandbox.**
> Parent document: `docs/compatibility/advanced-integrations.md`.
> Companions: `oauth-scopes.md`, `sync-semantics.md`, `webhook-security.md`.

This document records **what each delivered connector actually does**. It is written from the
implementation, not from a wish: every statement below is a property the code enforces and the
test suite proves.

## 0. The honesty clause

No vendor sandbox, partner approval or production account was available for this delivery. That
has three consequences, stated here rather than buried:

1. **Every provider-side fact in this document is the implementation's own choice, pinned from the
   vendor's published API at the time of writing.** It is not a verified observation of a live
   account. A deployment must confirm the endpoint, the scope names and the signature algorithm
   against the vendor's current documentation before it enables a connector in production.
2. **No test in this repository talks to a vendor.** Every connector test runs against an injected
   `fetch`, so the suite is deterministic, free and safe to run. The cost of that choice is that a
   vendor-side change would not be caught by these tests.
3. **The API versions below are pins, not claims of currency.** A pin is deliberate: it says which
   shape the connector was written against. Bumping a pin is a reviewed change.

## 1. The connector kit

Nine connectors would be nine copies of the same rules if each one implemented them. The shared
kit (`apps/api/src/advanced-integrations/connectors/kit/`) holds them once:

| Piece | What it guarantees |
| --- | --- |
| `connector-kit.ts` | A bounded JSON-over-HTTP path: the platform's timeout, no redirect following, the address check, a payload ceiling, a normalized error. Option readers that refuse a malformed value instead of coercing it. Opaque cursor encoding that refuses a cursor it did not write. |
| `oauth2-base.ts` | The four OAuth operations from one declarative configuration: authorization URL, code exchange, refresh, revocation. The client secret is read from the credential bundle and never logged. A failed exchange is permanent, so the platform moves the connection to `reauthorization_required` instead of retrying a grant that cannot succeed. |
| `base-adapter.ts` | The mandatory part of a connector and the OAuth part, so a new connector cannot forget an operation without a type error. |
| `webhook-signatures.ts` | Constant-time signature comparison, the timestamp window, and one named function per vendor algorithm. A missing signature is a rejection, never a pass. |

## 2. What every delivered connector has in common

| Property | Value |
| --- | --- |
| Registration | Code-registered in `IntegrationRegistry` by `ConnectorRegistrar`. A connector that breaks the contract suite stops the module from loading. |
| Enabled by default | **No.** A registered connector is *available*; a connection still has to be created, authorized and mapped. |
| The fake provider | Registered outside production only, and marked `deprecated`. A live deployment must not be able to select a provider that fabricates answers. |
| Errors | `ProviderError` with a stable code and a category. Nothing above the adapter sees a vendor type, and no error carries a credential. |
| Secrets | In the credential vault, never in the connection's configuration. A configuration key that looks like a credential is refused. |
| Deletes | A provider-side delete never hard-deletes a CRM record. The mapping's deletion policy decides: unlink, archive or conflict. |
| Writes | Only where the plan allows them. Stripe, Meta, Shopify, QuickBooks and the generic REST connector are read-only, and say so in their capability declaration. |

## 3. The connectors

### 3.1 Google Workspace — `google-workspace` (19-INT.16)

| | |
| --- | --- |
| Authentication | OAuth 2.0, PKCE (S256), refresh and revocation supported |
| API | Calendar `v3`, People `v1` |
| Objects | `calendarEvent`, `contact` |
| Sync | Full and incremental (Calendar `syncToken`, People `nextSyncToken`) |
| Webhook | **None.** Google Calendar's push notification is a channel with a verification token rather than a signed payload; the incremental sync covers the requirement instead. |
| Write | Outbound, and only with the `calendar` / `contacts` scope granted |

**The two rules that shape it**

- **The private-event policy is in the connector, not in a mapping.** A private event carries other
  people's attendee list. A mapping is configuration an administrator edits; the privacy rule is a
  product rule. A private event is therefore never emitted unless the connection explicitly opted
  in with `includePrivateEvents`, and its attendee list is never emitted even then.
- **An expired sync token is a controlled resync.** Google answers an expired `syncToken` with
  `410 Gone`; the connector reports `cursorExpired`, the engine drops the cursor and re-runs the
  full enumeration. Because a provider delete maps to *unlink*, the resync cannot erase a record
  that is merely missing from the new snapshot.

**Per-connection options**

| Option | Meaning | Default |
| --- | --- | --- |
| `calendarIds` | The calendars to read. | `["primary"]` |
| `includePrivateEvents` | Whether a private event may leave the provider. | `false` |

### 3.2 Microsoft 365 — `microsoft-365` (19-INT.17)

| | |
| --- | --- |
| Authentication | OAuth 2.0, PKCE (S256) |
| API | Microsoft Graph `v1.0` |
| Objects | `outlookEvent`, `outlookContact` |
| Sync | Full and incremental (Graph delta links) |
| Webhook | Yes — change notifications, authenticated by `clientState` |
| Write | Outbound, and only with `Calendars.ReadWrite` / `Contacts.ReadWrite` |

**The three rules that shape it**

- **The delta link is the cursor.** Graph answers with a `@odata.nextLink` while the feed is still
  paging and a `@odata.deltaLink` when it is not. The connector keeps the current link in its own
  opaque cursor, so the engine pages through the whole feed and the **final** delta link is what
  gets persisted. A connector that returned the first page's link would either re-read forever or
  skip a change.
- **A `nextLink` is re-validated before it is requested.** Graph's links are absolute URLs, and an
  absolute URL that came from a provider is still an untrusted destination. Every link is checked
  against `graph.microsoft.com` before it is requested, so a tampered cursor cannot turn the
  connector into an SSRF gadget.
- **A `403` becomes an actionable reauthorization.** The connector translates Graph's refusal into
  `SCOPE_MISSING` with the detail `insufficient_scope`, so the operator sees "the connection needs
  a permission it was not granted" rather than an opaque provider error.

**Subscription renewal** is an explicit operator action
(`POST /api/v1/AdvancedIntegrations/action/connections/:id/renew-subscriptions`). The subscription
ids live in the connection's `subscriptionIds` option; a connection without them has nothing to
renew. Graph subscriptions expire after a few days, and an expired one silently stops delivering —
which is exactly why the renewal is visible rather than a side effect of a read.

### 3.3 Zoom — `zoom` (19-INT.18)

| | |
| --- | --- |
| Authentication | OAuth 2.0, PKCE (S256) |
| API | `v2` |
| Objects | `meeting` |
| Sync | Outbound only. Zoom is a **destination**: the CRM decides when a meeting exists. |
| Webhook | Yes — `x-zm-signature` over the raw body, with an endpoint-validation challenge |
| Recordings | **Not implemented.** The plan requires a separate privacy and retention decision before a recording is downloaded or retained, and that decision has not been made. |

**No duplicate meeting.** Zoom's create endpoint has no idempotency key, so a retry after an
ambiguous timeout would create a second meeting. The connector solves it the only way a provider
without idempotency support allows:

- every created meeting carries a `tracking_fields` entry holding the platform's operation id;
- before creating, the connector **reconciles** by listing the user's meetings and looking for that
  marker.

So the same CRM change produces one meeting, however the network behaves. The test suite proves it:
a create whose marker is already present returns the existing meeting and makes exactly one HTTP
call.

### 3.4 Stripe — `stripe` (19-INT.19)

| | |
| --- | --- |
| Authentication | A restricted API key, sent as a bearer token |
| API | `v1` |
| Objects | `paymentIntent`, `customer`, `checkoutSession` — **all read-only, inbound-only** |
| Webhook | Yes — `Stripe-Signature` over the raw body |
| Writes | **None.** A charge, a refund or a payment link can never be created through this connector. |

**Payment state changes the Sales domain service, not the generic mapping path.** This is the
single most important decision in the connector, and it is enforced rather than documented:

- the connector declares **no write operation at all**, so the generic sync path cannot create a
  Stripe object and cannot write a CRM payment either;
- a Stripe event of type `payment_intent.*` or `checkout.session.*` is **claimed** by
  `StripePaymentBridge` and applied through `PaymentService.ingestProviderEvent`, which is
  idempotent on Stripe's own event id, writes an audit row and an outbox event in the same
  transaction, moves a payment request from `pending` to `paid`/`failed` and never out of a
  terminal state;
- the bridge sends a **summary**, never the provider's raw object, so the domain service's refusal
  of card-shaped payloads is never triggered by accident. The summary is asserted to contain no
  `client_secret` and no card number.

**Test and live mode are separated by the credential.** `stripeKeyMode()` reports `test` or `live`
from the key prefix, and the platform has exactly one CRM. There is no second database, and there
is no code path that issues a charge at all.

### 3.5 Mailchimp — `mailchimp` (19-INT.20)

| | |
| --- | --- |
| Authentication | OAuth 2.0, PKCE (S256) |
| API | `3.0`, addressed per data centre |
| Objects | `audienceMember` (read and write), `campaign` (read-only) |
| Webhook | Yes — `X-Mailchimp-Signature` over the raw body |
| Scope model | Mailchimp's OAuth publishes no per-object scope, so the connector declares none. The grant is account-wide, and the connector reads only the objects it declares. |

**A suppressed member cannot be silently resubscribed.** A write that would move a member from
`unsubscribed`, `cleaned` or `pending` to `subscribed` is **refused** with a `CONFLICT` unless the
mapped fields carry explicit `consentEvidence`. The check reads the provider's *current* state
first, so a stale CRM record cannot undo a suppression the provider already applied. The rule lives
in the connector because a mapping is configuration and consent is a product rule.

**An external unsubscribe is propagated, not mirrored.** The connector turns the three facts into
three distinct event types, and `MailchimpConsentBridge` routes them to
`MarketingSuppressionService`:

| Mailchimp event | Suppression reason |
| --- | --- |
| `unsubscribe` | `GlobalOptOut` |
| `unsubscribe` with a complaint reason | `Complaint` |
| `cleaned` | `HardBounce` |

The provider's own event id travels with the block as provenance. `GlobalOptOut` and `Complaint`
are not overridable in `MarketingAutomation`, so the refusal holds on both sides of the boundary.

**Per-connection options**

| Option | Meaning | Default |
| --- | --- | --- |
| `audienceIds` | The audiences to sync. | `[]` |
| `tenantRef` (the connection's provider account) | The data centre, e.g. `us21`. A connection without one is refused rather than guessed at. | — |

### 3.6 Meta Lead Ads — `meta-lead-ads` (19-INT.21)

| | |
| --- | --- |
| Authentication | OAuth 2.0, PKCE (S256) |
| API | Graph `v21.0` |
| Objects | `lead` (read-only), `leadForm` (read-only) |
| Webhook | Yes — the endpoint-validation challenge is echoed back |
| Writes | **None.** A lead form submission is a fact a person made, not a record the CRM may edit at the provider. |

- **The submission id is the identity.** Meta's lead id is stable and unique per submission, so
  the same submission imported twice resolves to the same CRM record. The form id is carried as the
  *parent*, so a submission stays scoped to the form it came from.
- **Consent provenance is carried, not inferred.** Every answer whose name mentions consent, terms,
  marketing or privacy travels with the submission. Nothing is interpreted: the CRM receives the
  evidence and its own consent policy decides what it means.
- **A revoked permission pauses the connector.** A `403` is an authorization failure, which the
  platform classifies as permanent: the connection moves to `reauthorization_required` rather than
  consuming quota on a request that can never succeed.

**Per-connection options**

| Option | Meaning | Default |
| --- | --- | --- |
| `leadFormIds` | The lead forms to import. | `[]` |
| `tenantRef` (the connection's provider account) | The ad account id. | — |

### 3.7 Shopify — `shopify`, the first ecommerce provider (19-INT.22)

**Why Shopify and not WooCommerce.** The provider matrix lists Shopify first in tier 3, and Shopify
publishes a documented Admin API with a versioned endpoint scheme, a signed webhook scheme and a
per-webhook event id. WooCommerce's REST API is a WordPress plugin whose availability depends on
the site's configuration, which makes a "framework plus one provider" release less verifiable. The
decision is recorded in `provider-matrix.md`.

| | |
| --- | --- |
| Authentication | A custom-app access token, sent as `X-Shopify-Access-Token` |
| API | Admin `2024-10` |
| Objects | `order`, `customer`, `product` — **inbound only** |
| Webhook | Yes — `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256) over the raw body |
| Writes | **None.** The plan forbids pushing CRM edits back to a store by default. |

- **A store delete is not a CRM delete.** The webhook marks the object as deleted; the mapping's
  deletion policy decides whether the CRM record is unlinked, voided or archived.
- **Money is a decimal string.** The totals are carried as the store's own decimal text and are
  never parsed into a binary float.
- **A page link is re-validated.** Shopify paginates with a `Link` header; the next page URL is
  checked against the connection's own store host before it is requested.
- **The delivery id is the provider's.** `X-Shopify-Event-Id` is unique per delivery, so the
  deduplication needs no invented key.

**Per-connection options**

| Option | Meaning | Default |
| --- | --- | --- |
| `tenantRef` (the connection's provider account) | The shop domain, e.g. `example.myshopify.com`. | — |

### 3.8 QuickBooks Online — `quickbooks-online`, the first accounting provider (19-INT.23)

**Why QuickBooks Online and not Xero.** The provider matrix lists QBO first in tier 3, and QBO
publishes a documented query endpoint that returns a company's customers, invoices and payments
with a per-record `LastUpdatedTime` — exactly the watermark the platform's checkpoint model needs.

| | |
| --- | --- |
| Authentication | OAuth 2.0 (no PKCE — the provider does not offer it) |
| API | `v3`, `minorversion=75` |
| Objects | `customer`, `invoice`, `payment` — **all read-only** |
| Sync | Full and incremental (the `LastUpdatedTime` watermark) |
| Webhook | **None.** A QBO app registers one notification URL for the whole app, so a per-connection endpoint cannot be expressed without a proxy. The watermark covers the requirement. |
| Writes | **None.** A financial operation runs through the Sales domain service, not through a generic mapping. |

- **The CRM's Sales module owns the business document.** The accounting package is told about a
  CRM invoice; it does not decide whether the invoice is issued.
- **A posted document is not an ordinary editable object.** The connector records the document's
  state (`draft`, `posted`, `paid`, `void`) so the CRM can tell them apart.
- **Sandbox by default.** The environment is a property of the connection. A connection that does
  not name one talks to the **sandbox**, so a half-configured installation can never post anything
  to a production ledger. There is one CRM, never two.

**Per-connection options**

| Option | Meaning | Default |
| --- | --- | --- |
| `environment` | `sandbox` or `production`. | `sandbox` |
| `tenantRef` (the connection's provider account) | The company (realm) id. | — |

### 3.9 Generic REST — `generic-rest` (19-INT.24)

**Not an escape hatch.** The plan is explicit that this "is not an arbitrary 'connect to any URL'
escape hatch", and the implementation refuses everything that would make it one.

| Rule | How it is enforced |
| --- | --- |
| The base URL is vetted | `https` only, no credentials in the URL, no fragment, no query string, and the host must not be loopback, `localhost` or a cloud-metadata name. The address check (private, loopback, link-local, CGNAT) runs when the configuration is saved, so a bad endpoint never becomes a connection. |
| The paths are allowlisted | Literal segments plus at most one `{id}` segment. `..` is refused. The list path and the item path must both be in the allowlist. |
| The methods are allowlisted | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, and the connector performs only the ones it implements. |
| The schema is explicit | Dotted pointers name the array, the id, the timestamp, the version, the deleted flag and the cursor. A pointer is a sequence of object keys — not an expression, so it can never reach a prototype or run code. |
| The payload is bounded | A maximum response size, a maximum request size, a finite timeout. |
| The credential goes only to the endpoint's own host | There is no way to point an authentication header at another host. The credential comes from the vault; the configuration never holds it. |
| The first release reads | No write operation exists, so no arbitrary outbound request is possible. |

**A malformed answer is refused, not half-read.** The connector requires the pointer to reach an
array and every item to carry an identifier. An answer that does not is a `permanent_validation`
failure: it will not be better on a retry, and half-mapping it would create records that cannot be
correlated later.

**The endpoint's options**

| Option | Meaning | Default |
| --- | --- | --- |
| `baseUrl` | The `https` base URL. Checked when the connection is saved. | — |
| `paths` | The allowlisted path templates. At most one `{id}` segment each. | — |
| `methods` | The allowlisted HTTP methods. | — |
| `listPath` | The path of the collection. Must be in `paths`. | the first path |
| `itemPath` | The path of one object. Must be in `paths`. | none |
| `authMode` | `none`, `bearer`, `header` or `oauth`. | `none` |
| `authHeaderName` | The header the credential is sent in, for the `header` mode. | — |
| `itemsPointer` | A dotted pointer to the array in the answer. | `items` |
| `idPointer` | A dotted pointer to the item's identifier. | `id` |
| `updatedAtPointer`, `versionPointer`, `deletedPointer` | Dotted pointers to the item's timestamp, version and deleted flag. | none |
| `nextCursorPointer` | A dotted pointer to the next cursor. | none |
| `pageSizeParam`, `cursorParam` | The query parameters the page size and the cursor are sent in. | none |
| `pageSize`, `maxResponseBytes`, `timeoutMs` | The bounds. | 50, 1 MiB, 15 s |

None of these names looks like a credential, which matters: the platform refuses a configuration
key that does, so an option named `credentialHeader` would have been rejected before it could
ever be saved. The credential itself always comes from the vault.

### 3.10 Data enrichment — `rest-enrichment` (19-INT.24)

**A bounded adapter pattern for one provider at a time.** The port
(`connectors/enrichment/enrichment.port.ts`) is deliberately tiny: one method.

| Rule | How it is enforced |
| --- | --- |
| The provider sees only the opted-in fields | The request body carries exactly the fields the profile's `requestFieldMap` names, and only those the record actually holds. |
| The provider cannot introduce a field | The answer is read through the `responseFieldMap`, and the service keeps only the fields the profile opted in to. |
| A change is never automatic | A preview produces a **pending** result. A human accepts or rejects it. There is no code path that writes an enriched value without a decision. |
| A protected field is never written | A profile may name protected fields; they are skipped whatever the provider answered. |
| A value the provider did not return is not invented | A missing answer leaves the CRM value alone. |
| The provenance is kept | Old value, new value, provider, retrieval time, confidence, the provider's own reference, the credits used and the decision are all stored. |
| The spend is bounded | A daily credit quota and a cache with a TTL. A cached answer is reused only when the record has not changed since it was fetched. |
| The endpoint is vetted | `https` only, no credentials in the URL, no loopback and no cloud-metadata host. |

The service lives in `apps/api/src/advanced-integrations/enrichment.service.ts`; the profiles and
the results live in `integration_enrichment_profiles` and `integration_enrichment_results`
(migration `059`).

**Where the credential comes from.** The enrichment provider is not a catalog entry, so it has no
connection of its own. A profile names the **connection** that holds the credential — in practice a
`generic-rest` connection, whose `api_key` is the enrichment endpoint's credential — and carries
the endpoint and the field maps in the profile's own options. The credential is therefore read
from that connection's vault entry, and the profile's options are refused if any of their keys
looks like a credential.

## 4. The known limitations

These are the gaps a deployment must know about. None of them is hidden in a code comment.

| Limitation | Where it bites |
| --- | --- |
| No connector was verified against a live vendor account. | Every provider-side fact above is an implementation choice pinned from published documentation. Confirm before production use. |
| Mailchimp's OAuth grants account-wide access; it publishes no per-object scope. | A Mailchimp connection can reach more of the account than it syncs. The connector reads only what it declares, but the *grant* is broader. |
| Zoom and Google have no "delete a meeting" or "delete a contact" write in this release. | A cancellation is a business decision, not a technical one. |
| Google Calendar push notifications are not implemented. | The reconciliation requirement is met by the incremental sync; a push-based deployment waits for a reviewed change. |
| QuickBooks Online has no per-connection webhook. | The `LastUpdatedTime` watermark covers the requirement; a push deployment waits for a proxy. |
| The generic REST connector reads only. | Outbound delivery to a vetted endpoint needs a reviewed configuration and a separate decision about which data may leave the CRM. |
| The enrichment provider is a REST endpoint, not a vendor SDK. | The plan asks for one provider at a time, and a vendor SDK would be a dependency without a second provider to justify it. |
| Scope narrowing is per connection, not per mapped object. | A Google connection that syncs only contacts still requests the calendar read scope. The operator may narrow the request through the OAuth flow, and the connection's requirement then becomes the narrowed set. |
| The cross-module contracts (19-INT.25) are partial. | The Stripe and Mailchimp bridges exist because those two connectors cannot work without them. The other modules have no adapter yet. |
