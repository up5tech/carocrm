# Product catalog and pricing

Phases **19-S.3** (catalog) and **19-S.4** (price books, price rules, supplier prices).
Implementation: `apps/api/src/sales/catalog/` and `apps/api/src/sales/pricing/`, with entity metadata
in `database/seed-metadata.ts` and indexes in `database/migrations/021_phase19_sales.sql`.

## 1. Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `Product` | Product/service definition | `sku`, `productType` (`Goods` \| `Service`), `active`, `isSellable`, `isPurchasable`, `unit`, `categoryId`, `taxClassId`, `defaultTaxCodeId`, `unitPrice`, `listPrice`, `costPrice` |
| `ProductCategory` | Hierarchical categorisation | `parentId`, `active`, `sortOrder`, `description` |
| `PriceBook` | Named price collection | `currency`, `accountId`, `priority`, `effectiveFrom`, `effectiveTo`, `active` |
| `PriceBookEntry` | One product's price inside a book | `priceBookId`, `productId`, `unitPrice`, `minQuantity`, `effectiveFrom`, `effectiveTo`, `unit` |
| `PriceRule` | Declarative adjustment | `priceBookId`, `priority`, `active`, `criteria`, `actionType`, `actionValue`, `productIds`, `categoryIds`, `accountIds`, `minQuantity`, `maxQuantity`, `effectiveFrom`, `effectiveTo` |
| `Supplier` | Supplier master data | `active`, terms, currency preference, supplier code |
| `SupplierProductPrice` | Supplier-specific buying price | `supplierId`, `productId`, `unitPrice`, `active` |

All of them are ordinary metadata entities in `entity_records`, so list/detail/create/edit/delete,
search, filters, import/export, stream, attachments, audit and ACL come from the Entity Engine.

## 2. Rules enforced on `beforeValidate`

`SalesCatalogGuardService` registers one hook (`sales.validate`, phase `beforeValidate`) that
dispatches on the entity type. Registering it on the hook phase — not in a controller — is what makes
`POST /api/v1/Product` and a domain command obey exactly the same rules.

### Product

* **SKU** is trimmed and upper-cased, then matched against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
* **SKU uniqueness is installation-wide and case-insensitive**, enforced by a partial unique index
  over `entity_records (lower(attrs ->> 'sku')) WHERE entity_type = 'Product' AND deleted_at IS NULL`.
  The hook turns the constraint into a clear `409 DUPLICATE_RECORD` before the insert.
* `productType` must be `Goods` or `Service`.
* `unitPrice`, `listPrice`, `costPrice` are canonical, **non-negative** decimal strings.
* `active`, `isSellable`, `isPurchasable` must be booleans.

### ProductCategory

* A category cannot be its own parent.
* A category cannot be moved under one of its own descendants (resolved ancestor chain check).
* Depth is bounded at **32** levels (`MAX_CATEGORY_DEPTH`), which keeps an ancestor walk finite.

### PriceBook / PriceBookEntry

* A currency must be a supported ISO 4217 code (`money/currency.ts`).
* `priority` is an integer in `0 … 10 000`.
* Effective windows are `YYYY-MM-DD`, inclusive at both ends, and `from` must not be after `to`.
* A price-book entry's `minQuantity` must be **greater than zero**.

### Sellable / purchasable gating

`salesGate()` and `purchaseGate()` are pure functions that return `{ allowed, reason }`. The reason
string is what the API returns and the UI shows — a refusal is never silent:

* inactive product → `Product "…" is inactive.`
* non-sellable → `Product "…" is not sellable.`
* non-purchasable → `Product "…" is not purchasable.`

## 3. Price resolution (`PriceResolutionService`)

Deterministic and explainable: the same context always yields the same price, and the result names
**which** source won and **why**.

**Precedence** (plan §4.3), configurable only through documented policy:

1. a selected, applicable **price book entry** (with the quantity break that fits), or an applicable
   **price rule** applied on top of it;
2. the product's own **`unitPrice`**, when product prices are enabled and no book price applies;
3. an **explicit user-entered price**, only where the role permits it (`pricing.allowCustomPrice`);
4. otherwise the request is **refused** — a missing price is never defaulted to zero.

The settings value `pricing.resolution` (`priceBookFirst` | `productFirst`) selects which of 1 and 2 is
consulted first; `pricing.missingPricePolicy` (`error` | `allowExplicit`) selects whether a miss is an
error or an explicitly *unresolved* result.

**Result shape** — `resolved`, `price`, `currency`, `scale`, `source`
(`priceBookEntry` | `priceRule` | `productUnitPrice` | `explicit`), a human `explanation`, and a
`trace` of the steps taken. The trace is the answer to "why did this price win", which is what makes
overlapping configurations debuggable.

**Eligibility rules applied while resolving:**

* an entry or rule outside its effective window is ignored (windows are inclusive);
* an entry whose `minQuantity` exceeds the requested quantity is ignored, so quantity breaks are
  honoured;
* an entry whose price book currency differs from the document currency is ignored, with the trace
  stating it (`is in EUR, not USD`);
* inactive products and non-sellable products are refused through `salesGate()` before any price work;
* **`SupplierProductPrice` is never read here.** Buying prices live in a separate entity, so a
  supplier price cannot leak into a sales document by an accidental fallback.

**Rule ordering** (`orderPriceRules`), never database row order:

1. lower `priority` first;
2. then **narrower** `specificity` first, where specificity is a simple, documented sum:
   `productIds` **+8**, `categoryIds` **+4**, `accountIds` **+2**, a quantity bound **+1**;
3. then `id` ascending, purely so the order is total.

Two rules with the **same priority and the same specificity are a conflict** and the request is
refused (`422`) naming the competing rules, rather than a coin toss between them.

**Rule actions** (`applyPriceRuleAction`), all rounded exactly once at the currency scale:

| Action | Semantics | Validation |
|---|---|---|
| `percentAdjustment` | `base × (100 − percent) / 100` | `percent` in `0 … 100` |
| `fixedAdjustment` | `base − amount` | `amount ≥ 0`; a result below zero is **refused**, not clamped |
| `setPrice` | the amount itself (usable with no entry at all) | `amount ≥ 0` |

A rule with no criteria is **book-wide**: it applies to every product the price book resolves, which
is a documented configuration (§4.3 lists criteria as supported conditions, not a requirement). Each
id list, when present, holds 1 – 500 entries. There is **no SQL, no JavaScript and no formula string**
in a price rule: an administrator cannot make the server execute arbitrary code through pricing.

## 4. Bulk price update (`BulkPriceService`)

`POST /api/v1/Sales/action/bulkPriceUpdate` with `mode: 'preview' | 'apply'`:

* **preview** returns every change (`entryId`, `from`, `to`), a `changedCount`, and changes nothing;
* **apply** performs the same computation inside one transaction, writes an `audit_log` row for the
  price book, and returns the `auditId`;
* the run is **bounded** (`limit`) and reports `truncated: true` instead of silently processing a
  partial set;
* the caller must be able to read the price book, and to `apply` must be an administrator.

## 5. What is deliberately not here yet

* **Product variants** — `features.productVariants` defaults to `false`; variants arrive in 19-S.15.
* **Product-level pricing switch** — `features.productPrices` can be turned off, and the UI must not
  assume `unitPrice` exists.
* **Customer-specific price books through Account metadata** — the association field exists on
  `PriceBook`; deeper Account-side extension is later work.
* **Repricing prompts for open draft documents** — there are no documents yet (19-S.6+).
