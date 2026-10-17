# Testing

## Database policy

All API tests run against the **already configured primary project database** (AGENTS.md §3.1).
They never create a test database, shadow database, schema or container, and the harness never drops
or truncates application tables. `apps/api/test/support/boot-api.ts` runs the normal migration runner
and the normal seed once per process; service-desk suites flip only their own feature flags and
restore the prior values in `afterAll`.

Every record a suite creates carries an `AGENT_TEST_<runId>` marker and is removed by exact id (or by
the exact case ids the run recorded). No suite uses a broad `DELETE` or name-pattern cleanup for
business records.

## Commands

```bash
# Service Desk API suites (configured DB)
pnpm vitest run apps/api/test/service-desk*.test.ts

# Worker scheduled-job unit tests (no DB/Redis needed)
pnpm --filter @carocrm/worker test

# Type checks and lint
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
pnpm lint
```

The root `pnpm test` also runs the kernel and other module suites; it is safe because the harness
uses the configured database and the established cleanup rules.

## Coverage map

| Suite | What it proves |
|---|---|
| `service-desk.test.ts` | module health, settings, numbering, CRUD/validation, ACL, concurrent numbering |
| `service-desk-domain.test.ts` | pure transition, resolution, routing-condition and assignment helpers |
| `service-desk-workflow.test.ts` | state machine, history, idempotency, assignment/routing/fallback |
| `service-desk-conversation.test.ts` | public/internal separation, attachment inheritance, notifications |
| `service-desk-email.test.ts` | inbound/thread/idempotency/loop prevention, outbound reply |
| `service-desk-sla.test.ts` | clock creation/met/breach, timezone/holiday math, pause/resume, thresholds, reopen cycle |
| `service-desk-csat.test.ts` | invitation after resolution, submission, duplicate/expiry, permission refusal |
| `service-desk-merge.test.ts` | candidates, merge audit, permission/status refusal |
| `service-desk-webtocase.test.ts` | allowlist, honeypot, idempotency, rate limits |
| `service-desk-portal.test.ts` | portal scope, field projection, public-only timeline, IDOR |
| `service-desk-metrics.test.ts` | ACL-scoped aggregates and CSAT restriction |
| `service-desk-security.test.ts` | IDOR, forged fields, record-scope refusal, admin/worker gates |
| worker `service-desk-handlers.test.ts` | scheduled job registration, secret use, inert/cancel/failure paths |

## Manual smoke checks

1. `GET /api/v1/ServiceDesk/action/health` → `ok: true`, all required dependencies present.
2. Create a case with `requesterName`; confirm a readable case number and `slaState`.
3. Set `features.sla` and a 24/7 calendar/policy; run `/action/sla/runScheduledCheck`; confirm
   counters and `lastScanAt`.
4. Set `features.portal`; sign in to `/portal` as a seeded portal user and confirm only the
   contact/account cases appear, internal fields are absent and a reply is public.
5. Build the web app (`pnpm -r --filter @carocrm/web build`) after UI changes.

## Limitations

- No browser E2E suite is configured for Service Desk; the SPA was type-checked and built, and API
  behaviour is covered by the suites above.
- Tests disable or inject the mail transport; they never deliver live email.
- The public web-to-case rate limit is in-process; a test run can legitimately hit it only within the
  same process.
