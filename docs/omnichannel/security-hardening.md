# Omnichannel — security, privacy and resilience hardening (19-OM.22)

> Phase 19-OM.22 (`PLAN_Phase_19_Omnichannel.md` §14). Scope: the module's core data paths —
> cross-channel identity, public web chat, provider webhooks, conversation/message reads, exports,
> attachments/media, and AI assistance. Method: a route-by-route ACL review, a data-flow review for
> customer-visible vs agent-only fields, a webhook/session review, dependency and license inspection,
> and the executable suite `apps/api/test/omnichannel-security.test.ts`.

## 1. Threat model

| # | Threat | Path considered | Control (where) | Residual |
| --- | --- | --- | --- | --- |
| T1 | Cross-channel identity resolution links the wrong customer | heuristic phone/e-mail match, ambiguous matches | exact stable ids/verified hints win; ambiguity is a review state, never guessed; manual link requires `identityLink` and writes an audit row (`omnichannel-identity.service.ts`) | Dedicated tables have no per-record ACL (audit G7), so visibility is entity-level |
| T2 | Public chat abused or read by the wrong visitor | `/api/v1/Omnichannel/chat/*` | 256-bit visitor key, only its SHA-256 stored; `httpOnly`, `SameSite=Lax`, path-scoped cookie; mutations require an allowlisted `Origin` and fail closed when none is configured; per-session message window is one atomic UPDATE; per-address new-session budget; client message ids namespaced by session | A non-browser caller can spoof `Origin`; the session budget and body caps bound that abuse. Legitimate visitors behind one NAT share the budget (configurable `maxSessionsPerHour`) |
| T3 | Webhook spoofing | provider callback routes | adapter signature required; constant-time HMAC compare; replay window where the provider timestamps; routing pair must agree; rejected callbacks recorded but never enqueued; valid processing uses the authenticated payload (`voice-webhook-ingress.service.ts`, `voice-provider-crypto.ts`) | Twilio does not timestamp callbacks, so freshness relies on dedup retention (see §7) |
| T4 | Forged callback blocks the genuine one (receipt poisoning) | pre-validation receipt insert | rejected receipts use `rejected:<payload digest>` keys that cannot collide with a genuine event's dedup key; the genuine callback then inserts and processes normally | An attacker can still write rejected rows at the global request rate limit |
| T5 | Internal-note leakage to a customer or generic consumer | timeline, export, hand-off excerpt, AI context, widget, analytics | `is_internal_note = false` in every customer-facing SQL; the owner timeline is **customer-safe by default** and agent surfaces opt in (`includeInternalNotes: true`); export filters in SQL and reports only `hasInternalNotes` | Agent-authorized endpoints (workspace, Voice inbox) intentionally show notes |
| T6 | Attachment exfiltration or internal file sent to a customer | outbound message with `mediaAttachmentIds` | each attachment must be readable by the sender through `AttachmentService.getById` and must be `visibility = 'public'`; checked before the message row/dispatch | A public attachment the sender can read is intentionally sendable |
| T7 | Recording/media URL exposure | `GET action/calls/:id/media` | list applies the same parent-call access rule as playback; provider URLs are no longer serialized (bytes only through authorized playback) | Playback authorization is the call's assignee/team rule, not metadata ACL |
| T8 | Provider credential theft | account administration and diagnostics | AES-256-GCM at rest with random IV; responses expose presence booleans only; no secret or hint beyond last-4 on owner views; operations projection never selects ciphertext | `ENCRYPTION_KEY` custody and rotation remain deployment responsibilities |
| T9 | CSRF / session abuse | CRM cookie auth and public chat | CRM accepts bearer by default and enforces the double-submit `CRM-CSRF`/`x-csrf-token` for cookie auth; web chat has no CRM authority; CORS is not opened by this module | The platform default (`CORS_ORIGINS` empty) reflects any origin with credentials — see §7 |
| T10 | Replay of a valid callback | authorized replay and provider retry | one receipt per dedup key; replay is `opsReplay`-gated and refuses rejected signatures; message state advances through the rank guard; replay reports its idempotent/refused effects | Twilio replay after receipt retention; worker effects are at-most-once per normalized event |
| T11 | Message injection into an agent surface | visitor/agent message bodies, links | React text rendering only (no `dangerouslySetInnerHTML` for messages); zod length caps; no markdown/linkify | Attachments are download-only; there is no rich-text message surface |
| T12 | AI prompt injection | customer text in a suggestion prompt; model-invented tool arguments | typed tasks; context limited to customer-visible messages; `<conversation>` data wrapper; delimiters and role prefixes neutralized; tools come from the registry, never from content; `material_write` send requires approval; run/tool bound to the originating conversation and actor | A model may still follow injected instructions *within* the tools and ACL it was given; the approval step is the last human gate |
| T13 | Unauthorized export | `GET action/conversations/:id/export` | `settingsManage` + conversation read ACL; only customer-visible messages; audit row with counts; note count not disclosed | Entity-level read ACL (G7) |
| T14 | SSRF through provider endpoints | stored provider URLs | `assertHttpUrl` refuses credentials-in-URL, non-HTTP(S), metadata hosts; redirects are not followed; requests timeout and responses are capped; no endpoint override API | DNS resolution/private-IP ranges are not blocked; endpoints are administrator-supplied and should point at trusted hosts |

## 2. Fixes delivered in this phase

| Severity | Issue | Fix | Proof |
| --- | --- | --- | --- |
| High | Web-chat mutations were accepted without an `Origin` when an allowlist existed | `requireChannel` requires an allowlisted origin for every mutation and refuses when the allowlist is empty | `omnichannel-security.test.ts` "web-chat mutations fail closed…" |
| High | A captured/forged callback could occupy the genuine dedup key | Rejected receipts use a namespaced digest key | same suite "a forged callback cannot poison…" |
| High | Customer-facing timeline default included internal notes | `includeInternalNotes` defaults to false on the owner; only agent surfaces opt in | same suite "owner timeline is customer-safe…" |
| Medium | Diagnostic receipt payloads contained bodies and phone numbers | `redactPayload` masks content/address/URL fields; a new `payload_internal` column keeps processing exact | same suite (inspection vs internal copy) and migration 082 |
| Medium | Per-session rate window was read-modify-write and sessions were free | atomic conditional UPDATE + `maxSessionsPerHour` per address budget | same suite "budget survives cookie rotation…" |
| Medium | Two visitors using the same client id shared one idempotency row | provider ids are namespaced by session and unwrapped for the widget | same suite "scopes visitor client ids per session" |
| Medium | An attachment could be sent without a read check or customer visibility | ACL + visibility check before insert/dispatch | same suite "refuses to send an attachment…" |
| Medium | Media listing skipped the parent-call access rule and exposed provider URLs | same access rule as playback; `providerRef` removed from the view | `voice-communications-inbox.test.ts` outsider list 404 |
| Medium | AI run reads ignored the authorizing conversation; the send tool accepted any conversation | run is bound to its conversation at creation and verified on read/execute | same suite "binds an AI run…" |
| Low | Export truncated in JS and disclosed the note count | filter in SQL; `excluded.internalNotes` is a boolean | same suite "exports notes-free content…" |
| Low | `SessionBody` parse result was discarded | invalid session bodies are refused | controller change |
| Low | Transcript could close the `<conversation>` block | delimiter/role markers are neutralized | `omnichannel-ai.service.ts` |
| Low | `triggerRun` could never start an integration run (manual-only check fired first) | internal trigger path is explicit; Omnichannel uses it | `ai-agent-runs.service.ts` + AI suite |

## 3. ACL position

- Every workspace route asserts one of the synthetic capabilities from
  `omnichannel-module.ts` (`inboxView`, `reply`, `assign`, `identityLink`, `connectionManage`,
  `opsRead`, `opsReplay`, `settingsManage`). Some routes assert inside their service (analytics,
  drafts, snippets, hand-off, operations); the capability matrix remains the single gate.
- Public routes are exactly: web-chat session/messages (visitor cookie) and provider callbacks
  (adapter signature). No CRM data is reachable through either without the visitor's own session or
  a valid signature.
- Conversation, message and receipt tables are **dedicated** (D1), so they have no metadata
  record-level ACL (audit G7). A role granted `team` or `own` on `CommunicationConversation` behaves
  like `all` for these tables; the module documents this and operations roles should be granted
  deliberately. Adding a record ACL for dedicated tables is a platform-level project, not an
  Omnichannel patch.
- `queueManage` is declared in the capability matrix but no route asserts it yet; queue editing
  continues to go through ServiceDesk's own permissions.

## 4. Redaction and retention

| Data | Diagnostic/API exposure | Stored | Retention owner |
| --- | --- | --- | --- |
| Webhook payload | masked (`body`, `from`, `to`, `email`, phone/address, URL); proof `payload_digest` | `payload_redacted` (safe) + `payload_internal` (not exposed) | receipt rows; owner retention |
| Message body | customer surfaces only customer-visible rows; export/notes excluded | `voice_messages` | Voice/message retention |
| Identifiers (phone/e-mail) | serialized only on agent-authorized conversation views; diagnostics mask them | owner tables | Voice retention |
| Recording URLs | no longer serialized; playback only | `voice_media.provider_ref` | `voice_media.retention_at` sweep |
| AI prompts/results | run view requires `reply` + run ownership/binding; prompts contain customer-visible text only | `ai_agent_runs.input/result` | AIAgents retention |
| Logs/errors | no credential, raw payload, address or message body is logged by the module | — | — |

## 5. Resilience scenarios

| Scenario | Behaviour | Verified by |
| --- | --- | --- |
| Duplicate callback | second receipt refused; one normalized event, one message | `omnichannel-ingress.test.ts`, operations replay test |
| Out-of-order status | unknown provider ids are ignored, never invented; the state rank guard rejects backwards moves | `voice-communications-messaging.test.ts` |
| Unknown send outcome | recorded `unknown`, no automatic retry; reconcile asks the provider | `omnichannel-send.test.ts` |
| Provider throttling / timeout | refusal categories and `unknown` without a failed timestamp | send/policy suites |
| Worker restart | durable receipt + job, idempotent replay | operations suite |
| Retry exhaustion | `outcome_unknown`/failed terminal states are not auto-retried | AIAgents state machine, send tool comment |
| Kill switch | outbound refused `account_disabled`, inbound still recorded, history intact | `omnichannel-operations.test.ts` |

## 6. Dependencies, licenses and provider terms

`pnpm audit --prod` before this phase: **44 advisories (14 high, 24 moderate, 6 low, 0 critical)**.

Overrides added in the root `package.json`:

- `fastify` → `5.12.5` (nested copy under `@nestjs/platform-fastify` was 5.11.3),
- `fast-uri` 3.x → `3.1.9`, 4.x → `4.1.4`.

Fastify 5.12 intentionally disables numeric `trustProxy` (hop counts cannot validate the immediate
peer). `TRUST_PROXY` now accepts `false`, `true`, or an IP/CIDR list; a hop count refuses startup
with an explicit message instead of silently trusting spoofable headers.

After the overrides: **28 advisories (6 high, 18 moderate, 4 low, 0 critical)**. The remaining high
advisories are `nodemailer@6.10.1` (5: `raw`-option file read/SSRF, DoS) and `zod@3.25.76`
(1: memory exhaustion on extreme inputs). Both are platform-wide, not Omnichannel-specific:

- the mail sender does not use nodemailer's `raw` option, and outbound mail composition is
  server-controlled; upgrading to nodemailer 7 with matching types is tracked for the mail owner;
- request bodies are capped (Fastify body limit, upload limits) and the API is rate-limited, which
  bounds the zod input-size class; zod 4 is a breaking migration across every DTO and is scheduled
  as a platform task.

Licenses: all direct runtime dependencies are MIT except `grapesjs` (BSD-3-Clause). No GPL/AGPL
runtime dependency was found. The repository has **no LICENSE file** and no `license` field — an
unresolved legal/compliance question that must be decided by the project owner before distribution.

Provider terms: channel prerequisites and contractual constraints are recorded in
`channel-feasibility.md` (Twilio, Meta, Telegram) and `feature-contract.md` §1. No new connector was
added in this phase. Open terms questions: WhatsApp template pre-approval, Meta's 24-hour window
enforcement, Twilio recording-consent rules — these are product/legal review items, not code.

## 7. Residual risks and owners

1. **Dedicated-table record ACL (platform).** `team`/`own` grants are not enforced per conversation;
   customers of this module should grant entity-level `All` or leave the capability ungranted. This
   is the recorded G7 audit limitation.
2. **Twilio callback freshness (Voice).** Twilio sends no timestamp; a captured callback is deduped
   but can replay after receipts are purged. The adapter's signature covers URL + parameters.
   Mitigation: retain receipts at least as long as the provider's retry window.
3. **CORS default (platform).** With `CORS_ORIGINS` unset the API reflects any origin with
   `credentials: true`. Deployments should set `CORS_ORIGINS`; changing the platform default is
   recommended before public exposure.
4. **Twilio form callbacks (Voice).** The API registers no `application/x-www-form-urlencoded`
   parser; a live Twilio form callback currently does not validate on the wire. Covered by the OM.23
   provider-sandbox step; not claimed as production-ready.
5. **AI trigger configuration (AIAgents).** Integration runs require the AIAgents `eventTriggers`
   feature and an agent whose trigger allowlist includes `integration`. The module refuses rather
   than pretending; operators must configure both.
6. **zod/nodemailer advisories (platform)** as in §6.
7. **SSRF private ranges (deployment).** Endpoint hostnames are validated but not resolved; only an
   administrator can set them. Restrict configuration access and use trusted hosts.

## 8. Verification

- `npx vitest run apps/api/test/omnichannel-security.test.ts` — 8/8.
- `npx vitest run apps/api/test/omnichannel-*.test.ts apps/api/test/voice-*.test.ts apps/api/test/ai-agents.test.ts apps/api/test/ai-providers.test.ts` — 29 files / 274 tests green.
- AI run suite: 25/25 with temporary concurrency headroom; the configured database holds two
  pre-existing queued demo runs (2026-10-24) that exhaust the default instance limit of 2. The
  settings row was restored byte-for-byte after the check.
- Migration 082 applied through `pnpm db:migrate` (additive: one nullable column, one index).
- Typecheck, lint, UI conventions and web build clean.
