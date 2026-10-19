# Voice & Communications — privacy and retention

> Phase 19-VC.6, extended through 19-VC.17. This is not legal advice. The deploying organization must validate telecom,
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

Both default **off** (`features.recordings`, `features.transcripts`). 19-VC.15/16 implement them as
follows:

- Enabling is an explicit administrator action; a callback while the flag is off registers nothing.
- A recording callback stores only a **reference** after the URL passes the SSRF allowlist
  (`media.allowedHosts`, https only, no private/metadata destination). Bytes enter private storage
  only when `media.fetchMode = "privateStorage"`, through a worker job.
- Playback is authorized server-side against the parent call (assignee, sharing team, or platform
  administrator). A caller without access gets "does not exist", not "forbidden".
- The browser never receives a provider URL or token: the platform serves the bytes it stored.
- Every media row carries `retention_at` (`media.retentionDays`, default 90); the
  `voiceCommunications.retentionSweep` job deletes the object and the row once it passes.
- Provider URLs with bearer-like query parameters are still a residual risk: the reference is stored
  in `voice_media.provider_ref` for the fetch, never returned by a read API, and the row is deleted at
  retention. A provider that puts a long-lived token in the URL should be avoided.

### AI enrichment (19-VC.16)

- `features.aiEnrichment` defaults off; the module calls the platform AI gateway, so the gateway's
  data-class policy and allowlists apply unchanged.
- Only the transcript text is sent, redacted (`[number]`, `[email]`, `[card]`) and truncated to
  `ai.maxTranscriptChars`.
- Output is **draft-only**: `ai_review_status` starts `pending`; nothing is sent or written to another
  record until an authorized user approves it, and the AI has no tools that could send or mutate.
- Provenance (`ai_connection_key`, `ai_model`, `ai_generated_at`) and review state are returned to
  authorized readers.

## 4. Data minimization

- Provider webhook payloads are stored redacted (credential-like keys removed) with a digest only.
- No message body is written to the audit log or to application logs.
- `voice_media` stores a storage reference, never a long-lived external URL.
- Contact resolution returns a name and a record reference; it never returns a copy of CRM fields.

## 5. Retention classes

`RETENTION_CLASSES` in the domain file names the classes a retention job will read:
`call-metadata`, `message-body`, `message-media`, `call-recording`, `transcript`,
`consent-evidence`, `webhook-diagnostic`.

`voice_media.retention_at` and the `voiceCommunications.retentionSweep` job cover recordings and
message media; transcript rows follow their call session (cascade) and can be deleted with it.
Consent evidence and webhook diagnostics are never deleted by a blanket rule.

## 6. Access

- Provider configuration and credentials: administrative capability only; secrets are write-only.
- Conversations, messages, recordings and transcripts each check their own capability
  (`ACL_MATRIX`): `CommunicationConversation` for the inbox, the `Call` entity for calls and their
  media/transcripts, so Contact visibility never implies recording access.
- Internal notes are structurally excluded from provider sends (`ck_voice_messages_internal_note`)
  and are only visible in the agent inbox; any portal projection must filter
  `is_internal_note = false` (no portal conversation surface exists yet — see the compatibility doc).
- Aggregate counts and health reports never include message content.
