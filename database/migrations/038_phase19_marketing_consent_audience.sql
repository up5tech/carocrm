-- Phase 19-MA.4/MA.5 — audience consent, suppression, public links and snapshots
-- (PLAN_Phase_19_Marketing_Automation.md §5.2, §5.3, §6.1, §6.3, §6.7, §15 `19-MA.4`–`19-MA.5`).
--
-- Consent, suppression, public-token and snapshot *headers* are ordinary metadata records in
-- `entity_records`, like every other CRM record in this platform, so ACL, validation, audit and search stay
-- in the engine. This file adds only what JSON attributes cannot express: the uniqueness rules those records
-- depend on, and the one bulk ledger (snapshot entries) that is operational data rather than a record a
-- person edits.
--
-- Additive only (AGENTS.md §3.5, plan §0.1 rule 11): no existing table is altered, no column is dropped or
-- repurposed, no row is modified or deleted, and every statement is `IF NOT EXISTS`.

-- ---------------------------------------------------------------------------
-- Consent (§5.3, §6.3)
-- ---------------------------------------------------------------------------
--
-- One live consent decision per (address identity, channel, purpose). Without this, two records could hold
-- contradictory states for the same person and the eligibility gate would have no single answer — the exact
-- ambiguity §5.3 invariant 5 refuses to resolve by guessing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_consent_identity
  ON entity_records ((attrs ->> 'emailHash'), (attrs ->> 'channel'), (attrs ->> 'purpose'))
  WHERE entity_type = 'MarketingConsent'
    AND deleted_at IS NULL
    AND (attrs ->> 'emailHash') IS NOT NULL;

-- "Which consent records belong to this person?" — the reverse lookup a contact merge or a data-subject
-- request starts from (§6.7).
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_consent_record
  ON entity_records ((attrs ->> 'entityType'), (attrs ->> 'entityId'))
  WHERE entity_type = 'MarketingConsent'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_consent_status
  ON entity_records ((attrs ->> 'status'), (attrs ->> 'purpose'))
  WHERE entity_type = 'MarketingConsent'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Consent history (§5.3 invariant 9)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_consent_event_consent
  ON entity_records ((attrs ->> 'consentId'), created_at)
  WHERE entity_type = 'MarketingConsentEvent'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_consent_event_identity
  ON entity_records ((attrs ->> 'emailHash'), created_at)
  WHERE entity_type = 'MarketingConsentEvent'
    AND deleted_at IS NULL;

-- An idempotent public endpoint may be pressed twice (a double-click, a mail-client prefetch, a retried
-- webhook). The key is unique so the second call cannot create a second history row (§5.3 invariant 10).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_consent_event_idem
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'MarketingConsentEvent'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Suppression (§5.3, §6.3)
-- ---------------------------------------------------------------------------
--
-- One live block per identity at a given scope. `purpose` and `targetListId` are only set for the narrower
-- scopes, so they are normalised to '' inside the key: Postgres treats NULLs as distinct, which would let a
-- "Global" block be inserted twice with two NULL purposes.
--
-- Partial on "not revoked": revoking a block is a recorded decision (`revokedAt`), and a later block for the
-- same identity must be possible — deleting the row instead would erase the audit trail (§6.8).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_suppression_identity
  ON entity_records (
    (attrs ->> 'emailHash'),
    (attrs ->> 'channel'),
    (attrs ->> 'scope'),
    (coalesce(attrs ->> 'purpose', '')),
    (coalesce(attrs ->> 'targetListId', ''))
  )
  WHERE entity_type = 'MarketingSuppression'
    AND deleted_at IS NULL
    AND (attrs ->> 'revokedAt') IS NULL;

-- The gate's hot path: "is this address blocked anywhere?" for every candidate recipient.
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_suppression_hash
  ON entity_records ((attrs ->> 'emailHash'), (attrs ->> 'channel'))
  WHERE entity_type = 'MarketingSuppression'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Public unsubscribe / preference / confirmation tokens (§5.3.1)
-- ---------------------------------------------------------------------------
--
-- The stored value is a digest of the token, never the token; uniqueness is what makes a collision
-- impossible rather than merely unlikely, and the lookup by digest means a request cannot probe which
-- addresses exist (§15 `19-MA.5` acceptance: "public endpoints do not leak contact existence or permit token
-- enumeration").
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_public_token_hash
  ON entity_records ((attrs ->> 'tokenHash'))
  WHERE entity_type = 'MarketingPublicToken'
    AND deleted_at IS NULL
    AND (attrs ->> 'tokenHash') IS NOT NULL;

-- Issuing a fresh link for a person should be able to revoke the previous ones (§5.3.2).
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_public_token_identity
  ON entity_records ((attrs ->> 'emailHash'), (attrs ->> 'scope'))
  WHERE entity_type = 'MarketingPublicToken'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audience snapshots (§5.2, §6.1)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_snapshot_campaign
  ON entity_records ((attrs ->> 'campaignId'), created_at)
  WHERE entity_type = 'MarketingAudienceSnapshot'
    AND deleted_at IS NULL;

-- The snapshot ledger itself.
--
-- This is the one marketing structure that is not an `entity_records` row, for the same reason
-- `email_deliveries` is not one (006_email_deliveries.sql): it is bulk derived state, one row per resolved
-- recipient, written and read in batches, never edited by a person, and it must not appear in search,
-- stream, audit or the record API. A campaign with 50,000 recipients would otherwise put 50,000 CRM records
-- into a store built for business objects.
--
-- Recipient identity is stored as (entity_type, entity_id) plus the keyed `email_hash` — the plaintext
-- address is *not* duplicated here (§6.1 "minimized recipient-address snapshot fields", §9.3).
CREATE TABLE IF NOT EXISTS marketing_audience_snapshot_entries (
  snapshot_id  TEXT NOT NULL REFERENCES entity_records (id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  email_hash   TEXT,
  -- The headline category: eligible, duplicateAddress, optedOut, consentUnknown, suppressedGlobal, …
  category     TEXT NOT NULL,
  -- Every block that applied, so a dry run explains all of them and not only the first (§5.5).
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which audience named this recipient, for the "explainable" requirement (§1.2).
  sources      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, entity_type, entity_id)
);

-- The send-time question ("who is eligible in this snapshot?") and the privacy question ("which snapshots
-- name this address?") in one index each.
CREATE INDEX IF NOT EXISTS idx_marketing_snapshot_entries_category
  ON marketing_audience_snapshot_entries (snapshot_id, category);
CREATE INDEX IF NOT EXISTS idx_marketing_snapshot_entries_identity
  ON marketing_audience_snapshot_entries (email_hash) WHERE email_hash IS NOT NULL;
