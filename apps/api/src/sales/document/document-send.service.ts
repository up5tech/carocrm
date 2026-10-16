import {
  FeatureDisabledError,
  InternalServerError,
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { createPdfkitRenderer, escapeHtml } from "@carocrm/document";
import type { MailTransportInfo } from "@carocrm/mail";
import { Inject, Injectable, Optional } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import {
  type AttachmentDto,
  AttachmentService,
} from "../../attachment/attachment.service.js";
import { EmailService } from "../../email/email.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { documentDescriptor, type ImplementedDocumentKind, PURCHASING_KINDS, requireDocumentKind, STOCK_MOVING_KINDS } from "./descriptors.js";
import type { DocumentView } from "./document.service.js";
import { SalesDocumentService } from "./document.service.js";
import type { DocumentRenderResult } from "./render.service.js";
import { SalesDocumentRenderService } from "./render.service.js";

/**
 * Phase 19-S.17 — sending any commercial document by mail (§4.16, §9.4, 19-S.17 task 4).
 *
 * The quote had its own send path from 19-S.7; this is the same contract for the other nine kinds, on
 * top of the pieces that already exist:
 *
 *  - rendering is `SalesDocumentRenderService` — the identical call `…/document/:kind/:id/render`
 *    serves, so what the user previews is byte-for-byte what gets emailed;
 *  - the document is issued by its **own** transition (`issues: true` in the descriptor), so the
 *    number, the snapshot, the lock and the outbox event all come from the engine;
 *  - the message is an ordinary `Email` record queued by `EmailService`, and the worker makes the
 *    network call. Nothing here opens a socket, and a transport that is not configured is refused
 *    *before* anything is issued — a document must never be marked official for an email that did
 *    not go out.
 *
 * Two rules that are specific to this wider surface:
 *
 *  - **A stock-moving document is never issued by sending it.** Confirming an order, a delivery, a
 *    return or a receipt moves or reserves stock (19-S.14), which is a warehouse act, not a side effect
 *    of pressing "send". Those kinds must already be confirmed; the refusal says so and points at the
 *    command.
 *  - **The counterparty decides the default recipient.** A purchasing document goes to its supplier's
 *    address; a selling one to its contact, then its account. A document with neither is refused
 *    rather than silently mailed to nobody.
 */

export interface SendDocumentInput {
  readonly to?: readonly string[] | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly templateCode?: string | undefined;
  readonly subject?: string | undefined;
  readonly message?: string | undefined;
  readonly emailAccountId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly attachPdf?: boolean | undefined;
}

export interface DocumentPdfAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string | null;
}

export interface SendDocumentResult {
  readonly kind: ImplementedDocumentKind;
  readonly document: DocumentView;
  readonly email: Record<string, unknown>;
  readonly rendered: DocumentRenderResult;
  readonly transport: MailTransportInfo;
  readonly job: { readonly id: string; readonly name: string; readonly status: string };
  /** True when this call issued the document; false when it was already official (a re-send). */
  readonly issued: boolean;
  readonly pdfAttachment: DocumentPdfAttachment | null;
}

interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

@Injectable()
export class SalesDocumentSendService {
  constructor(
    @Inject(SalesDocumentService)
    private readonly documents: SalesDocumentService,
    @Inject(SalesDocumentRenderService)
    private readonly renderer: SalesDocumentRenderService,
    @Inject(EmailService) private readonly emails: EmailService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Optional()
    @Inject(AttachmentService)
    private readonly attachments?: AttachmentService,
  ) {}

  async send(
    rawKind: string,
    id: string,
    input: SendDocumentInput,
  ): Promise<SendDocumentResult> {
    const kind = requireDocumentKind(rawKind);
    if (kind === "quote") {
      // The quote's send path predates this one (19-S.7) and renders its own layout; leaving it
      // reachable at its documented route avoids silently changing a customer's quote emails.
      throw new ValidationError(
        "A quote is sent with `POST /api/v1/Sales/quote/:id/send`.",
        { kind },
      );
    }
    const descriptor = documentDescriptor(kind);
    const issuing = descriptor.transitions.find(
      (transition) => transition.issues === true,
    );
    if (issuing === undefined) {
      throw new NotFoundError(
        `A ${descriptor.label.toLowerCase()} has no issuing transition to send it from.`,
      );
    }

    const view = await this.documents.view(kind, id);
    const state = text(view.document["status"]) ?? descriptor.initialState;

    // Cheap refusals first, all before anything is issued (see the class comment).
    await this.acl.assertAccess("Email", "create");
    await this.acl.assertAccess("Email", "edit");
    if (this.emails.info().name === "none") {
      throw new FeatureDisabledError("mail transport");
    }

    const isDraft = state === descriptor.initialState;
    const isOfficial = state === issuing.to;
    if (!isDraft && !isOfficial) {
      throw new ValidationError(
        `Only a draft or an issued ${descriptor.label.toLowerCase()} can be sent; this one is "${state}".`,
        { kind, documentId: id, status: state },
      );
    }
    if (isDraft && STOCK_MOVING_KINDS.includes(kind)) {
      throw new ValidationError(
        `A draft ${descriptor.label.toLowerCase()} is not sent: confirming it moves stock, which is a deliberate act. Confirm it first (\`…/transition\` with action "${issuing.action}"), then send it.`,
        { kind, documentId: id, action: issuing.action },
      );
    }

    const recipients = await this.recipientsFor(kind, view, input);
    const preview = await this.renderer.render(kind, id, input.templateCode);

    const wantsPdf = input.attachPdf === true;
    if (wantsPdf) {
      if (this.attachments === undefined) {
        throw new FeatureDisabledError("attachment storage");
      }
      // The render already asked whether the optional PDF engine is installed; refuse before issuing
      // rather than issuing a document whose attachment then fails.
      if (!preview.pdf.available) {
        throw new ValidationError(
          'A PDF attachment was requested, but the optional "pdfkit" dependency is not installed. Install it or send without `attachPdf`.',
          { kind, documentId: id, reason: preview.pdf.reason },
        );
      }
    }

    let issued = false;
    if (isDraft) {
      await runAsSalesInternal(() =>
        this.documents.transition(kind, id, issuing.action, {
          correlationId: input.correlationId,
        }),
      );
      issued = true;
    }
    // Re-render after issuance so the body and subject carry the number that was just allocated.
    const rendered = issued
      ? await this.renderer.render(kind, id, input.templateCode)
      : preview;

    const emailId = await this.createEmail(kind, view, rendered, recipients, input);
    const pdfAttachment = wantsPdf
      ? await this.attachPdf(kind, emailId, rendered)
      : null;

    try {
      const queued = await this.emails.queueSend(emailId);
      return {
        kind,
        document: await this.documents.view(kind, id),
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
        `The ${descriptor.label.toLowerCase()} is sent, but its email could not be queued. It is stored as a draft (${emailId}) and can be queued from the Email module.`,
        {
          emailId,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async recipientsFor(
    kind: ImplementedDocumentKind,
    view: DocumentView,
    input: SendDocumentInput,
  ): Promise<Recipients> {
    const to = [...(input.to ?? [])];
    if (to.length === 0) {
      const derived = PURCHASING_KINDS.includes(kind)
        ? await this.addressOf("Supplier", text(view.document["supplierId"]))
        : ((await this.addressOf("Contact", text(view.document["contactId"]))) ??
          (await this.addressOf("Account", text(view.document["accountId"]))));
      if (derived !== null) to.push(derived);
    }
    if (to.length === 0) {
      throw new ValidationError(
        `This document needs a recipient: pass "to", or set an email address on its ${
          PURCHASING_KINDS.includes(kind) ? "supplier" : "contact or account"
        }.`,
        { kind, documentId: view.id },
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

  private async createEmail(
    kind: ImplementedDocumentKind,
    view: DocumentView,
    rendered: DocumentRenderResult,
    recipients: Recipients,
    input: SendDocumentInput,
  ): Promise<string> {
    const descriptor = documentDescriptor(kind);
    const html = rendered.format === "html";
    const note = input.message?.trim() ?? "";
    const plain = html ? rendered.text : rendered.body;
    const created = await this.entities.create("Email", {
      name: input.subject ?? rendered.subject,
      status: "Draft",
      direction: "Outbound",
      parentType: descriptor.entity,
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
    if (emailId === undefined) {
      throw new ValidationError(
        `Creating the ${descriptor.label.toLowerCase()} email returned no id.`,
      );
    }
    return emailId;
  }

  /** The PDF is derived from the same blocks the email body used, so the two cannot disagree. */
  private async attachPdf(
    kind: ImplementedDocumentKind,
    emailId: string,
    rendered: DocumentRenderResult,
  ): Promise<DocumentPdfAttachment> {
    const attachments = this.attachments;
    if (attachments === undefined) {
      throw new FeatureDisabledError("attachment storage");
    }
    const descriptor = documentDescriptor(kind);
    const renderer = await createPdfkitRenderer();
    const pdf = await renderer.render(rendered.blocks, {
      title: rendered.subject,
      producer: "CaroCRM Sales",
    });
    const number = rendered.number ?? "draft";
    const stored: AttachmentDto = await attachments.upload({
      filename: `${descriptor.label}-${number}.pdf`,
      mimeType: "application/pdf",
      body: pdf,
      parentId: emailId,
      parentType: "Email",
      field: "attachments",
      role: `${kind}-pdf`,
    });
    return {
      id: stored.id,
      filename: stored.name,
      mimeType: stored.mimeType,
      size: stored.size,
      checksum: stored.checksum,
    };
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
