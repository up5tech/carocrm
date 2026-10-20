-- Phase 19-INT.6–19-INT.13 — Advanced Integrations engine persistence.
--
-- Additive only (AGENTS.md §3.5): new tables and their indexes. No existing table, column or row
-- is touched, and nothing is seeded — no connector is enabled by default.
--
-- Every table here is *control-plane* state, like migration 056. It lives outside `entity_records`
-- on purpose: a metadata entity is reachable through the generic `/api/v1/:entity` API, and a
-- direct write would bypass the engine's state machines, uniqueness rules and audit trail.

-- ---------------------------------------------------------------------------
-- 19-INT.12 — the opaque webhook endpoint key
--
-- The provider is given a URL containing this key instead of the connection id, so the endpoint
-- cannot be enumerated. It is a **routing identifier, not a secret**: the secret is the provider's
-- signature. The column is nullable, because a connection whose provider has no webhook support
-- never needs one.
-- ---------------------------------------------------------------------------

ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS webhook_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_connections_webhook_key
  ON integration_connections (webhook_key)
  WHERE webhook_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 19-INT.7 — external id links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_external_links (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key        TEXT NOT NULL,
  object_type         TEXT NOT NULL,
  -- The provider's identifier, always a string. A numeric-looking id is never parsed as a number.
  external_id         TEXT NOT NULL,
  -- The provider's parent identifier, when the object lives in a container.
  external_parent_id  TEXT,
  -- The CRM side of the link.
  crm_entity_type     TEXT,
  crm_entity_id       TEXT,
  link_status         TEXT NOT NULL DEFAULT 'linked'
                        CHECK (link_status IN ('linked', 'unlinked', 'conflict')),
  -- The provider's version token or etag, used to detect a change on the provider side.
  provider_version    TEXT,
  provider_updated_at TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at           TIMESTAMPTZ,
  -- A redacted, non-sensitive note. Never a payload and never a credential.
  detail              TEXT
);
-- One link per (connection, object type, provider object id). This is the uniqueness that makes a
-- sync idempotent: the same provider object can never point at two CRM records.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_external_links_identity
  ON integration_external_links (connection_id, object_type, external_id);
-- A CRM record may be linked to only one provider object per connection and object type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_external_links_crm
  ON integration_external_links (connection_id, object_type, crm_entity_id)
  WHERE crm_entity_id IS NOT NULL AND link_status = 'linked';
CREATE INDEX IF NOT EXISTS idx_integration_external_links_lookup
  ON integration_external_links (connection_id, crm_entity_type, crm_entity_id);

-- ---------------------------------------------------------------------------
-- 19-INT.8 — object and field mappings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_object_mappings (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,
  object_type       TEXT NOT NULL,
  -- The CRM entity this mapping writes into.
  crm_entity_type   TEXT NOT NULL,
  -- Which way data flows. `inbound` reads the provider and writes the CRM.
  direction         TEXT NOT NULL DEFAULT 'inbound'
                      CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  -- Bumped whenever the mapping's fields change. A run records the version it used.
  mapping_version   INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'retired')),
  sync_mode         TEXT NOT NULL DEFAULT 'incremental'
                      CHECK (sync_mode IN ('full', 'incremental')),
  -- The conflict policy (feature contract §5.3). `manual` never overwrites a CRM field silently.
  conflict_policy   TEXT NOT NULL DEFAULT 'manual'
                      CHECK (conflict_policy IN ('provider_wins', 'crm_wins', 'manual', 'newest_wins')),
  -- What a provider-side delete does. A provider delete never hard-deletes a CRM record.
  deletion_policy   TEXT NOT NULL DEFAULT 'unlink'
                      CHECK (deletion_policy IN ('unlink', 'archive', 'ignore')),
  -- Per-field authority, e.g. {"amount": "provider", "title": "crm"}.
  field_authority   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id     TEXT,
  modified_by_id    TEXT
);
-- One active mapping per (connection, object type). A retired mapping keeps its history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_object_mappings_active
  ON integration_object_mappings (connection_id, object_type)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_integration_object_mappings_connection
  ON integration_object_mappings (connection_id, status);

CREATE TABLE IF NOT EXISTS integration_field_mappings (
  id            TEXT PRIMARY KEY,
  mapping_id    TEXT NOT NULL REFERENCES integration_object_mappings (id) ON DELETE CASCADE,
  -- A dotted path into the provider object, e.g. 'organizer.email'.
  source_path   TEXT NOT NULL,
  -- The CRM field the value is written to.
  target_field  TEXT NOT NULL,
  -- The allowlisted transformation (19-INT.8). `null` is a direct copy. An expression, a script
  -- and a template are all rejected — only the allowlisted set is accepted.
  transform     JSONB,
  required      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Which direction this field participates in.
  direction     TEXT NOT NULL DEFAULT 'inbound'
                  CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_field_mappings_target
  ON integration_field_mappings (mapping_id, target_field, direction);

-- ---------------------------------------------------------------------------
-- 19-INT.9 — sync runs, operations and checkpoints
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  mapping_id          TEXT NOT NULL REFERENCES integration_object_mappings (id) ON DELETE CASCADE,
  run_type            TEXT NOT NULL
                        CHECK (run_type IN ('full', 'incremental', 'webhook', 'manual')),
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  trigger_source      TEXT NOT NULL DEFAULT 'schedule'
                        CHECK (trigger_source IN ('schedule', 'manual', 'webhook', 'event')),
  direction           TEXT NOT NULL DEFAULT 'inbound'
                        CHECK (direction IN ('inbound', 'outbound')),
  -- The mapping version this run used, so a mapping change mid-run is visible afterwards.
  mapping_version     INTEGER NOT NULL DEFAULT 1,
  -- The opaque provider cursors. The runtime never decodes them.
  cursor_before       TEXT,
  cursor_after        TEXT,
  records_scanned     INTEGER NOT NULL DEFAULT 0,
  records_applied     INTEGER NOT NULL DEFAULT 0,
  records_skipped     INTEGER NOT NULL DEFAULT 0,
  records_failed      INTEGER NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  last_error_code     TEXT,
  last_error_detail   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_connection
  ON integration_sync_runs (connection_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_mapping
  ON integration_sync_runs (mapping_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_sync_operations (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES integration_sync_runs (id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL,
  operation_type  TEXT NOT NULL
                    CHECK (operation_type IN ('fetch', 'apply', 'push', 'delete')),
  external_id     TEXT,
  crm_entity_type TEXT,
  crm_entity_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'skipped', 'failed', 'dead_letter')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- The idempotency key an operation carries. The same key is never applied twice.
  idempotency_key TEXT,
  -- The redacted record the operation produced. Never a credential.
  payload         JSONB,
  error_code      TEXT,
  error_detail    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_sync_operations_idempotency
  ON integration_sync_operations (connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_sync_operations_run
  ON integration_sync_operations (run_id, status);

CREATE TABLE IF NOT EXISTS integration_sync_checkpoints (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  mapping_id    TEXT NOT NULL REFERENCES integration_object_mappings (id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- The opaque provider cursor. It advances only past an operation that succeeded.
  cursor_value  TEXT,
  -- Set when the provider reports the cursor is no longer valid; the next run does a full sync.
  reset_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_sync_checkpoints_key
  ON integration_sync_checkpoints (connection_id, mapping_id, direction);

-- ---------------------------------------------------------------------------
-- 19-INT.10 — conflicts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_conflicts (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  mapping_id          TEXT NOT NULL REFERENCES integration_object_mappings (id) ON DELETE CASCADE,
  run_id              TEXT,
  object_type         TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  crm_entity_type     TEXT,
  crm_entity_id       TEXT,
  conflict_type       TEXT NOT NULL
                        CHECK (conflict_type IN ('field_conflict', 'duplicate', 'deletion', 'authorization')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'resolved', 'ignored')),
  -- The two sides of the conflict, redacted. They are what an operator compares.
  local_snapshot      JSONB,
  remote_snapshot     JSONB,
  -- The fields that disagree, with both values.
  conflicting_fields  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The policy the mapping declares.
  policy              TEXT NOT NULL DEFAULT 'manual',
  -- What was decided, and by whom.
  resolution          TEXT,
  resolved_by         TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_conflicts_open
  ON integration_conflicts (connection_id, object_type, external_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_integration_conflicts_status
  ON integration_conflicts (connection_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 19-INT.11 — resilience: rate limits, circuit breakers, dead letters
-- ---------------------------------------------------------------------------

-- A token bucket per provider or connection. The state is shared, because the API and the worker
-- are separate processes and a per-process limiter would let them exceed the provider's quota
-- between them.
CREATE TABLE IF NOT EXISTS integration_rate_limit_buckets (
  key         TEXT PRIMARY KEY,
  tokens      REAL NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A circuit breaker per provider and connection.
CREATE TABLE IF NOT EXISTS integration_circuit_states (
  key           TEXT PRIMARY KEY,
  state         TEXT NOT NULL DEFAULT 'closed'
                 CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ,
  next_probe_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_dead_letters (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key   TEXT NOT NULL,
  -- The failed operation, when there was one.
  operation_id   TEXT,
  error_code     TEXT NOT NULL,
  error_category TEXT NOT NULL,
  error_detail   TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  -- The redacted payload that failed. Never a credential.
  payload        JSONB,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'replayed', 'discarded')),
  replayed_at    TIMESTAMPTZ,
  replayed_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_open
  ON integration_dead_letters (connection_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 19-INT.12 — webhook deliveries
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key    TEXT NOT NULL,
  -- The provider's own delivery identifier. It is the deduplication key.
  delivery_id     TEXT NOT NULL,
  object_type     TEXT,
  external_id     TEXT,
  event_type      TEXT,
  status          TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'processed', 'failed', 'rejected', 'duplicate')),
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  -- The redacted payload. Never a credential, and never the raw signature.
  payload         JSONB,
  error_code      TEXT,
  error_detail    TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
-- The deduplication constraint: a provider delivery is processed once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_webhook_deliveries_dedup
  ON integration_webhook_deliveries (connection_id, delivery_id);
CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_recent
  ON integration_webhook_deliveries (connection_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 19-INT.13 — outbound operations and record origins
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_outbound_operations (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  mapping_id      TEXT NOT NULL REFERENCES integration_object_mappings (id) ON DELETE CASCADE,
  crm_entity_type TEXT NOT NULL,
  crm_entity_id   TEXT NOT NULL,
  operation_type  TEXT NOT NULL CHECK (operation_type IN ('create', 'update', 'delete')),
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'applied', 'skipped', 'failed', 'dead_letter')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- The idempotency key. The same key is never pushed twice.
  idempotency_key TEXT,
  -- The domain event that caused this operation. It is how an echo is recognised.
  origin_event_id TEXT,
  -- The redacted payload to push. Never a credential.
  payload         JSONB,
  error_code      TEXT,
  error_detail    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_outbound_operations_idempotency
  ON integration_outbound_operations (connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_outbound_operations_queue
  ON integration_outbound_operations (connection_id, status, created_at);

-- The origin of the last change to a CRM record.
--
-- This is how an echo is prevented (plan §11.6): when an inbound sync writes a record, the origin
-- is recorded, and the outbound path sees that the last change came from a sync and skips it.
CREATE TABLE IF NOT EXISTS integration_record_origins (
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  mapping_id    TEXT,
  -- `inbound_sync`, `outbound_sync` or `user`.
  origin        TEXT NOT NULL CHECK (origin IN ('inbound_sync', 'outbound_sync', 'user')),
  -- The event or operation that produced the change.
  origin_ref    TEXT,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_record_origins_record
  ON integration_record_origins (entity_type, entity_id);
