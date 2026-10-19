# `AIAgents` security and threat model

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §11, §20 Phase 19-AI.1.
> **Status:** delivered in 19-AI.1; re-reviewed in 19-AI.19.
> **Scope:** agent definitions, provider gateway, tool execution, approvals, runs, memory, usage and
> the administration surface.

---

## 1. Trust boundaries

```text
Untrusted  ── user prompt, CRM notes/emails/cases/documents, webhook payloads,
              model output, tool output, external provider responses

Trusted    ── agent configuration (after validation), published version snapshot,
              tool registry, policy engine, ACL context, budgets, state machine

Secrets    ── provider API keys, ENCRYPTION_KEY, database URL, JWTs
```

The model is an **untrusted planner**. It may propose a tool call; trusted code decides whether it
may execute. Nothing the model writes can grant a permission, change a budget, alter a tool
definition, extend a grant, approve itself or bypass ACL.

---

## 2. Assets

| Asset | Impact if compromised |
| --- | --- |
| CRM records and fields | privacy breach, business loss, regulatory exposure |
| Portal/customer identities | cross-customer disclosure |
| Provider credentials | financial loss, provider-account abuse |
| Agent instructions and tool grants | covert privilege expansion, unsafe automation |
| Runs, approvals, audit events | loss of accountability, silent side effects |
| Budgets/quotas | cost amplification, denial of service |
| Internal network | SSRF into metadata services or private infrastructure |

---

## 3. Threats and mandatory controls

### T1 — Direct prompt injection

*Threat:* a user tells the agent to ignore policy, reveal secrets or widen tools.

**Controls**
- System/policy instructions are composed by trusted code and are structurally separate from user
  content.
- Tool list, grants, budgets, ACL and approval policy are read from server state, never from the
  prompt.
- A request to "ignore previous rules" is ordinary data; it changes no server state.
- Invalid structured output triggers a small bounded repair, then fails safely.

**Tests:** adversarial fixtures assert that tool grants, budgets and ACL are unchanged and that
secret-extraction attempts return a policy denial.

### T2 — Indirect prompt injection (retrieved CRM content)

*Threat:* a customer email, ticket, note or document contains instructions that cause disclosure or
an unsafe action.

**Controls**
- Retrieved content is labelled as untrusted data in the provider request.
- Tools return the minimum fields and records needed by the current step.
- High-risk tools still require deterministic server-side validation and human approval.
- The run's final answer must cite its sources; retrieval never grants action authority.

**Tests:** a Case/Email fixture containing an injection cannot expand tools or return another
customer's record.

### T3 — Privilege escalation

*Threat:* an agent or its caller obtains data/actions beyond the initiating principal.

**Controls**
- Every tool calls `AclApiService.assertAccess` / `assertRecordAccess` for the **current** principal.
- Field-level and portal/project scopes are enforced by the same Entity Engine paths as the API.
- Synthetic permission resources (`AIAgentTool`, `AIAgentProvider`, …) are checked server-side.
- A queued job carries the principal explicitly; expiring a session does not elevate it.
- Tool arguments can never name a handler, SQL, URL or permission.

**Tests:** role without `AIAgent:read` cannot see the menu or call health; a tool request for an
unreadable record is denied; an agent cannot approve its own action.

### T4 — Cross-tenant / cross-user leakage

*Threat:* conversation ids, memory keys, run ids or caches return another principal's data.

**Controls**
- Runs and conversations store owner and tenant/scope; every read filters by them.
- Memory scope is explicit (`user`, `agent`, `tenant`, `record`) and re-checks source ACL on use.
- Retrieval filters chunks by permission **before** the model sees them.
- Run events have a visibility class and are redacted per caller.
- No cache key is derived solely from a client-supplied id.

**Tests:** two users with separate conversations cannot read each other's messages or memory; a
portal user cannot list internal agent runs.

### T5 — Replay and duplicate side effects

*Threat:* a retry, duplicate event or worker crash repeats an email, payment or record write.

**Controls**
- Run creation accepts an idempotency key; event triggers use the event id.
- Each write tool call has a unique idempotency key derived from run + step + call identity.
- Before retrying, the executor checks whether the first attempt committed and returns its outcome.
- External effects that cannot be reconciled are marked `outcome_unknown`, never "succeeded".
- Event-triggered runs carry causation ids and are de-duplicated; recursion depth is bounded.

**Tests:** duplicate dispatch of the same job creates one effect; a crash after the effect does not
send twice; a replay returns the stored outcome.

### T6 — Runaway cost and loops

*Threat:* repeated tool calls, large outputs or public triggers exhaust budget.

**Controls**
- Finite per-run limits: steps, model calls, tool calls, tokens, cost, elapsed time, retries,
  concurrency and result size.
- Budget is reserved/checked before each provider and tool call; hard limits stop safely.
- Repeated identical calls and no-progress steps are detected and stop the run.
- Rate limits on run creation, messages, approvals and public/integration endpoints.
- A global kill switch stops new runs without deleting history.

**Tests:** budget exhaustion yields a partial result with a clear reason; a looping fake provider
stops at the step ceiling.

### T7 — SSRF and unsafe egress

*Threat:* a provider `baseUrl` or a future HTTP tool reaches loopback, private ranges or cloud
metadata.

**Controls**
- Provider URLs are administrator-supplied and validated on save **and** before each request:
  `https` only, no URL credentials, no redirects; loopback allowed only outside production and only
  for an explicitly enabled self-hosted connection.
- Any future network tool must use a domain allowlist, DNS/private-range checks and response caps.
- The model cannot supply URLs to internal services.

**Tests:** `http://169.254.169.254`, `http://127.0.0.1` in production, URLs with credentials and
redirecting endpoints are rejected.

### T8 — Secret exposure

*Threat:* provider keys or session tokens appear in responses, logs, events, prompts or test output.

**Controls**
- Credentials are AES-256-GCM encrypted with `ENCRYPTION_KEY`; read paths return `hasApiKey` only.
- Saving a credential without a configured key fails with a clear message; no plaintext fallback.
- Authorization headers, keys and signed URLs are redacted from diagnostics.
- Prompts/completions are not stored by default; the provider ledger stores hashes and counters.
- Tests assert the key never appears in any response body.

**Tests:** provider list/check/settings responses contain no secret; logs are not asserted to contain
it (the code never receives it outside the adapter call).

### T9 — Approval bypass and stale approval

*Threat:* a high-impact action executes without approval, or after the target changed.

**Controls**
- Risk class is review-assigned per tool, not self-declared by the model.
- High-impact classes require an approval row before execution.
- Approvers need a dedicated permission and authority over the affected records.
- The agent cannot approve its own action; approvals are not bearer tokens.
- Before execution, the service revalidates version, actor, approver authority, target state,
  arguments hash, consent and policy. Any change invalidates the approval.
- Expiry/rejection never triggers an alternative write.

**Tests:** changed target record invalidates approval; revoked permission invalidates; replayed
approval does not create a duplicate record.

### T10 — Destructive or financial actions

*Threat:* an agent sends a customer message, changes an invoice/payment, deletes or merges records.

**Controls**
- These tools are disabled by default and require `high_impact` approval and an explicit grant.
- Sales/ServiceDesk/Marketing remain authoritative for calculations, consent, SLA and dispatch.
- Bulk actions require a bounded preview/count and approval for the exact set.
- No payment is reported as successful from model inference; only authoritative data is used.

**Tests:** unapproved financial write is denied; Marketing send cannot bypass consent/suppression.

### T11 — Arbitrary code / data exfiltration tools

*Threat:* a malicious extension or misconfiguration exposes eval, shell, SQL or filesystem access.

**Controls**
- The tool registry is code-registered; there is no dynamic registration API and no eval/SQL tool.
- Unknown tool keys, unknown fields and oversized arguments are rejected.
- A future custom-code tool is a separate sandboxed project with a threat model, not a flag.
- LLM filters/queries are parsed into safe query plans against allowlists, never interpolated into
  SQL.

### T12 — Audit tampering / repudiation

*Threat:* an actor denies an action or edits history.

**Controls**
- Run events are append-only and sequence-ordered; terminal success is written after the effect.
- Approval decisions are immutable after finalization.
- Configuration changes and kills are audited with actor, time and before/after summary.
- Audit access is permissioned (`AIAgentAudit`) and separated from aggregate usage.

### T13 — Provider outage and unsafe fallback

*Threat:* an outage causes infinite retries, duplicate actions or silent model downgrade.

**Controls**
- Provider errors are normalized (`auth`, `rate_limit`, `timeout`, `canceled`, `invalid_request`,
  `provider_unavailable`, `invalid_response`, `content_filter`, `unknown`) with a `retryable` flag.
- Retries are bounded with exponential backoff and jitter; billing/auth errors are not retried.
- Fallback is explicit per agent; a fallback model must be allowed for the same data class and
  tool/output contract. High-risk agents disable cross-provider fallback by default.
- Fallback preserves budgets and never repeats tool side effects.

### T14 — Worker crash and stale runs

*Threat:* a crashed worker leaves a run stuck or a second worker executes it concurrently.

**Controls**
- A run is claimable only with a lease; duplicate claim fails.
- Recovery resumes from the last durable checkpoint, not by replaying blindly.
- A sweeper expires stalled runs and records who/what expired them.
- Run events and tool calls are the durable record; in-memory state is never authoritative.

### T15 — Denial of service through public surfaces

*Threat:* public forms/chat or repeated triggers flood runs.

**Controls**
- Public/portal assistants are a separate classification with stricter allowances, quotas,
  content filtering and abuse prevention (captcha/rate limits as appropriate).
- Run creation, messages and approval polling are rate-limited per principal.
- Concurrency caps and queue depth are enforced globally and per agent/user/team.

---

## 4. Mandatory runtime checks (ordered)

For every tool proposal:

1. Resolve the tool by key from the server-side registry only.
2. Confirm globally enabled and granted by the captured agent version.
3. Validate arguments with the strict schema; reject unknown fields and oversize input.
4. Validate limits, identifier formats and result size.
5. Resolve the initiating/service principal and re-read current permissions.
6. Apply entity, record, field, team, tenant and portal boundaries.
7. Evaluate risk class, consent, and whether approval is required.
8. Confirm idempotency/replay state before any effect.
9. Execute through the owning domain service inside the required transaction.
10. Redact and persist the outcome; emit the run event and audit entry; return only permitted data.

Any failure is a safe, actionable policy denial. The model is never asked to find a workaround.

---

## 5. Logging and diagnostics rules

- Never log API keys, authorization headers, full database URLs, session tokens or raw prompts.
- Run events carry a safe summary; full payloads are opt-in diagnostics with short retention, narrow
  permission and an audit trail.
- Provider request records store request hashes, usage and normalized outcomes by default.
- Approval payloads never include secrets or unrestricted record snapshots; the viewer's ACL filters
  before/after values.
- Error responses expose a stable category and a remediation hint, never SQL, stack traces or the
  provider body.

---

## 6. Security test matrix (owned by later phases, seeded here)

| Area | Positive | Negative |
| --- | --- | --- |
| Menu/permission | role with `AIAgent:read` sees the entry | role without it sees nothing and gets 403 |
| Tool authorization | allowed read returns ACL-scoped record | unreadable record → policy denial |
| Injection | benign summary | injected instructions cannot widen grants |
| Approval | approve then execute once | changed target/revoked actor → invalid |
| Idempotency | retry returns stored outcome | duplicate request creates one effect |
| Budget | run stops at limit with partial result | concurrency cannot exceed the cap |
| Secrets | `hasApiKey` true after save | key absent from every response/log |
| SSRF | allowed https provider | loopback/metadata/credentials/redirect rejected |
| Portal | portal user sees own records | portal user cannot see internal runs/notes |
| Memory | own conversation persists | another user's memory is unreachable |

---

## 7. Residual risk accepted for the foundation (AI.0–AI.4)

- No run engine or tool executor exists yet, so injection/replay/approval threats are **designed and
  documented but not exploitable through an endpoint** in this sub-phase.
- Provider connectivity checks can reach an administrator-supplied endpoint. This is an explicit,
  admin-only, audited action; model output can never supply it.
- A role wilcard (`*`) grants the synthetic agent resources, as it does every future entity. This is
  the platform ACL contract, documented here and in the repository audit rather than silently
  special-cased.
