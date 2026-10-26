# Omnichannel — consent, preferences, retention and data rights

> Phase 19-OM.18 (`PLAN_Phase_19_Omnichannel.md` §14). Companion to the feature contract (§6, §9) and
> `docs/modules/voice-communications/privacy-and-retention.md`. **Omnichannel owns no consent store.**

## 1. Consent source of truth (per channel, never merged)

The unit of ownership is the **channel**, not the module. Omnichannel asks the owning module at send
time and stores no copy.

| Channel | Owner | Records | Identity | Read by |
| --- | --- | --- | --- | --- |
| SMS / MMS / WhatsApp | VoiceCommunications | `voice_consent_events`, `voice_suppressions` | normalized address (E.164) | `VoicePolicyService.evaluate` on every send |
| Voice calls | VoiceCommunications | same tables, channel `voice` | normalized number | the call path |
| Email (campaigns) | MarketingAutomation | `MarketingConsent`, `MarketingSuppression` | `emailHash` digest | Marketing campaigns only — **never** an Omnichannel route |
| Website chat | Omnichannel **session** (contract §7) | `omnichannel_visitor_sessions` (`consent_state`/`consent_version`/`consent_at`) | visitor session key (hashed) | the widget's public send endpoint |

The website-chat row is a **session consent artefact** for an anonymous visitor, not a third
channel-messaging consent store: it grants nothing on SMS/WhatsApp, and the widget's send path checks
it before `ingestInbound`. A message moving from the widget to another channel starts again with that
channel's owner — consent never carries across channels or across an address change.

## 2. Invariants (enforced by the owner, asserted by `omnichannel-consent.test.ts`)

1. **No Omnichannel send route bypasses the owner.** Sends go through `VoiceMessagingService.send`
   (policy → consent → suppression → window/template → capabilities) or the widget's session check.
2. **Missing evidence is never consent.** No consent record for an address ⇒ `consent_required`;
   unknown blocks.
3. **An address change does not carry consent over.** Consent granted to one number authorizes that
   number only; a second address is refused until it has its own evidence.
4. **Opt-outs are authoritative.** A `voice_suppressions` row refuses with `suppressed` regardless of
   consent events (the ordering lives in the owner's policy).
5. **Vocabularies never merge.** `voice_suppressions` is channel-scoped to voice/SMS/MMS/WhatsApp;
   `MarketingSuppression` is `Email` + `emailHash`. Neither table can express the other's channel.
6. **No copied consent.** No `omnichannel_*consent*`/`*suppression*` table exists (checked in the
   suite); the module cannot drift from the owners.

## 3. Retention (explicit, owner-mapped)

| Data | Owner | Policy today |
| --- | --- | --- |
| Media / recordings (`voice_media`) | VoiceCommunications | `retention_at` + the module's sweep; provider-hosted links are fetched into private storage and never rendered as public URLs |
| Conversation metadata, message bodies (`voice_*`) | VoiceCommunications | follow the conversation lifecycle; **no message-body sweep exists yet** — open owner task (R6) |
| Webhook payloads (`voice_webhook_events.payload_redacted`) | VoiceCommunications | retained for diagnostics/replay; owner-level purge is an open task |
| Per-agent drafts (`omnichannel_drafts`) | **Omnichannel** | `retention.staleDraftDays` (default 7) + `POST action/retention/purge` |
| Visitor sessions (`omnichannel_visitor_sessions`) | **Omnichannel** | session expiry (`webChat.sessionHours`) + `retention.expiredSessionDays` (default 30) purge |
| Audit rows | platform | preserved; exports/deletions are audited with **counts, never content** |

`POST /api/v1/Omnichannel/action/retention/purge` (administrator) applies the two module-owned
retention windows and reports the counts; it never touches an owner's table.

## 4. Data rights

- **Access/export.** `GET /api/v1/Omnichannel/action/conversations/:id/export` (administrator,
  `settingsManage` + conversation read ACL) returns the conversation metadata, participants with their
  identity evidence, and the **customer-visible** messages only — internal notes are excluded in SQL
  and counted in `excluded.internalNotes`. The act writes an `audit_log` row
  (`CommunicationConversationExport`) with counts only.
- **Erasure.** Deleting canonical conversation/message records is **not** implemented by Omnichannel:
  those rows belong to VoiceCommunications and erasure requires the platform's documented
  retention/deletion workflow, with legal review of what must be preserved (audit, consent evidence,
  suppression). Recorded as an open owner task, not silently claimed.
- The widget and every staff surface share the record but never the visibility: exports and the widget
  exclude internal notes structurally (separate SQL predicates), and internal notes never reach an
  adapter (the `voice_messages` CHECK keeps them unable to carry a provider id).
