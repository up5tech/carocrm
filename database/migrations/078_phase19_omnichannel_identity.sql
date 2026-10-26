-- Phase 19-OM.7 — Omnichannel identity resolution (PLAN_Phase_19_Omnichannel.md §14 OM.7;
-- docs/omnichannel/feature-contract.md §6).
--
-- The Voice contact resolver matches a stored `phoneNumber` as digits
-- (`regexp_replace(coalesce(attrs->>'phoneNumber',''), '[^0-9]', '', 'g')`, see
-- `voice-contact-resolver.service.ts`) because CRM phones are human-formatted text. Without an
-- expression index that predicate scans `entity_records` for every inbound conversation — the gap
-- the OM.0 audit recorded. This index mirrors the resolver's expression **exactly**; it is additive
-- and non-destructive (indexes only, no data or schema change in any table).
--
-- Scope: the three resolving entity types, live rows only. `deleted_at IS NULL` matches the
-- resolver's predicate, so a soft-deleted Contact is neither scanned nor indexed twice.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_entity_records_phone_digits
  ON entity_records ((regexp_replace(coalesce(attrs->>'phoneNumber', ''), '[^0-9]', '', 'g')))
  WHERE entity_type IN ('Contact', 'Lead', 'Account') AND deleted_at IS NULL;

COMMIT;
