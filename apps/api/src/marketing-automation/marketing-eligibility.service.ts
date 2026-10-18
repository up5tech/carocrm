import { Inject, Injectable } from "@nestjs/common";

import { type AppConfig,CONFIG_TOKEN } from "../config.js";
import {
  type CampaignPurpose,
  type CampaignStatus,
  checkCampaignSendable,
  type ConsentChannel,
  type ConsentStatus,
  evaluateRecipientEligibility,
  isConsentStatus,
  MARKETING_CONSENT_ENTITY,
  normalizeEmailAddress,
  type RecipientEligibilityDecision,
  type SuppressionFact,
} from "./marketing-automation-domain.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { emailIdentity } from "./marketing-identity.js";
import { type AppliedSuppression,MarketingSuppressionService } from "./marketing-suppression.service.js";

/**
 * Phase 19-MA.5 — the single eligibility gate
 * (PLAN_Phase_19_Marketing_Automation.md §5.3, §7.1 `MarketingEligibilityService`, §0.1 rule 8).
 *
 * §0.1 rule 8 says consent and suppression are mandatory server-side gates that *nothing* may bypass — no
 * UI toggle, workflow, journey action, retry, manual bulk send or API command. That is only true if there is
 * exactly one place that answers "may we send to this person", and this is it. The rules themselves are pure
 * and live in `evaluateRecipientEligibility`; this service is the data access around them: it resolves the
 * address identity, reads the consent state and the applied suppressions, and hands a complete input to the
 * matrix. A caller that skipped this service would have to re-implement the reading, and that is how a gate
 * gets bypassed.
 *
 * Reads are bulk by design (§5.2 "enforce query cost/time limits"): a 10,000-record audience is two queries
 * for consent and two for suppression, not twenty thousand.
 */

export interface EligibilityContext {
  readonly channel: ConsentChannel;
  readonly purpose: CampaignPurpose;
  readonly campaignStatus: CampaignStatus;
  /** Only consulted when a campaign is actually being run, never for a preview (§5.3). */
  readonly globalSendPaused?: boolean | undefined;
  /** The audience the recipient was named by, for a list-scoped suppression. */
  readonly targetListId?: string | undefined;
  /** Overrides the purpose default; `ServiceNotice` on an acknowledged campaign is the one exemption. */
  readonly consentRequired?: boolean | undefined;
  readonly frequencyCap?: number | undefined;
}

export interface RecipientCandidate {
  readonly entityType: string;
  readonly entityId: string;
  readonly emailAddress?: string | undefined;
  /** Pre-computed identity, when the caller already has one (a snapshot entry, for instance). */
  readonly emailHash?: string | undefined;
  /** False when the caller's ACL cannot read the person record. */
  readonly readable?: boolean | undefined;
  readonly messagesInWindow?: number | undefined;
}

export interface EligibilityDecision {
  readonly entityType: string;
  readonly entityId: string;
  readonly emailHash: string | null;
  readonly consentStatus: ConsentStatus;
  readonly suppressions: readonly AppliedSuppression[];
  readonly decision: RecipientEligibilityDecision;
}

@Injectable()
export class MarketingEligibilityService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingSuppressionService) private readonly suppressions: MarketingSuppressionService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** One recipient, fully evaluated. */
  async decide(
    candidate: RecipientCandidate,
    context: EligibilityContext,
  ): Promise<EligibilityDecision> {
    const decisions = await this.decideMany([candidate], context);
    const first = decisions[0];
    if (first === undefined) {
      throw new Error("Eligibility evaluation returned no decision for a single candidate.");
    }
    return first;
  }

  /**
   * Many recipients, evaluated against preloaded consent and suppression state. The returned order matches
   * the input, so a caller can zip the decisions back onto its own rows.
   */
  async decideMany(
    candidates: readonly RecipientCandidate[],
    context: EligibilityContext,
  ): Promise<readonly EligibilityDecision[]> {
    const identities = candidates.map((candidate) => this.identityOf(candidate));
    const hashes = [...new Set(identities.filter((hash): hash is string => hash !== null))];

    const consentByHash = await this.consentByHash(hashes, context);
    const suppressionByHash = await this.suppressions.appliedForMany(hashes, {
      channel: context.channel,
      purpose: context.purpose,
      ...(context.targetListId !== undefined ? { targetListId: context.targetListId } : {}),
    });

    return candidates.map((candidate, index) => {
      const emailHash = identities[index] ?? null;
      const consentStatus =
        emailHash === null ? "Unknown" : consentByHash.get(emailHash) ?? "Unknown";
      const applied = emailHash === null ? [] : suppressionByHash.get(emailHash) ?? [];
      const decision = evaluateRecipientEligibility({
        emailAddress: candidate.emailAddress,
        channel: context.channel,
        purpose: context.purpose,
        consentStatus,
        suppressions: applied.map<SuppressionFact>((item) => ({ reason: item.reason, scope: item.scope })),
        ...(candidate.readable !== undefined ? { recordReadable: candidate.readable } : {}),
        ...(candidate.messagesInWindow !== undefined ? { messagesInWindow: candidate.messagesInWindow } : {}),
        ...(context.frequencyCap !== undefined ? { frequencyCap: context.frequencyCap } : {}),
        ...(context.consentRequired !== undefined ? { consentRequired: context.consentRequired } : {}),
      });
      return {
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        emailHash,
        consentStatus,
        suppressions: applied,
        decision,
      };
    });
  }

  /**
   * Whether the *campaign* may put messages on the wire right now — kept separate from the recipient
   * question so an emergency stop is one obvious check on every path (§13), and so a preview on a Draft
   * campaign can still answer the recipient question honestly.
   */
  sendable(context: EligibilityContext): ReturnType<typeof checkCampaignSendable> {
    return checkCampaignSendable({
      status: context.campaignStatus,
      ...(context.globalSendPaused !== undefined ? { globalSendPaused: context.globalSendPaused } : {}),
    });
  }

  /** The identity used to match consent and suppression. Public so the audience resolver can reuse it. */
  identityOf(candidate: RecipientCandidate): string | null {
    const direct = candidate.emailHash?.trim() ?? "";
    if (direct !== "") return /^[0-9a-f]{64}$/.test(direct) ? direct : null;
    return emailIdentity(normalizeEmailAddress(candidate.emailAddress), this.config.encryptionKey)?.hash ?? null;
  }

  private async consentByHash(
    hashes: readonly string[],
    context: EligibilityContext,
  ): Promise<Map<string, ConsentStatus>> {
    const out = new Map<string, ConsentStatus>();
    if (hashes.length === 0) return out;
    const rows = await this.records.findByAttrIn(MARKETING_CONSENT_ENTITY, "emailHash", hashes, {
      limit: hashes.length * 4,
    });
    for (const row of rows) {
      if (row.data["channel"] !== undefined && row.data["channel"] !== context.channel) continue;
      if (row.data["purpose"] !== context.purpose) continue;
      const hash = typeof row.data["emailHash"] === "string" ? row.data["emailHash"] : "";
      // The unique index guarantees one live row per identity+channel+purpose, so last-write wins here
      // only in the sense that there is nothing else to choose between.
      out.set(hash, isConsentStatus(row.data["status"]) ? row.data["status"] : "Unknown");
    }
    return out;
  }
}
