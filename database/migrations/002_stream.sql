-- 002_stream.sql — Stream / timeline and notifications (PLAN.md §26)

CREATE TABLE IF NOT EXISTS stream_items (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}',
  post           TEXT,
  created_by_id  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_stream_items_entity ON stream_items (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stream_items_created_by ON stream_items (created_by_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stream_items_type ON stream_items (type) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS stream_mentions (
  id              TEXT PRIMARY KEY,
  stream_item_id  TEXT NOT NULL REFERENCES stream_items (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  char_offset     INT
);
CREATE INDEX IF NOT EXISTS idx_stream_mentions_item ON stream_mentions (stream_item_id);
CREATE INDEX IF NOT EXISTS idx_stream_mentions_user ON stream_mentions (user_id);

CREATE TABLE IF NOT EXISTS stream_followers (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unq_stream_followers UNIQUE (entity_type, entity_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_stream_followers_user ON stream_followers (user_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS stream_attachments (
  id              TEXT PRIMARY KEY,
  stream_item_id  TEXT NOT NULL REFERENCES stream_items (id) ON DELETE CASCADE,
  attachment_id   TEXT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stream_attachments_item ON stream_attachments (stream_item_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read, created_at DESC);
