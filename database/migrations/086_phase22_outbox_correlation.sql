-- Phase 22.21 — carry the originating request id through the transactional outbox.
--
-- A module writes the event in the caller's transaction; the worker consumes it seconds or minutes
-- later, in another process. Without the request id on the row the only way to connect the two is
-- to guess by timestamp. The column is nullable because scheduled/worker-created events have no
-- request behind them, and the index is partial because a null is never looked up.
--
-- Additive and safe: no row is rewritten, no existing column changes.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_correlation
  ON outbox_events (correlation_id)
  WHERE correlation_id IS NOT NULL;
