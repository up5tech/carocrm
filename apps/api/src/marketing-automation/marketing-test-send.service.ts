import { FeatureDisabledError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import {
  CAMPAIGN_ENTITY,
  type CampaignPurpose,
  fingerprint,
  isCampaignPurpose,
  looksLikeEmailAddress,
  normalizeEmailAddress,
  type SegmentEntityType,
} from "./marketing-automation-domain.js";
import {
  MarketingProviderError,
  type MarketingProviderErrorKind,
  type MarketingProviderMessage,
  type MarketingProviderReceipt,
  MarketingProviderRegistry,
} from "./marketing-automation-provider.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingProviderLimiter } from "./marketing-provider-limiter.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";
import type { RenderFinding } from "./marketing-template-render.js";

/**
 * Phase 19-MA.7 — the explicit, safe test send (§5.4, §8.2, §10.2, §10.5, §15 `19-MA.7` task 3).
 *
 * A test send exists so an operator can prove the *whole* path — sender identity, credentials, provider
 * submission, rendered content — before a campaign is aimed at people. §1.2 and §0.1 rule 6 make it a
 * safety device rather than a convenience, and every rule below is one of those safety properties:
 *
 *  1. **An administrator's allowlist, not the campaign's audience.** The command can only reach addresses
 *     listed in `provider.testSend.allowedRecipients`; an empty list means the command is refused. A
 *     mis-click on a Draft campaign can therefore never mail the audience the campaign is aimed at (§10.2).
 *  2. **Explicit and confirmed.** Recipients must be named per call, and confirmation is a server-side
 *     requirement (not a UI convention), so a replayed or forged request cannot send silently (§8.2).
 *  3. **Marked as a test in the message itself.** §10.2 requires test sends to be unmistakable; the subject
 *     is prefixed, a banner is prepended to both body parts, and an `X-Marketing-Test` header is set, so
 *     neither the recipient nor a downstream provider can mistake it for campaign delivery.
 *  4. **Nothing about the campaign changes.** No lifecycle transition, no validation stamp, no snapshot, no
 *     delivery row, no `marketing.*` event — §15's acceptance rule "test sends are not counted as campaign
 *     sends or journey outcomes" is implemented by simply not touching any of them.
 *  5. **Consent is not consulted, suppression always is.** §0.1 rule 8 forbids bypassing the consent gate for
 *     a *marketing* send; a test send goes only to internal, administrator-allowlisted addresses, and is
 *     labelled as such — but emailing somebody who complained, hard-bounced or unsubscribed is never
 *     acceptable, so the suppression gate still refuses the request.
 *  6. **A classified outcome, never a raw provider failure.** Submission failures come back as a result
 *     carrying one of the three §15 states, because "unknown submission" must stop an operator from pressing
 *     send again more than it must produce a stack trace (§5.8, §7.4).
 *
 * The one deliberate architectural exception: this path calls the provider **synchronously** from the API
 * process so the operator sees the real classification, while the campaign pipeline stays queue-based
 * (`email.service.ts`: "nothing is sent from the API process"). It is bounded to a single message, to
 * allowlisted recipients, under the provider limiter — and it is not the delivery pipeline that MA.9 builds.
 */

/** Unmistakable test markers (§10.2). Fixed strings: no campaign or recipient value is interpolated here. */
export const TEST_SEND_SUBJECT_PREFIX = "[TEST] ";
export const TEST_SEND_HEADER = "X-Marketing-Test";
export const TEST_SEND_BANNER = "*** TEST MESSAGE — NOT A CAMPAIGN SEND ***";
const TEST_SEND_HTML_BANNER = `<div style="font-family:sans-serif;padding:8px;border:1px solid #d4b106;background:#fffbe6">${TEST_SEND_BANNER}</div>`;

/** How many recent submissions are remembered for the duplicate guard, and for how long. */
const RECENT_LIMIT = 50;
const RECENT_TTL_MS = 10 * 60_000;

export interface TestSendInput {
  readonly recipients: readonly string[];
  readonly confirm?: boolean | undefined;
  readonly recipientType?: SegmentEntityType | undefined;
  readonly recipientId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface TestSendView {
  readonly testSend: true;
  readonly campaignId: string;
  readonly provider: {
    readonly key: string;
    readonly label: string;
    readonly mode: string;
  };
  readonly subject: string;
  readonly recipients: readonly MarketingProviderReceipt[];
  readonly accepted: boolean;
  readonly errorKind?: MarketingProviderErrorKind;
  readonly error?: string;
  /** The content hash actually rendered for this test, so the message can be tied to what it carried (§6.2). */
  readonly contentHash: string;
  readonly findings: readonly RenderFinding[];
  readonly markers: {
    readonly subjectPrefix: string;
    readonly header: string;
    readonly banner: string;
  };
  /** True when the same submission was already made and the recorded answer was returned instead. */
  readonly duplicate: boolean;
  readonly sentAt: string;
}

interface RecentSubmission {
  readonly at: number;
  readonly view: TestSendView;
}

@Injectable()
export class MarketingTestSendService {
  /** The duplicate guard for one process; a replayed key returns the original answer (§0.1 rule 10). */
  private readonly recent = new Map<string, RecentSubmission>();

  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
    @Inject(MarketingProviderLimiter) private readonly limiter: MarketingProviderLimiter,
    @Inject(MarketingSuppressionService) private readonly suppressions: MarketingSuppressionService,
    @Inject(MarketingConsentService) private readonly consent: MarketingConsentService,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async send(campaignId: string, input: TestSendInput): Promise<TestSendView> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");

    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    // Sending is a write-shaped action on the campaign in the §9.2 sense: it spends the deployment's
    // sending identity and reputation even though it stores nothing.
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "edit", recordShape(campaignId, row.data));

    if (settings.safety.globalSendPaused) {
      throw new ValidationError(
        "Marketing sending is stopped globally by an operator; a test send is a send and is stopped with the rest (§13).",
        { code: "GLOBAL_SEND_PAUSED", campaignId },
      );
    }

    const testSettings = settings.provider.testSend;
    const recipients = normalizeRecipients(input.recipients);
    if (recipients.length === 0) {
      throw new ValidationError("A test send needs at least one explicit recipient address.", {
        code: "TEST_SEND_RECIPIENTS_REQUIRED",
        campaignId,
      });
    }
    if (recipients.length > testSettings.maxRecipients) {
      throw new ValidationError(
        `A test send accepts at most ${String(testSettings.maxRecipients)} recipient(s); ${String(recipients.length)} were given.`,
        { code: "TEST_SEND_TOO_MANY_RECIPIENTS", campaignId },
      );
    }
    const allowed = new Set(testSettings.allowedRecipients.map((address) => normalizeEmailAddress(address)));
    if (allowed.size === 0) {
      throw new ValidationError(
        "No test-send recipient is allowlisted, so test sends are disabled. An administrator lists internal mailboxes under provider.testSend.allowedRecipients.",
        { code: "TEST_SEND_NOT_CONFIGURED", campaignId },
      );
    }
    const refused = recipients.filter((address) => !allowed.has(address));
    if (refused.length > 0) {
      throw new ValidationError(
        `A test send may only reach the allowlisted test addresses; ${refused.length} recipient(s) are not on it.`,
        { code: "TEST_RECIPIENT_NOT_ALLOWED", campaignId, notAllowed: refused },
      );
    }
    if (testSettings.requireConfirmation && input.confirm !== true) {
      throw new ValidationError(
        "A test send requires explicit confirmation (`confirm: true`), because it leaves this system.",
        { code: "TEST_SEND_CONFIRMATION_REQUIRED", campaignId },
      );
    }

    const purpose: CampaignPurpose | null = isCampaignPurpose(row.data["purpose"]) ? row.data["purpose"] : null;
    if (purpose === null) {
      throw new ValidationError(
        "This campaign has no communication purpose, so a test send cannot be scoped to one. Set the purpose first (§5.1).",
        { code: "PURPOSE_REQUIRED", campaignId },
      );
    }

    const adapter = this.providers.resolve(settings.provider.key);
    if (adapter.info.mode !== "live") {
      throw new ValidationError(
        settings.provider.key === ""
          ? "No marketing provider is configured, so there is nothing to test-send through. Set provider.key in Marketing Automation settings (§13)."
          : `The configured provider "${adapter.info.key}" is ${adapter.info.mode}, so a test send is refused rather than faked (§1.2).`,
        { code: "PROVIDER_NOT_BOUND", campaignId, provider: adapter.info.key, mode: adapter.info.mode },
      );
    }
    if (!adapter.info.supportsTestSend) {
      throw new ValidationError(
        `Provider "${adapter.info.key}" does not support an individual test send.`,
        { code: "TEST_SEND_UNSUPPORTED", campaignId, provider: adapter.info.key },
      );
    }

    // The sending identity. A campaign that names a mailbox keeps that choice — and the caller does not have
    // to be able to read the mailbox (sending accounts are administrator-only in this platform).
    const senderAccountId = text(row.data["emailAccountId"]);
    if (senderAccountId !== undefined && !(await this.records.emailAccountExists(senderAccountId))) {
      throw new ValidationError(
        `The campaign's sending account "${senderAccountId}" does not exist or was removed.`,
        { code: "SENDER_UNKNOWN", campaignId },
      );
    }
    if (senderAccountId === undefined && (adapter.info.fromAddress ?? "").trim() === "") {
      throw new ValidationError(
        "Neither the campaign nor the provider names a sending address, so this message would have no From identity.",
        { code: "SENDER_REQUIRED", campaignId },
      );
    }

    // §0.1 rule 8's suppression half still applies: a test must never reach a person who unsubscribed,
    // complained, hard-bounced or was blocked by an operator. Consent is deliberately not consulted here
    // (the allowlist is internal and the message is marked as a test); that decision is documented in
    // docs/marketing-automation/provider-adapters.md §5.
    await this.assertNotSuppressed(campaignId, recipients, purpose);

    const preview = await this.templates.previewCampaignContent(campaignId, {
      ...(input.recipientType !== undefined ? { recipientType: input.recipientType } : {}),
      ...(input.recipientId !== undefined ? { recipientId: input.recipientId } : {}),
    });

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `test:${campaignId}:${preview.templateContentHash}:${fingerprint({
        recipients,
        actor: this.scope.principal?.userId ?? "unknown",
      })}`;
    const prior = this.prior(idempotencyKey);
    if (prior !== undefined) return { ...prior, duplicate: true };

    const subject = `${TEST_SEND_SUBJECT_PREFIX}${preview.subject ?? ""}`;
    const message: MarketingProviderMessage = {
      to: recipients,
      subject,
      ...(preview.plainText !== null ? { text: `${TEST_SEND_BANNER}\n\n${preview.plainText}` } : {}),
      ...(preview.bodyHtml !== null ? { html: `${TEST_SEND_HTML_BANNER}\n${preview.bodyHtml}` } : {}),
      // A mailbox, when named, resolves its own From inside the adapter; otherwise the provider's verified
      // identity is the only address this system is allowed to send as.
      ...(senderAccountId !== undefined ? { senderAccountId } : {}),
      ...(senderAccountId === undefined && adapter.info.fromAddress !== null
        ? { fromAddress: adapter.info.fromAddress }
        : {}),
      headers: {
        [TEST_SEND_HEADER]: "true",
        "X-Marketing-Campaign": text(row.data["code"]) ?? campaignId,
      },
      idempotencyKey,
    };

    const view = await this.submit(campaignId, adapter, message, {
      subject,
      contentHash: preview.templateContentHash,
      findings: preview.findings,
      ratePerMinute: settings.provider.limits.ratePerMinute,
      maxConcurrency: settings.provider.limits.maxConcurrency,
    });
    this.remember(idempotencyKey, view);
    return view;
  }

  /**
   * One submission: the handshake first (so bad credentials are reported as such, not as a failed message),
   * then the send, both under the provider limiter. A `MarketingProviderError` is the adapter's *classified*
   * answer and becomes the result; anything else is a bug and is left for the global exception filter.
   */
  private async submit(
    campaignId: string,
    adapter: ReturnType<MarketingProviderRegistry["resolve"]>,
    message: MarketingProviderMessage,
    facts: {
      readonly subject: string;
      readonly contentHash: string;
      readonly findings: readonly RenderFinding[];
      readonly ratePerMinute: number;
      readonly maxConcurrency: number;
    },
  ): Promise<TestSendView> {
    const base = {
      testSend: true as const,
      campaignId,
      provider: { key: adapter.info.key, label: adapter.info.label, mode: adapter.info.mode },
      subject: facts.subject,
      contentHash: facts.contentHash,
      findings: facts.findings,
      markers: { subjectPrefix: TEST_SEND_SUBJECT_PREFIX, header: TEST_SEND_HEADER, banner: TEST_SEND_BANNER },
      duplicate: false,
      sentAt: new Date().toISOString(),
    };
    try {
      const result = await this.limiter.run(
        adapter.info.key,
        {
          messages: 1,
          // The deployment's own ceiling wins when it set one; the provider's published limit is the fallback.
          ratePerMinute: facts.ratePerMinute > 0 ? facts.ratePerMinute : adapter.info.ratePerMinute,
          maxConcurrency: facts.maxConcurrency > 0 ? facts.maxConcurrency : adapter.info.maxConcurrency,
        },
        async () => {
          await adapter.verify();
          return adapter.send(message);
        },
      );
      return { ...base, recipients: result.receipts, accepted: result.accepted };
    } catch (error) {
      if (!(error instanceof MarketingProviderError)) throw error;
      // A classified failure is a result, not an exception: the operator needs the state (and specifically
      // `unknown_submission`) to decide whether pressing send again is safe.
      return {
        ...base,
        recipients: message.to.map((recipient) => ({ recipient, status: "skipped" as const })),
        accepted: false,
        errorKind: error.kind,
        error: error.message,
      };
    }
  }

  /** Refuse a test send that would reach a suppressed address; consent is the campaign gate, not this one. */
  private async assertNotSuppressed(
    campaignId: string,
    recipients: readonly string[],
    purpose: CampaignPurpose,
  ): Promise<void> {
    const hashes = recipients
      .map((address) => this.consent.identity(address))
      .filter((hash): hash is string => hash !== null);
    if (hashes.length === 0) return;
    const applied = await this.suppressions.appliedForMany(hashes, { channel: "Email", purpose });
    if (applied.size === 0) return;
    const blocked = recipients.filter((address) => {
      const hash = this.consent.identity(address);
      return hash !== null && applied.has(hash);
    });
    throw new ValidationError(
      `A test send is refused for ${String(blocked.length)} suppressed recipient(s): suppression applies to every sending path (§5.3, §0.1 rule 8).`,
      { code: "TEST_RECIPIENT_SUPPRESSED", campaignId, blocked },
    );
  }

  private prior(key: string): TestSendView | undefined {
    const entry = this.recent.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > RECENT_TTL_MS) {
      this.recent.delete(key);
      return undefined;
    }
    return entry.view;
  }

  private remember(key: string, view: TestSendView): void {
    this.recent.set(key, { at: Date.now(), view });
    while (this.recent.size > RECENT_LIMIT) {
      const oldest = this.recent.keys().next();
      if (oldest.done === true) break;
      this.recent.delete(oldest.value);
    }
  }
}

/** Normalized, de-duplicated, validated addresses; the caller's order is preserved. */
function normalizeRecipients(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const address = normalizeEmailAddress(value);
    if (!looksLikeEmailAddress(address) || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/** The shape the record-level ACL evaluator needs, from the stored row. */
function recordShape(id: string, data: Record<string, unknown>) {
  return {
    id,
    assignedUserId: text(data["assignedUserId"]),
    createdById: text(data["createdById"]),
    teams: Array.isArray(data["teams"]) ? (data["teams"] as string[]) : [],
    data,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
