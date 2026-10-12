-- Phase 17 — delivery idempotency ledger for scheduled report mail.
-- A claimed/ambiguous delivery is not automatically sent again: SMTP cannot participate in a DB
-- transaction, so retrying after an uncertain transport outcome could duplicate an email.
CREATE TABLE IF NOT EXISTS report_deliveries (
  schedule_id       TEXT NOT NULL REFERENCES report_schedules (id) ON DELETE CASCADE,
  scheduled_for_ms  BIGINT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  PRIMARY KEY (schedule_id, scheduled_for_ms),
  CONSTRAINT chk_report_deliveries_status CHECK (status IN ('claimed', 'delivered', 'ambiguous', 'retryable'))
);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_status ON report_deliveries (status, modified_at DESC);
