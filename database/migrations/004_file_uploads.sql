-- 004_file_uploads.sql — chunked uploads for large files (PLAN.md §25)
--
-- A client reserves an upload, sends parts out of order if it likes, then completes: the parts are
-- assembled into the final storage key, scanned and turned into one `attachments` row. Only
-- metadata lives here; bytes live in the configured FileStorage under `uploads/<id>/<index>`.

CREATE TABLE IF NOT EXISTS file_uploads (
  id             TEXT PRIMARY KEY,
  created_by_id  TEXT,
  name           TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  total_size     BIGINT NOT NULL,
  chunk_max_size INTEGER NOT NULL,
  received       BIGINT NOT NULL DEFAULT 0,
  part_count     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',
  parent_type    TEXT,
  parent_id      TEXT,
  field          TEXT,
  role           TEXT,
  storage_prefix TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_uploads_status ON file_uploads (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_file_uploads_creator ON file_uploads (created_by_id, created_at DESC);
