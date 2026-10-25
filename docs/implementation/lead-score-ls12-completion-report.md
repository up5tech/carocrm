# Phase 19-LS.12 — Field Mapping and Conversion Preview: completion report

`PLAN_Phase_19_LeadScore.md` §5.7, §7.1–§7.4, §8.3, §9.1–§9.2, §11.4, §16 (`19-LS.12`); audit §11 `LS.12`;
contract `docs/implementation/lead-score-conversion-contract.md` §5.2, §6, §7, §8, §12.1; compatibility
`docs/compatibility/lead-score.md` §4.1–§4.3, §5.2, §8.

**Exit criterion (plan §16):** *the preview is side-effect-free and faithfully describes the operation that
would run.* Both halves are structural, not promised. The preview has no writer — the suite asserts the Lead's
`version`/`modifiedAt`, the record counts per entity, the audit log, the outbox and the `jobs` table are
unchanged across a call. And it is faithful because it is the **same code path LS.13 will run**: one resolver for
the values, one duplicate resolver for the candidates, and a fingerprint over every input those two read, so an
old preview can be *refused* rather than merely suspected.

## 1. What landed

**`lead-field-mapping.service.ts` (new) — the map, and the rules a map must obey.** The conversion section of the
`leadScore` settings document is `{targets, fieldMergeAllowed, mapping}`, where `mapping` is one versioned
`{version, fields, createDefaults}` per target. Shape is zod-strict; **meaning** needs metadata, so
`validateSection` runs on every settings write and refuses:

- a source `Lead` does not have, a target entity does not have, or two lines writing the same target field;
- a source that is a Lead **outcome or system field** (`score*`, `converted*`, `status`, `name`, ids,
  timestamps) and a target that is **ownership** (`assignedUserId`, `teams`), a **relationship carry**
  (`Contact.accountId`, `Opportunity.accountId`/`contactIds`) or a **derived** field (`Contact.name`);
- a type pair that would lose data silently: `text → varchar` (the bound would truncate), `datetime → date`
  (the time would vanish), `enum → enum` (no value map exists), a `link` into a different entity. Widening text
  is allowed and each value is then checked against the target field (`valueIssue`).
- a changed map that **kept its version** (`version_not_bumped`) — a stored conversion and every preview
  fingerprint name that version, so re-using it for a different policy is the kind of lie this phase exists to
  prevent;
- a `createDefaults` template naming a field `Lead` does not have (`{{token}}` is validated at write; the
  *value* is composed and checked at preview time, when the Lead is known).

The default map is the one compatibility §5.2 describes — including the two corrections LS.10 made (`name` is
derived, ownership is not data) — and `Account.emailAddress`/`phoneNumber` are deliberately **not** in it: they
reach an Account only when the request creates no Contact, where the preview adds them as `contextual` entries.

**`lead-conversion-preview.service.ts` (new) — the command.** `POST /api/v1/LeadScore/action/conversion/preview`
behind the existing `conversionPreview` operation. For each requested target it answers:

| Field | What it is |
| --- | --- |
| `proposed` | the values that would be written, each with `origin` (`mapped` / `createDefault` / `merge` / `contextual`) |
| `skipped` | every value that would **not** be written, with a reason from a closed list (`source_hidden`, `empty_value`, `target_no_such_field`, `field_type_incompatible`, `never_mappable`, `relationship_field`, `value_invalid`, `link_keeps_values`, `merge_not_allowed`) |
| `required` | target-required values the plan would still lack — the blocking list |
| `conflicts` | for a linked record, every mapped value that differs from what it holds, as `before`/`after` |
| `notCopied` | the deliberate non-mappings (`name` for a Contact, ownership) |
| `relationship` | the links the command will set, from this same request (a Contact → the chosen Account, an Opportunity → Account + Contact) |

plus `permission` (`canExecute` + a reason list), `confirmationTypes` (`simple`, `duplicates_present`,
`values_will_be_skipped`, `field_merge`, `contact_reparent`), and `previewHash`.

**The fingerprint** is SHA-256 over the Lead revision, each requested target's mapping version, the explicit
field merges, the duplicate choice, **the mapped Lead fields this reader can see**, **the target fields they can
read *and* write**, and **the merge policy**. The last three are security properties: a preview taken while a
field was visible cannot execute after it is hidden, and the same plan under a policy that would refuse a merge
is not the same operation.

**Stale refusals.** A pinned `expectedLeadRevision` or `mappingVersion` that no longer matches answers
`409 LEADSCORE_PREVIEW_STALE` with the component named (`revision` / `mapping`) — no values, no record dump. A
target that the settings disable, or one whose phase has not shipped, answers `422 LEADSCORE_TARGET_DISABLED`
with `{target, state: 'notEnabled' | 'pending', pendingPhase}`. Both codes are new, localized in `en` and `vi`,
and documented in contract §12.1.

**Two features flipped**: `fieldMapping` and `conversionPreview` are delivered, so the settings screen stops
calling them pending and the gate admits the preview once the module is on.

## 2. The findings that changed the implementation

**The fingerprint was missing the merge policy — a test caught it.** The first version hashed the Lead revision,
the mapping versions, the merges and the reader scopes. Enabling `conversion.fieldMergeAllowed` changed whether a
requested merge would be *applied* (from `skipped: merge_not_allowed` to `proposed: origin: merge`) without
changing the hash, so two different operations shared one fingerprint. `fieldMergeAllowed` is now a component.
That is precisely the kind of defect a fingerprint exists to prevent, and it was invisible until the suite
asserted that the hash moves when the permission does.

**`Contact.name` is derived, so "required" needs a nuance.** `EntityCrudService.withName` mirrors `name` from the
display field (`entity.service.ts:509-519`), which for Contact is `lastName`. Reporting both `name` and `lastName`
as missing would name one gap twice; the preview therefore excludes `name` from `required` for Contact only —
Account and Opportunity `name` are real blocking values (nothing derives them but the map or the template).

**A Lead always carries `lastName`, so the required-field test needed a custom map.** The plan's case "a Lead with
a company and a first name cannot become a Contact" is nearly unreachable through the API because Lead requires
`lastName` itself. The honest test is the configuration one — an installation whose map stops copying `lastName`
— and the ACL one: a hidden `company` leaves `Account.name` unset and the preview says so instead of proposing a
payload the entity layer would refuse. Both are in the suite.

**A link applies nothing, so the answer had to say that rather than list empty `proposed`.** Contract §6.1 makes
a link a reference: mapped values are not written, and the only writes are the relationship and an explicit
merge. `skipped: link_keeps_values` plus `conflicts` (before/after for every differing value) is how the wizard
can show "these fields differ, and none of them is being applied" without inventing a second vocabulary.

**An unreadable link target is not a 404.** The preview cannot describe a record the caller may not read, but
answering 404 would confirm that a guessed id does not exist and 200 would confirm that it does. It answers 200
with `permission.reasons: ['target_unreadable_Contact']` and `existing: null` — the operation cannot run, and
nothing about the record is learned (contract §9.2's invisibility rule applied to links).

**The type matrix had to be stricter than the audit's table.** `text → varchar` and `date ↔ datetime` are not in
the audit's examples, but they are the same class of silent loss as `datetime → date` (which is), so they are
refused; `enum → enum` is refused for lack of a value map rather than copied by label. Each refusal carries the
two types in its message, so a configured map can be fixed without reading the code.

**Templates are checked twice, deliberately.** At settings-write time only the tokens can be validated (the Lead
is not known); at preview time the composed value is checked against the target field, and an empty composition
is a `required` gap. Validating the literal `{{lastName}} — {{company}}` as a string would have refused every
useful template and accepted `{{nope}}`.

## 3. Verification

- `apps/api/test/lead-score-conversion-preview.test.ts` — **22 new tests** (6 pure, 16 API against the configured
  primary database): the default map's exact shape; the strict section (empty/duplicate/unknown target, unknown
  key); the type matrix incl. the three silent-loss pairs; `valueIssue` per type; template composition with a
  missing side; a fingerprint that moves with the revision, the mapping version, the merges, the reader scope and
  the merge policy. API: a Contact+Account create described with **the Lead's `version`/`modifiedAt`, the record
  count, `audit_log`, `outbox_events` and `jobs` all unmoved**; Account-only receiving the Lead's e-mail/phone as
  `contextual`; a custom map that drops `lastName` yielding `required: ['lastName']` and `canExecute: false`; a
  link proposing nothing with before/after conflicts and no conflict for a field that already agrees; a merge
  refused by policy then proposed once allowed (hash changes); stale revision and stale mapping refused by name;
  six settings refusals and the accepted version bump; four malformed target requests; the feature door; a hidden
  Lead field (`source_hidden` + a blocking `required` + the value absent from the payload); an unreadable link
  target (`target_unreadable`, not confirmed to exist); duplicates present only while that switch is on.
- All thirteen LeadScore API files together — **285 passed / 0 failed**. Two suites needed retargeting rather than
  weakening: `lead-score-module.test.ts` (the shipped-feature list gained `fieldMapping`/`conversionPreview`, the
  pending list lost them, the "stored switch whose phase has not shipped" example moved to `leadConversion` /
  `19-LS.13`, and the pending-operation example moved to `conversionExecute`/`conversionRetry`) and
  `lead-score-schema.test.ts` (the same pending-operation example).
- Full `npx vitest run` — **2,920 passed / 34 failed across 204 files**: the +22 over LS.11's 2,898 is exactly
  this suite, and the 34 are the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3,
  `crm-chat` ×3) with zero `lead-score` failures. Worker suite **210 passed / 0 failed** across 20 files.
  `npm run typecheck`, `npx eslint` on every touched path, `pnpm --filter @carocrm/api build`, and the two LS
  Playwright specs (**9 passed** — the settings screen renders the two newly-delivered switches). One caveat
  recorded rather than smoothed: an earlier run of the same two specs, launched immediately after the full
  vitest run and the API build, failed the LS.8 version-diff test once (8/9, 1.5 min for a suite that normally
  takes 30 s). It did not reproduce with the file alone or with the pair re-run, and nothing in this phase
  touches model versioning — recorded as load flake, with the clean result above as the one the claim rests on.
- No migration. The settings document is one JSONB row, the map is configuration, and nothing new is indexed.

## 4. What this phase does not claim

- **No convert command.** Nothing writes a Contact, an Account or a Lead yet; `conversionExecute` and
  `conversionRecovery` still name `19-LS.13`, and `action/conversion/convert` does not exist. The preview is the
  operation's description, not its execution.
- **No wizard, and no map administration screen.** LS.14 owns the UI; the map is edited through
  `POST action/settings`, which validates it. A form for the map would be a screen with no consumer yet.
- **Opportunity preview is refused** (`422 LEADSCORE_TARGET_DISABLED {state:'pending', pendingPhase:'19-LS.16'}`)
  and `opportunity_created` can therefore never be produced today. The template and the map entry exist and are
  validated, so LS.16 has configuration to inherit rather than to design.
- **A merge is not applied here** — it is only *proposed*. Applying it needs LS.13's transaction and its
  `applyFieldChanges` re-check; this phase answers whether it *would* be allowed.
- **The duplicate candidates are embedded, not decided.** `requiresChoice` says a decision is required; recording
  it (`selectedMatchIds`, `duplicateDecision`) belongs to the command.
- **No fuzzy suggestions, no index** — both are as LS.11 left them, and LS.18's query check still owns the index
  question.
- **No activity/attribution work** — LS.15; the preview says nothing about `Email.leads`, `Case.leadId` or
  consent provenance beyond `notCopied`'s ownership list.
- LS.13–LS.18 are not started.
