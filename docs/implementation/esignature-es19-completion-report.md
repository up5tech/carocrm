# Phase 19-ES.19 — Search, Reports and Dashlets

> `PLAN_Phase_19_ESignature.md` §14, §18 `Phase 19-ES.19`.
> Acceptance: reports obey record and field ACL; aggregate results do not leak inaccessible record
> details; date and status definitions are documented.
>
> Prerequisites read: `esignature-es13-completion-report.md` (the request list and detail contract),
> `esignature-es18-completion-report.md` (the event/lifecycle vocabulary), and the platform's
> `search/dashboard.service.ts` + `projects/project-dashlet.service.ts` (the established dashlet
> special-case pattern).

ES.19 adds the read side of the module: a search over signature requests that is scoped before it is
filtered, a curated set of operational aggregates computed in SQL under the same scope, and one new
dashlet kind that runs through the **existing** dashboard API. No provider call, no write path and no
new table.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `apps/api/src/esignature/dto/esignature-shapes.ts` | `q`, `recipient` and the six ISO date bounds on the list query; the report keys/query schema; `ESignatureDashletConfigSchema`. |
| `apps/api/src/esignature/signature-request.repository.ts` | `likePattern` and `requestAccessSql` (one record-scope predicate shared by the list and the reports), plus the new list predicates. A recipient search is an `exists` subquery over the scoped request. |
| `apps/api/src/esignature/signature-report.repository.ts` | The aggregate SQL: status, sent cohort, completion durations, approval queue, waiting recipients, exceptions and volume. Every query interpolates `requestAccessSql` first. |
| `apps/api/src/esignature/esignature-report.service.ts` | Capability + module check, scope derivation, the window, rate arithmetic, report definitions and the per-key result shapes. |
| `apps/api/src/esignature/esignature.controller.ts` | `GET /action/reports` and `GET /action/reports/:key`. |
| `apps/api/src/esignature/esignature-request.{controller,service}.ts` | The list filters are parsed and passed through; no route reads a report. |
| `apps/api/src/search/dashboard.service.ts`, `portal-shapes.ts` | The `esignature` dashlet kind; config validated by the module schema and executed as the **reader**. |
| `database/migrations/068_phase19_esignature_reporting.sql` | Additive replacement of `chk_dashlets_kind` by a strict superset that includes `esignature`. |
| `apps/web/src/pages/esignature/ESignatureReportsPanel.tsx` | The reporting screen (window selector, KPI row, status/rate/queue/volume tables). |
| `apps/web/src/pages/esignature/ESignatureRequestsPanel.tsx` | Subject and recipient search fields wired to the scoped list. |
| `apps/web/src/pages/DashboardsPage.tsx`, `DashletResult.tsx` | Dashlet configuration for `esignature` and the aggregate renderer. |
| `apps/api/test/esignature-reporting.test.ts` | The search, ACL, aggregate-privacy, window-definition and dashlet suite. |

---

## 2. How each acceptance criterion is held

**Reports obey record ACL.** Scope is not re-invented: `requestAccessSql` is the exact predicate the
request list already used (`assigned_user_id = me`, `created_by_id = me`, or a scoped team's
`team_ids`). Every report query interpolates it before grouping, and the waiting report joins to the
scoped request before it touches a recipient row. The same capstone test creates one user with
`SignatureRequest: read: own` and an administrator: the scoped user sees 2 requests, 1 completed
outcome and no queue items, while the administrator sees 6 requests, a 3-request sent cohort, the
pending approval, the waiting recipient and the exception. **Field ACL** for these dedicated tables
is not the metadata field-permission system (they are not metadata entities); the report projection
instead carries only fixed aggregate fields — counts, rates, durations, opaque owner/source ids — and
never a stored record field.

**Aggregates do not leak inaccessible record details.** The repository selects nothing but `status`,
`count`, duration percentiles, `assigned_user_id` and `source_entity_type`. A recipient filter is
applied inside the scoped join and only its counts are returned; the search term itself is not echoed
back. The suite serializes a full report and asserts it does not contain the run marker (request
names), a recipient name, an email address or the test prefix.

**Date and status definitions are documented.** The table in
`docs/compatibility/esignature.md` §3.1 is the contract: status/volume use `created_at`, rates use
the `sent_at` cohort, completion time uses `completed_at`, and the current queues ignore the window.
The statuses are the ES.12 normalized vocabulary; `completed` is only ever the provider-confirmed
local state, never an inference.

**Dashlets use the existing API only.** No new dashboard endpoint was added. `POST
/Dashboard/:id/dashlets` accepts `kind: 'esignature'` with `{view, days}`, and `…/action/run`
returns the same section payload as `/action/reports/:key`. The dashlet executes with the **reader's**
request scope: the suite creates one dashboard as the scoped user, runs it as that user (2 requests)
and as the administrator (6), proving a shared dashboard is not a way to count rows the reader
cannot list.

---

## 3. Definitions that are easy to get wrong

- **Rates denominator.** A request is in the cohort if it was sent in the window, even if it has since
  completed, declined or been voided. A request still `sent`/`delivered`/`partially_signed` is
  `inFlight`; it is in no numerator. With a three-request cohort of one completed, one declined and
  one in flight, the completion rate is 1/3, not 1/2.
- **Completion duration.** Only requests with both `sent_at` and `completed_at`, and
  `completed_at >= sent_at`, contribute. Median and p90 are `percentile_cont` (interpolated), the
  average is arithmetic; all are rounded to one decimal hour.
- **Approval age.** Measured from `approval_requested_at`, which is set both by policy-driven
  preparation and by the explicit `request-approval` command. Rows older than 24 h and 3 days are
  reported as overlapping bins.
- **Waiting recipients.** A request in flight with two outstanding recipients counts **once** in
  `requestsWaiting` and twice in `recipientsWaiting`; the per-status table counts recipients, not
  requests.
- **Volume owner.** Grouped by `assigned_user_id` (the module's owner column), not by
  `created_by_id`; a report viewer sees only owners present in their scoped rows.

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `pnpm vitest run apps/api/test/esignature-reporting.test.ts` | **12/12 passed** against the configured database. |
| `pnpm typecheck` | Passed (API + web). |
| `pnpm lint` | Passed for the changed files. |
| `pnpm db:migrate` | `068_phase19_esignature_reporting.sql` applied; additive constraint replacement only. |
| SPA | `ESignatureReportsPanel` renders on the module page; dashlet creation/run exercised in the browser (see the session log). |
| Existing ESignature suites | Re-run as part of the full suite; no changes to write paths. |

The test fixtures are created directly in `signature_requests` / `signature_recipients` because the
subject under test is the read model; their names carry the run marker and they are deleted by id in
`afterAll`. The `ESignature` settings row is restored to its prior value.

---

## 5. Known limitations / deferred

- **Provider API latency and error rate, OAuth refresh failures, Connect accepted/rejected/duplicate
  counts, webhook lag/dead-letter and queue depth** are §14 operational metrics owned by ES.20's
  diagnostics workbench, not this reporting phase. The `exceptions` report covers the request-level
  facts ES.19 can compute without new event tables.
- A scheduled report delivery of these aggregates is not added; the existing saved-report scheduler
  is metadata-entity based and these are module-native aggregates.
- Owner labels are opaque user ids (the SPA shows the id); resolving display names would introduce a
  user-directory dependency into the aggregate payload. The UI can link the id later without changing
  the report contract.
- `dead-letter` and job-age metrics remain ES.20.
