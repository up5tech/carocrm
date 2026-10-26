# Omnichannel (Phase 19-OM) — overview & implementation log

> Living log for `PLAN_Phase_19_Omnichannel.md` §14 ("after each sub-phase, update
> `docs/omnichannel/overview.md` or an implementation log"). Newest entry first.

## Sub-phase status

| Sub-phase | Status | Deliverables |
| --- | --- | --- |
| OM.0 — Repository audit | ✅ COMPLETE | `repository-audit.md`, `capability-matrix.md`; decisions D1–D3 locked in plan §0.2 |
| OM.1 — Feature contract & channel feasibility | ✅ COMPLETE (documentation only) | `feature-contract.md`, `channel-feasibility.md`, risk log update (contract §12) |
| OM.2 — Module registration & navigation | ✅ COMPLETE | `apps/api/src/omnichannel/` (descriptor, permission matrix, settings document, health, nav, control plane), nav seed, `/omnichannel` SPA shell, i18n en/vi, `omnichannel-module.test.ts` |
| OM.3 — Persistence model & additive migrations | ✅ COMPLETE | `database/migrations/077_phase19_omnichannel_persistence.sql`, `omnichannel-persistence.test.ts`, voice architecture §4.1 |
| OM.4 — Adapter & capability registry | ✅ COMPLETE | Voice barrel exports (E1), `unsupported` category (E3), `inbox.read`/`message.send` contracts (E14), `OmnichannelCapabilityService` + `action/channels`, page catalog card, `omnichannel-adapter.test.ts` |
| OM.5 — Inbound webhook/event receipt pipeline | ✅ COMPLETE | `omnichannel-webhook.controller.ts` (delegates to the shared Voice ingress), E2 raw-body hook, `omnichannel-ingress.test.ts` |
| OM.6 — Canonical conversation/thread/message services | ✅ COMPLETE | thread attach + continuity + reconcile in Voice; `OmnichannelConversationService` facade + conversation endpoints; `omnichannel-conversation.test.ts` |
| OM.7 — Identity resolution & record linking | ✅ COMPLETE | `OmnichannelIdentityService` + identity endpoints, migration 078 phone index, `omnichannel-identity.test.ts` |
| OM.8 — Outbound command & send state | ✅ COMPLETE | workspace send endpoint (facade pre-checks), timeout → `unknown` in Voice, `omnichannel-send.test.ts` |
| OM.9 — Website chat channel | ✅ COMPLETE | migration 079 visitor sessions + web-chat connection, local adapter, public `/chat` API + widget page, `omnichannel-webchat.test.ts` |
| OM.10 — Agent inbox workspace | ✅ COMPLETE | two-tab module page, server-side workspace filters, timeline/composer/identity panels, `omnichannel-inbox.test.ts` |
| OM.11+ | ⏸ Not started | — |

## Decisions index (locked)

- **D1/D2/D3** (plan §0.2) — canonical record = `voice_conversations` family; queues/routing =
  ServiceDesk extended; realtime = shared publish seam + module-scoped SSE. Carried into OM.1
  unchanged; refined in `feature-contract.md` §2.
- **OM1.1–OM1.7** (first channel set, first E2E path = Twilio SMS/WhatsApp, deferred channels,
  thread cardinality, transport via Voice's adapter, AI drafts-only) — `feature-contract.md` §1.
- **Per-channel verdicts** — `channel-feasibility.md` summary table (GO: CF-1, CF-2;
  conditional: CF-3 context, CF-4 web chat; all others NO-GO/EXCLUDED for the first release).

## Log

### 2026-10-26 — Phase 19-OM.10 (Agent inbox workspace)

- Owner-side: `VoiceInboxService.list` gained the workspace filters (priority, language, tag,
  unread-only, snooze state, queue) plus an `unassigned` scope — all SQL, ACL-scoped, mapped to the
  migration-077 indexes; totals remain server-computed.
- Facade projection: each conversation now carries the customer participant (name/address) beside the
  OM.6 workspace fields and threads.
- UI: `/omnichannel` became Tabs (Inbox default, Diagnostics unchanged); `InboxPanel` implements the
  filter bar, list with unread/priority/snooze markers, escaped-plain-text timeline with internal-note
  distinction, reply/note composer, status and assign/unassign actions, channel threads and identity
  review with linking. Polling (10 s list / 8 s timeline) is the documented interim until E11.
- Checks: `omnichannel-inbox.test.ts` 3/3; regression 14 files / 127 tests; typecheck/lint/ui-
  conventions/build clean; live browser pass (list + timeline + channel filter empty state, no
  console errors). Cursor pagination and the D3 realtime swap are recorded as deferred roadmap items.


### 2026-10-26 — Phase 19-OM.9 (Website chat channel)

- Migration 079: `omnichannel_visitor_sessions` (hashed key, consent evidence, expiry, rate window,
  conversation link) + the single seeded `omnichannel-web-chat` connection row. No second
  conversation store.
- Voice: `web_chat` added to the message channel/capability vocabulary; the Omnichannel-owned local
  adapter is registered into `VoiceProviderRegistry` at boot, so both directions use the canonical
  services; policy evaluation is skipped for exactly this channel (documented; consent is enforced
  by the session service before ingest).
- Public `/api/v1/Omnichannel/chat/{session,messages}` (cookie session, fail-closed origin allowlist,
  consent, rate window, honeypot, idempotent client ids) + widget page `/chat` (en/vi) outside the
  CRM session. Widget reads only `is_internal_note = false` rows of its own conversation.
- Checks: `omnichannel-webchat.test.ts` 9/9; regression 16 files / 197 tests; typecheck/lint/build/
  ui-conventions clean. Sessions/conversations created by the suite are removed by its own marker;
  the shared `omnichannel` settings row is restored byte-for-byte.


### 2026-10-26 — Phase 19-OM.8 (Outbound command, send state, reconciliation)

- Workspace reply command `POST action/conversations/:id/messages` (capability `reply`): the facade
  pre-checks the conversation, the computed channel capability and the payload type, then delegates to
  `VoiceMessagingService.send`. Attachments are refused as `unsupported` until an adapter declares
  media; a disabled/unconfigured channel is `channel_unavailable`; policy/consent refusals pass
  through as named codes.
- Voice send honesty: timeout outcomes are recorded `unknown` (no `failed_at`), not `failed` — the
  reconcile path (E7) or an explicit operator review resolves them; a same-key retry returns
  `duplicate` and dispatches nothing. Provider status stays separate per event
  (`voice_communication_events.payload.vendorStatus`) from the canonical message state.
- Checks: `omnichannel-send.test.ts` 6/6 incl. a scripted timeout adapter registered through the DI
  seam (one row, one call, no blind retry); regression 14 files / 150 tests; typecheck + eslint clean.


### 2026-10-26 — Phase 19-OM.7 (Identity resolution and record linking)

- Migration 078: expression index `idx_entity_records_phone_digits` mirroring the resolver's exact
  predicate (`regexp_replace(coalesce(attrs->>'phoneNumber',''), '[^0-9]', '', 'g')`, live
  Contact/Lead/Account). Verified by EXPLAIN: Bitmap Index Scan instead of a table scan.
- `OmnichannelIdentityService`: review persists evidence on the customer participant (exact/verified
  for one readable match; disputed/heuristic + auto-link dropped for ambiguity; counts-only for
  hidden matches), manual link/unlink through the ACL-aware entity service with an `audit_log` row
  carrying the reason, and a conflict list for staff review. Manual decisions are never overwritten
  by re-resolution. Endpoints: `GET …/:id/identity`, `POST …/:id/identity/link`,
  `POST …/:id/identity/unlink`, `GET action/identities/conflicts` (capabilities inboxView /
  identityLink).
- Checks: `omnichannel-identity.test.ts` 6/6 (unique link evidence, ambiguity not guessed, audit rows,
  review-vs-mutate separation, index presence); regression 11 files / 109 tests green; typecheck +
  eslint clean. Data: `AGENT_TEST_OM7_*` contacts, one consent + recipient, settings restored.


### 2026-10-26 — Phase 19-OM.6 (Canonical conversation, thread and message services)

- Owner-side (VoiceCommunications): `VoiceMessagingService` attaches inbound/outbound messages to a
  channel thread (E6) — `findThread` → existing conversation, else the conversation's own thread,
  else the address-based continuity rule (same normalized address on another open channel attaches a
  thread; closed/spam never reopened; no merging by Contact), then `attachThread` with the partial
  unique indexes as the race guard. Thread id is stored on `voice_messages.thread_id`; participants
  carry account/channel; inbound timestamps are validated; `last_message_at` is maintained.
- E7: `getMessageStatus` added to `VoiceProviderAdapter` (Twilio reads the Message resource; the
  simulator scripts its answer), and `VoiceMessagingService.reconcileMessage` polls only non-terminal
  messages (rank guard) and refuses `unsupported` when the provider offers no lookup — the send is
  never repeated to "find out".
- Omnichannel: `OmnichannelConversationService` composes the exported services (list/timeline/
  threads/mark-read/status/assign/reconcile) and adds the read-only workspace projection
  (priority/tags/queue/snooze/version + threads). Endpoints:
  `GET action/conversations`, `…/:id/timeline`, `…/:id/threads`, `POST …/:id/read`,
  `…/:id/status`, `…/:id/assign`, `POST action/messages/:id/reconcile`. No SQL write to the records
  lives in the module (source-scan test).
- Checks: `omnichannel-conversation.test.ts` 6/6 through the real webhook→worker pipeline; full
  regression 13 files / 176 tests green; typecheck + eslint clean. Test data: `agent_test_om6_*`
  account, consent rows for one phone, Voice settings row snapshotted and restored byte-for-byte.


### 2026-10-26 — Phase 19-OM.5 (Inbound webhook/event receipt pipeline)

- The plan's "reuse an existing shared webhook ingestion service" option, taken literally:
  `POST /api/v1/integrations/omnichannel/{providerKey}/{accountKey}/{kind}`
  ([omnichannel-webhook.controller.ts](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/omnichannel/omnichannel-webhook.controller.ts))
  delegates to the exported `VoiceWebhookIngressService` — account resolution, body ceiling, replay
  window, adapter-owned signature validation, the durable dedup receipt in `voice_webhook_events`,
  fast 202, job processing and admin replay all run unchanged. **No second receipt store, no second
  normalization path** (R1; the two prefixes are aliases over one pipeline).
- **E2 delivered**: `bootstrap.ts` raw-body `preParsing` allowlist gains the Omnichannel prefix — the
  exact bytes are preserved (and forwarded to the adapter through the ingress contract) so a future
  byte-signing provider (Meta, 19-OM.15) can verify what Twilio-style reconstruction cannot. The
  parsed body still flows normally; esignature's tolerant-parser branch untouched.
- Descriptor: `OMNICHANNEL_WEBHOOK_PREFIX` exported as a single source for route + hook; prefix is no
  longer "reserved only".
- Checks: `omnichannel-ingress.test.ts` 5/5 — signed callback records one receipt + exactly one job;
  repeated event answers duplicate with no second row; forged signature → 401 and is *recorded*
  (`INVALID_SIGNATURE`, never queued); unknown kind and provider/account mismatch → 404; no secret or
  raw content in responses; `information_schema` proof no `omnichannel_webhook*` table exists. Broad
  regression 11 suites / 144 tests green incl. `attachments-storage` (the raw-body hook change) and
  the Twilio/Asterisk adapter suites. api typecheck + eslint clean; no frontend change in this phase.
- Fake provider only — no external host contacted, no real message (audit §10 policy inherited).

### 2026-10-26 — Phase 19-OM.4 (Adapter and capability registry)

- **E1**: the Voice barrel now exports the consumed surface — `VoiceInboxService` + query/view types,
  `VoiceMessagingService` + `SendMessageInput`/`MessageView`, the `VoiceProviderAdapter` interface,
  provider event/health/account types, and the normalized vocabulary (channels, states, capability and
  error-category constants, `isRetryableError`).
- **E3**: `unsupported` added to `COMMUNICATION_ERROR_CATEGORIES` — permanent, non-retryable, with an
  operator message; exhaustive switch updated (`errorMessageFor`).
- **E14**: `voice-contracts.ts` publishes `voiceCommunications.inbox.read` (runs through the owner's
  ACL; conversation list or timeline) and `voiceCommunications.message.send` (runs the owner's full
  policy/consent/idempotency pipeline; records the owner's state, never a competing one), v1 each,
  beside the existing suppress contract.
- Omnichannel: `OmnichannelCapabilityService` + `GET /api/v1/Omnichannel/action/channels`
  (catalogVersion 1) — computed per-channel capabilities from bound accounts' declared ∩ granted
  sets + both modules' flags; no assumed support (readReceipts has no capability key → reported absent;
  web_chat reports "arrives with 19-OM.9"). Workspace page gained a "Channel capabilities" card;
  i18n en/vi extended.
- E15 stays closed: transport remains Voice's adapter; nothing was routed through `ConnectorAdapter`.
- Checks: `omnichannel-adapter.test.ts` 6/6 — including a source scan asserting the Omnichannel
  directory imports `../voice-communications/` **only** via `index.js`; regression across the 5 Voice
  suites + both earlier Omnichannel suites + AI contracts + i18n + navigation = 147+ green;
  api+web typecheck, eslint, ui-conventions, web build clean; live browser pass rendered the catalog
  (sms/whatsapp/web_chat rows with honest notes, no secrets in payload).
- Dev-server observation: the dev `voiceCommunications` settings has sms/whatsapp features off and
  `demo-voice` grants no messaging capability, so the catalog honestly reports outbound/inbound false
  until an operator binds an account — OM.5 will use the fake provider in tests, never live sends.

### 2026-10-26 — Phase 19-OM.3 (Persistence model and additive migrations)

- Migration `077_phase19_omnichannel_persistence.sql` (owned by `VoiceCommunications`, D1) applied to the
  configured DB. Strictly additive — no drop/rename/re-type, existing rows preserved.
- `voice_conversations`: `priority|category|language|tags|current_queue_id|assignment_version|last_message_at|last_outbound_at|snoozed_until|closed_at|version`; `current_queue_id → entity_records` ON DELETE SET NULL (queue is a ServiceDesk reference, not a Case dependency — R10).
- E6 `voice_conversation_threads` (N threads → 1 conversation) + `voice_messages.thread_id`; `external_thread_id` kept/written (deprecated); 1:1 backfill of thread + message links from existing data only.
- E5 participant identity columns (`provider_identity|verification_state|link_confidence|link_reason|last_seen_at|source_provenance|account_key|channel`) + partial-unique `uq_voice_participants_provider_identity`.
- `channel` CHECK widened to include `web_chat`; workspace query indexes (queue, snooze, last-message, unread, closed, participant-entity).
- Mid-phase correction: the identity backfill initially labelled agent participants as `exact/verified`; scoped to `role='customer'` (agent/system carry a platform assignment, not an address resolution). Applied data + migration both fixed.
- Checks: `omnichannel-persistence.test.ts` 5/5 (1:1 model, web_chat admitted, priority vocabulary, duplicate provider-identity + duplicate external-thread refused, no `omnichannel_conversation/message/queue` table); Voice (71) + navigation + i18n + omnichannel-module green; api typecheck + eslint clean; direct data-integrity queries confirm the backfill preserved the pre-existing demo conversation.
- **Pre-existing, out of scope:** `service-desk.test.ts` has 2 failures from a shared demo-seeded `serviceDesk` settings row (`queues/sla=true`) these non-isolating tests assume absent; unrelated to migration 077 (no tracked OM.3 change touches ServiceDesk). Noted, not fixed (AGENTS §10).
- Files: `database/migrations/077_...sql`, `apps/api/test/omnichannel-persistence.test.ts`, `apps/api/src/omnichannel/omnichannel-module.ts` (thread-store dependency + OM.3 phase), `docs/modules/voice-communications/architecture.md` §4.1, plan §14 OM.3, this log.
- Next (OM.4): export `VoiceInboxService`/`VoiceMessagingService`/`VoiceProviderAdapter` from the Voice barrel (E1) + publish the inbox-read and message-send cross-module contracts (E14) + the `unsupported` category (E3) — the preconditions OM.5+ depend on.

### 2026-10-26 — Phase 19-OM.2 (Module registration and navigation)

- Backend: new `Omnichannel` kernel module (`apps/api/src/omnichannel/`) registered in `AppModule`
  before the entity wildcard — descriptor (loadOrder 397, reserved webhook prefix, **zero owned
  tables** per D1), the nine synthetic permission resources of contract §10 (`OmnichannelConversation`,
  `OmnichannelMessage`, `OmnichannelAssignment`, `OmnichannelQueue`, `OmnichannelIdentity`,
  `OmnichannelConnection`, `OmnichannelOps`, `OmnichannelSettings`), the `omnichannel` settings
  document with the `features.workspace` switch, evidence-based health view, navigation visibility
  report, and the control-plane controller (`action/health|capabilities|nav|settings`, OpenAPI tag
  `omnichannel`). No placeholder endpoints.
- Wiring: `NAVIGATION_FEATURE_GATE` branch + `OMNICHANNEL_MENU_INVALIDATOR` resolver in
  `app.module.ts` (lazy `ModuleRef`, the CRMChat pattern); nav seed `omnichannel` (order 75, beside
  the inbox) gated on `OmnichannelConversation:read` + the workspace switch.
- Frontend: `/omnichannel` route + `OmnichannelPage` shell (server-answer tiles: foundation,
  modules built on, my capabilities; administrator workspace switch); `i18n/en|vi/omnichannel.json`.
- Corrections found while verifying: the queue-engine marker is the `CaseQueue` **metadata entity**
  (no `case_queues` table), the realtime seam marker is the `notifications` table, and the AI Agents
  marker is the `ai_agents` table (`AIAgent` is not a registered metadata entity — the same false
  negative exists in the esignature/lead-score markers; noted, not fixed there).
- Checks run: `apps/api/test/omnichannel-module.test.ts` 7/7; `navigation.test.ts` + `i18n.test.ts`
  16/16; api+web typecheck, eslint (touched files), `check-ui-conventions` 4730 keys, web build —
  all clean; live browser pass: page renders in vi with all foundation rows green, and toggling
  `workspace` off hid the sidebar entry on reload and on restored it (the non-admin 403 and menu
  filtering are covered by the API tests, not driven in the browser).
- Follow-up recorded, not done here: granting the new keys to non-admin/demo roles (E18/G21) is the
  OM.13 permission-model decision; E1/E2/E3/E14 preconditions (contract §13) land with OM.3–OM.5.
- Files: `apps/api/src/omnichannel/*` (7), `apps/api/src/app.module.ts`,
  `apps/api/src/admin-panel/navigation-defaults.ts`, `apps/web/src/AppRoutes.tsx`,
  `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`, `apps/web/src/pages/OmnichannelPage.tsx`,
  `i18n/en/omnichannel.json`, `i18n/vi/omnichannel.json`, `apps/api/test/omnichannel-module.test.ts`,
  plan §14 (OM.0/OM.1 notes + OM.2 status), this log.

### 2026-10-26 — Phase 19-OM.1 (Feature contract and channel feasibility)

- User-confirmed scope choice: **path A** (voice channels first, web chat second, email deferred)
  and channel set **SMS + WhatsApp + web chat**.
- Files added: `docs/omnichannel/feature-contract.md`, `docs/omnichannel/channel-feasibility.md`,
  this log. Plan §14 OM.1 marked COMPLETE. **No code, no migration, no metadata changed.**
- The two "decided here, not deferred" questions were answered: anonymous-visitor identity
  (contract §7) and the Email↔Email-to-Case non-competition contract (contract §15). Open
  question E15 closed in favour of Voice's own adapter (contract §1 OM1.6).
- Checks: documentation-only change — nothing to build or test; consistency cross-checked against
  audit §7–§9 and the live schema (`051_phase19_voice_communications.sql`, error taxonomy in
  `voice-communications-domain.ts:462`). Feasibility records carry an explicit re-verification
  duty before adapter coding.
- Next (OM.2): module skeleton per contract §3 F1 + preconditions §13 (E1/E2/E3/E14 are the
  earliest edits; E1 gates everything).

### 2026-10-25/26 — Phase 19-OM.0 (Repository audit)

- Audit + capability matrix written; D1–D3 locked in plan §0.2. No code changed.
