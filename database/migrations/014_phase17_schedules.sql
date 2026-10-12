-- Phase 17 — owner-bound scheduled report delivery.
-- A schedule is user-owned; the worker target contains only the schedule id, never a principal snapshot.
CREATE TABLE IF NOT EXISTS report_schedules (
  id                TEXT PRIMARY KEY,
  report_id         TEXT NOT NULL UNIQUE REFERENCES reports (id) ON DELETE CASCADE,
  owner_user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scheduled_job_id  TEXT NOT NULL UNIQUE,
  cron              TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_owner ON report_schedules (owner_user_id, enabled);
