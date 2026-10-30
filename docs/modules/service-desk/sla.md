# SLA policies, business time and jobs

## Records

- **`BusinessCalendar`** — `timezone` (IANA), `intervals` (JSON keyed by weekday `0`–`6`, each an
  array of `{start,end}` local times), `holidays` (JSON array of local `YYYY-MM-DD` dates), `isActive`.
- **`SLAPolicy`** — `priority` (lower matches first), `isActive`, declarative `conditions`,
  `calendarId`, `firstResponseMinutes`, `nextResponseMinutes`, `resolutionMinutes`,
  `warningThresholds`, `pauseOnCustomer`, `pauseOnInternal`, `version`.
- **`CaseSLAClock`** — one row per case and target: `targetType`, `startAt`, `dueAt`, `metAt`,
  `breachedAt`, `pausedAt`, `resumedAt`, `totalPausedBusinessMinutes`, `status`, `cycle`, the
  snapshot `policyId`/`policyVersion`/`warningThresholds` and the fired/notification flags.

## Policy resolution

Active policies are evaluated in `priority` order; the first whose declarative conditions match the
case becomes the applied policy. A case with no matching policy (or `features.sla` off) gets
`slaState = NotApplicable` and no clocks. A policy change never rewrites clocks that already exist;
recalculation is a deliberate operation and each clock names the version it was created under.

## Clock semantics

| Target | Starts | Met by |
|---|---|---|
| `firstResponse` | case creation | first qualifying **public agent reply** (internal notes never count) |
| `nextResponse` | case creation | the next public reply; intended to reset on each customer message where the next-response target is configured |
| `resolution` | case creation (and each reopen cycle) | `resolve` |

A target configured with `0` minutes creates no clock. `markMet` records `metAt` and the business
minutes elapsed; a paused clock that is met records the active time only.

## Business time

`addBusinessMinutes` and `businessMinutesBetween` walk real minutes and evaluate the calendar in its
IANA time zone through `Intl.DateTimeFormat`, so weekends, local holidays, overnight shifts and
daylight-saving transitions follow local wall time rather than server UTC. A calendar with no
intervals falls back to calendar time. Arithmetic is bounded (200,000 minutes) so a corrupt calendar
cannot loop forever.

## Pause and resume

Entering `Pending Customer` (when `pauseOnCustomer`) or `Pending Internal` (when `pauseOnInternal`)
marks active clocks `paused` and records `pausedAt`. Leaving those states computes the **business
minutes spent paused**, adds them to `totalPausedBusinessMinutes`, shifts `dueAt` forward by the same
business duration and clears `pausedAt`; the pause interval stays inspectable. The breach scan skips
paused clocks, so a pause can never breach a target.

## Warning and breach

- The clock stores the policy's warning thresholds at creation. The scan marks `warning` when the
  active business percentage reaches the lowest threshold.
- The scheduled pass fires a notification once per threshold (`sla-warning:<clock>:<threshold>`) and
  appends the threshold to `firedWarnings`.
- Passing `dueAt` marks `breached`, records `breachedAt`/elapsed minutes and emits
  `serviceDesk.case.slaBreached`.
- A breach notification is sent once (`breachNotified`). Escalation marks the case
  `isEscalated/escalationLevel/escalatedAt` only when the case is not resolved, closed, cancelled or
  merged; the clock is still flagged so a later tick does not retry.
- A failed notification does not erase the breach state.

## Reopen cycles

Reopening a resolved/closed case creates a new `resolution` clock with `cycle + 1`. The previous
resolution clock remains `met` and its policy snapshot is intact, so both cycles remain reproducible.
First-response history is not reset.

## Scheduled pass

`serviceDesk.slaScan` is a `scheduled_jobs` row (`*/5 * * * *`). The worker calls
`POST /api/v1/ServiceDesk/action/sla/run-scheduled-check` with `x-worker-secret`; the admin twin is
`POST …/action/sla/runScheduledCheck`. The scan is bounded to 500 clocks per run, reports
`truncated` when more remain, and records `settings.sla.lastScanAt` (without bumping the settings
version). Both sweeps filter in SQL — open clocks with a `dueAt` for the breach pass, clocks already
`warning`/`breached` for the notification pass — and order by `dueAt` ascending, so a bounded run
always covers the most urgent clocks and never leaves one unattended because the table outgrew the
batch. It also expires published Knowledge articles whose `expiresAt` has passed.

Returned counters: `checked`, `breached`, `warned`, `notified`, `escalated`, `expiredArticles`,
`truncated`.

## Metric definitions

- **First response:** creation → first public agent reply; business minutes when the policy uses a
  calendar.
- **Resolution time:** creation (or the reopen instant for a later cycle) → the `resolve` event.
- **SLA attainment:** met target clocks divided by eligible target clocks; `NotApplicable` has no
  clock and is excluded.
- **Backlog:** cases in non-terminal states (`Resolved`, `Closed`, `Cancelled` excluded).
- **Reopen rate:** cases with `reopenedAt` divided by cases that were resolved at least once.
- **CSAT:** mean rating of submitted, valid surveys; shown only to read-all roles, with the response
  count/rate alongside.
