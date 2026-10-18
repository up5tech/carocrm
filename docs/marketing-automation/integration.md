# Phase 19-MA.16 — Optional module integration contracts

Marketing Automation never imports Sales, CustomerSuccess, ServiceDesk or Portal. Optional integrations are
detected by metadata marker (see `OPTIONAL_INTEGRATIONS` in `marketing-automation-module.ts`) and can be
disabled independently. Supported cross-module events (whitelisted in `JOURNEY_TRIGGER_EVENTS`):

- Sales: `sales.opportunity.stageChanged` — attribution/influence only, no financial data is duplicated.
- CustomerSuccess: `customerSuccess.health.statusChanged` — lifecycle events only when explicitly configured.
- ServiceDesk: `serviceDesk.case.statusChanged` — approved, non-promotional use; transactional service
  notices remain separate from marketing consent.
- Core CRM: `entity.created`, `entity.updated` for Lead/Contact/Account.

Rules:

- Cross-module events are versioned, idempotent and carry a causation depth; chains are bounded by
  `MAX_CAUSATION_DEPTH` (3).
- Customer support activity cannot silently enroll contacts into promotional messaging — an enrollment
  requires a published journey plus the consent gate.
- Portal users can affect only their own preferences through the public preference endpoints.
