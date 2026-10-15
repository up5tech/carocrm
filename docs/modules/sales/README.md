# Sales module (Phase 19-S)

Implemented in `apps/api/src/sales` (backend) with metadata in `database/seed-metadata.ts`, seeds in
`database/seed.ts` and migrations `database/migrations/021_phase19_sales.sql` +
`022_phase19_sales_module_rename.sql`. Functional reference: EspoCRM Sales Pack documentation
(<https://docs.espocrm.com/extensions/sales-pack/overview/>), reproduced as clean-room TypeScript
behaviour.

**Status: the commercial foundation (19-S.0 – 19-S.5), the shared document engine (19-S.6) and the
quotes, sales orders, invoices and payments phases (19-S.7 – 19-S.10).** The authoritative scope and
the phase-by-phase roadmap live in [`PLAN_Phase_19_Sales.md`](../../PLAN_Phase_19_Sales.md); the list
of phases actually claimed is `SALES_MODULE.implementedPhases` in
`apps/api/src/sales/sales-module.ts`, and `/api/v1/Sales/action/health` reports it. Credit notes,
delivery/return orders, purchases, inventory and subscriptions have their descriptors and the generic
engine but not their own remaining work, and are **not** claimed.

## What it gives a user

| Capability | Where |
|---|---|
| Products and services with SKU, type, unit, active/sellable/purchasable flags and optional unit/list/cost prices | `/Product` list and detail (generic metadata-driven UI) |
| Hierarchical product categories with cycle and depth protection | `/ProductCategory` |
| Price books with currency, effective window and priority, plus entries with quantity breaks | `/PriceBook`, `/PriceBookEntry` |
| Declarative price rules (percentage / fixed / set-price adjustments) with deterministic ordering | `/PriceRule` |
| Suppliers and supplier purchase prices, kept separate from sales prices | `/Supplier`, `/SupplierProductPrice` |
| Tax classes, tax codes, tax rates and tax rules with effective windows and priorities | `/TaxClass`, `/TaxCode`, `/TaxRate`, `/TaxRule` |
| Module health, settings, numbering state, price resolution, bulk price update and totals preview | `/api/v1/Sales/action/*` |
| Stream, notes, attachments, audit history and field-level permissions | inherited from the kernel, no module code |

Records are ordinary metadata entities, so list/detail/create/edit/delete, search, filters, saved
filters, import/export and ACL come from the Entity Engine. Dedicated Sales screens are later work.

## Module layout

```text
apps/api/src/sales/
  sales-module.ts                module descriptor: id `sales`, version, load order, apiPrefix, phases
  sales.controller.ts            domain commands (`/api/v1/Sales/action/*`)
  sales-module-health.service.ts dependency evidence, optional integrations, feature flags, checks
  sales-settings.service.ts      the validated, versioned `sales` settings document
  sales-records.ts               allowlisted structural reads over the module's own entities
  clock.ts                       one date convention (`YYYY-MM-DD`, UTC default)
  catalog/                       product/category/price-book rules + their `beforeValidate` hook
  pricing/                       price rule engine, deterministic resolution, audited bulk update
  money/                         decimal-safe arithmetic and the currency scale contract
  tax/                           rule matching, rate selection, totals engine, preview service
  document/                      number series, immutable snapshots, issued-document locking,
                                 the quote block model and the quote render/send service
  dto/sales-shapes.ts            Zod request shapes
```

Nothing in `apps/api/src/sales` reimplements a kernel subsystem: no second ORM, ACL engine, scheduler,
settings store, audit log or currency module.

## Default data

`database/seed.ts` inserts the ten document number series once, with `ON CONFLICT DO NOTHING` and
never on boot: `quote` (`Q-`), `salesOrder` (`SO-`), `invoice` (`INV-`), `creditNote` (`CN-`),
`deliveryOrder` (`DO-`), `returnOrder` (`RO-`), `purchaseOrder` (`PO-`), `receiptOrder` (`GRN-`),
`bill` (`BILL-`), `billCredit` (`BC-`). The same list is the single source of truth for the runtime
service (`document/number-series-defaults.ts`), so seeded and runtime series cannot drift.

No demo products, price books or tax rules are ever created.

## Behaviour guarantees worth knowing

* A **missing price is never zero** — the default policy refuses the line; `allowExplicit` returns an
  explicitly *unresolved* result.
* A **missing tax is never zero** unless `tax.missingTaxPolicy` is deliberately set to `zero`.
* **Supplier prices can never become a sales price** — they live in a separate entity that price
  resolution does not read.
* **Two equally specific, equal-priority price rules are a conflict**, not an arbitrary winner.
* **Numbers are allocated at issuance** by default, and a retried allocation for the same document
  returns its existing number instead of consuming a second one.
* **Settings changes bump a version**, so a stored document snapshot can name the policy it was
  produced under.

## Document engine (19-S.6 – 19-S.12, in progress)

The shared mechanics live in `apps/api/src/sales/document` and are driven by a **descriptor per
document kind**, so a document type is data rather than a copy of the engine:

| Piece | What it does |
|---|---|
| `descriptors.ts` | state machine, allowed transitions, the issuing transition, conversions and lock policy for quote, sales order, invoice, credit note, delivery order and return order |
| `line-items.ts` | typed line validation, item-record payloads, ordered items, remaining-quantity guards |
| `document.service.ts` | create / update / recalculate / transition / issue / unlock / convert — every number server-calculated, every write through the Entity Engine |
| `lock.ts`, `snapshot.ts` | protected fields, privileged unlock with a reason, and the frozen commercial snapshot an issued document is rendered from |
| `numbering.service.ts` | atomic number allocation, once per document, retry-safe |

Commands (all under the module's own prefix):

```text
POST   /api/v1/Sales/document                      create a draft with typed line items
GET    /api/v1/Sales/document/:kind/:id            document + items + totals + allowed actions
PATCH  /api/v1/Sales/document/:kind/:id            update a draft (header and/or lines)
POST   /api/v1/Sales/document/:kind/:id/transition named transition (issue, confirm, send, void, …)
POST   /api/v1/Sales/document/:kind/:id/unlock     privileged unlock, reason required
POST   /api/v1/Sales/document/:kind/:id/convert    convert to another kind, idempotent
POST   /api/v1/Sales/document/:kind/:id/recalculate server-side recalculation
DELETE /api/v1/Sales/document/:kind/:id            delete a **draft** only
```

`kind` is one of `quote`, `salesOrder`, `invoice`, `creditNote`, `deliveryOrder`, `returnOrder`.

**Implemented:** the engine, the six descriptors, the document + item metadata
(`database/seed-metadata.ts`), migration `023_phase19_sales_documents.sql`, and the routes above.

**Not implemented yet — and deliberately not claimed by `implementedPhases`:** credit allocation and
write-offs (19-S.11), stock movement for delivery/return (19-S.12, with inventory still disabled),
and PDF *attachments* on a sent document. A PDF renderer exists (`@carocrm/document`'s optional
`pdfkit` adapter walks the same block model the text rendering uses), but turning a rendered PDF into
an outbound attachment needs the attachment-storage path, which is not built.

### Sales orders (19-S.8) and invoices (19-S.9)

| Requirement | Status |
|---|---|
| Order/Invoice + item metadata, layouts, ACL, relationship panels | done (items, generated invoices/delivery/return orders, allocations, credit allocations, write-offs) |
| Order lifecycle `draft → confirmed → partiallyFulfilled → fulfilled`, cancel before fulfilment | done |
| Fulfilment state | **derived**, not typed: `SalesDocumentService.refreshFulfilment()` computes it from the confirmed delivery orders' quantities against the order's own lines, and `POST /api/v1/Sales/salesOrder/:id/refreshFulfilment` runs it. Idempotent. |
| Creation from a quote / sales order / manually | done (`convertToOrder`, `convertToInvoice`, manual create). Opportunity-as-source creation is **not** implemented. |
| Payment terms, issue/due dates, service period, addresses, shipping, tax, items, totals | done — a due date is **computed** from the referenced `PaymentTermProfile` (`net` or `endOfMonth` + days, `apps/api/src/sales/document/terms.ts`); an explicit due date always wins |
| Issuance in one transaction (recalculate, snapshot, number, issuer/time, lock, event) | done |
| Document status vs payment status | separate fields; `paymentStatus` is derived from allocations/credits/write-offs and the due date |
| Amount due from allocations, never from a client | done (`AllocationService.syncDocument`) |
| Overdue detection + notification event + job | done — `markOverdueInvoices()`, an admin route, a worker route and the `sales.markOverdueInvoices` job on a daily cron. Idempotent: an already-overdue invoice is not a candidate. |
| Void/correction and privileged unlock | done (`void` with a reason; `unlock` needs the permission plus a reason) |
| Conversion double-billing protection | done — one generated document per (source, destination kind), and a quote that already became an order cannot also be invoiced directly |
| Stock effects on confirmation | **explicitly refused** while `features.inventory` is on, because reservations arrive with 19-S.14. With the flag off (the default) there is no stock consequence and the code says so rather than pretending. |
| Creation from an Opportunity / a Subscription Period | not implemented (the subscription source arrives with 19-S.16) |
| PDF / email / e-invoice adapter contracts | blocked — no document template system in the kernel |
| Tests | not written for the API side |

### Quotes (19-S.7) — where it stands

| Requirement | Status |
|---|---|
| Quote + QuoteItem metadata, layouts, relations, ACL | done — plus `items`, `salesOrders` (generated orders, via `mappedBy: 'source'`) and the Account-side `quotes` panel |
| Links to Account, Contact, Opportunity, Price Book, generated documents | done (links on the document, relations both ways) |
| Lifecycle, valid-until, accepted/rejected/converted rules, audit | done — `draft → sent → accepted/rejected/expired/converted/cancelled`, with audit from the Entity Engine |
| Server-side recalculation of lines | done |
| Safe conversion to a sales order with lineage and duplicate protection | done (`convertToOrder`, idempotent on `correlationId`, unique index behind it) |
| Idempotent expiry | **done** — `SalesDocumentService.expireOverdueQuotes()`, an administrator route (`POST /api/v1/Sales/action/expireQuotes`) and a worker-authorized one (`…/action/expire-quotes`), the `sales.expireQuotes` job in `apps/worker/src/handlers/sales-handlers.ts`, and a daily `scheduled_jobs` row seeded by `database/seed.ts`. Idempotent by construction: only a `sent` quote is a candidate, and expiring takes it out of that state. |
| PDF template selection, preview, email-send action | **done** — `POST /api/v1/Sales/quote/:id/render` renders the quote through the kernel `document` module (a named `DocumentTemplate`, or the built-in block layout when the entity type has no template); `POST /api/v1/Sales/quote/:id/send` issues a draft quote and queues an `Email` through the mail module. See below. |
| Line-item editor | frontend work, deferred to 19-S.17 |
| Tests for expiry, stale prices, ACL, send side-effects, conversion retries | **written** — `apps/api/test/sales-quote-document.test.ts` (the block model, pure) and `apps/api/test/sales-quotes.test.ts` (render, send side effects, no-provider refusal, ACL, a frozen price after the price book moves, expiry, conversion retries). The worker's `sales-handlers` suite still covers the expiry job itself. |

### Rendering and sending a quote (19-S.7)

```text
POST /api/v1/Sales/quote/:id/render   render against a template (or the built-in layout)
POST /api/v1/Sales/quote/:id/send     issue a draft quote, then email it
```

* **Rendering reuses the kernel.** `DocumentTemplate` is a record and `@carocrm/document` is the
  renderer, so a quote does not invent a second template syntax. The result carries the rendered
  subject/body, the plain-text rendering, **the block model**, and whether the optional PDF renderer
  can be loaded — so a PDF path needs no new service.
* **An unresolved placeholder is left in place and reported in `warnings`**, never blanked.
* **An issued quote renders from its frozen snapshot** — a price book that moves afterwards changes
  what a *new* quote gets, never what was sent.
* **Sending is explicit and refuses to lie.** A disabled mail transport, a caller without `Email`
  create/edit access, a missing recipient, or a state that cannot be sent is refused *before* the
  quote is issued, so a quote is never marked `sent` with no email behind it. When a quote is already
  `sent`, `send` re-renders from the snapshot and records a **new** `Email` (a send is a log entry, not
  an edit of the document) and reports `issued: false`.
* The `Email` record is linked to the quote through `parentType`/`parentId` and is queued by
  `EmailService`, which owns validation and the per-recipient delivery ledger. The API never opens a
  socket: the worker sends.
* **Permissions this needs**, all of them existing kernel checks: `read` on the quote, `read` on
  `DocumentTemplate` (the template is what gets rendered, so a role that sends quotes needs it),
  `read` on the referenced Account/Contact for a draft, and `create` + `edit` on `Email`.

## Payments and allocation (19-S.10)

`apps/api/src/sales/payments` records money that has already moved and applies it to documents. **No
handler in this module talks to a payment gateway** — that is a provider module's job, and the contract
with it is deliberately narrow.

| Piece | What it does |
|---|---|
| `allocation-math.ts` | pure: a payment's balance, a document's outstanding amount, over-allocation and cross-currency refusals, and the *derived* invoice payment status |
| `payment.service.ts` | record/confirm/cancel a payment; payment methods and channels; payment requests; idempotent provider-event ingestion |
| `allocation.service.ts` | allocate / unallocate / transfer, each in one transaction that locks the payment row then the document row |

Key rules:

* **Balances are derived, never supplied.** `allocatedAmount`, `unallocatedAmount`, `allocationStatus`,
  an invoice's `amountDue` and `paymentStatus` are all recomputed from the allocation rows. The write
  guard (`sales-write-guard.service.ts`) refuses those fields on the generic `/api/v1/:entity` path, so
  a crafted request cannot forge a paid invoice.
* **A payment must be `confirmed` and a document `issued`** before anything can be allocated.
* **Over-allocation is refused with both remainders attached**; a payment cannot go negative, and an
  invoice cannot be over-settled — the excess belongs to the payment's unapplied amount.
* **Cross-currency allocation needs an exchange-rate snapshot**; without one the amounts are not
  comparable and the allocation is refused.
* **Provider events are idempotent** on `(provider, providerEventId)`, backed by a unique index. A
  webhook delivered twice creates no second payment and no second allocation.
* **Card data, mandates and reusable secrets are refused**, not stored: any payload key matching
  `card|cvc|cvv|pan|iban|bic|secret|token|password|private key|mandate` is rejected before the row is
  written.
* **A payment-to-payment transfer is its own record** (`PaymentTransferAllocation`), not a negative
  allocation.

Commands: `POST /api/v1/Sales/payment`, `GET|PATCH /api/v1/Sales/payment/:id`,
`POST …/payment/:id/transition`, `…/payment/:id/allocate`, `…/payment/:id/transfer`,
`GET …/payment/:id/allocations`, `DELETE /api/v1/Sales/allocation/:id`,
`GET /api/v1/Sales/allocatableInvoices`, `POST /api/v1/Sales/paymentRequest`,
`…/paymentRequest/:id/transition`, `POST /api/v1/Sales/providerEvent`.

## Verification

```bash
pnpm typecheck && pnpm lint
# Pure: no database, no clock, no socket.
pnpm vitest run apps/api/test/sales-terms.test.ts apps/api/test/sales-fulfilment.test.ts \
  apps/api/test/sales-allocation-math.test.ts apps/api/test/sales-quote-document.test.ts
# API, against the configured primary database.
pnpm vitest run apps/api/test/sales-module.test.ts apps/api/test/sales-catalog.test.ts \
  apps/api/test/sales-pricing.test.ts apps/api/test/sales-tax.test.ts \
  apps/api/test/sales-money.test.ts apps/api/test/sales-documents.test.ts \
  apps/api/test/sales-payments.test.ts apps/api/test/sales-quotes.test.ts
# The worker has its own vitest config, so its suites are not collected by the root one.
cd apps/worker && pnpm vitest run src/handlers/sales-handlers.test.ts
```

`sales-quotes.test.ts` boots the app with `MAIL_TRANSPORT=memory` and `SMTP_FROM` set, and stubs the
BullMQ producer, so it never sends mail and never needs a Redis server; both env vars are restored in
`afterAll`.

The API suites target the configured primary database and create only `AGENT_TEST_<runId>` records that
they delete again by exact id. See
[../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) §10 for
what was and was not executed when this module was last touched.

**Coverage, honestly:** `sales-terms`, `sales-fulfilment`, `sales-allocation-math` and
`sales-quote-document` test the pure math and the pure block model; `sales-documents` covers the
create → issue → lock → convert → void lifecycle and the write guard that stops a crafted request
forging a computed field; `sales-quotes` covers rendering, the send side effects, the no-provider and
ACL refusals, a price frozen at issuance, expiry and conversion retries; `sales-payments` covers
allocation both ways, over-allocation, unallocation and provider-event idempotency; the worker suite
covers the expiry job. Still **not** covered: 19-S.11 (credit notes and write-offs) and 19-S.12
(delivery/return) beyond their descriptors, and the `markOverdueInvoices` job.

## Deeper documents

* [overview.md](overview.md) — what the module is, its boundary, and the tier roadmap
* [product-catalog-and-pricing.md](product-catalog-and-pricing.md) — catalog, price books, rules, resolution
* [money-tax-currency.md](money-tax-currency.md) — decimal rules, currency scales, tax engine, totals
* [api.md](api.md) — the domain commands and their payloads
* [permissions.md](permissions.md) — who may do what, with worked examples
* [../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) — the 19-S.0 audit
