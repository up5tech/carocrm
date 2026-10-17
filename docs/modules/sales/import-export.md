# Sales import and export (19-S.17 task 9)

Sales uses the platform's own CSV import/export — the same routes, the same ACL, the same column
engine — rather than a mapping file per installation. That choice has one consequence worth stating
plainly: **the mapping is the CSV header**, and it is the same header an export writes.

## Routes

| Route | What it does |
|---|---|
| `GET /api/v1/:entity/action/exportColumns` | the columns an export writes and an import reads, as `{ name, type }[]` |
| `POST /api/v1/:entity/action/export` | CSV of the caller's own records (ACL applies), body `{ where, select, orderBy }` |
| `GET /api/v1/:entity/action/export` | the same export from a query string |
| `POST /api/v1/:entity/action/import` | `{ csv, updateOnName? }`; the header names the fields, one row per record |

`apps/api/test/sales-import-export.test.ts` pins the contract for every Sales entity: the column list
exists and matches the metadata, an export's header is that list, a duplicate SKU is still refused on
import, and a document can only arrive as a draft.

## What imports

| Entity group | Columns that matter | Notes |
|---|---|---|
| `Product`, `ProductCategory` | `name`, `sku`, `productType`, `active`, `isSellable`, `isPurchasable`, `unit`, `categoryId`, `taxClassId`, `defaultTaxCodeId`, `unitPrice`, `listPrice`, `costPrice`, `stockTracking`, `variantFamily` | `sku` is stored upper-cased and unique; a duplicate is a refusal, not an update |
| `PriceBook`, `PriceBookEntry`, `PriceRule` | `name`, `active`, `priority`, `currency`, `priceBookId`, `productId`, `unitPrice`, `minQuantity`, `effectiveFrom`, `effectiveTo` | entries and rules are records of their own, so import them after the book exists |
| `TaxClass`, `TaxCode`, `TaxRate`, `TaxRule` | `name`, `code`, `taxClassId`, `ratePercent`, `priority`, `effectiveFrom`, `effectiveTo` | a rate belongs to a code; import the code first |
| `Supplier`, `SupplierProductPrice` | `name`, `active`, `supplierId`, `productId`, `unitPrice`, `currency`, `minOrderQuantity` | buying prices only — never a sales price |
| `Warehouse`, `Supplier`…, `PaymentTermProfile`, `PaymentMethod`, `PaymentChannel` | their editable header fields | master data |
| `Subscription` | `name`, `accountId`, `planCode`, `interval`, `status`, `currency` | a period is **not** importable — it is computed by the billing run |

Link columns carry a **record id** (`accountId`, `productId`), not a name: an import cannot resolve a
name to an id, because two accounts may share one.

## What does not import: commercial documents

A document can be created as a **draft** (`name`, `currency`, `accountId`, `contactId`, dates,
`description`) and the import then stops, because everything else about a document is either the
server's or the pricing that must be agreed:

- `status`, `number`, the totals (`subtotal`, `taxTotal`, `grossTotal`, `amountDue`, …), `snapshot`,
  the issuance and lock fields, `paymentStatus` — all refused by name, on the client path and on import
  as much as on a crafted `PUT` (`sales-internal.ts`, §4.7);
- the **lines** — a document needs at least one priced one, and a price is never assumed (§4.3). The
  `POST /Sales/document` command refuses an empty line set, and `POST /Sales/document/fromOpportunity`
  takes the same lines;
- a number — allocated at issuance, never imported.

So the honest rule for an installation moving data in: **master data by CSV, documents by the UI or
the API command**. An imported draft opens in the line editor, is priced there, and is issued from the
document screen — the same path a new document takes.

`POST /Sales/document` with no lines answers `422` rather than creating a document nobody can issue;
`GET /Sales/document/:kind/:id` answers for an imported (line-less) draft with zeroed totals, so the
screen that offers to add the lines can actually open.

## Currency and decimals

Money cells keep their canonical decimal string (`12.34`). The kernel coerced them to a JS number,
which the record store refuses on a decimal field — that made every product impossible to import, and
is fixed in `apps/api/src/search/import-export.service.ts`. Dates are `YYYY-MM-DD`; booleans accept
`true/false/yes/no/1/0`; enums their value (`Goods`, `all`, `fifo`).
