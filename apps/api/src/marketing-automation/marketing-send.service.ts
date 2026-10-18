import {
  FeatureDisabledError,
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { type AudiencePreview, MarketingAudienceService } from "./marketing-audience.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  allowedSendCommands,
  type AudienceCategoryCount,
  CAMPAIGN_CLOSED_STATUSES,
  CAMPAIGN_ENTITY,
  type CampaignPurpose,
  type CampaignStatus,
  type CampaignValidationReport,
  checkSendTransition,
  DELIVERY_STATE_FOR_CATEGORY,
  fingerprint,
  isCampaignPurpose,
  isCampaignStatus,
  isCampaignType,
  isSendCommand,
  isSendStatus,
  MARKETING_SEND_ENTITY,
  MARKETING_SEND_TRANSITION_ENTITY,
  RECIPIENT_DELIVERY_STATUSES,
  type RecipientDeliveryStatus,
  SEND_SYSTEM_ONLY_COMMANDS,
  type SendApprovalState,
  type SendAudienceForecast,
  sendBlocker,
  type SendCommand,
  sendCommandTarget,
  type SendDryRunReport,
  type SendFinding,
  type SendForecastRecipient,
  SENDING_CAMPAIGN_TYPES,
  type SendStatus,
  sendWarning,
  type TransitionCheck,
} from "./marketing-automation-domain.js";
import { runAsMarketingInternal } from "./marketing-automation-internal.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import { MarketingAutomationRecords, type MarketingRow } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingCampaignValidationService } from "./marketing-campaign-validation.service.js";
import { type DeliverySummary, MarketingDeliveryLedger } from "./marketing-delivery-ledger.js";
import { MarketingTemplateService } from "./marketing-template.service.js";

/**
 * Phase 19-MA.8 — the send definition, its audience snapshot and the dry run
 * (PLAN_Phase_19_Marketing_Automation.md §5.5, §5.6, §6.1, §6.2, §8.2, §8.4, §15 `19-MA.8`).
 *
 * A `MarketingSend` is one message within a campaign, and it is the record of *a decision*: what content
 * (a sealed revision, §6.2), to which frozen audience (an MA.4 snapshot bound by `sendId`), under which
 * validation hash, approved by whom (§5.5). Nothing about it may be inferred from the campaign later,
 * because the campaign keeps being editable — that is the whole reason §5.5 asks for a send definition
 * instead of more campaign fields.
 *
 * Five rules shape the implementation, each one an acceptance criterion of the phase:
 *
 *  1. **The dry run writes nothing.** `dryRun` resolves the audience and reports counts, per-category
 *     reasons and readable samples, and refuses to leave a row behind — an operator asks it as often as
 *     they like, and a preview that mutated state would be a hidden write (§8, AGENTS.md §8).
 *  2. **Validation freezes the decision.** `validate` seals the content revision, freezes a `final`
 *     audience snapshot for this send, materialises one delivery row per resolved recipient, records the
 *     validation hash and clears any previous approval. Re-validating is always safe: the ledger's own
 *     states decide what may be replaced, so a recipient already messaged by MA.9 is never re-derived.
 *  3. **An approval is bound to the facts it was given for.** The material hash covers content, audience
 *     composition, sender, purpose, tracking and provider — everything §5.5 lists — so a change to any of
 *     them makes the approval unusable. The view reports it on read; every command re-checks it before it
 *     acts, and a stale send goes back to `Draft` with the reason recorded, never quietly onward.
 *  4. **No campaign starts from a draft state.** `schedule` and `queue` require the campaign to be
 *     Scheduled or Running (§15 acceptance), `queue` additionally requires a live provider and a lifted
 *     emergency stop, and both need an approval for exactly the facts in hand.
 *  5. **Nothing here sends mail.** The transitions move states, the ledger records intent, the events
 *     announce the decision. Handing recipients to a provider is MA.9's queue, which is why every test in
 *     this phase can exercise the whole lifecycle with the platform's transport in `memory` mode.
 */

export interface SendCounts {
  readonly recipient: number;
  readonly eligible: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly sent: number;
  readonly failed: number;
}

export interface MarketingSendView {
  readonly id: string;
  readonly name: string;
  readonly campaignId: string;
  readonly slot: number;
  readonly status: SendStatus;
  readonly purpose: CampaignPurpose | null;
  readonly providerKey: string | null;
  readonly senderAccountId: string | null;
  readonly templateId: string | null;
  readonly templateRevisionId: string | null;
  readonly contentHash: string | null;
  readonly snapshotId: string | null;
  readonly compositionHash: string | null;
  readonly counts: SendCounts;
  readonly approval: SendApprovalState;
  readonly validation: {
    readonly hash: string | null;
    readonly validatedAt: string | null;
    readonly validatedById: string | null;
    readonly count: number;
    readonly report: SendDryRunReport | null;
  };
  readonly lifecycle: {
    readonly scheduledAt: string | null;
    readonly queuedAt: string | null;
    readonly pausedAt: string | null;
    readonly sentAt: string | null;
    readonly completedAt: string | null;
    readonly cancelledAt: string | null;
    readonly cancelReason: string | null;
    readonly failedAt: string | null;
    readonly failureReason: string | null;
    readonly lastErrorCode: string | null;
    readonly lastErrorAt: string | null;
  };
  readonly deliveries: DeliverySummary;
  readonly allowedCommands: readonly SendCommand[];
  readonly mayEdit: boolean;
  /** True when the stored decision no longer describes the campaign as it now stands (§5.5). */
  readonly stale: boolean;
  readonly createdAt: string | null;
}

export interface SendTransitionResult {
  readonly sendId: string;
  readonly from: SendStatus;
  readonly to: SendStatus;
  readonly command: string;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly transitionId: string | null;
  readonly cancelledDeliveries?: number | undefined;
  readonly blockers?: readonly string[] | undefined;
}

export interface SendRecipientView {
  readonly entityType: string;
  readonly entityId: string;
  readonly name: string | null;
  readonly slot: number;
  readonly state: string;
  readonly category: string | null;
  readonly reasons: readonly string[];
  readonly sentAt: string | null;
}

export interface SendTransitionView {
  readonly id: string;
  readonly sendId: string;
  readonly command: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly validationHash: string | null;
  readonly approvalHash: string | null;
  readonly snapshotId: string | null;
  readonly occurredAt: string | null;
}

export interface SendCreateInput {
  readonly slot?: number | undefined;
  readonly name?: string | undefined;
}

export interface SendCommandInput {
  readonly reason?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly note?: string | undefined;
  readonly version?: number | undefined;
}

/** The states a campaign must be in before a send may be scheduled or queued (§15 acceptance). */
const CAMPAIGN_LIVE_FOR_SEND: readonly CampaignStatus[] = ["Scheduled", "Running"];

/** A send no reconciliation may move: messages are out, done, or already stopped by an operator. */
const SEND_CLOSED_STATUSES: readonly SendStatus[] = ["Sending", "Sent", "Completed", "Cancelled"];

/** The send's own status when it is refused into Draft by a material change. */
const INVALIDATION_CODE = "SEND_APPROVAL_STALE";

type GatePhase = "validate" | "queue";

@Injectable()
export class MarketingSendService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingCampaignValidationService) private readonly campaignValidation: MarketingCampaignValidationService,
    @Inject(MarketingAudienceService) private readonly audience: MarketingAudienceService,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
    @Inject(MarketingDeliveryLedger) private readonly ledger: MarketingDeliveryLedger,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // -------------------------------------------------------------------------
  // Creation and reading
  // -------------------------------------------------------------------------

  /**
   * Define a send for a campaign. A send is created as a `Draft` with nothing decided: no content revision,
   * no snapshot, no approval. Everything that matters is set by `validate`, so a draft can exist while its
   * campaign is still being written — which is exactly when an operator wants to see the dry run.
   */
  async create(campaignId: string, input: SendCreateInput = {}): Promise<MarketingSendView> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");
    const { campaign } = await this.loadCampaign(campaignId, "edit");
    this.assertSendingCampaign(campaign.data);

    const slot = input.slot ?? 1;
    if (!Number.isInteger(slot) || slot < 1 || slot > 100) {
      throw new ValidationError("A send slot is a positive whole number between 1 and 100.", {
        code: "SEND_SLOT_INVALID",
        campaignId,
        slot,
      });
    }
    const existing = await this.records.findByAttr(MARKETING_SEND_ENTITY, "campaignId", campaignId);
    if (existing.some((row) => Number(row.data["slot"] ?? 1) === slot)) {
      throw new ValidationError(
        `Campaign ${campaignId} already has a send in slot ${String(slot)}. A slot is what makes "one delivery record per recipient" enforceable, so it is taken rather than shared.`,
        { code: "SEND_SLOT_TAKEN", campaignId, slot },
      );
    }

    const actor = this.scope.principal;
    const created = await runAsMarketingInternal(() =>
      this.entities.create(MARKETING_SEND_ENTITY, {
        name: input.name?.trim() || `${String(campaign.data["name"] ?? "Campaign")} · send ${String(slot)}`,
        campaignId,
        slot,
        status: "Draft",
        purpose: isCampaignPurpose(campaign.data["purpose"]) ? campaign.data["purpose"] : null,
        recipientCount: 0,
        eligibleCount: 0,
        blockedCount: 0,
        skippedCount: 0,
        sentCount: 0,
        failedCount: 0,
        validationCount: 0,
        assignedUserId: actor?.userId ?? null,
      }),
    );
    return this.get(String(created["id"]));
  }

  /** A campaign's send definitions, newest first, with each one's decision state and ledger totals. */
  async list(campaignId: string): Promise<{ campaignId: string; list: MarketingSendView[] }> {
    const { campaign } = await this.loadCampaign(campaignId, "read");
    const rows = await this.records.findByAttr(MARKETING_SEND_ENTITY, "campaignId", campaignId);
    const sorted = [...rows].sort((left, right) =>
      String(right.data["createdAt"] ?? "").localeCompare(String(left.data["createdAt"] ?? "")),
    );
    const summaries = await this.ledger.summaries(sorted.map((row) => row.id));
    const list: MarketingSendView[] = [];
    for (const row of sorted) {
      const context = await this.contextFor(asSend(row), campaign);
      list.push(this.toView(context, summaries.get(row.id) ?? emptySummary()));
    }
    return { campaignId, list };
  }

  /** One send, with its approval state, ledger totals and the stored dry-run report. */
  async get(sendId: string): Promise<MarketingSendView> {
    const { send, campaign } = await this.loadSend(sendId, "read");
    const context = await this.contextFor(send, campaign);
    return this.toView(context, await this.ledger.summary(sendId));
  }

  /** Why a send moved where it moved, oldest first — the send's own lifecycle evidence. */
  async history(sendId: string): Promise<{ list: SendTransitionView[] }> {
    await this.loadSend(sendId, "read");
    const rows = await this.records.findByAttr(MARKETING_SEND_TRANSITION_ENTITY, "sendId", sendId);
    const list = rows
      .map((row) => toTransitionView(row.id, row.data))
      .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
    return { list };
  }

  /**
   * The §5.5 dry run: resolve the audience, explain every category, and gate the answer with the campaign's
   * own report and the current approval state. Read-only by construction — it seals nothing, snapshots
   * nothing and writes nothing, so it can be run against a draft campaign all day.
   */
  async dryRun(sendId: string): Promise<SendDryRunReport> {
    const { send, campaign } = await this.loadSend(sendId, "read");
    const forecast = await this.forecast(send, campaign.data, "validate");
    return forecast.report;
  }

  // -------------------------------------------------------------------------
  // Validation and approval (§5.5)
  // -------------------------------------------------------------------------

  /**
   * Freeze this send's decision: seal the content revision, freeze a `final` audience snapshot bound to the
   * send, materialise the delivery ledger, record the validation hash and clear any previous approval (an
   * approval belongs to the validation it was given for, never to a later one).
   *
   * All of it happens in one transaction: a half-frozen send — a snapshot without ledger rows, or a hash
   * whose report was never stored — would be evidence of something that did not happen.
   */
  async validate(sendId: string): Promise<MarketingSendView> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");
    const { send, campaign } = await this.loadSend(sendId, "edit");

    const from = this.statusOf(send);
    const check = checkSendTransition({ from, command: "validate" });
    if (!check.allowed) this.refuse(check, sendId, from, "validate");

    const sealed = await this.sealContent(send.campaignId);
    const forecast = await this.forecast(send, campaign.data, "validate", sealed?.contentHash ?? null);
    if (!forecast.report.valid) {
      // The refusal is recorded on the send (so the operator can see it later) and thrown, in that order:
      // a blocked validation must not leave an approval or a snapshot behind, but it should leave an answer.
      await runAsMarketingInternal(() =>
        this.entities.update(MARKETING_SEND_ENTITY, sendId, {
          lastErrorCode: forecast.report.blockers[0]?.code ?? "SEND_VALIDATION_BLOCKED",
          lastErrorAt: new Date().toISOString(),
        }),
      );
      throw new ValidationError(
        `This send cannot be validated yet. ${forecast.report.blockers.map((finding) => finding.message).join(" ")}`,
        { code: "SEND_VALIDATION_BLOCKED", sendId, blockers: forecast.report.blockers },
      );
    }

    const slot = this.slotOf(send);
    const now = new Date();
    const actor = this.scope.principal;

    const outcome = await runInTransaction(this.database.db, async (tx) => {
      const snapshot = await this.audience.snapshot(send.campaignId, { mode: "final", sendId });
      await this.ledger.clearForecast(sendId, slot);
      await this.ledger.materialise({ sendId, slot, snapshotId: snapshot.snapshotId });
      const summary = await this.ledger.summary(sendId);
      const frozen: SendDryRunReport = {
        ...forecast.report,
        audience: {
          ...forecast.report.audience,
          snapshotId: snapshot.snapshotId,
          compositionHash: snapshot.compositionHash,
        },
      };

      await runAsMarketingInternal(() =>
        this.entities.update(MARKETING_SEND_ENTITY, sendId, {
          status: "Validated",
          purpose: isCampaignPurpose(campaign.data["purpose"]) ? campaign.data["purpose"] : null,
          templateId: sealed?.templateId ?? text(campaign.data["templateId"]) ?? null,
          templateRevisionId: sealed?.revisionId ?? null,
          contentHash: sealed?.contentHash ?? null,
          snapshotId: snapshot.snapshotId,
          compositionHash: snapshot.compositionHash,
          senderAccountId: text(campaign.data["emailAccountId"]) ?? null,
          providerKey: settings.provider.key,
          recipientCount: summary.total,
          eligibleCount: summary.eligible,
          blockedCount: summary.blocked,
          skippedCount: summary.skipped,
          validationHash: forecast.report.materialHash,
          validationReport: JSON.stringify(frozen),
          lastValidatedAt: now.toISOString(),
          validatedById: actor?.userId ?? null,
          validationCount: Number(send.data["validationCount"] ?? 0) + 1,
          // A validation replaces the decision the previous approval was given for (§5.5).
          approvedById: null,
          approvedAt: null,
          approvalHash: null,
          approvalNote: null,
          lastErrorCode: null,
          lastErrorAt: null,
        }),
      );

      await this.appendHistory({
        sendId,
        campaignId: send.campaignId,
        command: "validate",
        from,
        to: "Validated",
        reason: null,
        validationHash: forecast.report.materialHash,
        approvalHash: null,
        snapshotId: snapshot.snapshotId,
        idempotencyKey: null,
        occurredAt: now.toISOString(),
      });
      await this.events.dispatch(tx, {
        type: "marketingAutomation.send.validated",
        payload: {
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          campaignId: send.campaignId,
          sendId,
          slot,
          snapshotId: snapshot.snapshotId,
          contentHash: sealed?.contentHash ?? null,
          revisionId: sealed?.revisionId ?? null,
          validationHash: forecast.report.materialHash,
          recipientCount: summary.total,
          eligibleCount: summary.eligible,
          blockedCount: summary.blocked,
          skippedCount: summary.skipped,
          actorUserId: actor?.userId ?? null,
        },
      });
      return summary;
    });

    void outcome;
    return this.get(sendId);
  }

  /**
   * Approve exactly the facts that were validated (§5.5 "send approval metadata"). An approval is a
   * statement by a named person about a specific decision, so it is refused when the decision moved since:
   * the same material-hash comparison every command performs stands between a stale validation and a send.
   */
  async approve(sendId: string, input: SendCommandInput = {}): Promise<MarketingSendView> {
    const { send, campaign } = await this.loadSend(sendId, "edit");
    const status = this.statusOf(send);
    if (status !== "Validated") {
      throw new ValidationError(
        `A send is approved after it has been validated. This send is in status "${status}".`,
        { code: "SEND_APPROVAL_REQUIRES_VALIDATION", sendId, status },
      );
    }
    const forecast = await this.forecast(send, campaign.data, "validate");
    const stored = text(send.data["validationHash"]) ?? null;
    if (stored === null || stored !== forecast.report.materialHash) {
      await this.invalidate(sendId, "approve");
      throw this.staleError(sendId, forecast.report.materialHash, stored);
    }
    const now = new Date();
    const actor = this.scope.principal;
    await runInTransaction(this.database.db, async (tx) => {
      await runAsMarketingInternal(() =>
        this.entities.update(MARKETING_SEND_ENTITY, sendId, {
          approvedById: actor?.userId ?? null,
          approvedAt: now.toISOString(),
          approvalHash: forecast.report.materialHash,
          approvalNote: input.note?.trim() || null,
          lastErrorCode: null,
          lastErrorAt: null,
        }),
      );
      await this.appendHistory({
        sendId,
        campaignId: send.campaignId,
        command: "approve",
        from: status,
        to: status,
        reason: input.note?.trim() || null,
        validationHash: forecast.report.materialHash,
        approvalHash: forecast.report.materialHash,
        snapshotId: text(send.data["snapshotId"]) ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: now.toISOString(),
      });
      await this.events.dispatch(tx, {
        type: "marketingAutomation.send.approved",
        payload: {
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          campaignId: send.campaignId,
          sendId,
          approvalHash: forecast.report.materialHash,
          snapshotId: text(send.data["snapshotId"]) ?? null,
          actorUserId: actor?.userId ?? null,
        },
      });
    });
    return this.get(sendId);
  }

  /**
   * Withdraw an approval, and with it the send's right to move. The send returns to `Draft` because that is
   * the only honest state for "nothing is authorised" — the validation report is kept as history.
   */
  async revokeApproval(sendId: string, input: SendCommandInput = {}): Promise<MarketingSendView> {
    const { send } = await this.loadSend(sendId, "edit");
    const status = this.statusOf(send);
    if (text(send.data["approvalHash"]) === null && text(send.data["validationHash"]) === null) {
      throw new ValidationError("This send has no approval to withdraw.", {
        code: "SEND_APPROVAL_ABSENT",
        sendId,
        status,
      });
    }
    if (input.reason === undefined || input.reason.trim() === "") {
      throw new ValidationError(
        "Withdrawing an approval stops this send, so it needs a reason the audit trail can show later (§10.2).",
        { code: "SEND_REVOKE_REASON_REQUIRED", sendId },
      );
    }
    await runInTransaction(this.database.db, async (tx) => {
      await runAsMarketingInternal(() =>
        this.entities.update(MARKETING_SEND_ENTITY, sendId, {
          status: "Draft",
          approvedById: null,
          approvedAt: null,
          approvalHash: null,
          approvalNote: null,
          lastErrorCode: "SEND_APPROVAL_REVOKED",
          lastErrorAt: new Date().toISOString(),
        }),
      );
      await this.appendHistory({
        sendId,
        campaignId: send.campaignId,
        command: "revokeApproval",
        from: status,
        to: "Draft",
        reason: input.reason?.trim() || null,
        validationHash: text(send.data["validationHash"]) ?? null,
        approvalHash: null,
        snapshotId: text(send.data["snapshotId"]) ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: new Date().toISOString(),
      });
      await this.events.dispatch(tx, {
        type: "marketingAutomation.send.approvalRevoked",
        payload: {
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          campaignId: send.campaignId,
          sendId,
          actorUserId: this.scope.principal?.userId ?? null,
        },
      });
    });
    return this.get(sendId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle commands (§5.5, §8.2)
  // -------------------------------------------------------------------------

  /** Run one named lifecycle command. Nothing here hands a recipient to a provider — that is MA.9. */
  async run(sendId: string, command: SendCommand, request: SendCommandInput = {}): Promise<SendTransitionResult> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");
    if (!isSendCommand(command)) {
      throw new ValidationError(`"${String(command)}" is not a send command.`, {
        code: "SEND_COMMAND_UNKNOWN",
        sendId,
      });
    }
    if (SEND_SYSTEM_ONLY_COMMANDS.includes(command)) {
      throw new ValidationError(
        `"${command}" is produced by the delivery runtime, so no command route runs it (${SEND_SYSTEM_ONLY_COMMANDS.join(", ")}).`,
        { code: "SEND_COMMAND_SYSTEM_ONLY", sendId, command },
      );
    }

    // Anything can have moved since the last read, so the decision is re-checked before it is used. This is
    // the §5.5 requirement made operational: a stale approval is not a warning, it is a refusal.
    const loaded = await this.loadSend(sendId, "edit");
    const reconciled = await this.reconcile(loaded.send);
    const send = reconciled.send;
    const campaign = loaded.campaign;
    const from = this.statusOf(send);

    const idempotencyKey = request.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== "") {
      const prior = (await this.records.findByAttr(MARKETING_SEND_TRANSITION_ENTITY, "idempotencyKey", idempotencyKey, { limit: 5 }))
        .find((candidate) => candidate.data["sendId"] === sendId);
      if (prior !== undefined) {
        return {
          sendId,
          from,
          to: isSendStatus(prior.data["toStatus"]) ? prior.data["toStatus"] : from,
          command,
          changed: false,
          idempotent: true,
          transitionId: prior.id,
        };
      }
    }

    const check = checkSendTransition({ from, command });
    if (!check.allowed) {
      // When the refusal is the invalidation itself, say so: "this send cannot be scheduled" is a worse
      // answer than "what it was approved for changed, validate it again".
      if (reconciled.invalidated) throw this.staleError(sendId, reconciled.materialHash, null);
      this.refuse(check, sendId, from, command);
    }

    const to = sendCommandTarget(command);
    const forecast = command === "schedule" || command === "queue" || command === "resume"
      ? await this.forecast(send, campaign.data, command === "queue" || command === "resume" ? "queue" : "validate")
      : null;

    if (forecast !== null) {
      // `resume`/`queue` are execution gates, `schedule` is a configuration gate (MA.3's distinction, kept).
      // Everything the gate refuses — a live provider, a lifted emergency stop, a campaign that has actually
      // started — is a finding in this report (`findingsFor`), so the refusal and the preview answer the same
      // question with the same code (§7.4, §8.4).
      const report = forecast.report;
      if (!report.valid) {
        await this.recordRefusal(sendId, report.blockers);
        throw new ValidationError(
          `This send cannot be ${pastTense(command)} yet. ${report.blockers.map((finding) => finding.message).join(" ")}`,
          { code: "SEND_BLOCKED", sendId, blockers: report.blockers, warnings: report.warnings },
        );
      }
      this.assertApproval(send, report.materialHash);
    }

    if (command === "cancel" && (request.reason ?? "").trim() === "") {
      throw new ValidationError(
        "Cancelling a send stops its remaining messages, so it needs a reason the audit trail can show later (§10.2).",
        { code: "SEND_CANCEL_REASON_REQUIRED", sendId },
      );
    }

    const now = new Date();
    const actor = this.scope.principal;
    const slot = this.slotOf(send);

    const outcome = await runInTransaction(this.database.db, async (tx) => {
      const cancelledDeliveries = command === "cancel"
        ? await this.ledger.cancelOpen(sendId, slot, "SEND_CANCELLED", now.toISOString())
        : 0;

      // MA.9: on queue or resume, enqueue the delivery batch job. The worker reads from
      // marketing_recipient_deliveries in Sending/Queued state under the send's sendId/slot.
      // We only enqueue if there are Eligible rows already claimed or this send's ledger rows.
      const enqueueResult = { jobId: null as string | null, queued: false };

      await runAsMarketingInternal(() =>
        this.entities.update(MARKETING_SEND_ENTITY, sendId, {
          ...buildPatch(command, now, request.reason?.trim() ?? null),
          ...(request.version !== undefined ? { version: request.version } : {}),
        }),
      );
      const transitionId = await this.appendHistory({
        sendId,
        campaignId: send.campaignId,
        command,
        from,
        to,
        reason: request.reason?.trim() || null,
        validationHash: text(send.data["validationHash"]) ?? null,
        approvalHash: text(send.data["approvalHash"]) ?? null,
        snapshotId: text(send.data["snapshotId"]) ?? null,
        idempotencyKey: idempotencyKey ?? null,
        occurredAt: now.toISOString(),
      });
      await this.events.dispatch(tx, {
        type: SEND_EVENT_BY_COMMAND[command],
        payload: {
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          campaignId: send.campaignId,
          sendId,
          slot,
          from,
          to,
          cancelledDeliveries,
          actorUserId: actor?.userId ?? null,
          ...(idempotencyKey !== undefined ? { correlationId: idempotencyKey } : {}),
          ...enqueueResult,
        },
      });
      return { cancelledDeliveries, transitionId };
    });

    return {
      sendId,
      from,
      to,
      command,
      changed: true,
      idempotent: false,
      transitionId: outcome.transitionId,
      ...(command === "cancel" ? { cancelledDeliveries: outcome.cancelledDeliveries } : {}),
    };
  }

  /**
   * The recipients of a send, as *this* caller may see them (§9.2). Delivery rows carry a record reference,
   * not a name, and each referenced record is loaded through the engine: what the caller cannot read is
   * counted as hidden and never named.
   */
  async recipients(
    sendId: string,
    options: {
      readonly limit?: number;
      readonly offset?: number;
      readonly state?: RecipientDeliveryStatus | undefined;
    } = {},
  ): Promise<{
    sendId: string;
    summary: DeliverySummary;
    total: number;
    hidden: number;
    list: SendRecipientView[];
  }> {
    await this.loadSend(sendId, "read");
    const page = await this.ledger.list(sendId, {
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      ...(options.state !== undefined && isDeliveryState(options.state) ? { state: options.state } : {}),
    });
    const list: SendRecipientView[] = [];
    let hidden = 0;
    for (const record of page.records) {
      let name: string | null = null;
      try {
        const row = await this.entities.get(record.entityType, record.entityId);
        name = typeof row["name"] === "string" ? row["name"] : null;
      } catch {
        hidden += 1;
        continue;
      }
      list.push({
        entityType: record.entityType,
        entityId: record.entityId,
        name,
        slot: record.slot,
        state: record.state,
        category: record.category,
        reasons: record.reasons,
        sentAt: record.sentAt,
      });
    }
    return {
      sendId,
      summary: await this.ledger.summary(sendId),
      total: page.total,
      hidden,
      list,
    };
  }

  // -------------------------------------------------------------------------
  // Internals: loading, access and the material hash
  // -------------------------------------------------------------------------

  private async loadSend(sendId: string, action: "read" | "edit"): Promise<{ send: SendRow; campaign: MarketingRow }> {
    const row = await this.records.byId(MARKETING_SEND_ENTITY, sendId);
    if (row === undefined) throw new NotFoundError(`Send "${sendId}" does not exist.`);
    const send = asSend(row);
    const campaignId = text(send.data["campaignId"]);
    if (campaignId === undefined) throw new NotFoundError(`Send "${sendId}" has no campaign.`);
    const campaign = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (campaign === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    // Access is the campaign's (§9.2): a send definition belongs to its campaign, and a marketer who cannot
    // read the campaign must not learn its audience or its content hash through the send.
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, action, {
      id: campaignId,
      assignedUserId: text(campaign.data["assignedUserId"]),
      createdById: text(campaign.data["createdById"]),
      teams: Array.isArray(campaign.data["teams"]) ? (campaign.data["teams"] as string[]) : [],
      data: campaign.data,
    });
    return { send, campaign };
  }

  private async loadCampaign(campaignId: string, action: "read" | "edit"): Promise<{ campaign: MarketingRow }> {
    const campaign = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (campaign === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, action, {
      id: campaignId,
      assignedUserId: text(campaign.data["assignedUserId"]),
      createdById: text(campaign.data["createdById"]),
      teams: Array.isArray(campaign.data["teams"]) ? (campaign.data["teams"] as string[]) : [],
      data: campaign.data,
    });
    return { campaign };
  }

  private assertSendingCampaign(data: Record<string, unknown>): void {
    const type = isCampaignType(data["type"]) ? data["type"] : undefined;
    if (type === undefined || !SENDING_CAMPAIGN_TYPES.includes(type)) {
      throw new ValidationError(
        "Only an Email, Newsletter or Informational campaign can hold a send definition; the other families are planning records (§5.1).",
        { code: "SEND_CHANNEL_UNSUPPORTED", type: type ?? null },
      );
    }
  }

  /** The audience composition, as relation ids — the cheap half of the material hash. */
  private async composition(campaignId: string): Promise<{ included: string[]; excluded: string[] }> {
    const included = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "includedTargetLists");
    const excluded = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "excludedTargetLists");
    return { included: [...included].sort(), excluded: [...excluded].sort() };
  }

  /**
   * The §5.5 fingerprint: content, audience composition, sender, purpose, tracking and provider. Deliberately
   * not the name, description or budget — an editor may fix those without changing what would be sent, and
   * invalidating an approval for a typo fix would train operators to ignore the warning.
   */
  private materialHash(input: {
    readonly campaignId: string;
    readonly slot: number;
    readonly campaignData: Record<string, unknown>;
    readonly composition: { included: readonly string[]; excluded: readonly string[] };
    readonly contentHash: string | null;
    readonly providerKey: string;
  }): string {
    const data = input.campaignData;
    return fingerprint({
      campaignId: input.campaignId,
      slot: input.slot,
      type: text(data["type"]) ?? "",
      purpose: text(data["purpose"]) ?? "",
      serviceNoticeAcknowledged: data["serviceNoticeAcknowledged"] === true,
      timezone: text(data["timezone"]) ?? "",
      startsAt: text(data["startsAt"]) ?? "",
      endsAt: text(data["endsAt"]) ?? "",
      trackingOpen: data["trackingOpen"] ?? null,
      trackingClick: data["trackingClick"] ?? null,
      templateId: text(data["templateId"]) ?? "",
      senderAccountId: text(data["emailAccountId"]) ?? "",
      providerKey: input.providerKey,
      includedTargetLists: input.composition.included,
      excludedTargetLists: input.composition.excluded,
      contentHash: input.contentHash ?? "",
    });
  }

  /**
   * The current content hash of whatever the campaign's template holds *now*, computed with the pure
   * renderer and the actor's ACL — no sealing, no write. This is what makes "changing content invalidates the
   * approval" checkable on a read.
   */
  private async liveContentHash(campaignData: Record<string, unknown>): Promise<string | null> {
    const templateId = text(campaignData["templateId"]);
    if (templateId === undefined) return null;
    try {
      const template = await this.templates.readTemplate(templateId);
      return this.templates.analyzeTemplate(template, campaignData).templateContentHash;
    } catch {
      // Unreadable or deleted: the content is not what the send was validated against, and `null` says so
      // rather than pretending the previous hash still describes it.
      return null;
    }
  }

  private async sealContent(
    campaignId: string,
  ): Promise<{ revisionId: string; contentHash: string; templateId: string } | null> {
    try {
      const sealed = await this.templates.sealRevision(campaignId);
      return { revisionId: sealed.revisionId, contentHash: sealed.contentHash, templateId: sealed.templateId };
    } catch (error) {
      // No template, or the templates capability is off: both are reported as the send's own blocker with a
      // sentence an operator can act on, rather than as an opaque failure of the content subsystem.
      if (error instanceof FeatureDisabledError || error instanceof ValidationError) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Internals: the forecast and its findings
  // -------------------------------------------------------------------------

  private async contextFor(send: SendRow, campaign: MarketingRow): Promise<SendContext> {
    const composition = await this.composition(send.campaignId);
    const contentHash = await this.liveContentHash(campaign.data);
    const settings = await this.settings.settings();
    const materialHash = this.materialHash({
      campaignId: send.campaignId,
      slot: this.slotOf(send),
      campaignData: campaign.data,
      composition,
      contentHash,
      providerKey: settings.provider.key,
    });
    const validationHash = text(send.data["validationHash"]) ?? null;
    const approvalHash = text(send.data["approvalHash"]) ?? null;
    const decision = await this.acl.canAccessRecord(CAMPAIGN_ENTITY, "edit", {
      id: campaign.id,
      assignedUserId: text(campaign.data["assignedUserId"]),
      createdById: text(campaign.data["createdById"]),
      teams: Array.isArray(campaign.data["teams"]) ? (campaign.data["teams"] as string[]) : [],
      data: campaign.data,
    });
    // Staleness is a decision that stopped being true. A send nobody has validated yet is not stale — it is
    // simply undecided — so the comparison only starts once a validation exists.
    const stale =
      validationHash !== null &&
      (materialHash !== validationHash || (approvalHash !== null && approvalHash !== materialHash));
    return {
      send,
      campaign,
      composition,
      materialHash,
      validationHash,
      approvalHash,
      stale,
      mayEdit: decision.allowed === true,
    };
  }

  /** Build the report a dry run or a command gate reads. Writes nothing. */
  private async forecast(
    send: SendRow,
    campaignData: Record<string, unknown>,
    phase: GatePhase,
    sealedContentHash?: string | null,
  ): Promise<{ report: SendDryRunReport; preview: AudiencePreview }> {
    const settings = await this.settings.settings();
    const composition = await this.composition(send.campaignId);
    const contentHash = sealedContentHash !== undefined && sealedContentHash !== null
      ? sealedContentHash
      : await this.liveContentHash(campaignData);
    const preview = await this.audience.previewCampaign(send.campaignId);
    const campaignReport = await this.campaignValidation.build(send.campaignId, campaignData, { as: "Scheduled" });
    const materialHash = this.materialHash({
      campaignId: send.campaignId,
      slot: this.slotOf(send),
      campaignData,
      composition,
      contentHash,
      providerKey: settings.provider.key,
    });
    const approvalHash = text(send.data["approvalHash"]) ?? null;

    const categories = preview.categories.map<AudienceCategoryCount>((entry) => ({
      category: entry.category,
      count: entry.count,
      reasons: entry.reasons,
    }));
    const stateCount = (state: string) =>
      categories
        .filter((entry) => DELIVERY_STATE_FOR_CATEGORY[entry.category] === state)
        .reduce((total, entry) => total + entry.count, 0);
    const audienceForecast: SendAudienceForecast = {
      snapshotId: text(send.data["snapshotId"]) ?? null,
      compositionHash: preview.compositionHash,
      resolved: preview.resolved,
      eligible: preview.eligible,
      blocked: stateCount("Blocked"),
      skipped: stateCount("Skipped"),
      categories,
      sample: preview.samples.map<SendForecastRecipient>((sample) => ({
        entityType: sample.entityType,
        entityId: sample.entityId,
        name: sample.name,
        category: sample.category,
        reasons: sample.reasons,
      })),
      truncated: preview.truncated,
      limit: preview.limit,
      notes: preview.notes,
    };

    const findings = this.findingsFor({
      campaignData,
      campaignReport,
      preview,
      phase,
      providerLive: this.providers.resolve(settings.provider.key).info.mode === "live",
      globalSendPaused: settings.safety.globalSendPaused,
      contentSealed: contentHash !== null && contentHash !== "",
      audienceRequired: composition.included.length > 0,
    });

    return {
      report: {
        sendId: send.id,
        campaignId: send.campaignId,
        slot: this.slotOf(send),
        status: this.statusOf(send),
        valid: findings.blockers.length === 0,
        blockers: findings.blockers,
        warnings: findings.warnings,
        campaign: campaignReport,
        audience: audienceForecast,
        approval: {
          approvedById: text(send.data["approvedById"]) ?? null,
          approvedAt: text(send.data["approvedAt"]) ?? null,
          approvalHash,
          current: approvalHash !== null && approvalHash === materialHash,
          note: text(send.data["approvalNote"]) ?? null,
        },
        materialHash,
        checkedAt: new Date().toISOString(),
      },
      preview,
    };
  }

  /**
   * The send's own findings, on top of the campaign report it inherits (§5.1, §5.5, §8.4).
   *
   * `phase` is what makes one report answer two different questions honestly: `validate` asks "is this
   * decision well-formed?" and treats a missing provider or a campaign that has not started as warnings — an
   * operator may validate and approve a send before the campaign is scheduled. `queue` asks "may this go
   * out?" and is where those same facts become refusals.
   */
  private findingsFor(input: {
    readonly campaignData: Record<string, unknown>;
    readonly campaignReport: CampaignValidationReport;
    readonly preview: { resolved: number; eligible: number; truncated: boolean };
    readonly phase: GatePhase;
    readonly providerLive: boolean;
    readonly globalSendPaused: boolean;
    readonly contentSealed: boolean;
    readonly audienceRequired: boolean;
  }): { blockers: SendFinding[]; warnings: SendFinding[] } {
    const blockers: SendFinding[] = [];
    const warnings: SendFinding[] = [];
    const data = input.campaignData;

    const campaignStatus = isCampaignStatus(data["status"]) ? data["status"] : "Draft";
    const type = isCampaignType(data["type"]) ? data["type"] : undefined;
    const purpose = isCampaignPurpose(data["purpose"]) ? data["purpose"] : null;

    if (CAMPAIGN_CLOSED_STATUSES.includes(campaignStatus)) {
      blockers.push(
        sendBlocker(
          "SEND_CAMPAIGN_CLOSED",
          `Campaign ${String(data["name"] ?? "")} is ${campaignStatus}; a closed campaign cannot hold a live send (§5.1).`,
        ),
      );
    }
    if (type === undefined || !SENDING_CAMPAIGN_TYPES.includes(type)) {
      blockers.push(
        sendBlocker(
          "SEND_CHANNEL_UNSUPPORTED",
          "This campaign's type does not send messages, so it has no send definition to validate (§5.1).",
          "type",
        ),
      );
    }
    if (!input.campaignReport.valid) {
      blockers.push(
        sendBlocker(
          "SEND_CAMPAIGN_INVALID",
          `The campaign itself does not pass its own send-readiness checks: ${input.campaignReport.blockers.map((finding) => finding.message).join(" ")}`,
        ),
      );
    }
    if (!input.audienceRequired || input.preview.resolved === 0) {
      blockers.push(
        sendBlocker(
          "SEND_AUDIENCE_EMPTY",
          input.audienceRequired
            ? "The campaign's audience resolves to nobody, so there is no recipient to send to (§5.2)."
            : "A send needs an audience: attach at least one target list to the campaign (§5.2).",
          "includedTargetLists",
        ),
      );
    } else if (input.preview.eligible === 0) {
      blockers.push(
        sendBlocker(
          "SEND_NO_ELIGIBLE_RECIPIENTS",
          "Every resolved recipient is excluded or blocked; a send with no eligible recipient must not be authorised (§5.5).",
        ),
      );
    }
    if (!input.contentSealed) {
      blockers.push(
        sendBlocker(
          "SEND_CONTENT_UNSEALED",
          "The content this send would use cannot be sealed into an immutable revision. Link an email template the send may read, and enable the templates capability (§6.2).",
          "templateId",
        ),
      );
    }
    if (input.preview.truncated) {
      warnings.push(
        sendWarning(
          "SEND_AUDIENCE_TRUNCATED",
          "The audience hit the resolution ceiling, so this forecast is partial — raise limits.maxResolveRecords or narrow the audience before a real send.",
        ),
      );
    }
    if (purpose !== null && input.preview.eligible === input.preview.resolved && input.preview.resolved > 0) {
      warnings.push(
        sendWarning(
          "SEND_CONSENT_POLICY",
          "No recipient was filtered by consent. If this deployment holds no consent records for this purpose, the gate has nothing to check — review the consent state before sending (§5.3).",
          "purpose",
        ),
      );
    }

    if (!input.providerLive) {
      const message =
        "No live marketing provider is configured, so this send cannot be handed to a provider. Set provider.key once an adapter is configured (§5.8).";
      if (input.phase === "queue") blockers.push(sendBlocker("SEND_PROVIDER_NOT_LIVE", message));
      else warnings.push(sendWarning("SEND_PROVIDER_NOT_LIVE", message));
    }
    if (input.globalSendPaused) {
      const message = "Marketing sending is stopped globally by an operator; no message may be queued or sent (§13).";
      if (input.phase === "queue") blockers.push(sendBlocker("SEND_GLOBAL_SEND_PAUSED", message));
      else warnings.push(sendWarning("SEND_GLOBAL_SEND_PAUSED", message));
    }
    if (!CAMPAIGN_LIVE_FOR_SEND.includes(campaignStatus)) {
      const message = `Campaign ${String(data["name"] ?? "")} is ${campaignStatus}: a send may be validated and approved, but it is only queued while its campaign is Scheduled or Running (§15).`;
      if (input.phase === "queue") blockers.push(sendBlocker("SEND_CAMPAIGN_NOT_LIVE", message));
      else warnings.push(sendWarning("SEND_CAMPAIGN_NOT_LIVE", message));
    }
    return { blockers, warnings };
  }

  /** Refuse a command whose approval is not for the facts in hand, and normalise the send back to Draft. */
  private assertApproval(send: SendRow, materialHash: string): void {
    const validationHash = text(send.data["validationHash"]) ?? null;
    const approvalHash = text(send.data["approvalHash"]) ?? null;
    if (validationHash !== materialHash) throw this.staleError(send.id, materialHash, validationHash);
    if (approvalHash === null) {
      throw new ValidationError(
        "This send has not been approved. A validation describes what would happen; an approval is the named person who accepts it (§5.5).",
        { code: "SEND_APPROVAL_REQUIRED", sendId: send.id, status: this.statusOf(send) },
      );
    }
    if (approvalHash !== materialHash) throw this.staleError(send.id, materialHash, approvalHash);
  }

  private staleError(sendId: string, materialHash: string, storedHash: string | null): ValidationError {
    return new ValidationError(
      "The content, audience, sender or purpose this send was approved for has changed, so the approval no longer applies. Validate and approve it again (§5.5).",
      { code: INVALIDATION_CODE, sendId, materialHash, storedHash },
    );
  }

  private refuse(check: TransitionCheck, sendId: string, from: SendStatus, command: string): never {
    throw new ValidationError(check.message ?? "Invalid send transition.", {
      code: check.code ?? "SEND_TRANSITION_NOT_ALLOWED",
      sendId,
      from,
      command,
    });
  }

  private async recordRefusal(sendId: string, blockers: readonly SendFinding[]): Promise<void> {
    await runAsMarketingInternal(() =>
      this.entities.update(MARKETING_SEND_ENTITY, sendId, {
        lastErrorCode: blockers[0]?.code ?? "SEND_BLOCKED",
        lastErrorAt: new Date().toISOString(),
      }),
    );
  }

  /**
   * Bring the stored decision back in line with the campaign as it stands, if a material change happened
   * while nobody was looking (§5.5). Only pre-send sends are moved: a send that is already sending has
   * messages on the wire, and rewriting its meaning underneath the worker is the ambiguity the snapshot
   * exists to prevent — MA.9 pauses those instead.
   */
  private async reconcile(send: SendRow): Promise<{ send: SendRow; invalidated: boolean; materialHash: string }> {
    const context = await this.contextFor(send, (await this.loadCampaign(send.campaignId, "read")).campaign);
    const status = this.statusOf(send);
    // Nothing to reconcile before a first validation, and nothing to move once messages are on the wire —
    // MA.9 pauses those instead of rewriting what a running send means.
    if (context.validationHash === null || !context.stale || SEND_CLOSED_STATUSES.includes(status)) {
      return { send, invalidated: false, materialHash: context.materialHash };
    }
    const reloaded = await this.invalidate(send.id, "materialChange");
    return { send: reloaded ?? send, invalidated: true, materialHash: context.materialHash };
  }

  /** Record that the decision no longer holds: back to Draft, approval cleared, reason kept (§5.5). */
  private async invalidate(sendId: string, cause: string): Promise<SendRow | undefined> {
    const row = await this.records.byId(MARKETING_SEND_ENTITY, sendId);
    if (row === undefined) return undefined;
    const before = asSend(row);
    const from = this.statusOf(before);
    const now = new Date();
    const patch: Record<string, unknown> = {
      approvedById: null,
      approvedAt: null,
      approvalHash: null,
      approvalNote: null,
      lastErrorCode: INVALIDATION_CODE,
      lastErrorAt: now.toISOString(),
    };
    // Draft is reachable from every pre-send state by design, so this is a legal edge rather than a special
    // case: a send with no valid approval has nowhere else honest to stand.
    if (from !== "Draft") patch["status"] = "Draft";
    await runInTransaction(this.database.db, async (tx) => {
      await runAsMarketingInternal(() => this.entities.update(MARKETING_SEND_ENTITY, sendId, patch));
      await this.appendHistory({
        sendId,
        campaignId: before.campaignId,
        command: "invalidate",
        from,
        to: "Draft",
        reason: `A material change (${cause}) invalidated the approval this send was authorised by.`,
        validationHash: text(before.data["validationHash"]) ?? null,
        approvalHash: null,
        snapshotId: text(before.data["snapshotId"]) ?? null,
        idempotencyKey: null,
        occurredAt: now.toISOString(),
      });
      await this.events.dispatch(tx, {
        type: "marketingAutomation.send.approvalInvalidated",
        payload: {
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          campaignId: before.campaignId,
          sendId,
          from,
          to: "Draft",
          cause,
          actorUserId: this.scope.principal?.userId ?? null,
        },
      });
    });
    const after = await this.records.byId(MARKETING_SEND_ENTITY, sendId);
    return after === undefined ? undefined : asSend(after);
  }

  private async appendHistory(input: {
    readonly sendId: string;
    readonly campaignId: string;
    readonly command: string;
    readonly from: SendStatus;
    readonly to: SendStatus;
    readonly reason: string | null;
    readonly validationHash: string | null;
    readonly approvalHash: string | null;
    readonly snapshotId: string | null;
    readonly idempotencyKey: string | null;
    readonly occurredAt: string;
  }): Promise<string> {
    const actor = this.scope.principal;
    const created = await runAsMarketingSystem(this.scope, "sendTransitionHistory", () =>
      this.entities.create(MARKETING_SEND_TRANSITION_ENTITY, {
        name: `${input.command} ${input.from} → ${input.to}`,
        sendId: input.sendId,
        campaignId: input.campaignId,
        snapshotId: input.snapshotId,
        fromStatus: input.from,
        toStatus: input.to,
        command: input.command,
        reason: input.reason,
        actorUserId: actor?.userId ?? null,
        actorType: actor?.userType ?? "system",
        validationHash: input.validationHash,
        approvalHash: input.approvalHash,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    return String(created["id"]);
  }

  private toView(context: SendContext, deliveries: DeliverySummary): MarketingSendView {
    const send = context.send;
    const report = parseReport(send.data["validationReport"]);
    return {
      id: send.id,
      name: String(send.data["name"] ?? ""),
      campaignId: send.campaignId,
      slot: this.slotOf(send),
      status: this.statusOf(send),
      purpose: isCampaignPurpose(send.data["purpose"]) ? send.data["purpose"] : null,
      providerKey: text(send.data["providerKey"]) ?? null,
      senderAccountId: text(send.data["senderAccountId"]) ?? null,
      templateId: text(send.data["templateId"]) ?? null,
      templateRevisionId: text(send.data["templateRevisionId"]) ?? null,
      contentHash: text(send.data["contentHash"]) ?? null,
      snapshotId: text(send.data["snapshotId"]) ?? null,
      compositionHash: text(send.data["compositionHash"]) ?? null,
      counts: {
        recipient: Number(send.data["recipientCount"] ?? 0),
        eligible: Number(send.data["eligibleCount"] ?? 0),
        blocked: Number(send.data["blockedCount"] ?? 0),
        skipped: Number(send.data["skippedCount"] ?? 0),
        sent: Number(send.data["sentCount"] ?? 0),
        failed: Number(send.data["failedCount"] ?? 0),
      },
      approval: {
        approvedById: text(send.data["approvedById"]) ?? null,
        approvedAt: text(send.data["approvedAt"]) ?? null,
        approvalHash: context.approvalHash,
        current: context.approvalHash !== null && context.approvalHash === context.materialHash,
        note: text(send.data["approvalNote"]) ?? null,
      },
      validation: {
        hash: context.validationHash,
        validatedAt: text(send.data["lastValidatedAt"]) ?? null,
        validatedById: text(send.data["validatedById"]) ?? null,
        count: Number(send.data["validationCount"] ?? 0),
        report,
      },
      lifecycle: {
        scheduledAt: text(send.data["scheduledAt"]) ?? null,
        queuedAt: text(send.data["queuedAt"]) ?? null,
        pausedAt: text(send.data["pausedAt"]) ?? null,
        sentAt: text(send.data["sentAt"]) ?? null,
        completedAt: text(send.data["completedAt"]) ?? null,
        cancelledAt: text(send.data["cancelledAt"]) ?? null,
        cancelReason: text(send.data["cancelReason"]) ?? null,
        failedAt: text(send.data["failedAt"]) ?? null,
        failureReason: text(send.data["failureReason"]) ?? null,
        lastErrorCode: text(send.data["lastErrorCode"]) ?? null,
        lastErrorAt: text(send.data["lastErrorAt"]) ?? null,
      },
      deliveries,
      // What the SPA renders is only what this actor may run (§9.2): a reader sees the state machine and
      // none of its buttons, exactly as `MarketingCampaignService.capabilities` does.
      allowedCommands: context.mayEdit ? allowedSendCommands(this.statusOf(send)) : [],
      mayEdit: context.mayEdit,
      stale: context.stale,
      createdAt: text(send.data["createdAt"]) ?? null,
    };
  }

  private statusOf(send: MarketingRow): SendStatus {
    return isSendStatus(send.data["status"]) ? send.data["status"] : "Draft";
  }

  private slotOf(send: MarketingRow): number {
    // `slot` is the §5.6 identity of the send within its campaign; the default keeps a legacy row readable.
    const slot = Number(send.data["slot"] ?? 1);
    return Number.isInteger(slot) && slot > 0 ? slot : 1;
  }
}

/** A loaded `MarketingSend` row plus the campaign id it belongs to. */
interface SendRow extends MarketingRow {
  readonly campaignId: string;
}

interface SendContext {
  readonly send: SendRow;
  readonly campaign: MarketingRow;
  readonly composition: { included: string[]; excluded: string[] };
  readonly materialHash: string;
  readonly validationHash: string | null;
  readonly approvalHash: string | null;
  readonly stale: boolean;
  /** May this actor edit the campaign the send belongs to — the SPA hides what it cannot do (§9.2). */
  readonly mayEdit: boolean;
}

function emptySummary(): DeliverySummary {
  return { total: 0, eligible: 0, blocked: 0, skipped: 0, sent: 0, failed: 0, byState: [] };
}

// One entry per command, so the event a transition announces cannot be missing for a command that exists.
const SEND_EVENT_BY_COMMAND: Readonly<Record<SendCommand, string>> = {
  validate: "marketingAutomation.send.validated",
  schedule: "marketingAutomation.send.scheduled",
  queue: "marketingAutomation.send.queued",
  pause: "marketingAutomation.send.paused",
  resume: "marketingAutomation.send.resumed",
  cancel: "marketingAutomation.send.cancelled",
  complete: "marketingAutomation.send.completed",
  fail: "marketingAutomation.send.failed",
};

function buildPatch(command: SendCommand, now: Date, reason: string | null): Record<string, unknown> {
  const at = now.toISOString();
  const patch: Record<string, unknown> = { status: sendCommandTarget(command) };
  switch (command) {
    case "schedule":
      patch["scheduledAt"] = at;
      break;
    case "queue":
      patch["queuedAt"] = at;
      break;
    case "pause":
      patch["pausedAt"] = at;
      break;
    case "resume":
      patch["queuedAt"] = at;
      break;
    case "cancel":
      patch["cancelledAt"] = at;
      patch["cancelReason"] = reason;
      break;
    case "complete":
      patch["completedAt"] = at;
      break;
    case "fail":
      patch["failedAt"] = at;
      patch["failureReason"] = reason;
      break;
    case "validate":
      // `validate` is its own method with its own patch; reaching here would mean a command that forgot it.
      break;
  }
  return patch;
}

function pastTense(command: SendCommand): string {
  switch (command) {
    case "schedule":
      return "scheduled";
    case "queue":
      return "queued";
    case "resume":
      return "resumed";
    default:
      return command;
  }
}

function toTransitionView(id: string, data: Record<string, unknown>): SendTransitionView {
  return {
    id,
    sendId: text(data["sendId"]) ?? "",
    command: text(data["command"]) ?? "",
    fromStatus: text(data["fromStatus"]) ?? "",
    toStatus: text(data["toStatus"]) ?? "",
    reason: text(data["reason"]) ?? null,
    actorUserId: text(data["actorUserId"]) ?? null,
    actorType: text(data["actorType"]) ?? "user",
    validationHash: text(data["validationHash"]) ?? null,
    approvalHash: text(data["approvalHash"]) ?? null,
    snapshotId: text(data["snapshotId"]) ?? null,
    occurredAt: text(data["occurredAt"]) ?? null,
  };
}

function parseReport(value: unknown): SendDryRunReport | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value) as SendDryRunReport;
  } catch {
    return null;
  }
}

/** The ledger's own state vocabulary, so a query string cannot ask for a state that does not exist. */
function isDeliveryState(value: string): value is RecipientDeliveryStatus {
  return (RECIPIENT_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * A send row with its campaign id resolved once, so no command has to reach into `data` for the id it was
 * loaded by — and so a row whose campaign link is missing fails loudly instead of quietly sending nowhere.
 */
function asSend(row: MarketingRow): SendRow {
  return { ...row, campaignId: String(row.data["campaignId"] ?? "") };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
