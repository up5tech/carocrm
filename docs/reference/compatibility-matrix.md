# Compatibility matrix (PLAN §60)

Baseline: EspoCRM 9.3.x behavior, observed through public documentation — clean-room,
no upstream source used (PLAN §2). Status is as of 2026-10-12 (CRM Kernel Alpha + PLAN tasks 17–22,
search/import/export/dashboards, the extension SDK, the workflow engine and the BPM engine).

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
| Roles / Teams / Users | v9.3.x | REST + storage + admin UI (users, teams, roles, API-key tabs in the settings shell) | P0 | implemented |
| Authentication | v9.3.x | argon2id + JWT + rotating refresh + CSRF cookie; API keys hashed | P0 | implemented |
| OAuth/OIDC, MFA, password reset | v9.3.x | not built | P1 | not started |
| Attachments | v9.3.x | local-filesystem storage, MIME/size/extension checks, checksums | P0 | implemented |
| Audit | v9.3.x | field-level `audit_log`, redaction, read API | P0 | implemented |
| OpenAPI | upstream has none for v1 API | generated `GET /api/v1/OpenApi` — additive | P1 | implemented |
| Stream / followers | v9.3.x | `GET /Stream`, `GET /:type/:id/stream`, `POST /Note`, `PUT\|DELETE /:type/:id/subscription`, mentions→notifications, generated Update items | P1 | implemented |
| Activities / Calendar | v9.3.x | Task/Call/Meeting/Reminder entities, `GET /Calendar` occurrences, recurrence expansion, reminder job, month-grid UI with drag reschedule | P1 | implemented |
| Email | v9.3.x | metadata `Email` entity + templates, per-account SMTP, queued delivery with a ledger, `InboundMailProvider` port | P1 | implemented (see note) |
| Global search | v9.3.x | `/Search` over the query engine (ACL-aware) + trigram indexes; no OpenSearch stage 2 | P1 | implemented |
| Import / Export | v9.3.x | CSV import with field mapping and a validation report, paged CSV export with formula neutralisation | P1 | implemented |
| Dashboards / dashlets | v9.3.x | dashboards with list/chart/KPI dashlets driven by the query engine | P1 | implemented |
| Frontend SPA | v9.3.x | React SPA: generic list/detail/edit/create, Entity Manager, audit, stream, calendar, tabbed settings shell, command palette (Carocrm theme) | P0 (product) | implemented |
| Background jobs / scheduled jobs | v9.3.x | BullMQ worker, cron metadata, retries + backoff + dead letter, per-job progress and logs, cooperative cancellation, REST API and admin UI | P2 | implemented |
| Formula engine | v9.3.x | sandboxed parser → AST → evaluator with an allowlisted function set and execution budgets (`@carocrm/formula`) | P2 | implemented |
| Dynamic logic | v9.3.x | metadata `dynamicLogic.rules` evaluated in the SPA **and** on every API write | P2 | implemented |
| Workflows | v9.3.x (workflows module) | entity-event triggers, formula conditions, branching, delays, 5 actions, versioned definitions, run history + steps | P2 | implemented (see note) |
| BPM / process approval | v9.3.x (bpm module, commercial baseline) | process definitions with user tasks, exclusive gateways, service tasks, due/escalation timers, versioned definitions, per-person task lists, full audit trail | P2 | implemented subset (see note) |
| Reports / Portals | commercial/baseline | reports: exact aggregates + scheduled owner delivery; portals: separate role space + contact/account visibility + portal dashboard/nav | P2 | implemented (see note) |
| Hooks / domain events | v9.3.x entity hooks + event bus | `HookRegistry` phases + transactional-outbox domain events consumed by a worker subscriber bus | P2 | implemented (see note) |
| Extension SDK / modules | v9.3.x module/extension packages | `packages/extension-sdk` + host in API and worker: manifest, strict validation, dependency + `order` resolution, metadata contribution, providers/controllers/hooks/jobs, own migrations, SPA nav, admin API + UI | P1 | implemented (see note) |
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

## Background jobs (PLAN §24)

- Upstream ships a `Job` entity with `status`/`createdById`/`scheduledDate`/`attemptsCount` and an
  `Job.run` entitlement; here `jobs` is an execution table (one row per attempt) plus
  `scheduled_jobs` for cron metadata, and the HTTP surface is `/api/v1/Job` + `/api/v1/ScheduledJob`.
  The shape is ours — the upstream job lifecycle was not re-verified from documentation in this
  environment, so this row is a behaviour-level match, not a contract match.
- Job **names** must be registered by code (`JobRegistry`); metadata stores names only, never
  executable code (PLAN §24).
- Cancellation is cooperative (`cancel_requested` + `context.shouldStop()`), not a hard kill.

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
- Hooks are **code-registered** (a `HookRegistry` provider). Extension packages contribute hooks
  through the extension SDK (PLAN §38) — `manifest.json` + a backend module — which is also how a
  hook is persisted upstream (in a module directory), so the mechanism matches even though the
  file format does not.
- EspoCRM exposes its event bus to extensions only; here `GET /api/v1/Hook` and
  `GET /api/v1/DomainEvent` publish the same facts over the API, which is additive, not upstream.
- `entity.created|updated|deleted|restored` payloads (`{entityType, entityId, changed[], userId,
  version}`) are our own shape. Upstream event payloads carry the entity, `id`, `attributes`,
  `changed` and `acm`, but the exact field naming is not published in the docs we could reach.
- Restore is atomic (row + audit + event in one transaction) — upstream restores through its own
  transaction as well.
- Outbox delivery is at-least-once with per-event retry/backoff and a `failed` dead-letter status;
  upstream runs job consumers through its own queue table.

## Workflows (PLAN §35)

Upstream documentation was **not reachable from this environment** while building, so the shapes below
follow PLAN §35 and our own design; parity with EspoCRM's workflow configuration (its `workflow.json`
schema, `EntityBeforeCreate`/`EntityAfterUpdate`-style triggers, condition groups, action list, run
history screen) still needs a documentation pass.

- **Triggers** are entity lifecycle events (`entity.created|updated|deleted|restored` filtered by
  entity type). Upstream also triggers on record-field changes, entity-create/update and record-field
  conditions, plus before/after events and manual triggers; only the entity lifecycle subset is built,
  and matching happens against the existing outbox stream rather than EspoCRM's own event system.
- **Conditions** are sandboxed formulas from the PLAN §22 engine. Upstream stores a condition group
  with `{type, entity, ...}` objects and AND/OR composition; we chose one expression per node,
  because a second condition language would be a second thing to sandbox and test.
- **Actions** are a closed catalog of five (`updateRecord`, `createRecord`, `createNotification`,
  `sendEmail`, `runJob`). Upstream offers ~30 actions (create entity, create record, send email,
  notifications, webhooks, create task, job manager, and extension-registered ones). `runJob` is our
  extension point: a package registers a §24 job and any workflow can queue it.
- **Versioning is a deliberate difference**: upstream stores one workflow document and applies edits
  in place; here every save writes a draft and a published version is immutable, because a run that
  started against version N must still find version N (PLAN §35 asks for versioning explicitly).
- **Run history** exists on both sides (`GET /api/v1/WorkflowRun`, `/admin/workflows`); upstream's
  exact table and screen were not verifiable here.
- Not built: schedule (cron) triggers, relation-change triggers, a manual "run now", and per-workflow
  roles beyond administrator-only.

## BPM / process approval (PLAN §36)

Upstream documentation was **not reachable from this environment** while building either, so the
shapes below follow PLAN §36 and our own design; parity with EspoCRM's BPM module (its process
schema, flow elements, assignment rules, timer nodes) still needs a documentation pass. Upstream
BPM is a **commercial** module; ours is built from the same documented concepts (process definition,
instances, user tasks, gateways, audit trail).

- **One token per instance**: no parallel fork/join; the exclusive gateway picks the first matching
  branch, else the required default. Upstream offers parallel gateways and event-based gateways.
- **Timers exist only on user tasks** (due + escalation). Upstream has standalone timer/date events
  as flow elements ("wait three days, then continue"); we do not.
- **Loops are first-class** — a cycle is legal when it passes through a user task (checked with
  Tarjan on every save), because "request changes → back to review" is the canonical approval.
- **Service tasks reuse the workflow action catalog** (5 actions) and are dispatched to the worker;
  results deliberately never feed conditions. Upstream's service-task catalog is broader.
- **Assignment** is user, role (candidate group resolved by role name) or a record field; a task
  reached through a role is answerable by every member, first answer wins. Escalation re-resolves
  its target against live data when the timer fires.
- **Versioning matches workflows** (draft / immutable published / enable gates new instances) —
  PLAN asks for versioning explicitly; upstream keeps one process document.
- **Starting** is `POST /api/v1/ProcessInstance` (anyone who can read the record); upstream wires
  starts to workflow/scheduled events. No definition triggers are built yet.
- Not built: parallel gateways, timer flow elements, subprocesses, BPMN notation/import, process
  reporting, per-process roles beyond administrator-only authoring.

## Extension SDK (PLAN §38)

Upstream documentation was **not reachable from this environment** while building, so the shapes below
follow PLAN §38/§39 and our own design; parity with EspoCRM's module/extension contract (manifest
keys, install directory layout, `metadata/` + `Migrations/` + `backend/` layout, the
`ExtensionInstaller`/`Uninstaller` services) still needs a documentation pass.

- **Package = directory with `manifest.json`**, read from one configured directory (`EXTENSIONS_DIR`).
  Upstream installs by copying an uploaded zip into `data/upload/extensions/`; there is **no upload
  endpoint here** — deployment places the directory, an administrator installs it. That removes an
  entire class of "upload arbitrary code" risk (PLAN §38.4) at the cost of upstream's convenience.
- **Install is explicit and needs a restart**: the activation row (`installed_extensions`), its SQL
  migrations and then a process restart. Upstream performs the same actions in one request through
  `ExtensionInstaller` and reloads metadata; it can add providers to a live container, which we
  deliberately do not.
- **Load order is ours and deterministic**: dependencies first, then ascending `order`, then id.
  PLAN §39 asks for a module-order priority; upstream uses a per-module numeric `order` in
  `metadata.json` too, but the exact resolution rule was not verifiable here.
- **Version compatibility** is `minPlatformVersion` / `maxPlatformVersion` plus per-dependency
  minimum versions, checked before anything is loaded. Upstream has its own compatibility check with
  the platform version; the field names differ.
- **Contributions**: metadata documents, Nest providers/controllers, entity-manager hooks, background
  jobs, domain-event subscribers, SQL migrations and SPA navigation entries. Upstream modules also
  register routes and jobs from PHP class registries — the concepts match, the mechanism does not.
- **Frontend contributions are data only** (navigation entries, plus everything metadata already
  drives). Shipping a React component from a package would need a build-time Vite plugin and is not
  supported in this phase.
- **No signature verification**: packages are trusted code installed by an administrator. PLAN §71
  recommends signature checks; they remain a documented gap, not a silent omission.

## Attachments and file storage (PLAN §25)

Upstream documentation was **not reachable from this environment** while building, so the endpoint
shapes below follow PLAN §25 and our own `attachments` table; parity with EspoCRM's attachment API
still needs a documentation pass.

- Uploaded bytes are streamed: the body never lives whole in the API process, and the size ceiling is
  enforced twice (multipart parser + counting transform), so an oversized file is stopped mid-request
  instead of after it lands. `UPLOAD_MAX_MB` / `UPLOAD_CHUNK_MAX_MB` configure it.
- Every attachment stores a sha256 `checksum` computed during the same pass and returns it as
  `x-checksum-sha256` on download. Upstream does not publish a content hash, so this is additive.
- Pre-signed download URLs (`GET /api/v1/Attachment/:id/url`) are an **addition** and only exist for
  S3/MinIO; local disk has no public read path and answers `FEATURE_DISABLED`, keeping downloads
  authenticated.
- Chunked upload (`/api/v1/AttachmentUpload`) is an **addition** — there is no public chunked upload
  API upstream. Parts live outside the attachment table until completion, then replay through the
  ordinary upload path, so a chunked file gets exactly the same validation as a direct one.
  Reservations expire and `system.cleanupUploads` removes their bytes.
- Malware scanning is a hook (`MALWARE_SCANNER_TOKEN`), as PLAN §25 asks, not a bundled vendor. The
  built-in `SignatureScanner` covers EICAR and magic-number/MIME mismatches and fails closed.
  **Upstream parity: unknown** — antivirus is an integration/extension there.
- Extension and MIME filtering (`BLOCKED_EXTENSIONS`, `ALLOWED_MIME_TYPES` + `image/*`, `text/*`) is
  ours; upstream's allowlist is per-installation and was not verifiable here.
- Downloads enforce admin / uploader / parent-ACL access; `AppModule` wires `PARENT_ACL_CHECK_TOKEN` to
  the record ACL (`AclApiService` + the record store), so an attachment is readable by an admin, its
  uploader, or anyone who can read its parent record. The barrel still ships the permissive default for
  standalone use.
- No attachment UI yet: the SPA has no file field or panel, so uploads and downloads are API-only.

## Outbound email (PLAN §28)

Upstream documentation was **not reachable from this environment** while building, so the shapes below
follow PLAN §28 and our own record model; parity with EspoCRM's email module still needs a
documentation pass, and its templates, tags, mailbox accounts and feedback loop are out of scope here.

- `Email` is a **metadata entity** (content in `entity_records.attrs`), so upstream's dedicated `email`
  table with separate body/address tables is not reproduced. The §28.3 fields map to `name` (the
  subject), from/to/cc/bcc/reply-to, `body`/`bodyHtml`, `headers` (JSON text), `messageId`, `threadId`,
  `inReplyTo`, `status`, `dateSent`, `deliveryError`, `parentType`/`parentId` and manyMany links to
  Account/Contact/Lead/User — which is how ACL, audit, stream and the generated UI come for free.
- **Delivery status is our own `email_deliveries` table** (one row per recipient, unique on
  `(email_id, recipient)`, with transport, provider message id, error and attempts). Upstream tracks
  addresses through `emails_to_*` join tables; these column names and the retry accounting are ours.
- Sending is **queued, never inline**: the API validates the draft, writes the ledger and enqueues the
  §24 job `system.sendEmail`; the worker performs the SMTP call. Upstream sends during the request, so
  *when* a failure surfaces differs deliberately (PLAN §7.4 observability, §5.5 external effects).
- Transports implemented: SMTP submission and a generic credential-free SMTP relay over nodemailer,
  plus `memory` and `none`, which deliver nothing — `none` is the default and the API answers
  `FEATURE_DISABLED` while it is selected. **AWS SES, SendGrid and Microsoft Graph are PLAN §28
  "later" and are absent**, and so is **inbound collection (IMAP / POP3 / Graph / Gmail)**: upstream's
  fetched-mail behaviour is therefore **not comparable yet**.
- **No mail credential is stored in the database.** `SMTP_*` settings come from the environment, so
  PLAN §28.3's "secrets and credentials must be stored encrypted at rest" currently has no stored
  secret to satisfy. This is a deliberate deviation, not an implementation: if mail accounts become
  editable data (upstream stores inbound/outbound accounts), that rule needs a real secret store and
  this row must be revisited.
- Anti-spoofing and injection defenses are ours, not upstream-documented: the From address must equal
  the configured mailbox unless `SMTP_STRICT_FROM=false`, header names the envelope owns
  (`From`/`To`/`Subject`/`Message-Id`/`Content-Type`/`Received`…) are refused, header values containing
  CR/LF are rejected, and recipients are capped by `MAIL_MAX_RECIPIENTS`.
- Retry semantics are ours: a connection failure or 4xx answer is re-thrown so BullMQ backs off and the
  record returns to `Queued`; a 5xx or all-rejected envelope is final. A record already `Sent` is a
  no-op, so a duplicate queue entry cannot mail twice.
- No email UI yet (no compose screen, mailbox list or thread view) and email notifications (§29) are
  not wired to this subsystem — reminders still deliver in-app notifications only.

## Phase 19 — Projects (added 2026-10-13)

| Capability | Espo baseline | This implementation | Priority | State |
|---|---|---|---|---|
| Projects domain | v9.3.x Project Management extension | `apps/api/src/projects` + ten metadata entities; behaviour matched, not ported | P1 | implemented, deviations in `docs/modules/projects/compatibility.md` |
| Board stage → status mapping, several stages on one status | v9.3.x | `ProjectBoardStage.statusValue`; status derived on every write | P0 | implemented |
| Project role composition with global ACL | upstream leaves it implicit | global level first, then the member's role narrows; a non-member is never widened | — | this implementation's contract, not upstream-verified |
| Task type values | upstream `task`/`milestone` | capitalized `Task`/`Milestone` to match this codebase's enums | — | intentional deviation |
| Non-member task collaborators | documented upstream | refused: collaborators must be project members | — | intentional deviation |
| Gantt working-time shading | documented upstream | not built (no working-time calendar to reuse) | — | deferred |
| Project cloning with date offset | documented upstream | transactional, id remapped, attachments copied after commit | P1 | implemented |

## Phase 20 — Settings, administration and UX (added 2026-10-20)

| Capability | Espo baseline | This implementation | Priority | State |
|---|---|---|---|---|
| Administration panel | `app > adminPanel` metadata, panels with an `itemList` | group + tab descriptors registered in code (`apps/api/src/admin-panel/admin-panel.service.ts`), served by `GET /AdminPanel`; a module contributes a tab without editing the shell | P0 | implemented, deviation in `docs/compatibility/settings-ux.md` |
| Config-parameter visibility level | `default/global/admin/internal/system/superAdmin` + `readOnly` | `public` / `admin` / `sysAdmin` on each settings document; the instance has one administrative tier | P0 | implemented subset |
| Settings documents | one `config` JSON | one `app_settings` row per document, with a schema, a version, optimistic concurrency and reset-to-default | P0 | implemented |
| Main menu customization | client-side menu customization | server-resolved, ACL-filtered tree from `GET /Navigation`; the document stores overrides only | P0 | implemented |
| Per-entity navigation metadata | `entityMenu` / module menu metadata | a `nav` section on the entity definition (`hidden/order/group/quickCreate/board`) | P0 | implemented |
| User / team / role / API-key administration | separate screens under Administration | four tabs in the settings shell over the existing identity API; the secret exists only in the creating response | P1 | implemented |
| Layout manager | `EntityLayoutManager` per entity | one shared `LayoutEditor` hosted by the Entity Manager and a settings tab | P1 | implemented subset |
| Command palette | not an upstream feature | `⌘/Ctrl+K`, commands / records / recent modes, ACL-filtered records | P1 | implemented (this project's own) |
| Per-user preferences | local browser storage | server-side `/Preferences` documents keyed `(user_id, name)`; ownership is structural | P1 | implemented |
| Accessibility verification | not verified upstream | focus ring, 44 px targets, reduced motion, responsive breakpoints — **no automated axe audit, no frontend test runner** | P1 | partial, gaps in `docs/ux/accessibility.md` |
| Record-page relation panels | administrator-defined layout panels, stacked | stacked (unchanged) **or** a per-user, per-entity tab arrangement the user creates, renames, reorders and fills; the same `/Related` calls and the same ACL | P1 | implemented, intentional deviation in `docs/compatibility/settings-ux.md` |
