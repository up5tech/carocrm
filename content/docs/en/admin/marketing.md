---
title: Configuring Marketing
summary: How the marketingAutomation document is read and written, what each flag and limit does, and what a campaign needs before it can start.
audience: admin
order: 134
tags: [marketing, campaigns, consent, settings, email]
aliases: ["cấu hình marketing", "kênh gửi chiến dịch", "danh sách mục tiêu"]
related: [admin/module-settings, admin/settings-overview, admin/email-and-notifications, user/marketing]
updated: 2026-10-22
---

Marketing Automation keeps one validated document named `marketingAutomation`. It decides whether
campaigns can be edited, which optional capabilities open, how a send is chunked and retried, and which
provider a message leaves through. [Campaigns and audiences](user/marketing) covers the user's half.

## Where the document lives

The document is one row in the platform settings store (`app_settings`, name `marketingAutomation`),
written only by the module's own service. A fresh instance has no row: the service answers with defaults
and version 0 until the first write. [Module settings](admin/module-settings) lists it beside the other
module documents.

There is no Settings tab or form in this build; the module endpoint is the only writer.

## Reading and writing the document

Throughout this page `{module}` stands for `/api/v1/MarketingAutomation`.

```text
GET  {module}/action/settings
POST {module}/action/settings
{"features":{"audience":true},"provider":{"key":"platform-mail"}}
```

The read is available to a signed-in caller; the write requires an administrator. The response is the
whole view: `settings`, `version`, `updatedAt`, `updatedBy`, `defaults` and `warnings`.

A write is a partial document, not a replacement. The service deep-merges it into the current document,
validates the merged result against a strict schema, and refuses the whole write when a value is wrong
or a key is unknown. The stored version is untouched by a refusal. An accepted write increments
`version`, records who wrote it and returns the same view. A stored row that no longer satisfies the
schema falls back to defaults rather than blocking boot.

Two named operations sit beside the document. Pausing every marketing send:

```text
POST {module}/action/globalSendPause
{"paused":true,"reason":"Provider incident"}
```

The pause is administrator-only. A pause may carry a `reason`, which is stored and reported by the
health endpoint; resuming must omit it. `safety.reason` is audit text, not a gate.
`GET {module}/action/health` (administrator-only) reports the provider the document
names, its mode, and the same warnings the settings view returns.

## What starts on

| Feature | Default | What it exposes |
| --- | --- | --- |
| `features.campaigns` | on | Campaign create and edit, lifecycle commands, send definitions and test sends |
| `features.audience` | off | Target-list and audience-snapshot writes through the record API |
| `features.templates` | off | Content preview, revision sealing and template-revision rows |

Turning `campaigns` off refuses campaign writes, lifecycle commands and test sends, and stops delivery
batches, while existing campaigns stay readable. Consent and suppression records have no feature mapping:
campaigns being off does not block them, and their own ACL applies. Turning `audience` off refuses
saving a target list but leaves existing lists readable. Turning `templates` off refuses preview and
sealing.

> [!NOTE]
> The feature descriptors say audience and templates require campaigns, but each write path checks only
> the flag it names. With campaigns off and audience on, an audience write is still accepted.

## Defaults and sender

| Field | Default | Accepted | What reads it |
| --- | --- | --- | --- |
| `defaults.timezone` | `UTC` | Up to 64 characters, a time zone this runtime recognises | Applied when a campaign is scheduled with an empty timezone |
| `sender.defaultEmailAccountId` | `null` | An `email_accounts.id`, up to 64 characters | The fallback sending account for a campaign that names none |

There is no default purpose. Every campaign chooses one deliberately because consent is gated by
purpose, and the `ServiceNotice` purpose needs an explicit acknowledgement. With no default sender, a
sending campaign that names no account is blocked with `SENDER_REQUIRED`; with a default set, such a
campaign inherits it and the readiness report carries a warning. An unrecognised time zone on the
campaign itself blocks scheduling.

## Limits

`limits.maxResolveRecords` defaults to 10,000 and accepts 1 to 200,000. It caps audience preview and
snapshot resolution; past the ceiling the result is partial and says so.

## Provider

| Field | Default | Accepted | What reads it |
| --- | --- | --- | --- |
| `provider.key` | empty | Up to 64 characters | Send readiness, the delivery sweep, test sends and health |
| `provider.limits.ratePerMinute` | 0 | 0 to 100,000 | The shared provider limiter; 0 means no deployment ceiling |
| `provider.limits.maxConcurrency` | 1 | 1 to 50 | The shared provider limiter |

An empty key means no provider. A non-empty key must be one the registry can resolve, otherwise the
write is refused with `PROVIDER_UNKNOWN` and the known keys. This build registers `platform-mail`,
`fake` and `none`; of those only `platform-mail` can report `live`, and only when the platform mail
transport is `smtp` or `relay`. `fake` reports `disabled`, and a key that resolves to nothing fails closed.

A missing live provider is the usual reason **Start** refuses. The command stays available, but the
readiness report returns `PROVIDER_NOT_BOUND`: either no provider is configured, or the named one is
disabled. **Schedule** is not blocked, so a campaign can be prepared and queued. The delivery sweep
skips queued work with the same code, and a test send is refused rather than faked.

| Test-send field | Default | Accepted | Effect |
| --- | --- | --- | --- |
| `provider.testSend.allowedRecipients` | empty | Up to 50 email addresses | Empty disables test sends; every recipient must be on the list |
| `provider.testSend.maxRecipients` | 5 | 1 to 20 | The most addresses one test send may name |
| `provider.testSend.requireConfirmation` | true | boolean | Requires `confirm: true` on the test-send command |

A test send also needs a campaign purpose and a live provider, and it checks suppression but not
consent: the allowlist is internal and the message is marked as a test. It leaves campaign status,
history and metrics untouched.

## Delivery

| Field | Default | Accepted | What the runtime does |
| --- | --- | --- | --- |
| `delivery.chunkSize` | 100 | 1 to 500 | Caps the rows one batch claims per send |
| `delivery.maxAttempts` | 3 | 1 to 10 | Retry budget per recipient before the row becomes a dead letter |
| `delivery.staleClaimMinutes` | 15 | 1 to 1,440 | A claim older than this is requeued under the same idempotency key |
| `delivery.autoPauseAfterAuthFailures` | 3 | 1 to 20 | Consecutive authentication failures that pause the send |
| `delivery.frequencyCapPerRecipient` | 0 | 0 to 100 | Delivered marketing messages allowed in the window; 0 disables the cap |
| `delivery.frequencyWindowHours` | 168 | 1 to 8,760 | The window the cap counts over |
| `delivery.publicBaseUrl` | empty | Empty or an `http(s)` URL, up to 320 characters | Prefixes unsubscribe and preference links; enables the `List-Unsubscribe` header |

`publicBaseUrl` also decides which absolute origin the tracked-link redirect accepts. Empty means links
are API-relative and the `List-Unsubscribe` header is omitted, because an origin cannot be invented.

## Safety

`safety.globalSendPaused` defaults to false and is read before a recipient is claimed.
`safety.reason` (up to 500 characters, default `null`) is audit text reported by health, not a gate.

## Environment variables a live deployment needs

| Variable | Purpose |
| --- | --- |
| `MAIL_TRANSPORT` | `smtp` or `relay` makes `platform-mail` live; `none` and `memory` leave it disabled |
| `SMTP_HOST` and the other `SMTP_*` settings | The transport `platform-mail` delivers through |
| `MARKETING_WEBHOOK_SECRET` | Verifies provider callbacks; blank rejects every event with `SECRET_NOT_CONFIGURED` |
| `REPORT_WORKER_SECRET` | The worker door for the delivery sweep and journey batch |
| `ENCRYPTION_KEY` | Required to store or use credentials for a sending mailbox |

Callbacks arrive at `POST /api/v1/MarketingAutomation/webhook/:providerKey` with
`x-webhook-signature` and `x-webhook-timestamp`; a signature failure is recorded as a rejected event.

## Troubleshooting

| Symptom | Field or prerequisite |
| --- | --- |
| Start says the campaign cannot be started | `provider.key` is empty or resolves to a disabled adapter; check the blocker text |
| Saving a provider key is refused | The key is not registered; use `platform-mail` or leave the key empty |
| Test send is refused | The allowlist is empty, a recipient is not on it, `confirm` is missing, or no provider is live |
| Campaign schedules but nothing sends | Global pause, no worker with `REPORT_WORKER_SECRET`, or the provider failed verification |
| Sending paused itself mid-run | `autoPauseAfterAuthFailures` consecutive authentication failures paused the send |
| A target list cannot be saved | `features.audience` is off |
| Content preview or sealing is refused | `features.templates` is off |
| A campaign cannot be edited | `features.campaigns` is off; reads still work |
| Unsubscribe links are relative and the header is missing | `delivery.publicBaseUrl` is empty |

## Where to go next

- [Module settings](admin/module-settings) — the document map and what each module starts with.
- [Email and notifications](admin/email-and-notifications) — the transport `platform-mail` wraps.
- [Campaigns and audiences](user/marketing) — the lifecycle, consent and suppression a user works with.
