# Service Desk — release checklist and evidence

Release reference date: **2026-10-17**. Scope: Phase 19-SD sub-phases 19-SD.0 – 19-SD.18.

## 1. Phase status

| Phase | Status | Primary artefact |
|---|---|---|
| 0 Audit | Implemented | `docs/implementation/service-desk-audit.md` |
| 1 Scaffold | Implemented | `apps/api/src/service-desk/service-desk-module.ts`, `index.ts` |
| 2 Persistence | Implemented | migrations 033–036, `database/seed-metadata.ts` |
| 3 Case CRUD/numbering | Implemented | `case-numbering.service.ts`, write guard |
| 4 State machine | Implemented | `case-lifecycle.service.ts`, `service-desk-domain.ts` |
| 5 Assignment/queues | Implemented | `case-assignment.service.ts` |
| 6 Conversation | Implemented | `case-conversation.service.ts`, `stream/stream-visibility.ts` |
| 7 Email | Implemented | `email-to-case.service.ts` |
| 8 SLA engine | Implemented | `sla.service.ts` |
| 9 SLA jobs | Implemented | `serviceDesk.slaScan` seed, worker handler, worker route |
| 10 Knowledge Base | Implemented | `knowledge-base.service.ts` |
| 11 Portal | Implemented | portal role/nav/dashlet seeds, `PortalCaseConversation`, CSAT page |
| 12 Web-to-Case | Implemented | `web-to-case.service.ts` |
| 13 Operator UI | Implemented | inbox tabs, lifecycle/workload/conversation panels, dashboard |
| 14 Merge/CSAT | Implemented | `case-merge.service.ts`, `csat.service.ts` |
| 15 Metrics | Implemented | `service-desk-metrics.service.ts`, `GET /action/metrics` |
| 16 Workflow/integration | Implemented | domain events, Customer Success `support` signal |
| 17 Hardening | Implemented | migration 036, ACL record-scope fixes, security tests |
| 18 Release | Implemented | this file, module docs, compatibility note, plan §23 |

## 2. Commands and outcomes

| Command | Outcome |
|---|---|
| `pnpm vitest run apps/api/test/service-desk.test.ts …` (12 suites) | **12 files, 110 tests passed** |
| Final combined run: 12 Service Desk suites + `customer-success-domain.test.ts` | **13 files, 141 tests passed** |
| `pnpm --filter @carocrm/worker test` | **19 files, 184 tests passed** |
| `pnpm vitest run apps/api/test/portal.test.ts apps/api/test/auth.test.ts apps/api/test/settings.test.ts` | **3 files, 29 tests passed** |
| `pnpm vitest run apps/api/test/jobs.test.ts` / `i18n.test.ts` / `entity-manager-metadata.test.ts` / `audit.test.ts` | jobs 13, i18n 6, entity-manager 7 passed; audit aborts (see §4) |
| `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` | clean |
| `pnpm exec tsc --noEmit -p apps/web/tsconfig.json` | clean |
| `pnpm lint` | clean |
| `pnpm -r --filter @carocrm/web build` | Vite build succeeded (bundle-size warning only) |

## 3. What changed in this release pass

- Wired the missing `serviceDesk.slaScan` scheduled job: seed row, worker handler, worker-authorised
  API endpoint; admin scan endpoints now require administrator access.
- SLA correctness: IANA-timezone/holiday business math, configurable warning thresholds, pause
  deadline shifting with auditable pause minutes, paused clocks never breach, reopen creates a new
  resolution cycle.
- Security: lifecycle/assignment commands now enforce **record-scope** edit access; merge, duplicate
  candidates and CSAT enforce ACL and state rules; `mergedIntoCaseId` is server-owned; CSAT results
  are staff-only; `AclApiService.assertRecordAccess` now throws instead of returning `false`.
- Portal: seeded Case permissions/field projection/nav/dashlet; customer-safe conversation component;
  token CSAT page; fixed the portal list SQL that failed on `attrs` link fields; `features.portal`
  now gates every portal `Case` ACL decision.
- Metrics: ACL-scoped aggregate endpoint (volume, backlog, unassigned, breached, escalated, reopened,
  reopen rate, status/priority/source buckets, CSAT for read-all roles) and dashboard consumption.
- Knowledge expiry sweep in the scheduled pass.
- Email reply: no hard-coded sender; optional `settings.email.replyFromAddress`; outbound threading
  via `inReplyTo`/`threadId` from the last inbound email.
- Customer Success support signal now reads `Case` rows (open/breached/escalated/reopened) instead of
  reporting unavailable.
- Documentation: README, compatibility, lifecycle/assignment/SLA/email/portal/KB/API/operations/
  testing/performance docs, plan §21 checked and §23 evidence added.

## 4. Known limitations / environment notes

- The root `pnpm test` run aborts with `ERR_IPC_CHANNEL_CLOSED` after several suites in the shared
  fork. `apps/api/test/audit.test.ts` alone aborts at Nest initialisation (`abortOnError: true`).
  This is a pre-existing harness behaviour; Service Desk suites pass individually and in groups.
- No browser E2E suite is configured. The web app was type-checked and built; key API behaviour is
  covered by the suites above.
- Portal status changes/merge remain staff-mediated.
- Web-to-case rate limiting is in-process.
- No production performance measurement is recorded; query/index notes are in
  `docs/implementation/service-desk-performance.md`.

## 5. Safe rollback

The schema changes are additive (`CREATE SEQUENCE/INDEX IF NOT EXISTS`); application rollback does
not require dropping data. Disable the optional features in Service Desk settings to stop mail, SLA,
portal, Knowledge Base or CSAT work without deleting records. Do not roll back the migrations with a
destructive command in a shared database.
