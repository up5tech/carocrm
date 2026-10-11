-- 001_init.sql — CRM Kernel Alpha schema (PLAN.md §44)

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  user_name        TEXT NOT NULL UNIQUE,
  account_name     TEXT,
  first_name       TEXT,
  last_name        TEXT,
  email_address    TEXT,
  is_admin         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  portal_types     JSONB NOT NULL DEFAULT '[]',
  type             TEXT NOT NULL DEFAULT 'regular',
  auth_method      TEXT NOT NULL DEFAULT 'password',
  password         TEXT,
  assigned_role_ids JSONB NOT NULL DEFAULT '[]',
  title            TEXT,
  phone            TEXT,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id    TEXT,
  modified_by_id   TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  api_token    TEXT UNIQUE,
  refresh_token TEXT UNIQUE,
  revoked_at   TIMESTAMPTZ,
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_access_at TIMESTAMPTZ,
  expired_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS api_users (
  id            TEXT PRIMARY KEY,
  user_name     TEXT NOT NULL UNIQUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_role_ids JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  api_user_id  TEXT NOT NULL REFERENCES api_users (id) ON DELETE CASCADE,
  secret_hash  TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (api_user_id);

CREATE TABLE IF NOT EXISTS roles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  permissions     JSONB NOT NULL DEFAULT '{}',
  field_permissions JSONB NOT NULL DEFAULT '{}',
  entity_type     TEXT NOT NULL DEFAULT 'Role',
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  user_id      JSONB NOT NULL DEFAULT '[]',
  role_ids     JSONB NOT NULL DEFAULT '[]',
  is_private   BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users_roles (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS users_teams (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

CREATE TABLE IF NOT EXISTS teams_roles (
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, role_id)
);

CREATE TABLE IF NOT EXISTS metadata_entries (
  scope      TEXT NOT NULL,
  name       TEXT NOT NULL,
  data       JSONB NOT NULL,
  version    BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, name)
);

CREATE TABLE IF NOT EXISTS app_settings (
  name       TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entity_records (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL,
  name             TEXT,
  attrs            JSONB NOT NULL DEFAULT '{}',
  assigned_user_id TEXT,
  created_by_id    TEXT,
  modified_by_id   TEXT,
  team_ids         JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_entity_records_type ON entity_records (entity_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_entity_records_assigned ON entity_records (assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_entity_records_created_by ON entity_records (created_by_id);
CREATE INDEX IF NOT EXISTS idx_entity_records_created_at ON entity_records (created_at);
CREATE INDEX IF NOT EXISTS idx_entity_records_modified_at ON entity_records (modified_at);
CREATE INDEX IF NOT EXISTS idx_entity_records_attrs ON entity_records USING GIN (attrs);

CREATE TABLE IF NOT EXISTS entity_links (
  id            TEXT PRIMARY KEY,
  entity_type_a TEXT NOT NULL,
  record_id_a   TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  entity_type_b TEXT NOT NULL,
  record_id_b   TEXT NOT NULL,
  role_a        TEXT,
  role_b        TEXT,
  attributes    JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type_a, record_id_a, relation_name, entity_type_b, record_id_b)
);
CREATE INDEX IF NOT EXISTS idx_entity_links_a ON entity_links (entity_type_a, record_id_a, relation_name);
CREATE INDEX IF NOT EXISTS idx_entity_links_b ON entity_links (entity_type_b, record_id_b, relation_name);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Attachment',
  size        BIGINT NOT NULL,
  mime_type   TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  checksum    TEXT,
  parent_id   TEXT,
  parent_type TEXT,
  field       TEXT,
  role        TEXT,
  created_by_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_parent ON attachments (parent_type, parent_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  username    TEXT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  "order"     INTEGER NOT NULL DEFAULT 0,
  data        JSONB NOT NULL DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log (entity_type, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (status, available_at);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  job        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  scheduling_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  target     JSONB NOT NULL DEFAULT '{}',
  result     JSONB
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id       TEXT PRIMARY KEY,
  job      TEXT NOT NULL,
  scheduling TEXT NOT NULL,
  target   JSONB NOT NULL DEFAULT '{}',
  enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_changes (
  id          TEXT PRIMARY KEY,
  operation   TEXT NOT NULL,
  entity_type TEXT,
  field_name  TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  user_id     TEXT,
  criteria    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboards (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  config   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
