# Sales permissions

Two layers, and they are deliberately separate:

1. **Kernel ACL** — every Sales entity is a metadata record, so record-level access (own / team / all)
   and field-level permissions are enforced by the Entity Engine and the ACL service for list, detail,
   create, edit, delete, search, export and relations. The module writes no ACL code of its own.
2. **Domain-command checks** — the `/api/v1/Sales/action/*` routes ask the ACL service the specific
   question each command implies, and gate the administrative ones on the administrator flag.

Hiding a control in the UI is never the enforcement point; every check below runs on the server.

---

## 1. Entity-level access

Set permissions for the eleven entities in the normal role editor:
`Product`, `ProductCategory`, `PriceBook`, `PriceBookEntry`, `PriceRule`, `Supplier`,
`SupplierProductPrice`, `TaxClass`, `TaxCode`, `TaxRate`, `TaxRule`.

| Action | Meaning for Sales |
|---|---|
| `read` | List/see products, price books, tax rules, … |
| `create` | Add catalog/pricing/tax records |
| `edit` | Change them (and run a bulk price **apply**) |
| `delete` | Remove them |
| `stream` | See the record's stream |

A role with `noAccess` on `Product` gets `403` from `GET /api/v1/Product` **and** from
`POST /api/v1/Sales/action/resolvePrice`, because the command checks the same permission.

## 2. Field-level access

The canonical example is cost price. A role may read `Product` while a field permission on
`Product.costPrice` (`read: no`) hides it:

* `GET /api/v1/Product/:id` omits `costPrice` for that role and still returns `unitPrice`;
* a `PUT` that tries to write `costPrice` is refused with `403`;
* an administrator sees the value.

The same mechanism gates price-book prices: `PriceBookEntry.unitPrice` (`read: no`) makes
`resolvePrice` fail with `422` rather than silently returning a book price the caller may not see.

## 3. Domain-command permissions

| Command | Requirement | Failure |
|---|---|---|
| `GET /api/v1/Sales/action/health` | administrator | `403 Administrator access is required for module diagnostics.` |
| `GET /api/v1/Sales/action/settings` | authenticated | — |
| `POST /api/v1/Sales/action/settings` | administrator | `403 Administrator access is required for changing Sales settings.` |
| `GET /api/v1/Sales/action/numbering` | administrator | `403 Administrator access is required for document numbering.` |
| `POST …/resolvePrice` | `Product: read`; plus `PriceBook: read` when a price book is supplied; plus `PriceBookEntry.unitPrice: read` when a book price would be used | `403` |
| `POST …/bulkPriceUpdate` | `PriceBookEntry: read` for `preview`, **`edit`** for `apply` | `403` |
| `POST …/previewTotals` | `Product: read` when any line names a product | `403` |

Worked examples, matching the API tests:

* A user with `noAccess` asking for a price → `403`.
* A user who may read `Product` but not `PriceBook` gets `403` when they name a price book, and `200`
  with the product's own unit price when they do not.
* A user with `PriceBookEntry: read` but not `edit` can **preview** a bulk price change and is refused
  when they try to **apply** it.

## 4. Custom prices are a policy decision, not just a permission

Entering a price by hand requires **both**:

* `pricing.allowCustomPrice = true` in the Sales settings, and
* `PriceBookEntry.unitPrice: edit` for the caller.

Without the setting the request fails with `422 This installation does not allow a manually entered
price.`; without the field permission it fails with `422 This user may not enter a custom price.`

## 5. Issued-document locking (primitives ready, documents arrive later)

`apps/api/src/sales/document/lock.ts` already defines the rules the invoice/credit phases will use:

* `protectedFields(kind)` names the fields that become immutable once a document is issued;
* `assertDocumentEditable(state, changedFields, policy)` refuses a change to a protected field;
* `assertUnlockAllowed(state, { isAdmin, canUnlock }, policy)` requires the dedicated
  **"unlock issued documents"** permission — an administrator counts, a normal editor does not — and
  the caller must record a reason in the audit trail.

No route exposes these yet, because no document type exists yet.

## 6. Data-level safety rules the module follows

* Test data is created through the real API with `AGENT_TEST_<runId>` markers and deleted by exact id
  (`apps/api/test/support/sales-fixtures.ts`); no real customer record is ever used or modified.
* No command in this module sends email, charges a card, moves stock or writes to another module's
  tables.
* Structural reads (`SalesRecords`) allowlist the entity type and validate attribute names, and bind
  every value as a parameter — a request value can never become an SQL identifier.
