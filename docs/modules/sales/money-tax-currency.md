# Money, currency, tax and totals

Phases **19-S.2** (money + currency contract) and **19-S.5** (tax engine, currency snapshot, totals).
Implementation: `apps/api/src/sales/money/` and `apps/api/src/sales/tax/`.

Everything on this page is pure arithmetic over canonical decimal strings. No JavaScript `number` is
used for a monetary or quantity value anywhere in the module.

---

## 1. Decimal arithmetic (`money/decimal.ts`)

The platform has no decimal library, so the module owns one.

| Item | Value |
|---|---|
| Representation | `Decimal = { units: bigint, scale: number }` — exact, no binary floating point |
| Rounding modes | `half-up` (default), `half-even`, `floor`, `ceil` |
| Max scale | 12 fraction digits (`MAX_DECIMAL_SCALE`) |
| Max significant digits | 28 (`MAX_DECIMAL_DIGITS`) |
| Serialization | `format()` → plain decimal string, e.g. `"110.00"` |

Operations: `parseDecimal`, `add`, `subtract`, `sum`, `multiply`, `multiplyTo`, `divideTo`,
`percentageOf`, `rescale`, `compare`, `isNegative`, `abs`, `negate`, `zero`, `minOf`, `maxOf`,
`format`, and `netFromInclusive` (extract the tax-exclusive net from a tax-inclusive gross).

Division and percentage operations require an explicit target scale and mode, so rounding is always a
deliberate act at a named stage rather than an accident of a language operator.

## 2. Currency (`money/currency.ts`)

The kernel has **no currency registry and no exchange-rate facility** — `currency` is a metadata field
type that stores a canonical decimal string and is cast to `numeric` inside query expressions. Until a
platform currency module exists, this file states the contract explicitly.

* **`CURRENCY_SCALES`** — ISO 4217 minor-unit digits for the supported currencies (0 for JPY/KRW/VND…,
  2 for USD/EUR/CNY…, 3 for BHD/KWD/TND…, 4 for CLF/UYW). `currencyScale(code)` reads it; an unknown
  code is refused rather than guessed.
* **`normalizeCurrencyCode`** — trims, upper-cases and validates `^[A-Z]{3}$` against the table.
* **`Money = { amount, currency, scale }`** — an amount is always paired with its currency; `addMoney`,
  `subtractMoney` and `compareMoney` call `assertSameCurrency` first, so amounts in different
  currencies can never be silently combined.
* **`ExchangeRateSnapshot`** — the persisted rate fact of a document:
  `documentCurrency`, `baseCurrency`, `rate`, `rateDate`, `source`, plus the convention flag.
  **Convention:** the rate is expressed as *document currency → base currency*.
  `validateExchangeRateSnapshot` refuses a rate for a currency pair other than the document's, a
  non-positive rate, a non-canonical decimal, or a missing rate date.
* **`toBaseCurrency`** converts one money value through a snapshot, rounding once at the base scale.
  Historic documents are always converted through **their stored** snapshot, never a newer rate.

Because the platform owns no currency module, a second module needing currency scales would duplicate
`CURRENCY_SCALES`; when a platform currency module appears this file should become a thin adapter.

## 3. Tax engine

### 3.1 Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `TaxClass` | Product/account tax classification | `name`, `active` |
| `TaxCode` | Standardised tax category, with an optional external/e-invoice mapping code | `code`, `active` |
| `TaxRate` | A rate for a tax code | `taxCodeId`, `ratePercent` (0 – 100, ≤ 6 fraction digits), `jurisdiction`, `effectiveFrom`, `effectiveTo` |
| `TaxRule` | Declarative applicability | `taxCodeId`, `priority` (0 – 10 000), `criteria`, `effectiveFrom`, `effectiveTo` |

Rule criteria: `taxClassIds`, `productIds`, `categoryIds`, `accountIds`, `jurisdictions` (each list
holds 1 – 500 values). A rule **must** have a tax code — a rule without one cannot produce a rate and
is refused at write time.

### 3.2 Rule selection (`orderTaxRules`)

1. lower `priority` first;
2. then **narrower** criteria first — a documented specificity sum:
   `productIds` **+16**, `categoryIds` **+8**, `accountIds` **+4**, `taxClassIds` **+2**,
   `jurisdictions` **+1**;
3. then `id` ascending, so the order is total.

Two applicable rules with the **same priority and the same specificity are a conflict**: the caller
reports it with both rule ids instead of picking one. Effective windows are inclusive at both ends.

### 3.3 Rate selection (`selectTaxRate`)

Among the rates of the chosen code that are active, inside their window, and either
jurisdiction-neutral or matching the context, the **most recent `effectiveFrom` wins**. Two applicable
rates with the same effective date are reported as a **conflict**.

### 3.4 Resolution order for one line (`SalesTaxService.resolveLineTax`)

1. an **explicit line rate** supplied by the caller;
2. the **product's default tax code** and its applicable rate;
3. a **matching tax rule**.

`null` means "nothing matched". The caller then applies `tax.missingTaxPolicy`:

* `error` (default) — the line is refused with the reason;
* `zero` — an explicit **zero-tax resolution** is recorded, and the totals result carries a warning.
  Zero tax is therefore always something a user can see and an auditor can explain, never an
  unexplained default.

## 4. Totals engine (`computeTotals`)

Pure: it receives already-resolved per-line tax facts and returns document numbers. It never reads the
database, never sends mail, and never trusts a client-submitted total — the server recomputes
everything from the inputs.

### 4.1 Rounding stages

| Stage | Behaviour | Trade-off |
|---|---|---|
| `line` (default) | Each line's discount, net and tax are rounded to the currency scale; document totals are the sums of those rounded values. Line arithmetic reconciles exactly (`net + tax = gross`) and the sum of lines equals the document totals. | none |
| `document` | Line values are computed exactly and only the document aggregates (subtotal, per-rate tax, totals) are rounded. Per-line values are reported at the currency scale for display. | a line's displayed values may sum to less than the document total by under one minor unit — this is the documented trade-off |

`tax.roundingMode` selects the rounding mode (default `half-up`).

### 4.2 Discounts

* A line may carry a **percentage** (0 – 100) and/or a **fixed** discount, applied to the line amount
  before tax. A line discounted below zero is refused.
* A **document-level discount** is distributed across lines **pro rata by net amount** using a
  largest-remainder allocation (`distributeDocumentDiscount`), so the distributed parts sum to exactly
  the requested amount at the currency scale, ties going to the lower line index. A line never
  receives more discount than its net amount, and a discount larger than the document is refused.

### 4.3 Tax-inclusive vs tax-exclusive

With `taxInclusive` the line amount (after discount) is treated as tax-inclusive and the net is
extracted with `netFromInclusive(gross, rate, scale, mode)` before tax is computed. Shipping follows
the same rule. The setting `features.taxInclusivePrices` sets the installation default; a document may
still state its own policy.

### 4.4 Result shape

| Field | Meaning |
|---|---|
| `subtotal` | Sum of line amounts before discounts |
| `discountTotal` | Line discounts + the document discount |
| `shippingAmount`, `shippingTaxAmount` | Shipping net and its tax |
| `taxBreakdown[]` | One row per `(taxCode, rate)`: taxable base and tax amount |
| `taxTotal` | Sum of the breakdown rows |
| `netTotal` | Taxable base after all discounts, excluding tax |
| `grossTotal` | Payable total including tax |
| `amountDue` | `grossTotal` minus allocations; a freshly calculated document has none |
| `baseCurrency`, `exchangeRate`, `baseGrossTotal` | Present only when an exchange-rate snapshot was supplied, and validated against the document currency |
| `rounding`, `taxInclusive`, `warnings` | The policy the numbers were produced under, plus non-fatal notes |

Guards: a document needs at least one line, at most **500** lines (`MAX_TOTALS_LINES`); each line needs
a unit price and a quantity greater than zero whose scale does not exceed `quantityPrecision`; a
negative tax rate is refused.

## 5. Settings that drive this engine

| Setting | Default | Effect |
|---|---|---|
| `currency.defaultCurrency` | `USD` | Installation base currency; validated against the supported table |
| `tax.missingTaxPolicy` | `error` | Refuse a line with no applicable tax, or record explicit zero tax |
| `tax.shippingTaxCode` | `null` | Tax code applied to shipping; `null` means shipping is not taxed by default |
| `tax.roundingStage` | `line` | `line` or `document` |
| `tax.roundingMode` | `half-up` | `half-up` / `half-even` / `floor` / `ceil` |
| `quantityPrecision` | `2` | Maximum accepted quantity fraction digits (0 – 6) |
| `features.taxInclusivePrices` | `false` | Installation default for inclusive pricing |
| `features.multiCurrency` | `false` | Whether documents may carry a currency other than the base |

Every change bumps the settings version, so a stored snapshot can name the policy it was produced
under.

## 6. Deliberate non-goals

* No general ledger, FX gain/loss recognition, tax filing or jurisdiction-specific certification.
* No e-invoicing gateway; `TaxCode` carries a mapping field only, and it is described as *mapping
  metadata*, never as legal certification.
* No compounding tax chains, withholding tax or reverse-charge special cases — only item tax and
  shipping tax with a single rate per line, which is what the implemented reference scope covers.
