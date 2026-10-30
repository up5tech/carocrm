# Phase 22.20 — Performance and Capacity Baselines

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §19
> **Status:** Complete as a **baseline**, not a load test. Read-only measurements, plans and capacity
> observations recorded; two capacity gaps opened (G73, G74); no production code changed to chase a number.

---

## 1. Objective

Establish measurable baselines for critical user journeys and integration pipelines without running unsafe stress
tests against the primary database or live providers.

## 2. Tasks (plan §19, 10 items)

1. Record machine and dataset constraints before any benchmark.
2. Choose representative query and workflow profiles from actual usage, not arbitrary stress workloads.
3. Measure API latency for common list/detail/search, cross-module reads, lead scoring, conversation loading and
   background job processing.
4. Inspect query plans with safe, read-only `EXPLAIN`; avoid `EXPLAIN ANALYZE` on expensive/side-effecting statements.
5. Check pagination caps, query timeouts, bounded fan-out, request body limits, attachment size limits and rate limiting.
6. Measure queue waiting time, processing duration, retry rate, failure rate and job age.
7. Measure browser performance for critical routes using sanitized synthetic data.
8. Verify bulk actions and exports are bounded, permission-filtered, cancellable where supported, and do not hold long
   transactions.
9. Define targets from observed product needs and existing SLOs; do not invent a universal latency target disconnected
   from deployment resources.
10. Run load or stress tools only against a clearly identified non-production environment with approved synthetic data
    and a bounded request rate.

## 3. Harness

`scripts/perf-baseline.ts` — run with `pnpm tsx scripts/perf-baseline.ts` (optionally
`PERF_ITERATIONS=40 PERF_WARMUP=5`).

- Boots the API **in-process** with `createApp(config, { skipMigrations: true })` and the configured admin login, then
  drives only `GET` routes through `app.inject`. No listener, no browser, no network hop.
- 3 warm-up requests and 25 measured requests per endpoint; p50/p95/max are wall-clock around the inject call (handler
  + query time, not wire time).
- A request that does not answer in 20 s is reported as HTTP 0 and the profile continues.
- Reads counters with `pg_database_size`, table counts and `EXPLAIN` (no `ANALYZE`). It creates no record, does not
  seed, reset or enqueue, and contacts no provider.

Dataset and environment of this run (2026-10-29, configured `.env`):

| Item | Value |
|---|---|
| Machine | macOS arm64 (Apple silicon), local |
| Node / tsx | Node v24.19.0, tsx 4.23.12 |
| Database | PostgreSQL 16.6, local container (`postgres16`) |
| Redis | Redis 6.2, local container (`redis6`) |
| Database size | 738 016 279 bytes (≈ 704 MiB) |
| Live `entity_records` | 11 318 |
| Top entity types | Contact 2 185, Account 1 939, InvoiceItem 1 165, CaseTransition 982, CaseSLAClock 631, Invoice 530, Task 442, Call 381, Opportunity 293, MarketingSuppression 223 |
| Pending outbox | 289 234 (oldest 1 496 103 s ≈ 17.3 days) |
| Pending jobs | 8 429 (oldest 1 042 922 s ≈ 12.1 days) |
| Running / failed outbox | 0 / 0 |
| Running / failed jobs | 0 / 0 |
| Voice conversations / messages | 1 / 2 |

The backlog is shared-development-database residue, not production traffic: no worker is draining the scratch queue
during this run, and Phase 22.18's lease only makes crash recovery correct. Retention and scheduling remain G14/G21
(22.21). It is recorded because it *is* part of the capacity picture: the outbox claim now sorts a very large due set.

## 4. API latency baseline

In-process, `GET`, 25 iterations after 3 warm-ups. HTTP 200 for every profile.

| Profile | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|
| List Account (20, newest first) | 11.7 | 16.2 | 16.7 |
| Detail Account | 9.3 | 12.0 | 12.3 |
| Relation Account.contacts (20) | 12.4 | 17.4 | 17.9 |
| List Lead (20, newest first) | 11.4 | 13.6 | 13.8 |
| Global search, 3 entities (Account, Contact, Lead) | 27.0 | 30.2 | 31.1 |
| LeadScore read for one Lead | 10.2 | 11.5 | 12.1 |
| Omnichannel conversation inbox (20) | 8.9 | 11.4 | 11.6 |
| Conversation timeline (20) | 8.7 | 11.2 | 11.6 |
| Outbox failed list (20, admin) | 1.2 | 1.6 | 14.7 (one cold outlier) |

A second run reproduced every profile within a few milliseconds (p95 differences < 3 ms), so the table is stable for
this dataset. These are **server-side handler + query times on an 11 k-record dataset with a local database**. They are not a
promise for a remote database, a cold cache or a larger tenant, and they exclude TLS, the SPA, JSON rendering in a
browser, and exports.

## 5. Query plans (`EXPLAIN`, no `ANALYZE`)

| Statement | Root plan | Cost / rows | Reading |
|---|---|---|---|
| Account list, `deleted_at is null`, order by `modified_at desc`, limit 20 | `Limit → Index Scan Backward` on `idx_entity_records_modified_at`, filter `entity_type = 'Account'` | total 703.61, 20 rows | Uses the modified-at index; the entity-type filter is applied per row. Fine at this size, degrades with many non-Account records. |
| Lead name `ilike '%a%'`, limit 20 | `Limit → Index Scan` on `idx_entity_records_lead_score_value`, filter on `attrs->>'name'` | total 43.73, 20 rows | No name index; the planner walks another index until it finds 20 matches. Fast here because matches are common; a rare needle scans more. |
| Outbox due batch, `status in ('pending','running') and available_at <= now()`, order by `available_at, created_at`, limit 10 | `Limit → Gather Merge → Sort → Parallel Seq Scan` | total **21 351**, 240 914 rows estimated | **The capacity risk.** With 289 k due rows there is no index path that satisfies the status predicate and the order, so every poll sorts the due set. This is a consequence of the backlog, not of the 22.18 lease. |
| Pending jobs, order by `created_at`, limit 10 | `Limit → Index Scan Backward` on `idx_jobs_created`, filter `status = 'pending'` | total 1.00, 10 rows | Index-ordered; the status filter is cheap at this limit. |

## 6. Capacity controls (task 5)

| Control | Current value | Evidence |
|---|---|---|
| List page size | default 20, hard maximum **500** (`DEFAULT_MAX_SIZE`, `MAX_MAX_SIZE`) | `packages/query-engine/src/index.ts` |
| Request body | **32 MiB** (`FastifyAdapter.bodyLimit`) | `apps/api/src/bootstrap.ts` |
| Upload size | **25 MiB** default (`UPLOAD_MAX_MB`, 1–2000) for multipart, chunked and streamed uploads | `apps/api/src/config.ts`, attachment services |
| Rate limit | **600 requests / minute / client**, global, OPTIONS excluded, `RATE_LIMITED` envelope | `apps/api/src/bootstrap.ts` |
| CSV export | **10 000 rows**, paged in 500s, ACL `read` per page, not cancellable (synchronous) | `apps/api/src/search/import-export.service.ts`, `portal-shapes.ts` |
| CSV import | **5 MiB / 2 000 rows**, per-row errors kept in memory (G17) | `portal-shapes.ts` |
| Bulk update/delete | **200 ids per request** (`MASS_ACTION_MAX_RECORDS`), one record at a time, duplicated ids collapsed; the SPA batches larger selections — **G73 fixed 22.26** | `EntityCrudService.massUpdate/massDelete`, `apps/web/src/api/client.ts` |
| DB query/request deadline | statement **15 s** / lock **5 s** on the pool, request **30 s** (multipart exempt); all three configurable, `0` disables — **G74 fixed 22.26** | `DatabaseService`, `RequestTimeoutInterceptor`, `config.ts` |
| Queue/outbox retry | outbox: 8 attempts, exponential + equal jitter, lease 10 min; jobs: 3 attempts, exponential + equal jitter | 22.18, `apps/worker/src/backoff.ts` |
| Worker concurrency | 5 jobs by default; outbox batch 10 / poll 2 s | `apps/worker/src/env.ts` |

Bulk and export permission handling: both go through `AclApiService` before touching records (`assertAccess(entity,
'read'|'edit'|'delete')`), and export pages through the same ACL-filtered list as the UI. Export, import and bulk are
now all bounded (10 000 rows / 2 000 rows / 200 ids); every one of them is synchronous and offers no cancel, which the
plan allows ("cancellable where supported") but should be stated.

## 7. Queue and background work (task 6)

The configured database currently has 289 234 pending outbox events and 8 429 pending `jobs` rows, with no worker
draining them during the run; oldest ages are 17.3 and 12.1 days. Therefore this run cannot measure **service time,
waiting time, retry rate or failure rate** honestly — there is no live consumer. What can be stated:

- the durable states are observable (`pending`/`running`/`processed`/`failed`), and the 22.18 lease makes a crashed
  claim reclaimable;
- the outbox claim plan is the expensive statement at this backlog (§5), so a drain would start with a sort of the due
  set rather than an index walk;
- nothing in this baseline measures Redis queue depth or a worker's wait time because no worker is running here.

A queue-latency baseline needs a worker running against a bounded, synthetic dataset (22.21/22.20 follow-up), not a
shared database with a 12-day backlog.

## 8. Browser performance (task 7)

Not measured. Playwright's browser cache is absent in this environment (`~/.cache/ms-playwright` has no browser), so a
route-level browser baseline (navigation, first contentful paint, interaction latency) would require installing a
browser and booting both the API and the SPA. Phase 22.16 has functional browser coverage; it records pass/fail, not
timings. This is a stated limitation, not a zero.

## 9. Proposed targets (task 9) — for review, not enforced

No SLO or latency target exists in the repository (`grep` over `docs/` finds none). The following are **proposals**
anchored to this baseline and to the product's interactive surfaces; they should be adopted or replaced by an owner
before anything enforces them:

| Surface | Proposed server-side p95 | Why |
|---|---|---|
| Entity list / detail | ≤ 250 ms | The observed 17–19 ms leaves a 10× margin for a larger tenant and a remote database; 250 ms is still below a perceptible interaction delay. |
| Global search | ≤ 600 ms | Search is a broader query and the observed 33 ms is on 11 k records; it will degrade with data. |
| Omnichannel inbox/timeline | ≤ 500 ms | The inbox is the busiest operator surface; the observed 14 ms is local. |
| Admin outbox/job lists | ≤ 500 ms | Operational screens may scan large tables; the failed list is 1.3 ms today. |
| Outbox lag (normal load) | ≤ 60 s | A drain should keep the due set small; the 17-day backlog is a retention failure, not a target. |
| Queue job wait | ≤ 30 s p95 | Interactive-adjacent jobs (webhook apply, scoring) should not feel queued. |
| Error rate (5xx) | < 0.1 % | A starting point for the observability work in 22.21. |

These are deliberately provisional: the plan forbids inventing a universal target disconnected from deployment
resources, and this baseline is one machine, one dataset and one run.

## 10. Findings and gaps

- **G73 — bulk update/delete were uncapped and sequential.** *Fixed 22.26:* a 200-id ceiling per request, duplicated
  ids collapsed, the SPA batches larger selections. One transaction per record and no cancel path remain.
- **G74 — no query/request deadline.** *Fixed 22.26:* the pool carries a 15 s statement / 5 s lock deadline and the
  request a 30 s budget (multipart exempt), each configurable and `0`-disablable for a measured long export.
- **Outbox claim cost grows with the backlog.** 21 351 total cost and a parallel sort over ~241 k estimated rows at
  289 k pending. Retention/scheduling (G14/G21, 22.21) is the fix; the lease (22.18) is not the cause.
- **Backlog ages are a capacity fact.** 17.3-day-old outbox events and 12.1-day-old pending jobs in the configured
  development database; see G14.
- **Bulk/export cancel:** export is bounded (10 k) and ACL-filtered but synchronous; no cancel path exists. Stated, not
  changed.
- **Browser timing absent** (§8); **no load/stress run** (task 10) because the only available database is the shared
  primary one, which the plan and AGENTS.md forbid using for stress.

## 11. Evidence

- `PERF_ITERATIONS=25 PERF_WARMUP=3 pnpm tsx scripts/perf-baseline.ts` → exit 0; the table in §4, counters in §3 and
  plans in §5 come from this run.
- `EXPLAIN (costs on)` run separately for the four statements in §5 (read-only; no `ANALYZE`).
- `pnpm lint`, `pnpm typecheck` for the new script; `pnpm verify` for the closing gate. The first full gate run hit
  the shared-database flake `sales-credits.test.ts` (passes solo, 16/16, and the full suite passed on the immediate
  rerun: 248 files / 3 307 tests). Recorded as G75 with G69; 22.20 changes no Sales code.
- `pnpm --filter @carocrm/worker test` → 22 files / 224 tests passed (unchanged by this phase, outside the root gate).
