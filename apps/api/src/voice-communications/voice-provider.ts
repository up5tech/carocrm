import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";

import {
  type CallState,
  type CommunicationErrorCategory,
  mapCallStatus,
  mapMessageStatus,
  type MessageChannel,
  type MessageState,
  type ProviderCapability,
  type ProviderEventKind,
  stableStringify,
  type VoiceChannel,
} from "./voice-communications-domain.js";

/**
 * Phase 19-VC.4 — the provider adapter contract, the registry and the simulator
 * (`PLAN_Phase_19_Voice_Communications.md` §6.1–§6.3, §15 `19-VC.4`).
 *
 * The domain must not depend on one vendor's API (§1.2 "provider-neutral domain"), so a provider is
 * named by exactly this interface and nothing else in the module may know a vendor exists. This
 * phase delivers the **contract**, the **simulator** and the **disabled** adapter; a production
 * adapter is added in 19-VC.10/11 and is **registered**, never hard-wired.
 *
 * Two rules the rest of the module relies on:
 *  - `mode` is `'live' | 'simulator' | 'disabled'`. A simulator never contacts a network; a disabled
 *    adapter never claims anything happened.
 *  - A webhook is validated by the adapter that owns the provider's signature scheme. The ingress
 *    never implements a vendor signature itself (§11.4 "do not invent a signature algorithm").
 */

export type VoiceProviderMode = "live" | "simulator" | "disabled";

export type WebhookSignatureScheme = "hmac-sha256-canonical-json" | "provider-specific" | "none";

export interface VoiceProviderInfo {
  readonly key: string;
  /** Operator-facing name for capability screens and diagnostics; never a credential. */
  readonly label: string;
  readonly mode: VoiceProviderMode;
  /** Exactly the capabilities this adapter implements (§6.1). Missing means not-implemented. */
  readonly capabilities: readonly ProviderCapability[];
  /** Channels this adapter can carry at all; the capability list is the finer-grained truth. */
  readonly channels: readonly VoiceChannel[];
  /** Messages per minute the provider accepts; `0` means it publishes no limit. */
  readonly ratePerMinute: number;
  /** Simultaneous requests this adapter tolerates; `0` means the caller imposes no local ceiling. */
  readonly maxConcurrency: number;
  /** How `validateWebhook` authenticates a callback, so the admin screen can explain setup. */
  readonly webhookSignature: WebhookSignatureScheme;
}

/** The account, decrypted in memory for one operation. Never logged, persisted or returned. */
export interface ResolvedProviderAccount {
  readonly key: string;
  readonly providerKey: string;
  readonly label: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly capabilities: readonly ProviderCapability[];
  readonly config: Readonly<Record<string, unknown>>;
  /** Provider API credential, or null when the account needs none (the simulator). */
  readonly secret: string | null;
  /** The secret this account's callbacks are signed with, or null when none is configured. */
  readonly webhookSecret: string | null;
}

export interface ProviderWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Record<string, unknown>;
  /** Present only when a raw-body capture is configured; a provider that signs exact bytes needs it. */
  readonly rawBody?: string | undefined;
}

/** What an adapter produces after it has authenticated a callback and read its own fields. */
export interface ValidatedProviderEvent {
  /** The provider's own event id, when it has one. Used as the idempotency key (§5.3). */
  readonly providerEventId: string | null;
  /** The provider's event type, kept for diagnostics; never interpreted by the domain. */
  readonly eventType: string;
  readonly kind: ProviderEventKind;
  /** ISO timestamp the event occurred, when the provider supplies one. */
  readonly occurredAt: string | null;
  /** The provider call/message id the event refers to. */
  readonly externalId: string | null;
  /** The provider's own status token, preserved for troubleshooting. */
  readonly vendorStatus: string | null;
  /** The authenticated payload, redacted by the ingress before persistence. */
  readonly payload: Record<string, unknown>;
}

export interface NormalizedCallEvent {
  readonly kind: "call";
  readonly providerCallId: string;
  readonly state: CallState;
  readonly direction: "inbound" | "outbound";
  readonly from: string | null;
  readonly to: string | null;
  readonly occurredAt: string | null;
  readonly durationSeconds: number | null;
  readonly failureCategory: CommunicationErrorCategory | null;
  readonly vendorStatus: string | null;
}

export interface NormalizedMessageEvent {
  readonly kind: "message";
  readonly providerMessageId: string | null;
  readonly state: MessageState;
  readonly direction: "inbound" | "outbound";
  readonly channel: MessageChannel;
  readonly from: string | null;
  readonly to: string | null;
  readonly body: string | null;
  readonly occurredAt: string | null;
  readonly failureCategory: CommunicationErrorCategory | null;
  readonly vendorStatus: string | null;
}

export interface NormalizedStatusEvent {
  readonly kind: "status";
  readonly externalId: string | null;
  readonly state: CallState | MessageState;
  readonly occurredAt: string | null;
  readonly failureCategory: CommunicationErrorCategory | null;
  readonly vendorStatus: string | null;
}

/** 19-VC.15 — a recording became available for a call. The URL is never trusted blindly. */
export interface NormalizedRecordingEvent {
  readonly kind: "recording";
  readonly providerCallId: string | null;
  readonly providerRef: string | null;
  /** The provider's media URL. Held for validation; never fetched without a policy check. */
  readonly url: string | null;
  readonly durationSeconds: number | null;
  readonly mimeType: string | null;
  readonly occurredAt: string | null;
}

export interface NormalizedUnknownEvent {
  readonly kind: "unknown";
  readonly reason: string;
  readonly occurredAt: string | null;
}

export type NormalizedProviderEvent =
  | NormalizedCallEvent
  | NormalizedMessageEvent
  | NormalizedStatusEvent
  | NormalizedRecordingEvent
  | NormalizedUnknownEvent;

export interface ProviderHealthResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  /** Operator-safe sentence; never a credential, a request body or a raw provider response. */
  readonly detail: string;
}

/** A call the module asks a provider to place (§7.1). */
export interface InitiateCallInput {
  readonly account: ResolvedProviderAccount;
  /** The caller id / source endpoint address, when one is configured. */
  readonly from: string | null;
  /** Destination number in E.164. */
  readonly to: string;
  /** Client-generated key so a duplicate click cannot place a second call. */
  readonly idempotencyKey: string;
}

export interface InitiateCallResult {
  readonly providerCallId: string | null;
  readonly accepted: boolean;
  /** The state the provider itself reports; the domain never rounds it up. */
  readonly state: CallState;
  readonly errorCategory?: CommunicationErrorCategory | undefined;
  readonly error?: string | undefined;
}

/** A message the module asks a provider to deliver (§8.1). */
export interface SendMessageInput {
  readonly account: ResolvedProviderAccount;
  readonly conversationId: string;
  readonly messageId: string;
  readonly to: string;
  readonly body: string;
  readonly channel: MessageChannel;
  readonly idempotencyKey: string;
  readonly fromAddress?: string | null | undefined;
  readonly media?: readonly SendMessageMedia[] | undefined;
  readonly templateKey?: string | null | undefined;
  readonly templateLanguage?: string | null | undefined;
  readonly templateVariables?: Readonly<Record<string, string>> | null | undefined;
}

export interface SendMessageMedia {
  /** The internal storage reference (an attachment id), never a raw provider URL. */
  readonly storageRef: string;
  readonly contentType: string;
  readonly filename: string;
  readonly sizeBytes?: number | undefined;
}

export interface SendMessageResult {
  readonly providerMessageId: string | null;
  readonly accepted: boolean;
  /** `queued` when the provider accepted but has not reported delivery; never `delivered`. */
  readonly state: MessageState;
  readonly errorCategory?: CommunicationErrorCategory | undefined;
  readonly error?: string | undefined;
}

/** A capability the adapter declares but the account has not been granted is still refused server-side. */
export function effectiveCapabilities(
  info: VoiceProviderInfo,
  accountCapabilities: readonly ProviderCapability[],
): readonly ProviderCapability[] {
  const granted = new Set(accountCapabilities);
  return info.capabilities.filter((capability) => granted.has(capability));
}

/**
 * The only error type crossing the adapter boundary. The message is safe to return to an
 * administrator: it names the category and the provider status, never the credential, the request
 * body or the raw provider response.
 */
export class VoiceProviderError extends Error {
  readonly category: CommunicationErrorCategory;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    category: CommunicationErrorCategory,
    message: string,
    options: { readonly status?: number | null | undefined } = {},
  ) {
    super(message);
    this.name = "VoiceProviderError";
    this.category = category;
    this.retryable = category === "rate_limit" || category === "timeout" || category === "provider_unavailable";
    this.status = options.status ?? null;
  }
}

export function categorizeHttpStatus(status: number): CommunicationErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

/** Header names a provider may use for its signature. An adapter reads only what its vendor documents. */
export const SIGNATURE_HEADERS = ["x-webhook-signature", "x-voice-signature", "x-signature"] as const;
export const TIMESTAMP_HEADERS = ["x-webhook-timestamp", "x-voice-timestamp"] as const;

export function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * The simulator. Deterministic, in-memory, no socket — §15 `19-VC.4` acceptance ("fake adapter never
 * contacts external services").
 *
 * Webhook authentication is HMAC-SHA256 over `timestamp + "." + canonical JSON`, compared in
 * constant time. The canonical form is sorted-key JSON because Fastify hands the controller a parsed
 * body, not the raw bytes; a provider that signs exact bytes must supply `rawBody` and its adapter
 * must use it (recorded as a limitation in `docs/compatibility/voice-communications.md`).
 *
 * Payload shape (documented so a test and an operator can produce one):
 * ```json
 * { "eventId": "evt-1", "type": "call.status", "occurredAt": "2026-01-01T00:00:00Z",
 *   "callId": "CA1", "status": "ringing", "direction": "inbound",
 *   "from": "+14155550100", "to": "+14155550199" }
 * ```
 * `type` is one of `call.status`, `call.inbound`, `message.inbound`, `message.status`.
 */
export class FakeVoiceProvider implements VoiceProviderAdapter {
  readonly info: VoiceProviderInfo = {
    key: "fake",
    label: "Simulator (in-memory)",
    mode: "simulator",
    capabilities: [
      "voice.outboundCall",
      "voice.inboundEvents",
      "voice.callStatusCallbacks",
      "messaging.sms.send",
      "messaging.sms.receive",
      "messaging.whatsapp.send",
      "messaging.whatsapp.receive",
      "messaging.deliveryStatus",
      "messaging.templates",
      "webhook.signatureValidation",
      "provider.healthCheck",
    ],
    channels: ["voice", "sms", "whatsapp"],
    ratePerMinute: 0,
    maxConcurrency: 1,
    webhookSignature: "hmac-sha256-canonical-json",
  };

  hasCapability(capability: ProviderCapability): boolean {
    return this.info.capabilities.includes(capability);
  }

  async validateWebhook(request: ProviderWebhookRequest, account: ResolvedProviderAccount): Promise<ValidatedProviderEvent> {
    const signature = headerValue(request.headers, SIGNATURE_HEADERS);
    const timestamp = headerValue(request.headers, TIMESTAMP_HEADERS);
    if (account.webhookSecret === null || account.webhookSecret.trim() === "") {
      // Fail closed: with no configured secret there is nothing to verify against (§13.2).
      throw new VoiceProviderError("auth", "This account has no webhook secret, so no callback can be authenticated.");
    }
    if (signature === undefined) throw new VoiceProviderError("auth", "The callback carries no signature.");
    if (timestamp === undefined) throw new VoiceProviderError("auth", "The callback carries no timestamp.");

    const expected = signFakeWebhook(account.webhookSecret, timestamp, request.body);
    if (!constantTimeEqual(signature, expected)) {
      throw new VoiceProviderError("auth", "The callback signature is not valid for this account.");
    }

    const eventType = stringOf(request.body["type"]) ?? "unknown";
    const kind: ProviderEventKind =
      eventType === "call.recording"
        ? "recording"
        : eventType.startsWith("call.")
          ? "call"
          : eventType.startsWith("message.")
            ? "message"
            : "unknown";
    const externalId = stringOf(request.body["callId"]) ?? stringOf(request.body["messageId"]);
    return {
      providerEventId: stringOf(request.body["eventId"]),
      eventType,
      kind,
      occurredAt: stringOf(request.body["occurredAt"]),
      externalId,
      vendorStatus: stringOf(request.body["status"]),
      payload: request.body,
    };
  }

  normalizeEvent(event: ValidatedProviderEvent): NormalizedProviderEvent {
    const payload = event.payload;
    if (event.kind === "call") {
      const providerCallId = stringOf(payload["callId"]) ?? event.externalId;
      if (providerCallId === null) return { kind: "unknown", reason: "call event without a call id", occurredAt: event.occurredAt };
      const vendorStatus = event.vendorStatus ?? "unknown";
      const state = mapCallStatus(vendorStatus);
      return {
        kind: "call",
        providerCallId,
        state,
        direction: payload["direction"] === "inbound" ? "inbound" : "outbound",
        from: stringOf(payload["from"]),
        to: stringOf(payload["to"]),
        occurredAt: event.occurredAt,
        durationSeconds: numberOf(payload["durationSeconds"]),
        failureCategory: state === "failed" ? "unknown" : null,
        vendorStatus,
      };
    }
    if (event.kind === "message") {
      const inbound = event.eventType.endsWith(".inbound") || payload["direction"] === "inbound";
      const channel = (stringOf(payload["channel"]) ?? "sms") as MessageChannel;
      const vendorStatus = event.vendorStatus ?? (inbound ? "delivered" : "unknown");
      return {
        kind: "message",
        providerMessageId: stringOf(payload["messageId"]) ?? event.externalId,
        // An inbound message has arrived, which is the only delivery fact we can state about it.
        state: inbound ? "delivered" : mapMessageStatus(vendorStatus),
        direction: inbound ? "inbound" : "outbound",
        channel,
        from: stringOf(payload["from"]),
        to: stringOf(payload["to"]),
        body: stringOf(payload["body"]),
        occurredAt: event.occurredAt,
        failureCategory: null,
        vendorStatus,
      };
    }
    if (event.kind === "recording") {
      return {
        kind: "recording",
        providerCallId: stringOf(payload["callId"]),
        providerRef: stringOf(payload["recordingId"]),
        url: stringOf(payload["recordingUrl"]),
        durationSeconds: numberOf(payload["durationSeconds"]),
        mimeType: stringOf(payload["mimeType"]),
        occurredAt: event.occurredAt,
      };
    }
    return { kind: "unknown", reason: `unsupported event type "${event.eventType}"`, occurredAt: event.occurredAt };
  }

  async healthCheck(account: ResolvedProviderAccount): Promise<ProviderHealthResult> {
    // A scripted failure lets an operator (and a test) exercise the unhealthy path without a network.
    if (account.config["simulateUnhealthy"] === true) {
      throw new VoiceProviderError("provider_unavailable", "The simulator is configured to report itself unhealthy.");
    }
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      detail: "Simulator reachable; no network call was made.",
    };
  }

  /**
   * The simulator never dials a number. `sandboxRecipients` (account config) is an allowlist; when it
   * is set, a call or message to anything outside it is refused with `invalid_recipient`. An account
   * with no allowlist at all is a deployment mistake and is also refused — a simulator that could
   * reach a real phone would be a §15.4 violation ("no real calls or messages during tests").
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    this.assertScriptedOutage(input.account);
    this.assertSandboxRecipient(input.account, input.to);
    return {
      providerCallId: `CA-${simulatorId(input.idempotencyKey)}`,
      accepted: true,
      state: "initiated",
    };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.assertScriptedOutage(input.account);
    this.assertSandboxRecipient(input.account, input.to);
    if (input.templateKey !== null && input.templateKey !== undefined && input.templateKey.trim() !== "") {
      // A template send needs its variables; a missing body is legitimate for WhatsApp.
      if (input.templateVariables === null || input.templateVariables === undefined) {
        throw new VoiceProviderError("invalid_request", "A template send needs its variables.");
      }
    }
    return {
      providerMessageId: `SM-${simulatorId(input.idempotencyKey)}`,
      accepted: true,
      // Accepted by the provider; the domain must not claim delivery without a callback.
      state: "sent",
    };
  }

  /**
   * 19-VC.16 — the simulator returns a small canned transcript, so the transcription path can be
   * exercised end to end without a network or a speech vendor. An outage is honoured like every
   * other simulator operation.
   */
  async fetchTranscript(input: {
    readonly account: ResolvedProviderAccount;
    readonly providerRef: string | null;
  }): Promise<TranscriptFetchResult> {
    if (input.account.config["simulateOutage"] === true) {
      return { ok: false, language: null, segments: [], error: "The simulator is configured to fail its retrieval." };
    }
    return {
      ok: true,
      language: "en",
      segments: [
        { startMs: 0, endMs: 4_200, speaker: "agent", text: "Hello, this is Acme support. How can I help?" },
        { startMs: 4_800, endMs: 11_500, speaker: "customer", text: "I was charged twice for my September invoice." },
        { startMs: 12_000, endMs: 18_400, speaker: "agent", text: "I can see the duplicate charge and will request a refund today." },
      ],
    };
  }

  private assertScriptedOutage(account: ResolvedProviderAccount): void {
    if (account.config["simulateOutage"] === true) {
      throw new VoiceProviderError(
        "provider_unavailable",
        "The simulator is configured to fail its sends, which is how an unhealthy provider is exercised.",
      );
    }
  }

  private assertSandboxRecipient(account: ResolvedProviderAccount, to: string): void {
    const allowed = stringArray(account.config["sandboxRecipients"]);
    if (allowed.length === 0) {
      throw new VoiceProviderError(
        "invalid_recipient",
        "The simulator refuses every destination until the account configures sandboxRecipients.",
      );
    }
    if (!allowed.includes(to.trim())) {
      throw new VoiceProviderError(
        "invalid_recipient",
        "The simulator only accepts the allowlisted sandbox recipients this account names.",
      );
    }
  }
}

/** The bound adapter when an account names no provider or the provider is unknown. Every action refuses. */
export class DisabledVoiceProvider implements VoiceProviderAdapter {
  readonly info: VoiceProviderInfo = {
    key: "none",
    label: "No provider configured",
    mode: "disabled",
    capabilities: [],
    channels: [],
    ratePerMinute: 0,
    maxConcurrency: 1,
    webhookSignature: "none",
  };

  hasCapability(): boolean {
    return false;
  }

  async validateWebhook(): Promise<ValidatedProviderEvent> {
    throw new VoiceProviderError("provider_unavailable", "No provider adapter is configured for this account.");
  }

  normalizeEvent(): NormalizedProviderEvent {
    return { kind: "unknown", reason: "no provider adapter", occurredAt: null };
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    throw new VoiceProviderError("provider_unavailable", "No provider adapter is configured for this account.");
  }
}

export interface VoiceProviderAdapter {
  readonly info: VoiceProviderInfo;
  hasCapability(capability: ProviderCapability): boolean;
  validateWebhook(request: ProviderWebhookRequest, account: ResolvedProviderAccount): Promise<ValidatedProviderEvent>;
  normalizeEvent(event: ValidatedProviderEvent, account: ResolvedProviderAccount): NormalizedProviderEvent;
  healthCheck(account: ResolvedProviderAccount): Promise<ProviderHealthResult>;
  /** Absent when the adapter cannot place calls (`voice.outboundCall` not declared). */
  initiateCall?(input: InitiateCallInput): Promise<InitiateCallResult>;
  /** Absent when the adapter cannot send on this channel (`messaging.*.send` not declared). */
  sendMessage?(input: SendMessageInput): Promise<SendMessageResult>;
  /**
   * 19-VC.16 — retrieve an existing transcript from the provider. Absent when the adapter has no
   * transcript source; the module then reports the transcript as unavailable rather than inventing one.
   */
  fetchTranscript?(input: {
    readonly account: ResolvedProviderAccount;
    readonly providerRef: string | null;
  }): Promise<TranscriptFetchResult>;
}

/** 19-VC.16 — what a provider transcript retrieval produced. */
export interface TranscriptFetchResult {
  readonly ok: boolean;
  readonly language: string | null;
  /** Chronological segments with offsets and optional speaker labels, when the provider supplies them. */
  readonly segments: readonly { readonly startMs: number; readonly endMs: number | null; readonly speaker: string | null; readonly text: string }[];
  readonly error?: string | undefined;
}

/** Sign the simulator's documented payload. Exported so a test and the admin simulator use one rule. */
export function signFakeWebhook(secret: string, timestamp: string, body: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(`${timestamp}.${stableStringify(body)}`).digest("hex");
}

function constantTimeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  }
  return [];
}

/** A stable provider id per idempotency key, so a repeated dispatch resolves to the same call. */
function simulatorId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("base64url").slice(0, 22);
}

/**
 * Adapters are resolved by key, never constructed at a call site (§6.3). Resolution **fails closed
 * to `disabled`**: an unknown key, a typo in an account row or a provider that was removed yields
 * "nothing happens" plus a health warning, never a surprise live call.
 *
 * The simulator is reachable only outside production. A production deployment that mis-sets an
 * account to `fake` gets `disabled`, so a simulator can never be mistaken for a working provider.
 */
@Injectable()
export class VoiceProviderRegistry {
  private readonly disabled = new DisabledVoiceProvider();
  private readonly fake = new FakeVoiceProvider();
  private readonly custom = new Map<string, VoiceProviderAdapter>();

  resolve(key: string | undefined): VoiceProviderAdapter {
    const wanted = (key ?? "").trim();
    if (wanted === "" || wanted === this.disabled.info.key) return this.disabled;
    if (wanted === this.fake.info.key) {
      return process.env.NODE_ENV === "production" ? this.disabled : this.fake;
    }
    return this.custom.get(wanted) ?? this.disabled;
  }

  /** Registration point for a production adapter and for tests that need a scripted provider. */
  register(adapter: VoiceProviderAdapter): void {
    this.custom.set(adapter.info.key, adapter);
  }

  has(key: string): boolean {
    return this.keys().includes(key.trim());
  }

  keys(): string[] {
    return [this.disabled.info.key, this.fake.info.key, ...this.custom.keys()];
  }

  /** Capability metadata for the diagnostics screen — never credentials. */
  describeAll(): readonly VoiceProviderInfo[] {
    return [this.disabled.info, this.fake.info, ...[...this.custom.values()].map((adapter) => adapter.info)];
  }

  /** The simulator instance a test can hold, so it asserts against the same object the module uses. */
  simulator(): FakeVoiceProvider {
    return this.fake;
  }
}
