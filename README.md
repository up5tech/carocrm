# CaroCRM

Metadata-driven CRM platform: TypeScript + NestJS + Kysely/PostgreSQL, a clean-room
reimplementation of EspoCRM concepts (no PHP runtime, no upstream source copied).
The engineering plan lives in [PLAN.md](PLAN.md).

**Current state: CRM Kernel Alpha + generic React UI (PLAN §73, tasks 01–20).**
Backend: metadata engine, entity/query/ACL engines, attachments, audit, jobs.
Frontend (`apps/web`): metadata-driven login, navigation, list/detail/edit views and the
Entity Manager admin UI. Email, import/export, dashboards, workflows, BPM, reports and
portals are not implemented yet.
Full checklist and deviations: [docs/reference/alpha-status.md](docs/reference/alpha-status.md).

## Requirements

- Node.js >= 22 (tested on 24) and pnpm >= 9
- PostgreSQL reachable via `DATABASE_URL`
- Redis reachable via `REDIS_URL` (worker/queues only)

Copy `.env.example` to `.env` and adjust. `pnpm db:seed` creates the target database if missing.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | API with reload (`http://127.0.0.1:3030`) |
| `pnpm --filter @carocrm/web dev` | SPA dev server (`http://127.0.0.1:8080`, proxies `/api`) |
| `pnpm dev:all` | API + SPA together |
| `pnpm --filter @carocrm/worker dev` | background worker (outbox + jobs + cron) |
| `pnpm db:migrate` / `db:seed` | schema and idempotent seed (never creates or drops a database) |
| `pnpm lint` / `typecheck` / `-r build` | quality gates |
| `npx vitest run` | API integration tests (configured database) |
| `pnpm test:e2e` | HTTP end-to-end checks against a booted server |
| `npx playwright test` | browser tests: login, CRUD, Entity Manager (boots its own API + SPA) |
| `bash scripts/worker-smoke.sh` | 14 checks on queue/outbox/scheduler |
| `docker compose up postgres redis` | local infrastructure |

## Layout

```
apps/api        NestJS + Fastify REST API (/api/v1)
apps/worker     BullMQ worker, outbox poller, cron scheduler
apps/web        placeholder for the metadata-driven React UI (post-Alpha)
packages/       core, metadata, entity-engine, query-engine, acl, files, jobs, …
database/       SQL migrations, migration runner, seed data + entity metadata
docs/           module guide (runtime rules), reference, operations
```

## API surface (Alpha)

- `POST /api/v1/Authentication`, `/Refresh`, `/Logout`, `GET /AppUser/me`
- `GET /api/v1/Metadata`, `GET|POST /api/v1/Metadata/:entity`
- `GET|POST /api/v1/:entity`, `GET|PUT|PATCH|DELETE /api/v1/:entity/:id`
- `POST /api/v1/:entity/:id/restore`, `POST /api/v1/:entity/action/massUpdate|massDelete`
- `GET|PUT|DELETE /api/v1/:entity/:id/:relation[/:relatedId]`
- `POST /api/v1/Attachment/upload`, `GET /api/v1/Attachment/:id/file`, `GET /api/v1/AuditLog`
- `GET /api/v1/OpenApi`, `GET /health/live`, `GET /health/ready`

Auth: `Authorization: Bearer <jwt>`, `Authorization: ApiKey <keyId>:<secret>`, or the
`CRM-SESSION` cookie (unsafe methods then require `x-csrf-token` matching the `CRM-CSRF` cookie).

Contributors must read [docs/module-guide.md](docs/module-guide.md) first: the API runs under `tsx`,
so every DI needs an explicit `@Inject()` token, and ESM/`verbatimModuleSyntax`/
`exactOptionalPropertyTypes` are enforced repo-wide.

## Licensing

EspoCRM upstream is AGPL-3.0-or-later. This repository is a clean-room reimplementation
(PLAN §2): behavior and public API contracts were used as reference, no upstream source,
assets or translations were copied. A formal compliance review is required before distribution.
