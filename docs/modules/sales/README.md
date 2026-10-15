# Sales module (Phase 19-S)

Implemented in `apps/api/src/sales` (backend) with metadata in `database/seed-metadata.ts`, seeds in
`database/seed.ts` and migrations `database/migrations/021_phase19_sales.sql` +
`022_phase19_sales_module_rename.sql`. Functional reference: EspoCRM Sales Pack documentation
(<https://docs.espocrm.com/extensions/sales-pack/overview/>), reproduced as clean-room TypeScript
behaviour.

**Status: phases 19-S.0 – 19-S.5 only.** This is the *commercial foundation* tier — catalog, pricing,
tax and the shared money/document primitives. Quotes, orders, invoices, payments, credit notes,
purchases, inventory and subscriptions are **not implemented yet** and are not claimed here. The
authoritative scope and the phase-by-phase roadmap live in
[`PLAN_Phase_19_Sales.md`](../../PLAN_Phase_19_Sales.md).

## What it gives a user

| Capability | Where |
|---|---|
| Products and services with SKU, type, unit, active/sellable/purchasable flags and optional unit/list/cost prices | `/Product` list and detail (generic metadata-driven UI) |
| Hierarchical product categories with cycle and depth protection | `/ProductCategory` |
| Price books with currency, effective window and priority, plus entries with quantity breaks | `/PriceBook`, `/PriceBookEntry` |
| Declarative price rules (percentage / fixed / set-price adjustments) with deterministic ordering | `/PriceRule` |
| Suppliers and supplier purchase prices, kept separate from sales prices | `/Supplier`, `/SupplierProductPrice` |
| Tax classes, tax codes, tax rates and tax rules with effective windows and priorities | `/TaxClass`, `/TaxCode`, `/TaxRate`, `/TaxRule` |
| Module health, settings, numbering state, price resolution, bulk price update and totals preview | `/api/v1/Sales/action/*` |
| Stream, notes, attachments, audit history and field-level permissions | inherited from the kernel, no module code |

Records are ordinary metadata entities, so list/detail/create/edit/delete, search, filters, saved
filters, import/export and ACL come from the Entity Engine. Dedicated Sales screens are later work.

## Module layout

```text
apps/api/src/sales/
  sales-module.ts                module descriptor: id `sales`, version, load order, apiPrefix, phases
  sales.controller.ts            domain commands (`/api/v1/Sales/action/*`)
  sales-module-health.service.ts dependency evidence, optional integrations, feature flags, checks
  sales-settings.service.ts      the validated, versioned `sales` settings document
  sales-records.ts               allowlisted structural reads over the module's own entities
  clock.ts                       one date convention (`YYYY-MM-DD`, UTC default)
  catalog/                       product/category/price-book rules + their `beforeValidate` hook
  pricing/                       price rule engine, deterministic resolution, audited bulk update
  money/                         decimal-safe arithmetic and the currency scale contract
  tax/                           rule matching, rate selection, totals engine, preview service
  document/                      number series, immutable snapshots, issued-document locking
  dto/sales-shapes.ts            Zod request shapes
```

Nothing in `apps/api/src/sales` reimplements a kernel subsystem: no second ORM, ACL engine, scheduler,
settings store, audit log or currency module.

## Default data

`database/seed.ts` inserts the ten document number series once, with `ON CONFLICT DO NOTHING` and
never on boot: `quote` (`Q-`), `salesOrder` (`SO-`), `invoice` (`INV-`), `creditNote` (`CN-`),
`deliveryOrder` (`DO-`), `returnOrder` (`RO-`), `purchaseOrder` (`PO-`), `receiptOrder` (`GRN-`),
`bill` (`BILL-`), `billCredit` (`BC-`). The same list is the single source of truth for the runtime
service (`document/number-series-defaults.ts`), so seeded and runtime series cannot drift.

No demo products, price books or tax rules are ever created.

## Behaviour guarantees worth knowing

* A **missing price is never zero** — the default policy refuses the line; `allowExplicit` returns an
  explicitly *unresolved* result.
* A **missing tax is never zero** unless `tax.missingTaxPolicy` is deliberately set to `zero`.
* **Supplier prices can never become a sales price** — they live in a separate entity that price
  resolution does not read.
* **Two equally specific, equal-priority price rules are a conflict**, not an arbitrary winner.
* **Numbers are allocated at issuance** by default, and a retried allocation for the same document
  returns its existing number instead of consuming a second one.
* **Settings changes bump a version**, so a stored document snapshot can name the policy it was
  produced under.

## Verification

```bash
pnpm typecheck && pnpm lint
pnpm vitest run apps/api/test/sales-module.test.ts apps/api/test/sales-catalog.test.ts \
  apps/api/test/sales-pricing.test.ts apps/api/test/sales-tax.test.ts \
  apps/api/test/sales-money.test.ts
```

These suites target the configured primary database and create only `AGENT_TEST_<runId>` records that
they delete again by exact id. See [../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md)
§10 for what was and was not executed when this module was last touched.

## Deeper documents

* [overview.md](overview.md) — what the module is, its boundary, and the tier roadmap
* [product-catalog-and-pricing.md](product-catalog-and-pricing.md) — catalog, price books, rules, resolution
* [money-tax-currency.md](money-tax-currency.md) — decimal rules, currency scales, tax engine, totals
* [api.md](api.md) — the domain commands and their payloads
* [permissions.md](permissions.md) — who may do what, with worked examples
* [../../implementation/sales-repository-audit.md](../../implementation/sales-repository-audit.md) — the 19-S.0 audit
