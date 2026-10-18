import { RateLimitError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable, Logger } from "@nestjs/common";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  CAMPAIGN_ENTITY,
  type CampaignPurpose,
  type CampaignStatus,
  checkCampaignSendable,
  isCampaignPurpose,
  isCampaignStatus,
  MARKETING_SEND_ENTITY,
  normalizeEmailAddress,
} from "./marketing-automation-domain.js";
import { runAsMarketingInternal } from "./marketing-automation-internal.js";
import {
  MarketingProviderError,
  type MarketingProviderMessage,
  MarketingProviderRegistry,
} from "./marketing-automation-provider.js";
import { MarketingAutomationRecords, type MarketingRow } from "./marketing-automation-records.js";
import {
  type MarketingAutomationSettings,
  MarketingAutomationSettingsService,
} from "./marketing-automation-settings.service.js";
import { type DeliveryRecord, MarketingDeliveryLedger } from "./marketing-delivery-ledger.js";
import { MarketingEligibilityService } from "./marketing-eligibility.service.js";
import { MarketingProviderLimiter } from "./marketing-provider-limiter.js";
import { MarketingPublicTokenService } from "./marketing-public-token.service.js";
import { MarketingSendService } from "./marketing-send.service.js";
import { type DeliveryContentRender, MarketingTemplateService } from "./marketing-template.service.js";
import { PREVIEW_SYSTEM_LINK_SENTINELS } from "./marketing-template-render.js";

/**
 * Phase 19-MA.9 — the queue-based delivery runtime
 * (PLAN_Phase_19_Marketing_Automation.md §5.7, §5.8, §11, §15 `19-MA.9`).
 *
 * This is the one place a campaign message is handed to a provider. `MarketingSendService` decides *what*
 * may be sent (validation, approval, transitions), `MarketingDeliveryLedger` owns the per-recipient state
 * machine, and this service drives it:
 *
 *  1. **Bounded chunks** (§11.2): one batch claims at most `delivery.chunkSize` rows per send through the
 *     ledger's `FOR UPDATE SKIP LOCKED` claim, so a 50,000-recipient send never becomes one job or one
 *     transaction (tasks 1–2).
 *  2. **A final gate immediately before submission** (§5.8, §0.1 rule 8): consent, suppression, address and
 *     the frequency cap are re-evaluated per recipient *at claim time* — the snapshot's category is a
 *     forecast, never the permission. The emergency stop and the campaign state are re-checked too, so an
 *     operator who paused between queue and delivery still wins (tasks 3, 6).
 *  3. **One submission path** (`submit`): the limiter, the adapter and the classified outcome are shared
 *     with the journey email action, so no caller can reach a provider without the same ceilings (task 4).
 *  4. **Classified outcomes, bounded retries** (§5.8, §7.4): a transient failure walks the machine's own
 *     `Sending → Failed → Queued` edge until `delivery.maxAttempts` is spent and then becomes a dead
 *     letter an operator can read; a permanent one is final at once; a submission whose fate is unknown
 *     stays `Sending` with `SUBMISSION_UNKNOWN` rather than being blindly mailed twice (task 5).
 *  5. **Recovery** (§11.2): stale claims from a crashed worker are expired and re-queued under the same
 *     idempotency key before a chunk is claimed, and every statement is a bounded, guarded update so two
 *     workers racing the same send change nothing twice (task 6).
 *
 * The whole run executes under the documented service identity (§9.2) — the worker process has no human
 * session, and a delivery write must be attributed to `system`, not to a stale token (task 7: the result
 * and the structured log are the §11.3 metrics; neither ever carries a body, an address or a token).
 */

export interface DeliveryBatchInput {
  /** A specific send to run; omitted means the sweep: every `Queued`/`Sending` send with open rows. */
  readonly sendId?: string | undefined;
  /** Optional slot for a named send; the send's own slot is used when omitted. */
  readonly slot?: number | undefined;
  /** Cap on this run's claim size; the deployment's `delivery.chunkSize` is the ceiling. */
  readonly limit?: number | undefined;
}

export interface SendBatchOutcome {
  readonly sendId: string;
  readonly slot: number;
  readonly statusFrom: string;
  readonly statusTo: string;
  readonly claimed: number;
  readonly sent: number;
  readonly blocked: number;
  readonly failed: number;
  readonly retried: number;
  readonly released: number;
  readonly recovered: { readonly expired: number; readonly requeued: number; readonly exhausted: number };
  /** Why this send stopped mid-batch (emergency stop, throttle, provider verification), or null. */
  readonly stopped: string | null;
  readonly error?: string | undefined;
}

export interface DeliveryBatchResult {
  readonly ranAt: string;
  readonly paused: boolean;
  readonly sends: readonly SendBatchOutcome[];
  readonly skipped: readonly { readonly sendId: string; readonly reason: string }[];
  readonly totals: {
    readonly sends: number;
    readonly claimed: number;
    readonly sent: number;
    readonly blocked: number;
    readonly failed: number;
    readonly retried: number;
    readonly released: number;
  };
}

/** What `submit` needs to build, gate and hand one message to the provider. */
export interface MarketingSubmissionInput {
  readonly recipient: {
    readonly entityType: string;
    readonly entityId: string;
    readonly emailAddress: string;
    readonly emailHash: string | null;
    /** False when the caller could not read the person record — never a silent skip (§9.2). */
    readonly readable?: boolean | undefined;
  };
  readonly purpose: CampaignPurpose;
  readonly campaignStatus: CampaignStatus;
  readonly campaignId?: string | null | undefined;
  /** List-scoped suppression, when the recipient was named by a specific audience. */
  readonly targetListId?: string | undefined;
  readonly consentRequired?: boolean | undefined;
  readonly content: {
    readonly subject: string;
    readonly plainText: string | null;
    readonly bodyHtml: string | null;
    /** Which system link placeholders the content uses; only those get a token minted for this person. */
    readonly systemLinks: readonly string[];
    readonly contentHash: string | null;
  };
  readonly senderAccountId?: string | null | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Stable per-recipient key (§0.1 rule 10): a retry must submit the *same* key, never a new one. */
  readonly idempotencyKey: string;
}

export type MarketingSubmissionOutcome =
  | { readonly status: "sent"; readonly providerMessageId: string | null; readonly contentHash: string | null }
  | { readonly status: "blocked"; readonly code: string; readonly reasons: readonly string[] }
  | { readonly status: "throttled" }
  /** The §13 emergency stop landed between claim and submission: nothing was sent, nothing is terminal. */
  | { readonly status: "paused" }
  | {
      readonly status: "failed";
      readonly kind: "retryable" | "permanent" | "unknown_submission";
      readonly reasonCode: string;
    };

/** Ledger states that still hold work: while any exists the send is not finished (§6.5). */
const OPEN_DELIVERY_STATES: readonly string[] = ["Pending", "Eligible", "Queued", "Sending"];

/** §5.8: repeated authentication failures pause the send instead of burning every recipient's budget. */
const AUTH_FAILURE_REASON_CODES: ReadonlySet<string> = new Set(["AUTH_FAILED", "PROVIDER_NOT_CONFIGURED"]);

@Injectable()
export class MarketingDeliveryBatchService {
  private readonly logger = new Logger(MarketingDeliveryBatchService.name);

  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
    @Inject(MarketingProviderLimiter) private readonly limiter: MarketingProviderLimiter,
    @Inject(MarketingEligibilityService) private readonly eligibility: MarketingEligibilityService,
    @Inject(MarketingDeliveryLedger) private readonly ledger: MarketingDeliveryLedger,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
    @Inject(MarketingPublicTokenService) private readonly links: MarketingPublicTokenService,
    @Inject(MarketingSendService) private readonly sends: MarketingSendService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Run one delivery batch (MA.9). With `sendId` the named send is driven; without it the sweep claims
   * open work from every `Queued`/`Sending` send — the cron recovery path when the enqueue-time job was
   * lost to a restart or a queue outage (§11.2).
   */
  async run(input: DeliveryBatchInput = {}): Promise<DeliveryBatchResult> {
    return runAsMarketingSystem(this.scope, "deliveryBatch", () => this.execute(input));
  }

  private async execute(input: DeliveryBatchInput): Promise<DeliveryBatchResult> {
    const ranAt = new Date().toISOString();
    const settings = await this.settings.settings();
    const emptyTotals = { sends: 0, claimed: 0, sent: 0, blocked: 0, failed: 0, retried: 0, released: 0 };

    if (!settings.features.campaigns) {
      return { ranAt, paused: false, sends: [], skipped: [], totals: emptyTotals };
    }
    // §13: the emergency stop is checked before a single row is claimed — a paused deployment must not
    // even *begin* work, and the sweep reports why so an operator sees the stop instead of a silent no-op.
    if (settings.safety.globalSendPaused) {
      this.logger.warn(
        { job: "marketing.deliveryBatch", reason: "GLOBAL_SEND_PAUSED" },
        "delivery sweep refused: global send pause is active",
      );
      return { ranAt, paused: true, sends: [], skipped: [], totals: emptyTotals };
    }

    const targets = await this.discover(input);
    if (targets.length === 0) {
      return { ranAt, paused: false, sends: [], skipped: [], totals: emptyTotals };
    }

    // One verification per run (§15 `19-MA.7`): bad credentials are reported *before* any recipient is
    // claimed, so a broken provider never burns attempts or leaves rows in `Sending`.
    const adapter = this.providers.resolve(settings.provider.key);
    if (adapter.info.mode !== "live") {
      return {
        ranAt,
        paused: false,
        sends: [],
        skipped: targets.map((target) => ({ sendId: target.id, reason: "PROVIDER_NOT_BOUND" })),
        totals: emptyTotals,
      };
    }
    try {
      await adapter.verify();
    } catch (error) {
      const reason = error instanceof MarketingProviderError ? error.reasonCode : "PROVIDER_VERIFY_FAILED";
      this.logger.warn({ job: "marketing.deliveryBatch", reason }, "delivery sweep refused: provider verification failed");
      return {
        ranAt,
        paused: false,
        sends: [],
        skipped: targets.map((target) => ({ sendId: target.id, reason })),
        totals: emptyTotals,
      };
    }

    const sends: SendBatchOutcome[] = [];
    const skipped: { sendId: string; reason: string }[] = [];
    const totals = { ...emptyTotals };
    const chunkSize = Math.max(
      1,
      Math.min(input.limit ?? settings.delivery.chunkSize, settings.delivery.chunkSize),
    );

    for (const send of targets) {
      const outcome = await this.processSend(send, settings, chunkSize, skipped);
      sends.push(outcome);
      totals.claimed += outcome.claimed;
      totals.sent += outcome.sent;
      totals.blocked += outcome.blocked;
      totals.failed += outcome.failed;
      totals.retried += outcome.retried;
      totals.released += outcome.released;
      if (outcome.claimed > 0 || outcome.recovered.requeued > 0) totals.sends += 1;
      if (outcome.stopped !== null) break; // a stop (throttle, emergency, auth) applies to the whole run
    }

    this.logger.log({
      job: "marketing.deliveryBatch",
      sends: sends.length,
      claimed: totals.claimed,
      sent: totals.sent,
      blocked: totals.blocked,
      failed: totals.failed,
      retried: totals.retried,
      released: totals.released,
      skipped: skipped.length,
    });
    return { ranAt, paused: false, sends, skipped, totals };
  }

  /** The sends this run may drive: one named send, or the sweep of open work (bounded). */
  private async discover(input: DeliveryBatchInput): Promise<MarketingRow[]> {
    if (input.sendId !== undefined && input.sendId.trim() !== "") {
      const row = await this.records.byId(MARKETING_SEND_ENTITY, input.sendId.trim());
      return row === undefined ? [] : [row];
    }
    return this.records.findByAttrIn(MARKETING_SEND_ENTITY, "status", ["Queued", "Sending"], { limit: 25 });
  }

  /**
   * Drive one send: recover stale claims, claim a bounded chunk, deliver each recipient through the
   * shared submission gate, then record the ledger's counters on the send. Every early return is a
   * *skip* with a stated reason — nothing is claimed for a send that cannot legitimately deliver, so a
   * refusal never strands rows in `Sending`.
   */
  private async processSend(
    send: MarketingRow,
    settings: MarketingAutomationSettings,
    chunkSize: number,
    skipped: { sendId: string; reason: string }[],
  ): Promise<SendBatchOutcome> {
    const sendId = send.id;
    const slot = Number(send.data["slot"] ?? 1);
    const statusFrom = typeof send.data["status"] === "string" ? send.data["status"] : "Draft";
    const outcome: SendBatchOutcome = {
      sendId,
      slot,
      statusFrom,
      statusTo: statusFrom,
      claimed: 0,
      sent: 0,
      blocked: 0,
      failed: 0,
      retried: 0,
      released: 0,
      recovered: { expired: 0, requeued: 0, exhausted: 0 },
      stopped: null,
    };
    const skip = (reason: string): SendBatchOutcome => {
      skipped.push({ sendId, reason });
      return outcome;
    };

    const campaignId = typeof send.data["campaignId"] === "string" ? send.data["campaignId"] : "";
    const campaign = campaignId === "" ? undefined : await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (campaign === undefined) return skip("CAMPAIGN_MISSING");
    const campaignStatus = isCampaignStatus(campaign.data["status"]) ? campaign.data["status"] : "Draft";
    const sendable = checkCampaignSendable({ status: campaignStatus });
    if (!sendable.sendable) return skip(sendable.code);
    const purpose = isCampaignPurpose(send.data["purpose"]) ? send.data["purpose"] : null;
    if (purpose === null) return skip("PURPOSE_MISSING");
    const revisionId = typeof send.data["templateRevisionId"] === "string" ? send.data["templateRevisionId"] : "";
    const sealedHash = typeof send.data["contentHash"] === "string" ? send.data["contentHash"] : "";
    if (revisionId === "" || sealedHash === "") return skip("CONTENT_NOT_SEALED");

    // §11.2 recovery *before* claiming: a worker that died mid-flight left rows in `Sending`, and those
    // must be re-queued (or dead-lettered when the budget is spent) rather than counted as new work.
    const now = new Date();
    const recovered = await this.ledger.recoverStaleClaims({
      sendId,
      olderThan: new Date(now.getTime() - settings.delivery.staleClaimMinutes * 60_000).toISOString(),
      maxAttempts: settings.delivery.maxAttempts,
      limit: chunkSize,
      at: now.toISOString(),
    });

    if (statusFrom === "Queued") {
      await this.sends.runtimeAdvance(sendId, "Sending", "delivery batch started claiming recipients");
    }

    const claimed = await this.ledger.claim({ sendId, slot, limit: chunkSize, now: now.toISOString() });
    const tally = { claimed: claimed.length, sent: 0, blocked: 0, failed: 0, retried: 0, released: 0 };
    let stopped: string | null = null;
    let authFailures = Number(send.data["authFailureCount"] ?? 0);

    for (const row of claimed) {
      const rowOutcome = await this.deliverRow(row, {
        sendId,
        slot,
        campaignId,
        campaignLabel:
          typeof campaign.data["code"] === "string" && campaign.data["code"] !== ""
            ? campaign.data["code"]
            : campaignId,
        campaignStatus,
        purpose,
        revisionId,
        sealedHash,
        senderAccountId: typeof send.data["senderAccountId"] === "string" ? send.data["senderAccountId"] : null,
        settings,
      });
      const at = new Date().toISOString();
      switch (rowOutcome.kind) {
        case "sent":
          await this.ledger.markSent({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            providerKey: settings.provider.key,
            providerMessageId: rowOutcome.providerMessageId,
            contentHash: rowOutcome.contentHash,
            at,
          });
          tally.sent += 1;
          authFailures = 0; // §5.8: a success clears the consecutive-auth-failure count
          break;
        case "blocked":
          await this.ledger.blockClaimed({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasons: rowOutcome.reasons,
            errorCode: rowOutcome.code,
            at,
          });
          tally.blocked += 1;
          break;
        case "retry": {
          const state = await this.ledger.retryOrFail({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasonCode: rowOutcome.reasonCode,
            maxAttempts: settings.delivery.maxAttempts,
            at,
          });
          if (state === "Queued") tally.retried += 1;
          else tally.failed += 1;
          break;
        }
        case "dead":
          await this.ledger.failPermanent({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasonCode: rowOutcome.reasonCode,
            at,
          });
          tally.failed += 1;
          break;
        case "unknown":
          // The submission may already be at the provider: stay `Sending` with the reason recorded and
          // never blind-resend — MA.10's provider events reconcile it (§5.8).
          await this.ledger.markSubmissionUnknown({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            at,
          });
          tally.failed += 1;
          break;
        case "auth":
          // A configuration failure, not a recipient one: the attempt is given back, the failure is
          // counted, and the send pauses below instead of burning every recipient's budget (§5.8).
          await this.ledger.releaseClaim({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasonCode: rowOutcome.reasonCode,
            at,
          });
          tally.released += 1;
          authFailures += 1;
          break;
        case "released":
          await this.ledger.releaseClaim({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasonCode: rowOutcome.reasonCode,
            at,
          });
          tally.released += 1;
          break;
        case "paused":
          // The emergency stop landed mid-run: give the attempt back and stop — a pause must not consume
          // a recipient's budget or mark anything terminal (§13).
          await this.ledger.releaseClaim({
            sendId,
            slot,
            entityType: row.entityType,
            entityId: row.entityId,
            reasonCode: "GLOBAL_SEND_PAUSED",
            at,
          });
          tally.released += 1;
          stopped = "GLOBAL_SEND_PAUSED";
          break;
      }
      if (stopped !== null) break;
    }

    if (stopped === null && authFailures >= settings.delivery.autoPauseAfterAuthFailures) {
      try {
        await this.sends.run(sendId, "pause", {
          reason: `Provider authentication keeps failing (AUTH_FAILED); sending paused after ${String(authFailures)} consecutive failure(s).`,
        });
        stopped = "AUTH_FAILED";
      } catch (error) {
        skipped.push({ sendId, reason: "AUTH_PAUSE_REFUSED" });
        this.logger.warn(
          { job: "marketing.deliveryBatch", sendId, reason: "AUTH_PAUSE_REFUSED" },
          error instanceof Error ? error.message : "auth pause refused",
        );
      }
    }

    await this.finishSend(sendId, slot);
    const after = await this.records.byId(MARKETING_SEND_ENTITY, sendId);
    return {
      ...outcome,
      statusTo: typeof after?.data["status"] === "string" ? after.data["status"] : outcome.statusFrom,
      claimed: tally.claimed,
      sent: tally.sent,
      blocked: tally.blocked,
      failed: tally.failed,
      retried: tally.retried,
      released: tally.released,
      recovered,
      stopped,
    };
  }

  /**
   * Deliver one claimed row: read the person, render the sealed content for them, then hand everything
   * to `submit` — the single gate every marketing submission passes through. The returned `RowOutcome`
   * is a ledger instruction, never a status this method writes itself.
   */
  private async deliverRow(row: DeliveryRecord, ctx: DeliveryRowContext): Promise<RowOutcome> {
    // A ledger row holds an identity, not an address (§6.1): the address comes from the canonical record,
    // read under this run's identity. A person who cannot be read is a terminal block, not a silent skip.
    let record: Record<string, unknown> | undefined;
    try {
      record = await this.entities.get(row.entityType, row.entityId);
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      return { kind: "blocked", code: "RECORD_UNREADABLE", reasons: [...row.reasons, "RECORD_UNREADABLE"] };
    }
    const emailAddress = normalizeEmailAddress(
      typeof record["emailAddress"] === "string" ? record["emailAddress"] : "",
    );

    // The content is the sealed revision the send was validated against — never the live template, and
    // never a render whose hash disagrees with what the approval covered (§6.2, §5.5).
    let content: DeliveryContentRender;
    try {
      content = await this.templates.renderRevisionForRecipient({
        campaignId: ctx.campaignId,
        revisionId: ctx.revisionId,
        recipientType: row.entityType,
        recipientId: row.entityId,
      });
    } catch (error) {
      const code =
        error instanceof ValidationError && typeof error.details?.["code"] === "string"
          ? error.details["code"]
          : null;
      if (code === "CONTENT_REVISION_MISSING" || code === "RECIPIENT_UNREADABLE") {
        return { kind: "blocked", code, reasons: [...row.reasons, code] };
      }
      return { kind: "retry", reasonCode: "CONTENT_RENDER_FAILED" };
    }
    if (
      content.templateContentHash !== ctx.sealedHash ||
      (content.sealedContentHash !== null && content.sealedContentHash !== ctx.sealedHash)
    ) {
      return { kind: "blocked", code: "CONTENT_MISMATCH", reasons: [...row.reasons, "CONTENT_MISMATCH"] };
    }

    const result = await this.submit({
      recipient: {
        entityType: row.entityType,
        entityId: row.entityId,
        emailAddress,
        emailHash: row.emailHash,
      },
      purpose: ctx.purpose,
      campaignStatus: ctx.campaignStatus,
      campaignId: ctx.campaignId,
      content: {
        subject: content.subject ?? "",
        plainText: content.plainText,
        bodyHtml: content.bodyHtml,
        systemLinks: content.systemLinks,
        contentHash: ctx.sealedHash,
      },
      senderAccountId: ctx.senderAccountId,
      headers: { "X-Marketing-Campaign": ctx.campaignLabel },
      idempotencyKey: `ma:${ctx.sendId}:${ctx.slot}:${row.entityType}:${row.entityId}`,
    });

    switch (result.status) {
      case "sent":
        return { kind: "sent", providerMessageId: result.providerMessageId, contentHash: ctx.sealedHash };
      case "blocked":
        return { kind: "blocked", code: result.code, reasons: [...row.reasons, ...result.reasons] };
      case "paused":
        return { kind: "paused" };
      case "throttled":
        return { kind: "released", reasonCode: "RATE_LIMITED" };
      case "failed":
        if (result.kind === "unknown_submission") return { kind: "unknown" };
        if (AUTH_FAILURE_REASON_CODES.has(result.reasonCode)) return { kind: "auth", reasonCode: result.reasonCode };
        return result.kind === "retryable"
          ? { kind: "retry", reasonCode: result.reasonCode }
          : { kind: "dead", reasonCode: result.reasonCode };
    }
  }

  /**
   * Record what this batch proved on the send itself, then finish it when no open work remains. The
   * send's counters are always the ledger's summary — never arithmetic over this run's tallies — so two
   * concurrent chunks cannot disagree (§6.5, §15 `19-MA.8` "consistent with the underlying records").
   */
  private async finishSend(
    sendId: string,
    slot: number,
  ): Promise<void> {
    const summary = await this.ledger.summary(sendId);
    await runAsMarketingInternal(() =>
      this.entities.update(MARKETING_SEND_ENTITY, sendId, {
        recipientCount: summary.total,
        eligibleCount: summary.eligible,
        blockedCount: summary.blocked,
        skippedCount: summary.skipped,
        sentCount: summary.sent,
        failedCount: summary.failed,
      }),
    );

    const counts = await this.ledger.openCounts(sendId, slot);
    const open = OPEN_DELIVERY_STATES.reduce((total, state) => total + (counts[state] ?? 0), 0);
    if (open > 0) return;
    const status = (await this.records.byId(MARKETING_SEND_ENTITY, sendId))?.data["status"];
    if (status !== "Sending") return;

    if (summary.sent === 0 && summary.failed > 0) {
      await this.sends.runtimeAdvance(sendId, "Failed", "every recipient's submission failed in this send");
      return;
    }
    await this.sends.runtimeAdvance(sendId, "Sent", "every recipient reached a terminal state");
    try {
      await this.sends.run(sendId, "complete", { reason: "delivery finished; every recipient is terminal" });
    } catch (error) {
      // A refused completion leaves the send in `Sent` — visible and correct, never a hidden failure.
      this.logger.warn(
        { job: "marketing.deliveryBatch", sendId, reason: "COMPLETE_REFUSED" },
        error instanceof Error ? error.message : "completion refused",
      );
    }
  }

  /**
   * The single submission gate (§0.1 rule 8): emergency stop, provider binding, the MA.5 eligibility
   * matrix with the send-time frequency cap, per-recipient links, and the shared rate limiter — in that
   * order, on every path (campaign delivery *and* journey email). A caller that reached a provider
   * through anything other than this method has bypassed a mandatory server-side gate.
   */
  async submit(input: MarketingSubmissionInput): Promise<MarketingSubmissionOutcome> {
    const settings = await this.settings.settings();
    // §13: the stop is re-read *here*, not trusted from when the send was queued.
    if (settings.safety.globalSendPaused) return { status: "paused" };

    const adapter = this.providers.resolve(settings.provider.key);
    if (adapter.info.mode !== "live") {
      return { status: "blocked", code: "PROVIDER_NOT_BOUND", reasons: ["PROVIDER_NOT_BOUND"] };
    }

    // §5.8: consent, suppression, address and the cap are re-evaluated immediately before submission —
    // the snapshot's category was a forecast, and somebody who opted out after it must not be mailed.
    const cap = settings.delivery.frequencyCapPerRecipient;
    const identityHash = this.eligibility.identityOf({
      entityType: input.recipient.entityType,
      entityId: input.recipient.entityId,
      emailAddress: input.recipient.emailAddress,
      emailHash: input.recipient.emailHash ?? undefined,
    });
    let messagesInWindow: number | undefined;
    if (cap > 0 && identityHash !== null) {
      const since = new Date(Date.now() - settings.delivery.frequencyWindowHours * 3_600_000).toISOString();
      messagesInWindow = (await this.ledger.countMessagesSince([identityHash], since)).get(identityHash) ?? 0;
    }
    const gate = await this.eligibility.decide(
      {
        entityType: input.recipient.entityType,
        entityId: input.recipient.entityId,
        emailAddress: input.recipient.emailAddress,
        ...(input.recipient.emailHash !== null ? { emailHash: input.recipient.emailHash } : {}),
        ...(input.recipient.readable !== undefined ? { readable: input.recipient.readable } : {}),
        ...(messagesInWindow !== undefined ? { messagesInWindow } : {}),
      },
      {
        channel: "Email",
        purpose: input.purpose,
        campaignStatus: input.campaignStatus,
        ...(input.targetListId !== undefined ? { targetListId: input.targetListId } : {}),
        ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
        ...(cap > 0 ? { frequencyCap: cap } : {}),
      },
    );
    if (!gate.decision.eligible) {
      return { status: "blocked", code: gate.decision.code, reasons: [...gate.decision.reasons] };
    }
    const emailHash = gate.emailHash ?? identityHash;
    if (emailHash === null) {
      return { status: "blocked", code: "INVALID_ADDRESS", reasons: ["INVALID_ADDRESS"] };
    }

    // Per-recipient links (§5.4): minted now, never at preview time, and only for the placeholders the
    // content actually uses. A token outage fails the row *before* anything was submitted, so the retry
    // is safe and the bounded attempt budget keeps it from looping.
    let links: { unsubscribeUrl: string; preferenceUrl: string | null; listUnsubscribe: string };
    try {
      links = await this.issueLinks({
        emailHash,
        purpose: input.purpose,
        campaignId: input.campaignId ?? null,
        systemLinks: input.content.systemLinks,
        publicBaseUrl: settings.delivery.publicBaseUrl,
      });
    } catch {
      return { status: "failed", kind: "retryable", reasonCode: "LINK_ISSUE_FAILED" };
    }

    const sender = input.senderAccountId ?? "";
    const message: MarketingProviderMessage = {
      to: [normalizeEmailAddress(input.recipient.emailAddress)],
      subject: input.content.subject,
      ...(input.content.plainText !== null
        ? { text: replaceLinkSentinels(input.content.plainText, links) }
        : {}),
      ...(input.content.bodyHtml !== null
        ? { html: replaceLinkSentinels(input.content.bodyHtml, links) }
        : {}),
      ...(sender !== ""
        ? { senderAccountId: sender }
        : adapter.info.fromAddress !== null
          ? { fromAddress: adapter.info.fromAddress }
          : {}),
      headers: {
        ...(input.headers ?? {}),
        ...(links.listUnsubscribe !== "" ? { "List-Unsubscribe": `<${links.listUnsubscribe}>` } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    };

    // Shape validation before the limiter spends a rate slot: an injection-shaped header or address is a
    // permanent failure decided here, never a provider round trip (§9.4).
    try {
      adapter.validate(message);
    } catch (error) {
      if (error instanceof MarketingProviderError) {
        return { status: "failed", kind: error.kind, reasonCode: error.reasonCode };
      }
      return { status: "failed", kind: "permanent", reasonCode: "MESSAGE_INVALID" };
    }

    const limits = {
      messages: 1,
      ratePerMinute:
        settings.provider.limits.ratePerMinute > 0
          ? settings.provider.limits.ratePerMinute
          : adapter.info.ratePerMinute,
      maxConcurrency:
        settings.provider.limits.maxConcurrency > 0
          ? settings.provider.limits.maxConcurrency
          : adapter.info.maxConcurrency,
    };
    try {
      const result = await this.limiter.run(adapter.info.key, limits, () => adapter.send(message));
      if (result.accepted !== true) {
        return { status: "failed", kind: result.errorKind ?? "retryable", reasonCode: "PROVIDER_REJECTED" };
      }
      return {
        status: "sent",
        providerMessageId: result.providerMessageId ?? null,
        contentHash: input.content.contentHash,
      };
    } catch (error) {
      // A ceiling refusal is ours, not the provider's: the attempt is released (not consumed) and the
      // next run continues under the same idempotency key (§11.2 "prevent retry storms").
      if (error instanceof RateLimitError) return { status: "throttled" };
      if (error instanceof MarketingProviderError) {
        return { status: "failed", kind: error.kind, reasonCode: error.reasonCode };
      }
      // Unclassified from inside `send`: the submission may have reached the provider, so it is unknown
      // rather than retryable — a blind resend is how a recipient is mailed twice (§5.8).
      return { status: "failed", kind: "unknown_submission", reasonCode: "SUBMISSION_UNKNOWN" };
    }
  }

  /**
   * Mint this recipient's own links and report the `List-Unsubscribe` endpoint for them (§5.4, §5.3.1).
   * Tokens are issued here — never at preview time — and only for the placeholders the content actually
   * uses; without a configured `publicBaseUrl` the RFC 2369 header is omitted rather than built from an
   * invented origin (§13 `delivery.publicBaseUrl`).
   */
  private async issueLinks(input: {
    readonly emailHash: string;
    readonly purpose: CampaignPurpose;
    readonly campaignId: string | null;
    readonly systemLinks: readonly string[];
    readonly publicBaseUrl: string;
  }): Promise<{ unsubscribeUrl: string; preferenceUrl: string | null; listUnsubscribe: string }> {
    const common = {
      emailHash: input.emailHash,
      purpose: input.purpose,
      ...(input.campaignId !== null ? { campaignId: input.campaignId } : {}),
    };
    const unsubscribe = await this.links.issue("Unsubscribe", common);
    const preference = input.systemLinks.includes("preferenceUrl")
      ? await this.links.issue("Preferences", common)
      : null;
    const absolute = (path: string) => (input.publicBaseUrl === "" ? path : `${input.publicBaseUrl}${path}`);
    return {
      unsubscribeUrl: absolute(unsubscribe.path),
      preferenceUrl: preference === null ? null : absolute(preference.path),
      listUnsubscribe:
        input.publicBaseUrl === ""
          ? ""
          : `${input.publicBaseUrl}/api/v1/MarketingAutomation/public/unsubscribe/${unsubscribe.token}`,
    };
  }
}

/**
 * Replace the renderer's preview sentinels with the recipient's real links. The sentinels are the
 * reserved `.invalid` host `renderMarketingTemplate` documented (§5.4), and this is the "send path of
 * MA.7/MA.9" that promise names: an unfilled sentinel can never go on the wire, because a link that was
 * not issued is simply left as the harmless sentinel for the operator to see in diagnostics.
 */
function replaceLinkSentinels(
  value: string,
  links: { readonly unsubscribeUrl: string; readonly preferenceUrl: string | null },
): string {
  const unsubscribeSentinel = PREVIEW_SYSTEM_LINK_SENTINELS["unsubscribeUrl"];
  const preferenceSentinel = PREVIEW_SYSTEM_LINK_SENTINELS["preferenceUrl"];
  let out = value;
  if (typeof unsubscribeSentinel === "string" && unsubscribeSentinel !== "") {
    out = out.split(unsubscribeSentinel).join(links.unsubscribeUrl);
  }
  if (links.preferenceUrl !== null && typeof preferenceSentinel === "string" && preferenceSentinel !== "") {
    out = out.split(preferenceSentinel).join(links.preferenceUrl);
  }
  return out;
}




type RowOutcome =
  | { readonly kind: "sent"; readonly providerMessageId: string | null; readonly contentHash: string | null }
  | { readonly kind: "blocked"; readonly code: string; readonly reasons: readonly string[] }
  | { readonly kind: "retry"; readonly reasonCode: string }
  | { readonly kind: "dead"; readonly reasonCode: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "auth"; readonly reasonCode: string }
  | { readonly kind: "released"; readonly reasonCode: string }
  | { readonly kind: "paused" };

/** The send-level facts one claimed row is delivered under. */
interface DeliveryRowContext {
  readonly sendId: string;
  readonly slot: number;
  readonly campaignId: string;
  readonly campaignLabel: string;
  readonly campaignStatus: CampaignStatus;
  readonly purpose: CampaignPurpose;
  readonly revisionId: string;
  readonly sealedHash: string;
  readonly senderAccountId: string | null;
  readonly settings: MarketingAutomationSettings;
}

