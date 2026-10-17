import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.11 — the module's in-app notification writer (PLAN_Phase_19_Customer_Success.md §11.3).
 *
 * The platform has no notification service; the established writer is a worker job handler that
 * inserts into the `notifications` table directly. Rather than invent a wrapper around a
 * non-existent service, this is the smallest writer the module needs, following the same table
 * shape `system.sendReminders` uses. It is documented in the audit as a module-local facility.
 *
 * It writes **in-app rows only** — never outbound mail or webhooks — and it deduplicates by a stable
 * key plus the configured cadence, so a recurring condition does not become a notification storm.
 */

export interface NotifyInput {
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  /** Stable key for the condition; the cadence applies per key + recipient. */
  readonly dedupKey: string;
  readonly link: string | null;
  readonly severity: "info" | "warning" | "critical";
}

@Injectable()
export class CustomerSuccessNotificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
  ) {}

  async notify(input: NotifyInput): Promise<{ id: string; created: boolean }> {
    const settings = await this.settings.settings();
    if (!settings.features.notifications || !settings.notifications.enabled) {
      // A test must never trigger real delivery, and an installation that has not opted in gets no
      // rows at all — the condition is reported in module health instead.
      return { id: "", created: false };
    }
    if (await this.recentlySent(input.dedupKey, input.userId, settings.notifications.cadenceDays)) {
      return { id: "", created: false };
    }
    const id = randomUUID();
    const data = {
      title: input.title,
      body: input.body,
      link: input.link,
      dedupKey: input.dedupKey,
      severity: input.severity,
      module: "CustomerSuccess",
    };
    await this.database.db
      .insertInto("notifications")
      .values({
        id,
        type: input.type,
        user_id: input.userId,
        data: JSON.stringify(data),
        is_read: false,
        created_at: new Date(),
      })
      .execute();
    return { id, created: true };
  }

  private async recentlySent(dedupKey: string, userId: string, cadenceDays: number): Promise<boolean> {
    const since = new Date(Date.now() - cadenceDays * 86_400_000);
    const rows = await sql<{ id: string }>`
      select id from notifications
      where user_id = ${userId}
        and created_at >= ${since}
        and (data ->> 'dedupKey') = ${dedupKey}
      limit 1
    `.execute(this.database.db);
    return rows.rows.length > 0;
  }
}
