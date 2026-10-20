# `CRMChat` repository audit — pointer

`PLAN_Phase_19_CRM_Chat.md` §17 names this path for the Phase 19-CHAT.0 deliverable. This repository
keeps module audits beside the module, so the audit itself lives at
[`docs/modules/crm-chat/repository-audit.md`](../modules/crm-chat/repository-audit.md).

Summary of what that document establishes:

- `AIAgents` is delivered, not planned: durable run engine, 6-tool registry over the Entity Engine,
  approvals with revalidation and expiry, owner-scoped conversation storage with retention, usage and
  quota ledgers, evaluation suites.
- `CRMChat` reuses `ai_agent_conversations` / `ai_agent_messages` as the single conversation store and
  `ai_agent_approvals` as the single approval store; it adds only citation, feedback and saved-prompt
  tables, plus SSE as the one genuinely new transport seam.
- Real gaps: no streaming transport, no aggregate tool, no domain-service tools, no help
  *retrieval* (a `KnowledgeArticle` corpus exists in Service Desk), no chat UI, no
  citation/feedback/prompt persistence, no conversation rename or search.
- Blockers: no default Chat agent profile, `features.execution` and `features.memory` default to
  `false`, streaming adapter unverified, no article search endpoint, markdown-rendering dependency
  decision.

Do not treat any capability as available on the strength of `PLAN.md` alone; the audit marks each one
`available`, `partial` or `missing` with the exact file and line it was verified at.

Same folder, delivered after this audit:

- [`crm-chat-contract.md`](crm-chat-contract.md) — 19-CHAT.1 product contract: decisions, ownership,
  lifecycle, capability model, route surface, data shapes, stream and `AIAgents` contracts.
- [`../security/crm-chat-threat-model.md`](../security/crm-chat-threat-model.md) — 19-CHAT.1 threat
  model: trust boundaries, prompt-injection reasoning, blocked action classes and phased gaps.
