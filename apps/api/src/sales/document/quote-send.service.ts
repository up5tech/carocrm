import {
  FeatureDisabledError,
  InternalServerError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import {
  createPdfkitRenderer,
  type DocumentBlock,
  escapeHtml,
  pdfAvailable,
} from "@carocrm/document";
import type { MailTransportInfo } from "@carocrm/mail";
import { Inject, Injectable, Optional } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import {
  type AttachmentDto,
  AttachmentService,
} from "../../attachment/attachment.service.js";
import { DocumentTemplateService } from "../../document/document-template.service.js";
import { EmailService } from "../../email/email.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runAsSalesInternal } from "../sales-internal.js";
import type { DocumentView } from "./document.service.js";
import { SalesDocumentService } from "./document.service.js";
import {
  quoteBlocks,
  type QuoteRenderInput,
  quoteRenderLine,
  quoteSubject,
  quoteTemplateData,
  quoteText,
} from "./quote-document.js";

/**
 * Phase 19-S.7 — rendering and sending a quote (PLAN_Phase_19_Sales.md §4.5, 19-S.7 task 5).
 *
 * This is the half of a quote that leaves the CRM: it turns the quote into a document and hands it to
 * the mail module. It owns **no** new mechanism:
 *
 *  - rendering is the kernel `document` module (`DocumentTemplateService` over `@carocrm/document`),
 *    which was built precisely so a module does not invent a second template syntax;
 *  - sending is the `EmailService`, which validates the message, writes the per-recipient ledger and
 *    queues `system.sendEmail`. The worker makes the network call, so no request holds an SMTP
 *    connection open and this service never touches a socket.
 *
 * The rules it does enforce, because they are the plan's acceptance criteria:
 *
 *  - **Rendering is from the snapshot, never the live catalog.** An issued quote is rendered from the
 *    frozen envelope (`issuedData`), so a quote emailed today shows the prices, the customer name and
 *    the totals that were sent — not today's price book. A draft has no snapshot and renders live.
 *  - **Sending is explicit and refuses to lie.** A disabled mail transport is refused *before* the
 *    quote is issued, so a quote is never marked sent with no email behind it. Everything else that
 *    can fail (a missing recipient, an unknown template) is also checked first.
 *  - **A sent quote is never silently rewritten.** Sending an already-sent quote re-renders from its
 *    snapshot and records a *new* email; it does not re-issue or change the document. That is why
 *    `send` accepts the `sent` state as well as `draft`, and returns whether it issued anything.
 *
 * Permissions it relies on, all pre-checked before anything is issued: `read` on the quote (through
 * `SalesDocumentService.view`), `read` on `DocumentTemplate` (through the kernel renderer — a role
 * that sends quotes needs it, because the template is what gets rendered), `read` on the referenced
 * Account/Contact for a draft, and `create` + `edit` on `Email`. All of these are the *existing*
 * kernel checks; this service adds no permission of its own.
 */

/** What a render produced, for a preview UI and for the send action. */
export interface QuoteRenderResult {
  readonly quoteId: string;
  readonly number: string | null;
  readonly status: string;
  /** True when the numbers came from the frozen snapshot rather than a live calculation. */
  readonly fromSnapshot: boolean;
  /** The template actually used; `null` means the built-in block layout was rendered instead. */
  readonly templateCode: string | null;
  readonly format: string;
  readonly subject: string;
  /** The template's body (`html` format) or the plain text (`text` format). */
  readonly body: string;
  /** The plain-text rendering of the block model, always present — the email's text part. */
  readonly text: string;
  /** The block model itself, so a PDF renderer can be handed the same document (§19-S.7 PDF path). */
  readonly blocks: readonly DocumentBlock[];
  /** Placeholders the template could not resolve. Reported, never blanked. */
  readonly warnings: readonly string[];
  /** Whether the optional PDF renderer (`pdfkit`) can be loaded in this install. */
  readonly pdf: { readonly available: boolean; readonly reason: string | null };
}

export interface SendQuoteInput {
  /** Recipients. When empty, the quote's contact's address is used, then its account's. */
  readonly to?: readonly string[] | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  /** The `DocumentTemplate` code; the entity type's default is used when omitted. */
  readonly templateCode?: string | undefined;
  readonly subject?: string | undefined;
  /** A covering note prepended to the rendered body. */
  readonly message?: string | undefined;
  /** Sending mailbox; the configured default account is used when omitted. */
  readonly emailAccountId?: string | undefined;
  readonly correlationId?: string | undefined;
  /**
   * Attach a rendered PDF of the issued quote to the stored email (`parentType: 'Email'`), so the
   * worker's `system.sendEmail` picks it up through the §25 attachment path. Refused with a 422
   * *before* issuance when the optional `pdfkit` dependency is not installed — a quote is never
   * issued for an attachment that cannot be produced.
   */
  readonly attachPdf?: boolean | undefined;
}

export interface QuotePdfAttachment {
  /** The §25 attachment row linked to the stored email (`parentType: 'Email'`). */
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string | null;
}

export interface SendQuoteResult {
  /** The quote after the call — `sent`, with its number, when this call issued it. */
  readonly quote: DocumentView;
  /** The stored Email record (its status is `Queued` once the send is accepted). */
  readonly email: Record<string, unknown>;
  readonly rendered: QuoteRenderResult;
  readonly transport: MailTransportInfo;
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  };
  /** True when this call issued a draft; false when the quote was already sent (a re-send). */
  readonly issued: boolean;
  /** The PDF row under the email when `attachPdf` was requested; `null` otherwise. */
  readonly pdfAttachment: QuotePdfAttachment | null;
}

interface QuoteParties {
  readonly accountName: string | null;
  readonly contactName: string | null;
  readonly billingAddress: string | null;
  readonly shippingAddress: string | null;
}

interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

@Injectable()
export class SalesQuoteSendService {
  constructor(
    @Inject(SalesDocumentService)
    private readonly documents: SalesDocumentService,
    @Inject(DocumentTemplateService)
    private readonly templates: DocumentTemplateService,
    @Inject(EmailService) private readonly emails: EmailService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Optional()
    @Inject(AttachmentService)
    private readonly attachments?: AttachmentService,
  ) {}

  /**
   * Render a quote against a template — the preview half of the send action, and what the UI shows
   * before anybody commits to sending. Read access on the quote is the gate.
   */
  async render(id: string, templateCode?: string): Promise<QuoteRenderResult> {
    const view = await this.documents.view("quote", id);
    const parties = await this.partiesFor(view);
    const input = toRenderInput(view, parties);
    const blocks = quoteBlocks(input);
    const text = quoteText(input);
    const pdf = await pdfAvailable();

    const code =
      templateCode ?? (await this.templates.defaultTemplateCode("Quote"));
    if (code === undefined) {
      // No template configured: the built-in block layout is the document. That is a valid install,
      // not a failure — an operator adds a template when they want a letterhead.
      return {
        quoteId: view.id,
        number: input.number,
        status: input.status,
        fromSnapshot: view.fromSnapshot,
        templateCode: null,
        format: "text",
        subject: quoteSubject(input),
        body: text,
        text,
        blocks,
        warnings: [],
        pdf,
      };
    }

    const rendered = await this.templates.render(
      code,
      quoteTemplateData(input),
    );
    const subject = rendered.subject.trim();
    return {
      quoteId: view.id,
      number: input.number,
      status: input.status,
      fromSnapshot: view.fromSnapshot,
      templateCode: code,
      format: rendered.format,
      subject: subject === "" ? quoteSubject(input) : subject,
      body: rendered.body,
      text,
      blocks,
      warnings: rendered.warnings,
      pdf,
    };
  }

  /**
   * Issue a draft quote and email it, in that order, so the email carries the number the issuance
   * allocated. Sending an already-sent quote re-renders and records another email without touching
   * the document.
   *
   * If the mail queue is unreachable *after* the quote was issued, the stored email is left in
   * `Draft` and the error says so: nothing pretends the message went out, and the operator can queue
   * it from the Email module.
   */
  async send(id: string, input: SendQuoteInput): Promise<SendQuoteResult> {
    const view = await this.documents.view("quote", id);
    const state = text(view.document["status"]) ?? "draft";

    // Every refusal that can be foreseen happens **before** the quote is issued. A quote marked
    // `sent` with no email behind it, or issued by a caller who then turns out not to be allowed to
    // create the email, is a lie in the audit trail — so the gates come first, in order of how cheap
    // they are to check.
    await this.acl.assertAccess("Email", "create");
    await this.acl.assertAccess("Email", "edit");
    const transport = this.emails.info();
    if (transport.name === "none") {
      throw new FeatureDisabledError("mail transport");
    }
    if (state !== "draft" && state !== "sent") {
      throw new ValidationError(
        `Only a draft or a sent quote can be sent; this one is "${state}".`,
        {
          quoteId: id,
          status: state,
        },
      );
    }

    const recipients = await this.recipientsFor(view, input);
    // Validate the template and the recipients before issuing, for the same reason.
    const preview = await this.render(id, input.templateCode);

    // The PDF attachment needs the optional `pdfkit` renderer. Check *before* issuance, so a quote
    // is never issued for an attachment that cannot be produced — the same ordering as every other
    // gate above. The storage path needs no such check: it is a required kernel mechanism.
    const wantsPdf = input.attachPdf === true;
    if (wantsPdf) {
      if (this.attachments === undefined) {
        throw new FeatureDisabledError("attachment storage");
      }
      const probe = await pdfAvailable();
      if (!probe.available) {
        throw new ValidationError(
          'A PDF attachment was requested, but the optional "pdfkit" dependency is not installed. Install it or send the quote without `attachPdf`.',
          { quoteId: id, reason: probe.reason },
        );
      }
    }

    let issued = false;
    if (state === "draft") {
      await runAsSalesInternal(() =>
        this.documents.transition("quote", id, "send", {
          correlationId: input.correlationId,
        }),
      );
      issued = true;
    }
    // Re-render after issuance so the subject and the body carry the allocated number.
    const rendered = issued
      ? await this.render(id, input.templateCode)
      : preview;

    const emailId = await this.createEmail(view, rendered, recipients, input);
    // Render the PDF from the *issued* blocks, so the attachment carries the allocated number and
    // can never disagree with the sent email body — both walk the same block model.
    const pdfAttachment = wantsPdf
      ? await this.attachQuotePdf(emailId, rendered)
      : null;
    try {
      const queued = await this.emails.queueSend(emailId);
      return {
        quote: await this.documents.view("quote", id),
        email: queued.email,
        rendered,
        transport: queued.transport,
        job: queued.job,
        issued,
        pdfAttachment,
      };
    } catch (error: unknown) {
      if (error instanceof ValidationError) throw error;
      throw new InternalServerError(
        `The quote is sent, but its email could not be queued. It is stored as a draft (${emailId}) and can be queued from the Email module.`,
        {
          emailId,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Party facts for the document. An **issued** quote renders from its frozen snapshot, so a renamed
   * account does not rewrite a quote that was already sent; a draft reads the live records, through
   * the record API, so a user who may not read the customer cannot render a quote to them.
   */
  private async partiesFor(view: DocumentView): Promise<QuoteParties> {
    const snapshot = await this.documents.issuedData("quote", view.id);
    if (snapshot !== undefined) {
      return {
        accountName: snapshot.parties.accountName,
        contactName: snapshot.parties.contactName,
        billingAddress: snapshot.parties.billingAddress,
        shippingAddress: snapshot.parties.shippingAddress,
      };
    }
    return {
      accountName: await this.nameOf(
        "Account",
        text(view.document["accountId"]),
      ),
      contactName: await this.nameOf(
        "Contact",
        text(view.document["contactId"]),
      ),
      billingAddress: text(view.document["billingAddress"]) ?? null,
      shippingAddress: text(view.document["shippingAddress"]) ?? null,
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

  /** Who the quote goes to: the caller's list, else the contact's address, else the account's. */
  private async recipientsFor(
    view: DocumentView,
    input: SendQuoteInput,
  ): Promise<Recipients> {
    const to = [...(input.to ?? [])];
    if (to.length === 0) {
      const derived =
        (await this.addressOf("Contact", text(view.document["contactId"]))) ??
        (await this.addressOf("Account", text(view.document["accountId"])));
      if (derived !== null) to.push(derived);
    }
    if (to.length === 0) {
      throw new ValidationError(
        'A quote needs a recipient: pass "to", or set an email address on its contact or account.',
        { quoteId: view.id },
      );
    }
    return { to, cc: [...(input.cc ?? [])], bcc: [...(input.bcc ?? [])] };
  }

  private async addressOf(
    entity: string,
    id: string | undefined,
  ): Promise<string | null> {
    if (id === undefined) return null;
    const record = await this.entities.get(entity, id);
    return text(record["emailAddress"]) ?? null;
  }

  /**
   * Render the quote's block model to PDF and store it as a §25 attachment on the email, so the
   * worker's `system.sendEmail` picks it up without any change on its side. A PDF of a commercial
   * document is derived evidence of the *issued* state: it renders what was sent (snapshot blocks),
   * never the live catalog.
   */
  private async attachQuotePdf(
    emailId: string,
    rendered: QuoteRenderResult,
  ): Promise<QuotePdfAttachment> {
    const attachments = this.attachments;
    if (attachments === undefined) {
      throw new FeatureDisabledError("attachment storage");
    }
    const renderer = await createPdfkitRenderer();
    const pdf = await renderer.render(rendered.blocks, {
      title: rendered.subject,
      producer: "CaroCRM Sales",
    });
    const number = rendered.number ?? "draft";
    const stored: AttachmentDto = await attachments.upload({
      filename: `Quote-${number}.pdf`,
      mimeType: "application/pdf",
      body: pdf,
      parentId: emailId,
      parentType: "Email",
      field: "attachments",
      role: "quote-pdf",
    });
    return {
      id: stored.id,
      filename: stored.name,
      mimeType: stored.mimeType,
      size: stored.size,
      checksum: stored.checksum,
    };
  }

  /**
   * Store the email as a record and return its id. It is a normal `Email` record linked to the quote
   * through `parentType`/`parentId`, so it appears in the quote's stream and in the mail module's own
   * list — and `EmailService.queueSend` (which owns validation and the delivery ledger) takes it from
   * here.
   */
  private async createEmail(
    view: DocumentView,
    rendered: QuoteRenderResult,
    recipients: Recipients,
    input: SendQuoteInput,
  ): Promise<string> {
    const html = rendered.format === "html";
    const note = input.message?.trim() ?? "";
    const plain = html ? rendered.text : rendered.body;
    const created = await this.entities.create("Email", {
      name: input.subject ?? rendered.subject,
      status: "Draft",
      direction: "Outbound",
      parentType: "Quote",
      parentId: view.id,
      toAddressList: recipients.to.join(", "),
      ccAddressList:
        recipients.cc.length === 0 ? null : recipients.cc.join(", "),
      bccAddressList:
        recipients.bcc.length === 0 ? null : recipients.bcc.join(", "),
      body: note === "" ? plain : `${note}\n\n${plain}`,
      bodyHtml: html
        ? note === ""
          ? rendered.body
          : `<p>${escapeHtml(note)}</p>\n${rendered.body}`
        : null,
      ...(input.emailAccountId === undefined
        ? {}
        : { emailAccountId: input.emailAccountId }),
    });
    const emailId = text(created["id"]);
    if (emailId === undefined)
      throw new ValidationError("Creating the quote email returned no id.");
    return emailId;
  }
}

function toRenderInput(
  view: DocumentView,
  parties: QuoteParties,
): QuoteRenderInput {
  const document = view.document;
  return {
    number: text(document["number"]) ?? null,
    status: text(document["status"]) ?? "draft",
    quoteDate: text(document["quoteDate"]) ?? null,
    validUntil: text(document["validUntil"]) ?? null,
    accountName: parties.accountName,
    contactName: parties.contactName,
    billingAddress: parties.billingAddress,
    shippingAddress: parties.shippingAddress,
    description: text(document["description"]) ?? null,
    lines: view.totals.lines.map(quoteRenderLine),
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

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
