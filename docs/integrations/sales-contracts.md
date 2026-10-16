# Sales integration contracts (Phase 19-S.19)

`PLAN_Phase_19_Sales.md` §11. Sales is a **producer of commercial facts and a consumer of payment
outcomes**. It is not a gateway, a ledger, or a customer-health system, and these contracts are the
boundary where another module may read or drive it. Every shape here is versioned:
`SALES_CONTRACT_VERSION` (`apps/api/src/sales/integrations/sales-integration.service.ts`) is echoed as
`contractVersion` in every answer, adding a field is compatible, and renaming, retyping or removing one
raises the version.

No integration calls into Sales' tables. There is no second API surface either: every route below is the
same `/api/v1/Sales` prefix the UI uses, with the same authentication, the same entity and field
permissions, and the same record-level ACL.

```text
apps/api/src/sales/
  integrations/sales-integration.service.ts   the two read contracts (accounting, customer success)
  payments/payment.service.ts                 payment requests and provider events (§11.2)
  common/outbox.service.ts (kernel)           the event envelope every Sales event is written into
```

---

## 1. Who may call what

| Contract | Route | Needs | Writes |
|---|---|---|---|
| Payment request | `POST /api/v1/Sales/paymentRequest` | `Payment` create | one `PaymentRequest` record |
| Provider event ingestion | `POST /api/v1/Sales/providerEvent` | worker capability (`x-worker-secret`) or `Payment` edit | one idempotent event log row, and at most one payment |
| Accounting export | `POST /api/v1/Sales/action/accountingExport` | read on the document + on the settlement entities it reports | nothing |
| Customer commercial summary | `POST /api/v1/Sales/action/customerSummary` | read on `Invoice`, `CreditNote`, `Payment`, `Subscription` | nothing |
| Document render | `POST /api/v1/Sales/document/:kind/:id/render` | read on the document | nothing |
| Commercial events | outbox rows, delivered by the worker | — | the module's own commands produce them |

A consumer that lacks a read permission gets `403`; it does not get a partial document with the
inaccessible half elided. That is deliberate: a summary with holes in it is worse in an accounting or
success review than no summary at all.

---

## 2. Stripe / gateway integration (§11.2)

Sales is gateway-neutral. It holds **no API keys, no SDK calls and no card data**, and refuses requests
that look like they carry any.

### 2.1 `PaymentRequest` — the intent to be paid

A provider-neutral record: `amount`, `currency`, `accountId`, optional `invoiceId` / `salesOrderId`,
`expiresAt`, `status` (`pending → paid | failed | expired | cancelled`), and `providerReference` — a
*label*, never a credential. The state machine is walked by `POST /api/v1/Sales/paymentRequest/:id/transition`;
a gateway decides nothing on its own.

### 2.2 Provider events — idempotent by the provider's own id

`POST /api/v1/Sales/providerEvent` accepts `{ provider, providerEventId, eventType, paymentRequestId?,
payload }` and guarantees:

* **Duplicate delivery changes nothing.** `uq_payment_provider_event` (migration `024`) is unique on
  `(provider, providerEventId)`; a second delivery returns the existing row with `duplicate: true` and
  creates no payment, no allocation and no second settlement.
* **Card data is refused, not stored.** Any payload key matching
  `card|cvc|cvv|pan|iban|bic|secret|token|password|private_key|mandate` (case-insensitive) is rejected
  before the record is written. Consumers send a *summary*.
* **A confirmed event settles, a failed one does not.** `payment.paid` marks the request paid and records
  the corresponding `Payment` through the same payment command, so balances are derived by allocation,
  not asserted by the gateway.
* **Correlation travels.** Every event keeps the caller's `correlationId`, and the resulting outbox
  events carry it, so one payment can be traced across the delivery, the log row and the ledger.

Retries are the queue's (§10.2 of the plan): the delivery job is bounded and idempotent because the
provider event id is. Nothing in Sales auto-retries a charge.

---

## 3. Accounting export (§11.3)

`POST /api/v1/Sales/action/accountingExport { kind, id }` returns one document exactly as it was billed:

```jsonc
{
  "contractVersion": 1,
  "document": {
    "kind": "invoice", "entity": "Invoice", "id": "…", "number": "INV-000042",
    "status": "issued", "issuedAt": "…", "fromSnapshot": true,
    "currency": "USD", "baseCurrency": "EUR", "baseGrossTotal": "198.00",
    "exchangeRate": "0.9", "exchangeRateSnapshot": { "…": "the frozen rate, its date and its source" },
    "totals": { "subtotal": "…", "discountTotal": "…", "shippingAmount": "…", "shippingTaxAmount": "…",
                "taxTotal": "…", "netTotal": "…", "grossTotal": "…", "amountDue": "…",
                "taxInclusive": false, "roundingStage": "line", "roundingMode": "half-up",
                "settingsVersion": 7 },
    "taxBreakdown": [ { "taxCodeId": "…", "taxCodeName": "…", "taxRatePercent": "10",
                        "taxableBase": "…", "taxAmount": "…" } ],
    "parties": { "accountId": "…", "supplierId": null, "contactId": null },
    "lines": [ { "position": 1, "productId": "…", "name": "…", "sku": "…", "unit": "…",
                 "quantity": "1", "unitPrice": "…", "discountAmount": "…", "netAmount": "…",
                 "taxAmount": "…", "grossAmount": "…", "taxCodeId": "…", "taxRatePercent": "10",
                 "taxSource": "line" } ]
  },
  "settledBy": { "allocations": [], "credits": [], "writeOffs": [] },
  "externalSync": { "accountingReference": null, "syncedAt": null }
}
```

The rules a consumer can rely on:

* **An issued document answers from its frozen snapshot** (`fromSnapshot: true`). Catalog prices, tax
  rates and settings may move on; the exported numbers do not. `settingsVersion` names the policy the
  figures were produced under.
* **`amountDue` is the exception, and is deliberately live.** It is the receivable the balance service
  maintains from the settlement rows — the snapshot's own `amountDue` was only ever "what it owed at
  issuance". `settledBy` lets a consumer reconcile the difference line by line.
* **Money is never converted at read time.** `baseCurrency`/`baseGrossTotal` and each settlement row's
  `baseAmount` come from the snapshot frozen on that record (§4.13). Records without a conversion report
  `null`, not a zero and not today's rate.
* **Reversed corrections are history, not money.** A credit allocation or write-off with `reversedAt` set
  is excluded from `settledBy`, matching the balances exactly (§4.9).
* **References, not ids-only**: each document carries its human `number`, and each settlement row carries
  the actor and timestamp that made it, so a consumer can post and audit without re-reading Sales.
* **`externalSync` belongs to the consumer.** Sales does not know what an accounting system filed. The
  two fields stay `null` in this module by design: an accounting module keeps its own reference and sync
  state against these ids rather than writing into a commercial record that is locked.

Purchasing exports the same way with `kind: "bill"` / `"billCredit"`, where `parties.supplierId` is the
counterparty and `settledBy.credits` is filled from `BillCreditAllocation` (§4.12).

---

## 4. Customer Success summary (§11.4)

`POST /api/v1/Sales/action/customerSummary { accountId }` is the read-only commercial position a success
console shows: how much is outstanding, what credit is waiting to be applied, what has recently been
paid, and what is on recurring billing.

```jsonc
{
  "contractVersion": 1,
  "accountId": "…",
  "receivables": {
    "openInvoiceCount": 2,
    "outstandingByCurrency": [ { "currency": "USD", "amount": "170.00", "count": 2 } ],
    "oldestUnsettled": "2026-11-14",
    "unappliedCreditByCurrency": [ { "currency": "USD", "amount": "0.00", "count": 0 } ]
  },
  "recentPayments": [ { "id": "…", "reference": "…", "paymentDate": "…", "amount": "50.00",
                       "currency": "USD", "baseAmount": "45.00", "baseCurrency": "EUR",
                       "allocationStatus": "allocated" } ],
  "activeSubscriptions": [ { "id": "…", "name": "…", "renewalDate": "…", "currency": "USD" } ],
  "truncated": false
}
```

* Outstanding is the **live** `amountDue` of issued, unsettled invoices, summed **per currency** — the
  summary never adds two currencies (§12.4). Base-currency figures are attached only where the record has
  a frozen conversion.
* `truncated: true` means a bounded page was reached (200 invoices, 200 credits, 20 payments, 100
  subscriptions), so a consumer cannot mistake a bounded read for a complete one.
* The summary is read-only in every sense: it cannot settle, allocate, refund or bill. The commands for
  those are Sales' own, and require their own permissions.

---

## 5. Events Sales emits (§6.4)

Every commercial change writes into the kernel outbox inside the same transaction as the rows it
describes (`common/outbox.service.ts`), and the worker delivers them on the domain-event bus. Payloads
carry stable ids, the money facts as canonical decimal strings, the resulting balances, the actor and the
`correlationId`; they never carry secrets or provider payloads.

| Event | Emitted when | Consumer-relevant fields |
|---|---|---|
| `sales.document.issued` / `.voided` / `.unlocked` | a document takes or loses its official status | entity, id, number, totals, actor, reason |
| `sales.payment.recorded` / `.allocated` / `.unallocated` | money arrives or is applied | payment id, allocation id, both resulting balances |
| `sales.creditNote.issued` / `.allocated` / `.reversed` | a correction is raised, applied or compensated | note id, invoice id, remaining credit |
| `sales.writeOff.approved` / `.rejected` / `.reversed` | a forgiveness is decided | write-off id, invoice id, amount, approver |
| `sales.stock.movement` | a confirmed document or adjustment moves stock | product, warehouse, signed quantity, source document |
| `sales.inventory.reserved` / `.released` | availability is promised or returned | product, warehouse, quantity, policy |
| `sales.subscription.periodCreated` / `.invoiceGenerated` / `.billingFailed` | the recurring run claims, bills or fails a period | subscription, period, invoice id, failure code, idempotency key |
| `sales.invoice.overdue`, `sales.quote.expired` | a scheduled sweep changed a status | document id, the date it acted as of |

Downstream rules the plan requires (§6.4, §11.5): consumers are **idempotent** — the subscription events
key on `idempotencyKey`, the document events on the document id and the transition, and a retried
delivery of the same provider event creates nothing (§2.2). Delivery retries and backoff belong to the
queue (`apps/api/src/jobs`), not to Sales, and Sales never sends mail, charges a card or posts to an
external endpoint as a side effect of reading.

---

## 6. Links into CRM Core (§11.1) — what already exists, what does not

| Relationship | Status |
|---|---|
| `Quote.accountId` / `contactId` / `opportunityId`, `Invoice.accountId` / `contactId` | done — ordinary metadata links, so the CRM-side panels (`Account.quotes`, `Account.invoices`, `Opportunity.quotes`) come from the Entity Engine, and record-level ACL applies to them |
| Opportunity → quote/order | the link exists and is editable; **creating a document from an Opportunity is not implemented** and is stated as such in `docs/modules/sales/README.md` |
| `Invoice.subscriptionId` / `subscriptionPeriodId` | done (19-S.16), both directions |
| Documents → Project / Activity | not implemented; Sales adds no link and claims no activity feed |
| `Sales` as a consumer of the CRM pipeline | read-only: the module never writes `Opportunity`, `Lead` or `Contact` |

---

## 7. Optional modules must not be load-bearing (§19-S.19 task 6)

`GET /api/v1/Sales/action/health` reports `optionalIntegrations` — `stripeIntegration`,
`accountingIntegration`, `customerSuccess`, each `{ present, … }` — and the module **starts and serves
its own flows with all three absent**. Sales depends on the kernel only (entity engine, metadata, ACL,
audit, outbox, jobs, mail, files, documents); everything else is a consumer at the boundary described
above. The same health response states the feature flags, so an installation without inventory or
subscriptions says so rather than failing a command mysteriously.

## 8. What these contracts do *not* promise

* No general ledger, no journal entries, no FX gain/loss recognition (§1.2, §4.13) — that is an
  accounting module's job, from the export above.
* No payment execution, no stored credentials, no card tokens (§11.2).
* No e-invoice or jurisdiction-specific filing (§4.16): the export carries a free-text `jurisdiction` and
  the tax breakdown, and nothing more.
* No re-rating of history. If a conversion was never recorded, the base fields stay `null` forever.
