import { randomUUID } from "node:crypto";

import { type CampaignCommand, type CampaignStatus } from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.2 — the marketing domain-event contract (§7.3), and the only place those names are spelled.
 *
 * The names follow the convention every other Phase 19 domain already uses — `<module>.<resource>.<action>`,
 * like `serviceDesk.case.statusChanged` — which is **not** the plan's illustrative
 * `marketing.campaign.created.v1`. Two reasons, both binding: the kernel event grammar accepts 2 to 4 dot
 * segments ([apps/api/src/events/event-bus.ts:14](apps/api/src/events/event-bus.ts#L14)) so a five-segment
 * name is rejected outright, and no other module carries a version in the subject. The version therefore
 * lives in the payload as `schemaVersion`, which is also what §7.3's backward-compatibility requirement
 * needs: a consumer reads the version rather than subscribing to a new subject per revision.
 *
 * Payloads carry **identifiers and decisions only** (§7.3): never a contact object, an email address, a
 * rendered body, a token, or a raw provider payload. A consumer that needs a person reads the canonical
 * record through its own ACL.
 */

export const MARKETING_EVENT_SCHEMA_VERSION = 1;

/** Campaign lifecycle events. Later sub-phases add theirs beside these, under the same contract. */
export const MARKETING_CAMPAIGN_EVENTS = [
  "marketingAutomation.campaign.scheduled",
  "marketingAutomation.campaign.unscheduled",
  "marketingAutomation.campaign.started",
  "marketingAutomation.campaign.paused",
  "marketingAutomation.campaign.resumed",
  "marketingAutomation.campaign.completed",
  "marketingAutomation.campaign.cancelled",
  "marketingAutomation.campaign.archived",
  "marketingAutomation.campaign.validated",
  "marketingAutomation.campaign.duplicated",
] as const;
export type MarketingCampaignEvent = (typeof MARKETING_CAMPAIGN_EVENTS)[number];

/**
 * Which subject each lifecycle command publishes. A total map, so a command added to the domain cannot ship
 * without naming its event — a consumer that misses a lifecycle move is the failure mode §7.3 warns about.
 */
export const CAMPAIGN_EVENT_BY_COMMAND: Readonly<Record<CampaignCommand, MarketingCampaignEvent>> = {
  schedule: "marketingAutomation.campaign.scheduled",
  unschedule: "marketingAutomation.campaign.unscheduled",
  start: "marketingAutomation.campaign.started",
  pause: "marketingAutomation.campaign.paused",
  resume: "marketingAutomation.campaign.resumed",
  complete: "marketingAutomation.campaign.completed",
  cancel: "marketingAutomation.campaign.cancelled",
  archive: "marketingAutomation.campaign.archived",
};

export interface CampaignEventInput {
  readonly type: MarketingCampaignEvent;
  readonly campaignId: string;
  readonly campaignCode?: string | null | undefined;
  readonly from?: CampaignStatus | null | undefined;
  readonly to: CampaignStatus;
  readonly actorUserId: string;
  readonly actorType: string;
  readonly source?: "command" | "system" | "job" | undefined;
  /** Set by a retry so a duplicate delivery is recognisable; a fresh command generates one (§0.1 rule 10). */
  readonly correlationId?: string | undefined;
}

export interface DomainEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * One shape for every campaign event, so a consumer can switch on the subject and rely on the same fields.
 * `correlationId` ties an event to the command that produced it, which is what makes an operator's "why did
 * this campaign stop" answerable a week later (§1.2 "explainable automation").
 */
export function campaignEvent(input: CampaignEventInput): DomainEvent {
  const { type, campaignId, campaignCode, from, to, actorUserId, actorType, source, correlationId } = input;
  return {
    type,
    payload: {
      schemaVersion: MARKETING_EVENT_SCHEMA_VERSION,
      occurredAt: new Date().toISOString(),
      correlationId: correlationId ?? randomUUID(),
      source: source ?? "command",
      campaignId,
      campaignCode: campaignCode ?? null,
      from: from ?? null,
      to,
      actorUserId,
      actorType,
    },
  };
}
