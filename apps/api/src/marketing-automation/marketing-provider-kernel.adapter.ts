import { AppError, ValidationError } from "@carocrm/core/errors/index.js";
import type { MailMessageInput, MailTransport, SendResult } from "@carocrm/mail";
import { classifySmtpError, createAccountSmtpTransport, parseAddress } from "@carocrm/mail";

import type { EmailAccountsService } from "../email/email-accounts.service.js";
import {
  assertProviderMessage,
  type MarketingProviderAdapter,
  MarketingProviderError,
  type MarketingProviderErrorKind,
  type MarketingProviderInfo,
  type MarketingProviderMessage,
  type MarketingProviderReceipt,
  type MarketingProviderResult,
} from "./marketing-automation-provider.js";

/**
 * Phase 19-MA.7 — the live provider adapter, wrapping the platform's own outbound mail (§15 `19-MA.7`
 * task 1: "wrap the existing outbound email service or the existing vendor integration").
 *
 * The audit (`docs/implementation/marketing-automation-audit.md` §2) records that this repository already
 * owns a provider-neutral mail port — `@carocrm/mail`'s `MailTransport`, chosen by `MAIL_TRANSPORT` and
 * reached through `MAIL_TRANSPORT_TOKEN`. So the module adds **no vendor SDK**: this adapter is the seam
 * between `MarketingProviderAdapter` (§5.8) and that port, and an extension that replaces the transport with
 * SES/SendGrid/Graph changes nothing here.
 *
 * Three properties this adapter is responsible for:
 *
 *  1. **It never claims a delivery the transport did not make.** `info.mode` is derived from the transport's
 *     own `mode`: `none` and `memory` are `disabled`, so the send-readiness gate keeps refusing and a
 *     misconfigured deployment cannot produce a campaign that "sends" into a void (§1.2 safe by default).
 *  2. **Credentials come from the existing secrets mechanisms, never from marketing tables.** The
 *     deployment-level `SMTP_*`/`MAIL_TRANSPORT` configuration is the default; when a message names a
 *     `senderAccountId`, the sending mailbox is an `email_accounts` row whose password is encrypted at rest
 *     with `ENCRYPTION_KEY` and decrypted in memory only for this call (§9.4, §13).
 *  3. **Failures are normalized.** Every transport/validation failure leaves as a `MarketingProviderError`
 *     carrying one of the three §15 states and a stable reason code — never a raw provider body, an SMTP
 *     transcript or a credential (§7.4, §9.3).
 */

export const KERNEL_MAIL_PROVIDER_KEY = "platform-mail";

/**
 * Failure codes that mean "the message may already be at the provider". A socket that timed out or was reset
 * while a submission was in flight cannot be answered locally, so §5.8 requires this to be a distinct state
 * rather than a retryable error — MA.9 reconciles before it resends.
 */
const UNKNOWN_SUBMISSION_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE"]);

/**
 * Failures §5.8 names as non-retryable regardless of how the transport's own classifier reads them:
 * 'do not indefinitely retry ... rejected authentication ... or permanent errors'. The kernel treats an
 * authentication failure as transient (a rotation or a throttle can recover), which is right for a queued
 * job with a bounded budget; here the plan is explicit, so marketing answers `permanent` and the reason code
 * tells the operator which credential to fix.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set(["EAUTH", "EENVELOPE"]);

/** Stable reason codes for the diagnostics a human actually reads; never a provider transcript. */
const REASON_CODE_BY_TRANSPORT_CODE: Readonly<Record<string, string>> = {
  EAUTH: "AUTH_FAILED",
  EENVELOPE: "RECIPIENT_REJECTED",
  ECONNECTION: "CONNECTION_FAILED",
  ESOCKET: "CONNECTION_FAILED",
  ECONNCLOSED: "CONNECTION_CLOSED",
  ECONNREFUSED: "CONNECTION_REFUSED",
  ENOTFOUND: "HOST_NOT_FOUND",
  EAI_AGAIN: "DNS_UNAVAILABLE",
  ESMTPTEMPFAIL: "PROVIDER_TEMP_FAIL",
  EMFU: "MAILBOX_UNAVAILABLE",
};

/**
 * Normalize any failure into the §15 classification. Exported so the adapter, MA.9's worker and the
 * unit tests all classify through one implementation (a second classifier is how two retry policies
 * start disagreeing about the same error).
 */
export function classifyMarketingProviderFailure(error: unknown): {
  readonly kind: MarketingProviderErrorKind;
  readonly reasonCode: string;
} {
  if (error instanceof MarketingProviderError) {
    return { kind: error.kind, reasonCode: error.reasonCode };
  }
  if (error instanceof ValidationError) {
    // A message this system built failed the transport's own normalization: content, addresses, headers.
    // Retrying the identical message cannot help (§5.8 "malformed content" is permanent).
    return { kind: "permanent", reasonCode: "MESSAGE_INVALID" };
  }
  const code = errorCodeOf(error);
  const reasonCode = REASON_CODE_BY_TRANSPORT_CODE[code] ?? "PROVIDER_FAILED";
  if (PERMANENT_CODES.has(code)) return { kind: "permanent", reasonCode };
  if (UNKNOWN_SUBMISSION_CODES.has(code)) return { kind: "unknown_submission", reasonCode: "SUBMISSION_UNKNOWN" };
  // The kernel already classifies SMTP failures (`classifySmtpError`); marketing names the retryable arm
  // of the same decision rather than keeping a second list of codes.
  return { kind: classifySmtpError(error) === "transient" ? "retryable" : "permanent", reasonCode };
}

function errorCodeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** A short, operator-safe sentence. The provider's own text stays in the provider's logs, not in our API. */
function failureMessage(kind: MarketingProviderErrorKind, reasonCode: string): string {
  switch (kind) {
    case "retryable":
      return `The provider did not accept the message and this is worth retrying (${reasonCode}).`;
    case "permanent":
      return `The provider will not accept this message; change the configuration or the content (${reasonCode}).`;
    case "unknown_submission":
      return `The provider connection failed while the message was being submitted, so its state is unknown (${reasonCode}). Do not resend until it has been reconciled.`;
  }
}

function toFailure(error: unknown): MarketingProviderError {
  const { kind, reasonCode } = classifyMarketingProviderFailure(error);
  // Only our own validation sentence is repeated verbatim (it was written for an operator and contains no
  // provider transcript); every transport failure becomes a fixed sentence plus a stable code.
  const detail = error instanceof ValidationError ? error.message : failureMessage(kind, reasonCode);
  return new MarketingProviderError(detail, kind, reasonCode);
}

/**
 * Which identity this message is sent as. A caller that names a sending account does not have to know its
 * address (the platform keeps that administrator-only), so the account's own transport supplies it; the
 * deployment transport is the last resort.
 */
function resolveFrom(message: MarketingProviderMessage, transport: MailTransport): { name: string | null; address: string } {
  const explicit = message.fromAddress?.trim();
  if (explicit !== undefined && explicit !== "") return { name: message.fromName ?? null, address: explicit };
  const own = transport.info.fromAddress?.trim() ?? "";
  if (own !== "") return { name: message.fromName ?? null, address: own };
  throw new MarketingProviderError(
    "No sender address is configured for this provider, so the message has no From identity.",
    "permanent",
    "NO_SENDER",
  );
}

/** The provider-neutral message as the mail port's accepted input shape. */
function toMailInput(
  message: MarketingProviderMessage,
  from: { readonly name: string | null; readonly address: string },
): MailMessageInput {
  return {
    from: { name: from.name, address: from.address },
    to: [...message.to],
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
    ...(message.attachments !== undefined
      ? {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: attachment.content,
            ...(attachment.cid !== undefined ? { cid: attachment.cid } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Map the transport's per-recipient report back onto the marketing receipts. One message carries several
 * recipients and a transport may accept some and reject others, which is exactly why §6.5 keeps a
 * per-recipient decision rather than a per-batch one.
 */
function toProviderResult(
  key: string,
  message: MarketingProviderMessage,
  result: SendResult,
): MarketingProviderResult {
  const reported = new Map(result.recipients.map((recipient) => [recipient.address.toLowerCase(), recipient]));
  const receipts = message.to.map<MarketingProviderReceipt>((recipient) => {
    const entry = reported.get(recipient.trim().toLowerCase());
    if (entry === undefined) return { recipient, status: "skipped", reasonCode: "NOT_REPORTED" };
    if (entry.status === "accepted") {
      return { recipient, status: "accepted", providerMessageId: result.messageId };
    }
    if (entry.status === "rejected") return { recipient, status: "rejected", reasonCode: "PROVIDER_REJECTED" };
    return { recipient, status: "skipped", reasonCode: "TRANSPORT_DISABLED" };
  });
  const accepted = receipts.some((receipt) => receipt.status === "accepted");
  return {
    key,
    accepted,
    ...(accepted ? { providerMessageId: result.messageId } : {}),
    receipts,
  };
}

/**
 * The adapter itself. `accounts` is injected (not constructed) so the platform's only credential store is
 * read through its own service — marketing never touches `smtp_password_encrypted` (§9.4).
 */
export class KernelMailMarketingProvider implements MarketingProviderAdapter {
  constructor(
    private readonly transport: MailTransport,
    private readonly accounts: EmailAccountsService,
  ) {}

  get info(): MarketingProviderInfo {
    const info = this.transport.info;
    return {
      key: KERNEL_MAIL_PROVIDER_KEY,
      label: `Kernel mail transport (${info.name})`,
      // The transport owns the truth: `none` and `memory` are deliberately not delivering, so a campaign is
      // never started against them (§15 `19-MA.7` acceptance, §1.2).
      mode: info.mode === "live" ? "live" : "disabled",
      maxRecipients: Math.max(1, info.maxRecipients),
      // The SMTP configuration publishes no quota, so the deployment's own limit is the only ceiling
      // (settings `provider.limits`) — never a number invented here (§13).
      ratePerMinute: 0,
      maxConcurrency: 1,
      fromAddress: info.fromAddress,
      reportsEvents: false,
      supportsTestSend: true,
    };
  }

  /** Cheap shape/address validation before anything is persisted or queued, with no network call. */
  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
    try {
      // Only the addresses the caller actually supplied: a missing From is resolved from the sending account
      // inside `send`, and parsing a placeholder here would validate a value that is never used.
      for (const value of [...(message.fromAddress !== undefined ? [message.fromAddress] : []), ...message.to]) {
        parseAddress(value);
      }
    } catch (error) {
      throw toFailure(error);
    }
  }

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    try {
      const transport = await this.transportFor(message);
      const result = await transport.send(toMailInput(message, resolveFrom(message, transport)));
      return toProviderResult(this.info.key, message, result);
    } catch (error) {
      throw toFailure(error);
    }
  }

  async verify(): Promise<void> {
    try {
      await this.transport.verify();
    } catch (error) {
      throw toFailure(error);
    }
  }

  /**
   * The configured deployment transport, or the sending mailbox's own SMTP settings when the message names
   * one. A missing/inactive account or an unusable security mode is a *permanent* configuration failure,
   * which `toFailure` reports without exposing the credential that was or was not read.
   */
  private async transportFor(message: MarketingProviderMessage): Promise<MailTransport> {
    const accountId = message.senderAccountId?.trim();
    if (accountId === undefined || accountId === "") return this.transport;
    try {
      return createAccountSmtpTransport(await this.accounts.resolveTransportConfig(accountId));
    } catch (error) {
      // `resolveTransportConfig` raises its own domain errors (unknown account, encrypted-credential
      // refusal). Both are permanent and both name a different fix than "the message is malformed", so
      // they get their own reason code instead of being flattened into MESSAGE_INVALID.
      if (error instanceof AppError) {
        throw new MarketingProviderError(error.message, "permanent", "SENDER_ACCOUNT_INVALID");
      }
      throw error;
    }
  }
}

/** Built at bootstrap by `MarketingProviderBindingService`; kept here so the registry stays provider-neutral. */
export function createKernelMailProvider(
  transport: MailTransport,
  accounts: EmailAccountsService,
): MarketingProviderAdapter {
  return new KernelMailMarketingProvider(transport, accounts);
}
