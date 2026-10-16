# Sales — Phase 19-S gap report (19-S.20 task 12)

`PLAN_Phase_19_Sales.md` §14, Phase 19-S.20: *"Produce a gap report listing deferred Tier 2/3/4 features
and unresolved jurisdiction/accounting items."* This is that list, and it is the authoritative statement
of what **is not** built. The implemented surface is in
[`docs/modules/sales/README.md`](../modules/sales/README.md); the published boundaries are in
[`docs/integrations/sales-contracts.md`](../integrations/sales-contracts.md).

Nothing below is represented as delivered anywhere in the repository: `SALES_MODULE.implementedPhases`
(and therefore `GET /api/v1/Sales/action/health`) stops at `19-S.16` plus `19-S.18`. `19-S.17` is absent
on purpose and its split is stated in §2: its document work (editor, send, templates, settings,
translations) is delivered, its review pass (per-entity screens, navigation enablement,
responsive/keyboard, import/export mappings) is not.

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
| PDF send for the **other nine** document kinds | §4.16, S.17 task 4 | **Delivered in this pass.** `POST /Sales/document/:kind/:id/send` (`sales/document/document-send.service.ts`) is the quote contract driven by the descriptor: it renders through the same `SalesDocumentRenderService` the `…/render` route serves, issues the draft through the kind's own `issues: true` transition, stores the message as an `Email` linked to the document and lets the mail module queue it. Three rules the wide surface forced: a **stock-moving draft refuses to be issued by sending** (confirming an order, delivery, return or receipt is a warehouse act, and the refusal names the command that does it); the **counterparty decides the default recipient** (a purchasing document goes to its supplier, a selling one to its contact then its account, and a document with neither is refused rather than mailed to nobody); and a missing mail transport or a missing optional `pdfkit` is refused **before** anything is issued, so no document ever claims to be sent with no email behind it. `quote` is refused here and keeps its documented route. Tested by `test/sales-document-send.test.ts` (9 API tests against the configured database, `MAIL_TRANSPORT=memory`, the queue hop stubbed), including the PDF: `Invoice-<number>.pdf`, stored as an `Attachment` under the `Email` with role `invoice-pdf`. | nothing outstanding |
| **Creating** a document with its lines from the UI | §9.3, S.17 task 2 | **Delivered in this pass.** The generic create form mounts the line editor whenever the entity is a document kind (`EntityEditPage.tsx`, `sales/documents.ts` for the per-kind date field, `useSalesPickers.ts` for the shared catalog lookups) and writes through `POST /Sales/document` with `{ data, items }`, so the document and its priced lines are one command. Save stays blocked with the reason until every line is priced — the same rule the totals engine applies (§4.3). Verified in the browser: a draft invoice typed to `2 × 55.00` at `0 %` tax showed the server's `110.00 / 0.00 / 110.00 USD` before saving, saved, and its detail screen then showed the same figures; the record was deleted afterwards. | a Sales-specific create route is still unnecessary — the metadata form plus the editor is the screen |
| The shared **line-item editor**, mounted | §9.3, S.17 task 2 | **Delivered in this pass.** `components/LineItemEditor.tsx` is rewritten (rows keyed by a stable client id instead of `position`, exported types, the real `previewTotals`/`resolvePrice` payloads — its response is flat, and the old client type claimed a nested `totals` object that made every figure render as zero) and mounted as the `items` panel of every document's detail screen (`components/SalesDocumentLinesPanel.tsx`, `sales/documents.ts`). Prices come from `resolvePrice` with its explanation, totals and tax breakdown from `previewTotals`, and an unpriced line blocks the save with the reason rather than being silently zeroed (§4.3). Verified in the browser on a draft invoice: adding an unpriced product disabled Save with both warnings shown; editing a price re-computed `100.00 + 10.00 → 110.00 USD` from the server; saving persisted (`200.00 / 20.00 / 220.00`). An issued document renders the panel read-only, because its lines are the ones its snapshot froze. | a Sales create screen (row above) |
| A **send** action in the UI beyond the quote modal | §9.4, S.17 tasks 4, 8 | **Delivered in this pass.** `DocumentSendModal.tsx` is rewritten (its recipient box was a hand-rolled chip editor with a broken `icon` prop and no caller) around antd's own tag select, and mounted on every document's line panel (`SalesDocumentLinesPanel.tsx`) as the **Send** action. It previews the server's render — the identical call `…/render` serves — lists the templates configured for that entity type, and leaves recipients empty on purpose: the backend derives the counterparty's address, so the guard is the server's refusal, not a client-side guess. Verified in the browser on a draft invoice: the preview, the placeholder warning and the recipient chip all rendered, and pressing Send against this dev instance — which has no mail transport — showed the refusal and left the invoice a **draft with no number**. | the send button is not yet hidden or disabled from `availableTransitions` and the transport state; the refusal is shown instead |
| A line's **tax** when no tax code is configured | §4.8, S.17 task 2 | **Fixed in this pass.** The editor offered only a tax-code picker, and `missingTaxPolicy: error` refuses a line whose tax is unanswered — so on an install with no `TaxCode` rows yet, no document could be priced at all. A line with no code now also takes a percent (`taxRatePercent`), which is what the totals engine already accepts. The same pass made the shipped default templates render clean: `templateData` now supplies the fields they ask for by name (`dueDate`, `amountDue`, `reason`, `warehouseId`, …) and the per-line `lineTotal`/`tax` aliases, and the return-order default no longer references a `restockable` field that does not exist. Guarded by an assertion that the default template renders with **zero** warnings. | nothing outstanding |
| Sales settings **saving** in the admin UI | §13, S.17 task 6 | **Fixed in this pass** (was a defect, now recorded so nobody re-breaks it): the panel was one `Form` per card and only the features card had a submit, so every other edit was discarded, and that one posted a `salesSettings` closure that had not been updated yet. It is now a single controlled form over the whole settings document, repainted from the server's answer, with the server's `warnings` and settings `version` shown. Verified in the browser: a save moved `version` 520 → 521 and re-rendered from the response. | nothing outstanding for the groups the schema has; the variant *attribute list* (an array of objects) is still edited through the API, not this screen |
| Per-module navigation enablement | §9.1, S.17 task 5 | The 36 Sales entities now group under one Sales submenu of six categories (`AppShell.tsx`, `sales.nav.*` keys), but the group appears whenever the entities are navigable — it is not switched by `sales` module enablement or by a Sales-specific permission, because the metadata ACL already decides entity visibility. | a module-visibility signal in `/Metadata/nav` if a customer ever needs to hide the whole domain |
| Dedicated Sales screens | §9, S.17 tasks 1, 8 | The Sales-specific pieces exist now: the line editor with its price picker, tax preview and server-computed totals panel (create **and** detail), the send modal, the settings screen, and the Sales submenu. Everything else about a Sales record — list, detail, search, filter, sorting, pagination, relationship panels — is the generic metadata-driven UI, which is the intended design (§9 says the screens consume metadata, not that they are re-implemented). What has **not** been done is the review the task asks for: no per-entity pass over all 36 Sales entities' layouts and ACL-aware actions, and the document commands other than Send (`issue`, `void`, `cancel`, `convert`, unlock-with-reason) are still API-only — a draft invoice can be sent from the UI, but voiding one cannot. | a per-entity layout/action review, then drive the remaining commands from `availableTransitions` and `availableConversions` on the document view |
| S.17 task 8 — responsive / keyboard / state audit | §9, §17 | Loading, empty, error and permission-denied states are implemented per screen (and the refusal paths above were exercised in the browser), but no systematic responsive or keyboard pass has been recorded for the Sales screens. | a Playwright pass at the breakpoints the platform supports, plus tab-order checks on the line editor and the send modal |
| S.17 task 9 — import/export mappings | §14 S.17 | Sales has no module-specific import/export surface: master data (products, prices, tax codes, warehouses, suppliers) imports through the kernel's ACL-aware entity import, and a document imported that way is a **draft** because the write guard refuses every server-owned field (`status`, `number`, the snapshot, the stock decisions). No mapping file exists per installation, and none is generated. | a mapping preset per entity if an installation asks for one; the guard needs no change |
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

`pnpm typecheck` and `pnpm lint` (both projects, `--max-warnings=0`) are clean. The whole Sales surface —
28 suites, 388 tests — was then run in one vitest invocation against the configured primary database,
with no database created, reset or truncated (AGENTS.MD §3). Counts are the tests each file reported:

| Suite | Tests | What it pins |
|---|---|---|
| `sales-money` 25, `sales-allocation-math` 29, `sales-tax` 19, `sales-terms` 10, `sales-pricing` 15, `sales-catalog` 10, `sales-fulfilment` 9, `sales-stock-movement` 8, `sales-picking` 26, `sales-tracking` 25, `sales-subscriptions` 19, `sales-quote-document` 6 | 201 | the pure invariants: decimal and currency scales, the conversion snapshot and its refusal cases, allocation and credit arithmetic, tax resolution, price rules, fulfilment/receipt derivation, movement plans, removal policy, variant/serial rules, the billing calendar, the quote document contract |
| `sales-documents` 14, `sales-quotes` 9, `sales-document-send` 9, `sales-payments` 13, `sales-credits` 16, `sales-delivery-returns` 15, `sales-purchasing` 16, `sales-inventory` 8, `sales-inventory-ledger` 15, `sales-supplier-price` 7, `sales-subscriptions-api` 13, `sales-module` 11 | 146 | the commands over HTTP: issuance, locking, conversions, double-billing guards, allocation balances, purchasing, stock effects, the recurring run, module health — including unauthorised and crafted-request paths |
| `sales-reporting-api` | 11 | 19-S.18: every curated dataset runs through the generic Report subsystem, ACL denial, the standard dashlets accepted and executed by the shared engine, job monitoring admin-only, import refuses forged issued state and balances, export honours the reader's access, stock valuation |
| `sales-base-currency` | 10 | 19-S.18: the snapshot is stored, reused on recalculation, immutable once issued, refused on a mismatched currency, and derived on payments, allocations and the write-off path |
| `sales-integrations-api` | 7 | 19-S.19: the accounting export answers from the snapshot with its tax breakdown and settlement rows, the customer summary groups by currency, and both refuse a reader without the underlying access |
| `document-module` | 13 | the template/render path the Sales print hook depends on (two of its assumptions about default-template selection and bounded lists were stale once 19-S.17 registered the Sales defaults, and are corrected against the real behaviour) |

The suites for the rest of the platform (`projects*`, `portal`, `phase12*`, `reports`, `packages/*`) were
not re-run for this phase; nothing in 19-S.18/19 changes a shared contract they depend on, and
`packages/reports`, `packages/document` and the Report/Dashboard kernel services were read rather than
modified.
