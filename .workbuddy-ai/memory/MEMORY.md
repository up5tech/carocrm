# Project memory — carocrmv2

Curated, long-lived notes. Daily logs live next to this file as `YYYY-MM-DD.md`.

## Module naming

- Phase-19 domain modules use **plain names**, not `Ua*` prefixes (`sales`, `projects`). `Ua*` names
  in `PLAN.md` are legacy; never introduce a `Ua`-prefixed id, prefix, class, settings row or i18n
  namespace. References *to other modules* may keep their ids (`ua-customer-success` etc. in
  `sales-module.ts` `OPTIONAL_INTEGRATIONS`).

## Repo conventions

- A domain module is a kernel directory `apps/api/src/<domain>` with a barrel exporting
  `<DOMAIN>_CONTROLLERS` / `<DOMAIN>_PROVIDERS`, spread into `AppModule` **before** the generic
  `:entity` wildcard controller.
- Records are metadata entities in `entity_records` (seed `database/seed-metadata.ts`); cross-record
  rules go on the `beforeValidate` hook so generic CRUD and domain commands are validated alike.
- Migrations: `database/migrations/<NNN>_phase<NN>_<slug>.sql`, additive only, applied in filename
  order, tracked in `schema_migrations`.
- Money is a canonical decimal string; `sales/money/decimal.ts` is the module's engine.
- Docs per module in `docs/modules/<module>/`; audits/reports in `docs/implementation/`.
- **`entity_records` has `created_at` + `modified_at`, never `updated_at`** — hand-written SQL must
  use `modified_at`.
- **`ON CONFLICT` cannot infer a partial unique index** unless the target repeats the predicate
  (`on conflict (inbox_id) where inbox_id is not null do nothing`).
- Conditional-UPDATE "claims" must be **leases** (push the due time forward), not version bumps.
- Kysely `RawBuilder` has **no** `executeTakeFirst(db)`: use `(await sql`…`.execute(db)).rows[0]`.
  Platform `ValidationError` → HTTP **422** (not 400); error body is
  `{ error: { code, message, details } }`.

## Marketing Automation (19-MA, complete)

- `apps/api/src/marketing-automation/`, `/api/v1/MarketingAutomation`, settings row
  `marketingAutomation`, 16 entity types in `entity_records`, migrations 037–043.
- Delivery is queue-driven (`marketing_recipient_deliveries`, `marketing.journeyRunBatch`); worker
  jobs call API endpoints with `x-worker-secret` **and** a session.
- Public surface is 5 routes; empty `MARKETING_WEBHOOK_SECRET` rejects every provider event.
- Docs `docs/marketing-automation/` + runbooks; report
  `docs/implementation/marketing-automation-completion-report.md`. 13 suites / 225 tests.

## Kernel `document` module

- `packages/document` (pure engine, optional pdfkit) + `apps/api/src/document` (`DocumentTemplate`).
  Sales quote render/send uses it end to end (`sales/document/quote-document.ts`).
- Unresolved placeholders stay in place and are reported in `warnings`. One default template per
  entity type. `document/action/preview` is admin-only.
- Metadata `acl.fieldPermissions` is **declarative only**; the evaluator reads the role row's own
  `field_permissions`. Rendering needs `DocumentTemplate: read`.

## Sales quote render/send (19-S.7)

- `POST /Sales/quote/:id/render|send`. Rendering is read-only; sending issues the draft then creates
  and queues an `Email` via `EmailService.queueSend` (the API never opens a socket).
- **Every gate runs before issuance** (`Email: create`/`edit` pre-checked), so a refused caller never
  leaves a `sent` quote with no email. Re-send returns `issued: false` and records a new email.
- An issued quote renders from `issuedData`, never the live catalog. No PDF attachment yet.

## Sales document engine invariants

- **A document cannot exist with zero lines** (`computeTotals` throws) — every create path carries
  `items`; no "blank draft" flow.
- `DocumentView` carries action *names* and their *descriptions*; UIs render descriptions.
- Provenance is `sourceEntity`/`sourceId`/`correlationId`; write `correlationId` or a retry creates a
  second document. Only `Quote`/`SalesOrder` have `opportunityId`.
- `sales-shapes.ts` hoists `IdSchema` near `DaySchema` (schemas evaluate at import → TDZ otherwise).

## Test seams

- Mail/queue suites: set `MAIL_TRANSPORT=memory` **and** `SMTP_FROM=<addr>` before `bootApi()` and
  restore in `afterAll` (`singleFork: true` leaks `process.env`).
- Stub the BullMQ hop (`JobsService.enqueue`) and assert durable side effects, not the hop.
- Workspace packages resolve through `dist/`: after changing a package run `pnpm install` then
  `pnpm build` before `pnpm typecheck`/API tests.

## Environment notes

- **Full-suite flake (pre-existing):** one-fork `pnpm test` aborts at random file boundaries;
  `attachments`, `attachments-storage`, `audit` crash at boot here. Run one file per
  `pnpm vitest run`.
- If a session has no shell, write the changes and record the exact commands instead of claiming
  verification.

## Customer Success (19-CS, shipped 2026-10-17)

- `apps/api/src/customer-success/`, id `CustomerSuccess`, entities keep the prefix.
  **`CustomerSuccessProfile` is a fixed name** — Sales' integration marker.
- **`User` and `Team` are identity tables, not metadata entities**; validate against `users`/`teams`.
- Entity ACL `delete: 'no'` blocks record DELETE even for admins — tests must remove such rows by id.
- `EVENT_TYPE`/`JOB_NAME` allow camelCase segments (`customerSuccess.health.statusChanged`).
- 19-CS.12 screens deliberately not built; docs `docs/modules/customer-success/`.

## Voice & Communications (19-VC.0–19-VC.17, 2026-10-19)

- `apps/api/src/voice-communications/`, id `VoiceCommunications`, `/api/v1/VoiceCommunications`,
  webhook prefix `/api/v1/integrations/voice-communications`, migrations **051–054**.
- **No metadata entity**: provider accounts, endpoints, receipts, normalized events, call sessions,
  conversations, participants, messages, media, consent, suppression, conversation history, snippets
  and transcripts are dedicated tables. The user-facing call record is the platform `Call` Activity.
- Adapters are classes inside the module (`VoiceProviderAdapter`), never modules. Only `fake`
  (simulator) exists; it resolves to `disabled` in production and **requires `sandboxRecipients`**.
  It never returns `delivered` — a send is `sent` until a callback says otherwise.
- Event namespace `voiceCommunications.*` (hyphenated names fail the `EVENT_TYPE` regex). Events carry
  ids/verbs only — never message bodies.
- Consent: MarketingAutomation is **email-only**; this module owns SMS/MMS/WhatsApp/voice consent
  (`voice_consent_events`, append-only) and suppression tombstones.
- Secrets: `ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret`, write-only with a masked hint. Enabling
  requires the credential (live) and the webhook secret (signature adapters) before the write.
- Ingress: body ceiling → replay window → adapter signature → `voice_webhook_events`
  (`unique(account_key, dedup_key)`) → `voiceCommunications.processWebhookEvent`. Processing is
  idempotent via `unique(webhook_event_id)` on `voice_communication_events`. Webhook kinds:
  `voice-events | message-events | status-events | media-events`.
- `phone-number.ts` exposes `PhoneNormalizer` via `PHONE_NORMALIZER`; default
  `LibPhoneNumberNormalizer` (`libphonenumber-js` 1.13.15), `ConservativePhoneNormalizer` fallback.
- Calls (VC.7–9): one session per `(account, provider_call_id)`, `advanceCallState` monotonic, one
  `Call` Activity created lazily through `EntityCrudService`; `idempotencyKey` makes double-click one
  call; incoming-call notification rows go to the assignee or endpoint team, number only.
- Messaging (VC.10–11): durable send (`queued → sent/failed`, policy checked twice), inbound
  materialization via unique provider id, monotonic `advanceMessageState`, internal notes are `draft`
  and structurally cannot carry a provider id; WhatsApp templates are local approval records.
- Inbox (VC.12–13): `voice_conversation_events` is append-only history (assignment/status/case link).
  `voice_conversations.case_id` is the handoff idempotency key — a repeated click returns the same
  Case. Handoff must send `requesterName`: Service Desk refuses a Case without a requester.
  Conversation status never writes Case status.
- Snippets (VC.14): `voice_message_templates`, placeholders `{{name}}` rendered **only** from
  caller-supplied values (never CRM lookups). Local snippets ≠ provider WhatsApp templates.
- Media (VC.15): recording callback stores a reference only; `assertSafeMediaUrl` is **async** — it
  must be awaited or the SSRF check silently passes. Fetch is a worker job into private storage;
  playback is authorized against the parent call; `retentionSweep` deletes expired rows/objects.
- Transcription/AI (VC.16): adapter `fetchTranscript` is optional; AI goes through
  `AIProviderGateway` only, with redacted+truncated text, `ai_review_status` starts `pending`.
- Panels (VC.17): record-ACL-aware panel + touchpoint counts; panels only read, so no duplicate
  Activities.
- UI pass (2026-10-20): `/voice-inbox` (`VoiceInboxPage`) = inbox + composer + call log +
  click-to-call form; `CommunicationsPanel` on Account/Contact/Lead/Opportunity/Case detail;
  `IncomingCallBanner` polls `action/calls/incoming` in the internal shell only. Media playback is
  always API bytes — no provider URL/token in the browser. Portal deliberately not extended.
- ACL note: synthetic permission entities (`CommunicationConversation`, `VoiceProviderAccount`,
  `AIAgent`) need no metadata seeding — `roleLevel` falls back to the `*` wildcard and admins get
  `'all'`.
- Tests: domain 35, base 24, calls 9, messaging 10, inbox 22 (**100**). Integration suites set
  `ENCRYPTION_KEY` + `REPORT_WORKER_SECRET` before `bootApi()`; the inbox suite stubs `fetch` for the
  media download and cleans children before the account (FK cascade hides receipts otherwise).
