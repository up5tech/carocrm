# Omnichannel — release readiness (19-OM.23)

> Phase 19-OM.23 report (`PLAN_Phase_19_Omnichannel.md` §14). It records what is supported, what was
> verified, what must be configured, measured performance, upgrade steps, open risks and the
> connectors that remain disabled. Setup steps are in `admin-setup.md`; incidents in `runbook.md`.

## 1. Support matrix (release scope)

| Channel | State | Evidence | Production claim |
| --- | --- | --- | --- |
| Website chat | **Supported** | session/consent/rate/origin + widget; `omnichannel-webchat`, `omnichannel-security` suites | Yes, self-hosted widget; operator must name allowed origins |
| SMS (Twilio adapter) | **Release candidate** | full chain through the in-process simulator; Twilio adapter unit-tested (`voice-provider-twilio-asterisk`) | Not claimed production-ready: a live Twilio form callback has not been validated (no `application/x-www-form-urlencoded` parser; see §7) |
| WhatsApp (Twilio adapter) | **Release candidate** | same adapter path; template/window rules enforced in the policy layer | Not claimed production-ready for the same reason plus sender/template approval |
| Voice calls | **Context only** | call list + link to a conversation (OM.13); playback ACL'd | Not a conversation channel in this release |
| MMS | **Unsupported** | catalog row `supported: false`; sends answer `unsupported` (CF-5) | No |
| Messenger / Instagram | **Disabled (NO-GO)** | OM.15 review; no adapter, no catalog row, DB channel CHECK | No |
| Email / Telegram | **Disabled (gated)** | OM.16 review; no adapter/rows; null inbound provider | No |

The acceptance line "core inbox works with at least the first fully supported channel" is met by the
web chat channel and by the SMS/WhatsApp path **through the simulator**; a live Twilio account is a
required external precondition, not a code claim.

## 2. Verification performed

| Check | Result |
| --- | --- |
| `omnichannel-e2e.test.ts` (full chain + degradation + release surfaces + performance) | 4/4 |
| `omnichannel-security.test.ts` (OM.22) | 8/8 |
| Omnichannel + Voice + AI non-run regression | 29 files / 274 tests |
| AI run suite (`ai-agent-runs`) | 25/25 with temporary concurrency headroom; two pre-existing queued demo runs exhaust the default instance limit of 2, settings restored byte-for-byte afterwards |
| API/root typecheck, web typecheck | clean |
| ESLint on changed modules, UI conventions | clean |
| Workspace build (`pnpm -r build`) | clean |
| Migration ledger (077–082) | present; re-running `pnpm db:migrate` applies nothing |
| `pnpm audit --prod` | 28 advisories (6 high, 18 moderate, 4 low); remaining highs are nodemailer 6 and zod 3, documented in `security-hardening.md` §6 |
| Browser checks (earlier phases) | OM.2 diagnostics, OM.9 widget E2E, OM.10 inbox filters, OM.21 operations probe — no console errors |

### Full-chain evidence (simulated SMS)

One signed inbound callback was processed through the shared receipt pipeline and produced exactly
one canonical conversation. The identity review matched the single readable Contact by normalized
phone (`exact`, `contact_resolver`, `unique_address_match`). A ServiceDesk conversation rule routed
it to its queue and agent (decision named the rule id, queue and assignee). An ordinary agent (not
admin) replied through the workspace; the fake adapter returned a provider message id and state
`sent`. A signed `message.status` callback advanced the message to `delivered` with `delivered_at`.
The inbox projection from the agent's token carried the customer address (CRM context through the
reviewed identity). The optional hand-off created one Case, linked it, recorded the `handoff`
transition, and its description contained the customer message but not the internal note.

## 3. Required customer configuration

Full steps in `admin-setup.md`; the checklist is:

1. `omnichannel.features.workspace = true` and at least one channel account enabled in Voice.
2. Provider account: capabilities (`messaging.*.send/receive`, `webhook.signatureValidation`),
   credential/vault entry, webhook secret, endpoint; webhook URL registered at the provider.
3. Voice feature flag for the channel (`features.sms` / `features.whatsapp`) and a default account.
4. Consent basis and opt-out process for the jurisdiction; WhatsApp templates approved.
5. Web chat: `enabled`, non-empty `allowedOrigins`, consent text/version, session hours, message and
   session budgets.
6. ServiceDesk: queues with `acceptsConversations`, members, conversation-targeted routing rules
   (and optional business calendar).
7. Roles: `inboxView`, `reply`, `assign`, `identityLink`; `opsRead`/`opsReplay` for operations;
   `settingsManage`/`connectionManage` for administrators. Provider-account administration remains
   `VoiceProviderAccount` (admin).
8. Optional AI: published agent whose trigger allowlist includes `integration`, AIAgents
   `eventTriggers` enabled, and the agent id in `omnichannel.ai.agentId`.

## 4. Provider prerequisites, scope, costs and quotas

| Provider | Prerequisites | Approved scope in this release | Costs / quotas |
| --- | --- | --- | --- |
| Twilio SMS | Account, sender number, US A2P 10DLC registration where applicable, credential, webhook secret | Outbound text, inbound text, delivery statuses; media declared by the adapter but MMS is not released | Provider per-message and number fees; provider rate limits; local limits: `maxMessagesPerMinute` (web chat), per-session budgets, 10 attachments per message |
| Twilio WhatsApp | WhatsApp Business Account and sender approval, approved templates, 24-hour customer-service window | Text/template sends inside policy; inbound messages; statuses | Provider conversation/template fees; template approval lead time; provider throttling |
| Website chat | None beyond this deployment | Anonymous visitor sessions; text only | Self-hosted; local budgets only |
| Meta Messenger/Instagram | Reviewed app, published Page/professional account, permissions, 20 s webhook ack | **Not approved** | — |
| Email/Telegram | Mailbox/connector decision, Bot API token and secret header | **Not approved** | — |

No price is hard-coded: costs follow the provider's current list/contract and must be confirmed by
the customer. A live connector is only "production-ready" after the provider account setup below is
verified on a sandbox number.

## 5. Performance and limits (measured 2026-10-26)

Measured on the configured development database (local machine, demo data present), single run,
container-free Node process; treat as an order-of-magnitude budget, not a benchmark:

| Operation | Data | Measured | Ceiling asserted |
| --- | --- | --- | --- |
| Seed 150 conversations / 400 messages | through the owner ingest path | 1 065 ms | — |
| `GET action/conversations?limit=25` | 150 conversations, enrichment for 25 | 12 ms | < 2 000 ms |
| `GET action/conversations/{id}/timeline?limit=50` | 100-message conversation | 10 ms | < 1 500 ms |

Relevant indexes (all present): `voice_messages(conversation_id)`, `voice_messages(state)`,
`voice_messages(thread_id)`, unique `(account_key, provider_message_id)`, unique idempotency,
`voice_conversations(status|assignee|queue|team|status+snooze|last_message|case)`,
`voice_conversation_participants(address|entity)`, threads
`(conversation_id)`/unique address/external, webhook receipts `(status/provider)` + unique dedup,
visitor sessions `(expiry/conversation/ip_hash,first_seen_at)`.

Documented caps: inbox/timeline page ≤ 100 rows; web-chat history 100 messages per read; export
5 000 messages; 10 attachments per message; 20 000-character message body (web chat defaults 2 000);
AI context ≤ 50 messages (1 000 characters each); 200 validation candidates per identity resolution;
receipt body ≤ 256 KB; provider response ≤ 1 MB with a 15 s timeout.

## 6. Installation and upgrade (existing database, no reset)

1. Back up the configured database.
2. Run `pnpm db:migrate`. Omnichannel migrations 077–082 are additive: new tables, nullable columns,
   indexes and CHECK widenings; no table is dropped and no row is rewritten.
3. Re-run `pnpm db:migrate` — it must report no applied files.
4. `pnpm -r build`, restart the API and web app.
5. Verify `GET /api/v1/Omnichannel/action/health` (dependencies present), then the channel catalog.

No second database, shadow database, truncation or reset is used by any script in this repository.

## 7. Open risks and disabled connectors

1. **Live Twilio callbacks are unverified.** Fastify has no form-urlencoded parser registered, so a
   real Twilio callback does not validate on the wire yet. Required before claiming Twilio
   production readiness; planned as the first task after this phase.
2. **Twilio callback freshness.** No timestamp in Twilio's scheme; dedup is the only replay
   protection. Retain receipts at least as long as the provider retry window.
3. **Dedicated-table record ACL (platform G7).** Conversation/message tables are entity-gated only;
   `team`/`own` behaves like `all`. Grant deliberately and treat operations roles as trusted.
4. **Dependency advisories.** nodemailer 6 and zod 3 highs remain platform-wide; mitigations and the
   upgrade plan are in `security-hardening.md` §6.
5. **No repository LICENSE.** Legal/compliance decision required before distribution.
6. **Meta, Instagram, email, Telegram, MMS remain disabled** — no adapter and no production claim.
7. **AI integration trigger** requires both the AIAgents feature flag and the agent trigger
   allowlist; without them suggestions refuse (human work is unaffected).
8. **Provider-specific legal rules** (WhatsApp templates/window, Twilio recording consent) need
   customer/legal confirmation; they are not inferred by the code.

## 8. Release notes (first release)

Usable now: web chat widget with consent/origin/rate controls; a multi-channel inbox with history,
internal notes, unread/priority/tags/snooze/queue filters; deterministic queue routing and
team/agent assignment with concurrency guards; customer identity review with explainable auto-match
and audited manual link/unlink; Twilio SMS/WhatsApp send/receive/status through the adapter and
simulator; ServiceDesk Case hand-off; snippets and per-agent drafts; canned replies; conversation
analytics; AI drafts and an approval-gated send tool; operations diagnostics, replay and kill switch;
retention/export and the security controls from OM.22.

Deliberately absent: Meta/Instagram/email/Telegram/MMS transports, autonomous AI replies, workforce
optimization, social listening, sentiment analytics, live-update streaming (polling interim, E11),
and per-record ACL for dedicated tables.

## 9. Verification commands

```bash
pnpm db:migrate                       # 077–082 already applied -> no pending files
npx vitest run apps/api/test/omnichannel-e2e.test.ts
npx vitest run apps/api/test/omnichannel-*.test.ts apps/api/test/voice-*.test.ts
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
node scripts/check-ui-conventions.mjs
pnpm audit --prod
pnpm -r build
```
