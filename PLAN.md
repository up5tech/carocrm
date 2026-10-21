# PLAN.md — EspoCRM Reimplementation in NestJS

## 1. Document Purpose

This document defines a detailed engineering plan for building a clean-room, TypeScript/NestJS-based CRM that aims for functional and architectural parity with EspoCRM while replacing the PHP backend with a modern Node.js runtime.

The target is **not** a line-by-line PHP-to-TypeScript translation. The target is a maintainable reimplementation of the concepts exposed by EspoCRM: metadata-driven entities, REST APIs, permissions, relationships, layouts, business logic, extensions, jobs, files, activity management, administration, portals, reporting, workflows, and other CRM capabilities.

### Primary outcome

Build a product that can:

1. Run independently of PHP.
2. Expose a stable REST API under `/api/v1`.
3. Support metadata-driven entity types and fields.
4. Support custom fields and relationships without requiring developers to hand-code every entity.
5. Provide a role/team/record/field-level security model comparable to EspoCRM.
6. Provide an extension/module SDK comparable in spirit to EspoCRM modules.
7. Provide a modern React SPA consuming the same API.
8. Support PostgreSQL first, with the architecture prepared for MySQL/MariaDB compatibility.
9. Provide deterministic integration tests against a reference EspoCRM installation where appropriate.
10. Become the foundation for future modules such as Sales, Projects, Workflows, BPM, Reports, AI Agents, Marketing Automation, Customer Success, Service Desk, and third-party integrations.

---

## 2. Important Scope and Compliance Decision

EspoCRM is currently an open-source project distributed under **GNU AGPLv3 / AGPL-3.0-or-later**. The upstream project also contains explicit legal-notice requirements in its source distribution. Before distributing a derivative, modified, or otherwise legally related implementation, perform a formal license/compliance review with qualified counsel.

This plan therefore recommends a **clean-room reimplementation strategy**:

- Study public documentation, observable product behavior, API contracts, metadata concepts, and publicly documented extension mechanisms.
- Do not copy PHP source files into the TypeScript repository.
- Do not mechanically translate PHP classes into TypeScript classes.
- Do not copy upstream frontend assets, proprietary branding, screenshots, translations, icons, or other copyrighted materials unless their license explicitly permits the intended use.
- Maintain an explicit list of upstream references used to define compatibility requirements.
- Use EspoCRM as a behavioral reference, not as a source-code dependency.
- Keep all new implementation code authored in the new repository and document which behaviors were independently implemented.

The official EspoCRM repository describes its architecture as an SPA frontend with a REST API backend and states that the backend is written in PHP. It also documents PHP 8.3–8.5 and MySQL/MariaDB/PostgreSQL requirements for the current master line. [EspoCRM GitHub repository](https://github.com/espocrm/espocrm)

---

## 3. Reference Baseline

### 3.1 Functional reference

Use the following as the primary functional references:

- EspoCRM Developer Documentation: https://docs.espocrm.com/development/
- API Overview: https://docs.espocrm.com/development/api/
- Metadata: https://docs.espocrm.com/development/metadata/
- ORM: https://docs.espocrm.com/development/orm/
- Dependency Injection: https://docs.espocrm.com/development/di/
- Modules: https://docs.espocrm.com/development/modules/
- Extension Packages: https://docs.espocrm.com/development/extension-packages/
- Services: https://docs.espocrm.com/development/services/
- Hooks: https://docs.espocrm.com/development/hooks/
- ACL: https://docs.espocrm.com/development/acl/
- Scheduled Jobs: https://docs.espocrm.com/development/scheduled-job/
- Attachments: https://docs.espocrm.com/development/attachments/
- Entry Points: https://docs.espocrm.com/development/entry-points/
- Roles: https://docs.espocrm.com/administration/roles-management/
- Users: https://docs.espocrm.com/administration/users-management/
- Portal: https://docs.espocrm.com/administration/portal/

### 3.2 Version strategy

The project should use two explicit compatibility baselines:

- **Phase A baseline:** EspoCRM 9.3.x behavior, because this is a realistic, stable migration baseline for an initial implementation.
- **Phase B baseline:** current upstream behavior from the latest stable/master documentation and release once parity with the Phase A baseline is established.

Every feature specification must identify its baseline version. Do not silently mix version-specific behavior.

### 3.3 Compatibility philosophy

Compatibility should be categorized as:

| Level                 | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| API-compatible        | Request/response shape and semantics match the documented contract closely enough for clients to work. |
| Behavioral-compatible | User-visible behavior is equivalent even if the internal implementation differs.                       |
| Metadata-compatible   | Metadata concepts map to the new implementation.                                                       |
| Extension-compatible  | A documented concept has a corresponding extension point, not necessarily identical PHP class names.   |
| Database-compatible   | Not required for v1. The new system has its own schema.                                                |
| Source-compatible     | Explicitly out of scope. Do not attempt PHP source compatibility.                                      |

---

# 4. Product Scope

## 4.1 Core CRM foundation

The first product must support the platform capabilities on which all other CRM modules depend:

- User authentication.
- User management.
- Teams.
- Roles and ACL.
- API users/keys.
- Session management.
- Entity manager.
- Dynamic fields.
- Relationships.
- Layouts.
- List/detail/edit/search views.
- Saved filters.
- Dashboards and dashlets.
- Stream/timeline.
- Notes and attachments.
- Notifications.
- Activities.
- Calendar.
- Global search.
- Audit/history.
- Administration settings.
- Localization and translation.
- Background jobs.
- Scheduled jobs.
- Email infrastructure.
- Import/export.
- Webhooks/integrations.
- Extension/module system.
- System health and diagnostics.

## 4.2 CRM application domains

After the platform foundation, implement domains in increments:

1. Accounts.
2. Contacts.
3. Leads.
4. Opportunities.
5. Campaigns and target lists.
6. Calls.
7. Meetings.
8. Tasks.
9. Emails.
10. Cases.
11. Knowledge Base.
12. Documents.
13. Calendar.
14. Products and price books.
15. Quotes / sales orders / invoices where required by the selected baseline.
16. Projects and project tasks.
17. Reports.
18. Workflows.
19. BPM.
20. Marketing automation.
21. Customer success.
22. Service desk.
23. AI/assistant capabilities.
24. Third-party integrations.

Enterprise/commercial or separately distributed extensions should be treated as separate product packages unless their licensing and implementation requirements are explicitly approved.

---

# 5. Non-Goals

The following are explicitly not goals for the first release:

- Preserving the upstream PHP class structure.
- Reproducing the upstream database schema exactly.
- Making PHP modules run unmodified under Node.js.
- Supporting every third-party EspoCRM extension automatically.
- Reusing proprietary or unlicensed assets.
- Implementing every advanced feature before the platform is stable.
- Building microservices before the modular monolith has reached production maturity.

---

# 6. Recommended Technology Stack

## 6.1 Backend

- Node.js 24 LTS line when supported by the deployment baseline.
- TypeScript.
- NestJS.
- Fastify adapter for HTTP performance where appropriate.
- Zod or class-validator/class-transformer for input validation; standardize on one approach across the repository.
- OpenAPI/Swagger generated from controllers/contracts.
- Pino for structured logging.
- OpenTelemetry for traces/metrics.
- BullMQ + Redis for asynchronous jobs.
- Nodemailer or a dedicated provider abstraction for outbound email.
- `argon2` for password hashing.
- `jose` or another audited JWT/OIDC implementation where JWT functionality is required.
- `openid-client` for OIDC/OAuth providers.

## 6.2 Persistence

### Primary recommendation: PostgreSQL + Kysely

Use PostgreSQL as the first-class database and Kysely (or an equivalent SQL-first query builder) as the persistence abstraction for the core metadata-driven engine.

Reason: the platform needs dynamic entity definitions, dynamic fields, dynamic relationships, custom queries, reporting queries, ACL predicates, aggregation, and metadata-defined behavior. A static ORM such as Prisma is not the best primary abstraction for a runtime-configurable entity platform because new fields and relationships can be introduced from the admin UI without recompiling the application.

### Optional secondary use of Prisma

Prisma may be used for isolated, static services if the team strongly prefers it, but it should not become the foundation of the dynamic Entity Manager.

### Database compatibility target

- PostgreSQL: first-class in v1.
- MySQL 8+: compatibility target after core behavior is stable.
- MariaDB: compatibility target after MySQL compatibility is stable.

Do not try to maintain three database dialects during the first implementation sprint. Build a database capability matrix and make dialect-specific behavior explicit.

## 6.3 Frontend

- React + TypeScript.
- Vite.
- React Router.
- TanStack Query for server state.
- Zustand or an equivalent small state layer for UI/session state.
- Ant Design or a similarly mature component system.
- React Hook Form + schema validation.
- Monaco Editor or CodeMirror for formula/configuration editing where needed.
- i18next for localization.

The frontend must consume metadata from the backend rather than hard-code the entire data model.

## 6.4 Infrastructure

- Docker.
- Docker Compose for development.
- PostgreSQL.
- Redis.
- Object storage abstraction supporting local filesystem and S3-compatible storage.
- Nginx or an equivalent reverse proxy.
- GitHub Actions.
- Container image scanning.
- Database backup/restore automation.
- Optional Kubernetes deployment later.

---

# 7. Architectural Principles

## 7.1 Modular monolith first

Use one deployable NestJS application with strongly separated modules and packages. Avoid microservices until there is a clear operational reason.

The modular monolith should have strict boundaries:

- Identity module.
- Authorization module.
- Metadata module.
- Entity module.
- Query module.
- Relation module.
- Layout module.
- Attachment module.
- Stream module.
- Activity module.
- Notification module.
- Search module.
- Audit module.
- Job module.
- Email module.
- Administration module.
- Extension module.
- Domain modules.

## 7.2 Domain logic must not live in controllers

Controllers should:

1. Validate input.
2. Establish request context.
3. Call application services.
4. Serialize responses.

Business rules belong in application/domain services.

This follows the same high-level separation described by EspoCRM, where controllers/actions are thin and service classes are entry points for business logic.

## 7.3 Metadata is a first-class subsystem

Metadata must not be an afterthought. It drives:

- Entity definitions.
- Fields.
- Relationships.
- Layouts.
- ACL metadata.
- Views.
- Search definitions.
- Record actions.
- Dynamic logic.
- Notifications.
- Stream behavior.
- Reports.
- API schema.

## 7.4 Every important operation should be observable

Capture:

- Request ID.
- User ID.
- Entity type.
- Record ID.
- Action.
- Execution time.
- Job ID where applicable.
- Error code.
- Trace ID.

Do not log secrets, access tokens, passwords, or sensitive message bodies by default.

---

# 8. Target Repository Structure

```text
crm/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── bootstrap/
│   │   │   ├── common/
│   │   │   └── modules/
│   │   └── test/
│   ├── worker/
│   │   └── src/
│   └── web/
│       ├── src/
│       └── public/
├── packages/
│   ├── core/
│   ├── metadata/
│   ├── entity-engine/
│   ├── query-engine/
│   ├── acl/
│   ├── workflow-engine/
│   ├── formula-engine/
│   ├── jobs/
│   ├── mail/
│   ├── files/
│   ├── search/
│   ├── reports/
│   ├── extension-sdk/
│   ├── ui-schema/
│   ├── api-client/
│   └── test-kit/
├── modules/
│   ├── core-identity/
│   ├── crm/
│   ├── sales/
│   ├── activities/
│   ├── marketing/
│   ├── support/
│   ├── projects/
│   ├── workflows/
│   ├── bpm/
│   ├── reports/
│   └── integrations/
├── config/
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── fixtures/
├── docs/
├── scripts/
└── package.json
```

The exact package/workspace implementation can use pnpm or Yarn workspaces. Pick one and standardize it before development starts.

---

# 9. Core Runtime Architecture

## 9.1 Request lifecycle

Every API request should follow a predictable pipeline:

```text
HTTP Request
   ↓
Reverse Proxy
   ↓
NestJS/Fastify
   ↓
Request ID / Trace Context
   ↓
Authentication Guard
   ↓
Current User Context
   ↓
Rate Limit / Security Policy
   ↓
Controller
   ↓
Application Service
   ↓
ACL Evaluation
   ↓
Entity Engine / Domain Service
   ↓
Transaction Manager
   ↓
Repository / Query Builder
   ↓
Domain Events
   ↓
Audit / Notifications / Jobs
   ↓
Response Serializer
   ↓
HTTP Response
```

## 9.2 Request context

Create a per-request context using `AsyncLocalStorage` or an equivalent mechanism.

Context should include:

```ts
interface RequestContext {
  requestId: string;
  traceId?: string;
  userId?: string;
  userType?: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles?: string[];
  tenantId?: string;
  locale?: string;
  timezone?: string;
  ip?: string;
  userAgent?: string;
}
```

The context must be injectable throughout application services without passing the user ID manually through every method.

---

# 10. Dependency Injection Architecture

NestJS already provides dependency injection. Use it as the main container abstraction.

Define explicit provider tokens for infrastructure abstractions:

```ts
export const DATABASE = Symbol('DATABASE');
export const ENTITY_MANAGER = Symbol('ENTITY_MANAGER');
export const METADATA_SERVICE = Symbol('METADATA_SERVICE');
export const FILE_STORAGE = Symbol('FILE_STORAGE');
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
export const SEARCH_INDEX = Symbol('SEARCH_INDEX');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
```

Avoid direct dependencies on concrete infrastructure implementations inside business logic.

Example:

```ts
@Injectable()
export class ContactService {
  constructor(
    @Inject(ENTITY_MANAGER)
    private readonly entityManager: EntityManager,
    private readonly acl: AclService,
  ) {}
}
```

This should make it possible to replace PostgreSQL repositories, storage backends, mail providers, or queue infrastructure without rewriting domain services.

---

# 11. Entity Engine

This is the most important subsystem in the entire project.

## 11.1 Requirements

The Entity Engine must support:

- Entity type discovery.
- Create.
- Read.
- Update.
- Delete.
- Soft delete where configured.
- Record ownership.
- Assigned user.
- Teams.
- Created/modified timestamps.
- Created/modified users.
- Optimistic concurrency.
- Relationship manipulation.
- Bulk update.
- Bulk delete with permission checks.
- Search.
- Sorting.
- Pagination.
- Aggregation.
- Field projection.
- Formula/calculated fields.
- Validation.
- Hooks.
- Domain events.
- Audit.
- ACL.

## 11.2 Entity interface

```ts
export interface EntityRecord {
  id: string;
  entityType: string;
  createdAt: Date;
  modifiedAt: Date;
  createdById?: string;
  modifiedById?: string;
  assignedUserId?: string;
  deletedAt?: Date;
  version: number;
  data: Record<string, unknown>;
}
```

Do not expose the raw persistence representation to controllers.

## 11.3 Entity definition

```ts
interface EntityDefinition {
  name: string;
  label: string;
  table?: string;
  isEntity: boolean;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  indexes: IndexDefinition[];
  acl?: AclDefinition;
  record?: RecordDefinition;
  client?: ClientDefinition;
}
```

## 11.4 Dynamic field strategy

Recommended model:

- Keep common/system fields as physical columns.
- Store flexible custom attributes in a JSONB column for the first PostgreSQL implementation.
- Maintain normalized relation tables for links and link-multiple relationships.
- Create database indexes on frequently queried custom fields based on metadata.

Alternative EAV implementation should be retained as a future option, but JSONB is preferable for the initial PostgreSQL-first implementation because it simplifies record storage and migrations.

### JSONB field rules

- Metadata defines field types.
- API validation uses metadata.
- Search builder translates field operators into PostgreSQL JSON operators.
- Report engine has a field resolver layer.
- Index manager can create functional indexes for selected custom fields.
- No arbitrary SQL is accepted from users.

---

# 12. Metadata Engine

EspoCRM documents metadata as a central system for fields, relationships, frontend behavior, layouts and other application definitions. The new implementation should preserve that architectural idea while using TypeScript-friendly schemas.

## 12.1 Metadata sources

Support metadata from:

1. Core package.
2. Domain module.
3. Installed extension.
4. Instance/custom configuration.
5. Admin-generated customizations.

## 12.2 Metadata merge order

Suggested merge order:

```text
Core
  ↓
Domain Modules
  ↓
Installed Extensions
  ↓
Tenant/Instance Customizations
  ↓
Runtime Overrides
```

Higher-priority sources override or recursively merge lower-priority sources according to a deterministic rule.

## 12.3 Metadata cache

Implement:

- In-memory cache.
- Persistent cache/version marker.
- Optional Redis cache for multi-instance deployments.
- Metadata version number.
- Cache invalidation event.

When the admin modifies Entity Manager configuration, increment the metadata version and invalidate both server and browser metadata caches.

## 12.4 Metadata schema validation

Every metadata document must be validated against JSON Schema during installation/build/runtime reload.

Example:

```text
schemas/
  entity-definition.schema.json
  field-definition.schema.json
  relation-definition.schema.json
  layout-definition.schema.json
  acl-definition.schema.json
  job-definition.schema.json
```

Invalid extension metadata must fail installation with an actionable error.

---

# 13. Field System

Implement the following field categories first:

### Primitive fields

- varchar.
- text.
- int.
- float.
- decimal.
- bool.
- date.
- datetime.
- enum/select.
- multiEnum.
- currency.
- url.
- email.
- phone.
- password.

### Relational fields

- link.
- linkOne.
- linkMultiple.
- linkParent.
- foreign.

### File fields

- file.
- image.
- attachment-multiple.

### Computed fields

- formula.
- generated/read-only.
- aggregation/count.

Each field type requires:

- Backend validator.
- Serializer.
- Query parser support.
- Filter support.
- Sort support where appropriate.
- UI renderer.
- UI editor.
- Import/export support.
- Report support.
- ACL interaction.

---

# 14. Relationship Engine

Relationships are fundamental to CRM behavior.

## 14.1 Required relationship types

- One-to-one.
- Many-to-one.
- One-to-many.
- Many-to-many.
- Parent-child polymorphic relations.
- Assigned user relation.
- Team relation.
- Follower relation.
- Collaborator relation.

## 14.2 Relation table design

Recommended generic relation table:

```text
entity_links
-------------
entity_type_a
record_id_a
relation_name
entity_type_b
record_id_b
role_a
role_b
created_at
metadata_json
```

Use dedicated relation tables for extremely high-volume or performance-sensitive domains where necessary.

## 14.3 Relation operations

The API layer must support operations conceptually equivalent to:

- Get related records.
- Link record.
- Unlink record.
- Replace relation.
- Count related records.
- Query related records with filters.

Every related-record operation must run ACL checks on both the parent record and the target records.

---

# 15. Query Engine

The Query Engine should be one of the shared foundations for API, reports, dashboards, exports, workflows and search.

## 15.1 Query model

```ts
interface QueryRequest {
  entity: string;
  select?: string[];
  where?: FilterNode;
  orderBy?: OrderClause[];
  offset?: number;
  limit?: number;
  joins?: JoinDefinition[];
  distinct?: boolean;
  groupBy?: string[];
  aggregate?: AggregateDefinition[];
}
```

## 15.2 Filter grammar

Support:

- equals.
- not equals.
- greater than.
- greater than or equal.
- less than.
- less than or equal.
- contains.
- starts with.
- ends with.
- is null.
- is not null.
- in.
- not in.
- between.
- date-relative filters.
- related-record filters.
- AND/OR groups.

Never accept raw SQL from users or metadata.

## 15.3 Query security

The query engine must receive an already-established authorization context and inject ACL conditions automatically.

A developer should not be able to accidentally create an API endpoint that bypasses normal ACL rules by calling the repository directly.

---

# 16. REST API

EspoCRM exposes a REST API under `api/v1/`. The new implementation should retain this root path for compatibility-oriented clients.

## 16.1 Standard endpoints

Implement generic entity endpoints:

```text
GET    /api/v1/{Entity}
POST   /api/v1/{Entity}
GET    /api/v1/{Entity}/{id}
PUT    /api/v1/{Entity}/{id}
DELETE /api/v1/{Entity}/{id}
```

Related-record operations:

```text
GET    /api/v1/{Entity}/{id}/{link}
POST   /api/v1/{Entity}/{id}/{link}/{relatedId}
DELETE /api/v1/{Entity}/{id}/{link}/{relatedId}
```

Additional platform endpoints:

```text
GET  /api/v1/Metadata
GET  /api/v1/OpenApi
GET  /api/v1/I18n
GET  /api/v1/AppUser
POST /api/v1/Authentication
POST /api/v1/Logout
```

Exact endpoint contracts must be finalized by comparing against the selected EspoCRM baseline.

## 16.2 API response envelope

Create a consistent serializer layer.

Example:

```json
{
  "id": "...",
  "name": "Example",
  "createdAt": "2026-10-08T00:00:00.000Z"
}
```

For collection responses:

```json
{
  "list": [],
  "total": 0,
  "offset": 0,
  "count": 20
}
```

Where strict upstream compatibility is needed, implement a compatibility serializer rather than forcing the internal model to mimic upstream persistence.

## 16.3 OpenAPI

Expose a generated OpenAPI specification for the new API.

Additionally generate a metadata-aware OpenAPI document that includes custom entity/field definitions where possible.

---

# 17. Authentication

Implement multiple authentication methods through a provider interface.

## 17.1 Internal password authentication

- Username/email identifier.
- Argon2id password hash.
- Password policy.
- Account active/inactive state.
- Lockout/rate limiting.
- Password reset.
- Session revocation.
- Optional MFA.

## 17.2 API key authentication

- API user.
- Key ID.
- Hashed secret storage.
- Key rotation.
- Role association.
- Scope restrictions.
- Last used timestamp.
- IP restrictions as optional policy.

Never store raw API secrets.

## 17.3 OAuth/OIDC

Support:

- Google.
- Microsoft.
- Generic OpenID Connect provider.

Use provider adapters rather than embedding provider-specific logic into the identity service.

## 17.4 Session model

Recommended:

- Short-lived access token.
- Refresh token rotation.
- Server-side session record for revocation.
- HttpOnly secure cookies for browser sessions.
- CSRF protection for cookie-authenticated browser operations.

---

# 18. Authorization and ACL

This is another critical subsystem.

## 18.1 Role model

Support role levels comparable to:

- yes.
- all.
- team.
- own.
- no.

Actions:

- create.
- read.
- edit.
- delete.
- stream.

Special permissions:

- assignment.
- export.
- mass update.
- data privacy.
- follower management.
- message.
- audit.
- mention.
- record lock.

## 18.2 Role evaluation

A user may have multiple roles through:

- Direct role assignment.
- Team roles.
- Baseline role.
- Portal roles.

Merge permissions using explicit precedence rules.

## 18.3 Field-level security

ACL must be able to hide or make read-only specific fields.

This must be enforced in both:

- API serialization.
- API write validation.

Do not rely on the frontend hiding fields as a security mechanism.

## 18.4 Record-level security

Implement reusable predicates for:

- Own records.
- Team records.
- Assigned user.
- Related account/contact.
- Collaborator access.
- Portal access.
- Explicit sharing where supported.

---

# 19. Entity Manager / Admin Customization

Provide an admin UI comparable in purpose to an Entity Manager.

## 19.1 Admin capabilities

Admins can:

- Enable/disable entities.
- Create custom entities.
- Add fields.
- Edit labels.
- Create relationships.
- Configure layouts.
- Configure search.
- Configure ACL.
- Configure record lists.
- Add custom indexes where safe.
- Configure formulas.
- Manage API access.
- Configure integrations.
- Configure email.
- Configure scheduled jobs.
- Configure system settings.

## 19.2 Schema changes

Every admin structural change must create an internal change record:

```text
schema_changes
--------------
id
operation
entity_type
field_name
payload
status
created_at
applied_at
error
```

Use transactional migrations when a physical DB change is required.

Never directly modify production schema from arbitrary browser code without a server-side change plan and audit trail.

---

# 20. Layout Engine

The layout engine converts metadata into UI forms.

Support layouts such as:

- List.
- Detail.
- Edit.
- Filters.
- Search.
- Mass update.
- Side panels.
- Relationship panels.
- Activity panels.
- Stream panel.
- Record action buttons.

Example model:

```ts
interface LayoutDefinition {
  entity: string;
  type: 'list' | 'detail' | 'edit' | 'filter' | 'search';
  panels: LayoutPanel[];
}
```

A layout renderer should be generic so that a new entity created in Entity Manager can immediately obtain usable CRUD UI without manually creating a React page.

---

# 21. Dynamic Logic

Implement declarative UI and validation rules.

Examples:

- Show field when another field has a value.
- Make field required when condition matches.
- Make field read-only when condition matches.
- Hide panel based on state.
- Automatically set values.
- Validate business conditions.

Represent rules as a safe AST rather than JavaScript code.

Example:

```json
{
  "when": {
    "field": "type",
    "operator": "equals",
    "value": "Customer"
  },
  "then": {
    "setRequired": ["taxId"]
  }
}
```

---

# 22. Formula Engine

Formula functionality should be implemented as a sandboxed expression engine.

## 22.1 Rules

- Never execute arbitrary JS submitted by admins.
- Use a parser/AST.
- Explicitly whitelist functions.
- Limit execution time and expression complexity.
- Prevent filesystem/network access.
- Prevent dynamic module import.
- Provide deterministic date/time functions.

## 22.2 Initial functions

Implement:

- String functions.
- Numeric functions.
- Date functions.
- Boolean functions.
- Collection functions.
- Record access functions.
- Conditional functions.
- Math functions.

Later add custom function registration through the extension SDK.

---

# 23. Hooks and Domain Events

EspoCRM provides hooks such as before-save and after-save. Implement equivalent semantics using NestJS providers plus a domain-event layer.

## 23.1 Hook phases

Recommended phases:

```text
beforeValidate
beforeCreate
beforeUpdate
beforeDelete
beforeSave
afterCreate
whenCreated
whenUpdated
whenDeleted
afterSave
```

Keep the list configurable so it can evolve as parity requirements are discovered.

## 23.2 Event bus

Use a transactional outbox pattern for durable asynchronous events.

Example:

```text
HTTP transaction
    ↓
DB changes
    ↓
Outbox event inserted
    ↓
Transaction commit
    ↓
Worker publishes/processes event
```

This avoids the classic failure where the DB commit succeeds but the queue publish fails.

---

# 24. Background Jobs and Scheduled Jobs

EspoCRM documents scheduled jobs as a first-class extension mechanism. The new system should provide:

- One-off jobs.
- Scheduled jobs.
- Retry policy.
- Exponential backoff.
- Dead-letter handling.
- Job progress.
- Job logs.
- Job cancellation.
- Concurrency controls.
- Cron schedules.
- Admin UI.

Recommended infrastructure:

```text
NestJS
  ↓
BullMQ
  ↓
Redis
  ↓
Worker process
```

Job definitions should be metadata-driven:

```json
{
  "name": "CleanUpJobs",
  "scheduling": "0 * * * *",
  "handler": "system.cleanup"
}
```

Do not store executable JavaScript in metadata.

---

# 25. Attachment and File Storage

Provide a file abstraction:

```ts
interface FileStorage {
  put(input: PutFileInput): Promise<FileRef>;
  get(id: string): Promise<ReadableStream>;
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  getSignedUrl?(id: string): Promise<string>;
}
```

Storage implementations:

- Local filesystem.
- S3.
- MinIO.

Attachment entity fields:

- id.
- name.
- size.
- mimeType.
- storageKey.
- checksum.
- relatedType.
- relatedId.
- parentType.
- parentId.
- field.
- role.
- createdBy.

Implement chunked upload for large files.

Security requirements:

- Malware scanning hook.
- MIME validation.
- File size limits.
- Dangerous extension blocking.
- Signed download URLs for object storage.
- Access checks before download.

---

# 26. Stream / Timeline

Implement a unified activity stream.

Capabilities:

- Record posts.
- Notes.
- Mentions.
- Follows.
- Unfollows.
- Record updates where configured.
- Activity notifications.
- Attachments.
- Reactions only if required by the baseline.

Tables:

```text
stream_items
stream_mentions
stream_followers
stream_attachments
```

ACL must control stream visibility independently from record edit access where applicable.

---

# 27. Activities and Calendar

Implement these core activities:

- Task.
- Call.
- Meeting.
- Reminder.
- Calendar event.

Required features:

- Assigned user.
- Teams.
- Participants.
- Related records.
- Start/end time.
- Status.
- Priority.
- Reminder.
- Recurrence where required.
- Calendar views.
- Drag/drop rescheduling.
- Time zone handling.

Time should be stored as UTC with explicit user timezone/locale handling at the UI layer.

---

# 28. Email Subsystem

Treat email as a platform service, not a single feature module.

## 28.1 Outbound email

Provider interface:

```ts
interface MailTransport {
  send(message: MailMessage): Promise<SendResult>;
}
```

Implement:

- SMTP.
- Generic SMTP relay.
- Amazon SES adapter later.
- SendGrid adapter later.
- Microsoft Graph adapter later.

## 28.2 Inbound email

Later support:

- IMAP.
- POP3 only if necessary.
- Microsoft Graph.
- Gmail API.

Use a normalized inbound message pipeline.

## 28.3 Email records

Store:

- From.
- To.
- CC/BCC metadata where appropriate.
- Subject.
- Body.
- HTML body.
- Headers.
- Message ID.
- Thread ID.
- Delivery status.
- Related entity.
- Attachments.

Secrets and credentials must be stored encrypted at rest.

---

# 29. Notifications

Implement:

- In-app notifications.
- Email notifications.
- Browser push later.
- Notification preferences.

Create a generic notification event:

```ts
interface NotificationEvent {
  recipientUserId: string;
  type: string;
  payload: Record<string, unknown>;
  priority?: number;
  createdAt: Date;
}
```

Use Redis/WebSocket or Server-Sent Events for real-time notification delivery.

---

# 30. Search

Use a two-stage strategy.

## Stage 1

PostgreSQL search:

- B-tree indexes.
- GIN indexes for JSONB.
- PostgreSQL full text search.
- Trigram search.

## Stage 2

Optional OpenSearch/Elasticsearch.

Create an abstract search provider so the application is not tightly coupled to one engine.

Search must respect ACL. Never index private records into a shared global search index without preserving visibility information.

---

# 31. Audit and History

Audit changes to:

- Sensitive fields.
- Security configuration.
- Role changes.
- User status.
- Password/authentication events.
- Integration credentials.
- Entity configuration.
- Data modifications where audit is enabled.

Store field-level changes:

```text
audit_log
---------
entity_type
record_id
user_id
action
field
old_value
new_value
created_at
```

Redact secrets and credentials.

Provide an admin Audit Log UI.

---

# 32. Import / Export

## Import

Support:

- CSV first.
- XLSX later.
- Duplicate detection.
- Field mapping.
- Preview.
- Validation report.
- Error row export.
- Background processing for large files.
- Transaction batching.

## Export

Support:

- CSV.
- XLSX.
- JSON.
- PDF through a separate report/document subsystem.

Export must enforce ACL and export permission.

---

# 33. Dashboards and Dashlets

Dashboard architecture:

```text
Dashboard
  ├── Layout
  └── Dashlets
       ├── List
       ├── Chart
       ├── Metric
       ├── Calendar
       ├── Stream
       └── Custom
```

Dashlets should be metadata/configuration-driven and query through the same Query Engine used by reports.

Avoid allowing arbitrary SQL in dashboard configuration.

---

# 34. Reports

Build reports on top of the Query Engine instead of creating a separate data access layer.

## Report types

- List report.
- Summary report.
- Grouped report.
- Chart report.
- Matrix/pivot report.
- KPI.
- Scheduled report.

## Required capabilities

- Filters.
- Grouping.
- Aggregations.
- Calculated metrics.
- Date dimensions.
- Related fields.
- Export.
- Permissions.
- Scheduled delivery.

Report execution must have query-cost protections to prevent administrators from creating unbounded queries against large datasets.

---

# 35. Workflow Engine

Implement workflows after the event/hook/job infrastructure is stable.

## Workflow concepts

- Trigger.
- Condition.
- Action.
- Delay.
- Branch.
- Record create/update.
- Relation update.
- Notification.
- Email.
- Webhook.
- Job scheduling.

Use a versioned workflow definition:

```text
workflow
workflow_versions
workflow_nodes
workflow_edges
workflow_runs
workflow_run_steps
```

Never mutate a published workflow in place without versioning.

---

# 36. BPM Engine

BPM should build on the workflow/event/job foundation rather than duplicating it.

Core concepts:

- Process definition.
- Process instance.
- User task.
- Service task.
- Gateway.
- Transition.
- Approval.
- Timer.
- Escalation.
- Cancellation.
- Completion.

Suggested execution architecture:

```text
BPM Definition
    ↓
BPM Compiler/Validator
    ↓
Process Instance
    ↓
State Machine
    ↓
Jobs / User Tasks / Events
```

Keep BPM execution deterministic and resumable.

---

# 37. Portals

Implement a separate portal security model.

Portal users should have:

- Portal assignment.
- Contact/account relation.
- Portal role.
- Restricted record visibility.
- Portal-specific navigation.
- Portal dashboard.

Never reuse internal admin ACL blindly for portal requests. Portal ACL should have its own policy provider built on shared authorization primitives.

---

# 38. Extension / Module System

A primary goal of the reimplementation is to preserve extensibility.

## 38.1 Extension package

Example:

```text
my-extension/
├── manifest.json
├── backend/
│   ├── module.ts
│   ├── metadata/
│   ├── services/
│   ├── controllers/
│   ├── hooks/
│   └── jobs/
├── frontend/
│   ├── views/
│   ├── fields/
│   └── index.ts
├── migrations/
└── README.md
```

## 38.2 Manifest

```json
{
  "name": "My Extension",
  "id": "my-extension",
  "version": "1.0.0",
  "minPlatformVersion": "1.0.0",
  "dependencies": [],
  "permissions": [],
  "metadata": {
    "order": 100
  }
}
```

## 38.3 Extension lifecycle

```text
upload
  ↓
validate
  ↓
check compatibility
  ↓
check dependencies
  ↓
install database migrations
  ↓
merge metadata
  ↓
invalidate caches
  ↓
register jobs/routes/providers
  ↓
activate
```

## 38.4 Security

Do not allow extensions to upload arbitrary executable code from untrusted administrators in a hosted multi-tenant product without a strong isolation model.

For self-hosted installations, extension installation can support trusted packages, but signature verification and integrity checks are still recommended.

---

# 39. Module Ordering

EspoCRM documents module order as an input to metadata/controller override precedence. Recreate this behavior as a deterministic module priority system.

Example:

```json
{
  "id": "sales",
  "order": 300
}
```

Resolution rule:

- Lower-order base modules load first.
- Higher-order modules override/extend compatible definitions.
- Conflicts are reported during metadata compilation.
- Ambiguous overrides fail fast when safety cannot be guaranteed.

---

# 40. Frontend Architecture

## 40.1 SPA shell

The frontend must be an SPA with:

- Authentication screen.
- Main navigation.
- Route registry.
- Metadata loader.
- Permission-aware navigation.
- Global search.
- Notifications.
- User profile.
- Administration.

## 40.2 Generic record UI

Create generic components:

```text
EntityListPage
EntityDetailPage
EntityEditPage
EntityCreatePage
EntityFilterPanel
EntitySearchPanel
EntityRelatedPanel
EntityStream
EntityForm
FieldRenderer
FieldEditor
RecordActionMenu
MassActionBar
```

These components should render based on metadata.

## 40.3 Field registry

```ts
interface FieldRendererRegistration {
  type: string;
  renderer: React.ComponentType<any>;
  editor: React.ComponentType<any>;
}
```

Extensions can register field types without modifying the core application.

---

# 41. Internationalization

Localization is a P0 capability, not a polish feature. Every user-visible string must be resolvable through a translation catalog, including strings produced by metadata and by the API.

## 41.1 Scope

Support:

- UI translations.
- Entity labels.
- Field labels.
- Layout labels.
- Option-set labels.
- Error messages.
- Validation messages.
- Email templates.
- Date/number formatting.
- User timezone.

Everything listed above must be translatable. A hard-coded user-visible string is a defect, not a shortcut.

## 41.2 Translation key naming

Translation keys must be stable and namespaced by owning module:

```text
core.user.label
crm.account.label
crm.account.fields.name
sales.quote.label
```

Rules:

- Dot-separated, lowercase, module-first.
- The first segment is the owning package or module (`core`, `crm`, `bpm`, `reports`) or an extension id.
- Entity labels use `<module>.<entity>.label`.
- Field labels use `<module>.<entity>.fields.<fieldName>`.
- Keys never change once shipped. Renaming a label keeps the old key as an alias.
- Extensions own their namespace and must not emit keys outside it.

## 41.3 Catalog layout

```text
i18n/
  en/
    core.json
    crm.json
    errors.json
  vi/
    core.json
    crm.json
    errors.json
```

Rules:

- Catalogs are static files in version control, one JSON file per module.
- One directory per locale. Never suffix filenames with locale codes.
- An incomplete catalog is valid. Catalogs are never required to be 100% complete.
- Adding a locale means adding a directory. Never add locale conditionals to application code.

## 41.4 Resolution and fallback

Resolution order for a key:

1. Authenticated user's locale.
2. `Accept-Language` request header.
3. Instance default locale.
4. Built-in `en` catalog.

A missing key must never crash a request or render an empty label. The untranslated English source string is the last-resort fallback, then a humanized key name.

Untranslated keys must stay observable: emit a structured warning carrying the key and the locale so catalog gaps are findable in logs and metrics.

## 41.5 API

```text
GET /api/v1/I18n?locale=vi
```

Returns the merged catalog for the requested locale, already resolved against the fallback chain.

Support a content hash or equivalent conditional request (`?clientCache=<hash>`) so the SPA can skip re-downloading unchanged catalogs. Catalogs are cached per locale (see section 51).

A user's own locale is changed through the authenticated profile endpoint. Reject any locale outside the instance's enabled locale list.

## 41.6 User locale and timezone

- `users.locale` — per-user UI locale. Nullable; defaults to the instance default.
- `users.timezone` — IANA timezone name. Nullable; defaults to the instance default.
- Request context populates `locale` and `timezone` from the authenticated user first, and only then falls back to `Accept-Language`.
- Timestamps are stored as UTC. Conversion and formatting happen at the presentation layer only.
- Date, number, and currency formatting always go through the active locale. Never rely on the host or runtime default.

## 41.7 Metadata integration

Entity, field, and layout definitions in metadata accept either a literal label or a translation key.

Resolution happens inside the metadata layer, so list, detail, search, export, email, and API paths all return the same label for the same record. Do not resolve labels ad hoc per screen.

## 41.8 Extension contribution

An extension may ship catalogs. Its manifest must declare:

- The locale identifiers it contributes.
- The catalog files it provides.

Only declared files are loaded. Extension keys are namespaced by extension id and can never override core keys.

## 41.9 Security and validation

- Never build a translation key from untrusted input. Resolve keys from a validated, fixed set.
- Metadata field names, sort keys, and filter parameters must not be concatenated into keys without an allowlist check.
- Catalog content is static data, not a template engine. Do not evaluate expressions or embed user content in catalogs.
- User-facing errors resolve through the catalog and must not leak stack traces, SQL, or internal identifiers.

---

# 42. Configuration System

Separate configuration into:

1. Environment configuration.
2. Secure secrets.
3. Database-backed application settings.
4. User preferences.
5. Tenant settings.

Never store secrets in ordinary settings tables unencrypted.

Provide a central `ConfigService` with typed definitions.

---

# 43. Multi-Tenancy Strategy

The initial architecture should be tenant-ready even if v1 is single-tenant.

Recommended model:

```text
tenants
users.tenant_id
roles.tenant_id
records.tenant_id
metadata.tenant_id
attachments.tenant_id
```

Support three future isolation models:

- Shared database + tenant ID.
- Database/schema per tenant.
- Database per tenant.

Do not implement all three initially. Make repository APIs tenant-aware from day one.

---

# 44. Data Model Foundation

The exact schema should evolve, but the first migration set should include at least:

```text
users
user_sessions
api_users
api_keys
roles
role_permissions
teams
team_members
team_roles
users_roles
entities_metadata
fields_metadata
relations_metadata
layouts_metadata
app_settings
user_preferences
entity_records
entity_links
attachments
stream_items
followers
notifications
activities
audit_log
jobs
job_runs
scheduled_jobs
outbox_events
email_messages
email_accounts
saved_filters
dashboards
dashlets
```

Additional domain tables come later.

---

# 45. ID Strategy

Use UUID or ULID identifiers.

Recommended:

- UUIDv7 if database/tooling support is mature.
- Otherwise ULID.

Benefits:

- Better index locality than random UUIDv4.
- Distributed creation.
- No predictable integer IDs.

The API should treat IDs as opaque strings.

---

# 46. Transactions and Concurrency

All record mutations should support transactions.

Use optimistic concurrency with a version column:

```text
UPDATE record
SET ...,
    version = version + 1
WHERE id = :id
  AND version = :expectedVersion
```

If zero rows are updated, return a conflict error.

For high-risk operations, use explicit DB row locks.

Never keep a DB transaction open while waiting on an external HTTP API or email provider.

---

# 47. Error Model

Create stable machine-readable error codes.

Example:

```json
{
  "error": {
    "code": "AUTHORIZATION_DENIED",
    "message": "You do not have permission to edit this record.",
    "details": {
      "entity": "Opportunity",
      "action": "edit"
    }
  }
}
```

Suggested categories:

- AUTHENTICATION_REQUIRED.
- AUTHENTICATION_FAILED.
- AUTHORIZATION_DENIED.
- RECORD_NOT_FOUND.
- VALIDATION_FAILED.
- DUPLICATE_RECORD.
- CONCURRENCY_CONFLICT.
- INVALID_QUERY.
- RATE_LIMITED.
- FILE_TOO_LARGE.
- FEATURE_DISABLED.
- INTERNAL_ERROR.

Do not expose stack traces in production responses.

---

# 48. Security Architecture

## Required controls

- Password hashing with Argon2id.
- Secure cookies.
- CSRF protection for cookie-based operations.
- Rate limiting.
- Login throttling.
- API key hashing.
- Secrets encryption at rest.
- Security headers.
- Content Security Policy.
- MIME/file validation.
- SSRF protection for outbound integrations.
- Webhook signature verification.
- Replay protection for webhooks where possible.
- Audit logging.
- Least-privilege service accounts.
- Tenant isolation.
- Permission tests for every CRUD endpoint.

## SSRF protection

Any feature that fetches a user-supplied URL, including webhooks/importers/integrations, must reject:

- Localhost.
- RFC1918 private networks unless explicitly allowed.
- Link-local addresses.
- Cloud metadata endpoints.
- Untrusted redirects.

---

# 49. Observability

Implement:

### Logs

- Structured JSON.
- Correlation ID.
- User ID.
- Tenant ID.
- Route.
- Status code.
- Duration.

### Metrics

- Request rate.
- Error rate.
- Latency p50/p95/p99.
- DB latency.
- Queue depth.
- Job success/failure.
- Email delivery.
- Search latency.
- Cache hit rate.

### Tracing

OpenTelemetry tracing across:

```text
HTTP → service → database → queue → worker → external provider
```

---

# 50. Performance Targets

Initial production goals:

- CRUD API p95 < 250 ms for normal records without external API calls.
- Metadata endpoint p95 < 150 ms after cache warm-up.
- Authentication p95 < 500 ms.
- List pages should issue a bounded number of queries.
- No N+1 relation queries.
- Large exports always run asynchronously.
- Large imports always run asynchronously.
- Search should be paginated and ACL-aware.

Benchmark with realistic datasets:

- 100k Contacts.
- 100k Accounts.
- 1M Activities.
- 1M Stream items.
- 10M relation rows.

---

# 51. Caching

Cache only data with well-defined invalidation rules.

Cache candidates:

- Metadata.
- App configuration.
- User permissions.
- Translation catalogs.
- Frequently requested lookup lists.
- OpenAPI schema.

Do not cache mutable record data globally until correctness is proven.

Use Redis for distributed cache where necessary.

---

# 52. Database Indexing Strategy

Every entity definition should support declared indexes.

Automatically consider indexes on:

- id.
- created_at.
- modified_at.
- assigned_user_id.
- created_by_id.
- deleted_at.
- foreign key columns.
- frequently searched custom fields.

Do not create an index for every custom field by default.

Use query telemetry to identify expensive filters and add indexes intentionally.

---

# 53. Migration Strategy

## 53.1 Clean installation

All database schema should be reproducible from migrations.

## 53.2 Metadata migration

Metadata changes should be versioned separately from SQL migrations when they do not affect physical schema.

## 53.3 Custom field migration

When a custom field requires an index or physical structure change, execute an idempotent migration operation.

## 53.4 Rollback

Prefer forward migrations for production schema changes. Rollback scripts can be maintained for development, but destructive automated rollback should not be assumed safe in production.

---

# 54. Seed Data

Provide deterministic development seeds:

- Admin user.
- Demo users.
- Teams.
- Roles.
- Sample Accounts.
- Sample Contacts.
- Sample Leads.
- Sample Opportunities.
- Sample Activities.
- Sample dashboard.

Separate demo data from production bootstrap data.

---

# 55. API Compatibility Test Strategy

Create a test harness that can run the same scenario against:

1. Reference EspoCRM.
2. New NestJS implementation.

Then compare normalized responses.

Example scenario:

```text
Create Account
  ↓
Create Contact linked to Account
  ↓
Query Account contacts
  ↓
Update Contact
  ↓
Check audit
  ↓
Check stream
  ↓
Delete/restore where supported
```

Normalize:

- Timestamps.
- Generated IDs.
- Environment-specific URLs.
- Non-deterministic ordering where not contractually defined.

This is one of the most valuable assets of the project.

---

# 56. Testing Strategy

## 56.1 Unit tests

Test:

- Formula engine.
- Query parser.
- ACL evaluator.
- Metadata merger.
- Field validators.
- Serialization.
- Relation resolver.
- Workflow conditions.
- Job scheduling logic.

## 56.2 Integration tests

Test:

- PostgreSQL repositories.
- Transactions.
- Metadata reload.
- File storage.
- Redis queues.
- Email adapters.

## 56.3 API tests

Test every standard endpoint with:

- Admin user.
- Regular user.
- API user.
- Portal user.
- Unauthorized request.
- Record owner.
- Team member.
- Non-team user.

## 56.4 Browser tests

Use Playwright.

Critical flows:

- Login.
- Create contact.
- Search.
- Edit.
- Related records.
- File upload.
- Calendar.
- Role management.
- Entity Manager.
- Import/export.
- Workflow creation.

## 56.5 Security tests

Include:

- IDOR tests.
- Permission bypass tests.
- CSRF tests.
- SSRF tests.
- File upload tests.
- Token leakage tests.
- Rate-limit tests.
- Formula sandbox escape tests.
- Multi-tenant isolation tests.

---

# 57. Development Phases

## Phase 0 — Discovery and Baseline

Deliverables:

- Feature inventory.
- API inventory.
- Metadata inventory.
- Entity inventory.
- ACL inventory.
- Extension inventory.
- Version matrix.
- Compatibility matrix.
- Legal/compliance checklist.

Output:

```text
/docs/reference/
  api-matrix.md
  entity-matrix.md
  metadata-matrix.md
  feature-matrix.md
  compatibility-matrix.md
```

Acceptance criterion: the team can explain what “parity” means before writing core code.

---

## Phase 1 — Repository and Tooling

Tasks:

- Initialize monorepo.
- Configure TypeScript strict mode.
- Configure ESLint.
- Configure Prettier.
- Configure commit hooks.
- Configure conventional commits if desired.
- Configure CI.
- Build Docker development stack.
- Add PostgreSQL.
- Add Redis.
- Add test database lifecycle.

Acceptance:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

all pass in CI.

---

## Phase 2 — Kernel / Bootstrap

Implement:

- NestJS bootstrap.
- Config service.
- Logging.
- Request context.
- Error handling.
- Health endpoints.
- Database provider.
- Redis provider.
- OpenAPI.
- Security headers.
- Rate limiter.

Acceptance:

- API starts from a clean container.
- Health/readiness endpoints work.
- Database connection failures are visible.

---

## Phase 3 — Identity and Sessions

Implement:

- User model.
- Password authentication.
- Sessions.
- Password reset.
- API users.
- API keys.
- Logout/revocation.
- Account status.

Acceptance:

- Admin can log in.
- API user can authenticate.
- Revoked keys stop working.
- Password hashes are not reversible.

---

## Phase 4 — ACL Foundation

Implement:

- Users.
- Teams.
- Roles.
- Role merging.
- Scope permissions.
- Record permissions.
- Field permissions.
- API guards.

Acceptance:

Create a comprehensive ACL matrix and make it pass for all CRUD operations.

---

## Phase 5 — Metadata Engine

Implement:

- Metadata schemas.
- Metadata loader.
- Merge engine.
- Cache.
- Metadata API.
- Metadata validation.
- Metadata versioning.

Acceptance:

A new entity can be described entirely by metadata and exposed through a generic API.

---

## Phase 6 — Entity Engine

Implement:

- Entity Manager.
- CRUD.
- Validation.
- Query engine.
- Transactions.
- Optimistic locking.
- Soft delete where required.
- Relation engine.

Acceptance:

A generic custom entity can be created and managed without writing a dedicated controller for every CRUD operation.

---

## Phase 7 — Generic React UI

Implement:

- Metadata loader.
- Generic list view.
- Generic detail view.
- Generic create/edit form.
- Filters.
- Related panels.
- Record actions.

Acceptance:

An admin can create a custom entity and obtain a working CRUD UI from metadata alone.

---

## Phase 7A — Internationalization

Depends on: Phase 3 (user model), Phase 5 (metadata engine), Phase 7 (generic React UI).

Implement:

- Catalog layout and the `en` source catalog.
- Key naming convention and its validation.
- Fallback resolution chain with observable missing-key warnings.
- `GET /api/v1/I18n` with conditional client caching.
- i18next initialization in the SPA and language switching in the UI.
- `users.locale` and `users.timezone` columns with instance defaults.
- Request context locale and timezone resolution.
- Metadata label resolution for entity, field, and layout labels.
- Error and validation message keys.
- Admin-facing locale switching.

Acceptance:

- Changing the user locale changes entity labels, field labels, form actions, and error messages without a rebuild.
- `GET /api/v1/I18n` returns the merged catalog for the authenticated user and is cacheable by content hash.
- A missing translation key falls back to the English source string and logs a warning; it never breaks rendering.
- The generic CRUD UI contains no hard-coded user-visible strings.
- Dates render in the user timezone and numbers in the user locale.

---

## Phase 8 — Entity Manager Admin UI

Implement:

- Fields.
- Relations.
- Layouts.
- Labels.
- ACL metadata.
- Index configuration.
- Entity enable/disable.

Acceptance:

A non-developer admin can customize a standard entity safely.

---

## Phase 9 — Attachments / Stream / Activities

Implement:

- Attachments.
- Object storage.
- Stream.
- Notes.
- Followers.
- Tasks.
- Calls.
- Meetings.
- Calendar.
- Notifications.

Acceptance:

A normal CRM user can perform day-to-day customer management without custom code.

---

## Phase 10 — Core CRM Entities

Implement:

- Account.
- Contact.
- Lead.
- Opportunity.
- Campaign.
- Target List.
- Product.
- Document.

Acceptance:

The core CRM sales flow is complete from lead to customer/opportunity management.

---

## Phase 11 — Email and Communication

Implement:

- Email accounts.
- SMTP.
- Email sending.
- Email records.
- Email templates.
- Signature.
- Outbound queue.
- Inbound abstraction.

Acceptance:

A user can send and track CRM emails without blocking API requests on SMTP operations.

---

## Phase 12 — Search / Import / Export / Dashboards

Implement:

- Global search.
- Entity search.
- Saved filters.
- CSV import.
- CSV export.
- Dashboards.
- Dashlets.

Acceptance:

Users can locate and manage business data efficiently at 100k+ records.

---

## Phase 13 — Jobs / Hooks / Formula / Dynamic Logic

Implement:

- Hooks.
- Domain events.
- Outbox.
- Formula engine.
- Dynamic logic.
- Job framework.
- Scheduled jobs.

Acceptance:

Developers can build automation without modifying the core runtime for every new behavior.

---

## Phase 14 — Extension SDK

Implement:

- Manifest.
- Installation.
- Dependencies.
- Module priority.
- Metadata contribution.
- Backend providers.
- Frontend contribution.
- Migrations.
- Version compatibility checks.

Acceptance:

Build at least three independent extensions without editing the core package.

Suggested first extensions:

- Custom field package.
- Custom integration.
- Custom CRM domain module.

---

## Phase 15 — Workflow Engine

Implement:

- Triggers.
- Conditions.
- Actions.
- Delays.
- Branching.
- Error handling.
- Run history.
- Retry.

Acceptance:

Build several real automations entirely through the UI.

---

## Phase 16 — BPM

Implement the state-machine/process layer after workflows are stable.

Acceptance:

Support at least one multi-step approval process with user tasks, timers, conditions and auditability.

---

## Phase 17 — Reports

Implement:

- Report builder.
- Summary.
- Grouping.
- Charts.
- Metrics.
- Scheduled delivery.
- Export.

Acceptance:

Business users can build useful reports without SQL.

---

## Phase 18 — Portals and External Access

Implement:

- Portal users.
- Portal roles.
- Portal navigation.
- Portal dashboards.
- Portal-specific ACL.

Acceptance:

A contact/customer can safely access permitted records without gaining internal access.

---

## Phase 19 — Advanced Domains

Implement in separate modules:

- Projects.
- Customer success.
- Service desk.
- Marketing automation.
- AI agents (Phase 19-AI.0–19-AI.19 implemented; 19-AI.18's protocol half is delivered as the
  authenticated, allowlisted MCP-compatible adapter while model-backed retrieval stays deferred; see
  `PLAN_Phase_19_AI_Agents.md` and `docs/modules/ai-agents/`).
- Voice/communications.
- Advanced integrations.

Do not put these directly into the kernel.

---

## Phase 20 — Settings, Administration and UX/UI

Progress (2026-10-20): sub-phases 20.0–20.17 are implemented — the settings document registry with
versioning and optimistic concurrency, the tabbed administration shell, the General / Localization /
Main Menu / Layout / Attachments / Users / Teams / Roles / API keys / Security / Messaging / Internal
tabs, the hosted Sales, Service Desk and Customer Success documents, `GET /Navigation` resolved and
ACL-filtered on the server, per-entity `nav` metadata, per-user preferences, the shared state
components, the list-view power pack, the record-page guard, the command palette, the setup
checklist, and the accessibility/responsive pass.

The remaining parts of the plan's §5 that are **not** built — cross-page "select all N matching
records", bulk-action outcome counts, the row kebab menu, column reorder/resize/freeze, list
virtualization, the Favorites group, the record-page sticky header and next-action band, "Save &
new" — are listed as deferrals in `docs/compatibility/settings-ux.md`. There is no automated axe
audit and no frontend test runner in this repository, so the plan's 20.16 acceptance criterion is
not met; see `docs/ux/accessibility.md`.

See `docs/admin/settings.md`, `docs/admin/navigation.md`, `docs/ux/`,
`docs/compatibility/settings-ux.md` and `docs/reference/alpha-status.md`.

Implement, as specified in `PLAN_Phase_20_Settings_UX.md`:

- A metadata-driven, tabbed Administration area with a settings-document registry (brand,
  localization, layouts, main menu, attachments, jobs, audit, internal, users, teams, roles, API
  keys, portals, authentication, permissions, email, notifications, integrations and module settings).
- Administrator-configurable main menu and per-entity navigation metadata, resolved server-side and
  always filtered by existing ACL.
- End-user UX: command palette and global search, list-view power pack (saved views, URL state,
  columns, density, inline edit, scoped bulk actions with undo), record page and form ergonomics,
  shared empty/loading/error/permission states, accessibility and responsive hardening.

Acceptance:

An administrator configures the whole instance from the tabbed Settings area without a code change,
and an end user completes daily CRM work with minimal hunting, typing and context switching.

---

## Phase 21 — In-App Documentation and Product Help

Progress: ✅ implemented 2026-10-21 (21.0–21.10). Scope, architecture and work order in
`PLAN_Phase_21_Documentation.md`; operations in `docs/admin/documentation.md`; deferrals and deviations
in `docs/compatibility/documentation.md`. `/docs` ships 38 `en` pages across four sections with 17
translated into `vi`, reachable from the sidebar, the avatar menu, the command palette and the screen the
reader is standing on.

Today every capability is documented for engineers (`docs/`); the people who operate the product have
no in-app reference. Phase 21 adds a `/docs` surface written for the two audiences that run the
system — the **administrator** and the **CRM user** — searchable, bilingual, permission-aware and
deep-linked from the screens it describes.

Implement, as specified in `PLAN_Phase_21_Documentation.md`:

- `content/docs/<locale>/<section>/<slug>.md` — versioned user-facing content with a strict
  front-matter contract and a documented Markdown subset, kept out of the engineering `docs/` tree.
- `packages/docs` — a pure engine (front-matter, parser to a typed block tree, index builder, search
  with diacritic-insensitive matching, link/asset/parity lint). No HTML is produced or rendered, so no
  XSS surface exists.
- `apps/api/src/docs` — `GET /Docs/tree|page/:section/:slug|search`, ACL-filtered per caller,
  `ETag`/`304`, in-memory per-locale index, no table and no migration.
- A `docs` settings document (`enabled`, `showInSidebar`, `showHelpMenu`, `externalUrl`,
  `landingPage`, `supportEmail`; read `user`, write `admin`) and one `docs` page seed in
  `NAVIGATION_PAGES`, gated through `NAVIGATION_FEATURE_GATE`.
- The SPA reader (`/docs`, `/docs/search`, `/docs/:section`, `/docs/:section/:slug`) with a
  three-column reading layout, TOC, anchors, prev/next, print stylesheet and search snippets.
- Contextual help: `HelpTip` gains `docKey`, admin tab descriptors gain `docKey`, and the unused
  Phase 20 `PermissionDenied` state is consumed.
- 38 pages in `en` across `getting-started`, `user`, `admin` and `reference`; `vi` as a first-class
  translation with a visible per-page fallback notice.

Acceptance:

A new administrator configures the instance and a new CRM user completes daily work using only the
in-app documentation, reached from the screen they are on; search works with or without Vietnamese
diacritics; a CRM user never sees an administration page; and shipping a feature without its page
fails the content lint rather than a customer.

---

# 58. API Endpoint Inventory Plan

Create a machine-readable endpoint registry:

```text
api-spec/
  authentication.yaml
  metadata.yaml
  i18n.yaml
  users.yaml
  roles.yaml
  teams.yaml
  entities.yaml
  relationships.yaml
  attachments.yaml
  activities.yaml
  stream.yaml
  search.yaml
  reports.yaml
  workflows.yaml
  jobs.yaml
  admin.yaml
```

Each endpoint definition must document:

- Method.
- Path.
- Authentication.
- Required permissions.
- Request schema.
- Response schema.
- Errors.
- Pagination.
- Sorting.
- Filtering.
- Side effects.
- Idempotency.

---

# 59. Reference Behavior Catalog

Create one folder per important EspoCRM capability.

Example:

```text
reference-behavior/
├── authentication/
├── users/
├── roles/
├── teams/
├── accounts/
├── contacts/
├── leads/
├── opportunities/
├── activities/
├── stream/
├── attachments/
├── metadata/
├── entity-manager/
├── workflows/
├── reports/
└── portals/
```

Each folder contains:

```text
behavior.md
request-examples.json
response-examples.json
screenshots/       # only where licensing permits
edge-cases.md
```

Do not store upstream copyrighted source code in this folder.

---

# 60. Compatibility Matrix

Example:

| Capability           | Espo baseline     | New implementation | Priority |
| -------------------- | ----------------- | ------------------ | -------- |
| CRUD API             | v9.3.x            | Planned            | P0       |
| Metadata             | v9.3.x            | Planned            | P0       |
| Internationalization | v9.3.x            | Planned            | P0       |
| ACL                  | v9.3.x            | Planned            | P0       |
| Roles                | v9.3.x            | Planned            | P0       |
| Teams                | v9.3.x            | Planned            | P0       |
| Attachments          | v9.3.x            | Planned            | P0       |
| Stream               | v9.3.x            | Planned            | P1       |
| Calendar             | v9.3.x            | Planned            | P1       |
| Email                | v9.3.x            | Planned            | P1       |
| Workflows            | selected baseline | Planned            | P2       |
| BPM                  | selected baseline | Planned            | P2       |
| Reports              | selected baseline | Planned            | P2       |
| Portals              | selected baseline | Planned            | P2       |
| Extension SDK        | new design        | Planned            | P1       |

This matrix must be kept current throughout the project.

---

# 61. Definition of Done

A feature is not complete until it has:

1. Backend implementation.
2. Metadata definition if applicable.
3. API contract.
4. ACL rules.
5. Database migrations.
6. Validation.
7. Error handling.
8. Audit behavior where applicable.
9. Frontend implementation.
10. Translation keys.
11. Unit tests.
12. Integration tests.
13. End-to-end test for the primary user journey.
14. Documentation.
15. Performance test where the feature is high volume.
16. Security test where the feature crosses trust boundaries.

---

# 62. CI/CD Plan

CI pipeline:

```text
install
  ↓
lint
  ↓
typecheck
  ↓
unit tests
  ↓
integration tests
  ↓
build
  ↓
container build
  ↓
security scan
  ↓
E2E tests
```

CD pipeline:

```text
build image
  ↓
scan
  ↓
push registry
  ↓
staging deploy
  ↓
database migration
  ↓
smoke tests
  ↓
production approval
  ↓
production deploy
  ↓
post-deploy health checks
```

Never run destructive migrations automatically without an approved migration policy and backup strategy.

---

# 63. Environment Strategy

Provide:

```text
.env.example
.env.development
.env.test
.env.staging
.env.production
```

Configuration categories:

```text
APP_*
DATABASE_*
REDIS_*
AUTH_*
MAIL_*
STORAGE_*
SEARCH_*
OBSERVABILITY_*
SECURITY_*
```

Secrets should come from a secret manager in production.

---

# 64. Backup and Recovery

Required:

- PostgreSQL daily full backup.
- Point-in-time recovery where possible.
- Object-storage replication or backup.
- Redis persistence only where job durability requires it.
- Backup encryption.
- Restore testing.

A backup that has never been restored is not considered a validated backup.

Quarterly recovery drills should be automated and documented.

---

# 65. Deployment Topology

## Small self-hosted installation

```text
Nginx
  ↓
NestJS API + Web
  ↓
PostgreSQL
Redis
Local/S3 storage
```

## Production installation

```text
Load Balancer
   ↓
API replicas
   ↓
Worker replicas
   ↓
PostgreSQL HA
Redis HA
Object Storage
Observability Stack
```

Keep API and worker deployments independently scalable.

---

# 66. Migration From an Existing EspoCRM Installation

A data migration layer should be planned after the new entity model stabilizes.

## 66.1 Migration phases

```text
source inspection
  ↓
source schema mapping
  ↓
metadata mapping
  ↓
entity mapping
  ↓
relation mapping
  ↓
attachment migration
  ↓
user/role mapping
  ↓
transform
  ↓
load
  ↓
reconciliation
```

## 66.2 Never migrate blindly

Create explicit mapping files:

```yaml
Account:
  target: Account
  fields:
    name: name
    website: website
```

Relation mappings:

```yaml
Account:
  contacts:
    source: account_contact
    target: Account.contacts
```

## 66.3 Reconciliation

After migration compare:

- Record counts.
- Relation counts.
- Null rates.
- Required fields.
- Attachment counts.
- User counts.
- Team memberships.
- Permission assignments.
- Sample hashes for selected records.

---

# 67. Data Migration Tooling

Build a standalone CLI:

```bash
crm-migrate inspect-source
crm-migrate export-source
crm-migrate transform
crm-migrate import
crm-migrate validate
crm-migrate reconcile
```

The CLI should produce JSON/CSV reports that can be reviewed independently of the application.

---

# 68. Compatibility Adapter Layer

When exact API compatibility is required, build an adapter instead of modifying the core model.

```text
External Espo-compatible API
          ↓
Compatibility Controller
          ↓
Compatibility Mapper
          ↓
Application Service
          ↓
New Domain Model
```

This prevents legacy assumptions from contaminating the core architecture.

---

# 69. Developer Experience

Create internal generators:

```bash
crm generate:entity Account
crm generate:field Account customerType enum
crm generate:relation Account contacts manyToMany Contact
crm generate:module customer-success
crm generate:extension my-extension
crm generate:job CleanupJob
crm generate:workflow ExampleWorkflow
```

The generated module must include tests and metadata templates.

---

# 70. Documentation Plan

Maintain:

```text
docs/
├── architecture/
├── api/
├── metadata/
├── acl/
├── entity-engine/
├── extension-sdk/
├── frontend/
├── workflows/
├── bpm/
├── reports/
├── deployment/
├── security/
├── operations/
└── migration/
```

Every public extension point needs a documented example.

---

# 71. Risk Register

## Risk: Dynamic metadata becomes too complex

Mitigation:

- Define the metadata schema before implementing most UI features.
- Keep metadata compilation deterministic.
- Add snapshot tests for metadata.

## Risk: ACL bypasses

Mitigation:

- Centralize ACL in the Entity Engine.
- Require application services to use secured repositories.
- Write negative permission tests.

## Risk: Query performance collapses with JSONB

Mitigation:

- Add explicit field/index metadata.
- Use query telemetry.
- Introduce normalized columns or generated indexes for hot fields.

## Risk: Formula sandbox escape

Mitigation:

- Use AST execution.
- No arbitrary JS execution.
- Security fuzzing.

## Risk: Extension system becomes unsafe

Mitigation:

- Trusted extension packages only for self-hosted installs.
- Signature verification.
- Explicit permissions.
- Version compatibility checks.

## Risk: Trying to clone everything before shipping

Mitigation:

- Use P0/P1/P2 priorities.
- Ship the kernel first.
- Add domain modules incrementally.

## Risk: Upstream behavior changes

Mitigation:

- Pin a compatibility baseline.
- Maintain a reference environment.
- Re-run behavior tests periodically.

## Risk: Legal ambiguity

Mitigation:

- Maintain source/reference provenance records.
- Prefer clean-room implementation.
- Do formal licensing review before distribution.

---

# 72. Recommended Priority Matrix

## P0 — Platform kernel

- Authentication.
- Users.
- Teams.
- Roles.
- ACL.
- Metadata.
- Entity Engine.
- Query Engine.
- REST API.
- Internationalization.
- Generic CRUD UI.
- Attachments.
- Administration.
- Audit.

## P1 — Usable CRM

- Accounts.
- Contacts.
- Leads.
- Opportunities.
- Activities.
- Calendar.
- Email.
- Stream.
- Search.
- Import/export.
- Dashboard.
- Extension SDK.

## P2 — Automation/business intelligence

- Formula.
- Dynamic logic.
- Jobs.
- Scheduled jobs.
- Workflows.
- Reports.
- BPM.
- Portals.

## P3 — Advanced product ecosystem

- Marketing automation.
- Customer success.
- Service desk.
- AI agents.
- Advanced integrations.
- Multi-region deployment.
- Full database portability.

---

# 73. Initial Milestone Definition

The first major milestone should be called **CRM Kernel Alpha**.

It is complete when all of the following are true:

```text
[ ] NestJS API running
[ ] PostgreSQL running
[ ] Redis running
[ ] User authentication working
[ ] Roles working
[ ] Teams working
[ ] ACL working
[ ] Metadata service working
[ ] Generic entity CRUD working
[ ] Dynamic fields working
[ ] Dynamic relations working
[ ] Generic React CRUD UI working
[ ] Attachments working
[ ] Audit working
[ ] OpenAPI working
[ ] API integration tests working
[ ] Playwright login/CRUD tests working
[ ] Docker deployment working
[ ] Backup and restore documented
```

Do not start advanced Workflow/BPM development until this milestone is stable.

---

# 74. Recommended Second Milestone — CRM Core Beta

```text
[ ] Accounts
[ ] Contacts
[ ] Leads
[ ] Opportunities
[ ] Tasks
[ ] Calls
[ ] Meetings
[ ] Calendar
[ ] Stream
[ ] Email
[ ] Search
[ ] Import
[ ] Export
[ ] Dashboards
[ ] Notifications
```

The primary success criterion is that a sales team can use the system daily without needing direct database access or developer intervention.

---

# 75. Recommended Third Milestone — Extensible Platform

```text
[ ] Metadata SDK
[ ] Extension manifest
[ ] Extension installer
[ ] Module ordering
[ ] Extension migrations
[ ] Custom backend services
[ ] Custom API routes
[ ] Custom frontend views
[ ] Custom field types
[ ] Custom jobs
[ ] Custom formulas
[ ] Custom ACL providers
```

At this point the NestJS CRM should be capable of hosting independently developed modules such as `Sales`, `Projects`, `Workflows`, `Bpm`, `Reports`, `Intelligence`, `MarketingAutomation`, `CustomerSuccess`, and `ServiceDesk` without modifying the kernel.

---

# 76. Recommended Monorepo Module Boundaries

A suggested dependency direction is:

```text
apps/api
  ↓
platform modules
  ↓
core packages
  ↓
infrastructure
```

More concretely:

```text
UI
 ↓
API Controllers
 ↓
Application Services
 ↓
Domain Services
 ↓
Entity Engine / ACL / Query Engine
 ↓
Repository Interfaces
 ↓
Infrastructure
 ↓
PostgreSQL / Redis / Object Storage
```

Domain modules should not import database driver code directly.

---

# 77. Rules for Future Modules

Every future module must answer these questions:

1. What entity types does it add?
2. What metadata does it add?
3. What database migrations does it require?
4. What permissions does it define?
5. What APIs does it expose?
6. What jobs does it create?
7. What events does it listen to?
8. What UI pages/views does it add?
9. What reports/dashlets does it add?
10. What translations does it add?
11. What external dependencies does it need?
12. What upgrade/rollback strategy exists?
13. What test coverage is required?

No module should bypass the kernel abstractions merely because direct database access is convenient.

---

# 78. Example Module Contract

```ts
export interface CrmModule {
  id: string;
  version: string;
  order?: number;

  register(container: ModuleContainer): void;

  getMetadata(): MetadataContribution;

  getMigrations(): MigrationDefinition[];

  getPermissions(): PermissionDefinition[];

  getRoutes(): RouteDefinition[];

  getJobs(): JobDefinition[];
}
```

The exact interface can evolve, but the principle should remain: modules declare their contribution instead of reaching inside the framework internals.

---

# 79. Example Metadata Contract

```ts
const accountDefinition: EntityDefinition = {
  name: 'Account',
  label: 'Account',
  isEntity: true,
  fields: {
    name: {
      type: 'varchar',
      required: true,
      maxLength: 255,
    },
    website: {
      type: 'url',
    },
    description: {
      type: 'text',
    },
  },
  relations: {
    contacts: {
      type: 'oneToMany',
      target: 'Contact',
      mappedBy: 'account',
    },
  },
};
```

The frontend should receive enough metadata to render the correct input controls, labels and relationship UI.

---

# 80. Example API Request Lifecycle for Create Record

```text
POST /api/v1/Contact
        ↓
Authenticate
        ↓
Resolve current User
        ↓
Resolve Contact metadata
        ↓
Validate payload
        ↓
Check CREATE ACL
        ↓
Check field write ACL
        ↓
Validate relation IDs
        ↓
Execute before hooks
        ↓
Begin transaction
        ↓
Insert record
        ↓
Insert relationships
        ↓
Write audit rows
        ↓
Write outbox events
        ↓
Commit
        ↓
Run asynchronous subscribers
        ↓
Serialize response
```

This lifecycle must be implemented once and reused for all generic entities.

---

# 81. Example API Request Lifecycle for List Records

```text
GET /api/v1/Contact?where=...
        ↓
Authenticate
        ↓
Resolve current User
        ↓
Resolve metadata
        ↓
Parse query
        ↓
Inject tenant condition
        ↓
Inject ACL condition
        ↓
Validate fields/operators
        ↓
Build SQL
        ↓
Execute query
        ↓
Apply field-level output ACL
        ↓
Serialize
        ↓
Return paginated response
```

The ACL injection must happen below controllers so custom endpoints cannot accidentally bypass it.

---

# 82. Migration From PHP Concepts to NestJS Concepts

| EspoCRM concept       | NestJS implementation                        |
| --------------------- | -------------------------------------------- |
| Application bootstrap | NestFactory bootstrap                        |
| Dependency Injection  | NestJS DI container                          |
| Service classes       | Injectable application/domain services       |
| Controllers           | NestJS controllers                           |
| API actions           | NestJS route handlers / application services |
| ORM EntityManager     | Custom EntityManager abstraction             |
| Repository            | Repository/query provider                    |
| Metadata              | TypeScript/JSON Schema metadata registry     |
| Hooks                 | Domain hooks + events                        |
| Scheduled Jobs        | BullMQ repeatable jobs + cron metadata       |
| Entry Points          | Dedicated controllers/public routes          |
| Module                | NestJS module + platform extension manifest  |
| ACL                   | Guard + centralized authorization service    |
| File Storage Manager  | FileStorage abstraction                      |
| Formula               | Sandboxed AST expression engine              |
| Frontend metadata     | React UI schema/metadata registry            |
| Extension package     | npm/package/archive module SDK               |

This mapping is intentionally conceptual rather than source-compatible.

---

# 83. What Not to Do

Do not:

- Generate one NestJS controller per entity by copying PHP code patterns.
- Use Prisma models as the definition of every dynamic CRM field.
- Put ACL checks only in React.
- Put business logic in controllers.
- Allow arbitrary SQL in reports.
- Allow arbitrary JavaScript in formulas.
- Use synchronous APIs for large imports/exports.
- Call SMTP/API providers inside DB transactions.
- Store API secrets in plaintext.
- Build every feature as a separate microservice.
- Make the database schema the only source of truth for custom entity metadata.
- Make the frontend know about every entity at compile time.

---

# 84. Suggested 12-Month Roadmap

The exact duration depends on team size, but a practical sequencing model is:

### Months 1–2

- Discovery.
- Kernel.
- Auth.
- Users.
- Roles.
- Teams.
- ACL.
- Metadata.
- Entity Engine.

### Months 3–4

- Generic frontend.
- Entity Manager.
- Attachments.
- Stream.
- Activities.
- Calendar.
- Audit.

### Months 5–6

- Accounts.
- Contacts.
- Leads.
- Opportunities.
- Email.
- Search.
- Import/export.
- Dashboards.

### Months 7–8

- Hooks.
- Formula.
- Jobs.
- Scheduled jobs.
- Extension SDK.
- Developer tooling.

### Months 9–10

- Reports.
- Workflow.
- BPM.
- Portal.

### Months 11–12

- Advanced domains.
- Performance hardening.
- Security hardening.
- Migration tooling.
- Compatibility certification.
- Production release.

This is sequencing guidance, not a promise of delivery time.

---

# 85. Final Architecture Target

The final architecture should resemble this:

```text
                           ┌───────────────────────────┐
                           │       React SPA            │
                           │ Metadata-driven UI         │
                           └────────────┬──────────────┘
                                        │ HTTPS
                                        ▼
                           ┌───────────────────────────┐
                           │      NestJS API            │
                           │ Controllers / Guards       │
                           └────────────┬──────────────┘
                                        ▼
                       ┌──────────────────────────────────┐
                       │      Application Services         │
                       └────────────────┬─────────────────┘
                                        ▼
          ┌──────────────────────────────────────────────────────────┐
          │                       CRM Kernel                          │
          │                                                          │
          │ Metadata │ Entity Engine │ Query │ ACL │ Relations       │
          │ Hooks │ Formula │ Files │ Audit │ Notifications          │
          │ Jobs │ Search │ Email │ Layouts │ Extension SDK         │
          └───────────────┬─────────────────────┬────────────────────┘
                          │                     │
                          ▼                     ▼
                ┌────────────────┐    ┌────────────────┐
                │   PostgreSQL   │    │     Redis      │
                │  records/meta  │    │ queues/cache   │
                └────────────────┘    └────────────────┘
                          │
                          ▼
                ┌───────────────────────┐
                │ Object Storage / S3   │
                │ Attachments           │
                └───────────────────────┘
```

---

# 86. Final Success Criteria

The reimplementation should be considered successful when all of the following are true:

### Platform

- It runs entirely on Node.js/NestJS without a PHP runtime.
- The API is documented and versioned.
- Metadata drives entity behavior and UI.
- Custom entities/fields/relations can be added through metadata/admin tools.

### Security

- ACL enforcement is centralized and tested.
- Field-level security works in both API reads and writes.
- Portal access is isolated.
- Secrets are protected.
- Security regression tests run in CI.

### CRM

- Users can manage contacts, accounts, leads and opportunities.
- Activities, calendar, stream and attachments work.
- Search/import/export/dashboard features work.
- Email integration works through an abstraction.

### Automation

- Hooks/events work.
- Jobs work.
- Scheduled jobs work.
- Formula/dynamic logic work safely.
- Workflow/BPM can orchestrate business processes.

### Extensibility

- New modules can be installed without modifying core source files.
- Modules can contribute metadata, routes, services, jobs, migrations and frontend code.
- Module dependencies and ordering are deterministic.

### Operations

- Docker deployment is repeatable.
- Backups can be restored.
- Logs/metrics/traces are available.
- Database migrations are controlled.
- Large datasets are supported.

### Compatibility

- The compatibility matrix is documented.
- Critical scenarios have automated behavioral tests.
- Major API contracts are stable.
- Any intentional deviation from EspoCRM behavior is documented.

---

# 87. Immediate Next Implementation Task List

The recommended next engineering tasks, in exact order, are:

```text
01. Create monorepo
02. Create NestJS API application
03. Create worker application
04. Create React web application
05. Add PostgreSQL/Redis Docker stack
06. Add ConfigService
07. Add RequestContext
08. Add database abstraction
09. Implement users/authentication
10. Implement roles/teams/ACL
11. Implement MetadataRegistry
12. Implement EntityManager
13. Implement generic QueryBuilder
14. Implement generic CRUD API
15. Implement generic relation API
16. Implement Metadata API
17. Implement generic React list/detail/edit/create pages
18. Implement Entity Manager admin UI
19. Implement attachments
20. Implement audit
21. Implement stream
22. Implement activities/calendar
23. Add Accounts/Contacts/Leads/Opportunities
24. Add email subsystem
25. Add global search
26. Add import/export
27. Add dashboards
28. Add hooks/events/outbox
29. Add jobs/scheduled jobs
30. Add formula engine
31. Add extension SDK
32. Add workflow engine
33. Add reports
34. Add BPM
35. Add portal
36. Add advanced domain modules
37. Add migration tooling
38. Complete compatibility certification
```

---

# 88. Source References

Primary references used to shape this plan:

1. EspoCRM GitHub repository — architecture, requirements and licensing: https://github.com/espocrm/espocrm
2. EspoCRM License: https://github.com/espocrm/espocrm/blob/master/LICENSE.txt
3. Developer Documentation: https://docs.espocrm.com/development/
4. API Overview: https://docs.espocrm.com/development/api/
5. Metadata: https://docs.espocrm.com/development/metadata/
6. ORM: https://docs.espocrm.com/development/orm/
7. Dependency Injection: https://docs.espocrm.com/development/di/
8. Modules: https://docs.espocrm.com/development/modules/
9. Extension Packages: https://docs.espocrm.com/development/extension-packages/
10. Services: https://docs.espocrm.com/development/services/
11. Hooks: https://docs.espocrm.com/development/hooks/
12. ACL: https://docs.espocrm.com/development/acl/
13. Scheduled Jobs: https://docs.espocrm.com/development/scheduled-job/
14. Attachments: https://docs.espocrm.com/development/attachments/
15. Entry Points: https://docs.espocrm.com/development/entry-points/
16. Roles Management: https://docs.espocrm.com/administration/roles-management/
17. Users Management: https://docs.espocrm.com/administration/users-management/
18. Portal: https://docs.espocrm.com/administration/portal/

---

# 89. Closing Architecture Decision

The central design decision is:

> **Build a metadata-driven CRM platform on NestJS, not a PHP-to-TypeScript translation.**

The most important subsystem is the **CRM Kernel** consisting of:

```text
Metadata
+ Entity Engine
+ Query Engine
+ ACL
+ Relation Engine
+ Hooks / Events
+ Formula
+ Jobs
+ Files
+ Audit
+ Extension SDK
```

Everything else—Sales, Projects, Marketing, Service Desk, Customer Success, Reports, Workflows, BPM, AI Agents and integrations—should consume those kernel capabilities through stable interfaces.

This architecture gives the project a realistic path to becoming an independent NestJS CRM platform rather than a permanent compatibility shim around the original PHP design.
