# Advanced Integrations — webhook security per provider

> Phase 19-INT.16–19-INT.24 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §10.2, §18;
> `19-INT.12`, `19-INT.16`–`19-INT.24`).
> Status: **the shared ingress is delivered; each provider's algorithm below is the
> implementation's pin, not a verified observation of a live account.**
> Parent document: `docs/compatibility/advanced-integrations.md`.

## 1. The shared ingress

Every provider's callback arrives at one endpoint:

```
/api/v1/integrations/advanced-integrations/{providerKey}/{webhookKey}/{kind}
```

The order of the steps **is** the security posture:

1. **The path segment is an opaque webhook key, not a connection id.** It is a routing identifier,
   not a secret — the secret is the provider's signature. The key is 24 random bytes, and a
   connection has a unique index on it, so the endpoint cannot be enumerated.
2. **The signature is verified before anything is recorded.** An unverified payload is not written
   to the receipt table, not normalised and not enqueued. The verification itself is the connector's,
   because the algorithm is the provider's.
3. **The raw body is passed to the connector.** A provider signs the exact bytes it sent; a
   re-serialized body has a different signature. The ingress captures the raw body for the
   providers whose declaration says `requiresRawBody`.
4. **A delivery id deduplicates.** A repeated delivery is acknowledged and discarded; it is never
   processed twice. The unique index makes the decision atomic, so two concurrent deliveries of the
   same event cannot both be processed.
5. **The endpoint acknowledges fast and processes asynchronously.** A slow provider must never hold
   an HTTP connection open.

The receipt records what arrived — never a payload that was not verified.

## 2. The rules every provider's verification obeys

| Rule | Why |
| --- | --- |
| The signature covers the **exact bytes** the provider sent. | A signature over a re-serialized body is not the provider's signature. |
| The comparison is **constant-time**. | A byte-by-byte comparison leaks the position of the first difference, which is enough to forge a signature one byte at a time. |
| A **timestamp window** is enforced where the scheme has one. | Without it, a captured delivery can be replayed forever, however well signed. |
| A **missing header is a rejection**, never a "no signature" pass. | A provider that always signs must always be asked for its signature. |
| The secret is **per connection** and lives in the vault. | Two connections of one provider never share a signing secret, and a leaked secret affects one connection. |
| The secret is **never logged**, and the provider's own error body is **never** stored on a rejected delivery. | A provider's error message may quote a response body, which may quote a token. |

## 3. The per-provider schemes

| Provider | Header | Covered message | Comparison | Replay window | Endpoint validation |
| --- | --- | --- | --- | --- | --- |
| **Stripe** | `Stripe-Signature` | `<timestamp>.<raw body>` | HMAC-SHA256, hex, constant-time against every `v1=` value | 300 s (the timestamp is inside the signed message) | — |
| **Zoom** | `x-zm-signature` | `v1:<timestamp>:<raw body>` | HMAC-SHA256, hex, constant-time | 300 s | `plainToken` → `base64(HMAC-SHA256(secret, plainToken))` with the padding the provider documents |
| **Shopify** | `X-Shopify-Hmac-Sha256` | `<raw body>` | HMAC-SHA256, base64, constant-time | None in the scheme — the delivery id carries it | — |
| **Mailchimp** | `X-Mailchimp-Signature` | `<raw body><secret>` | MD5 digest, constant-time (the vendor's algorithm) | None in the scheme — the delivery id carries it | — |
| **Microsoft 365** | `clientState` | — | Constant-time string comparison | — | `validationToken` is echoed back |
| **Meta Lead Ads** | — | — | — | — | `hub.challenge` is echoed back |
| **Google Workspace** | — | — | — | — | — (no push notification in this release) |

### 3.1 Stripe

The `Stripe-Signature` header carries `t=<timestamp>,v1=<signature>`. The connector accepts any
number of `v1=` values — a provider that re-signs a delivery adds another one rather than replacing
the old — and compares each in constant time. The timestamp must be inside the window, and it is
part of the signed message, so a timestamp cannot be moved without breaking the signature.

The delivery id is Stripe's own `event.id`, which is unique and stable. A duplicate delivery is
therefore recognised without inventing a hash.

### 3.2 Zoom

The header is `v1=<timestamp>:<signature>`; the connector also accepts a comma as the separator,
because providers disagree on it and a connector that refuses a valid delivery is worse than one
that accepts both. The version prefix must still match, so a signature from a future scheme is not
mistaken for a current one.

The endpoint-validation answer is the provider's documented `encryptedToken`: the base64 HMAC-SHA256
of the `plainToken`, **with** the `=` padding the provider publishes.

Zoom publishes no delivery id, so the connector derives one from the event, its timestamp and the
object id. The same event delivered twice produces the same identifier.

### 3.3 Shopify

The header carries the base64 HMAC-SHA256 of the raw body. There is no timestamp in the scheme,
so the replay window is enforced by the delivery-id deduplication: `X-Shopify-Event-Id` is unique
per delivery.

### 3.4 Mailchimp

**The vendor's algorithm is MD5, and the platform says so rather than pretending otherwise.**
Mailchimp's documented scheme is an MD5 digest of the raw body concatenated with the webhook
secret. MD5 is not a sound MAC by modern standards, so:

- the comparison is still constant-time;
- the platform requires a **per-connection** secret rather than a shared one, so a leaked secret
  affects one connection;
- a Mailchimp delivery is treated as a **hint that must be reconciled**, never as a sufficient
  authorization on its own: the consent bridge applies the suppression, and the ordinary profile
  sync cannot undo it.

A deployment that cannot accept a weak vendor primitive should not enable the Mailchimp connector
and should say so in its risk register.

### 3.5 Microsoft 365

Graph does not sign its change notifications. The subscriber chooses a `clientState`, and the
platform compares it in constant time. A delivery without it is refused.

The endpoint is validated with the `validationToken` query parameter, which the platform echoes
back unchanged and never stores.

A change notification is turned into an event whose delivery id is derived from the subscription,
the resource, the change type and the object id — so the same change delivered twice is processed
once.

### 3.6 Meta Lead Ads

Meta validates an endpoint by calling it with a challenge and expecting it back. The challenge
**is** the verification; there is no signature to check. The delivery id is derived from the entry
id, the change field and the lead id.

### 3.7 Google Workspace

Not implemented in this release. Google Calendar's push notification is a channel with a
verification token rather than a signed payload, and adding it is a reviewed change rather than
something to smuggle in.

## 4. The security acceptance scenarios

The plan's §18 scenarios, and where each one is answered.

| # | Scenario | Where it is answered |
| --- | --- | --- |
| 1 | A regular user cannot view an administrator-owned provider token or connection secret. | The vault exposes `hasCredential` and a non-secret `credentialHint`; the credential read path is permission-gated. |
| 2 | A malicious OAuth callback cannot attach a provider account to another user's session or connection draft. | The callback derives the connection **from the hashed, single-use state**, and a user-scoped connection must still belong to the user that started the flow. |
| 3 | A forged or replayed webhook cannot trigger CRM updates. | The signature is verified before anything is recorded; the timestamp window bounds the replay; the delivery id deduplicates the rest. |
| 4 | A malicious external URL cannot use the generic connector to reach a cloud metadata endpoint or a private service. | The base URL is checked when the configuration is saved **and** on every request; the paths are allowlisted; a link that points elsewhere is refused. |
| 5 | A mapping cannot change a locked invoice, a privileged owner, an unsubscribe status, or a field outside the allowed policy. | The Stripe connector declares no write operation at all; the Mailchimp connector refuses a resubscribe without consent evidence; the enrichment service skips protected fields. |
| 6 | A provider outage cannot cause unbounded retry storms or repeated payment or creation actions. | Bounded retries with exponential backoff and jitter, a shared rate limiter, a shared circuit breaker, and dead letters. A Zoom create reconciles before it creates. |
| 7 | An operator can pause a connection and verify that all related workers stop issuing new provider requests. | A connection in a non-callable state is refused by the executor before the adapter is reached. |
| 8 | Secret values and raw personal data do not appear in logs, metrics labels or API error messages. | The HTTP client logs the method, the host, the path and the status — never the `Authorization` header, the body or the query string. A rejected delivery stores no payload. The Stripe summary carries no card data. |

## 5. The operational rules

| Rule | Detail |
| --- | --- |
| The endpoint is **unauthenticated by design**. | A provider holds no CRM session, so the provider's own signature is the authentication. The endpoint key is a routing identifier, not a secret. |
| A **rejected delivery is recorded**, with no payload. | The receipt says something arrived and was refused, and why. It never stores what was in it. |
| A **duplicate is acknowledged**, not processed. | The provider's retry must not become a second effect. |
| The **processing is asynchronous**. | The delivery is enqueued and the endpoint answers immediately. |
| A claimed event is **not** applied twice. | A provider event that belongs to a domain contract (a Stripe payment, a Mailchimp consent) is claimed by that domain's handler, and the generic mapping path skips it. |
| The signing secret is **rotatable** and **revocable**. | `POST /action/connections/:id/rotate-secret` with the `webhook_secret` kind. |
| The receipt history is **listable** per connection. | `GET /action/connections/:id/webhook-deliveries` — the status, the event type and the signature verdict, never the payload of a rejected delivery. |

## 6. What a deployment must confirm

1. The **exact bytes** each provider signs. The scheme is documented per provider above, but a
   provider that changes it breaks the delivery — and the connector refuses rather than accepting,
   so the failure is visible.
2. Whether the provider sends a **delivery id**. Where it does, the connector uses it. Where it
   does not, the connector derives one, and the derivation is per provider and documented above.
3. The **replay window**. The default is 300 seconds, which suits Zoom and Stripe. A provider with
   a longer delivery delay needs its own tolerance.
