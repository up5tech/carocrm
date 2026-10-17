# Customer Success — operations guide

Who this is for: whoever runs the platform — scheduled work, failed runs, recalculation and
diagnostics. Everything here uses the platform's existing job/scheduler and health facilities; the
module adds no queue, timer or scheduler of its own.

## 1. Scheduled jobs

Registered in the worker composition root by `registerCustomerSuccessJobs`
(`apps/worker/src/handlers/customer-success-handlers.ts`), installed as `scheduled_jobs` rows by
`database/seed.ts`, and driven from `apps/worker/src/app.ts` like every other job. Each handler
calls its own `@Public()` API endpoint with the shared `x-worker-secret` capability, so the work runs
in the application layer where the state machines, audit, stream and events live — exactly the
operation an administrator would run, under the documented service principal.

| Job | Schedule (seed) | What one run does |
|---|---|---|
| `customerSuccess.recalculateHealthBatch` | `10 2 * * *` | recalculates profiles whose score is missing or older than `jobs.refreshIntervalDays`; bounded by `jobs.batchSize` |
| `customerSuccess.expireHealthOverrides` | `25 2 * * *` | expires overrides past their date and restores the calculated status, with history |
| `customerSuccess.evaluateRenewalWindows` | `40 2 * * *` | detects profiles newly inside a configured renewal window |
| `customerSuccess.evaluateRiskEscalations` | `50 2 * * *` | finds overdue or high-severity risks needing review and tells their owners |
| `customerSuccess.evaluateReviewReminders` | `5 3 * * *` | reminds owners about reviews due or overdue |
| `customerSuccess.updateGoalOverdueState` | `15 3 * * *` | updates overdue indicators without churning rows that are already right |
| `customerSuccess.processPlaybookWaitSteps` | `25 3 * * *` | resumes runs whose wait steps have come due |
| `customerSuccess.repairStalePlaybookRuns` | daily | closes runs whose steps are all terminal; reports runs that still need a person |

Every run is idempotent (a snapshot is deduplicated by a material-change signature, an override is
cleared only once past its date, a playbook step waits until its date has passed), bounded, pausable
through the normal schedule switch, and reports processed/skipped/error counts and duration through
the standard job logs. When no worker capability is configured the jobs report `disabled` — inert,
not broken.

## 2. Diagnostics

`GET /api/v1/CustomerSuccess/action/health` (administrator) is the first stop. It reports:

- the module descriptor (id, version, `loadOrder`, API prefix, implemented sub-phases);
- each required platform capability with its evidence read from the running platform — never a
  hard-coded `true`;
- each optional integration's status: Sales & Subscriptions, Projects and Opportunities resolve
  through the metadata registry; Service Desk and adoption analytics report `unavailable` while
  their markers are absent, which is a supported state, not a fault;
- the feature flags and their settings paths;
- the settings version, who updated it and the active warnings;
- named checks (migration applied, write guard registered, seeding state).

`GET /api/v1/Sales/action/health` reports this module as an available optional integration of Sales,
because the marker entity `CustomerSuccessProfile` is registered — the contract
`apps/api/src/sales/sales-module.ts` declares.

## 3. Recalculation

- **One profile, on demand:** `POST …/action/recalculateHealth` (record ACL). A no-op recalculation
  follows the deduplication policy — a new snapshot is written only when an input, the configuration
  or the status materially changed, unless `force` asks for history.
- **The portfolio:** `POST …/action/bulkRecalculateHealth` (administrator) enqueues the registered
  batch job and returns the job row, so progress is visible in `/admin/jobs` like any other
  background work. Never a synchronous full-table sweep from a request.
- **Scheduled / event-driven:** the jobs above, plus recalculation on qualifying domain events.
  Health snapshot writes never trigger unbounded re-calculation: the events published after a
  snapshot are filtered by the consumers, so no loop forms (§5.4.5).

A failed or partial calculation **preserves the last valid snapshot** and is separately marked; a
good score is never replaced by an incorrect zero (§17).

## 4. Playbook runs that need a person

`GET /api/v1/CustomerSuccess/action/playbookRun?runId=…` shows the run with its template-version
snapshot, every step's status, the linked record it produced, attempt counts and a safe error
summary. Operators:

- retry failed steps only: `POST …/action/retryFailedSteps` — a completed step is never rerun;
- cancel with a reason: `POST …/action/cancelPlaybookRun`, which preserves history;
- stuck runs are found by `customerSuccess.repairStalePlaybookRuns` (a run that has not moved for
  the module's stale window) and are only ever closed through explicitly safe transitions.

The step snapshot taken at run start means editing a template cannot mutate in-flight work; the next
run picks up the new version.

## 5. Notifications

In-app rows only, written by the module's notification writer when enabled, deduplicated by
condition and recipient with the configured cadence. Tests and operations can verify rows exist
without any outbound delivery being possible: the module has no mail or webhook path.

## 6. Data safety notes for operators

- The migration `032_phase19_customer_success.sql` is additive: new partial indexes only. Nothing to
  back out manually; the normal migration lifecycle records it in `schema_migrations`.
- Profiles are soft-deleted, so history (snapshots, plans, goals, risks, runs) survives; a new
  profile for the same Account is allowed after an old one is archived.
- Deleting an Account is outside this module's scope; the platform's own cascade/soft-delete rules
  apply to its records as to any other entity's.
