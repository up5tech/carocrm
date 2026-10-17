import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.5 — assignment and reassignment notifications
 * (PLAN_Phase_19_ServiceDesk.md §12.3, acceptance "notifications reflect the new assignment").
 *
 * The platform already owns the in-app notification store (`notifications`, the same table Customer
 * Success writes), so this writes one row there rather than inventing transport. Generation is
 * separated from delivery — a Worker job reads the table — and every row carries a `dedupKey`, so a
 * retried command cannot produce a second notification for the same assignment (§12.3 "deduplicated
 * by event/recipient").
 *
 * Off by default: an installation that has not switched notifications on stores no rows, and a test
 * cannot accidentally produce them. Nothing here ever sends email — a customer is never notified of
 * an internal assignment.
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
    const settings = await this.settings.settings();
    if (!settings.features.notifications) return { id: "", created: false };
    // Telling someone they assigned a case to themselves is noise, not a notification.
    if (input.userId === input.actorUserId) return { id: "", created: false };

    if (await this.alreadyNotified(input.userId, input.dedupKey)) {
      return { id: "", created: false };
    }
    const id = randomId();
    const data = {
      title: input.caseNumber === null ? "Case assigned" : `Case ${input.caseNumber} assigned`,
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
        type: "ServiceDeskCaseAssigned",
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
