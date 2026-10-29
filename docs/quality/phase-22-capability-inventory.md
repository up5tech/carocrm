# Phase 22.0 — Repository and Capability Inventory

> **Date:** 2026-10-27
> **Method:** Read-only audit. No business data was modified. Database inspection used the configured primary database (`carocrm_dev`, name only — credentials never printed) and was limited to `SELECT` queries and migration-status checks.
> **Label semantics:** per `PLAN_Phase_22_Integration_E2E_Hardening.md` §0.2. Because this audit verified *structure* (routes, migrations, tests present) but did not re-run the suites, almost every module is labeled **Implemented, insufficiently verified** — re-running the relevant suites is the job of Phase 22.1+, not of this audit.
> **Sources:** file inspection of `apps/api/src`, `apps/worker/src`, `apps/web/src`, `apps/api/test`, `e2e/`, `database/migrations`, `scripts/`; live schema query against `carocrm_dev`.

---

## 1. Tooling and runtime (verified)

| Concern | Selection | Evidence |
|---|---|---|
| Package manager | pnpm 10 workspace (`pnpm-workspace.yaml`, `apps/*`, `packages/*`) | `package.json` |
| Runtime | Node >= 22 required | `package.json` engines |
| API framework | NestJS + Fastify (fastify pinned 5.12.5) | `package.json` overrides |
| Test runner (API/units) | **Vitest**, tests flat in `apps/api/test/*.test.ts` (~170 files) + web config `vitest.web.config.ts` | `package.json` scripts |
| Browser E2E | **Playwright**, root `playwright.config.ts`, 21 specs in `e2e/*.spec.ts` | file listing |
| Lint | ESLint 9 flat config + `scripts/check-ui-conventions.mjs` (`pnpm lint` = UI conventions + eslint, `.agents/**` excluded by config) | `package.json` |
| Typecheck | `tsc --noEmit` for root + `apps/web` | `package.json` |
| Migrations | Plain SQL in `database/migrations/*.sql`, applied by `database/migrate.ts`, tracked in `schema_migrations(name)`, transactional per file | `database/migrate.ts` |
| Queue | BullMQ queue `crm-jobs`; durable record is the `jobs` table (migration `003`); consumer in `apps/worker` | `apps/api/src/jobs/job-queue.service.ts` |
| Events | No `@nestjs/event-emitter`. Write side: `EventBus` → `outbox_events` table in-caller-transaction (`apps/api/src/common/outbox.service.ts`). Read side: `apps/worker` outbox poller fans out (at-least-once). | `apps/api/src/events/event-bus.ts`, `apps/worker/src/outbox/` |
| Mail | SMTP + worker handler `system.sendEmail`; `MAIL_TRANSPORT=memory` seam for tests | `apps/worker/src/handlers/mail-handlers.ts` |
| Storage | Local `STORAGE_ROOT`, chunked upload (migrations 004–005) | `apps/api/src/attachment/` |
| CI | **None.** `.github/` contains only `copilot-instructions.md` | directory listing |
| Env config | Root `.env` keys: `DATABASE_URL, DATABASE_ADMIN_URL, REDIS_URL, APP_PORT, APP_HOST, JWT_SECRET, *_TTL, STORAGE_ROOT, LOG_LEVEL, ENCRYPTION_KEY, REPORT_WORKER_SECRET` | `.env` key names only |

**Migration status (live check):** 82 migrations on disk, 82 applied, 0 pending, 0 applied-but-missing. 132 public tables.

---

## 2. Shared platform services

| Capability | Owner | State | Label | Notes / gaps |
|---|---|---|---|---|
| Entity Engine (generic CRUD) | `apps/api/src/entity` + `packages/entity-engine` | `EntityController` (`/api/v1/:entity…`) registered **last** in `app.module.ts` after all static prefixes | Implemented, insufficiently verified | Wildcard ordering correct; cross-module contract tests to come in 22.3/22.6 |
| Metadata | `metadata/`, `MetadataController` | Seed via `database/seed-metadata.ts` | Implemented, insufficiently verified | — |
| ACL | `acl/` engine + `APP_GUARD` AuthGuard | Global guard, `@Public()` opt-in (~35 routes, all intentional per §4 below) | Implemented, insufficiently verified | `acl-matrix.test.ts` exists |
| Jobs | `jobs/` + `apps/worker` | BullMQ + `jobs` table; `JOB_NAME` allowlist regex | Implemented, insufficiently verified | **Silent-degrade risk:** `job-queue.service.ts:131,139` returns `false`/`{}` on Redis errors — a Redis outage reads as "no jobs" |
| Outbox/event bus | `events/`, `common/outbox.service.ts`, `apps/worker/src/outbox/` | Transactional outbox; auto `entity.created/updated/deleted` | Implemented, insufficiently verified | **Most domain events (`customerSuccess.*`, `serviceDesk.*`, `esignature.*`, `leadScore.*`) have no registered consumer** — outbox registry marks unknown types processed with a warn (`apps/worker/src/outbox/outbox-registry.ts`) |
| Email | `email/` + mail-handlers | — | Implemented, insufficiently verified | — |
| Attachments | `attachment/` | Chunked upload, storage adapters | Implemented, insufficiently verified | Download-path ACL tests required by 22.17 |
| Audit | `audit/` | After-save hook + `/api/v1/AuditLog` | Implemented, insufficiently verified | — |
| Stream/notes/notifications | `stream/` | — | Implemented, insufficiently verified | — |
| Search/import/dashboards | `search/` | — | Implemented, insufficiently verified | — |
| Reports | `reports/` | Scheduled delivery gated on `REPORT_WORKER_SECRET` | Implemented, insufficiently verified | — |
| Workflows | `workflows/` + worker `workflow-handlers` | Reacts to `entity.*` events | Implemented, insufficiently verified | Loop-protection tests needed (22.7) |
| BPM (processes) | `processes/` | `/Process/action/*`, `/ProcessInstance`, `/ProcessTask` | Implemented, insufficiently verified | Visibility = initiator OR task holder (both clauses must agree — known shipped defect class) |
| Document kernel | `document/` + `packages/document` | Template preview `/document/action/preview` | Implemented, insufficiently verified | — |
| Portal | `portal/` (Phase 18) | `/api/v1/Portal`, `/api/v1/PortalRole` | Implemented, insufficiently verified | Portal-scope IDOR tests are a 22.4/22.17 priority |
| Auth/identity/2FA | `auth/` | Sessions, TOTP | Implemented, insufficiently verified | **Default JWT secret risk** — see §5 |

---

## 3. Domain module inventory

Label base for all: **Implemented, insufficiently verified** (structure + tests verified to exist; suites not re-run in this audit). Deviations noted.

| Module | Routes (base) | Migrations | Events | Queue jobs | Tests | Gaps / deviations |
|---|---|---|---|---|---|---|
| **Projects** | `/Project`, `/ProjectTask` | 018 | generic entity events | — | 5 files (`projects*`) | — |
| **Sales** | `/Sales` (actions + worker callbacks w/ `assertWorkerSecret`) | 021–031 | via entity events | `sales.expireQuotes`, `sales.markOverdueInvoices`, `sales.generateSubscriptionInvoices` | 28 files | Worker-callback routes: verify secret enforcement per route in 22.4 |
| **CustomerSuccess** | `/CustomerSuccess` | 032 | 9 services emit `customerSuccess.*` | 8 scheduled jobs (worker-cron routes, all `assertWorkerSecret` verified) | 2 files | Emitted events have **no consumers** beyond noop/log |
| **ServiceDesk** | `/ServiceDesk` | 033–036 | `serviceDesk.case.*`, SLA events | `serviceDesk.slaScan` | 13 files | Several best-effort swallow sites (notification paths) |
| **MarketingAutomation** | `/MarketingAutomation` | 037–043 | campaign/consent/send events | `marketing.deliveryBatch`, `marketing.journeyRunBatch` | 15 files | Worker-cron routes use optional-secret-with-admin-fallback pattern (see §5) |
| **AIAgents** | `/AIAgents` | 045–050, 061 | provider gateway | `aiAgents.executeRun`, `aiAgents.retentionSweep` | 3 files | **Integration triggers declared but not implemented** (`ai-agent-definitions.service.ts:506`, warned + gated) |
| **CRMChat** | `/CRMChat` — foundation routes only | 062 | — | — | 10 files | **Partial.** Conversation/streaming/citation routes specified in `docs/architecture/crm-chat-contract.md` but **not implemented** (`crm-chat.controller.ts:51-54`). Owns no table/queue/adapter |
| **VoiceCommunications** | `/VoiceCommunications` + `/api/v1/integrations/voice-communications` webhooks | 051–054 | inbox/event-processor events | `voice.processWebhook`, `voice.fetchMedia` | 6 files | — |
| **AdvancedIntegrations** | `/AdvancedIntegrations` + integration webhook/OAuth routes | 056–060 | consumes `entity.*` for outbound push | `advancedIntegrations.{processWebhookEvent,pushOutbound,notifyExpiringCredentials,purgeRetention}` | 8 files | **Zoom recordings not implemented** (`zoom.adapter.ts:39`, capability-gated) |
| **ESignature** | `/ESignature` (+ requests/templates) + provider webhooks | 064–070 | request lifecycle events (10+ dispatch sites) | `esignature.{processProviderWebhook,retrieveCompletedArtifacts}` | 26 files | Some provider adapters no-op/throw, capability matrix guards (production uses DocuSign/DropboxSign only; non-prod silently gets fake adapter) |
| **LeadScore** | `/LeadScore` | 073–076 | threshold/band/conversion events | `leadScore.{recalculateLead,batchRecalculate,decaySweep,recoverConversionOperations}` | 19 files | Unimplemented capabilities intentionally surfaced as "not implemented yet" |
| **Omnichannel** | `/Omnichannel` (+`/chat`, webhooks) | 077–082 | — | — | 22 files | Owns no store — pure workspace over Voice/ServiceDesk; Meta connectors deliberately gated out (enforced by test) |
| **Portal** | `/Portal`, `/PortalRole` | 016 | — | — | 1 file | Test coverage thin relative to IDOR risk |

### Controller registration order (verified)

Health → Auth → Identity → I18n → Settings → SetupChecklist → AdminPanel → Attachment → Audit → Stream → Calendar → Logic → Hook → DomainEvent → Job → Email → Preferences → Search → Report → Extension → Workflow → Process → Portal → Projects → Sales → CustomerSuccess → ServiceDesk → MarketingAutomation → AIAgents → CRMChat → VoiceCommunications → AdvancedIntegrations → ESignature → LeadScore → Omnichannel → Document → Docs → **ENTITY_CONTROLLERS (Metadata + generic wildcard, last)**.

---

## 4. Frontend routes and UI coverage

- **Route inventory:** all module workspaces registered (`/sales`-family generated entity pages, `/projects` per-record views, `/ai-agents`, `/crm-chat`, `/voice-communications`, `/voice-inbox`, `/advanced-integrations`, `/esignature`, `/lead-score`, `/omnichannel`, `/docs`, `/admin/*`, portal tree, public `/chat`, `/csat`, `/marketing/preferences`). Nav is **server-resolved and ACL-filtered** (`AppShell.tsx` renders what the backend navigation API returns — no hardcoded module names).
- **Conventions verified:** per-route `AppErrorBoundary` (keyed by pathname) + root boundary; `OfflineBanner` via React Query `onlineManager`; `EmptyState` used at 30+ call sites, zero raw antd `<Empty>`.
- **Convention violations found (pre-existing defects, to fix in 22.15):** ~25 `toLocaleString()`/`toLocaleDateString()` date-formatting call sites violating the `formatDateTime` rule — `StreamPage`, `omnichannel/InboxPanel` (4), `OperationsPanel` (3), `VoiceCommunicationsPage` (2), esignature panels, `ServiceDeskDashboardPage`, `CaseConversation` (2), `AdminSettingsShell`, `WebhooksTab`, `ApiKeysTab` (4), `AIAgentsSettingsTab`, `AIAgentsOverview`.
- **Browser E2E coverage gaps** (21 specs exist; no spec covers): `/crm-chat`, `/voice-communications`, `/voice-inbox`, `/esignature`, `/marketing/preferences`, `/chat` (public widget), `/portal`, `/csat`, `/admin/portals`, `/DocumentTemplate`.
- **E2E order coupling (flakiness signal):** `lead-score.spec.ts` and `lead-score-admin.spec.ts` `test.skip` on state produced by earlier tests.

---

## 5. Risk signals (verified findings)

### High

1. **Default JWT secret does not hard-fail in production** — `apps/api/src/config.ts:13`: `jwtSecret` defaults to `'dev-only-secret-change-me'` when `JWT_SECRET` is unset. Any misconfigured deployment silently boots with a known secret. *Action (22.17 or earlier): fail fast when `NODE_ENV=production` and secret is the default.*
2. **Seed/smoke scripts write to the configured primary database, unguarded** — `database/seed.ts` (`pnpm db:seed`, upserts roles with `DO UPDATE` overwriting permissions, default admin password `admin`), `scripts/e2e-smoke.sh` (seeds + inline `DELETE`s of fixture rows, hardcoded test JWT secret), `scripts/projects-demo.ts` (`main()` purges demo rows **unconditionally**, no prompt). All prefix-scoped, no `TRUNCATE`/`DROP` anywhere. *Action (22.1): add prompt/flag guards and document which commands are safe.*
3. **Leftover test data in the primary database** — live counts: **25,847 records matching `AGENT_TEST_%`**, 233,690 `outbox_events` rows, 6,441 `jobs` rows, 12,550 users. Accumulated from prior test runs. *Action: do NOT bulk-delete (AGENTS.MD §3.3). Design exact-ID cleanup + retention policy in 22.1; outbox/events retention sweep likely needs a bounded, reviewable job.*

### Medium

4. **Optional worker-secret pattern** — several `@Public()` cron routes use `if (workerSecret !== undefined) assertWorkerSecret(...) else requireAdmin` (marketing-automation, voice-communications controllers). CS controller's 8 routes assert unconditionally (good). Pattern depends on every route remembering its check. *Action (22.4): add a route-level test that enumerates `@Public()` routes and asserts each has either signature verification, worker-secret assertion, or explicit documented rationale.*
5. **Most domain events have no consumer** — outbox registry warns and marks unknown event types processed. Not a defect, but 22.3's contract catalog must record producer-with-no-consumer explicitly, or journeys in 22.8–22.13 will assume reactions that don't exist.
6. **Silent-degrade catches in job queue** (`jobs/job-queue.service.ts:131,139`) and notification paths in service-desk. *Action (22.21): structured logging + operator-visible degradation.*

### Low / informational

7. Non-production deployments silently get fake e-signature/AI/voice adapters (intentional, capability-gated; staging signs nothing real with only config-level warning).
8. One narrowly-scoped bulk `DELETE` exists in migration `071_phase20_retire_inert_preferences.sql` (one-off, migration-tracked — acceptable).
9. Zero TODO/FIXME debt, zero skipped static tests, zero credential logging; defensive redaction present in worker and smoke scripts.

---

## 6. Cross-module dependency matrix

`Reuse` = use as-is; `Extend` = exists, needs hardening/tests; `Build` = missing, must be built; `Ext prereq` = needs external credential/sandbox; `Defer` = out of Phase 22 scope.

| Integration concern | Disposition | Rationale |
|---|---|---|
| Outbox/event bus | **Extend** | Works; needs consumer registry, loop protection tests, retention policy |
| BullMQ jobs + `jobs` table | **Extend** | Works; needs Redis-outage observability fix, retry/DLQ verification |
| ACL engine + guard | **Extend** | Works; needs field-level/portal/export matrix tests (22.4, 22.17) |
| Worker-secret pattern for cron | **Extend** | Works; needs enumerate-and-assert test |
| Lead conversion (LeadScore→Sales) | **Extend** | Implemented with recovery job `leadScore.recoverConversionOperations`; journey tests in 22.8 |
| Sales→ESignature snapshot contract | **Extend** | Both sides implemented; fake-provider journey tests in 22.9 |
| CS↔Projects milestone signals | **Extend** | CS emits events, but consumers unverified — confirm wiring in 22.10 |
| Omnichannel→ServiceDesk handoff | **Extend** | Handoff migration 081 + 22 omnichannel tests; journey test in 22.11 |
| Marketing consent/suppression gate | **Extend** | Implemented (consent migration 038); suppression-vs-queued-send test in 22.12 |
| CRMChat full conversation flow | **Build (API) + Extend (UI)** | Foundation routes + page exist; conversation/streaming/turn routes are spec'd but not implemented — the CRMChat journey (22.13) must be scoped to what exists or the missing routes built first |
| AI agent tool authorization/approvals | **Extend** | Approvals + quotas implemented; prompt-injection/tool-misuse tests in 22.13/22.17 |
| Connector sync (AdvancedIntegrations) | **Extend** | Engine + DLQ implemented; Zoom recordings explicitly out (Defer) |
| Live provider credentials (DocuSign, Stripe, WhatsApp, Twilio…) | **Ext prereq** | All external effects stay on fakes per plan; sandbox runs optional and separately classified |
| Backup/restore rehearsal environment | **Ext prereq** | `docs/operations/backup-restore.md` exists; an approved non-prod recovery environment is required or 22.23 is marked Blocked |
| CI platform | **Build** | No workflows exist at all; platform choice is an open decision with the owner (22.22) |
| EspoCRM upstream DB parity | **Not applicable** | Explicitly out of scope per plan §1.3 |

---

## 7. Recommended Phase 22.1+ sequence

1. **22.1 (test infrastructure/safety)** — highest value first: guard `db:seed`/smoke scripts; define `agentTestRunId` cleanup policy addressing the 25.8k leftover records (exact-ID only, no bulk deletes); document the safe-command matrix; fix the `job-queue.service.ts` silent-degrade catches.
2. **22.4 (identity/ACL)** — JWT default-secret production hard-fail; enumerate `@Public()` routes and assert each one's auth story; portal IDOR matrix.
3. **22.3 (contract catalog)** — record the producer-without-consumer event list explicitly before journey sub-phases.
4. **22.8–22.14 journeys** — in plan order; scope 22.13 (CRMChat) to implemented surface or build missing conversation routes as a separate decision.
5. **22.15/22.16** — fix the ~25 `toLocaleString` violations; add Playwright specs for the 10 uncovered route families; de-couple lead-score e2e order dependence.
6. **22.22 (CI)** — blocked on platform decision with the owner.
7. **22.23 (backup/restore)** — blocked on approved recovery environment; mark Blocked if unavailable.

---

## 8. Audit compliance

- [x] Inventory includes source paths, migration evidence, API routes, registered frontend routes, tests, authorization implementation, and concrete status per item.
- [x] Dangerous test scripts identified **before** any was run (§5.2) — none were executed.
- [x] No business data modified; DB access was `SELECT`-only against the configured primary database.
- [x] Next sub-phase based on observed repository structure, not plan assumptions.

---

## 7. Phase 22.24 status update (2026-10-29)

This addendum supersedes the "Implemented, insufficiently verified" base label for the entries below.
It is based on the Phase 22 suites and journeys actually run, not on the original structural audit.
Labels: **Verified** (its owner suite and the relevant cross-module journey pass), **Partial**
(deliberately incomplete or a declared capability is not implemented), **Verified with residual
risk** (works, but a tracked gap affects a release decision).

| Capability | Final label | Evidence / residual risk |
|---|---|---|
| Entity Engine, metadata, ACL, audit, stream, search, reports, documents, hooks/workflows, BPM, attachments, email | **Verified with residual risk** | 22.4 ACL matrix, 22.7 replay/outbox, 22.15/22.17 security/UI suites; G6 (no consumers), G8 (allow-listed core imports), G30 (stream orphans), G64/G73/G74. |
| Auth / identity / 2FA | **Verified** | `auth.test.ts` (19) + config JWT production guard (G9 fixed); no open high auth finding. |
| Jobs / outbox / queue | **Verified with residual risk** | 22.7, 22.18 jitter/lease (G15/G70), 22.21 correlation; G21 (no retry/discard), G23 (dead-letter replay), G14 retention. |
| Projects | **Verified with residual risk** | Projects suites + 22.10 journey; G27 (no Project↔CS read). |
| Sales | **Verified with residual risk** | 28 suites, 22.9 quote→signature, 22.19 payment key/ledger; G20 fixed; G69/G75 flake (test isolation). |
| CustomerSuccess | **Verified with residual risk** | 22.10 journey; G27; health/renewal notifications off by default. |
| ServiceDesk | **Verified with residual risk** | 22.11 journey, SLA/domain suites; G37 (Case `own` create). |
| MarketingAutomation | **Verified with residual risk** | 22.12 consent/attribution journey, replay contract; G33 (webhook signature/freshness). |
| AIAgents | **Verified with residual risk** | 22.13 journey, 22.17 ACL/approval tests; G36 (unreachable states), declared triggers not implemented. |
| CRMChat | **Partial** | foundation/security suites; `features.readTools` not enforced (G38), turn sources not re-authorized (G39); streaming/citation contract not fully implemented. |
| VoiceCommunications | **Verified with residual risk** | 22.11 journey, webhook replay/out-of-order suites; retention gaps (G12/G13). |
| AdvancedIntegrations | **Verified with residual risk** | 22.14 recovery journey, provider/replay contracts; G47/G48/G50/G51/G53. |
| ESignature | **Verified with residual risk** | 22.9 journey, 22.17 provider contracts, lifecycle suites; no Sales→ESignature consumer (G26); non-production fake adapter is capability-gated. |
| LeadScore | **Verified with residual risk** | 22.8 conversion journey, LS suites; G22 fixed; conversion service test gap (G3 low). |
| Omnichannel | **Verified with residual risk** | 22.11 conversation→Case journey, security/e2e suites; groups 4–6 of the 22 OM review remain open (routing fallback, stale banner, no unlink/e2e/AI tool grant). |
| Portal | **Partial / verified with residual risk** | `portal.test.ts` only; IDOR risk is covered by 22.17 ACL/BOLA tests but the module suite is thin. |
| SPA / admin | **Verified with residual risk** | 22.15 consistency, 22.16 browser critical paths (4/4), 22.17 security; G63/G64/G65/G66/G67/G68. |
| CI | **Verified** | 22.22 DB-free scheduled gate; G78 (no PR gate). |
| Backup/restore | **Blocked (partially remediated 22.25)** | G80/G81; `pnpm backup` + secure permissions/encryption guard/verification landed, but no deployment schedule/off-host and no restore drill/RPO-RTO. |
