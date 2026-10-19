# Voice & Communications — providers

> Phase 19-VC.4. This file is the single source for per-adapter status. A capability is never
> described as supported before its adapter and end-to-end behavior pass the relevant tests.

## 1. Adapters shipped

| Adapter | Key | Mode | Channels | Signature scheme |
| --- | --- | --- | --- | --- |
| Simulator | `fake` | `simulator` | voice, sms, whatsapp | HMAC-SHA256 over `timestamp + "." + canonical JSON` |
| Disabled | `none` | `disabled` | — | — |

The simulator is resolvable only when `NODE_ENV !== 'production'`. In production the key `fake`
resolves to `disabled`, so a mis-set account cannot pretend to work. No production adapter exists in
19-VC.0–19-VC.6.

## 2. Capability matrix

| Capability | `fake` | Production adapter |
| --- | --- | --- |
| `voice.outboundCall` | experimental | not-implemented |
| `voice.inboundEvents` | experimental | not-implemented |
| `voice.callStatusCallbacks` | experimental | not-implemented |
| `voice.recordingMetadata` | not-implemented | not-implemented |
| `voice.recordingDownload` | not-implemented | not-implemented |
| `messaging.sms.send` | experimental | not-implemented |
| `messaging.sms.receive` | experimental | not-implemented |
| `messaging.mms.send` | not-implemented | not-implemented |
| `messaging.mms.receive` | not-implemented | not-implemented |
| `messaging.whatsapp.send` | experimental | not-implemented |
| `messaging.whatsapp.receive` | experimental | not-implemented |
| `messaging.deliveryStatus` | experimental | not-implemented |
| `messaging.templates` | experimental | not-implemented |
| `messaging.media` | not-implemented | not-implemented |
| `webhook.signatureValidation` | supported | not-implemented |
| `provider.healthCheck` | supported | not-implemented |

`experimental` means the behavior is implemented and tested against the simulator, not against a
live vendor. `supported` is reserved for a verified implementation.

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
accepts `rawBody` and the ingress passes it through when present.

## 3.1 Simulator behaviour (19-VC.10–19-VC.11)

- `sandboxRecipients` (account config) is a **mandatory** allowlist. With no list, every call and
  message is refused with `invalid_recipient`; with a list, anything outside it is refused. A
  simulator that could reach a real phone would violate §15.4.
- `simulateOutage: true` makes sends and calls fail with `provider_unavailable`, which is how the
  retry/uncertain-outcome paths are exercised.
- A send returns `sent` — never `delivered`. Delivery is only ever asserted from a callback.
- Calls and messages get a deterministic provider id derived from the idempotency key, so a repeated
  dispatch resolves to the same provider object.

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
  "config": { "messagingServiceSid": "MG…" },
  "credential": "AC…",
  "webhookSecret": "…"
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
