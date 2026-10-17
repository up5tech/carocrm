-- Phase 19 — Customer Success (PLAN_Phase_19_Customer_Success.md §6.4).
--
-- Customer Success records live in the generic `entity_records` store (JSONB `attrs`) exactly like
-- every other CRM entity, so the Entity Engine keeps ownership of CRUD, validation, audit, stream and
-- record ACL. What JSON alone cannot express is the one invariant the module's whole model rests on —
-- a single *active* profile per account — so that becomes a partial unique index over `attrs`.
--
-- Additive only (AGENTS.md §3.5): new indexes only. No table is created, dropped, truncated or
-- rewritten, and no existing row is modified.

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- §5.1 / §13.1: one active `CustomerSuccessProfile` per Account. The index is partial on
-- `deleted_at IS NULL`, so a soft-deleted profile does not block a new one for the same account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_success_profile_account
  ON entity_records ((attrs ->> 'accountId'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

-- §5.11.3: a triggerable playbook runs once per idempotency key (account+template+window). The key
-- is optional, so the index ignores rows where it is absent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_success_run_trigger
  ON entity_records ((attrs ->> 'triggerKey'))
  WHERE entity_type = 'CustomerSuccessPlaybookRun'
    AND deleted_at IS NULL
    AND attrs ->> 'triggerKey' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Query support: portfolio filters, queues, history and job scans
-- ---------------------------------------------------------------------------

-- §5.2: portfolio queues by CSM, team, health, lifecycle and renewal window.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_csm
  ON entity_records ((attrs ->> 'csmUserId'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_team
  ON entity_records ((attrs ->> 'csmTeamId'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_health
  ON entity_records ((attrs ->> 'healthStatus'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_lifecycle
  ON entity_records ((attrs ->> 'lifecycleStage'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_onboarding
  ON entity_records ((attrs ->> 'onboardingStatus'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_profile_renewal
  ON entity_records ((attrs ->> 'renewalDate'))
  WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL;

-- §5.4.4: the trend/history read loads a profile's snapshots newest-first.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_snapshot_profile_time
  ON entity_records ((attrs ->> 'profileId'), (attrs ->> 'calculatedAt'))
  WHERE entity_type = 'CustomerSuccessHealthSnapshot' AND deleted_at IS NULL;

-- §5.6 / §5.7: plans and goals by profile/plan and status.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_plan_profile
  ON entity_records ((attrs ->> 'profileId'), (attrs ->> 'status'))
  WHERE entity_type = 'CustomerSuccessPlan' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_goal_plan
  ON entity_records ((attrs ->> 'planId'), (attrs ->> 'status'))
  WHERE entity_type = 'CustomerSuccessGoal' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_goal_due
  ON entity_records ((attrs ->> 'targetDate'))
  WHERE entity_type = 'CustomerSuccessGoal' AND deleted_at IS NULL;

-- §5.8: open-risk queues by profile/severity, and the escalation scan by due date.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_risk_profile
  ON entity_records ((attrs ->> 'profileId'), (attrs ->> 'status'), (attrs ->> 'severity'))
  WHERE entity_type = 'CustomerSuccessRisk' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_risk_due
  ON entity_records ((attrs ->> 'targetResolutionDate'))
  WHERE entity_type = 'CustomerSuccessRisk' AND deleted_at IS NULL;

-- §11.1: the playbook jobs scan running runs and open step runs by assignee/status.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_run_profile
  ON entity_records ((attrs ->> 'profileId'), (attrs ->> 'status'))
  WHERE entity_type = 'CustomerSuccessPlaybookRun' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_step_run
  ON entity_records ((attrs ->> 'runId'), (attrs ->> 'status'))
  WHERE entity_type = 'CustomerSuccessPlaybookStepRun' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_cs_step_assignee
  ON entity_records ((attrs ->> 'assigneeUserId'), (attrs ->> 'status'))
  WHERE entity_type = 'CustomerSuccessPlaybookStepRun' AND deleted_at IS NULL;

-- §5.10: reviews by profile/date.
CREATE INDEX IF NOT EXISTS idx_entity_records_cs_review_profile
  ON entity_records ((attrs ->> 'profileId'), (attrs ->> 'reviewDate'))
  WHERE entity_type = 'CustomerSuccessReview' AND deleted_at IS NULL;
