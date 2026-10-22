---
title: Configuring Sales
summary: Enable Sales features and set the currency, pricing, tax, numbering, stock, variant and subscription policy behind every document.
audience: admin
order: 131
tags: [sales, settings, pricing, tax, numbering, inventory, subscriptions]
related: [admin/module-settings, admin/settings-overview, user/sales-quotes, admin/entities-and-fields]
updated: 2026-10-22
---

The `sales` settings document is the policy behind quotes, orders, invoices, purchasing and stock. An
administrator edits it on the **Sales** tab; the module service validates and stores it, and every
calculation path reads it. [Quotes and orders](user/sales-quotes) is the user-side guide; this page covers
the switches and values behind it.

## The tab and how a save works

Open [Settings → Sales](/admin/settings/sales), an administrator-only tab in the administration rail. It
loads the `sales` document from `GET /api/v1/Sales/action/settings` and saves the whole draft with
`POST /api/v1/Sales/action/settings`, which only an administrator may call.

- Editing any control marks the draft dirty: the tab gets a dot and **Save** becomes available. **Discard**
  restores the loaded value and **Reload** fetches the stored document again.
- **Save** sends the entire draft, not a field patch. The module merges it, validates the whole document,
  bumps the version and writes the one `app_settings` row named `sales`; issued documents record the
  version they were priced under, so a later change does not rewrite their totals.
- A refused save changes nothing. The stored version stays as it was, and the tab shows the module's own
  reason, including the field path that failed.
- Unknown keys are refused rather than stored; the tab only renders what the module publishes.

> [!NOTE]
> The module endpoint is the authority: a policy it refuses stays unsaved until the named field is fixed.

## What starts on and what starts off

A fresh instance starts with the price sources and issuance locking on, and everything that writes records,
moves stock, spends money or bills on a schedule off.

| Feature | Default | What it changes |
| --- | --- | --- |
| Product prices | On | A product's own unit price can price a line. |
| Price books | On | Price book entries and rules can price a line. |
| Supplier prices | On | Lists supplier prices in the module report; no resolver checks the switch. |
| Issuance locking | On | Issued documents are locked; the switch is not consulted. |
| Tax-inclusive prices | Off | The default for a document that does not state its own tax-inclusive policy. |
| Product variants | Off | Turns variant-family and attribute validation on for products. |
| Purchases | Off | Enables purchase orders, receipt orders, bills and bill credits; declares supplier prices as its prerequisite. |
| Inventory | Off | Enables stock commands, movements at confirmation, availability and reservations. |
| Subscriptions | Off | Enables recurring billing commands and the due-invoice run. |
| Payment requests | Off | No server path gates on this switch. |
| Multi-currency | Off | No server path gates on this switch. |

## Currency and pricing

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| `currency.defaultCurrency` | A three-letter ISO code the module knows | `USD` | The currency used when a record names none. |
| `quantityPrecision` | 0–6 | `2` | Maximum fraction digits accepted for a quantity. |
| `pricing.resolution` | `priceBookFirst`, `productFirst` | `priceBookFirst` | Which source wins when both can price a line. |
| `pricing.allowCustomPrice` | On or off | On | Whether a manually entered price may be used as the fallback. |
| `pricing.missingPricePolicy` | `error`, `allowExplicit` | `error` | Whether an unresolvable price throws or is reported as unresolved. |

The currency code is normalized to uppercase and checked against the module's currency table; unknown
codes are refused, and each currency has its own fraction digits (USD 2, JPY 0, KWD 3). A document may
carry its own currency, else the default applies.

`priceBookFirst` tries price books, then the product price; `productFirst` reverses it. A book in another
currency is skipped. With both sources off every line needs an explicit price, and the module warns you; an
explicit price is refused unless `allowCustomPrice` is on. `allowExplicit` reports a price as unresolved
instead of inventing a zero.

> [!NOTE]
> The multi-currency switch is stored but not enforced. Documents can carry a non-default currency and an
> optional exchange-rate snapshot whether it is on or off; base-currency amounts appear only with a snapshot.

## Numbering

Numbers are allocated from a series per document kind, and the tab lists the seeded series with their
prefix, next number and allocation column: Quote `Q-`, sales order `SO-`, invoice `INV-`, credit note
`CN-`, delivery order `DO-`, return order `RO-`, purchase order `PO-`, receipt order `GRN-`, supplier bill
`BILL-`, bill credit `BC-`.

A number is the literal prefix plus the zero-padded counter; there are no date or document-field tokens.
Provisioned series allow a prefix of up to 16 characters and padding of 1–12 (default 6). Numbers are
allocated at issuance, so a draft never consumes one; reissuing a document returns its existing number.

> [!NOTE]
> The series table is read-only and the allocation selector is stored only; allocation happens at issuance.

## Tax

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| `tax.missingTaxPolicy` | `error`, `zero` | `error` | Refuse a line without tax, or record an explicit zero-tax resolution with a warning. |
| `tax.shippingTaxCode` | A tax code id, 1–64 characters, or empty | Empty | Tax applied to shipping when the document names no shipping tax code. |
| `tax.roundingStage` | `line`, `document` | `line` | Round each line before summing, or sum exact values and round the totals once. |
| `tax.roundingMode` | `half-up`, `half-even`, `floor`, `ceil` | `half-up` | How a value that misses the currency scale is rounded. |

When tax-inclusive pricing is on, a line price is gross and the net is backed out; the difference is tax. A
document can override the default, and the rounding mode also applies to price-rule adjustments.

## Inventory

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| `inventory.defaultWarehouseId` | A warehouse id, 1–64 characters, or empty | Empty | Warehouse used when a stock-moving document names none. |
| `inventory.stockManagedProductTypes` | Up to 20 names, 1–32 characters each | `Goods` | The `Product.productType` values that move stock. |
| `inventory.allowNegativeStock` | On or off | Off | Whether a movement may take a warehouse below zero. |
| `inventory.reservationPolicy` | `none`, `soft`, `hard` | `hard` | Off, record an over-reservation, or refuse one above availability. |
| `inventory.adjustmentApprovalRequired` | On or off | On | Whether a stock adjustment waits for approval before it moves stock. |
| `inventory.removalPolicy` | `fifo`, `fefo`, `lifo` | `fifo` | Which lots or serials an outbound movement picks first. |
| `inventory.excludeExpiredStock` | On or off | On | Whether an expired lot is excluded from automatic picking. |

The `inventory` feature gates every stock command; a product type not in the list is never stock-managed,
and a movement with no warehouse and no default is refused. With purchases off, confirmed purchase orders
are not incoming stock; negative stock is allowed only by its switch.

## Variants

Variant attributes are configuration, not code. Each attribute has a `code` (1–24 characters, starting with
a letter and continuing with letters, digits or underscores) and a `label` (1–64 characters). Up to 20 are
allowed, and two attributes may not share a code, compared case-insensitively. `requireAllAttributes` is on
by default: a product that joins a family must carry every configured attribute.

The `productVariants` feature controls validation, not storage. With it off, variant fields are stored
unvalidated and mean nothing. With it on, an attribute needs a family, and two products of one family may
not carry the same combination. Turning the feature on while the attribute list is empty is warned about.

## Subscriptions

- `subscriptions.horizonDays` (1–1095, default `365`): how far past the run day an open-ended term is
  generated.
- `subscriptions.maxPeriodsPerRun` (1–500, default `24`): periods one run may create for one subscription.
- `subscriptions.maxInvoicesPerRun` (1–1000, default `50`): invoices one run may issue across all
  subscriptions.

The `subscriptions` feature is the gate: with it off, billing commands refuse and the due run reports itself
disabled. With it on, a run creates missing periods up to the limits and issues one invoice per due period;
anything beyond a limit waits for the next run.

## Stored but not enforced

These values are accepted, versioned and shown, but no calculation or command acts on them:

- `features.multiCurrency`, `features.paymentRequests` and `features.issuanceLocking`.
- `features.supplierPrices`: the supplier-price resolver reads supplier prices without checking it.
- `numbering.allocation`, and the allocation column on each series row: allocation always happens at
  issuance.

Issuance locking is always applied, so turning that switch off does not reopen an issued document. Payment
requests and non-default document currencies work regardless of their switches.

## What can go wrong

| Symptom | The field or prerequisite behind it |
| --- | --- |
| A line prices from the product although a price book exists | `pricing.resolution` is `productFirst`, price books are off, or no applicable entry matched. |
| "This installation does not allow a manually entered price." | `pricing.allowCustomPrice` is off. |
| A currency is refused as unsupported | `currency.defaultCurrency` is not a known three-letter code. |
| A quantity is rejected for too many decimals | `quantityPrecision` is lower than the quantity's fraction digits. |
| "Line N has no applicable tax rate." | `tax.missingTaxPolicy` is `error`; configure a rate or choose `zero`. |
| Totals differ from a spreadsheet by a cent | `tax.roundingStage` or `tax.roundingMode` differs from the calculation. |
| Stock commands say inventory is not enabled | `features.inventory` is off, or no warehouse is named and no default is set. |
| The allocation selector changes nothing | It is stored only; numbers are taken at issuance. |

## Where to go next

- [Quotes and orders](user/sales-quotes) — what a user does with the policy you set here.
- [Module settings](admin/module-settings) — the other module documents and their defaults.
- [The administration area](admin/settings-overview) — the draft, save bar and version model.
