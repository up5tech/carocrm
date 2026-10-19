# AI Agents — Run State Machine

## States

`queued`, `running`, `waiting_for_approval`, `waiting_for_input`, `retry_wait`,
`cancel_requested`, `succeeded`, `partially_succeeded`, `failed`, `canceled`,
`expired`, `blocked_by_policy`, `outcome_unknown`.

Terminal states: `succeeded`, `partially_succeeded`, `failed`, `canceled`, `expired`,
`blocked_by_policy`, `outcome_unknown`.

## Transitions

- `queued -> running`: worker claims the lease (`execute`).
- `running -> waiting_for_approval`: a tool with `requiresApproval` proposes an action.
- `waiting_for_approval -> running`: approval decided `approved`; `execute` resumes.
- `waiting_for_approval -> canceled/expired/blocked_by_policy`: rejection, expiry, invalidation.
- `running -> waiting_for_input`: (reserved) additional user input required.
- `waiting_for_input -> queued`: input received via `POST .../runs/:id/input`.
- `running -> cancel_requested`: cancellation requested while a step is in flight.
- `cancel_requested -> canceled`: current step finishes and observes the flag.
- `running -> retry_wait`: transient provider failure within retry budget.
- `retry_wait -> running`: retry timer elapses and a worker re-claims.
- `running -> outcome_unknown`: a write tool's result cannot be reconciled after a crash.
- `* -> expired`: lease/staleness sweeper (`recoverBatch` + `expire`).
- `* -> blocked_by_policy`: kill switch or feature disabled mid-run.

## Recovery

- `recoverBatch(limit)` scans `queued`, `retry_wait`, and stale `running` leases and re-drives
  each through `execute`, which is idempotent on the lease.
- `execute` is a no-op for terminal runs and for runs held by another live lease.
- Cancellation observed between steps prevents any further tool call.

## Invariants

- Every run ends in a terminal state or a documented waiting state.
- No long-running run depends solely on in-memory process state.
- Counters (steps, model calls, tool calls, tokens, estimated cost) are persisted at checkpoints.
- A run's captured `agent_version` is immutable for the life of the run.