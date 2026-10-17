-- 036_phase19_service_desk_hardening.sql — Phase 19-SD.17: indexes for SLA/clock queries.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_sla_state
  ON entity_records ((attrs ->> 'slaState'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_escalated
  ON entity_records ((attrs ->> 'isEscalated'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_sla_clock_case
  ON entity_records ((attrs ->> 'caseId'), (attrs ->> 'targetType'))
  WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_sla_clock_due
  ON entity_records ((attrs ->> 'dueAt'))
  WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL;
