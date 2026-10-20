-- Phase 19-AI — a provider connection may name the Anthropic Messages API adapter next to the
-- OpenAI-compatible one and the deterministic fake adapter. The 045 table carries a CHECK
-- constraint that predates it; this replaces it additively (no row is touched, nothing is
-- dropped).
ALTER TABLE ai_provider_connections
  DROP CONSTRAINT ai_provider_connections_kind_check;
ALTER TABLE ai_provider_connections
  ADD CONSTRAINT ai_provider_connections_kind_check
    CHECK (kind IN ('openai-compatible', 'anthropic', 'fake'));
