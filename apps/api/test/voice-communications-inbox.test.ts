import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { signFakeWebhook } from "../src/voice-communications/voice-provider.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, createTestUser, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-VC.12–19-VC.17 — unified inbox, assignment/Service Desk handoff, service snippets,
 * recordings/media, transcription/AI enrichment and the CRM panel
 * (`PLAN_Phase_19_Voice_Communications.md` §9–§10, §15 `19-VC.12` … `19-VC.17`).
 *
 * No network: the simulator is the provider, the fake AI adapter is the model, and `fetch` is
 * stubbed for the one media download the recording path performs.
 */
let ctx: ApiContext;
let runId: string;
let accountKey: string;
let webhookSecret: string;
let conversationId: string | null = null;
let callSessionId: string | null = null;
let mediaId: string | null = null;
let contactId: string | null = null;
let caseId: string | null = null;
let agentUserId: string | null = null;

const DESTINATION = "+14155550131";
const ENDPOINT = "+14155550198";
const AI_CONNECTION_KEY_PREFIX = "agent-test-ai-vc-";

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>, token?: string) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
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

function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"] as Record<string, unknown> | undefined;
  return (error?.["details"] as Record<string, unknown> | undefined) ?? {};
}

async function callback(kind: "message-events" | "media-events", body: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const accepted = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/integrations/voice-communications/fake/${accountKey}/${kind}`,
    headers: {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signFakeWebhook(webhookSecret, timestamp, body),
    },
    payload: body,
  });
  expect(accepted.statusCode, accepted.body).toBe(202);
  const eventId = (accepted.json() as Record<string, unknown>)["eventId"];
  const processed = await call("POST", "/api/v1/VoiceCommunications/action/webhook-events/process", { eventId });
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return processed.body;
}

async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const res = await call("POST", "/api/v1/VoiceCommunications/action/settings", patch);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? "agent-test-worker-secret";
  ctx = await bootApi();
  runId = Date.now().toString(36);
  accountKey = `agent_test_inbox_${runId}`;
  webhookSecret = `whsec_agent_inbox_${runId}`;

  const account = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
    key: accountKey,
    providerKey: "fake",
    label: marker("inbox"),
    environment: "test",
    enabled: true,
    capabilities: [
      "voice.outboundCall",
      "voice.inboundEvents",
      "voice.callStatusCallbacks",
      "messaging.sms.send",
      "messaging.sms.receive",
      "messaging.deliveryStatus",
      "webhook.signatureValidation",
      "provider.healthCheck",
    ],
    config: { sandboxRecipients: [DESTINATION] },
    webhookSecret,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  for (const [key, channel, address] of [
    ["voice-main", "voice", ENDPOINT],
    ["sms-main", "sms", ENDPOINT],
  ] as const) {
    const endpoint = await call("POST", `/api/v1/VoiceCommunications/action/accounts/${accountKey}/endpoints`, {
      key,
      channel,
      address,
      country: "US",
      active: true,
    });
    expect(endpoint.status).toBe(201);
  }

  const aiConnection = await call("POST", "/api/v1/AIAgents/action/providers", {
    kind: "fake",
    key: `${AI_CONNECTION_KEY_PREFIX}${runId}`,
    label: marker("ai connection"),
    baseUrl: "https://example.com/v1",
    models: ["fake-model"],
    dataClasses: ["internal"],
    config: { allowLoopback: false },
    enabled: true,
  });
  expect(aiConnection.status, JSON.stringify(aiConnection.body)).toBe(201);

  await updateSettings({
    // VC.16: enrichment starts disabled so the refusal path is testable before the happy path.
    features: { sms: true, voice: true, recordings: true, transcripts: true, aiEnrichment: false },
    provider: { defaultAccountKey: accountKey },
    media: { fetchMode: "privateStorage", allowedHosts: ["example.com"], retentionDays: 90 },
    ai: { connectionKey: `${AI_CONNECTION_KEY_PREFIX}${runId}`, model: "fake-model" },
  });

  const smsConsent = await call("POST", "/api/v1/VoiceCommunications/action/consent", {
    channel: "sms",
    address: DESTINATION,
    purpose: "service",
    status: "granted",
    basis: "explicit_opt_in",
    source: "manual_record",
  });
  expect(smsConsent.status).toBe(201);

  const agent = await createTestUser(ctx, { userName: `agent_test_inbox_${runId}` });
  agentUserId = agent.id;
});

afterAll(async () => {
  const db = ctx.database.db;
  vi.restoreAllMocks();
  // Children before parents, scoped to this run's account (§3.3).
  await sql`delete from voice_transcripts where call_session_id in (
    select id from voice_call_sessions where account_key = ${accountKey}
  )`.execute(db);
  await sql`delete from voice_media where call_session_id in (
    select id from voice_call_sessions where account_key = ${accountKey}
  )`.execute(db);
  await sql`delete from voice_conversation_events where conversation_id in (
    select id from voice_conversations where account_key = ${accountKey}
  )`.execute(db);
  await sql`delete from voice_conversations where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_call_sessions where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_webhook_events where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_communication_events where account_key = ${accountKey}`.execute(db);
  await sql`delete from voice_message_templates where key like ${`agent-test-${runId}-%`}`.execute(db);
  await sql`delete from voice_consent_events where address = ${DESTINATION}`.execute(db);
  await sql`delete from voice_suppressions where address = ${DESTINATION}`.execute(db);
  if (contactId !== null) await db.deleteFrom("entity_records").where("id", "=", contactId).execute();
  if (caseId !== null) await db.deleteFrom("entity_records").where("id", "=", caseId).execute();
  await sql`delete from outbox_events where payload->>'accountKey' = ${accountKey}`.execute(db);
  await sql`delete from ai_provider_connections where key = ${`${AI_CONNECTION_KEY_PREFIX}${runId}`}`.execute(db);
  await sql`delete from voice_provider_accounts where key = ${accountKey}`.execute(db);
  if (agentUserId !== null) await db.deleteFrom("users").where("id", "=", agentUserId).execute();
  await updateSettings({
    features: { sms: false, voice: false, recordings: false, transcripts: false, aiEnrichment: false },
    provider: { defaultAccountKey: "" },
    media: { fetchMode: "off", allowedHosts: [] },
    ai: { connectionKey: "", model: "" },
  }).catch(() => undefined);
  await shutdownApi();
});

describe("inbox listing and timeline (19-VC.12)", () => {
  it("materializes an inbound message into one conversation and lists it in the inbox", async () => {
    await callback("message-events", {
      eventId: `evt-${runId}-inbox-in`,
      type: "message.inbound",
      occurredAt: new Date().toISOString(),
      messageId: `M-inbox-${runId}`,
      direction: "inbound",
      channel: "sms",
      from: DESTINATION,
      to: ENDPOINT,
      body: marker("inbound for the inbox"),
    });
    const inbox = await call("GET", "/api/v1/VoiceCommunications/action/inbox?limit=50");
    expect(inbox.status).toBe(200);
    const list = inbox.body["list"] as Record<string, unknown>[];
    const mine = list.find((row) => row["externalThreadId"] === DESTINATION);
    expect(mine).toBeDefined();
    conversationId = String(mine?.["id"]);
    expect(Number(mine?.["unreadCount"])).toBeGreaterThan(0);
  });

  it("merges messages and history events into one chronological timeline", async () => {
    const timeline = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/timeline`);
    expect(timeline.status).toBe(200);
    const entries = timeline.body["entries"] as Record<string, unknown>[];
    const message = entries.find((entry) => entry["kind"] === "message");
    expect(message).toBeDefined();
    const flagged = (message?.["message"] as Record<string, unknown>) ?? {};
    expect(flagged["isInternalNote"]).toBe(false);
  });

  it("marks read and keeps the status history with actor and time", async () => {
    const read = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/read`);
    expect(read.status).toBe(200);
    expect(read.body["unreadCount"]).toBe(0);

    const statusChange = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/status`, {
      status: "pending_customer",
      reason: marker("waiting for the customer"),
    });
    expect(statusChange.status, JSON.stringify(statusChange.body)).toBe(200);
    expect((statusChange.body as Record<string, unknown>)["status"]).toBe("pending_customer");

    const history = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/history`);
    const events = history.body["list"] as Record<string, unknown>[];
    const recorded = events.find((event) => event["kind"] === "status_changed");
    expect(recorded).toBeDefined();
    expect(recorded?.["fromValue"]).toBe("open");
    expect(recorded?.["toValue"]).toBe("pending_customer");
    expect(recorded?.["actorUserId"]).toBeTruthy();
    expect(typeof recorded?.["createdAt"]).toBe("string");
  });
});

describe("assignment and Service Desk handoff (19-VC.13)", () => {
  it("assigns to a user and records the assignment history", async () => {
    const assigned = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/assign`, {
      userId: agentUserId,
      reason: marker("queue pick"),
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((assigned.body as Record<string, unknown>)["assignedUserId"]).toBe(agentUserId);
    const history = await call("GET", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/history`);
    const events = history.body["list"] as Record<string, unknown>[];
    expect(events.some((event) => event["kind"] === "assigned" && event["toValue"] === agentUserId)).toBe(true);
  });

  it("refuses an assignment to a user that does not exist", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/assign`, {
      userId: `u_missing_${runId}`,
    });
    expect(res.status).toBe(422);
  });

  it("hands off once: a repeated click returns the same Case, never a duplicate", async () => {
    const first = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/case/handoff`, {
      subject: marker("duplicate charge report"),
      description: marker("The customer reports a duplicate September charge."),
      reason: "billing dispute",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    caseId = String(first.body["caseId"]);
    expect(first.body["duplicate"]).toBe(false);

    const repeat = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/case/handoff`, {
      subject: marker("duplicate charge report"),
      description: marker("Clicked again."),
    });
    expect(repeat.status).toBe(201);
    expect(repeat.body["duplicate"]).toBe(true);
    expect(repeat.body["caseId"]).toBe(caseId);

    const rows = await sql<{ count: number }>`
      select count(*)::int as count from entity_records
      where entity_type = 'Case' and id = ${caseId}
    `.execute(ctx.database.db);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("keeps conversation status and Case status independent", async () => {
    await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/status`, {
      status: "resolved",
    });
    const caseRow = await sql<{ attrs: Record<string, unknown> }>`
      select attrs from entity_records where entity_type = 'Case' and id = ${caseId}
    `.execute(ctx.database.db);
    // The handoff created the Case as New; a conversation status change never mutates it (§9.2).
    expect(caseRow.rows[0]?.attrs["status"]).toBe("New");
  });

  it("links an existing Case without touching its status", async () => {
    const linked = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/case/link`, {
      caseId: caseId as string,
    });
    expect(linked.status).toBe(200);
    expect((linked.body as Record<string, unknown>)["caseId"]).toBe(caseId);
  });
});

describe("service snippets and composer validation (19-VC.14)", () => {
  const snippetKey = `agent-test-${runId}-refund`;

  it("creates a snippet, detects placeholders and renders with caller-provided values", async () => {
    const created = await call("POST", "/api/v1/VoiceCommunications/action/snippets", {
      key: snippetKey,
      name: marker("refund confirmation"),
      channel: "sms",
      body: "Hi {{firstName}}, your refund for {{amount}} was issued today. Reference {{reference}}.",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body["placeholders"]).toEqual(["firstName", "amount", "reference"]);

    const rendered = await call("POST", `/api/v1/VoiceCommunications/action/snippets/${snippetKey}/render`, {
      variables: { firstName: "Dana", amount: "$49.00", reference: "RF-1001" },
    });
    expect(rendered.status).toBe(200);
    expect(rendered.body["body"]).toBe("Hi Dana, your refund for $49.00 was issued today. Reference RF-1001.");
    const segments = rendered.body["segments"] as Record<string, unknown>;
    expect(segments["encoding"]).toBe("GSM-7");
    expect(Number(segments["segments"])).toBe(1);
  });

  it("refuses to render when a placeholder value is missing", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/snippets/${snippetKey}/render`, {
      variables: { firstName: "Dana" },
    });
    expect(res.status).toBe(422);
    expect(errorDetails(res.body)["missing"]).toEqual(["amount", "reference"]);
  });

  it("warns about UCS-2 encoding and over-length bodies in the composer check", async () => {
    const unicode = await call("POST", "/api/v1/VoiceCommunications/action/composer/validate", {
      channel: "sms",
      body: "Cảm ơn anh đã liên hệ ✅",
    });
    expect(unicode.status).toBe(200);
    expect((unicode.body["segments"] as Record<string, unknown>)["encoding"]).toBe("UCS-2");
    expect(unicode.body["ok"]).toBe(false);

    const tooLong = await call("POST", "/api/v1/VoiceCommunications/action/composer/validate", {
      channel: "sms",
      body: "x".repeat(1700),
    });
    expect(tooLong.status).toBe(200);
    expect((tooLong.body["warnings"] as string[]).length).toBeGreaterThan(0);
  });
});

describe("recordings and secure media (19-VC.15)", () => {
  it("places a call through the simulator so a recording has a session to belong to", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/calls/initiate", {
      to: DESTINATION,
      idempotencyKey: `inbox-call-${runId}-1`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const session = res.body["session"] as Record<string, unknown>;
    callSessionId = String(session["id"]);
    expect(session["state"]).toBe("initiated");
  });

  it("registers a recording reference from a signed callback and refuses a private URL", async () => {
    const processed = await callback("media-events", {
      eventId: `evt-${runId}-recording`,
      type: "call.recording",
      occurredAt: new Date().toISOString(),
      callId: String((await call("GET", `/api/v1/VoiceCommunications/action/calls/${callSessionId}`)).body["providerCallId"]),
      recordingId: `RE-${runId}`,
      recordingUrl: "https://example.com/recordings/one.wav",
      mimeType: "audio/wav",
      durationSeconds: 42,
    });
    expect(processed["status"]).toBe("processed");

    const media = await call("GET", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/media`);
    const list = media.body["list"] as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0]?.["kind"]).toBe("recording");
    expect(list[0]?.["providerRef"]).toBe("https://example.com/recordings/one.wav");
    mediaId = String(list[0]?.["id"]);

    // SSRF: a metadata URL is refused before any reference is stored.
    const bad = await callback("media-events", {
      eventId: `evt-${runId}-recording-ssrf`,
      type: "call.recording",
      occurredAt: new Date().toISOString(),
      callId: String((await call("GET", `/api/v1/VoiceCommunications/action/calls/${callSessionId}`)).body["providerCallId"]),
      recordingId: `RE-${runId}-bad`,
      recordingUrl: "http://169.254.169.254/latest/meta-data",
      mimeType: "audio/wav",
      durationSeconds: 1,
    });
    // The verdict lands on the receipt, and no second media reference exists.
    expect(bad["status"]).toBe("processed");
    const after = await call("GET", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/media`);
    expect(((after.body["list"] as Record<string, unknown>[]) ?? []).length).toBe(1);
  });

  it("fetches into private storage through the worker and serves authorized playback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
      ),
    );
    const fetched = await call("POST", "/api/v1/VoiceCommunications/action/media/fetch", { mediaId: mediaId as string });
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    expect(fetched.body["stored"]).toBe(true);

    const playback = await call("GET", `/api/v1/VoiceCommunications/action/media/${mediaId}/playback`);
    expect(playback.status).toBe(200);
    expect(playback.body["contentType"]).toBe("audio/wav");
    expect(typeof playback.body["dataBase64"]).toBe("string");
    vi.restoreAllMocks();
  });

  it("hides playback from a caller without access to the parent call", async () => {
    const outsider = await createTestUser(ctx, { userName: `agent_test_outsider_${runId}` });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/VoiceCommunications/action/media/${mediaId}/playback`,
      headers: authHeader(outsider.token),
    });
    expect(res.statusCode).toBe(404);
    await ctx.database.db.deleteFrom("users").where("id", "=", outsider.id).execute();
  });
});

describe("transcription and AI enrichment (19-VC.16)", () => {
  it("retrieves the transcript through the adapter with segments and provenance", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/request`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const transcript = res.body as Record<string, unknown>;
    expect(transcript["state"]).toBe("ready");
    const segments = transcript["segments"] as Record<string, unknown>[];
    expect(segments.length).toBe(3);
    expect(segments[0]?.["speaker"]).toBe("agent");
    // Idempotent: a second request returns the same transcript.
    const again = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/request`);
    expect((again.body as Record<string, unknown>)["id"]).toBe(transcript["id"]);
  });

  it("refuses AI enrichment while the feature is disabled by policy", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/enrich`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("aiEnrichment");
  });

  it("enriches draft-only once the feature and connection are configured", async () => {
    await updateSettings({ features: { aiEnrichment: true } });
    const res = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/enrich`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ai = res.body["ai"] as Record<string, unknown>;
    expect(ai["reviewStatus"]).toBe("pending");
    expect(ai["model"]).toBe("fake-model");
    expect(ai["connectionKey"]).toBe(`${AI_CONNECTION_KEY_PREFIX}${runId}`);
    expect(typeof ai["generatedAt"]).toBe("string");
  });

  it("records the review state; approving without a suggestion is refused", async () => {
    // The fake adapter returns an empty enrichment payload, so there is genuinely nothing to approve.
    const approved = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/review`, {
      status: "approved",
    });
    expect(approved.status).toBe(422);
    const dismissed = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/transcript/review`, {
      status: "dismissed",
    });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(((dismissed.body as Record<string, unknown>)["ai"] as Record<string, unknown>)["reviewStatus"]).toBe("dismissed");
  });
});

describe("CRM panels and touchpoints (19-VC.17)", () => {
  it("refuses a panel for an unsupported entity type", async () => {
    const res = await call("GET", "/api/v1/VoiceCommunications/action/panels/Note/whatever");
    expect(res.status).toBe(422);
  });

  it("refuses a panel for a record that does not exist", async () => {
    const res = await call("GET", "/api/v1/VoiceCommunications/action/panels/Contact/no-such-record");
    expect(res.status).toBe(404);
  });

  it("links a conversation to a readable record and shows both conversations and calls", async () => {
    const contact = await call("POST", "/api/v1/Contact", {
      name: marker("panel contact"),
      firstName: "AGENT_TEST",
      lastName: `${runId} panel`,
      phoneNumber: DESTINATION,
    });
    expect(contact.status, JSON.stringify(contact.body)).toBeLessThan(300);
    contactId = String((contact.body as Record<string, unknown>)["id"]);

    const linked = await call("POST", `/api/v1/VoiceCommunications/action/conversations/${conversationId}/link-record`, {
      entityType: "Contact",
      entityId: contactId,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const callLinked = await call("POST", `/api/v1/VoiceCommunications/action/calls/${callSessionId}/link`, {
      entityType: "Contact",
      entityId: contactId,
    });
    expect(callLinked.status, JSON.stringify(callLinked.body)).toBe(200);

    const panel = await call("GET", `/api/v1/VoiceCommunications/action/panels/Contact/${contactId}`);
    expect(panel.status).toBe(200);
    const conversations = panel.body["conversations"] as Record<string, unknown>[];
    const calls = panel.body["calls"] as Record<string, unknown>[];
    expect(conversations.some((row) => row["id"] === conversationId)).toBe(true);
    expect(calls.some((row) => row["id"] === callSessionId)).toBe(true);

    const touchpoints = await call("GET", `/api/v1/VoiceCommunications/action/panels/Contact/${contactId}/touchpoints`);
    expect(touchpoints.status).toBe(200);
    expect(Number(touchpoints.body["conversations"])).toBeGreaterThanOrEqual(1);
    expect(Number(touchpoints.body["calls"])).toBeGreaterThanOrEqual(1);
    // Counts only: no message bodies cross to Customer Success signals (§10.5).
    expect(JSON.stringify(touchpoints.body)).not.toContain("AGENT_TEST_");
  });
});
