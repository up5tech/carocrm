# Sales API

Two surfaces, deliberately:

1. **Entity CRUD** — every Sales entity is a metadata record, served by the generic
   `/api/v1/:entity` routes (`/api/v1/Product`, `/api/v1/PriceBookEntry`, `/api/v1/TaxRule`, …) with
   list/detail/create/edit/delete, relations, search, filters, saved filters, import/export and ACL.
   The module adds no CRUD controllers.
2. **Domain commands** — `/api/v1/Sales/action/*`, for the questions a single record cannot express.

The `Sales` controller is registered **before** the generic `:entity` wildcard in `app.module.ts`, so
`/api/v1/Sales/...` can never be read as a record of an entity called `Sales`.

Request bodies are validated by the Zod schemas in `apps/api/src/sales/dto/sales-shapes.ts`. Every
schema is `.strict()`, so an unknown key is a `422` rather than a silently ignored field. Monetary and
quantity values are **canonical decimal strings** (`^-?\d+(\.\d+)?$`, no exponent), never JSON numbers.

---

## `GET /api/v1/Sales/action/health`

Administrator only.

Reports the module descriptor plus facts read from the running platform — never a hard-coded `true`:

```jsonc
{
  "module": {
    "id": "sales",
    "name": "Sales & Commercial Operations",
    "version": "1.0.0",
    "minPlatformVersion": "1.0.0",
    "loadOrder": 320,
    "apiPrefix": "/api/v1/Sales",
    "implementedPhases": ["19-S.0", "19-S.1", "19-S.2", "19-S.3", "19-S.4", "19-S.5", "19-S.6", "19-S.7", "19-S.8", "19-S.9", "19-S.10", "19-S.11", "19-S.12", "19-S.13", "19-S.14"]
  },
  "ok": true,
  "dependencies": [            // entity-engine, crm-core-records, acl, hooks, audit-stream, jobs
    { "id": "entity-engine", "label": "…", "present": true,
      "evidence": [{ "kind": "entity", "value": "Account", "present": true }, …],
      "missing": [] }
  ],
  "optionalIntegrations": [    // stripe-integration, accounting-integration, customer-success, projects
    { "id": "stripe-integration", "label": "Stripe payments", "provides": "…",
      "present": false, "status": "unavailable" }
  ],
  "features": [{ "key": "priceBooks", "label": "Price books and price rules",
                 "enabled": true, "settingsPath": "features.priceBooks", "requires": [] }],
  "settings": { "version": 0, "updatedAt": null, "warnings": [] },
  "checks": [
    { "name": "entity-metadata", "ok": true, "detail": "11 Sales entities are registered." },
    { "name": "numbering", "ok": true, "detail": "10 number series are available." }
  ]
}
```

Evidence kinds: `entity` (metadata registry), `table` and `column` (`information_schema`),
`hookPhase` (hook registry). An absent optional integration is reported as `unavailable`; it never
breaks startup.

## `GET /api/v1/Sales/action/settings`

Authenticated. Returns the validated settings document plus what the server computed from it:

```jsonc
{
  "settings": {
    "features": { "productPrices": true, "taxInclusivePrices": false, "priceBooks": true,
                  "productVariants": false, "supplierPrices": true, "purchases": false,
                  "inventory": false, "subscriptions": false, "paymentRequests": false,
                  "multiCurrency": false, "issuanceLocking": true },
    "currency": { "defaultCurrency": "USD" },
    "pricing": { "resolution": "priceBookFirst", "allowCustomPrice": true, "missingPricePolicy": "error" },
    "tax": { "missingTaxPolicy": "error", "shippingTaxCode": null,
             "roundingStage": "line", "roundingMode": "half-up" },
    "numbering": { "allocation": "issuance" },
    "quantityPrecision": 2
  },
  "version": 0,
  "updatedAt": null,
  "updatedBy": null,
  "defaults": { /* the same shape, all defaults */ },
  "warnings": [{ "code": "noPriceSource", "message": "…" }]
}
```

Warning codes: `priceBooksDisabledWithPriceBookFirst`, `noPriceSource`,
`purchasesWithoutSupplierPrices`, `inventoryWithoutPurchases`, `multiCurrencyWithoutBase`.

## `POST /api/v1/Sales/action/settings`

Administrator only. A **deep-merged patch**; every accepted change bumps `version`. Unknown keys,
unknown policy names and unsupported currency codes are refused with `422`.

```jsonc
{ "features": { "priceBooks": false },
  "tax": { "roundingStage": "document" },
  "quantityPrecision": 3 }
```

## `GET /api/v1/Sales/action/numbering`

Administrator only.

```jsonc
{ "list": [{ "code": "invoice", "label": "Invoice", "prefix": "INV-",
             "padding": 6, "nextPreview": "INV-000042", "allocation": "issuance", "active": true }] }
```

`nextPreview` is the **next unallocated** number and consumes nothing — allocation happens at
issuance (`SalesNumberingService.allocate(code, { documentType, documentId })`), which takes a row lock
and writes the ledger row. A retried allocation for the same document returns its existing number with
`reused: true`.

## `POST /api/v1/Sales/action/resolvePrice`

ACL-checked: the caller must be able to read the product, and the price book when one is supplied.

```jsonc
{ "productId": "prd123", "quantity": "12", "currency": "USD",
  "accountId": "acc1", "priceBookId": "pb1", "date": "2026-10-15", "explicitPrice": null }
```

Resolved:

```jsonc
{ "resolved": true, "productId": "prd123", "price": "9.00", "currency": "USD", "scale": 2,
  "source": "priceBookEntry", "explanation": "Price book \"…\" entry.",
  "trace": [{ "step": "…", "detail": "…" }],
  "priceBookId": "pb1", "priceBookEntryId": "pbe1", "priceRuleId": null,
  "listPrice": null, "quantity": "12", "date": "2026-10-15" }
```

`source` is one of `priceBookEntry`, `priceRule`, `productUnitPrice`, `explicit`.

Failure modes:

| Status | When |
|---|---|
| `422` | no price could be resolved and `pricing.missingPricePolicy = error` (message: `No price could be resolved…`) |
| `422` | the product is inactive or not sellable, with the reason attached |
| `422` | two applicable rules share the same priority and specificity (message mentions `same priority and specificity`) |
| `403` | the caller may not read the product, or may not read the price book it asked for |

With `pricing.missingPricePolicy = allowExplicit` the same request returns HTTP 200 with
`"resolved": false` and no `price` — it is never defaulted to `"0.00"`.

## `POST /api/v1/Sales/action/bulkPriceUpdate`

```jsonc
{ "mode": "preview",              // or "apply"
  "priceBookId": "pb1",
  "adjustment": { "type": "percent", "value": "10" },   // percent | fixed | set
  "productIds": ["prd1"],          // optional narrowing
  "categoryIds": ["cat1"],         // optional narrowing
  "limit": 500 }                   // 1 … 500, optional
```

`preview` returns the full change list and writes nothing:

```jsonc
{ "mode": "preview", "applied": false, "priceBookId": "pb1",
  "changes": [{ "entryId": "pbe1", "from": "10.00", "to": "11.00" }],
  "changedCount": 2, "truncated": false }
```

`apply` performs the same computation in one transaction, writes an `audit_log` row for the price book
and returns `applied: true` with the `auditId`. `truncated: true` means the `limit` cut the run short.

| Status | When |
|---|---|
| `403` | the caller cannot read the price book, or is not an administrator for `apply` |
| `422` | invalid adjustment, unknown price book, or a `fixed`/`set` value that would make a price negative |

## `POST /api/v1/Sales/action/previewTotals`

Authenticated. Server-side recalculation — a client-submitted total is never trusted.

```jsonc
{ "currency": "USD", "date": "2026-10-15", "taxInclusive": false,
  "accountId": null, "jurisdiction": null,
  "lines": [{ "productId": "prd1", "name": "Widget", "sku": "W-1", "unit": "pcs",
              "quantity": "2", "unitPrice": "10.00",
              "discountPercent": "10", "discountAmount": "0.50",
              "taxCodeId": "tc1", "taxRatePercent": "19" }],
  "shipping": { "amount": "5.00", "taxCodeId": "tc1" },
  "documentDiscountAmount": "1.00",
  "exchangeRate": { "documentCurrency": "USD", "baseCurrency": "EUR",
                    "rate": "0.92", "rateDate": "2026-10-15", "source": "ecb" } }
```

Returns the `TotalsResult` described in
[money-tax-currency.md §4.4](money-tax-currency.md#44-result-shape): `lines`, `subtotal`,
`discountTotal`, `shippingAmount`, `shippingTaxAmount`, `taxBreakdown`, `taxTotal`, `netTotal`,
`grossTotal`, `amountDue`, the optional `baseCurrency`/`exchangeRate`/`baseGrossTotal`, the `rounding`
and `taxInclusive` policy used, and `warnings`.

| Status | When |
|---|---|
| `422` | no lines; more than 500 lines; a line without a unit price; a non-positive quantity; a quantity with more fraction digits than `quantityPrecision`; a line discounted below zero; a discount larger than the document; a missing tax rate while `tax.missingTaxPolicy = error`; an exchange-rate snapshot whose `documentCurrency` is not the request currency |

## `POST /api/v1/Sales/quote/:id/render`

Render a quote against a `DocumentTemplate` — the preview the UI shows before anybody commits to
sending. Rendering goes through the kernel `document` module, so the quote does not have its own
template syntax. Read access on the quote is the gate; rendering a **named** template also needs read
access on `DocumentTemplate`.

```json
{ "templateCode": "quote.default" }
```

`templateCode` is optional: the entity type's default template is used when it is omitted, and when
the entity type has **no** active template the built-in block layout is rendered instead (a valid
install, not an error).

```json
{
  "quoteId": "q_123",
  "number": "Q-000001",
  "status": "sent",
  "fromSnapshot": true,
  "templateCode": "quote.default",
  "format": "html",
  "subject": "Quote Q-000001",
  "body": "<h1>Quote Q-000001</h1>…",
  "text": "QUOTE Q-000001\n==============\n…",
  "blocks": [{ "kind": "heading", "text": "Quote Q-000001" }],
  "warnings": [],
  "pdf": { "available": false, "reason": "Cannot find package 'pdfkit'…" }
}
```

* `fromSnapshot` is `true` for an issued quote: the numbers and the party names come from the frozen
  envelope, so a price book or a renamed account cannot rewrite what was sent.
* `text` is always the plain-text rendering of the block model; `blocks` is that model, which is what
  a PDF renderer walks. `pdf.available` reports whether the optional `pdfkit` adapter can be loaded —
  a PDF is never generated here.
* `warnings` lists placeholders the template could not resolve. They are **left in the body**, never
  blanked.

## `POST /api/v1/Sales/quote/:id/send`

Issue a draft quote and email it — or, for a quote that is already `sent`, re-render it and record
another email.

```json
{
  "to": ["buyer@example.com"],
  "cc": [],
  "bcc": [],
  "templateCode": "quote.default",
  "subject": "Your quote",
  "message": "Here is the quote we discussed.",
  "emailAccountId": "acc_1",
  "correlationId": "req-1"
}
```

Every field is optional. `to` defaults to the quote's contact's email address, then its account's.
`message` is a covering note prepended to the rendered document. `emailAccountId` picks the sending
mailbox; the configured default account is used otherwise.

```json
{
  "quote": { "kind": "quote", "id": "q_123", "document": { "status": "sent", "number": "Q-000001" } },
  "email": { "id": "em_9", "parentType": "Quote", "parentId": "q_123", "status": "Queued" },
  "rendered": { "number": "Q-000001", "body": "…" },
  "transport": { "name": "smtp", "mode": "live" },
  "job": { "id": "…", "name": "system.sendEmail", "status": "pending" },
  "issued": true
}
```

| Status | When |
|---|---|
| `403` | no mail transport is configured (`FEATURE_DISABLED`); no `create`/`edit` access on `Email`; no `read` access on the quote |
| `422` | the quote is in a state that cannot be sent (only `draft` and `sent` can); no recipient could be determined; the template is unknown or inactive |

The email is a normal `Email` record linked through `parentType`/`parentId`, and `EmailService` owns
its validation and the per-recipient delivery ledger. The API never opens a socket — the worker
sends. Every refusal above happens **before** the quote is issued, so a quote is never marked `sent`
with no email behind it; `issued: false` in the response means the document was already sent and only
a new email was recorded.

## `POST /api/v1/Sales/document/:kind/:id/send`

The same contract for the other nine kinds (19-S.17), driven by the descriptor instead of by one service
per document type. The body is identical to the quote send's — `to`, `cc`, `bcc`, `templateCode`,
`subject`, `message`, `emailAccountId`, `correlationId`, `attachPdf` — and so is the response, with
`kind` and `document` where the quote answers `quote`.

Three rules are specific to the wider surface:

* **A stock-moving draft is not issued by sending it.** `salesOrder`, `deliveryOrder`, `returnOrder` and
  `receiptOrder` move or reserve stock when they are confirmed (19-S.14), which is a warehouse act, not a
  side effect of pressing "send". Sending one answers `422` with the reason and the action to run first;
  sending an already-confirmed one is a re-send.
* **The counterparty decides the default recipient.** A purchasing kind (`purchaseOrder`, `receiptOrder`,
  `bill`, `billCredit`) goes to its **supplier's** address; a selling one to its contact, then its
  account. With neither, the send is refused rather than mailed to nobody.
* `kind: quote` is refused here with a pointer to `POST /Sales/quote/:id/send`, so an installation's
  quote emails never change shape by accident.

`attachPdf: true` renders the issued blocks with the optional `pdfkit` adapter and stores the result as
an `Attachment` under the `Email` (`Invoice-INV-000042.pdf`, role `<kind>-pdf`), which the worker picks up
without knowing Sales exists. If `pdfkit` is not installed the send is refused **before** issuance, so a
document is never made official for an attachment that did not materialise.

| Status | When |
|---|---|
| `403` | no mail transport (`FEATURE_DISABLED`); no `create`/`edit` on `Email`; no `read` on the document; the kind's feature is off (purchasing kinds and `purchases`) |
| `422` | the kind is `quote`; the document is in a state that is neither its draft state nor its issued state; a stock-moving draft; no recipient; `attachPdf` without `pdfkit` |

## The conversion snapshot on a command (19-S.18)

`POST /api/v1/Sales/document`, `PATCH /api/v1/Sales/document/:kind/:id`, `POST /api/v1/Sales/payment`
and `PATCH /api/v1/Sales/payment/:id` accept one more top-level field:

```json
{ "exchangeRate": { "documentCurrency": "USD", "baseCurrency": "EUR",
                    "rate": "0.9", "rateDate": "2026-10-01", "source": "ecb daily" } }
```

It is a command field, not a header field, because the resulting values are server-owned. The service
validates the rate (`money/currency.ts`), stores the validated object as the record's
`exchangeRateSnapshot`, and derives the base figures from it — `baseCurrency`/`baseGrossTotal` on a
document, `baseCurrency`/`baseAmount`/`baseAllocatedAmount`/`baseUnallocatedAmount` on a payment,
`baseCurrency`/`baseAmount` on every allocation and write-off. Later recalculations reuse **the stored**
snapshot, never a fresher rate, and an issued document refuses a new one like any other protected field
(§4.13). Omitting the field records no conversion at all: the base columns stay absent rather than
being filled with a guessed number.

A rate whose `documentCurrency` is not the record's own currency is refused with `422`, as is a new rate
on a payment that already has allocations. None of these fields may be written through the generic
`/api/v1/:entity` path or through import — see the write guard in `sales-internal.ts`.

## Errors

All failures use the kernel error envelope. The Sales module raises `ValidationError` (→ `422`),
`DuplicateRecordError` (→ `409 DUPLICATE_RECORD`, e.g. a duplicate SKU), `NotFoundError` (→ `404`),
`AuthorizationDeniedError` (→ `403`) and `InvalidQueryError` (→ `422`) for a request body that fails its
schema. Validation reasons are attached as `error.details.reason` or `error.details.issues`, which is
what the tests assert on and what the UI shows.

## Not documented here

The commercial **document commands** and the **payment commands** are also part of this prefix and are
not repeated in this file: `POST /api/v1/Sales/document`, `GET|PATCH|DELETE
/api/v1/Sales/document/:kind/:id`, `…/:id/transition`, `…/:id/unlock`, `…/:id/convert`,
`…/:id/render`, `…/:id/recalculate`, `POST /api/v1/Sales/action/expireQuotes` (and the worker-authorized
`action/expire-quotes`), `action/markOverdueInvoices`, `salesOrder/:id/refreshFulfilment`,
`/api/v1/Sales/payment*`, `/api/v1/Sales/allocation/:id`, `/api/v1/Sales/allocatableDocuments`,
`/api/v1/Sales/paymentRequest`, `/api/v1/Sales/providerEvent`. `kind` is one of `quote`, `salesOrder`,
`invoice`, `creditNote`, `deliveryOrder`, `returnOrder`, `purchaseOrder`, `receiptOrder`, `bill`,
`billCredit`. The per-command behaviour is described in
[README.md](README.md#document-engine-19-s6--19-s13), and every request body is the Zod schema of the
same name in `apps/api/src/sales/dto/sales-shapes.ts`.

The **credit-note and write-off commands** (19-S.11) follow the same pattern:

```text
POST   /api/v1/Sales/creditNote/:id/allocate        apply part of an issued credit note to an issued invoice
DELETE /api/v1/Sales/creditNote/allocation/:id      reverse an allocation (the row is kept and marked, §4.9)
GET    /api/v1/Sales/creditNote/allocatableInvoices ?creditNoteId= &accountId= — issued invoices with their outstanding
POST   /api/v1/Sales/creditNote/:id/render          render through a DocumentTemplate (or the built-in block layout)
POST   /api/v1/Sales/write-off                      request a write-off (status `pending`, no balance changes)
POST   /api/v1/Sales/write-off/:id/approve          administrator only; re-checks the amount against the live balance
POST   /api/v1/Sales/write-off/:id/reject           administrator only; the request stays on record
POST   /api/v1/Sales/write-off/:id/reverse          administrator only; reason required, restores the receivable
```

The **purchasing commands** (19-S.13) are the same shapes on the payable side, and are refused with
`403` while `features.purchases` is off:

```text
POST   /api/v1/Sales/purchaseOrder/:id/refreshReceipt   re-derive `partiallyReceived` / `received` from confirmed receipts
POST   /api/v1/Sales/billCredit/:id/allocate            apply part of an issued bill credit to an issued bill
DELETE /api/v1/Sales/billCredit/allocation/:id          reverse it; the row stays with the reversal trail
GET    /api/v1/Sales/billCredit/allocatableBills        ?billCreditId= &supplierId= — issued bills and their outstanding
GET    /api/v1/Sales/bill/:id/creditAllocations         the bill's credit history, live and reversed
GET    /api/v1/Sales/allocatableDocuments?direction=outgoing&supplierId=  what a supplier payment can still settle
POST   /api/v1/Sales/action/resolveSupplierPrice        the buying price from `SupplierProductPrice` only (§4.11)
```

A `Payment` names its counterparty by direction: `accountId`/`contactId` when it is incoming,
`supplierId` when it is outgoing — a record that names both is refused. An allocation is accepted only
when the direction matches the document: incoming settles `Invoice`, outgoing settles `Bill`.

`DocumentTemplate` templates for a credit note are ordinary records; the template's target entity is
stored in `targetEntity` (the kernel reserves the attribute name `entityType`), while the create/query
API keeps accepting `entityType` as the parameter name.

Inventory has working routes since 19-S.14 (`/api/v1/Sales/inventory/*` for availability, stock levels,
history, reservations, adjustments, transfers and reconciliation) on top of the metadata entities, which
keep their generic `/api/v1/Warehouse`-style CRUD. A confirmed delivery, return or receipt order freezes
the movement it stands for in its snapshot and, when `features.inventory` is on, applies it in the same
transaction — with the flag off there is no stock consequence and the code says so rather than pretending.
Since 19-S.15 the same prefix also serves the stock-identity routes: `inventory/batches` (lots holding
stock with their dates), `inventory/serials` (unit records by product/place/state) and
`inventory/picking-suggestions` (what the configured removal policy would pick for a line — never
moves or reserves anything). The identity records are ordinary entities too (`InventoryBatch`,
`InventorySerial` on `/api/v1/...`), but the write guard refuses every client write to a serial and
all but a lot's dates, so no crafted request can invent a unit or walk its state.

The **subscription commands** (19-S.16) bill a term without a user present, and are refused with `403`
while `features.subscriptions` is off:

```text
POST   /api/v1/Sales/subscription/:id/previewPeriods   the windows a term would bill, writing nothing
POST   /api/v1/Sales/subscription/:id/generatePeriods  create the missing periods (idempotent; reports `created`/`existing`)
POST   /api/v1/Sales/subscription/:id/pause            stop billing; the periods stay
POST   /api/v1/Sales/subscription/:id/resume           resume a paused term
POST   /api/v1/Sales/subscription/:id/cancel           end the term; its unpaid periods become `cancelled`
POST   /api/v1/Sales/subscriptionPeriod/:id/retry      re-run one failed period's billing
POST   /api/v1/Sales/action/generateSubscriptionInvoices   administrator: periods, then one invoice per due period
POST   /api/v1/Sales/action/generate-subscription-invoices  worker capability (`x-worker-secret`), same operation
```

Every body is `{ today?: "YYYY-MM-DD" }`, which is how a run is pointed at a specific day (and what the
tests use); omitted, the run acts as of today. The run answers `{ enabled, runDay, subscriptions,
periodsCreated, invoiced, failed, truncated, results }`, where `truncated: true` means a per-run budget
was reached and more periods wait for the next one. `Subscription` and `SubscriptionPeriod` keep their
generic `/api/v1/...` records, but the write guard refuses a client-created period and any write to a
period's `status`, `invoiceId`, `invoiceDate`, `attemptCount`, `failureCode`, `retryState`, window or
idempotency key — a period is a computed schedule row, and only the billing service may claim it.

## Reporting, dashboards and monitoring (19-S.18)

```text
GET  /api/v1/Sales/action/reportCatalog      the curated datasets: key, label, description, moneyBasis
POST /api/v1/Sales/report/:key/run           run one dataset as the current user
GET  /api/v1/Sales/action/dashletCatalog     the standard Sales dashlets, ready for the dashboard route
GET  /api/v1/Sales/action/jobMonitoring      Sales job attempts, schedules and queue depth (administrator)
POST /api/v1/Sales/action/accountingExport   one document as an accounting consumer posts it (19-S.19)
POST /api/v1/Sales/action/customerSummary    one account's commercial position (19-S.19)
GET  /api/v1/Sales/inventory/valuation       on-hand stock valued at cost, with the unpriced quantity stated
```

`report/:key/run` deliberately owns **no** query engine. It hands the saved definition to the generic
Report subsystem (`ReportService.preview`), so entity existence, the `read` permission, field-level
visibility, the Query Engine's filter grammar and the report cost limits are applied there — the same
rules that govern a report an analyst wrote by hand. The response is `{ key, definition, result }`, and
`result` is the kernel's `ReportResult` (`groups`, `matrix`, `rows` or `metrics`, plus `truncated`).

Every dataset states how its money should be read, because a total across two currencies is not a total
(§12.4):

| `moneyBasis` | Meaning |
|---|---|
| `base-snapshot` | Summed from the persisted conversion (`baseGrossTotal`, `baseAmount`). Only records that were issued or recorded with a rate contribute, so this is never the same number as the gross. |
| `document-currency` | Summed per document currency, and the dataset groups by `currency` so no two currencies land in one bucket. |
| `count` | No money is added up. |

`action/dashletCatalog` returns objects the shared dashboard engine already accepts; a user places one
with `POST /api/v1/Dashboard/:dashboardId/dashlets` and runs it with the ordinary
`…/dashlets/:dashletId/action/run`. The Sales module stores no dashlet rows and reads no dashboard.

`action/jobMonitoring` reads the kernel's `jobs`, `job_logs` and `scheduled_jobs` for the jobs this
module registers (`sales.expireQuotes`, `sales.markOverdueInvoices`,
`sales.generateSubscriptionInvoices`) and answers `{ runs, schedules, queue }`. It never enqueues or
cancels: `POST /api/v1/Job` and `/api/v1/ScheduledJob` remain the only ways to start or stop work.
