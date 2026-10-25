# Phase 19-LS.16 — Optional Opportunity conversion: completion report

`PLAN_Phase_19_LeadScore.md` §7.2, §7.4, §11.4, §16 (`19-LS.16`); audit §11 `LS.16`, decision D5; contract §5.1
row 8, §6.2 case 2, §8.4, §13.1; compatibility `docs/compatibility/lead-score.md` §2.4, §4.1, §5.2, §8.

**Exit criterion (plan §16):** *Opportunity create/link inside the same command, Sales stage semantics
untouched.* The suite asserts both halves against the public routes: a conversion that names all three targets
creates the deal with the operation's `accountId` and the new Contact in `contactIds`, the Lead stores
`convertedOpportunityId`, the operation and its audit view name `createdOpportunityId`, and the deal's `stage`
is the kernel default while `amount`/`probability` stay as Sales left them; a **linked** deal keeps its people
(the Contact is appended, not substituted), its stage and its amount, and a Quote that already names it keeps
its `opportunityId`, `accountId` and state. Nothing in the module writes stage, amount, close date or a Sales
document — the only Opportunity fields it ever sets are the two relationships contract §6.2 assigns.

## What changed

### Command (`apps/api/src/lead-score/lead-conversion.service.ts`)

- `work()` resolves the third preview target and applies it **after** the Account and Contact, so their ids are
  the link values: `applyTarget(opportunity, 'Opportunity', plan, { accountId, contactId })`.
- `applyTarget` (now typed by `MappingTarget` and taking a `links` object) creates an Opportunity with
  `accountId` and `contactIds: [contactId]` when those exist, and links one by patching `accountId` and
  **appending** the Contact to the existing `contactIds`. No stage, amount, close date, probability or owner is
  written. The Contact re-parent rule (§6.3) is unchanged and still Contact-only; the Opportunity's Account is
  the operation's by policy and was disclosed by the preview (below).
- The Lead patch sets `convertedOpportunityId`; the operation row and `ConversionResultView` carry
  `createdOpportunityId` / `linkedOpportunityId`; `resume()` accounts for a created deal the same way it does
  for the other two targets.
- **Duplicate overrides skip Opportunity**: the resolver has no Opportunity stage, so a hidden Contact/Account
  match must not demand an override that means nothing for the deal.
- `affordance()` now also answers `convertedOpportunityId` and `targets` — `conversion.targets` minus any type
  whose feature is not effective. The wizard renders its rows from that list (see below).

### Preview (`apps/api/src/lead-score/lead-conversion-preview.service.ts`)

- `opportunity_created` is produced when the request **creates** an Opportunity (the contract's condition), so
  the person acknowledges a deal whose name and stage the review already shows.
- A **linked** Opportunity whose `accountId` differs from the chosen existing Account gets a `conflicts` entry
  for `accountId` marked `readOnly: true` (new optional flag on `FieldConflict`) — a before/after with no merge
  checkbox, because there is nothing per-field to opt into; the opt-out is choosing the deal's own Account. The
  conflict also raises `field_merge`, whose wording ("some values differ from the linked record") is accurate.
- A switched-off `opportunityConversion` now answers `LEADSCORE_TARGET_DISABLED {state:'notEnabled'}` (the
  pending-phase branch remains for a future build that re-marks the phase).

### Audit (`apps/api/src/lead-score/lead-conversion-audit.service.ts`)

`OperationView` and the retry accounting include the Opportunity id pair: an operation that names a created or
linked deal is never treated as "wrote nothing" by a retry.

### Screen (`apps/web/src/components/LeadConversionWizard.tsx`, `apps/web/src/api/types.ts`)

- The wizard's target rows come from the affordance's `targets` (known types filtered), with an Opportunity
  choice, its own picker, and generic helpers for the three `ChoiceState` slots.
- The result step lists Created/Linked Opportunity with links; the Conversion card links
  `convertedOpportunityId` once converted; the metadata **Converted To** panel already showed the field.
- A read-only conflict renders the before/after plus "this changes when the conversion runs" instead of a merge
  checkbox. New i18n keys in `en`/`vi`: `convertedOpportunity`, `createdOpportunity`, `linkedOpportunity`,
  `relationshipChange` (the `target.Opportunity` and `confirm.opportunity_created` strings already existed).
- `LeadConversionAffordance.targets` and the result's Opportunity ids are typed on the client.

### Module

`features.opportunityConversion` flipped to delivered (`pendingPhase: null`) and `19-LS.16` added to
`implementedPhases`. Only `aiInsight` (19-LS.17) remains pending.

## Verification

Commands run (configured primary database only; no migration, no new database):

| Check | Result |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-*.test.ts` | **314 passed / 0 failed** across **15 files** (LS.16 added 3: Opportunity create, Opportunity link + disclosure, affordance `targets`) |
| Full `npx vitest run` | **2,949 passed / 34 failed** across **206 files** — the 34 in the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3) and **zero `lead-score` failures**; the +3 are this phase's new tests |
| Worker suite (`npx vitest run --config apps/worker/vitest.config.ts`) | **210 passed / 0 failed** (20 files) |
| `npx playwright test e2e/lead-score.spec.ts e2e/lead-score-admin.spec.ts e2e/lead-conversion.spec.ts` | **16 passed** (49 s): the 7 conversion tests including the new Opportunity one |
| `npm run typecheck` | clean |
| `npx eslint` on every touched path | clean |
| `pnpm --filter @carocrm/api build`, `pnpm --filter @carocrm/web build` | both succeed |
| Migration | none |

API coverage details (the 3 new tests in `apps/api/test/lead-score-conversion.test.ts` and the retargeted
preview test in `apps/api/test/lead-score-conversion-preview.test.ts`):

1. **Create:** Contact + Account + Opportunity in one conversion → `200`; Lead `convertedOpportunityId`; deal
   `accountId`/`contactIds`; name `${lastName} — ${company}`; `stage = Qualification`; `amount`/`probability`
   absent; operation row and audit view both name the created deal.
2. **Link:** a deal owned by another Account with an existing contact, a Quote naming it, and a conversion that
   links a *different* existing Account → the preview contains the read-only `accountId` conflict and
   `field_merge`, the result is `linkedOpportunityId`, the deal moves to the operation's Account, its
   `contactIds` contains both the old and the new Contact, its stage/amount are unchanged, and the Quote keeps
   its `opportunityId`, `accountId` and `draft` state.
3. **Affordance:** `targets` is `['Contact','Account','Opportunity']` with the switch on and
   `['Contact','Account']` with it off, while `canConvert` stays true.
4. **Preview refusal:** a switched-off Opportunity is `422 LEADSCORE_TARGET_DISABLED {state:'notEnabled'}`
   (previously `pending`/`19-LS.16`), and once the switch is effective the preview proposes the composed name,
   reports no required gap, and includes `opportunity_created`.

Browser: the new Playwright test drives the wizard with three targets, reads the confirmation and composed
deal name from the review, converts, checks the result's Opportunity link, the card's "Open the Opportunity"
link, and reads the stored deal back (Account, Contact, `Qualification`). Fixtures and conversion-created
targets were removed after the run; the append-only operation rows, outbox events and targets from every run of
the session were swept at the database level by the `E2E_LS14_` marker (33 records, 18 operations, 18 events;
the final marker queries return zero live records, zero operations and zero events).

## Notes and limits

- **No Sales semantics were duplicated.** There is still no `OpportunityService` in this build (audit §1.2);
  the deal is created through `EntityCrudService` exactly like a manual create, and the kernel's `stage` default
  is what fills the enum. `SalesDocumentService.createFromOpportunity` was not touched.
- **The Account disclosure is one-directional.** A linked deal moving to an existing Account shows the
  before/after. When the operation *creates* the Account, the review shows "Create new" on that row and on the
  deal's relationship tag, but there is no second id to put beside the old one; the move is visible, not
  spelled out as `old → new`. And when the actor's field ACL hides `Opportunity.accountId`, the current value is
  absent from the preview by design, so there is nothing to show — the relationship tag still names the Account
  the deal will carry.
- **No amount/close-date entry in the wizard.** The contract's `createDefaults` surface remains the map's
  template plus the metadata defaults; a deal created by conversion is `Qualification` with no amount, and the
  person edits Sales fields on the record afterwards. That keeps this phase inside the exit criterion (Sales
  owns them) rather than growing a second Sales form.
- **Opportunity links still need `edit` on the record** for the relationship write; the preview checks
  `Opportunity:read` for a link (contract §5.1), so a caller who may read but not edit gets a
  `failed_final/forbidden` from the canonical path rather than a preview refusal — the same shape LS.13 has for
  a Contact link without `edit`.
