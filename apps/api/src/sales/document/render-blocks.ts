import type { LineItemTotals } from "./types.js";

/**
 * Phase 19-S.7 / 19-S.11 — the block vocabulary every commercial document's render shares.
 *
 * The kernel's `document` module renders a template and lays a block model out; it deliberately knows
 * nothing about quotes or credit notes (§4.4 keeps the document engine type-agnostic). What the
 * document kinds share — the line table's columns, the totals rows, the "omit an empty fact" rule —
 * lives here, so a quote and a credit note cannot drift into two different-looking documents.
 *
 * The numbers come from the engine (`LineItemTotals`, the document totals); nothing here does
 * arithmetic.
 */

/** One rendered line: the money facts of `LineItemTotals`, flattened for a template or a table. */
export interface DocumentRenderLine {
  readonly position: number;
  readonly name: string;
  readonly sku: string;
  readonly unit: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountAmount: string;
  readonly taxRatePercent: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
}

/** The document-level totals, already rounded by the totals engine at the document's own stage. */
export interface DocumentRenderTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly shippingAmount: string;
  readonly shippingTaxAmount: string;
  readonly taxTotal: string;
  readonly netTotal: string;
  readonly grossTotal: string;
  readonly currency: string;
}

export const LINE_COLUMNS: readonly string[] = [
  "#",
  "Item",
  "SKU",
  "Qty",
  "Unit price",
  "Discount",
  "Tax %",
  "Net",
  "Tax",
  "Gross",
];

/** The line facts a render needs, taken straight from the engine's calculated lines. */
export function documentRenderLine(line: LineItemTotals): DocumentRenderLine {
  return {
    position: line.position,
    name: line.name ?? "",
    sku: line.sku ?? "",
    unit: line.unit ?? "",
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount,
    taxRatePercent: line.tax?.taxRatePercent ?? "0",
    netAmount: line.netAmount,
    taxAmount: line.taxAmount,
    grossAmount: line.grossAmount,
  };
}

/** One line as a table row, in `LINE_COLUMNS` order. */
export function lineColumnsRow(
  line: DocumentRenderLine,
): readonly string[] {
  return [
    String(line.position),
    line.name,
    line.sku,
    line.quantity,
    line.unitPrice,
    line.discountAmount,
    line.taxRatePercent,
    line.netAmount,
    line.taxAmount,
    line.grossAmount,
  ];
}

/** The totals block, in the order a reader checks them. */
export function totalsRows(
  totals: DocumentRenderTotals,
): { key: string; value: string }[] {
  return [
    { key: "Subtotal", value: totals.subtotal },
    { key: "Discount", value: totals.discountTotal },
    { key: "Shipping", value: totals.shippingAmount },
    { key: "Tax", value: totals.taxTotal },
    { key: "Net total", value: totals.netTotal },
    { key: `Gross total (${totals.currency})`, value: totals.grossTotal },
  ];
}

/** Every optional fact is *omitted* rather than rendered as an empty line. */
export function pushFact(
  rows: { key: string; value: string }[],
  key: string,
  value: string | null,
): void {
  if (value === null) return;
  const trimmed = value.trim();
  if (trimmed === "") return;
  rows.push({ key, value: trimmed });
}
