# Runbook — marketing send operations

> **Scope:** operating Marketing Automation sending today. Phase 19-MA.7 delivers the provider binding, the
> rate/concurrency interface and the safe test send; the queued campaign and journey delivery pipeline lands
> in 19-MA.8/MA.9, and provider webhooks in 19-MA.10. Anything not yet delivered is marked **later phase**
> rather than described as if it existed.
> **Related:** [`docs/marketing-automation/provider-adapters.md`](../marketing-automation/provider-adapters.md),
> [`docs/marketing-automation/consent-and-suppression.md`](../marketing-automation/consent-and-suppression.md).

## 1. Where the controls are

Every control below is server-side; a UI toggle is never the enforcement point.

| Control | Endpoint / setting | Who |
| --- | --- | --- |
| Module diagnostics (capabilities, dependencies, provider state) | `GET /api/v1/MarketingAutomation/action/health` | administrator |
| Provider key, limits, test-send allowlist | `POST /api/v1/MarketingAutomation/action/settings` (`provider.*`) | administrator |
| Global emergency stop | `POST /api/v1/MarketingAutomation/action/globalSendPause` | administrator |
| Test send | `POST /api/v1/MarketingAutomation/action/campaign/{id}/sendTest` | campaign `edit` + allowlist |
| Campaign lifecycle (`start`, `pause`, `cancel`, …) | `POST /api/v1/MarketingAutomation/action/campaign/{id}/{command}` | campaign `edit` + validation |

## 2. Before the first send

1. **Confirm the transport.** `MAIL_TRANSPORT` must be `smtp` or `relay`; `none` and `memory` are deliberately
   not delivering, so the adapter reports `disabled`. Use the email module's transport `verify` action to open
   the connection.
2. **Bind the provider.** Set `provider.key` (normally `platform-mail`). An unknown key is refused at the
   settings write, and a key that resolves to a disabled adapter leaves `start` blocked with
   `PROVIDER_NOT_BOUND`.
3. **Allowlist test recipients.** `provider.testSend.allowedRecipients` must list internal mailboxes; an empty
   list means test sends are refused. Nothing else can receive a test send.
4. **Set the limits.** `provider.limits.ratePerMinute` / `maxConcurrency` should respect the vendor's quota;
   leave `ratePerMinute: 0` only when the provider publishes no limit and the deployment has no policy.
5. **Check encryption.** If campaigns name an `emailAccountId`, `ENCRYPTION_KEY` must be set, or the account's
   stored password cannot be decrypted and the send fails as `SENDER_ACCOUNT_INVALID`.

## 3. Reading a test send

The response is the diagnostic: `accepted`, the per-recipient receipts, and — on failure — `errorKind`.

| `errorKind` / reason code | What it means | Do this |
| --- | --- | --- |
| `AUTH_FAILED` | the provider rejected the credentials | fix the sending account's password (encrypted at rest) or the `SMTP_*` settings; do not retry |
| `CONNECTION_REFUSED` / `DNS_UNAVAILABLE` / `PROVIDER_FAILED` (retryable) | the server was unreachable or answered `4xx` | check the host/port/TLS and the provider status, then try again |
| `RECIPIENT_REJECTED` | the provider rejected that address | correct the address; the campaign's own recipients are filtered by the eligibility gate, not here |
| `MESSAGE_INVALID` | our own validation refused the message (bad header, address, content) | fix the template or the sender configuration |
| `SENDER_ACCOUNT_INVALID` | the campaign's mailbox is missing, inactive or unusable | fix or re-point the campaign's sending account |
| `RATE_LIMITED` (HTTP 429) | the deployment's own limiter refused the call | wait the indicated time or raise `provider.limits` deliberately |
| `SUBMISSION_UNKNOWN` | the connection died while the message was being submitted | **do not** press send again; confirm with the provider whether the message arrived before retrying |

A test send leaves **no** trace on the campaign: no status change, no history row, no snapshot, no delivery
row, no domain event. That is why it is safe to run at any point in a campaign's life.

## 4. Stopping everything

The §13 emergency stop is absolute and administrator-only:

```
POST /api/v1/MarketingAutomation/action/globalSendPause   { "paused": true, "reason": "vendor incident" }
```

- It halts every marketing send path — campaign `start`/`resume`, validation, and the test send — and the
  refusal is `GLOBAL_SEND_PAUSED`.
- It does **not** touch records: campaigns, audiences, consent and suppression are unchanged, so lifting the
  stop resumes from the same state.
- `cancel` (with a reason) is the per-campaign stop, and it is recorded in `CampaignTransition` with the actor.

Resuming without duplicate messages:

1. Confirm the provider is healthy (test send to an allowlisted mailbox).
2. Lift the stop with a reason — it is stored on the settings row and shown in diagnostics.
3. **Later phase (MA.9):** before restarting a paused campaign, check the per-recipient delivery rows for
   `unknown_submission` and reconcile them with the provider; that is the state that must never be blindly
   resent.

## 5. Provider incidents

| Symptom | First check | Note |
| --- | --- | --- |
| `provider.mode` is `disabled` while the deployment expects live | `MAIL_TRANSPORT` and `provider.key` | a `none`/`memory` transport is a deliberate sandbox, not a misconfiguration to work around |
| Repeated `AUTH_FAILED` | the mailbox credentials | rotate the credential in the existing store; never paste it into a record or a ticket |
| High latency or timeouts | the provider's status and `provider.limits` | a test send holds the request for at most the transport's own timeout |
| Bounce/complaint spike | suppression records (`MarketingSuppression`) | **later phase (MA.10):** automatic pausing on thresholds is not implemented yet; today the stop is manual |
| Events missing from reports | — | **later phase (MA.10/MA.11):** provider webhooks and campaign statistics are not implemented; no report exists to be wrong yet |

## 6. What an operator must never do

- Never add a live provider purely to make a test pass: tests are expected to use the fake adapter or a
  scripted one, and the acceptance rule is that a unit or E2E test cannot reach a live provider.
- Never edit a credential into a campaign, a note, a stream post or a template — credentials live in the
  platform's own stores.
- Never lift the global stop to work around a failing provider check; fix the provider first.
- Never treat a `SUBMISSION_UNKNOWN` as a failure to retry.
