-- Phase 19-AI.23 — MCP direct-call idempotency receipts
-- (plans/PLAN_Phase_19_AI_Agents.md §24, `19-AI.23`).
--
-- `POST /api/v1/AIAgents/action/mcp/call` executes a tool with no run behind it, so the run
-- pipeline's `ai_agent_tool_calls(run_id, idempotency_key)` dedup cannot apply — and
-- `ai_agent_tool_calls.run_id` has an FK to `ai_agent_runs`, which a `mcp-direct` sentinel cannot
-- satisfy. A replayed `low_write` call would therefore duplicate its effect.
--
-- This table is the dedicated receipt the plan calls for: one row per
-- `(principal_id, idempotency_key)` holding the tool-call id the caller saw and the serialized
-- result. A replay returns the stored pair without re-executing; `result` stays NULL while the
-- owning call is still in flight so a concurrent duplicate can tell "pending" from "done".
--
-- Additive only: new table, no change to existing rows (AGENTS.md §3.5).

CREATE TABLE IF NOT EXISTS ai_agent_mcp_direct_calls (
  id               TEXT PRIMARY KEY,
  principal_id     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  tool_key         TEXT NOT NULL,
  argument_hash    TEXT NOT NULL,
  call_id          TEXT NOT NULL,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_mcp_direct_calls_principal_key UNIQUE (principal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_mcp_direct_calls_principal
  ON ai_agent_mcp_direct_calls (principal_id, created_at);
