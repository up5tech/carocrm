# Voice & Communications — compatibility and behavior reference

> Phase 19-VC.0 deliverable (`PLAN_Phase_19_Voice_Communications.md` §1.3, §16).
> Status: **19-VC.0–19-VC.17 delivered** (server side; dedicated screens remain a follow-up).
> Canonical module name: `VoiceCommunications` (no `Ua` prefix). API prefix:
> `/api/v1/VoiceCommunications`; webhook prefix: `/api/v1/integrations/voice-communications`.

This document records the external behavior this module reimplements, the decisions taken
against the repository as it actually exists, and the compatibility limits a deploying
organization must know. It is updated as adapters land; a feature is **not** listed as supported
until its adapter and end-to-end behavior pass the relevant tests (§16).

---

## 1. Functional reference

The product behavior is CRM-oriented telephony and one-to-one messaging, not a PBX:

| Behavior | Reference | Implementation status |
| --- | --- | --- |
| Click-to-call from a phone field | EspoCRM VoIP Integration overview | API implemented (19-VC.8); the phone-field button is not built (no SPA screens in this phase) |
| Incoming-call popup with caller context | EspoCRM VoIP Integration overview | Server side implemented (19-VC.9): notification row + ACL-filtered context; the popup component is not built |
| Call logging as an Activity | EspoCRM Activities and Calendar | Implemented (19-VC.7): one `Call` Activity per session, created/updated through the entity service |
| SMS/MMS send + delivery callbacks | Twilio Message resource docs | SMS implemented through the simulator (19-VC.10); MMS not implemented; live adapter pending |
| WhatsApp Business templates and service window | Twilio WhatsApp API / templates docs | Window policy (19-VC.6) + template approval/variables (19-VC.11), simulator only |
| Provider webhook signature validation | Twilio webhook security docs | Contract + fake HMAC adapter (19-VC.5); provider-specific validators per adapter |
| Unified inbox: list, timeline, read state, status | EspoCRM / general CRM inbox behavior | Implemented as an API (19-VC.12); no dedicated SPA screen |
| Conversation assignment and Service Desk handoff | EspoCRM assignment + Service Desk case flow | Implemented (19-VC.13): user/team assignment with history, idempotent Case handoff |
| One-to-one service snippets and composer checks | EspoCRM email templates (one-to-one use) | Implemented (19-VC.14): local snippets, strict placeholders, segment hints; no campaign model |
| Call recording metadata, playback and retention | Twilio recording docs | Implemented with the simulator (19-VC.15): reference, SSRF-checked private fetch, ACL playback, retention sweep |
| Transcript and AI summary / suggested reply | Twilio transcription + AI summarization | Implemented with the simulator and the fake AI adapter (19-VC.16); draft-only, opt-in |
| Communications panel on a CRM record | EspoCRM stream/panels | API implemented (19-VC.17): record-ACL-aware conversations + calls, touchpoints for Customer Success |

This is a clean-room reimplementation. No EspoCRM PHP class, frontend asset, icon, translation or
branding is copied. Provider behavior is treated as a versioned external contract; each adapter
must verify the provider's current documentation when it is implemented.

Reference pages (unchanged from the plan): EspoCRM VoIP integration and customization docs,
EspoCRM Activities and Calendar, Twilio secure webhooks / Voice webhooks / Message resource /
WhatsApp API / WhatsApp templates / recording encryption.

---

## 2. Decisions taken from the repository audit

The audit is `docs/implementation/voice-communications-audit.md`. The decisions that shape every
later sub-phase:

1. **The module is a kernel domain directory**, like Sales, Service Desk, Customer Success,
   Marketing Automation and AI Agents: `apps/api/src/voice-communications/`, records in the
   existing stores, ACL/audit/stream/jobs/attachments reused. No installable extension, no second
   framework (AGENTS.md §5.1–§5.2).
2. **High-volume communication data uses dedicated tables.** Provider accounts, endpoints,
   webhook receipts, call sessions, conversations, participants, messages, media, consent and
   suppression are relational tables created by additive migration 051. The Entity Engine remains
   the right home for CRM records (Contact, Lead, Account, Call), not for a message timeline whose
   lifecycle and volume differ from a metadata record. The plan explicitly permits this
   (§4.2 "provider events and high-volume message/call data may use dedicated relational tables").
3. **Call records reuse the platform `Call` Activity** (§7.4). The `Call` entity already exists with
   `direction`, `status`, `dateStart`, `dateEnd`, `duration`, `description` and account/contact/user
   relations. `voice_call_sessions` holds provider correlation and normalized state; it never
   duplicates the Activity's user-facing fields. Linking a session to its Activity is 19-VC.7.
4. **Secrets use the platform encryption primitive**, not a module-local scheme:
   `ENCRYPTION_KEY` + AES-256-GCM (`encryptSecret`/`decryptSecret` from `@carocrm/core`), the same
   one `email_accounts` and `ai_provider_connections` use. Provider credentials are write-only and
   never returned by any read path (§13.1).
5. **Marketing consent is email-only.** `MarketingConsent.channel` is the enum `['Email']` and its
   identity is an email hash. It stays authoritative for email. Voice, SMS, MMS and WhatsApp
   consent/suppression are owned by this module (`voice_consent_events`, `voice_suppressions`) with
   a documented integration contract: MarketingAutomation may query the module's policy service
   before a campaign-triggered voice/SMS send, and this module never writes email consent.
   This avoids two authoritative sources for the same fact while respecting §5.2.
6. **No realtime gateway exists.** The repository has no WebSocket/SSE gateway. Incoming-call
   popups (19-VC.9) must use the existing `notifications` table and polling/stream mechanisms, or
   add a minimal documented event channel in that sub-phase. This module does not invent a second
   notification system for VC.0–VC.6.
7. **Phone normalization uses `libphonenumber-js` behind a seam.** `LibPhoneNumberNormalizer`
   (default, `PHONE_NORMALIZER` token) applies real numbering-plan metadata, so `isValid()` means the
   number is assigned for its region. `ConservativePhoneNormalizer` remains as a dependency-free
   fallback for contract tests and for a deployment that cannot ship the metadata package. Both
   implement `PhoneNormalizer`; the resolver, consent and policy services depend on the interface
   only. Numbers rejected by the plan are refused, never guessed.
8. **Event names use the repository's camelCase namespace rule.** The plan's suggested
   `voice-communications.call.initiated` contains a hyphen, which the platform's `EVENT_TYPE`
   regex rejects. The module emits `voiceCommunications.call.initiated` and its siblings
   (`voiceCommunications.message.received`, …), exactly as Customer Success namespaced
   `customerSuccess.*`. The semantic contract is unchanged.
9. **Webhook signatures are verified against canonical JSON for the fake adapter.** Fastify parses
   the body before the controller runs and no raw-body capture is configured. The fake adapter signs
   `HMAC-SHA256(secret, timestamp + "." + canonicalJson(body))`. A provider that signs exact raw
   bytes (Twilio) needs a raw-body capture added with that adapter in 19-VC.10; the adapter contract
   accepts `rawBody` when present and the ingress passes it through.

---

## 3. Compatibility limits (honest list)

- **No live provider is implemented.** Only the simulator and the adapter contract exist. No call is
  placed, no message is sent, no external host is contacted; the simulator refuses every destination
  outside its `sandboxRecipients` allowlist.
- **No PBX adapter** (Asterisk, 3CX, Starface, Binotel, iexPBX) exists. Each will be marked
  `not-implemented` in the capability matrix until it has an adapter and contract tests.
- **Recording and transcription are off by default and must be enabled explicitly.** With the flag
  off, a recording callback registers nothing. Transcription requires a provider adapter that offers
  `fetchTranscript`; AI enrichment additionally requires an approved AI gateway connection.
- **No dedicated SPA screens** for the inbox, composer, call popup, media player or CRM panel. Every
  behavior is reachable through the API and is exercised by the integration suite; the screens are a
  separate UI phase, not a missing backend capability.
- **The Portal is not extended.** There is no customer-facing conversation surface: adding one
  without an explicit product requirement would create a second ACL surface whose internal-note
  exclusion would have to be re-proved. The inbox API never exposes internal notes to a
  non-agent caller, and any future portal projection must filter `is_internal_note = false`.
- **Customer Success consumes events, not records.** `voiceCommunications.*` events carry ids and
  verbs only (no bodies), and the panel touchpoint endpoint returns counts and recency. Neither
  creates a second Activity, so the "no duplicate Activities" rule holds by construction.
- **MMS is not implemented**; the channel exists in the domain and the settings gate, but no adapter
  path sends it.
- **Delivery state is never inferred.** The normalized message state machine only moves forward on
  an actual callback; absent a callback the state remains `sent`/`unknown`, never `delivered`.
- **WhatsApp service-window policy is evaluated with an injectable clock** and returns
  `templateRequired` outside the window; an approved local template with complete variables is the
  only way through it (19-VC.11).
- **No cost or billing integration.** Provider usage data is not collected in this release.
- **Webhook replay protection** is a timestamp window plus an `(account_id, dedup_key)` unique
  constraint. Replay of an old event outside the window is rejected; a duplicate inside it is
  recorded once and answered idempotently.

---

## 4. Versioning

| Component | Version / contract |
| --- | --- |
| Module | `VoiceCommunications` 1.0.0, load order 390 |
| Migrations | `051`…`054` (additive) |
| Adapter contract | `apps/api/src/voice-communications/voice-provider.ts` |
| Normalized states | `apps/api/src/voice-communications/voice-communications-domain.ts` |
| Fake adapter signature | HMAC-SHA256 over `timestamp + "." + canonical JSON` |

Provider API versions are pinned per adapter when the adapter is implemented; this document records
the pinned version in `docs/modules/voice-communications/providers.md`.
