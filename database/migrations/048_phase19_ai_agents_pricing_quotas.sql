-- Phase 19-AI.13 — pricing snapshots for the usage ledger
-- (PLAN_Phase_19_AI_Agents.md §12.1 "versioned configured price data").
--
-- Costs must never be hard-coded in business logic. An administrator maintains a snapshot per
-- provider/model, prices are per million tokens, and the ledger records which snapshot produced an
-- estimate so a report can distinguish an estimate from a provider-confirmed value. A wildcard
-- model `*` applies to every model of that provider until a more specific row supersedes it.

CREATE TABLE IF NOT EXISTS ai_agent_pricing_snapshots (
  id                        TEXT PRIMARY KEY,
  provider_key              TEXT NOT NULL,
  -- Exact model name, or `*` for every model of this provider.
  model                     TEXT NOT NULL,
  currency                  TEXT NOT NULL DEFAULT 'USD',
  input_price_per_million   NUMERIC(18, 8) NOT NULL,
  output_price_per_million  NUMERIC(18, 8) NOT NULL,
  cached_input_price_per_million NUMERIC(18, 8) NOT NULL DEFAULT 0,
  valid_from                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id        TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_pricing_snapshots_prices_check CHECK (
    input_price_per_million >= 0
    AND output_price_per_million >= 0
    AND cached_input_price_per_million >= 0
  ),
  CONSTRAINT ai_agent_pricing_snapshots_currency_check CHECK (char_length(currency) = 3)
);

-- The newest valid snapshot for a (provider, model) pair wins; the partial unique index keeps one
-- snapshot per target at a time while the wildcard stays optional.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_pricing_snapshots_target
  ON ai_agent_pricing_snapshots (provider_key, model);

CREATE INDEX IF NOT EXISTS idx_ai_agent_pricing_snapshots_provider
  ON ai_agent_pricing_snapshots (provider_key, valid_from DESC);
