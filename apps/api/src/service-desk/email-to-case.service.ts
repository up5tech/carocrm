import { FeatureDisabledError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { EMAIL_ENTITY } from "../email/email.constants.js";
import { EmailService } from "../email/email.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { StreamService } from "../stream/stream.service.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";
import { ServiceDeskRecords } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.7 — Email-to-Case ingestion and outbound replies
 * (PLAN_Phase_19_ServiceDesk.md §5.5, §7.1).
 */
export interface ProcessEmailResult {
  readonly emailId: string;
  readonly caseId: string;
  readonly streamItemId: string | null;
  readonly created: boolean;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
}

export interface CaseEmailReplyResult {
  readonly caseId: string;
  readonly emailId: string;
  readonly messageId: string | null;
  readonly queued: boolean;
}

@Injectable()
export class EmailToCaseService {
  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(StreamService) private readonly stream: StreamService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
  ) {}

  async processEmail(emailId: string): Promise<ProcessEmailResult> {
    const settings = await this.settings.settings();
    if (!settings.features.emailToCase) throw new FeatureDisabledError("emailToCase");

    const record = await this.entities.get(EMAIL_ENTITY, emailId);
    const status = typeof record["status"] === "string" ? record["status"] : "";
    if (status !== "Inbound") {
      throw new ValidationError("Only inbound emails can be processed into cases.", { emailId, status });
    }

    const existingCaseId = text(record["caseId"]);
    const existingItemId = text(record["streamItemId"]);
    const existingStatus = text(record["emailToCaseStatus"]);
    if (existingStatus === "processed" && existingCaseId !== undefined) {
      return { emailId, caseId: existingCaseId, streamItemId: existingItemId ?? null, created: false, skipped: false };
    }
    if (existingStatus !== undefined && existingStatus.startsWith("skipped")) {
      return { emailId, caseId: existingCaseId ?? "", streamItemId: null, created: false, skipped: true, reason: existingStatus };
    }

    const from = text(record["fromAddress"]) ?? "";
    const subject = text(record["name"]) ?? "(no subject)";
    const body = text(record["body"]) ?? text(record["bodyHtml"]) ?? "";

    const skipReason = this.loopReason(record);
    if (skipReason !== undefined) {
      await this.markEmail(emailId, { emailToCaseStatus: `skipped:${skipReason}` });
      return { emailId, caseId: "", streamItemId: null, created: false, skipped: true, reason: skipReason };
    }

    const threadKey = text(record["threadId"]) ?? text(record["inReplyTo"]) ?? text(record["messageId"]) ?? emailId;
    const prior = await this.findThreadCase(threadKey, emailId);

    const now = new Date();
    if (prior === undefined) {
      const contact = await this.findContactByEmail(from);
      const result = await runInTransaction(this.database.db, async () => {
        const created = await this.entities.create(CASE_ENTITY, {
          name: subject.slice(0, 255),
          description: body,
          source: "Email",
          status: "New",
          ...(contact !== undefined ? { contactId: contact.id, accountId: contact.accountId } : {}),
          requesterEmail: from,
          requesterName: from,
        });
        const caseId = String(created["id"]);
        await runAsServiceDeskInternal(() =>
          this.entities.update(CASE_ENTITY, caseId, {
            lastActivityAt: now.toISOString(),
            lastCustomerResponseAt: now.toISOString(),
          }),
        );
        const item = await this.stream.create(CASE_ENTITY, caseId, {
          type: "Post",
          post: body === "" ? subject : body,
          visibility: "public",
          data: { channel: "email", emailId, messageId: text(record["messageId"]) ?? null },
        });
        await this.markEmail(emailId, { caseId, streamItemId: item.id, emailToCaseStatus: "processed", threadId: threadKey });
        return { caseId, streamItemId: item.id };
      });
      return { emailId, caseId: result.caseId, streamItemId: result.streamItemId, created: true, skipped: false };
    }

    const caseId = prior.caseId;
    const item = await this.stream.create(CASE_ENTITY, caseId, {
      type: "Post",
      post: body === "" ? subject : body,
      visibility: "public",
      data: { channel: "email", emailId, messageId: text(record["messageId"]) ?? null },
    });
    await runAsServiceDeskInternal(() =>
      this.entities.update(CASE_ENTITY, caseId, {
        lastActivityAt: now.toISOString(),
        lastCustomerResponseAt: now.toISOString(),
      }),
    );
    await this.markEmail(emailId, { caseId, streamItemId: item.id, emailToCaseStatus: "processed", threadId: threadKey });
    return { emailId, caseId, streamItemId: item.id, created: false, skipped: false };
  }

  async processInbound(): Promise<{ fetched: number; stored: number; skipped: number; processed: number; failed: number }> {
    const settings = await this.settings.settings();
    if (!settings.features.emailToCase) throw new FeatureDisabledError("emailToCase");
    const poll = await this.email.pollInbound();
    let processed = 0;
    let failed = 0;
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", EMAIL_ENTITY)
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'status'`, "=", "Inbound")
      .execute();
    for (const row of rows) {
      const attrs = (row.attrs ?? {}) as Record<string, unknown>;
      if (text(attrs["emailToCaseStatus"]) === "processed") continue;
      if (String(text(attrs["emailToCaseStatus"]) ?? "").startsWith("skipped")) continue;
      try {
        await this.processEmail(String(row.id));
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return { fetched: poll.fetched, stored: poll.stored, skipped: poll.skipped, processed, failed };
  }

  async replyByEmail(caseId: string, input: { text: string; attachmentIds?: readonly string[] | undefined }): Promise<CaseEmailReplyResult> {
    const settings = await this.settings.settings();
    if (!settings.features.emailToCase) throw new FeatureDisabledError("emailToCase");

    const row = await this.records.byId(CASE_ENTITY, caseId);
    if (row === undefined) throw new NotFoundError(`Case "${caseId}" does not exist.`);
    const subject = text(row.data["name"]) ?? "Case";
    const requesterEmail = text(row.data["requesterEmail"]) ?? (await this.contactEmail(text(row.data["contactId"])));
    if (requesterEmail === undefined) {
      throw new ValidationError("The case has no requester email address to reply to.", { caseId });
    }

    const textBody = input.text.trim();
    if (textBody === "") throw new ValidationError("An email reply needs text.", { caseId });

    // Thread the outbound message with the case's last inbound mail, so the customer's mail client
    // groups it and a reply from them matches the same case (§5.5). The sending address is left to
    // the mail account/transport configuration rather than hard-coded (§28.1).
    const lastInbound = await this.lastInboundEmail(caseId);
    const parentMessageId = text(lastInbound?.["messageId"]);
    const threadId = text(lastInbound?.["threadId"]) ?? parentMessageId;

    const created = await this.entities.create(EMAIL_ENTITY, {
      name: `Re: ${subject}`,
      status: "Draft",
      direction: "Outbound",
      ...(settings.email.replyFromAddress !== "" ? { fromAddress: settings.email.replyFromAddress } : {}),
      toAddressList: requesterEmail,
      body: textBody,
      parentType: CASE_ENTITY,
      parentId: caseId,
      ...(parentMessageId !== undefined ? { inReplyTo: parentMessageId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
    });

    const emailId = String(created["id"]);
    let queued = false;
    try {
      await this.email.queueSend(emailId);
      queued = true;
    } catch {
      queued = false;
    }

    const now = new Date();
    const item = await this.stream.create(CASE_ENTITY, caseId, {
      type: "Post",
      post: textBody,
      visibility: "public",
      data: { channel: "email", emailId, outbound: true },
    });
    await runAsServiceDeskInternal(() =>
      this.entities.update(CASE_ENTITY, caseId, {
        lastActivityAt: now.toISOString(),
        lastAgentResponseAt: now.toISOString(),
        ...(text(row.data["firstResponseAt"]) === undefined ? { firstResponseAt: now.toISOString() } : {}),
      }),
    );

    return { caseId, emailId, messageId: item.id, queued };
  }

  private async findThreadCase(threadKey: string, currentEmailId: string): Promise<{ caseId: string } | undefined> {
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", EMAIL_ENTITY)
      .where("deleted_at", "is", null)
      .where("id", "!=", currentEmailId)
      .execute();
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      if (text(a["threadId"]) === threadKey && text(a["caseId"]) !== undefined) {
        return { caseId: text(a["caseId"]) as string };
      }
    }
    const cases = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", CASE_ENTITY)
      .where("deleted_at", "is", null)
      .execute();
    for (const c of cases) {
      const a = (c.attrs ?? {}) as Record<string, unknown>;
      if (text(a["threadId"]) === threadKey) return { caseId: String(c.id) };
    }
    return undefined;
  }

  private async findContactByEmail(email: string): Promise<{ id: string; accountId: string | null } | undefined> {
    if (email === "") return undefined;
    const row = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "Contact")
      .where("deleted_at", "is", null)
      .where(sql`lower(attrs ->> 'emailAddress')`, "=", email.toLowerCase())
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const a = (row.attrs ?? {}) as Record<string, unknown>;
    return { id: String(row.id), accountId: text(a["accountId"]) ?? null };
  }

  private async contactEmail(contactId: string | undefined): Promise<string | undefined> {
    if (contactId === undefined) return undefined;
    const row = await this.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "Contact")
      .where("id", "=", contactId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return text((row.attrs as Record<string, unknown>)["emailAddress"]);
  }

  private async lastInboundEmail(caseId: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", EMAIL_ENTITY)
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .where(sql`attrs ->> 'status'`, "=", "Inbound")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : ((row.attrs ?? {}) as Record<string, unknown>);
  }

  private loopReason(record: Record<string, unknown>): string | undefined {
    const subject = (text(record["name"]) ?? "").toLowerCase();
    const headers = text(record["headers"]) ?? "";
    if (subject.startsWith("auto:") || subject.includes("out of office") || subject.includes("automatic reply")) {
      return "auto-reply";
    }
    if (headers.toLowerCase().includes("auto-submitted")) {
      return "auto-submitted";
    }
    if (subject.startsWith("delivery status notification") || subject.startsWith("mail delivery failed")) {
      return "dsn";
    }
    return undefined;
  }

  private async markEmail(emailId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify(patch)}::jsonb, modified_at = now() WHERE id = ${emailId}`.execute(this.database.db);
    } catch {
      // Best effort.
    }
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
