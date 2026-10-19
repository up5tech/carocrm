# Project memory — carocrmv2

Curated, long-lived notes. Daily logs live next to this file as `YYYY-MM-DD.md`.

## Module naming

- Phase-19 domain modules use **plain names**, not `Ua*` prefixes. The Sales module is `sales`
  (directory `apps/api/src/sales`, API prefix `/api/v1/Sales`, settings row `sales`), matching how
  Projects is `projects` / `/api/v1/Project`. `Ua*` names in `PLAN.md` (`UaProjects`,
  `UaWorkflows`, …) are legacy/aspirational and are not followed by the implementation.
- Consequence for any extension work: never introduce a `Ua`-prefixed module id, API prefix, class
  name, settings row or translation namespace.
- References *to other modules* may keep their own ids (`ua-stripe-integration`,
  `ua-accounting-integration`, `ua-customer-success`, `ua-projects` in
  `apps/api/src/sales/sales-module.ts` `OPTIONAL_INTEGRATIONS`).

## Repo conventions worth remembering

- Domain modules are kernel directories under `apps/api/src/<domain>` with a barrel exporting
  `<DOMAIN>_CONTROLLERS` / `<DOMAIN>_PROVIDERS`, spread into `AppModule` **before** the generic
  `:entity` wildcard controller.
- Records are metadata entities in `entity_records` (seed in `database/seed-metadata.ts`); the module
  adds only cross-record rules, registered on the `beforeValidate` hook so generic CRUD is validated
  identically to domain commands.
- Migrations: `database/migrations/<NNN>_phase<NN>_<slug>.sql`, additive only, applied in filename
  order inside one transaction each, tracked in `schema_migrations`.
- Money is a canonical decimal string at every boundary; `apps/api/src/sales/money/decimal.ts` is the
  module's decimal engine (the kernel has no currency registry or exchange-rate facility).
- Docs for a module go in `docs/modules/<module>/`; audits in `docs/implementation/`.
- **`entity_records` has `created_at` + `modified_at`, never `updated_at`.** Any hand-written SQL against
  that table must use `modified_at`; `updated_at` fails at runtime with "column does not exist" (it cost
  the whole journey runtime, see the 2026-10-18 log).
- **`ON CONFLICT` cannot infer a partial unique index** unless the conflict target repeats the predicate:
  `on conflict (inbox_id) where inbox_id is not null do nothing`. Several marketing indexes are partial
  (`WHERE deleted_at IS NULL`, `WHERE inbox_id IS NOT NULL`).
- Conditional-UPDATE "claims" must be **leases** (push the due/next-run timestamp forward), not a version
  counter bump — otherwise two workers both claim the same row.

## Marketing Automation (Phase 19-MA, complete)

- `apps/api/src/marketing-automation/`, API prefix `/api/v1/MarketingAutomation`, settings row
  `marketingAutomation`, records in `entity_records` (16 entity types), migrations 037–043.
- Delivery is queue-driven: `marketing_recipient_deliveries` (one row per recipient per slot) is claimed by
  `marketing.deliveryBatch`; journeys by `marketing.journeyRunBatch`. Both worker jobs call API endpoints
  with `x-worker-secret` **and** a session — the secret is an extra capability, not authentication.
- Public surface is 5 routes; `MARKETING_WEBHOOK_SECRET` empty means **reject every provider event** (fail
  closed, no default secret). `public/form/submit` always answers `{accepted:true}` so it cannot confirm
  whether an address is in the CRM.
- Docs live in `docs/marketing-automation/` (+ `docs/runbooks/marketing-{send-operations,provider-incidents}.md`);
  evidence report: `docs/implementation/marketing-automation-completion-report.md`. 13 suites / 225 tests.

## Kernel `document` module

- Two halves: pure package `packages/document` (`@carocrm/document` — template engine, block model →
  text, optional pdfkit adapter, no database/NestJS) + thin API layer `apps/api/src/document`
  (`DocumentTemplate` entity + service + controller). 19-S.7 now uses it end to end:
  `apps/api/src/sales/document/quote-document.ts` builds a quote's blocks from the engine's own totals,
  and `quote-send.service.ts` renders them through `DocumentTemplateService`.
- Unresolved placeholders are **left in place and reported in `warnings`**, never blanked. One default
  template per entity type; a new default clears the old one. `document/action/preview` is admin-only.
- Metadata `acl.fieldPermissions` is **declarative only**: the ACL evaluator reads the role row's own
  `field_permissions`. A field-level deny is real only once it is set on a role.
- **Rendering through this module needs `DocumentTemplate: read`.** That is the kernel's own ACL check
  inside `DocumentTemplateService`, so a role that sends quotes must be granted it; the seeded
  metadata default (`read: 'all'`) is declarative only.

## Sales quote render/send (19-S.7)

- `POST /api/v1/Sales/quote/:id/render` and `…/:id/send` (both on the `SalesController`). Rendering is
  read-only; sending issues the draft and then creates + queues an `Email` linked by
  `parentType`/`parentId` through the existing `EmailService.queueSend` (which owns validation, the
  per-recipient ledger and the `system.sendEmail` job). The API never opens a socket.
- **Every gate runs before issuance** — `Email: create`/`edit` are pre-checked with `AclApiService`
  precisely so a refused caller cannot leave a `sent` quote with no email behind it. A re-send of a
  `sent` quote returns `issued: false` and records a *new* email rather than changing the document.
- An issued quote renders from its frozen snapshot (`issuedData`), never from the live catalog.
- A PDF **attachment** is still not produced: the blocks and the optional pdfkit adapter exist, but
  writing the PDF into an outbound message needs the attachment-storage path.

## Sales document engine invariants (learned the hard way)

- **A document cannot exist with zero lines**: `sales/tax/totals.ts#computeTotals` throws
  "A document needs at least one line", so every create path (including
  `POST /Sales/document/fromOpportunity`) must carry `items`. Don't design a "blank draft" flow.
- A `DocumentView` carries both the action *names* (`availableTransitions`/`availableConversions`) and
  their *descriptions* (`actions`/`conversions`: label, `issues`, `requiresReason`, `to`/`toKind`) built
  from the descriptor. UIs must render the descriptions, never hard-code state machines.
- Provenance on a generated document is `sourceEntity`/`sourceId`/`correlationId`; `findBySource` is the
  idempotency lookup. Write `correlationId` into the record or a retry creates a second document.
- Only `Quote` and `SalesOrder` have an `opportunityId` field (descriptor `opportunityField`); `Invoice`
  does not, so its deal provenance lives in `sourceEntity`/`sourceId` only.
- `apps/api/src/sales/dto/sales-shapes.ts` declares `IdSchema` **after** its first use in the document
  section would be a TDZ crash (schemas evaluate at import) — it is hoisted near `DaySchema`; keep it
  there if you add earlier schemas.

## Test seams for mail- and queue-touching suites

- Any suite that exercises a send must set `MAIL_TRANSPORT=memory` **and** `SMTP_FROM=<addr>` before
  `bootApi()` (config is read once at boot) and restore both in `afterAll` — without a From address
  `EmailService.queueSend` (correctly) refuses the message. `process.env` leaks between suites because
  the root vitest config runs `singleFork: true`.
- Stub the BullMQ hop on the instance: `ctx.app.get(JobsService).enqueue = async (i) => ({ id: 'x',
  job: i.job, status: 'pending' }) as unknown as JobView`. Assert the durable side effects, not the
  queue hop.

## Build / test pre-flight

- Workspace packages resolve through `dist/` (`exports` → `dist/index.js`, no vitest/tsc alias), so
  after adding or changing a package run `pnpm install` (updates `pnpm-lock.yaml` importers) then
  `pnpm build` before `pnpm typecheck` or any `apps/api` test. Pure suites under
  `packages/*/src/**` run without the build; API suites do not.

## Environment notes

- Some sessions in this repo expose **no shell**: no `git`, no `pnpm typecheck`, no `vitest`, and no
  way to rename or delete files. When that happens, write the content changes, and record the exact
  commands the user must run instead of claiming verification.
- **Full-suite flake (pre-existing, verified 2026-10-17):** `pnpm test` (all api suites, one fork)
  aborts at random file boundaries with a native V8 abort before/between suites. Control-verified
  with module changes stashed — crashes even earlier without them. Individual suites are reliable;
  `attachments`, `attachments-storage`, `audit` crash at boot in this environment regardless of any
  change. For regression sweeps, run one file per `pnpm vitest run` invocation.

## Customer Success module (Phase 19-CS, shipped 2026-10-17)

- `apps/api/src/customer-success/`, module id `CustomerSuccess` (no prefix), entities keep the
  `CustomerSuccess` prefix. **`CustomerSuccessProfile` is a fixed name** — the shipped Sales
  integration's marker (`sales-module.ts`); registering it flips
  `apps/api/test/sales-module.test.ts`'s absence-case assertion to `available` (plan §12.8).
- **`User` and `Team` are identity tables, not metadata entities** — the entity API refuses them;
  validate destinations against `users`/`teams` directly (`project-member.service.ts` precedent).
- Entity ACL `delete: 'no'` (playbook templates/runs/step runs) blocks the record API DELETE even
  for admins — a test suite must remove its own such rows by exact id from the DB. Health snapshots
  are engine-written with no tracked id; sweep them by the run's profile ids.
- `EVENT_TYPE` (`events/event-bus.ts`) and `JOB_NAME` (`jobs/jobs.service.ts`) were widened to allow
  camelCase segments so `customerSuccess.health.statusChanged` / `…recalculateHealthBatch` validate.
- 19-CS.12 (dedicated React screens) deliberately not built; the generic metadata UI serves the
  entities. Docs: `docs/modules/customer-success/` + `docs/implementation/customer-success-*.md`.

## Voice & Communications module (Phase 19-VC.0–19-VC.6, 2026-10-19)

- `apps/api/src/voice-communications/`, module id `VoiceCommunications` (no prefix), API prefix
  `/api/v1/VoiceCommunications`, webhook prefix `/api/v1/integrations/voice-communications`.
- **No metadata entity** in VC.0–6: provider accounts, endpoints, webhook receipts, normalized
  events, call sessions, conversations, participants, messages, media, consent and suppression are
  dedicated tables (migration 051). The user-facing call record remains the platform `Call` Activity.
- Provider adapters are classes inside the module (`VoiceProviderAdapter`), never modules; only the
  `fake` simulator exists, and it resolves to `disabled` in production.
- Event namespace is `voiceCommunications.*` — the plan's hyphenated `voice-communications.*` fails
  the platform `EVENT_TYPE` regex.
- MarketingAutomation consent is **email-only**; this module owns SMS/MMS/WhatsApp/voice consent
  (`voice_consent_events`, append-only) and suppression tombstones.
- Provider secrets use `ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret`; write-only, masked hint
  on read. Enabling requires the credential (live adapters) and the webhook secret (signature
  adapters) before the write.
- Webhook ingress: body ceiling → replay window → adapter signature → `voice_webhook_events`
  receipt (`unique(account_key, dedup_key)`) → `voiceCommunications.processWebhookEvent` job.
  Processing is idempotent via `unique(webhook_event_id)` on `voice_communication_events`.
- **Kysely `RawBuilder` has no `executeTakeFirst(db)`** in this repo: use
  `(await sql`…`.execute(db)).rows[0]`. Platform `ValidationError` returns HTTP **422**, not 400.
- `phone-number.ts` exposes `PhoneNormalizer` via the `PHONE_NORMALIZER` token. The default is
  `LibPhoneNumberNormalizer` (`libphonenumber-js` 1.13.15, installed manually);
  `ConservativePhoneNormalizer` remains a dependency-free fallback. Services inject the interface.
- VC.7–VC.11 add `voice-call.service.ts` (one session ↔ one `Call` Activity via `EntityCrudService`,
  `advanceCallState` monotonic), `voice-call-notification.service.ts` (notification rows for the
  endpoint team), `voice-messaging.service.ts` (durable send + inbound materialization + monotonic
  `advanceMessageState`), `voice-whatsapp-template.service.ts` (approval + `{{n}}` variables) and
  migration 052 (`idempotency_key` columns, `voice_whatsapp_templates`).
- The simulator **requires** `sandboxRecipients` and never returns `delivered`; a send is `sent`
  until a callback arrives.
- Tests: domain 35, base 24, calls 9, messaging 10 (78). The integration suites set
  `ENCRYPTION_KEY` and `REPORT_WORKER_SECRET` before `bootApi()`.
