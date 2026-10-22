import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { stableStringify } from "../src/voice-communications/voice-communications-domain.js";
import {
  type ResolvedProviderAccount,
  VoiceProviderError,
  VoiceProviderRegistry,
} from "../src/voice-communications/voice-provider.js";
import { AsteriskProviderAdapter } from "../src/voice-communications/voice-provider-asterisk.js";
import { VoiceProviderBindingService } from "../src/voice-communications/voice-provider-binding.service.js";
import { TwilioProviderAdapter } from "../src/voice-communications/voice-provider-twilio.js";

/**
 * Unit tests for the first production adapters.
 *
 * No socket is opened: every HTTP call goes through an injected `fetch`, and webhook tests produce
 * their own signatures. The tests therefore exercise the adapter boundary the same way the ingress
 * and the registry do, without needing a Twilio or Asterisk account and without sending a message,
 * placing a call or creating a database row.
 */

const TWILIO_URL =
  "https://crm.example.com/api/v1/integrations/voice-communications/twilio/twilio_main/voice-events";
const TWILIO_AUTH_TOKEN = "twilio-auth-token";
const ASTERISK_SECRET = "asterisk-bridge-secret";
const ASTERISK_TIMESTAMP = "2026-10-22T10:00:00.000Z";

function twilioAccount(overrides: Record<string, unknown> = {}): ResolvedProviderAccount {
  return {
    key: "twilio_main",
    providerKey: "twilio",
    label: "Twilio",
    environment: "test",
    enabled: true,
    capabilities: [],
    config: {
      accountSid: "AC123",
      webhookUrl: TWILIO_URL,
      webhookBaseUrl: "https://crm.example.com",
      twimlUrl: "https://crm.example.com/twiml",
      ...overrides,
    },
    secret: TWILIO_AUTH_TOKEN,
    webhookSecret: TWILIO_AUTH_TOKEN,
  };
}

function asteriskAccount(overrides: Record<string, unknown> = {}): ResolvedProviderAccount {
  return {
    key: "asterisk_main",
    providerKey: "asterisk",
    label: "Asterisk",
    environment: "test",
    enabled: true,
    capabilities: [],
    config: {
      ariUrl: "https://pbx.example.com:8089/ari",
      ariUsername: "carocrm",
      ariApp: "carocrm",
      ...overrides,
    },
    secret: "ari-password",
    webhookSecret: ASTERISK_SECRET,
  };
}

function twilioSignature(secret: string, url: string, body: Record<string, unknown>): string {
  const material = Object.keys(body)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${String(body[key] ?? "")}`, url);
  return createHmac("sha1", secret).update(material, "utf8").digest("base64");
}

function asteriskSignature(secret: string, timestamp: string, body: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(`${timestamp}.${stableStringify(body)}`).digest("hex");
}

function headerValue(init: RequestInit | undefined, name: string): string {
  return new Headers(init?.headers).get(name) ?? "";
}

function stubFetch(responses: readonly { status?: number; body?: string }[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = answer?.status ?? 200;
    const body = status === 204 || status === 205 || status === 304 ? null : (answer?.body ?? "");
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("production adapter registration", () => {
  it("registers Twilio and Asterisk at module init with no runtime plugin loading", () => {
    const registry = new VoiceProviderRegistry();
    new VoiceProviderBindingService(registry).onModuleInit();
    expect(registry.resolve("twilio").info).toMatchObject({ key: "twilio", mode: "live" });
    expect(registry.resolve("asterisk").info).toMatchObject({ key: "asterisk", mode: "live" });
    expect(registry.resolve("unknown").info.mode).toBe("disabled");
  });
});

describe("Twilio adapter", () => {
  it("authenticates the callback URL and form fields, then normalizes a ringing call", async () => {
    const body = {
      CallSid: "CA123",
      CallStatus: "ringing",
      Direction: "inbound",
      From: "+14155550100",
      To: "+14155550199",
    };
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    const event = await adapter.validateWebhook(
      {
        headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, body) },
        body,
        url: TWILIO_URL,
      },
      account,
    );

    expect(event.eventType).toBe("call.status");
    expect(event.kind).toBe("call");
    expect(event.providerEventId).toBe("call:CA123:ringing");
    const normalized = adapter.normalizeEvent(event, account);
    expect(normalized).toMatchObject({
      kind: "call",
      providerCallId: "CA123",
      state: "ringing",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550199",
    });
  });

  it("refuses a Twilio callback with a bad signature", async () => {
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    await expect(
      adapter.validateWebhook(
        {
          headers: { "x-twilio-signature": "not-the-signature" },
          body: { CallSid: "CA123", CallStatus: "ringing" },
          url: TWILIO_URL,
        },
        account,
      ),
    ).rejects.toMatchObject({ category: "auth" });
  });

  it("accepts a status callback signed for its own path when webhookUrl names voice-events", async () => {
    const body = {
      MessageSid: "SM-status",
      MessageStatus: "delivered",
      From: "+14155550199",
      To: "+14155550100",
    };
    const statusUrl =
      "https://crm.example.com/api/v1/integrations/voice-communications/twilio/twilio_main/status-events";
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    const event = await adapter.validateWebhook(
      {
        headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, statusUrl, body) },
        body,
        url: statusUrl,
      },
      account,
    );

    expect(event.kind).toBe("message");
    expect(adapter.normalizeEvent(event, account)).toMatchObject({ state: "delivered" });
  });

  it("falls back to the configured webhookUrl when a proxy rewrote the request URL", async () => {
    const body = { CallSid: "CA-proxy", CallStatus: "ringing" };
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    await expect(
      adapter.validateWebhook(
        {
          headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, body) },
          body,
          url: "http://internal-api:3000/api/v1/integrations/voice-communications/twilio/twilio_main/voice-events",
        },
        account,
      ),
    ).resolves.toMatchObject({ externalId: "CA-proxy" });
  });

  it("uses RecordingStatus for a recording callback and keeps the final completed event", async () => {
    const body = {
      CallSid: "CA-recording",
      RecordingSid: "RE123",
      CallStatus: "in-progress",
      RecordingStatus: "completed",
      RecordingUrl: "https://api.twilio.com/recordings/RE123",
      RecordingDuration: "12",
    };
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    const event = await adapter.validateWebhook(
      {
        headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, body) },
        body,
        url: TWILIO_URL,
      },
      account,
    );

    expect(event).toMatchObject({
      eventType: "call.recording",
      kind: "recording",
      vendorStatus: "completed",
      providerEventId: "recording:RE123:completed",
    });
    expect(adapter.normalizeEvent(event, account)).toMatchObject({
      kind: "recording",
      providerCallId: "CA-recording",
      providerRef: "RE123",
      durationSeconds: 12,
    });
  });

  it("maps no-answer and completed call callbacks without inventing success", async () => {
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    const noAnswer = await adapter.validateWebhook(
      {
        headers: {
          "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, {
            CallSid: "CA2",
            CallStatus: "no-answer",
          }),
        },
        body: { CallSid: "CA2", CallStatus: "no-answer" },
        url: TWILIO_URL,
      },
      account,
    );
    expect(adapter.normalizeEvent(noAnswer, account)).toMatchObject({ state: "no_answer", failureCategory: null });

    const completed = await adapter.validateWebhook(
      {
        headers: {
          "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, {
            CallSid: "CA3",
            CallStatus: "completed",
            CallDuration: "42",
          }),
        },
        body: { CallSid: "CA3", CallStatus: "completed", CallDuration: "42" },
        url: TWILIO_URL,
      },
      account,
    );
    expect(adapter.normalizeEvent(completed, account)).toMatchObject({
      state: "completed",
      durationSeconds: 42,
    });
  });

  it("normalizes inbound WhatsApp messages and delivery callbacks separately", async () => {
    const adapter = new TwilioProviderAdapter();
    const account = twilioAccount();
    const inboundBody = {
      SmsSid: "SM-in",
      SmsStatus: "received",
      From: "whatsapp:+14155550100",
      To: "whatsapp:+14155550199",
      Body: "hello",
    };
    const inbound = await adapter.validateWebhook(
      {
        headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, inboundBody) },
        body: inboundBody,
        url: TWILIO_URL,
      },
      account,
    );
    expect(inbound.eventType).toBe("message.inbound");
    expect(adapter.normalizeEvent(inbound, account)).toMatchObject({
      kind: "message",
      providerMessageId: "SM-in",
      state: "delivered",
      direction: "inbound",
      channel: "whatsapp",
      from: "+14155550100",
      body: "hello",
    });

    const statusBody = {
      MessageSid: "SM-out",
      MessageStatus: "delivered",
      From: "whatsapp:+14155550199",
      To: "whatsapp:+14155550100",
    };
    const status = await adapter.validateWebhook(
      {
        headers: { "x-twilio-signature": twilioSignature(TWILIO_AUTH_TOKEN, TWILIO_URL, statusBody) },
        body: statusBody,
        url: TWILIO_URL,
      },
      account,
    );
    expect(adapter.normalizeEvent(status, account)).toMatchObject({
      kind: "message",
      state: "delivered",
      direction: "outbound",
      channel: "whatsapp",
    });
  });

  it("sends SMS through the Messages API with the registered sender and status callback", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 201, body: JSON.stringify({ sid: "SM123", status: "queued" }) },
    ]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    const result = await adapter.sendMessage({
      account: twilioAccount(),
      conversationId: "conversation-1",
      messageId: "message-1",
      to: "+14155550100",
      body: "Hello",
      channel: "sms",
      idempotencyKey: "agent-test-idem",
      fromAddress: "+14155550199",
    });

    expect(result).toMatchObject({ providerMessageId: "SM123", accepted: true, state: "queued" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/2010-04-01/Accounts/AC123/Messages.json");
    expect(headerValue(calls[0]?.init, "authorization")).toContain("Basic ");
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.get("To")).toBe("+14155550100");
    expect(form.get("From")).toBe("+14155550199");
    expect(form.get("Body")).toBe("Hello");
    expect(form.get("StatusCallback")).toContain(
      "/api/v1/integrations/voice-communications/twilio/twilio_main/status-events",
    );
  });

  it("maps a local WhatsApp template key to its ContentSid and refuses unmapped keys", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 201, body: JSON.stringify({ sid: "SM-template", status: "queued" }) },
    ]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    await adapter.sendMessage({
      account: twilioAccount({ templateContentSids: { order_update: "HX123" } }),
      conversationId: "conversation-1",
      messageId: "message-2",
      to: "+14155550100",
      body: "",
      channel: "whatsapp",
      idempotencyKey: "agent-test-template",
      fromAddress: "+14155550199",
      templateKey: "order_update",
      templateVariables: { 1: "Alex" },
    });
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.get("ContentSid")).toBe("HX123");
    expect(form.get("ContentVariables")).toBe('{"1":"Alex"}');
    expect(form.get("From")).toBe("whatsapp:+14155550199");

    await expect(
      adapter.sendMessage({
        account: twilioAccount(),
        conversationId: "conversation-1",
        messageId: "message-3",
        to: "+14155550100",
        body: "",
        channel: "whatsapp",
        idempotencyKey: "agent-test-template-2",
        fromAddress: "+14155550199",
        templateKey: "not_mapped",
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
  });

  it("refuses attachments instead of silently sending text without them", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 201, body: "{}" }]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    await expect(
      adapter.sendMessage({
        account: twilioAccount(),
        conversationId: "conversation-1",
        messageId: "message-4",
        to: "+14155550100",
        body: "with file",
        channel: "sms",
        idempotencyKey: "agent-test-media",
        fromAddress: "+14155550199",
        media: [{ storageRef: "attachment-1", contentType: "image/png", filename: "x.png" }],
      }),
    ).rejects.toBeInstanceOf(VoiceProviderError);
    expect(calls).toHaveLength(0);
  });

  it("places a call with TwiML and hangs it up through the Calls resource", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 201, body: JSON.stringify({ sid: "CA-call", status: "queued" }) },
      { status: 200, body: JSON.stringify({ sid: "CA-call", status: "completed" }) },
    ]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    const placed = await adapter.initiateCall({
      account: twilioAccount(),
      from: "+14155550199",
      to: "+14155550100",
      idempotencyKey: "agent-test-call",
    });
    expect(placed).toMatchObject({ providerCallId: "CA-call", accepted: true, state: "requested" });
    const callForm = new URLSearchParams(String(calls[0]?.init?.body));
    expect(callForm.get("To")).toBe("+14155550100");
    expect(callForm.get("From")).toBe("+14155550199");
    expect(callForm.get("Url")).toBe("https://crm.example.com/twiml");

    const ended = await adapter.controlCall({
      account: twilioAccount(),
      providerCallId: "CA-call",
      action: "hangup",
    });
    expect(ended).toEqual({ accepted: true, state: "completed" });
    expect(calls[1]?.url).toContain("/Calls/CA-call.json");
    expect(new URLSearchParams(String(calls[1]?.init?.body)).get("Status")).toBe("completed");
  });

  it("cancels a ringing call but completes an answered one", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: JSON.stringify({ sid: "CA-ringing", status: "canceled" }) },
      { status: 200, body: JSON.stringify({ sid: "CA-answered", status: "completed" }) },
    ]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    const account = twilioAccount();

    await expect(
      adapter.controlCall({ account, providerCallId: "CA-ringing", action: "hangup", state: "ringing" }),
    ).resolves.toEqual({ accepted: true, state: "cancelled" });
    expect(new URLSearchParams(String(calls[0]?.init?.body)).get("Status")).toBe("canceled");

    await expect(
      adapter.controlCall({ account, providerCallId: "CA-answered", action: "hangup", state: "in_progress" }),
    ).resolves.toEqual({ accepted: true, state: "completed" });
    expect(new URLSearchParams(String(calls[1]?.init?.body)).get("Status")).toBe("completed");
  });

  it("reports Twilio health without exposing the auth token", async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: JSON.stringify({ status: "active" }) }]);
    const adapter = new TwilioProviderAdapter({ fetchImpl });
    await expect(adapter.healthCheck(twilioAccount())).resolves.toMatchObject({ ok: true });
  });
});

describe("Asterisk adapter", () => {
  const validHeaders = (body: Record<string, unknown>): Record<string, string> => ({
    "x-voice-timestamp": ASTERISK_TIMESTAMP,
    "x-voice-signature": asteriskSignature(ASTERISK_SECRET, ASTERISK_TIMESTAMP, body),
  });

  it("authenticates a signed bridge event and maps an ARI channel state", async () => {
    const body = {
      eventId: "ari-event-1",
      type: "ChannelStateChange",
      occurredAt: ASTERISK_TIMESTAMP,
      channel: { id: "ast-channel-1", state: "Ring", caller: { number: "+14155550100" }, dialplan: { exten: "+14155550199" } },
    };
    const adapter = new AsteriskProviderAdapter();
    const account = asteriskAccount();
    const event = await adapter.validateWebhook({ headers: validHeaders(body), body }, account);
    expect(event).toMatchObject({ eventType: "call.status", kind: "call", externalId: "ast-channel-1" });
    expect(adapter.normalizeEvent(event, account)).toMatchObject({
      kind: "call",
      providerCallId: "ast-channel-1",
      state: "ringing",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550199",
    });
  });

  it("maps an Asterisk hangup cause to busy rather than completed", async () => {
    const body = {
      type: "ChannelDestroyed",
      occurredAt: ASTERISK_TIMESTAMP,
      channel: { id: "ast-channel-2", state: "Down" },
      cause: 17,
    };
    const adapter = new AsteriskProviderAdapter();
    const account = asteriskAccount();
    const event = await adapter.validateWebhook({ headers: validHeaders(body), body }, account);
    expect(adapter.normalizeEvent(event, account)).toMatchObject({ state: "busy", failureCategory: null });
  });

  it("maps no-answer, rejection and unknown causes without inventing a failure", async () => {
    const adapter = new AsteriskProviderAdapter();
    const account = asteriskAccount();
    const cases: readonly (readonly [number, string])[] = [
      [18, "no_answer"],
      [19, "no_answer"],
      [20, "no_answer"],
      [21, "cancelled"],
      [0, "unknown"],
      [16, "completed"],
      [31, "completed"],
    ];
    for (const [cause, expected] of cases) {
      const body = {
        type: "ChannelDestroyed",
        occurredAt: ASTERISK_TIMESTAMP,
        channel: { id: `ast-cause-${cause}`, state: "Down" },
        cause,
      };
      const event = await adapter.validateWebhook({ headers: validHeaders(body), body }, account);
      expect(adapter.normalizeEvent(event, account)).toMatchObject({ state: expected });
    }
  });

  it("keeps any domain failure category supplied by the bridge", async () => {
    const body = {
      type: "ChannelDestroyed",
      occurredAt: ASTERISK_TIMESTAMP,
      channel: { id: "ast-channel-failure", state: "Down" },
      cause: 3,
      failureCategory: "invalid_response",
    };
    const adapter = new AsteriskProviderAdapter();
    const account = asteriskAccount();
    const event = await adapter.validateWebhook({ headers: validHeaders(body), body }, account);
    expect(adapter.normalizeEvent(event, account)).toMatchObject({
      state: "failed",
      failureCategory: "invalid_response",
    });
  });

  it("reads the bridge timestamp after the processor rebuilds a redacted event", () => {
    const adapter = new AsteriskProviderAdapter();
    const account = asteriskAccount();
    const call = adapter.normalizeEvent(
      {
        providerEventId: "ari-event-restored",
        eventType: "call.status",
        kind: "call",
        occurredAt: null,
        externalId: "ast-ts",
        vendorStatus: null,
        payload: {
          type: "ChannelStateChange",
          timestamp: ASTERISK_TIMESTAMP,
          channel: { id: "ast-ts", state: "Ring" },
        },
      },
      account,
    );
    expect(call).toMatchObject({ kind: "call", state: "ringing", occurredAt: ASTERISK_TIMESTAMP });

    const recording = adapter.normalizeEvent(
      {
        providerEventId: "ari-recording-restored",
        eventType: "call.recording",
        kind: "recording",
        occurredAt: null,
        externalId: "ast-ts",
        vendorStatus: null,
        payload: { timestamp: ASTERISK_TIMESTAMP, recordingId: "rec-1" },
      },
      account,
    );
    expect(recording).toMatchObject({ kind: "recording", occurredAt: ASTERISK_TIMESTAMP });
  });

  it("refuses a bridge event with a bad signature", async () => {
    const adapter = new AsteriskProviderAdapter();
    await expect(
      adapter.validateWebhook(
        { headers: { "x-voice-timestamp": ASTERISK_TIMESTAMP, "x-voice-signature": "bad" }, body: { type: "StasisStart" } },
        asteriskAccount(),
      ),
    ).rejects.toMatchObject({ category: "auth" });
  });

  it("originates, answers and hangs up through ARI", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: JSON.stringify({ id: "ast-channel-3", state: "Down" }) },
      { status: 204, body: "" },
      { status: 204, body: "" },
    ]);
    const adapter = new AsteriskProviderAdapter({ fetchImpl });
    const account = asteriskAccount();
    const placed = await adapter.initiateCall({
      account,
      from: "+14155550100",
      to: "+14155550199",
      idempotencyKey: "agent-test-call",
    });
    expect(placed).toMatchObject({ providerCallId: "ast-channel-3", accepted: true, state: "initiated" });
    expect(calls[0]?.url).toContain("/ari/channels?");
    expect(calls[0]?.url).toContain("endpoint=PJSIP%2F%2B14155550199");
    expect(calls[0]?.url).toContain("app=carocrm");

    await expect(
      adapter.controlCall({ account, providerCallId: "ast-channel-3", action: "answer" }),
    ).resolves.toEqual({ accepted: true, state: "in_progress" });
    expect(calls[1]?.url).toContain("/ari/channels/ast-channel-3/answer");
    expect(calls[1]?.init?.method).toBe("POST");

    await expect(
      adapter.controlCall({ account, providerCallId: "ast-channel-3", action: "hangup" }),
    ).resolves.toEqual({ accepted: true, state: "completed" });
    expect(calls[2]?.url).toContain("/ari/channels/ast-channel-3");
    expect(calls[2]?.init?.method).toBe("DELETE");
  });

  it("checks ARI health with basic authentication", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: JSON.stringify({ system: {} }) }]);
    const adapter = new AsteriskProviderAdapter({ fetchImpl });
    await expect(adapter.healthCheck(asteriskAccount())).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.url).toBe("https://pbx.example.com:8089/ari/asterisk/info");
    expect(headerValue(calls[0]?.init, "authorization")).toContain("Basic ");
  });
});
