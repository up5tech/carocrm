# Marketing provider adapters, limits and the safe test send

> **Phase:** 19-MA.7 (PLAN_Phase_19_Marketing_Automation.md §1.2, §5.8, §9.4, §13, §15 `19-MA.7`).
> **Where the code lives:** the contract, registry and fake are
> [`marketing-automation-provider.ts`](../../apps/api/src/marketing-automation/marketing-automation-provider.ts);
> the live adapter is
> [`marketing-provider-kernel.adapter.ts`](../../apps/api/src/marketing-automation/marketing-provider-kernel.adapter.ts);
> the rate/concurrency interface is
> [`marketing-provider-limiter.ts`](../../apps/api/src/marketing-automation/marketing-provider-limiter.ts);
> the bootstrap binding is
> [`marketing-provider-binding.service.ts`](../../apps/api/src/marketing-automation/marketing-provider-binding.service.ts);
> the test-send command is
> [`marketing-test-send.service.ts`](../../apps/api/src/marketing-automation/marketing-test-send.service.ts).

## 1. One contract, no vendor SDK

The module talks to a provider only through `MarketingProviderAdapter`
(`info`, `validate`, `send`, `verify`). No campaign, journey or delivery code names a vendor, and the plan's
§1.2 rule ("provider-independent domain model") is enforced by there being exactly one place a message becomes
a network call.

The audit (`docs/implementation/marketing-automation-audit.md` §2, §4) records that this repository already
owns a provider-neutral mail port: `@carocrm/mail`'s `MailTransport`, selected by `MAIL_TRANSPORT` and
reachable through the existing `MAIL_TRANSPORT_TOKEN` seam. MA.7 therefore adds **no SDK and no second mail
stack** — `KernelMailMarketingProvider` adapts that port, and an extension that replaces the transport with
SES/SendGrid/Graph changes nothing in the marketing module (§7.1 `MarketingProviderRegistry`).

## 2. Registered keys and capability metadata

`provider.key` in the module settings names the adapter a deployment sends through. An empty key means **no
provider**: campaigns cannot start, and no test send can run. Resolution **fails closed** — an unknown key
resolves to `disabled`, never to "whatever registered first".

| Key | Reachable when | `mode` | Test send | Notes |
| --- | --- | --- | --- | --- |
| `` (empty) → `none` | always | `disabled` | no | Nothing is sent, and the refusal says so. |
| `fake` | `MAIL_TRANSPORT=memory` only | `disabled` | yes | In-memory, deterministic; `hardbounce@…`/`unknown@…` addresses drive each receipt outcome. It never claims to be live. |
| `platform-mail` | transport registered (production API) | `live` when `MAIL_TRANSPORT=smtp`/`relay`, otherwise `disabled` | yes | The live adapter: wraps the platform transport and, when a message names a sending account, that mailbox's own SMTP settings. |
| any key an extension registers | when registered | adapter-defined | adapter-defined | `MarketingProviderRegistry.register(adapter)`. |

Capability metadata (`info`) is the §5.8 "capabilities and verified sender/configuration identity" list:
`key`, `label`, `mode`, `maxRecipients`, `ratePerMinute`, `maxConcurrency`, `fromAddress`, `reportsEvents`,
`supportsTestSend`. It is reachable from the administrator-only health endpoint
(`GET /api/v1/MarketingAutomation/action/health` → `provider.available`) and contains **no credential** — the
`fromAddress` is the sending address, not a secret.

## 3. Credentials: the platform's stores, never marketing tables

| Source | Used when | Storage |
| --- | --- | --- |
| `MAIL_TRANSPORT` + `SMTP_*` environment | the deployment sends through one mailbox | deployment configuration (existing platform settings) |
| `email_accounts` row named by the campaign's `emailAccountId` | the campaign names a sending mailbox | password encrypted with `ENCRYPTION_KEY` (AES-256-GCM), decrypted in memory only for the submission |

Consequences that are enforced by construction:

- no marketing record carries a credential, so no marketing API can return one;
- a provider failure is reported as a stable reason code and our own sentence — the provider's response text,
  the SMTP transcript and the credential never reach a response or a log (§7.4, §9.3);
- a missing `ENCRYPTION_KEY` makes an account-backed send fail with a clear configuration error instead of
  silently degrading.

## 4. Limits

`MarketingProviderLimiter` is the single rate/concurrency interface (§5.8, §11.2). Settings:

```
provider.limits.ratePerMinute   # 0 = whatever the provider allows (the default)
provider.limits.maxConcurrency  # default 1
```

The provider's own published limit (`info.ratePerMinute`) is the fallback when the deployment sets none. A
refusal is the platform's own `429` (`RateLimitError`) carrying a retry hint — not a vendor error.

It is deliberately **in-process**, so one API process never exceeds the configured ceiling but a
multi-worker fleet is not coordinated. The authoritative, shared limit belongs to the queued delivery phase
(MA.9) and to the Redis store that phase will use; saying so is better than pretending a `Map` is a
distributed limiter.

## 5. Error classification

Every failure leaves the adapter as a `MarketingProviderError` with one of three §15 states and a stable
reason code.

| State | Meaning | Examples (reason code) | Retry policy |
| --- | --- | --- | --- |
| `retryable` | nothing was accepted; a later attempt may succeed | `4xx` response, refused connection (`CONNECTION_REFUSED`), DNS (`DNS_UNAVAILABLE`), local `RATE_LIMITED` | retry with bounded backoff (MA.9) |
| `permanent` | retrying fails identically | rejected authentication (`AUTH_FAILED`), rejected envelope (`RECIPIENT_REJECTED`), unusable sending account (`SENDER_ACCOUNT_INVALID`), transport validation (`MESSAGE_INVALID`) | do not retry; fix configuration or content |
| `unknown_submission` | the socket died while the message was being submitted (`SUBMISSION_UNKNOWN`) | `ETIMEDOUT`, `ECONNRESET`, `EPIPE` | **do not** resend blindly: reconcile with the provider first (MA.9/MA.10) |

Rejected authentication is `permanent` here even though the kernel's generic SMTP classifier treats `EAUTH`
as transient, because §5.8 names "rejected authentication" among the failures not to retry indefinitely.

## 6. Test send

`POST /api/v1/MarketingAutomation/action/campaign/{id}/sendTest`

```json
{ "recipients": ["qa@example.com"], "confirm": true, "recipientType": "Contact", "recipientId": "…" }
```

Rules, all enforced server-side:

1. **Permission:** the caller must be able to *edit* the campaign. The allowlist is administrator-configured
   settings, so a marketer cannot widen it.
2. **Allowlist:** `provider.testSend.allowedRecipients`. An empty list disables test sends entirely; an
   address that is not on it is refused. The campaign's own audience is never used as a fallback.
3. **Confirmation:** `provider.testSend.requireConfirmation` (default `true`) makes `confirm: true` mandatory.
4. **Ceiling:** `provider.testSend.maxRecipients` (default 5, maximum 20) bounds one command.
5. **Provider:** `provider.key` must resolve to an adapter that is `live` and `supportsTestSend`.
6. **Suppression:** a suppressed recipient (global opt-out, complaint, hard bounce, operator block) is always
   refused — suppression applies to every sending path. **Consent is deliberately not consulted**: the
   recipients are internal, administrator-allowlisted addresses and the message is marked as a test. This is
   the one documented exception, and it is recorded in the response as a test send.
7. **Markers:** subject prefixed `[TEST] `, an `X-Marketing-Test: true` header, `X-Marketing-Campaign`, and a
   `*** TEST MESSAGE — NOT A CAMPAIGN SEND ***` banner at the top of both the plain-text and HTML bodies.
8. **No campaign side effects:** no lifecycle transition, no validation stamp, no snapshot, no delivery row,
   no `marketing.*` event. Test sends are not counted as campaign sends or journey outcomes.
9. **Duplicate guard:** the same submission key returns the recorded answer with `duplicate: true` instead of
   sending twice. The guard is per process and bounded; the durable dedupe arrives with MA.8's recipient
   records.
10. **Classified outcome:** a submission failure is returned as `{ accepted: false, errorKind, error }` with
    HTTP 200 — the command executed; the outcome is the diagnostic. `unknown_submission` specifically tells
    the operator that pressing send again is not safe.

One deliberate architectural exception: this command calls the provider **synchronously** so the operator sees
the real classification, while the campaign pipeline stays queue-based (MA.9; `email.service.ts`: "nothing is
sent from the API process"). It is bounded to one message, to allowlisted addresses, under the limiter — and a
transport timeout (default 20 s per connection phase) is the worst-case request duration.

## 7. Sandbox versus production configuration

| Environment | Configuration | Effect |
| --- | --- | --- |
| Development / CI / any test | `MAIL_TRANSPORT=none` (default) or `memory`; no `provider.key`, or a key that resolves to `disabled` | Every adapter reports `disabled`. Campaign `start` is blocked with `PROVIDER_NOT_BOUND` and the test send is refused — a test **cannot** reach a live provider. |
| Staging with a real provider | `MAIL_TRANSPORT=smtp` + `SMTP_*` (or a sandbox account on the vendor's side), `provider.key=platform-mail`, allowlisted test addresses | Live sends are possible; the allowlist keeps test sends inside the team. |
| Production | as staging, with the verified sender and the deployment's `provider.limits` set to the vendor's quota | Campaign and journey sends (from MA.8/MA.9 onward) go through the same adapter and the same gates. |

Checklist before flipping a deployment to live:

- [ ] `MAIL_TRANSPORT` is `smtp` or `relay` and the `SMTP_*` settings were verified (the email module's own
      `verify` action opens the connection).
- [ ] `provider.key` is set and the health endpoint reports `provider.mode: "live"`.
- [ ] `provider.testSend.allowedRecipients` lists internal mailboxes only.
- [ ] `provider.limits` respects the vendor's published quota.
- [ ] `ENCRYPTION_KEY` is set if campaigns name an `emailAccountId`.
- [ ] The test send has been run and produced an accepted receipt with the test markers visible.

## 8. Handed to later phases

- **MA.8** creates the durable send definition, audience snapshot and per-recipient delivery rows, and stamps
  `revisionId`/`contentHash` on each delivery.
- **MA.9** enqueues chunks, claims work atomically, re-checks consent/suppression at submission, applies the
  shared rate limiter, and reconciles `unknown_submission` before any resend.
- **MA.10** verifies provider webhooks and normalizes delivery/bounce/complaint events; adapters advertise
  that with `reportsEvents`.
