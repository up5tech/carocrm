# Runbook — marketing provider incidents

> **Scope:** what to do when the *provider* is the problem — credentials, quotas, outages, webhook delivery,
> bounce/complaint spikes, stalled queues. For the day-to-day path (bind a provider, run a test send, approve
> and queue a send, stop everything) see
> [`marketing-send-operations.md`](marketing-send-operations.md).
> **Delivered in:** Phase 19-MA.7 (provider binding, limits, error classes), 19-MA.9 (delivery worker,
> retries, dead letters), 19-MA.10 (webhooks, normalization, suppression feedback), 19-MA.18 (diagnostics).
> **Related:** [`docs/marketing-automation/provider-adapters.md`](../marketing-automation/provider-adapters.md),
> [`docs/marketing-automation/metrics.md`](../marketing-automation/metrics.md),
> [`docs/marketing-automation/security-and-privacy.md`](../marketing-automation/security-and-privacy.md).

## 0. First two minutes

```
GET  /api/v1/MarketingAutomation/action/health        # provider, secret, emergency stop, dependencies
GET  /api/v1/MarketingAutomation/action/diagnostics   # ledger states, dead letters, stuck sends
```

`health` answers "is the deployment wired up"; `diagnostics` answers "what is stuck right now". Everything
below starts from those two responses. Neither returns credentials, addresses or message bodies.

| Signal | Where | Means |
| --- | --- | --- |
| `provider.mode` | health | `live` = will send; `disabled`/`fake` = sending is refused, not faked |
| `provider.resolvedKey` vs `configuredKey` | health | a mismatch means the configured key no longer resolves (adapter removed or renamed) |
| `checks[provider-webhook-secret]` | health | "verified against the configured secret" or "every event is recorded as rejected" |
| `checks[emergency-stop]` | health | whether the global stop is on, and the reason recorded with it |
| `deliveryStates` | diagnostics | how many recipients sit in each ledger state |
| `deadLetters` | diagnostics | `state = 'Failed'` — retries are exhausted, not in flight |
| `stuckSending` | diagnostics | `Sending` with a claim older than ten minutes — a worker died mid-claim |

## 1. Credentials fail (`AUTH_FAILED`, `PROVIDER_NOT_CONFIGURED`)

**Symptom:** test send and delivery both return `AUTH_FAILED`; `health` shows a live provider whose
verification fails. After `delivery.autoPauseAfterAuthFailures` consecutive authentication failures (default 3)
the **send pauses itself** instead of burning every recipient's retry budget.

1. Do **not** retry the send. The credential is wrong, and each retry spends a recipient attempt.
2. Fix the credential in the platform store it came from: `SMTP_*` for the transport, or the
   `email_accounts` row a campaign names. `ENCRYPTION_KEY` must be present to decrypt a stored password — a
   missing key surfaces as `SENDER_ACCOUNT_INVALID`, not as a wrong password.
3. Rotate rather than re-enter: a credential pasted into a note, a stream post or a ticket is a leak — delete
   the note, not just the password.
4. Resume the paused send (`POST …/action/send/{id}/resume`) only after a **test send to an allowlisted
   mailbox** succeeds. Resuming does not resend anything already `Sent`; it re-queues the rows that were never
   submitted.

## 2. Webhook events are not arriving

**Symptom:** `delivery.delivered` stays at zero while the provider dashboard shows deliveries; or `health`
reports `provider-webhook-secret` as unconfigured.

| Check | Answer |
| --- | --- |
| `MARKETING_WEBHOOK_SECRET` set? | Unset is the **default** and means every event is rejected (`SECRET_NOT_CONFIGURED`). Set it and restart: config is read once at boot. |
| Signature header present and exact? | The route compares `x-webhook-signature` with the configured secret in constant time. A prefix, a hash of the secret, or a different header name is a rejection. |
| `x-webhook-timestamp` within five minutes? | Older is refused before anything is written (replay window). A provider clock that is minutes behind will look like an outage. |
| `marketing_provider_webhook_inbox` rows? | `processing_status = 'rejected'` + `failure_reason` names the cause (`INVALID_SIGNATURE`, `SECRET_NOT_CONFIGURED`). `processed_with_errors` means the event was stored but a side effect (the suppression write) failed — see §3. |
| Duplicates reported? | `duplicate: true` is normal provider retry behaviour and is *correct*: one inbox row, one event, no counter moved. |

The dedupe key is `(provider, providerEventId)` — or, when the provider sends no id, a composite of type +
message id + recipient + `occurredAt`. **Confirm the provider reuses ids only for retries**; a provider that
recycles event ids will have genuine events dropped as duplicates.

## 3. A bounce or complaint did not suppress the address

**Symptom:** a hard bounce arrived, but the address still appears eligible on the next dry run.

1. Read the inbox row: `processed_with_errors` means the event was recorded and the suppression write failed;
   the `failure_reason` says why. The event is **not** retried automatically (the dedupe key would make the
   retry a no-op), so act on it manually.
2. Confirm the payload carried `emailHash`. Suppression is keyed by the module's address digest, never by a
   plaintext address; an event without one cannot block anything. If the provider cannot send it, the fix is a
   mapping in the adapter, not a manual block per event.
3. Verify the block: `GET /api/v1/MarketingAutomation/action/suppression?emailAddress=…` returns the row with
   `reason` (`HardBounce`/`Complaint`/`GlobalOptOut`), `scope: Global` and `source: ProviderWebhook`.
4. **Never delete a suppression row** to "unstick" a send. `revoke` exists only for overridable reasons; a
   complaint, a hard bounce and a global opt-out are not overridable.

## 4. Bounce or complaint spike

There is no automatic threshold pausing in this release: the stop is an operator decision, made on evidence.

1. `GET …/action/campaign/{id}/stats` — compare `delivered`, `bounced`, `complained`.
2. If the spike is one campaign, `POST …/action/campaign/{id}/pause`; if it is the provider, use the global
   stop (section 5).
3. Read a sample of the log (`GET …/action/campaign/{id}/log?normalizedType=hard_bounce`). A spike concentrated
   in one acquisition source is a list-quality problem; one spread across the base is usually a sender-reputation
   problem (authentication, IP warming, content).
4. Do not "clean" the ledger. Bounced rows are terminal on purpose; the suppression list is the durable answer.

## 5. Stop everything, then resume without duplicates

```
POST /api/v1/MarketingAutomation/action/globalSendPause   { "paused": true, "reason": "provider outage" }
```

The stop is absolute: campaign `start`/`resume`, validation, test send, queueing and every in-flight submission
refuse with `GLOBAL_SEND_PAUSED`. A worker that already claimed a row returns `paused` and leaves the row
non-terminal, so nothing is lost and nothing is sent.

To resume:

1. Confirm the provider is healthy — a test send to an allowlisted mailbox, not a production audience.
2. Lift the stop **with a reason** (it is stored and shown in diagnostics).
3. Run one delivery batch and read `totals`:
   `POST /api/v1/MarketingAutomation/action/delivery/run-scheduled-batch` (administrator) or let
   `marketing.deliveryBatch` do it. `claimed`/`sent`/`retried` tell you the queue is moving; `paused: true`
   tells you the stop is still on.
4. Check `diagnostics.deadLetters`. A dead letter is a recipient whose attempts are spent — reconcile it with
   the provider before any manual re-send, because the last attempt may have been accepted.

**`unknown_submission` is the state that must never be blindly retried.** The connection died during
submission, so the provider may or may not have the message. Confirm with the provider (by message id or by the
recipient) and only then decide.

## 6. Stuck queue / stalled campaign

| Observation | Cause | Action |
| --- | --- | --- |
| `stuckSending > 0`, not falling | a worker died mid-claim | wait for `delivery.staleClaimMinutes` (default 15); the next sweep expires the claim and re-queues under the same idempotency key |
| `deliveryStates` shows many `Queued`, `sent` stays 0 | the worker is not running, or `REPORT_WORKER_SECRET` is empty | check the worker process and the capability; an unconfigured capability makes the job **inert**, not failed |
| every batch returns `paused: true` | the global stop is on | lift it deliberately (§5) |
| batches run but `claimed: 0` | sends are not `Queued`, or their `scheduledAt` is in the future | check the send's status and schedule; a send in `Scheduled` has not been queued yet |
| `failed` grows with `RATE_LIMITED` | `provider.limits` exceeds the vendor's quota | lower `ratePerMinute`/`maxConcurrency`, then resume |
| `failed` grows with `MESSAGE_INVALID` | our own validation refused the message | fix the template or sender; retrying cannot succeed |

## 7. Provider outage

1. Global stop with a reason naming the incident.
2. Do not cancel sends. Cancelling skips the remaining recipients and throws away the approved decision; the
   stop already prevents submissions, and the ledger keeps the work.
3. When the provider recovers: lift the stop, run one batch, read `totals`, then let the schedule take over.
4. If the outage outlasted the campaign window, decide explicitly whether to `complete` the campaign (it stops
   being sendable) or extend its `endsAt` — do not leave it silently past its window.

## 8. What this runbook deliberately does not cover

* **Automatic bounce/complaint threshold pausing** — not implemented; the decision is manual (§4).
* **Provider-side reconciliation APIs** — no adapter implements a status-reconcile call in this release, so
  `unknown_submission` is resolved by asking the provider out of band.
* **Editing suppression or consent rows to unblock a send** — there is no supported path, and inventing one by
  direct SQL defeats the one rule the module exists to keep.
