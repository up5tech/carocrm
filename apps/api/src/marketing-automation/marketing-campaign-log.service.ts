import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { MarketingReportAccessService } from "./marketing-report-access.service.js";

export interface CampaignLogQuery {
  readonly campaignId: string;
  readonly normalizedType?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CampaignLogEntry {
  readonly id: string;
  readonly inboxId: string | null;
  readonly provider: string;
  readonly providerEventId: string | null;
  readonly eventType: string;
  readonly normalizedType: string;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly sendId: string | null;
  readonly slot: number | null;
  readonly providerMessageId: string | null;
  readonly recipientEntityType: string | null;
  readonly recipientEntityId: string | null;
  readonly emailHash: string | null;
  readonly url: string | null;
}

export interface CampaignStats {
  readonly campaignId: string;
  readonly asOf: string;
  readonly events: {
    readonly total: number;
    readonly byType: readonly { readonly type: string; readonly count: number }[];
  };
  readonly delivery: {
    readonly total: number;
    readonly sent: number;
    readonly delivered: number;
    readonly bounced: number;
    readonly complained: number;
    readonly unsubscribed: number;
    readonly opened: number;
    readonly clicked: number;
  };
  readonly uniqueRecipients: number;
}

@Injectable()
export class MarketingCampaignLogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MarketingReportAccessService) private readonly reports: MarketingReportAccessService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  async log(
    query: CampaignLogQuery,
  ): Promise<{ records: CampaignLogEntry[]; total: number; hidden: number }> {
    await this.reports.assertCampaignReadable(query.campaignId);
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = query.offset ?? 0;
    const filters = [sql`campaign_id = ${query.campaignId}`];
    if (query.normalizedType !== undefined && query.normalizedType !== "") {
      filters.push(sql`normalized_type = ${query.normalizedType}`);
    }
    const where = sql.join(filters, sql` and `);

    const counted = await sql<{ count: string }>`select count(*)::text as count from marketing_events where ${where}`.execute(this.database.db);
    const rows = await sql<Record<string, unknown>>`select id, inbox_id, provider, provider_event_id, event_type, normalized_type, occurred_at, received_at, send_id, slot, provider_message_id, recipient_entity_type, recipient_entity_id, email_hash, url from marketing_events where ${where} order by received_at desc limit ${limit} offset ${offset}`.execute(this.database.db);

    let hidden = 0;
    const records: CampaignLogEntry[] = [];
    for (const r of rows.rows) {
      const entityType = r.recipient_entity_type === null || r.recipient_entity_type === undefined ? null : String(r.recipient_entity_type);
      const entityId = r.recipient_entity_id === null || r.recipient_entity_id === undefined ? null : String(r.recipient_entity_id);
      // Who received a campaign message is a fact about that person's record. A caller who may read the
      // campaign but not this contact gets the event without the identity, counted rather than named — the
      // same rule `action/send/:id/recipients` already keeps.
      const readable = entityType !== null && entityId !== null ? await this.mayRead(entityType, entityId) : true;
      if (entityType !== null && entityId !== null && !readable) hidden += 1;
      records.push({
        id: String(r.id),
        inboxId: r.inbox_id === null || r.inbox_id === undefined ? null : String(r.inbox_id),
        provider: String(r.provider),
        providerEventId: r.provider_event_id === null || r.provider_event_id === undefined ? null : String(r.provider_event_id),
        eventType: String(r.event_type),
        normalizedType: String(r.normalized_type),
        occurredAt: r.occurred_at ? new Date(String(r.occurred_at)).toISOString() : null,
        receivedAt: new Date(String(r.received_at)).toISOString(),
        sendId: r.send_id === null || r.send_id === undefined ? null : String(r.send_id),
        slot: r.slot === null || r.slot === undefined ? null : Number(r.slot),
        providerMessageId: r.provider_message_id === null || r.provider_message_id === undefined ? null : String(r.provider_message_id),
        recipientEntityType: readable ? entityType : null,
        recipientEntityId: readable ? entityId : null,
        emailHash: readable
          ? (r.email_hash === null || r.email_hash === undefined ? null : String(r.email_hash))
          : null,
        url: r.url === null || r.url === undefined ? null : String(r.url),
      });
    }

    return { records, total: Number(counted.rows[0]?.count ?? "0"), hidden };
  }

  /** One recipient record, judged by the read grant this caller already has on it. */
  private async mayRead(entityType: string, entityId: string): Promise<boolean> {
    try {
      await this.entities.get(entityType, entityId);
      return true;
    } catch {
      return false;
    }
  }

  async stats(campaignId: string): Promise<CampaignStats> {
    await this.reports.assertCampaignReadable(campaignId);
    const asOf = new Date().toISOString();
    const typeRows = await sql<{ normalized_type: string; count: string }>`select normalized_type, count(*)::text as count from marketing_events where campaign_id = ${campaignId} group by normalized_type`.execute(this.database.db);
    const byType = typeRows.rows.map((r: Record<string, unknown>) => ({ type: String(r.normalized_type), count: Number(r.count) }));
    const totalEvents = byType.reduce((s: number, x: { type: string; count: number }) => s + x.count, 0);
    const countOf = (t: string) => byType.find((x: { type: string; count: number }) => x.type === t)?.count ?? 0;
    const uniq = await sql<{ count: string }>`select count(distinct recipient_entity_id)::text as count from marketing_events where campaign_id = ${campaignId} and recipient_entity_id is not null`.execute(this.database.db);

    return {
      campaignId,
      asOf,
      events: { total: totalEvents, byType },
      delivery: {
        total: totalEvents,
        sent: countOf("delivered") + countOf("opened") + countOf("clicked"),
        delivered: countOf("delivered"),
        bounced: countOf("hard_bounce") + countOf("soft_bounce"),
        complained: countOf("complaint"),
        unsubscribed: countOf("unsubscribed"),
        opened: countOf("opened"),
        clicked: countOf("clicked"),
      },
      uniqueRecipients: Number(uniq.rows[0]?.count ?? "0"),
    };
  }
}
