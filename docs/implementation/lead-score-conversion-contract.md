# Phase 19-LS.10 — Conversion domain audit and state contract

`PLAN_Phase_19_LeadScore.md` §2.3, §3.4, §3.5, §4.3, §4.4, §5.5–§5.7, §7.1–§7.8, §8.3, §8.4, §9.1–§9.4,
§10.2–§10.4, §11.4, §13.4, §14.1–§14.3, §16 (`19-LS.10`–`19-LS.16`); audit §6 (the LS.0 sketch this phase
decides), §11 `LS.10`, decisions D4/D7/D12, gaps G2/G3/G6; compatibility `docs/compatibility/lead-score.md`
§2.1–§2.4, §4.1–§4.4, §5.2–§5.5, §7 (U3/U5/U6).

**Exit criterion (plan §16):** *the conversion state machine, the mapping policy and failure recovery are
documented before conversion behavior is written.* This document is that contract. **It contains no code and
changes no schema**: every statement below is either a fact read from this repository (cited) or a decision
`19-LS.11`–`19-LS.16` must implement. Where a decision requires a metadata or permission change, the change is
named in §13 as that later phase's obligation, not applied here — LS.13 is the phase that writes conversion
behavior, and a half-applied schema edit is exactly the "conversion behavior written before it is designed"
this phase exists to prevent.

Two things in the LS.0 sketch turned out to be **factually wrong** about this repository and are corrected here
because later phases would have built on them: see §1.4.

---

## 1. The facts the contract is built on

### 1.1 The conversion surface LS.2 already shipped

| Object | What exists today | Evidence |
| --- | --- | --- |
| `Lead.status` | `New, Assigned, In Process, Converted, Dead`, default `New`. **No status is added**; `Converted` is the only terminal conversion guard | `database/seed-metadata.ts:269-276` |
| Lead result fields | `convertedAt` (datetime), `convertedById`→User, `convertedAccountId`→Account, `convertedContactId`→Contact, `convertedOpportunityId`→Opportunity, `conversionOperationId`→`LeadConversionOperation`; all `inDetail`, all `audited`, **none `inEdit`** | `seed-metadata.ts:325-330` |
| `Converted To` panel | present on the Lead detail layout with exactly those six fields | `seed-metadata.ts:367-372` |
| `Lead.relations` | `{}` — the Lead has no outbound relation to any target; the result is carried by the six attributes above | `seed-metadata.ts:332` |
| `LeadConversionOperation` | a metadata entity: `operationKey` (varchar 128, required), `sourceLeadId` (link, required), `sourceLeadRevision`, `status` (enum, default `previewed`), `requestedTargets` (multiEnum `Contact/Account/Opportunity`), `previewHash`, `mappingVersion`, `selectedMatchIds`, `requestedById/At`, `confirmedAt`, `completedAt`, `createdAccountId`/`linkedAccountId`/`createdContactId`/`linkedContactId`/`createdOpportunityId`/`linkedOpportunityId`, `resultSummary`, `failureCode`, `correlationId`; `removable: false`, `client.web: false`, ACL `create/read/edit/delete: 'no'` | `seed-metadata.ts:5112-5177`, enums `:183-184` |
| Idempotency index | **unique** partial index on `attrs->>'operationKey'` for this entity type (`WHERE … deleted_at IS NULL AND … IS NOT NULL`) | `database/migrations/073_phase19_lead_score.sql:175-179` |
| Recovery index | non-unique `(status, requestedAt)`, which is the scan the recovery view needs | `073_phase19_lead_score.sql:189-191` |
| Write guard | `leadScore.LeadConversionOperationGuard` refuses **every** client create/update/delete — an administrator included — and stays active while the module is disabled; the Lead's six result fields and ten score fields are in `SERVER_OWNED_LEAD_FIELDS` | `apps/api/src/lead-score/lead-score-write-guard.service.ts:96-121`, `lead-score-internal.ts:43,53-70` |
| Gate + capabilities | operations `conversionPreview` (`convertPreview`/feature `conversionPreview`/no write), `conversionExecute` (`convertExecute`/`leadConversion`/writes), `conversionRetry` (`conversionRecover`/`conversionRecovery`/writes); capabilities `duplicateOverride`, `applyFieldChanges`, `conversionAuditRead`, `conversionRecover`; synthetic resources `LeadConversionPreview`, `LeadConversion`, `LeadConversionOverride`, `LeadConversionFieldMerge`, `LeadConversionRecover` | `lead-score-feature-gate.service.ts:101-103`, `lead-score-module.ts:183-224`, `lead-score-domain.ts:31-42` |

So: the storage, the idempotency constraint, the permissions and the refusal of client writes are already in
place. What is missing is **the decision about how they are used**, which is this document.

### 1.2 There is no canonical Contact/Account/Opportunity service — the Entity Engine is the canonical path

Verified negative: no `ContactService`, `AccountService`, `OpportunityService` or any domain service creates
those entities. The only write path is `EntityCrudService` (`apps/api/src/entity/entity.service.ts:104`),
reached over REST (`entity.controller.ts:78,93`) and by the handful of dynamic writers that call it rather
than the store: `advanced-integrations/sync-orchestrator.service.ts:326,432`,
`ai-agents/ai-agent-tools.ts:707` (fields limited to `description`), and
`marketing-automation/marketing-journey-action.service.ts:216` (likewise `description` only). The three raw
`insert into entity_records` statements in the repo (`project-guard.service.ts:446`,
`marketing-journey-runtime.service.ts:71,337`) touch none of them.

**Consequence (plan §4.4):** the conversion command calls `EntityCrudService.create/update` for every target
and for the Lead. It gets validation, dynamic logic, field-level ACL (`assertFieldWrites`), the write-guard
hooks, audit and the outbox for free; bypassing it would be a second guard to forget, and it is the reason
§9.2's "conversion cannot elevate permissions" holds without extra code.

### 1.3 The work can be atomic, and the platform already proves it two ways

- `PostgresRecordStore` resolves its connection as `currentTx() ?? this.database.db`
  (`apps/api/src/entity/entity-record.store.ts:145-155`), and the ambient transaction is an
  `AsyncLocalStorage` (`apps/api/src/entity/tx-context.ts:22-32`). `EntityCrudService` itself never opens a
  transaction (`entity.service.ts:370-372`), so a caller that wraps it in `runInTransaction` puts every entity
  write — including `Contact`, `Account`, `Opportunity` and the Lead — on one connection, in one commit.
- Prior art with exactly that shape: `projects/project-clone.service.ts:66-190` (six entity types created plus a
  back-reference update to the parent in one transaction) and `service-desk/case-merge.service.ts:100-121`
  (update + create + `dispatchMany(tx)`).
- Audit rows and outbox events follow the caller's transaction too
  (`apps/api/src/audit/audit-hooks.ts:134` `const tx = args.tx ?? this.database.db`;
  `apps/api/src/events/event-bus.ts:25-36` → `common/outbox.service.ts:14`). LS.5 and LS.9 already rely on
  this (`lead-score-calculation.service.ts:196-248`, `lead-score-threshold.service.ts:76-170`).
- Optimistic concurrency is enforced at three points (`entity.service.ts:233-236`,
  `packages/entity-engine/src/entity-manager/index.ts:169-171`, and the conditional write
  `entity-record.store.ts:207-214` → `ConcurrencyConflictError` = `CONCURRENCY_CONFLICT`, HTTP 409:
  `packages/core/src/errors/index.ts:50-54`), and row locks are an established tool in this codebase
  (`service-desk/case-assignment.service.ts:459-464`, `sales/document/numbering.service.ts:142`,
  `sales/payments/balance.service.ts:68`).

**Consequence:** the state machine in §3 is **not** a compensation mechanism for a database that cannot do the
job. It exists because plan §11.4 and §14.3 ask a client and an administrator to be able to *look something up*
after a lost response, and because a claim that is a unique-index insert is the only double-click guard that
does not have a race in it.

### 1.4 Two corrections to the LS.0 audit

The audit and `docs/compatibility/lead-score.md` §7 (U3, G3) state that **no phone-normalization facility
exists** and that LS.11 must therefore write one. That is no longer true:
`apps/api/src/voice-communications/phone-number.ts` provides `normalizePhone(input, defaultRegion)` returning
`{valid, e164, nationalDigits, internationalDigits, callingCode}` (`:141,178-185`), `phoneMatchKeys` (`:201-208`),
and a swappable `ConservativePhoneNormalizer` / `LibPhoneNumberNormalizer` behind the `PHONE_NORMALIZER` DI
token (`:211-228`, wired at `index.ts:56`) — the latter backed by `libphonenumber-js`, which is a real
dependency of `apps/api` (`apps/api/package.json:45`), so the audit's "no libphonenumber dependency in any
`package.json`" is stale too. `VoiceContactResolverService` already uses it for an **ACL-gated** record lookup
by phone, counting matches the caller cannot see (`voice-contact-resolver.service.ts:101-167`, SQL at
`:147-154`). LS.11 must reuse this seam (§9.2) rather than add a second normalizer.

One caveat the audit's sentence would have caused: `normalizePhone(input, defaultRegion = "US")` only produces a
meaningful `e164` for a number written with `+` or `00`; a national form like `0912…` gets the *default*
region's calling code prepended (`phone-number.ts:141-166`), and a Lead has no country field to correct it with
(`Account.billingAddressCountry` exists at `seed-metadata.ts:204`, but an Account may not exist yet). §9.1's
stage-2 rule is therefore built on `phoneMatchKeys` — the international **and** national digit forms a stored
value might take (`phone-number.ts:201-208`) — and does not claim E.164 accuracy, which is what U3 already
promised.

Second: `database/migrations/008_phase12.sql:8-22` installs `pg_trgm` and creates attribute expression indexes
for `firstName`, `lastName`, **`'email'`** and **`'phone'`** — and the last two are not field names in this
schema (`Contact`/`Lead` use `emailAddress` and `phoneNumber`). Those two index expressions therefore cover
nothing. LS.11 must not assume a usable trigram index for fuzzy suggestions, and LS.18's query check owns
whether one is worth adding. §9.4's bounded suggestion rule follows from this.

Everything else the LS.0 audit found negative is still negative and is quoted where it constrains a decision:
no B2B/B2C mode (`docs/implementation/lead-score-audit.md:63`, re-verified — the only `accountEnabled` hits are
voice-provider flags), no unique index on any email/phone/name, no domain extraction from a URL or address
anywhere, no `similarity()`/Levenshtein use, and no per-record custom action path on the generic entity
controller (`entity.controller.ts:24-98` — only `massUpdate`, `massDelete`, `rowActions`, `restore`, relation
routes and CRUD), which is why every LS command lives under `/api/v1/LeadScore/action/…`.

---

## 2. Command surface and route shape

`docs/compatibility/lead-score.md:29-30` records the plan's literal paths
(`/api/v1/leads/:leadId/conversion-preview`, `/convert`) as **semantics**. LS.5 already deviated for the same
reason LS.13 must: there is no per-record action route in the kernel, the module's commands are all
`LeadScore/action/…`, and a Lead-scoped path would need a second controller with the same gate. Decided:

| Plan path (semantics) | This build (LS.12/LS.13 implement) | Why |
| --- | --- | --- |
| `POST /leads/:leadId/conversion-preview` | `POST /api/v1/LeadScore/action/conversion/preview` with `{leadId, …}` in the body | LS.5's `action/score/recalculate` precedent; one controller, one gate, one OpenAPI surface |
| `POST /leads/:leadId/convert` | `POST /api/v1/LeadScore/action/conversion/convert` | as above |
| `GET /lead-score/conversion-operations/:operationId` | `GET /api/v1/LeadScore/action/conversion/operations/:operationId` | module-scoped read; the record API stays closed (§13.1) |
| `POST /lead-score/conversion-operations/:operationId/retry` | `POST /api/v1/LeadScore/action/conversion/operations/:operationId/retry` | recovery is an explicit act, never an implicit re-execution |
| (recovery list) | `GET /api/v1/LeadScore/action/conversion/operations?status=&staleAfterMinutes=&limit=` | the ESignature operations pattern (§11.3) |

`leadId`, never `id`, in every request body, matching LS.5/LS.6. Every route is gated by its operation
(`conversionPreview` / `conversionExecute` / `conversionRetry`), which applies the refusal order capability →
module switch → `pendingPhase` → feature (`lead-score-feature-gate.service.ts:155-186`).

---

## 3. The operation state machine

### 3.1 States (five, and `previewed` is retired)

`CONVERSION_STATUSES` is seeded with `previewed, processing, succeeded, failed_retryable, failed_final,
needs_review` (`seed-metadata.ts:183`, `lead-score-vocabulary.ts:222-223`, asserted in
`apps/api/test/lead-score-schema.test.ts:377`).

**Decision: `previewed` is removed** and the metadata default becomes `processing` (§13.2). The reason is the
plan's own rule: a preview must write nothing (§8.3 "Side effects: none; no record writes", and LS.12's exit
criterion "preview is side-effect-free"). Therefore no code path may legitimately create a row in
`previewed`, and a status nobody can reach is worse than no status: it invites an implementation to invent a
use for it, and it makes the recovery view's "states that need a human" list a guess. The alternative — making
the preview durable — is rejected for the same reason.

### 3.2 Transitions

| From | To | Driven by | Guard that must hold | Writable evidence |
| --- | --- | --- | --- | --- |
| — | `processing` | T1 (claim) | gate admitted; actor may read the Lead; Lead not `Converted`; `previewHash` matches; every target enabled and permitted | `operationKey`, `sourceLeadId`, `sourceLeadRevision`, `requestedTargets`, `previewHash`, `mappingVersion`, `selectedMatchIds`, `requestedById`, `requestedAt`, `confirmedAt`, `correlationId` |
| `processing` | `succeeded` | T2 (work) — the same transaction as every target write | Account/Contact/(Opportunity) created or linked exactly as claimed; Lead re-read under lock, still not `Converted`, revision still as claimed | `createdAccountId`/`linkedAccountId`/`createdContactId`/`linkedContactId`/(Opportunity pair), `resultSummary`, `completedAt` |
| `processing` | `failed_final` | T3 (settle) | the failure is deterministic — validation, ACL, a disabled target, the Lead already converted, a stale revision | `failureCode` (a token from §12's closed list), `completedAt`, `resultSummary` with counts only |
| `processing` | `failed_retryable` | T3 | the failure is transient — serialisation/deadlock, connection loss, a store error with no side effect committed | `failureCode`, `completedAt` |
| `processing` | `needs_review` | T3, or the recovery scan (§11) | evidence is incomplete: the row is committed, no final status arrived, and the scan cannot prove that zero targets exist | `failureCode: 'interrupted'`, `resultSummary` naming what could not be established |
| `needs_review` | `processing` | `…/operations/:id/retry` (`conversionRecover`) | §10.3's accounting rule: every target the row already names still exists and is accounted for | a new `confirmedAt`; the row keeps its `operationKey` |
| `needs_review` | `failed_final` | an explicit administrator decision | the operator states that no retry should happen | `failureCode`, `resultSummary.decision` |
| `succeeded` / `failed_final` | *(nothing)* | — | terminal. No transition leaves either state, ever | — |

There is no legal path back to a non-terminal state from `succeeded`: **a conversion is never reversed by this
module** (§10.5, U5).

### 3.3 Commit choreography

```
T1  claim         runInTransaction: insert row (status 'processing'); commit.
                  The unique index on operationKey IS the claim: a duplicate
                  insert is the answer to a double click, not a check-then-write race.
T2  work          runInTransaction:
                    1. SELECT … FOR UPDATE the Lead row (lock first, write nothing before it)
                    2. re-read Lead status + revision + the actor's Lead read ACL
                    3. create/link Account → create Contact with accountId → (optional) Opportunity
                       every one through EntityCrudService under the actor's scope
                    4. update the Lead: status 'Converted', convertedAt/ById, the three target
                       references, conversionOperationId (internal marker for the LS.2 guard)
                    5. update the row to 'succeeded' with the created/linked ids + resultSummary
                    6. EventBus.dispatch(tx, 'lead.conversionSucceeded.v1')
                  commit — all of it or none of it.
T3  settle        separate transaction, only when T2 refused: update the row to
                  failed_final | failed_retryable | needs_review + failureCode, and dispatch
                  lead.conversionFailed.v1 only for the terminal and review outcomes.
```

Decided consequences:

- **A committed `processing` row means the process died between T1 and T2, or inside T2 before its commit.**
  Either way no target exists, because T2 is one transaction. The recovery scan may therefore settle it to
  `failed_retryable` **without touching a record** — but only after the §10.3 existence check, because "should
  be impossible" is not a proof.
- **T1's insert is the only write that happens outside T2.** If T1 fails, nothing happened and the caller may
  retry with a fresh key. If T1 succeeds and the request then dies, the client's correct move is the plan
  §11.4 one: look the key up, do not issue a new conversion.
- The Lead's result fields are written under `runAsLeadScoreInternal` (LS.2's marker) so the field guard
  distinguishes the command from a caller (`lead-score-internal.ts:22-27`), while the *ACL* still belongs to
  the actor (§13.1) — the conversion runs as the person who clicked, never as `system`. LS.6's service
  principal is for background work; this is a user act whose permissions are the user's (plan §9.2).
- **No side effect may be placed between T1 and T2 that cannot be re-run**: no mail, no webhook, no provider
  call (plan §7.5, §14.3). The only thing in that window is the row.

### 3.4 What each committed state means to a reader

| State | Means | Safe next action |
| --- | --- | --- |
| `processing` | an attempt exists; nothing about targets is knowable from the row alone | wait, or re-check the Lead's `conversionOperationId` |
| `succeeded` | the Lead is `Converted` and the ids named in the row are what it points at | none |
| `failed_final` | nothing was created or linked; the answer will be the same forever | fix the data/permission, then convert with a new key |
| `failed_retryable` | nothing was created or linked; the cause was transient | retry the same key (`conversionRecover`) |
| `needs_review` | the module cannot prove what exists; a human must look | the §10.3 accounting, then retry or close |

---

## 4. Idempotency, replay and concurrency

### 4.1 The key

- Scope: the unique index is installation-wide for the entity type (`073_phase19_lead_score.sql:175-179`),
  which matches ESignature's `send_attempt_id` (`064_phase19_esignature.sql:181-182`) and Marketing
  Automation's `MarketingSendTransition.idempotencyKey` (`041_…:53-57`). There is no tenant column to scope
  by, and adding one would be inventing a tenancy model this build does not have.
- Format: 8–128 characters, caller-generated (UUID recommended), **never derived from the Lead id, the actor
  id or the timestamp** — a derived key would collide across two people converting the same Lead and turn a
  concurrency answer into a false "replay".
- A key collision with a row the caller may not see is a **conflict, not a read**: `409
  LEADSCORE_CONVERSION_CONFLICT` with `details {leadId}` only. It never echoes the other row's status,
  target ids or actor (§12, plan §8.4 "do not include … unnecessary PII").

### 4.2 Replay and refusal answers

| Situation | Answer | Records |
| --- | --- | --- |
| same `operationKey`, row `succeeded` | `200` with the stored result (created/linked ids, Lead status, `resultSummary`) | nothing new — zero inserts, zero updates, zero events |
| same `operationKey`, row `processing` | `409 LEADSCORE_CONVERSION_IN_FLIGHT` + a `Retry-After` header | nothing |
| same `operationKey`, row `failed_final` | `409` carrying the stored `failureCode`; refused, **not** re-run | nothing |
| same `operationKey`, row `failed_retryable` or `needs_review` | `409 LEADSCORE_CONVERSION_NEEDS_RECOVERY` pointing at the retry route | nothing — a retry is an explicit act behind `conversionRecover`, never an implicit re-execution of a key |
| different key, Lead `status = 'Converted'` **or** a non-empty `conversionOperationId` | `409 LEADSCORE_ALREADY_CONVERTED`, `details {leadId, convertedAt}` and `operationId` only when the caller may read operations | a `failed_final` row recording the attempt |
| different key, same Lead, both in flight at once | one wins (row lock in T2); the loser re-reads, sees `Converted`, settles itself `failed_final` / `failureCode: 'already_converted'` | its own row; no targets |
| `previewHash` no longer recomputes | `409 LEADSCORE_PREVIEW_STALE` + which component moved (revision, mapping version, target availability, **the actor's own visible-field set**) and no values | nothing |
| actor lacks `Contact:create` but holds `Contact:read` and a candidate exists | **not** downgraded to a link of that candidate for the create the user asked for; refused `AUTHORIZATION_DENIED` | a `failed_final` row |

The last row is the general rule: **a conversion is never partially repaired.** Plan §3.5's
"never create an invalid partial combination due to a hidden frontend condition" has a server-side half, and
it is this — an unmet choice is an error, not a substitution.

### 4.3 Concurrency, decided

The Lead row lock (`FOR UPDATE`) inside T2 is the primary guard, because the optimistic `version` check alone
answers with a 409 that the client cannot distinguish from "your data was wrong". The version check stays as
the second line: it is what `EntityCrudService` does anyway (`entity.service.ts:233-236`), and it catches a
Lead changed by something that did not take the lock.

Plan §13.4-10 ("two concurrent attempts cannot convert the same Lead twice") is therefore satisfied by a lock
plus a state re-read, and §13.4-9 ("repeating the same key returns the original result") by the unique index
plus the stored row.

---

## 5. Valid target combinations

### 5.1 The matrix

`requestedTargets` is a multiEnum of `Contact / Account / Opportunity` (`seed-metadata.ts:184`); the wizard's
choices are expressed as **one create-or-link decision per type**, and the row's separate
`created*Id`/`linked*Id` columns are what makes "Created versus Linked" (§11.4, LS.14) a fact rather than an
inference.

| # | Combination | Requires (ACL, actor scope) | Requires (data) | Settings gate |
| --- | --- | --- | --- | --- |
| 1 | create Contact | `Contact:create` | `lastName` non-empty after mapping — Contact requires `name` **and** `lastName` (`seed-metadata.ts:232-234`; verified: a create without `lastName` answers `422 VALIDATION_FAILED {lastName: "Field is required."}`) | `Contact ∈ targets` |
| 2 | link Contact | `Contact:read` (+ `edit` if any field will be written on it, §6.2) | the id exists and passes `canAccessRecord` | `Contact ∈ targets` |
| 3 | create Account | `Account:create` | `name` non-empty — Account requires `name` (`:196`), and the only source for it is `Lead.company` | `Account ∈ targets` |
| 4 | link Account | `Account:read` | as 2 | `Account ∈ targets` |
| 5 | Account + Contact, Contact linked to it | 1 or 3 + 2 or 4 | + the Contact's `accountId` is set to the chosen Account | both enabled |
| 6 | Contact + existing Account | 1 or 2 + 4 | the Account exists and is readable; if the Contact already belongs to a *different* Account, §6.3 applies | both enabled |
| 7 | existing Contact + existing Account | 2 + 4 | explicit user confirmation of the pairing | both enabled |
| 8 | any of 1–7 ± Opportunity | `Opportunity:create`/`read` | Opportunity requires `name` (`:390`) which no Lead field supplies → `createDefaults` (§7.4) | `Opportunity ∈ targets` **and** `features.opportunityConversion` |

Two things the matrix deliberately does not encode:

- **A prohibition on Account-only conversion.** Plan §3.5 allows "a new Account without a Contact, if business
  rules allow an organization-only Lead", and this build has no business rule that forbids it — so row 3 stands
  on its data gate alone: an Account whose `name` would come from an empty `Lead.company` is a required-field
  refusal, not a policy one. That distinction matters to the wizard, because one of the two has a fix the user
  can make (type the company) and the other does not.
- **More than one target of a type.** One create-or-link decision per type, because the row has exactly one
  `created*Id`/`linked*Id` pair per type (`seed-metadata.ts:5139-5144`). Two Contacts in one operation is not a
  combination LS.10 is being asked to permit; it is a change to that schema and to the wizard (§13.6).

`Opportunity` links through `accountId` (`:405`) and `contactIds` (linkMultiple, `:406`). Decided: the command
**always** sets `accountId` to the operation's Account (created or linked) and **appends** the Contact into
`contactIds` rather than replacing the list — replacing it would silently remove other people from a deal the
actor may not even be able to read.

### 5.2 B2B/B2C

No global mode exists (§1.4), and plan §7.7 forbids inventing one. The decided control is exactly what
`docs/compatibility/lead-score.md:54-67` §2.1 promised, now made concrete as a settings key LS.13 must add:

```
conversion: {
  targets: string[]                     // subset of CONVERSION_TARGETS, default all three,
                                        // deduplicated, refusing an unknown value AND refusing []
  fieldMergeAllowed: boolean            // default false — see §7.5
  mapping: { … per target entity … }    // §7.1
}
```

- `targets` is the *only* B2B/B2C surface. An installation that wants EspoCRM's B2C effect removes `Account`.
  This build therefore does not reproduce upstream's B2C switch; it reproduces the effect through a
  module-owned setting, which stays the documented deviation (§2.1).
- An empty list is refused (`422 VALIDATION_FAILED {section: 'conversion'}`) because disabling conversion
  entirely is `features.leadConversion`'s job; two switches for one decision is how they start disagreeing.
- The **backend** validates the setting independently of the wizard, and a disabled target that appears in a
  request is a refusal (`LEADSCORE_TARGET_DISABLED`), never a silent drop (§4.2's no-repair rule).
- The setting is read at command time, not cached per request beyond the existing settings-document cache, so
  turning `Account` off stops the next conversion immediately and changes nothing about the ones already
  recorded (§10.4).

---

## 6. Linking policy

### 6.1 What "link" means here

A link is *a reference the Lead records*, nothing more: `convertedContactId` / `convertedAccountId` /
`convertedOpportunityId` and `conversionOperationId` on the Lead. The target is not mutated, not re-parented,
not re-assigned, and its `assignedUserId`/`teams` are never touched by a link (§7.6). This distinction is what
makes row 2/4's ACL requirement `read` and not `edit`.

### 6.2 When a link does write to the target

Only three cases, and each needs `edit` on that record (checked by `canAccessRecord`,
`apps/api/src/acl/acl-api.service.ts:232-247`, plus `assertFieldWrites` at `:172` inside the canonical path):

1. `Contact.accountId` set as part of combination 5/6/7 (the relation carrier, `seed-metadata.ts:238`);
2. `Opportunity.accountId` / `contactIds` (§5.1);
3. an explicit field merge on an existing target (§7.5).

A request that asks for #1 on a Contact whose `accountId` is already set to a **different** Account is a
re-parent and goes through §6.3, not through this list's silence.

### 6.3 Re-parenting

`Contact.accountId` already non-empty and different from the chosen Account:

- default answer: **refuse** (`LEADSCORE_CONVERSION_REPARENT_REQUIRED`) and make the user choose again;
- allowed only when the request carries an explicit re-parent decision, the preview named it
  (`confirmationType: 'contact_reparent'`), the actor holds `applyFieldChanges`, the installation allows field
  merge (`conversion.fieldMergeAllowed`), and the before/after pair is written into the target's own audit row
  — which the canonical path does automatically (`audit/audit-hooks.ts:134`), so the diff is not a
  conversion-specific log line.

Re-parenting is the clearest case in the whole feature of "the user must see it": it changes who else can reach
that person's record through `Account.relations.contacts` (`seed-metadata.ts:206-217`), so it is treated as
broadening access (§10.2), not as a field write.

### 6.4 Candidates and links must be re-checked inside the transaction

The preview may say "candidate X, match reason email". Inside T2, X is re-read: it must still exist, still be
of the expected entity type, and still pass the actor's read ACL. Two cases matter, and both answer with a
recorded refusal rather than a substitution: (a) a candidate deleted between preview and confirm is
`failed_final` with `failureCode: 'target_missing'` — the command does not create instead; (b) a candidate that
has become unreadable is `failed_final` with `forbidden`, and the refusal does not confirm anything about the
record beyond the fact that the request the *caller* made cannot be honoured.

---

## 7. Field mapping policy

### 7.1 Where the mapping lives, and what it looks like

Decision (plan §5.7 allows static or versioned; the repository's convention is a settings document, and LS.1
already owns `leadScore`): **inside the `leadScore` settings row**, under `conversion.mapping`, versioned per
target entity. No new entity, no new migration, and the strict `.strip()`/`.strict()` behaviour of
`LeadScoreSettingsSchema` (`lead-score-settings.service.ts:108-124`) means an unvalidated key cannot smuggle
itself in.

```
conversion.mapping = {
  Contact:     { version: 1, fields: [{ from: 'lastName', to: 'lastName' }, …], createDefaults: { … } },
  Account:     { version: 1, fields: […], createDefaults: { … } },
  Opportunity: { version: 1, fields: […], createDefaults: { name: '<composed template>' } },
}
```

Rules:
- `from` must exist on `Lead`, `to` must exist on that target, both must pass §7.3's type matrix, and `to` must
  not be a server-owned or protected field. Validated **on settings write** (LS.12) so a broken map never
  reaches a conversion, exactly the way `settings.scoring.activeModelId` is validated on read rather than
  trusted (`docs/implementation/lead-score-audit.md` §5.1 lesson) — with one difference: an invalid map is a
  refusal (`422`), not a warning, because mapping mistakes write records.
- `version` is a monotonic integer the operator raises when they change the map; the operation row stores it in
  `mappingVersion`, and the `previewHash` includes it, so **editing a map invalidates outstanding previews and
  never mutates a past conversion** (plan §5.7's last bullet).
- The `name`/`description`/`createdAt`… of the operation row itself: `name` is composed by the module as
  `Convert <Lead display name>` and is a label, not data (the entity has `displayField: 'name'`,
  `seed-metadata.ts:5171`).

### 7.2 `name` is derived by the kernel — and that changes the default map

`EntityCrudService.withName` mirrors `name` from the entity's metadata display field
(`apps/api/src/entity/entity.service.ts:509-519`), and the display field is `lastName` for both Lead and
Contact (`seed-metadata.ts:377`, `:247`) and `name` for Account/Opportunity. Verified against the running API:
a Contact created with `{firstName:'Agent', lastName:'AGENT_TEST_LS10 last'}` came back with
`name: 'AGENT_TEST_LS10 last'`; the same payload without `lastName` is a `422`.

Consequences written into the default map:
- **`Lead.name → Contact.name` is not in the map** and `docs/compatibility/lead-score.md` §5.2's row for it is
  corrected in §13.4. Mapping a value the kernel re-derives is at best a no-op and at worst a way to store a
  company name in a person's `name` while `lastName` says something else.
- The person identity a conversion can build is `firstName` + `lastName`; a Lead with only a company and a
  `firstName` **cannot** produce a Contact, and the preview must say so as a required-field problem before the
  user confirms (plan §7.1 step 4).
- `Account.name` legitimately comes from `Lead.company` — Account's display field *is* `name`, so no mirroring
  fights it.

### 7.3 Type compatibility

Value types come from `packages/entity-engine/src/validation/index.ts` (the `email` type is a single string
with a regex, `phone` is only "must be a string", `:33-40`), and none of `emailAddress`/`phoneNumber` is a
multi-value field. The allowed set, per pair:

| Source (Lead) → target | Allowed when |
| --- | --- |
| `varchar` → `varchar`, `text`, `url`, `email`, `phone` | widening text; the target's own validation then decides (`email` must look like an address) |
| `text` → `varchar` | refused: a `description` cannot be squeezed into a 128-char name |
| `enum`/`varchar` → `enum` | only with an explicit `valueMap` in the mapping entry; no implicit case-folding or translation |
| `datetime` → `datetime`, `date` → `date` | same kind only; `datetime → date` refused (a lossy conversion the user would not see) |
| `int`/`float`/`currency` | numeric to numeric; `currency` requires the target's `currency` companion to be settable or defaulted |
| `link` → `link` | only when both point at the same entity type |
| `linkMultiple`/`multiEnum` | only to the identical shape, never from a single value |
| `password`, `file`, `attachment`/`attachmentMultiple`, `jsonArray`/`object` | **never mappable** — a policy rule, not a type accident |

Never mapped, whatever the types (plan §5.7, §9.3, and LS.3's existing denylist in
`apps/api/src/lead-score/lead-score-condition.ts` `PROTECTED_FIELD_NAMES`): credentials and API secrets,
consent evidence, the Lead's own `score*`/`converted*`/`conversionOperationId` (server-owned — the guard
refuses them for a client and the command has no reason to copy them), the protected-characteristic fields the
validator already refuses as rule inputs, `id`/`createdAt`/`modifiedAt`/`createdById`/`modifiedById`/
`deletedAt`, and any target field the actor cannot write (§1.2: the canonical path enforces this, the map must
not *appear* to allow it).

### 7.4 `createDefaults`

Only for a target-required field no source supplies, today exactly one: `Opportunity.name`. The template is
composed from the Lead's own display values (`<Lead.lastName> — <Lead.company>`, trimmed) and the wizard may
edit it; if it resolves empty, that is a required-field refusal in the preview. Nothing else gets an implicit
default: `Contact.status` already has `defaultValue: 'Active'` in metadata (`seed-metadata.ts:240`) and
`Opportunity.stage` defaults to `Qualification` (`:397`) — the kernel supplies those, not the map.

### 7.5 Existing-target policy: `skip`, and merge is a triple lock

- **`skip` is the only behaviour this build implements**: a non-empty field on a linked target is never
  overwritten by a mapped value (plan §7.4). The skipped target is reported by name and reason in the preview.
- A merge (write the source value over a non-empty target value) requires all three: `conversion.fieldMergeAllowed`
  is true (installation policy), the actor holds `applyFieldChanges` (the capability whose own description
  says "Off by default policy (plan §7.4)" — `lead-score-module.ts:204-210`), and the request carries the
  explicit per-field decision that was inside the confirmed `previewHash`.
- The before/after diff lives in the platform's `audit_log` for the target's update (written by the canonical
  path in the same transaction), and the operation's `resultSummary` names the merged fields. There is no
  second conversion-specific diff table.

### 7.6 Assignment and teams are not data

`assignedUserId` and `teams` are **not** mapped from the Lead (this replaces `docs/compatibility/lead-score.md`
§5.2's "carried as create defaults through the canonical service" row, §13.4). They are an ownership decision:
the command may set `assignedUserId` only from an explicit request value the actor may assign to, and `teams`
only from an explicit choice among teams the actor belongs to. Copying a Lead's team list onto a new Contact
would silently widen who can read a person record — the opposite of plan §7.5/§14.3's preservation rule.

### 7.7 Every skipped or blocked value is named

The preview output carries, per target: `mapped` (source→target pairs that will be written), `skipped`
(each with a reason code from a closed list — `target_has_value`, `field_not_writable`,
`field_type_incompatible`, `field_not_mappable_policy`, `no_such_target_field`, `value_invalid`), `required`
(target-required fields still empty after mapping), and `notCopied` for the deliberate non-mappings
(consent, files, credentials, assignment). A field silently absent from a preview is the failure mode plan
§11.4 names, so this list is part of the hash, not decoration.

---

## 8. Preview contract

### 8.1 Input

`{leadId, targets: [{type, action: 'create'|'link', existingId?}], fieldMerge?: [{target, field, value}],
reparent?: {contactId, accountId}, opportunity?: {…}, mappingVersion?, expectedLeadRevision?, acknowledged?:
[confirmationType]}`.

`mappingVersion` is optional: the server uses the current version and a client that pins an older one gets
`LEADSCORE_PREVIEW_STALE` rather than a surprise map.

### 8.2 Output

`{leadId, leadRevision, mappingVersions, targets (resolved per target: create/link + the fields as §7.7),
duplicates (candidates + `hiddenMatches` count only), required (blocking list), confirmationTypes,
permission ({canConvert, reasons}), previewHash, expiresNote}`.

`permission.reasons` uses the same reason tokens as §12's error list, so the wizard's disabled button and the
command's refusal are the same fact stated twice, once early (plan §9.2: the UI is never the boundary).

### 8.3 `previewHash`

`sha256` over a canonical, key-sorted JSON of:

```
{ leadId, leadRevision,
  targets:        [{type, action, existingId?}…] sorted by type,
  mappingVersions:{Contact:n, Account:n, Opportunity:n},
  fieldMerge:     [{target, field, value}…] sorted,
  reparent:       {contactId, accountId} | null,
  duplicateChoice:{type: selectedExistingId|null}…,
  readerScope:    [the sorted list of target fields the actor could read AND write at preview time] }
```

Two decisions worth stating because they are security properties, not hashing detail:

- `readerScope` is included, so **a preview taken while the actor could see a field cannot be executed after
  that field is hidden from them.** Without it, a permission change mid-flow would let the confirmed preview
  write values the actor can no longer read — the covert-elevation path plan §9.2 closes.
- `leadRevision` is `entity_records.version` (`packages/entity-engine/src/entity-manager/index.ts:122-125`).
  It is safe here and only here: unlike LS.5's *staleness* question, the score write that moves a Lead's
  version has not happened yet, and the Lead being edited between preview and confirm is precisely the case
  that must be caught.

The hash is recomputed inside the command over the request's own claims; a mismatch refuses with the component
that moved and never with the values.

### 8.4 `confirmationTypes`

| Type | Raised when | The wizard must say |
| --- | --- | --- |
| `simple` | nothing below applies | what will be created/linked |
| `duplicates_present` | any stage produced a candidate, or `hiddenMatches > 0` | which candidates, and that some matches are not visible to them |
| `values_will_be_skipped` | any `skipped` entry, or any `required` gap the user filled by hand | what is not copied and why |
| `field_merge` | any explicit merge | before/after per field |
| `contact_reparent` | §6.3 | that another person's records may become reachable and the Contact leaves its current Account |
| `opportunity_created` | an Opportunity will be created | its defaulted name and stage |

The convert request must acknowledge **exactly** the set the current preview computes; acknowledging fewer is
`LEADSCORE_PREVIEW_STALE` (the set moved) and more is a validation error. This is the mechanism that makes
"the preview faithfully describes the operation that would run" (LS.12's exit criterion) enforceable rather than
aspirational.

### 8.5 The preview writes nothing

Zero side effects, asserted the way LS.4 and LS.8 assert it: record counts before and after for
`entity_records`/`audit_log`/`outbox_events`/`jobs`, and the Lead's `version` **and** `modifiedAt` unchanged
(`docs/implementation/lead-score-ls4-completion-report.md`, `…ls8…`). It may read: the Lead, the target
metadata, the mapping, and a **bounded** duplicate scan (§9). It may not enqueue, dispatch, notify, or call any
provider.

---

## 9. Duplicate policy (what LS.11 must implement, and what it must not)

### 9.1 Stages, with the source of each normalizer

| Stage | Comparison | Classifies as | Reuses |
| --- | --- | --- | --- |
| 1 | exact normalized email | `same person` | `normalizeEmailAddress` = `trim().toLowerCase()` (`marketing-automation/marketing-automation-domain.ts:1385-1387`) |
| 2 | exact phone on match keys | `same person` | `phoneMatchKeys` / `normalizePhone(…).internationalDigits` (`voice-communications/phone-number.ts:141,201-208`) |
| 3 | exact Account `website` host | `same organization` | new `domainOf()` inside the module (§9.3) |
| 4 | exact normalized `company` / Account `name` | `same organization` | stage-1 string rule |
| 5 | name similarity | **suggestion only** | §9.4 |

- Stage 1 must not use MA's `emailHash` (`marketing-identity.ts:38-48`) as a join key: that HMAC identity is
  **consent** identity, keyed to a purpose/channel, and matching a Lead to a Contact through it would silently
  import a consent decision into a sales decision — the exact confusion §2.4/§10.4 forbids.
- Stage 2 takes **no** installation region and makes no E.164 claim. It compares
  `phoneMatchKeys(normalizePhone(value))` — the international *and* national digit forms a stored value might
  take (`phone-number.ts:201-208`) — against the same digit-normalized form of the stored
  `Contact.phoneNumber` / `Account.phoneNumber` / `Lead.phoneNumber`, which is what the Voice resolver does
  (`regexp_replace(coalesce(attrs->>'phoneNumber',''),'[^0-9]','','g') IN (keys)`,
  `voice-contact-resolver.service.ts:147-154`). The accepted cost is a cross-country digit collision: it can
  only ever produce a **candidate for a human**, never a link, so the worst case is one wasted click. The
  alternative — requiring a region no Lead carries (§1.4) — would silently mis-normalize every national-form
  number instead.
- Every stage is exact-or-nothing. Nothing before stage 5 can produce a link.

### 9.2 ACL comes first, and invisibility is counted, not described

Candidates are produced from a query that applies `AclApiService.recordPredicate(entity, 'read')`
(`apps/api/src/acl/acl-api.service.ts:192-216`, store side `entity-record.store.ts:686-691`) and then
`canAccessRecord` + `stripRestricted` per row. The response may contain: the candidates the actor may read,
their names/reasons and the minimum fields needed to decide, and one integer `hiddenMatches` — the number of
matches they may not see. It may never contain a hidden record's id, name, or any field. `hiddenMatches` is
precedent, not invention: `VoiceContactResolverService` already counts exactly this
(`apps/api/src/voice-communications/voice-contact-resolver.service.ts:101-167`).

An `email` field hidden from the actor by field-level ACL additionally suppresses stage 1 for *that* record
(they cannot be shown why it matched), so the stages are evaluated per-candidate against the fields the actor
may read, the same three-state discipline LS.4 established for scoring inputs.

### 9.3 Domain extraction is a module-owned helper, with a hard-coded non-organizational set

Nothing in the repository derives a domain from a URL or an address (§1.4), so LS.11 adds
`domainOf(input: urlOrEmail)` to the LeadScore module: lowercase, host only, strip a leading `www.`, drop
userinfo/port/path, refuse an IP literal and an empty host, and treat the domains in a named
`FREE_MAIL_DOMAINS` vocabulary constant as **never** an organization signal. The list lives in the module's
vocabulary file (so LS.18 can review it as data, and the tests can assert it), and the contract only requires
that free mail cannot make two records "same organization".

### 9.4 Fuzzy is bounded or absent

`pg_trgm` is installed but its attribute indexes are wrong for this schema (§1.4), so LS.11 may use
`similarity()` **only** over an explicitly bounded candidate set (the Account names matching the Lead's company
prefix, `LIMIT` bounded by a module constant) and only as a suggestion. If that cannot be bounded to an
indexed path, LS.11 ships without fuzzy at all — a missing suggestion is a smaller failure than a full scan of
`entity_records` inside a user-facing preview (plan §14.2 "avoid unbounded fuzzy matching and full-table
scans"). No new GIN index without LS.18's query check.

### 9.5 Decisions, overrides, and what is recorded

The user's options are exactly three: **link** a visible candidate, **create anyway** (needs the
`duplicateOverride` capability, and the operation records the overridden candidate in `selectedMatchIds` +
`resultSummary.duplicateDecision`), or **cancel**. A create-with-override is an audited act, which is why it is
a capability and not a checkbox. Nobody gets an automatic link, an automatic merge, or a silent choice made on
their behalf by "the highest-scoring candidate".

No unique constraint is added on email or phone at any point in LS.11–LS.16 (decision D7): the values are
legitimately shared (households, `info@`, one company's staff), and the current data has no such index
(§1.4 verified).

> **Delivered in 19-LS.11** (`apps/api/src/lead-score/lead-duplicate-resolver.ts`), with three refinements
> this contract's §9.1–§9.4 anticipated but had not sharpened:
>
> 1. **Stage 2's key is the last nine significant digits**, not `phoneMatchKeys`'s exact international/national
>    forms. §1.4 already recorded *why* (a Lead carries no region), and the tail is the form that survives
>    `+84 912 345 678`, `0912 345 678` and `(091) 234-5678` at once; the documented collision cost — two
>    numbers in different countries sharing a tail — is unchanged and still only produces a candidate.
> 2. **Stage 4 compares the `name` column, not `attrs->>'name'`.** `name` is physical (LS.2), so the attribute
>    form matched nothing; the SQL folds the column with `'[[:space:]]+'` to mirror `normalizedName` exactly.
>    (The same class of mistake in the `label` — a display value read from `attrs` — silently dropped every
>    candidate until the organization test caught it.)
> 3. **§9.4's "bounded or absent" resolved to absent.** No similarity stage ships: the only trigram indexes in
>    this schema key on field names that do not exist (`008_phase12.sql:8-22`), so a suggestion pass would be a
>    full scan; LS.18's query check owns whether an index is worth adding. The contract's own wording allowed
>    this, and it is recorded rather than left implicit.
>
> The request surface is a plan addition, not a deviation: `POST /api/v1/LeadScore/action/conversion/candidates`
> with `{leadId}` (§2's route family, one Lead per call), because a candidate list for a *set* of Leads would be
> a searchable map of who-knows-whom across the database.

---

## 10. Failure, recovery and what never happens

### 10.1 Failure classification

| Cause | Outcome | `failureCode` token | HTTP |
| --- | --- | --- | --- |
| target field missing/invalid (required `lastName`, empty Account `name`, bad email) | `failed_final` | `target_invalid` | `422 VALIDATION_FAILED {entity, field}` — the kernel's own shape, so the wizard's field list behaves like every other form |
| actor lacks create/read/edit on a target | `failed_final` | `forbidden` | `403 AUTHORIZATION_DENIED` |
| target enabled but Lead cannot satisfy it | `failed_final` | `required_value_missing` | `422` |
| Lead converted meanwhile | `failed_final` | `already_converted` | `409 LEADSCORE_ALREADY_CONVERTED` |
| stale preview / unacknowledged confirmation set | nothing written (T1 not reached) | — | `409 LEADSCORE_PREVIEW_STALE` |
| disabled target requested | nothing written | — | `422 LEADSCORE_TARGET_DISABLED` |
| key collision with an unreadable row | nothing written | — | `409 LEADSCORE_CONVERSION_CONFLICT` |
| serialisation failure / deadlock / connection loss | `failed_retryable` | `transient` | `503 LEADSCORE_CONVERSION_RETRYABLE` |
| row committed `processing` with no final state, past the threshold | `needs_review` (by the scan) | `interrupted` | — (recovery view) |
| a target the row names no longer exists | `needs_review` | `target_missing` | — |

`failureCode` is a token from this closed list. Never an exception message, never SQL, never a field value
(plan §8.4; the same rule as LS.5's `errorSummary`).

### 10.2 Retry rules

A retry (`POST …/operations/:id/retry`, `conversionRecover` + `conversionRecovery` feature) may re-run T2 only
when the accounting in §10.3 is clean, and:

- it **never** creates a target the row already names as created — that id is the proof the create committed;
- it **never** clears or overwrites a target that has since been edited by someone else; a merge attempt turns
  into `needs_review`, not into a write;
- it **never** re-links a Lead that is already `Converted` (that path is terminal, §3.2);
- it keeps the same `operationKey` (the retry is of *that* attempt) and records its own `confirmedAt`;
- it is rate-bounded like any other user-facing command (§12.3).

### 10.3 The accounting rule (the one thing that makes recovery safe)

Before any retry, and whenever the scan marks a row `needs_review`, the module reads back the row's own claims:

1. every non-empty `created*Id`/`linked*Id` must exist, be undeleted, and be of the expected entity type;
2. if the row claims success in `resultSummary` but the Lead is not `Converted`, that is `needs_review` — the
   transaction did not do what the row says, and no automated path may "fix" that by writing records;
3. if the Lead **is** `Converted` and points at ids the row does not name, that is `needs_review` too
   (something else converted it);
4. only "row says `processing`, no target ids, Lead not `Converted`" is safe to re-run.

Plan §14.3's "retrying a conversion operation only after verifying that previously created target records are
accounted for" is this list. Rules 2 and 3 exist because LS.2 made the result fields server-owned: nothing but
this command can write them, so a disagreement between the row and the Lead is evidence about the *system*, and
the honest answer to that is a human, not a compensating write.

### 10.4 Post-commit side effects

After T2 commits, `lead.conversionSucceeded.v1` is already in the outbox (it was dispatched inside the
transaction, §3.3), so the "post-commit" surface is the consumers: the worker poller's delivery
(`apps/worker/src/outbox/outbox-poller.ts:18-63` with its own attempts/backoff/dead-letter) and any
Workflow/stream reaction. If a consumer fails, the conversion stays `succeeded` and the delivery is retried by
the outbox's own machinery — **entities are never recreated to "re-send" an event** (plan §7.8).

### 10.5 What conversion never does

- never deletes, un-converts or resets a Lead; never clears `converted*` (that is §11.4's admin procedure and
  currently nobody's);
- never sends mail/SMS/webhook/provider calls (§7.5, and no test may either — plan §13.4-14);
- never copies consent evidence into a Contact, because MA consent is keyed by `emailHash` rather than a record
  id (§9.1; `docs/compatibility/lead-score.md` §4.4) — a converted Contact is **not** a consented Contact;
- never duplicates a file or attachment;
- never moves an activity, note, email or stream item without an explicit, authorized, documented action
  (LS.15 owns that list; the relations that already point at the Lead — `Email.leads`
  (`seed-metadata.ts:62-67`), `Case.leadId` (`:3570`), `MarketingConsent.leadId` (`:4331`),
  `LeadScoreEvaluation.leadId` (`:5044`) — stay pointing at it, and Tasks/Calls/Meetings cannot reference a
  Lead at all (gap G2/U2));
- never auto-converts on a score threshold or a band crossing — LS.9's events may *tell* a workflow, and plan
  §10.4 forbids the workflow from converting;
- never converts in bulk (U6 stays out of scope).

---

## 11. Operations, observability and the recovery screen

### 11.1 Metrics and log lines

Plan §14.1's conversion list, mapped onto what this build can actually emit: structured log lines with the
request/correlation id (`REQUEST_SCOPE_TOKEN`, the way LS.5/LS.9 stamp `correlationId` on the row), plus counts
derivable from the rows themselves — previews taken, confirms refused as stale, operations by state,
`created` vs `linked` counts, idempotency hits, `needs_review` count, and duplicate decisions by kind. Logs
carry **no** field values, no Lead/Contact payload and no candidate identity (plan §14.1, §8.4).

### 11.2 The stuck-row scan

`leadScore.recoverConversionOperations` (worker job, LS.13 owns it, following the LS.9 decay-sweep shape:
settings switch defaulting **off**, bounded `limit`/`chunkSize`, refuses when its feature is off, and the
scan reads the existing `(status, requestedAt)` index — `073_phase19_lead_score.sql:189-191`). It only settles
`processing` rows older than a threshold into `needs_review`/`failed_retryable` after §10.3's accounting. It
**never** creates a record and never re-runs a conversion.

### 11.3 The administrator's view

Pattern: the ESignature operations panel, not the jobs list — the rows are metadata entities, not `jobs`
(`apps/api/src/esignature/signature-operations.repository.ts:98-260` with its stuck-state predicate at
`:218-228`, route `esignature.controller.ts:320`, UI
`apps/web/src/pages/esignature/ESignatureOperationsPanel.tsx:44-70`).

`GET /api/v1/LeadScore/action/conversion/operations?status=&staleAfterMinutes=&limit≤100` → per row:
`operationId`, `leadId` + the Lead's display label (only if the caller may read the Lead), `status`,
`requestedBy` label, `requestedAt`/`confirmedAt`/`completedAt`, `failureCode`, the created/linked id pairs,
and `canRetry`/`canClose` computed exactly as §12.2's `ScoreReadView.actions` did — the server's answer, never
a role-name guess in the client (LS.7's rule). One retry action and one close action, each its own audited
command.

### 11.4 Corrections (U5) — policy now, mechanism has no owner

Plan §7.6 requires reopening/correcting to be a separate, explicit, admin-controlled workflow that accounts
for targets edited or used since. Decided policy:

- a correction is a **new** `LeadConversionOperation` row (there is no `kind` column, and adding one to a
  frozen-by-usage schema is not this phase's call) with its own key, reason and audit trail;
- it may re-point one `converted*` reference to a record the actor may read, or clear one reference; it may not
  delete any target, may not change `Lead.status` to anything other than an explicit user-driven status edit,
  and may not touch a target that has transactions attached (a refusal, not a cascade);
- it requires `conversionRecover` (and a named capability of its own if it ships separately).

**No sub-phase in plan §16 owns this.** LS.10 records it as a gap for the plan owner rather than quietly
building it into LS.13's transaction (§13.6, G9). The consequence of *not* having it is concrete: LS.2 made the
`converted*` fields server-owned for clients, so today an administrator has **no** path at all to fix a wrong
reference — which is exactly the situation the plan's own words (§7.6 "separate explicit admin-controlled
workflow") anticipated and which must be scheduled, not left implicit.

---

## 12. Error codes, capability answers and abuse bounds

### 12.1 Codes to introduce (LS.12/LS.13 add them; the list is closed at nine)

Today `LeadScoreErrorCode` has six members (`lead-score-module.ts:83-89`, built in `lead-score-errors.ts`,
localized in `i18n/{en,vi}/errors.json:32-37`), and **none** of the conversion states plan §8.4 names has a
code (§1.4 verified). Decided additions, all following the house rules — a stable code, machine data in
`details` and never under the key `reason` (which `GlobalExceptionFilter` overwrites), and no echo of an id a
caller may not see:

| Code | HTTP | `details` | Meaning |
| --- | --- | --- | --- |
| `LEADSCORE_ALREADY_CONVERTED` | 409 | `{leadId, convertedAt, operationId?}` | the Lead is already converted. This is the code the compatibility file has been describing in prose as `LEAD_ALREADY_CONVERTED` since LS.0 without anything ever defining it |
| `LEADSCORE_PREVIEW_STALE` | 409 | `{leadId, component}` | the preview no longer recomputes; `component ∈ {revision, mapping, targets, readerScope, confirmation, hash}` |
| `LEADSCORE_DUPLICATE_REVIEW_REQUIRED` | 409 | `{leadId, visibleCandidates, hiddenMatches}` | a decision is required and none was recorded |
| `LEADSCORE_TARGET_DISABLED` | 422 | `{target}` | the requested type is off in `conversion.targets` |
| `LEADSCORE_CONVERSION_CONFLICT` | 409 | `{leadId}` | the key is taken by a row this caller may not read |
| `LEADSCORE_CONVERSION_IN_FLIGHT` | 409 | `{operationId}` | same key, still running (+ `Retry-After`) |
| `LEADSCORE_CONVERSION_RETRYABLE` | 503 | `{operationId, failureCode}` | transient failure; retry is allowed |
| `LEADSCORE_CONVERSION_NEEDS_REVIEW` | 409 | `{operationId}` | this attempt must be recovered through the retry route, not re-issued |
| `LEADSCORE_CONVERSION_REPARENT_REQUIRED` | 409 | `{contactId, accountId, currentAccountId?}` | the link would move a Contact between Accounts (the current id only if readable) |

Plus the kernel's existing answers for the rest: `AUTHORIZATION_DENIED` 403, `VALIDATION_FAILED` 422 (per-field
required/type problems, `entity` + `field` in details), `CONCURRENCY_CONFLICT` 409, `RECORD_NOT_FOUND`/
`NOT_FOUND` 404 (`packages/core/src/errors/index.ts:26-96`), `FEATURE_DISABLED` 403, `RATE_LIMITED` 429.

### 12.2 Capability answers on the read side

The Lead read view gains a `conversion` affordance block computed by the server — `{canPreview, canConvert,
reasons[]}` — exactly like LS.7's `ScoreReadView.actions` (`docs/implementation/lead-score-ls7-completion-report.md`),
so the Convert button is rendered from an answer rather than from a role name. `reasons` uses §12.1's tokens.

### 12.3 Abuse bounds

Plan §9.4 asks for bounded candidate limits, bounded conversion retries and protection against tight loops.
The kernel has a **global** HTTP limiter (`apps/api/src/config.ts`, `bootstrap.ts`, `RATE_LIMIT_MAX`) and no
per-action limiter inside this module (§1.4 verified), so:

- duplicate candidates: a hard per-stage and per-target `LIMIT` module constant (same style as
  `MAX_SIGNAL_EVENTS_PER_PLAN` in LS.9), never a user-supplied size;
- preview: bounded to one Lead per call (LS.8's `maxPreviewSample` bounds a *sample*, but a conversion preview is
  one Lead's plan — a batch of them is a bulk conversion, U6);
- retry: one in-flight retry per operation (the row's own `processing` state is the mutex, §4.2) — so a loop
  on retry costs a refusal, not a second pass over the targets;
- the global limiter plus the operation gates are what protects the endpoints today; the absence of a
  per-user action budget is recorded as a gap (G10) rather than papered over, because the plan asks for it and
  LS.18's rollout review should decide whether the global limiter is enough.

---

## 13. What LS.11–LS.16 owe, and the schema work LS.13 must do

### 13.1 Ownership

| Phase | Owns | Files (audit §11 unchanged) | Must not |
| --- | --- | --- | --- |
| LS.11 | the resolver: stages, ACL, hidden-match count, domain helper, bounded fuzzy | `apps/api/src/lead-score/lead-duplicate-resolver.ts` | auto-link, auto-merge, a new unique index, MA's consent HMAC as a join key |
| LS.12 | mapping service + side-effect-free preview + `previewHash` + stale detection | `lead-field-mapping.service.ts`, `action/conversion/preview` | write a row, enqueue a job, read a field the actor cannot read and then omit the fact |
| LS.13 | T1/T2/T3, the six-field Lead write, events, the retry command, the scan, the settings `conversion` section | `lead-conversion.service.ts`, `lead-conversion-audit.service.ts` | trust the wizard's claims, repair an unmet choice, run as `system` instead of the actor |
| LS.14 | the wizard, `Converted To` panel wiring, timeout recovery by key lookup | `apps/web/src/components/LeadConversionWizard.tsx` (new), Lead detail | treat a lost response as a failure; issue a second conversion after a timeout |
| LS.15 | the explicit "what stays / what is linked" list | docs + relation work only | move a consent record, copy a file, broaden team access |
| LS.16 | Opportunity conversion through the same command | `lead-conversion.service.ts` extension | duplicate Sales' opportunity semantics (`createFromOpportunity` stays Sales', `document.service.ts:1257-1321`) |

### 13.2 Metadata/permission changes LS.13 must make (decided here, applied there)

1. **`LeadConversionOperation.acl.permissions.create` must become `'yes'`** (`read/edit/delete` stay `'no'`),
   exactly as LS.5 did for `LeadScoreEvaluation` (`seed-metadata.ts:5109`). Evidence it is required:
   `EntityCrudService.create` calls `acl.assertAccess(entity, 'create')` before anything else
   (`entity.service.ts:212`), and the internal marker only exempts the LS field guard
   (`lead-score-internal.ts:22-27`) — so with `create: 'no'` the command could not write its own row for any
   non-admin role. The client-write refusal is unaffected: the guard already refuses every client create
   (verified against the running API: `422 VALIDATION_FAILED
   {entity:'LeadConversionOperation', operation:'create', reason:"…written only by its Lead Score command…"}`),
   which is why LS.5 could afford `create: 'yes'` on evaluations and still keep them unwritable.
   This makes "may convert" imply "may record the operation", which is the honest grant story — and LS.13 must
   assert both directions, the way `lead-score-calculation.test.ts` asserts that a refused history row leaves
   no projection.
2. **`conversionAuditRead` must stop pointing at the entity's own `read`** (`lead-score-module.ts:211-217` uses
   the literal `'LeadConversionOperation'`). Granting that entity read to a role would open
   `GET /api/v1/LeadConversionOperation` — list and get — for it, because the write guard blocks writes only,
   and that contradicts the LS.5 design where history is reachable *only* through the Lead-scoped command
   (`docs/implementation/lead-score-ls5-completion-report.md`). Decided: a synthetic resource
   `LeadConversionAudit` (following `LeadScoreExplain`/`LeadScoreBatch` in `lead-score-domain.ts:31-42`), with
   the entity profile left at `read: 'no'`.
3. **`CONVERSION_STATUSES` loses `previewed`** and `defaultValue` becomes `'processing'`
   (`seed-metadata.ts:183`, `lead-score-vocabulary.ts:222`, and the LS.2 assertion at
   `lead-score-schema.test.ts:377` retargeted — a documented pointer change, not a weakened test), plus the
   `conversion` settings section of §5.2 in `LeadScoreSettingsSchema` with its own `.strict()` shape.
4. No new migration for the fields (attributes are JSONB); one *if* LS.11's bounded search needs an index for
   normalized email/phone — and §9.4 already says LS.18 decides that, not LS.11 in passing.

### 13.3 Test obligations this contract creates (so "documented" means "decidable")

Plan §13.4-5…13 map onto: a replay returns the stored ids with zero new rows; two concurrent converts produce
one `succeeded` and one `failed_final/already_converted` with a single Account and a single Contact; a forced
failure inside T2 leaves no target and a `failed_retryable` row; `previewHash` changes when the actor's visible
field set changes and the command then refuses; a user with `Account:create` but no `Account:read` on a
candidate gets no candidate and `hiddenMatches ≥ 1` without a leak; a disabled `Account` target cannot be
created by a direct API call; and a conversion sends nothing (the outbox row count for `notifications`/mail is
zero, and no adapter is invoked).

### 13.4 Document corrections made by this phase

- `docs/compatibility/lead-score.md` §5.2: drop the `name → name` row (§7.2) and the
  `assignedUserId, teams` row (§7.6); the corrected rows land in §13.4's edit of that file.
- §4.1's `Contact.accountId` pointer: `seed-metadata.ts:238`, not `:219` (`:206-217` is Account's *relations*).
- §4.3's "Two concurrent attempts … the Lead `version` plus the operation-key unique index let exactly one
  win" is superseded by §4.3 here: the **row lock** is the guard, the version check is the second line, and the
  loser's answer is a recorded `failed_final`, not a bare 409.
- §4.3's "(LS.18)" for the sweeper is corrected to LS.13 (§11.2), and its "U5" row keeps pointing at §11.4.

### 13.5 Gap and risk entries this phase resolves or adds

| Ref | Status after LS.10 |
| --- | --- |
| G3 / U3 "no phone normalization facility" | **superseded** — voice's `PHONE_NORMALIZER` is the reuse target (§1.4, §9.1); E.164 accuracy is still not claimed |
| G6 "event read must use recipient id, email fallback inside the same Lead" | already resolved in LS.9 (no fallback) |
| new **G9** | the correction/reopen workflow (§11.4) has no owning sub-phase in plan §16 — handed to the plan owner, with the concrete consequence stated |
| new **G10** | no per-user/per-action rate bound exists; plan §9.4's tight-loop protection is met only by the global limiter today (§12.3) |
| U5 | stays open, now with a decided policy (§11.4) instead of "unresolved item" |
| U6 | unchanged: bulk conversion stays out |

### 13.6 Explicitly not decided here

- Whether a future second source (web-to-lead, an import) changes §5.1's required-field gates — no such entry
  point exists (`docs/compatibility/lead-score.md` §1 "Web-to-Lead … no such endpoint").
- Whether `Contact` should gain an `industry` field so plan §7.4's "handle … industry option mappings" has a
  target: that is a core-metadata change, out of LS's ownership boundary (§1.2, plan §2.3), so the map skips it
  (§7.1's table in `docs/compatibility/lead-score.md` §5.2 already says "**no such Contact field** → skip").
- Any multi-target-per-type operation (two Contacts), any bulk conversion, and any Account merge.
- Whether LS.14's wizard is a modal or a route — a UI decision the LS.14 phase makes with a browser in the loop,
  not a contract term.

---

## 14. Exit-criteria evidence map

| Exit criterion term | Where it is now decided |
| --- | --- |
| conversion state machine | §3 (states 3.1, transitions 3.2, choreography 3.3, reader meaning 3.4) |
| valid conversions / target combination matrix | §5.1 with §5.2's settings gate and §6's linking rules |
| B2B/B2C constraint | §5.2 (module setting `conversion.targets`, backend-enforced; deviation carried) |
| required target fields | §5.1's data column, §7.2 (`name` mirroring), §7.4 (`createDefaults`), §7.7 (surfaced in the preview) |
| target linking policy | §6.1–§6.4 |
| allowed corrections | §10.5 (never reversed by the command) + §11.4 (the policy, and the missing owner) |
| canonical creation/linking services | §1.2 (there is one: `EntityCrudService`) and §1.3 (how it composes into one transaction) |
| mapping policy | §7 (storage, versioning, type matrix, non-mappable classes, defaults, existing-target/merge, ownership fields) |
| failure recovery | §10 (classification, retry rules, the accounting rule, post-commit) + §11 (scan, screen) |
| operation status / idempotency strategy / transactional boundaries | §3.3, §4.1–§4.3, §13.2 |
| …documented **before** conversion behavior | this file is documentation only; §13.1 assigns every implementation act to LS.11–LS.16, and §13.2 lists the schema/permission edits LS.13 must make when it starts |
