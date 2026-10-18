# Marketing Automation — campaign lifecycle

**Delivered in:** Phase 19-MA.2 (contracts), Phase 19-MA.3 (lifecycle and validation), Phase 19-MA.4
(audience resolution and preview), Phase 19-MA.5 (the consent gate behind `CONSENT_NOT_CONFIGURED`) and
Phase 19-MA.8 (the send definition a campaign schedules *into* — see
[`send-definitions.md`](send-definitions.md)).
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.1, §5.2, §8.2, §8.4, §15.
**Code:** [apps/api/src/marketing-automation](../../apps/api/src/marketing-automation) —
`marketing-automation-domain.ts` (the tables below), `marketing-campaign.service.ts` (commands),
`marketing-campaign-validation.service.ts` (the gate), `marketing-audience.service.ts` (resolution and
preview), `marketing-automation-write-guard.service.ts` (the record-API boundary).

## 1. States

`Draft → Scheduled → Running → Paused → Completed`, plus `Failed` and `Archived` (§5.1 "where justified").

| Status | Meaning | Live? |
| --- | --- | --- |
| `Draft` | Being prepared. Nothing is queued, nothing is sent. | no |
| `Scheduled` | Configured and scheduled to run. Recipients are not yet being produced. | yes |
| `Running` | The campaign is active. | yes |
| `Paused` | Active but deliberately held by an operator. | yes |
| `Completed` | Finished normally. | no |
| `Failed` | Stopped by the system. **No user command produces it** — it arrives with the delivery runtime (MA.9). | no |
| `Archived` | Retired and read-only. Terminal: no edge leaves it. | no |

## 2. Legal edges

```text
Draft      → Scheduled, Running, Archived
Scheduled  → Draft, Running, Archived
Running    → Paused, Completed, Failed, Archived
Paused     → Running, Completed, Failed, Archived
Completed  → Archived
Failed     → Archived
Archived   → (terminal)
```

A no-op (`from === to`) is allowed and changes nothing, so a retried command is never an error.

## 3. Commands

Every status move is a **named command**; none is a field write.

| Command | From | To | Gate |
| --- | --- | --- | --- |
| `schedule` | Draft | Scheduled | send-readiness report must be clean |
| `unschedule` | Scheduled | Draft | — (clears `scheduledAt`) |
| `start` | Draft, Scheduled | Running | report must be clean |
| `pause` | Running | Paused | — |
| `resume` | Paused | Running | report must be clean |
| `complete` | Running, Paused | Completed | — |
| `cancel` | Draft, Scheduled, Running, Paused | Archived | **a reason is required** (§10.2) |
| `archive` | Completed, Failed | Archived | — |

`POST …/action/campaign/:id/transition` accepts `command`, or a `to` **only where exactly one command owns
that move**. `Running` (`start` or `resume`) and `Archived` (`cancel` or `archive`) are therefore refused
without a named command: the caller has to say which operation it means, because the two have different
checks. A command and a `to` that disagree are rejected rather than silently reconciled.

## 4. The send-readiness gate (§5.1)

> "Prevent a campaign from becoming Scheduled/Running unless audience resolution, consent policy, template,
> sender/provider, tracking settings and required content validation pass."

The gate is **per target state**, which is what lets MA.3 ship a real lifecycle while the later phases attach
a live provider:

* **configuration findings** apply to `schedule` — classification, purpose, schedule order, time zone,
  audience and content references the actor can actually read, sender existence, tracking choices;
* **execution findings** additionally apply to `start`/`resume` **of a campaign that could send**
  (`Email`, `Newsletter`, `Informational`): `PROVIDER_NOT_BOUND`, `GLOBAL_SEND_PAUSED`.

Audience resolution (MA.4) and the consent gate (MA.5) are live, so they are no longer blockers: a campaign
that is configured, aimed at a resolvable audience and addressed to consenting people can pass everything this
system decides — and still must not run until MA.7 binds a real provider. `CONSENT_NOT_CONFIGURED` survives as
a **warning** for a campaign whose audience has no recorded consent at all, because such a campaign is
scheduleable but will send to nobody; the preview is the tool that proves it.

A campaign typed `Other` is the documented non-email family: its `Running` is a programme being underway, so
it is validated as configuration only. Nothing about it can put a message on the wire.

Findings are returned as `{ code, level, message, field }` with `blockers` and `warnings` kept separate
(§8.4), plus `validationHash` — a fingerprint of the facts the decision was made on, so a later material
change is detectable (§5.5). The report a `validate` command stores on the record is never trusted by a
subsequent command: the gate is recomputed against the row as it stands.

### Consent cannot be sidestepped

`purpose` (not `type`) decides whether marketing consent is required. `ServiceNotice` is the only exempt
purpose and demands a separate, explicit `serviceNoticeAcknowledged` on the campaign, so the exemption is an
attributable decision rather than a dropdown default (§5.1, §9.3). A `Newsletter` campaign carrying the
`ServiceNotice` purpose is a blocker.

## 5. Audience resolution, preview and snapshots (MA.4)

A campaign points at **audience definitions**, never at recipients: the many-to-many relations
`includedTargetLists` and `excludedTargetLists` on `Campaign`. `TargetList` owns the *rule*; `TargetListEntry`
owns a *named membership* (`memberType` + `memberId`, source `Manual|Import|Criteria|Api|Journey`).

**Two membership modes.**
`static` resolves through the list's own membership rows. `dynamic` resolves a stored, versioned criteria
document through the platform query engine — nothing else.

**Criteria are validated before anything runs** (`marketing-audience-criteria.ts`, `CRITERIA_VERSION` 1):
one clause per segment entity type (`Contact`, `Lead` — the only types that can be mailed), at most 20 filters
per clause, at most 50 `in` values, values capped at 512 characters, field names matched against the entity's
own metadata and read permission, an operator set taken verbatim from the query engine's vocabulary and
narrowed by the field's declared type (`equals`/`contains`/`between`/…), audit columns `createdAt`/`modifiedAt`
capped to date operators, and a deny list (`id`, `deletedAt`, `password`, `apiKey`, `token`, `tokenHash`,
`emailHash`, `teams`, `assignedUsers`). A rejected document names every problem it found. **No user-supplied SQL
is constructed or executed at any point** — resolution goes through `EntityCrudService.list`, so record-level
ACL, field masking and serialisation stay in the one place (§5.2, AGENTS.md §5.2).

**Composition** (`MarketingAudienceService.compose`): the included lists are unioned and de-duplicated by
`entityType:entityId` (a second mention is recorded as a `source`, not as a second person); every excluded list
is applied **by record key *and* by address identity**, so a person who exists as both a Contact and a Lead is
excluded from both — the thing being suppressed is the recipient, not the row. Exclusion always wins over
inclusion. Candidates are then ordered by `recipientPrecedence` (Contact before Lead, then oldest key), which is
the documented de-duplication rule for one message per normalised address; records are never merged and
identity is never rewritten.

**Classification** maps each candidate to exactly one headline category, in this order: excluded → duplicate
record → the eligibility code (`optedOut`, `consentUnknown`, `suppressedGlobal`, `noEmailAddress`, …, see
[consent-and-suppression.md](consent-and-suppression.md) §6) → duplicate address → `eligible`. The counts
therefore add up to the resolved population and an operator can see *why* eligible < resolved.

**Cost ceiling.** `settings.limits.maxResolveRecords` (default 10,000) bounds every resolution. Hitting it sets
`truncated: true` and pushes a note naming the list and the ceiling, so a partial audience is never silently
read as the whole audience.

`GET …/action/campaign/:id/audiencePreview` returns `{ campaignId, purpose, status, resolved, eligible,
categories, samples, notes, truncated, limit, generatedAt }`. `samples` is capped at 10 rows and only ever
holds records the caller may actually read; counts come from the ACL-filtered set, so a preview cannot disclose
records or addresses the caller may not see. `refresh` is the only command that recomputes a list's stored
counters — no read path writes.

**Snapshots.** `POST …/action/campaign/:id/audienceSnapshot` (`preview` | `final`, default `final`) freezes the
composition: a `MarketingAudienceSnapshot` header (include/exclude ids, `compositionHash`, resolved/eligible/
entry counts, per-category tally, purpose, actor, `generatedAt`, `previousSnapshotId`) plus
`marketing_audience_snapshot_entries` rows written in the same transaction
(`on conflict (snapshot_id, entity_type, entity_id) do nothing`, so a retried command cannot double-insert).
Entries carry the **digest**, never an address. A snapshot is immutable: editing the audience afterwards
generates a *new* snapshot, and the send definition a later phase runs against will be a snapshot, not a live
query — that is what makes "the audience a send used" reconstructable after the fact (§6.1).

## 6. What the record API may not write

The write guard refuses a client that sets any of: `status`, `scheduledAt`, `startedAt`, `pausedAt`,
`resumedAt`, `completedAt`, `cancelledAt`, `archivedAt`, `failureReason`, `validationReport`,
`validationHash`, `lastValidatedAt`, `duplicatedFromId`, `lastErrorCode`. A new campaign is created as
`Draft` or not at all. `CampaignTransition` and `TargetListEntry` rows are module-written only.

These fields are also `inEdit: false` in metadata, so the SPA never offers an input the server will refuse.

MA.4 and MA.5 extended the same boundary to the resolver and to consent provenance
(`SERVER_OWNED_FIELDS_BY_ENTITY`): `TargetList.refreshStatus|lastRefreshedAt|resolvedCount|criteriaHash`,
`TargetListEntry.addedById|addedAt|source|removedAt|removedById`, the consent stamps
(`confirmedAt`, `withdrawnAt`, …) and the acting identity, and a suppression's provider provenance and
revocation stamps. A `confirmedAt` someone could type in is a forged opt-in, so it is derived from the
transition that actually happened. `MarketingConsent`, `MarketingSuppression`, `MarketingPublicToken`,
`MarketingAudienceSnapshot` and `MarketingConsentEvent` are internal-only entities: no client writes them at
all, they are written by their services under the module identity, and the guard refuses a portal/API-user
write path by name.

## 7. Atomicity, history and idempotency

One command runs in one transaction: campaign update → `CampaignTransition` row → outbox event. A refusal
anywhere leaves no partial write.

`CampaignTransition` records the command, the from/to states, the actor and their type, the reason, the
validation fingerprint the command passed, and the idempotency key. Generic field audit cannot express any
of that, which is why the row exists (§5.1 "immutable execution history").

A repeated `idempotencyKey` returns the original answer with `changed: false, idempotent: true` and writes
nothing new; the key is also unique in the database (migration `037`), so a race between two retries fails
on the constraint instead of double-writing (§0.1 rule 10).

## 8. Duplicate as draft

`duplicateAsDraft` builds the copy from an **allowlist of configuration fields**, so nothing that describes
an execution can be carried over by omission: no lifecycle stamps, no validation report or hash, no failure
reason, no recipients, deliveries, enrollments or provider identifiers. Those exist now — MA.8 added send
definitions and per-recipient delivery rows, and neither is reachable from a copy — and MA.9/MA.10 add
execution and enrollment state, which is excluded the same way. `code` is not duplicated — a copy needs its
own identity or none. The source is recorded as `duplicatedFromId`.

## 9. Events

`marketingAutomation.campaign.<action>` (kernel grammar allows 2–4 dot segments, so the plan's `.v1`
suffix is not usable — see [the compatibility note](../compatibility/marketing-automation.md) §5). Payload:
`schemaVersion`, `occurredAt`, `correlationId`, `source`, `campaignId`, `campaignCode`, `from`, `to`,
`actorUserId`, `actorType`. Identifiers and decisions only: no person, no body, no token (§7.3).

MA.5 adds `marketingAutomation.consent.changed` under the same discipline: consent id, purpose, channel,
from/to, source and actor — never the address, and not even its digest, which is already an identifier.

## 10. Verification

* Unit: [apps/api/test/marketing-automation-domain.test.ts](../../apps/api/test/marketing-automation-domain.test.ts)
  — every table is total over its status list, every command source is a declared edge, no edge lacks a
  producing command, and the eligibility matrix is covered independently.
* API: [apps/api/test/marketing-automation.test.ts](../../apps/api/test/marketing-automation.test.ts)
  — the full lifecycle with stamps and history, illegal moves refused without mutating the record, the
  validation blockers on `schedule`/`start`, cancel-without-reason refused, idempotent replay, optimistic
  version conflict, duplicate-as-draft exclusions, record ACL on every path, and outbox payload shape.
* API (MA.4): [apps/api/test/marketing-automation-audience.test.ts](../../apps/api/test/marketing-automation-audience.test.ts)
  + [its domain half](../../apps/api/test/marketing-automation-audience-domain.test.ts)
  — static membership add/remove with provenance, dynamic criteria resolution, the injection-shaped criteria
  refused before any query runs, one inclusion union, **exclusion winning over inclusion**, de-duplication of
  one person in several lists, the no-address and unreadable cases, the resolution ceiling reporting
  `truncated`, a snapshot staying stable after the segment changes, and snapshot entries never returning an
  address. Every phase acceptance criterion of §15 `19-MA.4` is a named test.
* Browser: the campaign detail page shows the lifecycle controls, the blockers/warnings a `schedule` or `start`
  would raise, and an audience summary line ("Audience resolved: 2 · sendable now: 1") with the per-category
  breakdown; unsubscribing from the public preference page in the same session dropped that campaign to zero
  eligible recipients.
