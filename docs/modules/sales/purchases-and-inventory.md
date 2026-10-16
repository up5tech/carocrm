# Sales — purchases and inventory

Scope: the purchasing half of the module (19-S.13) and the inventory ledger that applies the stock
effects every stock-moving document stands for (19-S.14). Both are driven by the same document engine
described in [README.md](README.md); this page is about what is different on the buying side and about
how a quantity is tracked.

Reference: EspoCRM Sales Pack documentation — Purchases, Purchase Orders, Receipt Orders, Bills, Bill
Credits and Inventory Management (<https://docs.espocrm.com/extensions/sales-pack/overview/>),
reproduced as clean-room TypeScript behaviour. `PLAN_Phase_19_Sales.md` §4.11, §4.15 and §4.12 are the
product requirements.

## Purchasing (19-S.13)

`purchaseOrder → receiptOrder → bill → billCredit`, gated by `features.purchases` (off by default). A
purchasing command with the flag off is refused with a clear 403 rather than quietly creating records
nobody configured.

| Rule | Where |
|---|---|
| The four kinds are descriptors + metadata entities, not four copies of the engine | `document/descriptors.ts`, `database/seed-metadata.ts` |
| Receipt state (`partiallyReceived` / `received`) is **derived** from confirmed receipt orders; over-receipt is refused against the order line | `document/receipt.ts`, `refreshReceipt()` |
| A receipt names its order; a bill raised from a receipt names both; a bill credit names the bill it corrects | `linkToSource` on each conversion |
| Bill due dates come from the referenced `PaymentTermProfile` exactly like an invoice's; an explicit due date wins | `document/terms.ts` |
| An outgoing payment settles a `Bill`, an incoming one settles an `Invoice`; a payment may not name both an account and a supplier | `payments/allocation-math.ts` |
| A bill credit reduces a payable through its own `BillCreditAllocation` rows and is fully unallocated when issued; a reversal keeps the row with `reversedAt`/`reversedBy`/`reversalReason` | `payments/bill-credit.service.ts` |
| Supplier prices live in `SupplierProductPrice` and are resolved by `resolveSupplierPrice` only — the sales resolver never reads them | `pricing/supplier-price.ts` |
| A supplier named by an issued bill or a confirmed order keeps its identity (name, code, currency, tax id) | `catalog/product-rules.ts::assertSupplierEditable` |

Capabilities are separate grants, not one flag: purchase-order management is `edit` on `PurchaseOrder`,
receipt confirmation on `ReceiptOrder`, bill issue on `Bill`, payment on `Payment`, all under
`features.purchases`.

Deferred: bill overdue marking (the daily job covers invoices only), and batch/serial *tracking*
entities (19-S.15) — a receipt line stores the `batchNumber`/`serialNumber` the operator recorded, but
no stock identity table validates it yet.

## Inventory (19-S.14)

Off unless `features.inventory` is on. When it is on, every physical quantity change is a row in the
append-only movement ledger, and the figures a user sees are derived from it.

### The ledger

`InventoryTransaction` is an ordinary metadata entity (list/detail/search/ACL/audit come from the Entity
Engine) with these guarantees:

* **Append-only.** A correction is a new, compensating row, never an edit or a delete. The write guard
  refuses every client write and the metadata declares `edit`/`delete` as `no`.
* **Traceable.** Each row records the product, the warehouse, a signed `quantityDelta`, a
  `transactionType`, the source entity/id/number, a reason where one is required, the actor and
  `occurredAt`. The sign is fixed by the type: `receipt`, `return`, `transferIn` and `openingBalance`
  are inbound; `delivery` and `transferOut` are outbound; `adjustment` and `correction` may be either.
* **Idempotent.** `movementKey` is derived from the source document and line —
  `DeliveryOrder:<id>:delivery:<position>` — never from a request, and a unique index (migration 028)
  backs the service's pre-check. A retried confirmation asks for the same movement once.

### Availability

`GET /api/v1/Sales/inventory/availability` returns four figures that reports must keep apart:

| Figure | Meaning |
|---|---|
| `onHand` | physical stock — the sum of the ledger for the pair |
| `reserved` | promised to confirmed documents but not yet shipped |
| `available` | `onHand − reserved` — what a new order may still promise |
| `incoming` | confirmed purchase orders net of receipts, plus transfers that are `inTransit` toward the warehouse |

### The projection and reconciliation

`on_hand`/`reserved` are persisted in `sales_inventory_stock` (migration 028) for two reasons: it is
the **lock target** that makes concurrent reservations safe, and it keeps availability reads off an
aggregate over the whole ledger. It is a *projection*, not a second truth: `POST
/api/v1/Sales/inventory/reconcile` recomputes each pair's ledger sum and compares it, returning
`{ checked, ok, mismatches }`. A mismatch is **reported**, never auto-corrected — writing it away would
erase the evidence of what caused it, and a stock correction must be an explicit, reviewed adjustment.

### Adjustments (reviewed corrections)

`POST /api/v1/Sales/inventory/adjustment` records a correction with a required reason. When
`inventory.adjustmentApprovalRequired` is on (the default) it stays `pending` and **moves nothing**;
approval writes the ledger row and marks it `applied`, rejection leaves stock untouched. The decision
is administrator-only, and a decided adjustment is final.

### Transfers (two linked effects)

`TransferOrder` has the states `draft → inTransit → received`, plus `cancelled` from `draft`:

* `confirm` applies the **source outflow** and moves the transfer to `inTransit`;
* `receive` applies the **destination inflow** and moves it to `received`;
* a dispatched transfer can no longer be cancelled — the source half has already moved, and a
  correction is a reverse transfer, never a silent rewind.

The intermediate state is deliberate: while the goods are between warehouses they are visible as
`incoming` at the destination rather than missing. Receiving twice is refused by the state machine, and
each side has its own movement key, so neither half can be applied twice.

### Reservations

A reservation is a **soft** promise: it raises `reserved`, lowers `available`, and never touches
`onHand`. `inventory.reservationPolicy` decides the behaviour:

* `hard` (default) refuses a reservation larger than `available`;
* `soft` records the over-reservation and reports the shortfall;
* `none` disables reservations entirely.

Confirming a sales order places one reservation per line; a delivery **consumes** the reservation as it
ships; cancelling a confirmed order **releases** it. Under concurrency, every reserve/consume/release
takes a row lock on the (product, warehouse) level first, so two confirmations cannot both promise the
last unit.

### Which products are stock-managed

`inventory.stockManagedProductTypes` (default `["Goods"]`) lists the `Product.productType` values that
move stock. A line whose product is not in the list never produces a movement, so a service product
stays a service. `inventory.allowNegativeStock` (default off) is the explicit override for a movement
that would take a warehouse below zero.

### Relationship to the documents

A confirmed delivery/return/receipt freezes a `stockMovement` plan into its issuance snapshot
(`document/stock-movement.ts`). With `features.inventory` on, `InventoryService.applyMovementPlan`
applies that plan **inside the same transaction** as the confirmation, so a refused movement rolls the
confirmation back rather than leaving a confirmed document with no stock. With the flag off the plan
stays a recorded intention, which is the honest state for an install that tracks no stock.

## Permissions

* Warehouses are ordinary records: `create`/`read`/`edit`/`delete` on `Warehouse`.
* The ledger is read-only to users (`read`), never writable.
* Reservations are placed by the `reserve` command or by confirming a sales order (`create` on
  `InventoryReservation`); releasing needs `edit`.
* Adjustments may be *requested* with `create` on `InventoryAdjustment`; the decision is
  administrator-only.
* Transfers need `create`/`edit` on `TransferOrder`; each side applies against the transfer's state.

## Verification

See the block in [README.md](README.md#verification). `sales-inventory-ledger` is the pure suite;
`sales-inventory` is the API suite and restores `features.inventory` in `afterAll`.
