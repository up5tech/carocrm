# Sales — Phase 19-S gap report (19-S.20 task 12)

`PLAN_Phase_19_Sales.md` §14, Phase 19-S.20: *"Produce a gap report listing deferred Tier 2/3/4 features
and unresolved jurisdiction/accounting items."* This is that list, and it is the authoritative statement
of what **is not** built. The implemented surface is in
[`docs/modules/sales/README.md`](../modules/sales/README.md); the published boundaries are in
[`docs/integrations/sales-contracts.md`](../integrations/sales-contracts.md).

Nothing below is represented as delivered anywhere in the repository: `SALES_MODULE.implementedPhases`
(and therefore `GET /api/v1/Sales/action/health`) stops at `19-S.16` plus `19-S.18`, and `19-S.17` is
absent from it on purpose.

---

## 1. Tier status

| Tier | Scope | State |
|---|---|---|
| 1 — Commercial foundation | products, price selection, tax/total engine, quotes, sales orders, invoices, payments and allocations, ACL, audit, API | **delivered** (19-S.0 – 19-S.10) |
| 2 — Lifecycle completeness | credit notes, write-offs, delivery and return orders, advanced price books, multi-currency, payment terms, issuance locking | **delivered** (19-S.11 – 19-S.13, with the multi-currency persistence gap closed in 19-S.18 — see §3) |
| 3 — Procurement and inventory | suppliers, purchase orders, receipts, supplier bills and credits, warehouses, stock ledger, transfers, reservations, batches and serials | **delivered** (19-S.13 – 19-S.15) |
| 4 — Recurring and advanced | subscriptions and the recurring invoice job, payment requests, payment-to-payment transfers, reports and dashboards, integration contracts | **delivered** (19-S.16, 19-S.18, 19-S.19) |
| 4 — E-invoicing / export adapters, deeper integrations | | **not delivered** — §2 |

## 2. Deferred features, with the reason

| Item | Plan ref | Why it is not here | What it would take |
|---|---|---|---|
| PDF **attachment** on a sent document | §4.16, S.17 tasks 3–4 | `@carocrm/document` renders PDFs from the block model and every kind exposes `…/render`, but turning rendered bytes into an outbound `Attachment` needs the kernel attachment-storage path, which is not built. Quote send emails the rendered **text** body today. | an attachment-write seam in the kernel (`apps/api/src/attachment`), then a `format: pdf` send path and an audit entry |
| Dedicated Sales screens | §9, S.17 tasks 1–2, 5, 8 | Sales records are ordinary metadata entities, so list/detail/edit/search/filter/sort/paginate/panels come from the generic Entity Engine UI. No Sales-specific line-item editor, price picker or totals panel exists yet; nothing in §9's screen layout is claimed. | frontend work on `apps/web` against the existing entity/layout metadata; no backend change needed |
| Admin settings UI coverage for every policy group | §13, S.17 task 6 | The validated settings document and its API (`GET/POST /Sales/action/settings`) are complete and each group is validated; the admin screen exposes the groups the earlier phases needed. | render the remaining groups from the same schema rather than a new API |
| Document creation **from an Opportunity** | §4.5, §4.6 | The link fields exist (`Quote.opportunityId`) and `convert` exists between document kinds; the Opportunity→document command was never written. | a conversion command from a non-document source entity, with its own double-billing rule |
| Stock effect of an *invoice* | §4.10 | Movements are attached to the fulfilment documents (delivery, return, receipt) and to adjustments/transfers, which is where a physical move happens. | only if a jurisdiction or business model really bills and ships in one step |
| E-invoicing / PEPPOLIS / SDT / e-invoice export | §4.16 | Deliberate non-goal until an external format owner exists; the accounting export (§11.3 contract) is the closest thing and is a read contract, not a filing. | a format adapter module outside Sales, consuming `action/accountingExport` |
| FX gain/loss recognition, journal entries, general ledger | §4.13, §1.2 | Sales is not a ledger. `docs/integrations/sales-contracts.md` §3 is the hand-off an accounting module posts from. | an `AccountingIntegration` module; Sales needs no change |
| Real gateway calls (Stripe, …) | §11.2 | By design: `PaymentRequest` and the idempotent provider-event intake are the whole interface. No credential is stored and no SDK is called. | a consumer module that owns keys and calls the provider |
| Jurisdiction-specific tax behaviour beyond rate resolution | §4.12, §4.16 | The engine resolves tax by class/code/rate/rule with an effective window, records the frozen breakdown and a free-text `jurisdiction`, and stops there. Reverse charge, OSS/IOSS, withholding, e-invoice mandatories and country filing are **unresolved**. | per-jurisdiction rules as data plus a filing adapter; each needs a real requirement, not a guess |
| Event-schema version envelope | §6.4, S.19 task 7 | Events carry stable ids, canonical money, resulting balances, actor and `correlationId`, and the two published read contracts return `contractVersion`. The kernel `outbox_events` row itself has **no version column**, so a uniform per-event version is not enforceable without a kernel change. | add versioning to the kernel outbox/bus, then stamp every Sales event |
| Scheduled report delivery for Sales datasets | §10.1 | The generic Report subsystem already schedules and delivers any saved report by email; Sales adds no dataset-specific schedule. | none — save a dataset as a report and use the kernel schedule |

## 3. Unresolved accounting items

* **External sync state is not stored by Sales.** `action/accountingExport` answers
  `externalSync: { accountingReference: null, syncedAt: null }` by design (§11.3): an accounting module
  keeps its own reference against the document ids. If a future requirement needs Sales to *show* the
  sync state, that is a new field with its own write guard, not a re-use of these nulls.
* **No realized/unrealized FX distinction.** A payment and the document it settles are converted through
  the rates frozen on each of them; the difference between the two is not computed, classified or
  reported anywhere. That is an accounting recognition concern (§4.13).
* **Payment-to-payment allocation is a transfer record, not a revaluation.** `PaymentTransferAllocation`
  moves an unapplied amount between payments and does not restate either payment's base figures.
* **Base-currency coverage is partial by nature.** `baseGrossTotal`/`baseAmount` exist only on records
  created or issued with a supplied conversion. Reports that sum them are therefore totals of the
  *converted* subset — stated in each dataset's `moneyBasis` and description, and the reason the
  per-currency datasets exist alongside them (§12.4).

### 3.1 What 19-S.18 fixed

The plan asked (§4.13) that the rate, its date and its source be **persisted** on documents and on the
allocations that need conversion. Before that phase the module read `exchangeRateSnapshot` in three
places — the document recalculation, the cross-currency allocation gate and the bill-credit conversion —
and **nothing ever wrote it**. Consequences: `baseCurrency`/`baseGrossTotal` were always null, and a
cross-currency allocation could never be authorised. 19-S.18 closed the loop for documents, payments,
payment allocations, credit and bill-credit allocations and write-offs, with the immutability rules that
come with it (an issued document and a payment with allocations refuse a new rate). Evidence:
`apps/api/test/sales-base-currency.test.ts`.

## 4. Known limitations that are *not* gaps

* A cross-currency allocation needs the **document's** conversion snapshot; without one it is refused,
  naming the missing fact (§4.13). This is the policy, not a missing feature.
* `PaymentFlow`-style base reports sum only payments recorded with a rate; a payment without one is money
  in its own currency and appears in the per-currency dataset instead.
* Stock valuation (`GET /Sales/inventory/valuation`) uses each product's `costPrice`, which has no
  currency of its own; the figure is labelled with the installation's default Sales currency, and
  products without a parsable cost are reported as `unpricedOnHand` rather than valued at zero.
* Sales analytics read `baseGrossTotal`/`baseAmount`; nothing in the reporting path recomputes a rate.

## 5. Release posture

`features.productVariants`, `features.purchases`, `features.inventory`, `features.subscriptions`,
`features.paymentRequests` and `features.multiCurrency` all default to **off** (only `priceBooks`,
`supplierPrices` and `issuanceLocking` are on): an installation opts in per capability, the commands
refuse with the setting named, and `GET /Sales/action/health` reports the flags and the checks. Nothing
in the module sends mail, charges a card, calls a provider or moves stock as a side effect of a read, and
no test in the Sales suites does any of those either.

## 6. Verification evidence (19-S.20 tasks 1–4, 7)

`pnpm typecheck` and `pnpm lint` (both projects, `--max-warnings=0`) are clean. Every suite below was run
against the configured primary database, one vitest invocation each, with no database created, reset or
truncated (AGENTS.MD §3). Counts are the tests each file reported:

| Suite | Tests | What it pins |
|---|---|---|
| `sales-money` 25, `sales-allocation-math` 29, `sales-tax` 19, `sales-terms` 10, `sales-pricing` 15, `sales-catalog` 10, `sales-fulfilment` 9, `sales-stock-movement` 8, `sales-picking` 26, `sales-tracking` 25, `sales-subscriptions` 19, `sales-quote-document` 6 | 201 | the pure invariants: decimal and currency scales, the conversion snapshot and its refusal cases, allocation and credit arithmetic, tax resolution, price rules, fulfilment/receipt derivation, movement plans, removal policy, variant/serial rules, the billing calendar, the quote document contract |
| `sales-documents` 14, `sales-quotes` 9, `sales-payments` 13, `sales-credits` 16, `sales-delivery-returns` 15, `sales-purchasing` 16, `sales-inventory` 8, `sales-subscriptions-api` 13, `sales-module` 11 | 115 | the commands over HTTP: issuance, locking, conversions, double-billing guards, allocation balances, purchasing, stock effects, the recurring run, module health — including unauthorised and crafted-request paths |
| `sales-reporting-api` | 11 | 19-S.18: every curated dataset runs through the generic Report subsystem, ACL denial, the standard dashlets accepted and executed by the shared engine, job monitoring admin-only, import refuses forged issued state and balances, export honours the reader's access, stock valuation |
| `sales-base-currency` | 10 | 19-S.18: the snapshot is stored, reused on recalculation, immutable once issued, refused on a mismatched currency, and derived on payments, allocations and the write-off path |
| `sales-integrations-api` | 7 | 19-S.19: the accounting export answers from the snapshot with its tax breakdown and settlement rows, the customer summary groups by currency, and both refuse a reader without the underlying access |
| `document-module` | 13 | the template/render path the Sales print hook depends on (two of its assumptions about default-template selection and bounded lists were stale once 19-S.17 registered the Sales defaults, and are corrected against the real behaviour) |

The suites for the rest of the platform (`projects*`, `portal`, `phase12*`, `reports`, `packages/*`) were
not re-run for this phase; nothing in 19-S.18/19 changes a shared contract they depend on, and
`packages/reports`, `packages/document` and the Report/Dashboard kernel services were read rather than
modified.
