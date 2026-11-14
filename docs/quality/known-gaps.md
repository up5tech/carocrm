# Phase 22 — Known Gaps and Defects

> **Date:** 2026-10-28 (opened in Phase 22.6; entries 22.0–22.5 consolidated)
> **Plan:** `plans/PLAN_Phase_22_Integration_E2E_Hardening.md` §3.2
> **Rule:** every entry names the evidence it rests on. A gap that is not reproduced is a hypothesis, and a hypothesis is labelled as one.
> **Status vocabulary:** `Open` · `Fixed` (with the commit/test) · `Accepted` (a deliberate decision, with the reason) · `Deferred` (belongs to a later sub-phase, named)

---

## Summary

| ID | Title | Module | Severity | Status |
|---|---|---|---|---|
| G1 | Route-level OpenAPI exists; DTO schemas absent (security schemes added 23.5) | platform | Medium | Partial — D3 deviation recorded (24.2), owner sign-off pending |
| G2 | Event payloads carry no `schemaVersion`, `correlationId` or `dedupeKey` | platform | Medium | Deferred (22.7) |
| G3 | `LeadConversionService` has no direct service-level test | lead-score | Low | Open |
| G4 | `advanced-integrations-contracts.test.ts` leaves two contacts behind | advanced-integrations | Low | Open |
| G5 | The worker test suite is not part of the root `pnpm verify` gate | platform | Medium | Deferred (22.22) |
| G6 | Most domain events have no registered consumer | platform | Medium | Accepted (documented) |
| G7 | Two provider-key conventions across two port families | esignature / advanced-integrations | Info | Fixed (22.6) |
| G8 | The shared core imports two business domains | platform | Medium | Accepted (allow-listed) |
| G9 | The default JWT secret is accepted in non-production environments | auth | High | Fixed (22.4) |
| G10 | The architecture guard threw a `ReferenceError` instead of reporting a violation | platform | Medium | Fixed (22.6) |
| G11 | The connector dead-letter replay route has no capability check | advanced-integrations | Medium | Fixed (22.14, as part of G43) |
| G12 | The signature webhook inbox stamps a purge date that nothing acts on | esignature | Low | Fixed (23.7) |
| G13 | Two provider receipt tables have no retention at all | voice-communications / marketing-automation | Low | Fixed (23.7) |
| G14 | The `jobs` and `job_logs` tables have no retention | platform | Medium | Fixed (23.7) |
| G15 | No jitter on the queue or outbox retry | platform | Medium | Fixed (22.18) |
| G16 | `JOB_BACKOFF_BASE_MS` is dead configuration and the two attempt settings can diverge | platform | Low | Open (22.21) |
| G17 | The CSV import keeps its per-row errors in memory only | search | Low | Open (22.9) |
| G18 | No projection compares an event's timestamp — every ordering guard is a state-machine rule | platform | Medium | Accepted (22.18 decision) |
| G19 | No door detects "same idempotency key, different body" | platform | Medium | Fixed (22.18) |
| G20 | The payment provider event key is not scoped by provider | sales | Low | Fixed (22.19) |
| G21 | A failed `jobs` row can be neither retried nor discarded through the API | platform | Medium | Fixed (23.7) |
| G22 | The duplicate-job collapse looks for a status that never exists (`active`) | lead-score | Medium | Fixed (22.19) |
| G23 | A connector dead letter can be marked "replayed" without the failed work being re-run | advanced-integrations | Medium | Fixed (23.4) |
| G24 | The marketing form's Lead write is silently truncated — six fields the form writes are not Lead fields, so they are deleted | marketing-automation | Medium | Fixed (22.12) |
| G25 | There is no first-class campaign↔Lead link; the Lead carries only a free-text `source` | lead-score / marketing-automation | Medium | Fixed (22.12) |
| G26 | There is no Sales→ESignature contract; a completed signature has no consumer in the platform | sales / esignature | Medium | Open (22.9+) |
| G27 | Customer Success never creates or reads `Project`/`ProjectTask`; the only link is the plan's `projectId` | customer-success / projects | Medium | Open (22.10+) |
| G28 | The customer-success suite leaves the default onboarding template's Task behind | customer-success (test hygiene) | Low | Fixed (verified 22.11) |
| G29 | A connector webhook delivery leaves a pending durable `jobs` row that the delivering suite does not remove | advanced-integrations (test hygiene) | Low | Open (partly fixed 22.11; the 22.14 journey removes its own) |
| G30 | Hard-deleting an entity leaves its `stream_items` (and attachment rows) behind as orphans | platform (Entity Engine delete) | Medium | Partial (23.7: stream fixed; attachment rows exception) |
| G31 | The campaign reports answered any authenticated caller, and the event log named recipients the caller could not open | marketing-automation | High | Fixed (22.12) |
| G32 | A replayed attribution outcome double-counted the conversion and its revenue | marketing-automation | Medium | Fixed (22.12) |
| G33 | The marketing webhook "signature" is the shared secret itself, and a delivery with no timestamp is never age-checked | marketing-automation | Medium | **Fixed 23.5** (HMAC over raw body + mandatory timestamp) |
| G34 | Help retrieval read Service Desk's knowledge corpus with the caller's rights ignored | crm-chat → service-desk | Medium | Fixed (22.13) |
| G35 | The MCP-shaped tool door could commit an approval-class write with no decision anywhere | ai-agents | Medium | Fixed (22.13) |
| G36 | Three declared run and approval states are unreachable | ai-agents | Low | Open (found 22.13) |
| G37 | A user whose Case scope is `own` cannot create a Case at all | service-desk / platform ACL | Medium | Fixed (2026-11-03) |
| G38 | `features.readTools` is declared as the gate for turns and queries and never enforced | crm-chat | Medium | Fixed (2026-11-03, deployment-visible) |
| G39 | A turn's own `sources` list is handed back without re-authorization | crm-chat | Low | Fixed (2026-11-03) |
| G40 | None of the connector's five worker doors could be reached by the worker | advanced-integrations | High | Fixed (22.14) |
| G41 | The webhook job the API enqueues was refused by the door that receives it, and its domain-claim flag was dropped | advanced-integrations | High | Fixed (22.14) |
| G42 | A verified webhook answered "no events" whenever the connector did not mention a challenge | advanced-integrations | Medium | Fixed (22.14) |
| G43 | Nine connector write routes had no capability check anywhere | advanced-integrations | High | Fixed (22.14) |
| G44 | The sync checkpoint advanced only at the end of the loop, and a bounded run advanced it past records it never applied | advanced-integrations | High | Fixed (22.14) |
| G45 | Cancelling a run stopped nothing, and a cancelled run could be cancelled again | advanced-integrations | Medium | Fixed (22.14) |
| G46 | `features.connections` was stored and displayed but enforced nothing | advanced-integrations | Medium | Fixed (22.14) |
| G47 | Token refresh is implemented, serialised and tested — and no production path calls it | advanced-integrations | Medium | Fixed (23.3) |
| G48 | The resilience layer the sync path never uses: rate limiter, retry policy, `assertCallable` | advanced-integrations | Medium | Open (22.21; 22.18 decided scope) |
| G49 | `deletionPolicy: 'archive'` behaves exactly like `unlink` | advanced-integrations | Low | Open (found 22.14) |
| G50 | A mapping asked for "the connection for this provider" gets one picked by name order | advanced-integrations | Medium | Fixed (23.3) |
| G51 | The OAuth callback never compares the redirect URI its own comment claims it checks | advanced-integrations | Medium | Fixed (23.3) |
| G52 | A provider's own error text is echoed into a 401, and a credential reference points at the connection, not the credential | advanced-integrations | Low | Fixed (23.1) |
| G53 | A delivery deferred by a paused connection or a disabled module is never picked up again | advanced-integrations | Medium | Open (found 22.14) |
| G54 | An unexpected error sent its own text to the browser inside `details.reason` | platform / SPA | High | Fixed (22.15) |
| G55 | A rejected save never marked the fields the server named | platform / SPA | Medium | Fixed (22.15) |
| G56 | `details.retryAfterSeconds` was produced by the server and read by no caller | platform / SPA | Low | Fixed (22.15) |
| G57 | Fifteen screens formatted dates and numbers in the browser's locale and zone | platform / SPA | Medium | Fixed (22.15) |
| G58 | A placeholder dash and two surfaces were painted with black alpha literals | platform / SPA | Low | Fixed (22.15) |
| G59 | A loading skeleton said nothing to a screen reader | platform / SPA | Medium | Fixed (22.15) |
| G60 | The webhooks tab decided "module not installed" from a message containing "404" | platform / SPA | Low | Fixed (22.15) |
| G61 | One chat string was hard-coded English in a shared component | crm-chat / SPA | Low | Fixed (22.15) |
| G62 | The chat action card rendered its own decision response instead of the server's | crm-chat / SPA | Medium | Fixed (22.15) |
| G63 | No route guard sits in front of `/admin/*` — only the menu is filtered by the server | platform / SPA | Medium | Fixed (2026-11-03) |
| G64 | ~150 call sites still show `error.message` raw instead of the code-aware helper | platform / SPA | Medium | Open (found 22.15) |
| G65 | Home content is chosen from `principal.roles` in the client, a rule the server does not mirror | platform / SPA | Low | Fixed (23.4) |
| G66 | No browser spec asserts an error, denied or empty state, and login is English-only | platform / SPA / e2e | Medium | Open (found 22.15; error/empty/denial browser spec added in 22.16, run pending) |
| G67 | Column resize is mouse-only, and modal focus trap/restore rests on antd defaults with no assertion | platform / SPA | Low | Open (found 22.15) |
| G68 | A core record write does not invalidate the module panels keyed to that record | platform / SPA | Low | Open (found 22.15) |
| G69 | The stock-movement history page returned an arbitrary 200-row sample, not the newest movements | sales (inventory read) | Medium | Fixed (22.26) — the "lot stock" diagnosis was wrong |
| G70 | An outbox event claimed by a worker that then died stayed `running` forever | platform (outbox) | High | Fixed (22.18) |
| G71 | Offset pagination is a live window, not a snapshot | platform (entity list) | Low | Accepted (22.19) |
| G72 | An AI approval did not pin the target record's version | ai-agents | Medium | Fixed (22.19) |
| G73 | Bulk update/delete have no record-count cap and run one record at a time | platform (entity list) | Medium | Fixed (22.26) |
| G74 | No per-query statement timeout or request deadline | platform (database) | Medium | Fixed (22.26) |
| G75 | The allocation picker silently hid every issued document past the first 500 | sales (allocation read) | Medium | Fixed (22.26) — the "flake" was this truncation |
| G76 | Readiness checks the database only; queue/provider health is on demand | platform (health) | Medium | Accepted (22.21) |
| G77 | No continuous metrics/tracing exporter; metrics are derived module documents | platform (observability) | Medium | Accepted (22.21; security counters added 23.8, still no exporter) |
| G78 | CI is a nightly integrity check, not a PR gate; a regression can land before detection | platform (CI) | Medium | Accepted (22.22 decision) |
| G79 | `hooks-events` restore-event test flakes under the full parallel suite but passes solo | platform (test isolation) | Low | Fixed (22.26, found 22.22) |
| G80 | The restore drill is blocked: no approved isolated recovery environment, no approved RPO/RTO | platform (operations) | Medium | **Blocked (23.9, 2026-11-12)** — tooling ready, both approvals unnamed/outstanding; no drill run |
| G81 | No automated, encrypted, off-host backup; the existing demo artifact is partial and world-readable | platform (operations/security) | High | **Blocked (23.9, 2026-11-12)** — tooling shipped, no installed backup/off-host copy/alert recipient |
| G82 | The movement history exposed a limit with no way to page deeper | sales (inventory read) | Medium | Fixed (22.27) |
| G83 | Three worker doors cannot be called by the worker — they lack `@Public()` | sales / marketing-automation | Medium | Fixed (23.4) |
| G84 | The OAuth callback never compares a redirect URI | advanced-integrations | Medium | Fixed (23.3) |
| G88 | Every module system principal carries `sysAdmin`, so record ACL is bypassed for worker and public-intake writes | platform | Medium | Mitigated (23.4) |
| G89 | The worker's BPM/workflow handlers write CRM records through the worker's own DB access | worker | Medium | Open — exception G89 |
| G90 | `GET /api/v1/OpenApi` is served without authentication | platform | Low | Open — exception G90 |
| G91 | Readiness returns database reachability to an anonymous caller | platform | Low | Open — exception G91 |
| G92 | The DB-free CI lane has no API authorization assertion | platform (CI) | Medium | Partial (23.8/23.10) — exception G92 |
| G93 | The Phase 22.17 exception list drifted from this register | platform (docs) | Low | Fixed (23.0) |
| G94 | `POST /api/v1/Refresh` is public and cookie-driven with no CSRF check | auth | Medium | Fixed (23.1) |
| G95 | The AI-agent trigger door reads only the first 20 published agents, ordered by a random UUID | ai-agents | Medium | Open — exception G95 |
| G96 | A non-admin could read any record's audit history by supplying its id | audit / ACL | Medium | Fixed (23.4) |
| G97 | Dependency-vulnerability audit is manual, not in the mandatory gate | platform | Low | Accepted (23.6) |
| G98 | The three sample extension packages in `modules/` are unsigned | extensions | Low | Accepted (23.6) |

**Phase 23.11 status note (2026-11-13).** The Phase 23 security workstream is finished and its release review is
recorded in `docs/quality/phase-23-security-release-review.md` with a **NO-GO** decision. Two rows block a
production release: **G81** (High — no installed, encrypted, off-host backup) and **G80** (no approved recovery
environment or RPO/RTO), both **Blocked** by owner decision D4, plus the release-wide `LICENSE`/distribution
blocker that this register tracks by decision, not by G-ID. Every other open row above is a live exception with a
named owner and a review date in `docs/security/exception-register.md`; the exception register, not this table, is
the authoritative list of what is accepted. No new finding was raised by 23.11.

---

## G1 — The generated OpenAPI document carries no contract

- **Module / contract:** platform — every `/api/v1/**` route.
- **Impact:** a client cannot be generated or checked against the API. `@nestjs/swagger` decorators exist on nearly every controller, but no `DocumentBuilder`/`SwaggerModule` setup does, and there is no global prefix or versioning — so no document is produced.
- **Expected vs observed:** expected — a spec generated from the DTOs; observed — the catalog (`docs/architecture/contract-catalog.md`) plus hand-written assertions.
- **Root cause:** the swagger decorators were added per controller; the assembly step was never added.
- **Status:** Deferred to 22.22 (CI quality gates). 22.6 compensates with DTO-shape and error-envelope assertions at the route boundary rather than a generated spec.
- **Remaining risk:** a client built from the catalog can still drift from the DTOs between releases.

### G1 correction (Phase 23.0, 2026-11-09)

The original title said "No generated OpenAPI document". That was **half wrong**, and the correction is recorded here
rather than in a second register. A document **does** exist and is served: `apps/api/src/bootstrap.ts:238` registers
`GET /api/v1/OpenApi` returning `instance.swagger()`, generated by `@fastify/swagger` from the registered Fastify
routes. `docs/reference/compatibility-matrix.md:22` was correct about this.

An executed probe on 2026-11-09 (`GET /api/v1/OpenApi`, anonymous) measured what the document actually contains:

- **772 paths**, each with a verb and a bare `"Default Response"`;
- `components.schemas` = **0**;
- `requestBody` present on **0** paths;
- response `content` present on **0** paths;
- `securitySchemes` = **null**.

The 57 `@nestjs/swagger` imports under `apps/api/src` are `ApiTags` only — there is no `ApiProperty`, no
`ApiOperation` and no `DocumentBuilder`/`SwaggerModule` anywhere in the repository.

**Accurate statement of the gap:** *a route-level OpenAPI document is generated and served, but it carries no
DTO-derived schemas, no request/response bodies and no declared security scheme, so the API contract is still not
machine-verifiable.* The gap survives in substance; only the wording was wrong. Target: **23.5**.

### G1 update (Phase 23.5, 2026-11-12)

The document now declares the two real authentication schemes (`cookieAuth` on `CRM-SESSION`, `bearerAuth`), and
`apps/api/test/phase22-security-injection.test.ts` contract-tests representative paths and verbs (`/api/v1/{entity}`,
`/api/v1/{entity}/{id}`, `/api/v1/Authentication`) plus those schemes. **The DTO half is still absent:**
`components.schemas` remains empty and no route carries `requestBody`, because the API is validated with Zod at the
controller boundary rather than class DTOs. That is recorded as a **proposed accepted deviation**: the route-level
contract is machine-checkable, the payload shapes are documented in `docs/architecture/contract-catalog.md` and
asserted at the route boundary, and generating 772 request/response schemas from Zod is a separate, larger change.
Owner sign-off and a target phase (23.9 or later) are still required; this entry is not marked closed.
Related: **G90** (the document is served without authentication; owner decision still pending).

### G1 disposition (Phase 24.2, 2026-11-14 — D3 recorded, sign-off still pending)

Owner decision **D3** from `plans/PLAN_Phase_24_Product_Completion.md` §0.3 was applied as the governing
default by the Phase 24.0 audit (`docs/quality/phase-24-priority-decisions.md` §3): **accept the
route-inventory deviation**. `GET /api/v1/OpenApi` stays a generated route inventory;
`docs/architecture/contract-catalog.md` stays the prose convention reference; `api-spec/*.yaml` is the
canonical reviewed contract and must reach `pnpm ci:api-spec --strict` in Phase 24.4. Full DTO-derived
OpenAPI for ~772 routes is **not** required, but machine-readable payload schemas for the bounded
generated-client surface in 24.4 are mandatory. Coverage is unchanged by 24.2: 4 registry files,
63 documented and matched endpoints, 915 `/api` routes in source, 852 undocumented.

**This is a recorded default, not an owner signature.** G1 remains `Partial`: the deviation is proposed
and governed by D3, but the register does not mark it `Accepted`, and no exception was accepted by an
agent. **G90** (the inventory is served without authentication) is a separate owner decision that D3
does not resolve. Closure evidence is a signed D3 sign-off plus `pnpm ci:api-spec --strict` green in
24.4; until then this entry stays open. The matching register note is
`docs/security/exception-register.md` §5.

## G2 — Event payloads carry no version, correlation or dedupe key

- **Module / contract:** platform — `outbox_events.payload`.
- **Impact:** cross-version tolerance and replay safety rely entirely on consumer code being additive-tolerant. There is no first-class key to dedupe on, so "was this event already handled?" has no answer inside the event itself.
- **Evidence:** `outbox_events` has only `event_type` + `payload` (`docs/architecture/contract-catalog.md` §3, Finding F2).
- **Status:** Deferred to 22.7 (idempotency, outbox/inbox, retry hardening), which will assert the envelope in replay tests. 22.6 verified the **current** rule — a consumer tolerates unknown optional fields and ignores an unknown event type (`apps/worker/src/events/domain-event-bus.contract.test.ts`).
- **Remaining risk:** a consumer written before a producer adds a field relies on that tolerance; a consumer that throws on an unexpected field would block the outbox.

## G3 — `LeadConversionService` has no direct service-level test

- **Module / contract:** lead-score → CRM records (conversion).
- **Impact:** the conversion's *route* contract is well covered (`apps/api/test/lead-score-conversion.test.ts`, `lead-score-conversion-preview.test.ts`, `lead-score-duplicates.test.ts`), but `LeadConversionService.convert` / `.affordance` / `.operationByKey` and `LeadConversionAuditService` are only exercised through HTTP.
- **Why it was not fixed in 22.6:** duplicating the same assertions at a second layer adds no evidence; the plan asks for the critical edges to be covered, not for every class to have a test.
- **Status:** Open. A service-level test is worth writing when 22.8 exercises the lead→customer journey.
- **Remaining risk:** a change to the service that keeps the route's behaviour cannot be detected separately from a route change.

## G4 — A pre-existing suite leaves two records behind

- **Module / contract:** advanced-integrations (test hygiene, not product behaviour).
- **Impact:** `apps/api/test/advanced-integrations-contracts.test.ts` creates two `Contact` records (`Protected Target`, `Record`) and its cleanup does not remove them; they were observed in the configured database after a run on 2026-10-28.
- **Status:** Open. The rows were left untouched (AGENTS.md §3.3 — cleanup only what the run can positively identify). The Phase 22.1 run-id policy (`apps/api/test/support/test-run.ts`) is the intended fix.
- **Remaining risk:** the primary database keeps accumulating `AGENT_TEST_%` rows — the 22.0 audit counted 25,847 of them.

## G5 — The worker test suite is outside the root quality gate

- **Module / contract:** platform — the test gate itself.
- **Impact:** `pnpm verify` runs the root Vitest config, which collects `apps/api/test` and `packages/*/src` only. The worker package keeps its own config (`apps/worker/vitest.config.ts`, 21 files, 215 tests), so a green `pnpm verify` says nothing about the worker's handlers — including the outbox consumer that every domain event depends on.
- **Status:** Deferred to 22.22 (CI quality gates). 22.6's consumer-contract test therefore runs under `pnpm --filter @carocrm/worker test`.
- **Remaining risk:** a regression in a worker handler is invisible to the default local gate.

## G6 — Most domain events have no registered consumer

- **Module / contract:** platform — `serviceDesk.*`, `customerSuccess.*`, `esignature.*`, `marketing.*`, `aiAgents.*`.
- **Impact:** the events are published into the outbox and the poller logs "no handler" and marks them processed. A journey that assumes "event X triggers Y" silently does nothing.
- **Status:** Accepted — documented in `docs/architecture/contract-catalog.md` §3 and §7 rather than "fixed", because the missing consumers are product features, not defects.
- **Remaining risk:** 22.8–22.14 must verify the consumer exists before a journey relies on it.

## G7 — Two provider-key conventions

- **Module / contract:** esignature and advanced-integrations.
- **Impact:** the connector registry accepts hyphen-only keys (`/^[a-z][a-z0-9-]{1,63}$/`), the signature module's keys use an underscore (`dropbox_sign`). A suite copied from one family to the other reports a false failure.
- **Status:** Fixed in 22.6 — the signature provider conformance suite uses the signature module's own convention, and the difference is documented in `apps/api/src/esignature/providers/signature-provider.contract.ts`.
- **Verification:** `apps/api/test/phase22-provider-contract.test.ts` → "is honoured by every adapter this build ships" (fake, DocuSign, Dropbox Sign).

## G8 — The shared core imports two business domains

- **Module / contract:** `acl/acl-api.service.ts` → `portal`, `projects`; `search/dashboard.service.ts` → `esignature`, `lead-score`, `projects`.
- **Impact:** the dependency direction points up, so a shared service can break when a domain changes.
- **Status:** Accepted as a reviewed exception, allow-listed in `scripts/check-architecture-boundaries.mjs` (`KNOWN_VIOLATIONS`) so the static gate fails only on **new** violations. The refactor is not part of Phase 22.
- **Verification:** `pnpm lint:arch` passes today.

## G9 — The default JWT secret

- **Module / contract:** auth — every session token.
- **Impact:** a deployment that boots without `JWT_SECRET` would accept a publicly known signing key, letting anyone forge a session.
- **Expected vs observed:** expected — refuse to boot in production; observed (before 22.4) — a silent default.
- **Status:** Fixed in 22.4 — `apps/api/src/config.ts` now refuses the default secret when `NODE_ENV=production`.
- **Verification:** `apps/api/test/config-jwt-secret.test.ts`.

## G10 — The architecture guard failed in the path it exists for

- **Module / contract:** platform — the shared-core boundary guard.
- **Impact:** `scripts/check-architecture-boundaries.mjs` built the relative path `rel` inside a block and used it outside it. The guard therefore threw a `ReferenceError` instead of reporting a violation — the guard was blind exactly when it had something to report — and it kept `pnpm lint` red, which blocked the whole quality gate.
- **Expected vs observed:** expected — a new shared-core → business-domain import is reported as a violation; observed — a `ReferenceError` (and a lint error).
- **Root cause:** the variable was declared in the "not a known violation" branch but used in the reporting branch.
- **Status:** Fixed in 22.6 — `rel` is computed once at the top of `checkFile`.
- **Verification:** `pnpm lint` (clean) and `pnpm lint:arch` (`OK: no new shared-core -> business-domain imports (known exceptions=2)`).
- **Remaining risk:** none known; the guard still allow-lists the two reviewed exceptions from G8.

---

## G11 — The dead-letter replay route has no capability check

- **Module / contract:** advanced-integrations — `POST /api/v1/AdvancedIntegrations/action/dead-letters/:id/replay`.
- **Impact:** every other route in that controller checks a capability server-side (its own header comment says so), but this one does not. Any caller who can reach the controller can mark a dead letter as replayed.
- **Status:** Open — deferred to 22.17 (security and privacy regression suite), where the authorization matrix becomes a test.
- **Remaining risk:** the replay only flips a status and writes an audit row (see G23), so the damage today is a misleading queue rather than a re-run.

### G11 correction (Phase 23.0, 2026-11-09)

The detail entry above was **stale**; the summary row ("Fixed 22.14, as part of G43") was right. The route does carry a
server-side capability check — `apps/api/src/advanced-integrations/advanced-integrations.controller.ts:411-415`:

```ts
@Post('action/dead-letters/:id/replay')
async replayDeadLetter(@Param('id') id: string) {
  await this.permissions.assert('connectionAdmin');
  return this.deadLetters.markReplayed(id);
}
```

`permissions.assert` resolves the capability through `AclApiService.canUser(INTEGRATION_CONNECTION_PERMISSION_ENTITY, 'edit')`
and throws `AuthorizationDeniedError` when the level is `no`
(`apps/api/src/advanced-integrations/advanced-integrations-permission.service.ts:48-57`). Every route in that
controller carries the same gate.

**Status: Fixed.** The residual risk below still stands and is tracked as **G23**: `markReplayed`
(`apps/api/src/advanced-integrations/dead-letter.service.ts:127-145`) flips the status and writes an audit row but
does **not** re-run the failed work, so the route's contract overstates what it does. Target: **23.4**.

## G12 — The signature webhook inbox stamps a purge date that nothing acts on

- **Module / contract:** esignature — `signature_webhook_inbox.purge_after` (90 days by default).
- **Impact:** the column is written and never read; the inbox and `signature_provider_events` grow without bound. The dedup rows are never deleted, so a late redelivery stays a duplicate — the safe side of the trade.
- **Status:** **Fixed (23.7).** `system.cleanupProviderReceipts` reads `purge_after`: the normalized event payload is minimized to `{}` and terminal inbox receipts are deleted once the deadline passes. Non-terminal receipts stay for replay. Regression: `apps/worker/src/handlers/job-handlers.test.ts`; policy: `docs/security/data-retention.md` §2.

## G13 — Two provider receipt tables have no retention at all

- **Module / contract:** voice-communications (`voice_webhook_events`) and marketing-automation (`marketing_provider_webhook_inbox`).
- **Impact:** the receipts accumulate. The marketing module declares a 30-day policy in `RETENTION_POLICIES` and its retention service only ever counts rows — the delete does not exist.
- **Status:** **Fixed (23.7).** The provider-receipt job minimizes voice payloads after 90 days and deletes only terminal receipts with no `voice_communication_events` child; marketing inbox receipts are deleted after 30 days while `marketing_events` survives (`inbox_id` is set null). Regression: `apps/worker/src/handlers/job-handlers.test.ts`.

## G14 — The `jobs` and `job_logs` tables have no retention

- **Module / contract:** platform — the durable record of every job and every attempt.
- **Impact:** the development database held 6 574 `jobs` rows, and on 2026-10-29 **279 028 `pending` `outbox_events`** against 869 `processed`. The kernel's `system.cleanupOutbox` and `system.pruneSessions` handlers exist but are **not seeded as schedules**, so nothing cleans either table by default. The 22.18 outbox lease makes crash recovery correct but does not drain the backlog.
- **Status:** **Fixed (23.7).** Migration `094_phase23_retention_schedules.sql` seeds `cleanupOutbox`, `pruneSessions`, `cleanupJobs` and the provider/stream sweeps; `system.cleanupJobs` deletes terminal job rows after 30 days in 500-row batches, oldest first, and `job_logs` cascades. Regression: `job-handlers.test.ts`; policy: `docs/security/data-retention.md` §1.

## G15 — No jitter on the queue or the outbox retry

- **Module / contract:** platform — `apps/worker/src/queue/job-consumer.ts` and `apps/worker/src/outbox/outbox-poller.ts`.
- **Impact:** both backoffs are pure exponential. A fleet that failed at the same moment retries at the same moment, which is the opposite of what jitter is for. The only jittered retry in the codebase is the provider HTTP call (`advanced-integrations/resilience.ts`).
- **Status:** **Fixed (22.18).** `apps/worker/src/backoff.ts` owns the plan and equal jitter; the outbox poller (`retryDelayMs`) and the BullMQ consumer (`jobRetryDelayMs` via `backoffStrategy`) both use it. `backoff.test.ts` pins the bounds and the spread; the poller/consumer tests pin the exact delay with an injected `random`. See `docs/quality/phase-22-resilience-chaos.md` §5.1.

## G16 — Dead retry configuration

- **Module / contract:** platform — `JOB_BACKOFF_BASE_MS` and `JOB_ATTEMPTS` on the API side.
- **Impact:** the worker's `backoffStrategy` replaces BullMQ's own strategy, so the API's backoff base has no effect; and the effective attempt count is the one baked in at enqueue, so `JOB_ATTEMPTS=10` with `WORKER_JOB_ATTEMPTS=1` silently yields ten attempts.
- **Status:** Open — deferred to 22.21.

## G17 — The CSV import has no persisted per-item outcome

- **Module / contract:** search — `import-export.service.ts`.
- **Impact:** the per-row errors live in an in-memory result and are capped at 50; a re-import redoes every row, so a partially successful import cannot be resumed.
- **Status:** Open — deferred to 22.9, where the import path is exercised as a journey.

## G18 — No projection compares an event's timestamp

- **Module / contract:** platform — every state projection (signature envelope, signature recipient, voice call, voice message, marketing delivery, payment request).
- **Impact:** the ordering guards are state-machine rules, so a terminal state cannot regress — but an older event whose target is still a legal *forward* move does move the projection forward. A call that is `in_progress` today and receives a `ringing` event from yesterday becomes `ringing`.
- **Status:** **Accepted (22.18)** as a documented product decision: a provider's clock is not a contract this platform can verify (providers replay, batch and skew events independently), so provider timestamps stay informational and the state machine stays the ordering authority. The stale-forward case remains visible in the event timeline. Making timestamps authoritative needs a per-projection `last_event_at`, a rule for whose clock wins, and a migration for existing rows — not a hardening patch. Owner: platform. Review date: 2026-11-30, together with 22.19 concurrency work. See `docs/quality/phase-22-resilience-chaos.md` §7.

## G19 — No door detects "same idempotency key, different body"

- **Module / contract:** platform — the five provider ingresses.
- **Impact:** three of them store a body hash (`signature_webhook_inbox.payload_hash`, `signature_provider_events.payload_hash`, `voice_webhook_events.payload_digest`) and never compare it. A delivery that reuses a key with a different body is treated as a replay: the new body is discarded and nothing happens, so the platform is *safe* — but the mismatch is never surfaced to an operator.
- **Status:** **Fixed (22.18).** Every hash-storing door compares on redelivery and keeps the first delivery as the receipt of record: voice stamps `failure_code = DEDUP_BODY_MISMATCH` on the receipt and returns `bodyMismatch`; ESignature writes a `provider.event_body_mismatch` audit entry (declared action, translated) and stamps the inbox receipt; the provider-event table's duplicate branch does the same. No quarantine table was needed — the receipt *is* the quarantine record, and an operator sees it where they already look. Regression: `phase22-out-of-order-events.test.ts` (voice), `esignature-events.test.ts` (signature). See `docs/quality/phase-22-resilience-chaos.md` §5.3.

## G20 — The payment provider event key is not scoped by provider

- **Module / contract:** sales — `PaymentProviderEventLog.providerEventId`.
- **Impact:** the key is the provider's event id alone, so two providers sharing an id space would collide. Harmless today: only Stripe feeds the payment path.
- **Status:** **Fixed (22.19).** The service looks events up by `(provider, providerEventId)` in both the fast path and the unique-violation answer. Migration 024 already had the correct scoped index (`uq_payment_provider_event`); migration 083 had added a second, narrower unique index on `providerEventId` alone while closing the concurrent-delivery race. Migration `085_phase22_payment_event_key_scoped.sql` drops that redundant index; the scoped index still makes the write the decision for concurrent deliveries of one provider. Regression: `sales-payments.test.ts` "scopes a provider event id by provider…". See `docs/quality/phase-22-data-integrity-concurrency.md` §6.5.

## G21 — A failed `jobs` row can be neither retried nor discarded through the API

- **Module / contract:** platform — `apps/api/src/jobs/`.
- **Impact:** the jobs API exposes create, list, get, log and cancel. An operator who wants a failed job to run again must re-submit it by hand (`POST /api/v1/Job`), and there is no way to discard one. The admin "purge the job queue" operation drains the Redis waiting list only and leaves the table untouched.
- **Status:** **Fixed (23.7).** `POST /Job/:id/action/retry` re-submits a **failed** job as a new row (the failed row stays as history); `POST /Job/:id/action/discard` removes an exact **terminal** row and its logs. Pending/running work must be cancelled first. Regression: `apps/api/test/jobs.test.ts`.

## G22 — The duplicate-job collapse looks for a status that never exists

- **Module / contract:** lead-score — `lead-score-recalculation.service.ts`.
- **Impact:** the collapse filters `status IN ('pending','active')`, but a job's status is one of `pending | running | completed | failed | cancelled`. A second recalculation job can therefore be queued for the same lead while the first is still running.
- **Status:** **Fixed (22.19).** The filter is now `('pending','running')`. Regression: `lead-score-recalculation.test.ts` "collapses a newer trigger even after the first job started running (G22)" — the first row is moved to `running`, a newer revision must answer `alreadyQueued` with the same id, and one row remains. See `docs/quality/phase-22-data-integrity-concurrency.md` §6.4.

## G23 — A dead letter can be marked "replayed" without the work being re-run

- **Module / contract:** advanced-integrations — `DeadLetterService.markReplayed`.
- **Impact:** the route flips the status to `replayed` and writes an audit row; it does not re-enqueue the failed operation, and no route ever calls `markDiscarded`. An operator reading the queue sees "replayed" for work that was never retried.
- **Status:** Fixed (23.4) — a terminal sync failure now records the mapping and run it failed on, `replayTarget` refuses a letter that cannot be re-run, and `markReplayed` requires the id of the run that actually performed the replay. The route re-runs the mapping's inbound sync before it stamps the letter, and leaves the letter `open` when the run fails. Regression: `apps/api/test/advanced-integrations-engine.test.ts` (replay context and single replay).

## G24 — The marketing form's Lead write is silently truncated

- **Module / contract:** marketing-automation → CRM — the public web-form intake.
- **Impact:** `MarketingFormService.createLead` writes `companyName`, `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` and `formIntakeKey` onto a `Lead`. The `Lead` entity declares none of them, and `EntityCrudService.prepareWrite` deletes every key the metadata does not declare. So the company is lost (the Lead field is `company`), the campaign and UTM reference never reach the Lead, and the form's own intake-key idempotency lookup (`attrs ->> 'formIntakeKey'`) can never match — a repeated intake with a different e-mail address creates a second Lead.
- **Expected vs observed:** expected — the intake records where the lead came from and the same intake key never creates two Leads; observed — the record keeps only `source`.
- **Root cause:** two modules disagree about the Lead's shape. The form was written against a richer Lead than the metadata declares.
- **Status:** Fixed (22.12) — `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` and `formIntakeKey` are declared `Lead` fields (JSONB attributes, so no table changed), the form writes the declared `company` instead of `companyName`, and a record-API write of any of them is refused with `MARKETING_INTAKE_FIELDS_SERVER_OWNED` because that evidence belongs to the intake. They are shown in the Lead detail view's `Acquisition` panel — which the platform's own guard (`lead-score-schema.test.ts`) requires, because every `inDetail` field has to be placed rather than quietly dropped from the view.
- **Verification:** found while building the Phase 22.8 journey (`docs/quality/phase-22-journey-lead-to-customer.md` §8, F3); proven by the Phase 22.12 journey step 2 (`docs/quality/phase-22-journey-marketing-consent-attribution.md`).

## G25 — There is no first-class campaign↔Lead link

- **Module / contract:** lead-score / marketing-automation — "which campaign produced this lead".
- **Impact:** the `Lead` entity carries only the free-text `source`. The campaign↔Lead association lives outside the Lead record: `marketing_events.campaign_id`, `MarketingConsent.campaignId`, `TargetListEntry` and the journey enrollment. LeadScore reads the `marketing_events` association (its engagement signal) and ignores the campaign id, so a score cannot say *which* campaign engaged the lead.
- **Status:** Fixed (22.12) — `Lead.campaignId` is now a declared link to `Campaign`, audited and written only by the intake, so "which campaign produced this lead" is a fact on the Lead and a filterable reference rather than a join through the event log. The direction stays one-way (a Lead names one campaign); a campaign's Leads are read by filtering the Lead list, and `marketing_events` remains the touch-level record.

## G26 — There is no Sales→ESignature contract, and a completed signature has no consumer

- **Module / contract:** sales ⇄ esignature — "a quote is sent for signature" and "a signed document changes the commercial record".
- **Impact:** the two modules do not import each other, no contract adapter exists for ESignature, and the events ESignature publishes (`esignature.requestCompleted`, `esignature.completedArtifactAvailable`) have **no subscriber** anywhere in the platform. The only link that exists is the generic pair `sourceEntityType` + `sourceRecordId` a signature request stores — `signature-record-entry.service.ts` lists `Quote`, `SalesOrder` and `Invoice` as entry points, so a request *may* name a commercial record, and nothing reads that link back.
- **Expected vs observed:** expected — a signed quote reaches the order it became; observed — a signature is a fact about a document, and Sales never hears of it.
- **Status:** Open — this is a product decision rather than a defect, and it was found while building the Phase 22.9 journey (`docs/quality/phase-22-journey-quote-to-signature.md` §8, F1). The journey proves the *negative* the plan asks for (a signed document does not make an invoice paid), which holds precisely because no such path exists.
- **Remaining risk:** an installation that expects "signed ⇒ paid" or "signed ⇒ ordered" will not get it, and no diagnostic will say so.

## G27 — Customer Success never creates or reads a Project

- **Module / contract:** customer-success ⇄ projects — "the onboarding plan and the delivery project are the same thing".
- **Impact:** the only link is `CustomerSuccessPlan.projectId`, a reference written by `CustomerSuccessPlanService.create`. The health engine's facts (`loadFacts`) read no `Project` and no `ProjectTask`, no signal provider looks at one, and the Projects module never writes a Customer Success record. So completing a project milestone moves nothing in Customer Success: the profile's score, status, progress and onboarding state stay exactly where they were. That is the correct line — a delivery milestone is not a customer touch — but an installation that expects the two to move together will not get it.
- **Status:** Open — a product decision rather than a defect, found while building the Phase 22.10 journey (`docs/quality/phase-22-journey-project-customer-success.md` §8, F1). The journey proves the negative the plan asks for.
- **Remaining risk:** the same shape as G26 (no Sales→ESignature contract): a cross-module reaction that the product never promised.

## G28 — The customer-success suite leaves the default onboarding template's Task behind

- **Module / contract:** customer-success — test hygiene, not product behaviour.
- **Impact:** `apps/api/test/customer-success.test.ts` used to start the **default** onboarding playbook, whose first step is a `createTask` step named `Schedule the kickoff call` — a name without the suite's `AGENT_TEST_` marker, so the suite's cleanup could not remove it and every run left one row behind.
- **Expected vs observed:** expected — the suite removes every record it created; observed at the time — one unmarked `Task` per run.
- **Status:** Fixed (verified during the 22.11 run on 2026-10-28) — the suite now installs its own playbook template whose task step is named with the run marker (`AGENT_TEST_csm… kickoff call`) and deletes it through the API: after a full `pnpm test` the database holds **zero** live `Schedule the kickoff call` rows and the run's marked task is soft-deleted. The Phase 22.10 journey does the same by tracking the produced task's id.
- **Remaining risk:** none observed; a future change back to the shared default template would reintroduce it.

## G29 — A connector webhook delivery leaves a pending durable `jobs` row that the delivering suite does not remove

- **Module / contract:** advanced-integrations — test hygiene, plus the delivery seam itself.
- **Impact:** `POST /api/v1/integrations/webhook/:connectionId/:key` stores a durable `jobs` row before the handler runs, so a suite that deletes its connection and delivery rows but not the job leaves a `pending` row whose `target->>'providerKey'` names a provider that no longer exists. `apps/api/test/advanced-integrations-engine.test.ts` has done this on every run since 2026-10-20 (29+ rows found in the configured database, `agent-test-webhook_*`). The Phase 22.7 replay suite showed the same shape (14 rows, `agent-test-p22-*`).
- **Expected vs observed:** expected — a suite removes every row it created; observed — one pending `jobs` row per webhook delivery that the suite never dequeues.
- **Status:** Partly fixed (22.11) — `phase22-replay-contract.test.ts` now deletes `jobs where target->>'connectionId' = ${connectionId}` in its `afterAll`, the rows its earlier runs left behind were removed by exact id, and two further runs of that suite (focused and inside `pnpm test`) left **zero** `agent-test-p22-*` jobs rows. The pre-existing engine suite still leaks; the same one-line predicate is the fix in that file too.
- **Remaining risk:** orphan `jobs` rows keep accumulating, and a worker that scans the durable queue does work for connections that no longer exist.

## G30 — Hard-deleting a record leaves its `stream_items` rows behind as orphans

- **Module / contract:** platform — the Entity Engine delete path and the stream.
- **Impact:** `stream_items` is polymorphic (`entity_type`, `entity_id`) with no foreign key to `entity_records` (migration `002_stream.sql`), and nothing in the platform removes its rows when a record is hard-deleted — `apps/api/src/stream/stream-hooks.ts` only inserts. So every hard delete leaves the record's timeline behind. One `pnpm test` run on 2026-10-28 added 570 such rows across 31 entity types (152 `SubscriptionPeriod`, 68 `LeadScoreModel`, 49 `MarketingSend`, 47 `Invoice`, … , 1 `Case`); the configured database now carries 4,640 orphan `Case` rows, 13,528 `SubscriptionPeriod` and 5,127 `LeadScoreModel`.
- **Expected vs observed:** expected — either the delete path removes the record's stream rows (`stream_items` with their `stream_mentions`/`stream_attachments`) or a retention pass prunes rows whose subject no longer exists; observed — neither, so the stream tables only grow and a list of stream rows can name a record that no longer exists.
- **Status:** **Partial (23.7).** `system.cleanupStreamOrphans` removes stream rows older than 30 days only when their `entity_type` is a known Entity Engine type and no record with that exact id exists; soft-deleted records and unknown/non-record subjects are untouched, and the mentions/attachments tables cascade with the item. **Residual:** `attachments` rows and their stored files are not swept by this pass; access is already denied when the parent cannot be read (Phase 23.6 ACL), so this is inert storage growth. Recorded as a named exception in `docs/security/exception-register.md` (owner platform, review 2026-12-12).
- **Remaining risk:** unbounded growth in the stream tables, and a stale `entity_type`/`entity_id` pair that a future notification or stream reader could surface.

## G31 — The campaign reports answered any authenticated caller

- **Module / contract:** marketing-automation — `GET action/campaign/:id/log`, `/stats`, `/attribution`, `/funnel`.
- **Impact:** these four routes went straight to aggregates over `marketing_events` with no check that the caller may read the campaign at all, and the event log returns each recipient's record id and address digest. A marketer on another team could page through a campaign they cannot open and enumerate whose records it mailed — while the sibling report (`action/send/:id/recipients`) had applied record ACL from the start, and `docs/marketing-automation/metrics.md` §2 already promised "access is the campaign's own record ACL — a report never reveals a recipient the caller could not open". The code did not match its own documentation.
- **Expected vs observed:** expected — a report answers to the campaign's read grant and names only recipients the caller may open; observed — an authenticated stranger got the whole log, and a caller with no Contact rights still got Contact ids and digests.
- **Root cause:** the report services were written against the event table, not against the record; no shared gate existed to point them at.
- **Status:** Fixed (22.12) — `marketing-report-access.service.ts` answers to the Campaign's record-level read grant and all four reports call it; the event log masks the recipient type, id and digest for records the caller cannot open and counts them in a `hidden` field, exactly as the recipient ledger does. Proven in the Phase 22.12 journey step 11 (an outsider sees counted-not-named rows; a caller without campaign rights is refused).
- **Remaining risk:** none for these four routes; the same "reports must answer to the record's own grant" rule should be applied when new aggregate endpoints are added.

## G32 — A replayed attribution outcome double-counted the conversion

- **Module / contract:** marketing-automation — `POST action/attribution`.
- **Impact:** the door that lets another module report "this campaign's work converted" inserted a `conversion` event unconditionally. The same `correlationId` arriving twice — a retried job, a replayed handler, an operator pressing again — counted the conversion twice and added its amount to `influencedRevenue` twice, so the report a marketer acts on could be inflated by nothing but a duplicate request. Phase 22.7 gave every other door an atomic claim; this one was not in its scope.
- **Expected vs observed:** expected — one outcome per correlation id, and a replay answered as the duplicate it is; observed — two rows, two conversions, double revenue.
- **Status:** Fixed (22.12) — migration `084_phase22_marketing_attribution_dedup.sql` adds the partial unique index `uq_marketing_events_internal_attribution` (internally-recorded conversions that name a correlation id, scoped by campaign), and `recordAttribution` now makes the write itself the decision: an insert that loses the race re-reads the winner and returns `duplicate: true`. An outcome without a correlation id is a different fact each time and still stands. Proven in the Phase 22.12 journey step 9.
- **Remaining risk:** attribution is scoped by campaign by design — crediting the same outcome to two campaigns remains two intentional rows, not a duplicate.

## G33 — The marketing webhook signature is the shared secret, and freshness is optional **— Fixed (23.5)**

- **Module / contract:** marketing-automation — `POST webhook/:providerKey` (and its `webhooks/` alias).
- **Impact:** `MarketingEventIngestionService.verifySignature` compares the `x-webhook-signature` header **to the configured secret itself** — it is not a signature over the payload. The door therefore cannot prove the body was not altered in transit, and because the five-minute replay window is only consulted when the caller sent an `x-webhook-timestamp`, a captured request without that header can be replayed at any later time and is recorded as a fresh delivery. The platform's other provider doors do it differently: Voice and ESignature sign `timestamp + body` and verify with a constant-time HMAC comparison.
- **Expected vs observed:** expected — the door verifies a body-bound signature and refuses a stale delivery whether or not the caller volunteered a timestamp; observed — the secret itself is the credential, and an omitted header skips the age check.
- **Verification:** found while building the Phase 22.12 journey, whose step 6 asserts today's behaviour (a 2020-dated `open` event with no timestamp header is processed).
- **Status:** **Fixed (23.5).** `MarketingEventIngestionService` now verifies `sha256=<hex>` where the hex is HMAC-SHA256 over `timestamp + "." + rawBody`, compares it in constant time, and keeps the `x-webhook-timestamp` **inside** the signed material. A missing or unparseable timestamp is a recorded rejection (`MISSING_TIMESTAMP` / `INVALID_TIMESTAMP`), an out-of-window one is a 400 with no inbox row, and a forged body can no longer reuse the genuine event's dedupe key. The raw bytes are preserved for both marketing prefixes in `bootstrap.ts`. Proven by `marketing-automation-events.test.ts` (valid, forged, tampered body, missing timestamp, stale, duplicate), `phase22-replay-contract.test.ts` and the updated journey step 6.
- **Remaining risk:** provider adapters must migrate from sending the shared secret to signing the body; any adapter that still sends the old value is refused. The 5-minute window is fixed in code rather than configurable per provider.

## G34 — Help retrieval read Service Desk's knowledge corpus with the caller's rights ignored

- **Module / contract:** crm-chat → service-desk — `GET action/help/search`.
- **Impact:** `CRMChatHelpService.searchKnowledgeBase` took `KnowledgeBaseService.portalArticles()` — which selects `entity_records` rows directly, filtered to published, non-internal, in-date — and returned each hit's title, summary and record id to any caller holding `use` plus the `helpRetrieval` flag. The same caller asking `GET /api/v1/KnowledgeArticle/<id>` was refused: the corpus is *portal-safe by state*, which is not the same question as *readable by you*, and Chat answered the second question with the first answer. The handbook half of the same route was already per-caller, because it goes through `DocsService`.
- **Expected vs observed:** expected — a cross-module read through Chat grants the caller nothing they could not get directly (AGENTS.md §5.3, plan §13.6 step 4); observed — ids, titles and summaries of records the caller may not open.
- **Status:** Fixed (22.13) — each knowledge hit is re-read under the caller's own record ACL and dropped silently when it fails, which is the rule the citation builder already applied to CRM records. Proven in the Phase 22.13 journey step 4: the entitled caller sees the article, a caller without `KnowledgeArticle: read` sees handbook pages only.
- **Remaining risk:** the drop is silent, so a user who *should* have seen an article sees a shorter answer rather than a reason — the same trade the citation path makes, deliberately, because a reason is a disclosure.

## G35 — The MCP-shaped tool door could commit an approval-class write with no decision anywhere

- **Module / contract:** ai-agents — `POST action/mcp/call`.
- **Impact:** the door checked the caller's `use` capability, that the tool was enabled, and that the arguments fitted its schema — then executed the handler. For a read tool that is exactly right. For `crm_update_record_fields`, whose registry entry says `material_write` and `requiresApproval: true`, it meant a single caller could commit the write that the run pipeline will only perform after one person proposes and a *different* right decides. The caller's record ACL still governed, so nothing was reached that a plain `PATCH /api/v1/Case/:id` would not have reached — what was bypassed was the decision and its trace: no run, no `ai_agent_approvals` row, no tool-call ledger.
- **Expected vs observed:** expected — an effect class that demands a human decision demands it on every door (plan §13.6 acceptance: proposed and executed states are distinct); observed — one door where they collapsed into one caller.
- **Status:** Fixed (22.13) — the door refuses a tool whose registry entry or the instance's `approval.requireFor` list demands a decision, with `AI_TOOL_APPROVAL_REQUIRED` naming the run pipeline as the path that can carry one. Proven in the Phase 22.13 journey step 12, which also shows a read through the same door still stops at the caller's own record rights.
- **Remaining risk:** a client that used this door for writes gets a refusal rather than a silent downgrade; nothing in the SPA does, and the door's own documentation now says what it will not do.

## G36 — Three declared run and approval states are unreachable

- **Module / contract:** ai-agents — `RUN_STATUSES` and the approval decision vocabulary; `docs/quality/phase-22-journey-ai-controlled-actions.md` F3.
- **Impact:** `partially_succeeded`, `waiting_for_input` and the `changes_requested` decision are in the schema checks, the route filters and the SPA's vocabulary, and no runtime path writes them. A run that stopped after committing one effect is reported `canceled`, which is true of the stopping but not distinguishable, at the status field, from a run that stopped having done nothing.
- **Expected vs observed:** expected — every state an operator can filter on is one some path can produce; observed — three are reachable only through a database write.
- **Status:** Open (found 22.13) — the honest alternatives are to produce them (`provideInput`/`resume` exist and wait only for a runtime that can park a run, and a review-decision with changes requested needs a re-propose path) or to retire the vocabulary; either is a product decision with an API-shape consequence, so it is recorded rather than silently narrowed. The journey asserts the inspectable truth instead: the tool ledger and timeline say exactly which effects committed.
- **Remaining risk:** a dashboard filters for "partially succeeded" and reports an empty result as though nothing ever went partway.

## G37 — A user whose Case scope is `own` cannot create a Case at all

- **Module / contract:** service-desk write guard × the Entity Engine's own-scope assignment — `POST /api/v1/Case` as a non-administrator.
- **Impact:** with `Case: { create: 'yes', read: 'own' }`, `prepareWrite` stamps `assignedUserId` into the create so the new record is visible to its creator at all, and the guard refuses any client write that changes `assignedUserId` by name — so the create answers `422 …These fields on Case are set by the Service Desk module and cannot be written through the record API: assignedUserId`. The user did not ask for that field; the platform set it for them. The practical result is that a deployment gives its agents `Case: read all` to let them create at all, which is the opposite of least privilege.
- **Expected vs observed:** expected — an own-scoped create succeeds and lands owned by its creator; observed — a refusal naming a field the caller never sent.
- **Status:** **Fixed 2026-11-03.** `ServiceDeskWriteGuardService` now accepts `assignedUserId` on a
  **create** when it names the caller the record API scoped the record to
  (`isSelfOwnershipOnCreate`, `apps/api/src/service-desk/service-desk-write-guard.service.ts`), and refuses
  it in every other position — an update, or a create naming anybody else (the record API's own
  "can only be assigned to yourself" rule fires first for the latter). Asserted by
  `service-desk-security.test.ts` ("an own-scope create succeeds and lands owned by its creator"), which
  checks the 201, the `assignedUserId`, the read-back and the forged-other-owner refusal; verified by
  mutation — disabling the exception returns the original `422 … cannot be written through the record API:
  assignedUserId`.
  **The queue-routing question the entry asked for is decided as follows:** the stamp is *initial
  ownership*, not an assignment, so it writes no `CaseAssignment` history row (nothing was handed over)
  and it does not trigger routing — a case that arrives owned by its creator is not the record routing
  wants to place; `action/route` stays the explicit command and `CaseAssignmentService.assign` stays the
  only writer of the assignment trail.
  **Collateral finding, also fixed:** the IDOR test at `service-desk-security.test.ts:36` had been passing
  vacuously the whole time — its create answered 422, so it read `/Case/undefined` and got the expected
  404. It now asserts the create returns 201 before anything else.
- **Remaining risk:** least-privilege roles keep being widened in practice rather than fixed in the guard.

## G38 — `features.readTools` is declared as the gate for turns and queries and never enforced

- **Module / contract:** crm-chat — `POST action/turns`, `POST action/query/execute`, and the route table in `crm-chat-contract.ts`.
- **Impact:** the contract names `readTools` as the feature those two routes require, and `CRM_CHAT_ROUTES` is pinned against the served routes — but the only thing the turn path consults is assistant readiness (which reads the *AIAgents* execution flags), and the query route only checks the workspace plus `use`. An administrator who switches "Grounded CRM answers" off still gets answers built from live CRM records. The flag is real for write actions, which chain through `actionProposals` → `readTools`, so the one path that does honour it is the one that needs it least.
- **Expected vs observed:** expected — a capability switch the operator can see is a switch the server enforces; observed — decorative for the two routes that most define the product.
- **Status:** **Fixed 2026-11-03.** `POST action/turns` and `POST action/query/execute` now call
  `policy.assertFeature('readTools')` (`apps/api/src/crm-chat/crm-chat.controller.ts`), and
  `actions.canStartTurn` is the conjunction of workspace, `readTools` effective and assistant readiness so
  the composer cannot offer a refused send. Asserted by `crm-chat.test.ts` ("obeys the readTools switch on
  the two routes it gates"), which checks the refusal, the capability answer and the fact that a request
  past the gate is answered by validation rather than by the flag. The deliberate decision the entry asked
  for was taken and documented: `docs/architecture/crm-chat-contract.md` §7.1 and
  `docs/modules/crm-chat/RELEASE_NOTES.md` both state that **a deployment with the flag off stops
  answering until an operator switches it on**, including help-only installations, because a help turn
  travels the same route.
- **Remaining risk:** a compliance answer of "we disabled grounded answers" is not true.

## G39 — A turn's own `sources` list is handed back without re-authorization

- **Module / contract:** crm-chat — `GET action/turns/:id`.
- **Impact:** the turn status returns the run's `result` as recorded, and `sources` there are the raw `entity:id` references collected from the tool ledger at answer time. The citation builder re-reads each record under the caller's current ACL and drops what fails; this field does not, so a record that was readable when the answer was given and has since been revoked continues to appear as `Account:<id>` in the turn's own result. Visibility is bounded (the initiator, or a holder of `AIAgentAudit: read`), and what is disclosed is a reference to a record the reader once could open, which is why this is Low.
- **Expected vs observed:** expected — one rule for "may this caller see this record", applied on every read; observed — two rules, one re-read and one replayed from the stored answer.
- **Status:** **Fixed 2026-11-03.** `CRMChatCitationService.reauthorizedResult()` applies the citation rule
  to the turn's `sources` and `CRMChatAIAgentsClientService.getTurnStatus()` runs it on every read, so
  `GET action/turns/:turnId` cannot name a record the reader has lost. Asserted by
  `crm-chat-evaluation.test.ts` ("stops naming a record the reader has lost"), which answers a turn from a
  real `crm_read_record` call, soft-deletes the record, and re-reads the turn; verified by mutation — with
  the filter removed the same assertion fails naming the revoked record. A reference that is not shaped
  `Entity:id` is passed through unchanged (nothing to look up), and the answer text is not rewritten.
- **Remaining risk:** a long-lived turn keeps naming records its reader may no longer open.

## G40 — None of the connector's five worker doors could be reached by the worker

- **Module / contract:** advanced-integrations — `POST action/outbound-event`, `action/process-webhook-event`, `action/push-outbound`, `action/notify-expiring-credentials`, `action/purge-retention`.
- **Impact:** the section these routes live in says, in its own comment, that the worker has no session so `@Public()` skips session authentication and the shared `x-worker-secret` is the authorisation. Four of the five routes (all but `action/dead-letters/:id/replay`'s neighbours) carried no `@Public()` decorator, so a session guard refused the worker before `assertWorkerSecret` was ever reached: `401 AUTHENTICATION_REQUIRED`. Every job in `ADVANCED_INTEGRATIONS_JOB_NAMES` is an HTTP proxy to one of those doors, so the whole asynchronous side of the module — a verified provider callback becoming a CRM record, an outbound push, the expiring-credential sweep, the retention purge — could not run in any deployment. Nothing noticed because every existing suite called the *services* directly, and the worker's own tests inject a fetcher instead of hitting the API.
- **Expected vs observed:** expected — the worker posts the payload the API handed it and gets an answer; observed — a refusal that names no capability, because the request never reached the capability check.
- **Status:** Fixed (22.14) — `@Public()` on all five doors, with the constant-time shared-capability comparison left as the only authority. Proven in the Phase 22.14 journey step 12, which reads the `jobs` row the ingress itself created and posts *that* to the door: no secret → 401, wrong length secret → 401, right secret → the event is applied.
- **Remaining risk:** the doors are now reachable, so a leaked `REPORT_WORKER_SECRET` can drive them; that is the documented worker contract (ADR 0003) and it is the same capability every other module's door uses.

## G41 — The webhook job the API enqueues was refused by the door that receives it

- **Module / contract:** advanced-integrations — `WebhookIngressService.receive` → `advancedIntegrations.processWebhookEvent` → `action/process-webhook-event`.
- **Impact:** the ingress put `kind` (the routing segment the provider used) into the job payload; the door parses that payload with `WebhookProcessSchema`, which is `.strict()` and does not declare `kind`. The worker forwards `context.data` verbatim, so every delivery failed with `400` at the door — one more way for a verified event to die between the API and the CRM. And `handled`, which the schema *does* accept and `processDelivery` honours (a domain service already claimed this event, so the generic mapping must not apply it a second time), was never passed on by the door — the guard was unreachable from the queue.
- **Expected vs observed:** expected — the payload one component enqueues is the payload the next component accepts; observed — a producer and a consumer of the same contract disagreeing by one field in each direction.
- **Status:** Fixed (22.14) — the enqueued payload carries exactly the fields the door accepts, and the door passes `handled` through. Journey step 12 proves both halves: a delivery a domain claimed answers `handled_by_domain` and leaves the record alone.

## G42 — A verified webhook answered "no events" whenever the connector did not mention a challenge

- **Module / contract:** advanced-integrations — the ingress's endpoint-validation branch.
- **Impact:** `if (verification.challenge !== null)` was read as "this was a challenge", but a verification helper that returns only `{valid, reason}` yields `undefined`, which is `!== null`. So any connector whose `verifyWebhook` did not spell out `challenge: null` had every verified delivery answered as an empty event list: HTTP accepted, nothing recorded, nothing applied. The failure is silent in exactly the direction operators cannot see — the provider is told 202 and the CRM never changes.
- **Expected vs observed:** expected — absence of a challenge means there was no challenge; observed — absence of a challenge *is* a challenge.
- **Status:** Fixed (22.14) — the branch now tests the value, not its absence. The journey's connector returns the helper's result spread with an explicit `challenge: null`, so both readings are covered.

## G43 — Nine connector write routes had no capability check anywhere

- **Module / contract:** advanced-integrations — `POST action/mappings`, `PATCH action/mappings/:id`, `action/mappings/:id/activate`, `…/retire`, `…/sync`, `POST action/runs/:id/cancel`, `POST action/conflicts/:id/resolve`, `POST action/dead-letters/:id/replay`, plus the read-only `…/preview`.
- **Impact:** the controller's header states the rule — every route checks a capability server-side, and each capability is checked by exactly one service, "so a route cannot drift from the matrix". For nine routes the matrix and the route had already drifted: neither the controller nor the service behind it asserted anything. A role holding only `AdvancedIntegrations: read` could create and activate a mapping, start a sync — which writes CRM records under the **connection's** authority, not the caller's — cancel a run, decide a conflict (choosing which side a record keeps) and mark a dead letter replayed. That last one is G11, which this entry subsumes.
- **Expected vs observed:** expected — a write on a connection is connection administration; observed — a read right was a write right.
- **Status:** Fixed (22.14) — the eight writes assert `connectionAdmin` at the controller (the seam an operator crosses, so no internal system path is affected) and `preview` keeps `use`, because a dry run writes nothing. Journey step 2 walks all eight with a viewer-only token and expects `403` on each, then makes the same calls as an operator and requires the refusal to come from the domain rather than from the permission layer.
- **Remaining risk:** the module still has no narrower "who may decide a conflict" rule than `connectionAdmin`; a deployment that wants four-eyes on conflicts needs a new capability, not a new assertion.

## G44 — The sync checkpoint advanced only at the end of the loop, and a bounded run advanced it past records it never applied

- **Module / contract:** advanced-integrations — `SyncOrchestrator.runInbound`, `integration_sync_checkpoints.cursor_value`.
- **Impact:** two faces of one missing rule. First, the cursor was written once, after the page loop finished, so an interruption — a provider error on page 40, a cancelled run, a dying process — discarded the progress of 39 applied pages, and the next run re-read every one of them; the table's own comment ("it advances only past an operation that succeeded") described the intent, not the code. Second, a run stopped by `maxRecords` in the middle of a page still advanced the cursor to the end of that page, so the records after the cut were recorded as behind the checkpoint and were never read again — silent, permanent data loss with a green run row.
- **Expected vs observed:** expected — the cursor names the last thing this process committed; observed — it named a page the process had half-read, or nothing at all.
- **Status:** Fixed (22.14) — the cursor is written per page, only when the page was consumed whole, and the budget is applied to the page before the cursor moves. Journey steps 8–10 pin all three behaviours: a rate-limited page 2 leaves `off:2` behind and the resume run reads the rest; a `maxRecords` stop inside page 2 leaves the cursor at the end of page 1, so the half-read record is read again (five records, not four) and still produces one CRM record; a cancelled run's cursor matches the pages it applied.
- **Remaining risk:** a run that fails *between* the last record of a page and the cursor write re-reads that page on resume. That is the correct direction to be wrong in — at-least-once reading against an idempotent apply — and step 7 proves the apply is idempotent.

## G45 — Cancelling a run stopped nothing, and a cancelled run could be cancelled again

- **Module / contract:** advanced-integrations — `SyncOrchestrator.cancelRun` and the run loop.
- **Impact:** `cancelRun` wrote `status = 'cancelled'` and its comment promised the run "stops at the next record boundary". The loop never read the row again, so the promise was prose: an operator pressed cancel, the answer said `cancelled`, and the run went on calling the provider and writing records until it finished — while the row that said `cancelled` was then overwritten by the loop's own final status. Cancelling an already-cancelled run was also accepted, because only `completed` and `failed` were treated as finished.
- **Expected vs observed:** expected — a cancellation the operator sees is a cancellation that takes effect, and a terminal run is not cancellable twice; observed — a status the loop silently replaced.
- **Status:** Fixed (22.14) — the loop asks once per page whether it was cancelled and stops there, keeping the counts of what it already applied, and `cancelled` joins `completed`/`failed` as a state that refuses a second cancel. Journey step 10 cancels from *inside* the run — the connector's page hook calls the cancel route while the loop is between pages — and asserts `cancelled`, two records scanned, `off:2` in the checkpoint, and a continuation run that reads the remaining five without duplicating anything.
- **Remaining risk:** the boundary is a page, not a record, so a cancel waits for the current page's round-trip. That is the documented contract now and the page size is the operator's knob.

## G46 — `features.connections` was stored and displayed but enforced nothing

- **Module / contract:** advanced-integrations settings — `features.connections`, `AdvancedIntegrationsHealthService`, `docs/runbooks/advanced-integrations.md` §12.
- **Impact:** the schema's own comment calls it "the connection control plane", and the runbook's disable plan tells an operator to turn the module's features off (`connections`, `oauth`). `oauth` is enforced (the flow refuses with a named feature); `connections` was read in exactly one place — the health report describing itself. So the documented way to stop the module stopped nothing, and the health report said "off" to an operator who believed it.
- **Expected vs observed:** expected — a switch an operator can see is a switch the server enforces; observed — the control plane kept accepting writes.
- **Status:** Fixed (22.14) — creating a connection is refused while the flag is off, naming the feature; reads, diagnostics and the existing connections keep answering, which is what the runbook says a disabled module does. Journey step 14 asserts refusal, the health report, and that re-enabling restores the write. Provider calls per se are gated by the connection's own state (`paused`, `revoked`, `reauthorization_required` are never permission to call), which step 14 also proves with the connector's own call counter.
- **Remaining risk:** there is still no single "stop everything" switch — the module's kill switch is pause-the-connection plus features-off, and G53 records what happens to work already queued behind them.

## G47 — Token refresh is implemented, serialised and tested — and no production path calls it

- **Module / contract:** advanced-integrations — `OAuthFlowService.refresh`, `ConnectorExecutor.buildContext`.
- **Impact:** `refresh()` takes an advisory lock per connection, re-checks under that lock whether another worker already rotated the token, stores the new pair and moves the connection to `reauthorization_required` if the provider refuses. It is correct and it is concurrency-safe. Nothing calls it: the only caller in the repository is `apps/api/test/advanced-integrations.test.ts`, and the executor reads the stored access token and hands it to the adapter without consulting its expiry. So a token that expires in the middle of a working day leaves the connection `connected`, every provider call failing, and no path marks it as needing reauthorization from a live authorization error — the operator finds out from failed runs, not from the connection's state.
- **Expected vs observed:** expected — an expiring grant is refreshed before it is used, or the connection says so; observed — an expiry notice job exists (`features.expiryNotices`, `notifyExpiringCredentials`) that warns a human days ahead, and nothing else.
- **Status:** Fixed (23.3) — the executor now consults the credential's own expiry before every provider call and refreshes an expired (or nearly expired) token first, so a long-idle connection no longer fails on its first use. The refresh question itself (`needsRefresh`) was lifted out of `oauth-flow.service.ts` and is now one shared function, so the executor and the refresh cannot drift apart. A provider that **refuses** the credential gets exactly **one** second attempt with a fresh token, and the retry is bounded: a second failure is the failure. That path needed a *forced* refresh, because a provider can revoke a token whose clock has not run out — the refresh is therefore bound to the token that was refused, so a credential another worker already replaced is not rotated twice, and the per-connection advisory lock still serialises concurrent refreshes. The provider-facing behaviour did not change: a refresh that the provider refuses still moves the connection to `reauthorization_required` and the caller still sees the provider's own failure.
- **Remaining risk:** a deployment whose provider issues short-lived tokens now sees a refresh on nearly every call; the number of provider round-trips per call is one, and the token is rotated once per connection, but a deployment that cannot afford that should widen its token lifetime rather than rely on the expiry notice.

## G48 — The resilience layer the sync path never uses

- **Module / contract:** advanced-integrations — `resilience.ts` (`ProviderRateLimiter`, `decideRetry`, `computeRetryDelay`) and `assertCallable` in the domain.
- **Impact:** the rate limiter is wired into the executor behind `options.rateLimit`, and no caller anywhere passes that option — `runInbound`, the webhook paths, the outbound push and the controller's own calls all use `executor.call(id, fn)`. So `integration_rate_limit_buckets` stays empty and a connector that documents `rateLimitStrategy: 'provider_header'` is throttled only by the provider's own refusal. `decideRetry`/`computeRetryDelay` — the bounded, jittered backoff the engine tests assert to the bit — are imported and re-exported by the orchestrator and never called by production code: the retry policy lives in the queue (`attempts`, exponential backoff) and in a hardcoded `attempts >= 5` in the outbound path. `assertCallable`, the domain's own rule about which states may call a provider, is exported and never used; the executor re-implements the same rule inline with different wording.
- **Expected vs observed:** expected — a declared capability and a tested policy that nothing consults is a bug waiting for the day somebody trusts it; observed — the circuit breaker *is* live (it is the one part of `resilience.ts` the executor uses unconditionally), which is why the gap is easy to miss.
- **Status:** Open — deferred to 22.21 (operations) after review in 22.18. 22.18 aligned the queue's retry with the HTTP policy's equal jitter (G15) and made the outbox claim a lease, so the two remaining pieces need a decision rather than a patch: wiring `rateLimit` would invent capacity/refill numbers because `ConnectorCapabilities` declares only a strategy name, and moving the queue onto `decideRetry` changes who owns retries (provider budget vs queue policy). `assertCallable` stays a domain helper because the executor deliberately raises a `ProviderError` with a stable `configuration_invalid` code instead of a `ValidationError`. The journey asserts what is genuinely enforced instead — the breaker refuses through a poisoned connection, and a rate-limited page produces a named `RATE_LIMITED` failure with a dead letter.
- **Remaining risk:** `docs/compatibility/advanced-integrations/provider-matrix.md` describes rate-limit strategies per connector; a reader can reasonably conclude the platform obeys them.

## G49 — `deletionPolicy: 'archive'` behaves exactly like `unlink`

- **Module / contract:** advanced-integrations — `DELETION_POLICIES` and `SyncOrchestrator.applyDeletion`.
- **Impact:** three policies are declared and validated (`unlink`, `archive`, `ignore`) and the implementation branches only on `ignore`; everything else takes the unlink path. The docstring promises the record is archived. An operator who chose archive to keep an audit trail of provider-side deletions gets an unlink and a live record, and nothing says the choice was not honoured.
- **Expected vs observed:** expected — a policy the API validates is a policy the engine implements; observed — two of three names mean one behaviour.
- **Status:** Open (found 22.14) — a one-branch change (set `deleted_at`/archive state instead of only removing the link), but it changes what a CRM record looks like after a provider delete, which is a product decision with a restore path attached. The journey covers the `unlink` behaviour that exists.
- **Remaining risk:** compliance answers built on "we archive what the provider deletes" are wrong.

## G50 — A mapping asked for "the connection for this provider" gets one picked by name order

- **Module / contract:** advanced-integrations — `POST action/mappings` and its `resolveConnectionId` helper.
- **Impact:** the request names a provider, and the helper lists the caller's connections and takes the **first one whose provider key matches**, ordered by `provider_key, name`. A deployment with two connections to one provider (a sandbox and a production tenant; a revoked one awaiting deletion and a live one) silently binds the mapping — and therefore every sync and every webhook apply — to whichever name sorts first. A revoked connection sorts as easily as a live one.
- **Expected vs observed:** expected — the caller chooses, or the platform chooses a *usable* connection and says which; observed — an ordering accident decides where CRM records come from.
- **Status:** Fixed (23.3) — the mapping request may now name the connection it belongs to (`connectionId`), and the platform refuses to guess: a named connection must exist **and** belong to the named provider; a provider with exactly one connection still resolves without naming it; a provider with more than one is refused with a message that says so. The alphabetical pick is gone — the ordering accident cannot happen any more. Existing mappings are unaffected: they already carry a `connection_id`, and the request shape only gained an optional field, so no migration is needed.
- **Remaining risk:** a mapping that was created **before** this change and was bound to the alphabetically first connection still points at that connection. Nothing rewrote it, because rewriting it would have been guesswork; an operator who has more than one connection per provider should review those mappings by hand.

## G51 — The OAuth callback never compares the redirect URI its own comment claims it checks

- **Module / contract:** advanced-integrations — `AdvancedIntegrationsOAuthCallbackController` header comment and `OAuthFlowService.complete`.
- **Impact:** the controller states that the returning redirect URI is compared with the one stored on the state row. `complete()` takes `{state, code, error}` and has no redirect input at all, so nothing is compared. The state row is single-use, hashed, short-lived and bound to a connection and an initiating principal, which is what actually stops a replay — but the provider-facing binding an operator is told about (register the exact redirect) is not enforced by the platform.
- **Expected vs observed:** expected — either compare it, or stop documenting it; observed — documentation of a check that is not there.
- **Status:** Fixed (23.3) — the callback now carries the redirect URI the provider echoed back, and the platform compares it with the value it sent, **before** the authorization code is exchanged. The comparison is constant-time, and a state row whose stored redirect URI is not the platform's own constant is refused as a tampered row — so a mismatch costs no token request at all. The platform's redirect URI stays a constant of the platform (it is never request input), and the exchange still sends the stored value, which is what a real OAuth client does. The same rule was applied to the **generic OIDC sign-in** added in this sub-phase: its callback compares the echoed redirect URI with the one the platform sent, before the code is exchanged.
- **Remaining risk:** a mis-registered redirect at the provider produces a provider-side error the platform reports as a generic authorization failure (`AUTHORIZATION_FAILED`), which is accurate but not actionable.

## G52 — A provider's own error text is echoed into a 401, and a credential reference points at the connection, not the credential

- **Module / contract:** advanced-integrations — `OAuthFlowService.complete` failure branch; `ConnectionLifecycleService` credential bookkeeping.
- **Impact:** when the provider returns an `error` on the callback, the refusal message interpolates the provider's string — and that string is the one place an OAuth error response sometimes carries a code or a token fragment, which then reaches the operator's browser and whatever logs the message. Separately, `credential_reference_id` is written as the **connection's own id** rather than the credential row it is meant to reference, and it is not cleared when the credential is revoked, so the "reference" is a pointer that never pointed at anything and keeps pointing after the thing is gone; the module's own `secretHint()` helper (first two characters, mask, last two) is exported and never used, so an operator sees the credential *kind* and no recognizable hint.
- **Expected vs observed:** expected — a refusal that carries a stable code and never the provider's raw words; a reference that identifies the row it names, and a hint that helps an operator recognise it. Observed — provider text in a message, and a column that duplicates `connection_id`.
- **Status:** Fixed (23.1) — provider error text no longer echoed; credential_reference_id now points at the stored credential row and is cleared on revoke.
- **Remaining risk:** an error-tracking pipeline that logs API messages can capture a provider error string containing something it should not keep.

## G53 — A delivery deferred by a paused connection or a disabled module is never picked up again

- **Module / contract:** advanced-integrations — `WebhookIngressService.processDelivery`, the connection state gate in the executor.
- **Impact:** the receipt's status is the idempotency guard, and a delivery that is not applied stays `received`. Pausing a connection refuses provider *calls*, but a callback already in the queue still arrives and is still applied through the mapping, because applying a stored payload calls no provider. Turning `features.connections` off refuses new control-plane writes and does nothing to a queued job either. Either way, if a delivery is refused or fails, nothing sweeps the rows left `received`: the provider must send them again, and a provider that will not re-send a duplicate delivery for a row it deduplicates by id has lost the event with only a receipt to prove it happened.
- **Expected vs observed:** expected — one documented policy for work already in flight when the operator stops the module, and a sweeper that acts on it; observed — the runbook's disable plan (pause, then turn features off) has no queue semantics attached to it.
- **Status:** Open (found 22.14) — the journey asserts the enforceable part (no provider call goes out while a connection is paused, proven with the connector's own counter, and a full re-sync via `reconcile` recovers the data that matters), and records the rest rather than inventing a policy the plan has not decided.
- **Remaining risk:** "we paused the connector during the outage" can still mean "the CRM changed underneath us", and an operator has no list of what arrived meanwhile beyond the receipts table.

## G54 — An unexpected error sent its own text to the browser inside `details.reason`

- **Module / contract:** platform — `apps/api/src/common/global-exception.filter.ts`, the `{error:{code,message,details}}` envelope every module answers with.
- **Impact:** the filter's rule is sound — when the catalog replaces a message with the generic face of a code, the specific sentence travels as `details.reason` so the operator can act on it. It applied that rule to **every** status, including 5xx. A database driver's text quotes the statement it failed on (`update invoice_lines set amount = … — column "x" does not exist`), a connector's names the field that held a credential, and the SPA has components that render `details.reason` on screen by design (`CampaignLifecycleActions.tsx:61`, `AIAgentsSettingsTab.tsx:58`, `AIAgentsProvidersTab.tsx:53`, `lead-score/shared.tsx:72`). The plan's rule that a frontend error never surfaces SQL, a stack trace or a provider secret (§14 task 10) was therefore enforced everywhere except the one class of error that carries the most internals. A second face of the same problem: when no catalog is loaded, `translateErrorMessage` returns the original message, so a 500's raw text became the visible `message` too.
- **Expected vs observed:** expected — a server failure answers with a code and a fixed sentence; observed — the internal text, in two fields, whenever a translation existed.
- **Status:** Fixed (22.15) — a 5xx is now built from a fixed sentence with no `details.reason`, whichever catalog state it meets; the real error still goes to the log with the request id. Pinned by `apps/api/test/error-payload-hygiene.test.ts`, which asserts an SQL-shaped message appears in neither field while a 422's operator-facing sentence still does.
- **Remaining risk:** a module that throws `InternalServerError` with its own `details` still ships those details; they are author-controlled and reviewed, unlike a driver's text.

## G55 — A rejected save never marked the fields the server named

- **Module / contract:** platform / SPA — `EntityEditPage.tsx`'s save handler; the API's record-validation answer (`details` keyed by field name, e.g. `{ emailAddress: 'Value must be a valid email address.', reason: 'Record validation failed.' }`).
- **Impact:** the shared edit page — every entity's edit screen — put the refusal into one toast and left every input looking accepted. The user pressed Save again with the same values. The metadata form does validate required fields and patterns client-side, but the server owns more than the client can compute (referenced-record existence, module write guards, per-entity rules), and that is exactly the answer with field names in it. `details.errors` was read by no component at all.
- **Expected vs observed:** expected — the input that was refused says so under itself; observed — a sentence in the corner and a form that looked fine.
- **Status:** Fixed (22.15) — `apps/web/src/lib/serverFieldErrors.ts` maps the refusal onto the fields the form actually renders, and the page marks them, scrolls to the first and focuses it. Restricted to 400/422 by design: a 403 is not a typing problem and a 409 is a decision, so marking a field red for either would teach the user the wrong lesson. Six unit tests cover both shapes, both sources, unknown keys and the statuses that must answer nothing.

## G56 — `details.retryAfterSeconds` was produced by the server and read by no caller

- **Module / contract:** platform — the filter's 429 branch and `EntityListPage.tsx`'s throttled-list path.
- **Impact:** the filter deliberately copies `Retry-After` into the body "so the SPA can back off without parsing prose", and nothing parsed it. A throttled list kept its rows and showed the generic sentence, so the operator could not tell a five-second backoff from a five-minute one.
- **Status:** Fixed (22.15) — the list reads the number and names it (`web.list.rateLimitedRetry`, en + vi), falling back to the message when no number came.

## G57 — Fifteen screens formatted dates and numbers in the browser's locale and zone

- **Module / contract:** platform / SPA — `AdminSettingsShell`, `ApiKeysTab`, `WebhooksTab`, `CaseConversation`, `PortalCaseConversation`, `StreamPanel`, `StreamPage`, `ServiceDeskDashboardPage`, `VoiceCommunicationsPage`, `AIAgentsOverview`, `AIAgentsSettingsTab`, `ESignatureOperationsPanel`, `ESignatureRequestsPanel`, `InboxPanel`, `OperationsPanel`, plus the counters in `DashletResult` and `ReportsPage`.
- **Impact:** `state/i18n.ts` owns `formatDateTime`/`formatClock`/`formatNumber` and its comment says they replace `new Date(x).toLocaleString()`, "which formats in the host locale and timezone and therefore disagrees with every other date on the page". Thirteen screens disagreed anyway, and seven more formatted numbers with the host locale. Two timestamps in one table — one in the user's zone, one in the browser's — is not a cosmetic difference on a screen an operator uses to decide who was on a call when it dropped. The convention gate missed them because its rule looked for `.slice(0, 19)`, not for the formatter it was meant to replace.
- **Expected vs observed:** expected — one formatter per page, the user's zone and locale; observed — mixed, and a gate that did not see it.
- **Status:** Fixed (22.15) — every call site now uses `formatDateTime`/`formatClock`/`formatNumber`, and the gate gained rule 5 (no host-locale date formatting outside `state/i18n.ts`, numbers exempt) so it cannot come back. `pnpm lint:ui` and its `--self-test` both cover the rule.

## G58 — A placeholder dash and two surfaces were painted with black alpha literals

- **Module / contract:** platform / SPA — `components/fields.tsx:84`, `crm-chat/CRMChatActionCard.tsx`, `admin/tabs/ESignatureSettingsTab.tsx`.
- **Impact:** `rgba(0,0,0,0.25)` as the colour of the "no value" dash is a light-mode colour: on the dark theme it is black on near-black, so every empty field reads as blank space rather than as a deliberate em dash. The gate that exists to keep colour in `tokens.css` only looked for hex, so `rgba(` walked straight past it — the same defect class that once put a light chat bubble into dark mode, arriving through a different syntax.
- **Status:** Fixed (22.15) — the three sites use `--carocrm-c-8c8c8c` and `--carocrm-surface-sunken`, both of which carry dark values, and gate rule 6 now refuses a black or white alpha literal used as a `color`/`background` while leaving shadows alone (a shadow is the same in both themes by design).

## G59 — A loading skeleton said nothing to a screen reader

- **Module / contract:** platform / SPA — `components/LoadingSkeleton.tsx`.
- **Impact:** antd's `Skeleton` carries no role and no live region, and the shared wrapper added none, so a user who cannot see the bars has no signal that content is arriving — and no signal when it never does. `ErrorState` was fine (antd's `Alert` renders `role="alert"`), which is the asymmetry that makes this worth fixing: the failure is announced and the wait is not.
- **Status:** Fixed (22.15) — the skeleton sits in `role="status"` with a polite live region and a visually hidden label in the reader's own language. `SharedStates.test.tsx` pins the structure (roles and live regions, not wording, because the node test project loads no catalog).

## G60 — The webhooks tab decided "module not installed" from a message containing "404"

- **Module / contract:** platform / SPA — `admin/tabs/WebhooksTab.tsx`.
- **Impact:** `error.message.toLowerCase().includes('404')` is true for a record id, a port, a year in a timestamp, or a provider's own text. It decided whether the tab showed "this extension is not installed" or an error, so a false match told the operator to install something that was already there.
- **Status:** Fixed (22.15) — it reads the HTTP status the `ApiError` already carries.

## G61 — One chat string was hard-coded English in a shared component

- **Module / contract:** crm-chat / SPA — `CRMChatComposer.tsx`.
- **Impact:** the fallback for a failed turn was `'Failed to submit turn.'`, so a Vietnamese user got English at the exact moment they needed to understand why nothing was sent. Gate rule 1 checks that used keys *exist*, not that code contains no literal English, so a literal string in place of a key passes unseen.
- **Status:** Fixed (22.15) — the message is the server's when there is one and `web.crmChat.turnFailed` (en + vi) when there is not.

## G62 — The chat action card rendered its own decision response instead of the server's

- **Module / contract:** crm-chat / SPA — `CRMChatActionCard.tsx`.
- **Impact:** after confirm/reject the card showed what that call returned and told its parent. It never re-read `['crmChat','action',id]`, so the card could sit on "approved" while the run it triggered moved to `queued`, `failed`, or `blocked_by_policy` — the plan's §14 task 4 in miniature: a control that shows an intention instead of a confirmed result. Task 5 asks the same of high-impact actions, and an agent action executing on the user's behalf is one.
- **Status:** Fixed (22.15) — the decision invalidates the action's own query, so what the card says is what the server last said.

## G63 — No route guard sits in front of `/admin/*` — only the menu is filtered by the server

- **Module / contract:** platform / SPA — `AppRoutes.tsx`.
- **Impact:** the router gates on "is there a session" and "is this a portal user". It does not gate on capability, so a signed-in non-admin who types `/admin/users` reaches the page, and the page then refuses its own data with a permission card or a 403 list. The comments in the route table say "visibility is decided by the server", which is true of the navigation tree (`AppShell` renders the ACL-filtered result) and of every data call, but not of the route itself. §14 task 8 asks route guards and API authorization to *agree*; today they agree on outcome and disagree on the moment.
- **Expected vs observed:** expected — a route a caller cannot serve does not render its chrome; observed — it renders and then reports the refusal inside itself.
- **Status:** **Fixed 2026-11-03 — without inventing the map the entry said was needed.** The guard reads
  the server's own answer instead: `GET /AdminPanel` is already filtered per caller
  (`admin-panel.service.ts:115`, `TAB_CATALOG.filter((tab) => this.registry.mayRead(tab.level))`) and is
  the same data the menu is built from, so route and navigation cannot drift.
  `apps/web/src/admin/RequireAdministration.tsx` wraps the nine standalone `/admin/*` routes (entity
  manager ×2, audit log, jobs, extensions, workflows ×2, processes ×2, portals) and renders the shared
  `PermissionDenied` card instead of the page when the caller's panel does not offer that route; a panel
  that failed to load is a refusal with a retry, never an implicit allow. `/admin/settings*` needed
  nothing — the shell already resolves the tab against the same server list.
  Asserted in `apps/web/src/admin/RequireAdministration.test.tsx` (5 cases: allowed, refused, empty
  panel, param page under its base route, pending) and checked in a browser as a `noAccess` user typing
  `/admin/jobs`: the denial card renders and **no page chrome does** (no `.carocrm-page-title`, no jobs
  table), while the same URL as an administrator still renders the page.

## G64 — ~150 call sites still show `error.message` raw instead of the code-aware helper

- **Module / contract:** platform / SPA — every `catch` that renders `error instanceof Error ? error.message : …`.
- **Impact:** the server's answer is `{code, message, details}` and the useful reading depends on the code: a validation refusal should list its field issues, a rate limit should give the number (G56), a permission denial should not be a red toast at all. Most sites read only the message, and one module's helper (`errorMessage()` in `admin/tabs/identity.ts`) already does it properly — so the same failure looks different depending on which page the user happened to be on, which is exactly the consistency §14 is about.
- **Status:** Open (found 22.15) — the shared edit page now handles the field-shaped case (G55) and the list page the throttled case; migrating the remaining call sites onto one helper is a wide mechanical change with ~150 small behaviour decisions in it, and it deserves its own pass rather than arriving inside a hardening phase.

## G65 — Home content is chosen from `principal.roles` in the client, a rule the server does not mirror

- **Module / contract:** platform / SPA — `home/SetupBanner.tsx`, `home/PulseStrip.tsx`, `pages/DashboardsPage.tsx`, `state/dashboard-default.ts`, `state/portal.ts`.
- **Impact:** these pick what to show by looking at role names or `principal.type === 'admin'` on the stored session. No server rule corresponds, so a custom role that holds the right to read a dashboard can be denied the widget by a client-side name check, and an `admin`-typed principal with a reduced ACL is offered a setup banner whose every link 403s. It is not an authorization hole — every read is still enforced — but the two answers to "what may this person see" are computed differently.
- **Status:** Fixed (23.4) — the dead client-side rule is gone. `pickDefaultDashboard` no longer takes or compares
  `principal.roles`; the server's dashboard list is already filtered to the caller's ACL, and the API never returned
  the `roleScoped` field the client was testing, so the branch could never match. The only remaining home gate is the
  setup checklist, whose endpoint is administrator-only on the server — the banner cannot show content the server
  would refuse. Regression: the web suite's dashboard-default test and the `pnpm typecheck` of the removed signature.

## G66 — No browser spec asserts an error, denied or empty state, and login is English-only

- **Module / contract:** platform / SPA / e2e — `e2e/*.spec.ts`, `e2e/accessibility.spec.ts`.
- **Impact:** the Playwright suite covers the happy path of login, CRUD, conversion, sales documents, omnichannel, AI agents and an axe pass over home/list/record/settings. Nothing drives a 403, a failed save, a throttled list or an empty filtered result, and no spec asserts focus returns to its trigger when a modal closes. `login()` looks up `getByLabel('User name')`, so the Vietnamese catalog is not exercised in the browser at all — which is where a missing key or an English-only fallback (G61) would actually show.
- **Status:** Open (found 22.15) — this is Phase 22.16's brief (browser E2E critical paths), not a defect in the components. The node-side structural assertions added in 22.15 (`SharedStates.test.tsx`) cover what the DOM-less project can reach. Phase 22.16 started closing it with `e2e/critical-paths.spec.ts` (error / empty / denial assertions plus the secondary-locale login coverage); the first browser execution of that spec is pending, and the modal-focus half of the gap stays with this phase's browser spec (G67).

## G67 — Column resize is mouse-only, and modal focus trap/restore rests on antd defaults with no assertion

- **Module / contract:** platform / SPA — `EntityListPage.tsx` resize handles, `LinkRecordModal.tsx` and the other shared modals.
- **Impact:** the resizable header can be dragged but not keyboard-operated, so the list's width control is unavailable without a pointer; every modal relies on antd's built-in focus trap and restore, which is a reasonable default but is untested here, and one component adds its own `autoFocus` on top. The rest of the shared surface is genuinely accessible (skip link, `role="toolbar"` bulk bar with a live count, per-row labelled checkboxes, `aria-expanded` sections).
- **Status:** Open (found 22.15) — the resize fix is a keyboard handler on the same handle; the focus assertions belong to the browser spec in G66, where they can be measured rather than assumed.

## G68 — A core record write does not invalidate the module panels keyed to that record

- **Module / contract:** platform / SPA — `components/RecordHeader.tsx` (rename, delete) against module queries such as `['eSignature','record-entry',type,id]` and the Lead Score chip.
- **Impact:** the core record screens use plain `useState`, not react-query, so renaming or deleting a record leaves any mounted module panel holding its previous answer until the user gives the window focus or the panel's own stale time passes. The blast radius is bounded twice over — the provider is configured with `refetchOnWindowFocus: 'always'` and the affected queries are short-staled — which is why this is Low and not a correctness bug: a record that no longer exists still answers 404/410 from the server on any action.
- **Status:** Open (found 22.15) — closing it needs a single invalidation seam (a core `onRecordChanged(entity,id)` broadcast the module panels subscribe to), which is an architecture decision for the frontend rather than a fix in a hardening phase.

## G69 — The stock-movement history page returned an arbitrary 200-row sample, not the newest movements *(was: "lot stock" test flake)*

- **Module / contract:** sales — `GET /api/v1/Sales/inventory/history` (`InventoryService.history`), observed through `apps/api/test/sales-tracking.test.ts`, `19-S.15 — transfers and returns keep lot traceability` and `19-S.15 — serialised units`.
- **Impact:** `history()` read its page with `SalesRecords.find()`, which orders by `id` — a random UUID — and then applied `limit`. The endpoint's documented promise is "movement history, newest first", but past ~200 live movements the rows it returned were an arbitrary sample of the ledger, sorted in memory afterwards. A movement created seconds earlier could be absent, so the stock-movement panel (and anything reasoning over recent movements) silently lost the newest entries.
- **Expected vs observed:** expected — the newest `limit` movements for the filter; observed — whichever rows happened to sort first by UUID, relabelled "newest" by the in-memory sort.
- **Status:** **Fixed (22.26)** — `history()` now pages through `SalesRecords.findPage`, which orders by `created_at desc` in SQL, so the newest movements are always the ones returned and the in-memory sort only refines equal timestamps. The earlier entry blamed the shared database's lot stock; the sequence of the failure — confirmations answered `200`, then the movement the test read back had no batch/serials — was the read losing the row, not the write failing. The suite passes in the full pool now (251 files / 3 319 tests, 2026-10-30).
- **Remaining risk:** the endpoint exposed a `limit` with no cursor, so a UI that wanted to scroll further back had no way to ask for the next page — that follow-up contract is **G82**, fixed in 22.27.

## G70 — An outbox event claimed by a worker that then died stayed `running` forever

- **Module / contract:** platform — `apps/worker/src/outbox/outbox-poller.ts` (`CLAIM_SQL`).
- **Impact:** the claim committed `status = 'running'` before the handler ran and never wrote a deadline. If the worker process died between the claim and `MARK_PROCESSED_SQL` — including after the handler had committed its own side effects but before the acknowledgement — no other worker could claim the row (`CLAIM_SQL` selected only `pending`), and no operator screen lists `running` as a problem. The fact was effectively lost, silently, while the outbox row still looked like work in progress.
- **Expected vs observed:** expected — a claim is a lease with an expiry, so a dead worker's row becomes available again; observed — a claim was a permanent reservation and the only way out was manual SQL.
- **Status:** Fixed (22.18). `CLAIM_SQL` now sets `available_at = now() + lease` and reclaims `running` rows whose lease expired; the lease is `WORKER_OUTBOX_LEASE_MS` (`outboxLeaseMs`, default 10 minutes). Dispatch is therefore at-least-once across a crash, which is only safe because handlers are required to be idempotent (AGENTS.md §5.5). Regression: `outbox-poller.test.ts` (SQL shape + lease parameter) and `env.test.ts` (the setting), plus a rolled-back PostgreSQL check in `docs/quality/phase-22-resilience-chaos.md` §5.2.
- **Remaining risk:** a handler that runs longer than the lease can be executed twice on a healthy worker. Operators must size the lease above the slowest handler; the default of ten minutes is a starting point, not a measurement.

## G71 — Offset pagination is a live window, not a snapshot

- **Module / contract:** platform — the generic list API (`offset`/`maxSize` over the current order).
- **Impact:** a page is a window over the order as it is when the query runs. An insert that sorts before the next page's boundary shifts the window (a row the caller already saw can move out, and a new row can appear); an edit that does not move the sort key does not. No authorization or money decision depends on a page's contents — the server filters every row by ACL and recomputes derived values — but a client that assumes a stable snapshot can show a duplicate or skip a record between two requests.
- **Expected vs observed:** expected — either a documented window or a cursor; observed — an offset window with no cursor, and no documentation until 22.19.
- **Status:** **Accepted (22.19).** `phase22-data-integrity.test.ts` pins the behaviour: an edit that leaves the sort key alone keeps the next page stable, a record inserted after the remaining page does not change it, and a record inserted before the boundary shifts it. A stable cursor is an API-shape decision for a later phase; until then the UI refetches after a write, and no workaround relies on client serialization.
- **Remaining risk:** a long paging session over a changing dataset can show a duplicate or miss a row; consumers must treat the list as a view, not an export snapshot.

## G72 — An AI approval did not pin the target record's version

- **Module / contract:** ai-agents — `AIToolRegistry.previewUpdateFields`, `AIAgentApprovalService.revalidationFailure`, `AIAgentRunService.executeApprovedAction`.
- **Impact:** the proposal stored the record id and the before/after values but not its version. Revalidation checked the tool, the grant, the agent version and whether the tool was enabled; it never checked that the record was still the one the human was shown. A record edited after the preview (or after the approval) was silently overwritten by the approved write — last-write-wins across an approval boundary.
- **Expected vs observed:** expected — an approval is about a version, and confirmation revalidates it; observed — the version was never captured, and the update tool wrote to whatever the record had become.
- **Status:** Fixed (22.19). `AIToolPreviewTarget` carries the version; approval revalidation refuses a moved target (`422`, approval `invalidated`, run `blocked_by_policy`); the execution context carries the same version map to the preview and to the Entity Engine update, so a write that lands in between loses with `CONCURRENCY_CONFLICT`. A deleted target keeps the existing "human may approve, execution refuses" behaviour. Regression: `ai-agent-runs.test.ts` "refuses an approval whose target changed after the proposal was shown (22.19)" and "refuses to execute when the target moved after approval (22.19)".
- **Remaining risk:** approvals created before this change carry no target version and are therefore not version-guarded; their approvals expire under the existing deadline.

## G73 — Bulk update/delete have no record-count cap and run one record at a time

- **Module / contract:** platform — `POST /api/v1/:entity/action/massUpdate` and `massDelete` (`EntityController.massPayload`, `EntityCrudService.massUpdate/massDelete`).
- **Impact:** the only bound on `ids` is the 32 MB request-body limit; there is no `maxItems`, no chunking and no cancellation. The service loops over ids and issues one update/delete (with its own transaction, hooks and audit row) per record, so a large selection holds one HTTP request and one connection for the whole loop and produces N events/stream rows. A malformed or accidental 50 000-id selection is accepted and starts working.
- **Expected vs observed:** expected — a documented bulk ceiling (or a bounded, queued operation) and a way to stop it; observed — an unbounded synchronous loop behind the generic controller.
- **Status:** **Fixed (22.26).** `EntityCrudService.massUpdate/massDelete` refuse more than `MASS_ACTION_MAX_RECORDS` (**200**) ids with `422 VALIDATION_FAILED` and `details: { max, requested }` *before* the first write, so nothing is half-applied; repeated ids are collapsed first, so one record is written (and audited) once. A queued operation with a progress resource was not built — the cap keeps the worst case inside one request deadline and gives the client a batch size to chunk against. The SPA mirrors it: `api.massUpdate`/`massDelete` send `BULK_BATCH_SIZE = 200` batches and add the outcomes up, and a failure after some batches succeeded names how many records were already changed so the user refreshes instead of retrying the whole selection. Regressions: `entity-crud.test.ts` ("refuses a bulk selection above the cap…", "collapses a repeated id…").
- **Remaining risk:** a selection of 100 000 ids is now 500 sequential requests from a scripted client instead of one; the per-record transaction is still the unit of work, and the cap is a constant rather than a deployment setting.

## G74 — No per-query statement timeout or request deadline

- **Module / contract:** platform — `DatabaseService` pool and the Fastify request lifecycle.
- **Impact:** nothing sets `statement_timeout`/`lock_timeout` on the pool, no route has a request deadline, and the only related setting is BullMQ/provider socket timeouts. A query that waits on a lock (or a plan that degrades, as the 289 k-row outbox claim does) can hold a request and a connection indefinitely; the rate limiter bounds request *rate*, not request *duration*.
- **Expected vs observed:** expected — a bounded query/request deadline with a stable error; observed — unlimited wait.
- **Status:** **Fixed (22.26).** Three settings, all `0`-disables and all documented in `.env.example`:
  - `DATABASE_STATEMENT_TIMEOUT_MS` (default **15 s**) and `DATABASE_LOCK_TIMEOUT_MS` (default **5 s**) travel in the pool's startup packet (`DatabaseService`), so every connection carries them before its first query. Migrations, `pg_dump` and the seed scripts open their own connections and keep their own budgets.
  - `REQUEST_TIMEOUT_MS` (default **30 s**) is one global interceptor (`RequestTimeoutInterceptor`, registered in `bootstrap.ts`) that answers `503 REQUEST_TIMEOUT` instead of letting a client wait. Multipart uploads are exempt — the body streams for as long as the upload lasts, and their queries are still bounded by the pool — and the deadline is disabled for a measured long synchronous export by setting `0`.
  - A cancelled statement (PostgreSQL `57014`) and the expired deadline reach the caller through the **same** code: `GlobalExceptionFilter` maps `57014` to `RequestTimeoutError`, so the envelope is `REQUEST_TIMEOUT` / 503 with a message in the catalog (`i18n/*/errors.json`) rather than a 500 quoting the driver. Because the statement was cancelled, its transaction is rolled back — this is a refusal, not a partial write.

  Regression: `request-deadline.test.ts` (budget expiry, pass-through, multipart exemption, `0` disables, and a real `pg_sleep` cancelled by the pool cap → 503).
- **Remaining risk:** a *transaction* holding many statements each under 15 s is not bounded as a whole — only the HTTP deadline stops the request, and the transaction is then rolled back when the connection is released. Operators running a legitimately slow report must raise `REQUEST_TIMEOUT_MS` deliberately, not discover the 503.

## G75 — The allocation picker silently hid every issued document past the first 500 *(was: `sales-credits` flake)*

- **Module / contract:** sales — the allocatable-document read behind `POST /api/v1/Sales/action/paymentAllocatableInvoices`, `creditNoteAllocatableInvoices` and `billCreditAllocatableBills` (PLAN §4.8, §4.9, §4.12); observed through `apps/api/test/sales-credits.test.ts`, "applies part of a credit to an invoice and both balances follow".
- **Impact:** the three pickers read issued documents through `records.find()` with `maxSize: 500` and **no** `orderBy`, so PostgreSQL returned an arbitrary 500 of the 571 issued invoices the configured database held. A payment or credit note therefore could not be allocated against a real invoice that existed: the document simply was not in the list. The same read priced every row with its own balance query (N+1), and the offset was applied to the raw rows rather than to eligible ones, so pages could skip documents.
- **Expected vs observed:** expected — every eligible document is reachable, newest first, with something still owed; observed — a 500-row window with no ordering, and one balance query per row.
- **Status:** **Fixed (22.26)** — the read is now `collectAllocatable()` (`apps/api/src/sales/payments/allocatable.ts`): it pages chronologically through `SalesRecords.findPage` (newest first), prices each 200-row scan in one `outstandingOfMany` call, counts `offset` in *eligible* documents, bounds the scan at 5 000 rows and reports `hasMore` instead of pretending the list ended. The three endpoints accept `limit`/`offset` and return `{ list, hasMore, limit, offset }`, documented in `docs/modules/sales/api.md`.
- **Why it looked like a flake:** the failure depended on which arbitrary 500 rows the unordered query returned for the shared database's row count, so it appeared under the full suite and disappeared on a rerun or on a freshly seeded database. It was data-volume and ordering, never test isolation; the entry stays here so the earlier diagnosis is not repeated.
- **Remaining risk:** the 5 000-document scan ceiling still bounds one request; a database with more than 5 000 unsettled *and* settled documents ahead of the requested page reports `hasMore` and needs a narrower filter.

## G76 — Readiness checks the database only; queue/provider health is on demand

- **Module / contract:** platform — `apps/api/src/health/health.controller.ts` (`/health/live`, `/health/ready`).
- **Impact:** readiness answers whether the process is up and the database answers `SELECT 1`. It does not probe Redis/queue reachability or a provider. That is deliberate for the probe (a readiness check must be cheap and must not call a provider), but a load balancer can keep sending traffic while the queue is down, and an operator learns about a provider outage from a module page rather than from readiness.
- **Status:** Accepted (22.21) — the safe probe is DB-only; queue/provider diagnostics are the module health endpoints (`AdvancedIntegrations/action/metrics`, ESignature operations/health, Voice/Omnichannel health) and the platform operations snapshot. Splitting readiness into an optional deep probe with its own budget is an operations decision (22.21 follow-up), not a change that belongs in every kubelet check.
- **Remaining risk:** a deployment whose only health signal is `/health/ready` will not see a queue outage.

## G77 — No continuous metrics/tracing exporter; metrics are derived module documents

- **Module / contract:** platform — no Prometheus/StatsD/OTel exporter; module services compute counters from their own tables (`IntegrationMetricsService`, `crm-chat-observability`, the AdminInternal operations snapshot).
- **Impact:** there is no time series: an operator sees the current counts and the gaps in `jobs`/`outbox`, but cannot graph request latency, error rate, retry rate or provider health over time without querying the database. Request latency was measured once by `scripts/perf-baseline.ts` (22.20), not continuously. Traces are the correlation ids (request → outbox `correlation_id` → worker log; request → job payload/result) rather than spans.
- **Expected vs observed:** expected — either an operator-owned metrics/tracing backend (the plan permits OpenTelemetry only if compatible instrumentation exists) or an explicit decision to stay derived; observed — no exporter and no backend, now documented rather than implied.
- **Status:** Accepted (22.21; narrowed 23.8) — adding a second metrics stack was explicitly out of scope without an owner/backend; the operations snapshot and module metrics are the interim answer. Phase 23.8 added process-local security-event counters and 24-hour receipt counts to that snapshot, with the logger's correlation id on each event. There is still no time series, cross-instance aggregation or alerting. Owner: platform/operations; revisit with a deployment decision.
- **Remaining risk:** no alerting on a latency/error regression, and no historical queue age; the snapshot is point-in-time.

## G78 — CI is a nightly integrity check, not a PR gate

- **Module / contract:** platform — `.github/workflows/quality-gate.yml`, `pnpm ci:gate`.
- **Impact:** by owner decision for 22.22, the gate runs on a schedule (02:00 UTC) and manual dispatch, not on every pull request. A lint/type/unit/build/contract regression can merge into `master` and stay undetected until the next scheduled run; the PR itself has no automated check. The gate also has no database, so integration regressions are only caught by a local `pnpm verify` or a sandbox run.
- **Expected vs observed:** expected — either a PR gate or an explicit accepted window; observed — scheduled-only with the window documented in `docs/quality/ci-gates.md` §1/§7 and no silent implication that CI blocks merges.
- **Status:** Accepted (22.22) — changing the trigger to PR-gated is an owner/infrastructure decision (runner cost, database policy, browser cache), not something to switch on unilaterally. Owner: platform; revisit at 22.24 release readiness.
- **Remaining risk:** the main branch can carry a red build or a type error for up to a day; keep the local pre-merge habit (`pnpm verify`) until the trigger changes.

## G79 — `hooks-events` restore-event test flakes under the full parallel suite but passes solo

- **Module / contract:** platform — `apps/api/test/hooks-events.test.ts`, "publishes entity.restored for a restore".
- **Impact:** during the 22.22 closing `pnpm verify`, that assertion failed in the 250-file fork pool; the file passes solo (13/13) and the immediate full rerun passed it (only the known G75 credit flake remained). It shares the configured database with every other integration file and is exposed by parallel ordering, not by a 22.22 change (22.22 adds CI scripts/config and no production code).
- **Expected vs observed:** expected — the event test creates its own record and filters its own outbox rows, so another file cannot page or delete them; observed — a full-suite run can still see the assertion fail, and the exact interference is not diagnosed.
- **Status:** **Fixed (22.26)**, with one honest caveat: the original failure was never reproduced, so this is the read path being made correct rather than a confirmed root cause. Both helpers in `hooks-events.test.ts` read the **whole** `outbox_events` table and filtered in JavaScript after the fact — `eventsFor()` then sorted by the record's `version` *string* — while the shared database carries every other file's events (and the table is the 289 k-row one G74 names). The read now filters on `payload ->> 'entityId'` and `payload ->> 'entityType'` in SQL and orders by `created_at`, and `countOutboxRows()` counts **this entity's** rows instead of the global table (that one was a genuine cross-file race: any other file writing an event between the two reads failed the rollback assertion).
- **Remaining risk:** if the failure was actually outside the read (a hook commit racing the assertion), the flake could return. Treat a red `hooks-events` in a future full gate as a **new** diagnosis, not as this entry reopening, and capture the actual expected/received values.

## G80 — The restore drill is blocked: no approved isolated recovery environment, no approved RPO/RTO

- **Module / contract:** platform — backup/restore (`docs/operations/backup-restore.md`, Phase 22.23).
- **Impact:** the plan requires a restore exercise in an approved isolated recovery environment and an owner-approved RPO/RTO. Neither exists: the only database is the configured `carocrm_dev`, and the owner has not approved target values. Without the drill there is no measured RTO, no proof that files and DB metadata align after a restore, and no evidence that the real upgrade/migration path survives one. The demo NDJSON artifact cannot stand in for it (G81).
- **Expected vs observed:** expected — a rehearsed restore with evidence and an explicit RPO/RTO; observed — the procedure and reconciliation policy are written, but no restore has run, and creating a database to run one would violate AGENTS.md §3.6.
- **Status:** **Blocked (Phase 23.9, 2026-11-12) — missing approvals named.** The two things that block the exercise are approvals, not code, and they have not been given: there is no approved isolated recovery environment and the owner has not approved an RPO/RTO (owner decision D4 in `docs/security/phase-23-security-baseline.md` §6). Phase 23.9 therefore did not run a drill and did not create a database. What was missing — a repeatable, measured, evidenced drill — is in the repository: `scripts/restore-drill.mjs` (`pnpm restore:drill`) verifies an archive (SHA-256 over every file, `pg_restore --list` structure, file-archive presence, age and permissions), and only then, and only with `--allow-restore`, restores into a target the operator names. It refuses to run if that target is unset, is the same URL as the primary, or is named after an application database, and it never creates a database (AGENTS.md §3.6). It measures time-to-queryable and writes JSON + markdown evidence with no connection string in it, and the evidence states that RPO/RTO are unapproved, so a measurement can never be read as a pass. `scripts/deploy/restore-drill.cron.example` shows the weekly line a deployment owner installs; it is shipped, not installed. Verified on 2026-11-04 against a real schema-only archive in container mode: checksums verified, 927 TOC entries listed, file archive correctly reported absent, no database contacted, evidence written mode 600. The 23.9 operational record is `docs/security/deployment-baseline.md` §6/§9 and `docs/runbooks/security-incident-response.md` §8. **Unblock by** approving an isolated target, a window and RPO/RTO, then running the drill with `--allow-restore` and reading the evidence. Owner: platform/operations. Review: when the environment is approved (no date until then).
- **Remaining risk:** an untested backup is not a recovery plan; the release readiness (22.24) must not claim restore coverage. The tooling closes the "we could not run one" half of that; the "nobody has run one" half is exactly what remains.

### G80 read-only verification (Phase 24.2, 2026-11-14)

**D4 is still missing**: no approved isolated recovery target, permitted writes, RPO or RTO. No restore
was attempted and no recovery database was contacted. With `RESTORE_DATABASE_URL` unset,
`node scripts/restore-drill.mjs --target-env=RESTORE_DATABASE_URL` **refused with exit 1** before any
database connection ("the recovery target is not provided") — the fail-closed behaviour the plan
requires. `pnpm backup:freshness` examined the only archive under `.data/backups`
(`phase22-2026-11-04T01-28-42-309Z`, a **schema-only** tooling artifact): checksums verified, 3 files,
0 world-readable, no encryption marker, but **243.1 h old** against a 26 h limit → exit 1 `STALE`.
This is archive integrity/freshness evidence only: it is not a restore, not a recovery point, and does
not change the `Blocked` status. D4 remains the only unblock. Commands and exact output are in
`docs/quality/phase-24-test-evidence.md` §24.2.

## G81 — No automated, encrypted, off-host backup; the existing demo artifact is partial and world-readable

- **Module / contract:** platform — backup artifacts and retention.
- **Impact:** the repository has no scheduled `pg_dump`, no file-storage backup, no off-host copy and no monitoring. The only artifact (`.data/demo/backup-2026-10-22T03-12-12-673Z`) is a 40-table NDJSON demo snapshot with **no** `users`, `roles`, `teams`, `app_settings`, `audit_log`, `outbox_events` or `jobs`; its files are **world-readable (644)**, have no encryption marker, and its newest file was **179.9 h** old on 2026-10-29. `archive_mode` is `off`, so there is no PITR. `pnpm verify:backup` flags 9 problems. File storage (`.data/files`, 1 846 files) has no backup artifact and sampled files are 644.
- **Expected vs observed:** expected — scheduled full dumps plus matched file archives, checksums, encryption, restricted permissions, off-host retention and a freshness alert; observed — manual commands in a document and a partial, unencrypted demo snapshot.
- **Status:** **Blocked (Phase 23.9, 2026-11-12) — deployment-owned; tooling shipped, nothing installed or evidenced.** `scripts/backup.mjs` (`pnpm backup`) implements pg_dump + files, SHA-256 checksums, gpg-encryption required by default, 700/600 permissions, `pg_restore --list` verification, opt-in prefix-only retention and a schema-only tooling mode; the existing demo artifact was chmodded to 700/600 (the `verify:backup` permission finding is gone, 8 problems remain). Added since: `pnpm backup:freshness` (`scripts/restore-drill.mjs --check-freshness`), which exits non-zero when the newest archive is outside `BACKUP_MAX_AGE_HOURS` (default 26 h), when its checksums do not verify, or when no archive exists — so a stalled or failing run becomes an alert instead of a surprise at restore time; and `scripts/deploy/backup.service.example` / `backup.timer.example`, which wire the job and the freshness check together. **Still missing and named:** an installed scheduler/timer, an off-host destination, a provisioned gpg recipient/key, and someone reading the alert — plus an evidence artifact showing all four on the deployment. The templates are shipped, not installed, so G81 stays High and **Blocked**, not Partial: Phase 23.9 cannot install a deployment from this repository, and the demo snapshot is still not a recovery point. Requirements are in `docs/security/deployment-baseline.md` §6/§9; see also `docs/quality/phase-22-25-release-blocker-remediation.md`.
- **Remaining risk:** data loss up to the last unmonitored manual dump; a leaked backup because it is world-readable; inability to meet any approved RPO once one exists.

### G81 read-only verification (Phase 24.2, 2026-11-14)

The four deployment-owned items named above are still missing: no installed scheduler/timer, no off-host
destination, no provisioned gpg recipient/key, and no alert recipient. In this checkout
`BACKUP_GPG_RECIPIENT`, `BACKUP_ROOT`, `RESTORE_DATABASE_URL` and `BACKUP_MAX_AGE_HOURS` are **all
unset**; only `.example` templates exist under `scripts/deploy/`, and the repository installs no
`backup.service` or `backup.timer`. Read-only checks: `pnpm backup:freshness` → exit 1 (243.1 h stale
schema-only archive, checksums verified, no encryption marker);
`node scripts/verify-backup.mjs .data/demo/backup-2026-10-22T03-12-12-673Z` → exit 1 with **8
problems** (7 missing core tables — `users`, `roles`, `teams`, `app_settings`, `audit_log`,
`outbox_events`, `jobs` — plus a 553.4 h age; 40 tables / 31,379 rows, no encryption marker). Nothing
was installed, chmodded, created or deleted. G81 stays **High / Blocked**; no owner acceptance was
recorded or signed. See `docs/quality/phase-24-test-evidence.md` §24.2.

## G82 — The movement history exposed a limit with no way to page deeper

- **Module / contract:** sales — `GET /api/v1/Sales/inventory/history` (`InventoryService.history`); the follow-up G69 named in its own remaining risk.
- **Impact:** the endpoint answered "the newest N movements" and stopped there. A reader that wanted to scroll further back had nothing to scroll with: no position, no continuation token. The only way to reach an older movement was to raise `limit` — capped at 2 000 rows — so a ledger larger than that could not be read through this endpoint at all, and a reader had to fetch pages it did not need to reach the one it did.
- **Expected vs observed:** expected — a page with a place (an offset) and a continuation (a cursor), the way the generic list already paginates; observed — one bounded window and no way to ask for the next one.
- **Status:** **Fixed (22.27).** `GET /api/v1/Sales/inventory/history` takes `?limit`, `?offset`, `?cursor` and `?total=false`, and answers `{ list, offset, count, total?, hasMore, nextCursor? }`. The cursor is a **keyset** over the ledger's chronological order (`created_at desc, id asc`): it names the row the page ended on, so a movement written while the reader walks the pages joins the list at its own place and does not move the boundary — the walk neither repeats nor skips a row, which an offset window cannot promise (G71). `?offset` stays, for a reader that wants a position rather than a token, and a cursor wins over an offset because it *is* the position. A cursor the endpoint did not issue is refused (`400 INVALID_QUERY`), never read as page one. The count is a second pass over the filter, so `?total=false` opts out of it — the same opt-out the entity list offers. Regressions: `apps/api/test/sales-inventory-history.test.ts` (the page, the continuation, a movement written meanwhile, the offset walk, the count opt-out, the refusals) and `apps/api/test/sales-paging.test.ts` (the token itself).
- **Remaining risk:** the order is by *recording* time, not by the row's own `occurredAt`. A movement is never backdated, so the two agree today; a future backdated entry would sort by when it was recorded, and the two orders would have to be reconciled then. The cursor is positional, not filter-bound: a reader that changes the filter while holding a cursor walks a different window — the filter, not the token, decides what it may see.

---

# Phase 23 — New findings (2026-11-09)

> Opened by Phase 23.0 (`plans/PLAN_Phase_23_Security_Hardening.md` §6). The evidence, the executed commands and the
> owner decisions behind these entries are in `docs/security/phase-23-security-baseline.md`; the single exception list
> is `docs/security/exception-register.md`.
>
> **Note on the ID sequence:** `G85` was assigned during the 23.0 audit and then **withdrawn** as a
> duplicate of **G33** (the marketing webhook is neither HMAC-signed nor timestamp-mandatory — one finding,
> one ID). The remaining IDs are not renumbered, so the sequence has one deliberate gap.

| ID | Title | Module | Severity | Status |
|---|---|---|---|---|
| G83 | Three worker doors cannot be called by the worker — they lack `@Public()`, so the global guard answers 401 before the capability check | sales / marketing-automation | Medium | Fixed (23.4) |
| G84 | The OAuth callback never compares a redirect URI, although its own comment says it does | advanced-integrations | Medium | Fixed (23.3) |
| G86 | Four independent SSRF validators, and one outbound fetch that follows redirects | platform / voice | Medium | **Fixed 23.5** (shared classifier, redirects pinned, empty allowlist fails closed) |
| G87 | Half-configured S3 credentials are silently dropped and the SDK falls back to its default credential chain | platform / files | Low | Fixed (23.1) |
| G88 | Every module system principal carries `sysAdmin`, so record ACL is bypassed for worker and public-intake writes (the concrete shape of F1) | platform | Medium | Mitigated (23.4) — system scope documented; user-scoped work uses `runAsUser` |
| G89 | The worker's BPM/workflow handlers write CRM records through the worker's own DB access, bypassing the API's ACL layer | worker | Medium | Open — documented system-scoped automation (23.4); residual risk |
| G90 | The generated OpenAPI document is served without authentication and exposes the whole route surface | platform | Low | Open |
| G91 | Readiness returns database reachability to an anonymous caller | platform | Low | Open |
| G92 | The DB-free CI lane contains no API authorization assertion; SSRF/security-event suites were outside the include list | platform (CI) | Medium | Partial (23.8: SSRF/security events added; authorization still sandbox-only) |
| G93 | The Phase 22.17 §7/§9 exception list drifted from this register after the 2026-11-03 fixes | platform (docs) | Low | **Fixed (23.0)** |
| G94 | `POST /api/v1/Refresh` is public and cookie-driven with no CSRF check | auth | Medium | Fixed (23.1) |
| G95 | The AI-agent trigger door reads only the **first 20** published agents, ordered by a random UUID, so a matching agent can be invisible | ai-agents | Medium | Open (found 23.3) |
| G96 | A non-admin could read any record's audit history by supplying its id | audit / ACL | Medium | Fixed (23.4) |
| G97 | Dependency-vulnerability audit is manual; it is not in the mandatory CI gate | platform / supply chain | Low | Accepted (23.6; release checklist) |
| G98 | The three sample extension packages in `modules/` are unsigned, so production `enforce` refuses them | extensions / supply chain | Low | Accepted (23.6; development fixtures) |

## G83 — Three worker doors cannot be called by the worker

- **Module / contract:** sales, marketing-automation — `POST /api/v1/Sales/action/generate-subscription-invoices`,
  `POST /api/v1/MarketingAutomation/action/delivery/run-scheduled-batch`,
  `POST /api/v1/MarketingAutomation/action/journey/run-batch`.
- **Impact:** the worker posts to these routes with only the `x-worker-secret` header
  (`apps/worker/src/handlers/sales-handlers.ts:37,136`; `apps/worker/src/handlers/marketing-handlers.ts:25,29,68,88`),
  but none of the three routes carries `@Public()`
  (`apps/api/src/sales/sales.controller.ts` has `@Public()` only at `:780` and `:818`;
  `apps/api/src/marketing-automation/marketing-automation.controller.ts` only at `:627,634,641,650,657,678,818,931,949`).
  The global `AuthGuard` (`apps/api/src/auth/auth.guard.ts:37-84`) therefore demands a Bearer token or a session cookie
  first, and the worker sends neither.
- **Expected vs observed:** expected — the worker capability is the credential, exactly as on every other worker door;
  observed — **401 before the capability check**, so the capability is never consulted.
- **Reproduction (2026-11-09, executed):** a `POST` with only `x-worker-secret` answered
  `401 AUTHENTICATION_REQUIRED` on all three routes, while the sibling `Sales/action/expire-quotes` (which *is*
  `@Public()`) answered `401 AUTHENTICATION_FAILED / "Invalid worker capability"` — i.e. it reached the capability
  check and failed there, as designed.
- **Severity:** Medium. This is an **availability** defect, not an authorization bypass — it fails closed.
- **Root cause:** the `@Public()` decorator was applied door by door; these three were missed.
- **Status:** Fixed (23.4). `Sales/action/generate-subscription-invoices` is worker-only, so it carries `@Public()` and
  its existing `assertWorkerSecret` is the authorisation. The two marketing routes were **dual doors** (admin token
  or worker capability on one route); `@Public()` skips session resolution, so a dual door would leave the admin
  branch with no principal. They are split like Sales' `expireQuotes` / `expire-quotes`: the admin routes keep their
  session check, and `action/delivery/run-worker-batch` / `action/journey/run-worker-batch` are `@Public()` and
  require the shared capability. The worker's two path constants point at the new doors. Every capability is
  compared in constant time and refused when unconfigured.
- **Regression test:** `marketing-automation-delivery.test.ts` asserts the worker door refuses a wrong capability and
  accepts the configured one; `marketing-automation-journey-runtime.test.ts` and the Phase 22 marketing journey
  exercise the admin doors. The session guard is no longer reached before the capability check on a worker door.

## G84 — The OAuth callback never compares a redirect URI

- **Module / contract:** advanced-integrations — `GET /api/v1/integrations/advanced-integrations/oauth/callback`.
- **Impact:** the callback's own comment claims "the redirect URI the platform sent is an allowlisted constant, and
  the one that comes back is compared against the state row — a callback for a different redirect is refused"
  (`apps/api/src/advanced-integrations/oauth-callback.controller.ts:26-29`). **No such comparison exists.** The
  callback schema is `.strict()` and has no `redirect_uri` member
  (`apps/api/src/advanced-integrations/dto/advanced-integrations-shapes.ts:79-86`), so the value the provider echoes
  back is never read; the exchange sends the platform's own constant `OAUTH_REDIRECT_URI`
  (`apps/api/src/advanced-integrations/oauth-flow.service.ts:54,164,233`).
- **Expected vs observed:** expected — the claim in the comment, or an explicit note that the constant is used
  unconditionally; observed — the code is safe in the *direction that matters* (the platform sends and uses its own
  registered value), but the stated control does not exist.
- **Severity:** Medium — a false security comment is a maintenance hazard, and a provider that requires the echoed
  redirect URI to match would not be checked.
- **Status:** Fixed (23.3) — the callback schema now accepts the echoed `redirect_uri`, the flow compares it with the
  value the platform sent (constant-time) **before** the code is exchanged, and a state row whose stored redirect URI
  is not the platform's own constant is refused as a tampered row. The comment now describes a check that exists, and
  the same rule was applied to the generic OIDC sign-in added in this sub-phase.

## G86 — Four SSRF validators, and one fetch that follows redirects **— Fixed (23.5)**

- **Module / contract:** platform — `apps/api/src/ai-agents/ai-provider-url.ts`,
  `apps/api/src/voice-communications/media-url.ts`,
  `apps/api/src/advanced-integrations/provider-http-client.ts:113`,
  `modules/webhook-integration/src/shared.ts:109`.
- **Impact:** four independent implementations of the same rule will drift. More concretely,
  `apps/api/src/voice-communications/voice-media.service.ts:167` is the **only** outbound fetch that does not pin
  `redirect` to `'manual'` or `'error'` — it follows redirects by default, while the URL check at `:162` validates only
  the original URL. An allowlisted host that answers with a 302 to a private or metadata address would be followed.
  The `media.allowedHosts` allowlist is empty by default, so the path is unreachable until an operator configures it.
- **Severity:** Medium (conditional on configuration).
- **Status:** **Fixed (23.5).** `packages/core/src/net/address.ts` is now the one classifier (`isLoopbackAddress`,
  `isPublicAddress`, `isPrivateAddress`, `isLoopbackHostname`); the four validators delegate to it and keep only their
  own protocol/allowlist policy. It parses every IPv6 spelling that the copies disagreed on — `[::1]`,
  `::ffff:127.0.0.1`, `::ffff:7f00:1`, ULA, link-local, 6to4/Teredo/NAT64-embedded private IPv4 and the documentation
  range. `assertSafeMediaUrl` now requires https and **refuses every fetch when `media.allowedHosts` is empty** (the
  comment said so; the condition did not). `voice-media.service.ts` uses `redirect: 'error'`, so a 302 cannot leave the
  validated origin. Proven DB-free by `apps/api/test/phase23-5-ssrf.test.ts`; the DNS-rebinding window between check
  and connect remains documented in `ai-provider-url.ts`.
- **Remaining risk:** DNS rebinding (a record that changes after the check) is not closed; the connector and webhook
  transports pin redirects, and the AI/voice destinations are administrator-configured.

## G87 — Half-configured S3 credentials are silently dropped

- **Module / contract:** platform — `apps/api/src/config.ts:42-43`, `packages/files/src/s3/index.ts:206-209`.
- **Impact:** `parseS3Settings` sets the access key **only** when both the key id and the secret are non-empty; if
  either is blank, **both are dropped** and the AWS SDK falls back to its default credential chain. `S3_BUCKET` and
  `S3_REGION` *do* throw at boot, so the object store fails closed for those and fails **open** for the credentials.
- **Severity:** Low — a misconfiguration that silently uses ambient credentials is a surprise, not a leak.
- **Status:** Fixed (23.1) — half-configured credentials now throw instead of falling back to the ambient chain.

## G88 — Module system principals bypass record-level ACL

- **Module / contract:** platform — `apps/api/src/{customer-success,lead-score,service-desk,advanced-integrations,esignature,marketing-automation,voice-communications}/*-authority.ts`.
- **Impact:** each authority file runs work under a principal whose `roles` include `'sysAdmin'`. The ACL engine
  treats that snapshot as administrative (`apps/api/src/acl/acl-api.service.ts:374`) and
  `canAccessRecord` then returns `{allowed: true, scope: 'all'}` **unconditionally** (`:235`). The authority files
  assert the opposite — e.g. `apps/api/src/marketing-automation/marketing-automation-authority.ts:15-18` ("never
  bypasses the *record's* ACL, because the command has already passed that check"), which is true for an admin door
  and false for a worker door, where no prior caller check exists. Two **public, unauthenticated** endpoints reach
  this principal: `apps/api/src/service-desk/web-to-case.service.ts:98` and
  `apps/api/src/marketing-automation/marketing-form.service.ts:205`.
- **Expected vs observed:** expected — an async job re-derives the initiating principal and re-evaluates record and
  field ACL at execution time; observed — the record ACL is bypassed.
- **Severity:** Medium. The correct reference implementation already exists at
  `apps/api/src/reports/report.service.ts:290-303`, where a real user is re-derived and the owner match, entity
  access, visible fields and the record predicate are all re-evaluated.
- **Status:** Mitigated (23.4). The remaining `sysAdmin` principals are now classified rather than left ambiguous:
  every worker door they serve is a **system-scoped** scheduled sweep (billing run, marketing batch, SLA scan,
  artifact retrieval, provider callback), and the public intake paths are system-scoped by design because there is no
  user to act as. User-scoped async work goes through the new `apps/api/src/common/async-principal.ts`
  (`runAsUser`), which reloads the initiating user, fails closed when the account is inactive, and executes under the
  user's current roles; the scheduled-report path now uses it. The full list of system-scoped jobs and why is in
  `docs/quality/authorization-matrix.md` §3.1. **Residual risk:** the system principals still carry the platform
  wildcard, so a future user-scoped door that reuses one would bypass record ACL — the review rule is that a
  user-scoped door must use `runAsUser`, not a module authority.

## G89 — Worker BPM/workflow writes bypass the API's ACL layer

- **Module / contract:** worker — `apps/worker/src/workflows/workflow-handlers.ts:63,88,198`,
  `apps/worker/src/workflows/workflow-store.ts:179,224`.
- **Impact:** these handlers carry a `userId` into the job but write through the worker's **own** database access
  (`bpm-store.ts`, `workflow-store.ts`), not through the API. The `userId` is never re-checked against the record's
  ACL at execution time, so a workflow step can write a record the initiating user could not have written.
- **Severity:** Medium.
- **Status:** Open — documented at 23.4 as **intentional system-scoped automation**: a workflow/BPM action is
  configured by an administrator and applies after the triggering transition already passed the caller's ACL; it is
  not a user-supplied write. The worker still does not re-evaluate the record ACL, which is the residual risk.
  Route the narrowing (worker calls an API door under the initiating principal) to **23.10**, where the field/bulk
  authorization matrix is completed.

## G96 — Any signed-in user could read any record's audit history by id

- **Module / contract:** audit — `GET /api/v1/AuditLog?entityId=…` (`apps/api/src/audit/audit.controller.ts`).
- **Impact:** a non-admin was required to pass `entityId`, but the id was never checked against the record's ACL. Any
  signed-in user who knew or guessed a record id could read its field-level history — old and new values, actor names
  and timestamps — even when the record itself answered 404 on the record endpoint. That is an independent-object
  authorization failure, not a scoping bug.
- **Expected vs observed:** expected — the history of a record is readable only when the record is; observed — the
  audit query filtered by id without consulting the entity ACL.
- **Fix (23.4):** `AuditReadService.assertHistoryVisible` resolves the record through `EntityCrudService.get`, which
  applies entity, record and field ACL and answers 404 for a record out of scope. When the query omits `entityType`
  the audit rows name it; more than one type for one id is refused rather than guessed. The isolated audit test
  harness does not boot the entity module, so its non-admin branch is **fail-closed** (403) and names that reason.
- **Verification:** `apps/api/test/phase23-4-idor.test.ts` (a stranger asking for a foreign Account's history gets 403
  and no record data); `apps/api/test/audit.test.ts` (the harness branch).

## G90 — The OpenAPI document is served without authentication

- **Module / contract:** platform — `GET /api/v1/OpenApi` (`apps/api/src/bootstrap.ts:238`).
- **Impact:** an anonymous caller receives the platform's complete route surface — **772 paths** measured on
  2026-11-09 — including admin, worker, webhook and portal paths. That is information disclosure (a map of the
  attack surface), not a bypass.
- **Severity:** Low.
- **Status:** Open — target **23.5**, together with the G1 contract work. The owner decides whether the document stays
  public or requires an administrator.

## G91 — Readiness discloses database reachability to an anonymous caller

- **Module / contract:** platform — `GET /health/ready` (`apps/api/src/health/health.controller.ts:18`).
- **Impact:** an anonymous caller learns whether the database is up (`{"status":"ok","database":"up"}`, measured
  2026-11-09). Minor reconnaissance value.
- **Severity:** Low.
- **Status:** Open — target **23.8**.

## G92 — The DB-free CI lane proves nothing about authorization

- **Module / contract:** platform (CI) — `vitest.ci.config.ts:19-62`.
- **Impact:** the include list holds 47 named API suites plus the `packages/*` glob. **Every** API-level
  authorization, BOLA and injection suite is excluded, because each boots the API against the database. The
  DB-free SSRF suites were also outside the list, so even the provider-URL boundary was unchecked nightly.
  Combined with the nightly-only trigger (G78), the consequence is that **no authorization assertion runs in CI
  at all**, on any schedule.
- **Severity:** Medium.
- **Status:** **Partial (23.8).** `ai-agent-adversarial.test.ts`, `phase23-5-ssrf.test.ts` and
  `phase23-8-security-events.test.ts` are now in `vitest.ci.config.ts` (88 files / 1 419 tests), so SSRF and the
  security-event contract run nightly. Authorization remains DB-backed and sandbox-only; target **23.10**. The
  nightly-only trigger stays by owner decision (see `docs/security/phase-23-security-baseline.md` §6, decision D3).

## G93 — The Phase 22.17 exception list drifted from the gap register

- **Module / contract:** platform (docs) — `docs/quality/phase-22-security-privacy-regression-suite.md` §7 and §9.
- **Impact:** commit `fe27adb` (2026-11-03) fixed G37, G38, G39 and G63, and updated `known-gaps.md`, but §7 and §9 of
  the Phase 22.17 document were left untouched — so four closed findings were still listed as live exceptions, and
  §8's acceptance claim ("remaining open findings are Medium/Low and are dispositioned in §9") was false: G50, G51,
  G52, G53, G33, G66, G67, G68, G29 and G27 were open and dispositioned nowhere.
- **Severity:** Low.
- **Status:** **Fixed (23.0)** — all exceptions now live in `docs/security/exception-register.md`; the Phase 22.17 §9
  links there instead of keeping a second table, and the four closed findings are recorded as closed.

## G94 — `POST /api/v1/Refresh` has no CSRF check

- **Module / contract:** auth — `POST /api/v1/Refresh` (`apps/api/src/auth/auth.controller.ts:114`).
- **Impact:** the route is `@Public()`, and `AuthGuard` returns `true` for a `@Public()` route **before** any CSRF
  comparison (`apps/api/src/auth/auth.guard.ts:28-30`). The refresh therefore rotates the session from the
  `CRM-REFRESH` cookie with no CSRF proof. A cross-site top-level POST navigation can rotate a victim's session.
  The impact is muted in the shipped SPA, which keeps a bearer token in `localStorage` and never uses the cookie path
  — but the endpoint is reachable and the contract is not closed.
- **Severity:** Medium.
- **Status:** Fixed (23.1) — cookie-driven refresh now requires the double-submit CSRF token plus an Origin/SameSite check.

## G95 — The AI-agent trigger door reads only the first 20 published agents, ordered by a random UUID

- **Module / contract:** ai-agents — `apps/api/src/ai-agents/runs/triggers.ts:127-134` (the event door) and
  `:342-349` (the integration door).
- **Impact:** both doors select their candidates with `where status = 'published' and is_deleted = false
  order by id asc limit 20`. The agent id is a **random UUID**, so the ordering is arbitrary and the
  window is the 20 agents whose UUID happens to sort first — not the 20 that match. An installation
  with more than 20 published agents therefore has agents that a matching event can **never** start:
  the agent is simply outside the window, and nothing says so. The response reports `matched: 0`,
  which reads like "no agent wanted this event" rather than "the candidate window excluded your agent".
  The fan-out cap that follows (`candidates.slice(0, 5)`) is a deliberate bound; this one is not — it
  bounds the *search*, not the fan-out.
- **Expected vs observed:** expected — every published agent that matches the event type, the entity and
  the record-context rule is a candidate; observed — only the agents inside an arbitrary 20-row window
  are considered.
- **Severity:** Medium — availability, not authorization: the affected agent simply never runs. It
  fails **closed** (no run is started), so it is not a way to make an agent do something it should not.
- **How it surfaced:** the `ai-agent-triggers` suite failed under the full parallel gate and passed
  solo. The cause was **not** the suite's isolation: the shared database held 22 published test agents
  from earlier runs, and the suite's own agent fell outside the window. The leftovers were removed by
  their exact `AGENT_TEST` marker (the suite's own `afterAll` had not run for the interrupted run), and
  the suite passes (15/15) with a clean database. The underlying defect is the window, not the leftovers.
- **Status:** Open (found 23.3) — out of scope for 23.3, which is external identity and OAuth
  correctness; the fix belongs with the AI-agent trigger work (filter by the event type and the entity
  in SQL instead of paging an arbitrary window, and keep the fan-out cap on the *matched* set). The
  finding is recorded here rather than fixed opportunistically.
- **Remaining risk:** until it is fixed, an installation with more than 20 published agents has agents
  whose triggers silently never fire.

## G97 — Dependency-vulnerability auditing is manual, not part of the mandatory gate

- **Module / contract:** platform (supply chain) — `package.json`, `.github/workflows/quality-gate.yml`.
- **Impact:** the repository keeps one `pnpm-lock.yaml` and installs with `--frozen-lockfile`, so a
  dependency cannot change without a lockfile diff. It does **not** automatically learn that an already
  pinned version has a published advisory. `pnpm audit` queries the registry, so making it a mandatory
  step would add a network-dependent failure mode to a nightly gate that currently runs offline after
  install (task 4 explicitly permits adding it only if it is not network-dependent).
- **Severity:** Low — a lockfile diff is still reviewed, and Dependabot/registry advisories are the
  operator's normal channel, but an advisory can sit unnoticed between reviews.
- **Status:** Accepted (23.6). The owner runs `pnpm audit --prod` (and `pnpm audit --audit-level high`)
  as part of the release checklist and records the result with the release; no second package manager
  or vendored scanner is introduced. Revisit when the gate gains a network-capable, isolated audit job
  (23.8).

## G98 — The sample extension packages are unsigned, so production `enforce` refuses them

- **Module / contract:** extensions — `modules/account-health-fields`, `modules/webhook-integration`,
  `modules/project-domain`; `EXTENSION_TRUST_MODE=enforce`.
- **Impact:** the three packages are development fixtures used by `apps/api/test/extensions.test.ts`
  and the module guide. They have no `extension.sig`, so an installation that sets
  `EXTENSIONS_DIR=modules` in production with the default `enforce` will list none of them. That is the
  trust check working as designed, but it is a surprising first-run experience.
- **Severity:** Low — it fails closed (no code loads); nothing is silently trusted.
- **Status:** Accepted (23.6). Signing them in the repository would require committing a private key or
  a release-key workflow; neither belongs in this phase. The module guide and
  `docs/extension-sdk.md` §8 document the signing procedure, and `warn` is the development default so
  the fixtures still load locally. Revisit when the sample packages become release artifacts (23.9).
