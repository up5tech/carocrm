# Case lifecycle

Status codes are server-side contracts; labels and enums can be changed through metadata but the
codes below are what the state machine, SLA engine and reports read.

## States

| Code | Meaning | Terminal for SLA/escalation |
|---|---|---|
| `New` | created, not yet triaged | no |
| `Open` | being worked | no |
| `Pending Customer` | waiting for the requester; may pause SLA clocks | no |
| `Pending Internal` | waiting for another internal team; may pause SLA clocks | no |
| `Escalated` | escalated by a command or an SLA breach | no |
| `Resolved` | solution provided; may be reopened | yes (excluded from active backlog) |
| `Closed` | normal terminal state | yes |
| `Cancelled` | cancelled or merged into another case | yes |

## Commands and edges

Status moves are **commands**, never a bare field edit. `CaseLifecycleService` accepts:

| Command | Allowed source states | Target |
|---|---|---|
| `start` | New, Pending Customer, Pending Internal, Escalated | Open |
| `setPendingCustomer` | New, Open, Pending Internal, Escalated | Pending Customer |
| `setPendingInternal` | New, Open, Pending Customer, Escalated | Pending Internal |
| `escalate` | New, Open, Pending Customer, Pending Internal | Escalated |
| `deEscalate` | Escalated | Open |
| `resolve` | New, Open, Pending Customer, Pending Internal, Escalated | Resolved |
| `close` | Resolved | Closed |
| `reopen` | Resolved, Closed, Cancelled | Open |
| `cancel` | New, Open, Pending Customer, Pending Internal, Escalated, Resolved | Cancelled |

A direct move (`{ "to": "Open" }`) is accepted only inside the same transition map. A portal
principal has no `Case` edit permission and therefore cannot run commands; customer state changes
stay staff-mediated.

## Resolution

- `resolution.requireCode` (default on) rejects `resolve` without a code from the configured
  `resolution.codes` list.
- `resolution.requireSummary` (default off) can additionally require a summary.
- `close` is only valid from `Resolved`, so a case cannot be closed without a resolution step.
- Reopening keeps the previous `resolvedAt`/`closedAt`; `reopenedAt` records the new cycle. The
  prior resolution remains in `CaseTransition` and the prior resolution SLA clock stays `met`.

## Merge (SD.14)

`POST /api/v1/ServiceDesk/action/case/:id/merge { "intoCaseId": "…" }`:

- requires read access to both cases and **edit** access to the source (`own`/`team`/`all` scope);
- refuses a closed, cancelled or already-merged source;
- cancels the source (`status = Cancelled`), writes `mergedIntoCaseId`, appends a `CaseTransition`
  with command `merge` and emits `serviceDesk.case.merged`;
- leaves the target untouched; its history remains its own.

Duplicate candidates are advisory only: `GET …/duplicateCandidates` returns up to ten readable
cases with the same Account/Contact and a related subject prefix. A human must choose the target.

## History and audit

`CaseTransition` is written by `CaseLifecycleService` and `CaseMergeService` only. It carries the
command, from/to status, reason, resolution code/summary, actor and timestamp, plus an optional
`idempotencyKey`. The generic field audit and Stream remain in place; `GET …/case/:id/history`
returns the transition view oldest-first.
