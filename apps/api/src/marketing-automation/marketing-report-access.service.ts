import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { CAMPAIGN_ENTITY } from "./marketing-automation-domain.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";

/**
 * Phase 22.12 — the gate the campaign reports answer to.
 *
 * A campaign's event log, its statistics and its attribution report are all answers about *this campaign*,
 * and the event log is the one report that carries who received what. Before this gate they answered any
 * authenticated caller: a marketer on another team could page through a campaign they cannot open and read
 * the recipient records and address digests behind it, while the sibling report
 * (`action/send/:id/recipients`) had been applying record ACL from the start. Reporting is not a separate
 * permission — §9.2 says the same read grant decides both, and `action/campaign/:id/validate` already
 * answers to it.
 */
@Injectable()
export class MarketingReportAccessService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  /** Refuse a report about a campaign this caller may not read, exactly as the record API would. */
  async assertCampaignReadable(campaignId: string): Promise<void> {
    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "read", {
      id: campaignId,
      assignedUserId: typeof row.data["assignedUserId"] === "string" ? row.data["assignedUserId"] : undefined,
      createdById: typeof row.data["createdById"] === "string" ? row.data["createdById"] : undefined,
      teams: Array.isArray(row.data["teams"]) ? (row.data["teams"] as string[]) : [],
      data: row.data,
    });
  }
}
