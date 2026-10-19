# `AIAgents` architecture and domain contract

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §4–§9, §20 Phase 19-AI.1.
> **Status:** delivered in 19-AI.1. Contracts here are binding for AI.2 onwards.
> **Module:** `AIAgents`, key/route `ai-agents`, no `Ua` prefix.

---

## 1. First-release scope

### In scope

1. An agent definition registry with **draft** configuration and **immutable published versions**.
2. A provider gateway that is vendor-neutral, uses encrypted credentials, normalizes errors/usage and
   never exposes SDK types to domain code.
3. A durable run state machine with bounded steps, tool calls, model calls, tokens, cost, elapsed
   time, retries and concurrency; cancellation and expiry.
4. A typed server-side tool registry with read tools first, then explicitly approved low-risk writes.
5. Human approval for material/high-impact actions, with execution-time revalidation.
6. Run events, audit, usage ledger and a redacted diagnostics surface.
7. Administration and usage views; manual runs only until policies and logs are proven.
8. Optional integrations through owning-module service contracts.

### Explicit non-goals (first release)

- Unrestricted agents, or any data beyond the invoking principal's ACL.
- Arbitrary SQL, shell, filesystem, browser, network or code execution chosen by a model.
- Automatic customer-facing sends, financial changes, deletes, permission changes or refunds without
  policy **and** approval.
- Self-modifying production prompts or auto-publication.
- A general workflow/BPM engine, a second email system, a second notification system or a vector DB.
- Multi-agent swarms/recursive delegation without a finite depth budget.
- Training provider models on CRM data.
- Promising deterministic model output.

The module registry key is `ai-agents`; API prefix `/api/v1/AIAgents`; frontend route `/ai-agents`.

---

## 2. Domain contracts

All ids are UUID/text ids generated with `randomUUID()`; timestamps are UTC `timestamptz`.

### 2.1 Agent definition (`ai_agents`)

| Field | Contract |
| --- | --- |
| `id` | stable id |
| `agent_key` | unique stable key, `^[a-z][a-z0-9-]{1,63}$` |
| `name`, `description`, `purpose`, `category` | display/classification |
| `owner_user_id`, `team_id`, `visibility` | `private` / `team` / `organization` |
| `status` | `draft` / `published` / `paused` / `archived` |
| `draft_config` | validated JSON of the shape in §2.2 |
| `current_version` | integer pointer to the published version, `null` while never published |
| `data_sensitivity` | `public` / `internal` / `confidential` / `restricted` |
| `is_deleted`, timestamps, actor ids | soft delete and provenance |

A published definition is edited through a **new draft**; `draft_config` is never the published
snapshot. The immutable snapshot lives in `ai_agent_versions` and is read by every run.

### 2.2 Agent configuration (validated with Zod, strict)

```text
{
  model: {
    providerKey: string,            // must resolve to an enabled connection
    model: string,                  // must be in the connection's allowlist
    fallbackModels: [{ providerKey, model }], // empty by default
    structuredOutput: boolean,
    temperature: number,            // 0..2
  },
  instructions: {
    system: string,                 // <= 32k chars
    behaviour: string | null,       // user-facing description
  },
  schemas: {
    input: JSONSchema | null,       // bounded, depth/size limited
    output: JSONSchema | null,
  },
  tools: [{ toolKey: string, effectClass: 'read'|'low_write'|'material_write'|'high_impact',
            constraints: { entities?: string[], fields?: string[], maxRecords?: number } }],
  triggers: { manual: boolean, record: boolean, event: boolean, schedule: boolean,
              integration: boolean },           // only manual may be true in the first release
  limits: { maxSteps: 1..16, maxToolCalls: 0..32, maxModelCalls: 1..16,
            maxTokens: 1..100000, maxCostUsd: 0..100, maxElapsedSeconds: 1..600,
            maxRetries: 0..5, maxConcurrency: 1..10 },
  memory: { mode: 'none'|'conversation'|'run_checkpoint'|'curated',
            scope: 'user'|'agent'|'tenant'|'record', retentionDays: 1..365 },
  approval: { requireFor: RiskClass[], approverPermission: string },
  dataPolicy: { sensitivity: 'public'|'internal'|'confidential'|'restricted',
                logPrompts: false },
}
```

Unknown keys are rejected. Numeric bounds are enforced server-side; a missing or unbounded limit is a
publication failure, never an implicit default.

### 2.3 Published version (`ai_agent_versions`)

| Field | Contract |
| --- | --- |
| `id` | version row id |
| `agent_id`, `version` | unique pair, monotonically increasing |
| `config` | the full frozen config snapshot |
| `checksum` | SHA-256 over the canonical JSON snapshot |
| `published_by_id`, `published_at`, `publication_note` | provenance |
| `tool_grants` | rows in `ai_agent_tool_grants` |

Immutability: no update path exists for a published row. A change creates a new version. Runs read
by `agent_version_id`; an emergency kill switch may cancel active runs but never mutates the snapshot.

### 2.4 Tool grant (`ai_agent_tool_grants`)

`tool_key`, `tool_version`, `effect_class`, `constraints`, `requires_approval`, `enabled`.
A grant is a **subset** of globally enabled tools and of the publisher's own authority. Unknown tools
fail publication.

### 2.5 Run (`ai_agent_runs`)

| Field | Contract |
| --- | --- |
| `id` | run id returned to the caller |
| `agent_id`, `agent_version_id`, `agent_version` | captured at creation |
| `initiated_by_user_id`, `service_principal` | exactly one is set |
| `trigger` | `manual` / `record` / `event` / `schedule` / `integration` |
| `input` | schema-validated JSON, minimised |
| `status` | §3 state machine |
| `idempotency_key` | unique when present; derived from caller key or event id |
| `correlation_id`, `causation_id` | tracing and loop prevention |
| `lease_owner`, `lease_expires_at` | one worker at a time |
| counters | steps, model calls, tool calls, tokens, estimated cost (exact numeric) |
| `result`, `failure_category`, `failure_message` | terminal outcome |
| `cancel_requested` | observed between every step |

### 2.6 Run event (`ai_agent_run_events`)

`run_id`, `seq` (unique per run), `category`, `event_type`, `actor_type`/`actor_id`,
`correlation_id`/`causation_id`, `summary` (safe, human-readable), `payload` (redacted by default),
`visibility` (`user` / `operator` / `admin`), `redaction` (`summary` / `none` / `hashed`).

Append-only. Sequence is allocated inside the writing transaction. A success event is never written
before the operation it reports has actually succeeded.

### 2.7 Tool call (`ai_agent_tool_calls`)

`run_id`, `step`, `tool_key`, `tool_version`, `argument_hash`, optional protected `arguments`,
`policy_result` (`allowed` / `denied` / `approval_required`), `status`
(`proposed` / `validated` / `executing` / `succeeded` / `failed` / `outcome_unknown`), `outcome`,
`result_ref`, `error_category`, `idempotency_key` (unique per run+step+call), attempts, duration.

### 2.8 Approval (`ai_agent_approvals`)

`run_id`, `tool_call_id`, `agent_id`, `agent_version`, `requested_by_user_id`, `action_class`,
`risk_level`, `summary`, `proposal` (typed action, before/after values), `targets`,
`expires_at`, `status` (`pending` / `approved` / `rejected` / `changes_requested` / `expired` /
`invalidated` / `executed`), `decided_by_user_id`, `decided_at`, `decision_note`, `revalidation`,
`execution_result`.

Approvals are authenticated decisions, not bearer links. An agent cannot approve its own action.
Changing arguments or target records invalidates the approval.

### 2.9 Provider request (`ai_agent_provider_requests`)

`run_id` (nullable for a connectivity check), `step`, `provider_key`, `model`, `request_hash`,
`request_meta`, `response_meta`, token counts, latency, normalized `outcome`/`error_category`,
`estimated_cost_usd` (exact numeric), `provider_request_id`. **No raw prompt or completion by
default.**

### 2.10 Budget policy (`ai_agent_budget_policies`)

`scope` (`global` / `user` / `team` / `agent` / `provider`), `scope_ref`, optional `provider_key`
and `agent_id`, `period` (`run` / `day` / `month`), `max_requests`, `max_tokens`, `max_cost_usd`,
`max_runs`, `max_concurrent_runs`, `enabled`. Limits are enforced atomically with row locking when a
run reserves budget (AI.13).

### 2.11 Provider connection (`ai_provider_connections`)

`key` (unique), `kind` (`openai-compatible` / `fake`), `label`, `base_url`, `models` (allowlist),
`data_classes`, `api_key_encrypted` (write-only), `config`, `enabled`, provenance. See
[provider-configuration.md](provider-configuration.md).

---

## 3. Run state machine

```text
queued ──claim──▶ running ──▶ succeeded
  │                 │  ├────▶ partially_succeeded
  │                 │  ├────▶ failed
  │                 │  ├────▶ outcome_unknown
  │                 │  ├────▶ waiting_for_approval ──approve──▶ queued/running
  │                 │  │                        └──reject───▶ failed (policy_denied)
  │                 │  ├────▶ waiting_for_input ──input─────▶ running
  │                 │  ├────▶ retry_wait ─────────backoff──▶ running
  │                 │  └────▶ blocked_by_policy
  ├──cancel────────▶ canceled
  └──expire────────▶ expired
cancel_requested ──observed──▶ canceled
```

Rules:

- Every transition is persisted before the next external effect.
- A run may claim a worker only with an unexpired lease; lease expiry allows recovery, not a second
  concurrent execution.
- Cancellation stops **new** tool calls; it cannot undo committed effects.
- `outcome_unknown` is mandatory when an external effect may have happened but cannot be reconciled.
- Terminal states never transition again.

---

## 4. Risk classes and default approval matrix

| Class | Examples | Default |
| --- | --- | --- |
| `read` | search, read a record through ACL, read a ticket/project summary | automatic within ACL |
| `low_write` | internal task/note, draft email (not sent), proposed field change | automatic if granted, audited |
| `material_write` | update customer fields, change ownership/status, portal-visible content | approval required |
| `high_impact` | send external message, start campaign, financial document/payment/refund, bulk update, delete/merge, permission change | approval required; some disabled by default |

Mappings are code-reviewed per tool. A tool's self-declared class is not trusted until reviewed.

---

## 5. Principal model

| Run origin | Principal | Rules |
| --- | --- | --- |
| Interactive / record / manual | the authenticated user | tools execute with that user's **current** ACL; no elevation |
| Scheduled / event / integration | a dedicated service principal (`system` user or configured API user) | narrow roles, visible provenance; never reuse an admin's personal identity |
| Portal | the portal user | portal policy applies; internal/agent admin surfaces are invisible |

Additional rules:

- The run stores the initiating principal and a reference to the authorization context.
- Permissions are re-evaluated **immediately before each tool execution**; an expired session does
  not silently elevate.
- Configuration visibility never implies record access.
- Background work carries the principal explicitly in the job payload and reconstructs it under
  `RequestScope.runAs`; it does not rely on an ambient HTTP request.

---

## 6. Tool contract

A tool is registered by trusted code:

```text
ToolDefinition {
  key, label, version, ownerModule, enabled,
  input: Zod schema (strict, bounded),
  output: schema or size-capped serializer,
  effectClass, requiredPermission: { resource, action },
  entities/fields/record constraints,
  requiresApproval, approvalPermission,
  idempotency: 'keyed' | 'none' | 'reconcile',
  timeoutMs, maxRetries, maxResultBytes,
  audit: { eventType, redaction }
}
```

Execution pipeline: resolve by key → enabled + granted → schema validate (reject unknown fields) →
limits/format checks → resolve principal → record/field/tenant/portal ACL → risk + approval → replay
check → execute domain service in one transaction → redact/persist outcome → emit event.

The model may only choose a tool key and arguments. It cannot name handlers, SQL, URLs, permissions
or policy values. No arbitrary SQL/code/shell/filesystem/browser tool exists.

### 6.1 Memory contract (implemented in AI.12)

Memory is **off by default**. An agent version declares one mode and one scope:

| Mode | Contents | Lifetime |
| --- | --- | --- |
| `none` | nothing beyond the current request | run only |
| `conversation` | bounded messages for one user + agent + optional record | retention window, last activity |
| `run_checkpoint` | the minimum state needed to resume the same run | until the run is terminal |
| `curated` | approved facts/summaries with provenance | per agent retention (1–365 days) |

Rules: a memory item records its source reference, creator, confidence/status, sensitivity class and
retention deadline; every use re-checks the source record's **current** ACL; memories are scoped by
user, agent, tenant/organization and optionally record; a summary never overrides current
authoritative CRM data; deletion and export are supported. Memory text is untrusted context and
cannot change tools, policy, budgets or approval requirements.

### 6.2 Evaluation contract (implemented in AI.14)

An evaluation suite belongs to an agent and contains cases. A case carries an input fixture (or a
protected reference), expected properties, and forbidden behaviours. A run records the tested
version, provider/model, deterministic grader results, optional human/model review (labelled as
such), and a regression comparison with the prior published version.

Publication gates are deterministic and mandatory: schema validity, tool-grant correctness, ACL
denial behaviour, prompt-injection resistance, budget limits and idempotency invariants. A
model-generated grade can never override a failed deterministic safety case. Evaluation tables are
not created until AI.14 so no empty artefact is exposed.

---

## 7. Retention and deletion semantics

| Data | Default retention | Deletion |
| --- | --- | --- |
| Run events | 90 days after terminal state | sweeper deletes by `created_at`; aggregate counters survive on the run |
| Provider requests | 30 days | sweeper |
| Conversations/messages | 30 days after last activity (when enabled) | owner delete + retention sweep |
| Memory items | per agent config, 1–365 days | expiry sweep; source refs re-checked |
| Approvals | retained with the run | never deleted independently while the run exists |
| Evaluation artifacts | 180 days | sweep |
| Definitions/versions | retained while the agent exists | archive keeps history; no silent hard delete |

Deletion never cascades into another module's records. Foreign keys use `ON DELETE CASCADE` only for
rows wholly owned by a run (events, tool calls, approvals), and `ON DELETE SET NULL` where a ledger row
must survive.

---

## 8. API surface (foundation delivered in AI.2–AI.4)

```text
GET    /api/v1/AIAgents/action/health          // capability + dependency + provider status (use)
GET    /api/v1/AIAgents/action/capabilities    // this caller's rights (use)
GET    /api/v1/AIAgents/action/settings        // policy settings (policy admin)
POST   /api/v1/AIAgents/action/settings        // validated patch (policy admin)
GET    /api/v1/AIAgents/action/providers       // sanitized connections (provider admin)
POST   /api/v1/AIAgents/action/providers       // create connection (provider admin)
PATCH  /api/v1/AIAgents/action/providers/:key  // update; secret write-only (provider admin)
DELETE /api/v1/AIAgents/action/providers/:key  // remove (provider admin)
POST   /api/v1/AIAgents/action/providers/:key/check // connectivity check, no secrets (provider admin)
```

Definition, run, approval, usage and evaluation routes arrive in their own phases. Static
`AIAgents` routes are registered before `ENTITY_CONTROLLERS` so `:entity` cannot swallow them.

Response errors keep the platform envelope `{ error: { code, message, details? } }`. Policy denials
use `AuthorizationDeniedError`; disabled execution uses `FeatureDisabledError`.

---

## 9. Module disablement

- `features.execution` defaults to **false**; no run may be created while it is false.
- `safety.globalExecutionPaused` is an operator kill switch that blocks new runs and new high-risk
  tool calls without deleting configuration or history.
- Disabling a feature or the module never deletes runs, audit rows or published versions.
- Provider configuration and health checks remain available while execution is disabled, so an
  operator can prepare a deployment before enabling it.
