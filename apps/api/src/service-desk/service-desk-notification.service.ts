import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.5/SD.6 — assignment and reply notifications
 * (PLAN_Phase_19_ServiceDesk.md §12.3, acceptance "notifications reflect the new assignment" and
 * "Add notifications with event/recipient idempotency").
 *
 * The platform already owns the in-app notification store (`notifications`, the same table Customer
 * Success writes), so this writes one row there rather than inventing transport. Generation is
 * separated from delivery — a Worker job reads the table — and every row carries a `dedupKey`, so a
 * retried command cannot produce a second notification for the same event/recipient (§12.3).
 *
 * Two events are notified: a case being assigned, and a *public* reply on a case (to the assignee and
 * the case's internal followers). Internal-only notes notify nobody here — a customer is never told
 * about an internal note (§12.2), and the mention path in the stream service already covers the
 * named agent. Portal users are never recipients: they cannot open internal content.
 *
 * Off by default: an installation that has not switched notifications on stores no rows, and a test
 * cannot accidentally produce them. Nothing here ever sends email.
 */

export interface CaseAssignmentNotification {
  readonly userId: string;
  readonly caseId: string;
  readonly caseNumber: string | null;
  readonly subject: string | null;
  readonly actorUserId: string;
  /** Stable identity of the assignment event; the same key never yields two rows for one recipient. */
  readonly dedupKey: string;
}

export interface CaseReplyNotification {
  readonly userId: string;
  readonly caseId: string;
  readonly caseNumber: string | null;
  readonly subject: string | null;
  readonly actorUserId: string;
  /**
   * Stable identity of the reply event — the stream item id. The same reply never yields two rows for
   * one recipient, however many times the command is retried (§12.3).
   */
  readonly dedupKey: string;
}

export interface NotificationResult {
  readonly id: string;
  readonly created: boolean;
}

@Injectable()
export class ServiceDeskNotificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
  ) {}

  async assignment(input: CaseAssignmentNotification): Promise<NotificationResult> {
    return this.write("ServiceDeskCaseAssigned", {
      userId: input.userId,
      caseId: input.caseId,
      caseNumber: input.caseNumber,
      subject: input.subject,
      title: (caseNumber) => (caseNumber === null ? "Case assigned" : `Case ${caseNumber} assigned`),
      actorUserId: input.actorUserId,
      dedupKey: input.dedupKey,
    });
  }

  /** A customer-visible reply on a case; internal notes are deliberately never notified here. */
  async publicReply(input: CaseReplyNotification): Promise<NotificationResult> {
    return this.write("ServiceDeskCaseReply", {
      userId: input.userId,
      caseId: input.caseId,
      caseNumber: input.caseNumber,
      subject: input.subject,
      title: (caseNumber) => (caseNumber === null ? "New reply on a case" : `New reply on case ${caseNumber}`),
      actorUserId: input.actorUserId,
      dedupKey: input.dedupKey,
    });
  }

  private async write(
    type: string,
    input: {
      readonly userId: string;
      readonly caseId: string;
      readonly caseNumber: string | null;
      readonly subject: string | null;
      readonly title: (caseNumber: string | null) => string;
      readonly actorUserId: string;
      readonly dedupKey: string;
    },
  ): Promise<NotificationResult> {
    const settings = await this.settings.settings();
    if (!settings.features.notifications) return { id: "", created: false };
    // Telling someone about their own action is noise, not a notification.
    if (input.userId === input.actorUserId) return { id: "", created: false };

    if (await this.alreadyNotified(input.userId, input.dedupKey)) {
      return { id: "", created: false };
    }
    const id = randomId();
    const data = {
      title: input.title(input.caseNumber),
      body: input.subject ?? "",
      link: `/Case/${input.caseId}`,
      dedupKey: input.dedupKey,
      module: "ServiceDesk",
      caseId: input.caseId,
    };
    await this.database.db
      .insertInto("notifications")
      .values({
        id,
        type,
        user_id: input.userId,
        data: JSON.stringify(data),
        is_read: false,
        created_at: new Date(),
      })
      .execute();
    return { id, created: true };
  }

  private async alreadyNotified(userId: string, dedupKey: string): Promise<boolean> {
    const rows = await sql<{ id: string }>`
      select id from notifications
      where user_id = ${userId} and (data ->> 'dedupKey') = ${dedupKey}
      limit 1
    `.execute(this.database.db);
    return rows.rows.length > 0;
  }
}

function randomId(): string {
  // The platform's notification ids are opaque strings; a UUID keeps them collision-free.
  return globalThis.crypto.randomUUID();
}
