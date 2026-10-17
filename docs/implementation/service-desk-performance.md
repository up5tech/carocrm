# Performance and reliability notes

## Indexes

`database/migrations/033_phase19_service_desk.sql` adds:

- `uq_entity_records_case_number` — partial unique index on `attrs->>'caseNumber'` for live cases.
- `idx_entity_records_case_status` — `(attrs->>'status', modified_at)`.
- `idx_entity_records_case_assignee` — `(assigned_user_id, attrs->>'status')`.
- `idx_entity_records_case_account` / `idx_entity_records_case_contact`.

`database/migrations/036_phase19_service_desk_hardening.sql` adds:

- `idx_entity_records_case_sla_state` — dashboard/backlog filters.
- `idx_entity_records_case_escalated`.
- `idx_entity_records_case_sla_clock_case` — `(caseId, targetType)` for clock lookups/reopen cycles.
- `idx_entity_records_case_sla_clock_due` — due-date scans.

Queue/routing and history indexes are declared in the `CaseQueue`/`RoutingRule`/`CaseTransition`/
`CaseAssignment` metadata and created by the same additive migration path.

## Bounded work

- The SLA scan loads at most 500 clocks per run (`SLA_SCAN_BATCH_SIZE`) and reports `truncated`;
  the next tick continues. Per-case watcher and case rows are cached within the run.
- Business-time arithmetic is bounded to 200,000 minute steps per calculation, so a malformed
  calendar cannot loop indefinitely.
- Duplicate detection scans at most 200 candidates sharing the Account/Contact and returns at most
  10 readable ones; it does not scan every case.
- Metrics use `EntityCrudService.aggregate`, which sets a 5s `statement_timeout` inside the
  transaction, applies the record ACL in SQL, and caps groups (`maxGroups`).
- The portal list compiles the contact/account predicate into SQL; it never loads all cases and
  filters in memory.

## Cost notes

- Business-time percentage checks walk minutes within each target window. The bounded batch keeps a
  tick predictable; installations with very large calendars should prefer wider business-hour slots
  over long 24/7 intervals.
- The SLA scan is a per-clock loop with a small number of statements per clock. It is intentionally
  simple rather than a bulk SQL update; at 500 clocks/tick the load is bounded and can be tuned by
  changing `SLA_SCAN_BATCH_SIZE`.
- The scheduler runs every five minutes; each run is a no-op when `features.sla` is off (apart from
  the optional Knowledge expiry sweep).

## Measurements

No production latency measurement has been recorded for this repository yet. The query/index review
above is the current evidence; operational counters (`checked`, `breached`, `warned`, `notified`,
`escalated`, `truncated`) are the first thing to watch when a tick slows down.
