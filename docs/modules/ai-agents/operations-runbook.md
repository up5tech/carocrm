# AI Agents — Operations Runbook

## Provider outage / rate limit

- Runs fail with a normalized provider error and enter `retry_wait` within retry budget.
- No duplicate tool effects: retries re-claim the lease; terminal/unknown outcomes are not retried.
- Rotate credentials in the **Providers** tab of the AI Agents module page, or via
  `PATCH /api/v1/AIAgents/action/providers/:key` (secret is write-only).
- Use **Check** on the connection to confirm the endpoint answers before re-enabling execution.

## Stuck run

- `POST /api/v1/AIAgents/action/runs/recover` (admin, `audit` capability) scans queued/retry_wait
  and stale running leases and re-drives them via `execute`.
- `POST /api/v1/AIAgents/action/runs/:id/cancel` stops further tool calls.

## Cost / quota spike

- Kill switch: the **Emergency stop** card of the **Settings** tab of the AI Agents module page, or
  `POST /api/v1/AIAgents/action/settings` with `safety.globalExecutionPaused=true`, stops new runs
  without deleting history.
- Hard limits stop execution safely and preserve partial results.

## Retention / deletion request

- Dry run: `POST /api/v1/AIAgents/action/retention/dryRun`.
- Execute: `POST /api/v1/AIAgents/action/retention/run` (worker-authenticated).
- Conversation/memory deletion: `DELETE .../conversations/:id`, `DELETE .../memory/:id`.

## Suspected prompt injection / unauthorized tool attempt

- Review run timeline (`GET .../runs/:id/events`) and tool calls (`.../toolCalls`).
- Policy denials are recorded as `blocked_by_policy` with a safe reason code.
- Tighten tool grants, approval matrix and data-class restrictions on the agent version.

## Unknown outcome after external side effect

- Run marked `outcome_unknown`; reconciliation required before retry.
- `retry` refuses while an `outcome_unknown` tool call exists.