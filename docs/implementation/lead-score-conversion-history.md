# Lead conversion — what happens to the Lead's history

`PLAN_Phase_19_LeadScore.md` §7.5, §16 `19-LS.15`; audit §11 `LS.15`; contract
`docs/implementation/lead-score-conversion-contract.md` §10.5; compatibility
`docs/compatibility/lead-score.md` §4.4.

**Exit criterion (plan §16):** *conversion does not lose source context or broaden access to related data.*

The answer this build gives is deliberately conservative and is verified rather than argued: **a conversion
writes its own rows and touches none of the Lead's history.** The command creates or links the targets, writes the
Lead's six `Converted` attributes, records the operation and dispatches one event (LS.13, contract §3.3). Every
other row that pointed at the Lead still points at it, with the same values — the suite
`apps/api/test/lead-score-conversion-history.test.ts` seeds each kind of history the audit named and counts it
before and after.

## 1. The inventory

| History | Where it actually lives | What a conversion does | Verified by |
| --- | --- | --- | --- |
| E-mails about the Lead | `entity_links` — `Email.leads` is a **manyMany** relation (`database/seed-metadata.ts:62-67`) | nothing: the link stays on the Lead, and the Contact gets **no** e-mail link | link counts for `Email → Lead` and `Email → Contact` are equal before and after; no `entity_links` row names the new Contact |
| Cases raised from the Lead | `Case.leadId` (a `link` attribute) | nothing | the field still names the Lead |
| Campaign / target-list attribution | `TargetListEntry.memberType`/`memberId` (polymorphic, `seed-metadata.ts:4248-4252`) | nothing: the entry is not re-pointed at the Account or Contact | the fixture entry still reads `Lead` / the Lead id; no entry names the new Account |
| Marketing consent | `MarketingConsent` — keyed by `emailHash` + `channel` + `purpose`, with `subjectType/subjectId`, `contactId`, `leadId` as *references* (`:4317-4339`) | nothing: no consent row is created, copied or re-pointed | consent row count unchanged; the seeded row still names the Lead and has no `contactId`; no consent row names the new Contact |
| Attachments | the `attachments` table, `parent_type`/`parent_id` (`database/migrations/001_init.sql:152-168`) | nothing: no copy, no move | attachment count unchanged; the row still reads `parent_type='Lead'`, `parent_id=<lead>`, same `storage_key`; no attachment names the Contact |
| Stream / notes / activities | `stream_items` and the activity tables | nothing of the module's own: any new row is the platform's own record of the writes | counts are taken immediately before the call |
| The Lead's own fields | the `entity_records` row | only the six conversion attributes (LS.2's contract) | `description`, e-mail, status history and the append-only `audit_log` are checked |

There is **no `Note` entity and no Lead-linked activity** in this build (`activityRelations` has accounts,
contacts, users and reminders — not leads, audit gap G2), so "a note is not duplicated" and "an activity is not
moved" are true structurally: there is nothing to move. Files exist only as `attachments`, which the table covers.

## 2. Why nothing is copied, not merely "not copied yet"

The command has no code that touches those tables. Its whole write set is: the targets (through
`EntityCrudService`), the Lead's six attributes, the `LeadConversionOperation` row, and one
`lead.conversionSucceeded.v1` outbox row with ids and the verdict (contract §3.3, §10.4). That is the same reason
"no file is duplicated" and "no consent is granted" need no runtime check: there is no path to copy from.

## 3. Consent provenance (the sharp edge)

Consent in this build is **address-level**: a `MarketingConsent` row is keyed by a normalized `emailHash` plus a
channel and a purpose, and its `leadId`/`contactId` are references to who the decision was taken about, not the
key (`apps/api/src/marketing-automation/marketing-identity.ts:36-48`).

Consequences a reader should not misunderstand:

- conversion **creates no consent row and copies none** — a converted Contact is not thereby a consented Contact,
  and the fact that a consent row names the Lead is not rewritten to name the Contact;
- whether an *address* is mailable remains MarketingAutomation's decision, keyed by the address hash. A converted
  Contact that carries an address some consent row covers is, in MA's terms, that address — that is a property of
  the address, not something the conversion granted, and this module neither reads nor writes consent to decide it;
- a consent row that named only the Lead keeps naming only the Lead. If an operator wants it to name the Contact,
  that is MA's own consent workflow, with its own evidence rules — not a side effect of converting.

## 4. Access is not broadened

- **Ownership is not data.** `assignedUserId` and `teams` are not mappable (contract §7.6), so a Contact created
  from a Lead somebody owned is **unowned** and team-less; the suite asserts both, and a restricted reader who
  may read the Lead (it is assigned to them) gets **404** on the new Contact and Account.
- **Link labels respect the target's record ACL.** The Lead's `Converted To` panel is rendered from the Lead's
  own attributes, and the labels for its link fields are resolved through `acl.recordPredicate(target, 'read')`
  (`apps/api/src/entity/entity.service.ts:685-700`), so a reader who may see the Lead but not the Contact sees
  the reference field, not the Contact's name through a label map.
- **Nothing re-points a relation at a record the actor could not read.** The links the command writes
  (`Contact.accountId`, `Opportunity.accountId`/`contactIds`) are the chosen targets it already had to read.

## 5. What the *new* record does not get (the honest half of "lose source context")

Nothing is lost from the Lead; the Lead keeps every row and remains reachable (it is `Converted`, not deleted).
What the new Contact/Account **do not** inherit is the history itself: the e-mail thread, the attachments, the
campaign membership and the cases stay on the Lead. Two things do travel, by the map (LS.12): the Lead's own
field values — including `source → Contact.leadSource` — and the relationship the wizard chose.

Linking history to the new records is allowed by the plan **only as an explicit, authorized action**, and no
phase in the plan's §16 owns that action. It is therefore **deferred, not silently built**: an implementation
would need

1. its own command and capability (adding e-mails/attachments to a Contact is a write on somebody else's
   record, so the actor's `Contact:edit` and the target's record ACL both apply);
2. **add-not-move** semantics — the Lead keeps its links, because the whole point is preservation;
3. a per-item selection (the wizard would show what could be linked, and the person would choose), never a bulk
   "link everything";
4. an audit trail naming which row was added to which record, by whom;
5. the same treatment for consent, which is *not* link-able this way: consent is MA's, keyed by address, and a
   conversion that "moved" a consent row would be a consent decision nobody made.

Recorded as a gap for the plan owner (the same shape as G9, the correction workflow): the capability exists in
the plan's prose, the mechanism has no owner.

## 6. What this phase is not

- **Not a new command.** No production code changed in 19-LS.15: the suite is the deliverable, because the
  guarantee is already structural and the honest way to keep it is to pin it with tests.
- **Not a stream migration.** Stream items, notifications, jobs and outbox rows that named the Lead are platform
  history; a conversion adds its own event and changes none of them.
- **Not a record-merge.** Two records now exist (the Lead and the Contact); nothing merges them, and nothing
  deletes the source.
