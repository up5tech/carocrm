# Assignment, queues and routing

## Records

- **`CaseQueue`** — `code`, `name`, `strategy` (`manual`, `roundRobin`, `leastBusy`),
  `fallbackBehavior` (`unassigned`, `fallbackOwner`), `defaultTeamId`, `defaultAssignedUserId`,
  server-owned round-robin cursor (`lastAssignedUserId`, `lastAssignedAt`), `isActive`, `sortOrder`.
- **`QueueMember`** — one row per `(queueId, userId)`, with `priority` and `isActive`.
- **`RoutingRule`** — validated declarative conditions, target queue/team/user, strategy, fallback,
  `isActive`, `sortOrder`.
- **`CaseAssignment`** — immutable history of every assignment/routing decision, including the
  previous and new owner, queue, strategy, matched rule, decision JSON and idempotency key.

Queue, membership and rule writes are administrator-scoped and require `features.queues`. Conditions
are parsed and checked against a field/operator allowlist at save time; no stored value is executed.

## Manual assignment

`POST /api/v1/ServiceDesk/action/case/:id/assign` accepts `assignedUserId`, `teamId`, `queueId` and
`strategy` (`manual` by default). The service:

1. requires record-scope **edit** on the case (not just entity permission);
2. validates that the destination user is active, internal and eligible for the queue/team;
3. validates the actor's assignment scope (unrestricted edit, the same team/queue, or self-claim);
4. writes the case ownership, a `CaseAssignment` row and `serviceDesk.case.assigned` in one
   transaction; assignment notifications are deduplicated by the history row id.

An assignment with no queue, team or user is refused. A no-op assignment returns `changed: false`.

## Queue strategies

- `manual` — the caller names the user; a queue-only placement is allowed and leaves the case
  unassigned for triage.
- `roundRobin` — members ordered by `QueueMember.priority` (then user id); the cursor is read under
  `SELECT … FOR UPDATE`, advanced on the queue row, so concurrent claims cannot pick the same next
  member.
- `leastBusy` — counts each eligible member's active cases (`New`, `Open`, `Pending Customer`,
  `Pending Internal`, `Escalated`) and picks the lowest; ties are broken deterministically.

If a queue has no eligible member, the case is retained in the queue (or given the configured
fallback owner) and the decision records `queue-has-no-eligible-agent`; it is never dropped.

## Routing

`POST …/case/:id/route` matches active rules in `sortOrder` order, first match wins. A rule's
conditions support `equals`, `notEquals` and `in` on known case fields. The configured
`assignment.defaultQueueId` is the fallback when no rule matches. The result reports the matched
rule, strategy, target and fallback reason; the same facts are stored on `CaseAssignment`.

## Workload

`GET /action/queues` lists queues with member and unassigned counts for administrators or callers
with read-all scope. `GET /action/queues/:id/workload` returns each eligible member's active case
count and the queue's unassigned backlog; access requires the same scope or membership in the queue's
team.
