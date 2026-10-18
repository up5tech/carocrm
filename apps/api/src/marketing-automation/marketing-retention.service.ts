import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";

/**
 * Phase 19-MA.18 — privacy-aware retention (§15 `19-MA.18`).
 *
 * Suppression evidence is **never** deleted (§6.8): removing it could re-email an opted-out person.
 * Retention only targets normalized events and delivery rows, and only after an explicit operator
 * request with a dry-run summary first.
 */
export interface RetentionDryRun {
  readonly cutoff: string;
  readonly marketingEvents: number;
  readonly recipientDeliveriesSent: number;
  readonly note: string;
}

@Injectable()
export class MarketingRetentionService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async dryRun(olderThanDays: number): Promise<RetentionDryRun> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const events = await sql<{ count: string }>`
      select count(*)::text as count from marketing_events where received_at < ${cutoff}
    `.execute(this.database.db);
    const deliveries = await sql<{ count: string }>`
      select count(*)::text as count from marketing_recipient_deliveries
      where state in ('Sent','Delivered') and (sent_at is null or sent_at < ${cutoff})
    `.execute(this.database.db);
    return {
      cutoff,
      marketingEvents: Number(events.rows[0]?.count ?? "0"),
      recipientDeliveriesSent: Number(deliveries.rows[0]?.count ?? "0"),
      note: "Suppression records are excluded from retention and are never deleted.",
    };
  }
}
