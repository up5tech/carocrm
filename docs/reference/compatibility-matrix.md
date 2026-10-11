# Compatibility matrix (PLAN §60)

Baseline: EspoCRM 9.3.x behavior, observed through public documentation — clean-room,
no upstream source used (PLAN §2). Status is as of 2026-10-10 (CRM Kernel Alpha).

| Capability | Espo baseline | This implementation | Priority | State |
|---|---|---|---|---|
| CRUD REST API under `/api/v1` | v9.3.x | generic `/api/v1/:entity` + relations | P0 | implemented |
| List envelope `{list,total,offset,count}` | v9.3.x | same shape; `?total=false` opts out of the count | P0 | implemented |
| Error envelope `{error:{code,message,details}}` | v9.3.x (plain `error` string upstream) | machine codes per PLAN §47 — intentional deviation | P0 | implemented |
| Metadata (`GET /Metadata`) | v9.3.x | DB-backed scopes, version header, admin patch | P0 | implemented |
| Entity Manager (custom entities/fields) | v9.3.x | metadata patch API; no admin UI yet | P0 | partial (API only) |
| Field types | v9.3.x | varchar/text/int/float/decimal/bool/date/datetime/enum/multiEnum/currency/url/email/phone/password + link kinds | P0 | implemented subset |
| Relations | v9.3.x | link, linkMultiple, oneToMany/manyToOne via link attributes + `entity_links` | P0 | implemented |
| ACL (entity/record/field) | v9.3.x | `yes/all/team/own/no`, role merge, field read/edit, record predicates | P0 | implemented |
| Roles / Teams / Users | v9.3.x | REST + storage; no admin UI yet | P0 | partial (API only) |
| Authentication | v9.3.x | argon2id + JWT + rotating refresh + CSRF cookie; API keys hashed | P0 | implemented |
| OAuth/OIDC, MFA, password reset | v9.3.x | not built | P1 | not started |
| Attachments | v9.3.x | local-filesystem storage, MIME/size/extension checks, checksums | P0 | implemented |
| Audit | v9.3.x | field-level `audit_log`, redaction, read API | P0 | implemented |
| OpenAPI | upstream has none for v1 API | generated `GET /api/v1/OpenApi` — additive | P1 | implemented |
| Stream / followers | v9.3.x | tables exist, no service/endpoints | P1 | not started |
| Activities / Calendar | v9.3.x | Task entity metadata only; no calendar API | P1 | not started |
| Email | v9.3.x | not built | P1 | not started |
| Global search | v9.3.x | query-engine filters only; no trigram/FTS index | P1 | not started |
| Import / Export | v9.3.x | not built | P1 | not started |
| Dashboards / dashlets | v9.3.x | not built | P1 | not started |
| Frontend SPA | v9.3.x | not built (PLAN tasks 17–18) | P0 (product) | not started |
| Background jobs / scheduled jobs | v9.3.x | BullMQ worker, cron metadata-driven, transactional outbox | P2 | implemented |
| Workflows / BPM / Reports / Portals | commercial/baseline | out of Alpha scope | P2 | not started |
| Database | MySQL/MariaDB/PG | PostgreSQL only; MySQL/MariaDB later (PLAN §6.2) | — | PG first |
| PHP source compatibility | — | explicitly a non-goal (PLAN §5) | — | N/A |

## Behavioral notes / intentional deviations

- Record `version` column exposes optimistic concurrency (`409 CONCURRENCY_CONFLICT`); upstream is last-write-wins.
- Soft delete is `deleted_at`; restore is an explicit `POST /:entity/:id/restore`.
- Custom entity data lives in `entity_records.attrs` (JSONB) with physical columns for identity,
  ownership, teams and timestamps — upstream uses one table per entity. Data is not
  database-compatible with EspoCRM (PLAN §3.3).
- IDs are UUIDv4 strings, treated as opaque (PLAN §45 recommended UUIDv7/ULID — revisit later).
- Field-level ACL is enforced on both read serialization and write validation (PLAN §18.3).
