# AI Agents — Tool Developer Guide

## Registering a tool

Tools are registered in `apps/api/src/ai-agents/ai-agent-tools.ts` via `AIToolRegistry`.
Each definition requires:

- `key`, `label`, `description`, `version`, `owningModule`
- `effectClass`: `read` | `low_write` | `material_write` | `high_impact`
- `requiresApproval`: whether a human must approve before execution
- `entityScopes`: entities the tool touches
- `inputSchema` (Zod) and a hand-written `inputJsonSchema` for the provider
- `maxResultBytes`, `timeoutMs`
- `execute(args, context)` and optional `preview(args, context)`

## Rules

- A model selects only a tool key and arguments; it can never name a handler, URL, table, SQL or
  permission rule.
- All arguments are validated against the schema; unknown fields are rejected.
- Tools run through the normal Entity Engine / domain services so ACL, validation, audit and hooks
  apply exactly as for a human request.
- No arbitrary SQL, shell, filesystem or code-execution tools.
- Write tools must accept an idempotency key derived from run + step + tool-call identity.
- Result payloads are size-capped and stripped of irrelevant personal data.

## Effect classes and approval

Default matrix: `read` and `low_write` may run automatically within ACL; `material_write` and
`high_impact` require human approval unless policy says otherwise.

## Contributing a tool from a domain module

`ai-agents` may not import a business domain: `crm-chat` imports `ai-agents`, and
`docs/architecture/module-contracts.md` records the graph as a DAG. When a tool needs a domain
service, the domain registers it itself at bootstrap through the public
`AIToolRegistry.register()` — `crm_cross_module` in
`apps/api/src/crm-chat/crm-chat-tool-contribution.ts` is the worked example.

`register()` throws on a duplicate key, so two modules claiming one tool is a boot failure rather
than a silent override. `ai-agents` still owns the grant check: `entityScopes` must name entities
the metadata registry knows, and a `material_write` cannot be granted without approval.

## Aggregation tools

A number in an answer must come from SQL. Use `EntityCrudService.aggregate()`, which applies the
caller's record predicate before it groups — never fetch rows and sum them in JavaScript.

- Pass `fieldType` for every dimension and metric. The store casts numerics and dates from it; a
  missing type compares JSON text and silently returns wrong groupings.
- The store orders groups by key and returns at most `maxGroups + 1` rows, so "top N by value"
  requires a wider scan (`AGGREGATE_GROUP_SCAN`) followed by an in-memory sort and slice. Report
  `truncated` when the scan hit its ceiling.
- `currency` and `decimal` fields are canonical decimal strings on the way in and numbers on the way
  out of the store; attach a formatted `display` so an answer can quote a readable amount.

## Relative periods

Never let the model compute a date. Accept a token from `ai-agent-periods.ts` (`this_quarter`,
`last_month`, `rolling:30d`, …), resolve it against the **actor's** timezone, and return the resolved
`{ label, from, to, timezone }` with the result so the answer can state its window.

- A period is meaningless without the date field it applies to: require both, and name the
  candidate date fields when the caller omits one.
- Week boundaries are Monday-based (ISO-8601); quarters are calendar quarters.
- The resolver converts local wall clocks to instants with a two-pass offset correction, which is
  what makes a DST boundary land on the correct side. It is covered by
  `apps/api/test/ai-agent-periods.test.ts`.

## Actor-scoped tools

Resolve "mine" from `AIToolContext.actorUserId` via `AIAgentActorDirectoryService`; never accept a
user id as an argument. The same service feeds the system prompt, so a tool and the prompt cannot
describe the acting user differently.

## Write tools

A write tool is only useful if the record it creates can be found again. Four rules, each learned
from a shipped defect:

- **Attach it to what it is about.** Create through the owning service and then link with
  `entities.link()`, resolving the relation name from metadata rather than hardcoding it. A task with
  no parent, a note on nothing and a call nobody can find on the account are records that answer no
  question.
- **Use the owning service, not an insert.** `StreamService.create()` brings the parent's `stream`
  ACL action, mentions, followers and audit with it. Reaching around it produces a note that looks
  right and notifies nobody.
- **Drafting is not sending.** `crm_draft_email` writes `status: 'Draft'` and never calls
  `EmailService.queueSend`; `queueSend` independently refuses any status outside `Draft`/`Failed`.
  Two guards, because one of them will eventually be refactored.
- **Declare the class and keep it.** Widening an allowlist (for example adding
  `Opportunity.stage`) does not soften `material_write`: the tool keeps `requiresApproval`, the
  version check and the proposal the human saw.

Pass `context.idempotencyKey` to any service that accepts one, so a retried step cannot write twice.
Tests should assert the effect — the `stream_items` row, the `entity_links` row, the absence of a
`system.sendEmail` job — and not the tool's own return value, which is a claim rather than evidence.

The version string on an upgraded tool (`'1'` → `'2'`) is audit metadata: `ai_agent_tool_grants`
records `tool_version` but authorises by `key`, so bumping it does not invalidate existing grants.