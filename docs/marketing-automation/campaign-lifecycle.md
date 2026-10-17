# Marketing Automation — campaign lifecycle

**Delivered in:** Phase 19-MA.2 (contracts) and Phase 19-MA.3 (lifecycle and validation).
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.1, §8.2, §8.4, §15.
**Code:** [apps/api/src/marketing-automation](../../apps/api/src/marketing-automation) —
`marketing-automation-domain.ts` (the tables below), `marketing-campaign.service.ts` (commands),
`marketing-campaign-validation.service.ts` (the gate), `marketing-automation-write-guard.service.ts`
(the record-API boundary).

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

The gate is **per target state**, which is what lets MA.3 ship a real lifecycle while the audit records
audience resolution (MA.4), consent (MA.5) and a live provider (MA.7) as prerequisites of an actual send:

* **configuration findings** apply to `schedule` — classification, purpose, schedule order, time zone,
  audience and content references the actor can actually read, sender existence, tracking choices;
* **execution findings** additionally apply to `start`/`resume` **of a campaign that could send**
  (`Email`, `Newsletter`, `Informational`): `AUDIENCE_ENGINE_PENDING`, `CONSENT_NOT_CONFIGURED`,
  `PROVIDER_NOT_BOUND`, `GLOBAL_SEND_PAUSED`.

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

## 5. What the record API may not write

The write guard refuses a client that sets any of: `status`, `scheduledAt`, `startedAt`, `pausedAt`,
`resumedAt`, `completedAt`, `cancelledAt`, `archivedAt`, `failureReason`, `validationReport`,
`validationHash`, `lastValidatedAt`, `duplicatedFromId`, `lastErrorCode`. A new campaign is created as
`Draft` or not at all. `CampaignTransition` and `TargetListEntry` rows are module-written only.

These fields are also `inEdit: false` in metadata, so the SPA never offers an input the server will refuse.

## 6. Atomicity, history and idempotency

One command runs in one transaction: campaign update → `CampaignTransition` row → outbox event. A refusal
anywhere leaves no partial write.

`CampaignTransition` records the command, the from/to states, the actor and their type, the reason, the
validation fingerprint the command passed, and the idempotency key. Generic field audit cannot express any
of that, which is why the row exists (§5.1 "immutable execution history").

A repeated `idempotencyKey` returns the original answer with `changed: false, idempotent: true` and writes
nothing new; the key is also unique in the database (migration `037`), so a race between two retries fails
on the constraint instead of double-writing (§0.1 rule 10).

## 7. Duplicate as draft

`duplicateAsDraft` builds the copy from an **allowlist of configuration fields**, so nothing that describes
an execution can be carried over by omission: no lifecycle stamps, no validation report or hash, no failure
reason, no recipients, deliveries, enrollments or provider identifiers (MA.8–MA.10 add those, and they
cannot leak into a copy). `code` is not duplicated — a copy needs its own identity or none. The source is
recorded as `duplicatedFromId`.

## 8. Events

`marketingAutomation.campaign.<action>` (kernel grammar allows 2–4 dot segments, so the plan's `.v1`
suffix is not usable — see [the compatibility note](../compatibility/marketing-automation.md) §5). Payload:
`schemaVersion`, `occurredAt`, `correlationId`, `source`, `campaignId`, `campaignCode`, `from`, `to`,
`actorUserId`, `actorType`. Identifiers and decisions only: no person, no body, no token (§7.3).

## 9. Verification

* Unit: [apps/api/test/marketing-automation-domain.test.ts](../../apps/api/test/marketing-automation-domain.test.ts)
  — every table is total over its status list, every command source is a declared edge, no edge lacks a
  producing command, and the eligibility matrix is covered independently.
* API: [apps/api/test/marketing-automation.test.ts](../../apps/api/test/marketing-automation.test.ts)
  — the full lifecycle with stamps and history, illegal moves refused without mutating the record, the
  validation blockers on `schedule`/`start`, cancel-without-reason refused, idempotent replay, optimistic
  version conflict, duplicate-as-draft exclusions, record ACL on every path, and outbox payload shape.
