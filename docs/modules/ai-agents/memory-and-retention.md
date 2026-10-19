# AI Agents — Memory and Retention

## Modes

- `none` (default): every run is isolated except for explicitly provided input/context.
- `conversation`: bounded thread for an authenticated user and a specific agent.
- `checkpoint`: run-resume state only (counters, pending approval).
- `curated`: scoped facts/summaries with provenance, sensitivity, expiry, deletion.

## Scope and ACL

- Memories are scoped by user, agent, tenant/organization and (optionally) record.
- Conversation memory is never shared across users unless converted to a shared artifact.
- ACL is re-evaluated whenever a remembered reference is used; permissions may have changed.
- Memory is treated as untrusted context: it cannot override system policy, tool grants or the
  current user's instructions.

## Retention

- `runEventsDays`, `conversationsDays`, `providerRequestsDays`, `evaluationsDays` configured
  under `retention.*` in the `aiAgents` settings row.
- `AI_AGENT_RETENTION_JOB` (worker) calls `POST /api/v1/AIAgents/action/worker/retention`, which
  runs `memory.sweep()`; the API decides what falls outside the configured windows, so a cron
  misconfiguration cannot become a broad delete.
- Manual dry run: `POST /api/v1/AIAgents/action/retention/dryRun` (admin).

## Deletion

- `DELETE /api/v1/AIAgents/action/conversations/:id` removes a thread and its messages.
- `DELETE /api/v1/AIAgents/action/memory/:id` removes a memory item.
- Conversation/memory rows carry `created_at`, `expires_at` and deletion metadata for audit.

## Data minimisation

- Long-term memory is opt-in (`features.memory`) and defaults off.
- Credentials, secrets, payment details and special-category personal data are never stored.
- Raw email/ticket content is avoided; summaries link to source records instead.