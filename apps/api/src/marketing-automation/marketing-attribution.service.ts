import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { MarketingReportAccessService } from "./marketing-report-access.service.js";

/**
 * Phase 19-MA.17 — attribution and funnel analytics (§15 `19-MA.17`).
 *
 * Attribution is reported as a *model* (first-touch / last-touch / influenced) over the normalized event
 * log and the recipient ledger. Revenue is never duplicated here: we store only references and an
 * optional amount supplied by the caller, and the report labels the basis. Aggregates carry an `asOf`
 * timestamp so asynchronous results are honest (§15 acceptance).
 */
export type AttributionModel = "first_touch" | "last_touch" | "influenced";

export interface AttributionReport {
  readonly campaignId: string;
  readonly model: AttributionModel;
  readonly asOf: string;
  readonly touches: number;
  readonly uniqueRecipients: number;
  readonly conversions: number;
  readonly conversionRate: number;
  readonly influencedRevenue: number | null;
  readonly note: string;
}

export interface FunnelStage {
  readonly stage: string;
  readonly count: number;
}

export interface FunnelReport {
  readonly campaignId: string;
  readonly asOf: string;
  readonly stages: readonly FunnelStage[];
  readonly dropOff: readonly { readonly from: string; readonly to: string; readonly rate: number }[];
}

@Injectable()
export class MarketingAttributionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MarketingReportAccessService) private readonly reports: MarketingReportAccessService,
  ) {}

  async attribution(campaignId: string, model: AttributionModel = "influenced"): Promise<AttributionReport> {
    await this.reports.assertCampaignReadable(campaignId);
    const asOf = new Date().toISOString();
    const touches = await sql<{ count: string }>`
      select count(*)::text as count from marketing_events where campaign_id = ${campaignId}
    `.execute(this.database.db);
    const uniq = await sql<{ count: string }>`
      select count(distinct recipient_entity_id)::text as count from marketing_events
      where campaign_id = ${campaignId} and recipient_entity_id is not null
    `.execute(this.database.db);
    const conversions = await sql<{ count: string }>`
      select count(*)::text as count from marketing_events
      where campaign_id = ${campaignId} and normalized_type = 'conversion'
    `.execute(this.database.db);
    const revenue = await sql<{ total: string | null }>`
      select coalesce(sum((properties->>'amount')::numeric), 0)::text as total
      from marketing_events
      where campaign_id = ${campaignId} and normalized_type = 'conversion'
    `.execute(this.database.db);

    const touchCount = Number(touches.rows[0]?.count ?? "0");
    const convCount = Number(conversions.rows[0]?.count ?? "0");
    const rate = touchCount > 0 ? convCount / touchCount : 0;
    const total = revenue.rows[0]?.total;

    return {
      campaignId,
      model,
      asOf,
      touches: touchCount,
      uniqueRecipients: Number(uniq.rows[0]?.count ?? "0"),
      conversions: convCount,
      conversionRate: rate,
      influencedRevenue: total === null ? null : Number(total),
      note:
        model === "influenced"
          ? "Influenced revenue is not additive across campaigns; a conversion may be attributed to several touches."
          : `${model} attribution selects a single touch per conversion.`,
    };
  }

  async funnel(campaignId: string): Promise<FunnelReport> {
    await this.reports.assertCampaignReadable(campaignId);
    const asOf = new Date().toISOString();
    const rows = await sql<{ normalized_type: string; count: string }>`
      select normalized_type, count(*)::text as count
      from marketing_events
      where campaign_id = ${campaignId}
      group by normalized_type
      order by min(received_at) asc
    `.execute(this.database.db);
    const stages: FunnelStage[] = rows.rows.map((r) => ({ stage: r.normalized_type, count: Number(r.count) }));
    const dropOff: { from: string; to: string; rate: number }[] = [];
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      if (from === undefined || to === undefined) continue;
      const rate = from.count > 0 ? 1 - to.count / from.count : 0;
      dropOff.push({ from: from.stage, to: to.stage, rate });
    }
    return { campaignId, asOf, stages, dropOff };
  }
}
