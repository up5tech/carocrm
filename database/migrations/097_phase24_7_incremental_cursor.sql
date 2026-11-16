-- 097_phase24_7_incremental_cursor.sql — remember which feed a checkpoint cursor belongs to.
--
-- Phase 24.7 completes the incremental path: an `incremental` mapping reads the connector's
-- **delta feed** (Google's `syncToken`, Graph's `@odata.deltaLink`) instead of re-enumerating every
-- page, so a change is collected without re-reading the whole object. A checkpoint cursor therefore
-- belongs to one of two feeds, and a cursor of the other feed is not a valid starting point — a
-- page offset handed to a delta reader is a cursor the connector refuses.
--
-- Rows written before this migration hold **page** cursors, so the default is `page`. The engine
-- reacts to that by starting the delta feed at its beginning instead of resuming from a page
-- cursor; the external link makes that one re-read idempotent (the same provider object resolves to
-- the same CRM record). Nothing existing is rewritten and no cursor is dropped here.

ALTER TABLE integration_sync_checkpoints
  ADD COLUMN IF NOT EXISTS cursor_kind TEXT NOT NULL DEFAULT 'page'
    CHECK (cursor_kind IN ('page', 'delta'));