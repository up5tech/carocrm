# Voice & Communications — providers

> Phase 19-VC.4, extended through 19-VC.16. This file is the single source for per-adapter status. A capability is never
> described as supported before its adapter and end-to-end behavior pass the relevant tests.

## 1. Adapters shipped

| Adapter | Key | Mode | Channels | Signature scheme |
| --- | --- | --- | --- | --- |
| Simulator | `fake` | `simulator` | voice, sms, whatsapp | HMAC-SHA256 over `timestamp + "." + canonical JSON` |
| Twilio | `twilio` | `live` | voice, sms, whatsapp | Twilio `X-Twilio-Signature`: HMAC-SHA1 over the callback URL plus sorted form fields |
| Asterisk | `asterisk` | `live` | voice | HMAC-SHA256 over `timestamp + "." + canonical JSON`, emitted by the ARI event bridge |
| Disabled | `none` | `disabled` | — | — |

The simulator is resolvable only when `NODE_ENV !== 'production'`. In production the key `fake`
resolves to `disabled`, so a mis-set account cannot pretend to work. The two live adapters are
registered by `VoiceProviderBindingService` at module init; there is no runtime plugin loading.

The Twilio and Asterisk rows are **experimental** until they have been exercised against a real
account with the documented webhooks. Their unit tests use an injected `fetch`, so no test in this
repository sends a message or places a call.

## 2. Capability matrix

| Capability | `fake` | `twilio` | `asterisk` |
| --- | --- | --- | --- |
| `voice.outboundCall` | experimental | experimental | experimental |
| `voice.inboundEvents` | experimental | experimental | experimental |
| `voice.callStatusCallbacks` | experimental | experimental | experimental |
| `voice.callAnswer` | experimental | not-implemented | experimental |
| `voice.callHangup` | experimental | experimental | experimental |
| `voice.recordingMetadata` | experimental | not-implemented | not-implemented |
| `voice.recordingDownload` | experimental | not-implemented | not-implemented |
| `messaging.sms.send` | experimental | experimental | not-implemented |
| `messaging.sms.receive` | experimental | experimental | not-implemented |
| `messaging.mms.send` | not-implemented | not-implemented | not-implemented |
| `messaging.mms.receive` | not-implemented | not-implemented | not-implemented |
| `messaging.whatsapp.send` | experimental | experimental | not-implemented |
| `messaging.whatsapp.receive` | experimental | experimental | not-implemented |
| `messaging.deliveryStatus` | experimental | experimental | not-implemented |
| `messaging.templates` | experimental | experimental | not-implemented |
| `messaging.media` | not-implemented | not-implemented | not-implemented |
| `voice.transcript` | experimental | not-implemented | not-implemented |
| `webhook.signatureValidation` | supported | experimental | experimental |
| `provider.healthCheck` | supported | experimental | experimental |

`experimental` means the behavior is implemented and tested at the adapter boundary, not verified
against a live vendor. `supported` is reserved for an implementation that has been exercised against
the real service. The Twilio adapter deliberately does not declare `voice.callAnswer`: Twilio answers
an inbound call in its TwiML handler, not through an agent-side REST call. Neither live adapter
declares recording download; see §3.4.

## 3. Adding a production adapter

1. Implement `VoiceProviderAdapter` (`voice-provider.ts`): `info` with only the capabilities actually
   implemented, `validateWebhook`, `normalizeEvent`, `healthCheck`.
2. Register it in a binding service at module init (the `MarketingProviderBindingService` precedent),
   never in a constructor side effect.
3. Pin the provider API version in this file and add adapter contract tests: valid/invalid signature,
   unknown fields, duplicate and out-of-order callbacks, rate-limit classification, credential
   masking, timeout/uncertain outcome.
4. Only then change its row in the matrix.

Adapters that sign exact raw bytes need a raw-body capture in the Fastify bootstrap; the contract
accepts `rawBody` and the ingress passes it through when present. Twilio signs form parameters, not
raw bytes, so its adapter does not depend on that capture; the controller reconstructs the absolute
callback URL for it.

## 3.1 Simulator behaviour (19-VC.10–19-VC.11)

- `sandboxRecipients` (account config) is a **mandatory** allowlist. With no list, every call and
  message is refused with `invalid_recipient`; with a list, anything outside it is refused. A
  simulator that could reach a real phone would violate §15.4.
- `simulateOutage: true` makes sends and calls fail with `provider_unavailable`, which is how the
  retry/uncertain-outcome paths are exercised.
- A send returns `sent` — never `delivered`. Delivery is only ever asserted from a callback.
- Calls and messages get a deterministic provider id derived from the idempotency key, so a repeated
  dispatch resolves to the same provider object.

## 3.2 Recording and transcript contracts (19-VC.15–19-VC.16)

- A recording arrives as a `call.recording` callback; the adapter normalizes it to
  `{ providerCallId, providerRef, url, durationSeconds, mimeType }`. No adapter downloads media itself:
  the module validates and fetches, so the SSRF and MIME rules cannot be bypassed by an adapter.
- `fetchTranscript({ account, providerRef })` is **optional**. When absent, the module reports
  "this provider does not offer transcript retrieval" instead of fabricating one. The simulator
  returns three canned segments, so the transcription path is testable without a speech vendor.
- Neither contract can send anything: they only read. AI enrichment goes through the platform's
  AI gateway, never through a telephony adapter.

## 3.3 Twilio adapter

Pinned API: Twilio REST `2010-04-01`. The adapter is one registry entry for all three Twilio
channels; the account's granted capabilities decide what it may do.

```json
{
  "key": "twilio_main",
  "providerKey": "twilio",
  "label": "Twilio production",
  "environment": "production",
  "enabled": false,
  "capabilities": [
    "voice.outboundCall", "voice.inboundEvents", "voice.callStatusCallbacks", "voice.callHangup",
    "messaging.sms.send", "messaging.sms.receive", "messaging.whatsapp.send",
    "messaging.whatsapp.receive", "messaging.deliveryStatus", "messaging.templates",
    "webhook.signatureValidation", "provider.healthCheck"
  ],
  "config": {
    "accountSid": "AC…",
    "messagingServiceSid": "MG…",
    "defaultFrom": "+14155550100",
    "twimlUrl": "https://crm.example.com/twiml",
    "webhookBaseUrl": "https://crm.example.com",
    "webhookUrl": "https://crm.example.com/api/v1/integrations/voice-communications/twilio/twilio_main/voice-events",
    "templateContentSids": { "order_update": "HX…" }
  },
  "credential": "Twilio Account Auth Token",
  "webhookSecret": "The same Account Auth Token"
}
```

- **Sender selection.** A voice call uses the account's active voice endpoint. A message uses the
  active endpoint for its channel, then `defaultFrom`, then `messagingServiceSid`. Registering the
  sender as an endpoint is preferred because the inbound `To` can then route the call to the right
  team.
- **Calls** need exactly one of `twimlUrl` or static `twiml`; without one Twilio has no instruction
  after the call connects. `record: true` asks Twilio to record and points its recording callback at
  `media-events`. `timeoutSeconds` is bounded to 600.
- **Status callbacks** are only emitted when `webhookBaseUrl` is set. The adapter uses
  `…/twilio/{accountKey}/status-events` for message and call status, and `…/media-events` for
  recording callbacks. Inbound Twilio webhooks must be configured in the Twilio console to the same
  `…/{accountKey}/voice-events` and `…/{accountKey}/message-events` paths.
- **Signature validation** uses `X-Twilio-Signature` over the absolute callback URL and the sorted
  form parameters. Callback kinds use different paths (`voice-events`, `message-events`,
  `status-events`, `media-events`), so the adapter accepts a signature computed over either the URL
  reconstructed from `Host`/`X-Forwarded-*` or the account's `webhookUrl`. Set `webhookUrl` when a
  proxy rewrites the public URL; it is an additional candidate, not an override, so one configured
  URL cannot make every callback kind unverifiable. Twilio sends form-encoded bodies, which Nest's
  URL encoded parser handles; no raw-body capture is needed for this scheme.
- **Hang-up** uses `Status=canceled` for a call that is still queued, initiated or ringing and
  `Status=completed` for an answered call, because Twilio's Calls resource rejects `completed` on a
  call that never connected. The adapter reports the matching `cancelled` or `completed` state.
- **WhatsApp templates** are local records whose `templateKey` must map to a Twilio ContentSid via
  `templateContentSids`, or itself be a ContentSid (`HX…`). The module's approval/variable/window
  policy still runs before the adapter; the adapter only maps the key and supplies
  `ContentSid`/`ContentVariables`.
- **Not implemented:** agent-side answer (use the TwiML handler), MMS/media sends (the module stores
  attachment ids, not public URLs), inbound MMS attachment persistence, and recording playback. A
  `RecordingUrl` still arrives in the callback for diagnostics, but Twilio requires account
  authentication to download it, which the media service does not hold.

## 3.4 Asterisk adapter

Asterisk is a PBX, so the adapter has two halves: ARI for outbound control and a small deployment-side
bridge for inbound events. The bridge is intentionally not a long-lived WebSocket inside the API.

```json
{
  "key": "asterisk_main",
  "providerKey": "asterisk",
  "label": "Asterisk PBX",
  "environment": "production",
  "enabled": false,
  "capabilities": [
    "voice.outboundCall", "voice.inboundEvents", "voice.callStatusCallbacks",
    "voice.callAnswer", "voice.callHangup", "webhook.signatureValidation", "provider.healthCheck"
  ],
  "config": {
    "ariUrl": "https://pbx.example.com:8089/ari",
    "ariUsername": "carocrm",
    "ariApp": "carocrm",
    "endpointTemplate": "PJSIP/{to}",
    "callerId": "+14155550100",
    "timeoutSeconds": 30,
    "allowInsecureHttp": false
  },
  "credential": "ARI password",
  "webhookSecret": "Bridge signing secret"
}
```

- **ARI** uses HTTP Basic authentication with `ariUsername` + the encrypted credential. The adapter
  calls `POST /ari/channels` to originate, `POST /ari/channels/{id}/answer` to answer and
  `DELETE /ari/channels/{id}` to hang up; `GET /ari/asterisk/info` is the health check. `ariApp` must
  name the Stasis application the bridge listens on. `endpointTemplate` must contain `{to}`.
- **Bridge contract.** Post an event to
  `/api/v1/integrations/voice-communications/asterisk/{accountKey}/voice-events` with
  `X-Voice-Timestamp` and `X-Voice-Signature`, where the signature is
  `HMAC-SHA256(webhookSecret, timestamp + "." + canonicalJson(body))`. A canonical bridge event is:

```json
{
  "eventId": "ari-…",
  "type": "call.status",
  "occurredAt": "2026-10-22T10:00:00.000Z",
  "callId": "1729…",
  "status": "ringing",
  "direction": "inbound",
  "from": "+14155550100",
  "to": "+14155550199",
  "durationSeconds": 42
}
```

  The bridge may also forward a raw ARI event (`type: "ChannelStateChange"`, `channel.id`,
  `channel.state`, `cause`) with the same headers; the adapter maps `StasisStart`, `StasisEnd`,
  `ChannelStateChange`, `ChannelDestroyed` and `Dial`, including Asterisk hangup causes. Causes
  18/19/20 (no response, no answer, subscriber absent) become `no_answer`, 21 (rejected) becomes
  `cancelled`, 16/31 (normal clearing) become `completed`, and 0 is `unknown`. A `timestamp` field is
  accepted when `occurredAt` is absent. An outbound event must carry `direction: "outbound"`, because
  ARI does not state it reliably.
- **Not implemented:** message channels (Asterisk is voice-only here), recording download, and
  conferencing/transfer/hold. A recording URL in a bridge event is normalized for diagnostics but
  is not advertised as a recording capability.

## 4. Account configuration

`POST /api/v1/VoiceCommunications/action/accounts`

```json
{
  "key": "twilio_main",
  "providerKey": "twilio",
  "label": "Twilio production",
  "environment": "production",
  "enabled": false,
  "capabilities": ["messaging.sms.send", "webhook.signatureValidation"],
  "config": {
    "accountSid": "AC…",
    "messagingServiceSid": "MG…",
    "webhookBaseUrl": "https://crm.example.com"
  },
  "credential": "Twilio Account Auth Token",
  "webhookSecret": "The same Auth Token"
}
```

Rules enforced server-side:

- `providerKey` must resolve to a registered, non-disabled adapter.
- `capabilities` must be a subset of what the adapter declares.
- `config` may not contain credential-like keys (`secret`, `token`, `password`, `apiKey`, …); those
  belong in the encrypted `credential`/`webhookSecret` fields.
- Enabling a `live` account requires a credential; enabling an account whose adapter validates
  signatures requires a webhook secret, because callbacks would otherwise be rejected.
- A credential or webhook secret is **never** returned. Reads report `hasCredential` /
  `hasWebhookSecret` and a masked hint (`••••1234`).

Secrets are encrypted with `ENCRYPTION_KEY` (AES-256-GCM, `@carocrm/core`). With no key configured,
saving a secret fails with a clear message instead of writing plaintext.

## 5. Health checks

`POST /api/v1/VoiceCommunications/action/accounts/{key}/health` runs the adapter's check and persists
`last_health_status/detail/at`. The policy service refuses an account whose last check is `unhealthy`
(`account_unhealthy`). The check is never run automatically on boot: an installation with no network
must still start.
