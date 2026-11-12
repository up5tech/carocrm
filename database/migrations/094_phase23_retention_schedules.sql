-- Phase 23.7 — retention schedules exist, not just handlers.
--
-- G14 recorded that the kernel cleanup handlers existed but no `scheduled_jobs` row ever called
-- them, so the tables grew unless an operator submitted each sweep by hand. These rows are
-- idempotent: re-running the migration keeps the operator's edits to an existing schedule.
--
-- Windows are the documented defaults:
--   outbox 7 days, sessions 30, jobs 30, signature/voice receipts 90, marketing receipts 30,
--   orphan stream rows 30. An operator can change a `target` value without a deploy; setting an
--   invalid value falls back to the handler's documented default.

INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled, created_at, modified_at)
VALUES
  ('system-retention-outbox', 'system.cleanupOutbox', '15 3 * * *',
   '{"retentionDays": 7}'::jsonb, TRUE, now(), now()),
  ('system-retention-sessions', 'system.pruneSessions', '25 3 * * *',
   '{"retentionDays": 30}'::jsonb, TRUE, now(), now()),
  ('system-retention-jobs', 'system.cleanupJobs', '35 3 * * *',
   '{"retentionDays": 30, "batchSize": 500}'::jsonb, TRUE, now(), now()),
  ('system-retention-provider-receipts', 'system.cleanupProviderReceipts', '45 3 * * *',
   '{"signatureDays": 90, "voiceDays": 90, "marketingDays": 30, "batchSize": 500}'::jsonb, TRUE, now(), now()),
  ('system-retention-stream-orphans', 'system.cleanupStreamOrphans', '55 3 * * *',
   '{"retentionDays": 30, "batchSize": 500}'::jsonb, TRUE, now(), now())
ON CONFLICT (id) DO NOTHING;
