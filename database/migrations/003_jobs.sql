-- 003_jobs.sql — job progress, logs, retries and cancellation (PLAN.md §24)
-- Additive only: existing `jobs` rows keep their meaning, new columns default to the old shape.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress         INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS message          TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS queue_job_id     TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_jobs_queue_job_id ON jobs (queue_job_id) WHERE queue_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);

-- One line per `context.log(...)` call; ordered by seq so a burst inside one millisecond stays readable.
CREATE TABLE IF NOT EXISTS job_logs (
  seq        BIGSERIAL PRIMARY KEY,
  job_id     TEXT   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  level      TEXT   NOT NULL DEFAULT 'info',
  message    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs (job_id, seq);
