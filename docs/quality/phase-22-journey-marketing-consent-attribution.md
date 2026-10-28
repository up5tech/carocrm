# Phase 22.12 — Journey: marketing consent, a campaign send, and what the provider says afterwards

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.5 (steps 1–10) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-marketing-consent-attribution.test.ts` (11 ordered steps)
> **Depends on:** `docs/quality/phase-22-journey-lead-to-customer.md` (22.8), `docs/quality/phase-22-idempotency-retry.md` (22.7)
> **Status:** Implemented and verified — the focused journey and the full `pnpm verify` gate both pass.

---

## 1. The journey in one sentence

A person consents, a campaign is built around them, the audience is validated and the suppression list is
reviewed, the send is sealed-approved-queued — and **the consent and suppression gates are asked again at the
last moment before a message is handed to a provider**, so somebody who opts out between the queue and the
wire is not mailed. The provider then talks back — delivered, opened, clicked, bounced, complained,
unsubscribed — and every one of those arriving twice is still one event and one counter. A conversion is
reported as a model with a caveat, not as proof of causation, and Lead Score reads only the engagement the log
really holds.

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| A provider that is **live** but has no socket | an in-process `ScriptedProvider` registered on `MarketingProviderRegistry` (`mode: 'live'`), which records every message it is handed | **Required** — `submit()` refuses anything whose adapter is not live (`PROVIDER_NOT_BOUND`), so this is the only way to reach a real send without mail |
| A sender identity | a row in `email_accounts` (there is no HTTP route for it), named as the campaign's `emailAccountId` | **Required** — otherwise `SENDER_REQUIRED` blocks the campaign |
| The Marketing settings | `features: { campaigns, templates, audience }`, `provider.key` = the scripted key, `provider.testSend.allowedRecipients`, `safety.globalSendPaused: false` | **Required** — snapshotted and restored |
| The webhook door's secret | `MARKETING_WEBHOOK_SECRET` set before the app boots, restored in `afterAll` | **Required** — with no secret the door fails closed and records every event as `SECRET_NOT_CONFIGURED` |
| An address identity | `MarketingConsentService.identity(address)` — the same keyed digest the platform uses, never re-implemented in the test | **Required** — consent, suppression and the ledger all key on it |
| A Lead Score model | a model plus one `marketingEvents` rule (`eventCount ≥ 2` on `opened`), published **and selected as the active model** in the Lead Score settings | **Required** for the engagement leg only |
| Two principals that are not the administrator | a role that may read Campaigns but no Contacts, and a role that may read nothing | **Required** for the metrics leg |

## 3. The test-owned data

Every row carries `AGENT_TEST_<runId> …` or is bound to this run's unique ids: the sender account, the
template, the two audiences, the campaign, the two sends and their transitions, the recipients' contacts and
the two Leads the public form created, the consent decisions and their history, the suppressions, the public
tokens the delivery minted, the delivery ledger rows, the provider events, the inbox rows, the durable jobs,
the Lead Score model and rules, and the two test users with their roles. `afterAll` removes them in the order
the foreign keys demand and then **asserts** that nothing carrying this run's marker, campaign, provider name
or send id is left.

Nothing is sent: the provider is an object in this process, the mail transport is not exercised, and the
addresses are `@example.test`.

## 4. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | Consent is recorded through the consent service for three people, and one of them is later withdrawn | a decision answers `changed: true`; the same `idempotencyKey` answers `idempotent: true` and leaves **one** history event; the consent row holds a 64-hex identity and **not** the address; the trail shows `Unknown → Consented` |
| 2 | The public form collects a person, their company, their UTM trail and the campaign that sent them | the Lead really carries `company`, `utmSource/Medium/Campaign`, `campaignId` and `formIntakeKey` (this was G24: all six were silently deleted); the same intake key with a **corrected address** returns the first Lead and creates no second record; a stranger's unknown `campaignId` is dropped rather than breaking the submission; a record-API write of the intake evidence is refused with `MARKETING_INTAKE_FIELDS_SERVER_OWNED` |
| 3 | The audience is composed, one address is blocked by hand, and the campaign is validated | the preview categories say `eligible`, `consentUnknown`, `optedOut`, `excludedBySegment`; the validation report is `valid` with a 32-hex `validationHash`; **`start` is refused with `PROVIDER_NOT_BOUND` while no live provider is bound**, and succeeds once one is |
| 4 | The send is decided: dry run → validate → approve → schedule → queue | the dry run forecasts the audience and a `materialHash` without writing; `validate` freezes a final snapshot, seals a template revision and materialises six ledger rows; the approval binds to the validation hash; `queue` returns a durable `marketing.deliveryBatch` job — and the provider was handed **nothing** by any of it |
| 5 | The provider reports an unsubscribe for somebody whose row is already sitting there as `Eligible`, twice | one inbox row, `duplicate: true` on the replay, exactly **one** `GlobalOptOut` suppression sourced from `ProviderWebhook`; when the batch runs that person is `Blocked` and never reaches the adapter, the person with no consent is `Blocked`, the hand-blocked address is `Blocked` as `suppressedGlobal`, the excluded person is `Blocked` as `excludedBySegment`, and only the consented people are `Sent`; the mailed message carries the recipient's own preference token, not the preview sentinel |
| 6 | delivered, opened, clicked — each twice; a forged delivery; a bounce and a complaint | one `marketing_events` row per provider event id; the forged delivery is recorded as `rejected` and does **not** occupy the genuine event's key (the same id is accepted afterwards); a delivery with no timestamp header is accepted regardless of its age — the door's freshness rule only applies when the caller supplies one (G33); the hard bounce and the complaint each create their own suppression |
| 7 | A second send, and the provider fails transiently for one recipient | the failed attempt leaves that row `Queued` with `PROVIDER_TEMP_FAIL` and hands the adapter nothing for them; the next sweep sends **exactly one** message; a third sweep of the finished send sends nothing further |
| 8 | A test send to an allowlisted colleague, then to a person who opted out | the colleague receives one message marked as a test (`X-Marketing-Test`, prefixed subject); the opted-out address is refused with `TEST_RECIPIENT_SUPPRESSED` and receives nothing; the campaign's own counters still show the four real events — a test send is not a campaign send |
| 9 | A conversion outcome, reported | the attribution report names the model, counts **one** conversion, carries an `asOf`, and its note refuses causation ("not additive across campaigns" / "selects a single touch per conversion"); the same `correlationId` reported again is `duplicate: true` and does not move the count (G32); no amount was supplied, so the report claims no revenue; the funnel lists the normalised stages in the order they arrived |
| 10 | Lead Score reads the engagement the log holds | two opens and a click for the form's Lead put the score at 40 from the `opened · eventCount ≥ 2` rule; replaying every stored event id is `duplicate: true` and leaves the score at 40; a `deferred` provider event — not an engagement type — never moves an engagement rule |
| 11 | The metrics are read by two principals who are not the administrator | a caller who may read Campaigns but no Contacts gets the recipient ledger **counted, not named** (`hidden > 0`), and the event log masks the recipient identity and digest for the same records; no report anywhere carries the address itself; a caller who may not read the campaign is refused the report |

## 5. Expected persisted state and evidence

| What | Where | What the journey asserts |
|---|---|---|
| the consent decision and its trail | `entity_records` `MarketingConsent` / `MarketingConsentEvent` | keyed by `emailHash`; one live row per identity+purpose; one event per real change |
| the suppression | `entity_records` `MarketingSuppression` | created by the provider's unsubscribe/bounce/complaint, `source: ProviderWebhook`, global scope |
| the frozen audience | `MarketingAudienceSnapshot` + entries | final snapshot at `validate`, identities as digests, never an address |
| the recipient ledger | `marketing_recipient_deliveries` | one row per resolved recipient and slot; `Eligible` before the wire; `Sent`/`Blocked`/`Queued` after, with the block code in `category`/`reasons`/`error_code` |
| the decision | `MarketingSend` + `MarketingSendTransition` | validation hash, sealed revision, approval, lifecycle stamps, ledger-derived counters |
| the provider's words | `marketing_provider_webhook_inbox` + `marketing_events` | one inbox row per delivery (a forged one under a `rejected:` key), one event per provider event id |
| the work | `jobs` (`marketing.deliveryBatch`) | queued by `queue`/`resume`, removed by exact id |
| the attribution | `marketing_events` `normalized_type = 'conversion'` | unique per (campaign, correlation id) by `uq_marketing_events_internal_attribution` |

## 6. Consent, suppression and the last responsible moment

`MarketingEligibilityService` is the single place that answers "may we send to this person", and
`MarketingDeliveryBatchService.submit()` asks it **immediately before handing the message to the adapter** —
after the emergency stop and the provider binding, before the links are minted. The forecast written into the
ledger at `validate` is a prediction; step 5 is the proof that the prediction is not trusted. The same gate
also refuses a *test* send to a suppressed address (step 8), which is the plan's acceptance sentence, and the
frequency cap is read from the ledger at the same moment.

## 7. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **The campaign reports answered any authenticated caller.** `action/campaign/:id/log`, `/stats`, `/attribution` and `/funnel` ran straight to aggregates over `marketing_events` with no campaign read check, and the log returned each recipient's record id and address digest — while its own documentation (`docs/marketing-automation/metrics.md` §2) promised "access is the campaign's own record ACL". Fixed here: the four reports now answer to that grant, and the log masks the recipient identity for records the caller cannot open, counting them as `hidden`, exactly as `action/send/:id/recipients` already did | High | Fixed (22.12) — `marketing-report-access.service.ts`; recorded as G31 |
| F2 | **A replayed attribution double-counted the outcome.** `POST action/attribution` inserted unconditionally, so the same `correlationId` from a retried job counted the conversion twice and added its amount to `influencedRevenue` twice — the one door Phase 22.7 had not covered | Medium | Fixed (22.12) — migration `084` partial unique index + atomic claim returning `duplicate: true`; recorded as G32 |
| F3 | **The marketing webhook door does not sign the body.** `verifySignature` compares the `x-webhook-signature` header to the configured secret itself, and the five-minute freshness window is only applied when the caller sends an `x-webhook-timestamp`. A captured request can therefore be replayed at any later time, and the door cannot prove the payload was not changed in transit — unlike the Voice and ESignature doors, which sign `timestamp + body` | Medium | Open — G33. Proven in step 6 so the behaviour cannot drift silently |
| F4 | **The public form's Lead write was silently truncated** (G24) and there was **no campaign↔Lead link** (G25). Both were deferred to this sub-phase. Fixed: `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` (a real link to `Campaign`) and `formIntakeKey` are declared Lead fields, the form writes the declared `company` rather than `companyName`, an unknown `campaignId` is dropped instead of breaking a public submission, and the intake evidence is refused to a record-API write (`MARKETING_INTAKE_FIELDS_SERVER_OWNED`) | Medium | Fixed (22.12) — additive metadata (JSONB attributes, no table change) plus the narrow write guard |
| F5 | **`influencedRevenue` reports `0`, not "unknown".** The attribution sum coalesces to zero, so a campaign with conversions that carry no amount looks like "zero revenue influenced" rather than "not measured" | Info | Not a defect — the report's `note` is what the plan asks for (a labelled model, not proof). Recorded so a reader does not over-read the number |
| F6 | **Attribution is one-way evidence.** The `conversion` row references the campaign and the outcome record; there is no relation record between a Campaign and a Lead beyond `Lead.campaignId`, and `recordAttribution` never validates that `referenceId` exists | Info | A design fact; F4 gives the Lead side a first-class link, and the report reads the event log |

## 8. Known limitations

1. This is an API journey, not a browser journey: it drives the public contracts the plan names.
2. The delivery provider is scripted **in this process**. A real provider's own event spellings, rate ceilings
   and credential behaviour are not certified here; `marketing-automation-provider.test.ts` covers the contract.
3. The steps are ordered on purpose — step 5 depends on step 4's ledger and step 10 on step 2's Lead.
4. No live worker, Redis or scheduler runs: the queue transport is real (a durable `jobs` row is written) and
   the batch is executed through its own authenticated route, the same one the worker's job calls.
5. The Lead Score leg needs the model to be **selected** as active, not merely published; a deployment that
   publishes without selecting still refuses to score (`LEADSCORE_NO_ACTIVE_MODEL`).
6. The journey proves the gate on the four report routes. Per-attribute field ACL on the recipient records is
   the platform's ordinary read path, already covered by the entity tests.
7. **One vitest process at a time.** This suite configures instance-wide rows — the `marketingAutomation` and
   `leadScore` settings documents — and restores them in `afterAll`. A second test process running against the
   same database at the same time can read the middle of that window, so suites that touch a settings row are
   only deterministic when they are not run in parallel with each other. (This is how the suite's own bug was
   found: it had been snapshotting a row named `marketing`, which is not the row's name, so nothing was ever
   restored.)

## 9. Evidence

| Command | Result |
|---|---|
| `pnpm exec vitest run apps/api/test/phase22-journey-marketing-consent-attribution.test.ts` | **11 passed** (the 11 ordered steps) |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| `pnpm exec tsc --noEmit -p tsconfig.json` | no diagnostics |
| `pnpm exec vitest run apps/api/test/marketing-automation{,-send,-delivery,-consent,-audience,-events}.test.ts apps/api/test/lead-score-engagement.test.ts` | **7 files, 109 tests passed** after the report gate, the intake guard and the metadata change |
| `pnpm exec vitest run apps/api/test/lead-score-schema.test.ts apps/api/test/marketing-automation-provider.test.ts` | passed once the `marketingAutomation` settings row was snapshotted under its real name (§8.7) and the Lead detail guard was told about the `Acquisition` panel |
| Final `pnpm verify` | Passed — lint 0/0, typecheck clean, `pnpm test` 242 files / 3,252 tests, `pnpm test:web` 5 files / 21 tests |

**Database discipline.** The configured primary database only (AGENTS.md §3.1). The one schema change is
additive — a partial unique index over rows that did not exist before it — and was reviewed before it was
applied; no database, schema or container was created and nothing was truncated, dropped or reset. The
journey's own `afterAll` asserts that no row carrying its marker, campaign, provider name or send id survives.

**External effects.** None. The provider is an object in this process, `MAIL_TRANSPORT` is untouched, no SMTP
connection is opened, and every address is synthetic (`@example.test`).

## 10. Acceptance criteria (plan §13.5)

- [x] **Consent is checked server-side at the last responsible moment before outbound send.** An unsubscribe that lands after `queue` and before the batch leaves that recipient `Blocked` with a suppression of its own, while the consented recipients are mailed — and no caller reached the adapter except through `submit()`.
- [x] **Suppressed recipients receive no automated test message, and all provider behaviour remains simulated.** A test send to a suppressed address is refused with `TEST_RECIPIENT_SUPPRESSED` and the scripted provider recorded nothing for them; the provider never had a socket.
- [x] **Suppression wins over a queued send, retries never duplicate, attribution is labelled rather than causal, and the metrics respect the caller's rights.** Steps 5, 7, 9 and 11 each; the attribution report's own `note` is what says so.
