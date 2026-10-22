---
title: Configuring Voice and messaging
summary: How the voiceCommunications document is read and written, what each switch and policy field does, and what a live deployment needs beyond this build.
audience: admin
order: 135
tags: [voice, sms, whatsapp, telephony, settings]
related: [admin/module-settings, user/chat-and-voice, admin/integrations, admin/files-and-storage]
updated: 2026-10-22
---

Voice Communications keeps one validated document named `voiceCommunications`. It decides which
channels send, which account a call or message uses, consent and quiet hours, callbacks, recordings
and transcripts. [CRM Chat and the voice inbox](user/chat-and-voice) shows the user's side.

## Where the document lives

The document is one row in the platform settings store (`app_settings`, name `voiceCommunications`).
A fresh instance has no row: the service answers with defaults and version 0 until the first write.
[Module settings](admin/module-settings) lists it beside the other module documents.

[Voice](/voice-communications) is a diagnostics screen: it reads the health report and displays the
document's warnings, but it has no editor. Provider accounts are separate rows.

## Reading and writing the document

```text
{module} = /api/v1/VoiceCommunications
GET  {module}/action/settings
POST {module}/action/settings
{"features":{"sms":true},"provider":{"defaultAccountKey":"main"}}
```

The write requires an administrator; the read is available to a signed-in caller. The response is the
whole view: `settings`, `version`, `updatedAt`, `updatedBy`, `defaults` and `warnings`.

A write is a partial document. The service deep-merges it, validates the merged result against a strict
schema, and refuses the whole write when a value is wrong or a key is unknown, leaving the stored
version untouched. An accepted write increments `version` and records who wrote it. A stored row that
no longer satisfies the schema falls back to defaults.

`GET {module}/action/health` and `GET {module}/action/providers` are administrator-only and report
the warnings, the resolvable adapters and their modes.

## What starts on

Every feature starts off. A fresh instance records configuration and sends nothing.

| Feature | Default | What it exposes |
| --- | --- | --- |
| `features.voice` | off | Outbound calls, call sessions and the incoming-call notice |
| `features.sms` | off | SMS sends through the channel policy |
| `features.mms` | off | MMS sends; the shipped simulator declares no MMS capability |
| `features.whatsapp` | off | WhatsApp sends, including the service-window and template rules |
| `features.recordings` | off | Ingest of recording callbacks |
| `features.transcripts` | off | Transcript retrieval for a call |
| `features.aiEnrichment` | off | Draft summaries, topics, actions and suggested replies |

An outbound operation whose channel flag is off is refused with `channel_disabled`. Consent is required
per message channel out of the box; quiet hours are off.

> [!NOTE]
> The warning list still reports voice, SMS, MMS and WhatsApp as arriving in a later phase. That text
> is stale in this build: the call, messaging and webhook services are present and the flags above gate them.

The health report publishes each feature's `requires` list (`mms` → `sms`, `recordings` → `voice`,
`transcripts` → `recordings`), but the settings write does not enforce those chains. Each service checks
the flag it reads; an unmet prerequisite is shown, not refused.

## Provider

| Field | Default | Accepted | What reads it |
| --- | --- | --- | --- |
| `provider.defaultAccountKey` | empty | Up to 64 characters | Calls and messages that name no account |

An empty default means every call or message must name an account explicitly; a send with neither is
refused. The document accepts any string and does not check that the account exists, so a typo saves
cleanly and later fails as `account_missing`.

A provider account is created and enabled through the module's account endpoints, not this document.
Policy evaluates in order: the channel flag, a resolving account, the account being enabled and not
unhealthy, the adapter's channel capability, consent, suppression, quiet hours, WhatsApp's window, then length.

## Policy

| Field | Default | Accepted | What the policy does |
| --- | --- | --- | --- |
| `policy.defaultRegion` | `US` | Two letters, stored uppercase | Applied to a national phone number before lookup or send |
| `policy.requireConsent.sms` | true | boolean | Requires a granted consent for the purpose |
| `policy.requireConsent.mms` | true | boolean | Requires a granted consent for the purpose |
| `policy.requireConsent.whatsapp` | true | boolean | Requires a granted consent for the purpose |
| `policy.quietHours.enabled` | false | boolean | Blocks an outbound operation inside the window |
| `policy.quietHours.start` | `21:00` | `HH:MM` | Window start |
| `policy.quietHours.end` | `08:00` | `HH:MM` | Window end; an overnight window wraps midnight |
| `policy.quietHours.timezone` | `UTC` | Up to 64 characters | The clock the window is read in |
| `policy.whatsappWindowHours` | 24 | 1 to 168 | Outside the window a free-form message needs an approved template |
| `policy.maxMessageLength` | 1,600 | 1 to 10,000 | Refuses a longer body and drives the composer warning |
| `policy.maxSendsPerMinute` | 0 | 0 to 100,000 | Stored and returned; no code in this build reads it |

Calls never require consent; quiet hours apply to them too. Equal start and end is an empty window; a
blank time zone warns and uses UTC; an unknown identifier leaves the window unevaluable.

## Webhook

| Field | Default | Accepted | What it does |
| --- | --- | --- | --- |
| `webhook.replayWindowSeconds` | 300 | 30 to 900 | Refuses a callback whose timestamp is further away than this |

Callbacks arrive as `POST` on the `integrations/voice-communications` route under `/api/v1`, then
`{providerKey}/{accountKey}/{kind}`; `kind` is `voice-events`, `message-events`, `status-events` or
`media-events`. The route is unauthenticated; the account's encrypted webhook secret authenticates it.

## Media

| Field | Default | Accepted | What it does |
| --- | --- | --- | --- |
| `media.fetchMode` | `off` | `off` or `privateStorage` | `off` keeps the provider reference only; `privateStorage` fetches the bytes |
| `media.allowedHosts` | empty | Up to 32 hostnames | Restricts the hosts a recording may be fetched from |
| `media.allowLoopback` | false | boolean | Non-production escape hatch for the SSRF check |
| `media.maxBytes` | 26,214,400 | 1,024 to 104,857,600 | Refuses a larger download |
| `media.retentionDays` | 90 | 1 to 3,650 | Sets the recording's retention date |
| `media.noticeRequired` | false | boolean | Stored and returned; no code in this build reads it |

Recordings are ingested only when `features.recordings` is on, and playback returns stored bytes, so a
recording must have been fetched while `fetchMode` was `privateStorage`. The schema says an empty
allowlist refuses every fetch, but the validator skips an empty list: fill it in production.

## AI

| Field | Default | Accepted | What it does |
| --- | --- | --- | --- |
| `ai.connectionKey` | empty | Up to 64 characters | Names the AI gateway connection |
| `ai.model` | empty | Up to 128 characters | Names the model |
| `ai.maxTranscriptChars` | 20,000 | 500 to 200,000 | Caps the redacted transcript sent to the model |

Enrichment needs both keys, `features.transcripts` and `features.aiEnrichment`. The transcript is
redacted before truncation, and the module calls the platform's AI gateway. The result stays a draft.

## What a live deployment needs

- A registered live adapter. This build ships a simulator (`fake`, outside production only) and a
  disabled adapter (`none`); unknown keys resolve to disabled. `VoiceProviderRegistry.register` adds live.
- A provider account with the adapter's credential, enabled. Enabling a live account requires the
  credential; an adapter that validates webhooks also requires the account's webhook secret.
- `ENCRYPTION_KEY` for the credential and webhook secret, and a public URL for the webhook route.
- `REPORT_WORKER_SECRET` for the worker doors on webhook processing, media fetch and retention.
- `STORAGE_DRIVER` and its settings (or `STORAGE_ROOT`) when recordings use private storage. See
  [Files and storage](admin/files-and-storage).

## Troubleshooting

| Symptom | Field or prerequisite |
| --- | --- |
| A call or send is refused with `channel_disabled` | The matching feature flag is off |
| Refused with `account_missing` | No default account and none named, or a key that does not resolve |
| Refused with `account_disabled` or `account_unhealthy` | Enable the account, or run its health check |
| Refused with `capability_missing` | The adapter does not declare the channel; the shipped simulator has no MMS |
| Refused with `consent_required` | The channel requires consent and no granted record exists for the purpose |
| Refused with `suppressed` | The address is on the suppression list |
| Refused with `quiet_hours` | The quiet-hours window is active in its time zone |
| Refused with `template_required` | The WhatsApp window is closed and no approved template was named |
| Webhook returns 401 | The account is disabled, or the signature or webhook secret is wrong |
| A recording cannot be played | It was never fetched: `fetchMode` is `off`, or the download failed |
| Enrich refuses to run | Transcripts or AI enrichment is off, or `ai.connectionKey` / `ai.model` is empty |
| A settings warning says a channel is pending | The stale pending-feature text; check the channel flag and account capabilities |

## Where to go next

- [The voice inbox](user/chat-and-voice) — the surfaces these switches enable.
- [Integrations](admin/integrations) — credentials and connections the platform already stores.
- [Module settings](admin/module-settings) — the document map and what each module starts with.
