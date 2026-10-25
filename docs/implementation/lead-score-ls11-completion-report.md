# Phase 19-LS.11 — Duplicate Detection and Candidate Review: completion report

`PLAN_Phase_19_LeadScore.md` §7.1, §7.3, §9.1–§9.4, §13.4-5/13/14, §16 (`19-LS.11`); audit §11 `LS.11`,
gaps G3 (superseded) / G10; contract `docs/implementation/lead-score-conversion-contract.md` §1.4, §9, §12.3;
compatibility `docs/compatibility/lead-score.md` §4.2, §7 (U3), §8.

**Exit criterion (plan §16):** *ambiguous matches cannot result in silent auto-linking or auto-merge.* The
resolver cannot link or merge anything — it has no write path at all — so the criterion is met by construction
and then *asserted*: the suite checks that a call leaves the Lead's `version`, `modifiedAt` and the audit log
exactly as they were, and that every match the caller may not see comes back as one number rather than as a
hint. The decision the plan asks for is exposed, not implied: `requiresChoice`, `canOverride` and
`allowedDecisions` (`link` / `create_with_override` / `cancel`) are the question LS.12's preview and LS.13's
command will refuse to proceed without.

## 1. What landed

**The resolver — `apps/api/src/lead-score/lead-duplicate-resolver.ts` (new).** Four exact stages, each a
type-filtered SQL predicate with a hard limit, each row then passed through the caller's ACL:

| Stage | Match | Classifies as | Bounded by |
| --- | --- | --- | --- |
| e-mail | `lower(btrim(emailAddress))` equality | `same person` | `MAX_DUPLICATE_SCAN` = 25 rows per stage |
| phone | last 9 significant digits (trunk zero dropped) | `same person` | same |
| domain | host of the Lead's e-mail domain vs the host of `Account.website`, folded by **one rule** in SQL and TypeScript | `same organization` | same |
| company | `Account.name` folded like `normalizedName` | `same organization` | same |

…with `MAX_DUPLICATE_CANDIDATES` = 10 returned, `dedupe` merging the reasons a single record matched on, a
person match ordered before an organization match, and `bounded: true` when a scan hit its limit (so the answer
never pretends a truncated scan was exhaustive).

**The ACL partition.** A row that fails `canAccessRecord('read')` contributes only to `hiddenMatches`; a row
the caller may read but whose **display name** is hidden is withheld the same way, because there is nothing to
choose between without a label; every value that *is* returned passes `visibleFields` first, so a readable
Contact whose e-mail is hidden does not hand the value back through `details`. `hiddenMatches` is the plan
§7.1 "a possible match exists but is not visible" warning, expressed as a count — the `VoiceContactResolver`
precedent, for the same reason.

**The stage report.** `stages[{key, evaluated, reason}]` says which key ran and, when one could not, why:
`no_value` (the Lead has no e-mail/phone/company) or `free_mail` (the e-mail domain is a personal mailbox, so it
cannot be an organization signal). A caller can therefore tell "we looked and found nothing" from "we could not
look", which is the same discipline LS.9 applied to engagement states and LS.4 to missing data.

**The door.** New gate operation `duplicateCheck` — capability `convertPreview`, feature `duplicateDetection`,
`writes: false` — and `POST /api/v1/LeadScore/action/conversion/candidates` with `{leadId}` only. One Lead per
call: a candidate list for a *set* of Leads would be a searchable map of who-knows-whom across the database,
and the DTO deliberately cannot be turned into one. `features.duplicateDetection` flipped to delivered; the
operation count is 17.

**The keys — `lead-score-vocabulary.ts`.** `domainOf` (scheme, `www.`, path, query, fragment and port stripped;
IP literals and bare words refused), `FREE_MAIL_DOMAINS` (a named list, so LS.18 can review the exclusions),
`isFreeMailDomain`, `normalizedEmail`, `normalizedName`, `phoneMatchTail`, and the two caps. They are pure and
tested without a database, which is what lets the SQL expressions be checked as copies of them rather than as
coincidences.

**A descriptor correction.** `implementedPhases` in `lead-score-module.ts` still listed LS.0–LS.6 while LS.7,
LS.8, LS.9 and LS.10 had shipped — the health view renders that list, so it was telling a reader the card, the
model workspace, the engagement read and the conversion contract did not exist. Corrected to LS.11, with the
module suite's exact-list assertion retargeted (not loosened) and the OpenAPI assertion extended with the new
route.

## 2. The findings that changed the implementation

**`name` is a physical column — twice.** The first cut read the candidate's label from `attrs['name']`, which is
always `null` for Contact and Account (LS.2 wrote that lesson down: only the `name` column exists). Every
candidate was therefore silently classified as "unnameable" and counted as hidden, and the suite showed a Lead
with a matching Contact answering `candidates: []`, `hiddenMatches: 1`. The fix reads the column for the label
*and* for the company stage's comparison; the attribute form would have matched nothing at all. This is the
same trap LS.7 hit from the other direction, and the test that caught it is the organization one.

**`'\s+'` in a template literal is `'s+'`.** The SQL folding expression for Account names collapsed whitespace
via `regexp_replace(…, '\s+', ' ')`, and because a JavaScript template literal drops the backslash of an
unrecognized escape, PostgreSQL received `s+` and replaced every letter **s** with a space — visible in a debug
run as `agent_test_ls11_mvn3 yh2 acme   indu trie `. The fix uses the escape-free POSIX class
`'[[:space:]]+'`, and the same treatment replaced `'^www\.'` with `'^www[.]'` in the domain expression. Any
future SQL regex in this repository should prefer bracket expressions over backslash classes.

**The phone key is a tail, and that is a decision rather than a shortcut.** `phoneMatchKeys` (voice) yields the
exact international and national digit forms, which are correct only when the input carries enough region
information — and a Lead carries none (contract §1.4). The tail of the last nine significant digits is the one
form that makes `+84 912 345 678`, `0912 345 678` and `(091) 234-5678` equal. The accepted cost, written in the
contract, is a cross-country tail collision; it can only add a candidate, and a candidate is a question.

**No fuzzy stage shipped, and the reason is measurable.** Plan §7.3 lists a similarity stage "only to suggest
candidates"; the only trigram indexes in this schema key on `'email'`/`'phone'` (`008_phase12.sql:8-22`), which
are not field names here, so a similarity query would be an unbounded scan of `entity_records` inside a
user-facing preview — the thing plan §14.2 forbids. Contract §9.4 allowed "bounded or absent", so it is absent,
recorded in the audit row and here, and left to LS.18's query check. "Verified identifiers" are absent for the
same kind of reason: no such field exists on Lead/Contact/Account, and inventing one would be a schema change
this phase does not own.

**A hidden label is a hidden candidate.** Field ACL can hide `name` while leaving the record readable. The first
instinct — return the row with `label: null` — is worse than useless: a person cannot choose between records
they cannot tell apart, and the row would still confirm the record exists at that id. It is counted instead,
which makes `hiddenMatches` mean "matches you cannot act on", not just "matches you cannot read".

## 3. Verification

- `apps/api/test/lead-score-duplicates.test.ts` — **15 new tests** (4 pure, 11 API against the configured
  primary database):
  - pure: e-mail folding and refusals; the phone tail from five spellings plus three refusals; `domainOf` from
    URL/address forms plus refusals and the free-mail test; name collapsing;
  - API: exact e-mail match with the Lead's and Contact's `version`/`modified_at` and the `audit_log` count
    **unmoved**; the same number in three formats; organization by company **and** by domain; free-mail never
    an organization; stage reporting (`no_value`) and `requiresChoice: false` when nothing matched; the cap
    (26 matches → 10 returned, `bounded: true`); a record-ACL-hidden Contact counted and the payload asserted
    not to contain its id or name; field-hidden e-mail/phone masked, an unnameable candidate withheld; the
    capability door (`403 {capability:'convertPreview'}`); the feature door (off → `LEADSCORE_MODULE_DISABLED`
    naming `duplicateDetection`, and back on); a Lead under `Lead:read own` that the caller does not own →
    **404, not an empty list**.
- All twelve LeadScore API files together — **263 passed / 0 failed**. The four retargeted assertions in
  `lead-score-module.test.ts` are `implementedPhases` (exact list, +LS.7–LS.11), the pending-feature list
  (`duplicateDetection` moved to the shipped loop, `fieldMapping` takes its place as the example of a stored
  switch whose phase has not shipped), the `effective`-switch example (now `fieldMapping` / `19-LS.12`), and the
  OpenAPI path list (+`action/conversion/candidates`).
- Full `npx vitest run` — **2,898 passed / 34 failed across 203 files**: the +15 over LS.10's 2,883 is exactly
  this suite, the 34 are the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3,
  `crm-chat` ×3), and there are zero `lead-score` failures. Worker suite **210 passed / 0 failed** across 20
  files. `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` — **9 passed**, which is the
  settings screen rendering a feature whose `pendingPhase` just became `null`. `npm run typecheck`,
  `npx eslint` on every touched path, `pnpm --filter @carocrm/api build`.
- No migration: the resolver reads existing tables and adds no index — `idx_entity_records_type
  (entity_type, deleted_at)` is what keeps each scan type-filtered, and whether the attribute expressions deserve
  an index is LS.18's measurement.
- Residue: the suite deletes its Leads, Contacts, Accounts, `entity_links`, roles and users by exact id, restores
  the `leadScore` settings row, and warns if a query over the run marker finds anything.

## 4. What this phase does not claim

- **No user interface.** The plan puts target selection, the candidate list and the decision in the wizard
  (LS.14); this phase exposes the answer and its question, not a screen. The SPA shows nothing new.
- **No recording of the decision.** `selectedMatchIds`, `resultSummary.duplicateDecision` and the
  `duplicateOverride` audit note belong to LS.12's preview hash and LS.13's operation row (contract §9.5). Here
  the capability only decides whether `create_with_override` is *offered*.
- **No fuzzy suggestions, no "same person" heuristic beyond two exact keys.** A Lead whose e-mail and phone are
  both absent, and whose company differs in spelling, will show no candidate at all — and that is an honest
  "we could not tell", not an empty "you are unique". `stages` says which keys were unavailable.
- **No index and no change to the entity schema.** The scans are bounded but unindexed on their attribute
  expressions (the type index is the only help); a large `Contact` table is the case LS.18's query check has to
  measure before an index is added.
- **No deduplication across the conversion targets** — the resolver returns both Contacts and Accounts; which
  of them a given conversion needs is the preview's job (§5.1 of the contract), not this command's.
- **The decision is not enforced here.** `requiresChoice` is an answer to the client; the refusal to proceed
  without an answer is LS.12/LS.13's, and is asserted by their suites when they land.
- LS.12–LS.18 are not started.
