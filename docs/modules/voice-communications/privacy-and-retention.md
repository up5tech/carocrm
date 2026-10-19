# Voice & Communications — privacy and retention

> Phase 19-VC.6. This is not legal advice. The deploying organization must validate telecom,
> privacy, recording and messaging requirements for its jurisdictions.

## 1. Consent ownership

| Channel | Authoritative store | Notes |
| --- | --- | --- |
| Email | `MarketingConsent` (Marketing Automation) | Unchanged; this module never writes it. |
| Voice, SMS, MMS, WhatsApp | `voice_consent_events` | Append-only evidence per `(channel, address, purpose)`. |

Consent is never inferred from a phone number or an unrelated CRM interaction. A channel with no
recorded decision is `unknown`, and `policy.requireConsent` defaults to `true` for SMS/MMS/WhatsApp.

`POST /api/v1/VoiceCommunications/action/consent` records a decision with `basis`, `source`,
`evidence`, `occurredAt` and the acting user. The current state is the latest event; nothing is
updated in place.

## 2. Suppression

`voice_suppressions` is a tombstone, not a delete. Revocation sets `revoked_at` and keeps history.
At most one active suppression per `(channel, address)` exists (partial unique index). Suppression is
checked on every policy evaluation, including a re-evaluation immediately before dispatch in later
phases.

## 3. Recording and transcription

Both default **off** (`features.recordings`, `features.transcripts`). No recording is fetched,
stored or played in 19-VC.0–19-VC.6. When 19-VC.15/16 land, they must:

- require an administrator-configured legal/operational policy before enabling;
- authorize every playback/download server-side, independently of Contact/Case visibility;
- keep a retention date and a deletion path per `voice_media`;
- avoid persisting provider URLs that carry bearer-like parameters.

## 4. Data minimization

- Provider webhook payloads are stored redacted (credential-like keys removed) with a digest only.
- No message body is written to the audit log or to application logs.
- `voice_media` stores a storage reference, never a long-lived external URL.
- Contact resolution returns a name and a record reference; it never returns a copy of CRM fields.

## 5. Retention classes

`RETENTION_CLASSES` in the domain file names the classes a retention job will read:
`call-metadata`, `message-body`, `message-media`, `call-recording`, `transcript`,
`consent-evidence`, `webhook-diagnostic`.

Only `voice_media.retention_at` exists as a concrete column today; the retention job itself is
19-VC.15/19-VC.18. Consent evidence and webhook diagnostics are never deleted by a blanket rule.

## 6. Access

- Provider configuration and credentials: administrative capability only; secrets are write-only.
- Conversations, messages, recordings and transcripts will each have their own permission
  (`ACL_MATRIX`), so Contact visibility never implies recording access.
- Internal notes are structurally excluded from provider sends (`ck_voice_messages_internal_note`)
  and must be excluded from any portal projection.
- Aggregate counts and health reports never include message content.
