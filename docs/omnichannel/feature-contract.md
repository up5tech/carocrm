# Phase 19-OM.1 — Omnichannel feature contract (first release)

> Plan: `PLAN_Phase_19_Omnichannel.md` §14 `19-OM.1`. Inputs: `docs/omnichannel/repository-audit.md`
> (audit), `docs/omnichannel/capability-matrix.md` (matrix), plan §0.2 decisions **D1/D2/D3**.
> Companion: `docs/omnichannel/channel-feasibility.md` (per-channel feasibility gate).
> This document is the signed contract for the **first release**. Later sub-phases implement it;
> they do not silently widen it.

---

## 1. First-release decisions taken in OM.1

| # | Decision | Outcome |
| --- | --- | --- |
| OM1.1 | First channel set | **SMS + WhatsApp (through the existing Twilio adapter) + website chat (built)**. Voice is **context only** (calls are not conversations — matrix §B). |
| OM1.2 | First end-to-end path | **(a) Twilio SMS/WhatsApp** through `VoiceCommunications` (inbound webhook → conversation → inbox → agent reply), validated end-to-end with `FakeVoiceProvider` + `sandboxRecipients` — no real customer message is required. Website chat is the **second** path (OM.9) and its identity model is fixed here (§7). |
| OM1.3 | Deferred / excluded channels | **Deferred:** email-thread ingestion (no inbound provider installed, G9), MMS (no adapter declares it), Meta Cloud API WhatsApp (separate connector + app review). **Excluded from first release:** Telegram, Meta Messenger, Instagram, Viber, TikTok, social publishing/listening. Each has a feasibility record in `channel-feasibility.md`; none may appear in UI as available. |
| OM1.4 | Conversation↔thread cardinality (E6/G3) | See §4. One canonical conversation carries **N channel threads** via a new additive table owned by `VoiceCommunications`. |
| OM1.5 | D1/D2/D3 | Carried **unchanged** (plan §0.2). §3 refines their contracts without re-opening them. |
| OM1.6 | Channel transport routing (audit §12.4) | Transport goes through **Voice's own `VoiceProviderAdapter`** (E1/E14), **not** through `AdvancedIntegrations`' `ConnectorAdapter` (it has no `send` — G17/R18). E15 is therefore **not scheduled** for the first release. New adapters reuse the AI-kit assets directly (E17: `webhook-signatures.ts`, `provider-http-client.ts`, `resilience.ts`). |
| OM1.7 | AI posture (audit §12.5) | First release = **drafts only** (suggestions, summaries, classification) with a human pressing send. No autonomous reply policy. Any AI-originated send is gated on registering a channel-send tool with `effectClass: 'material_write'` (E16/G18) so the existing approval matrix enforces it — deferred to OM.19. |

---

## 2. D1–D3 refinements (binding contracts, not reversals)

### 2.1 D1 — Voice facade contract (E1 + E10 + E14)

Omnichannel consumes `voice_conversations`-family records **only** through an exported,
provider-neutral facade. The facade surface OM.1 fixes (names indicative, types must not mention
SMS/MMS/WhatsApp/Voice):

- `VoiceInboxFacade`: `listConversations(query)`, `getConversation(id)`, `timeline(id, page)`,
  `assign(...)`, `updateStatus(...)`, `addNote(...)`.
- `VoiceMessagingFacade`: `send(command)`, `ingestInbound(event)`, `applyStatus(event)`,
  `reconcileMessage(id)` (E7), `downloadMedia(ref)`.
- Barrel exports (E1): `VoiceInboxService`, `VoiceMessagingService`, `VoiceProviderAdapter` (+
  input/result types). Cross-module declaration (E14): `voiceCommunications.inbox.read` and
  `voiceCommunications.message.send` contracts in `advanced-integrations/contracts/voice-contracts.ts`
  style, per audit §6 "Cross-module contract declaration".
- Deep imports from `apps/api/src/voice-communications/...` internals are forbidden; the Omnichannel
  module imports the barrel or the published contracts only.
- The Omnichannel "projection" (§2.4 plan) is a **read model** computed by facade queries for
  workspace filters (queue, priority, tag, unread). No `omnichannel_conversations` write-store.

### 2.2 D2 — ServiceDesk queue/routing extension contract (E8)

The extension is specified here and delivered **in ServiceDesk** (OM.8/OM.11):

1. **Routed object**: `CaseQueue`/`RoutingRule` accept a routed-object type (`case` |
   `conversation`) instead of being Case-only. A conversation may occupy a queue with no Case
   existing (reference, not dependency — R10).
2. **Operator widening**: rule condition operators extend beyond `equals|notEquals|in` with at
   least `notIn`, `contains`, `greaterThan/lessThan` on numeric/datetime attrs — additive enum.
3. **Business hours**: routing consults the existing `BusinessCalendar` for "open now" /
   after-hours fallback queue.
4. **Skills/language/tier**: a minimal additive `QueueSkill`-style join (or `requiredSkills`/
   `language` attrs on `RoutingRule` + `QueueMember`) so conditions can express plan §3.4 factors.
   First release ships **deterministic rules + round-robin/least-busy + unassigned fallback**;
   skills are the smallest model that expresses channel-support and language only.
5. `currentQueueId` on the conversation (D1 additive column) references `case_queue.id`; moves are
   recorded in `voice_conversation_events` (existing pattern).

### 2.3 D3 — Realtime payload and cursor contract (E11)

- Generic per-user publish seam on `NotificationEventsService` gains a payload
  `{ userId, channel: string, kind: string, payload: Record<string, string|number|null>, seq }`.
  **Identifiers only** — never message body, never participant address, never provider payloads.
- Omnichannel SSE endpoint `GET /api/v1/Omnichannel/stream` (module-scoped, CRMChat precedent):
  - `kind`s in first release: `conversation.message`, `conversation.assignment`,
    `conversation.status`, `conversation.read`, `message.delivery`, `connection.health`.
  - Cursor: monotonic per-user `seq` (the existing notification/event id); client resubmits
    `Last-Event-ID`; on gap or expiry the client **re-reads** inbox state through normal ACL APIs —
    no server-side event replay of content.
  - Auth = the existing session auth path only (no second auth, no second pool, no second
    LISTEN/NOTIFY channel).
- Until E11 lands, the inbox keeps its 15–20 s poll (known degradation, matrix C12).

---

## 3. First-release feature list (owner + acceptance test)

Every row: one owner, one acceptance test type. "Omni" = `Omnichannel` module. Tests run against
the configured primary DB with `AGENT_TEST_<runId>` markers; outbound side effects only via fakes
(audit §10).

| F | Feature | Owner (record / code) | Sub-phase | Acceptance test |
| --- | --- | --- | --- | --- |
| 1 | Module skeleton, nav, permission keys, feature flags | Omni | OM.2 | module loads; nav visibility report; least-privilege ACL default (no `'*'` reliance — E18/G21) |
| 2 | Additive conversation fields: `priority`, `category`, `language`, `tags`, `currentQueueId`, `assignmentVersion`, `lastOutboundAt`, `lastMessageAt`, `snoozedUntil`, `closedAt`, `version` | VoiceCommunications (E4) | OM.3 | migration applies to configured DB; existing rows preserved; unit tests on defaults |
| 3 | Participant identity fields + uniqueness: provider-identity id, `verificationState`, `linkConfidence`/`linkReason`, `lastSeenAt`, `sourceProvenance`; unique (connection/account + channel + provider identity) | VoiceCommunications (E5) | OM.3 | duplicate identity insert rejected; existing rows untouched |
| 4 | Channel-thread table + `voice_messages.thread_id` (this contract §4) | VoiceCommunications (E6) | OM.3 | backfill produces exactly one thread per pre-existing conversation; two threads (sms+whatsapp) group under one conversation |
| 5 | Adapter contract published (E1) + capability registry + `unsupported` category (E3) | VoiceCommunications (+ AI-kit reuse E17) | OM.4 | registry fail-closed to disabled provider unchanged; capability query refuses unsupported send with `unsupported`, no silent success |
| 6 | Inbound webhook receipt for Twilio sms/whatsapp over existing `voice_webhook_events` + raw-body hook (E2) | Omni ingress → Voice pipeline | OM.5 | signature verified byte-exactly (real HMAC fixture), duplicate delivery deduped to one normalized event |
| 7 | Canonical conversation upsert + timeline | VoiceCommunications (reuse `ingestInbound`) | OM.6 | find-or-create by thread contract §4; ordering stable; internal notes unsendable (CHECK) |
| 8 | CRM identity resolution + manual link + conflict review (this contract §6) | Omni policy on Voice records (E5) | OM.7 | exact-E.164 auto-link; fuzzy never auto-links; link/unlink audited |
| 9 | Outbound command: send via facade, idempotency key, explicit states, reconcile-unknown (E7) | VoiceCommunications | OM.8 | double POST with same idempotency key → one send; unknown state resolved only by provider evidence |
| 10 | Website chat widget + visitor sessions + identify/lead capture (this contract §7) | Omni (channel), Voice (conversation records) | OM.9 | anonymous visitor message lands in inbox; internal notes never rendered on public endpoint; abuse controls (rate/honeypot/caps) fire |
| 11 | Agent inbox workspace (views/filters/search/composer) over facade + Voice inbox patterns | Omni UI reusing `VoiceInboxPage` patterns | OM.10 | filters incl. queue/priority/tag/snooze; ACL applied before search results; degraded states visible |
| 12 | Queues, assignment, transfers, routing (D2 extension §2.2) | ServiceDesk engine, Omni policy | OM.11 | transfer records reason + `assignmentVersion` conflict rejected (optimistic lock); after-hours → fallback queue |
| 13 | Canned replies, drafts, follow-up reminders, attachments | Omni on existing snippets/`attachments` | OM.12 | attachment download honours parent ACL; internal-only snippets never sent outbound |
| 14 | Voice-call context panel (read-only `voice_call_sessions` links) | VoiceCommunications (read), Omni (display) | OM.13 | call shown beside conversation; no call status mutated from inbox |
| 15 | WhatsApp/SMS through Twilio in the inbox (template registry honoured) | VoiceCommunications | OM.14 | window-closed / template-required refusals surface the existing error categories; no competing template state |
| 16 | ServiceDesk hand-off create-or-link (this contract §8) | ServiceDesk (E9), Omni trigger | OM.17 | replaying hand-off yields the **same** Case (idempotent via `externalId`); `CaseTransition` row with source exists; Case status never mutated from conversation |
| 17 | Consent/preferences/retention consult, per-channel (audit §4.7) | Owners: Voice + MarketingAutomation | OM.18 | suppression blocks send with `suppressed`; no third consent store |
| 18 | AI-assisted drafts only (summary/suggest/classify via `AIAgentRunService`) | AIAgents runtime, Omni facade | OM.19 | suggestion appears as draft; send disabled without approval tool E16; no autonomous reply path |
| 19 | Conversation analytics reports + operational dashboards | Omni read-model projections (G7 path) | OM.20 | volumes/first-response/resolution computed from facade queries; no second status column |
| 20 | Admin: connections, health, webhook events, replay, diagnostics | Omni reusing Voice admin surface patterns | OM.21 | replay is admin-gated; secrets never rendered; `payload_redacted` respected |
| 21 | Security/privacy/resilience hardening | Omni + platform | OM.22 | security suite modelled on `crm-chat-security.test.ts` (F5): cross-user isolation, unauth, rate limit, no raw SQL; webhook tamper rejected |
| 22 | E2E QA, docs, release readiness | Omni | OM.23 | checklist below passes with fake adapters only |

Out of first release (kept in plan, later): Meta Messenger/Instagram adapters (OM.15), email/Telegram
connectors (OM.16 — gated on operator configuration), auto-identity-merge, autonomous AI sends,
social listening/publishing.

---

## 4. Conversation vs channel thread (canonical boundary)

**Canonical conversation** = the customer-context unit the agent works in (one customer
relationship segment on a set of channels). **Channel thread** = the provider's own conversation
scope (`external_thread_id` on Twilio/WhatsApp business hours, the visitor session on web chat).

Model (all additive, owned and migrated by `VoiceCommunications`):

- New table `voice_conversation_threads`:
  `id`, `conversation_id → voice_conversations(id) ON DELETE CASCADE`, `account_key`, `channel`,
  `external_thread_id` (nullable), `address` (normalized participant address), `provider_identity`
  (nullable, per E5), `created_at`, `modified_at`.
  Unique `(account_key, channel, external_thread_id) WHERE external_thread_id IS NOT NULL`;
  unique `(conversation_id, account_key, channel, address)` for address-scoped threads.
- `voice_messages` gains nullable `thread_id → voice_conversation_threads(id)` (backfilled to the
  conversation's single thread).
- `voice_conversations.external_thread_id` and the `uq_voice_conversations_thread` index are
  **kept but deprecated** (still written for the primary thread so nothing breaks); new grouping
  logic reads threads only.
- **Grouping rule (first release):** a new inbound thread attaches to an existing conversation when
  the normalized participant identity (E.164 `address` / provider identity per §6) matches and the
  conversation is not closed; otherwise a new conversation is created. Same-phone SMS and WhatsApp
  threads therefore share one canonical conversation. Nothing else is merged automatically.
- **Web chat**: the thread is the visitor session key (§7); channel value `web_chat` — this
  requires widening the `channel` CHECK constraint on `voice_conversations`/`voice_messages` to
  include `web_chat` (additive migration, same OM.3 change; matrix A2).
- **Voice calls are not conversations** in the first release: `voice_call_sessions` stays separate;
  F14 links call context into the workspace read-only. A call never blocks or mutates a
  conversation.
- Backfill in the OM.3 migration: one thread row per existing conversation from
  `(account_key, channel, external_thread_id, address-of-customer-participant)`; existing rows and
  ids preserved; runs in one transaction; verified by count-equality before/after.

---

## 5. Lifecycle, visibility, assignment

### 5.1 Conversation state machine (existing enum reused — no new statuses first release)

Current enum (`051_phase19_voice_communications.sql:156`): `open | pending_customer |
pending_internal | resolved | closed | spam`.

| Transition | Trigger | Notes |
| --- | --- | --- |
| → `open` | inbound with no assignee; new web-chat session | unassigned pool |
| `open → pending_internal` | inbound message while assigned | "Waiting on Agent" |
| any non-closed → `pending_customer` | agent outbound **accepted by provider** (`sent`+) | "Waiting on Customer"; never on a queued/failed send |
| `pending_customer → pending_internal/open` | inbound from customer | unread++ |
| any non-closed → `closed` | agent/system close (+ `closedAt`) | reopen → `open`, recorded |
| → `resolved` | kept for parity with existing data; first-release UI maps resolved≈closed | no silent migration of meaning |
| → `spam` | agent/admin on web-chat abuse | also feeds abuse controls |
| snooze | `snoozedUntil` column (E4), **not** a status | view filter; auto-clears on inbound |

Every transition writes a `voice_conversation_events` row (existing pattern) and bumps
`version` (optimistic concurrency, E4). `resolved` vs `closed` semantics may be revisited only in
an explicitly recorded decision.

### 5.2 Visibility model

- Agent side: any user passing conversation record-level ACL sees the full timeline **including**
  internal notes (`is_internal_note`). Field ACL (`visibleFields`/`stripRestricted`) applies on
  read DTOs and on every export path (matrix D24).
- Customer side (web-chat widget, future portal view): **structurally cannot** read internal notes
  — separate public endpoint that filters at SQL level, plus the existing CHECK keeping notes
  unsendable. Same rule for other participants' addresses and for assignment metadata.
- Search returns only records the caller passes ACL on **before** results are shaped (§3.1 plan).

### 5.3 Assignment rules

- Assignment only through the facade (`assign`), which writes `voice_conversation_events` +
  requires current `assignmentVersion` (transfer-conflict guard; R12 equivalent for
  conversations).
- Ownership: one `assigned_user_id`; team queues set `assigned_team_id` + `currentQueueId`.
  Transfer requires a reason (event payload). Unassignment returns the conversation to the queue
  or the unassigned view per routing fallback (D2).
- Routing executes ServiceDesk's engine (§2.2); Omnichannel may **not** compute assignments itself
  outside that engine.

---

## 6. Identity confidence requirements

`linkConfidence` values (E5) and what they authorize:

| Confidence | Basis | Auto-link? |
| --- | --- | --- |
| `exact` | normalized channel address match (E.164 phone via existing libphonenumber resolver; email case-folded) against a single CRM Contact/Lead/Account with record ACL pass | **Yes** |
| `manual` | agent-confirmed link in the workspace | Yes (audited, permission `identityLink`) |
| `heuristic` | multi-candidate or partial match (name, hostname, weak phone variant) | **No** — suggestion + conflict-review list only |
| `none` | unresolved | No |

`verificationState`: `unverified | verified | disputed`. A provider-identity id (E5) that maps to
multiple CRM records is `disputed` and blocks auto-link (R9). `sourceProvenance` records which
ingest produced the claim. **Auto-merge of two CRM records is a first-release non-goal** (plan
§2.2); linking is reversible, always audited, never silent.

---

## 7. Website chat: anonymous visitor identity and consent (OM1.2 second path, F5/G8)

- **Principal**: an Omnichannel-owned **visitor session**, not a Portal account. Portal auth and
  `PortalPolicyService.recordVisible()` are **not modified and not weakened**; the widget is not a
  Portal surface.
- **Session**: 128-bit random `visitorKey`, issued server-side on first load, stored in an
  `httpOnly`, `SameSite=Lax` cookie scoped to the chat routes; server row
  `omnichannel_visitor_sessions` (`id/visitorKey hash, firstSeenAt, lastSeenAt, ipHash, userAgent,
  consentState, identifiedEntityType/entityId, status`). The conversation attaches via a
  `web_chat` thread keyed by the session (§4).
- **Identity upgrade**: visitor may submit an identify/lead-capture form (or sign in via Portal) →
  create-or-match Lead/Contact (`exact`/`manual` rules of §6), link the session row, keep
  provenance. No merge of two identified records.
- **Consent basis**: configurable pre-chat consent notice; messaging consent stored as the
  participant `consent_status`; explicit checkbox required before the first visitor message when
  the site operator enables it (default on). Stored with timestamp + text version.
- **Abuse controls**: reuse `WebToCaseService` primitives (§3.7 audit): per-IP/per-session rate
  limits, honeypot field, bounded session count, message-length caps; `spam` status path (§5.1).
- **First-release limits**: text + one bounded image/file type set via existing `attachments`
  (scanner + parent-ACL download); no credentials/SSO flows in the widget; no agent video/voice;
  transcripts visible only to ACL-passing agents; widget never receives internal notes (§5.2).

---

## 8. ServiceDesk hand-off contract (OM17 dependency, E9/G12)

Additive, owned and delivered **in ServiceDesk**:

1. `Case` gains `external_id` + `external_source` (values first release: `'omnichannel'`) with a
   partial unique index on `(external_source, external_id)`.
2. Relation `Case ⇄ conversations`: authoritative link stays on the conversation side
   (`voice_conversations.case_id`, existing); ServiceDesk exposes `Case.conversations` through a
   read contract; the create-or-link command sets both sides in one transaction.
3. Commands (ServiceDesk-owned, audited):
   - `createCaseForConversation({ conversationId, ...caseAttrs, idempotencyKey })` — create-or-link
     by `external_id = conversationId`; **idempotent replay returns the existing Case**; writes
     `CaseTransition` with `source: 'omnichannel'`, audit row, and assigns via `CaseAssignment`
     only (never by setting `assignedUserId` directly — R12).
   - `linkConversation({ caseId, conversationId })` / `unlinkConversation(...)`.
4. Omni replaces the current generic-entity-API `handoffToCase` internals with this command (C11
   gap). Case status is never mutated from the conversation (ownership matrix, audit §6).

---

## 9. Error taxonomy (D3/matrix D3, E3)

Baseline: the 13 `COMMUNICATION_ERROR_CATEGORIES`
(`voice-communications-domain.ts:462`): `auth, rate_limit, timeout, invalid_request,
invalid_recipient, consent_required, suppressed, template_required, window_closed,
provider_unavailable, invalid_response, media_rejected, unknown`.

Contract additions/clarifications:

- **Add `unsupported`** (E3): the channel does not offer the capability at all (e.g. MMS send,
  read receipts where absent). Behaviour: permanent refusal, no retry, visible to the agent, never
  a silent success (audit §11 plan rule). Retryable set stays `{rate_limit, timeout,
  provider_unavailable}`; policy-blocked set stays `{consent_required, suppressed,
  template_required, window_closed}` and is surfaced as "cannot reply now", not "failed".
- `unknown` is reconciled only by provider evidence (`reconcileMessage`, E7) — the agent may not
  mark it sent; UI shows "delivery uncertain" and gates retry (§3.5 plan).
- Web-chat has no provider status beyond `accepted` (delivered/read only when the session SSE
  acks, bounded — capability registry declares this per channel, matrix §A).

---

## 10. Permission keys (preview for OM.2/OM.13, E18/G21)

Flat synthetic-entity convention (matrix D12), least privilege, seeded for non-admin roles
explicitly: `omnichannelInboxView`, `omnichannelConversationRead`, `omnichannelReply`,
`omnichannelAssign`, `omnichannelQueueManage`, `omnichannelIdentityLink`,
`omnichannelConnectionManage` (admin-class), `omnichannelOpsReplay` (admin-class),
`omnichannelSettingsManage` (admin-class). Admin-class keys are granted to `sysAdmin` only;
ordinary agents never see connection credentials, provider payloads or replay UI (plan §8.1).

---

## 11. First-release non-goals (explicit)

Everything in plan §2.2, plus OM1.3: no Meta Cloud API connector, no Messenger/Instagram/Telegram/
Viber/TikTok UI entries, no MMS (the composer disables it per capability registry), no inbound
email channel (seam documented, provider unconfigured), no autonomous AI sends, no identity
auto-merge, no call-as-conversation, no second realtime gateway, no second routing engine, no
social media publishing.

Connector features that additionally require **provider approval/config before any promise in UI**
(see `channel-feasibility.md` per record): WhatsApp template category/priority approvals (Twilio
+ Meta policy), WhatsApp business-initiated 24h window rules, media messaging product entitlements
(MMS on Twilio requires account entitlement today unused), Messenger/Instagram app review +
advanced permissions, Telegram business messaging (not assessed), email mailbox credentials +
SPF/DKIM for sending (out of first release anyway).

---

## 12. Risk log (updates audit §9 R1–R19)

| # | Risk (OM.1 additions) | Severity | Mitigation / decision |
| --- | --- | --- | --- |
| R20 | Web-chat widget is an unauthenticated public attack surface (spam, prompt-style abuse, DoS) | High | Reuse `WebToCaseService` abuse controls (§7); bounded sessions; `spam` state; security suite OM.22; attachments scanner-gated |
| R21 | Thread-cardinality migration (§4) touches live conversation data | Medium | Purely additive: new table + nullable column + single-transaction backfill; count-equality check; `external_thread_id` kept (no rename/drop) |
| R22 | Visitor-session fixation / cookie theft creating fake conversations | Medium | 128-bit random key, httpOnly cookie, ipHash rate limiting, sessions expire and are bounded per IP |
| R23 | Grouping conversations by phone could expose one customer's history to a wider ACL than intended | Medium | ACL is per conversation record (composition preserved); grouping never widens ACL; conflict-review (§6) surfaces mislinks |
| R24 | `web_chat` CHECK-widening could be read as "email/MMS support" by later phases | Low | Capability registry is the only source of channel availability; UI derives from it (OM1.3, §11) |
| R25 | Realtime seam (E11, shared-platform) slips → inbox stays on 15–20 s poll | Low | Polling is the documented degraded mode (§2.3); OM.10 ships functional without SSE |
| R26 | Twilio feasibility drifts (pricing/policy/regional changes) between contract and OM.5 work | Medium | `channel-feasibility.md` records require re-verification date-stamped before adapter work (plan §4.3) |

Carried from audit §9 without change: R1–R19 (second-inbox, second-routing, email double-process,
consent drift, fake-adapter confidence, unbounded growth, search/report blindness, internal-note
leak, mis-merge, queue coupling, realtime tension, assignment integrity, stale dist artifact,
fifth webhook inbox, third credential stack, CRMChat exposure, `upsertObject` abuse, permission
key gaps).

---

## 13. Preconditions scheduled first (edits, not decisions)

| Ext | Change | Owner | Blocks | Status |
| --- | --- | --- | --- | --- |
| E1 | Voice barrel exports (`VoiceInboxService`, `VoiceMessagingService`, `VoiceProviderAdapter` + types) | VoiceCommunications | everything (OM.4+) | **DONE — OM.4** |
| E2 | `bootstrap.ts` raw-body `preParsing` allowlist gains the Omnichannel webhook prefix | shared platform | OM.5, any real-signature channel | **DONE — OM.5** (bytes preserved for the prefix; the parsed body still flows normally) |
| E3 | `unsupported` error category | VoiceCommunications/domain | OM.4 | **DONE — OM.4** (permanent, non-retryable, operator message present) |
| E14 | `voiceCommunications.inbox.read` + `voiceCommunications.message.send` cross-module contracts | VoiceCommunications + contracts registry | OM.4/OM.6/OM.8 | **DONE — OM.4** (v1, beside the existing suppress contract) |
| E4/E5/E6 | Additive migrations (conversation fields, participant identity, threads) | VoiceCommunications | OM.3 | **DONE — OM.3** (migration 077) + **OM.6** (services write threads: attach + continuity) |
| E7 | `reconcileMessage` / provider status lookup | VoiceCommunications | OM.6 | **DONE — OM.6** (`getMessageStatus` on the adapter; Twilio + simulator; `unsupported` when absent) |
| E8 | Queue/routing accepts conversations + operators + business hours | ServiceDesk | OM.11 | **DONE — OM.11** (queue opt-in, rule object type, operators, business hours, decision reuse) |
| E9 | Case `external_id` + create-or-link commands | ServiceDesk | OM.17 | open — **re-scoped**: delivered with its consumer in OM.17 (recorded in plan §14 OM.11) |
| E11 | Generic per-user publish seam | shared platform | OM.12/realtime | open |
| E16 | `material_write` channel-send tool registration | AIAgents | OM.19 only | open |

---

## 14. Acceptance evidence (plan §14, 19-OM.1)

| Criterion | Where met |
| --- | --- |
| Every first-release feature has a clear owner and acceptance test | §3 (F1–F22), §2.1–2.3, §8, §13 |
| No unsupported social messaging capability is represented as a committed feature | §1 OM1.1/OM1.3, §11, `channel-feasibility.md` (all excluded channels are NO-GO with reasons) |
| The first connector path can be tested without sending a real customer message | §1 OM1.2: Twilio path validated with `FakeVoiceProvider`/`signFakeWebhook` + injected `fetchImpl` + `sandboxRecipients` (audit §10); web chat validated by HTTP-level tests (no provider) |
| D1–D3 carried unchanged, or replacement recorded with rationale | §2 (refinements only); §1 OM1.6 closes the E15 open question **in favour of Voice's adapter** — rationale: `ConnectorAdapter` has no `send` (G17) and using `upsertObject` would break its documented promise (R18); no reversal of D1–D3 occurred |

Documentation-only phase: **no code, no migration, no metadata changed.** The two OM.0 "decided
here, not deferred" questions (anonymous-visitor identity → §7; email double-processing → §15)
are answered here.

## 15. Email ↔ Email-to-Case non-competition contract (pre-decided for the deferred channel)

Email is not in the first release, but the rule is fixed now so a later phase cannot improvise:

1. One ingestion path only: `packages/mail` → existing `Email` records. Omnichannel never polls a
   second mailbox and never binds its own `InboundMailProvider`.
2. Omnichannel **reads and honours** the ServiceDesk markers (`caseId`, `streamItemId`,
   `emailToCaseStatus`, undeclared raw attrs today) and the `EmailToCaseService` outcome; it writes
   **no competing marker** and mutates none of them.
3. A support email already claimed by Email-to-Case (`emailToCaseStatus` set, or linked
   `streamItemId`) is not converted into a second conversation-thread; if a conversation view is
   wanted, it links to the existing Case instead (hand-off relation, §8).
4. Enabling the channel requires E13 (operator-configured IMAP/Graph provider) and a new
   `channel-feasibility.md` go decision — recorded before any code.
