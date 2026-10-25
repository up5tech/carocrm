# Phase 19-LS.15 — History, Activities and Attribution Preservation: completion report

`PLAN_Phase_19_LeadScore.md` §7.5, §16 (`19-LS.15`); audit §11 `LS.15`; contract
`docs/implementation/lead-score-conversion-contract.md` §10.5; compatibility `docs/compatibility/lead-score.md`
§4.4, §8.

**Exit criterion (plan §16):** *conversion does not lose source context or broaden access to related data.* The
deliverable is a **verification and a documented inventory**, because the guarantee is already structural: the
command's whole write set is the targets, the Lead's six `Converted` attributes, the operation row and one event.
This phase pins that with tests and says exactly what "history" means in this build.

## 1. What landed

**`apps/api/test/lead-score-conversion-history.test.ts` (new) — six tests that seed each kind of history and
count it before and after a real conversion** through the API:

| Seeded | Asserted after conversion |
| --- | --- |
| a Lead with a `description` | the Lead still exists, `Converted`, description and e-mail unchanged, `deletedAt` null, an append-only `audit_log` present |
| an `Email` linked to the Lead (`PUT /Email/:id/leads/:leadId`) | the `Email → Lead` link count is unchanged; `Email → Contact` is unchanged (zero); no `entity_links` row names the new Contact; the e-mail row itself is unchanged |
| a `Case` with `leadId` | `leadId` still names the Lead |
| a `TargetListEntry` (`memberType='Lead'`, `memberId=<lead>`) | still `Lead` / the Lead id; no entry names the new Account |
| a `MarketingConsent` row (address hash, purpose, `leadId`) | consent row count unchanged; still names the Lead; `contactId` still null; no consent row names the new Contact |
| an `attachments` row (`parent_type='Lead'`) | attachment count unchanged; `parent_type`/`parent_id`/`storage_key` unchanged; nothing attached to the Contact |
| a restricted reader who owns the Lead | the Lead still reads 200; the new Contact and Account answer **404**; the created records have no owner and no teams |

**`docs/implementation/lead-score-conversion-history.md` (new) — the inventory.** Every place a Lead is
referenced (e-mail links, `Case.leadId`, polymorphic target-list entries, consent references, attachments,
stream/audit/platform rows), what a conversion does to each (nothing), why (there is no code to copy from), the
consent nuance, the access rules, the honest half (the new record does not inherit the thread/attachments/
campaign membership — the Lead keeps them), and the **deferral with a named owner** of the explicit history-linking
action the plan allows: no phase in §16 owns it, and the document states the contract such an action would need
(its own capability, add-not-move, per-item selection, audit) — recorded beside G9.

**No production code changed.** That is the finding, not a gap: the command cannot move history because it has no
writer for it, and adding a runtime check would suggest the opposite.

## 2. What the verification decided

**Consent is address-level, and that changes the sentence.** The audit's shorthand ("a converted Contact is not a
consented Contact") is true about *rows*: conversion creates none and copies none. But consent in this build is
keyed by `emailHash` + channel + purpose (`marketing-identity.ts:36-48`), so a converted Contact that carries an
address some consent covers is, in MarketingAutomation's terms, that address. The document says so precisely:
conversion neither grants nor revokes a decision, and whether an address is mailable remains MA's call keyed by
the hash. Writing "conversion cannot affect consent" would have been the comfortable sentence and the wrong one.

**"Notes" have no entity here, so the row is stated rather than faked.** `activityRelations` has accounts,
contacts, users and reminders — not leads (audit gap G2), and there is no `Note` entity. The only "note" a Lead
can carry is its own `description`, which the first test checks. Faking a note through a relation that does not
exist would have been worse than saying it.

**The target-list fixture is written to the entity store, not through MarketingAutomation.** MA's `audience`
feature switch is off in this database, and flipping another module's switch to create a fixture is not this
phase's business. The row is an `entity_records` insert with the run marker, removed in `afterAll`; the question
is what a conversion does to attribution, and the answer does not depend on how MA created it.

**Link labels were checked rather than assumed.** The `Converted To` panel renders link fields, and labels come
from `attachLinkLabels`, which filters the target lookup through `acl.recordPredicate(target, 'read')`
(`entity.service.ts:685-700`). So a Lead-only reader sees the reference attribute, not the Contact's name through
a label map — the access half of the criterion, verified by the 404s and by reading the code path that produces
labels.

## 3. Verification

- The new suite: **6 passed / 0 failed**.
- All fifteen LeadScore API files together — **311 passed / 0 failed**. Full `npx vitest run` — **2,946 passed /
  34 failed across 206 files**: zero `lead-score` failures, and the failures are the same seven pre-existing
  shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3). Worker suite **210 passed / 0 failed**.
  `npm run typecheck` and `npx eslint` on the touched paths. This phase adds six tests to LS.14's 305 and no
  source change, which is why the numbers move by six and nothing else does.
- No migration, no settings change, no new endpoint.
- Residue: the suite removes its Leads, targets, operation rows, link rows, the consent and attachment fixtures,
  the roles and the users, restores the `leadScore` settings row, and warns if a marker query finds anything.
  Conversion operation rows are append-only, so — as in LS.13/LS.14 — the run's rows are swept at the database
  level by the Leads they name.

## 4. What this phase does not claim

- **No history-linking action.** The plan permits an *explicit, authorized* link of history to the new records;
  no phase in §16 owns it, and this phase records the contract it needs instead of building it silently. Until
  then a Contact converted from a Lead has the Lead's values and no thread.
- **No activity or note migration** — there is nothing to migrate, and inventing a relation to make a checklist
  pass would be a core-metadata change outside this module's ownership.
- **No consent transfer.** Consent is MA's decision, keyed by address; a conversion that moved a consent row
  would be a consent decision nobody made.
- **No campaign attribution on the new records.** A TargetListEntry keeps pointing at the Lead; attributing the
  Contact to the campaign is a marketing decision with its own membership rules.
- **No deletion of the source.** The Lead is `Converted`, not removed; its history stays readable, which is the
  actual answer to "lose source context".
- LS.16–LS.18 are not started.
