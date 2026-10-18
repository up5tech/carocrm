import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { EntityCrudService } from "../entity/entity.service.js";
import {
  blocker,
  CAMPAIGN_ENTITY,
  type CampaignFinding,
  type CampaignStatus,
  type CampaignValidationReport,
  checkCampaignSendable,
  fingerprint,
  isCampaignPurpose,
  isCampaignStatus,
  isCampaignType,
  isSupportedTimeZone,
  purposeTypeMismatch,
  SENDING_CAMPAIGN_TYPES,
  serviceNoticeNeedsAcknowledgement,
  TARGET_LIST_ENTITY,
  warning,
} from "./marketing-automation-domain.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";

/**
 * Phase 19-MA.3 — campaign send-readiness validation
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §8.4, §9.3, §15 `19-MA.3`).
 *
 * §5.1 is the requirement: *"Prevent a campaign from becoming Scheduled/Running unless audience resolution,
 * consent policy, template, sender/provider, tracking settings and required content validation pass."* This
 * service is the single answer to that question, and the lifecycle commands call it instead of trusting the
 * stored report — a report an operator pressed an hour ago is not evidence about the campaign as it is now.
 *
 * Two design decisions carry weight:
 *
 *  1. **The gates are per target state.** `schedule` demands that the campaign be *configured* correctly;
 *     `start` additionally demands that the platform be able to *execute* it. That distinction is what lets
 *     MA.3 ship a real lifecycle while §4.1 of the audit records consent (MA.5), audience resolution (MA.4)
 *     and a live provider (MA.7) as prerequisites of an actual send. A blocker here never says "no": it names
 *     the sub-phase that will clear it, so the refusal is honest and self-documenting.
 *  2. **Only a campaign that could send is held to the sending rules.** `Other` is a documented non-email
 *     campaign family (§2.1): an event or a programme has a lifecycle without a message, so refusing to
 *     "start" it would be an invention. Its schedule and classification are still validated.
 *
 * Nothing here reads a recipient, resolves an audience, or touches the network. Reads of the linked audience
 * and content go through `EntityCrudService`, so **the actor's own record ACL decides** whether an audience
 * or template is usable — §9.2's requirement that a campaign author cannot lean on a record they may not read.
 */

@Injectable()
export class MarketingCampaignValidationService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
  ) {}

  async report(
    campaignId: string,
    options: { readonly as?: CampaignStatus | undefined } = {},
  ): Promise<CampaignValidationReport> {
    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    return this.build(campaignId, row.data, options);
  }

  /**
   * Build the report for a stored campaign body. Exposed separately from `report()` so the lifecycle service
   * can validate the row it already loaded inside its transaction, without a second read of the same record.
   */
  async build(
    campaignId: string,
    data: Record<string, unknown>,
    options: { readonly as?: CampaignStatus | undefined } = {},
  ): Promise<CampaignValidationReport> {
    const settings = await this.settings.settings();
    const status = isCampaignStatus(data["status"]) ? data["status"] : "Draft";
    // `as` is the state the operator is asking about; a bare `validate` answers for the next move up.
    const target = options.as ?? nextConfiguredStatus(status);
    const demandsSending = target !== null && requiresExecution(target, data);

    const blockers: CampaignFinding[] = [];
    const warnings: CampaignFinding[] = [];

    const audience = await this.audienceOf(campaignId);
    this.checkClassification(data, blockers, warnings);
    this.checkSchedule(data, blockers);
    this.checkBudget(data, blockers);
    await this.checkAudience(data, audience, blockers);
    await this.checkContent(data, blockers, warnings);
    await this.checkSender(data, settings.sender.defaultEmailAccountId, blockers, warnings);
    this.checkTracking(data, warnings);

    if (demandsSending) {
      // Campaign-level execution gates (§5.1, §13). Audience resolution (MA.4) and the consent gate (MA.5)
      // exist, so what stands between a scheduled campaign and a running one is a **live provider**: the
      // adapter the deployment named in `provider.key` (MA.7), which is disabled unless the platform's own
      // mail transport is configured to deliver. The blocker is raised here rather than failing opaquely at
      // the first send.
      const adapter = this.providers.resolve(settings.provider.key);
      if (adapter.info.mode !== "live") {
        blockers.push(
          blocker(
            "PROVIDER_NOT_BOUND",
            settings.provider.key === ""
              ? "No marketing provider is configured, so nothing may be sent. Set the provider key in Marketing Automation settings (§13)."
              : `The configured provider "${adapter.info.key}" is ${adapter.info.mode}, so nothing may be sent through it (§1.2).`,
          ),
        );
      }
      const sendable = checkCampaignSendable({
        status: target,
        globalSendPaused: settings.safety.globalSendPaused,
      });
      if (!sendable.sendable && sendable.code === "GLOBAL_SEND_PAUSED") {
        blockers.push(blocker("GLOBAL_SEND_PAUSED", sendable.message));
      }
    }

    if (isSendingType(data["type"]) && audience.included.length > 0) {
      // §5.1 lists consent policy among the things that must pass. Per-recipient consent is enforced at the
      // gate (MA.5); what can be checked here is that the campaign has not been pointed at an audience the
      // operator cannot resolve, and that a purpose was chosen deliberately rather than defaulted.
      warnings.push(
        warning(
          "CONSENT_NOT_CONFIGURED",
          "Recipients are only mailed if they hold consent for this purpose at send time (MA.5). A campaign aimed at an audience with no recorded consent will send to nobody — preview the audience before scheduling.",
          "purpose",
        ),
      );
    }

    return {
      campaignId,
      status,
      valid: blockers.length === 0,
      blockers,
      warnings,
      checkedAt: new Date().toISOString(),
      validationHash: this.hash(data, audience),
    };
  }

  /**
   * The facts a schedule/consent decision was made on (§5.5: a material change invalidates a prior
   * approval). Classification, audience, content, sender, policy and timing — and deliberately **not** the
   * name, description or budget, which an editor can fix without changing what would be sent.
   */
  hash(data: Record<string, unknown>, audience: AudienceComposition): string {
    return fingerprint({
      type: text(data["type"]) ?? "",
      purpose: text(data["purpose"]) ?? "",
      serviceNoticeAcknowledged: data["serviceNoticeAcknowledged"] === true,
      timezone: text(data["timezone"]) ?? "",
      startsAt: text(data["startsAt"]) ?? "",
      endsAt: text(data["endsAt"]) ?? "",
      includedTargetLists: audience.included,
      excludedTargetLists: audience.excluded,
      templateId: text(data["templateId"]) ?? "",
      emailAccountId: text(data["emailAccountId"]) ?? "",
      trackingOpen: data["trackingOpen"] ?? null,
      trackingClick: data["trackingClick"] ?? null,
    });
  }

  /**
   * The campaign's audience composition, read structurally. Relation links are not attributes, so the
   * composition has to come from the link table; the caller's permission over each list is checked where it
   * is used, not here, because this read is what makes "a list you cannot see is attached" detectable.
   */
  async audienceOf(campaignId: string): Promise<AudienceComposition> {
    return {
      included: await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "includedTargetLists"),
      excluded: await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "excludedTargetLists"),
    };
  }

  private checkClassification(
    data: Record<string, unknown>,
    blockers: CampaignFinding[],
    warnings: CampaignFinding[],
  ): void {
    if ((text(data["name"]) ?? "") === "") {
      blockers.push(blocker("NAME_REQUIRED", "A campaign needs a name.", "name"));
    }
    const type = isCampaignType(data["type"]) ? data["type"] : undefined;
    if (type === undefined) {
      blockers.push(
        blocker("TYPE_REQUIRED", "A campaign needs a type; the type decides whether it may ever send.", "type"),
      );
    }
    const purpose = isCampaignPurpose(data["purpose"]) ? data["purpose"] : undefined;
    if (purpose === undefined) {
      blockers.push(
        blocker(
          "PURPOSE_REQUIRED",
          "A campaign needs a communication purpose, because consent is gated by purpose and not by content wording (§5.3).",
          "purpose",
        ),
      );
    }
    if (type !== undefined && purpose !== undefined) {
      const mismatch = purposeTypeMismatch(type, purpose);
      if (mismatch !== undefined) blockers.push(blocker("PURPOSE_TYPE_MISMATCH", mismatch, "purpose"));
      // §5.1: the informational label must not be a consent loophole. A mismatch between the two independent
      // fields is surfaced instead of one silently overriding the other.
      if (purpose !== "ServiceNotice" && type === "Informational") {
        warnings.push(
          warning(
            "PURPOSE_TYPE_MISMATCH",
            `This campaign is classified as Informational but carries the ${purpose} purpose, so marketing consent still applies to every recipient (§5.1).`,
            "type",
          ),
        );
      }
    }
    if (purpose !== undefined && serviceNoticeNeedsAcknowledgement(purpose)) {
      if (data["serviceNoticeAcknowledged"] !== true) {
        blockers.push(
          blocker(
            "SERVICE_NOTICE_UNACKNOWLEDGED",
            "Claiming the ServiceNotice purpose exempts this campaign from marketing consent, so it must be acknowledged deliberately and is attributed to whoever acknowledged it (§5.1, §9.3).",
            "serviceNoticeAcknowledged",
          ),
        );
      }
    }
  }

  private checkSchedule(data: Record<string, unknown>, blockers: CampaignFinding[]): void {
    const timezone = text(data["timezone"]);
    // An empty timezone is not a blocker: the deployment default (§13 `defaults.timezone`) is applied when
    // the campaign is scheduled, and §5.1 lists timezone as a field, not a mandatory choice.
    if (timezone !== undefined && !isSupportedTimeZone(timezone)) {
      blockers.push(
        blocker("TIMEZONE_INVALID", `"${timezone}" is not a time zone this runtime understands.`, "timezone"),
      );
    }
    const startsAt = parseDate(data["startsAt"]);
    const endsAt = parseDate(data["endsAt"]);
    if (startsAt !== undefined && endsAt !== undefined && endsAt.getTime() <= startsAt.getTime()) {
      blockers.push(
        blocker("SCHEDULE_ORDER", "A campaign must end after it starts; an inverted window would schedule messages that can never run.", "endsAt"),
      );
    }
  }

  private checkBudget(data: Record<string, unknown>, blockers: CampaignFinding[]): void {
    const amount = data["budgetAmount"];
    if (amount === undefined || amount === null) return;
    const value = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(value) || value < 0) {
      blockers.push(blocker("BUDGET_INVALID", "A campaign budget, when set, must be a non-negative number.", "budgetAmount"));
    }
  }

  private async checkAudience(
    data: Record<string, unknown>,
    audience: AudienceComposition,
    blockers: CampaignFinding[],
  ): Promise<void> {
    if (!isSendingType(data["type"])) return;
    if (audience.included.length === 0) {
      blockers.push(
        blocker(
          "AUDIENCE_REQUIRED",
          "A sending campaign needs an audience: no target list means no recipient to evaluate.",
          "includedTargetLists",
        ),
      );
      return;
    }
    // Each audience must be one *this caller* may read: leaning on a list they cannot see would let a
    // campaign be aimed at records the operator has no visibility of (§9.2).
    for (const id of audience.included) {
      const problem = await this.readable(TARGET_LIST_ENTITY, id);
      if (problem !== undefined) {
        blockers.push(
          blocker("AUDIENCE_NOT_READABLE", `An included audience cannot be used by this user: ${problem}`, "includedTargetLists"),
        );
      }
    }
    for (const id of audience.excluded) {
      const problem = await this.readable(TARGET_LIST_ENTITY, id);
      if (problem !== undefined) {
        blockers.push(
          blocker("AUDIENCE_NOT_READABLE", `An excluded audience cannot be used by this user: ${problem}`, "excludedTargetLists"),
        );
      }
    }
    const shared = audience.included.filter((id) => audience.excluded.includes(id));
    if (shared.length > 0) {
      blockers.push(
        blocker(
          "AUDIENCE_NOT_READABLE",
          "An audience is listed as both included and excluded, which resolves to nobody and hides the mistake.",
          "excludedTargetLists",
        ),
      );
    }
  }

  private async checkContent(
    data: Record<string, unknown>,
    blockers: CampaignFinding[],
    warnings: CampaignFinding[],
  ): Promise<void> {
    if (!isSendingType(data["type"])) return;
    const templateId = text(data["templateId"]);
    if (templateId === undefined) {
      blockers.push(
        blocker("CONTENT_REQUIRED", "A sending campaign needs message content: link an email template.", "templateId"),
      );
      return;
    }
    const error = await this.readable("EmailTemplate", templateId);
    if (error !== undefined) {
      blockers.push(blocker("CONTENT_NOT_READABLE", `The linked template cannot be used by this user: ${error}`, "templateId"));
      return;
    }

    // MA.6 (§15 `19-MA.6` acceptance): what would this content actually render as, and what would it
    // carry? The renderer answers with sanitized facts — what the filter dropped, whether the opt-out
    // links are present, whether a placeholder the allowlist does not provide is named. Recipient
    // personalisation stays out of the report (there is no recipient here), so a missing recipient
    // value is a documented fallback, not a finding; a template *mistake* is.
    const analysis = await this.analyzeContent(data, templateId);
    if (analysis === null) return;
    for (const finding of analysis.findings) {
      const code = RENDER_FINDING_TO_CAMPAIGN_WARNING[finding.code];
      if (code === undefined) continue;
      warnings.push(warning(code, finding.message));
    }
  }

  private async analyzeContent(data: Record<string, unknown>, templateId: string): Promise<ReturnType<MarketingTemplateService["analyzeTemplate"]> | null> {
    let template: Record<string, unknown> | null = null;
    try {
      template = await this.templates.readTemplate(templateId);
    } catch {
      // `readable()` already ran; a race (deleted between the two reads) is not worth a blocker here,
      // and swallowing it as unreadable would contradict the earlier check — null keeps the report
      // limited to the facts taken at read time (AGENTS.md §7: no silently swallowed failures without
      // an explicit reason).
      return null;
    }
    if (template === null) return null;
    return this.templates.analyzeTemplate(template, data);
  }

  private async checkSender(
    data: Record<string, unknown>,
    defaultAccountId: string | null,
    blockers: CampaignFinding[],
    warnings: CampaignFinding[],
  ): Promise<void> {
    if (!isSendingType(data["type"])) return;
    const accountId = text(data["emailAccountId"]);
    if (accountId === undefined) {
      if (defaultAccountId === null) {
        blockers.push(
          blocker(
            "SENDER_REQUIRED",
            "No sending account is set on the campaign and the deployment has no default, so there is no address this could come from (§13).",
            "emailAccountId",
          ),
        );
        return;
      }
      warnings.push(
        warning(
          "SENDER_REQUIRED",
          "The campaign inherits the deployment's default sending account. Name it explicitly before a large send (§13: an author must not exceed global policy by accident).",
          "emailAccountId",
        ),
      );
      return;
    }
    if (!(await this.records.emailAccountExists(accountId))) {
      blockers.push(
        blocker("SENDER_UNKNOWN", `The sending account "${accountId}" does not exist or was removed.`, "emailAccountId"),
      );
    }
  }

  private checkTracking(data: Record<string, unknown>, warnings: CampaignFinding[]): void {
    if (!isSendingType(data["type"])) return;
    if (data["trackingOpen"] === undefined || data["trackingClick"] === undefined) {
      warnings.push(
        warning(
          "TRACKING_NOT_CONFIGURED",
          "Open and click tracking have not been chosen for this campaign. §9.3: tracking is not permitted in every deployment, so leaving it unset is not consent to track.",
          "trackingOpen",
        ),
      );
    }
    if (data["trackingOpen"] === true || data["trackingClick"] === true) {
      warnings.push(
        warning(
          "TRACKING_DISCLOSURE",
          "This campaign tracks engagement. Open tracking is not reliable (privacy proxies) and a notice may be required; MA.6 renders the disclosure and preference link into the content.",
        ),
      );
    }
  }

  /** Can this actor read the linked record? The engine's own ACL answers; nothing is inferred. */
  private async readable(entity: string, id: string): Promise<string | undefined> {
    try {
      await this.entities.get(entity, id);
      return undefined;
    } catch (error) {
      if (error instanceof NotFoundError) return `no ${entity} "${id}" exists.`;
      // Anything else is an access refusal: the engine never says *why*, so a report cannot leak a record
      // the caller may not read (§9.2).
      return "it is not readable by this user.";
    }
  }
}

/** The campaign's audience composition, as relation ids. */
export interface AudienceComposition {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
}

/**
 * The renderer findings a campaign report carries (MA.6), and the CAMPAIGN_FINDING_CODES entry each
 * maps to. The informational `SYSTEM_LINK_INSERTED_AT_SEND` note stays preview-only, and a fallback
 * for a missing recipient value is normal person-data sparsity, not a campaign finding.
 */
const RENDER_FINDING_TO_CAMPAIGN_WARNING: Readonly<Record<string, CampaignFinding["code"]>> = {
  MARKUP_REMOVED: "CONTENT_MARKUP_REMOVED",
  LINK_NOT_ALLOWED: "CONTENT_LINK_INVALID",
  FOOTER_MISSING: "CONTENT_FOOTER_MISSING",
  PLACEHOLDER_UNKNOWN: "CONTENT_PLACEHOLDER_UNKNOWN",
};

/** Types that would put a message on the wire, and therefore carry the sending obligations (§5.1). */
function isSendingType(value: unknown): boolean {
  return isCampaignType(value) && SENDING_CAMPAIGN_TYPES.includes(value);
}

/**
 * Does reaching this target state require the platform to *execute* anything?
 * Only a sending campaign crossing into the live band does; a non-email campaign's `Running` is a
 * programme being underway, and scheduling/validating any campaign is a configuration question.
 */
function requiresExecution(target: CampaignStatus, data: Record<string, unknown>): boolean {
  if (target === "Draft" || target === "Archived") return false;
  if (target === "Scheduled") return false;
  return isSendingType(data["type"]);
}

/** The move an operator is most likely asking about, from the current state. */
function nextConfiguredStatus(status: CampaignStatus): CampaignStatus | null {
  if (status === "Draft") return "Scheduled";
  if (status === "Scheduled") return "Running";
  if (status === "Paused") return "Running";
  return null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
