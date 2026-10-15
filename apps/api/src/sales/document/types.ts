import { createHash } from 'node:crypto';

/**
 * Phase 19-S.2 — contracts every Sales document type reuses.
 *
 * Quotes, sales orders, invoices, credit notes and the rest do **not** share one status machine
 * (PLAN_Phase_19_Sales.md §4.4), but they do share the same input/output vocabulary: a typed line
 * item, a tax resolution, an audit context and an idempotency key. Those live here so the pricing,
 * tax and totals services stay independent of any specific document.
 */

/** Who performed a commercial operation, and under which correlation. Never credentials. */
export interface SalesAuditContext {
  readonly userId?: string | undefined;
  readonly userName?: string | undefined;
  readonly correlationId?: string | undefined;
  /** Required for privileged corrections (unlock, write-off, stock override) by policy. */
  readonly reason?: string | undefined;
}

/**
 * Stable idempotency key for a command that must not repeat an irreversible effect
 * (PLAN_Phase_19_Sales.md §6.3, §4.14).
 *
 * The key is a digest of the *meaningful* inputs only — never a random value and never a timestamp —
 * so a retried request produces the same key and a different request produces a different one.
 */
export function idempotencyKey(parts: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ''}`)
    .join('\u0000');
  return `sales-idem-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

/** One requested line, before calculation. Amounts and quantities are canonical decimal strings. */
export interface LineItemInput {
  readonly productId?: string | undefined;
  readonly name?: string | undefined;
  readonly sku?: string | undefined;
  readonly unit?: string | undefined;
  /** Canonical decimal string; sign is validated by the totals service. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent?: string | undefined;
  readonly discountAmount?: string | undefined;
  /** Explicit tax treatment; when absent the tax engine resolves one or reports the configured gap. */
  readonly taxCodeId?: string | undefined;
  readonly taxRatePercent?: string | undefined;
}

/** Where a line's tax rate came from — the explainability half of the tax engine (§4.12). */
export type TaxResolutionSource = 'line' | 'taxRule' | 'taxCode' | 'zero' | 'none';

export interface TaxLineResolution {
  readonly taxCodeId: string | null;
  readonly taxCodeName: string | null;
  /** Canonical decimal string, e.g. `"19"` or `"7.5"`. */
  readonly taxRatePercent: string;
  readonly source: TaxResolutionSource;
  readonly ruleId: string | null;
  /** True when a tax rule won but its rate had to come from a specific rate row. */
  readonly rateId?: string | null | undefined;
}

/** One calculated line. `netAmount + taxAmount = grossAmount` at the line's rounding stage. */
export interface LineItemTotals {
  readonly position: number;
  readonly productId: string | null;
  readonly name: string | null;
  readonly sku: string | null;
  readonly unit: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountAmount: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
  readonly tax: TaxLineResolution | null;
}

/** Aggregated tax per (code, rate) pair, at the document's rounding stage. */
export interface TaxBreakdownRow {
  readonly taxCodeId: string | null;
  readonly taxCodeName: string | null;
  readonly taxRatePercent: string;
  readonly taxableBase: string;
  readonly taxAmount: string;
}
