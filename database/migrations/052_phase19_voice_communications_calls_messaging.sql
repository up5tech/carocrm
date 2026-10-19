-- Phase 19-VC.7/VC.10/VC-VC.11 — call-session and message idempotency keys, WhatsApp templates.
-- Additive only: new nullable columns and new tables. No existing column is altered or dropped.

-- Duplicate-click protection for an outbound call (§7.1 "provider timeout and duplicate-click
-- protection"): the client-generated key is unique, so a retried initiation cannot place a second call.
ALTER TABLE voice_call_sessions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_call_sessions_idem
  ON voice_call_sessions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Durable send identity for a message (§8.1 "persist an outbound message attempt and idempotency key
-- before external dispatch"): a restarted worker re-reading the row must not send twice.
ALTER TABLE voice_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_messages_idem
  ON voice_messages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Locally held WhatsApp Business template metadata (§8.3). The provider owns approval; this records
-- what it told us, so a send can be validated without calling the vendor first.
CREATE TABLE IF NOT EXISTS voice_whatsapp_templates (
  id               TEXT PRIMARY KEY,
  account_key      TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE CASCADE,
  template_key     TEXT NOT NULL,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  language         TEXT NOT NULL,
  components       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  vendor_status    TEXT,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_whatsapp_templates_key
  ON voice_whatsapp_templates (account_key, template_key, language);
