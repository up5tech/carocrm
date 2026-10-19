import { createHash } from "node:crypto";

/**
 * Phase 19-VC.1 — pure Voice & Communications domain vocabulary and decisions
 * (`PLAN_Phase_19_Voice_Communications.md` §6.1, §7.3, §8.1, §9.2, §11.5, §15 `19-VC.1`).
 *
 * Everything here is a constant or a pure function: no Nest dependency, no database, no I/O, no
 * clock read outside an injected `now`. The adapter contract, the settings schema, the policy
 * service, the webhook processor and the unit tests read these same lists, so a state or an error
 * category added here reaches validation and persistence at once — never a second, drifting copy.
 *
 * Three rules from the plan shape the file:
 *  - **No silent success** (§1.2): every normalized state distinguishes requested, accepted,
 *    in progress, delivered/completed, failed and unknown. A missing callback never becomes
 *    "delivered".
 *  - **At-least-once webhooks** (§1.2): every event carries a deterministic dedup key, and state
 *    transitions are monotonic so an out-of-order callback cannot regress a terminal state.
 *  - **Provider-neutral** (§1.2): no vendor status string, SDK type or payload shape appears in the
 *    domain. Mapping tables live here; adapters call them.
 */

// ---------------------------------------------------------------------------
// Channels and capabilities (§6.1)
// ---------------------------------------------------------------------------

/** The interactive channels this module owns. Email is deliberately absent: it is the Email subsystem. */
export const VOICE_CHANNELS = ["voice", "sms", "mms", "whatsapp"] as const;
export type VoiceChannel = (typeof VOICE_CHANNELS)[number];

/** Channels that carry a message body. `voice` is a call, never a message. */
export const MESSAGE_CHANNELS = ["sms", "mms", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export function isVoiceChannel(value: string): value is VoiceChannel {
  return (VOICE_CHANNELS as readonly string[]).includes(value);
}

export function isMessageChannel(value: string): value is MessageChannel {
  return (MESSAGE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Adapter capability keys (§6.1). An adapter declares what it can do; the server still validates
 * every operation, and the UI hides what the declaration does not include. A missing key is
 * `not-implemented`, never "assume supported".
 */
export const PROVIDER_CAPABILITIES = [
  "voice.outboundCall",
  "voice.inboundEvents",
  "voice.callStatusCallbacks",
  "voice.recordingMetadata",
  "voice.recordingDownload",
  "messaging.sms.send",
  "messaging.sms.receive",
  "messaging.mms.send",
  "messaging.mms.receive",
  "messaging.whatsapp.send",
  "messaging.whatsapp.receive",
  "messaging.deliveryStatus",
  "messaging.templates",
  "messaging.media",
  "webhook.signatureValidation",
  "provider.healthCheck",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/**
 * Per-capability status (§6.3). `supported` is only ever set after the adapter and its end-to-end
 * behavior have passed the relevant tests (§16); `experimental` is honest about a simulator or an
 * unverified provider; `disabled` and `unhealthy` are runtime states.
 */
export const CAPABILITY_STATUSES = ["not-implemented", "experimental", "supported", "disabled", "unhealthy"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Capabilities a channel needs before the server will accept a send for it. */
export function sendCapabilityFor(channel: VoiceChannel): ProviderCapability | null {
  switch (channel) {
    case "voice":
      return "voice.outboundCall";
    case "sms":
      return "messaging.sms.send";
    case "mms":
      return "messaging.mms.send";
    case "whatsapp":
      return "messaging.whatsapp.send";
  }
}

export function receiveCapabilityFor(channel: VoiceChannel): ProviderCapability | null {
  switch (channel) {
    case "voice":
      return "voice.inboundEvents";
    case "sms":
      return "messaging.sms.receive";
    case "mms":
      return "messaging.mms.receive";
    case "whatsapp":
      return "messaging.whatsapp.receive";
  }
}

// ---------------------------------------------------------------------------
// Call state machine (§7.3)
// ---------------------------------------------------------------------------

/**
 * Normalized call states. `unknown` is the reconciliation state: a provider response we could not
 * classify must stay unknown rather than be rounded to success or failure.
 */
export const CALL_STATES = [
  "requested",
  "initiated",
  "ringing",
  "in_progress",
  "completed",
  "missed",
  "busy",
  "no_answer",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type CallState = (typeof CALL_STATES)[number];

/** States from which no further provider event may move the call (except `unknown` reconciliation). */
export const CALL_TERMINAL_STATES: readonly CallState[] = [
  "completed",
  "missed",
  "busy",
  "no_answer",
  "failed",
  "cancelled",
];

/**
 * Allowed forward transitions. A terminal state only accepts a correction from `unknown` (an
 * operator reconciliation), never a regression such as `completed → ringing` caused by a duplicate
 * or out-of-order callback.
 */
export const CALL_TRANSITIONS: Readonly<Record<CallState, readonly CallState[]>> = {
  requested: ["initiated", "ringing", "in_progress", "failed", "cancelled", "unknown"],
  initiated: ["ringing", "in_progress", "missed", "busy", "no_answer", "failed", "cancelled", "unknown"],
  ringing: ["in_progress", "missed", "busy", "no_answer", "failed", "cancelled", "unknown"],
  in_progress: ["completed", "failed", "cancelled", "unknown"],
  completed: [],
  missed: [],
  busy: [],
  no_answer: [],
  failed: [],
  cancelled: [],
  // Reconciliation may settle an unknown call into any outcome, but not back into an active state.
  unknown: ["completed", "missed", "busy", "no_answer", "failed", "cancelled"],
};

export function isCallTerminal(state: CallState): boolean {
  return CALL_TERMINAL_STATES.includes(state);
}

/** Whether `to` is a legal successor of `from`. Same-state repeats are idempotent and allowed. */
export function canTransitionCall(from: CallState, to: CallState): boolean {
  if (from === to) return true;
  return CALL_TRANSITIONS[from].includes(to);
}

/**
 * Vendor call-status mapping (§7.3 "do not force every provider state to fit an incorrect status").
 * Keys are lower-cased and punctuation-normalized by `normalizeStatusToken`. An unrecognized value
 * maps to `unknown`, never to `completed`.
 */
const CALL_STATUS_MAP: Readonly<Record<string, CallState>> = {
  queued: "requested",
  requested: "requested",
  initiating: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  answered: "in_progress",
  "in-call": "in_progress",
  completed: "completed",
  complete: "completed",
  ended: "completed",
  hangup: "completed",
  "call-ended": "completed",
  missed: "missed",
  "no-answer": "no_answer",
  noanswer: "no_answer",
  busy: "busy",
  failed: "failed",
  failure: "failed",
  error: "failed",
  canceled: "cancelled",
  cancelled: "cancelled",
  "call-cancelled": "cancelled",
};

export function normalizeStatusToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function mapCallStatus(raw: string): CallState {
  return CALL_STATUS_MAP[normalizeStatusToken(raw)] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Message state machine (§8.1)
// ---------------------------------------------------------------------------

/**
 * Normalized message states, in delivery order. `submitted` means the provider accepted the
 * request; `sent` means the provider reports it left its system; `delivered`/`read` require an
 * explicit callback. `unknown` covers an uncertain submission (a timeout after the request may
 * have been accepted) and must be reconciled before any retry.
 */
export const MESSAGE_STATES = [
  "draft",
  "queued",
  "submitted",
  "sent",
  "delivered",
  "read",
  "failed",
  "undelivered",
  "unknown",
] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * Monotonic rank. A callback may only move a message **forward**; a late "sent" arriving after
 * "delivered" is recorded as an event but does not regress the message (§8.1 "out-of-order delivery
 * updates"). `failed`/`undelivered` are terminal and rank above delivery on purpose: a provider that
 * first reported delivery and later a hard failure must not keep showing "delivered".
 */
const MESSAGE_STATE_RANK: Readonly<Record<MessageState, number>> = {
  draft: 0,
  queued: 1,
  submitted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  undelivered: 6,
  unknown: 1,
};

export function isMessageTerminal(state: MessageState): boolean {
  return state === "delivered" || state === "read" || state === "failed" || state === "undelivered";
}

/**
 * Resolve the next persisted state. Returns `current` when the incoming state would regress it.
 * `unknown` never overrides a known state; it only fills a draft/queued row.
 */
export function advanceMessageState(current: MessageState, incoming: MessageState): MessageState {
  if (incoming === "unknown" && current !== "draft" && current !== "queued") return current;
  if (incoming === "unknown") return "unknown";
  return MESSAGE_STATE_RANK[incoming] >= MESSAGE_STATE_RANK[current] ? incoming : current;
}

const MESSAGE_STATUS_MAP: Readonly<Record<string, MessageState>> = {
  accepted: "submitted",
  submitted: "submitted",
  queued: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  undelivered: "undelivered",
  rejected: "failed",
  expired: "undelivered",
  unknown: "unknown",
};

export function mapMessageStatus(raw: string): MessageState {
  return MESSAGE_STATUS_MAP[normalizeStatusToken(raw)] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Conversation states (§9.2)
// ---------------------------------------------------------------------------

/**
 * Conversation states are intentionally **separate from Case status** (§9.2). A conversation linked
 * to a Case never mutates the Case's workflow state.
 */
export const CONVERSATION_STATES = [
  "open",
  "pending_customer",
  "pending_internal",
  "resolved",
  "closed",
  "spam",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_TRANSITIONS: Readonly<Record<ConversationState, readonly ConversationState[]>> = {
  open: ["pending_customer", "pending_internal", "resolved", "closed", "spam"],
  pending_customer: ["open", "pending_internal", "resolved", "closed", "spam"],
  pending_internal: ["open", "pending_customer", "resolved", "closed", "spam"],
  resolved: ["open", "closed"],
  closed: ["open"],
  spam: ["open"],
};

export function canTransitionConversation(from: ConversationState, to: ConversationState): boolean {
  return from === to || CONVERSATION_TRANSITIONS[from].includes(to);
}

/** Inbound traffic reopens a resolved conversation; it does not reopen a deliberately closed/spam one. */
export function conversationStateAfterInbound(current: ConversationState): ConversationState {
  return current === "resolved" ? "open" : current;
}

// ---------------------------------------------------------------------------
// Normalized provider events and domain events (§11.5)
// ---------------------------------------------------------------------------

/**
 * What a validated provider event is about. `status` is a delivery/call-status callback for an
 * object that already exists; `call` and `message` create or update the object; `unknown` is
 * persisted for an operator to inspect rather than silently dropped.
 */
export const PROVIDER_EVENT_KINDS = ["call", "message", "status", "unknown"] as const;
export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

/**
 * Domain event names emitted on the platform bus. The plan's suggested hyphenated namespace
 * (`voice-communications.call.initiated`) is rejected by the platform's `EVENT_TYPE` regex, which
 * allows only `[A-Za-z0-9]` segments; `voiceCommunications.*` is the repository-consistent spelling
 * (the Customer Success precedent, `customerSuccess.health.statusChanged`).
 *
 * Events carry identifiers and minimal metadata only — never a message body or a recording URL.
 * A consumer reloads content through an authorization-aware service (§11.5).
 */
export const DOMAIN_EVENTS = [
  "voiceCommunications.call.initiated",
  "voiceCommunications.call.ringing",
  "voiceCommunications.call.answered",
  "voiceCommunications.call.completed",
  "voiceCommunications.call.missed",
  "voiceCommunications.call.failed",
  "voiceCommunications.message.received",
  "voiceCommunications.message.queued",
  "voiceCommunications.message.sent",
  "voiceCommunications.message.delivered",
  "voiceCommunications.message.failed",
  "voiceCommunications.conversation.assigned",
  "voiceCommunications.conversation.resolved",
  "voiceCommunications.recording.available",
  "voiceCommunications.transcript.completed",
] as const;
export type VoiceDomainEvent = (typeof DOMAIN_EVENTS)[number];

/** The event a call-state transition announces, if any. `unknown` announces nothing. */
export function callEventFor(state: CallState): VoiceDomainEvent | null {
  switch (state) {
    case "initiated":
      return "voiceCommunications.call.initiated";
    case "ringing":
      return "voiceCommunications.call.ringing";
    case "in_progress":
      return "voiceCommunications.call.answered";
    case "completed":
      return "voiceCommunications.call.completed";
    case "missed":
      return "voiceCommunications.call.missed";
    case "failed":
      return "voiceCommunications.call.failed";
    default:
      return null;
  }
}

/** The event a message-state transition announces, if any. */
export function messageEventFor(state: MessageState): VoiceDomainEvent | null {
  switch (state) {
    case "queued":
      return "voiceCommunications.message.queued";
    case "sent":
      return "voiceCommunications.message.sent";
    case "delivered":
      return "voiceCommunications.message.delivered";
    case "read":
      return "voiceCommunications.message.delivered";
    case "failed":
      return "voiceCommunications.message.failed";
    case "undelivered":
      return "voiceCommunications.message.failed";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Error categories (§7.3, §8.2, §13.6)
// ---------------------------------------------------------------------------

/**
 * Normalized failure categories. A vendor code is preserved in a safe detail field by the adapter;
 * the category is what policy and retry decisions read.
 */
export const COMMUNICATION_ERROR_CATEGORIES = [
  "auth",
  "rate_limit",
  "timeout",
  "invalid_request",
  "invalid_recipient",
  "consent_required",
  "suppressed",
  "template_required",
  "window_closed",
  "provider_unavailable",
  "invalid_response",
  "media_rejected",
  "unknown",
] as const;
export type CommunicationErrorCategory = (typeof COMMUNICATION_ERROR_CATEGORIES)[number];

const RETRYABLE_ERROR_CATEGORIES: ReadonlySet<CommunicationErrorCategory> = new Set([
  "rate_limit",
  "timeout",
  "provider_unavailable",
]);

/** Policy refusals are never retried: the recipient state must change first (§8.2). */
export function isRetryableError(category: CommunicationErrorCategory): boolean {
  return RETRYABLE_ERROR_CATEGORIES.has(category);
}

/** Operator-safe sentence per category; never a raw provider body or a credential. */
export function errorMessageFor(category: CommunicationErrorCategory): string {
  switch (category) {
    case "auth":
      return "The provider rejected the configured credential. Rotate it before retrying.";
    case "rate_limit":
      return "The provider rate-limited the request. Retry with backoff.";
    case "timeout":
      return "The provider request timed out. The outcome is uncertain and must be reconciled.";
    case "invalid_request":
      return "The provider rejected the request shape.";
    case "invalid_recipient":
      return "The recipient address is not valid for this channel.";
    case "consent_required":
      return "The recipient has not given consent for this channel and purpose.";
    case "suppressed":
      return "The recipient is opted out or suppressed for this channel.";
    case "template_required":
      return "This channel requires an approved template outside the service window.";
    case "window_closed":
      return "The channel's service window is closed for a free-form message.";
    case "provider_unavailable":
      return "The provider is unavailable. Retry later.";
    case "invalid_response":
      return "The provider returned a response this module could not interpret.";
    case "media_rejected":
      return "The media was rejected by size, type or scanning policy.";
    case "unknown":
      return "The provider request failed for an unknown reason.";
  }
}

// ---------------------------------------------------------------------------
// Webhook idempotency and replay (§5.3, §11.4, §13.2)
// ---------------------------------------------------------------------------

/** Accepted webhook timestamp skew, in milliseconds. Outside it an event is refused as a replay. */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Hard ceiling on a provider webhook body. A larger body is refused before parsing. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Deterministic dedup key. The provider's own event id wins; otherwise a stable digest of the
 * fields that identify the event is used, so a provider that resends an identical callback without
 * an id is still recorded once.
 */
export function webhookDedupKey(input: {
  readonly providerEventId?: string | null;
  readonly eventType: string;
  readonly externalId?: string | null;
  readonly occurredAt?: string | null;
}): string {
  const id = (input.providerEventId ?? "").trim();
  if (id !== "") return `id:${id}`;
  const material = [normalizeStatusToken(input.eventType), input.externalId ?? "", input.occurredAt ?? ""].join("|");
  return `digest:${createHash("sha256").update(material).digest("hex")}`;
}

/** A payload digest for diagnostics: enough to prove two receipts match, never the payload itself. */
export function payloadDigest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

/** Redact credential-like keys before a payload is persisted for troubleshooting (§13.2). */
export function redactPayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (/secret|token|password|signature|authorization|api[_-]?key/i.test(key)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Stable JSON (sorted keys) so a digest and a fake-adapter signature do not depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Data classification, retention and ACL (§5.2, §13.3)
// ---------------------------------------------------------------------------

/** Classification of each stored class, used by retention and export decisions. */
export const DATA_CLASSES = ["public", "internal", "confidential", "restricted"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const RETENTION_CLASSES = [
  "call-metadata",
  "message-body",
  "message-media",
  "call-recording",
  "transcript",
  "consent-evidence",
  "webhook-diagnostic",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/**
 * Which permission gates which object. Internal notes are readable only through the conversation
 * API and are structurally excluded from every adapter send path (§13.3). Recordings and
 * transcripts have their own permission so they are not implied by Contact visibility.
 */
export const ACL_MATRIX = {
  providerAccount: { entity: "VoiceProviderAccount", actions: ["read", "edit"] },
  endpoint: { entity: "VoiceEndpoint", actions: ["read", "edit"] },
  callSession: { entity: "Call", actions: ["read", "edit", "create"] },
  conversation: { entity: "CommunicationConversation", actions: ["read", "edit", "create"] },
  message: { entity: "CommunicationMessage", actions: ["read", "create"] },
  internalNote: { entity: "CommunicationMessage", actions: ["read", "create"] },
  recording: { entity: "CallRecording", actions: ["read"] },
  transcript: { entity: "CallTranscript", actions: ["read"] },
} as const;

/** The synthetic permissions the admin surface checks; no metadata entity owns them yet. */
export const ADMIN_PERMISSION_ENTITY = "VoiceProviderAccount";

// ---------------------------------------------------------------------------
// Channel policy refusal codes (§8.4)
// ---------------------------------------------------------------------------

/**
 * Every refusal names the rule that refused it, so a block is explainable rather than a bare 403
 * (§8.4 "explainable block reasons"). The order here is the order the policy service evaluates.
 */
export const POLICY_REFUSAL_CODES = [
  "channel_disabled",
  "account_missing",
  "account_disabled",
  "account_unhealthy",
  "capability_missing",
  "invalid_address",
  "consent_required",
  "suppressed",
  "quiet_hours",
  "template_required",
  "window_closed",
  "quota_exceeded",
  "payload_invalid",
] as const;
export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export function policyRefusalMessage(code: PolicyRefusalCode): string {
  switch (code) {
    case "channel_disabled":
      return "This channel is disabled in the Voice & Communications settings.";
    case "account_missing":
      return "No provider account is configured for this channel and none was named.";
    case "account_disabled":
      return "The provider account for this channel is disabled.";
    case "account_unhealthy":
      return "The provider account failed its last health check.";
    case "capability_missing":
      return "The provider adapter does not declare the capability this operation needs.";
    case "invalid_address":
      return "The recipient address is not a valid number for this channel.";
    case "consent_required":
      return "The recipient has not opted in to this channel and purpose.";
    case "suppressed":
      return "The recipient is suppressed or has opted out.";
    case "quiet_hours":
      return "The deployment's quiet hours do not permit a send at this time.";
    case "template_required":
      return "An approved template is required outside the service window.";
    case "window_closed":
      return "The service window is closed and no template was supplied.";
    case "quota_exceeded":
      return "The account's configured send quota is exhausted for this period.";
    case "payload_invalid":
      return "The message payload failed validation for this channel.";
  }
}

// ---------------------------------------------------------------------------
// WhatsApp service window (§8.3)
// ---------------------------------------------------------------------------

/** Default customer-service window, in hours, when the provider publishes one and settings are silent. */
export const DEFAULT_WHATSAPP_WINDOW_HOURS = 24;

/**
 * Whether a free-form WhatsApp message is allowed at `now`. Outside the window a template is
 * required. The window is derived from the last inbound customer message, never from a phone
 * number's mere existence (§8.3, §8.4).
 */
export function isWhatsAppWindowOpen(lastInboundAt: string | null, now: Date, windowHours = DEFAULT_WHATSAPP_WINDOW_HOURS): boolean {
  if (lastInboundAt === null) return false;
  const last = Date.parse(lastInboundAt);
  if (Number.isNaN(last)) return false;
  const elapsed = now.getTime() - last;
  return elapsed >= 0 && elapsed <= windowHours * 60 * 60 * 1000;
}
