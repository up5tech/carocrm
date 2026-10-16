# Sales — module overview

## 1. What `Sales` is

`Sales` is the commercial-operations domain of this CRM. In this project the name means the
**extended commercial operations / Sales Pack domain**, not a replacement for basic CRM lead and
opportunity management. The target lifecycle is product and pricing setup → quote → confirmed sales
order → fulfilment → invoice issuance → payments → credits/corrections, and — where enabled —
recurring subscriptions and purchasing/inventory.

| Field | Value |
|---|---|
| Module id | `sales` |
| Display name | Sales & Commercial Operations |
| Domain directory | `apps/api/src/sales` |
| Domain-command prefix | `/api/v1/Sales` |
| Load order | 320 (after the kernel and Projects) |
| Version | 1.0.0 |
| Implemented phases | 19-S.0 – 19-S.15 (`sales-module.ts` → `implementedPhases`; 19-S.16 – 19-S.20 are not claimed) |

## 2. Module boundary — who owns what

| Capability | Owner | `Sales` responsibility |
|---|---|---|
| Accounts, Contacts | CRM core | Reference and extend through metadata relationships only |
| Leads and lead conversion | CRM core | Consume the conversion result; never reimplement qualification |
| Opportunities and pipelines | CRM core | Link opportunities to commercial documents; never create a competing Opportunity entity |
| Products and prices | **`Sales`** | Catalog, price books, price rules, supplier prices, price selection |
| Quotes and commercial orders | **`Sales`** | Documents, line items, totals, lifecycle (19-S.6+) |
| Invoices, credits, payments | **`Sales`** | Document state, balances, allocations, audit trail (19-S.9 – 19-S.11, supplier side 19-S.13) |
| Purchases and inventory | **`Sales`** | Purchasing delivered behind the `purchases` feature (19-S.13); warehouses, the stock ledger, adjustments, transfers and reservations delivered behind `inventory` (19-S.14); lots, serialised units and FIFO/FEFO/LIFO removal delivered behind the same flag (19-S.15) |
| General ledger, tax filing, statutory accounting | Accounting module (absent) | Publish integration contracts; never claim accounting compliance |
| Card gateway, bank connection | Payment provider module (absent) | Expose provider-neutral payment intents/events; never embed gateway secrets or SDK calls |
| Customer lifecycle, churn | Customer Success module (absent) | Publish customer/invoice/subscription summary contracts; never implement health scoring here |

## 3. Delivery tiers

The full module is deliberately tiered so that a complete ERP is not attempted in one iteration.
Later tiers must not contradict Tier-1 invariants.

| Tier | Contents | Status |
|---|---|---|
| **Tier 1 — Commercial foundation** | Products, price selection, tax/total engine, quotes, sales orders, invoices, basic payments/allocations, ACL, audit, PDF/email, API | **Delivered** (19-S.0 – 19-S.10), with PDF *attachments* on a sent document still open (the block model and renderer exist). |
| **Tier 2 — Lifecycle completeness** | Credit notes, write-offs, delivery orders, returns, advanced price books, multi-currency documents, payment terms, issuance locking | **Delivered** (19-S.11 credit notes/write-offs; 19-S.12 delivery and return orders: partial moves, derived fulfilment, restock dispositions, one stock-movement plan per document). Payment terms, issuance locking and multi-currency foundations came earlier. |
| **Tier 3 — Procurement and inventory** | Suppliers, purchase orders, receipts, supplier bills/credits, warehouses, stock ledger, transfers, reservations, batches/serials | **Purchasing delivered** (19-S.13, behind `features.purchases`): purchase orders, partial/full receipts with derived receipt state, supplier bills, supplier payments and bill credits, supplier price resolution. **Inventory delivered** (19-S.14, behind `features.inventory`): warehouses, the append-only stock ledger and its projection, availability, reservations, reviewed adjustments, two-sided transfers and reconciliation. **Stock identity delivered** (19-S.15): configurable product variants, lot and serial records with expiry validation, deterministic FIFO/FEFO/LIFO picking, transfer/return traceability and identity reconciliation. |
| **Tier 4 — Recurring and advanced** | Subscriptions, recurring invoice jobs, payment requests, payment-to-payment allocations, advanced reporting, e-invoicing adapters | Not started (19-S.16 – 19-S.19) |

## 4. What exists today, concretely

Delivered by 19-S.0 – 19-S.5:

1. **Module identity and diagnostics** — a stable module descriptor, a load order, an API prefix, a
   health endpoint that *proves* each required kernel capability from the running platform's own
   state (metadata registry, `information_schema`, hook phases) rather than asserting it, and a report
   of which optional integrations are absent.
2. **Settings** — one validated, versioned `sales` row in the kernel's `app_settings`, with feature
   flags for price books, product prices, variants, supplier prices, purchases, inventory,
   subscriptions, payment requests, multi-currency and issuance locking, plus pricing, tax, numbering,
   currency and quantity-precision policy. Coherence problems surface as warnings, not as a refused
   save.
3. **Money primitives** — decimal-safe arithmetic with explicit rounding modes, an ISO 4217
   minor-unit scale table, and validated document exchange-rate snapshots. No JavaScript `number`
   ever touches a monetary amount.
4. **Document primitives** — atomic number series allocation (row lock + ledger + unique constraints,
   so a retry returns the existing number), immutable snapshot build/read with a digest, and issued
   document lock state with protected-field checks.
5. **Product catalog** — `Product` and `ProductCategory` with normalised SKUs, installation-wide
   case-insensitive uniqueness, cycle and depth protection, and server-side active/sellable/
   purchasable gating.
6. **Pricing** — `PriceBook`, `PriceBookEntry`, `PriceRule`, `Supplier`, `SupplierProductPrice`;
   deterministic, explainable resolution; conflict detection; and a previewed, bounded, audited bulk
   price update. The **buying** side resolves from `SupplierProductPrice` alone through its own command
   (19-S.13), and the two resolvers never read each other's entities.
7. **Tax and totals** — `TaxClass`, `TaxCode`, `TaxRate`, `TaxRule`; declarative matching with
   effective windows and priorities; tax-inclusive/exclusive handling; line vs document rounding; and
   a server-calculated subtotal → discount → shipping → tax → total → amount-due breakdown.

## 5. How it stays decoupled

* **No mandatory optional dependency.** Optional modules are detected through the metadata registry
  (a marker entity), never imported, so their absence can never break startup.
* **No private-table coupling.** Other modules consume Sales through published contracts, not by
  querying Sales entity types in `entity_records`.
* **Kernel first.** Every record is a metadata entity served by the Entity Engine; the module only
  adds the rules that span more than one record, registered on the `beforeValidate` hook so a record
  arriving through the generic `/api/v1/:entity` routes is validated exactly like one arriving through
  a domain command.

## 6. Related documents

* [README.md](README.md) — capability table, layout, guarantees
* [product-catalog-and-pricing.md](product-catalog-and-pricing.md)
* [money-tax-currency.md](money-tax-currency.md)
* [api.md](api.md) · [permissions.md](permissions.md)
* [`PLAN_Phase_19_Sales.md`](../../PLAN_Phase_19_Sales.md) — authoritative scope and roadmap
* [../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) — the 19-S.0 audit
