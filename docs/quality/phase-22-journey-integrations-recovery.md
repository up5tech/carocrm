# Phase 22.14 — Journey: a connector that breaks, and what the platform does about it

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.7 (steps 1–8) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-integrations-recovery.test.ts` (14 ordered steps)
> **Depends on:** `docs/quality/phase-22-journey-ai-controlled-actions.md` (22.13), `docs/quality/phase-22-contract-tests.md` (22.6), `docs/runbooks/advanced-integrations.md`
> **Status:** Implemented and verified — the focused journey and the full `pnpm verify` gate both pass.

---

## 1. The journey in one sentence

A connection is authorized through a real OAuth dance and its credential never leaves the vault in a
form anyone can read; a sync then pages through the provider, and every way the plan says it can break
— a rate-limited page, a cancelled run, a `maxRecords` stop in the middle of a page, a record the CRM
owns — leaves a run row that says what happened, a **checkpoint that says how far it actually got**, and
no second copy of a record that was already applied; a provider callback is verified over the exact
bytes, recorded once, and applied through the same mapping path a poll uses, so a conflict is opened
rather than silently overwritten and a decision made against a world that has moved is refused. Behind
all of it sits the queue: the job the API creates is the job the worker can actually deliver, and when
an operator pauses a connector or switches the module's control plane off, the refusal is a fact about
calls going out rather than a line in a health report.

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| A provider with no network | one hand-built `ConnectorAdapter` registered into the live registry: OAuth (authorize / exchange / refresh / revoke), a paged read of seven contacts with opaque `off:<n>` cursors, and inbound webhooks whose signature is an HMAC over the raw body | **Required** |
| Deterministic faults | a scripted hook: arm the *next* fetch to throw `RATE_LIMITED`, and run a callback after each page (which is how the journey cancels a run *while it is working*) | **Required** |
| A credential at rest | `ENCRYPTION_KEY` set to a synthetic value before `bootApi()`; every secret in the file is a marker string, never a real one | **Required** |
| The control plane switched on | `AdvancedIntegrations` settings `features: { connections: true, oauth: true }` — both off or on by default per module, and both restored in `afterAll` | **Required** |
| A worker capability | `REPORT_WORKER_SECRET` set for this run and restored afterwards, because `process.env` is shared by every test file in the process | **Required** for step 12 |
| Two principals | a **viewer** (`AdvancedIntegrations: read`, nothing else) and an **operator** (`connectionAdmin`, `credentialAdmin`, `providerAdmin`, `diagnostics`, plus `Account` create/read/edit/delete) | **Required** |

## 3. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | The catalog and an inert connection | the connector list is provider administration and a viewer is refused it, not given an empty list; a new connection is `draft`, disabled, holding nothing; a credential smuggled through `connectionOptions.apiKey` is refused **naming the key**; `POST action/connections/:id/test` on a draft answers as a *result*, `{ok:false, code:'CONFIGURATION_INVALID', message:null}` — the provider's words never ride back to the caller |
| 2 | The capability matrix on the write routes | a viewer holding only the module's read right is refused **all eight** write routes with `403` (mapping create/patch/activate/retire, sync, cancel run, resolve conflict, replay dead letter); the read-only preview reaches the domain instead; the same calls as an operator fail for a reason that names the mapping, never for a missing right |
| 3 | A credential in the vault | the stored row is `v1:`-prefixed ciphertext; the plaintext appears in none of the nine surfaces an operator can read (connections, detail, runs, deliveries, logs, health, metrics, audit); a rotation sets `rotated_at` and still never returns a value |
| 4 | The authorization dance | `authorize` hands back a URL carrying a state and a PKCE challenge and no code verifier; the connection waits in `pending_authorization`; a forged state is `401`, a callback with an undocumented extra query parameter is `400` (the schema is strict), the real callback is a `302` whose location carries the connection and the status but **never the code**; the same state presented again is refused; a provider that grants less than its own required scope lands on `reauthorization_required` with `SCOPE_MISSING` |
| 5 | Expiry and revocation | refresh rotates the token **and is reached through the service, because no route or runtime path calls it** (G47); revoke calls the provider *and* destroys the stored secret (`state='revoked'`, ciphertext emptied), the state is terminal for every entry point including `reconnect`, and removing the connection takes its credentials and states with it; a fresh connection is authorized to carry the journey on |
| 6 | The mapping is reviewed before it can write | a mapping whose target is the protected field `assignedUserId` is refused **at activation**, naming the field; a preview renders the sample and creates no link and no record; an inactive mapping cannot be synced |
| 7 | A paged sync | seven records over four two-record pages, one run row with `records_scanned/applied/skipped/failed`, `cursor_after` empty at the end of a full pass, one external link per provider object, one CRM record per link, every operation `applied` under the mapping's own idempotency key |
| 8 | The same page twice, and a run that stops mid-page | re-running the provider's whole dataset produces seven links and seven records, not fourteen; a `maxRecords` stop **inside** a page leaves the cursor at the end of the last complete page, so the half-read record is read again — five records on the continuation, not four — and still no duplicate |
| 9 | A provider that refuses page 2 | the run is `failed` with `last_error_code = 'RATE_LIMITED'` and no token, secret or payload in the detail; the checkpoint keeps `off:2` from the page that really applied; the failure surfaces in the runs list, the dead letters and the connection's "needs attention"; the resume reads the remaining five |
| 10 | An operator cancels a working run | the cancel lands *between* pages (the connector's page hook calls the route while the loop is running) and the loop stops there: `cancelled`, two records scanned, `off:2` in the checkpoint, and a continuation that reads the rest without repeating the start; a run that already stopped cannot be cancelled twice |
| 11 | A conflict, decided by a human | a CRM edit and a provider page disagree under `manual`: the record keeps the human's words, a conflict opens, and `keep_provider` is the only thing that changes it; a second decision on a closed conflict is refused; and a decision whose record moved underneath it is refused with "changed again", leaving the latest human edit standing |
| 12 | A provider callback | a valid HMAC over the exact bytes is `202` with `signature_valid` recorded; the **`jobs` row the ingress itself created** is posted to `action/process-webhook-event` with the worker capability and applies the change; under `manual` the same delivery opens a conflict instead of writing, under `provider_wins` it writes — one path, two policies; a replayed delivery id is `duplicate` with one receipt; a bad signature is `401`, recorded as rejected with its reason and **no payload stored**; an unknown endpoint key is refused without writing anything; no secret → `401`, wrong-length secret → `401`; an event a domain already claimed answers `handled_by_domain` and leaves the record alone |
| 13 | A partial failure and a retry | a run's failed operations are listable by status; retrying one re-opens it (`pending`, attempt counted) and **creates no queue job**, because the adapter contract reads a page and not an object, and a job naming a handler that does not exist would only be a permanent failure with a confident answer attached; replaying a dead letter is an operator action, once, and a viewer cannot do it at all |
| 14 | Disablement | pausing the connector stops every provider call — proven with the provider's own call counter, not with a status string — and a run started before the pause is recorded as failed rather than quietly completing; the test route answers `{ok:false, code:'CONFIGURATION_INVALID'}`; resuming restores the work; `features.connections: false` refuses a new connection by name while health, the list and the detail keep answering; and no credential value appears on any readable surface at the end |

## 4. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **The worker could not reach any of the module's five doors.** The section comment says `@Public()` skips session authentication and the shared capability is the authority; the routes carried no `@Public()`, so the session guard answered `401 AUTHENTICATION_REQUIRED` before the secret was ever compared. Every job name in `ADVANCED_INTEGRATIONS_JOB_NAMES` is a proxy to one of them, so webhook application, outbound push, the expiring-credential sweep and the retention purge could not run in any deployment. Nobody noticed because every existing suite calls the *services*, and the worker's own tests inject a fetcher | High | Fixed (22.14) · G40 |
| F2 | **The webhook job was refused by the door that receives it.** The ingress put the routing `kind` into the payload; the door parses it with a `.strict()` schema that does not declare `kind`, so every job failed `400`. And `handled` — which the schema accepts and `processDelivery` honours so a domain-owned event is not applied twice — was never forwarded, making that guard unreachable | High | Fixed (22.14) · G41 |
| F3 | **A verified delivery could silently mean "no events".** `if (verification.challenge !== null)` read *absence* as *presence*: a connector whose verifier returns `{valid, reason}` (the kit's own shape) had every accepted callback produce nothing — the provider was told 202 and the CRM never changed | Medium | Fixed (22.14) · G42 |
| F4 | **Nine write routes checked nothing, anywhere.** Mapping create/patch/activate/retire, sync, cancel run, conflict resolve and dead-letter replay asserted no capability in the controller and none in the service behind them, while the controller's header claims the matrix cannot drift. A role with only `AdvancedIntegrations: read` could start a sync that writes CRM records under the *connection's* authority and decide which side a conflict keeps. This subsumes the previously recorded G11 | High | Fixed (22.14) · G43 |
| F5 | **The checkpoint did not describe what the run had done.** It was written once, after the loop, so an interruption threw away the cursor of every page already applied — and a `maxRecords` stop in the middle of a page advanced the cursor *past records that were never applied*, losing them silently while the run reported success | High | Fixed (22.14) · G44 |
| F6 | **Cancelling was prose.** The loop never re-read the run's status, so a cancelled run kept calling the provider and its `cancelled` row was overwritten by the loop's final write; and an already-cancelled run accepted another cancel | Medium | Fixed (22.14) · G45 |
| F7 | **`features.connections` enforced nothing.** The schema calls it the control plane, the runbook tells the operator to turn the module's features off, and the flag was read only to describe itself in the health report | Medium | Fixed (22.14) · G46 |
| F8 | **Refresh is correct, concurrency-safe and unreachable.** Advisory-locked, re-checked under the lock, it is exercised only by a test that calls the service. Nothing in the runtime rotates an expiring token, and no live authorization failure moves a connection to `reauthorization_required` | Medium | Open · G47 — the journey calls the service and says so in the step rather than pretending a route exists |
| F9 | **The resilience layer is half decorative.** No caller passes `rateLimit`, so the token bucket never sees a request; `decideRetry`/`computeRetryDelay` (the jittered backoff the engine tests assert precisely) are re-exported and never called; `assertCallable`, the domain's own "may this state call the provider" rule, is exported and unused while the executor repeats it inline. The circuit breaker is the live part, which is why the rest is easy to miss | Medium | Open · G48 |
| F10 | **Three smaller truths about the recovery vocabulary.** `deletionPolicy: 'archive'` is `unlink`; a mapping resolves "the connection for this provider" by name order, not by usability; and the OAuth callback documents a redirect-URI comparison that never happens | Medium/Low | Open · G49, G50, G51 |
| F11 | **What a sync writes, it writes as the human who asked.** The record create inside a run is refused when the *initiator* has no create right on the entity — the connection's authority does not widen a caller's own. The journey had to grant `Account: create` to the operator because of it, which is the property the plan asks for | Info | Design, confirmed (step 7 against step 2) |
| F12 | **A refusal answers with a code, not with the provider's words** — with one exception. `POST …/test` returns `{ok:false, code, message:null}` and the run row keeps `RATE_LIMITED` plus a safe detail; but the OAuth callback interpolates the provider's own `error=` string into its 401, and the credential "reference" column stores the connection's own id and is never cleared on revoke | Low | Open · G52 |

## 5. Evidence

| Check | Result |
|---|---|
| `pnpm exec vitest run apps/api/test/phase22-journey-integrations-recovery.test.ts` | **14 passed** (the 14 ordered steps) |
| `pnpm exec vitest run apps/api/test/advanced-integrations*.test.ts` (7 files, the module's own suites) | **194 passed** |
| `pnpm exec vitest run apps/api/test/phase22-integration-contract.test.ts apps/api/test/phase22-replay-contract.test.ts` | **24 passed** |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| `pnpm exec tsc --noEmit -p tsconfig.json` | no diagnostics |
| Leftover scan for this run's connections, mappings, runs, links, credentials, states, CRM records, users, jobs and settings documents | 0 rows |
| `pnpm verify` | Passed — lint 0/0, typecheck clean, `pnpm test` 244 files / 3,278 tests, `pnpm test:web` 5 files / 21 tests |

**Database discipline.** The configured primary database only (AGENTS.md §3.1). No schema change, no
migration, no extra database or container; nothing truncated, dropped or reset. The seven provider
records this journey syncs become **real CRM records**, and they are identified for deletion by the
external-link rows this run's own connection wrote — the marker in the record name is a second check,
not the primary one. `afterAll` attempts every cleanup group even after an earlier one fails, recovers
its ids **from the database by marker** rather than trusting the lists the steps appended (a step that
fails before it records its own id is the normal case a cleanup has to survive — the first version of
this file orphaned exactly that way), clears a settings document that still names a pointer this run
created (the lesson taken from 22.13), restores `REPORT_WORKER_SECRET`, and asserts zero leftovers.

**External effects.** None. The provider is an in-process adapter: no socket is opened, no credential is
real, no message is sent, and every name, email, key and token in this file carries the run marker.

## 6. Known limitations

1. One connector, one object type. The journey proves paging, resume, conflict and webhook behaviour on `contact → Account`; the vendor-specific cursor and rate-limit shapes live in the adapters, which the provider contract suites own (22.6).
2. The interrupted-run case is simulated at the *page* boundary, which is where the loop can notice anything at all. A process killed mid-page still re-reads that page on the next run — at-least-once reading against an idempotent apply, which step 7 proves.
3. `outcome_unknown`-style reconciliation for a run whose provider call was sent but not answered belongs to the worker suites; nothing here pretends to detect it.
4. Refresh and the expiry sweep are exercised through the service and the notification door, not through a runtime path, because none exists (G47). That is the finding, not a gap in the test.
5. `archive`, the rate limiter and the retry policy are recorded as decorative (G48, G49) rather than asserted as behaviour; the journey asserts only what the code can actually do.

## 7. Acceptance criteria (plan §13.7)

- [x] **A sync can be retried or resumed without duplicating records or losing the checkpoint.** Steps 7–10: the cursor moves only past pages that were committed, a bounded run leaves the half-read record ahead of the cursor rather than behind it, a cancelled run's cursor matches its counts, and every continuation reads what is left and creates nothing twice.
- [x] **Mapping conflicts and partial failures are visible and recoverable.** Steps 11 and 13: a conflict is opened with both snapshots, nothing is overwritten until a human chooses, a stale choice is refused, failed operations are listable and re-openable, and the answer an operator gets describes the real recovery path instead of inventing a job.
- [x] **Credentials never surface, and expiry/refresh/revoke behave.** Steps 3–5: ciphertext at rest, no value on any readable surface, a single-use state, a scope refusal, a rotation, and a revocation that reaches both the provider and the vault (F8/G47 record that nothing rotates a token on its own).
- [x] **Duplicate webhooks, partial pages, rate limits and interruptions are handled, and disablement follows the documented policy.** Steps 9, 12 and 14 — with F1–F3 showing that the queue leg of that sentence was not true before this sub-phase.
