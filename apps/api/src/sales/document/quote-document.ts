import { blocksToText, type DocumentBlock } from "@carocrm/document";

import {
  type DocumentRenderLine,
  documentRenderLine,
  type DocumentRenderTotals,
  LINE_COLUMNS,
  lineColumnsRow,
  pushFact,
  totalsRows,
} from "./render-blocks.js";

/**
 * Phase 19-S.7 — a quote as a document.
 *
 * The kernel's `document` module renders a template and lays a block model out; it deliberately knows
 * nothing about quotes (PLAN_Phase_19_Sales.md §4.4 keeps the document engine type-agnostic). So the
 * block model of a *quote* is this module's job, built from the shared block vocabulary in
 * `render-blocks.ts` and from the same facts the engine already froze: the document's own totals.
 *
 * Two rules this file exists to keep:
 *
 *  - **The numbers are the engine's, never re-derived here.** The renderer takes `LineItemTotals` and
 *    the document totals as input; it does no arithmetic. A rendered quote therefore cannot disagree
 *    with the quote, and an issued quote renders from its snapshot because that is what the caller
 *    passes in.
 *  - **The blocks are the shared vocabulary.** Plain text (for an email body) and PDF (when `pdfkit`
 *    is installed) both walk `DocumentBlock[]`, so the two renderings cannot drift apart.
 */

/** One rendered line: the money facts of `LineItemTotals`, flattened for a template or a table. */
export type QuoteRenderLine = DocumentRenderLine;

/** The document-level totals, already rounded by the totals engine at the document's own stage. */
export type QuoteRenderTotals = DocumentRenderTotals;

export interface QuoteRenderInput {
  /** The official number; `null` while the quote is still a draft and has not been issued. */
  readonly number: string | null;
  readonly status: string;
  readonly quoteDate: string | null;
  readonly validUntil: string | null;
  readonly accountName: string | null;
  readonly contactName: string | null;
  readonly billingAddress: string | null;
  readonly shippingAddress: string | null;
  readonly description: string | null;
  readonly lines: readonly QuoteRenderLine[];
  readonly totals: QuoteRenderTotals;
}

/** The line facts a render needs, taken straight from the engine's calculated lines. */
export const quoteRenderLine = documentRenderLine;

/**
 * The quote as a block model: an identity heading, the party facts, the priced lines, the totals.
 *
 * Every optional fact is *omitted* rather than rendered as an empty line, so a quote without a
 * shipping address does not print "Shipping address:" followed by nothing.
 */
export function quoteBlocks(input: QuoteRenderInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: "heading", text: quoteTitle(input) },
  ];

  const header: { key: string; value: string }[] = [];
  pushFact(header, "Status", input.status);
  pushFact(header, "Date", input.quoteDate);
  pushFact(header, "Valid until", input.validUntil);
  pushFact(header, "Account", input.accountName);
  pushFact(header, "Contact", input.contactName);
  pushFact(header, "Currency", input.totals.currency);
  if (header.length > 0) blocks.push({ kind: "keyValue", rows: header });

  if (input.description !== null && input.description.trim() !== "") {
    blocks.push(
      { kind: "spacer" },
      { kind: "paragraph", text: input.description },
    );
  }

  blocks.push({ kind: "spacer" });
  blocks.push({
    kind: "table",
    columns: LINE_COLUMNS,
    rows: input.lines.map(lineColumnsRow),
  });

  blocks.push({ kind: "spacer" });
  blocks.push({ kind: "keyValue", rows: totalsRows(input.totals) });

  const addresses: { key: string; value: string }[] = [];
  pushFact(addresses, "Billing address", input.billingAddress);
  pushFact(addresses, "Shipping address", input.shippingAddress);
  if (addresses.length > 0)
    blocks.push({ kind: "spacer" }, { kind: "keyValue", rows: addresses });

  return blocks;
}

/**
 * The data a `DocumentTemplate` is rendered against. `lines` is an array so `{{#each lines}}` works;
 * the totals are also flattened onto the root, so `{{grossTotal}}` works outside the block.
 */
export function quoteTemplateData(
  input: QuoteRenderInput,
): Record<string, unknown> {
  return {
    number: input.number ?? "",
    status: input.status,
    quoteDate: input.quoteDate ?? "",
    validUntil: input.validUntil ?? "",
    accountName: input.accountName ?? "",
    contactName: input.contactName ?? "",
    billingAddress: input.billingAddress ?? "",
    shippingAddress: input.shippingAddress ?? "",
    description: input.description ?? "",
    title: quoteTitle(input),
    lines: input.lines.map((line) => ({ ...line })),
    totals: { ...input.totals },
    subtotal: input.totals.subtotal,
    discountTotal: input.totals.discountTotal,
    shippingAmount: input.totals.shippingAmount,
    shippingTaxAmount: input.totals.shippingTaxAmount,
    taxTotal: input.totals.taxTotal,
    netTotal: input.totals.netTotal,
    grossTotal: input.totals.grossTotal,
    currency: input.totals.currency,
  };
}

/** The plain-text rendering — the email body when no template is chosen, and a testable output. */
export function quoteText(input: QuoteRenderInput): string {
  return blocksToText(quoteBlocks(input));
}

/** `Quote Q-000123`, or `Quote (draft)` before issuance. */
export function quoteTitle(input: QuoteRenderInput): string {
  return input.number === null ? "Quote (draft)" : `Quote ${input.number}`;
}

/** The default subject line, used when the template does not provide one. */
export function quoteSubject(input: QuoteRenderInput): string {
  return input.number === null ? "Quote" : `Quote ${input.number}`;
}
