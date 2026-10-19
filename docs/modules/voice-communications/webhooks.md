# Voice & Communications — webhooks

> Phase 19-VC.5. Applies to every adapter that declares `webhook.signatureValidation`.

## 1. Endpoints

```
POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/voice-events
POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/message-events
POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/status-events
```

Unauthenticated by design: a provider cannot hold a CRM session. `accountKey` is a routing
identifier, **not** a secret; authentication is the provider's signature. The `{kind}` segment is
validated (`voice-events | message-events | status-events`) but the event's own `type` decides how it
is normalized.

## 2. Processing order (the security contract)

1. Resolve the configured account from `{providerKey}/{accountKey}`; a mismatched pair is `404`.
2. Reject a body larger than 256 KiB.
3. Reject a timestamp outside the configured replay window (`webhook.replayWindowSeconds`, default
   300 s, bounded 30–900). A refused callback is recorded with `failure_code = REPLAY_WINDOW`.
4. Ask the adapter to authenticate the callback. The ingress never implements a vendor signature.
5. Persist a receipt in `voice_webhook_events`, deduplicated by `(account_key, dedup_key)`.
6. Answer `202` immediately and enqueue `voiceCommunications.processWebhookEvent`.

A callback that fails signature validation is **recorded** (`signature_valid = false`,
`processing_status = 'rejected'`) and answered `401`. It is never enqueued.

## 3. Dedup key

`webhookDedupKey()`:

- `id:<providerEventId>` when the provider supplies an event id;
- otherwise `digest:<sha256(type|externalId|occurredAt)>`, so an identical resend without an id is
  still recorded once.

The unique index `uq_voice_webhook_events_dedup` is what enforces it, not the application.

## 4. Simulator payload and signature

```json
{
  "eventId": "evt-1",
  "type": "message.inbound",
  "occurredAt": "2026-01-01T00:00:00Z",
  "messageId": "SM1",
  "channel": "sms",
  "direction": "inbound",
  "from": "+14155550100",
  "to": "+14155550199",
  "body": "hello"
}
```

`type` is `call.status`, `call.inbound`, `message.inbound` or `message.status`.

Signature: `HMAC-SHA256(webhookSecret, timestamp + "." + stableStringify(body))`, hex, sent as
`x-webhook-signature` with `x-webhook-timestamp`. `stableStringify` sorts keys, because Fastify hands
the controller a parsed body. A provider that signs exact raw bytes must supply `rawBody` and its
adapter must use it — recorded as a limitation in
`docs/compatibility/voice-communications.md` §2.9.

## 5. Processing

`voiceCommunications.processWebhookEvent` is executed by the worker calling
`POST /api/v1/VoiceCommunications/action/webhook-events/process` with the shared
`x-worker-secret` capability (`REPORT_WORKER_SECRET`). An administrator may run the same endpoint for
one event.

The processor:

- normalizes the receipt through the adapter;
- inserts one `voice_communication_events` row (`unique (webhook_event_id)`);
- emits `voiceCommunications.*` through the platform outbox **only when the account is enabled**;
- marks the receipt `processed`;
- on failure increments `attempts` and keeps the receipt retryable; after 3 attempts it is a dead
  letter (`processing_status = 'failed'`).

## 6. Operations

| Task | Endpoint |
| --- | --- |
| List receipts (filter by status/account) | `GET action/webhook-events?status=&accountKey=&limit=&offset=` |
| Inspect one receipt (redacted payload) | `GET action/webhook-events/{id}` |
| Replay a failed receipt | `POST action/webhook-events/{id}/replay` |

Replay is refused for a receipt whose signature failed. Replay is safe because the normalized-event
unique constraint and the outbox are idempotent.

Payloads are stored **redacted**: keys matching `secret|token|password|signature|authorization|apiKey`
are removed recursively before persistence, and a SHA-256 digest is kept for comparison.
