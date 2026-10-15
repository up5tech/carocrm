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
    "implementedPhases": ["19-S.0", "19-S.1", "19-S.2", "19-S.3", "19-S.4", "19-S.5", "19-S.6", "19-S.7", "19-S.8", "19-S.9", "19-S.10"]
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
`…/:id/recalculate`, `POST /api/v1/Sales/action/expireQuotes` (and the worker-authorized
`action/expire-quotes`), `action/markOverdueInvoices`, `salesOrder/:id/refreshFulfilment`,
`/api/v1/Sales/payment*`, `/api/v1/Sales/allocation/:id`, `/api/v1/Sales/paymentRequest`,
`/api/v1/Sales/providerEvent`. `kind` is one of `quote`, `salesOrder`, `invoice`, `creditNote`,
`deliveryOrder`, `returnOrder`. The per-command behaviour is described in
[README.md](README.md#document-engine-19-s6--19-s12-in-progress), and every request body is the Zod
schema of the same name in `apps/api/src/sales/dto/sales-shapes.ts`.

Credit notes (beyond their descriptor), delivery/return stock effects, purchases, inventory and
subscriptions have no working routes yet — those arrive with 19-S.11 onward.
