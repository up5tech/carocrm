import { Inject, Injectable } from "@nestjs/common";

import { type AppConfig,CONFIG_TOKEN } from "../config.js";

/**
 * Phase 19-MA.2 — the provider adapter contract and the fake (§15 `19-MA.2` task 3, §5.8, §6.5, §7.1
 * `MarketingProviderAdapter` / `MarketingProviderRegistry`).
 *
 * The domain must not depend on one vendor's API (§1.2 "provider-independent domain model"), so a sending
 * provider is named by exactly this interface and nothing else in the module may know a provider exists.
 * This phase delivers the **contract** and a **fake**; the kernel-mail-backed live adapter is `19-MA.7`,
 * and the module deliberately refuses to send while no live adapter is bound (§1.2 "safe by default")
 * rather than quietly falling back to something that reaches the network.
 *
 * Two contracts the rest of the module relies on:
 *  - `mode` is `'live' | 'disabled'` — a disabled adapter never claims to have sent anything, mirroring the
 *    platform's own `MailTransport.mode` (`packages/mail/src/message/index.ts:66`).
 *  - a receipt is **per recipient**. A provider that accepts a batch still rejects individual addresses, and
 *    the campaign's eligibility decisions must be recorded per person (§5.3, §6.5), not per batch.
 */

export type MarketingProviderMode = "live" | "disabled";

export interface MarketingProviderInfo {
  readonly key: string;
  readonly mode: MarketingProviderMode;
  /** Highest recipient count one `send` call may carry; the caller chunks to this (§5.5, §11.2). */
  readonly maxRecipients: number;
  /** Messages per minute the provider will accept; `0` means the provider publishes no limit. */
  readonly ratePerMinute: number;
  /** Whether this adapter reports delivery/bounce/complaint feedback (webhooks, MA.10). */
  readonly reportsEvents: boolean;
}

export interface MarketingProviderAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  /** Content id for an inline asset; absent for a plain attachment. */
  readonly cid?: string;
}

export interface MarketingProviderMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly fromAddress: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  /** Extra transport headers, e.g. `List-Unsubscribe`. Values are validated, never trusted (§9.4). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly MarketingProviderAttachment[];
  /**
   * The marketing-side idempotency key (§0.1 rule 10). An adapter must treat a repeat of the same key as
   * the same message and must not deliver twice; the fake asserts this so a live adapter cannot forget it.
   */
  readonly idempotencyKey: string;
}

export type MarketingReceiptStatus = "accepted" | "rejected" | "skipped";

export interface MarketingProviderReceipt {
  readonly recipient: string;
  readonly status: MarketingReceiptStatus;
  readonly providerMessageId?: string;
  /** Stable reason code when not accepted; never a raw provider error body (§9.3, §7.4). */
  readonly reasonCode?: string;
}

export interface MarketingProviderResult {
  readonly key: string;
  readonly accepted: boolean;
  readonly providerMessageId?: string;
  readonly receipts: readonly MarketingProviderReceipt[];
  /** Classified so the retry policy can decide: transient is worth another attempt, permanent is not (§5.8). */
  readonly errorKind?: "transient" | "permanent";
  readonly error?: string;
}

export interface MarketingProviderAdapter {
  readonly info: MarketingProviderInfo;
  /** Cheap shape/address validation before anything is persisted or queued. */
  validate(message: MarketingProviderMessage): void;
  send(message: MarketingProviderMessage): Promise<MarketingProviderResult>;
  /** Connectivity check with no message sent; used by the health endpoint and MA.7's test send. */
  verify(): Promise<void>;
}

/** Errors an adapter raises; the message is operator-safe and never contains a secret or a body. */
export class MarketingProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "permanent",
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = "MarketingProviderError";
  }
}

const MAX_FILENAME_LENGTH = 255;

/** Shared precondition checks so no adapter implementation has to re-derive them (§7.4). */
export function assertProviderMessage(message: MarketingProviderMessage): void {
  if (message.to.length === 0) {
    throw new MarketingProviderError("A provider message needs at least one recipient.", "permanent", "NO_RECIPIENT");
  }
  if (message.idempotencyKey.trim() === "") {
    throw new MarketingProviderError("A provider message needs an idempotency key.", "permanent", "NO_IDEMPOTENCY_KEY");
  }
  if (message.fromAddress.trim() === "") {
    throw new MarketingProviderError("A provider message needs a sender address.", "permanent", "NO_SENDER");
  }
  if (message.subject.length > 998) {
    throw new MarketingProviderError("A message subject is too long.", "permanent", "SUBJECT_TOO_LONG");
  }
  // A CRLF inside a header value or address is a transport-injection vector, refused before any adapter
  // sees it — the same rule the platform mail layer applies (`packages/mail/src/message/index.ts:132`).
  for (const value of [...message.to, message.fromAddress, message.replyTo ?? ""]) {
    if (/[\r\n]/.test(value)) {
      throw new MarketingProviderError("A message address contains an illegal character.", "permanent", "ADDRESS_INJECTION");
    }
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (/[\r\n]/.test(`${name}${value}`)) {
      throw new MarketingProviderError("A message header contains an illegal character.", "permanent", "HEADER_INJECTION");
    }
  }
  for (const attachment of message.attachments ?? []) {
    if (attachment.filename.length > MAX_FILENAME_LENGTH) {
      throw new MarketingProviderError("An attachment filename is too long.", "permanent", "FILENAME_TOO_LONG");
    }
  }
}

/**
 * The test adapter. Deterministic, in-memory, no socket — §15 `19-MA.2` acceptance ("Provider adapter can be
 * faked without network calls"). Address keywords drive the outcome so a test can ask for each result
 * without stubbing internals:
 *
 *  - `hardbounce@…`  → rejected with `HARD_BOUNCE` (a permanent suppression trigger, §5.3 invariant 8)
 *  - `unknown@…`     → rejected with `UNKNOWN_USER`
 *  - anything else   → accepted, with a stable per-recipient provider message id.
 *
 * A repeated `idempotencyKey` returns the recorded first result and does not append a message, which is the
 * behaviour every real adapter must have (§0.1 rule 10).
 */
export class FakeMarketingProvider implements MarketingProviderAdapter {
  readonly sent: MarketingProviderMessage[] = [];
  private readonly byKey = new Map<string, MarketingProviderResult>();

  constructor(
    readonly info: MarketingProviderInfo = {
      key: "fake",
      mode: "disabled",
      maxRecipients: 50,
      ratePerMinute: 0,
      reportsEvents: true,
    },
  ) {}

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    const prior = this.byKey.get(message.idempotencyKey);
    if (prior !== undefined) return prior;

    this.sent.push(message);
    const receipts = message.to.map<MarketingProviderReceipt>((recipient) => {
      const address = recipient.toLowerCase();
      if (address.startsWith("hardbounce@")) {
        return { recipient, status: "rejected", reasonCode: "HARD_BOUNCE" };
      }
      if (address.startsWith("unknown@")) {
        return { recipient, status: "rejected", reasonCode: "UNKNOWN_USER" };
      }
      return {
        recipient,
        status: "accepted",
        providerMessageId: `fake-${Buffer.from(`${message.idempotencyKey}:${address}`).toString("base64url")}`,
      };
    });
    const accepted = receipts.filter((receipt) => receipt.status === "accepted");
    const result: MarketingProviderResult = {
      key: this.info.key,
      accepted: accepted.length > 0,
      receipts,
      ...(accepted.length > 0 && accepted[0]?.providerMessageId !== undefined
        ? { providerMessageId: accepted[0].providerMessageId }
        : {}),
    };
    this.byKey.set(message.idempotencyKey, result);
    return result;
  }

  async verify(): Promise<void> {
    // Nothing to reach: the fake is always reachable, which is exactly why tests use it.
  }

  reset(): void {
    this.sent.length = 0;
    this.byKey.clear();
  }
}

/**
 * The bound adapter when no provider is configured. `mode: 'disabled'` and every send refuses, mirroring
 * the platform's `DisabledTransport`: an unconfigured deployment must not pretend a campaign went out.
 */
export class DisabledMarketingProvider implements MarketingProviderAdapter {
  readonly info: MarketingProviderInfo = {
    key: "none",
    mode: "disabled",
    maxRecipients: 0,
    ratePerMinute: 0,
    reportsEvents: false,
  };

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    throw new MarketingProviderError(
      "No marketing provider is configured, so nothing was sent. Configure one or enable the safe test adapter (phase 19-MA.7).",
      "permanent",
      "PROVIDER_NOT_CONFIGURED",
    );
  }

  async verify(): Promise<void> {
    throw new MarketingProviderError("No marketing provider is configured.", "permanent", "PROVIDER_NOT_CONFIGURED");
  }
}

/**
 * Adapters are resolved by key, never constructed at a call site, so MA.7 can add a live adapter without
 * any domain service changing (§7.1 `MarketingProviderRegistry`).
 *
 * Resolution **fails closed to `disabled`**: an unknown key, a typo in settings or a missing integration
 * yields "nothing will be sent" plus a health warning, never a surprise live send through whatever adapter
 * happened to be registered first.
 *
 * The fake is reachable only when the platform's own mail transport is `memory` — the existing, explicit
 * "this deployment is not attached to a real mail server" switch (`MAIL_TRANSPORT`, AGENTS.md §5.5). In any
 * other runtime a `fake` key resolves to `disabled`, so a mis-set provider key in production cannot produce
 * a provider that lies about delivery.
 */
@Injectable()
export class MarketingProviderRegistry {
  private readonly disabled = new DisabledMarketingProvider();
  private readonly fake = new FakeMarketingProvider();
  private readonly custom = new Map<string, MarketingProviderAdapter>();

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  resolve(key?: string | undefined): MarketingProviderAdapter {
    const wanted = (key ?? "").trim();
    if (wanted === "" || wanted === this.disabled.info.key) return this.disabled;
    if (wanted === this.fake.info.key) {
      return this.config.mailTransport === "memory" ? this.fake : this.disabled;
    }
    return this.custom.get(wanted) ?? this.disabled;
  }

  /** Registration point for MA.7's live adapter and for tests that need a scripted provider. */
  register(adapter: MarketingProviderAdapter): void {
    this.custom.set(adapter.info.key, adapter);
  }

  /** The adapter the fake resolves to in this runtime, so a test can hold the same instance the domain uses. */
  testAdapter(): FakeMarketingProvider {
    return this.fake;
  }

  keys(): string[] {
    return [this.disabled.info.key, this.fake.info.key, ...this.custom.keys()];
  }

  capabilities(): MarketingProviderInfo[] {
    return [this.disabled.info, this.fake.info, ...[...this.custom.values()].map((adapter) => adapter.info)];
  }
}
