# Phase 19 — Sales & Commercial Operations Module

> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Priority:** Implement before `CustomerSuccess` and before integrations that require commercial documents, especially `StripeIntegration`.  
> **Module ID:** `sales`  
> **Display name:** Sales & Commercial Operations  
> **Primary stack:** NestJS, TypeScript, PostgreSQL, Kysely, React, and the existing CRM module/metadata systems.  
> **Planning baseline:** EspoCRM 9.3.x for the core CRM compatibility baseline, plus the documented Sales Pack feature set with Sales Pack 4.4.0 as the current listed reference release at the time this plan was prepared.  
> **Reference reviewed:** October 15, 2026.

---

## 0. Instructions for the Coding Agent

Read these files before implementation:

1. `AGENTS.MD`
2. `PLAN.md`
3. `PLAN_Phase_19_Sales.md`
4. `PLAN_Phase_19_Customer_Success.md` for the intended downstream integration contract
5. Any existing plans for Stripe, accounting, projects, reports, workflows, BPM, and other modules that already exist in the repository

This plan describes the target behavior, not proof that every prerequisite already exists. **Start with Phase 19-S.0 only.** Inspect the real repository, database migration history, module manifests, test scripts, and existing CRM entities before implementing later phases. Do not infer implementation from a plan alone.

### Non-negotiable implementation rules

- Implement a clean-room TypeScript/NestJS module. Use official EspoCRM documentation to define observable behavior; do not copy or mechanically translate EspoCRM source code, frontend assets, translations, branding, or icons.
- Reuse existing CRM Core entities and services. Do not create a second implementation of Accounts, Contacts, Leads, Opportunities, Users, Teams, ACL, Activities, Attachments, Stream, Metadata, Entity Engine, Jobs, Reports, Workflows, or BPM.
- Follow the repository's established metadata, API, response envelope, transaction, validation, logging, and frontend conventions. The examples in this plan are conceptual where the real repository contract differs.
- Use PostgreSQL as the first-class target and the established SQL-first persistence layer, expected to be Kysely unless repository audit proves otherwise.
- **Do not create a test database, shadow database, temporary database, test schema, per-agent database, or per-run database.** Follow the exact database rules in `AGENTS.MD`; use the existing configured primary database for targeted, safe integration checks when needed.
- Do not reset, truncate, drop, broadly delete, or replace existing data. Review every migration before applying it. Test writes must use explicit `AGENT_TEST_...` identifying values and cleanup may only remove records created by the current run and identified by exact IDs.
- Never make tests issue real invoices to customers, send actual payment requests, charge cards, send live emails, trigger production webhooks, move real stock, or create external financial side effects. Use provider adapters in fake/stub mode for unit and API tests.
- Do not store money in JavaScript `number` values for arithmetic. Use a decimal-safe arithmetic library and canonical decimal strings at API boundaries.
- Do not treat an issued commercial document as an ordinary editable CRM record. Issuance, locking, correction, credits, and cancellation must be explicit, transactional, and auditable.
- Do not implement a full general ledger/accounting engine inside `Sales`. Use stable integration contracts for `AccountingIntegration` or another accounting module.
- Do not report a phase as complete until its acceptance criteria and verification evidence have been recorded.

---

## 1. Purpose and Product Outcome

`Sales` is a modular commercial-operations extension for the NestJS CRM. It implements the commercial capabilities associated with EspoCRM Sales Pack while integrating with the CRM Core selling process already provided by the platform.

The module must support a traceable lifecycle from product and pricing setup through a customer quote, confirmed sales order, fulfilment/delivery, invoice issuance, payments, credit/correction documents, and—where enabled—recurring subscriptions. It must also support purchase and inventory operations without mixing their concerns into the CRM kernel.

### 1.1 Primary outcomes

At completion, authorized users must be able to:

1. Maintain products and services, product categories, product variants where enabled, and supplier-specific purchasing prices.
2. Define prices using product-level prices and/or configurable price books, including effective dates, quantity breaks, customer-specific pricing, and rule-based adjustments.
3. Configure tax classes, tax codes, tax rules, shipping taxes, tax-inclusive/exclusive behavior, and document rounding.
4. Create, revise, send, accept, reject, expire, and convert quotes.
5. Create and confirm sales orders from opportunities or quotes, and track their fulfilment status.
6. Issue invoices with immutable commercial snapshots, configurable numbering, payment terms, due dates, and issuance locking.
7. Record incoming/outgoing payments and allocate them across invoices, credit notes, bills, or other supported payable/receivable documents.
8. Issue credit notes, write-offs, and corrections using traceable allocation and adjustment workflows rather than silently editing issued invoices.
9. Track delivery orders and customer returns when fulfilment/inventory features are enabled.
10. Manage suppliers, purchase orders, receipts, supplier bills, bill credits/debit notes, and supplier prices when purchasing features are enabled.
11. Track stock across warehouses, stock movements, reservations, transfers, and adjustments when inventory is enabled.
12. Create subscriptions and billing periods and generate invoices idempotently through the platform job system.
13. Print commercial documents to PDF, email documents using the existing mail system, and expose document/report data through secure APIs.
14. Provide a foundation that `StripeIntegration`, `AccountingIntegration`, and `CustomerSuccess` can consume without private database coupling.

### 1.2 Module boundary: what “Sales” means in this plan

For this project, **`Sales` means the extended commercial operations / Sales Pack domain**, not a replacement for basic CRM lead and opportunity management.

| Capability | Owner | `Sales` responsibility |
|---|---|---|
| Accounts and Contacts | CRM Core | Reference and extend them through metadata relationships only. |
| Leads and Lead conversion | CRM Core | Consume the existing conversion result; do not reimplement lead qualification. |
| Opportunities and sales pipelines | CRM Core | Link opportunities to quotes/orders/invoices where supported. Do not create a competing Opportunity entity. |
| Products and prices | `Sales` | Implement catalog, price books, price rules, supplier prices, and price selection. |
| Quotes and commercial orders | `Sales` | Implement documents, line items, totals, lifecycle, printing, sending, and conversions. |
| Invoices, credits, payments | `Sales` | Implement commercial document state, balances, allocations, and audit trail. |
| Purchases and inventory | `Sales` | Implement the documented purchasing and stock operations behind settings/permissions. |
| General ledger, tax filing, full accounting | Accounting integration / future accounting domain | Publish integration events and exportable data; do not claim accounting compliance by default. |
| Card gateway or bank connection | `StripeIntegration` or another payment provider module | Expose provider-independent payment intents/events and consume payment interfaces; do not embed provider secrets or gateway-specific logic in the sales domain. |
| Customer lifecycle / churn mitigation | `CustomerSuccess` | Provide customer and invoice/subscription summary contracts; do not implement health scoring here. |

### 1.3 Reference scope

Use these public resources to establish behavior and compatibility expectations:

- Sales Pack overview: <https://docs.espocrm.com/extensions/sales-pack/overview/>
- Sales Pack release notes: <https://www.espocrm.com/extensions/sales-pack/release-notes/>
- Products: <https://docs.espocrm.com/user-guide/products/>
- Prices and Price Books: <https://docs.espocrm.com/extensions/sales-pack/prices/>
- Quotes: <https://docs.espocrm.com/user-guide/quotes/>
- Sales Orders: <https://docs.espocrm.com/user-guide/sales-orders/>
- Invoices: <https://docs.espocrm.com/user-guide/invoices/>
- Sales Management (Core CRM Opportunities): <https://docs.espocrm.com/user-guide/sales-management/>
- Payments: <https://docs.espocrm.com/extensions/sales-pack/payments/>
- Taxes: <https://docs.espocrm.com/extensions/sales-pack/taxes/>
- Tax Codes: <https://docs.espocrm.com/extensions/sales-pack/tax-codes/>
- Inventory Management: <https://docs.espocrm.com/extensions/sales-pack/inventory-management/>
- Sales Pack API reference: <https://docs.espocrm.com/extensions/sales-pack/api/>

Treat public documentation and documented UI behavior as references, not as a source code dependency. Record the source URL and the reference version for each non-obvious compatibility rule.

---

## 2. Scope and Non-Goals

### 2.1 In scope

#### Product and pricing

- Product/service catalog and lifecycle.
- Product categories and optional product variants.
- Sellable/purchasable flags and Goods/Service product type.
- Product units and configurable quantity precision where required.
- Product-level cost/list/unit prices where enabled.
- Price Books with product prices, customer association, effective periods, quantity breaks, price rules, and mass update preview.
- Supplier/product prices and supplier relationships.
- Product search/selectors and batch product insertion into line-item editors.

#### Sales documents

- Quotes.
- Sales Orders.
- Invoices.
- Credit Notes and credit allocations.
- Delivery Orders.
- Return Orders.
- Write-offs.
- Payment Terms and Payment Terms Profiles.
- Document numbering, immutable issued snapshots, locking, PDF templates, email sending, and conversion between related documents.

#### Payments

- Payment methods and channels.
- Incoming/outgoing payment records.
- Payment allocations and remaining/unallocated amount calculations.
- Payment-to-payment allocations/refunds where supported by an explicit domain rule.
- Payment requests as an integration-ready record and state machine.
- Provider-independent webhook/event contract. Actual online payment processing belongs to a gateway integration.

#### Tax, currency, and totals

- Tax classes, tax codes, tax rates, and tax rules.
- Tax-inclusive and tax-exclusive pricing.
- Discounts, shipping/handling charges, and shipping tax.
- Document and line-level rounding policy.
- Base currency and document currency.
- Currency exchange rates and stored exchange-rate snapshots.
- Multi-currency handling for documents, payments, and reports within the documented scope.

#### Procurement and inventory

- Suppliers.
- Purchase Orders.
- Receipt Orders.
- Supplier Bills.
- Bill Credits and supplier debit/correction notes if supported by the selected baseline.
- Warehouses, inventory transactions, adjustments, transfers, stock reservations, batches/serial numbers, product expiry dates, and configurable removal strategies (FIFO, FEFO, LIFO) where inventory is enabled.

#### Subscription billing

- Subscription plans/records, term dates, interval, status, renewal/cancellation settings, and related customer/product relationships.
- Subscription periods with explicit period boundaries and billing statuses.
- Scheduled invoice generation using the existing jobs system.
- Retry, idempotency, pause/cancel, and date boundary behavior.

#### Platform capabilities and UI

- Metadata/entity registration and admin settings.
- ACL/record ownership/team visibility and relevant roles.
- API, search, saved filters, import/export, list/detail/edit layouts, relationships, timeline/audit, PDF and email templates.
- Dashlets/reports and generic report integration if available.
- Workflow/BPM hooks and domain events.
- Integrations with core CRM, activities, jobs, mail, reports, Stripe, accounting, Projects, and Customer Success through stable interfaces.

### 2.2 Explicit non-goals

Do not implement the following as implicit parts of `Sales`:

- Replacing the CRM Core Lead, Account, Contact, or Opportunity entities.
- A full ERP manufacturing system, bills of materials, production planning, warehouse labor management, or advanced demand forecasting.
- A complete general ledger, financial statements, statutory accounting, payroll, bank reconciliation, or jurisdiction-specific accounting certification.
- A full tax authority/e-invoicing gateway or guarantee of tax-law compliance for any jurisdiction.
- Direct credit-card processing, card storage, PCI scope expansion, bank APIs, or payment-gateway-specific webhook logic in the Sales domain.
- Automatic irreversible order issuance, shipment, payment collection, subscription renewal charge, external email, or inventory decrement without a confirmed state transition and auditable policy.
- Unrestricted arbitrary SQL or JavaScript rule execution.
- Database-schema compatibility with EspoCRM or a line-by-line PHP port.
- Making Sales dependent on Customer Success, Projects, Stripe, or Accounting.

### 2.3 Recommended delivery tiers

To avoid trying to build a full ERP in one iteration, deliver the module in tiers while preserving the final architecture:

- **Tier 1 — Commercial foundation:** products, price selection, tax/total engine, quotes, sales orders, invoices, basic payments/allocations, ACL, audit, PDF/email, API.
- **Tier 2 — Sales lifecycle completeness:** credit notes, write-offs, delivery orders, returns, advanced price books, multi-currency, payment terms, issuance locking.
- **Tier 3 — Procurement and inventory:** suppliers, purchase orders, receipts, supplier bills/credits, warehouses, stock transactions, transfers, reservations, batches/serials.
- **Tier 4 — Recurring and advanced capabilities:** subscriptions, recurring invoice jobs, payment requests, payment-to-payment allocations, advanced reports, e-invoicing/export adapters, and deeper integrations.

The plan may be executed phase-by-phase, but later-tier database contracts must not contradict Tier 1 invariants.

---

## 3. Prerequisites and Repository Audit

### 3.1 Verify CRM and platform capabilities

Before adding code, verify the actual presence, implementation path, and test command for:

- Module/extension manifests, dependency resolution, module load ordering, migrations, and metadata merge behavior.
- Entity Engine create/read/update/delete, custom fields, relationship loading, child records, validation, serialization, query/filter/sort, pagination, and transactions.
- PostgreSQL/Kysely conventions for migrations, numeric/decimal types, JSONB, unique constraints, partial indexes, and row locking.
- API routing, request DTO validation, error envelope, authentication, authorization, OpenAPI, pagination, filtering, sorting, and idempotency support.
- Accounts, Contacts, Opportunities, Users, Teams, currency settings, base currency, activity records, attachments, notes, Stream, audit/history, and notifications.
- Formula/dynamic logic, workflow, BPM, scheduled jobs, report engine, import/export, PDF/document generation, templates, and email infrastructure.
- Existing Products, Quotes, Sales Orders, Invoices, Payment, Inventory, Subscription, or other partially implemented entities, including ownership and migration history.
- `StripeIntegration`, `AccountingIntegration`, and any existing payment provider abstractions.
- The frontend component system, generic entity layouts, relationship panels, lookup modals, line-item editor, PDF preview, and dashboard/report widgets.
- Existing data migration and seed behavior, including which commands modify the configured primary database.

### 3.2 Audit deliverable

Create `docs/implementation/sales-repository-audit.md` containing:

1. Verified source locations for all relevant modules and platform primitives.
2. Reusable existing entities/services and how to call them.
3. Existing API naming and routing rules.
4. Existing migration naming/version conventions and observed database schema ownership.
5. Existing money/currency conventions and any inconsistencies that need resolution.
6. Missing prerequisites and whether they block Tier 1 or only a later optional tier.
7. A dependency map for `Sales`, `StripeIntegration`, `AccountingIntegration`, `CustomerSuccess`, `Projects`, Reports, Workflows, and BPM.
8. A feature contract listing reference version, intended behavior, known deviations, and explicit non-goals.
9. Existing test commands inspected for database creation, reset, teardown, seed, and external side effects.

### 3.3 Dependency policy

- Accounts, Contacts, Users, Teams, CRM Opportunities, ACL, Entity Engine, module system, and safe migrations are required for a complete integration.
- If Opportunities are missing, report the finding. Do not silently create a duplicate entity; implement only a minimal, reusable Core CRM dependency if the parent plan explicitly permits it and the audit shows it is necessary.
- Reports, Workflows, BPM, Stripe, accounting, Projects, and Customer Success are optional consumers/providers. The module must start when they are not installed.
- For optional modules, use dependency registration and narrow typed adapter interfaces. Avoid direct imports that cause a mandatory startup dependency.
- Do not use another module's private database tables as its public integration API.

---

## 4. Functional Requirements

## 4.1 Product Catalog

Each product/service record should support, subject to metadata and configuration:

- Name, SKU/product code, description, category, type (`Goods` or `Service`), active/inactive status.
- Sellable and purchasable flags.
- Unit of measure, quantity precision, optional weight/dimensions, and configured system weight unit.
- Tax class or default tax code relationship where applicable.
- Optional default cost/list/unit prices, with per-setting enable/disable behavior.
- Supplier/supplier price associations and supplier product code.
- Product variant family and variant attributes when variants are enabled.
- Image/attachment relationships using the shared file storage system.
- Audit fields and standard CRM assignment/team fields when supported by the Entity Engine.

Rules:

1. Inactive products cannot be added to new documents unless an explicit privileged override is supported; existing issued documents retain their snapshots.
2. A product marked non-sellable cannot be added to a sales quote/order/invoice by default; a non-purchasable product cannot be added to purchase orders.
3. A product may be a service and therefore not produce stock movements.
4. Product names, SKUs, tax defaults, and catalog prices are copied into document-line snapshots so later catalog edits do not rewrite commercial history.
5. SKU uniqueness must follow an explicit scope (global or organization-scoped) decided in repository audit and enforced with a database constraint.
6. Product-level pricing may be disabled globally; the UI must not assume it always exists.
7. Product list and selector queries must use the shared query engine and ACL filtering.

## 4.2 Product Categories and Variants

- Categories support name, parent category, active state, sort order, and optional description.
- Prevent self-parenting and cyclic category trees.
- Variants support a product family plus configured attribute values, such as size, color, or model. Do not hard-code industry-specific attributes.
- SKU/variant uniqueness rules must be documented.
- Where inventory tracks batches/serials, stock must attach to the exact product/variant identity.
- If variants are delivered after the initial catalog, expose a setting/feature flag and keep Tier 1 catalog functional without them.

## 4.3 Price Books and Price Resolution

A price book defines reusable customer/product price conditions. Requirements:

- Price book: name, active state, currency policy, effective date range, optional customer/account assignment, and priority.
- Price entries: product/variant, unit price, minimum quantity, effective period, and optional unit of measure.
- Price rules: explicitly supported criteria/actions, such as percentage adjustment, fixed adjustment, customer/account conditions, product/category conditions, and quantity ranges.
- Customer-specific price book association may be exposed through Account metadata if the platform supports relationship extension.
- Supplier prices are separate from sales prices and must not be accidentally used as a sell price.
- Price selection strategy must be deterministic and explainable. Return the selected price source and the rule/entry that won.
- If multiple eligible rules match, use documented priority and tie-breaking rules; do not depend on unordered SQL row order.
- Prompt users before applying a changed price book to existing draft line items. Do not silently reprice an accepted quote or issued document.
- Bulk price update must support preview, affected-record count, permission checks, transaction safety, and an audit record.
- Never execute administrator-entered arbitrary SQL or unrestricted JavaScript as a price rule.

Recommended price precedence, configurable only through a documented policy:

1. A selected applicable Price Book entry/rule.
2. Product-level Unit Price when enabled and no applicable Price Book price exists.
3. Explicit user-entered price only where the user's role permits it and required justification/audit metadata is captured.
4. If no valid price exists, require an explicit price before saving. **Do not default a missing price to zero.**

The implementation must document and test behavior for overlapping price-book rules, quantity thresholds, effective date boundaries, currency mismatch, no-price products, and inactive entries.

## 4.4 Shared Commercial Document Contract

Quotes, Sales Orders, Invoices, Credit Notes, Delivery Orders, Return Orders, Purchase Orders, Receipt Orders, Bills, and supplier credit/correction documents share some concepts, but they do not share one undifferentiated status machine.

Common capabilities should be implemented through shared domain services or composable helpers:

- Number/series resolution.
- Related customer/supplier and billing/shipping party data.
- Currency and exchange-rate snapshot.
- Payment term/profile and due-date calculation.
- Typed line items with stable ordering.
- Price resolution, discounts, taxes, shipping charges, and totals.
- PDF/email template rendering.
- Locking and issued snapshot behavior.
- Audit/history, conversion lineage, and allocation checks.
- Optimistic concurrency or row-locking support for critical transitions.

Requirements:

- A shared internal abstraction is allowed; do not force unrelated document types into an awkward public inheritance hierarchy.
- Each document type must own its allowed transitions and its own validation.
- Line items should use a queryable, auditable storage model backed by the Entity Engine or a documented typed child-entity design. Do not hide every line item in one opaque JSON blob if the platform needs item-level filtering, reporting, ACL, audit, or custom fields.
- Each line item must record enough source information to preserve history: source product ID if still available, product/SKU snapshot, item name/description, unit, quantity, list price where enabled, unit price, discount, tax treatment, net/tax/gross totals, and position. Fields vary by document type.
- Historical documents must remain renderable if the referenced product, account, contact, price book, or template is later renamed or deactivated.
- Keep the source document link and conversion timestamp/user when generated from another document.

## 4.5 Quotes

- Create quotes manually or from an Opportunity; optionally copy relevant customer/contact/address, currency, source line items, and commercial terms.
- Support owner, teams/collaborators if the core supports them, account/contact, opportunity, subject/title, quote date, valid-until/expiration date, currency, price book, payment terms, shipping details, notes, and status.
- Add, remove, reorder, and edit line items; choose multiple products in one selector action when supported by the existing UI framework.
- Recalculate line and document totals on the server for every save/transition.
- Support draft, sent/proposed, accepted, rejected, expired, and converted outcomes, mapped to the project's chosen baseline and extensible metadata rules.
- Expired quotes must be detected in the UI and by a scheduled job if the job subsystem exists; the job must be idempotent.
- Accepted quotes may be converted into a Sales Order. Conversion must create an auditable relation and not duplicate line items after retries.
- Generate PDF via the existing document template system and send using the existing email service after user confirmation.
- Include relationship panels for related Opportunity, Sales Orders, and generated documents where supported.
- A quote revision after sending must preserve audit/history. Define whether the product uses revision copies or immutable sent snapshots; do not silently change what was already emailed.

## 4.6 Sales Orders

- Create manually, from an Opportunity, or from an eligible Quote.
- Copy commercial values by value into the new order, rather than relying on the source record staying unchanged.
- Include order date, planned/required delivery date, billing/shipping details, warehouse where enabled, currency, payment terms, shipping/handling, items and totals.
- Use an order state machine such as draft → confirmed → in fulfilment/partially fulfilled → fulfilled, with cancellation paths only before prohibited irreversible actions. Exact names must match the feature contract.
- Confirmation must validate price, tax, inventory policy where enabled, required addresses, and line-level quantities.
- A source quote/order may be converted more than once only if an explicit supported workflow permits it; repeated API retries must not create accidental duplicate orders.
- Support generating Invoice and Delivery Order records through explicit actions.
- If inventory is enabled, distinguish stock availability, reservations, and actual stock movement. Confirmation must not decrement stock unless the configured policy explicitly says it does.
- Support PDF and email from templates, audit/history, relationship panels, and optional Workflow/BPM events.

## 4.7 Invoices and Issuance Locking

Invoice requirements:

- Create from a Quote, Sales Order, Opportunity, Subscription Period, or manually if permitted.
- Capture invoice date, due date, payment terms, account/contact, document currency, exchange-rate snapshot, billing/tax party fields, line items, shipping charges, tax details, totals, payment state, and amount due.
- Invoice date, delivery date, service period start/end, and tax/e-invoice identifiers should be supported where relevant to the baseline.
- Distinguish draft from issued. Allocate the final document number at issuance if that is the selected reference behavior; do not consume official numbers for unsaved drafts unless the administrator explicitly chooses a different policy.
- Issuance must be one transaction: validate, recalculate, snapshot buyer/seller and tax facts, allocate number, store issue timestamp/actor, lock protected fields, and emit a domain event/outbox record.
- Support draft, issued, partially paid, paid, overdue, void/credited states as separate state/payment concepts. Do not make payment status a careless substitute for document status.
- Amount Due must be recomputed from eligible allocations, credits, write-offs, and balance adjustments rather than trusted from client payloads.
- Issued documents cannot be silently edited. Use credit notes, void/correction flows, or audited administrative unlocking when a supported policy permits it.
- If issuance locking is enabled, enforce locking server-side and define whether admins can unlock; an admin unlock must require a dedicated permission and audit reason.
- Maintain mirrored/snapshotted buyer and seller data for historical rendering where required. Do not rely solely on mutable Account/company records.
- Support PDF generation, email sending, payment details, and e-invoice export adapter hooks. Do not claim statutory acceptance without jurisdiction-specific validation.

## 4.8 Payments, Payment Methods, Allocations, and Requests

- Represent a payment as a recorded financial event with amount, currency, date, direction, method, channel/reference, payer/payee, status, memo, and audit information.
- Support incoming customer payments and outgoing supplier payments with explicit direction and permitted document types.
- Payment method/channel records are configurable but cannot be deleted while referenced by issued documents if issuance-locking rules require preservation.
- Allocations link a payment to one or more eligible receivable/payable documents. Store allocation amount, currency/FX details where applicable, date, and audit info.
- Validate that allocations do not exceed the payment's remaining allocatable balance or document's remaining eligible balance, except for a separately modelled unapplied amount or explicit overpayment policy.
- Payment-to-payment allocations/refunds must be represented as explicit, auditable records. Do not implement negative allocation hacks that confuse balances.
- Payment status is derived or validated from the domain state (draft/pending/confirmed/failed/refunded etc. as appropriate) and allocation totals.
- Payment requests are internal requests/records linked to a customer and invoice/order. Actual checkout, payment intent, card data, bank mandate, and gateway-specific webhooks belong to provider modules such as `StripeIntegration`.
- A payment provider event must be idempotently ingested with provider event ID and processed status. Duplicate webhook delivery must not create duplicate payments or allocations.
- Never store raw card numbers, CVC, or reusable gateway secrets in `Sales`.
- Tests must use a fake provider; no external charges or live customer emails.

## 4.9 Credit Notes, Write-Offs, and Corrections

- Credit Notes reduce a receivable balance through a documented allocation to one or more invoices or an explicitly supported account-level credit.
- Credit Note items preserve product/description/quantity/tax values and their own totals/snapshots.
- Credit allocation must validate currency, remaining invoice balance or configured allowable credit rules, and transaction consistency.
- Unallocated credit value must be visible and reportable.
- Write-offs represent approved balance adjustments and require reason, actor, date, amount, document link, and permission. They must not be disguised as payments.
- Voiding/correcting an issued invoice must use an approved transition/correction model, never an unlogged hard delete.
- Supplier bill credits/debit notes are a distinct payable-side workflow. Do not conflate them with customer credit notes.
- All credit/write-off allocations must be reversible only through a supported compensating action with audit history.

## 4.10 Delivery Orders, Returns, and Stock Effects

- Delivery Orders can be generated from eligible Sales Orders and represent fulfilment/delivery records.
- Track order, warehouse, shipment/delivery dates, item quantities, shipped/returned/delivered amounts, tracking/reference information, and state.
- Partial delivery must be supported if consistent with the reference baseline and selected feature contract.
- Return Orders reference the original eligible sales/delivery documents, record returned quantities and condition/reason, and define whether the item is restockable.
- Validate that delivered/returned quantities never exceed permitted remaining quantities unless an authorized explicit adjustment path is used.
- Inventory effects must happen exactly once per confirmed stock-moving action. Replaying a command or retrying a job must not double-decrement/increment stock.
- Service items never create stock movements unless a specific extension defines a supported rule.
- Shipment/fulfilment external integrations are optional and are not assumed to exist.

## 4.11 Suppliers and Purchase Workflow

- Supplier records use shared party/contact/address conventions if available and support payment terms, currency preferences, tax IDs, supplier code, default warehouse where relevant, price references, and lock state.
- Purchase Orders contain supplier, order date, expected delivery date, currency, terms, line items, tax/shipping/total data, status, and origin/conversion links.
- Receipt Orders record actual received quantities, dates, warehouse, batches/serials where applicable, and source Purchase Order.
- Supplier Bills represent received supplier invoices, with invoice reference, issue/due dates, line items, totals, payment status, and links to receipts/orders.
- Bill Credits/debit notes adjust supplier balances via explicit allocation/correction behavior.
- Supplier prices are separate from customer sales prices.
- Supplier records referenced by financial documents must be lockable or otherwise protected from edits that would invalidate issued-document history.
- Procurement features can be hidden by configuration/permissions, but should use the same validation and money/tax foundations.

## 4.12 Taxes and Tax Codes

- Define tax classes, tax codes, rates, rules, applicability windows, optional jurisdiction/region criteria, product/account/customer conditions, and enabled/disabled status.
- Tax code mapping may include an external/e-invoicing classification code but must be described as mapping metadata, not legal certification.
- Support item tax, shipping tax, tax-inclusive prices, tax-exclusive prices, and explicitly configured compounding behavior only if required by the target jurisdiction and supported by the engine.
- Tax selection must be deterministic and explainable. Save the tax basis/rate/amount snapshot on issued items and documents.
- Updating a tax rule must not silently change already-issued invoices or credit notes.
- Validate date ranges, overlapping rules, missing applicable tax rates, and currency/rounding effects.
- Provide an admin preview/calculation tool for representative scenarios before enabling a rule.
- Tax rules must use declarative, validated conditions rather than arbitrary SQL or unsafe code.

## 4.13 Multi-Currency

- Use the existing platform currency registry/base currency settings if they exist.
- Document currency and base currency are distinct; do not add a second global currency subsystem inside `Sales`.
- Store all monetary values as decimal strings at API boundaries and fixed-scale `NUMERIC` values in PostgreSQL, with the scale decided from the platform currency model.
- Persist the exchange rate, rate date/source, and any conversion policy snapshot on documents and payment allocations that require conversion.
- Never recompute old issued document base-currency values using a newer exchange rate.
- Specify whether rate is expressed as document-currency-to-base-currency or the reverse; use one convention in all code and documentation.
- Distinguish transaction amount from realized/unrealized FX differences. Full accounting recognition of FX gains/losses is an integration concern unless the repository has an established accounting domain.
- Prevent allocations across currencies without an explicit conversion snapshot and policy.

## 4.14 Subscriptions and Recurring Billing

- Subscription records link customer, product/service and optionally quote/sales order/invoice, with start/end/renewal dates, interval, quantity, currency, pricing/tax policy, billing lead time, status, cancellation/pause settings, and owner.
- Subscription Period records represent a concrete billed/service period and track period start/end, status, planned invoice date, invoice date, generated invoice, and failure/retry metadata.
- Generate periods and invoices using the existing scheduler/jobs framework; do not add an isolated scheduler.
- Job processing must be idempotent through stable idempotency keys/unique constraints, transaction boundaries, and locks.
- Do not generate invoices early when period policy says billing is pending until the configured lead date. Honour time zones/date-only semantics consistently.
- Define handling for paused, cancelled, ended, failed, and overlapping periods.
- If the invoice-generation operation partially fails, it must be safe to retry without creating duplicate invoices, periods, numbers, or email sends.
- Recurring invoice creation must not automatically charge a payment method or send an external communication unless a separate, explicit, audited provider/notification policy authorizes it.

## 4.15 Inventory Management

Enable inventory only through an explicit setting and declare which product types are stock-managed.

Core concepts:

- Warehouses with name/code, active status, address, sort order, and access controls.
- Inventory Transactions as an append-only movement ledger; each transaction records product/variant, quantity delta, warehouse/bin if supported, transaction type, source document, timestamp, actor, and batch/serial references.
- Inventory Adjustments for reviewed corrections with reason and approval/permission requirements.
- Transfer Orders with source/destination warehouses and item quantities, supporting draft/confirmed/in-transit/received/cancelled states only if those states are implementable consistently.
- Reservations/soft reservations for outstanding orders, distinct from physical stock movements.
- Lot/batch/serial number tracking and expiry data where enabled.
- FIFO, FEFO, and LIFO removal policies as configurable options if supported by the repository's stock model.
- Availability calculations that account for on-hand, reserved, and eligible incoming quantities, with semantics clearly labelled.

Inventory invariants:

1. Physical stock is derived from immutable stock movements or a rigorously maintained projection reconciled to that ledger.
2. A document transition creates its stock effects once, in a transaction or through a durable outbox workflow with idempotency.
3. Negative stock is rejected by default where inventory validation is enabled. Any override requires a dedicated permission, reason, and audit record.
4. A cancelled/voided source document does not simply delete a stock movement; use a compensating transaction.
5. Stock transfer has two linked effects (source outflow and destination inflow) and cannot complete only one side silently.
6. Returns are restocked only when their disposition/condition and policy allow it.
7. Concurrent order confirmations must not both reserve the same available quantity. Use row locks or safe atomic reservation logic.
8. Reports distinguish physical on-hand, reserved, available-to-promise, and incoming quantity.

## 4.16 E-Invoicing and Document Output

- Use the shared PDF/print/email template system where it exists.
- Use a document rendering adapter that consumes a stable, permission-filtered document snapshot.
- Support UBL/e-invoice export as an optional adapter if included in the reference baseline or explicitly selected for the target market.
- Keep country-specific validation and signing separate from the generic invoice lifecycle.
- Do not claim the generated document is legally valid for a jurisdiction without formal validation and tests against the relevant specification.
- Never silently modify a previously issued PDF/XML artefact; generate a new version/correction and preserve references/audit metadata.

---

## 5. Data Model and Persistence Design

The exact schema must follow repository conventions and the audit outcome. The entities below are the target logical model, not permission to bypass metadata/Entity Engine or to create duplicate foundational entities.

## 5.1 Core catalog and pricing entities

| Logical entity | Main responsibilities |
|---|---|
| `Product` | Product/service definition, SKU, type, sellable/purchasable flags, unit and product defaults. |
| `ProductCategory` | Hierarchical categorization. |
| `ProductVariant` or variant-enabled `Product` relation | Variant family and configurable attribute values. |
| `ProductPrice` | Optional product-level list/unit/cost prices where enabled. |
| `PriceBook` | Named price collection, currency, account association, effective period and priority. |
| `PriceBookEntry` | Product/variant, unit price, effective period, minimum quantity and optional unit. |
| `PriceBookRule` | Declarative price adjustment criteria/action, priority and validity. |
| `Supplier` | Supplier party/contact, status, terms, currency and lock metadata. |
| `SupplierProductPrice` | Supplier-specific buying price and supplier product information. |

## 5.2 Sales document entities

| Logical entity | Required child/related data |
|---|---|
| `Quote` | `QuoteItem`, source Opportunity, account/contact, lifecycle, totals and PDF/email references. |
| `SalesOrder` | `SalesOrderItem`, source Quote/Opportunity, fulfilment state and warehouse policy. |
| `Invoice` | `InvoiceItem`, source document/Subscription Period, issue/lock data, payment state and due date. |
| `CreditNote` | `CreditNoteItem`, invoice/account links, allocations and correction reason. |
| `DeliveryOrder` | `DeliveryOrderItem`, source order and stock movement links. |
| `ReturnOrder` | `ReturnOrderItem`, source delivery/order, reasons and restock disposition. |
| `WriteOff` | Amount, currency, reason, target invoice/balance, approver, actor and date. |
| `PaymentTermProfile` | Named term policy; link from quote, order, invoice, bill, and supplier when supported. |

## 5.3 Payment and financial records

| Logical entity | Required behavior |
|---|---|
| `Payment` | Direction, counterparty, amount/currency, method/channel, status, reference and audit. |
| `PaymentAllocation` | Payment-to-document amount allocation with currency policy and audit. |
| `PaymentTransferAllocation` | Explicit payment-to-payment allocation/refund/transfer relationship where required. |
| `PaymentMethod` | Configurable payment method lookup. |
| `PaymentChannel` | Configurable channel/provider-neutral reference. |
| `PaymentRequest` | Request state, customer/document relationship, expiry and provider-neutral reference. |
| `CreditNoteAllocation` | Explicit credit note to invoice/balance allocation. |
| `SupplierBillAllocation` or equivalent | Explicit outgoing-payment allocation to bills and supplier credits. |

## 5.4 Taxes, currency, and procurement entities

| Logical entity | Required behavior |
|---|---|
| `TaxClass` | Product/account tax classification if used by rules. |
| `TaxCode` | Standardized tax category code and external code mapping. |
| `TaxRule` | Declarative applicability and calculation rule. |
| `TaxRate` or versioned rule value | Percentage/fixed rate, effective window and jurisdiction context. |
| `PurchaseOrder` / `PurchaseOrderItem` | Supplier order and its immutable item snapshots. |
| `ReceiptOrder` / `ReceiptOrderItem` | Actual received goods and inventory linkage. |
| `Bill` / `BillItem` | Supplier invoice and payable state. |
| `BillCredit` / item records | Supplier credit/correction document. |
| `DebitNote` where supported | Explicit supplier/customer correction semantics as required by the chosen baseline. |

## 5.5 Subscription and inventory entities

| Logical entity | Required behavior |
|---|---|
| `Subscription` | Customer/product, billing interval, status, term, price/tax policy and idempotency metadata. |
| `SubscriptionPeriod` | Service period, billing status, expected invoice date, invoice link and retry state. |
| `Warehouse` | Warehouse identity, address, order and access policy. |
| `InventoryTransaction` | Append-only stock movement ledger. |
| `InventoryAdjustment` | Reviewed stock correction and reason. |
| `TransferOrder` / `TransferOrderItem` | Controlled warehouse transfer. |
| `InventoryReservation` | Reserved/soft-reserved quantities and source order. |
| `InventoryBatch` / `InventorySerial` | Batch/serial tracking and expiry attributes. |

## 5.6 Shared fields and relationship conventions

Where supported by the Entity Engine, use standard fields/relations instead of creating bespoke fields for each module:

- `id`, `name` or `number`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`.
- `assignedUser`, `teams`, owner/collaborator fields when supported by the platform.
- `account`, `contact`, `opportunity`, source document relation, and document relationship panels.
- `status`, `currency`, `amount`, and explicit date/time fields with the project's standard naming conventions.
- Audit, Stream, Notes, Attachments, and soft-delete/archival behavior as provided by Core.

Do not use `name` as a substitute for official commercial document numbering. Internal IDs remain stable, opaque IDs.

## 5.7 Decimal and money data rules

- Persist amounts, unit prices, discounts, tax amounts, rates, quantities, and totals with deliberate precision/scale. Determine exact database column definitions during Phase 19-S.0 and document them.
- Use a decimal arithmetic library or a proven platform utility. Never calculate money through binary floating point.
- Serialize money values as decimal strings, not unqualified floating-point numbers.
- Preserve currency on every monetary aggregate and ensure API contracts do not imply amounts in different currencies are directly comparable.
- Avoid implicit database casts that lose precision. Round at defined calculation stages, not at arbitrary UI steps.
- Recompute totals on the server; client-provided totals are display hints only and must not be trusted.

## 5.8 Snapshot, auditing, constraints, and indexes

- On issuance/confirmation, persist required snapshots of seller, buyer, addresses, currency, exchange rate, item details, tax basis/rate, payment terms, and terms/policy version.
- Keep a document's original content reproducible even if products, accounts, tax rules, prices, templates, or exchange-rate tables change later.
- Use FK/relationship constraints where supported, plus unique constraints for document numbers, idempotency keys, external provider event IDs, SKUs where required, and subscription-period identity.
- Use check constraints for positive quantities or allowed signs where applicable; do not overconstrain legitimate credit/refund semantics.
- Add indexes for customer/supplier, status, date/due date, document number, source relationship, currency, invoice balance lists, product/SKU search, price resolution, payment allocations, warehouse/product, transaction date, and subscription jobs.
- Do not add indexes speculatively to every field. Use query plans or measured workload where available.
- Prefer forward-only, additive migrations. Never make an automated migration silently destroy real commercial records.

---

## 6. Domain Services and Invariants

Create domain services around well-defined business operations; keep controllers thin. Names below are suggested and must be aligned with repository conventions.

### 6.1 Suggested services

- `ProductCatalogService`
- `ProductVariantService`
- `PriceResolutionService`
- `PriceBookService`
- `TaxResolutionService`
- `MoneyCalculationService`
- `CommercialDocumentNumberService`
- `CommercialDocumentSnapshotService`
- `CommercialDocumentLockService`
- `QuoteService`
- `QuoteConversionService`
- `SalesOrderService`
- `SalesOrderFulfillmentService`
- `InvoiceService`
- `InvoiceIssuanceService`
- `PaymentService`
- `PaymentAllocationService`
- `CreditNoteService`
- `WriteOffService`
- `DeliveryOrderService`
- `ReturnOrderService`
- `SupplierService`
- `PurchaseOrderService`
- `ReceiptOrderService`
- `SupplierBillService`
- `InventoryAvailabilityService`
- `InventoryReservationService`
- `InventoryMovementService`
- `SubscriptionService`
- `SubscriptionBillingService`
- `SalesReportingService` where needed beyond generic Reports.

### 6.2 Transaction boundaries

Use a single database transaction for each critical operation when all effects are local to PostgreSQL. Examples:

- Quote-to-order conversion.
- Sales-order confirmation plus stock reservation (not external shipment).
- Invoice issuance plus number allocation, snapshot persistence, and durable event/outbox write.
- Payment allocation/unallocation and balance calculation.
- Credit-note allocation.
- Receipt confirmation and inventory transaction insertion.
- Two-sided warehouse transfer completion where local transaction semantics allow it.
- Subscription period claim/create and invoice-generation intent.

If an operation has external side effects, commit local state and an outbox/job record transactionally, then process the external call with retries and idempotency keys. Never hold a database transaction open while making a slow external HTTP call.

### 6.3 Concurrency

- Use row-level locking, optimistic concurrency, unique constraints, or atomic update predicates to prevent duplicate numbering, over-allocation, over-reservation, and duplicate subscription invoices.
- Handle unique-constraint races as expected domain outcomes, not as silent success.
- Document retry semantics for conflicts and avoid unbounded retries.
- Where locking is used, lock records in a consistent order to reduce deadlocks.

### 6.4 Domain event catalogue

Publish events through the existing event/hook/outbox system where available. Suggested events:

- `sales.product.created`, `sales.product.updated`, `sales.priceBook.changed`
- `sales.quote.created`, `sales.quote.sent`, `sales.quote.accepted`, `sales.quote.rejected`, `sales.quote.expired`, `sales.quote.converted`
- `sales.salesOrder.confirmed`, `sales.salesOrder.cancelled`, `sales.salesOrder.fulfilled`
- `sales.invoice.issued`, `sales.invoice.locked`, `sales.invoice.unlocked`, `sales.invoice.overdue`, `sales.invoice.paid`, `sales.invoice.voided`
- `sales.payment.recorded`, `sales.payment.allocated`, `sales.payment.refunded`, `sales.paymentRequest.created`, `sales.paymentRequest.updated`
- `sales.creditNote.issued`, `sales.creditNote.allocated`, `sales.writeOff.approved`
- `sales.deliveryOrder.confirmed`, `sales.returnOrder.confirmed`
- `sales.purchaseOrder.confirmed`, `sales.receiptOrder.confirmed`, `sales.bill.issued`
- `sales.inventory.transaction.created`, `sales.inventory.lowStock`
- `sales.subscription.created`, `sales.subscription.periodDue`, `sales.subscription.invoiceGenerated`, `sales.subscription.billingFailed`, `sales.subscription.cancelled`

Use stable versioned payload schemas. Events should contain immutable record IDs, relevant totals/currency/status snapshots, actor/correlation IDs where appropriate, and no secrets. Event consumers must be idempotent.

---

## 7. API Design

Follow the actual repository's existing `/api/v1` route and entity CRUD conventions. Do not create parallel CRUD endpoints if the Entity Engine already exposes standard entity resources. Use dedicated command endpoints for state transitions that need domain validation.

The endpoint names below are a proposed inventory, not a mandate to break established route naming conventions.

## 7.1 Standard entity resources

CRUD/list/query resources as available via the generic Entity Engine:

- Products, Product Categories, Product Variants.
- Price Books, Price Book Entries/Rules, Supplier Product Prices.
- Quotes and Quote Items.
- Sales Orders and Sales Order Items.
- Invoices and Invoice Items.
- Credit Notes and Credit Note Items.
- Payments, Payment Allocations, Payment Methods/Channels, Payment Requests.
- Delivery Orders, Return Orders, Write-offs.
- Suppliers, Purchase Orders, Receipt Orders, Bills, Bill Credits.
- Tax Classes, Tax Codes, Tax Rules, Tax Rates.
- Subscriptions and Subscription Periods.
- Warehouses, Inventory Transactions, Adjustments, Transfer Orders, Reservations, Batches/Serials.

Some line-item and ledger entities may be restricted to a nested/domain API instead of direct general CRUD. This must be explicit in metadata and ACL.

## 7.2 Domain commands

Use a command endpoint or equivalent service action for operations that change business state. Expected commands include:

- `POST /api/v1/sales/quotes/{id}/send`
- `POST /api/v1/sales/quotes/{id}/accept`
- `POST /api/v1/sales/quotes/{id}/reject`
- `POST /api/v1/sales/quotes/{id}/expire` (administrative/system action if allowed)
- `POST /api/v1/sales/quotes/{id}/convert-to-sales-order`
- `POST /api/v1/sales/sales-orders/{id}/confirm`
- `POST /api/v1/sales/sales-orders/{id}/cancel`
- `POST /api/v1/sales/sales-orders/{id}/create-invoice`
- `POST /api/v1/sales/sales-orders/{id}/create-delivery-order`
- `POST /api/v1/sales/invoices/{id}/issue`
- `POST /api/v1/sales/invoices/{id}/void` (only if allowed and with reason)
- `POST /api/v1/sales/invoices/{id}/unlock` (privileged, audited action)
- `POST /api/v1/sales/invoices/{id}/send`
- `POST /api/v1/sales/invoices/{id}/allocate-payment`
- `POST /api/v1/sales/payments/{id}/allocate`
- `POST /api/v1/sales/payments/{id}/unallocate`
- `POST /api/v1/sales/credit-notes/{id}/issue`
- `POST /api/v1/sales/credit-notes/{id}/allocate`
- `POST /api/v1/sales/write-offs/{id}/approve`
- `POST /api/v1/sales/delivery-orders/{id}/confirm`
- `POST /api/v1/sales/return-orders/{id}/confirm`
- `POST /api/v1/sales/purchase-orders/{id}/confirm`
- `POST /api/v1/sales/receipt-orders/{id}/confirm`
- `POST /api/v1/sales/bills/{id}/issue`
- `POST /api/v1/sales/subscriptions/{id}/pause`
- `POST /api/v1/sales/subscriptions/{id}/resume`
- `POST /api/v1/sales/subscriptions/{id}/cancel`
- `POST /api/v1/sales/subscriptions/{id}/generate-periods` (permission-restricted/admin/job use)
- `POST /api/v1/sales/products/resolve-prices` or a repository-conforming batch price-preview action.
- `POST /api/v1/sales/tax/preview` or a repository-conforming tax/total preview action.

Adapt these paths to the project's existing route convention. Preserve the semantic separation between ordinary field updates and irreversible state transitions.

## 7.3 API requirements

- Validate IDs, DTOs, decimal strings, enumerations, date ranges, currency, line counts, quantity precision, and transition preconditions.
- Never trust client-submitted calculated totals, tax amounts, final balances, stock availability, or authorized status changes.
- Apply authentication, record ACL, team visibility, field-level ACL, and operation permissions before loading or mutating related records.
- Enforce ACL through the server-side domain service—not just by hiding a React button.
- Use idempotency keys for retries of important create/issue/convert/allocate/generate commands where supported by the generic platform.
- Return the canonical updated representation or the project's standard command result and error envelope.
- Expose clear conflict errors when an item was concurrently issued, allocated, converted, locked, reserved, or changed.
- Generate/update OpenAPI contracts and endpoint tests with every API change.
- Do not reveal internal SQL, secret settings, provider payloads with sensitive data, or stack traces in API responses.

---

## 8. Permissions and Security

### 8.1 Permission areas

Define Sales-specific permissions in the established ACL/role system. At minimum, cover:

- View/manage products, product prices, price books, and supplier prices.
- View/manage suppliers, purchase documents, and supplier bills/credits.
- Create/edit/send/accept/reject/convert quotes.
- Create/edit/confirm/cancel sales orders.
- Create/edit/issue/send/void invoices.
- Lock/unlock issued documents.
- Record payments, allocate/unallocate payments, issue refunds, and approve write-offs.
- Create/confirm delivery orders and returns.
- View/perform inventory adjustments and transfers; override negative stock or reservation conflicts.
- Manage tax configuration, document numbering, payment terms, subscription billing settings, and module settings.
- View sensitive costs, margins, customer balances, supplier balances, and profitability reports.
- Run/retry subscription billing jobs and access payment request provider metadata.

Use least privilege and keep sensitive permissions separate. “Edit document” must not imply “issue invoice”, “unlock issued invoice”, “write off balance”, “override stock”, or “perform refund”.

### 8.2 Record-level rules

- Reuse Account, Contact, Opportunity, owner, team, collaborator, and record ACL conventions from Core.
- Apply ACL to source records, converted records, line items, allocation records, documents rendered to PDF, reports, exports, and background jobs.
- A user who can view an invoice must not necessarily view internal cost price, supplier data, margin, or payment provider identifiers.
- Enforce allowed relations to avoid linking one tenant/team's restricted document to an unauthorized account or opportunity.
- Child item endpoints inherit parent visibility and apply any additional item-level policy.
- Jobs must execute as an explicit service/system identity with scoped authorization and audit context—not as an implicit unrestricted user.

### 8.3 Issuance, numbering, and lock security

- Reserve/allocate numbers atomically with a unique constraint.
- Define numbering scopes: organization/legal entity and document series at minimum; include fiscal period only if selected and validated.
- If a number is allocated on issuance, never reuse the number of an issued document after void/correction unless the applicable legal policy explicitly supports it.
- Ensure a double-click, retry, or concurrent request cannot issue the document twice or create two numbered records.
- Lock protected values after issuance. Admin unlock requires dedicated permission, reason, actor, time, and before/after audit.
- Preserve original artefacts and snapshot values used to render issued PDF/XML outputs.

### 8.4 Payment and inventory security

- Do not expose raw provider secrets, card data, full gateway tokens, mandate secrets, or webhook signing secrets.
- Webhook authenticity must be verified in the provider module; `Sales` should consume an authenticated provider-neutral event contract.
- Payment/credit/write-off allocation operations must re-check balances while holding appropriate locks.
- Stock adjustment, negative inventory override, transfer confirmation, and reservation override require separate permissions and audit reasons.
- Restrict bulk edits and exports of financial records; apply ACL in background-generated files, not just at download time.

---

## 9. UI and User Experience

Follow the existing React SPA shell, design system, metadata-driven forms, list/detail pages, route conventions, and state/query management. Reuse generic record pages where they are sufficient and implement domain-specific components only where generic CRUD is inadequate.

## 9.1 Navigation and menu structure

Proposed grouping, subject to actual navigation conventions:

- **Catalog:** Products, Categories, Product Variants, Price Books, Supplier Prices.
- **Sales:** Quotes, Sales Orders, Invoices, Credit Notes, Delivery Orders, Returns, Write-offs.
- **Payments:** Payments, Payment Requests, Methods/Channels.
- **Purchases:** Suppliers, Purchase Orders, Receipts, Bills, Bill Credits.
- **Subscriptions:** Subscriptions, Subscription Periods.
- **Inventory:** Warehouses, Inventory Transactions, Adjustments, Transfers, Batches/Serials.
- **Administration:** Sales Settings, Tax Classes/Codes/Rules, Numbering, Payment Terms, Inventory Settings.

Each navigation entry must respect module enabled state and user ACL.

## 9.2 Product and pricing UX

- Product list with search by name/SKU, filters for category/type/status/sellable/purchasable, and safe bulk operations.
- Product form/detail page with prices, tax classification, variants, suppliers, references and stock summaries where authorized.
- Price Book page with price entries, effective periods, customer association, rules and deterministic price preview.
- Supplier price records separated visually from sales price sources.
- Bulk price update should show a preview of changed values before committing.

## 9.3 Line-item editor

The line-item editor is a critical shared control. Requirements:

- Search/select products and add multiple items when supported.
- Show quantity, unit, price source, unit/list price where enabled, discount, tax, and line total.
- Support reorder, remove, edit description and optionally permit custom item lines with explicit permissions.
- Show a clear explanation when a product has no applicable price or a price rule cannot be resolved.
- Provide a user-confirmed action to refresh prices when changing a Price Book; never silently overwrite user edits.
- Display totals by line subtotal, discount, shipping/handling, tax breakdown, and grand total according to configured tax policy.
- Display values with currency code/format and exact server-calculated results.
- Support large line lists with pagination/virtualization if needed; do not load an unbounded number of lines at once.
- Display validation errors near the relevant item and make keyboard operation possible.

## 9.4 Document UX

- A status banner shows Draft, Issued, Locked, Paid, Partially Paid, Overdue, Fulfilled, Cancelled, or other valid domain states without conflating separate state dimensions.
- State-changing actions are explicit, permission-sensitive, confirmed when irreversible, and accompanied by validation feedback.
- Relationship panels show source Opportunities/Quotes/Orders, generated invoices, deliveries, payments, credit notes, subscriptions, and receipts where relevant.
- Detail pages show document number, total, amount due, due date, currency, tax summary, payment allocations, and issue/lock history as permitted.
- PDF preview and email send use the existing shared template/mail mechanisms.
- Show “issued and locked” state clearly. Do not expose normal edit controls when the document is immutable.
- Provide clear conversion UX: preview what values will be copied and disclose when a conversion is partial or will create a new document.

## 9.5 Payment, stock, and subscription UX

- Payment form displays allocatable amount and document outstanding amount; allocation preview must be server validated.
- Show unallocated payment/credit amounts and provide a separate allocation action.
- Warehouse stock views distinguish on-hand, reserved, available, and incoming values.
- Inventory adjustments/transfers require reason and confirmation; dangerous overrides require privileged permissions.
- Subscription detail shows period calendar/list, next billing date, status, generated invoices, billing failures, last attempt and next retry, with an authorized retry action.
- Jobs and generated invoices must have clear status/error displays; avoid hiding failures in logs alone.

## 9.6 Responsive and accessible behavior

- Respect the existing app's responsive breakpoints and accessibility conventions.
- Forms and line-item editors must be keyboard accessible and have visible focus states.
- Tables must not lose critical document number, amount/currency, status, and due date on narrow screens; use responsive layouts or horizontal scrolling intentionally.
- Provide loading, empty, validation-error, permission-denied, conflict, and server-error states.

---

## 10. Jobs, Notifications, and Automation

Use the existing jobs, scheduler, notification, event, workflow and BPM subsystems. Do not create a separate timer/cron framework in `Sales`.

### 10.1 Candidate jobs

- Mark quotes expired when their configured valid-until policy says so.
- Update overdue invoice indicators based on due date and eligible balances.
- Generate subscription periods.
- Generate subscription invoices when a period reaches its eligible billing window.
- Retry eligible failed internal processing tasks with bounded backoff.
- Detect low-stock thresholds if configured.
- Reconcile derived stock/balance projections against authoritative ledger/allocations, report discrepancies, and avoid silently mutating issued records.
- Cleanup non-sensitive temporary render artefacts according to shared storage retention policy.

### 10.2 Job requirements

- Stable job identifiers and idempotency keys.
- Bounded batch size, retries, backoff, and failure diagnostics.
- Locking/claim semantics to prevent overlapping workers from generating duplicate periods/invoices or stock effects.
- No live external payment calls or customer emails unless an explicit provider/notification flow authorizes it.
- Metrics for job run count, duration, failures, retry count and duplicate/idempotency rejections.
- Administrative retry/cancel functions protected by ACL and audited.

### 10.3 Workflow and BPM

Where the generic engines exist, publish stable Sales events and permit configured rules for reminders, task creation, notifications, and approval processes. Never let generic workflows bypass issuance lock, payment allocation, credit, or inventory invariants. External side effects should pass through approved adapters/outbox processing.

---

## 11. Integration Contracts

### 11.1 CRM Core

- Link Accounts, Contacts and Opportunities via standard relationship metadata.
- Use the existing currency registry, user/team, ACL, audit, Activity, Stream, Attachments, Notes, notification, search and layout components.
- Add optional Account relationship panels for quotes/orders/invoices/payments/subscriptions only through supported metadata/layout contribution mechanisms.
- Do not alter unrelated Core fields or existing data unless the migration is additive and reviewed.

### 11.2 `StripeIntegration`

The Sales domain must be provider-neutral. Define an integration contract around:

- Create a payment request/intent linked to an invoice or order.
- Receive an authenticated provider event with stable provider event ID, provider payment/reference ID, status, amount, currency, and related internal record ID.
- Record/confirm a payment through `PaymentService`/the supported domain operation.
- Make webhook processing idempotent and prevent duplicate Payment/Payment Allocation records.
- Maintain a correlation link between the provider request and the Sales document/payment.

`Sales` must not contain Stripe secret keys, Stripe SDK calls, card fields, or Stripe-specific webhook signature code. The Stripe module may declare `Sales` as a required dependency; `Sales` must not declare Stripe as a dependency.

### 11.3 `AccountingIntegration` / Accounting domain

Expose stable, documented records or events for:

- Issued invoices and credit notes.
- Customer payments and allocations.
- Supplier bills and supplier payments.
- Tax summaries and currency snapshots.
- Voids, write-offs, and correction events.

Integration delivery should use idempotency keys, external reference storage, retry state and reconciliation tools. Do not couple Sales services to private accounting tables. A later accounting integration decides mapping to accounts, journal entries, receivables/payables, and tax-return structures.

### 11.4 `CustomerSuccess`

Customer Success is a downstream optional consumer. Provide authorized summary queries/adapters for:

- Latest and historical issued invoices and amount-due summaries.
- Current and historical subscriptions, subscription term dates, billing status and invoice generation failures.
- Linked commercial Opportunities/Quotes where permitted.
- Renewal-related dates and statuses if stored in the Sales domain.

Do not implement customer health scores, churn predictions, success plans, onboarding, or Customer Success risk records in `Sales`. If `CustomerSuccess` is not installed, all Sales features must work normally.

### 11.5 Projects, Reports, Workflows, BPM, and generic modules

- Projects may consume Sales Order or delivery milestones only through optional adapters.
- Reports should use the generic report engine if available, with Sales-specific datasets/metrics registered through a supported provider interface.
- Workflow and BPM integration must use public events/commands and not bypass state transitions.
- Module absence must not prevent application bootstrap. Feature links/dashlets should be omitted or disabled gracefully.

---

## 12. Reporting and Dashboards

Where the generic Reports/Dashboard subsystem exists, register Sales datasets and reusable metrics rather than implementing a separate report builder.

### 12.1 Core sales reporting

- Quote volume/value by status, date, owner, team, account, and opportunity.
- Accepted/rejected/expired quote distribution and conversion rate.
- Sales Orders by status, customer, owner, date, amount and fulfilment progress.
- Revenue/invoice totals by invoice date, customer, product, category, owner, currency, and tax code where authorized.
- Accounts receivable aging and amount due (label as an operational report, not statutory accounting output).
- Payments and allocations by date/method/status/currency.
- Credits/write-offs and net billed values.
- Product sales quantities and values.

### 12.2 Purchasing and inventory reporting

- Purchase Orders by supplier/status/expected date.
- Supplier bill totals and amounts due.
- Receipts and delivery/return volume.
- Inventory on-hand, reserved, available, incoming, aging/expiry and stock movement history.
- Low-stock items where thresholds are configured.
- Stock valuation only if an explicit costing method and accounting policy are implemented and reviewed; do not label a simple quantity-times-price approximation as official valuation.

### 12.3 Subscription reporting

- Active/paused/cancelled subscriptions.
- Next billing periods and invoice-generation failures.
- Recurring invoicing volume/amount by period, customer, product, and status.
- Failed period generation or duplicate prevention counts.

### 12.4 Reporting rules

- Apply ACL, team scope, currency selection, time zone, date boundaries, and permission to see costs/margins.
- Clearly label values in document currency vs base currency.
- Reports must not aggregate incomparable currencies without an explicit conversion rule.
- Where sales/purchase report support from the upstream Sales Pack depends on an Advanced Pack report engine, treat the generic report engine as a reusable platform dependency, not a hard-coded license or package assumption.

---

## 13. Settings and Administration

Implement settings in the existing administrative configuration framework. Do not introduce a second settings store.

Candidate settings:

- Enable/disable optional features: price books, product-level prices, variants, purchases, inventory, subscriptions, payment requests, multi-currency, issuance locking, PDF/e-invoice adapters.
- Default currency and price source only by reference to the platform's currency settings.
- Price resolution strategy and permission to enter custom prices.
- Document numbering series/prefix/format and allocation timing.
- Document lock policy and admin unlock policy.
- Default payment term profiles.
- Tax inclusivity, rounding stages, quantity precision, and configured weight unit.
- Inventory negative-stock policy, reservation strategy, removal method, and default warehouse if supported.
- Subscription invoice lead time, billing date rule, retry limit and interval (must map to jobs configuration).
- Default templates for quotes/orders/invoices/credits/purchase documents.
- Sales-specific report/dashboard defaults and list panel configuration.

Rules:

- Validate settings server-side and version settings changes where they affect calculations or financial document interpretation.
- Changes to tax/pricing/numbering policy must not rewrite historic issued documents.
- Restrict high-impact settings to administrators or explicit permission roles.
- Display dependency state when enabling a feature requires another capability or integration.

---

## 14. Implementation Roadmap — Phase 19-SALES

Execute these sub-phases sequentially. A sub-phase may be split into smaller pull requests, but do not skip prerequisites or claim completion without the acceptance evidence.

## Phase 19-S.0 — Repository Audit and Feature Contract

**Goal:** Establish the real implementation boundary and record the initial behavior contract before changing code.

Tasks:

1. Read `AGENTS.MD`, the relevant sections of `PLAN.md`, this plan, and downstream integration plans.
2. Inspect the actual codebase and database migration history.
3. Verify Core CRM entities and platform primitives listed in Section 3.
4. Search for existing Sales/Product/Quote/Invoice/Payment/Inventory/Subscription code, metadata, route handlers, UI screens, migrations and translations.
5. Inspect package scripts, test setup/teardown, Docker Compose and CI for implicit database creation/reset and external side effects.
6. Verify the repo's decimal/money, currency and timezone conventions. Record any mismatch before coding.
7. Map existing entity CRUD routes vs domain command routes.
8. Define Tier 1 feature contract and explicit deviations from the documented reference baseline.
9. Identify license/compliance and country-specific tax/e-invoice questions that need review; don't make legal claims.
10. Create `docs/implementation/sales-repository-audit.md`.

**Acceptance criteria:**

- The audit contains concrete source locations and verified commands.
- Required vs optional dependencies are classified accurately.
- No code, migration, database, or settings change has been made in this phase.
- No new database or schema was created.

## Phase 19-S.1 — Module Scaffold, Manifest, and Registration

**Goal:** Register `Sales` using the existing module system.

Tasks:

1. Add a manifest with stable ID `sales`, version, compatible platform range, dependency declarations, feature flags, and module load order following repository conventions.
2. Declare only actual required Core dependencies. Do not depend on Stripe, Accounting, Projects, Reports, Workflows, BPM, or Customer Success unless repository audit proves the platform's module SDK requires an optional capability in a way that can be resolved safely.
3. Register metadata, routes/actions, permission declarations, frontend navigation contributions, settings, translations and jobs through the established extension APIs.
4. Ensure module enable/disable/uninstall semantics are explicit and data preserving.
5. Add module-health/diagnostic output that reports unavailable optional integrations.
6. Add smoke tests for module load with and without optional consumers.

**Acceptance criteria:**

- Module is discoverable and loads without editing kernel files beyond supported registration needs.
- Existing modules remain operational.
- Disabled optional modules do not create import/runtime errors.
- No test database is created.

## Phase 19-S.2 — Domain Settings, Shared Money Utilities, and Document Infrastructure

**Goal:** Provide the smallest reusable foundation needed by Sales document types.

Tasks:

1. Reuse the platform currency registry and user/company settings. Identify any minimal reusable platform fix in a separate change if needed.
2. Implement/use decimal-safe utility functions for multiplication, percentage discount, tax, rounding, comparison, and serialization.
3. Define a canonical money value contract: amount string, currency code, amount scale, and exchange-rate policy where relevant.
4. Add settings schema and validation for optional Sales features, defaults, rounding policy, numbering series, and supported document types.
5. Add a reusable document-number service with atomic sequence/series management and unique constraints. Prefer number allocation at issuance for financial documents; document any exception.
6. Add document lifecycle/state-machine service interfaces, immutable snapshot service and lock service, without forcing every document to share the same statuses.
7. Add common typed line-item calculation input/output contracts, tax breakdown output, audit context, correlation ID and idempotency support.
8. Add API/OpenAPI definitions for settings/preview services as appropriate.

**Acceptance criteria:**

- Unit tests prove decimal operations and rounding policy are deterministic.
- Concurrent number allocation cannot produce duplicates.
- The common services are reusable by the next phases and do not bypass ACL or the Entity Engine.
- Historic documents can be rendered from persisted snapshots.

## Phase 19-S.3 — Product Catalog and Categories

**Goal:** Ship products/services and shared product selectors.

Tasks:

1. Register Product and Product Category entity metadata and relationships.
2. Add name, SKU, product type, description, active state, sellable/purchasable flags, unit and relevant dimensional fields as supported by scope.
3. Implement product-level cost/list/unit prices as configurable fields only if enabled by settings.
4. Add tax-class/default-tax relationships where the tax model is available; use a deferred optional relation only if the module system supports it safely.
5. Add category hierarchy validation, active state, filtering and sorting.
6. Add product detail panels for prices, supplier links, stock and sales references as the related phases arrive.
7. Add search/selectors, ACL-aware API, import/export configuration and safe bulk updates.
8. Ensure inactive/non-sellable/non-purchasable rules apply server-side.

**Acceptance criteria:**

- Authorized user can create, list, view, update and deactivate products and categories.
- SKU uniqueness rule is explicit and enforced.
- Unauthorized users cannot view protected cost prices.
- Deactivating a product does not mutate existing document snapshots.

## Phase 19-S.4 — Price Books, Price Rules, and Supplier Prices

**Goal:** Implement explainable deterministic sales and purchasing price selection.

Tasks:

1. Add Price Book and Price Book Entry metadata/models.
2. Add active status, currency, customer association, priority, effective dates, quantity breaks, and product/variant reference.
3. Implement supported declarative price rules with validation, rule ordering, preview and conflict diagnostics.
4. Implement `PriceResolutionService` with the precedence and tie-breaking policy documented in Section 4.3.
5. Add account/customer price-book selection without hard-wiring account behavior into the generic Entity Engine.
6. Add Supplier Product Price with supplier currency, supplier item code, validity, minimum order quantity if needed, and buying-price fields.
7. Add bulk price update preview/apply flow, audit log, permission checks and bounded transactions.
8. Add frontend price editor, rules form, resolution preview and stale-price prompt contracts.

**Acceptance criteria:**

- Same input context always resolves to the same price and records why that price won.
- Missing prices are surfaced and are never silently changed to zero.
- Supplier prices are never used for sales by accidental fallback.
- Bulk changes are previewed and auditable.

## Phase 19-S.5 — Tax Engine, Tax Codes, Currency Snapshot, and Totals

**Goal:** Implement tax and currency rules before document issuance.

Tasks:

1. Register Tax Class, Tax Code, Tax Rate and Tax Rule concepts using the repository's metadata patterns.
2. Implement declarative rule matching, effective dates, priorities, conflict detection and tax preview.
3. Support tax-inclusive/exclusive pricing, item tax, shipping tax and configured discount treatment.
4. Define line and document rounding stages and apply them consistently.
5. Add tax-code external/e-invoice mapping fields where relevant.
6. Use platform currency/exchange-rate facilities and store document rate snapshots.
7. Implement subtotal, discount, shipping, tax breakdown, net total, gross total, and amount-due calculation contracts.
8. Add test vectors covering rounding boundaries, discounts, inclusive/exclusive tax, multiple item rates, currency scale, no-price, and effective date boundaries.
9. Document jurisdiction-dependent gaps and avoid asserting legal compliance.

**Acceptance criteria:**

- Server-calculated totals are deterministic and validated with known examples.
- Existing issued documents will retain their original tax/currency snapshot after rules change.
- Conflicting or missing tax rules produce clear errors, not silent zero tax unless the selected policy explicitly permits it.
- Reports can identify tax code/rate at the document-line level.

## Phase 19-S.6 — Shared Document Line Items, Numbering, Locking, and Snapshots

**Goal:** Establish the common mechanics used by quote/order/invoice workflows.

Tasks:

1. Implement the chosen typed child-line entity/table strategy for item-level fields, sorting, custom field extension and reporting.
2. Add line item validation, price snapshots, product snapshots, quantity precision, discounts, taxes, totals and reordering.
3. Add server-side document recalculation; reject or ignore client-submitted totals.
4. Implement numbering series, allocation timing, uniqueness, preview/display numbering if applicable, and concurrency controls.
5. Implement source-to-destination conversion service that copies values by snapshot and is idempotent under retries.
6. Implement shared lock/snapshot utilities; per-document state machines remain separate.
7. Add PDF/email rendering input contract based on a permission-checked snapshot.
8. Verify custom item fields can be extended safely through the existing Entity Manager/metadata system or document any minimum generic platform work required.

**Acceptance criteria:**

- Item-level search/report and safe custom-field capability works within the chosen data model.
- A product/catalog update does not alter draft calculations unless the user explicitly refreshes prices; it never alters issued snapshots.
- Document numbers are unique and atomically assigned according to policy.
- A repeated conversion request cannot create duplicate destination documents by default.

## Phase 19-S.7 — Quotes

**Goal:** Complete quotes and the Opportunity integration.

Tasks:

1. Register Quote and Quote Item metadata, layouts, relations, ACL, filters and list/detail/edit views.
2. Link Account, Contact, Opportunity, Price Book and generated downstream documents through existing relationships.
3. Implement quote lifecycle, valid-until behavior, accepted/rejected/converted state rules and audit.
4. Implement line-item editor and server recalculation.
5. Add quote PDF template selection, preview and email-send action using existing shared services.
6. Implement safe conversion to Sales Order with conversion lineage and duplicate protection.
7. Add an idempotent expiry job if the job subsystem exists; otherwise display an accurate derived expired state and document the limitation.
8. Add relationship panels for source Opportunity and generated Sales Orders.
9. Add tests for expired quote handling, stale prices, ACL, send side-effects, and conversion retries.

**Acceptance criteria:**

- Authorized users can prepare and send quotes, record their outcome, and generate an order from an eligible quote.
- Sending requires explicit user intent and a configured email provider.
- A sent/accepted quote is auditable and never changes silently.
- Conversion preserves line/tax/currency snapshot and handles retries safely.

## Phase 19-S.8 — Sales Orders and Fulfilment State

**Goal:** Implement confirmed customer orders and lifecycle actions.

Tasks:

1. Register Sales Order and Sales Order Item metadata and relationships to Quote, Opportunity, Account, Contact, Invoice, Delivery Order and Warehouse when inventory is enabled.
2. Implement draft/confirmation/cancellation/fulfilment state transitions with per-state validation.
3. Support manual creation and conversion from eligible Opportunity/Quote according to the feature contract.
4. Add payment terms, required/delivery dates, addresses, shipping, tax, line items and totals.
5. Add confirm/cancel/create-invoice/create-delivery-order commands with transactionality and idempotency.
6. Validate stock availability or create reservations only when inventory is enabled and configured.
7. Add PDF/email template integration and relationship panels.
8. Add Workflow/BPM events without letting automation bypass confirmation rules.

**Acceptance criteria:**

- Orders cannot be confirmed with invalid prices, taxes, customer details, or quantities.
- Inventory confirmation behavior is explicit and does not double-reserve or double-decrement.
- Generated invoice/delivery orders retain source lineage.
- Cancellation obeys fulfilment/payment/issuance rules and records the reason.

## Phase 19-S.9 — Invoices, Issuance, Due Dates, and Issuance Locking

**Goal:** Implement secure issued invoices and operational balances.

Tasks:

1. Register Invoice and Invoice Item entity metadata, layouts, ACL and relationship panels.
2. Support creation from Sales Order, Quote, Opportunity, Subscription Period (when available), or manual creation according to permissions.
3. Implement payment terms/profiles, issue/due dates, service period, delivery date, currency/rate snapshot, tax, shipping and totals.
4. Implement issue command that validates/recalculates, snapshots parties/lines/tax/rates, assigns number atomically, records issuer/time, applies lock policy and writes the event/outbox entry in one transaction.
5. Implement invoice status and payment status as separate but related concepts.
6. Implement amount due from payment allocations, credit allocations and approved write-offs—not from a client-supplied value.
7. Add overdue detection and optional notification event/job using the existing platform services.
8. Add PDF/email/e-invoice adapter contracts; sending is explicit, audited and testable in fake mode.
9. Implement void/correction and privileged unlock only through documented, auditable state commands.
10. Add tests for double issuance, concurrent issuance, number allocation, locking, old snapshots, partial payment, due-date boundaries, and unauthorized unlock.

**Acceptance criteria:**

- Issuing twice via retries creates one issued invoice and one number.
- Issued values cannot be changed through generic CRUD or crafted API requests.
- Amount due matches allocations and approved adjustments.
- Issued document can be rendered without reading mutable catalog/account/rate data for historic values.

## Phase 19-S.10 — Payments, Methods, Allocations, and Payment Requests

**Goal:** Track payments and allocate amounts safely.

Tasks:

1. Register Payment, Payment Method, Payment Channel, Payment Allocation and Payment Request entities/contracts.
2. Implement incoming and outgoing payment records with direction and permissions.
3. Implement allocation/unallocation commands using transactions and locks on relevant payment/documents.
4. Prevent over-allocation, negative unallocated balances and unsupported cross-currency allocations.
5. Support partial payments, multiple invoices per payment where allowed, one invoice paid by multiple payments, unapplied payments and allocation history.
6. Add customer/supplier payment method metadata and ensure sensitive values are never stored in Sales records.
7. Add provider-neutral payment request contract with pending/paid/failed/expired/cancelled states, where needed.
8. Add event/outbox contract for payment provider callbacks; fake out external modules in tests.
9. Add optional payment-to-payment allocation/refund records where selected in the phase contract.
10. Add payment list/detail, allocation editor, invoice outstanding balances and payment history panels.

**Acceptance criteria:**

- Concurrent allocation cannot allocate the same balance twice.
- Payment and invoice amounts due remain consistent after allocate/unallocate/correction actions.
- Duplicate provider event IDs cannot create duplicate payments or allocations.
- No live gateway is called by tests or basic Sales flows.

## Phase 19-S.11 — Credit Notes, Write-Offs, and Financial Corrections

**Goal:** Provide controlled mechanisms for reducing receivables/payables.

Tasks:

1. Register Credit Note and Credit Note Item records.
2. Implement credit-note creation from supported invoice/source documents or manual creation with permission.
3. Implement issue/lock flow analogous to invoice issuance where applicable.
4. Implement credit allocation to eligible invoice(s), balances, or account credits under explicit rules.
5. Implement write-off creation, approval, reason requirement, amount limits and audit trail.
6. Add bill credit/debit correction concepts if the supplier-bill phase needs them; preserve separate customer vs supplier semantics.
7. Add compensating action/reversal rather than delete for applied credits/write-offs.
8. Add PDF/email templates and reportable allocations.

**Acceptance criteria:**

- Issued invoice and credit-note amounts cannot be silently rewritten.
- Applied credits cannot exceed allowed balances except through a separately specified policy.
- Write-offs are permission-gated and audited.
- Reversals preserve the history of both original and compensating entries.

## Phase 19-S.12 — Delivery Orders and Return Orders

**Goal:** Track fulfilment and customer returns, connecting commercial orders with stock effects when inventory is enabled.

Tasks:

1. Register Delivery Order/Item and Return Order/Item models and metadata.
2. Support creation from Sales Orders and explicit manual paths if allowed.
3. Validate remaining quantities and partial deliveries/returns.
4. Implement delivery confirmation, return confirmation, restock disposition and cancellation behavior.
5. Connect confirmed stock-changing actions to inventory movement service through a stable internal contract; do not write stock counts directly in controllers.
6. Add tracking/reference fields and attachments using shared file components.
7. Add PDF/print/export hooks, relationship panels and domain events.
8. Ensure repeated confirmation commands do not create duplicate stock movement.

**Acceptance criteria:**

- Fulfilled/delivered/returned quantities reconcile with order line quantities under the documented policy.
- Stock-affecting actions are idempotent and auditable.
- Return items are restocked only when their disposition allows it.

## Phase 19-S.13 — Suppliers, Purchase Orders, Receipts, Bills, and Supplier Credits

**Goal:** Complete purchasing flows using the shared money/tax/document infrastructure.

Tasks:

1. Register Supplier entity or extend existing party entity without creating a competing Account/Contact model.
2. Add lock/edit rules for suppliers referenced by issued bills and documents.
3. Register Purchase Order/Item, Receipt Order/Item, Bill/Item and Bill Credit records.
4. Implement order, partial/full receipt, bill issuance and supplier payment allocation workflows.
5. Link receipt lines to product, supplier price, warehouse, and batch/serial tracking when inventory is enabled.
6. Implement supplier bill due dates, payment terms, currency/rate, taxes, snapshots, and issued-document protection.
7. Implement supplier bill credits/debit notes with explicit correction/allocation semantics.
8. Add PDF/email templates where appropriate and relationship panels from supplier/order/receipt/bill records.
9. Add permission boundaries separating purchase order management, receipt confirmation, bill issue, payment, and stock adjustment.

**Acceptance criteria:**

- Purchase-to-receipt-to-bill traceability works.
- Supplier prices cannot leak into sales pricing.
- Supplier bill/payment/credit allocations remain consistent and audited.
- Receiving stock is not duplicated on job/API retry.

## Phase 19-S.14 — Warehouses, Stock Ledger, Adjustments, Transfers, Reservations

**Goal:** Implement inventory foundations around an auditable movement ledger.

Tasks:

1. Add Inventory setting and explicit enablement guard.
2. Register Warehouse, Inventory Transaction, Inventory Adjustment, Transfer Order/Item and Inventory Reservation records.
3. Implement on-hand, reserved, available and incoming quantity semantics and document them.
4. Make stock movements append-only; represent correction as a compensating movement.
5. Add controlled stock adjustment with reason/permission and optional approval.
6. Add two-sided warehouse transfer with correct source/destination effects and safe intermediate state if asynchronous transfer completion is used.
7. Add reserve, soft-reserve, release-reservation and allocation logic where required by order state.
8. Protect against overselling under concurrent order confirmation with row-level/atomic reservation rules.
9. Add inventory history, product/warehouse filters and basic stock reporting.
10. Add a reconciliation command/report comparing stock projections with the transaction ledger; never auto-correct discrepancies without review.

**Acceptance criteria:**

- All physical quantity changes have a traceable transaction and source/reason.
- Concurrent reservations cannot overbook stock under the configured policy.
- Transfer source and destination effects stay consistent.
- Stock figures can be reconciled and explained from movements.

## Phase 19-S.15 — Product Variants, Batch/Serial Tracking, Removal Policies

**Goal:** Add more advanced stock identity and fulfilment logic.

Tasks:

1. Add configurable product variant attributes and variant SKU validation if not included earlier.
2. Add batch/lot and serial tracking models and relevant relationship panels.
3. Add expiry/manufacturing date validation where those fields are used.
4. Implement configured picking/removal policy such as FIFO, FEFO or LIFO with deterministic ordering.
5. Enforce serial number uniqueness in the appropriate organization/warehouse scope.
6. Connect receipt/delivery/return/transfer transactions to batch/serial quantities.
7. Expose availability/picking suggestions in the line editor when enabled.
8. Keep the non-batch/non-serial product path fully functional.

**Acceptance criteria:**

- Inventory identity remains correct per product variant, batch or serial.
- Expired/invalid lots are not selected when the configured policy forbids them.
- Transfers and returns preserve batch/serial traceability.

## Phase 19-S.16 — Subscriptions and Recurring Invoice Generation

**Goal:** Deliver recurring billing without duplicate documents or uncontrolled external side effects.

Tasks:

1. Register Subscription and Subscription Period entities with their lifecycle metadata.
2. Define supported billing intervals, period boundaries, lead time, renewal/cancellation behavior and date/time conventions.
3. Implement creation of due periods through the platform job system.
4. Implement idempotent invoice creation from an eligible period using the shared invoice service.
5. Record planned invoice date, invoice date, generated Invoice ID, attempt count, failure code and retry state.
6. Handle pending, active, paused, ended, cancelled, billing-failed and renewed states according to the feature contract.
7. Prevent duplicate periods and invoices using stable idempotency keys/unique constraints and transactional job claims.
8. Add manual authorized retry and a safe preview of expected periods/invoices.
9. Add subscription and period views, invoice relationship panels and billing-failure notifications as optional platform jobs/notifications allow.
10. Add integration events for Customer Success and Accounting consumers.

**Acceptance criteria:**

- A job replay cannot create duplicate periods/invoices.
- Period dates and invoice dates respect the configured lead time and timezone semantics.
- Failed period processing is visible and can be retried safely.
- No automatic charge or live email occurs without a separately approved integration/notification rule.

## Phase 19-S.17 — PDFs, Email, Line-Item UX, Admin Settings, and Navigation Polish

**Goal:** Complete end-to-end usability across sales and purchase documents.

Tasks:

1. Review every entity's list, detail, edit, create, search, filter, sorting, pagination, relationship panels and ACL-aware actions.
2. Complete the shared line-item editor, price picker, tax preview, totals panel and conflict/error rendering.
3. Register standard PDF templates and reusable tokens for each supported document type through the existing template system.
4. Use existing mail infrastructure to send documents with explicit preview/recipient confirmation and audit.
5. Add navigation groupings, module enablement checks, list/detail panel configuration and context actions.
6. Add admin configuration for document numbering, lock policies, payment terms, enabled features, inventory rules, tax rules and subscription settings.
7. Add translations using namespaced `sales.*` keys through existing i18n conventions; author original project translations instead of copying upstream translation files.
8. Verify responsive, keyboard accessible and empty/error/loading states.
9. Add safe import/export mappings for eligible master data and document types, honoring ACL and issuance rules.

**Acceptance criteria:**

- A user can complete supported sales flows in the UI without raw API calls.
- Issued documents render from saved snapshots.
- Sending is explicit and testable without external side effects.
- Admin settings validation and module navigation respect permissions and dependencies.

## Phase 19-S.18 — Reporting, Dashboard, Search, Import/Export, and Operational Views

**Goal:** Make commercial activity monitorable and searchable.

Tasks:

1. Register Sales report datasets and metrics with the generic Report subsystem.
2. Add standard dashboard/dashlet definitions using the shared dashboard engine.
3. Implement quote conversion, invoice aging, payments/allocations, credit/write-off, supplier, inventory and subscription summaries as their prerequisites become available.
4. Ensure base-currency aggregation uses persisted conversion snapshots and clearly labels values.
5. Apply ACL in query plans, export jobs, report outputs and downloaded files.
6. Add saved filter support and indexes for observed important query paths.
7. Provide import/export for products, prices, suppliers, and selected document types while preventing unsafe import of issued-state transitions or arbitrary balances.
8. Add job-monitoring views for recurring billing, stock reconciliation, PDF generation and any batch operations.

**Acceptance criteria:**

- Sales analytics are ACL-aware and do not aggregate currencies ambiguously.
- Exports only include records and fields the requesting user may access.
- Imports validate values through the same domain services used by UI/API operations.
- Reports reconcile with source documents and allocation ledgers for tested scenarios.

## Phase 19-S.19 — Integrations and Compatibility Contracts

**Goal:** Publish and verify stable interfaces for dependent modules.

Tasks:

1. Finalize provider-neutral Payment Request / Payment Provider Event contracts for `StripeIntegration`.
2. Add accounting export/event contract for `AccountingIntegration`, including invoice/credit/payment/supplier bill references, tax snapshots and external sync status.
3. Add read-only customer commercial summary adapter for `CustomerSuccess`.
4. Add optional links to CRM Core Opportunities, Projects and Activities using existing relationships.
5. Add Reports, Workflow and BPM registration through the generic extension points.
6. Verify the module bootstraps when every optional module is absent; verify optional consumers behave when enabled.
7. Add event schema versioning, delivery retries, idempotency and correlation IDs.
8. Document compatibility contract in `docs/integrations/sales-contracts.md`.

**Acceptance criteria:**

- Stripe is a consumer/provider integration; Sales itself does not embed gateway credentials or SDK calls.
- Accounting and Customer Success can use documented contracts without querying Sales private tables.
- Optional dependencies do not break startup or core Sales flows.
- Duplicate events and retries do not duplicate invoices, payments, allocations, stock movements or external sync records.

## Phase 19-S.20 — Security, Performance, Data Safety, and Release Readiness

**Goal:** Prove Tier 1 is safe and bring the selected tiers to production-quality acceptance.

Tasks:

1. Run unit tests for pricing, tax, totals, document state machines, numbering, allocations, inventory and subscription idempotency.
2. Run integration tests against the existing configured primary database, after inspecting test lifecycle scripts and selecting narrowly scoped, non-destructive commands.
3. Run API tests for unauthenticated, unauthorized, record-level, team-level, field-level and admin-only operations.
4. Run UI tests for quote-to-order, order-to-invoice, issue/lock, payment allocation, credit allocation, and any completed inventory/subscription flows.
5. Verify no generic CRUD endpoint can bypass domain transitions or change immutable issued fields.
6. Review migrations for locks, backfills, data preservation, index creation, rollback implications and execution cost.
7. Run safe static analysis, lint, type checking, dependency audit and build checks.
8. Inspect SQL/query plans for product search, price resolution, invoice lists/aging, allocation balance, stock availability and subscription job selection.
9. Verify logs/events do not leak credentials, payment secrets, full provider payloads or unnecessary personal data.
10. Review job retries and idempotency under simulated duplicate requests/events.
11. Test backup/restore compatibility using the project's established process only; do not create a new database just for tests and do not overwrite the configured database.
12. Produce a gap report listing deferred Tier 2/3/4 features and unresolved jurisdiction/accounting items.

**Acceptance criteria:**

- All completed-tier acceptance criteria are met with recorded evidence.
- No new test database/schema exists.
- No destructive migration is applied without explicit approval.
- No external payment/email/shipment side effect was triggered by tests.
- `Sales` starts successfully with required dependencies and without optional modules.
- Security, operational docs and release checklist are complete.

---

## 15. Testing Strategy

Tests must complement the shared test conventions in `AGENTS.MD` and `PLAN.md`. Every test involving a money, document, payment, tax, or inventory invariant must include at least one negative/invalid case.

### 15.1 Unit tests

- Decimal arithmetic, currency precision, rounding policy, inclusive/exclusive tax, discount order and tax selection.
- Price book tie-break, quantity ranges, validity windows, currency mismatch and no-price behavior.
- Product active/sellable/purchasable validation.
- Each document's lifecycle/state-transition table.
- Issuance number allocation policy and snapshot content selection.
- Payment allocations, credit allocations, write-off approval and amount-due calculation.
- Inventory on-hand/reserved/available calculations, FIFO/FEFO/LIFO choice and transfer movement plan.
- Subscription period boundaries, lead-time logic and idempotency-key construction.
- Event schema serialization and access-controlled output projections.

### 15.2 Integration tests

Use the existing configured primary project database as described in `AGENTS.MD`. Before execution, inspect test setup/teardown and commands for any `CREATE DATABASE`, `DROP DATABASE`, `TRUNCATE`, automated reset, shadow DB or seed-wide-delete behavior. Do not execute a test mode that creates another database or destroys unrelated data.

- Metadata and migration registration.
- Product and category CRUD through the Entity Engine.
- Price Book loading and price resolution query behavior.
- Quote conversion with item snapshots.
- Invoice issuance with unique number and lock state.
- Payment/credit allocations under transactional locking.
- Inventory transaction creation and reservation consistency.
- Subscription job claims and duplicate suppression.
- Optional integration boot/contract tests.

Use explicit `AGENT_TEST_<RUN_ID>_...` markers and unique test record IDs. Cleanup may only remove data created by the current run with exact recorded IDs and after verifying that no other record references them. Do not use real customer records.

### 15.3 API and authorization tests

Test, at minimum:

- Unauthenticated access.
- Authenticated user without module permission.
- User with read but no create/edit permission.
- Record outside user's team/ownership scope.
- Field-level restriction for cost/margin/sensitive payment metadata.
- Generic endpoint attempting to bypass `issue`, `confirm`, `unlock`, `allocate`, `write-off`, `stock-adjust`, and `cancel` command rules.
- Stale version/concurrent update conflicts.
- Invalid currency, negative/too-precise quantity, invalid tax, duplicate document number, over-allocation and over-reservation.
- Export/report ACL and document PDF permission checks.

### 15.4 UI tests

- Build a product and a price book; preview the resolved price.
- Create a quote and convert it to an order.
- Confirm an order and create an invoice.
- Issue/lock an invoice and verify protected fields cannot be edited.
- Record a payment and allocate it to an invoice; verify amount due.
- Issue/allocate a credit note and verify balances.
- Confirm delivery/return movements when inventory is available.
- Create a subscription and verify one generated period/invoice under a simulated job run.
- Verify states, empty views and permission-denied behavior.

### 15.5 External side-effect tests

- Replace provider calls with fake adapters.
- Email tests capture messages in memory/local test transport; they do not send real email.
- Payment requests use fake provider IDs and fake webhook signatures/events.
- Inventory tests use explicit test products/warehouses and clean up only exact current-run records.
- Do not trigger real payment, refund, bank debit, shipment or customer communication.

### 15.6 Regression and compatibility tests

Maintain a behavior matrix with:

- Scenario name and reference source/version.
- Preconditions/configuration.
- Input document/product/price/tax/currency facts.
- Expected status transition, calculation, side effects and snapshot values.
- Observed NestJS result.
- Compatibility level: behavioral, API, metadata, or intentionally different.

Do not mark a behavior as compatible solely because the UI looks similar. Verify totals, state transitions, access checks and historical immutability.

---

## 16. Performance, Reliability, and Observability

### 16.1 Performance

- Product lookup and SKU search should remain responsive at realistic catalog sizes; use indexed fields and bounded pagination.
- Avoid N+1 queries in line-item editors and document detail pages.
- Load large item lists with explicit page limits or appropriate virtualization/pagination.
- Ensure invoice aging, allocation balance, stock availability and recurring-period queries use appropriate indexes and measured query plans.
- Tax/price preview should accept a bounded request size and reject oversized payloads.
- Bulk import/price update should use bounded batches and report partial failure clearly.
- Inventory ledger reports may require date/product/warehouse indexes and pagination; never return an unbounded movement history in a single API response.

### 16.2 Observability

Use the platform's structured logging/metrics/tracing conventions. Add domain context such as entity ID, document number, operation type, correlation ID, actor/system identity, and job ID—without logging secrets or unnecessary customer payment data.

Track:

- Quote conversion outcomes and processing errors.
- Invoice issue/lock/unlock/void counts and failures.
- Payment allocation conflicts, unapplied amounts, and duplicate provider events.
- Subscription billing attempts, duplicate suppression, failures and retries.
- Inventory reservations denied, negative-stock overrides, ledger reconciliation mismatches, and transfer failures.
- PDF render/email send failures without exposing content/secrets.
- Slow queries and query failures on critical commercial flows.

### 16.3 Reliability rules

- Use transactional outbox/job processing for asynchronous consumers where available.
- All retryable commands and jobs need a defined idempotency strategy.
- Preserve failure records for operational repair; don't silently swallow exceptions.
- Distinguish retriable infrastructure errors from non-retriable domain validation errors.
- A failed external accounting sync must not roll back an already-issued invoice; show a separate sync status and provide retry/reconciliation.

---

## 17. Data Migration and Upgrade Strategy

### 17.1 Fresh installation

- Install module manifest and additive migrations using the platform's standard installer.
- Register metadata/layouts/settings/translations only after dependency checks pass.
- Do not ship broad demo data in production migrations.
- Seed only minimal reference data explicitly approved for default installs, such as safe statuses or built-in configuration; make it idempotent.

### 17.2 Upgrade

- Version schema changes using the existing migration framework.
- Preserve products, prices, issued documents, item snapshots, payments, allocations, subscriptions and inventory ledger history.
- Do not rebuild document numbers or recalculate issued document totals during migration.
- Add backfills in bounded and resumable chunks when necessary.
- Log migration progress and make failure/repair state clear.

### 17.3 Uninstall/disable

- Disabling `Sales` should stop routes/jobs/menus while preserving data.
- Uninstall must not delete financial records by default. If physical data removal is ever proposed, treat it as a separately approved destructive operation with an export/backup and explicit policy.
- Do not allow optional integration removal to delete or corrupt Sales records.

### 17.4 Data import from EspoCRM

If migration from an EspoCRM installation is part of scope, implement it as a separate controlled tool after the baseline Sales model is stable:

- Map source document type, IDs and source relationships to new internal IDs.
- Preserve source IDs in external reference fields when policy permits, not as primary-key assumptions.
- Import products/prices before documents; import payment/allocation and inventory history with their dependencies.
- Preserve issued numbers, source currency, item tax/price snapshots, issue timestamps, and conversion/relationship lineage where available.
- Reconcile counts and balances; produce a mismatch report before finalizing.
- Never modify an existing source installation in place.

---

## 18. Documentation Deliverables

Create and maintain:

- `docs/implementation/sales-repository-audit.md`
- `docs/modules/sales/overview.md`
- `docs/modules/sales/product-catalog-and-pricing.md`
- `docs/modules/sales/commercial-documents.md`
- `docs/modules/sales/money-tax-currency.md`
- `docs/modules/sales/payments-and-allocations.md`
- `docs/modules/sales/purchases-and-inventory.md`
- `docs/modules/sales/subscriptions.md`
- `docs/modules/sales/permissions.md`
- `docs/modules/sales/api.md` or generated OpenAPI link
- `docs/modules/sales/operations-and-troubleshooting.md`
- `docs/integrations/sales-contracts.md`
- `docs/compatibility/sales-reference-matrix.md`

Documentation must explain which features are implemented, which require optional modules, what the reference baseline is, and what has intentionally not been implemented. Avoid claiming exact parity without test evidence.

---

## 19. Definition of Done

`Sales` is considered complete for the selected delivery tier only when all applicable items are true:

- Module manifest, load lifecycle, metadata, settings, ACL and module health checks are complete.
- Product/catalog and price resolution rules are deterministic, permission-aware and auditable.
- Monetary calculations use decimal-safe arithmetic and canonical currency-aware values.
- Quotes, orders, invoices, payments, credits, and other selected documents follow valid domain state machines.
- Issued documents have stable numbers, snapshots and correct locking/correction behavior.
- Balances derive from transactions/allocations and are concurrency-safe.
- Inventory movements, if included, are ledger-based, idempotent and reconcilable.
- Subscription jobs, if included, are idempotent and have operational failure visibility.
- REST API, OpenAPI, UI, search/filter, imports/exports and reports respect ACL.
- Events and integration contracts are documented and versioned.
- Tests include invalid states, permissions, concurrency and duplicate retry paths.
- No test database/schema or per-run database was created.
- No real external payment, email, or shipment side effect was triggered by tests.
- Existing data and unrelated user changes have been preserved.
- Migrations are reviewed, additive when possible, and not destructive by surprise.
- Documentation and a tested compatibility matrix are current.
- Remaining limitations are listed explicitly and not represented as implemented features.

---

## 20. Recommended Coding-Agent Execution Prompt

Use this prompt when starting implementation:

> Read `AGENTS.MD`, `PLAN.md`, and `PLAN_Phase_19_Sales.md`. Execute **Phase 19-S.0 only**: audit the actual codebase, existing core CRM entities, module conventions, money/currency implementation, migration history, test lifecycle, and all relevant dependencies. Create `docs/implementation/sales-repository-audit.md` with verified source locations, prerequisites, integration boundaries, and a feature compatibility contract. Do not implement later phases yet. Do not create a database or schema. Do not run destructive setup or reset scripts. Preserve existing data and all uncommitted user changes. Report commands inspected, findings, blockers, and recommended next phase.

---

## 21. Reference URLs and Baseline Notes

The Sales Pack documentation lists Products, Prices, Quotes, Sales Orders, Invoices, Credit Notes, Delivery Orders, Return Orders, Write-offs, Subscriptions, Suppliers, Purchase Orders, Receipt Orders, Bills, Bill Credits, Inventory Management, Payments, Taxes, Tax Codes, Issuance Locking, Multi-Currency, Reports, and API functionality.

The Sales Pack release notes page lists version 4.4.0 dated August 25, 2026, including payment-to-payment allocations, payment terms profiles for Quotes and Sales Orders, invoice period start/end fields, and line-item pagination improvements. Version 4.0 introduced/expanded subscriptions, tax codes, tax-inclusive pricing, true multi-currency, supplier bills/credits, credit-note allocations, write-offs, debit notes, payment terms, invoice rounding, and issuance locking. Treat this as the current listed reference baseline at the date written, and re-check the official release notes during Phase 19-S.0 before finalizing behavior contracts.

- Sales Pack Overview: <https://docs.espocrm.com/extensions/sales-pack/overview/>
- Sales Pack Release Notes: <https://www.espocrm.com/extensions/sales-pack/release-notes/>
- Products: <https://docs.espocrm.com/user-guide/products/>
- Prices: <https://docs.espocrm.com/extensions/sales-pack/prices/>
- Sales Management: <https://docs.espocrm.com/user-guide/sales-management/>
- Quotes: <https://docs.espocrm.com/user-guide/quotes/>
- Sales Orders: <https://docs.espocrm.com/user-guide/sales-orders/>
- Invoices: <https://docs.espocrm.com/user-guide/invoices/>
- Payments: <https://docs.espocrm.com/extensions/sales-pack/payments/>
- Taxes: <https://docs.espocrm.com/extensions/sales-pack/taxes/>
- Tax Codes: <https://docs.espocrm.com/extensions/sales-pack/tax-codes/>
- Inventory Management: <https://docs.espocrm.com/extensions/sales-pack/inventory-management/>
- Sales Pack API: <https://docs.espocrm.com/extensions/sales-pack/api/>

**Compliance reminder:** Follow the clean-room rules in `PLAN.md` and `AGENTS.MD`. Official documentation is a behavioral reference. Do not copy upstream code, assets, translations, trademarks, or non-permitted content. Check licensing and target-market tax/e-invoicing requirements with qualified counsel or specialists where distribution/compliance questions arise.
