# AI Agents — Operations Runbook

## Self-approval policy (19-AI.21)

A proposal the requester was the source of may not be completed by that same person.

- **Setting:** `AIAgents` → **Settings** → `approval.selfApprovalPolicy`.
  - `forbidden` (default) — the requester's attempt is refused with
    `AI_APPROVAL_SELF_APPROVAL_FORBIDDEN` (403). Nothing is decided: the proposal stays in the inbox
    for another approver.
  - `permitted_with_audit` — the requester's signature is recorded (the inbox shows *Waiting for a
    second approver*, the run timeline shows `approval.self_signed`) but the action cannot execute
    until a **second** approver signs. The requester asking again is refused with
    `AI_APPROVAL_SECOND_APPROVER_REQUIRED` (403).
- Only `material_write` and `high_impact` proposals are gated. Rejecting one's own proposal stays
  allowed — a requester must be able to cancel their own run.
- The check is not an admin bypass: an administrator who started the run needs a second approver too.
- **Before switching an existing installation on**, see what history already contains:
  `pnpm tsx scripts/audit-ai-self-approvals.ts` (read-only; lists the approvals that were decided by
  their own requester). The policy applies to new decisions — history is not rewritten.
- **Rollback:** set the setting back, or revert the service code. No migration, no data change.

## Event triggers (P1, 2026-11-05)

A committed `entity.*` event can start a run for each agent that opted in. Nothing starts until an
operator enables both switches, and an agent opts in itself:

1. `AIAgents` → **Settings** → `features.eventTriggers: true` (off by default; the door answers a
   quiet `{ disabled: true }` without it — never a retry storm).
2. The published version carries `triggers.event: true` **and** both allowlists:
   `triggers.eventTypes` (e.g. `["entity.created"]`) and `triggers.eventEntities`
   (e.g. `["Case"]`). Empty either way means never; publication warns when the flag is on with
   empty allowlists.
3. The agent must be **record-context** (`input.mode: "record"` with `input.entity` equal to the
   event's entity). Text-mode agents cannot be fed by events.
4. Each run executes as the **publishing user** — the agent can do nothing wider than its owner
   could by clicking Run. If the owner is deleted or deactivated, the trigger skips the agent and
   logs `owner-inactive`; it never falls back to a wider principal.
5. **Agents never trigger agents.** Every event produced inside a run carries
   `correlation_id = 'aiAgentRun:<runId>'`; the worker subscriber never forwards those.
6. Re-delivering the same event starts no second run (idempotency key `evt:<eventId>:<agentId>`).
7. Fan-out is capped at 5 agents per event.

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
- Where the money went: the **Usage** tab of the AI Agents module page answers it per agent, per
  trigger type and per provider/model over a chosen window (`this month` by default), and
  `GET /api/v1/AIAgents/action/usage/export` writes the same numbers to a CSV file for the finance
  handover. Cost is an **estimate** priced from the admin-maintained price cards, never the
  provider's billed amount.
- A near-limit warning arrives as an in-app notification for the administrators, naming the limit
  that is close (runs, requests, tokens, cost or concurrent runs). It is raised when a run is
  created, so an installation that stopped creating runs sees the state on the Usage tab and in the
  budget list instead.

## Golden evaluation gate (25.11)

- Run it: `pnpm eval:ai` — the same DB-free suite the scheduled nightly gate runs
  (`vitest.ci.config.ts`). No database, no network, no model call.
- What it measures: **tool-routing accuracy** over the versioned golden dataset — the share of
  deterministic cases whose prompt reaches the tool the dataset names, with that tool's real effect
  class, and with only the granted tools in reach. The floor is 1.00 and may only rise.
- A red run names the reason: `grant_missing` (the agent does not hold the tool its prompt needs),
  `write_on_read_prompt` (a read-only prompt reached a write tool), `unknown_tool` / `unknown_grant`
  (the catalogue and the dataset disagree), `effect_changed` (a tool changed class) or `misrouted`.
- The catalogue it checks is the live one. Renaming or removing a tool, or reclassifying one, fails
  the gate — that is the point.
- The `human_review` cases (four of them) wait for a person: their owner and deadline are in
  `docs/quality/phase-25-eval-evidence.md` §6. The `model_review` cases are advisory and are never
  executed by the gate.
- Evidence, commands and the metric: `docs/quality/phase-25-eval-evidence.md`.

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