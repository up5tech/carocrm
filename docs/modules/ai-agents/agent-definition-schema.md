# AI Agents — Agent Definition Schema

## Lifecycle states

`draft`, `published`, `paused`, `archived`. A published version is immutable; editing a draft
produces a new version on publish.

## Configuration (draft_config)

- `provider`: `{ key, model, fallbackModels }`
- `dataClass`: `public` | `internal` | `confidential` | `restricted`
- `prompt.system`: system instructions
- `input.mode`: `text` | `record`
- `tools`: array of `{ key }` grants
- `limits`: maxSteps, maxModelCalls, maxToolCalls, maxTokens, maxCostUsd, maxElapsedSeconds,
  maxRetries, maxOutputTokens, temperature
- `output.mode`: `text` | `json` (with optional schema)
- `memory`: `{ mode, maxMessages, retentionDays }`
- `triggers`: `{ manual, record, event, schedule, integration }`
- `approval`: `{ requireFor: EffectClass[] }`

## Publication validation

Provider exists/enabled, prompt/config within limits, valid input/output schema, every tool grant
registered and approval-safe, memory/retention explicit, finite budgets, passing required
evaluations, no references to disabled providers/tools/unpublished versions.