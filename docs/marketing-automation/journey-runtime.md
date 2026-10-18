# Marketing Automation — journey runtime

**Delivered in:** Phase 19-MA.12 (graph schema, validation, immutable versions), Phase 19-MA.13 (enrollment,
claims, waits, conditions, recovery), Phase 19-MA.14 (the allowlisted action catalog and the CRM-event
trigger), Phase 19-MA.16 (cross-module events).
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.6, §5.7, §6.4, §11, §15 `19-MA.12`–`19-MA.14`.
**Code:** [apps/api/src/marketing-automation](../../apps/api/src/marketing-automation) —
`marketing-journey-definition.service.ts` (schema, validation, publish), `marketing-journey-runtime.service.ts`
(enrollment, claim, step execution), `marketing-journey-action.service.ts` (actions),
`marketing-journey-trigger.service.ts` (whitelist and causation bound),
`marketing-automation-domain.ts` §`JOURNEY_STATUSES`/`ENROLLMENT_*`.
**Migration:** `database/migrations/043_phase19_marketing_journey_runtime.sql` (enrollment dedupe, step
idempotency, both indexes additive).

---

## 1. Records

| Record | Holds | Mutable? |
| --- | --- | --- |
| `MarketingJourney` | name, status, `currentVersion`, `publishedVersionId` | yes (status/pointer only) |
| `MarketingJourneyVersion` | `version`, `graph` (JSON text), `graphHash`, `schemaVersion`, `publishedById`, `publishedAt`, `releaseNotes`, `status` | **no** — a published version is never edited |
| `MarketingJourneyEnrollment` | `journeyId`, `versionId`, `version`, `personType`/`personId`/`emailHash`, `source`, `dedupeKey`, `state`, `currentNodeId`, `nextRunAt`, `enteredAt`, `exitedAt`, `exitReason`, `branchTrace[]`, `lockVersion` | yes, through the runtime only |
| `MarketingJourneyStepExecution` | `enrollmentId`, `nodeId`, `nodeType`, `attempt`, `status`, `startedAt`, `finishedAt`, `outputSummary`, `idempotencyKey` | append-only |

Journey status: `Draft → Scheduled → Active → Paused → Completed → Archived` (`JOURNEY_STATUSES`). Version
status: `Draft → Published → Retired`, with **no edge back from `Published` to `Draft`**
(`JOURNEY_VERSION_TRANSITIONS`) — that is what makes "editing a draft cannot mutate a running journey" a
structural fact rather than a convention.

## 2. Graph schema

```jsonc
{
  "start": "n1",
  "nodes": [
    { "id": "n1", "type": "wait", "seconds": 3600, "next": "n2" },
    { "id": "n2", "type": "condition", "formula": "record.state == 'New'", "then": "n3", "otherwise": "n4" },
    { "id": "n3", "type": "action", "action": "sendEmail", "params": { "templateId": "…", "purpose": "Newsletter" }, "next": "n5" },
    { "id": "n4", "type": "action", "action": "createTask", "params": { "subject": "Follow up" }, "next": "n5" },
    { "id": "n5", "type": "end" }
  ]
}
```

Node types are a closed set — `start`, `end`, `action`, `condition`, `wait`, `split`, `join`
(`ALLOWED_NODE_TYPES`). A node names an **action key**, never code: there is no script field, no SQL, no URL
fetch and no network call in a node's configuration.

### 2.1 Validation (`validate`, runs before every publish)

| Rule | Failure |
| --- | --- |
| graph is an object with a non-empty `start` and at least one node | error |
| every node has a unique non-empty `id` and an allowlisted `type` | error |
| `start` names an existing node | error |
| `condition` has a valid `then` port (`otherwise` optional but must exist if present) | error |
| every non-`end` node's `next`/`then`/`otherwise` names an existing node | error |
| `action` nodes declare `action`; `wait` nodes declare non-negative `seconds` | error |
| `sendEmail` nodes declare `params.templateId`, and `recipientType`/`purpose` only from their allowlists | error |
| no cycle (depth-first over the edge set) | error |
| at least one reachable `end` | error |
| a node unreachable from `start` | **warning** |

`publish` refuses an invalid graph outright (`Cannot publish invalid graph: …`), writes a
`MarketingJourneyVersion` with `graphHash = sha256(canonical JSON)` and `status: "Published"`, and then moves
the journey to `Published` and repoints `publishedVersionId`/`currentVersion`.

## 3. Enrollment

`POST /api/v1/MarketingAutomation/action/journey/:id/enroll`

* **Idempotent by `dedupeKey`.** `uq_entity_records_marketing_journey_enrollment_dedupe`
  (`journeyId, dedupeKey`) is the guarantee: a repeat — including two triggers racing — returns the existing
  enrollment with `duplicate: true` instead of creating a second one. The insert also uses
  `on conflict do nothing` and re-reads, so a lost race is still one enrollment.
* **Version pinning.** The enrollment stores the `versionId`/`version` it entered on. Publishing v2 changes
  what *new* enrollments get; an existing enrollment keeps executing the graph its own `versionId` names
  (`runStep` loads the graph by `versionGraph(versionId)`, never by the journey's current pointer).
* **Entry state.** `state = Active`, `currentNodeId = graph.start`, `nextRunAt = now`, `lockVersion = 0`.

## 4. Step execution

`POST /api/v1/MarketingAutomation/action/journey/run-batch` — the admin door, or the worker door with
`x-worker-secret` (job `marketing.journeyRunBatch`). One pass:

1. `dueEnrollments(now, limit)` — `state in (Active, Waiting)` and `nextRunAt <= now`, oldest first, bounded by
   `limit` (default 25).
2. `claim(id, now)` — a **conditional UPDATE** on `lockVersion` that also requires the enrollment to still be
   due. Two workers cannot execute the same enrollment concurrently: the second claim affects 0 rows.
3. `runStep(id, graph)` — the node at `currentNodeId`:

| Node | Effect | Next state |
| --- | --- | --- |
| `action` | executes the action (below); `failed` suspends, no `next` completes | `Active` / `Completed` / `Suspended` |
| `wait` | `nextRunAt = now + seconds` | `Waiting` |
| `condition` | evaluates `formula` against a **narrow** record (`personType`, `personId`, `emailHash`, `source`, `state`); a formula error is `false`, never an exception | `Active` on the chosen port |
| `end` | `exitedAt` set | `Completed` |
| anything else | follows `next`, or completes | `Active` / `Completed` |

**Suppression is checked before every step.** If the enrollment's `emailHash` has any applied Email
suppression, the enrollment exits with reason `SUPPRESSED` and the step is not run — a journey graph cannot
outvote an opt-out (§15 `19-MA.13` acceptance).

Every step appends a `MarketingJourneyStepExecution` row with `idempotencyKey =
<enrollmentId>:<nodeId>:<at>` and an `outputSummary`; `branchTrace[]` on the enrollment accumulates one entry
per visited node (`n2:condition:then`, `n1:wait:3600s`, …), so a timeline explains each branch and delay.

### 4.1 Recovery

* A crash between claim and write leaves `lockVersion` bumped and `nextRunAt` unchanged; the row is due again
  and the next pass re-runs the *same* node. Idempotency is the action's own key (§4.2), not a flag.
* `state = Suspended` (action failure) is **not** retried by a timer: an operator resumes it
  (`POST action/enrollment/:id/resume`) or exits it.
* `POST action/enrollment/:id/(suspend|resume|exit)` are the operator commands; `exit` records the reason.

## 5. Actions (`ALLOWED_JOURNEY_ACTIONS`)

| Action | What it does | ACL |
| --- | --- | --- |
| `sendEmail` | renders `params.templateId` for the enrolled person and submits through the **same** MA.9 delivery pipeline (`MarketingDeliveryBatchService.submit`) — same eligibility gate, same limiter, same classified outcomes | the person must be readable by the actor |
| `createTask` | creates a `Task` linked to the person | system identity, `Task: create` |
| `updateField` | writes one field from `ALLOWED_UPDATE_FIELDS` (`Lead.status`, `Lead.description`, `Contact.description`, `Account.description`) | **actor scope** — the Entity Engine enforces ACL, so a journey cannot bypass it |
| `notify` | records the notification intent in the step output (no message is sent by this release) | — |

`sendEmail` details worth knowing:

* `params.recipientType` may only be `Contact` or `Lead`, and only when it equals the enrollment's own person
  type — a node cannot message an arbitrary record id smuggled into `params` (`RECIPIENT_MISMATCH`).
* `params.purpose` must come from `CAMPAIGN_PURPOSES`; absent, it defaults to `ProductMarketing`. A template
  cannot invent a purpose.
* Idempotency key: `journey:<sha256(enrollmentId:journeyId:personType:personId:contentHash)[0..32]>`. A retry
  of the same step submits the same key, so even a provider retry cannot deliver twice.
* A blocked submission returns `skipped` with the gate's code (`blocked:CONSENT_UNKNOWN`, …); a paused
  deployment returns `GLOBAL_SEND_PAUSED` (retryable); a throttled one `RATE_LIMITED` (retryable).

## 6. Triggers (`JOURNEY_TRIGGER_EVENTS`)

Only these event types can start or advance a journey:

| Event | Source module | Use |
| --- | --- | --- |
| `entity.created`, `entity.updated` | core CRM | Lead/Contact/Account lifecycle |
| `sales.opportunity.stageChanged` | Sales (optional) | deal-stage journeys, attribution |
| `customerSuccess.health.statusChanged` | Customer Success (optional) | lifecycle/health journeys |
| `serviceDesk.case.statusChanged` | Service Desk (optional) | approved, non-promotional use only |

`POST action/journey/:id/trigger` is **not public**: it answers whether a journey is published, so it takes
the worker capability (`x-worker-secret`) or administrator access. It refuses a non-whitelisted event
(`EVENT_NOT_WHITELISTED`), a chain deeper than `MAX_CAUSATION_DEPTH = 3`
(`CAUSATION_DEPTH_EXCEEDED`), and a journey that is not `Published` (`JOURNEY_NOT_PUBLISHED`).

Disabling an optional module removes its event from the whitelist: the journey simply stops matching it, and
no code path breaks.

## 7. What this release does *not* do

* No arbitrary loops. A graph with a cycle is refused at publish, and there is no `jump`/`goto` node.
* No `split`/`join` fan-out execution. Both types validate (they are in the closed set) but the runtime walks a
  single path; A/B splitting is Tier 3 (§5.12) and not built.
* No per-step retry budget beyond the delivery pipeline's `delivery.maxAttempts`. A failed action suspends the
  enrollment for an operator, which is deliberate: a silently retried CRM write is worse than a visible stop.
* No goal node distinct from `end`. `ENROLLMENT_EXIT_REASONS` already carries `GoalReached`, but no node
  produces it yet: a goal is expressed today as a `condition` that routes to an `end`, and the branch trace
  records which port was taken. Attribution for a journey conversion comes from the campaign's event log
  (see [metrics.md](metrics.md)), not from a journey node.
