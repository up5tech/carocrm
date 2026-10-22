import { createHash } from "node:crypto";

import {
  type CallState,
  COMMUNICATION_ERROR_CATEGORIES,
  type CommunicationErrorCategory,
  mapCallStatus,
  type ProviderEventKind,
  stableStringify,
} from "./voice-communications-domain.js";
import {
  type CallControlInput,
  type CallControlResult,
  type InitiateCallInput,
  type InitiateCallResult,
  type NormalizedProviderEvent,
  type ProviderHealthResult,
  type ProviderWebhookRequest,
  type ResolvedProviderAccount,
  type ValidatedProviderEvent,
  type VoiceProviderAdapter,
  VoiceProviderError,
  type VoiceProviderInfo,
} from "./voice-provider.js";
import {
  basicAuth,
  constantTimeEqual,
  signCanonicalWebhook,
} from "./voice-provider-crypto.js";
import { assertHttpUrl, requestVoiceProviderJson } from "./voice-provider-http.js";

/**
 * Asterisk adapter — outbound ARI control and a signed inbound-event bridge
 * (`PLAN_Phase_19_Voice_Communications.md` §6.3, §15 `19-VC.10`–`19-VC.11`).
 *
 * Asterisk is a PBX, not a SaaS with a webhook subscription. This adapter therefore has two halves:
 *
 *  - **Outbound**: Asterisk REST Interface (ARI) creates, answers and hangs up channels using the
 *    account credential (the ARI password) and `ariUsername`.
 *  - **Inbound**: a small deployment-side bridge subscribes to the ARI event WebSocket and POSTs the
 *    selected events to this module's webhook endpoint. The bridge signs the canonical JSON body with
 *    HMAC-SHA256, following the same rule as the simulator, so the ingress authenticates it without
 *    inventing an Asterisk-native signature that does not exist.
 *
 * The bridge is deliberately not embedded here: keeping a long-lived WebSocket inside an HTTP
 * adapter would own reconnects, backoff and event ordering outside the module's durable receipt
 * path. The documented contract is in `docs/modules/voice-communications/providers.md`.
 *
 * Account configuration:
 * ```json
 * {
 *   "ariUrl": "https://pbx.example.com:8089/ari",
 *   "ariUsername": "carocrm",
 *   "ariApp": "carocrm",
 *   "endpointTemplate": "PJSIP/{to}",
 *   "callerId": "+14155550100",
 *   "timeoutSeconds": 30,
 *   "allowInsecureHttp": false
 * }
 * ```
 * `credential` is the ARI password; `webhookSecret` signs bridge callbacks. `ariApp` must name the
 * Stasis application the bridge listens on.
 */
export class AsteriskProviderAdapter implements VoiceProviderAdapter {
  readonly info: VoiceProviderInfo = {
    key: "asterisk",
    label: "Asterisk (ARI + event bridge)",
    mode: "live",
    capabilities: [
      "voice.outboundCall",
      "voice.inboundEvents",
      "voice.callStatusCallbacks",
      "voice.callAnswer",
      "voice.callHangup",
      "webhook.signatureValidation",
      "provider.healthCheck",
    ],
    channels: ["voice"],
    ratePerMinute: 0,
    maxConcurrency: 4,
    webhookSignature: "hmac-sha256-canonical-json",
  };

  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: { readonly fetchImpl?: typeof fetch | undefined } = {}) {
    this.fetchImpl = options.fetchImpl;
  }

  hasCapability(capability: Parameters<VoiceProviderAdapter["hasCapability"]>[0]): boolean {
    return this.info.capabilities.includes(capability);
  }

  async validateWebhook(
    request: ProviderWebhookRequest,
    account: ResolvedProviderAccount,
  ): Promise<ValidatedProviderEvent> {
    if (account.webhookSecret === null || account.webhookSecret.trim() === "") {
      throw new VoiceProviderError("auth", "This Asterisk account has no bridge secret, so no callback can be authenticated.");
    }
    const signature = headerOf(request.headers, "x-voice-signature");
    const timestamp = headerOf(request.headers, "x-voice-timestamp");
    if (signature === undefined) throw new VoiceProviderError("auth", "The Asterisk bridge callback carries no signature.");
    if (timestamp === undefined) throw new VoiceProviderError("auth", "The Asterisk bridge callback carries no timestamp.");
    const expected = signCanonicalWebhook(account.webhookSecret, timestamp, request.body);
    if (!constantTimeEqual(signature, expected)) {
      throw new VoiceProviderError("auth", "The bridge signature is not valid for this Asterisk account.");
    }

    const eventType = canonicalEventType(request.body);
    const kind = kindOf(eventType, request.body);
    const externalId = callIdOf(request.body);
    const vendorStatus = statusOf(request.body);
    return {
      providerEventId: stringOf(request.body["eventId"]) ?? digestEvent(request.body),
      eventType,
      kind,
      occurredAt: isoOrNull(stringOf(request.body["occurredAt"]) ?? stringOf(request.body["timestamp"])),
      externalId,
      vendorStatus,
      payload: request.body,
    };
  }

  normalizeEvent(event: ValidatedProviderEvent, _account: ResolvedProviderAccount): NormalizedProviderEvent {
    if (event.kind === "recording") return normalizeRecording(event);
    if (event.kind !== "call") {
      return { kind: "unknown", reason: `unsupported Asterisk bridge event "${event.eventType}"`, occurredAt: occurredAtOf(event) };
    }
    const payload = event.payload;
    const channel = objectOf(payload["channel"]);
    const providerCallId = callIdOf(payload) ?? event.externalId;
    if (providerCallId === null) {
      return { kind: "unknown", reason: "Asterisk call event without a channel id", occurredAt: occurredAtOf(event) };
    }
    const ariType = ariTypeOf(payload);
    const explicit = statusOf(payload);
    const state = explicit === null ? stateForAri(ariType, channel, payload) : stateForStatus(explicit, ariType, channel, payload);
    const direction = (stringOf(payload["direction"]) ?? stringOf(channel?.["direction"]) ?? "").toLowerCase() === "outbound"
      ? "outbound"
      : "inbound";
    return {
      kind: "call",
      providerCallId,
      state,
      direction,
      from: stringOf(payload["from"]) ?? callerNumber(channel),
      to: stringOf(payload["to"]) ?? connectedNumber(channel),
      occurredAt: occurredAtOf(event),
      durationSeconds: numberValue(payload["durationSeconds"]),
      failureCategory: state === "failed" ? failureCategoryOf(payload) ?? "unknown" : null,
      vendorStatus: explicit ?? stringOf(channel?.["state"]) ?? stringOf(payload["cause"]) ?? event.vendorStatus,
    };
  }

  async healthCheck(account: ResolvedProviderAccount): Promise<ProviderHealthResult> {
    const { base } = ariConnection(account);
    await requestVoiceProviderJson({
      method: "GET",
      url: `${base}/asterisk/info`,
      service: "Asterisk ARI",
      headers: authHeaders(account),
      allowHttp: configBoolean(account, "allowInsecureHttp", false),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    return { ok: true, checkedAt: new Date().toISOString(), detail: "Asterisk ARI is reachable." };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const { base, app } = ariConnection(input.account);
    const template = configString(input.account, "endpointTemplate") ?? "PJSIP/{to}";
    if (!template.includes("{to}")) {
      throw new VoiceProviderError("invalid_request", "Asterisk endpointTemplate must contain the {to} placeholder.");
    }
    const endpoint = template.split("{to}").join(input.to);
    const params = new URLSearchParams({ endpoint, app });
    const callerId = input.from ?? configString(input.account, "callerId");
    if (callerId !== null) params.set("callerId", callerId);
    const timeout = numberValue(input.account.config["timeoutSeconds"]);
    if (timeout !== null && timeout > 0) params.set("timeout", String(Math.min(600, Math.round(timeout))));
    // A stable hint the bridge can read from StasisStart args; the CRM's own idempotency record
    // remains authoritative, because ARI has no idempotency key for channel creation.
    params.set("appArgs", `carocrm-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`);

    const result = await requestVoiceProviderJson({
      method: "POST",
      url: `${base}/channels?${params.toString()}`,
      service: "Asterisk ARI",
      headers: { ...authHeaders(input.account), "content-length": "0" },
      allowHttp: configBoolean(input.account, "allowInsecureHttp", false),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    const providerCallId = stringOf(result.data?.["id"]);
    if (providerCallId === null) {
      throw new VoiceProviderError("invalid_response", "Asterisk created no channel id for the call.");
    }
    const state = stateForOriginate(stringOf(result.data?.["state"]));
    return { providerCallId, accepted: true, state };
  }

  async controlCall(input: CallControlInput): Promise<CallControlResult> {
    const { base } = ariConnection(input.account);
    const channel = encodeURIComponent(input.providerCallId);
    if (input.action === "answer") {
      await requestVoiceProviderJson({
        method: "POST",
        url: `${base}/channels/${channel}/answer`,
        service: "Asterisk ARI",
        headers: { ...authHeaders(input.account), "content-length": "0" },
        allowHttp: configBoolean(input.account, "allowInsecureHttp", false),
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
      return { accepted: true, state: "in_progress" };
    }
    await requestVoiceProviderJson({
      method: "DELETE",
      url: `${base}/channels/${channel}`,
      service: "Asterisk ARI",
      headers: authHeaders(input.account),
      allowHttp: configBoolean(input.account, "allowInsecureHttp", false),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    return { accepted: true, state: "completed" };
  }
}

interface AriConnection {
  readonly base: string;
  readonly app: string;
}

function ariConnection(account: ResolvedProviderAccount): AriConnection {
  const raw = configString(account, "ariUrl");
  if (raw === null) throw new VoiceProviderError("invalid_request", "Asterisk needs ariUrl in the account config.");
  const allowHttp = configBoolean(account, "allowInsecureHttp", false);
  const url = assertHttpUrl(raw, { allowHttp });
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/ari") ? path : `${path}/ari`;
  return {
    base: url.toString().replace(/\/$/, ""),
    app: configString(account, "ariApp") ?? "carocrm",
  };
}

function authHeaders(account: ResolvedProviderAccount): Record<string, string> {
  if (account.secret === null || account.secret.trim() === "") {
    throw new VoiceProviderError("auth", `Asterisk account "${account.key}" has no ARI password configured.`);
  }
  return {
    authorization: basicAuth(configString(account, "ariUsername") ?? "carocrm", account.secret),
    accept: "application/json",
  };
}

function canonicalEventType(payload: Record<string, unknown>): string {
  const type = stringOf(payload["type"]) ?? "unknown";
  if (type.startsWith("call.")) return type;
  if (type === "RecordingStarted" || type === "RecordingFinished" || type === "RecordingFailed") {
    return "call.recording";
  }
  if (type === "StasisStart") return "call.inbound";
  if (type === "StasisEnd" || type === "ChannelStateChange" || type === "ChannelDestroyed" || type === "Dial") {
    return "call.status";
  }
  return "unknown";
}

function kindOf(eventType: string, payload: Record<string, unknown>): ProviderEventKind {
  if (eventType === "call.recording" || stringOf(payload["recordingUrl"]) !== null) return "recording";
  if (eventType.startsWith("call.")) return "call";
  return "unknown";
}

function ariTypeOf(payload: Record<string, unknown>): string {
  return stringOf(payload["ariType"]) ?? stringOf(payload["type"]) ?? "unknown";
}

function callIdOf(payload: Record<string, unknown>): string | null {
  const channel = objectOf(payload["channel"]);
  return stringOf(payload["callId"]) ?? stringOf(payload["channelId"]) ?? stringOf(channel?.["id"]);
}

function statusOf(payload: Record<string, unknown>): string | null {
  const channel = objectOf(payload["channel"]);
  return stringOf(payload["status"]) ?? stringOf(channel?.["state"]);
}

function stateForStatus(
  status: string,
  ariType: string,
  channel: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): CallState {
  const mapped = mapCallStatus(status);
  return mapped === "unknown" ? stateForAri(ariType, channel, payload) : mapped;
}

function stateForAri(
  type: string,
  channel: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): CallState {
  if (type === "Dial") return "ringing";
  if (type === "StasisEnd") return "completed";
  if (type === "StasisStart") {
    const state = (stringOf(channel?.["state"]) ?? "").toLowerCase();
    if (state === "ring" || state === "ringing") return "ringing";
    if (state === "up") return "in_progress";
    if (state === "down") return "initiated";
    return "initiated";
  }
  if (type === "ChannelStateChange") {
    const state = (stringOf(channel?.["state"]) ?? "").toLowerCase();
    if (state === "ring" || state === "ringing") return "ringing";
    if (state === "up") return "in_progress";
    if (state === "down") return causeState(payload) ?? "completed";
    return "unknown";
  }
  if (type === "ChannelDestroyed") return causeState(payload) ?? "unknown";
  return mapCallStatus(stringOf(channel?.["state"]) ?? "") === "unknown" ? "unknown" : mapCallStatus(stringOf(channel?.["state"]) ?? "");
}

function stateForOriginate(raw: string | null): CallState {
  if (raw === null) return "initiated";
  const state = raw.toLowerCase();
  if (state === "up") return "in_progress";
  if (state === "ring" || state === "ringing") return "ringing";
  return "initiated";
}

function causeState(payload: Record<string, unknown>): CallState | null {
  const raw = payload["cause"];
  const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : null;
  if (code === null || !Number.isFinite(code)) return null;
  // Q.931 causes as Asterisk reports them. 18/19/20 all mean the callee never answered, so they map
  // to the domain's `no_answer` instead of being collapsed into `cancelled` or `failed`. 21 is a
  // rejection, which the domain records as a cancellation. 0 is "unknown", not a failure.
  if (code === 0) return "unknown";
  if (code === 16 || code === 31) return "completed";
  if (code === 17) return "busy";
  if (code === 18 || code === 19 || code === 20) return "no_answer";
  if (code === 21) return "cancelled";
  return "failed";
}

function failureCategoryOf(payload: Record<string, unknown>): CommunicationErrorCategory | null {
  const explicit = stringOf(payload["failureCategory"]);
  if (explicit === null) return null;
  // Accept every category the domain defines; a narrower whitelist silently downgraded valid ones
  // such as `invalid_response` to `unknown`.
  return (COMMUNICATION_ERROR_CATEGORIES as readonly string[]).includes(explicit)
    ? (explicit as CommunicationErrorCategory)
    : null;
}

function normalizeRecording(event: ValidatedProviderEvent): NormalizedProviderEvent {
  const payload = event.payload;
  return {
    kind: "recording",
    providerCallId: callIdOf(payload),
    providerRef: stringOf(payload["recordingName"]) ?? stringOf(payload["recordingId"]),
    url: stringOf(payload["recordingUrl"]),
    durationSeconds: numberValue(payload["durationSeconds"]),
    mimeType: stringOf(payload["mimeType"]),
    occurredAt: occurredAtOf(event),
  };
}

/** The processor rebuilds the event from the redacted payload, so the bridge timestamp must be read
 * from the payload again when the validator's copy did not survive that round trip. */
function occurredAtOf(event: ValidatedProviderEvent): string | null {
  return event.occurredAt ?? isoOrNull(stringOf(event.payload["occurredAt"]) ?? stringOf(event.payload["timestamp"]));
}

function digestEvent(payload: Record<string, unknown>): string {
  return `digest:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

function callerNumber(channel: Record<string, unknown> | null): string | null {
  return stringOf(objectOf(channel?.["caller"])?.["number"]);
}

function connectedNumber(channel: Record<string, unknown> | null): string | null {
  return (
    stringOf(objectOf(channel?.["connected"])?.["number"]) ??
    stringOf(objectOf(channel?.["dialplan"])?.["exten"])
  );
}

function configString(account: ResolvedProviderAccount, key: string): string | null {
  return stringOf(account.config[key]);
}

function configBoolean(account: ResolvedProviderAccount, key: string, fallback: boolean): boolean {
  return typeof account.config[key] === "boolean" ? account.config[key] : fallback;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function headerOf(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
