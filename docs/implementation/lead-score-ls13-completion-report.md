# Phase 19-LS.13 — Conversion Operation and Transactional Execution: completion report

`PLAN_Phase_19_LeadScore.md` §3.4, §4.3, §7.6, §7.8, §8.3, §9.2, §13.4-6…11, §14.3, §16 (`19-LS.13`); audit
§11 `LS.13`; contract `docs/implementation/lead-score-conversion-contract.md` §3, §4, §6, §10, §11, §13;
compatibility `docs/compatibility/lead-score.md` §4.2–§4.3, §8.

**Exit criterion (plan §16):** *retrying the same operation cannot create duplicate targets, and failed atomic
operations do not leave inconsistent state.* The suite asserts both through the public routes:

- a same-key replay returns the stored operation with **zero** new Contacts, Accounts or events; a second key
  against a converted Lead is refused and leaves the target count unchanged; **two keys fired at once produce
  exactly one 200, one Contact and one converted Lead**;
- the work is one transaction, so every refusal that happens after the claim (already converted, a changed Lead)
  leaves no target behind — and the operation row records which refusal it was.

## 1. What landed

**`lead-conversion.service.ts` (new) — the command.** `POST /api/v1/LeadScore/action/conversion/convert` behind
`conversionExecute`. The order is the design:

1. **Replay first.** A repeated key answers with what happened, whatever state the row is in — succeeded returns
   the stored result, `processing` says in flight, `failed_final` says why it failed finally, and the two
   recoverable states point at the retry route (contract §4.2). A key belonging to another Lead is a conflict and
   never names that Lead.
2. **Re-derive the preview.** The command re-runs the same preview function the caller used and compares the
   fingerprint (`hash`) and the acknowledgement set (`confirmation`). A mismatch is `LEADSCORE_PREVIEW_STALE`
   naming the component, and nothing is written.
3. **The decisions the preview demanded.** A create next to a duplicate candidate — visible or hidden — needs
   `overrideDuplicateFor` *and* the `duplicateOverride` right; a link that would move a Contact to another Account
   needs `allowReparent` + `applyFieldChanges` + `conversion.fieldMergeAllowed`.
4. **T1 — claim.** One insert, in its own transaction, of a `processing` row carrying the plan: the decisions and
   the fingerprint, **never record values**. The LS.2 unique key is the double-click guard; a genuine race replays
   the winner.
5. **T2 — work.** One transaction: `SELECT … FOR UPDATE` on the Lead, re-read under the lock, then every target
   through `EntityCrudService` (validation, field ACL, hooks, audit and the outbox are the ordinary ones), the
   Lead's `Converted` status + references + `conversionOperationId`, the row `succeeded` with the created/linked
   ids, and `lead.conversionSucceeded.v1` carrying ids and the verdict — no name, no payload.
6. **T3 — settle.** A separate transaction, only on failure: `failed_final` for a refusal that will not change by
   repeating it, `failed_retryable` for a transient cause (answered as `503 LEADSCORE_CONVERSION_RETRYABLE`), plus
   `lead.conversionFailed.v1` for the terminal and review outcomes.

**`lead-conversion-audit.service.ts` (new) — the record.** The bounded operations list and single read
(`conversionAuditRead` + the module switch; the Lead's label only when the caller may read that Lead), `retry`
(after the accounting of contract §10.3 — a row that names targets, or a Lead already converted, becomes
`needs_review` instead of re-running), `close` (a reviewable row → `failed_final` with the operator's reason), and
`recoverStuck` (the worker scan: off by default via the new `conversion.recovery` settings section, bounded by
`limit` / `chunkSize` / `staleAfterMinutes`, settling stuck `processing` rows to `failed_retryable` /
`needs_review` and **never touching a record**).

**The permissions and schema work contract §13.2 assigned to this phase.** `LeadConversionOperation` is now
`create: 'yes', edit: 'yes'` — the command creates its row *and* moves it through its states — while `read` stays
`'no'` and the LS.2 guard still refuses every client create/update/delete. `conversionAuditRead` points at the new
synthetic `LeadConversionAudit` resource instead of the entity's own `read`, so granting it cannot open the generic
record API. `previewed` is removed from `CONVERSION_STATUSES` (default `processing`), and a stored row carrying it
would be read as `processing` rather than ignored. `features.leadConversion` and `conversionRecovery` are
delivered, and `implementedPhases` reaches LS.13.

**Seven new error codes**, all localized in `en`/`vi`: `LEADSCORE_ALREADY_CONVERTED`,
`LEADSCORE_CONVERSION_CONFLICT`, `LEADSCORE_CONVERSION_IN_FLIGHT`, `LEADSCORE_CONVERSION_RETRYABLE` (503),
`LEADSCORE_CONVERSION_NEEDS_RECOVERY`, `LEADSCORE_DUPLICATE_REVIEW_REQUIRED`, `LEADSCORE_CONVERSION_REPARENT_REQUIRED`.

**The worker half.** `leadScore.recoverConversionOperations` → `action/work/recover-conversion-operations` (the
shared `x-worker-secret`, the module's system authority) and a `scheduled_jobs` row at 03:50. The job decides
nothing: the switches, the bounds and the rows live in the API, so turning recovery off needs no worker redeploy
(the LS.9 reason, restated).

## 2. The findings that changed the implementation

**A converter role needs `create` *and* `edit` on the operation entity.** The claim inserts a row and T2/T3 update
it, and ACL is the **actor's** — `runAsLeadScoreInternal` exempts the field guard, not the permission check. The
suite makes this concrete: a non-admin with both grants converts and is recorded as `requestedById` and as the
Lead's `convertedById`; the same role with `create: 'no'` is refused before anything exists. This is the LS.5 rule
restated ("writing history is a grant, not a bypass"), and it is now written down where a role author will look.

**The already-converted refusal had to carry the attempt's id.** The first implementation passed `null`, and the
test could not find the `failed_final` row it had just asserted existed — the response named the Lead and the code
but not the attempt. Passing that attempt's id is safe (the caller caused it) and it is the only way the client can
see its own failed row. It never carries another operation's id.

**A refusal before T1 writes no row — and that is a deliberate correction of the contract's table.** §4.2 said the
already-converted case "records a failed_final row"; §3.2 said T1 is only reached when the Lead is not converted.
The code resolves it by *where* each check lives: a stale or unacknowledged request never claims (no row), while
an already-converted Lead is caught inside T2 — which is exactly the case §4.2 was about — so a row exists, is
settled `failed_final` / `already_converted`, and the error points at it. A request that never passed its own
guards leaving an operation row would be evidence of an attempt that did not start.

**Recovery must store decisions, not values.** The row's plan is the target actions, the merge choices, the
fingerprint and the acknowledgements — **not** the proposed field values. A retry re-derives the proposal from
that plan and compares the fingerprint: if the Lead, the map or the reader's visibility has moved on, the retry
turns into `needs_review` / `stale` instead of writing a plan the person never saw. Storing the values would have
duplicated data into an audit row and made exactly that staleness invisible.

**The scan's time comparison is text, and only because the store writes ISO.** `requestedAt` is a JSONB datetime
stored as ISO-8601 text, so `attrs->>'requestedAt' < cutoff` is a lexicographic comparison that happens to be
correct. A different format (or a missing value) would silently never match — which is why the scan also requires
`requestedAt is not null` and why the value is always written by the module itself.

**`processing` is reachable in exactly one way, and that is the point.** T2 is atomic, so a *committed*
`processing` row means the process died between T1 and T2 (or inside T2 before its commit) — never a half-applied
conversion. The scan can therefore settle it without inspecting records in the common case, and the accounting
still checks the Lead and any named target ids before it does.

**A cross-Lead key collision is a conflict, not a replay.** The unique index is installation-wide, so two people
can pick the same key. The answer is `LEADSCORE_CONVERSION_CONFLICT` with the *requesting* Lead only — the row it
collided with belongs to somebody else, and the response must not confirm that.

## 3. Verification

- `apps/api/test/lead-score-conversion.test.ts` — **17 new API tests** against the configured primary database:
  - **exit criterion 1**: same-key replay (same operation id, zero new Contacts, zero new events); a second key on
    a converted Lead (`409 LEADSCORE_ALREADY_CONVERTED`, the attempt recorded `failed_final` / `already_converted`,
    target counts unchanged); **two keys racing → exactly one 200, one 409, one Contact, one converted Lead**; a
    cross-Lead key conflict that does not name the other Lead.
  - **exit criterion 2**: a happy-path Contact + Account conversion asserting the Lead's `Converted` status, its
    three references, the Contact's `accountId`, the row's ids, and one `lead.conversionSucceeded.v1` event whose
    payload contains no Lead name; a link + link conversion that writes the relationship and the references and
    creates nothing.
  - the guards before the claim: a stale fingerprint (component `hash`) and an unacknowledged set (component
    `confirmation`) both refused **with no operation row created**; a duplicate create needing
    `overrideDuplicateFor`; four malformed target shapes.
  - recovery: a retry that re-derives the stored plan and converts; a retry whose plan went stale → `needs_review`
    / `stale` with the Lead untouched; the scan answering `disabled` and then settling a stuck row to
    `failed_retryable` / `interrupted` without touching the Lead; close once then refused; the operations list
    under the audit right with the Lead label withheld from a caller who cannot read the Lead, and `403` without
    the capability.
  - the permission change: a non-admin conversion succeeds under the new grants (row `requestedById` and Lead
    `convertedById` are the caller); a role without the operation `create` is refused with nothing written; the
    feature door answers `403` naming `leadConversion`.
- All fourteen LeadScore API files together — **302 passed / 0 failed**. Four suites were retargeted rather than
  weakened: `lead-score-module.test.ts` (implemented phases to LS.13, the shipped-feature list, the pending list,
  the stored-switch example moved to `aiInsight` / `19-LS.17`, and the pending-operation example likewise),
  `lead-score-schema.test.ts` (the retired `previewed`, the new `create`/`edit` profile, and the pending-operation
  example), `lead-score-model.test.ts` (the same pending example), and the worker's job-registration test (the new
  job and its name).
- Worker suite — **210 passed / 0 failed** across 20 files, including the new job.
- Full `npx vitest run` — **2,937 passed / 34 failed across 205 files**: the +17 over LS.12's 2,920 is exactly
  this suite, and the 34 are the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3,
  `crm-chat` ×3) with zero `lead-score` failures. `npm run typecheck`, `npx eslint` on every touched path,
  `pnpm --filter @carocrm/api build`.
- **The two LS Playwright specs are the one honest wobble.** They pass 9/9 when run clean, and an earlier run in
  this session passed 9/9 too — but two runs launched immediately after a fresh API build failed the **LS.8
  "new version can be compared"** test (8/9, and 1.5 minutes for a suite that normally takes 30 seconds), then
  passed again when the same file ran alone. The failure text was never captured (the run was interrupted), the
  test exercises model versioning rather than anything this phase touches, and the identical test flaked once in
  LS.12. It is recorded as an **intermittent, load-sensitive failure that has not been diagnosed**, not as a
  passing check: the next phase that touches the model workspace should reproduce it deliberately (trace on
  failure is already configured) before the suite is trusted as a gate.
- No migration: the operation columns and the unique key existed since LS.2, and `scheduled_jobs` is seeded.
- Residue: the suite deletes the targets, the Lead, the operation rows, the `entity_links` rows, the roles and the
  users it created, restores the settings row, and warns if a query over the run marker finds anything. The
  conversion's own audit trail (`audit_log`, `outbox_events`) is left in place — it is the platform's history of a
  real operation, and deleting it would make the run's assertions unreproducible.

## 4. What this phase does not claim

- **No wizard.** LS.14 owns the screen; this phase is the command and its record. A person drives it through the
  API today.
- **No Opportunity conversion.** The preview refuses an Opportunity target (`state: 'pending'`, `19-LS.16`) and the
  command never receives one; LS.16 turns the switch and adds the Opportunity links to the same transaction.
- **No merge of a linked record beyond the explicit choices.** `applyFieldChanges` + `conversion.fieldMergeAllowed`
  gate it, and the before/after the preview showed is what runs — there is no "apply everything that differs".
- **No reversal.** A completed conversion is not undone here; the correction workflow (contract §11.4) still has no
  owning sub-phase (G9), and this phase does not invent one.
- **No activity, note, file or email move.** LS.15 owns that; the Lead's `Email.leads`, `Case.leadId` and consent
  provenance stay where they are, and `createdAt`/`updatedAt` of the Lead are the platform's.
- **No `Retry-After` header** on the in-flight answer: the code carries the answer and the controller has no
  response object (recorded in the contract's §13.2 note).
- **The API is bounded but not rate-limited per user** — G10 stands; a retry is one row's state, and the global
  limiter is the only throttle.
- LS.14–LS.18 are not started.
