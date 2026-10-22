-- Phase 19-ES.2 — ESignature persistence: connections, requests, recipients, document snapshots,
-- provider events, the webhook inbox, template mappings and the lifecycle audit trail.
-- (PLAN_Phase_19_ESignature.md §6, §7, §10, §12.1, §18 `19-ES.2`; data-model decision in
-- docs/implementation/esignature-audit.md §6.)
--
-- ADDITIVE ONLY (AGENTS.md §3.5): eight new tables and their indexes. No existing table, column or
-- row is touched, nothing is seeded, and no connection is enabled — a fresh installation has no
-- DocuSign connection, so every provider path stays closed.
--
-- Why these are dedicated tables rather than `entity_records` metadata entities (audit §6): a
-- metadata entity is reachable through the generic `/api/v1/:entity` API, and a direct `PATCH` on a
-- signature request would move it between lifecycle states, forge a `provider_envelope_id`, or mark
-- a contract signed — without passing the state machine, the send guard or the credential vault. The
-- provider is the signing authority (plan §1.2), so the state machine and the send guard must be the
-- only mutation path. The same rationale is recorded in
-- database/migrations/056_phase19_advanced_integrations.sql:6-10.
--
-- Credentials are absent by construction. `esignature_connections` stores a **non-secret** OAuth
-- client id and the account context; the client secret, the refresh token and the Connect HMAC secret
-- live only in `integration_credential_secrets` (the encrypted vault, keyed by `ENCRYPTION_KEY`),
-- referenced by (connection id, kind) — plan §4.1, §6.1.
--
-- Personal data is minimized and bounded (plan §12.1): recipient identity is a snapshot as submitted,
-- raw provider payloads are not stored here at all (only a hash plus the fields the projection needs),
-- and the rows that carry any payload have a `purge_after` the retention job reads. Evidence rows
-- (`signature_provider_events`, `signature_audit_entries`, signed artifacts) never get a purge date by
-- default: dropping the proof of a signed contract is a reviewed decision, not a cron default.

-- ---------------------------------------------------------------------------
-- 1. The provider connection (plan §6.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS esignature_connections (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  -- First release: `docusign` only. A future adapter adds a value here, and nothing above the
  -- adapter boundary changes (plan §1).
  provider_key        TEXT NOT NULL CHECK (provider_key IN ('docusign')),
  -- Demo and production are separate integrations, secrets, redirect URIs and stored identities;
  -- an existing connection is never silently switched between them (plan §9.2, §9.4).
  environment         TEXT NOT NULL CHECK (environment IN ('demo', 'production')),
  status              TEXT NOT NULL DEFAULT 'not_connected'
                        CHECK (status IN ('not_connected', 'connected', 'reauthorization_required',
                                          'disabled', 'error')),
  -- The operator's switch. `status = 'connected'` says the grant is live; `is_active` says this
  -- installation is currently willing to use it. A provider call requires both (plan §4.1).
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,
  -- The OAuth **client id**: public by nature, and the only credential-shaped idea allowed here.
  oauth_client_id     TEXT,
  redirect_uri        TEXT,
  -- The account context discovered from `GET {authHost}/oauth/userinfo` → `accounts[]`. Never
  -- hard-coded, because the REST base URI is per account (plan §3.2).
  account_id          TEXT,
  account_name        TEXT,
  base_uri            TEXT,
  subject_user_id     TEXT,
  granted_scopes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_status      TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (consent_status IN ('unknown', 'granted', 'insufficient', 'revoked')),
  -- The opaque routing id in the Connect webhook path (`/api/v1/integrations/esignature/:publicId`).
  -- A random identifier, not a secret: it authenticates nothing on its own (plan §8.3).
  public_id           TEXT NOT NULL,
  -- Non-secret reference to the provider-side Connect configuration, for the runbook and the
  -- health view. The HMAC secret itself is a vault row.
  connect_reference   TEXT,
  last_auth_at        TIMESTAMPTZ,
  last_successful_api_at TIMESTAMPTZ,
  last_webhook_at     TIMESTAMPTZ,
  last_error_at       TIMESTAMPTZ,
  -- A sanitized code, never a provider body (plan §9.3).
  last_error_code     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id       TEXT,
  modified_by_id      TEXT,
  -- Soft delete: disconnecting a connection must never delete request history or signed artifacts
  -- that point at it (plan §21.12).
  deleted_at          TIMESTAMPTZ
);

-- Two named connections to one provider in one environment are different accounts; a third row with
-- the same name in the same environment is a mistake, not a configuration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_esignature_connections_name
  ON esignature_connections (provider_key, environment, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_esignature_connections_public_id
  ON esignature_connections (public_id);
CREATE INDEX IF NOT EXISTS idx_esignature_connections_state
  ON esignature_connections (status, is_active, environment);
-- The gate's hot read: "is there any usable connection at all".
CREATE INDEX IF NOT EXISTS idx_esignature_connections_live
  ON esignature_connections (provider_key, environment)
  WHERE deleted_at IS NULL AND status = 'connected' AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_esignature_connections_expiry
  ON esignature_connections (last_auth_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The signature request (plan §6.2, §4.3, §4.7)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_requests (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  -- The normalized lifecycle. The vocabulary is frozen here: a stored value must keep its meaning
  -- after the mapper is corrected against live demo payloads in ES.12.
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_approval', 'ready_to_send', 'sending',
                                            'send_unknown', 'sent', 'delivered', 'partially_signed',
                                            'completed', 'declined', 'voided', 'expired',
                                            'provider_error', 'reconciliation_required')),
  provider_key          TEXT NOT NULL CHECK (provider_key IN ('docusign')),
  -- NULL while the request is a local draft: a draft means no envelope exists (plan §4.3).
  connection_id         TEXT REFERENCES esignature_connections (id) ON DELETE RESTRICT,
  -- Filled only once the provider has accepted the envelope. Kept as an opaque string: a DocuSign
  -- envelope id is not an integer and is not globally unique.
  provider_envelope_id  TEXT,
  -- The provider's own vocabulary, preserved verbatim for troubleshooting and forward compatibility.
  provider_status_raw   TEXT,
  -- The linked CRM record, as a validated (type, id) pair. The type is checked against the metadata
  -- registry before it reaches this column and is never interpolated into SQL (AGENTS.md §5.2).
  source_entity_type    TEXT,
  source_record_id      TEXT,
  -- Message data handed to the provider. Signer emails and names live on `signature_recipients`,
  -- never here.
  subject               TEXT,
  message               TEXT,
  email_blurb           TEXT,
  created_by_id         TEXT,
  -- The tenancy boundary the record-level ACL evaluates in later phases: the owner and the teams that
  -- may see the request, alongside the linked record's own ACL (plan §12.2).
  assigned_user_id      TEXT,
  team_ids              JSONB NOT NULL DEFAULT '[]'::jsonb,
  prepared_by_id        TEXT,
  approved_by_id        TEXT,
  sent_by_id            TEXT,
  prepared_at           TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  declined_at           TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,
  expired_at            TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  -- Approval is module policy, not a BPM deployment (audit §2). `approved_digest` binds the decision
  -- to the exact reviewed snapshot: a changed document or recipient invalidates it (plan §11.2, §17).
  approval_required     BOOLEAN NOT NULL DEFAULT FALSE,
  approval_status       TEXT NOT NULL DEFAULT 'not_required'
                          CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approval_reason       TEXT,
  approved_at           TIMESTAMPTZ,
  approved_digest       TEXT,
  -- The stable correlation token of one deliberate send attempt. One effective send per attempt id,
  -- enforced below, is what makes a lost response recoverable instead of duplicated (plan §4.3, §16).
  send_attempt_id       TEXT,
  -- The immutable outgoing snapshot: the exact documents, recipients, routing and message data
  -- submitted to the provider, in a versioned envelope with a SHA-256 digest (plan §4.3). Editing a
  -- source document after sending cannot change what is recorded here.
  outgoing_snapshot     JSONB,
  outgoing_digest       TEXT,
  last_reconciled_at    TIMESTAMPTZ,
  last_provider_sync_at TIMESTAMPTZ,
  -- Failure classification, redacted by construction: a category, a stable code and a safe message.
  failure_category      TEXT,
  failure_code          TEXT,
  failure_message_safe  TEXT,
  -- Optimistic concurrency (plan §6.2 "record version"). Every guarded transition bumps it, so a
  -- stale preview cannot overwrite a newer state and a stale send cannot be confirmed twice.
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by_id        TEXT,
  deleted_at            TIMESTAMPTZ
);

-- A DocuSign envelope id is unique **within the account context**, not globally (plan §6.2). The
-- connection supplies that context, and NULL envelopes (drafts) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_requests_envelope
  ON signature_requests (connection_id, provider_envelope_id)
  WHERE provider_envelope_id IS NOT NULL AND deleted_at IS NULL;
-- One live request per send attempt: a retry of a timed-out send cannot create a second envelope
-- quietly, because the correlation token is already taken.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_requests_send_attempt
  ON signature_requests (send_attempt_id) WHERE send_attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signature_requests_status ON signature_requests (status, modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_signature_requests_connection ON signature_requests (connection_id, status);
CREATE INDEX IF NOT EXISTS idx_signature_requests_source ON signature_requests (source_entity_type, source_record_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_created ON signature_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signature_requests_sent ON signature_requests (sent_at DESC) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signature_requests_completed ON signature_requests (completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signature_requests_declined ON signature_requests (declined_at DESC) WHERE declined_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signature_requests_voided ON signature_requests (voided_at DESC) WHERE voided_at IS NOT NULL;
-- The operator queues: needs approval, and needs reconciliation (plan §13.2, §14).
CREATE INDEX IF NOT EXISTS idx_signature_requests_approval
  ON signature_requests (approval_status, modified_at DESC) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_signature_requests_attention
  ON signature_requests (status, modified_at DESC)
  WHERE status IN ('send_unknown', 'provider_error', 'reconciliation_required');
CREATE INDEX IF NOT EXISTS idx_signature_requests_creator ON signature_requests (created_by_id);
-- "My Requests / Requests I Need to Review" (plan §13.1).
CREATE INDEX IF NOT EXISTS idx_signature_requests_owner ON signature_requests (assigned_user_id, status);

-- ---------------------------------------------------------------------------
-- 3. Recipients, as submitted (plan §6.4)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_recipients (
  id                     TEXT PRIMARY KEY,
  request_id             TEXT NOT NULL REFERENCES signature_requests (id) ON DELETE CASCADE,
  -- The provider's recipient id for this person once the envelope exists.
  provider_recipient_id  TEXT,
  -- The first release addresses signers and carbon copies; any other DocuSign recipient type must
  -- be declared before it can be stored (plan §4.4).
  recipient_type         TEXT NOT NULL CHECK (recipient_type IN ('signer', 'carbon_copy')),
  -- Populated when the signer is a known Contact. The name and email below are the **snapshot** that
  -- was submitted, because a Contact's email can change later and the evidence must not (plan §6.4).
  crm_contact_id         TEXT,
  name                   TEXT NOT NULL,
  email                  TEXT NOT NULL,
  -- The DocuSign template role this recipient fills, when a template is used (plan §6.7, ES.7).
  role_name              TEXT,
  -- 1..n. Equal routing orders are parallel; strictly increasing orders are sequential (plan §4.4).
  routing_order          INTEGER NOT NULL CHECK (routing_order >= 1),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'sent', 'delivered', 'viewed', 'signed',
                                             'completed', 'declined', 'canceled', 'expired')),
  provider_status_raw    TEXT,
  sent_at                TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ,
  viewed_at              TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  declined_at            TIMESTAMPTZ,
  -- The decline reason, sanitized of any provider body or credential (plan §6.4).
  decline_reason_safe    TEXT,
  -- A non-secret description of the identity-verification method the account offers.
  authentication_method  TEXT,
  -- The last event that moved this projection, so a duplicate or older event is a no-op (plan §4.7).
  last_status_event_id   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id          TEXT,
  modified_by_id         TEXT,
  -- Soft delete only. Once a request has been sent, a recipient row is evidence of who was asked to
  -- sign and must not disappear.
  deleted_at             TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_recipients_provider_id
  ON signature_recipients (request_id, provider_recipient_id)
  WHERE provider_recipient_id IS NOT NULL AND deleted_at IS NULL;
-- Two recipients may share a routing order (parallel signing, plan §4.4), but no two may fill the
-- same template role: an ambiguous role mapping is exactly what the send preview must refuse.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_recipients_role
  ON signature_recipients (request_id, role_name) WHERE role_name IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signature_recipients_request ON signature_recipients (request_id, routing_order);
CREATE INDEX IF NOT EXISTS idx_signature_recipients_status ON signature_recipients (status, modified_at DESC);
-- "Requests waiting on a specific recipient" (plan §14) and contact resolution.
CREATE INDEX IF NOT EXISTS idx_signature_recipients_email ON signature_recipients (email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signature_recipients_contact ON signature_recipients (crm_contact_id) WHERE crm_contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Document snapshots and derived artifacts (plan §6.3, §4.5)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_document_snapshots (
  id                   TEXT PRIMARY KEY,
  request_id           TEXT NOT NULL REFERENCES signature_requests (id) ON DELETE CASCADE,
  -- Which of the four roles this row plays. A signed document is a **new derived artifact**; the
  -- source attachment is never overwritten (plan §4.5).
  artifact_kind        TEXT NOT NULL
                         CHECK (artifact_kind IN ('source_snapshot', 'provider_signed_document',
                                                  'completion_evidence', 'supporting_document')),
  -- The CRM attachment the bytes came from, for source snapshots. Not a foreign key: the request
  -- must still be auditable if the attachment is later removed.
  source_attachment_id TEXT,
  -- The immutable version reference of that file, when the file service has one.
  source_version_id    TEXT,
  display_name         TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  byte_size            BIGINT NOT NULL CHECK (byte_size >= 0),
  -- SHA-256 of the exact bytes handed to the provider — not of whatever the file is today.
  content_hash_sha256  TEXT NOT NULL CHECK (content_hash_sha256 ~ '^[0-9a-f]{64}$'),
  -- The storage reference of the snapshot itself, through the platform's file service. A key, not a
  -- public URL, and never a signed URL (plan §12.6).
  storage_ref          TEXT,
  document_order       INTEGER NOT NULL DEFAULT 1 CHECK (document_order >= 1),
  -- The provider's document id for the artifact, when the provider returns one. This plus the content
  -- hash is the stable artifact key that makes a retried download a no-op (plan §16).
  provider_document_id TEXT,
  -- `evidence` rows (signed documents, completion certificates) are never purged automatically.
  retention_class      TEXT NOT NULL DEFAULT 'business'
                         CHECK (retention_class IN ('transient', 'business', 'evidence')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id        TEXT,
  deleted_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_documents_order
  ON signature_document_snapshots (request_id, document_order)
  WHERE artifact_kind = 'source_snapshot' AND deleted_at IS NULL;
-- Artifact retrieval is idempotent by construction: the same provider document cannot be stored twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_documents_provider_id
  ON signature_document_snapshots (request_id, artifact_kind, provider_document_id)
  WHERE provider_document_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_documents_hash
  ON signature_document_snapshots (request_id, artifact_kind, content_hash_sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signature_documents_request ON signature_document_snapshots (request_id, artifact_kind);
CREATE INDEX IF NOT EXISTS idx_signature_documents_source ON signature_document_snapshots (source_attachment_id) WHERE source_attachment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Normalized provider events — append-only history (plan §6.5, §10.3)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_provider_events (
  id                          TEXT PRIMARY KEY,
  connection_id               TEXT REFERENCES esignature_connections (id) ON DELETE RESTRICT,
  -- NULL until the envelope is matched to a request; an unmatched event is still evidence, and an
  -- unknown envelope must never be dropped (plan §10.4).
  request_id                  TEXT REFERENCES signature_requests (id) ON DELETE RESTRICT,
  provider_key                TEXT NOT NULL CHECK (provider_key IN ('docusign')),
  provider_account_id         TEXT,
  provider_envelope_id        TEXT,
  -- The deduplication key: the provider's event id when it supplies one, otherwise a deterministic
  -- key built from verified event fields plus the payload hash. Unique, so a replayed delivery
  -- cannot create a second transition, artifact or notification (plan §10.1.4).
  dedup_key                   TEXT NOT NULL UNIQUE,
  provider_event_id           TEXT,
  -- The normalized name, or `unmapped`. Unknown is never success (plan §10.4).
  event_type_normalized       TEXT NOT NULL,
  provider_event_type_raw     TEXT,
  recipient_provider_id       TEXT,
  provider_occurred_at        TIMESTAMPTZ,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at                TIMESTAMPTZ,
  payload_hash                TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  -- The minimized event: only the fields the projection needs. The full body is never kept by
  -- default (plan §6.5, §12.1).
  event_data                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_verification_status TEXT NOT NULL
                                  CHECK (signature_verification_status IN ('verified', 'invalid', 'not_required')),
  processing_status           TEXT NOT NULL DEFAULT 'pending'
                                CHECK (processing_status IN ('pending', 'applied', 'ignored', 'duplicate',
                                                              'unmapped', 'failed', 'dead_letter')),
  attempt_count               INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_processing_error_safe  TEXT,
  correlation_id              TEXT,
  -- Data-minimization deadline for the row's minimized payload; NULL means "keep as evidence".
  purge_after                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signature_provider_events_request
  ON signature_provider_events (request_id, received_at);
CREATE INDEX IF NOT EXISTS idx_signature_provider_events_envelope
  ON signature_provider_events (connection_id, provider_envelope_id, received_at);
CREATE INDEX IF NOT EXISTS idx_signature_provider_events_pending
  ON signature_provider_events (processing_status, received_at)
  WHERE processing_status IN ('pending', 'failed', 'dead_letter');
CREATE INDEX IF NOT EXISTS idx_signature_provider_events_purge
  ON signature_provider_events (purge_after) WHERE purge_after IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Webhook inbox — the durable receipt, before any state changes (plan §10.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_webhook_inbox (
  id                          TEXT PRIMARY KEY,
  -- The connection the delivery is addressed to, resolved from the routing id. NULL when nothing
  -- matched, which is recorded rather than guessed (plan §8.3).
  connection_id               TEXT REFERENCES esignature_connections (id) ON DELETE RESTRICT,
  routing_public_id           TEXT,
  provider_key                TEXT NOT NULL CHECK (provider_key IN ('docusign')),
  provider_account_id         TEXT,
  provider_envelope_id        TEXT,
  -- One row per accepted delivery, deduplicated structurally so a retried POST is a no-op.
  dedup_key                   TEXT NOT NULL UNIQUE,
  payload_hash                TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  content_length              INTEGER NOT NULL CHECK (content_length >= 0),
  -- The verification result decided **before** any payload field was trusted (plan §10.2).
  signature_status            TEXT NOT NULL
                                CHECK (signature_status IN ('verified', 'invalid', 'not_required')),
  content_type                TEXT,
  -- A minimized copy of the accepted body, bounded by the settings policy and purged on schedule.
  payload_minimized           JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                       TEXT NOT NULL DEFAULT 'received'
                                CHECK (state IN ('received', 'processing', 'processed', 'ignored',
                                                  'duplicate', 'retryable', 'dead_letter')),
  processed_at                TIMESTAMPTZ,
  attempt_count               INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_safe             TEXT,
  correlation_id              TEXT,
  purge_after                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signature_webhook_inbox_state
  ON signature_webhook_inbox (state, received_at) WHERE state IN ('received', 'retryable', 'dead_letter');
CREATE INDEX IF NOT EXISTS idx_signature_webhook_inbox_envelope
  ON signature_webhook_inbox (connection_id, provider_envelope_id, received_at);
CREATE INDEX IF NOT EXISTS idx_signature_webhook_inbox_purge
  ON signature_webhook_inbox (purge_after) WHERE purge_after IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Template mappings — local workflow to provider template (plan §6.7, ES.7)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_template_mappings (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  mapping_type             TEXT NOT NULL DEFAULT 'workflow'
                             CHECK (mapping_type IN ('workflow', 'document_type', 'process')),
  connection_id            TEXT NOT NULL REFERENCES esignature_connections (id) ON DELETE RESTRICT,
  -- The provider template stays bound to the account that owns it (plan §13 acceptance in ES.7).
  provider_template_id     TEXT NOT NULL,
  provider_template_name   TEXT,
  -- Which CRM entity types may start a request from this mapping. Validated against the metadata
  -- registry before it is stored; never an identifier interpolated into SQL.
  supported_source_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Role-to-recipient assignments, validated against an allowlist in the service, never evaluated.
  role_mappings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_mappings           JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_subject          TEXT,
  default_message          TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT FALSE,
  version                  INTEGER NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id            TEXT,
  modified_by_id           TEXT,
  deleted_at               TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_template_mappings_name
  ON signature_template_mappings (connection_id, name) WHERE deleted_at IS NULL;
-- A template id belongs to one connection; the same provider template is not mapped twice for the
-- same workflow type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_template_mappings_template
  ON signature_template_mappings (connection_id, provider_template_id, mapping_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signature_template_mappings_active
  ON signature_template_mappings (connection_id, is_active);

-- ---------------------------------------------------------------------------
-- 8. Lifecycle audit — append-only to application code (plan §6.6)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signature_audit_entries (
  id                TEXT PRIMARY KEY,
  request_id        TEXT REFERENCES signature_requests (id) ON DELETE RESTRICT,
  connection_id     TEXT REFERENCES esignature_connections (id) ON DELETE RESTRICT,
  recipient_id      TEXT,
  document_id       TEXT,
  -- One of the declared lifecycle actions (`request.prepared`, `send.confirmed`,
  -- `embedded_view.created`, `artifact.downloaded`, …). The repository validates the name against the
  -- allowlist in `esignature-domain.ts`, so a typo cannot invent an unaudited action.
  action            TEXT NOT NULL,
  actor_type        TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  actor_id          TEXT,
  actor_name        TEXT,
  -- What the action targeted, as a validated (type, id) pair rather than a foreign key: the target
  -- may be a CRM record this module does not own.
  target_entity_type TEXT,
  target_id         TEXT,
  outcome           TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'refused')),
  -- A safe reason: a void reason, a refusal cause. Never a token, a signing URL or document content.
  reason_safe       TEXT,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signature_audit_entries_request
  ON signature_audit_entries (request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signature_audit_entries_connection
  ON signature_audit_entries (connection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signature_audit_entries_action
  ON signature_audit_entries (action, created_at);
CREATE INDEX IF NOT EXISTS idx_signature_audit_entries_actor
  ON signature_audit_entries (actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signature_audit_entries_correlation
  ON signature_audit_entries (correlation_id) WHERE correlation_id IS NOT NULL;
