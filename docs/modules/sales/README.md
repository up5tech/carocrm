# Sales module (Phase 19-S)

Implemented in `apps/api/src/sales` (backend) with metadata in `database/seed-metadata.ts`, seeds in
`database/seed.ts` and migrations `database/migrations/021_phase19_sales.sql` through
`028_phase19_sales_inventory.sql`. Functional reference: EspoCRM Sales Pack documentation
(<https://docs.espocrm.com/extensions/sales-pack/overview/>), reproduced as clean-room TypeScript
behaviour.

**Status: the commercial foundation (19-S.0 – 19-S.5), the shared document engine (19-S.6), the
quotes, sales orders, invoices and payments phases (19-S.7 – 19-S.10), credit notes and write-offs
(19-S.11), delivery and return orders (19-S.12) and the purchasing half — suppliers, purchase orders,
receipt orders, supplier bills and bill credits (19-S.13) — and the inventory foundations (19-S.14):
warehouses, the append-only stock ledger, reviewed adjustments, two-sided transfers and
concurrency-safe reservations, which is what now applies the movement plans a confirmed document
freezes.** The authoritative scope and the phase-by-phase roadmap live in
[`PLAN_Phase_19_Sales.md`](../../PLAN_Phase_19_Sales.md); the list of phases actually claimed is
`SALES_MODULE.implementedPhases` in `apps/api/src/sales/sales-module.ts`, and
`/api/v1/Sales/action/health` reports it. Batch/lot and serial tracking (19-S.15) and subscriptions
(19-S.16) are **not** claimed.

## What it gives a user

| Capability | Where |
|---|---|
| Products and services with SKU, type, unit, active/sellable/purchasable flags and optional unit/list/cost prices | `/Product` list and detail (generic metadata-driven UI) |
| Hierarchical product categories with cycle and depth protection | `/ProductCategory` |
| Price books with currency, effective window and priority, plus entries with quantity breaks | `/PriceBook`, `/PriceBookEntry` |
| Declarative price rules (percentage / fixed / set-price adjustments) with deterministic ordering | `/PriceRule` |
| Suppliers and supplier purchase prices, kept separate from sales prices | `/Supplier`, `/SupplierProductPrice`, `POST /api/v1/Sales/action/resolveSupplierPrice` |
| Tax classes, tax codes, tax rates and tax rules with effective windows and priorities | `/TaxClass`, `/TaxCode`, `/TaxRate`, `/TaxRule` |
| Quotes → sales orders → delivery/return orders, with partial moves and a derived fulfilment state | `POST /api/v1/Sales/document`, `…/document/:kind/:id/{transition,convert,render}`, `POST /api/v1/Sales/salesOrder/:id/refreshFulfilment` |
| Purchase orders → receipt orders → supplier bills, with partial receipts, a derived receipt state and credits | the same document commands for `purchaseOrder`, `receiptOrder`, `bill`, `billCredit`, plus `POST /api/v1/Sales/purchaseOrder/:id/refreshReceipt` |
| Payments in both directions, allocations, credit notes, bill credits and write-offs | `POST /api/v1/Sales/payment`, `…/payment/:id/allocate`, `…/creditNote/:id/allocate`, `…/billCredit/:id/allocate` |
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
  catalog/                       product/category/price-book/supplier rules + their `beforeValidate` hook
  pricing/                       price rule engine, deterministic resolution, audited bulk update,
                                 the separate buying-price resolver (19-S.13)
  money/                         decimal-safe arithmetic and the currency scale contract
  tax/                           rule matching, rate selection, totals engine, preview service
  document/                      descriptors, the document engine, derived fulfilment/receipt state,
                                 the stock-movement contract, snapshots, locking, line items, terms,
                                 number series, the shared block model and render/send services
  payments/                      payments, allocation, balances, credit notes, bill credits, write-offs
  inventory/                     the movement ledger and its projection, availability, reservations,
                                 reviewed adjustments, two-sided transfers, reconciliation (19-S.14)
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
* **Supplier prices can never become a sales price** — they live in a separate entity resolved by a
  separate command, and neither resolver reads the other's source.
* **A quantity a document moves is bounded by the document it came from** — a delivery against the
  order line, a return against what was delivered, a receipt against what was ordered. Over-moving is
  refused with the remainder attached, never clamped.
* **Stock effects are recorded, never pretended** — a confirmed delivery/return/receipt freezes its
  movement plan with one key per document, and since 19-S.14 `InventoryService` applies that plan in
the same transaction when `features.inventory` is on. With the flag off the plan stays a recorded
intention and no stock consequence is claimed.
* **Two equally specific, equal-priority price rules are a conflict**, not an arbitrary winner.
* **Numbers are allocated at issuance** by default, and a retried allocation for the same document
  returns its existing number instead of consuming a second one.
* **Settings changes bump a version**, so a stored document snapshot can name the policy it was
  produced under.

## Document engine (19-S.6 – 19-S.13)

The shared mechanics live in `apps/api/src/sales/document` and are driven by a **descriptor per
document kind**, so a document type is data rather than a copy of the engine:

| Piece | What it does |
|---|---|
| `descriptors.ts` | state machine, allowed transitions, conversions, lock policy and the feature a kind belongs to, for all ten kinds |
| `line-items.ts` | typed line validation, item-record payloads, ordered items, remaining-quantity guards |
| `document.service.ts` | create / update / recalculate / transition / issue / unlock / convert — every number server-calculated, every write through the Entity Engine |
| `fulfilment.ts`, `receipt.ts` | the *derived* state of a sales order (from confirmed deliveries) and of a purchase order (from confirmed receipts) |
| `stock-movement.ts` | the internal contract a confirmation freezes into its snapshot, and the return-restock gate — `inventory/inventory.service.ts` consumes it (19-S.14) |
| `terms.ts` | due dates computed from the referenced payment terms |
| `lock.ts`, `snapshot.ts` | protected fields, privileged unlock with a reason, and the frozen commercial snapshot an issued document is rendered from |
| `render-blocks.ts`, `render.service.ts` | the block model every kind shares, and the print/PDF hook that draws any document from it |
| `numbering.service.ts` | atomic number allocation, once per document, retry-safe |

Commands (all under the module's own prefix):

```text
POST   /api/v1/Sales/document                      create a draft with typed line items
GET    /api/v1/Sales/document/:kind/:id            document + items + totals + allowed actions
PATCH  /api/v1/Sales/document/:kind/:id            update a draft (header and/or lines)
POST   /api/v1/Sales/document/:kind/:id/transition named transition (issue, confirm, send, void, …)
POST   /api/v1/Sales/document/:kind/:id/unlock     privileged unlock, reason required
POST   /api/v1/Sales/document/:kind/:id/convert    convert to another kind, idempotent
POST   /api/v1/Sales/document/:kind/:id/render     the printed rendering (template or built-in layout)
POST   /api/v1/Sales/document/:kind/:id/recalculate server-side recalculation
DELETE /api/v1/Sales/document/:kind/:id            delete a **draft** only
```

`kind` is one of `quote`, `salesOrder`, `invoice`, `creditNote`, `deliveryOrder`, `returnOrder`,
`purchaseOrder`, `receiptOrder`, `bill`, `billCredit`.

**Implemented:** the engine, the ten descriptors, the document + item metadata
(`database/seed-metadata.ts`), migrations `023_phase19_sales_documents.sql`,
`027_phase19_sales_purchasing.sql` and `028_phase19_sales_inventory.sql`, and the routes above.

**Not implemented yet — and deliberately not claimed by `implementedPhases`:** PDF *attachments* on a
sent document. A PDF renderer exists (`@carocrm/document`'s optional `pdfkit` adapter walks the same
block model the text rendering uses), and every document kind exposes that block model through
`…/render`, but turning a rendered PDF into an outbound attachment needs the attachment-storage path,
which is not built. Stock is **not** in this list: the ledger that applies a movement plan arrived in
19-S.14 — see [Inventory](#inventory-19-s14) and [purchases-and-inventory.md](purchases-and-inventory.md).

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
| Stock effects on confirmation | applied by the ledger when `features.inventory` is on — the confirmation writes the movement its snapshot froze (a reservation on an order, an issue on a delivery, a re-entry on a return) in the same transaction, and is refused if it cannot honour it. With the flag off (the default) there is no stock consequence and the code says so rather than pretending. |
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

## Credit notes and write-offs (19-S.11)

The two supported ways a receivable is reduced without a payment (§4.9). Both are ordinary metadata
entities (`CreditNote`, `CreditNoteItem`, `CreditNoteAllocation`, `WriteOff`), so list/detail,
search, export and relationships come from the Entity Engine; the module adds the command semantics
that a single record cannot express.

| Piece | What it does |
|---|---|
| `payments/balance.service.ts` | the one place derived balances are computed and stored: a payment's allocation balance, an invoice's `amountDue`/`paymentStatus`, a credit note's `unallocatedAmount` — with the 19-S.11 filters (reversed credit allocations and un-approved write-offs never count) |
| `payments/credit-note.service.ts` | allocate / **reverse** a credit allocation, list allocatable invoices, and render a credit note through the kernel `document` module |
| `payments/write-off.service.ts` | request → approve / reject → reverse, with the amount re-checked against the live balance at approval |

Key rules:

* **A credit note reduces a receivable through an explicit allocation** to an issued invoice — never
  by editing the invoice. The conversion `POST …/document/invoice/:id/convert` with
  `action: convertToCreditNote` creates a linked draft (its lines re-snapshotted by value, one credit
  note per invoice per conversion; further partial credits are manual documents).
* **A freshly issued credit note is fully unallocated** (`unallocatedAmount = grossTotal`), and every
  allocation or reversal recomputes that remainder from the live rows — a client cannot set it, and
  neither can a crafted record-API call (the write guard refuses `unallocatedAmount`).
* **Corrections are reversals, not deletions**: undoing a credit allocation marks the row
  (`reversedAt`/`reversedBy`/`reversalReason`) and recomputes both sides; the original and the
  replacement are both on record. Reversing twice is refused.
* **A write-off is a two-step decision.** A request is `pending` and changes **no** balance; only an
  administrator can approve (or reject), and approval re-checks the amount against what the invoice
  still owes *at that moment* — an invoice paid in the meantime refuses the approval. Reversal
  (`status: reversed` + reason) restores the receivable and keeps both entries.
* **Write-off requests are grantable, decisions are not.** `WriteOff: create` + `Invoice: edit` may
  request; approve/reject/reverse are administrator-gated (`403` otherwise), and the write guard
  refuses client writes to `status`, the approver/reversal trail, and any field of a decided
  write-off.
* **Currency agreement is enforced** (`assertCreditAllocatable`): a cross-currency allocation needs a
  conversion snapshot, and neither side may be over-allocated — the refusal names both remainders.
* **Rendering reuses the kernel**: `POST /api/v1/Sales/creditNote/:id/render` renders a named
  `DocumentTemplate` (entity `targetEntity: 'CreditNote'`) or the built-in block layout, from the
  frozen snapshot once issued. The block model is shared with quotes (`document/render-blocks.ts`).

Commands: `POST /api/v1/Sales/creditNote/:id/allocate`,
`DELETE /api/v1/Sales/creditNote/allocation/:id`,
`GET /api/v1/Sales/creditNote/allocatableInvoices`, `POST /api/v1/Sales/creditNote/:id/render`,
`POST /api/v1/Sales/write-off`, `POST /api/v1/Sales/write-off/:id/approve|reject|reverse`.

## Delivery and return orders (19-S.12)

Fulfilment and returns on the selling side, built on the same engine with two ideas the rest of the
module did not need yet.

| Rule | Where it lives |
|---|---|
| A delivery order is generated from a sales order (`convertToDeliveryOrder`) or created by hand; its lines keep `sourceItemId`, the order line each unit moves against | `document/descriptors.ts`, `document.service.convert()` |
| The order's `partiallyFulfilled` / `fulfilled` state is **derived** from its confirmed deliveries, never typed, and recomputed inside the same transaction that confirms the shipment | `document/fulfilment.ts`, `refreshFulfilment()` |
| A source line can be moved more than once: several delivery orders per order are partial moves, not duplicate billings. What bounds them is the remaining quantity, checked *before* a number is taken | `assertConvertible`, `assertMovementWithinRemaining` |
| Over-moving is refused with the remainder attached, never silently clamped — a clamp would ship a different quantity than the operator confirmed | `line-items.ts::assertWithinRemaining` |
| A return is generated from a delivery order (`convertToReturnOrder`, bounded by what that shipment moved) or from the order (bounded by what all confirmed deliveries moved) | `descriptors.ts`, `movementBound()` |
| Each return line carries a **disposition** — `restock`, `scrap`, `quarantine`. Only `restock` may produce an inbound movement, and the value is frozen at confirmation | `document/stock-movement.ts`, `ReturnOrderItem.disposition` |
| Every confirmed stock-moving document freezes one `stockMovement` plan in its snapshot, keyed `Entity:id` — never from a request value — so a retried confirmation asks for the same movement once | `snapshot.stockMovement` |
| With `features.inventory` **on** there is no ledger yet, so confirming a stock-moving document is refused rather than pretended; the plan is still recorded | `assertInventoryPolicy` |
| Confirmation is the point of no return: a confirmed delivery cannot be cancelled — the supported correction is a return order | `DELIVERY_ORDER` transitions |
| Tracking number, warehouse, reason, attachments, relationship panels, domain events and the `…/render` print hook | metadata + the engine |

## Purchasing (19-S.13)

`purchaseOrder → receiptOrder → bill → billCredit`, the same engine with the supplier in the account's
seat and the money flowing the other way. Gated by `features.purchases` (off by default): a purchasing
document is refused with a clear 403 rather than quietly creating records nobody configured.

| Rule | Where it lives |
|---|---|
| Purchase order, receipt order, bill and bill credit are descriptors + metadata entities, not four copies of the engine | `descriptors.ts`, `database/seed-metadata.ts` |
| Receipt state (`partiallyReceived` / `received`) is derived from **confirmed** receipt orders; over-receipt is refused against the order line | `document/receipt.ts`, `refreshReceipt()` |
| Purchase-to-bill traceability: a receipt names its order, a bill generated from a receipt names both, and a bill credit names the bill it corrects | `linkToSource` on each conversion |
| Bill due dates come from the referenced `PaymentTermProfile` exactly like an invoice's; an explicit due date always wins | `document/terms.ts` |
| An **outgoing payment** settles a `Bill`; an incoming one settles an `Invoice`. The direction is checked against the document entity, and a payment may not name both an account and a supplier | `allocation-math.ts::PERMITTED_DOCUMENT_TYPES`, `PaymentService.create()` |
| A bill credit reduces a payable through its own `BillCreditAllocation` rows, is fully unallocated when issued, and a reversal keeps the row with `reversedAt`/`reversedBy`/`reversalReason` | `payments/bill-credit.service.ts` |
| Customer and supplier credits are separate records with the same discipline — never one table for both sides of the ledger | `CreditNoteAllocation` vs `BillCreditAllocation` |
| A supplier referenced by an issued bill or a confirmed purchase/receipt order keeps its identity (`name`, `code`, `currency`, `taxId`); deactivating it stays allowed | `catalog/product-rules.ts::assertSupplierEditable` |
| Supplier prices are resolved by `POST /api/v1/Sales/action/resolveSupplierPrice`, which reads `SupplierProductPrice` only; the sales resolver never reads it, so a buying price cannot leak into a quote | `pricing/supplier-price.ts` |
| Capabilities are separate grants, not one flag: purchase-order management is `edit` on `PurchaseOrder`, receipt confirmation on `ReceiptOrder`, bill issue on `Bill`, payment on `Payment`, all under the `purchases` feature | [permissions.md](permissions.md) |

**Deferred, honestly:** bill overdue marking (the daily job covers invoices only), and batch/serial
*tracking* entities until 19-S.15 — a receipt line stores the
`batchNumber`/`serialNumber` the operator recorded, but no stock identity table validates it yet.

## Inventory (19-S.14)

The stock ledger. `apps/api/src/sales/inventory` owns it, it is off unless `features.inventory` is on,
and it is the only thing that changes a quantity — a confirmed delivery/return/receipt applies the
plan its snapshot froze, and nothing else writes `on_hand`. See
[purchases-and-inventory.md](purchases-and-inventory.md) for the detail.

| Rule | Where it lives |
|---|---|
| The ledger (`InventoryTransaction`) is **append-only**: every physical change is a row with a signed delta whose sign is fixed by its `transactionType`, a source document and (for a correction) a reason; a fix is a **new compensating** row, never an edit | `inventory/ledger.ts`, `inventory/inventory.service.ts` |
| Movements are **idempotent** by `movementKey`, derived from the source document and line — never from a request — and backed by a unique index | `movementKeyFor`, migration 028 |
| Availability keeps four figures apart: `onHand` (the sum of the ledger), `reserved` (soft promises), `available` (`onHand − reserved`) and `incoming` (confirmed purchase orders net of receipts, plus in-transit transfers) | `stockLevel`, `inventory.service.availability` |
| A **projection** (`sales_inventory_stock`) is the lock target and the fast read; `reconcile()` compares it with the ledger and **reports** a discrepancy rather than auto-correcting it | migration 028, `inventory.service.reconcile` |
| Concurrent reservations cannot overbook: every read-modify-write takes `SELECT … FOR UPDATE` on the (product, warehouse) row | `lockLevel` |
| A movement that would take a warehouse below zero is refused unless `inventory.allowNegativeStock` is deliberately on | `recordMovements` |
| An **adjustment** is reviewed: `pending` → `applied` (the ledger row is written) or `rejected`, with a required reason; the decision is administrator-only | `inventory-ops.service.ts` |
| A **transfer** moves stock in two linked steps — `confirm` dispatches (source outflow) and puts the goods `inTransit`, `receive` completes it (destination inflow). A dispatched transfer cannot be cancelled: what is in transit is visible as `incoming`, not lost | `inventory-ops.service.ts` |
| Confirming a **sales order** reserves what it promises (a soft hold); a **delivery** consumes the reservation as it ships; **cancelling** a confirmed order releases it | `document.service.ts` → `InventoryService` |
| Warehouse, ledger, transfer and reservation commands are refused outright while the feature is off, naming the setting | `InventoryService.requireEnabled` |

Commands (all under the module's own prefix):

```text
GET    /api/v1/Sales/inventory/availability?productId=&warehouseId=   on-hand/reserved/available/incoming
GET    /api/v1/Sales/inventory/stock?warehouseId=&productId=          a bounded page of levels
GET    /api/v1/Sales/inventory/history?productId=&warehouseId=        the movement history, newest first
POST   /api/v1/Sales/inventory/reconcile                              projection vs ledger
GET    /api/v1/Sales/inventory/reservations?...                       active/released promises
POST   /api/v1/Sales/inventory/reserve                                place a reservation
POST   /api/v1/Sales/inventory/reservation/:id/release                release one
POST   /api/v1/Sales/inventory/adjustment                             request a reviewed correction
POST   /api/v1/Sales/inventory/adjustment/:id/transition              approve (moves stock) or reject
POST   /api/v1/Sales/inventory/transfer                               create a draft transfer
GET    /api/v1/Sales/inventory/transfer/:id                           a transfer with its lines
GET    /api/v1/Sales/inventory/transfers/inTransit?warehouseId=       dispatched but not received
POST   /api/v1/Sales/inventory/transfer/:id/transition                confirm / receive / cancel
```

Warehouses themselves are ordinary metadata records (`/api/v1/Warehouse`); `Warehouse`,
`InventoryTransaction`, `InventoryAdjustment`, `TransferOrder`/`TransferOrderItem` and
`InventoryReservation` are the six entities this phase registers, and the write guard refuses every
client write to the ledger and every client-set lifecycle field on the others.

## Verification

```bash
pnpm typecheck && pnpm lint
# Pure: no database, no clock, no socket.
pnpm vitest run apps/api/test/sales-terms.test.ts apps/api/test/sales-fulfilment.test.ts \
  apps/api/test/sales-allocation-math.test.ts apps/api/test/sales-quote-document.test.ts \
  apps/api/test/sales-stock-movement.test.ts apps/api/test/sales-supplier-price.test.ts \
  apps/api/test/sales-inventory-ledger.test.ts
# API, against the configured primary database (one invocation per suite — see the note below).
pnpm vitest run apps/api/test/sales-module.test.ts apps/api/test/sales-catalog.test.ts \
  apps/api/test/sales-pricing.test.ts apps/api/test/sales-tax.test.ts \
  apps/api/test/sales-money.test.ts apps/api/test/sales-documents.test.ts \
  apps/api/test/sales-payments.test.ts apps/api/test/sales-quotes.test.ts \
  apps/api/test/sales-credits.test.ts apps/api/test/sales-delivery-returns.test.ts \
  apps/api/test/sales-purchasing.test.ts apps/api/test/sales-inventory.test.ts
# The worker has its own vitest config, so its suites are not collected by the root one.
cd apps/worker && pnpm vitest run src/handlers/sales-handlers.test.ts
```

Run each API suite as its own invocation: booting the app re-seeds metadata into the configured
database, so parallel suites in one process fight over it.

`sales-quotes.test.ts` boots the app with `MAIL_TRANSPORT=memory` and `SMTP_FROM` set, and stubs the
BullMQ producer, so it never sends mail and never needs a Redis server; both env vars are restored in
`afterAll`. `sales-delivery-returns.test.ts` and `sales-purchasing.test.ts` flip the `inventory` and
`purchases` feature flags and put them back in `afterAll` — the settings row is shared, so leaving a
flag set would change what the next suite sees.

The API suites target the configured primary database and create only `AGENT_TEST_<runId>` records that
they delete again by exact id. See
[../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) §10 for
what was and was not executed when this module was last touched.

**Coverage, honestly:** `sales-terms`, `sales-fulfilment`, `sales-allocation-math`,
`sales-quote-document`, `sales-stock-movement` and `sales-supplier-price` test the pure math, the
stock-movement gate and the buying-price selection with no database; `sales-documents` covers the
create → issue → lock → convert → void lifecycle and the write guard that stops a crafted request
forging a computed field; `sales-quotes` covers rendering, the send side effects, the no-provider and
ACL refusals, a price frozen at issuance, expiry and conversion retries; `sales-payments` covers
allocation both ways, over-allocation, unallocation and provider-event idempotency; `sales-credits`
covers invoice→credit-note conversion and linkage, allocation and its refusal paths (remainder,
outstanding, cross-currency, draft), reversal keeping the row, write-off request/approve/reject/
reverse with the administrator gate, approval-time re-check, forge refusals and the credit-note
render; `sales-delivery-returns` (19-S.12) covers lineage, partial and over-sized deliveries, the
derived fulfilment state and its idempotent refresh, the confirmation-twice refusal, the frozen
movement plan and its key, return dispositions through to the snapshot, the cancellation policy and
the ledger being consulted when inventory is enabled (19-S.14); `sales-inventory-ledger` tests the
signed-quantity rules, availability, the reservation policy, both small state machines and the
reconciliation with no database; `sales-inventory` (19-S.14) covers the feature gate, a reviewed
adjustment (pending moves nothing, approval moves stock once), the append-only ledger, the
negative-stock refusal, reserve/over-reserve/release, two **parallel** reservations of the whole
quantity (one wins, one is refused, one row survives), both sides of a transfer with the in-transit
state and a double-receive refusal, reconciliation, and stock moving with a confirmed order and
shipped delivery (reserve → consume → release on cancel); `sales-purchasing` (19-S.13) covers the feature gate, the derived
receipt state across partial receipts, over-receipt refusal, receipt batch facts, purchase→receipt→
bill traceability, terms-computed bill due dates, supplier payment allocation with its direction and
counterparty refusals, bill-credit allocate/reverse/remainder refusals with the row kept, the supplier
identity freeze, buying-vs-selling price separation and the bill render. The worker suite covers the
expiry job. Still **not** covered: the `markOverdueInvoices` job, and anything a UI would do —
dedicated Sales screens are 19-S.17 work.

## Deeper documents

* [overview.md](overview.md) — what the module is, its boundary, and the tier roadmap
* [product-catalog-and-pricing.md](product-catalog-and-pricing.md) — catalog, price books, rules, resolution
* [money-tax-currency.md](money-tax-currency.md) — decimal rules, currency scales, tax engine, totals
* [api.md](api.md) — the domain commands and their payloads
* [purchases-and-inventory.md](purchases-and-inventory.md) — purchasing, warehouses, the stock ledger, reservations
* [permissions.md](permissions.md) — who may do what, with worked examples
* [../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) — the 19-S.0 audit
