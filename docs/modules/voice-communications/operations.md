# Voice & Communications — operations

> Phase 19-VC.2–19-VC.6. Health, queue recovery, credential rotation and incidents for the delivered
> scope. Later sub-phases extend this file.

## 1. Health

`GET /api/v1/VoiceCommunications/action/health` (administrator) reports:

- module identity and implemented phases;
- every required platform dependency with the evidence it was checked against (`entity`, `table`,
  `column`, `hookPhase`) — never a hard-coded `true`;
- optional integrations detected by their metadata/table marker;
- feature flags and their settings paths;
- adapters, account counts and the configured default account;
- settings version and warnings;
- named checks: `schema`, `idempotency-indexes`, `secret-encryption`, `settings-row`,
  `provider-accounts`, `write-guard`, `admin-surface`.

A deployment with no provider account is healthy for configuration and ingestion; it refuses every
send/call and says so.

## 2. Common failure states

| Symptom | Cause | Action |
| --- | --- | --- |
| Every callback is `401`, receipt `failure_code = INVALID_SIGNATURE` | Wrong webhook secret | Rotate the account's webhook secret and update the provider |
| Every callback is `401`, `REPLAY_WINDOW` | Clock skew > 5 min | Fix NTP; the window is configurable 30–900 s |
| Receipts stay `received` | Worker not running | Run `voiceCommunications.processWebhookEvent` or press process for one event |
| Receipts `failed` after 3 attempts | Processing defect or missing account | Inspect `failure_detail`, fix, then replay |
| `enqueue_failed` | Queue unavailable | The receipt is durable; replay once the queue is back |
| Account cannot be enabled | Missing credential or webhook secret | Provide it; the API refuses with the exact requirement |
| Secret cannot be saved | `ENCRYPTION_KEY` unset | Configure the platform key; never store plaintext |
| Every simulator send fails `invalid_recipient` | No `sandboxRecipients`, or the destination is not listed | Add the test number to the account config |
| A WhatsApp send is refused `template_required` | Window closed and no approved template | Record the template and its approval, then send with its key and variables |
| A WhatsApp send is refused `payload_invalid` | Template variables missing | Supply every `{{n}}` placeholder |
| A call is `failed` with `invalid_recipient` | Destination outside the simulator allowlist | Expected in tests; a live adapter uses the provider's own rejection |
| A message stays `sent` | No delivery callback arrived | That is correct: delivery is never inferred |

## 3. Credential rotation

`PATCH /api/v1/VoiceCommunications/action/accounts/{key}` with `{ "credential": "new…" }` or
`{ "webhookSecret": "new…" }`. The new value is encrypted immediately; the old one is overwritten.
No read endpoint ever returns either value. Rotate the provider side first or last, but expect
callbacks to fail closed until both sides agree.

## 4. Disabling a provider

`POST action/accounts/{key}/enabled` with `{ "enabled": false }`.

- New sends/calls are refused (`account_disabled`).
- Inbound callbacks are still recorded and marked processed, but emit **no** domain event, so no
  downstream action runs.
- Re-enabling requires the credential/webhook secret to still be present.

## 5. Queue and replay

The durable record is `voice_webhook_events`; Redis only carries the job. A restarted worker loses
nothing: the receipt remains `received` until processed. Replay is idempotent because
`voice_communication_events.webhook_event_id` is unique and the outbox insert is one per event.

## 6. Logging

Application logs may contain receipt ids, account keys, provider keys, normalized event types and
error categories. They must never contain credentials, webhook secrets, message bodies or full
signed payloads. The receipt's `payload_redacted` column is the troubleshooting surface, and it is
redacted at write time.
