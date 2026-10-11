# Compatibility matrix (PLAN §60)

Baseline: EspoCRM 9.3.x behavior, observed through public documentation — clean-room,
no upstream source used (PLAN §2). Status is as of 2026-10-11 (CRM Kernel Alpha + PLAN tasks 17–22).

| Capability | Espo baseline | This implementation | Priority | State |
|---|---|---|---|---|
| CRUD REST API under `/api/v1` | v9.3.x | generic `/api/v1/:entity` + relations | P0 | implemented |
| List envelope `{list,total,offset,count}` | v9.3.x | same shape; `?total=false` opts out of the count | P0 | implemented |
| Error envelope `{error:{code,message,details}}` | v9.3.x (plain `error` string upstream) | machine codes per PLAN §47 — intentional deviation | P0 | implemented |
| Metadata (`GET /Metadata`) | v9.3.x | DB-backed scopes, version header, admin patch | P0 | implemented |
| Entity Manager (custom entities/fields) | v9.3.x | metadata patch API + admin UI (create entity, add/disable fields) | P0 | implemented |
| Field types | v9.3.x | varchar/text/int/float/decimal/bool/date/datetime/enum/multiEnum/currency/url/email/phone/password + link kinds | P0 | implemented subset |
| Relations | v9.3.x | link, linkMultiple, oneToMany/manyToOne via link attributes + `entity_links` | P0 | implemented |
| ACL (entity/record/field) | v9.3.x | `yes/all/team/own/no`, role merge, field read/edit, record predicates | P0 | implemented |
| Roles / Teams / Users | v9.3.x | REST + storage; no admin UI yet | P0 | partial (API only) |
| Authentication | v9.3.x | argon2id + JWT + rotating refresh + CSRF cookie; API keys hashed | P0 | implemented |
| OAuth/OIDC, MFA, password reset | v9.3.x | not built | P1 | not started |
| Attachments | v9.3.x | local-filesystem storage, MIME/size/extension checks, checksums | P0 | implemented |
| Audit | v9.3.x | field-level `audit_log`, redaction, read API | P0 | implemented |
| OpenAPI | upstream has none for v1 API | generated `GET /api/v1/OpenApi` — additive | P1 | implemented |
| Stream / followers | v9.3.x | `GET /Stream`, `GET /:type/:id/stream`, `POST /Note`, `PUT\|DELETE /:type/:id/subscription`, mentions→notifications, generated Update items | P1 | implemented |
| Activities / Calendar | v9.3.x | Task/Call/Meeting/Reminder entities, `GET /Calendar` occurrences, recurrence expansion, reminder job, month-grid UI with drag reschedule | P1 | implemented |
| Email | v9.3.x | not built | P1 | not started |
| Global search | v9.3.x | query-engine filters only; no trigram/FTS index | P1 | not started |
| Import / Export | v9.3.x | not built | P1 | not started |
| Dashboards / dashlets | v9.3.x | not built | P1 | not started |
| Frontend SPA | v9.3.x | React SPA: generic list/detail/edit/create, Entity Manager, audit, stream, calendar (Lizant theme) | P0 (product) | implemented |
| Background jobs / scheduled jobs | v9.3.x | BullMQ worker, cron metadata-driven, transactional outbox | P2 | implemented |
| Formula engine | v9.3.x | sandboxed parser → AST → evaluator with an allowlisted function set and execution budgets (`@carocrm/formula`) | P2 | implemented |
| Dynamic logic | v9.3.x | metadata `dynamicLogic.rules` evaluated in the SPA **and** on every API write | P2 | implemented |
| Workflows / BPM / Reports / Portals | commercial/baseline | out of Alpha scope | P2 | not started |
| Hooks / domain events | v9.3.x entity hooks + event bus | `HookRegistry` phases + transactional-outbox domain events consumed by a worker subscriber bus | P2 | implemented (see note) |
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

## Stream and calendar specifics (PLAN §26–§27)

Confirmed against EspoCRM documentation on 2026-10-11:

- Routes match upstream: `GET /Stream`, `GET /{entityType}/{id}/stream`, `POST /Note`
  (`{type,parentId,parentType,post,attachmentsIds,idList}`), `DELETE /Note/{id}`,
  `PUT|DELETE /{entityType}/{id}/subscription`.
- Generated `Update` items are driven by the per-field `audited` flag, as upstream does,
  plus the assignee; bookkeeping fields (`createdAt`/`modifiedAt`/`deletedAt`) are excluded
  so the stream stays readable. The stored `data` shape (`{type:'Updated',attributes:[…]}`)
  is not documented upstream — our own.
- `GET /{entityType}/{id}/subscription` (is-followed) has no upstream equivalent; the SPA needs it.
- Stream item kinds: upstream documents only `Post`. `Note` and `Update` follow the historical
  upstream values; the exact machine enum is not published.
- Mentions are stored in `stream_mentions` (upstream storage is undocumented) and notify the
  mentioned user only; posting requires the per-entity `stream` ACL action, reading requires `read`.
- **Recurrence is an extension, not compatibility**: EspoCRM core has no recurring activities,
  so `repeatType/repeatEvery/repeatEndDate/repeatDayOfWeek/repeatByMonth` and
  `GET /Calendar` are our own contract.
- Reminders deliver **in-app notifications** only. Upstream popup/email transports
  (`SendEmailReminders`, WebSocket topics) are not implemented; `reminderSentAt` on the
  activity is the idempotency marker used by `system.sendReminders`.

## Formula and dynamic logic (PLAN §21–§22)

**This section is our own contract, not verified upstream.** The EspoCRM formula/dynamic-logic
documentation was not reachable from this environment while building, so the language, function
names and metadata shape below come from PLAN §21/§22 and were designed here; they must be
re-checked against upstream docs before claiming compatibility (PLAN §60).

- Expression language: literals, `field('x')`/`recordId()` record access, arithmetic
  (`+ - * / %`), comparison (`== != < <= > >=`), logical (`&& || !`), ternary `? :`, array
  literals, `member`/`index` reads limited to plain data. No assignment, no statements, no
  function definitions, no comments other than `#` to end of line, and `__proto__`,
  `constructor`, `prototype` are rejected at parse time.
- Values: string / number / boolean / null / arrays / plain objects only. Host functions, objects
  and prototypes never reach a formula, and results are bounded by `maxStringLength` /
  `maxArrayLength`.
- Truthiness: `null`, `false`, `0`, `''`, `'0'` are false; everything else true.
- Dates: computed from `FormulaContext.now` + an IANA zone (default UTC) through `Intl`, with
  built-in English month/weekday names — output does not depend on the host locale or clock.
- Rule metadata: `entity.dynamicLogic.rules[]`, `when` = formula string **or**
  `{field, operator, value}` criteria (nested with `all`/`any`/`not`, 16 operators),
  `then` = `show|hide|setRequired|setReadOnly|setValues|showPanels|hidePanels|error`.
  A metadata patch replaces the rule list as a whole.
- Enforcement: the same rule set runs in the SPA and on the server. The server rejects a write
  that contradicts a computed field, blocks records that hit an `error` rule, and treats a
  condition that cannot be evaluated as a failure of the write (fail closed) rather than
  "rule did not match".
- Layouts: `showPanels`/`hidePanels` are evaluated and returned, but the SPA has no panel layout
  yet (PLAN §20 panels are still unwired), so panel rules have no visible effect today.
- Cross-record reads inside a formula (`parent()`, `related()`) are **not** implemented: a formula
  sees only the record it is evaluating.

## Hooks and domain events (PLAN §23)

Upstream documentation was again **not reachable from this environment** while building, so the
phase names and event payloads are PLAN §23.1/§23.2 plus our own design; the upstream hook naming
(`beforeSave_ENTITY`, `afterLoad_ENTITY`, …) must be re-checked before claiming parity.

- Phases implemented as documented in PLAN §23.1: `beforeValidate`, `beforeCreate`, `beforeUpdate`,
  `beforeDelete`, `beforeSave`, `afterCreate`, `whenCreated`, `whenUpdated`, `whenDeleted`,
  `afterSave`. There is no load/read phase yet (`afterLoad` upstream) and no `afterDelete` — soft
  delete reports `whenDeleted`.
- Hooks are **code-registered** (a `HookRegistry` provider), not files dropped in an extension
  directory; that belongs to the extension SDK (PLAN §38, task 31).
- EspoCRM exposes its event bus to extensions only; here `GET /api/v1/Hook` and
  `GET /api/v1/DomainEvent` publish the same facts over the API, which is additive, not upstream.
- `entity.created|updated|deleted|restored` payloads (`{entityType, entityId, changed[], userId,
  version}`) are our own shape. Upstream event payloads carry the entity, `id`, `attributes`,
  `changed` and `acm`, but the exact field naming is not published in the docs we could reach.
- Restore is atomic (row + audit + event in one transaction) — upstream restores through its own
  transaction as well.
- Outbox delivery is at-least-once with per-event retry/backoff and a `failed` dead-letter status;
  upstream runs job consumers through its own queue table.
