import { blocksToText, type DocumentBlock } from "@carocrm/document";

import {
  type DocumentRenderLine,
  type DocumentRenderTotals,
  LINE_COLUMNS,
  lineColumnsRow,
  pushFact,
  totalsRows,
} from "./render-blocks.js";

/**
 * Phase 19-S.11 — a credit note as a document.
 *
 * The credit note's block model over the shared vocabulary (`render-blocks.ts`): the same identity
 * heading, party facts, priced lines and totals a quote renders, plus the two facts only a credit
 * note carries — the invoice it credits and its reason — and the remainder that is still available
 * to allocate.
 *
 * It renders from the same frozen facts as every other document: an issued credit note is rendered
 * from its snapshot, so a price book or tax rule that moved afterwards cannot rewrite what was
 * credited.
 */

export interface CreditNoteRenderInput {
  /** The official number; `null` while the credit note is still a draft and has not been issued. */
  readonly number: string | null;
  readonly status: string;
  readonly creditDate: string | null;
  /** The invoice this credit note credits, when it was created from one (display reference). */
  readonly invoiceNumber: string | null;
  readonly reason: string | null;
  /** Credit not yet allocated to any invoice; a draft has none yet. */
  readonly unallocatedAmount: string | null;
  readonly accountName: string | null;
  readonly contactName: string | null;
  readonly billingAddress: string | null;
  readonly shippingAddress: string | null;
  readonly description: string | null;
  readonly lines: readonly DocumentRenderLine[];
  readonly totals: DocumentRenderTotals;
}

/**
 * The credit note as a block model. Every optional fact is *omitted* rather than rendered as an empty
 * line — a credit note without a reason does not print "Reason:" followed by nothing.
 */
export function creditNoteBlocks(input: CreditNoteRenderInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: "heading", text: creditNoteTitle(input) },
  ];

  const header: { key: string; value: string }[] = [];
  pushFact(header, "Status", input.status);
  pushFact(header, "Date", input.creditDate);
  pushFact(header, "Credits invoice", input.invoiceNumber);
  pushFact(header, "Reason", input.reason);
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

  if (input.unallocatedAmount !== null) {
    blocks.push({
      kind: "keyValue",
      rows: [
        {
          key: `Unallocated (${input.totals.currency})`,
          value: input.unallocatedAmount,
        },
      ],
    });
  }

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
export function creditNoteTemplateData(
  input: CreditNoteRenderInput,
): Record<string, unknown> {
  return {
    number: input.number ?? "",
    status: input.status,
    creditDate: input.creditDate ?? "",
    invoiceNumber: input.invoiceNumber ?? "",
    reason: input.reason ?? "",
    unallocatedAmount: input.unallocatedAmount ?? "",
    accountName: input.accountName ?? "",
    contactName: input.contactName ?? "",
    billingAddress: input.billingAddress ?? "",
    shippingAddress: input.shippingAddress ?? "",
    description: input.description ?? "",
    title: creditNoteTitle(input),
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

/** The plain-text rendering — the testable output. */
export function creditNoteText(input: CreditNoteRenderInput): string {
  return blocksToText(creditNoteBlocks(input));
}

/** `Credit Note CN-000123`, or `Credit Note (draft)` before issuance. */
export function creditNoteTitle(input: CreditNoteRenderInput): string {
  return input.number === null
    ? "Credit Note (draft)"
    : `Credit Note ${input.number}`;
}

/** The default subject line, used when the template does not provide one. */
export function creditNoteSubject(input: CreditNoteRenderInput): string {
  return input.number === null ? "Credit Note" : `Credit Note ${input.number}`;
}
