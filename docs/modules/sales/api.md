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
    "implementedPhases": ["19-S.0", "19-S.1", "19-S.2", "19-S.3", "19-S.4", "19-S.5"]
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

## Errors

All failures use the kernel error envelope. The Sales module raises `ValidationError` (→ `422`),
`DuplicateRecordError` (→ `409 DUPLICATE_RECORD`, e.g. a duplicate SKU), `NotFoundError` (→ `404`),
`AuthorizationDeniedError` (→ `403`) and `InvalidQueryError` (→ `422`) for a request body that fails its
schema. Validation reasons are attached as `error.details.reason` or `error.details.issues`, which is
what the tests assert on and what the UI shows.

## Not yet exposed

Quotes, sales orders, invoices, credit notes, payments, deliveries, purchases, inventory and
subscriptions have no routes yet — those arrive with phases 19-S.6 onward. Their number series are
already seeded so they do not need a migration later.
