---
title: Configuring AI agents
summary: Configure providers, execution limits, approvals, retention and budgets for AI Agents, and diagnose refused publishing.
audience: admin
order: 155
tags: [ai-agents, providers, settings, approvals, budgets]
related: [admin/module-settings, admin/users-teams-roles, admin/audit-jobs-and-operations, user/ai-agents]
updated: 2026-10-22
---

The AI Agents module is configured in two places inside [the AI agents screen](/ai-agents): **Providers** manages model connections, and **Settings** edits the single validated `aiAgents` settings document. The server validates every save, refuses an unknown key and increments the document version. This page is about making the module work. For what a run, an approval and a conversation look like to the person using them, read [AI agents](user/ai-agents).

## What ships switched off

A fresh instance can define agents but cannot execute them; the emergency stop is off, no default connection is set, no tool is disabled, and prompt logging is off.

| Feature | Default | What it controls |
| --- | --- | --- |
| `features.definitions` | on | Drafts, versions, agent reads and lifecycle commands |
| `features.execution` | off | Creating a run and claiming a queued run |
| `features.memory` | off | New conversations; publishing an agent that declares memory |
| `features.evaluations` | off | Whether required evaluation suites gate publishing |
| `features.eventTriggers` | off | The event and integration trigger route |
| `features.scheduledTriggers` | off | The scheduled trigger route |
| `features.portalAssistant` | off | Nothing in this build; the value is stored but no code path reads it |

To get the first agent running:

1. Create an enabled connection in **Providers**, allowlist at least one model, and run its check.
2. In **Settings**, keep definitions on and turn execution on. Leave evaluations off for the first publish; see [Publishing and the evaluation gate](#publishing-and-the-evaluation-gate).
3. Create an agent from **Agents**, choose that connection and an allowlisted model, and write its system instructions.
4. Publish the agent, then start a manual run.

## Providers

### Create a connection

1. Open **Providers** and click **Add**.
2. Pick a preset, or **Custom / OpenAI-compatible endpoint**, to fill the kind, base URL and suggested models.
3. Set a key such as `primary-openai`. It starts with a letter and uses lowercase letters, digits or hyphens; it cannot be changed later.
4. Set the name, base URL and at least one model. The model list is the allowlist, not a suggestion: an agent can use only a listed model, and fallback models are checked too.
5. Choose the data classes the connection may receive, enter the credential, and leave **Enabled** on.

The base URL must be `http` or `https` and must not carry credentials; a plain `http` endpoint is accepted,
but the credential then travels unencrypted, so use `https` for anything outside your own machine. Cloud
metadata, link-local and RFC1918/ULA addresses are always refused. Loopback is refused as well — it is
allowed only outside production and only when the connection explicitly opts in with **Allow loopback**,
which is meant for a local runtime. DNS is resolved when the URL is saved and again at call time.

### Credentials and the allowlist

A credential is write-only. No read path, error or log returns it; the API exposes only `hasApiKey`, and the list shows **Stored** or **Missing**. Leaving the credential field empty while editing keeps the stored value. The screen has no control to clear a stored credential; replacing it is the supported action. Credentials are encrypted with `ENCRYPTION_KEY`. If that key is missing, a new credential cannot be saved, and the Overview check reports the problem. Connections without a credential are valid for a self-hosted endpoint that does not need one. A connection referenced by a published version cannot be deleted; disable it instead, and publish validation and model calls will refuse it.

### The connection check

**Check** sends one small probe through the normal gateway: the first allowlisted model unless you choose another, a fixed instruction, at most 16 output tokens and a 15-second timeout. It returns status, error category, latency, token usage and the provider request id, never the model's text or the credential.

The probe is an ordinary provider request. It uses the `internal` data class, so the instance data policy and the connection's own data-class list must both allow `internal` or the check is refused. The attempt is written to the provider request ledger and may be billable at the provider.

### Shipped adapters

| Adapter | What it speaks | Registered |
| --- | --- | --- |
| `openai-compatible` | `/chat/completions`; tool calling and JSON-schema output | Always |
| `anthropic` | The Messages API with `x-api-key`; tool calling, no structured output | Always |
| `fake` | Deterministic canned answers for tests | Only when `NODE_ENV` is not `production` |

There are no other adapters, and no adapter has a separate disabled flag: `fake` is the only conditional registration. With `NODE_ENV=production` the registry contains two: the fake adapter is not registered at all, creating a `fake` connection is refused, and a stored fake row cannot resolve to an adapter. Gemini is a preset on `openai-compatible`, not a separate adapter. An agent that needs JSON output cannot use an Anthropic connection.

## Settings

### Features

- **Definitions** off refuses draft, version, listing and lifecycle calls through the definitions service. It does not delete published history.
- **Execution** off refuses a new run and stops a queued run from being claimed. An executing run is not canceled; the emergency stop below is the same.
- **Memory** off refuses a new conversation, hides the Conversations tab, and blocks publishing any agent whose memory mode is not `none`.
- **Evaluations** off skips the publication gate entirely. Suites can still be created and run; nothing enforces them.
- **Event triggers** and **scheduled triggers** gate their trigger routes, but the run engine accepts only manual runs in this release, so enabling either switch does not make event or scheduled runs execute. Publishing an agent with either trigger enabled only warns; it is not blocked.

### Ceilings and runtime limits

| Setting | Default | What the code enforces |
| --- | --- | --- |
| `maxSteps` | 8 | Publication refuses an agent above it |
| `maxModelCalls` | 8 | Publication refuses an agent above it |
| `maxToolCalls` | 8 | Publication refuses an agent above it |
| `maxTokens` | 20,000 | Publication refuses an agent above it |
| `maxCostUsd` | 1 | Publication refuses an agent above it |
| `maxElapsedSeconds` | 120 | Publication ceiling; also caps a provider request timeout and a worker lease |
| `maxRetries` | 2 | Publication refuses an agent above it |
| `maxConcurrency` | 2 | Refuses a new run while that many queued, running, retrying or cancel-requested runs exist |
| `maxResultBytes` | 65,536 | Saved, but no run path reads it; each tool applies its own fixed result cap |

Lowering `maxSteps`, `maxModelCalls`, `maxToolCalls`, `maxTokens`, `maxCostUsd` or `maxRetries` does not change an already published version: the version captured its own limits, and a run uses those; the next publication is refused until the draft is lowered. `maxElapsedSeconds` and `maxConcurrency` are also read at run time. A warning appears when `maxModelCalls` is larger than `maxSteps`. Budget policies are not part of this document; they are administered on the Usage tab. Cost ceilings compare the estimate, so without a price card they see zero.

### Approval classes and lifetime

`approval.requireFor` defaults to `material_write` and `high_impact`; these classes pause a matching tool call for a human. The list is additive with the agent's own approval list and with tools that always require approval, such as the field-update tool. A class runs without review only when it is absent from the instance list, absent from the agent's list, and the tool does not require approval itself. Published versions keep the grants they captured, but the instance list is read live.

`approval.ttlMinutes` defaults to 60 and accepts 1 to 1,440. A proposal past its deadline closes as expired and its run ends as expired. Opening the Approvals inbox performs that sweep.

### Retention

| Setting | Default | What the sweep deletes |
| --- | --- | --- |
| `runEventsDays` | 90 | Run timeline events older than the window; runs and tool calls remain |
| `providerRequestsDays` | 30 | Provider request ledger rows older than the window |
| `conversationsDays` | 30 | Conversations and their messages; also the ceiling for an agent's memory retention |
| `evaluationsDays` | 180 | Nothing; the value is stored but no code path reads it |

The sweep is an explicit operation, available to a policy administrator as a preview and a run, and through the worker's retention route. It does not delete runs, approvals, tool calls or evaluation runs.

### Data policy

`allowedExternalDataClasses` defaults to `public` and `internal`. A model call must pass both this list and the connection's own data classes; the intersection is what leaves the deployment. Publication applies the same test, so lowering the list can block an existing published agent at its next call.

`logPrompts` is stored but not consumed. The provider ledger always records a request hash, counters and metadata, never the prompt or the completion, whatever this switch says.

### Default connection

The default connection is stored, shown in diagnostics and reported as a warning when empty. It is not used to create an agent and is not required to publish: every agent names its own connection and model. Treat it as orientation, not routing.

### Disabled tools and the emergency stop

`tools.disabled` is a list of tool keys. A disabled tool is refused at publication and, if a published version already granted it, the call is denied at run time; the catalogue marks it disabled.

`safety.globalExecutionPaused` is the emergency stop. It refuses a new run and stops an unstarted queued run from being claimed. It does not cancel a run already executing, and it deletes no configuration or history. The optional reason is shown in diagnostics and can be up to 500 characters.

## Rights

| Tab or action | Capability |
| --- | --- |
| Overview, Agents, Runs; starting a run | `use` |
| Conversations | `use` plus `features.memory` |
| Approvals; approve or reject | `approval` |
| Usage and budget status | `usage` |
| Evaluations tab; suites, cases, decisions | `evaluation` |
| Providers; create, edit, delete, check | `providerAdmin` |
| Settings; price cards, budget policies | `policyAdmin` |
| All users' runs and timelines | `audit` |
| Create or edit a draft; publish; pause, resume, archive | `manageDraft`, `publish`, `lifecycle` |

Every check runs on the server, and a settings or connection write is re-checked in its service. The capabilities are synthetic ACL resources (`AIAgent`, `AIAgentProvider`, `AIAgentPolicy` and so on). A user marked administrator and a user holding the `sysAdmin` role both bypass ACL, so they hold all of them and are the same tier here. The Roles screen builds its permission list from entity metadata, which does not contain those synthetic resources, so that screen cannot grant a non-administrator the module rights in this build. A role whose stored permissions carry the `*` wildcard passes as well. The `toolAdmin` capability is declared but no endpoint checks it; the disabled-tool list above is `policyAdmin`.

## Publishing and the evaluation gate

Publishing refuses a draft without a provider and a non-empty system prompt; one whose limits exceed a ceiling; one using a disabled, unknown or approval-unsafe tool; one whose model or data class the connection does not allow; and one identical to the current published version. An archived agent must be restored first.

When `features.evaluations` is on and at least one enabled suite has **required for publish**, publishing additionally requires a **passed** evaluation run for this agent at the exact checksum of the draft. If no such suite exists, the gate is skipped and validation only warns. Creating the standard **Publication gate** suite from the Evaluations tab sets both enabled and required.

"Same checksum" is literal: SHA-256 over the canonical JSON of the draft configuration. The prompt, provider, model, fallbacks, data class, tools, limits, output schema, memory, triggers and approval list are all inside it. Any edit after a passing run produces a different checksum and the gate fails again. Evaluation always grades the current draft, so run it after the final edit.

> [!WARNING]
> The standard Publication gate suite contains a `human-review` case. A run with that case is `pending_review`, never `passed`, and the Evaluations screen has no control to record the human decision. The decision endpoint exists on the API and needs the `evaluation` capability, but no screen calls it. Enabling evaluations and creating the standard suite therefore blocks every publish until a decision is recorded outside the screen. For this build, leave evaluations off and do not create the standard suite. There is also no screen to disable the suite after it exists.

The deterministic cases inspect the draft offline: configuration, tool grants, approval coverage, budgets, provider allowlist, memory policy and ownership. No model is called to grade an answer. A `model_review` case is advisory and does not run in this release.

## Pricing and usage

A price card is one provider and model with an input, cached-input and output price in USD per million tokens. An exact model card wins over a `*` card for that provider. Cost is calculated per request from the reported token counts, and every priced row records the snapshot it used. The Usage total is labelled **Estimate** when at least one request was priced, or **No price data** when none was. It is never the provider's billed amount; no adapter returns an authoritative billed figure. A zero total with **No price data** means nothing was priced, not that the runs were free. Reading usage needs `usage`; adding or replacing a price card needs `policyAdmin`.

Budgets are policies with a day or month period and a global, user, team, agent or provider scope. Hard limits are runs, requests, tokens, cost and concurrent runs; a run is refused atomically when any hard limit is already reached. `warnPercent` is a soft threshold: it raises a warning and never refuses work. The instance `maxConcurrency` ceiling is a separate check.

> [!NOTE]
> A team-scoped budget is stored and its usage is shown, but the run-creation matcher selects only global, user, agent and provider scopes, so a team policy does not refuse a run in this build. Cost budgets depend on estimated cost: with no matching price card the estimate is zero, so a cost cap never trips.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Publishing is refused for an evaluation | A required suite has no passed run at the current checksum. The standard suite contains the undecidable human-review case; keep evaluations off or record a decision outside the screen |
| Publishing is refused for the configuration | Missing provider or system prompt, a model or data class outside the connection, a disabled tool, a limit above a ceiling, an archived agent, or an identical version |
| A run never starts | Execution is off or globally paused; you lack `use`; the concurrency ceiling or a hard budget is reached; the agent is not published; a non-manual trigger is refused because only manual runs are implemented. A created run that stays queued is waiting for the worker |
| Cost is zero or shows no price data | No price card matches the provider and model, or no request was priced. Add a card, or a `*` card for the provider |
| An approval stays pending | Nobody with `approval` has decided it. It expires after the TTL and the run ends as expired; opening Approvals performs the sweep |

## Where to go next

- [AI agents](user/ai-agents) — runs, approvals and conversations from the user's side.
- [Module settings](admin/module-settings) — the other module documents and what starts off.
- [Users, teams and roles](admin/users-teams-roles) — the role model behind the capabilities.
- [Audit, jobs and operations](admin/audit-jobs-and-operations) — the worker and job history behind a queued run.
