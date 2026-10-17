-- 035_phase19_service_desk_conversation.sql — Phase 19-SD.6: explicit conversation visibility
-- (PLAN_Phase_19_ServiceDesk.md §5.4, §10.3).
--
-- Every conversation entry and every attachment now carries an explicit visibility classification,
-- enforced server-side rather than inferred from the UI or the author:
--
--   public   — permitted for the customer/requester and authorised portal users.
--   internal — staff only; never returned to a portal principal or a customer-bound message.
--   system   — a generated audit/event entry; internal only, rendered as a safe summary.
--
-- Both columns are additive with a NOT NULL default, so existing rows are classified without a
-- rewrite. Existing rows are classified conservatively: generated `Update` items become `system`,
-- and every other pre-existing stream entry becomes `internal`. Nothing that existed before this
-- migration becomes customer-visible, so switching a portal on cannot retroactively expose
-- historical staff chatter.

ALTER TABLE stream_items ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'internal';

UPDATE stream_items SET visibility = 'system' WHERE type = 'Update' AND visibility <> 'system';

-- Attachments default to `public` — governed by the parent record's read ACL exactly as before. The
-- stream service lowers an attachment to `internal` when it is linked to an internal message.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

-- Supports the portal read path, which always filters to customer-visible entries.
CREATE INDEX IF NOT EXISTS idx_stream_items_entity_visibility
  ON stream_items (entity_type, entity_id, visibility, created_at DESC) WHERE is_deleted = FALSE;
