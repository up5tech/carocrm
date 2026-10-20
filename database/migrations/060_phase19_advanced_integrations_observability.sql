-- Phase 19-INT.25 / 19-INT.26 — cross-module contracts, observability and retention.
--
-- Additive only (AGENTS.MD §3.5): one new table, four new columns and their indexes. No existing
-- table, column or row is dropped or rewritten, and nothing is seeded.
--
-- 1. `integration_audit_log` — the module's own audit trail.
--    The kernel audit hook records changes to *entities*. The plan §14.4 also asks for an audit
--    event for every privileged module action: a connection paused, a mapping published, a sync
--    replayed, a conflict resolved. Those actions touch no CRM record, so the kernel hook never
--    sees them. The trail lives in its own table, beside the module's other control-plane state,
--    and it never holds a secret value.
--
-- 2. `integration_field_mappings.allow_protected` — the reviewed-mapping escape hatch for
--    §14.2. An imported payload may not assign owners, teams, roles, payment status, consent or
--    other protected values. A mapping may set the flag, which records that the mapping was
--    *reviewed* — and the flag is refused unless the mapping is the only thing that can turn it on.
--
-- 3. `correlation_id` on a run, an operation and a webhook receipt — the plan §16.2 correlation
--    id. It is the join key between a provider's own request id, the platform's log lines and the
--    operator's report, without any of them carrying personal data.

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id                TEXT PRIMARY KEY,
  -- The connection the action belongs to, when it belongs to one.
  connection_id     TEXT,
  -- The stable action name, e.g. `connection.paused` or `mapping.published`.
  action            TEXT NOT NULL,
  -- The entity the action touched, e.g. `IntegrationConnection`.
  entity_type       TEXT,
  entity_id         TEXT,
  -- The actor. `system` means the module's own service identity; a user id means a person.
  actor_type        TEXT NOT NULL DEFAULT 'system'
                      CHECK (actor_type IN ('system', 'user')),
  actor_id          TEXT,
  actor_name        TEXT,
  -- The reason the caller gave, when the action needed one.
  reason            TEXT,
  -- The outcome: `ok` or `refused`.
  outcome           TEXT NOT NULL DEFAULT 'ok'
                      CHECK (outcome IN ('ok', 'refused')),
  -- A redacted, non-sensitive detail. Never a credential, never a raw provider payload.
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The correlation id of the run or delivery the action belongs to.
  correlation_id    TEXT,
  -- The request id, when the platform supplies one.
  request_id        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_audit_log_connection
  ON integration_audit_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_action
  ON integration_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_created
  ON integration_audit_log (created_at DESC);

-- The reviewed-mapping flag of §14.2. Off by default: a protected target needs an explicit,
-- recorded decision, and the decision is the flag.
ALTER TABLE integration_field_mappings
  ADD COLUMN IF NOT EXISTS allow_protected BOOLEAN NOT NULL DEFAULT FALSE;

-- The plan §16.2 correlation id.
ALTER TABLE integration_sync_runs
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_correlation
  ON integration_sync_runs (correlation_id)
  WHERE correlation_id IS NOT NULL;

ALTER TABLE integration_sync_operations
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

ALTER TABLE integration_webhook_deliveries
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_correlation
  ON integration_webhook_deliveries (correlation_id)
  WHERE correlation_id IS NOT NULL;
