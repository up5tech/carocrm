-- 096_phase24_7_sync_metadata.sql — metadata for inbound mail and calendar sync.
--
-- Why a migration and not only `database/seed-metadata.ts`: the production images **never run the
-- seed** (`docs/runbooks/installation-and-upgrade.md`), so an installation that upgrades from an
-- older build keeps the metadata it has. A field that only exists in the seed file is a field the
-- running system does not have — and the entity engine *drops* unknown fields on write, so the
-- record would silently lose it.
--
-- Two groups of fields:
--
--  1. **Phase 24.6 — the inbound mail fields** (`Email.inboundConnectionId`, `messageKind`,
--     `inboundParsed`, `inboundError`). The scoped dedupe reads `inboundConnectionId` from the
--     stored record; without the field every poll would look like a first poll and re-ingest the
--     whole mailbox.
--  2. **Phase 24.7 — `Call.location` and `Meeting.location`**, so a synced calendar event keeps
--     the place it happens.
--
-- The statements are **additive and idempotent**: a field that is already there is left alone, so
-- an installation that *did* run the seed is not changed, and an administrator's own edits to the
-- same entity are preserved — only the named field is added. The metadata lives in two places
-- (`metadata_entries`, the core layer, and `app_settings.entity`, the administrator's layer), and
-- both are patched, because the merge in `MetadataStoreService` reads both.

UPDATE metadata_entries
SET data = jsonb_set(data, '{fields,inboundConnectionId}', '{"type":"varchar","maxLength":255,"inDetail":true}'::jsonb, true)
WHERE scope = 'entity' AND name = 'Email' AND NOT (data -> 'fields' ? 'inboundConnectionId');

UPDATE metadata_entries
SET data = jsonb_set(data, '{fields,messageKind}', '{"type":"enum","values":["Standard","Bounce","AutoReply"],"defaultValue":"Standard","inDetail":true}'::jsonb, true)
WHERE scope = 'entity' AND name = 'Email' AND NOT (data -> 'fields' ? 'messageKind');

UPDATE metadata_entries
SET data = jsonb_set(data, '{fields,inboundParsed}', '{"type":"bool","defaultValue":true,"inDetail":true}'::jsonb, true)
WHERE scope = 'entity' AND name = 'Email' AND NOT (data -> 'fields' ? 'inboundParsed');

UPDATE metadata_entries
SET data = jsonb_set(data, '{fields,inboundError}', '{"type":"text","label":"Inbound parse note","inDetail":true}'::jsonb, true)
WHERE scope = 'entity' AND name = 'Email' AND NOT (data -> 'fields' ? 'inboundError');

UPDATE metadata_entries
SET data = jsonb_set(data, '{fields,location}', '{"type":"varchar","maxLength":255,"inList":true,"inDetail":true,"inEdit":true}'::jsonb, true)
WHERE scope = 'entity' AND name IN ('Call', 'Meeting') AND NOT (data -> 'fields' ? 'location');

UPDATE app_settings
SET data = jsonb_set(data, '{Email,fields,inboundConnectionId}', '{"type":"varchar","maxLength":255,"inDetail":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Email' AND NOT (data -> 'Email' -> 'fields' ? 'inboundConnectionId');

UPDATE app_settings
SET data = jsonb_set(data, '{Email,fields,messageKind}', '{"type":"enum","values":["Standard","Bounce","AutoReply"],"defaultValue":"Standard","inDetail":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Email' AND NOT (data -> 'Email' -> 'fields' ? 'messageKind');

UPDATE app_settings
SET data = jsonb_set(data, '{Email,fields,inboundParsed}', '{"type":"bool","defaultValue":true,"inDetail":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Email' AND NOT (data -> 'Email' -> 'fields' ? 'inboundParsed');

UPDATE app_settings
SET data = jsonb_set(data, '{Email,fields,inboundError}', '{"type":"text","label":"Inbound parse note","inDetail":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Email' AND NOT (data -> 'Email' -> 'fields' ? 'inboundError');

UPDATE app_settings
SET data = jsonb_set(data, '{Call,fields,location}', '{"type":"varchar","maxLength":255,"inList":true,"inDetail":true,"inEdit":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Call' AND NOT (data -> 'Call' -> 'fields' ? 'location');

UPDATE app_settings
SET data = jsonb_set(data, '{Meeting,fields,location}', '{"type":"varchar","maxLength":255,"inList":true,"inDetail":true,"inEdit":true}'::jsonb, true)
WHERE name = 'entity' AND data ? 'Meeting' AND NOT (data -> 'Meeting' -> 'fields' ? 'location');
