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