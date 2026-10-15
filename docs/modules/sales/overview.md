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
| Implemented phases | 19-S.0 – 19-S.10 (`sales-module.ts` → `implementedPhases`; 19-S.11 – 19-S.20 are not claimed) |

## 2. Module boundary — who owns what

| Capability | Owner | `Sales` responsibility |
|---|---|---|
| Accounts, Contacts | CRM core | Reference and extend through metadata relationships only |
| Leads and lead conversion | CRM core | Consume the conversion result; never reimplement qualification |
| Opportunities and pipelines | CRM core | Link opportunities to commercial documents; never create a competing Opportunity entity |
| Products and prices | **`Sales`** | Catalog, price books, price rules, supplier prices, price selection |
| Quotes and commercial orders | **`Sales`** | Documents, line items, totals, lifecycle (19-S.6+) |
| Invoices, credits, payments | **`Sales`** | Document state, balances, allocations, audit trail (19-S.9 – 19-S.11) |
| Purchases and inventory | **`Sales`** | Behind settings and permissions (19-S.13 – 19-S.15) |
| General ledger, tax filing, statutory accounting | Accounting module (absent) | Publish integration contracts; never claim accounting compliance |
| Card gateway, bank connection | Payment provider module (absent) | Expose provider-neutral payment intents/events; never embed gateway secrets or SDK calls |
| Customer lifecycle, churn | Customer Success module (absent) | Publish customer/invoice/subscription summary contracts; never implement health scoring here |

## 3. Delivery tiers

The full module is deliberately tiered so that a complete ERP is not attempted in one iteration.
Later tiers must not contradict Tier-1 invariants.

| Tier | Contents | Status |
|---|---|---|
| **Tier 1 — Commercial foundation** | Products, price selection, tax/total engine, quotes, sales orders, invoices, basic payments/allocations, ACL, audit, PDF/email, API | **Partially delivered:** catalog, pricing, tax and the shared money/document primitives are done (19-S.0 – 19-S.5). Quotes/orders/invoices/payments are not. |
| **Tier 2 — Lifecycle completeness** | Credit notes, write-offs, delivery orders, returns, advanced price books, multi-currency documents, payment terms, issuance locking | Not started (19-S.11 – 19-S.12) |
| **Tier 3 — Procurement and inventory** | Suppliers, purchase orders, receipts, supplier bills/credits, warehouses, stock ledger, transfers, reservations, batches/serials | Not started (19-S.13 – 19-S.15); the `Supplier` and `SupplierProductPrice` *master data* already exists |
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
   price update.
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
