-- Phase 19-VC.15 — recordings are a provider event kind. The 051 table carries a CHECK constraint
-- that predates the `recording` kind; this replaces it additively (no data is touched).
ALTER TABLE voice_communication_events
  DROP CONSTRAINT voice_communication_events_kind_check;
ALTER TABLE voice_communication_events
  ADD CONSTRAINT voice_communication_events_kind_check
    CHECK (kind IN ('call', 'message', 'status', 'recording', 'unknown'));
