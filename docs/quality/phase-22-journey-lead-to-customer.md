# Phase 22.8 — Journey: lead acquisition, scoring, qualification, and conversion

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.1 (steps 1–10) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-lead-to-customer.test.ts` (12 ordered steps)
> **Depends on:** `docs/quality/phase-22-contract-tests.md` (22.6), `docs/quality/phase-22-idempotency-retry.md` (22.7)
> **Status:** Implemented. The journey runs end to end against the configured primary database; the three acceptance assertions hold.

---

## 1. The journey in one sentence

A Lead arrives, the active model scores it, a campaign engagement moves its band to **Sales Ready** —
and **nothing happens**: no conversion, no Contact, no Account, no Opportunity, no access. Only when a
person explicitly previews and converts does the CRM create the identities, and only then can the
Sales module use them.

That gap between "the CRM knows this lead is worth talking to" and "the CRM turned this lead into a
customer" is the whole point of the journey, and it is the part that was never proven.

---

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| The `leadScore` settings row | enabled, with the feature chain `modelAdministration → scoring → {manualRecalculation, scoreExplanation, eventRecalculation, thresholdNotifications, engagementSignals}` and `fieldMapping → conversionPreview → leadConversion → {conversionRecovery, opportunityConversion}`, `duplicateDetection` on | **Required** |
| A published scoring model with three rules | created through the public record API, published through `POST /api/v1/LeadScore/action/model/publish`, then selected as `scoring.activeModelId` | **Required** |
| A campaign signal | a row in Marketing Automation's own `marketing_events` table (`recipient_entity_type='Lead'`, `recipient_entity_id=<lead>`, `campaign_id=<campaign>`), written exactly as the module writes it | **Optional** (a direct field change is the alternative the plan allows) |
| The Sales module | installed and reachable; the journey creates one quote through `POST /api/v1/Sales/document` | **Optional** — the journey proves the hand-off when it is there, and skips nothing else if it is not |
| Marketing Automation | **not required** for the journey: the campaign signal is a table row, not a campaign run | Optional |

## 3. The actors

| Actor | Rights | What the journey proves with it |
|---|---|---|
| The administrator | everything | the happy path |
| A restricted caller | `Lead/Contact/Account: read = own`, **no LeadScore right** | the convert command is refused with `AUTHORIZATION_DENIED` (403); the converted Contact is **missing** (404), not forbidden — the disclosure policy for a record the caller may not see |

## 4. The test-owned data

Every record carries the `AGENT_TEST_LS22_<base36>` marker: the Lead, the Contact, the Account, the
Opportunity, the conversion operation, the model, the three rules, the two campaign events, the
Sales quote and its product line, plus the role and the user the negative path needs. The cleanup
deletes **exactly those ids** (and the `entity_links` rows that touch them) — nothing is truncated,
reset or dropped.

## 5. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | A Lead is created through `POST /api/v1/Lead` | status `New`, `source` kept, `scoreStatus = not_scored`, `scoreBand = Unknown`, no conversion reference |
| 3 | The active model scores it (`POST /api/v1/LeadScore/action/score/recalculate`) | score 30, band `Cold`, `scoreStatus = current`, `scoreModelId` = the active model; the history has one row whose breakdown names the **rule**, and carries no Lead value |
| 4 | Two campaign `opened` events are seeded and the Lead is scored again | score 70, band `Hot`; the **same** inputs scored again leave the history length and the score unchanged — a repeated signal is not counted twice |
| 4b | The Lead's `industry` is changed directly and it is scored again | score 90, band `Sales Ready` |
| 5 | The journey checks what the band did **not** do | status is still `New`; no Contact, Account or Opportunity exists; the only reaction is the `leadScore.bandChanged.v1` event — there is no `lead.conversionSucceeded.v1` |
| 6 | The conversion is previewed | the preview returns a fingerprint and its confirmation types, and writes nothing |
| 7 | The conversion is executed | the Lead is `Converted` with `convertedAccountId` / `convertedContactId` / `convertedOpportunityId` / `conversionOperationId` / `convertedAt`; the Contact carries `accountId` → the converted Account, `leadSource` → the Lead's source, and the mapped fields; the Account carries the company and the industry; the Opportunity carries `accountId` and the new Contact, keeps `stage = Qualification` and **no amount** — the conversion writes no selling semantics |
| 8 | Sales creates a quote against the converted Account | `POST /api/v1/Sales/document` answers 201 and the quote's `accountId` is the converted Account — the hand-off is real |
| 9 | The conversion is replayed with the same operation key | the same operation id comes back; no second Contact, Account or Opportunity, and no second `lead.conversionSucceeded.v1` |
| 10 | The restricted caller tries to convert, then to read the result | 403 `AUTHORIZATION_DENIED` for the command; 404 for the Contact — the record is missing, not forbidden |
| 11 | A second Lead is previewed, changed, and then converted with the stale fingerprint | 409 `LEADSCORE_PREVIEW_STALE`, the Lead is still `New`, and no operation was recorded |
| 12 | The journey reconciles the events and the audit trail | exactly one `lead.conversionSucceeded.v1` for this Lead, carrying the three created ids; at least three `leadScore.updated.v1` rows, none of which carries the Lead's e-mail; the audit trail holds one row per converted field (`convertedAccountId`, `convertedContactId`, `conversionOperationId`) |

## 6. Expected persisted state and event history

| What | Where | What the journey asserts |
|---|---|---|
| the score projection | `Lead.scoreValue` / `scoreBand` / `scoreStatus` / `scoreModelId` / `scoreCalculatedAt` | the projection matches the last evaluation |
| the score history | `LeadScoreEvaluation` rows, readable only through `GET /api/v1/LeadScore/action/score/:leadId/history` | one row per **distinct** input set; a repeat adds none |
| the conversion record | `LeadConversionOperation` | `status = succeeded`, the plan and the created ids |
| the identities | `Lead.converted*Id` → `Contact` / `Account` / `Opportunity` | the links point at the records the conversion created |
| the events | `outbox_events` | `leadScore.updated.v1`, `leadScore.bandChanged.v1`, `lead.conversionSucceeded.v1`, plus the generic `entity.created` / `entity.updated` for the records |
| the audit trail | `audit_log` | one row per audited converted field; **no** row for `status` (it is not an audited Lead field) |

## 7. Deduplication and provider interactions

The journey makes **no provider call**: the campaign signal is a table row, the scoring model is
local, and the Sales document is local. The one interaction that *could* duplicate work is the
conversion, and the journey proves the deduplication key does its job (step 9). The conversion
operation's key is the caller's `operationKey`; the replay returns the stored result instead of
creating a second set of targets.

## 8. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **There is no qualification *state*.** The Lead's `status` enum has no `Qualified` value; qualification is the derived `scoreBand` | Info | Not a defect — a design fact. The journey proves step 5 as a **negative** assertion: a `Sales Ready` band changes nothing |
| F2 | **There is no Lead-level campaign link.** The Lead carries only the free-text `source`; the campaign↔Lead association lives in `marketing_events`, `MarketingConsent.campaignId`, `TargetListEntry` and the journey enrollment | Medium | The journey uses the free-text `source` and the `marketing_events` link (the association LeadScore actually reads). A first-class campaign link was deferred to 22.12 and is now declared: `Lead.campaignId` is a link to `Campaign` (gap G25, fixed in 22.12) |
| F3 | **The marketing form's Lead write is silently truncated.** `MarketingFormService.createLead` writes `companyName`, `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` and `formIntakeKey` — none of which the `Lead` entity declares, so `EntityCrudService.prepareWrite` deletes them. The company is lost (the field is `company`), the campaign reference never lands, and the form's intake-key idempotency lookup can never match | Medium | Recorded as gap G24 and deferred to 22.12, which fixed it — the five fields are declared, the form writes the declared `company`, and the intake evidence is refused to a record-API write (`docs/quality/phase-22-journey-marketing-consent-attribution.md` §7 F4) |

## 9. Evidence

| Command | Result |
|---|---|
| `npx vitest run apps/api/test/phase22-journey-lead-to-customer.test.ts` | **12 passed** (the 12 ordered steps) |
| `pnpm verify` | **green** — `lint` exit 0, `typecheck` exit 0, `test` 238 files / 3206 tests passed, `test:web` 5 files / 21 tests passed |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | clean |

**Database discipline.** The configured primary database only (`AGENTS.md` §3.1); no database, schema
or container was created; nothing was truncated, dropped or reset. Every row the journey created is
deleted by exact id, and the journey asserts its own side effects (a preview writes nothing, a
refused conversion writes nothing). A post-run query confirmed zero rows left under the journey's
marker.

**External effects.** None. No mail, no provider, no browser, no network.

## 10. Known limitations

1. **The journey is not a browser journey.** It drives the public API contracts, which is what the
   plan asks for (§13: "real user-visible behavior or public application contracts"); the wizard's
   own steps are covered by `e2e/lead-conversion.spec.ts`.
2. **The step order is the test's contract.** The twelve steps share state on purpose — that is what
   makes it a journey — so a failure in an early step cascades into the later ones. The steps are
   ordered `it`s inside one `describe`, and each states what the previous one left behind.
3. **The ESignature and Sales-document halves are not in this journey.** The journey stops at the
   quote (step 8). Signing a quote is 22.9's journey.
4. **The campaign signal is a table row, not a campaign run.** A full marketing journey — a campaign
   whose audience contains the Lead, whose signal reaches the score — is 22.12's job.

## 11. Acceptance criteria (plan §13.1)

- [x] **Score and conversion history match executed operations.** The score history holds one row per distinct input set and the repeat adds none; the conversion history is the operation row, and the audit trail holds one row per converted field.
- [x] **Canonical Lead, Contact, and Account identities remain linked correctly.** The Lead points at the created Contact, Account and Opportunity; the Contact points at the Account; the Opportunity points at both; and the Sales module can create a quote against the converted Account.
- [x] **Duplicate handling requires explicit policy and does not silently merge unrelated people or organizations.** The conversion is previewed and acknowledged; the duplicate-override path is the caller's explicit choice; and the replay of the same key creates nothing.
