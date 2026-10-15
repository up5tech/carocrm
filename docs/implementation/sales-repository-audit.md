# Sales repository audit (Phase 19-S.0)

Deliverable of **Phase 19-S.0 — Repository Audit and Feature Contract** of
[`PLAN_Phase_19_Sales.md`](../../PLAN_Phase_19_Sales.md) §14. It records what the repository actually
contains, what the Sales module reuses, and which documented behaviours are in scope.

| Field | Value |
|---|---|
| Module | `Sales` — module id `sales`, display name *Sales & Commercial Operations* |
| Domain directory | `apps/api/src/sales` |
| API prefix (domain commands) | `/api/v1/Sales` |
| Reference baseline | EspoCRM 9.3.x core CRM compatibility; Sales Pack 4.4.0 as the listed reference release |
| Audit prepared | 2026-10-15 |
| Phases covered by this audit | 19-S.0 – 19-S.5 |

> **Method note.** This audit was produced by reading the working tree (source, migrations, seeds,
> configuration, tests). The environment used to prepare it exposed **no shell**, so `git status`,
> `git log`, `pnpm typecheck`, `pnpm lint` and `pnpm test` could **not** be executed. Every statement
> below is therefore a statement about file contents, not about a command result. See §9 and §10 for
> the exact commands that still need to be run and what could not be verified.

---

## 1. Verified source locations

### 1.1 Platform primitives the module builds on

| Primitive | Location | What Sales uses it for |
|---|---|---|
| Metadata registry / Entity Engine | `apps/api/src/entity`, `apps/api/src/metadata`, `packages/entity-engine` | Entity definitions, CRUD, validation, relations, serialization, query/filter/sort, pagination |
| Generic record store | `entity_records` table (`database/migrations/001_init.sql`) | Every Sales catalog/pricing/tax record |
| Hook registry | `apps/api/src/hooks/hook.registry.ts` | `beforeValidate` invariants for catalog/pricing/tax records |
| ACL | `apps/api/src/acl`, tables `roles` / `users_roles`, `roles.field_permissions` | Record/field permissions and the `resolvePrice` / `bulkPriceUpdate` authorisation checks |
| Request scope | `apps/api/src/common/request-scope.ts` (`REQUEST_SCOPE_TOKEN`) | Admin-only gating, `updatedBy` on settings |
| Audit + Stream + Outbox | tables `audit_log`, `stream_items`, `outbox_events` | Audited bulk price change; future document events |
| Jobs | tables `jobs`, `scheduled_jobs`, `job_logs` | Reserved for expiry / recurring-billing phases (19-S.7, 19-S.16) |
| Instance settings store | `app_settings` table, `apps/api/src/settings` | The single `sales` settings row |
| Module registration | `apps/api/src/app.module.ts` | `SALES_CONTROLLERS` spread **before** `ENTITY_CONTROLLERS`; `SALES_PROVIDERS` |
| Error envelope | `@carocrm/core/errors/index.js` | `ValidationError`, `DuplicateRecordError`, `AuthorizationDeniedError`, `NotFoundError`, `InvalidQueryError` |
| Clock | `apps/api/src/sales/clock.ts` (`resolveDay`) | One date convention for price/tax effective windows |
| Test harness | `apps/api/test/support/boot-api.ts` | Boots the real app in-process against the configured primary database |

### 1.2 The Sales module itself

```text
apps/api/src/sales/
  index.ts                          barrel: SALES_CONTROLLERS, SALES_PROVIDERS, public re-exports
  sales-module.ts                   module descriptor: id, version, load order, apiPrefix, phases
  sales-module-health.service.ts    health/diagnostics read model
  sales.controller.ts               domain commands (`/api/v1/Sales/action/*`)
  sales-records.ts                  allowlisted structural reads over the module's own entities
  sales-settings.service.ts         the validated, versioned `sales` settings document
  clock.ts                          the single date convention
  catalog/
    product-rules.ts                pure rules: SKU, product, category, price-book, date windows
    sales-guard.service.ts          registers those rules on `beforeValidate`
  pricing/
    price-rules.ts                  pure rule ordering, specificity, action application
    price-resolution.service.ts     deterministic, explainable price resolution
    bulk-price.service.ts           previewed, audited bulk price update
  money/
    decimal.ts                      decimal-safe arithmetic (no JavaScript `number`)
    currency.ts                     currency scale table + exchange-rate snapshot validation
  tax/
    tax-rules.ts                    pure rule matching and rate selection
    totals.ts                       pure subtotal / discount / shipping / tax / total engine
    tax.service.ts                  row reading + tax resolution + totals preview
  document/
    types.ts                        line-item and tax-resolution contracts
    numbering.service.ts            atomic number series allocation
    number-series-defaults.ts       the seeded series list (shared with `database/seed.ts`)
    snapshot.ts                     immutable document snapshot build/read + digest
    lock.ts                         issued-document lock state and protected fields
  dto/sales-shapes.ts               Zod request shapes for the domain commands
```

### 1.3 Entities registered by the module

`database/seed-metadata.ts` registers eleven metadata entities, all served by the generic Entity
Engine (list/detail/create/edit/delete, relations, search, ACL, audit, stream):

`Product`, `ProductCategory`, `PriceBook`, `PriceBookEntry`, `PriceRule`, `Supplier`,
`SupplierProductPrice`, `TaxClass`, `TaxCode`, `TaxRate`, `TaxRule`.

`SalesRecords` (`apps/api/src/sales/sales-records.ts`) is the only structural read path over them,
and it allowlists the entity type and validates attribute names before they reach SQL.

### 1.4 Migrations and seeds owned by the module

| File | Contents |
|---|---|
| `database/migrations/021_phase19_sales.sql` | `sales_number_series`, `sales_document_numbers`, the case-insensitive unique SKU index, and the catalog/pricing/tax expression indexes |
| `database/migrations/022_phase19_sales_module_rename.sql` | Carries the `app_settings` row `uaSales` → `sales` so the rename cannot discard configured policy |
| `database/seed-metadata.ts` | The eleven entity definitions above (idempotent upsert of metadata) |
| `database/seed.ts` | `DEFAULT_NUMBER_SERIES` → `sales_number_series`, once, `ON CONFLICT DO NOTHING` |

---

## 2. Reusable existing entities and services

| Need | Reused | Not reimplemented |
|---|---|---|
| Accounts, Contacts, Opportunities, Users, Teams | CRM core metadata entities | Sales never creates a competing Account/Contact/Opportunity |
| Record CRUD, validation, serialization, pagination, filtering, sorting | Entity Engine | The module adds only cross-record rules |
| Field-level and record-level permissions | `AclApiService` + role definitions | No module-local ACL engine |
| Audit trail, stream, attachments, notes | kernel tables and services | The bulk price update writes its audit row through the kernel |
| Background work | `jobs` / `scheduled_jobs` / `job_logs` | No second scheduler |
| Instance settings | `app_settings` + `POST /api/v1/Settings` | No second settings store; Sales owns exactly one row named `sales` |
| Events to other modules | `outbox_events` | No direct cross-module imports |

How the module calls them:

* validation → `HookRegistry.register({ phase: 'beforeValidate' })` in `SalesCatalogGuardService`;
* authorisation → `AclApiService` for record reads, `RequestScope.isAdmin` for administrative commands;
* structural reads → `SalesRecords` (Kysely, every value bound as a parameter);
* transactions → the Entity Engine's `currentTx()` context so a domain command and its record writes share one transaction.

---

## 3. API naming and routing rules

Observed convention: a **static PascalCase prefix per domain** registered *before* the generic
`/api/v1/:entity` wildcard, e.g. `/api/v1/Settings`, `/api/v1/Report`, `/api/v1/Project`,
`/api/v1/Workflow`. There is no `Ua*` prefix anywhere else in the repository.

| Kind | Route |
|---|---|
| Sales domain commands | `/api/v1/Sales/action/*` |
| Entity CRUD (all eleven entities) | generic `/api/v1/:entity`, e.g. `/api/v1/Product`, `/api/v1/PriceBookEntry` |

Registered domain commands (`apps/api/src/sales/sales.controller.ts`):

| Method | Route | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/Sales/action/health` | administrator | module descriptor, dependency evidence, optional integrations, features, settings warnings, checks |
| `GET` | `/api/v1/Sales/action/settings` | authenticated | validated settings document + computed defaults + warnings |
| `POST` | `/api/v1/Sales/action/settings` | administrator | validated patch; bumps the settings version |
| `GET` | `/api/v1/Sales/action/numbering` | administrator | number series with the next unallocated preview |
| `POST` | `/api/v1/Sales/action/resolvePrice` | record ACL on the product / price book | deterministic price resolution with the reason it won |
| `POST` | `/api/v1/Sales/action/bulkPriceUpdate` | ACL + administrator for `apply` | previewed, bounded, audited bulk price change |
| `POST` | `/api/v1/Sales/action/previewTotals` | authenticated | server-calculated subtotal/discount/shipping/tax/total breakdown |

Request bodies are validated by Zod schemas in `dto/sales-shapes.ts`; failures return the kernel's
error envelope with `422`. `parse()` in the controller rejects unknown shapes rather than coercing.

---

## 4. Migration and schema ownership conventions

* Files live in `database/migrations/`, named `<NNN>_phase<NN>_<slug>.sql` (`001_init.sql` …
  `022_phase19_sales_module_rename.sql`).
* `database/migrate.ts` reads the directory, **sorts by filename**, and applies each unapplied file
  inside a single transaction, recording it in `schema_migrations`. A failed migration rolls back and
  aborts the run.
* Migrations are additive: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE UNIQUE
  INDEX IF NOT EXISTS`. Nothing in the Sales migrations drops, truncates, renames or backfills.
* Schema ownership observed: kernel tables in `001`–`017`; phase tables per phase (`018` projects,
  `021` sales). The Sales module owns `sales_number_series`, `sales_document_numbers`, one unique
  index over `entity_records` for the SKU scope, and the catalog/pricing/tax expression indexes.
* Partial indexes over `entity_records ((attrs ->> 'field'))` filtered by `entity_type` are the
  established pattern for indexing a metadata attribute.

---

## 5. Money, currency and date conventions — and the gaps

| Question | Finding |
|---|---|
| Is there a currency registry? | **No.** `currency` is a metadata field type that stores a canonical decimal **string** and is cast to `numeric` inside query/report expressions. Nothing else exists. |
| Is there an exchange-rate facility? | **No.** No rate table, no rate service. |
| How are money values stored? | Canonical decimal strings in `attrs`, cast to `numeric` by the query engine. No binary floating point. |
| Is there a decimal library? | The platform has none; the module owns `money/decimal.ts` (add, subtract, multiply, divide, percentage, rescale, compare, round with explicit modes, format). |
| Consequence | `money/currency.ts` owns the two facts a money calculation needs: the ISO 4217 minor-unit scale table (`CURRENCY_SCALES`) and validation of a document exchange-rate snapshot. It is stated as an explicit module contract because the platform provides neither. |
| Date handling | `clock.ts` (`resolveDay`) is the single convention: `YYYY-MM-DD` day strings for effective windows, defaulting to today (UTC). No ad-hoc `new Date()` comparisons in pricing/tax. |
| Inconsistency to be aware of | Because the platform has no currency module, a second module needing currency scales would duplicate `CURRENCY_SCALES`. When a platform currency module appears, `money/currency.ts` should become a thin adapter over it. |

---

## 6. Missing prerequisites: blocking vs later tier

| Missing | Blocks Tier 1 (19-S.0 – 19-S.5)? | Notes |
|---|---|---|
| Currency registry / exchange-rate table | No | Sales states the scale table itself and validates rate snapshots; a platform module would later replace it |
| Products / Quotes / Orders / Invoices entities | No | They did not exist; the catalog entities are introduced by 19-S.3 and documents follow in 19-S.6+ |
| Document PDF / print template system | No for S.0–S.5 | The kernel has an email service and i18n catalogs but no document template/renderer; PDF output is deferred to 19-S.17 |
| `StripeIntegration` / payment provider module | No | Optional; detected by the `PaymentProviderEvent` metadata marker, absence is reported and survivable |
| Accounting module | No | Optional; detected by the `AccountingExport` marker |
| Customer Success module | No | Optional; detected by the `CustomerSuccessProfile` marker |
| Projects module | No | Present in this repository (`apps/api/src/projects`, `/api/v1/Project`); detected by the `Project` entity |
| Product variants | No | Feature-flagged off by default (`features.productVariants`), delivered in 19-S.15 |
| Purchases / inventory / subscriptions | No | Feature-flagged off by default; delivered in 19-S.13 / 19-S.14 / 19-S.16 |
| Sales SPA screens | No | Records render through the generic metadata-driven UI; dedicated screens are 19-S.17 work |
| Workflow / BPM events for Sales | No | Generic extension points exist; wiring is 19-S.19 work |

---

## 7. Dependency map

```text
                    ┌───────────────────────────────────────────┐
                    │ kernel: Entity Engine, metadata, ACL,      │
                    │ hooks, audit/stream, outbox, jobs,         │
                    │ settings, attachments, email, i18n         │
                    └───────────────────┬───────────────────────┘
                                        │ required (verified at runtime)
                                        ▼
   optional consumers ◄────────────  Sales  ────────────► optional providers
   • Customer Success                 (sales)              • Stripe integration
     reads commercial summaries      /api/v1/Sales           payment requests / provider events
   • Reports / dashboards              entity CRUD            (marker: PaymentProviderEvent)
   • Workflow / BPM                  /api/v1/:entity        • Accounting integration
   • Projects (delivery links)                              ledger export of invoices/payments
     (marker: Project)                                      (marker: AccountingExport)
```

Rules enforced by the design:

* **No mandatory optional dependency.** Optional modules are detected through the metadata registry
  (a marker entity), never by importing them, so their absence can never break startup
  (`sales-module.ts` → `OPTIONAL_INTEGRATIONS`, verified by `SalesModuleHealthService`).
* **No private-table coupling.** Other modules consume Sales through published contracts, not through
  `entity_records` queries against Sales entity types.
* **One direction of data flow for each pair.** Customer Success and Accounting *consume* Sales;
  Stripe *provides* payment facts to Sales. Sales does not call a gateway, hold card data or post to a
  ledger.

---

## 8. Feature contract for 19-S.0 – 19-S.5

### 8.1 Implemented

| Phase | Delivered behaviour | Evidence |
|---|---|---|
| 19-S.0 | This audit and the Tier-1 contract below | this document |
| 19-S.1 | Module identity `sales`, descriptor, load order 320, `apiPrefix /api/v1/Sales`, health/diagnostics, absence-tolerant optional integrations | `sales-module.ts`, `sales-module-health.service.ts`, `sales.controller.ts`, `apps/api/test/sales-module.test.ts` |
| 19-S.2 | Validated, versioned `sales` settings document; decimal-safe arithmetic; currency scale + rate snapshot contract; document number series with atomic allocation; snapshot/lock primitives; typed line-item + totals contracts | `sales-settings.service.ts`, `money/*`, `document/*`, `apps/api/test/sales-money.test.ts` |
| 19-S.3 | Product + ProductCategory metadata, SKU normalisation and installation-wide case-insensitive uniqueness, category cycle/depth prevention, active/sellable/purchasable gating enforced on `beforeValidate`, cost-price field permission | `catalog/*`, `database/seed-metadata.ts`, `database/migrations/021_phase19_sales.sql`, `apps/api/test/sales-catalog.test.ts` |
| 19-S.4 | Price books, entries with effective windows and quantity breaks, declarative price rules with deterministic ordering and conflict detection, explainable resolution, supplier prices kept separate, previewed/audited bulk price update | `pricing/*`, `apps/api/test/sales-pricing.test.ts` |
| 19-S.5 | Tax class/code/rate/rule metadata, declarative rule matching with effective dates and priority, tax-inclusive/exclusive handling, line/document rounding stages, currency snapshot, subtotal → discount → shipping → tax → total → amount due | `tax/*`, `money/currency.ts`, `apps/api/test/sales-tax.test.ts` |

### 8.2 Explicit deviations from the documented reference baseline

| Reference behaviour | This implementation | Reason |
|---|---|---|
| Sales Pack ships as an installable EspoCRM extension package | Sales is a kernel domain directory registered in `app.module.ts` | The repository's extension SDK exposes no entity CRUD facade; an extension package owning records could only write them with raw SQL, bypassing audit/stream/validation |
| Reference release numbering (Sales Pack 4.x) | Module version `1.0.0`, `implementedPhases` published by the health endpoint | The project tracks phases, not upstream release numbers |
| Upstream translation catalogs and frontend assets | Not copied | Clean-room rule (PLAN §6, AGENTS.md §6) |
| Database-schema compatibility with EspoCRM | Not attempted | Explicitly out of scope (plan §2.2) |

### 8.3 Explicit non-goals for these phases

Replacing CRM core entities; a general ledger or statutory accounting; jurisdiction-specific tax
certification; card processing, card storage or gateway webhooks inside Sales; arbitrary SQL/JS price
or tax rules; a second scheduler; a second settings store; any document issuance, stock movement or
external communication in this tier.

### 8.4 Deliberate behaviour decisions worth remembering

* A **missing price is never zero**: the default policy is `error`, and `allowExplicit` returns an
  explicitly *unresolved* result.
* A **missing tax is never zero** unless the operator configures `tax.missingTaxPolicy = 'zero'`.
* **Supplier prices can never become a sales price**: they live in a separate entity that price
  resolution does not read.
* **Equal-priority, equal-specificity price rules are a conflict**, not a coin toss.
* **Numbering allocates at issuance** by default; a retried allocation for the same document returns
  its existing number instead of consuming a second one.
* **Settings changes bump a version**, so a stored document snapshot can name the policy it was
  produced under.
* **No `ua-` / `Ua` module-identity prefix anywhere.** The optional-integration ids in
  `OPTIONAL_INTEGRATIONS` are `stripe-integration`, `accounting-integration`, `customer-success` and
  `projects`, and the plans name those modules the same way (`StripeIntegration`,
  `AccountingIntegration`, `CustomerSuccess`, `Projects`). Module identity is a plain name, matching
  `sales` and `projects`.

---

## 9. Test commands inspected

| Command | What it does | Database effect |
|---|---|---|
| `pnpm test` / `pnpm vitest run` | `vitest run` with `vitest.config.ts` | none by itself |
| `pnpm typecheck` | `tsc --noEmit` for the API and the web SPA | none |
| `pnpm lint` | `eslint . --max-warnings=0` | none |
| `pnpm db:migrate` | applies pending migrations from `database/migrations` | **writes** the configured primary database; each file in one transaction, tracked in `schema_migrations` |
| `pnpm db:seed` | seeds metadata, roles, number series | **writes**; inserts with `ON CONFLICT DO NOTHING`, no table clearing |
| `pnpm test:e2e` | `scripts/e2e-smoke.sh` (Playwright) | depends on a running app; not inspected in detail |

`vitest.config.ts` findings:

* `include: ['apps/api/test/**/*.test.ts', 'packages/*/src/**/*.test.ts']`
* `globalSetup: []` — empty; **no setup file, no teardown hook**
* no `setupFiles`
* `pool: 'forks'`, `poolOptions.forks.singleFork: true` — suites run serially in one forked process
* `testTimeout` / `hookTimeout`: 120 s

**Conclusion:** nothing in the test configuration creates, resets, drops, truncates or clones a
database. Tests target the configured primary database, create their records through the real HTTP
API with `AGENT_TEST_<runId>` markers, and remove exactly those ids in `cleanup()`
(`apps/api/test/support/sales-fixtures.ts`). Number-series rows are created under a dedicated
`agentTest…` code namespace and deleted by that exact code together with their ledger rows.

---

## 10. Verification record and open items

### 10.1 What was verified

* Every source location, entity name, route, migration name and configuration value in this document
  was read from the working tree.
* The repository-wide rename `UaSales` / `ua-sales` / `uaSales` → `Sales` / `sales` was applied and
  re-checked by an exhaustive search over the repository. The same sweep removed the `ua-` / `Ua`
  prefix from every other module identity it touched: the `OPTIONAL_INTEGRATIONS` ids, the six
  `ua-`-prefixed file names under `apps/api/test`, and the module names listed in `PLAN.md`
  (`Projects`, `Workflows`, `Bpm`, `Reports`, …).

### 10.2 What could NOT be verified

The environment used for this audit had **no shell**, so none of the following was executed:

* `git status` / `git log` — the working-tree baseline before this change set is unknown.
* `pnpm typecheck`, `pnpm lint`, `pnpm build` — no static verification of the rename.
* `pnpm test` / `pnpm vitest run` — the six Sales suites were **not** executed.
* `pnpm db:migrate` — migration `022` was **not** applied.
* The six `ua-*`-prefixed file names could not be **renamed or deleted** from this session: it exposes
  no shell and no file-move/delete capability, so only file *contents* could be changed. The rename was
  carried out afterwards from a shell — see §10.3.

### 10.3 Done after this document was written

The six `ua-*`-prefixed files under `apps/api/test` were renamed to `sales-*`, and the
`support/ua-sales-fixtures.ts` shim deleted, with plain `mv` / `rm`. Not `git mv` / `git rm`: the whole
Sales module is untracked in git, so git refuses those with `fatal: not under version control`. The
same pass removed the `ua-` prefix from the `OPTIONAL_INTEGRATIONS` ids and from the module names in
`PLAN.md` / this plan.

### 10.4 Open items

1. Run `pnpm typecheck && pnpm lint` and then
   `pnpm vitest run apps/api/test/sales-module.test.ts apps/api/test/sales-catalog.test.ts
   apps/api/test/sales-pricing.test.ts apps/api/test/sales-tax.test.ts
   apps/api/test/sales-money.test.ts` against the configured primary database.
2. Apply `database/migrations/022_phase19_sales_module_rename.sql` (`pnpm db:migrate`) so an existing
   installation's Sales settings row follows the rename.
3. `app_settings` may hold an orphaned `uaSales` row on an installation where a `sales` row already
   existed when migration `022` ran. It is inert; deleting it is an operator decision.
