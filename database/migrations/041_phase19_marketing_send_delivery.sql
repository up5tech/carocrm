-- Phase 19-MA.8 — send definition, audience snapshot binding and recipient delivery records
-- (PLAN_Phase_19_Marketing_Automation.md §5.5, §5.6, §6.1, §6.5, §15 `19-MA.8`).
--
-- `MarketingSend` and `MarketingSendTransition` are ordinary metadata records in `entity_records`, exactly
-- like `Campaign` and `CampaignTransition` before them, so ACL, audit, validation and serialisation stay in
-- the Entity Engine and `database/seed-metadata.ts` carries the entity definitions. This file adds only what
-- JSON attributes cannot express:
--
--   1. **One live send per (campaign, slot).** §5.5/§5.6 speak of a send *slot*: a recipient has one delivery
--      record per intended send slot, and a second concurrent definition for the same slot would make that
--      rule unenforceable. The unique index is what makes it impossible rather than merely discouraged.
--   2. The lookups the module actually performs: a campaign's sends, the sends a scheduler will claim by
--      state, and a send's own history.
--   3. The per-recipient ledger itself (`marketing_recipient_deliveries`), which is bulk derived state and
--      therefore a table rather than a record — the same decision `marketing_audience_snapshot_entries`
--      (038) and `email_deliveries` (006) already made.
--
-- Additive only (AGENTS.md §3.5, plan §0.1 rule 11): no existing table, column or row is altered, dropped or
-- repurposed, and every statement is `IF NOT EXISTS`.

-- ---------------------------------------------------------------------------
-- Send definitions (§5.5)
-- ---------------------------------------------------------------------------

-- The slot identity: at most one live send per campaign slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_send_slot
  ON entity_records ((attrs ->> 'campaignId'), (attrs ->> 'slot'))
  WHERE entity_type = 'MarketingSend'
    AND deleted_at IS NULL;

-- A campaign's sends, newest first — the campaign detail surface.
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_send_campaign
  ON entity_records ((attrs ->> 'campaignId'), created_at)
  WHERE entity_type = 'MarketingSend'
    AND deleted_at IS NULL;

-- What MA.9's scheduler claims: sends in a given state, ordered by when they were meant to go.
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_send_status
  ON entity_records ((attrs ->> 'status'), (attrs ->> 'scheduledAt'))
  WHERE entity_type = 'MarketingSend'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Send history (§5.5, the `CampaignTransition` counterpart)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_send_transition_send
  ON entity_records ((attrs ->> 'sendId'), (attrs ->> 'occurredAt'))
  WHERE entity_type = 'MarketingSendTransition'
    AND deleted_at IS NULL;

-- A replayed command is a no-op, not a second lifecycle row (§0.1 rule 10).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_send_transition_idem
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'MarketingSendTransition'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Recipient delivery ledger (§5.5, §6.5)
-- ---------------------------------------------------------------------------
--
-- One row per (send, slot, resolved recipient): the durable answer to "who was this send meant for, what did
-- the gate decide about them, and what happened?" A dry run and a validation both produce these rows from the
-- frozen audience snapshot, and MA.9 advances them (`Eligible` → `Queued` → `Sending` → `Sent`/`Failed`)
-- under the `RECIPIENT_DELIVERY_TRANSITIONS` machine declared in the domain.
--
-- Identity is `(entity_type, entity_id)` plus the keyed `email_hash`: the plaintext address is not stored
-- here either (§6.1 "minimized recipient-address snapshot fields", §9.3), and `reasons` carries every rule
-- that decided the row so an operator can explain a block without a second query (§5.5 "shows the reasons").
CREATE TABLE IF NOT EXISTS marketing_recipient_deliveries (
  send_id      TEXT NOT NULL REFERENCES entity_records (id) ON DELETE CASCADE,
  -- The intended send slot, so a follow-up message to the same person is a different row, not a rewrite.
  slot         INTEGER NOT NULL DEFAULT 1,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  email_hash   TEXT,
  -- RecipientDeliveryStatus: Eligible/Blocked/Skipped from the forecast, then Queued/Sending/Sent/… (MA.9).
  state        TEXT NOT NULL,
  -- The headline forecast category this row came from, kept alongside the state so the dry run's explanation
  -- survives into delivery time.
  category     TEXT,
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Filled by MA.9/MA.10; present now so the delivery fact has one home and no second ledger appears.
  provider_message_id TEXT,
  provider_key TEXT,
  content_hash TEXT,
  error_code   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The §5.6 rule made structural: one delivery record per recipient per intended send slot.
  PRIMARY KEY (send_id, slot, entity_type, entity_id)
);

-- The delivery worker's and the detail screen's query: a send's rows by state.
CREATE INDEX IF NOT EXISTS idx_marketing_recipient_deliveries_state
  ON marketing_recipient_deliveries (send_id, state);

-- "Which sends named this address?" — the privacy and reconciliation question (§6.7, §5.8).
CREATE INDEX IF NOT EXISTS idx_marketing_recipient_deliveries_identity
  ON marketing_recipient_deliveries (email_hash) WHERE email_hash IS NOT NULL;

-- One *message* per address per slot, even when two CRM records share an address. Skipped rows are excluded
-- because they deliberately name every record the forecast resolved (a Lead and a Contact with one address
-- are two skipped rows and zero messages) — the rule being enforced is about messages, not rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_recipient_deliveries_address
  ON marketing_recipient_deliveries (send_id, slot, email_hash)
  WHERE email_hash IS NOT NULL AND state <> 'Skipped';
