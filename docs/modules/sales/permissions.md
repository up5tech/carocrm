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

Set permissions in the normal role editor. The catalog entities are `Product`, `ProductCategory`,
`PriceBook`, `PriceBookEntry`, `PriceRule`, `Supplier`, `SupplierProductPrice`, `TaxClass`, `TaxCode`,
`TaxRate`, `TaxRule`; the commercial ones are the document entities and their items (`Quote`,
`SalesOrder`, `Invoice`, `CreditNote`, `DeliveryOrder`, `ReturnOrder`, `PurchaseOrder`, `ReceiptOrder`,
`Bill`, `BillCredit` and each `…Item`), plus the money records (`Payment`, `PaymentAllocation`,
`BillCreditAllocation`, `CreditNoteAllocation`, `WriteOff`, `PaymentTermProfile`).

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
| `POST …/document`, `…/document/:kind/:id/transition\|convert\|recalculate` | the document entity's `create` / `edit` (the descriptor's entity) | `403` |
| `POST …/document/:kind/:id/unlock` | the document entity's `edit` **plus** the "unlock issued documents" permission, and a reason | `403` |
| `DELETE …/document/:kind/:id` | the document entity's `delete`; only a **draft** is removable | `403` / `422` |
| `POST …/quote/:id/render` | `Quote: read`; plus `DocumentTemplate: read` when a template is named or the default is used | `403` |
| `POST …/quote/:id/send` | `Quote: read`, `DocumentTemplate: read`, `Email: create` and `Email: edit`; plus `read` on the referenced Account/Contact for a draft | `403` |
| `POST …/action/expireQuotes`, `…/action/markOverdueInvoices` | administrator | `403` |
| `POST …/action/expire-quotes`, `…/action/mark-overdue-invoices` | the shared worker capability header `x-worker-secret` (no session) | `401` |
| `/api/v1/Sales/payment*`, `/allocation/:id` | the payment/allocation entity's own `create`/`edit`/`delete`, plus `Invoice: edit` to allocate against one | `403` |
| `POST …/creditNote/:id/allocate`, `DELETE …/creditNote/allocation/:id` | `CreditNote: edit` **and** `Invoice: edit` (the allocation changes both records) | `403` |
| `GET …/creditNote/allocatableInvoices` | `Invoice: read` | `403` |
| `POST …/creditNote/:id/render` | `CreditNote: read`; plus `DocumentTemplate: read` when a template is named or the default is used | `403` |
| `POST …/write-off` | `WriteOff: create` **and** `Invoice: edit`; the request stays `pending` | `403` |
| `POST …/write-off/:id/approve\|reject\|reverse` | **administrator** — approval authority is not a record edit | `403 Administrator access is required for …` |
| `POST …/action/resolveSupplierPrice` | `SupplierProductPrice: read` | `403` |
| `POST …/document` with a purchasing `kind` | that entity's `create`, **and** `features.purchases` enabled | `403` |
| `POST …/purchaseOrder/:id/refreshReceipt` | `PurchaseOrder: edit` | `403` |
| `POST …/billCredit/:id/allocate`, `DELETE …/billCredit/allocation/:id` | `BillCredit: edit` **and** `Bill: edit` (the allocation changes both) | `403` |
| `GET …/billCredit/allocatableBills`, `…/bill/:id/creditAllocations`, `…/allocatableDocuments` | `Bill: read` (the payment's own `read`/`edit` for the allocate/unallocate paths) | `403` |
| `POST …/document/:kind/:id/render` (any kind) | that entity's `read`; plus `DocumentTemplate: read` when a template is named or the default is used | `403` |

A quote **send** checks every one of its gates before it issues anything, so a caller who is refused
never leaves a `sent` quote with no email behind it. The requirement that surprises people is
`DocumentTemplate: read`: the template is what gets rendered, so a role that sends quotes needs it.
The metadata's declared default for `DocumentTemplate` is `read: 'all'`, but that default is
*declarative* — a field- or entity-level deny is real only once it is set on the role row itself.

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

## 5. Issued-document locking

`apps/api/src/sales/document/lock.ts` defines the rules the document engine applies:

* `protectedFields(kind)` names the fields that become immutable once a document is issued;
* `assertDocumentEditable(state, changedFields, policy)` refuses a change to a protected field —
  through the record API **and** through item writes, since a line carries the money facts;
* `assertUnlockAllowed(state, { isAdmin, canUnlock }, policy)` requires the dedicated
  **"unlock issued documents"** permission — an administrator counts, a normal editor does not — and
  the caller must record a reason in the audit trail;
* `isLocked(state, policy)` honours a privileged unlock: `unlockedAt`/`unlockedBy` are the recorded
  exception to the issue-time lock, so an unlocked document is editable again until it is locked.

`POST /api/v1/Sales/document/:kind/:id/unlock` exposes the privileged unlock (administrator plus
reason), and the write guard applies the field rules on every record write.

## 6. Purchasing capability boundaries (19-S.12, 19-S.13)

§4.12 asks for purchase-order management, receipt confirmation, bill issue, payment and stock
adjustment to be **separate authorities**. The module does not invent a permission system for that: it
uses the two the platform already has.

| Capability | Grant |
|---|---|
| Raise and confirm purchase orders | `PurchaseOrder: create/edit` |
| Confirm a receipt (the goods-arrived act) | `ReceiptOrder: edit` |
| Issue a supplier bill or a bill credit | `Bill: edit`, `BillCredit: edit` |
| Record and settle a supplier payment | `Payment: create/edit` + `Bill: edit` |
| Ship goods, take a return | `DeliveryOrder: edit`, `ReturnOrder: edit` |
| Adjust stock | **not grantable yet** — the ledger is 19-S.14, and with `features.inventory` on a stock-moving confirmation is refused |

Two gates sit in front of all of them:

* **`features.purchases`** (settings, administrator-changed): off means a purchasing document command
  returns `403` with the feature named, so an installation that never enabled procurement does not
  accumulate purchase orders by accident.
* **`features.inventory`**: on means the confirmation of a *stock-moving* document (`salesOrder`,
  `deliveryOrder`, `returnOrder`, `receiptOrder`) is refused until 19-S.14 exists, because silently
  succeeding would leave an operator believing stock had moved.

A clerk who may confirm receipts but never issue bills is therefore a role with `ReceiptOrder: edit`
and `Bill: noAccess` — no module-specific switch, and the same answer through the domain command or a
direct `PUT /api/v1/Bill/:id`.

## 7. Data-level safety rules the module follows

* Test data is created through the real API with `AGENT_TEST_<runId>` markers and deleted by exact id
  (`apps/api/test/support/sales-fixtures.ts`); no real customer record is ever used or modified.
* No command in this module sends email beyond the mail module's own queue, charges a card, or applies
  a stock effect: a confirmed delivery, return or receipt **records** the movement it stands for and
  nothing acts on it until the 19-S.14 ledger exists. No command writes to another module's tables.
* Structural reads (`SalesRecords`) allowlist the entity type and validate attribute names, and bind
  every value as a parameter — a request value can never become an SQL identifier.
