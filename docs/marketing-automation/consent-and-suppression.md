# Marketing Automation — consent, suppression, eligibility and public unsubscribe

**Delivered in:** Phase 19-MA.5 (this document) on the contracts declared in Phase 19-MA.2.
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.3, §5.3.1, §5.3.2, §6.3, §6.8, §9.3, §13, §15 (`19-MA.5`).
**Code:** [apps/api/src/marketing-automation](../../apps/api/src/marketing-automation) —
`marketing-identity.ts` (address digest, token primitives), `marketing-consent.service.ts`,
`marketing-suppression.service.ts`, `marketing-eligibility.service.ts`,
`marketing-public-token.service.ts`, and the tables in `marketing-automation-domain.ts`.

The rule this document exists to protect (§0.1 rule 8): **no path may decide "may I mail this person" except
`evaluateRecipientEligibility`.** Not the UI, not a workflow, not a journey action, not a manual retry, not
the API. A second implementation is how an opted-out person gets mailed.

## 1. Recipient identity: a keyed digest, never a copied address

Marketing records (`MarketingConsent`, `MarketingSuppression`, `MarketingPublicToken`, snapshot entries) store
`emailHash`, and the plaintext address stays on the canonical `Contact`/`Lead` where the platform's field ACL
already governs it.

- Normalisation first: trim + lowercase ([`normalizeEmailAddress`](../../apps/api/src/marketing-automation/marketing-automation-domain.ts)).
- Digest: HMAC-SHA256 keyed with `ENCRYPTION_KEY` when configured; without a key it degrades to a *salted but
  unkeyed* SHA-256, which dictionary attacks can invert for common addresses.
  `identityStrength()` reports the mode and the module health endpoint surfaces it — an operator is never left
  believing addresses are protected when they are not.
- A caller who supplies an `emailHash` directly must supply this platform's 64-hex digest; anything else is
  refused, so no foreign or attacker-chosen identity can be planted.

## 2. Consent states

`Unknown`, `PendingConfirmation`, `Consented`, `OptedOut`, `Suppressed`, `Invalid`
(`CONSENT_STATUSES`). Only `Consented` authorises a marketing send (`CONSENT_GRANTING_STATUSES`).
**`Unknown` is a real state and never means "assume yes"** (§5.3 invariant 5).

| From | May move to |
| --- | --- |
| `Unknown` | `PendingConfirmation`, `Consented`, `OptedOut`, `Suppressed`, `Invalid` |
| `PendingConfirmation` | `Unknown`, `Consented`, `OptedOut`, `Suppressed` |
| `Consented` | `OptedOut`, `Suppressed`, `Invalid`, `Unknown` |
| `OptedOut` | `Consented` (re-consent, see §4), `Suppressed` |
| `Suppressed` | `OptedOut` only — a suppressed person is never flipped straight back to `Consented` |
| `Invalid` | `Unknown`, `Consented` |

`checkConsentTransition` refuses an illegal move with `CONSENT_TRANSITION_NOT_ALLOWED`; a no-op
(`from === to`) is allowed so a retried webhook or form post is not an error.

Channel: **Email only** in this release (§3.2) — a request for another channel is refused, not ignored.
Purposes are the campaign purposes: `Newsletter`, `ProductMarketing`, `EventUpdate`, `ServiceNotice`.
Consent is per address × channel × purpose, so leaving `EventUpdate` on does not re-open `Newsletter`.

## 3. Recording a decision

`POST /api/v1/MarketingAutomation/action/consent` → `MarketingConsentService.record`:

1. resolve the identity (address or digest),
2. replay check: a matching `idempotencyKey` in the history returns the original answer with
   `changed: false, idempotent: true` and writes nothing,
3. transition check,
4. no-op check: a mutation that would not change the state returns the current view, no new history row,
5. re-consent evidence (§4),
6. caller's `create`/`edit` permission on `MarketingConsent` is asserted, then the row is written under the
   module identity so an anonymous public unsubscribe and a marketer's manual record take one code path,
7. in the same transaction: consent row + `MarketingConsentEvent` (prior state, new state, actor and actor
   type, source, basis, reason, `occurredAt`, idempotency key) + the
   `marketingAutomation.consent.changed` outbox event.

The outbox payload carries the consent id, purpose, channel, from/to, source and actor only. **No address, no
hash** — a hash of a normalised address is already an identifier and does not belong in every consumer's store
(§7.3, §9.3).

Sources (`CONSENT_SOURCES`): `WebForm`, `PreferenceCenter`, `UnsubscribeLink`, `ProviderWebhook`,
`ManualRecord`, `Import`, `Api`, `SalesRep`, `System`.

## 4. Re-consent requires affirmative evidence

`OptedOut → Consented` and `Suppressed → Consented` are refused unless the request carries **both** a `basis`
and a `reason` naming the evidence
(`CONSENT_RECONSENT_EVIDENCE_REQUIRED`, [marketing-consent.service.ts](../../apps/api/src/marketing-automation/marketing-consent.service.ts)).
A preference-centre toggle alone can never undo an opt-out; the operator has to say what the new evidence is,
and that sentence lands in the append-only history.

## 5. Suppression

`MarketingSuppression` is a tombstone per address × channel × scope. Scopes: `Global`, `Channel`, `Purpose`,
`TargetList` — a `Purpose` block must name the purpose and a `TargetList` block must name the audience, both
checked server-side.

| Reason | Overridable by a fresh opt-in / an operator revoke |
| --- | --- |
| `LegalRestriction` | **no** (absolute) |
| `OperatorBlock` | **no** (absolute) |
| `Complaint` | **no** |
| `HardBounce` | **no** |
| `GlobalOptOut` | **no** |
| `InvalidAddress` | yes |
| `UnknownUser` | yes |
| `ManualBlock` | yes |

`SUPPRESSION_OVERRIDABLE` is the single source for that table; `revoke()` refuses a non-overridable reason
rather than letting a UI button erase a complaint. A complaint or a hard bounce therefore arrives as a
*suppression written by the module*, and `HardBounce`/`Complaint` are fed by provider events in MA.10 — until
then an administrator records them with `POST …/action/suppression`.

Severity order used when several facts apply to one recipient
(`SUPPRESSION_SEVERITY`): `LegalRestriction` → `OperatorBlock` → `Complaint` → `HardBounce` → `GlobalOptOut` →
`InvalidAddress` → `UnknownUser` → `ManualBlock`. The strongest fact becomes the headline code; every applied
block is still returned in `reasons`.

## 6. The eligibility matrix

`evaluateRecipientEligibility(input)` — evaluation order *is* the policy:

1. `RECORD_UNREADABLE` when the caller cannot read the person record: never a silent skip, never a count that
   leaks a record (§5.2, §9.2).
2. `NO_EMAIL_ADDRESS`, then `INVALID_ADDRESS`.
3. **Suppression wins** over consent, membership and automation — mapped by reason first, then scope, so
   `COMPLAINT_SUPPRESSED` / `HARD_BOUNCE_SUPPRESSED` are reported even when recorded at `Purpose` scope.
4. `EXCLUDED_BY_TARGET_LIST` — exclusion beats inclusion (§5.2).
5. Consent for this purpose: `OPTED_OUT`, `CONSENT_UNKNOWN`, `CONSENT_PENDING`. A campaign whose purpose is
   `ServiceNotice` and carries `serviceNoticeAcknowledged` is the only exemption (`consentRequired` override).
6. `FREQUENCY_CAP_REACHED` — a send-time policy, not a permission (cap 0 means "no cap").

`code` is the headline, `reasons` every block, and `terminal: true` for `GLOBALLY_SUPPRESSED`,
`COMPLAINT_SUPPRESSED`, `HARD_BOUNCE_SUPPRESSED` — codes no retry can lift, so a not-yet-submitted message
must be **dropped, not rescheduled** (§5.3).

`MarketingEligibilityService.decide` answers one recipient; `decideMany` preloads consent and suppression in
bulk (`findByAttrIn`) and then runs the same pure matrix, so a 10,000-recipient preview is a handful of queries
rather than 10,000. Campaign-level readiness is a *different* question and lives in
[checkCampaignSendable](campaign-lifecycle.md) — a dry run on a `Draft` campaign must still be able to answer
the per-person question.

## 7. Public links

`POST …/action/publicLink` (requires consent-write capability — a public unsubscribe must not become a free
utility endpoint) mints a 256-bit opaque token, stores only its SHA-256 digest, and **revokes the outstanding
tokens of the same scope for that identity** so an old printed link cannot outlive a new one.

| Scope | TTL | Can do |
| --- | --- | --- |
| `Unsubscribe` | 365 days | withdraw consent / globally suppress — never grant it |
| `Preferences` | 90 days | read the preference page, unsubscribe |
| `OptInConfirmation` | 7 days | the only public path that can **grant** consent |

Keeping the operation inside the token is what stops an unsubscribe link from becoming a preference-writing
link. An unsubscribe link keeps working for a year because a broken opt-out is worse than a long-lived URL, and
the action is idempotent and single-direction.

Public endpoints (`@Public()`, no login — an opt-out must not require a CRM account):

| Endpoint | Behaviour |
| --- | --- |
| `GET …/public/preferences/:token` | read-only state for the token's address; the address itself is never returned |
| `GET …/public/unsubscribe/:token` | renders the confirmation page and **performs nothing** |
| `POST …/public/unsubscribe/:token` | the deliberate act; `{ all: true }` (or a token with no purpose) is a global block, a purpose-bearing token withdraws only that purpose |
| `POST …/public/confirm/:token` | double opt-in confirmation for the purpose named in the token |

A GET that unsubscribed would silently opt people out of communications they never meant to leave: mail
clients and link-preview crawlers fetch URLs.

Guarantees:

- **No existence disclosure.** Unknown, expired, revoked, wrong-scope and over-budget all answer the identical
  `PUBLIC_TOKEN_INVALID` sentence, so these endpoints cannot test whether an address is in the CRM.
- **No enumeration.** 32 random bytes, digest lookup, constant-time comparison (`tokenMatches`), and a
  25-attempt budget per token (`MAX_PUBLIC_ATTEMPTS`) after which a live token is locked.
- **Idempotent opt-out.** Repeating an unsubscribe — including after the link was consumed — answers
  `unsubscribed: true` with `applied: false`, because an opt-out that errors on the second click is an
  opt-out that did not work.
- **Immediately effective.** A global unsubscribe writes a `GlobalOptOut` suppression *and* the purpose
  withdrawal, so the next audience preview drops that recipient without any further action (verified: a
  running campaign's eligible count fell from 1 to 0 on the second click).

## 8. Retention (§6.8)

`RETENTION_POLICIES` gives each class its own stated rule rather than one global number, because a suppression
tombstone must outlive the event stream it governs:

- `MarketingConsent` — `null`: evidence must outlive the campaigns it authorises.
- `MarketingSuppression` — `null`: **never timer-deleted**, or an opt-out silently expires.
- `MarketingConsentEvent` — 1825 days: the audit trail is the defence.
- `MarketingRecipientDelivery` 730, `MarketingEvent` 365, `MarketingProviderWebhookInbox` 30 (detail expires,
  aggregates are rebuilt from what remains; the delivery row keeps the eligibility decision, not the body).

`null` means "kept until a privacy-reviewed deletion", never "delete on a timer".

## 9. Boundaries the write guard enforces

`marketingAutomation.<Entity>Guard` on all nine entities refuses, on the generic record API:
portal/API-user access to consent and suppression writes; any client-set server-owned field; a `emailHash` that
is not a 64-hex digest; a `Purpose`/`TargetList` suppression with no purpose or list. Metadata marks those
fields `inEdit: false`, so the SPA never offers an input the server will refuse.

## 10. What is not wired yet

- **No send pipeline exists before MA.8/MA.9**, so the §15 acceptance line "a post-queue unsubscribe prevents
  a not-yet-submitted message from being sent" is guaranteed structurally, not operationally: the gate is one
  service, snapshots store the per-recipient decision and `terminal` marks what a retry must drop, and
  §0.1 rule 8 forbids any future send path from re-implementing it. Re-check this claim when MA.9 lands.
- **Provider-driven `HardBounce`/`Complaint` need MA.10's webhook ingestion**; until then those tombstones are
  written by an administrator.
- **Per-recipient personalisation and the actual email write are MA.6–MA.8.** Audience resolution and consent
  are live now, and `start` remains blocked by `PROVIDER_NOT_BOUND` until MA.7 binds a real adapter.
- SMS/WhatsApp channels are out of scope (§3.2); `CONSENT_CHANNELS` is `["Email"]` and the service refuses
  anything else.

## 11. Verification

- Unit: [apps/api/test/marketing-automation-domain.test.ts](../../apps/api/test/marketing-automation-domain.test.ts)
  — transition tables, the full eligibility matrix (order, headline vs. all reasons, terminal codes),
  suppression overridability, retention, token scopes and TTLs.
- API: [apps/api/test/marketing-automation-consent.test.ts](../../apps/api/test/marketing-automation-consent.test.ts)
  — 16 tests against the configured primary database: idempotent replay, no-op, illegal transition refusal,
  re-consent evidence, history contents, outbox payload privacy, public link issue/revoke/scope/expiry,
  unsubscribe `all` vs. purpose, anonymous GET with no `Authorization` header, attempt budget, and the record
  and field ACL boundaries. `MAIL_TRANSPORT=memory` is forced in the test environment; no message is sent.
  Cleanup removes the records the run created by exact id, **and** the rows only the services write
  (`TargetListEntry`, consent, history, suppression, public token, audience links) by the run's own list ids
  and by the digest of an address only that run used — verified to leave zero live marketing rows, zero
  orphan membership rows, zero orphan links and zero undispatched events in the configured database
  (AGENTS.md §3.3).
- Browser: the public preference page at `/marketing/preferences?token=…` renders the four purposes with their
  states and the expiry line; unsubscribing there flipped consent to `OptedOut` and the campaign's audience
  preview dropped to zero eligible in the same session.
