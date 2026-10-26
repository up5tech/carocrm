# Phase 19-OM.1 — Omnichannel channel feasibility records

> Plan: `PLAN_Phase_19_Omnichannel.md` §4.3 gate, §14 `19-OM.1`. One record per candidate channel.
> A channel **must not** have an adapter, UI entry, or committed feature until its record is GO.
>
> **Evidence basis and re-verification duty.** The "Checked" date below is the date this record was
> written; its facts are drawn from (1) the code audit `docs/omnichannel/repository-audit.md`
> (2026-10-26, commit lineage of OM.0) and (2) the reference baseline in plan §16. **Live provider
> documentation was not re-fetched for every record in this pass.** Before any adapter coding
> (OM.5, OM.9, OM.14, and any future connector), the responsible sub-phase **must** re-open the
> linked official docs, update this record with the re-check date and changed facts, and stop if
> the decision no longer holds (plan §0.1: "re-check current provider documentation").
>
> Verdict legend: ✅ **GO** (first release) · 🟡 **CONDITIONAL** (gate has a named prerequisite) ·
> ⛔ **NO-GO** (first release; record kept so nobody assumes support).

---

## CF-1 — SMS (Twilio)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (code audit + plan §16; re-verify docs before OM.5) |
| Official docs | https://www.twilio.com/docs/sms · https://www.twilio.com/docs/messaging · webhook: https://www.twilio.com/docs/usage/webhooks |
| Account type | Twilio Messaging Service + verified/registered sender; number purchase; regional rules (e.g. 10DLC in the US) attach to the account, not our code |
| Review/approval prerequisites | Sender campaign/registry approvals are region-dependent (US 10DLC, other countries' sender IDs). Operator-side. |
| Inbound | ✅ production webhook → status callbacks + inbound SMS; verified live in code: `voice-webhook-ingress.service.ts` + Twilio adapter (audit §4.2) |
| Outbound B2C | ✅ `VoiceMessagingService.send` → Twilio Messages API |
| Message types / media | Text ✅; media = **MMS, not supported by any adapter today → see CF-5** |
| Delivery callbacks | ✅ queued/sent/delivered/undelivered → mapped into `voice_messages` state enum with rank-no-regression (`applyStatus`) |
| Read receipts | ❌ not a Twilio SMS capability → declared in capability registry, composer must not promise it |
| Idempotency | ✅ ours: `uq_voice_messages_idem` (Twilio itself is at-least-once on webhooks; dedup via `voice_webhook_events`) |
| Rate limits / quotas | Per-account and per-number throughput, and regional throughput caps — **re-verify exact numbers before OM.5**; error mapping already has `rate_limit` |
| Retention / deletion | Provider retention is external; our retention follows `voice_messages` lifecycle + R6 mitigation (define retention in OM.3) |
| Test environment | Twilio console test credentials + magic test numbers; **in automated tests only `FakeVoiceProvider`/`simulator()` with `sandboxRecipients` and injected `fetchImpl` (audit §10) — no real message is ever sent by a test** |
| Credential/webhook/transport owner | **VoiceCommunications** (`voice_provider_accounts`, adapter, ingress). Reuse unchanged. |
| Known gaps to close first | E2 raw-body hook (byte-exact Twilio signature verification), E1 barrel, E14 contracts |
| **Decision** | ✅ **GO — first end-to-end path (OM1.2)** |

## CF-2 — WhatsApp (via Twilio WhatsApp API)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (as CF-1) |
| Official docs | https://www.twilio.com/docs/whatsapp · Meta policy surface: plan §16 WhatsApp Business Platform links |
| Account type | Twilio WhatsApp sender (sandbox or approved sender backed by a WhatsApp Business account). **Note: this is Twilio's WhatsApp API — the Meta Cloud API direct connector is a different channel (CF-7)** (matrix §B, audit §7.2) |
| Review/approval prerequisites | Sender approval, HSM/template approval per category, opt-in requirements, message category rules. Operator-side; template state already owned by `voice_whatsapp_templates` (audit §6 — read-only for us) |
| Inbound | ✅ same Twilio webhook pipeline as CF-1 (live adapter, audit §4.1–4.2) |
| Outbound B2C | ✅ within the 24h customer-service window for free-form; **outside it, approved template only** — already enforced: `window_closed` / `template_required` error categories exist (domain `:462`) |
| Message types / media | Text ✅; media capability = simulator-only today (audit §7.2) → capability registry must declare media **unsupported** until re-verified (`unsupported` category, E3) |
| Delivery callbacks | ✅ read/delivered statuses mapped into existing enum (matrix A5) |
| Read receipts | ✅ on WhatsApp where the platform reports them (adapter callback) |
| Idempotency | ours: same as CF-1 |
| Rate limits / quotas | Throughput tiers are account-graded on the Meta side under Twilio — **re-verify before OM.14** |
| Retention / deletion | External provider policy; our audit trail per R6/OM.3 retention definition |
| Test environment | Twilio WhatsApp sandbox + fake provider; tests never hit real senders |
| Credential/webhook/transport owner | **VoiceCommunications** |
| **Decision** | ✅ **GO — first release** (with template/window honoured, media declared unsupported until re-check) |

## CF-3 — Voice calls (Twilio Voice + Asterisk ARI)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (as CF-1) |
| Official docs | https://www.twilio.com/docs/voice · Asterisk ARI docs (adapter: `voice-provider-asterisk.ts`, 428 lines, live) |
| Account type | Twilio voice-capable number / Asterisk server credentials (operator infra) |
| Inbound / outbound | ✅ events + `initiateCall`/`controlCall` already implemented |
| Scope in Omnichannel | **Context only**: calls stay in `voice_call_sessions`; not inbox conversations in the first release (feature contract §4, F14). Recordings/transcripts are simulator-only today (audit §7.2) → media features stay capability-gated off |
| Credential/webhook/transport owner | **VoiceCommunications** |
| **Decision** | 🟡 **CONDITIONAL GO (read-only context)** — no call-conversation modelling in first release |

## CF-4 — Website / Portal chat (self-hosted channel)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (code audit; no external provider — the "provider" is us) |
| Docs | Internal: feature contract §7 (visitor identity/consent), §4 (`web_chat` thread rule); reuse surface: `WebToCaseService` abuse controls (audit §5.1), `attachments` scanner, `is_internal_note` pattern |
| Account type / approval | None external. Requires: `channel` CHECK widened to include `web_chat` (OM.3 additive migration, matrix A2) |
| Inbound / outbound | ✅ both are ours: widget HTTP + Omnichannel SSE (D3) — no third-party dependency |
| Message types | First release: text + scanner-gated bounded attachments (feature contract §7); typing/read receipts only when our session acks them (capability registry truth, taxonomy §9) |
| Delivery callbacks / idempotency | Internal: same `voice_messages` idempotency + state machine; `delivered/read` states emitted by widget acks only |
| Rate limits | Self-imposed abuse controls (session/IP bounded, honeypot) — R20 mitigation |
| Test environment | Fully testable over HTTP with `bootTestApp()` — **no external service, no real message** |
| Identity/consent | Anonymous visitor session model, pre-chat consent (§7 contract). Portal auth untouched; `PortalPolicyService.recordVisible()` not weakened |
| Owner | Session/widget/transport: **Omnichannel (new)**; conversation/message records: **VoiceCommunications** (D1). This is the only first-release channel where Omnichannel writes a channel-store of its own (`omnichannel_visitor_sessions`) — justified by gap G8 (no anonymous principal anywhere) and scoped to session state, not conversation content |
| **Decision** | 🟡 **GO — second path (OM.9)**, prerequisites: OM.3 `web_chat` channel value + OM.1 SSE seam (E11; poll fallback documented) |

## CF-5 — MMS

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 |
| Official docs | https://www.twilio.com/docs/messaging (MMS is a Twilio messaging capability) |
| Code reality | Named in vocabulary/tables/DTOs but **no adapter declares `messaging.mms.send/.receive`** (matrix §B, audit §7.2). Channel CHECK already includes `mms` — the constraint is the adapter, not the schema |
| Approval prerequisites | Twilio MMS requires account-level media messaging entitlement; carrier filtering applies |
| **Decision** | ⛔ **NO-GO first release — DEFER.** UI must hide MMS via the capability registry (`unsupported`), never show it as available (feature contract §11, R24) |

## CF-6 — Email (threaded conversation channel)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 |
| Official docs | n/a external; seam docs: `packages/mail` `InboundMailProvider` port |
| Code reality | Outbound transports exist (SMTP/relay/memory/none); **inbound seam bound to `NullInboundProvider` — no IMAP/Graph provider installed** (G9). `Email` entity + `threadId` exist; ServiceDesk `EmailToCaseService` is manually triggered and its marker attrs are undeclared raw attrs (audit §5.2) |
| Approval prerequisites (operator) | Mailbox credentials, IMAP/Graph app permissions, SPF/DKIM if sending, mailbox policy — all outside our repo |
| Double-processing | Contract fixed in advance: feature contract §15 (one ingestion path; honour `emailToCaseStatus`/`caseId`/`streamItemId`; no competing marker; no second mailbox poll) |
| **Decision** | ⛔ **NO-GO first release — DEFER** (OM.16 optional). Re-open only after E13 (provider configured by operator) + §15 contract is re-affirmed here with a re-check date |

## CF-7 — WhatsApp via Meta Cloud API (direct)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (plan §16 links; not code-verified — nothing exists to verify) |
| Official docs | plan §16: WhatsApp Business Platform developer hub + Meta messages/webhook API collections (developers.facebook.com surface) |
| Account type | Meta Business Portfolio, WhatsApp Business account, display name approval |
| Review/approval | App review for messaging scopes, business verification, message category pricing rules (Meta-side), template approval owned by Meta |
| Code reality | **Not present.** WhatsApp today ships only through Twilio (CF-2) |
| Ownership concern | If ever built, it is an **additional adapter in VoiceCommunications** (second transport behind the same adapter contract), sharing `voice_provider_accounts` — never a second conversation/message store (R1) |
| **Decision** | ⛔ **NO-GO first release.** Only justify it if a requirement appears that Twilio-through WhatsApp cannot meet (e.g. features Meta exposes and Twilio does not) — re-evaluate at OM.14 with live docs |

## CF-8 — Meta Messenger

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (plan §16 Send API reference; no code exists) |
| Official docs | https://developers.facebook.com/docs/messenger-platform (Send API, Webhooks, Handover, rate limits) |
| Account type | Facebook **Page** (professional), Meta app, Page access token |
| Review/approval | App review with `pages_messaging` permission, business verification, 24h messaging window + tagged-message rules; no assumption that consumer DMs imply business API access (plan §0.1) |
| Inbound/outbound | Documented ✅ webhook + send — but **we have no adapter, no app, no review** (matrix §B: ⛔) |
| **Decision** | ⛔ **NO-GO first release — EXCLUDED** (OM.15, plan §4.1(4): only "if permissions and app review are available" — they are not). No UI surface may mention it |

## CF-9 — Instagram (professional messaging)

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (no code, no live-docs re-check performed this pass) |
| Official docs | Instagram messaging is exposed through the Messenger Platform surface (plan §16 Messenger link); Instagram API with Facebook Login messaging docs |
| Account type | Instagram **professional** account linked to a Facebook Page/app; advanced permissions |
| Review/approval | App review + advanced permission grant per audience; policies tighten frequently |
| **Decision** | ⛔ **NO-GO first release — EXCLUDED** (same posture as CF-8). Never infer support from the consumer app's DM feature (plan §0.1) |

## CF-10 — Telegram

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (plan §16 links; no code) |
| Official docs | https://core.telegram.org/bots/api · https://core.telegram.org/bots/webhooks |
| Account type | Bot via BotFather; webhook or long-polling |
| Constraints | A bot only sees conversations **with its users** — "bot capability ≠ access to arbitrary personal conversations" (plan §4.1(6), §4.4). Customer-initiated path requires the user to find/message the bot; no business-verified DM surface equivalent to WhatsApp/Messenger |
| Product posture | Not credible as a first-release customer channel for this CRM's market |
| **Decision** | ⛔ **NO-GO first release — EXCLUDED** (plan §15 explicit deferral). Would need: adapter in Voice, webhook signature model (Telegram secret-data approach), and a product decision on how customers initiate the bot chat |

## CF-11 — Viber

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (no code; docs URL from public knowledge — **must be re-verified live before any use**, plan §4.1(7)) |
| Official docs | https://developers.viber.com/docs/api/rest-bot-api/ (Viber Business APIs) |
| Gate | Plan §4.1(7): regional channels only after a technical feasibility review documenting official commercial messaging APIs, approval/partner requirements, regions, policies. That review has not been performed |
| **Decision** | ⛔ **NO-GO — NOT ASSESSED.** Record kept to prevent silent scope creep |

## CF-12 — TikTok

| Field | Value |
| --- | --- |
| Checked | 2026-10-26 (plan §16 link; no code) |
| Official docs | https://developers.tiktok.com/doc/tiktok-api-v2-introduction/ |
| Gate | TikTok's public API surface is not a general business-DM channel; messaging/commercial APIs are partner-gated. Plan §4.4 forbids claiming private-message access |
| **Decision** | ⛔ **NO-GO first release — EXCLUDED.** Also out of scope as social publishing/listening (§2.2) |

---

## Summary table

| ID | Channel | Verdict | First release? | Blocking prerequisite |
| --- | --- | --- | --- | --- |
| CF-1 | SMS (Twilio) | ✅ GO | **Yes — first E2E path** | E1, E2, E14 |
| CF-2 | WhatsApp (Twilio) | ✅ GO | **Yes** | CF-1 set + capability honesty on media |
| CF-3 | Voice calls | 🟡 GO (read-only context) | Context only | none (existing store read via facade) |
| CF-4 | Website chat | 🟡 GO (second path, OM.9) | Yes (2nd) | OM.3 `web_chat` channel value; visitor-session build; E11 for live updates |
| CF-5 | MMS | ⛔ NO-GO (defer) | No | an adapter that declares mms send/receive + entitlement |
| CF-6 | Email | ⛔ NO-GO (defer) | No | E13 operator provider + §15 non-competition contract |
| CF-7 | Meta Cloud WhatsApp | ⛔ NO-GO | No | business justification vs Twilio path + Meta review |
| CF-8 | Messenger | ⛔ EXCLUDED | No | app review, `pages_messaging`, Page accounts |
| CF-9 | Instagram | ⛔ EXCLUDED | No | professional account + advanced permissions |
| CF-10 | Telegram | ⛔ EXCLUDED | No | initiation model + adapter |
| CF-11 | Viber | ⛔ NOT ASSESSED | No | full §4.1(7) feasibility review |
| CF-12 | TikTok | ⛔ EXCLUDED | No | partner-gated messaging APIs |

**First connector path testability (acceptance):** CF-1/CF-2 are exercised end-to-end in automated
tests through `FakeVoiceProvider`, `signFakeWebhook`, `registry.simulator()`, injected `fetchImpl`,
and `sandboxRecipients` — **zero real customer messages** (audit §10). CF-4 is exercised purely
over HTTP against the configured primary DB. No other channel ships, so no other feasibility gate
is load-bearing for the first release.
