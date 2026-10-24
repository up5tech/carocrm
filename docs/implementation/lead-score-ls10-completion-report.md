# Phase 19-LS.10 — Conversion Domain Audit and State Contract: completion report

`PLAN_Phase_19_LeadScore.md` §2.3, §3.4–§3.5, §4.3–§4.4, §5.5–§5.7, §7.1–§7.8, §8.3–§8.4, §9.1–§9.4,
§10.2–§10.4, §11.4, §13.4, §14.1–§14.3, §16 (`19-LS.10`); audit §6 (the LS.0 sketch this phase decided),
§11 `LS.10`, decisions D4/D7/D12, gaps G2/G3/G6; compatibility `docs/compatibility/lead-score.md` §2.1–§2.5,
§4.1–§4.4, §5.2–§5.5, §7 (U3/U5/U14), §8 verification record.

**Exit criterion (plan §16):** *the conversion state machine, the mapping policy and failure recovery are
documented before conversion behavior is written.* The artifact is
[`docs/implementation/lead-score-conversion-contract.md`](./lead-score-conversion-contract.md) — 14 sections,
every claim either a citation of this repository or a decision LS.11–LS.16 must implement. **No code, schema,
settings or metadata file was changed by this phase**, which is the criterion rather than a shortfall: LS.13 is
the phase that writes conversion behavior, and a schema edit applied now would be conversion behavior written
before its contract was finished.

## 1. What landed

**The contract** (the file above). Its shape, in one line each:

- **§1 facts** — the conversion surface LS.2 already shipped: the six `converted*`/`conversionOperationId`
  Lead attributes and the `Converted To` panel, `LeadConversionOperation` with its unique
  `operationKey` partial index and recovery index, the LS.2 write guard that refuses every client write of it,
  and the three gate operations + six capabilities LS.1 registered. Plus the negative findings that still hold
  (no `Contact`/`Account`/`Opportunity` domain service exists; `Lead.relations` is `{}`; no B2B/B2C mode; no
  unique index on any email or phone; nothing derives a domain from a URL or address).
- **§2 route shape** — the plan's `/leads/:leadId/convert` semantics realized as
  `LeadScore/action/conversion/{preview,convert,operations,…}` because the kernel has no per-record action
  route at all (`entity.controller.ts:24-98`) and LS.5 already set that precedent for the score commands.
- **§3 state machine** — five states and why `previewed` is retired; a transition table with the guard that
  must hold and the fields written on each edge; the T1-claim / T2-work / T3-settle choreography; and what each
  *committed* state means to whoever is reading it, because that is what a recovery screen has to render.
- **§4 idempotency and concurrency** — key scope/format/derivation rules, a replay-and-refusal answer table
  (eleven rows), and the decision that a `SELECT … FOR UPDATE` on the Lead — taken *before* anything is
  written — is the concurrency guard, with the optimistic `version` check as the second line and the loser
  settled to `failed_final` rather than answered with a bare 409.
- **§5 the combination matrix** — eight rows, each with its ACL gate, its data gate and its settings gate; the
  `conversion` settings section as the entire B2B/B2C surface, with *why* an empty target list is refused.
- **§6 linking policy** — what a link is (a reference the Lead records, nothing else), the three cases where a
  link legitimately writes to the target, the re-parent triple lock, and the re-check-inside-the-transaction
  rule with its two failure answers.
- **§7 mapping policy** — where the map lives and why (a settings document, `.strict()`, validated on write
  because a mapping mistake writes records), the versioning semantics that make a map edit invalidate a
  preview but never mutate a past conversion, the type-compatibility matrix, the never-mappable classes,
  `createDefaults` for the one required field no Lead supplies, `skip` as the only existing-target behaviour,
  and why assignment fields are not data.
- **§8 preview contract** — the `previewHash` composition, including the deliberate `readerScope` component,
  the `confirmationTypes` set the convert request must acknowledge *exactly*, and the zero-write assertion
  method LS.4/LS.8 already use.
- **§9 duplicate policy** — five stages each naming the seam it reuses, the no-consent-HMAC-as-join-key rule,
  the digit-form matching with its accepted collision cost, `domainOf()` as a module helper with a free-mail
  exclusion, and the ACL rule (candidates the actor may read + a single `hiddenMatches` count).
- **§10 failure and recovery** — the classification table with a closed `failureCode` token list, the retry
  rules, the accounting rule that makes a retry safe, the post-commit side-effect stance, and the never-do list.
- **§11 operations** — what can be logged and counted here, the stuck-row scan's shape, the ESignature-operations
  rather than AdminJobs pattern for the screen, and the correction policy with its missing owner named.
- **§12 codes and bounds** — the nine `LEADSCORE_*` codes LS.12/13 must add (none of the states plan §8.4 names
  has a code today), the capability-answer block for the read side, and how the abuse bound is met by *shape*
  in the absence of a per-action limiter.
- **§13 obligations** — the LS.11→LS.16 ownership map with a "must not" per phase, the four schema/permission
  edits LS.13 must make with the evidence for each, the tests the contract creates, the document corrections
  this phase made, and the two new gaps.
- **§14 evidence map** — each clause of the exit criterion against the section that now decides it.

## 2. The findings that changed the decisions

**Two of LS.0's negative findings were stale, and a phase that trusted them would have built the wrong thing.**
The audit and U3 both assert *"no phone-number normalizer … no libphonenumber dependency in any
`package.json`"*, and G3 accordingly told LS.11 to write one. It exists: `voice-communications/phone-number.ts`
supplies `normalizePhone`, `phoneMatchKeys` and the `PHONE_NORMALIZER` token with a conservative and a
`libphonenumber-js` implementation (`apps/api/package.json:45`), and `VoiceContactResolverService` already uses
it for an ACL-gated phone lookup that counts the matches the caller may not see
(`voice-contact-resolver.service.ts:101-167`). So LS.11 reuses, and gains a hidden-match pattern for the ACL
rule it was going to have to invent. The second: `pg_trgm` is installed with attribute expression indexes
(`008_phase12.sql:8-22`) whose last two keys are `'email'` and `'phone'` — field names that do not exist here
(`emailAddress`, `phoneNumber`) — so that index covers nothing, and LS.10 bounds fuzzy matching instead of
assuming an index would make it cheap.

**The seeded status list contains a state no code may reach.** `CONVERSION_STATUSES` starts with `previewed`,
and `LeadConversionOperation.status` defaults to it. But the plan and LS.12's exit criterion forbid a preview
from writing anything, so no legitimate path may create a row in `previewed` — a status that is unreachable is
not unused, it is *wrong*, and it makes the recovery screen's list of states-a-human-must-look-at a guess. The
contract retires it and moves the default to `processing` as an LS.13 edit, with the LS.2 schema assertion
retargeted rather than deleted.

**The operation row, as seeded, cannot be written by the command that owns it.** `EntityCrudService.create`
calls `acl.assertAccess(entity, 'create')` (`entity.service.ts:212`) and `runAsLeadScoreInternal` exempts only
the LS *field guard* (`lead-score-internal.ts:22-27`) — so with the profile's `create: 'no'`
(`seed-metadata.ts:5175`), the convert command could not insert its own operation row for any non-admin role.
LS.5 met the identical problem and answered it by seeding `LeadScoreEvaluation` with `create: 'yes',
read: 'no'` (`:5109`) — the client stays locked out because the *guard* refuses client writes, which is exactly
what the running API still reports for an administrator (`422 VALIDATION_FAILED
{entity: 'LeadConversionOperation', operation: 'create', …}`). The contract records the profile flip as LS.13's
first obligation, with the note that this is what makes "may convert" imply "may record the operation".

**A capability that points at the entity's own read would open the door the design closed.**
`conversionAuditRead` is mapped to resource `'LeadConversionOperation'`, action `read`
(`lead-score-module.ts:211-217`). The write guard blocks *writes* only, so a role granted that entity read
would be able to list and get operation rows through `/api/v1/LeadConversionOperation` — the property LS.5
deliberately bought for evaluation history by making it reachable only through the Lead-scoped command. The
contract decides LS.13 introduces a synthetic `LeadConversionAudit` resource and leaves the entity profile at
`read: 'no'`.

**`name` is not data you can map.** `EntityCrudService.withName` mirrors `name` from the metadata display field
(`entity.service.ts:509-519`), and for both Lead and Contact that field is `lastName`. Verified live: a Contact
created with only `firstName`+`lastName` came back with `name` equal to the last name, and the same payload
without `lastName` is a `422 … "Field is required."`. Two consequences the compatibility table now carries:
the `Lead.name → Contact.name` row is wrong (mapping a derived value into a field the kernel re-derives can
only create a disagreement), and `lastName` is a **hard** required field for a person target — a Lead with a
company and a first name but no surname cannot produce a Contact, which is a preview-surface fact, not an
implementation detail.

**Ownership is not a field to copy.** LS.0's map said `assignedUserId, teams` are "carried as create defaults
through the canonical service". Copying a Lead's team list onto a new Contact silently widens who can read a
person record — the opposite of plan §7.5/§14.3's preservation rule — so the contract refuses it: assignment
may be set only from an explicit choice the actor may make.

**Concurrency needed a stronger answer than "the version check will catch it".** The plan's acceptance example
is *"two concurrent attempts cannot convert the same Lead twice"*. With the optimistic `version` alone the
loser gets `CONCURRENCY_CONFLICT`, which a client cannot distinguish from "your data was wrong", and the
operation row would sit unexplained in `processing`. The contract therefore takes the Lead row lock as T2's
first action, re-reads status and revision under it, and settles the loser deliberately
(`failed_final` / `already_converted`) — with `rowLock` precedent already in this codebase
(`case-assignment.service.ts:459-464`, `numbering.service.ts:142`) and the version check kept as the second
line for changes that did not go through the lock.

**Two requirements in the plan have no mechanism in this build, and LS.10 says so instead of inventing one.**
Plan §9.4 asks for per-action abuse bounds; the only limiter is the global HTTP one, and the LeadScore module
makes no rate-limit call anywhere. Plan §7.6 requires an explicit admin-controlled reopen workflow; **no
sub-phase in plan §16 asks for it**, and since LS.2 made every `converted*` field server-owned for all
callers, the practical consequence today is that a wrong reference cannot be corrected by anyone. These are
recorded as G10 and G9 with what LS.11–LS.13 do instead in the meantime, not papered over with a setting nobody
asked for.

**The preview fingerprint has a security component people forget.** Beyond the Lead revision and the mapping
version, the contract puts the *set of target fields the actor could read and write at preview time* into
`previewHash`. Without it, a preview confirmed while the user could see `emailAddress` would execute after that
field was hidden from them, and the conversion would write values the actor can no longer see — plan §9.2's
"field mappings cannot elevate permissions" closed at the right layer.

## 3. Verification

- **Documentation-only diff**: the only files this phase changed are `docs/implementation/lead-score-conversion-contract.md`
  (new), `docs/implementation/lead-score-audit.md` (§1.1, §3.5, §6, §10, §11),
  `docs/compatibility/lead-score.md` (§2.1, new §2.5, §4.1–§4.3, §5.2, §7 U3/U5/U14, §8), and `README.md`.
  `git status` was checked before and after; no source, metadata, settings or migration file is in the diff.
- **Every load-bearing claim re-read from the file it cites** — the LS.2 conversion surface
  (`seed-metadata.ts:325-330, 367-372, 5112-5177`, `073_phase19_lead_score.sql:175-191`), the guard
  (`lead-score-write-guard.service.ts:96-121`, `lead-score-internal.ts:22-43`), the transaction seam
  (`entity-record.store.ts:145-155`, `tx-context.ts:22-32`), the two multi-record prior arts
  (`project-clone.service.ts:66-190`, `case-merge.service.ts:100-121`), the audit/outbox transaction behaviour
  (`audit/audit-hooks.ts:134`, `events/event-bus.ts:25-36`), the concurrency and lock precedents
  (`entity.service.ts:233-236`, `entity-manager/index.ts:169-171`, `entity-record.store.ts:207-214`,
  `case-assignment.service.ts:459-464`), the ACL surface (`acl-api.service.ts:109-247`), the field lists and
  required flags of the three targets (`seed-metadata.ts:196-204, 232-240, 390-406`), the normalizer seams
  (`phone-number.ts:141-208`, `marketing-automation-domain.ts:1385-1387`, `marketing-identity.ts:38-48`), the
  gate/permission tables (`lead-score-feature-gate.service.ts:45-105`, `lead-score-module.ts:183-224`), the
  settings schema (`lead-score-settings.service.ts:28-124`) and the Sales convert precedent
  (`document.service.ts:1170-1240`).
- **Three facts confirmed against the running dev API**, because a citation would only have shown what the
  metadata *says*, not what the write path *does*: a Contact create without `lastName` →
  `422 VALIDATION_FAILED {lastName: "Field is required."}`; a Contact create with `firstName`+`lastName` only →
  the returned record carries `name` mirrored from `lastName`; an administrator `POST
  /api/v1/LeadConversionOperation` → refused by the LS.2 guard with `{entity, operation: 'create'}`, while an
  equivalent `POST /api/v1/LeadScoreEvaluation` passes the ACL gate and fails only on a link-existence check —
  the asymmetry that §13.2's first obligation rests on. The probe Contact and probe Lead were removed by exact id
  and a residue query for the run marker returned nothing.
- **Nothing moved**: the eleven LeadScore API files re-run together — **248 passed / 0 failed**, with all
  eleven green inside the full run as well; full `npx vitest run` — **2,883 passed / 34 failed across 202
  files**, identical to the LS.9 baseline, and the 34 are the same seven pre-existing shared-state files
  (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3), zero `lead-score` failures; worker suite
  **210 passed / 0 failed across 20 files**; `npm run typecheck` clean. A documentation change cannot break a
  test that reads these files — `apps/api/test/docs-content.test.ts` lints `content/docs/**` only, and no test
  reads `docs/compatibility/` or `docs/implementation/` — which is why the run is expected green rather than
  hoped for.
- `git status` before committing shows exactly five paths: `README.md`, `docs/compatibility/lead-score.md`,
  `docs/implementation/lead-score-audit.md` and the two new documents. **No source, metadata, settings or
  migration file is in the diff** — the check that keeps this phase to its own exit criterion.

## 4. What this phase does not claim

- **No conversion behavior exists.** `conversionPreview`, `leadConversion`, `conversionRecovery`,
  `duplicateDetection`, `fieldMapping` and `opportunityConversion` still carry their `pendingPhase` pointers
  (`lead-score-module.ts:259-265`) and every one of those operations refuses with `LEADSCORE_PHASE_PENDING`.
  Nothing in the repo can convert a Lead today, and this phase deliberately did not change that.
- **A contract is not a passing test.** §13.3 lists the tests the contract creates; they belong to LS.11–LS.13,
  which are the phases whose exit criteria can only be met by running them.
- **The decisions that depend on a decision LS.10 did not take** are named as such rather than smoothed:
  whether LS.13's row-lock holds up under the real pool size is LS.18's concurrency run; whether a per-action
  limiter is worth a kernel primitive is G10's call at rollout; whether an index for normalized email/phone
  search earns its migration is LS.11's measurement plus LS.18's review.
- **Two open items are handed out of the module**: the correction/reopen owner (G9), and the Contact `industry`
  field that would let plan §7.4's "industry option mappings" have a target at all — that is a core-metadata
  change outside LS's ownership boundary (plan §2.3), so the map skips `industry` for Contact and says why.
- **Opportunity conversion stays gated behind its own feature and phase** (`opportunityConversion`, LS.16). The
  matrix has room for it (§5.1 row 8) precisely so LS.16 does not have to redesign the state machine, not
  because this phase assumes it will ship.
- LS.11–LS.18 are not started.
