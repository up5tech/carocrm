-- Phase 19-MA.13 — journey enrollment dedupe and step idempotency
-- (PLAN_Phase_19_Marketing_Automation.md §6.4, §15 `19-MA.13`).
-- Additive only: unique indexes over rows this module owns.

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_journey_enrollment_dedupe
  ON entity_records ((attrs ->> 'journeyId'), (attrs ->> 'dedupeKey'))
  WHERE entity_type = 'MarketingJourneyEnrollment'
    AND deleted_at IS NULL
    AND (attrs ->> 'dedupeKey') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_journey_enrollment_state
  ON entity_records ((attrs ->> 'state'), (attrs ->> 'nextRunAt'))
  WHERE entity_type = 'MarketingJourneyEnrollment' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_journey_step_idem
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'MarketingJourneyStepExecution'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_journey_step_enrollment
  ON entity_records ((attrs ->> 'enrollmentId'), (attrs ->> 'startedAt'))
  WHERE entity_type = 'MarketingJourneyStepExecution' AND deleted_at IS NULL;
