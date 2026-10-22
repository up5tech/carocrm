import {
  type CallState,
  type CommunicationErrorCategory,
  mapCallStatus,
  mapMessageStatus,
  type MessageChannel,
  type MessageState,
  type ProviderEventKind,
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
  type SendMessageInput,
  type SendMessageResult,
  type ValidatedProviderEvent,
  type VoiceProviderAdapter,
  VoiceProviderError,
  type VoiceProviderInfo,
} from "./voice-provider.js";
import {
  basicAuth,
  constantTimeEqual,
  signTwilioWebhook,
} from "./voice-provider-crypto.js";
import { assertHttpUrl, requestVoiceProviderJson } from "./voice-provider-http.js";

/**
 * Twilio adapter — voice, SMS and WhatsApp (`PLAN_Phase_19_Voice_Communications.md` §15
 * `19-VC.10`–`19-VC.11`).
 *
 * Implemented against Twilio's documented REST API (`2010-04-01`) and `X-Twilio-Signature`
 * validation. A Twilio account is one registry entry because the registry resolves one adapter per
 * provider key; the capability list, not a second account, decides whether it may place calls or
 * send messages.
 *
 * Deliberately **not** declared:
 *  - `voice.callAnswer` — Twilio answers an inbound call in the TwiML handler, not through the REST
 *    API, so an agent-side Answer button would be a lie.
 *  - `messaging.mms.*` / `messaging.media` — the adapter contract carries an attachment id, not a
 *    provider-fetchable URL, and Twilio media would have to be uploaded first. A media send is
 *    refused with `invalid_request` instead of being silently dropped.
 *  - recording download — Twilio recording URLs require account authentication, which the media
 *    service does not (and must not) hold. Recording callbacks are still normalized so an operator
 *    can see the reference; the capability is not advertised.
 *
 * Account configuration:
 * ```json
 * {
 *   "accountSid": "AC…",
 *   "messagingServiceSid": "MG…",           // optional; otherwise a channel endpoint is the From
 *   "defaultFrom": "+14155550100",          // optional fallback sender
 *   "twimlUrl": "https://…/twiml",          // exactly one of twimlUrl / twiml is required for calls
 *   "twiml": "<Response><Say>…</Say></Response>",
 *   "webhookBaseUrl": "https://crm.example.com", // enables per-message/per-call status callbacks
 *   "webhookUrl": "https://crm.example.com/api/v1/integrations/voice-communications/twilio/main/voice-events",
 *   "record": false,
 *   "timeoutSeconds": 30,
 *   "templateContentSids": { "order_update": "HX…" }
 * }
 * ```
 * `credential` is the Account Auth Token. `webhookSecret` is the same Auth Token, because Twilio
 * signs callbacks with it; it is stored separately so the generic account rule can require a signing
 * secret before the account is enabled.
 */
export class TwilioProviderAdapter implements VoiceProviderAdapter {
  readonly info: VoiceProviderInfo = {
    key: "twilio",
    label: "Twilio",
    mode: "live",
    capabilities: [
      "voice.outboundCall",
      "voice.inboundEvents",
      "voice.callStatusCallbacks",
      "voice.callHangup",
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
    maxConcurrency: 4,
    webhookSignature: "provider-specific",
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
    const signature = headerOf(request.headers, "x-twilio-signature");
    if (signature === undefined) {
      throw new VoiceProviderError("auth", "The Twilio callback carries no X-Twilio-Signature header.");
    }
    if (account.webhookSecret === null || account.webhookSecret.trim() === "") {
      throw new VoiceProviderError("auth", "This Twilio account has no Auth Token configured for signature validation.");
    }
    const webhookSecret = account.webhookSecret;
    const configuredUrl = configString(account, "webhookUrl");
    const requestUrl = request.url !== undefined && request.url.trim() !== "" ? request.url.trim() : null;
    const callbackUrls = [...new Set([requestUrl, configuredUrl].filter((url): url is string => url !== null))];
    if (callbackUrls.length === 0) {
      throw new VoiceProviderError(
        "auth",
        "The callback URL is unknown, so the Twilio signature cannot be checked; set webhookUrl on the account.",
      );
    }
    // Twilio signs the URL it called, which differs per callback kind (`voice-events`,
    // `status-events`, `media-events`, `message-events`). A single configured `webhookUrl` cannot
    // cover every kind, so a signature over either candidate is accepted. The secret is still
    // required, so a wrong URL can only reject a callback, never authenticate a forged one.
    const verified = callbackUrls.some((url) =>
      constantTimeEqual(signature, signTwilioWebhook(webhookSecret, url, request.body)),
    );
    if (!verified) {
      throw new VoiceProviderError("auth", "The callback signature is not valid for this Twilio account.");
    }

    const callSid = stringOf(request.body["CallSid"]);
    const recordingSid = stringOf(request.body["RecordingSid"]);
    const messageSid = stringOf(request.body["MessageSid"]) ?? stringOf(request.body["SmsSid"]);
    const messageStatus = stringOf(request.body["MessageStatus"]) ?? stringOf(request.body["SmsStatus"]);
    const eventType: string =
      recordingSid !== null
        ? "call.recording"
        : callSid !== null
          ? "call.status"
          : messageSid !== null
            ? messageStatus === "received" || messageStatus === "receiving"
              ? "message.inbound"
              : "message.status"
            : "unknown";
    const kind: ProviderEventKind =
      eventType === "call.recording"
        ? "recording"
        : eventType === "call.status"
          ? "call"
          : eventType.startsWith("message.")
            ? "message"
            : "unknown";
    // A recording callback may also carry `CallStatus`. For recordings, `RecordingStatus` is the
    // status of the recording being reported; preferring `CallStatus` would give the event the wrong
    // dedup key and could discard the final `completed` recording callback.
    const recordingStatus = stringOf(request.body["RecordingStatus"]);
    const vendorStatus =
      (recordingSid !== null ? recordingStatus : null) ??
      stringOf(request.body["CallStatus"]) ??
      recordingStatus ??
      messageStatus ??
      null;
    const externalId = callSid ?? messageSid;
    const providerEventId =
      recordingSid !== null
        ? `recording:${recordingSid}:${vendorStatus ?? "unknown"}`
        : callSid !== null
          ? `call:${callSid}:${vendorStatus ?? "unknown"}`
          : messageSid !== null
            ? `message:${messageSid}:${vendorStatus ?? "unknown"}`
            : null;

    return {
      providerEventId,
      eventType,
      kind,
      occurredAt: isoOrNull(stringOf(request.body["Timestamp"]) ?? stringOf(request.body["OccurredAt"])),
      externalId,
      vendorStatus,
      payload: request.body,
    };
  }

  normalizeEvent(event: ValidatedProviderEvent, _account: ResolvedProviderAccount): NormalizedProviderEvent {
    if (event.kind === "recording") return normalizeRecording(event);
    if (event.kind === "call") return normalizeCall(event);
    if (event.kind === "message") return normalizeMessage(event);
    return { kind: "unknown", reason: `unsupported Twilio callback "${event.eventType}"`, occurredAt: event.occurredAt };
  }

  async healthCheck(account: ResolvedProviderAccount): Promise<ProviderHealthResult> {
    const accountSid = requireConfig(account, "accountSid", "Twilio");
    const credential = requireCredential(account, "Twilio");
    const result = await requestVoiceProviderJson({
      method: "GET",
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      service: "Twilio",
      headers: { authorization: basicAuth(accountSid, credential), accept: "application/json" },
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    const status = stringOf(result.data?.["status"]) ?? "unknown";
    if (status !== "active") {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        detail: `Twilio is reachable, but the account status is "${status}".`,
      };
    }
    return { ok: true, checkedAt: new Date().toISOString(), detail: "Twilio account is reachable and active." };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const accountSid = requireConfig(input.account, "accountSid", "Twilio");
    const credential = requireCredential(input.account, "Twilio");
    const from = input.from ?? configString(input.account, "callerId") ?? configString(input.account, "defaultFrom");
    if (from === null || from.trim() === "") {
      throw new VoiceProviderError("invalid_request", "Twilio needs a caller id; register an active voice endpoint for the account.");
    }
    const twimlUrl = configString(input.account, "twimlUrl");
    const twiml = configString(input.account, "twiml");
    if (twimlUrl === null && twiml === null) {
      throw new VoiceProviderError(
        "invalid_request",
        "Twilio needs twimlUrl or twiml on the account so the call has an instruction when it connects.",
      );
    }

    const form = new URLSearchParams();
    form.set("To", input.to);
    form.set("From", from);
    if (twimlUrl !== null) {
      assertHttpUrl(twimlUrl, { allowHttp: false });
      form.set("Url", twimlUrl);
    } else if (twiml !== null) {
      form.set("Twiml", twiml);
    }
    appendCallStatusCallback(input.account, form);
    if (configBoolean(input.account, "record", false)) {
      form.set("Record", "true");
      const base = webhookBase(input.account);
      if (base !== null) form.set("RecordingStatusCallback", `${base}/media-events`);
    }
    const timeout = numberConfig(input.account, "timeoutSeconds");
    if (timeout !== null && timeout > 0) form.set("Timeout", String(Math.min(600, Math.round(timeout))));

    const result = await requestVoiceProviderJson({
      method: "POST",
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
      service: "Twilio",
      headers: {
        authorization: basicAuth(accountSid, credential),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    const providerCallId = stringOf(result.data?.["sid"]);
    const rawStatus = stringOf(result.data?.["status"]) ?? "queued";
    const state = callStateForTwilio(rawStatus, "initiated");
    if (state === "failed") {
      return {
        providerCallId,
        accepted: false,
        state,
        errorCategory: "unknown",
        error: "Twilio reported the call as failed.",
      };
    }
    return { providerCallId, accepted: true, state };
  }

  async controlCall(input: CallControlInput): Promise<CallControlResult> {
    if (input.action === "answer") {
      throw new VoiceProviderError(
        "invalid_request",
        "Twilio answers an inbound call in its TwiML handler; it does not expose an agent Answer API.",
      );
    }
    const accountSid = requireConfig(input.account, "accountSid", "Twilio");
    const credential = requireCredential(input.account, "Twilio");
    // Twilio distinguishes cancelling a call that has not been answered (`canceled`) from ending an
    // answered one (`completed`); the Calls resource rejects the wrong transition. Without a known
    // state, assume the call was answered, which is the historical behaviour.
    const cancel = input.state === "requested" || input.state === "initiated" || input.state === "ringing";
    const form = new URLSearchParams({ Status: cancel ? "canceled" : "completed" });
    await requestVoiceProviderJson({
      method: "POST",
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(input.providerCallId)}.json`,
      service: "Twilio",
      headers: {
        authorization: basicAuth(accountSid, credential),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    return { accepted: true, state: cancel ? "cancelled" : "completed" };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const accountSid = requireConfig(input.account, "accountSid", "Twilio");
    const credential = requireCredential(input.account, "Twilio");
    if ((input.media ?? []).length > 0) {
      throw new VoiceProviderError(
        "invalid_request",
        "This Twilio adapter cannot send attachments: the module stores attachment ids, while Twilio needs a public media URL. Send text only or upload the media through Twilio first.",
      );
    }
    if (input.to.trim() === "") throw new VoiceProviderError("invalid_recipient", "The destination address is empty.");

    const isWhatsApp = input.channel === "whatsapp";
    const from = input.fromAddress ?? configString(input.account, "defaultFrom");
    const messagingServiceSid = configString(input.account, "messagingServiceSid");
    if (from === null && messagingServiceSid === null) {
      throw new VoiceProviderError(
        "invalid_request",
        "Twilio needs a sender: register an endpoint for the channel, set defaultFrom, or configure messagingServiceSid.",
      );
    }

    const templateKey = (input.templateKey ?? "").trim();
    const contentSid = templateKey === "" ? null : resolveContentSid(input.account, templateKey);
    if (templateKey !== "" && contentSid === null) {
      throw new VoiceProviderError(
        "invalid_request",
        `WhatsApp template "${templateKey}" is not mapped to a Twilio ContentSid. Add it to templateContentSids or use the ContentSid as the key.`,
      );
    }
    if (contentSid !== null && !isWhatsApp) {
      throw new VoiceProviderError("invalid_request", "Twilio templates are only sent on the WhatsApp channel here.");
    }
    if (input.body.trim() === "" && contentSid === null) {
      throw new VoiceProviderError("invalid_request", "A Twilio message needs text or a WhatsApp template.");
    }

    const form = new URLSearchParams();
    form.set("To", isWhatsApp ? withWhatsAppPrefix(input.to) : input.to);
    if (from !== null) {
      form.set("From", isWhatsApp ? withWhatsAppPrefix(from) : from);
    } else if (messagingServiceSid !== null) {
      form.set("MessagingServiceSid", messagingServiceSid);
    }
    if (contentSid !== null) {
      form.set("ContentSid", contentSid);
      if (input.templateVariables !== undefined && input.templateVariables !== null) {
        form.set("ContentVariables", JSON.stringify(input.templateVariables));
      }
    } else {
      form.set("Body", input.body);
    }
    const statusCallback = webhookBase(input.account);
    if (statusCallback !== null) form.set("StatusCallback", `${statusCallback}/status-events`);

    const result = await requestVoiceProviderJson({
      method: "POST",
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      service: "Twilio",
      headers: {
        authorization: basicAuth(accountSid, credential),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    const providerMessageId = stringOf(result.data?.["sid"]);
    const rawStatus = stringOf(result.data?.["status"]) ?? "queued";
    const mapped = mapMessageStatus(rawStatus);
    if (mapped === "failed" || mapped === "undelivered") {
      return {
        providerMessageId,
        accepted: false,
        state: mapped,
        errorCategory: "unknown",
        error: `Twilio reported the message as ${rawStatus}.`,
      };
    }
    // A create response is an acceptance, never proof of delivery, even if a mock answers
    // "delivered"; only a signed callback may advance the message that far.
    return { providerMessageId, accepted: true, state: mapped === "delivered" || mapped === "read" ? "sent" : mapped };
  }
}

function normalizeCall(event: ValidatedProviderEvent): NormalizedProviderEvent {
  const payload = event.payload;
  const providerCallId = stringOf(payload["CallSid"]) ?? event.externalId;
  if (providerCallId === null) {
    return { kind: "unknown", reason: "Twilio call callback without a CallSid", occurredAt: event.occurredAt };
  }
  const vendorStatus = stringOf(payload["CallStatus"]) ?? event.vendorStatus ?? "unknown";
  const state = callStateForTwilio(vendorStatus, "unknown");
  return {
    kind: "call",
    providerCallId,
    state,
    direction: (stringOf(payload["Direction"]) ?? "").toLowerCase().startsWith("inbound") ? "inbound" : "outbound",
    from: stripWhatsApp(stringOf(payload["From"])),
    to: stripWhatsApp(stringOf(payload["To"])),
    occurredAt: occurredAtOf(event),
    durationSeconds: numberValue(payload["CallDuration"]),
    failureCategory: state === "failed" ? failureCategory(payload) ?? "unknown" : null,
    vendorStatus,
  };
}

function normalizeMessage(event: ValidatedProviderEvent): NormalizedProviderEvent {
  const payload = event.payload;
  const providerMessageId = stringOf(payload["MessageSid"]) ?? stringOf(payload["SmsSid"]) ?? event.externalId;
  const vendorStatus =
    stringOf(payload["MessageStatus"]) ?? stringOf(payload["SmsStatus"]) ?? event.vendorStatus ?? "unknown";
  const inbound =
    event.eventType === "message.inbound" ||
    vendorStatus === "received" ||
    vendorStatus === "receiving" ||
    (stringOf(payload["Direction"]) ?? "").toLowerCase() === "inbound";
  const from = stringOf(payload["From"]);
  const to = stringOf(payload["To"]);
  const channel = messageChannel(from, to);
  const state: MessageState = inbound
    ? "delivered"
    : (mapMessageStatus(vendorStatus) === "unknown" ? "unknown" : mapMessageStatus(vendorStatus));
  return {
    kind: "message",
    providerMessageId,
    state,
    direction: inbound ? "inbound" : "outbound",
    channel,
    from: stripWhatsApp(from),
    to: stripWhatsApp(to),
    body: stringOf(payload["Body"]),
    occurredAt: occurredAtOf(event),
    failureCategory:
      !inbound && (state === "failed" || state === "undelivered") ? failureCategory(payload) ?? "unknown" : null,
    vendorStatus,
  };
}

function normalizeRecording(event: ValidatedProviderEvent): NormalizedProviderEvent {
  const payload = event.payload;
  const url = stringOf(payload["RecordingUrl"]);
  return {
    kind: "recording",
    providerCallId: stringOf(payload["CallSid"]),
    providerRef: stringOf(payload["RecordingSid"]),
    url,
    durationSeconds: numberValue(payload["RecordingDuration"]),
    mimeType: stringOf(payload["RecordingContentType"]),
    occurredAt: occurredAtOf(event),
  };
}

function callStateForTwilio(raw: string, fallback: CallState): CallState {
  const mapped = mapCallStatus(raw);
  return mapped === "unknown" ? fallback : mapped;
}

function messageChannel(from: string | null, to: string | null): MessageChannel {
  return (from ?? "").startsWith("whatsapp:") || (to ?? "").startsWith("whatsapp:") ? "whatsapp" : "sms";
}

function failureCategory(payload: Readonly<Record<string, unknown>>): CommunicationErrorCategory | null {
  const raw = stringOf(payload["ErrorCode"]);
  const code = raw === null ? null : Number(raw);
  if (code !== null && Number.isFinite(code)) {
    if (code === 21610) return "suppressed";
    if (code === 21211 || code === 21214 || code === 21612 || code === 21614) return "invalid_recipient";
    if (code === 63016 || code === 63024) return "window_closed";
    if (code === 63022 || code === 63023) return "template_required";
    if (code === 21617 || code === 21620) return "media_rejected";
    if (code === 20003 || code === 20404) return "auth";
    if (code === 20429) return "rate_limit";
    if (code === 30001 || code === 30002 || code === 30003 || code === 30004) return "provider_unavailable";
  }
  return null;
}

function appendCallStatusCallback(account: ResolvedProviderAccount, form: URLSearchParams): void {
  const base = webhookBase(account);
  if (base === null) return;
  form.set("StatusCallback", `${base}/status-events`);
  for (const event of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
}

function webhookBase(account: ResolvedProviderAccount): string | null {
  const raw = configString(account, "webhookBaseUrl");
  if (raw === null) return null;
  const url = assertHttpUrl(raw, { allowHttp: false });
  if (url.username !== "" || url.password !== "") {
    throw new VoiceProviderError("invalid_request", "webhookBaseUrl must not include credentials.");
  }
  return `${url.toString().replace(/\/+$/, "")}/api/v1/integrations/voice-communications/twilio/${encodeURIComponent(account.key)}`;
}

function resolveContentSid(account: ResolvedProviderAccount, templateKey: string): string | null {
  const mapping = configRecord(account, "templateContentSids");
  const mapped = mapping === null ? null : stringOf(mapping[templateKey]);
  if (mapped !== null) return mapped;
  return /^HX[A-Za-z0-9]{32}$/.test(templateKey) ? templateKey : null;
}

function withWhatsAppPrefix(address: string): string {
  return address.startsWith("whatsapp:") ? address : `whatsapp:${address}`;
}

function stripWhatsApp(address: string | null): string | null {
  return address === null ? null : address.replace(/^whatsapp:/i, "");
}

function requireConfig(account: ResolvedProviderAccount, key: string, service: string): string {
  const value = configString(account, key);
  if (value === null) {
    throw new VoiceProviderError("invalid_request", `${service} needs "${key}" in the account config.`);
  }
  return value;
}

function requireCredential(account: ResolvedProviderAccount, service: string): string {
  if (account.secret === null || account.secret.trim() === "") {
    throw new VoiceProviderError("auth", `${service} account "${account.key}" has no credential configured.`);
  }
  return account.secret;
}

function configString(account: ResolvedProviderAccount, key: string): string | null {
  return stringOf(account.config[key]);
}

function configRecord(account: ResolvedProviderAccount, key: string): Record<string, unknown> | null {
  const value = account.config[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configBoolean(account: ResolvedProviderAccount, key: string, fallback: boolean): boolean {
  const value = account.config[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberConfig(account: ResolvedProviderAccount, key: string): number | null {
  return numberValue(account.config[key]);
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

/** The processor reconstructs the event from the redacted payload, so the callback timestamp is
 * read from the payload again when the validator's copy did not survive that round trip. */
function occurredAtOf(event: ValidatedProviderEvent): string | null {
  return event.occurredAt ?? isoOrNull(stringOf(event.payload["Timestamp"]) ?? stringOf(event.payload["OccurredAt"]));
}

