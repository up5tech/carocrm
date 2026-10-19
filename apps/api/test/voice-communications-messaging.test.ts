import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signFakeWebhook } from "../src/voice-communications/voice-provider.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-VC.10–19-VC.11 — SMS/MMS and WhatsApp messaging
 * (`PLAN_Phase_19_Voice_Communications.md` §8.1–§8.3, §15 `19-VC.10`, `19-VC.11`).
 *
 * The simulator's `sandboxRecipients` allowlist contains exactly one test number, so no automated
 * run can message a real phone (§15.4). Delivery state is only ever asserted after a callback.
 */
let ctx: ApiContext;
let runId: string;
let accountKey: string;
let webhookSecret: string;
let conversationId: string | null = null;

const DESTINATION = "+14155550121";
const ENDPOINT = "+14155550199";
const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(ctx.adminToken), ...headers },
    ...(payload !== undefined ? { payload } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** The platform wraps errors as `{ error: { code, message, details } }`. */
function refusals(body: Record<string, unknown>): string[] {
  const error = body["error"] as Record<string, unknown> | undefined;
  const details = error?.["details"] as Record<string, unknown> | undefined;
  return Array.isArray(details?.["refusals"]) ? (details["refusals"] as string[]) : [];
}

async function callback(body: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const accepted = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/integrations/voice-communications/fake/${accountKey}/message-events`,
    headers: {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signFakeWebhook(webhookSecret, timestamp, body),
    },
    payload: body,
  });
  expect(accepted.statusCode, accepted.body).toBe(202);
  const eventId = (accepted.json() as Record<string, unknown>)["eventId"];
  const processed = await call(
    "POST",
    "/api/v1/VoiceCommunications/action/webhook-events/process",
    { eventId },
    { "x-worker-secret": process.env.REPORT_WORKER_SECRET ?? "" },
  );
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return processed.body;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? "agent-test-worker-secret";
  ctx = await bootApi();
  runId = Date.now().toString(36);
  accountKey = `agent_test_msg_${runId}`;
  webhookSecret = `whsec_agent_msg_${runId}`;

  const account = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
    key: accountKey,
    providerKey: "fake",
    label: marker("messaging"),
    environment: "test",
    enabled: true,
    capabilities: [
      "messaging.sms.send",
      "messaging.sms.receive",
      "messaging.whatsapp.send",
      "messaging.whatsapp.receive",
      "messaging.deliveryStatus",
      "messaging.templates",
      "webhook.signatureValidation",
      "provider.healthCheck",
    ],
    config: { sandboxRecipients: [DESTINATION] },
    webhookSecret,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  await call("POST", `/api/v1/VoiceCommunications/action/accounts/${accountKey}/endpoints`, {
    key: "sms-main",
    channel: "sms",
    address: ENDPOINT,
    country: "US",
    active: true,
  });

  const settings = await call("POST", "/api/v1/VoiceCommunications/action/settings", {
    features: { sms: true, whatsapp: true },
    provider: { defaultAccountKey: accountKey },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  for (const channel of ["sms", "whatsapp"] as const) {
    const consent = await call("POST", "/api/v1/VoiceCommunications/action/consent", {
      channel,
      address: DESTINATION,
      purpose: "service",
      status: "granted",
      basis: "explicit_opt_in",
      source: "manual_record",
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(201);
  }
});

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from voice_conversations where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_call_sessions where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_consent_events where address = ${DESTINATION}`.execute(db);
  await sql`delete from voice_suppressions where address = ${DESTINATION}`.execute(db);
  await sql`delete from outbox_events where payload->>'accountKey' = ${accountKey}`.execute(db);
  await sql`delete from voice_provider_accounts where key = ${accountKey}`.execute(db);
  await ctx.app
    .inject({
      method: "POST",
      url: "/api/v1/VoiceCommunications/action/settings",
      headers: authHeader(ctx.adminToken),
      payload: { features: { sms: false, whatsapp: false }, provider: { defaultAccountKey: "" } },
    })
    .catch(() => undefined);
  await shutdownApi();
});

describe("SMS send and delivery (19-VC.10)", () => {
  it("sends one message, records it as sent and opens a conversation", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "sms",
      to: DESTINATION,
      body: marker("hello from sms"),
      idempotencyKey: `sms-${runId}-1`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const message = res.body["message"] as Record<string, unknown>;
    expect(message["state"]).toBe("sent");
    expect(message["direction"]).toBe("outbound");
    expect(message["providerMessageId"]).toBeTruthy();
    conversationId = String(message["conversationId"]);

    const conversation = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId}`);
    expect(conversation.status).toBe(200);
    expect((conversation.body["conversation"] as Record<string, unknown>)["channel"]).toBe("sms");
  });

  it("returns the same message for a repeated idempotency key", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "sms",
      to: DESTINATION,
      body: marker("hello from sms"),
      idempotencyKey: `sms-${runId}-1`,
    });
    expect(res.status).toBe(201);
    expect(res.body["duplicate"]).toBe(true);
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from voice_messages where idempotency_key = ${`sms-${runId}-1`}
    `.execute(ctx.database.db);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("records an inbound message once and raises the unread count", async () => {
    const body = {
      eventId: `evt-${runId}-in`,
      type: "message.inbound",
      occurredAt: new Date().toISOString(),
      messageId: `SM-in-${runId}`,
      channel: "sms",
      direction: "inbound",
      from: DESTINATION,
      to: ENDPOINT,
      body: "customer reply",
    };
    await callback(body);
    await callback({ ...body, eventId: `evt-${runId}-in-dup` });

    const conversation = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId ?? ""}`);
    expect((conversation.body["conversation"] as Record<string, unknown>)["unreadCount"]).toBe(1);
    const messages = conversation.body["messages"] as { direction: string; state: string }[];
    const inbound = messages.filter((message) => message.direction === "inbound");
    expect(inbound.length).toBe(1);
    expect(inbound[0]?.state).toBe("delivered");
  });

  it("moves to delivered only on a callback and never regresses", async () => {
    const list = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId ?? ""}`);
    const outbound = (list.body["messages"] as { id: string; direction: string; providerMessageId: string | null }[]).find(
      (message) => message.direction === "outbound",
    );
    const providerMessageId = String(outbound?.providerMessageId ?? "");

    await callback({
      eventId: `evt-${runId}-delivered`,
      type: "message.status",
      occurredAt: new Date().toISOString(),
      messageId: providerMessageId,
      status: "delivered",
      channel: "sms",
    });
    // A late "sent" callback must not undo delivery.
    await callback({
      eventId: `evt-${runId}-late-sent`,
      type: "message.status",
      occurredAt: new Date().toISOString(),
      messageId: providerMessageId,
      status: "sent",
      channel: "sms",
    });

    const after = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId ?? ""}`);
    const stored = (after.body["messages"] as { id: string; state: string }[]).find((message) => message.id === outbound?.id);
    expect(stored?.state).toBe("delivered");
  });

  it("refuses to send after consent is revoked", async () => {
    await call("POST", "/api/v1/VoiceCommunications/action/consent", {
      channel: "sms",
      address: DESTINATION,
      purpose: "service",
      status: "revoked",
      source: "manual_record",
    });
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "sms",
      to: DESTINATION,
      body: marker("should not send"),
      idempotencyKey: `sms-${runId}-revoked`,
    });
    expect(res.status).toBe(422);
    expect(refusals(res.body)).toContain("consent_required");
    await call("POST", "/api/v1/VoiceCommunications/action/consent", {
      channel: "sms",
      address: DESTINATION,
      purpose: "service",
      status: "granted",
      basis: "explicit_opt_in",
      source: "manual_record",
    });
  });

  it("stores an internal note without a provider message id", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "sms",
      conversationId,
      body: marker("internal note only"),
      idempotencyKey: `sms-${runId}-note`,
      isInternalNote: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const message = res.body["message"] as Record<string, unknown>;
    expect(message["isInternalNote"]).toBe(true);
    expect(message["providerMessageId"]).toBeNull();
    expect(message["state"]).toBe("draft");
  });
});

describe("WhatsApp template policy (19-VC.11)", () => {
  it("blocks a free-form WhatsApp message outside the service window", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "whatsapp",
      to: DESTINATION,
      body: marker("free form"),
      idempotencyKey: `wa-${runId}-free`,
    });
    expect(res.status).toBe(422);
    expect(refusals(res.body)).toContain("template_required");
  });

  it("records an approved template and validates its variables", async () => {
    const template = await call("POST", `/api/v1/VoiceCommunications/action/templates/${accountKey}`, {
      templateKey: "agent_test_welcome",
      name: marker("welcome"),
      category: "UTILITY",
      language: "en",
      components: [{ type: "BODY", text: "Hello {{1}}, your request is ready." }],
      status: "approved",
    });
    expect(template.status, JSON.stringify(template.body)).toBe(200);
    expect(template.body["status"]).toBe("approved");

    const missing = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "whatsapp",
      to: DESTINATION,
      body: "",
      idempotencyKey: `wa-${runId}-missing`,
      templateKey: "agent_test_welcome",
      templateLanguage: "en",
      templateVariables: {},
    });
    expect(missing.status).toBe(422);
    expect(refusals(missing.body)).toContain("payload_invalid");

    const sent = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "whatsapp",
      to: DESTINATION,
      body: "",
      idempotencyKey: `wa-${runId}-templated`,
      templateKey: "agent_test_welcome",
      templateLanguage: "en",
      templateVariables: { "1": "Jacky" },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((sent.body["message"] as Record<string, unknown>)["state"]).toBe("sent");
  });

  it("refuses a rejected template", async () => {
    await call("POST", `/api/v1/VoiceCommunications/action/templates/${accountKey}/agent_test_welcome/en/status`, {
      status: "rejected",
      rejectionReason: "policy",
    });
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "whatsapp",
      to: DESTINATION,
      body: "",
      idempotencyKey: `wa-${runId}-rejected`,
      templateKey: "agent_test_welcome",
      templateLanguage: "en",
      templateVariables: { "1": "Jacky" },
    });
    expect(res.status).toBe(422);
    expect(refusals(res.body)).toContain("template_required");
  });

  it("refuses MMS because the simulator does not declare it", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/messages/send", {
      channel: "mms",
      to: DESTINATION,
      body: marker("mms"),
      idempotencyKey: `mms-${runId}-1`,
    });
    expect(res.status).toBe(422);
    expect(refusals(res.body)).toContain("capability_missing");
  });
});
