# Omnichannel — operations runbook

> Phase 19-OM.21 (`PLAN_Phase_19_Omnichannel.md` §14). This runbook covers the failure modes an
> administrator can see and recover from **through the product**, without database access. Every
> figure and action below reads or commands the owners' existing records — provider accounts,
> `voice_webhook_events`, `voice_messages` state — never a parallel operational store.

## 1. Where the diagnostics live

| Surface | Endpoint | Capability |
| --- | --- | --- |
| Overview (accounts, backlog, failures) | `GET /api/v1/Omnichannel/action/operations?days=1..90` | `opsRead` |
| Connection health probe | `POST /api/v1/Omnichannel/action/operations/accounts/{key}/test` | `connectionManage` |
| Receipt list | `GET /api/v1/Omnichannel/action/operations/events?status=&limit=` | `opsRead` |
| Receipt inspection | `GET /api/v1/Omnichannel/action/operations/events/{id}` | `opsRead` |
| Authorized replay | `POST /api/v1/Omnichannel/action/operations/events/{id}/replay` | `opsReplay` |
| Reconcile an unknown send | `POST /api/v1/Omnichannel/action/messages/{id}/reconcile` | `opsReplay` |
| Connection kill switch | `POST /api/v1/Omnichannel/action/operations/accounts/{key}/enabled` | `settingsManage` |

The SPA exposes the first six on **Omnichannel → Operations**; the kill switch is the state switch in
the connections table. Capabilities are the synthetic ACL resources `OmnichannelOps`
(read/replay) and `OmnichannelConnection` (manage); hiding a control is never the enforcement.

### What is never exposed

- Credential and webhook-secret presence are returned as **booleans**. No value, prefix, length or
  hint of a secret leaves the API.
- Inspection returns the **redacted payload the ingress stored** (`redactPayload`). Raw headers,
  signature material and message bodies are not stored to begin with.
- No endpoint accepts a provider URL override. Endpoints come from the account configuration, which
  was validated on write (`assertHttpUrl`: absolute URL, no embedded credentials, https unless a
  self-hosted account explicitly opted into http, no link-local/metadata hosts). The operations
  surface therefore adds no SSRF path.

## 2. Provider outage or unreachable endpoint

**Symptoms** — `health.status` not `ok`; outbound sends failing with `provider_unavailable` or
`timeout`; receipts accumulating with `processing_status = received` and no application updates.

1. Open **Operations** and press **Test connection** for the account. The probe uses the stored
   credential; a failed probe is about reachability or the credential, not about CRM data.
2. If the probe reports an HTTP rejection, read the failure code on the account's health line and
   the `failures` list in the overview.
3. Outbound traffic that timed out is **not** retried automatically with an unknown outcome — see
   §6. Inbound callbacks that arrived are durable receipts; replay them after the outage (§5).

## 3. Expired or revoked token / credential

**Symptoms** — probe or sends reject with HTTP 401/403; the account health detail names an auth
category.

1. Rotate the credential in the connection's settings (admin surface). The secret is write-only; the
   stored value is replaced and the presence flag stays `true`.
2. Press **Test connection** to confirm. The owner persists the result on the account row.
3. There is no "reveal credential" step in the product. A lost credential is rotated, not recovered.

## 4. Signature / certificate failures

**Symptoms** — receipts with `signature_valid = false`, status `rejected`, failure code
`INVALID_SIGNATURE`; the provider reports non-2xx deliveries. A rejected callback is **recorded**, not
silently dropped, so this is visible in the backlog.

1. Compare the account's webhook URL with what the provider is signing. The full URL is what the
   signature covers; a proxy that rewrites host or scheme breaks it. Pin the exact URL in the
   account's `webhookUrl` when the deployment is behind a proxy.
2. Compare the webhook secret. A rotated provider secret must be updated on the account first.
3. Check the callback timestamp. A timestamp outside the configured replay window is rejected with
   `REPLAY_WINDOW` — usually clock skew on the provider or on the host.
4. A `rejected` receipt **cannot be replayed**: replay refuses it instead of running unauthenticated
   input. Fix the configuration and let the provider redeliver, or ask the provider to resend.

## 5. Replay and duplicate events

**Symptoms** — a receipt stuck in `enqueue_failed`, `failed`, or `received` after a worker incident.

1. Inspect the receipt first; the redacted payload shows what was authenticated.
2. Press **Replay**. The API answers with the effects:
   - idempotent — one normalized communication event per receipt (receipt unique index), one message
     per provider message id (message idempotency index). Replaying twice does not create a second
     message or a second event.
   - refused — a callback that failed signature validation cannot be replayed.
3. If the answer is "recorded but not queued", the job enqueue failed; retry replay once the job
   infrastructure is healthy. The receipt is never lost by a failed enqueue.
4. Duplicate provider callbacks are expected and harmless: the second one is answered with
   `duplicate: true` and no second job. Never delete the duplicate receipt; it is the dedup record.

## 6. Unknown send outcome (timeout)

**Symptoms** — a outbound message in state `unknown`; the composer said the outcome is uncertain.

1. **Do not resend the same text.** A timed-out send may have been delivered.
2. Call **Reconcile** on the message (`POST action/messages/{id}/reconcile`). This asks the provider
   for the message's status; it never repeats the send.
3. If the provider confirms delivery, the message state becomes delivered and the thread continues.
   If the provider confirms failure, the message can be sent again deliberately.
4. `awaitingConfirmation` in the connections table counts outbound messages still in
   `queued | submitted | unknown` — after a provider outage this number is the operator's TODO list.

## 7. Rate limits and throttling

**Symptoms** — failures with a rate-limit category; sends succeeding later without intervention.

- Provider rate limits are reported as retryable. Sends are not retried automatically after an
  **unknown** outcome; policy refusals (`window_closed`, `template_required`, `quiet_hours`) are
  answers, not incidents.
- If a limit persists, reduce concurrent agent activity or switch the account to a provider plan
  that matches volume. Do not loop retries — the policy pipeline already refuses before the provider
  is called.
- Web-chat rate limiting is per visitor session and returns HTTP 429; it is not an account-level
  event and does not appear in the receipt backlog.

## 8. Stuck jobs

**Symptoms** — receipts `received` for longer than a worker cycle, or `enqueue_failed`.

1. Check the platform jobs admin (`/admin/jobs`) for the `voice.processWebhook` job family. A failed
   job carries its safe diagnostic context there.
2. Once the worker is healthy, replay the receipt from **Operations**. The dedup indexes make this
   safe even if the earlier attempt partially ran.
3. A receipt whose signature failed is not a job problem; see §4.

## 9. Channel-policy changes

**Symptoms** — sends suddenly refused with `window_closed`, `template_required`, `consent_required`,
`quiet_hours` or `suppressed`; no provider request was made.

These are policy answers, not failures. The composer shows the named code. Review:
- the channel capability catalog (Omnichannel → Diagnostics → Channel capabilities) for what the
  transport declares;
- the module settings for quiet hours, window and retention;
- the contact's consent state and suppression list.

Changing policy does not rewrite history; earlier messages keep their recorded outcomes.

## 10. Kill switch — disabling a compromised connection

Disabling an account is a **traffic** control, not a deletion:

| Direction | Effect while disabled |
| --- | --- |
| Outbound | New sends are refused by policy with `account_disabled`. Nothing already queued is deleted. |
| Inbound | Callbacks are still received and stored as receipts, but are not applied to conversations while disabled. |
| History | Conversations, messages and receipts are unchanged. |
| In-flight | Sends already submitted to the provider keep their state; the response reports how many are still awaiting confirmation. |

Recovery: fix the cause (rotate the credential, correct the endpoint or secret), press **Test
connection**, then re-enable. Replay the receipts that accumulated while disabled if their events
are still wanted.

## 11. Escalation checklist

When a symptom does not match the above, collect before escalating:

1. The account key and provider key (never the credential).
2. The receipt id and its failure code from **Operations**.
3. The health line's `checkedAt` and detail.
4. The message id and state for any send involved.

Do not paste secrets, raw provider payloads or customer message bodies into a ticket. The redacted
payload and the failure code are enough to reproduce the path.
