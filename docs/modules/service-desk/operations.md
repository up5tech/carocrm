# Operations

## Scheduled jobs

| Job name | Schedule | Handler | Purpose |
|---|---|---|---|
| `serviceDesk.slaScan` | `*/5 * * * *` | `apps/worker/src/handlers/service-desk-handlers.ts` | SLA warnings, breaches, notifications, escalation, Knowledge expiry |

The seed inserts the `scheduled_jobs` row once (`id = sdSlaScan`) with `ON CONFLICT DO NOTHING`. The
worker calls `POST /api/v1/ServiceDesk/action/sla/run-scheduled-check` with the shared
`x-worker-secret` (`REPORT_WORKER_SECRET`). When the secret is empty the job is **inert**: it
completes with `disabled: true` rather than failing and accumulating retries.

A run is idempotent: fired thresholds and breach notification flags live on the clock, so a retry or
overlapping run does not duplicate a notification. A failed notification is swallowed (counted as not
sent) but the breach state remains. The scan is bounded to 500 clocks and reports `truncated`; the
next tick continues.

`GET /ServiceDesk/action/settings` exposes `sla.lastScanAt`, and `/action/health` shows the module's
dependency/feature state.

## Manual runs

- Full pass: `POST /ServiceDesk/action/sla/runScheduledCheck` (administrator).
- State-only pass: `POST /ServiceDesk/action/sla/checkBreaches` (administrator).
- Inbound mail: `POST /ServiceDesk/action/emailToCase/processInbound` (authenticated + feature on).

## Failure handling

- **Mail outage**: inbound processing counts `failed` and leaves the email unprocessed; a later run
  retries it. Outbound replies report `queued: false` and still record the message and Stream entry.
- **Worker restart**: all job state is in Postgres (`scheduled_jobs`, `jobs`, `job_logs`); a new
  worker resumes from the scheduler and the clock flags.
- **Optional module absent**: the module starts; health reports the integration unavailable, and
  feature commands that depend on it return `403 FEATURE_DISABLED` or a documented validation error.
- **Portal/CSAT**: one-time tokens are hashed and expire; a stale link returns a validation error,
  never case data.

## Observability

- Module health: `GET /api/v1/ServiceDesk/action/health`.
- Job history: the platform `GET /api/v1/Job` / `ScheduledJob` screens and `job_logs`.
- Domain events: `outbox_events` (`serviceDesk.case.*`) are consumed by the worker/outbox poller.
- Audit/Stream: generic `AuditLog`, `stream_items`; transitions and assignments have dedicated
  history records.
- Logs: the worker logs counts only (`checked`, `breached`, `warned`, `notified`, `escalated`,
  `expiredArticles`), never message bodies or customer content.

## Rate limits

The public web-to-case endpoint limits five submissions per minute per IP inside the API process. A
multi-instance deployment must add a shared limiter (reverse proxy or platform rate-limit store).
The global API rate limit still applies.
