# Phase 19-MA — Marketing Automation completion report

> **Plan:** `PLAN_Phase_19_Marketing_Automation.md` (§16 Definition of Done, §17 Release Checklist).
> **Module:** `MarketingAutomation`, API prefix `/api/v1/MarketingAutomation`, directory
> `apps/api/src/marketing-automation`, settings row `marketingAutomation`.
> **Status:** complete for phases 19-MA.0 – 19-MA.19. This report is the evidence, not a summary of intent:
> every claim below was produced by a command in this checkout, and the commands are named.

---

## 1. What was built, by phase

| Phase | Delivered | Primary files |
| --- | --- | --- |
| MA.0 | repository audit, canonical ownership decisions, phase order | `docs/implementation/marketing-automation-audit.md` |
| MA.1 | module descriptor, health/diagnostics, navigation visibility, settings row, feature flags | `marketing-automation-module.ts`, `…-module-health.service.ts`, `…-navigation.service.ts`, `…-settings.service.ts` |
| MA.2 | domain contracts, state machines, DTO shapes, migration baseline (037) | `marketing-automation-domain.ts`, `dto/marketing-automation-shapes.ts` |
| MA.3 | campaign lifecycle commands, send-readiness gate, duplicate-as-draft, history, write guard | `marketing-campaign.service.ts`, `…-campaign-validation.service.ts`, `…-write-guard.service.ts` |
| MA.4 | `TargetList` membership, dynamic criteria, include/exclude resolution, preview, snapshots (038) | `marketing-audience.service.ts`, `marketing-audience-criteria.ts` |
| MA.5 | consent/preference/suppression records, public tokens, unsubscribe + preference centre | `marketing-consent.service.ts`, `marketing-suppression.service.ts`, `marketing-public-token.service.ts` |
| MA.6 | placeholder rendering, sanitisation, preview, immutable template revisions (040) | `marketing-template.service.ts`, `marketing-template-render.ts` |
| MA.7 | provider registry, platform-mail adapter, limiter, classified errors, safe test send | `marketing-automation-provider.ts`, `marketing-provider-*.ts`, `marketing-test-send.service.ts` |
| MA.8 | `MarketingSend`, dry run, approval, frozen audience, recipient ledger (041) | `marketing-send.service.ts`, `marketing-delivery-ledger.ts` |
| MA.9 | queue-based delivery, chunking, retries, dead letters, recovery, emergency stop | `marketing-delivery-batch.service.ts`, `apps/worker/src/handlers/marketing-handlers.ts` |
| MA.10 | webhook verification, normalization, dedupe inbox, suppression feedback (042) | `marketing-event-ingestion.service.ts` |
| MA.11 | campaign log, statistics, denominators | `marketing-campaign-log.service.ts` |
| MA.12 | journey graph schema, validation, immutable published versions | `marketing-journey-definition.service.ts` |
| MA.13 | enrollment, lease claims, waits, conditions, recovery, step traces (043) | `marketing-journey-runtime.service.ts` |
| MA.14 | action catalog, CRM-event triggers, causation bound | `marketing-journey-action.service.ts`, `marketing-journey-trigger.service.ts` |
| MA.15 | public form, honeypot, per-IP limit, dedupe, consent capture | `marketing-form.service.ts` |
| MA.16 | cross-module contracts (Sales/CS/ServiceDesk/Portal) as optional adapters | `marketing-integration.service.ts`, `docs/marketing-automation/integration.md` |
| MA.17 | attribution models and funnel | `marketing-attribution.service.ts` |
| MA.18 | diagnostics, retention dry run, provider-incident runbook | `marketing-operations.service.ts`, `marketing-retention.service.ts`, `docs/runbooks/` |
| MA.19 | hardening: webhook fail-closed, trigger authorisation, redirect guard, form non-disclosure | this report §3 |

**No `Ua` prefix** appears in any module id, class, directory, settings row or route added by these phases.
The module reuses the kernel's Entity Engine, ACL, hooks, audit, stream, jobs, outbox, mail transport,
template engine, query engine and reporting; it adds **no** second campaign, audience, consent, queue or
workflow system.

## 2. Migrations

All additive; every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Applied by
`database/migrate.ts` in filename order, one transaction each, tracked in `schema_migrations`.

| File | Adds |
| --- | --- |
| `037_phase19_marketing_automation.sql` | campaign code uniqueness, transition and audience indexes |
| `038_phase19_marketing_consent_audience.sql` | consent/suppression/token/snapshot indexes, `marketing_audience_snapshot_entries` |
| `039_phase19_marketing_identity_rename.sql` | renames the identity unique indexes (`memberType`/`subjectType`) |
| `040_phase19_marketing_template_revision.sql` | template revision indexes |
| `041_phase19_marketing_send_delivery.sql` | `marketing_recipient_deliveries` + send slot/history indexes |
| `042_phase19_marketing_webhook_inbox.sql` | `marketing_provider_webhook_inbox`, `marketing_events` |
| `043_phase19_marketing_journey_runtime.sql` | enrollment dedupe, step idempotency, due-scan indexes |

No existing table, column or row was altered, renamed or dropped. No test or script creates a database,
schema or container (AGENTS.md §3).

## 3. Defects found and fixed while closing the phase

Each of these was found by a test written for the plan's own acceptance criteria, not by inspection.

| Defect | Effect before the fix | Fix |
| --- | --- | --- |
| `insert into marketing_events … on conflict (inbox_id)` could not infer `uq_marketing_events_inbox` (a **partial** index) | every accepted provider event failed with SQLSTATE 42P10 — webhook ingestion recorded **nothing**, ever | repeat the index predicate: `on conflict (inbox_id) where inbox_id is not null do nothing` |
| journey runtime wrote `entity_records.updated_at` | the column is `modified_at`: enrollment, claim, step write and trace insert all failed, so the journey engine could not run at all | `modified_at` in all four statements |
| `claim()` only bumped `lockVersion` | two workers could both claim and execute the same step | claim is now a **lease**: the conditional UPDATE also pushes `nextRunAt` 60 s ahead, so a second claim finds the row not due; a crashed worker's lease expires into recovery |
| webhook secret defaulted to a hard-coded string (`"dev-marketing-webhook-secret"`) | any deployment without the env var accepted forged signatures | new `MARKETING_WEBHOOK_SECRET` config (empty default) and **fail closed**: unset means every event is `rejected` / `SECRET_NOT_CONFIGURED`; health reports the state |
| webhook suppression feedback ran without an identity | a public webhook has no principal, so the suppression write was refused and swallowed — a hard bounce was recorded and never applied | side effects run under the module's service identity; a failure is recorded on the inbox row as `processed_with_errors` |
| `POST action/journey/:id/trigger` was `@Public()` | an anonymous caller could probe whether a journey is published | worker capability or administrator access, like `journey/run-batch` |
| `public/click` accepted `//host` and returned a JSON body instead of redirecting | open redirect to any host, and no working bounce | same-origin only (`//`, `/\` and third-party origins refused), real `302`, invalid target is `400` |
| `public/form/submit` returned `created`/`duplicate`/`leadId` | the form confirmed whether an address was already a CRM Lead | the public route answers `{ "accepted": true }` for every outcome, including a honeypot hit |
| the form never received the caller's IP | the "10 per minute per IP" limiter was one deployment-wide bucket | the controller passes `request.ip` |

## 4. Tests actually run

One file per `vitest run` invocation: the repository's single-fork full-suite abort is pre-existing and
documented (it crashes at random file boundaries, before and between suites, with or without this module).
Every suite below boots the real API against the configured primary database, except the pure-function ones.

| Suite | Tests | Covers |
| --- | --- | --- |
| `marketing-automation.test.ts` | 26 | module surface, settings, campaign lifecycle, ACL |
| `marketing-automation-domain.test.ts` | 43 | state machines, transition tables, eligibility matrix |
| `marketing-automation-audience.test.ts` | 16 | include/exclude, dedupe, preview categories |
| `marketing-automation-audience-domain.test.ts` | 22 | criteria schema and safe query mapping |
| `marketing-automation-consent.test.ts` | 16 | consent, suppression, public unsubscribe/preferences |
| `marketing-automation-template.test.ts` | 8 | revisions, sealing, preview API |
| `marketing-automation-template-render.test.ts` | 24 | placeholders, escaping, sanitisation, fallbacks |
| `marketing-automation-provider.test.ts` | 15 | adapter contract, limiter, error classes, test send |
| `marketing-automation-send.test.ts` | 15 | send definition, dry run, approval, transitions |
| `marketing-automation-delivery.test.ts` | 6 | queue → claim → submit, retries, dead letters, emergency stop |
| `marketing-automation-journey.test.ts` | 7 | graph validation, action/trigger catalogs |
| `marketing-automation-journey-runtime.test.ts` | 6 | enrollment idempotency (including a 3-way race), lease claim, wait/completion, suppression exit |
| `marketing-automation-events.test.ts` | 21 | webhook signature/replay/dedupe, normalization, bounce/complaint/unsubscribe feedback, out-of-order events, trigger authorisation, click/open guards, form non-disclosure, health |

**225 tests across 13 suites, all passing.** No test sends mail: the delivery suites register an in-process
scripted provider, and `MAIL_TRANSPORT` is never a live transport in a test.

## 5. Settings and feature flags

One validated row, `app_settings.name = 'marketingAutomation'`, versioned and audited on every write.

| Path | Default | Consumer |
| --- | --- | --- |
| `features.campaigns` | `true` | campaign create/edit and lifecycle commands |
| `features.audience` | `false` | segment membership and preview |
| `features.templates` | `false` | placeholder rendering and content preview |
| `defaults.timezone` | `UTC` | campaign scheduling fallback (no default *purpose*, deliberately) |
| `sender.defaultEmailAccountId` | `null` | sender fallback; no fallback means validation blocks |
| `limits.maxResolveRecords` | `10 000` | audience resolution ceiling |
| `provider.key` | `""` (no provider) | send-readiness gate, test send, health |
| `provider.limits.ratePerMinute` / `maxConcurrency` | `0` / `1` | delivery limiter |
| `provider.testSend.allowedRecipients` / `requireConfirmation` / `maxRecipients` | `[]` / `true` / `5` | test-send gate |
| `delivery.chunkSize` | `100` | delivery batch claim size |
| `delivery.maxAttempts` | `3` | per-recipient retry budget |
| `delivery.staleClaimMinutes` | `15` | recovery of a dead worker's claim |
| `delivery.autoPauseAfterAuthFailures` | `3` | pause a send on repeated auth failures |
| `delivery.frequencyCapPerRecipient` / `frequencyWindowHours` | `0` (off) / `168` | send-time frequency cap |
| `delivery.publicBaseUrl` | `""` | absolute unsubscribe links; also the click-redirect origin |
| `safety.globalSendPaused` / `safety.reason` | `false` / `null` | §13 emergency stop |

Deployment configuration (not settings): `MAIL_TRANSPORT`, `SMTP_*`, `ENCRYPTION_KEY` (identity digests and
mail-account passwords), `REPORT_WORKER_SECRET` (worker→API capability), `MARKETING_WEBHOOK_SECRET`
(provider webhook verification, empty = reject everything).

Jobs: `marketing.deliveryBatch` and `marketing.journeyRunBatch` in the worker registry; both call the API's
worker-authorized endpoint, and both are **inert** (not failed) when no capability is configured.

## 6. Documentation

`docs/implementation/marketing-automation-audit.md` (MA.0 audit), `docs/compatibility/marketing-automation.md`
(behaviour matrix, refreshed to MA.19), `docs/marketing-automation/{campaign-lifecycle,consent-and-suppression,
email-templates,provider-adapters,send-definitions,integration,journey-runtime,metrics,security-and-privacy}.md`,
`docs/runbooks/{marketing-send-operations,marketing-provider-incidents}.md`, this report. OpenAPI is served
from the running app (`GET /docs`, `GET /api/v1/OpenApi`); every marketing controller is tagged
`marketing-automation`.

## 7. Known limitations (accepted, documented, not hidden)

1. **No PDF/attachment in a marketing message.** The renderer and the document engine exist, but attaching a
   generated file to an outbound message needs the attachment-storage path.
2. **No per-recipient click rewriting or open pixel.** `public/click` is a same-origin bounce and
   `public/open` is a 1×1 GIF; both record nothing. Engagement events come from provider webhooks, so a
   provider that reports no events yields no engagement data. Open tracking is approximate by design.
3. **No automatic bounce/complaint threshold pausing.** The stop is an operator decision; the runbook says so.
4. **Journey `split`/`join` validate but do not fan out.** The runtime walks a single path; A/B testing is
   Tier 3 and not built.
5. **No goal node.** A goal is a `condition` routed to an end; `GoalReached` exists in the exit vocabulary but
   no node produces it.
6. **Retention is a dry run only.** There is no destructive purge command behind this release.
7. **Public endpoints are protected by the platform's global rate limit**, not a per-route limiter; a
   deployment that exposes them to the internet should put a proxy/WAF limit in front.
8. **The form's per-IP limiter is in-process**, so it is per API instance rather than per deployment.
9. **Full-suite `pnpm test` remains unreliable** (pre-existing single-fork V8 abort); suites were run one file
   per invocation, which is how every number in §4 was produced.

## 8. Release position

Production sending is **off by default**: `provider.key` is empty, `MAIL_TRANSPORT` defaults to `none`, and
the webhook door rejects everything until `MARKETING_WEBHOOK_SECRET` is set. A deployment that wants to send
must do so deliberately, following `docs/runbooks/marketing-send-operations.md` §2, and a deployment that
wants engagement data must configure the webhook secret *and* the provider's signing secret to the same value.
