import { blocksToText, type DocumentBlock, pdfAvailable } from "@carocrm/document";
import { Inject, Injectable } from "@nestjs/common";

import { DocumentTemplateService } from "../../document/document-template.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import {
  documentDescriptor,
  type ImplementedDocumentKind,
  type SalesDocumentDescriptor,
} from "./descriptors.js";
import { type DocumentView,SalesDocumentService } from "./document.service.js";
import type { DocumentRenderLine, DocumentRenderTotals } from "./render-blocks.js";
import {
  documentRenderLine,
  LINE_COLUMNS,
  lineColumnsRow,
  pushFact,
  totalsRows,
} from "./render-blocks.js";

/**
 * Phase 19-S.12 / 19-S.13 task 8 — the print/PDF hook every document kind shares.
 *
 * A quote (19-S.7) and a credit note (19-S.11) already render, each with the facts only they carry.
 * The remaining kinds — orders, deliveries, returns, and the whole purchasing half — are the same
 * block model with a different heading and a different counterparty, so they are served from the
 * descriptor rather than from one more per-kind module.
 *
 * Like every other render here, **an issued document renders from its frozen snapshot**: a price, tax
 * rule or party name that moved afterwards changes what a *new* document shows, never what was issued.
 */

@Injectable()
export class SalesDocumentRenderService {
  constructor(
    @Inject(SalesDocumentService) private readonly documents: SalesDocumentService,
    @Inject(DocumentTemplateService)
    private readonly templates: DocumentTemplateService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /** Render one document: a named `DocumentTemplate`, or the built-in block layout. */
  async render(
    kind: ImplementedDocumentKind,
    id: string,
    templateCode?: string,
  ): Promise<DocumentRenderResult> {
    const descriptor = documentDescriptor(kind);
    const view = await this.documents.view(kind, id);
    const input = await this.renderInputFor(descriptor, view);
    const blocks = documentBlocks(descriptor, input);
    const text = blocksToText(blocks);
    const pdf = await pdfAvailable();
    const subject = `${descriptor.label}${input.number === null ? " (draft)" : ` ${input.number}`}`;

    const code =
      templateCode ?? (await this.templates.defaultTemplateCode(descriptor.entity));
    if (code === undefined) {
      return {
        kind,
        documentId: view.id,
        number: input.number,
        status: input.status,
        fromSnapshot: view.fromSnapshot,
        templateCode: null,
        format: "text",
        subject,
        body: text,
        text,
        blocks,
        warnings: [],
        pdf,
      };
    }

    const rendered = await this.templates.render(
      code,
      templateData(descriptor, input),
    );
    const renderedSubject = rendered.subject.trim();
    return {
      kind,
      documentId: view.id,
      number: input.number,
      status: input.status,
      fromSnapshot: view.fromSnapshot,
      templateCode: code,
      format: rendered.format,
      subject: renderedSubject === "" ? subject : renderedSubject,
      body: rendered.body,
      text,
      blocks,
      warnings: rendered.warnings,
      pdf,
    };
  }

  private async renderInputFor(
    descriptor: SalesDocumentDescriptor,
    view: DocumentView,
  ): Promise<DocumentRenderInput> {
    const document = view.document;
    const snapshot = await this.documents.issuedData(descriptor.kind, view.id);
    const parties =
      snapshot !== undefined
        ? snapshot.parties
        : {
            accountName: await this.nameOf("Account", text(document["accountId"])),
            contactName: await this.nameOf("Contact", text(document["contactId"])),
            supplierName: await this.nameOf("Supplier", text(document["supplierId"])),
            billingAddress: text(document["billingAddress"]) ?? null,
            shippingAddress: text(document["shippingAddress"]) ?? null,
          };
    return {
      number: text(document["number"]) ?? null,
      status: text(document["status"]) ?? descriptor.initialState,
      date: text(document[descriptor.dateField]) ?? null,
      accountName: parties.accountName,
      contactName: parties.contactName,
      supplierName: parties.supplierName,
      billingAddress: parties.billingAddress,
      shippingAddress: parties.shippingAddress,
      description: text(document["description"]) ?? null,
      // Every optional fact is read straight off the document: a kind that does not have the field
      // simply renders nothing for it.
      facts: OPTIONAL_FACTS.map((fact) => ({
        label: fact.label,
        value: text(document[fact.field]) ?? null,
      })).filter((fact) => fact.value !== null),
      unallocatedAmount: text(document["unallocatedAmount"]) ?? null,
      // The same optional facts a template asks for by their own name: `{{dueDate}}`, `{{reason}}`,
      // `{{amountDue}}`. The block layout prints them under a label; a template addresses the field.
      fields: Object.fromEntries(
        [
          ...OPTIONAL_FACTS.map((fact) => fact.field),
          "amountDue",
        ].map((field) => [field, text(document[field]) ?? ""]),
      ),
      lines: view.totals.lines.map(documentRenderLine),
      totals: {
        subtotal: view.totals.subtotal,
        discountTotal: view.totals.discountTotal,
        shippingAmount: view.totals.shippingAmount,
        shippingTaxAmount: view.totals.shippingTaxAmount,
        taxTotal: view.totals.taxTotal,
        netTotal: view.totals.netTotal,
        grossTotal: view.totals.grossTotal,
        currency: view.totals.currency,
      },
    };
  }

  private async nameOf(
    entity: string,
    id: string | undefined,
  ): Promise<string | null> {
    if (id === undefined) return null;
    const record = await this.entities.get(entity, id);
    return text(record["name"]) ?? null;
  }
}

/** What a render produced; the same shape the quote and credit-note renders return. */
export interface DocumentRenderResult {
  readonly kind: ImplementedDocumentKind;
  readonly documentId: string;
  readonly number: string | null;
  readonly status: string;
  readonly fromSnapshot: boolean;
  readonly templateCode: string | null;
  readonly format: string;
  readonly subject: string;
  readonly body: string;
  readonly text: string;
  /** The block model, so the optional PDF renderer is handed the same document. */
  readonly blocks: readonly DocumentBlock[];
  readonly warnings: readonly string[];
  readonly pdf: { readonly available: boolean; readonly reason: string | null };
}

interface DocumentRenderInput {
  readonly number: string | null;
  readonly status: string;
  readonly date: string | null;
  readonly accountName: string | null;
  readonly contactName: string | null;
  readonly supplierName: string | null;
  readonly billingAddress: string | null;
  readonly shippingAddress: string | null;
  readonly description: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string | null }[];
  /** The optional document fields, keyed by their own name, for a template that asks for them. */
  readonly fields: Readonly<Record<string, string>>;
  readonly unallocatedAmount: string | null;
  readonly lines: readonly DocumentRenderLine[];
  readonly totals: DocumentRenderTotals;
}

/**
 * The reference fields worth printing on a commercial document, whatever kind it is: a tracking
 * number, a carrier, a warehouse, a return reason, the purchase order a bill belongs to (§4.10, §4.12).
 * A kind that does not carry one renders nothing for it.
 */
const OPTIONAL_FACTS: readonly { readonly label: string; readonly field: string }[] =
  [
    { label: "Tracking number", field: "trackingNumber" },
    { label: "Warehouse", field: "warehouseId" },
    { label: "Reason", field: "reason" },
    { label: "Due date", field: "dueDate" },
    { label: "Required delivery", field: "requiredDeliveryDate" },
    { label: "Expected delivery", field: "expectedDeliveryDate" },
  ];

function documentBlocks(
  descriptor: SalesDocumentDescriptor,
  input: DocumentRenderInput,
): DocumentBlock[] {
  const title =
    input.number === null
      ? `${descriptor.label} (draft)`
      : `${descriptor.label} ${input.number}`;
  const blocks: DocumentBlock[] = [{ kind: "heading", text: title }];

  const header: { key: string; value: string }[] = [];
  pushFact(header, "Status", input.status);
  pushFact(header, "Date", input.date);
  pushFact(header, "Supplier", input.supplierName);
  pushFact(header, "Account", input.accountName);
  pushFact(header, "Contact", input.contactName);
  pushFact(header, "Currency", input.totals.currency);
  for (const fact of input.facts) pushFact(header, fact.label, fact.value);
  if (header.length > 0) blocks.push({ kind: "keyValue", rows: header });

  if (input.description !== null && input.description.trim() !== "") {
    blocks.push({ kind: "spacer" }, { kind: "paragraph", text: input.description });
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

function templateData(
  descriptor: SalesDocumentDescriptor,
  input: DocumentRenderInput,
): Record<string, unknown> {
  return {
    entityLabel: descriptor.label,
    number: input.number ?? "",
    status: input.status,
    date: input.date ?? "",
    accountName: input.accountName ?? "",
    contactName: input.contactName ?? "",
    supplierName: input.supplierName ?? "",
    billingAddress: input.billingAddress ?? "",
    shippingAddress: input.shippingAddress ?? "",
    description: input.description ?? "",
    ...input.fields,
    unallocatedAmount: input.unallocatedAmount ?? "",
    title:
      input.number === null
        ? `${descriptor.label} (draft)`
        : `${descriptor.label} ${input.number}`,
    facts: Object.fromEntries(input.facts.map((fact) => [fact.label, fact.value])),
    // `lineTotal` and `tax` are the names a template reaches for; the block model calls them
    // `grossAmount` and `taxAmount`, and the two aliases keep the shipped defaults warning-free.
    lines: input.lines.map((line) => ({
      ...line,
      lineTotal: line.grossAmount,
      tax: line.taxAmount,
    })),
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

/** The calculated line in the shape the shared block model draws. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
