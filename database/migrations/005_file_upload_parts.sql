-- 005_file_upload_parts.sql — per-chunk ledger for chunked uploads (PLAN.md §25)
--
-- `part_count` and `received` alone cannot tell whether a chunk index was already counted, so a
-- retried part would inflate the totals and a gap would look complete. The ledger records each
-- accepted index with its size; re-sending an index replaces its bytes and counts once.
-- Additive and nullable-safe: existing open uploads simply have no recorded parts yet.

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS parts JSONB NOT NULL DEFAULT '{}'::jsonb;
