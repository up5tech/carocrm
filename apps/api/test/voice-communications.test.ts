import { createHmac } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signFakeWebhook } from "../src/voice-communications/voice-provider.js";
import type { ApiContext, TestUser } from "./support/boot-api.js";
import {
  authHeader,
  bootApi,
  createTestRole,
  createTestUser,
  shutdownApi,
} from "./support/boot-api.js";

/**
 * Phase 19-VC.2–19-VC.6 — module registration, provider accounts, webhook ingress/processing,
 * contact resolution and channel policy
 * (`PLAN_Phase_19_Voice_Communications.md` §15 `19-VC.2`–`19-VC.6` acceptance).
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1). No
 * database, schema or container is created. The only provider is the in-process simulator: nothing
 * here places a call, sends a message or contacts an external host.
 *
 * Every row this suite creates carries `runId` and is removed by exact id/key in `afterAll`; the
 * module's own rows cascade from the provider account, and outbox rows are deleted by the
 * `accountKey` this run wrote into their payload (§3.3–§3.4).
 */
let ctx: ApiContext;
let runId: string;
let accountKey: string;
let webhookSecret: string;
let restrictedUser: TestUser;

const contactIds: string[] = [];
const createdAccountKeys: string[] = [];
const TEST_PHONE = "+1 (415) 555-0100";
const TEST_PHONE_E164 = "+14155550100";

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  token = ctx.adminToken,
  headers: Record<string, string> = {},
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token), ...headers },
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

async function publicPost(url: string, payload: Record<string, unknown>, headers: Record<string, string>) {
  const res = await ctx.app.inject({ method: "POST", url, headers, payload });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function publicPostForm(url: string, payload: Record<string, string>, headers: Record<string, string>) {
  const res = await ctx.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(payload).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** Twilio's signature over the URL plus sorted form fields, independent of the adapter's helper. */
function twilioSignature(secret: string, url: string, payload: Record<string, string>): string {
  const material = Object.keys(payload)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${payload[key]}`, url);
  return createHmac("sha1", secret).update(material, "utf8").digest("base64");
}

async function createContact(phoneNumber: string, suffix: string): Promise<string> {
  const res = await call("POST", "/api/v1/Contact", {
    name: marker(suffix),
    firstName: "AGENT_TEST",
    lastName: `${runId} ${suffix}`,
    phoneNumber,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body["id"]);
  contactIds.push(id);
  return id;
}

function signedHeaders(body: Record<string, unknown>, timestamp = new Date().toISOString()): Record<string, string> {
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": signFakeWebhook(webhookSecret, timestamp, body),
  };
}

beforeAll(async () => {
  // Config is read once at boot: the encryption key must exist before `bootApi()` so provider
  // secrets can be stored, and the worker capability so the processing door can be exercised.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? "agent-test-worker-secret";
  ctx = await bootApi();
  runId = Date.now().toString(36);
  accountKey = `agent_test_${runId}`;
  webhookSecret = `whsec_agent_test_${runId}`;
  restrictedUser = await createTestUser(ctx, { userName: `agent_test_voice_${runId}` });
});

afterAll(async () => {
  const db = ctx.database.db;
  // Test data only, by exact ids/keys this run created (§3.3). Children go before parents.
  if (contactIds.length > 0) {
    await db.deleteFrom("entity_records").where("id", "in", contactIds).execute();
  }
  await sql`delete from voice_consent_events where address = ${TEST_PHONE_E164}`.execute(db);
  await sql`delete from voice_suppressions where address = ${TEST_PHONE_E164}`.execute(db);
  for (const key of createdAccountKeys) {
    // Children first: conversations and sessions reference the account with ON DELETE RESTRICT.
    await sql`delete from voice_conversations where account_key = ${key}`.execute(db);
    await sql`delete from voice_call_sessions where account_key = ${key}`.execute(db);
    await sql`delete from outbox_events where payload->>'accountKey' = ${key}`.execute(db);
    await sql`delete from voice_provider_accounts where key = ${key}`.execute(db);
  }
  // Restore the module's settings row to defaults so a later suite starts clean.
  await ctx.app
    .inject({
      method: "POST",
      url: "/api/v1/VoiceCommunications/action/settings",
      headers: authHeader(ctx.adminToken),
      payload: {
        features: { voice: false, sms: false, mms: false, whatsapp: false, recordings: false, transcripts: false, aiEnrichment: false },
        provider: { defaultAccountKey: "" },
        policy: { quietHours: { enabled: false }, requireConsent: { sms: true, mms: true, whatsapp: true } },
      },
    })
    .catch(() => undefined);
  await db.deleteFrom("users").where("user_name", "=", restrictedUser.userName).execute();
  await shutdownApi();
});

describe("module registration and settings (19-VC.2)", () => {
  it("reports health with the module's own identity and no Ua prefix", async () => {
    const res = await call("GET", "/api/v1/VoiceCommunications/action/health");
    expect(res.status).toBe(200);
    const module = res.body["module"] as Record<string, unknown>;
    expect(module["id"]).toBe("VoiceCommunications");
    expect(module["apiPrefix"]).toBe("/api/v1/VoiceCommunications");
    expect(JSON.stringify(res.body)).not.toMatch(/\bUa[A-Z]/);
    expect(res.body["ok"]).toBe(true);
  });

  it("serves validated defaults and refuses an unknown settings key", async () => {
    const read = await call("GET", "/api/v1/VoiceCommunications/action/settings");
    expect(read.status).toBe(200);
    const settings = read.body["settings"] as Record<string, unknown>;
    // The row is shared across suites, so this asserts the shape and the safe default of the flags
    // rather than a boolean another suite may have changed.
    expect(settings["features"]).toHaveProperty("voice");
    expect(settings["features"]).toHaveProperty("sms");
    expect(settings["features"]).toHaveProperty("whatsapp");
    expect(settings["policy"]).toHaveProperty("defaultRegion");
    expect(JSON.stringify(read.body)).not.toContain("credential");

    const bad = await call("POST", "/api/v1/VoiceCommunications/action/settings", { nonsense: true });
    expect(bad.status).toBe(422);
  });

  it("reports navigation visibility for the admin caller", async () => {
    const res = await call("GET", "/api/v1/VoiceCommunications/action/nav");
    expect(res.status).toBe(200);
    expect(res.body["visible"]).toBe(true);
  });

  it("lists the Voice & Communications administration tab for an administrator", async () => {
    const res = await call("GET", "/api/v1/AdminPanel");
    expect(res.status).toBe(200);
    const groups = res.body["groups"] as { tabs: { key: string; route: string; moduleEndpoint?: string; docKey?: string }[] }[];
    const tab = groups.flatMap((group) => group.tabs).find((entry) => entry.key === "voiceCommunications");
    expect(tab).toMatchObject({
      route: "/admin/settings/voiceCommunications",
      moduleEndpoint: "VoiceCommunications",
      docKey: "admin/voice",
    });
  });
});

describe("provider accounts and health (19-VC.4)", () => {
  it("creates a simulator account and never returns the webhook secret", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
      key: accountKey,
      providerKey: "fake",
      label: marker("simulator"),
      environment: "test",
      enabled: true,
      capabilities: [
        "voice.outboundCall",
        "voice.inboundEvents",
        "messaging.sms.send",
        "messaging.sms.receive",
        "messaging.deliveryStatus",
        "webhook.signatureValidation",
        "provider.healthCheck",
      ],
      config: {},
      webhookSecret,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    createdAccountKeys.push(accountKey);
    expect(res.body["hasWebhookSecret"]).toBe(true);
    expect(res.body["webhookSecretHint"]).toMatch(/^••••/);
    expect(JSON.stringify(res.body)).not.toContain(webhookSecret);
    expect(res.body["effectiveCapabilities"]).toContain("messaging.sms.send");
  });

  it("refuses to enable an account whose adapter validates signatures without a secret", async () => {
    const key = `agent_test_nosecret_${runId}`;
    const res = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
      key,
      providerKey: "fake",
      label: marker("no secret"),
      environment: "test",
      enabled: true,
      capabilities: ["messaging.sms.send"],
      config: {},
    });
    expect(res.status).toBe(422);
    // A refused create leaves no half-configured row behind.
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from voice_provider_accounts where key = ${key}
    `.execute(ctx.database.db);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("refuses a capability the adapter does not declare", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
      key: `agent_test_cap_${runId}`,
      providerKey: "fake",
      label: marker("capability"),
      environment: "test",
      enabled: false,
      capabilities: ["messaging.mms.send"],
      config: {},
    });
    expect(res.status).toBe(422);
  });

  it("refuses a credential smuggled through config", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
      key: `agent_test_cfg_${runId}`,
      providerKey: "fake",
      label: marker("config"),
      environment: "test",
      enabled: false,
      capabilities: [],
      config: { apiKey: "should-not-be-stored" },
    });
    expect(res.status).toBe(422);
  });

  it("runs the simulator health check and persists the outcome", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/accounts/${accountKey}/health`);
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    const read = await call("GET", `/api/v1/VoiceCommunications/action/accounts/${accountKey}`);
    expect((read.body["lastHealth"] as Record<string, unknown>)["status"]).toBe("healthy");
  });

  it("registers the Twilio adapter and deduplicates two distinct form callbacks", async () => {
    const key = `agent_test_twilio_${runId}`;
    const secret = `twilio_auth_${runId}`;
    const callbackUrl = `https://crm.example.com/api/v1/integrations/voice-communications/twilio/${key}/status-events`;
    const account = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
      key,
      providerKey: "twilio",
      label: marker("twilio adapter"),
      environment: "test",
      enabled: true,
      capabilities: ["voice.inboundEvents", "voice.callStatusCallbacks", "webhook.signatureValidation"],
      config: { accountSid: "AC_agent_test", webhookUrl: callbackUrl },
      credential: secret,
      webhookSecret: secret,
    });
    expect(account.status, JSON.stringify(account.body)).toBe(201);
    createdAccountKeys.push(key);

    const callbacks = [
      { CallSid: `CA_${runId}`, CallStatus: "ringing", Direction: "inbound-api", From: TEST_PHONE_E164, To: "+14155550199" },
      { CallSid: `CA_${runId}`, CallStatus: "completed", Direction: "inbound-api", From: TEST_PHONE_E164, To: "+14155550199" },
    ];
    const accepted: boolean[] = [];
    for (const payload of callbacks) {
      const res = await publicPostForm(
        `/api/v1/integrations/voice-communications/twilio/${key}/status-events`,
        payload,
        { "x-twilio-signature": twilioSignature(secret, callbackUrl, payload) },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      accepted.push(res.body["duplicate"] === true);
    }
    // Different statuses for the same CallSid are two callbacks, not one. Before the validator-derived
    // dedup key, both looked like the generic "unknown" digest and the second was silently dropped.
    expect(accepted).toEqual([false, false]);
    const receipts = await sql<{ count: number }>`
      select count(*)::int as count from voice_webhook_events where account_key = ${key}
    `.execute(ctx.database.db);
    expect(receipts.rows[0]?.count).toBe(2);
  });

  it("normalizes an endpoint address to E.164", async () => {
    const res = await call("POST", `/api/v1/VoiceCommunications/action/accounts/${accountKey}/endpoints`, {
      key: "main",
      channel: "sms",
      address: "(415) 555-0199",
      country: "US",
      active: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["address"]).toBe("+14155550199");
    expect(res.body["displayAddress"]).toBe("(415) 555-0199");
  });
});

describe("webhook ingress and durable processing (19-VC.5)", () => {
  const eventId = () => `evt_${runId}_1`;
  const body = () => ({
    eventId: eventId(),
    type: "message.inbound",
    occurredAt: new Date().toISOString(),
    messageId: `SM_${runId}`,
    channel: "sms",
    direction: "inbound",
    from: TEST_PHONE_E164,
    to: "+14155550199",
    body: "hello from the simulator",
  });
  const url = () => `/api/v1/integrations/voice-communications/fake/${accountKey}/message-events`;

  it("accepts a signed callback, processes it once and emits one domain event", async () => {
    const payload = body();
    const accepted = await publicPost(url(), payload, signedHeaders(payload));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body["duplicate"]).toBe(false);

    const processed = await call(
      "POST",
      "/api/v1/VoiceCommunications/action/webhook-events/process",
      { eventId: accepted.body["eventId"] },
      ctx.adminToken,
      { "x-worker-secret": process.env.REPORT_WORKER_SECRET ?? "" },
    );
    expect(processed.status, JSON.stringify(processed.body)).toBe(200);
    expect(processed.body["status"]).toBe("processed");
    expect(processed.body["kind"]).toBe("message");

    const events = await sql<{ count: number }>`
      select count(*)::int as count from voice_communication_events where webhook_event_id = ${String(accepted.body["eventId"])}
    `.execute(ctx.database.db);
    expect(events.rows[0]?.count).toBe(1);

    const outbox = await sql<{ count: number }>`
      select count(*)::int as count from outbox_events
      where event_type = 'voiceCommunications.message.received' and payload->>'accountKey' = ${accountKey}
    `.execute(ctx.database.db);
    expect(outbox.rows[0]?.count).toBe(1);
  });

  it("records a duplicate callback once and does not create a second event", async () => {
    const payload = body();
    const again = await publicPost(url(), payload, signedHeaders(payload));
    expect(again.status).toBe(202);
    expect(again.body["duplicate"]).toBe(true);

    const receipts = await sql<{ count: number }>`
      select count(*)::int as count from voice_webhook_events
      where account_key = ${accountKey} and vendor_event_id = ${eventId()}
    `.execute(ctx.database.db);
    expect(receipts.rows[0]?.count).toBe(1);
    const events = await sql<{ count: number }>`
      select count(*)::int as count from voice_communication_events where external_id = ${`SM_${runId}`}
    `.execute(ctx.database.db);
    expect(events.rows[0]?.count).toBe(1);
  });

  it("rejects an invalid signature before any effect and records the refusal", async () => {
    const payload = { ...body(), eventId: `evt_${runId}_bad` };
    const rejected = await publicPost(url(), payload, {
      "x-webhook-timestamp": new Date().toISOString(),
      "x-webhook-signature": "not-a-signature",
    });
    expect(rejected.status).toBe(401);
    const receipts = await sql<{ processing_status: string; signature_valid: boolean }>`
      select processing_status, signature_valid from voice_webhook_events where vendor_event_id = ${`evt_${runId}_bad`}
    `.execute(ctx.database.db);
    expect(receipts.rows[0]).toMatchObject({ processing_status: "rejected", signature_valid: false });
    const events = await sql<{ count: number }>`
      select count(*)::int as count from voice_communication_events where external_id = ${`SM_${runId}`}
    `.execute(ctx.database.db);
    expect(events.rows[0]?.count).toBe(1);
  });

  it("refuses a callback outside the replay window", async () => {
    const payload = { ...body(), eventId: `evt_${runId}_old` };
    const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await publicPost(url(), payload, signedHeaders(payload, oldTimestamp));
    expect(res.status).toBe(401);
    const receipts = await sql<{ failure_code: string }>`
      select failure_code from voice_webhook_events where vendor_event_id = ${`evt_${runId}_old`}
    `.execute(ctx.database.db);
    expect(receipts.rows[0]?.failure_code).toBe("REPLAY_WINDOW");
  });

  it("refuses a routing pair that names no configured account", async () => {
    const payload = { ...body(), eventId: `evt_${runId}_route` };
    const res = await publicPost(
      `/api/v1/integrations/voice-communications/fake/agent_test_missing_${runId}/message-events`,
      payload,
      signedHeaders(payload),
    );
    expect(res.status).toBe(404);
  });

  it("exposes the receipt log and refuses replay of an unauthenticated callback", async () => {
    const list = await call("GET", "/api/v1/VoiceCommunications/action/webhook-events?status=rejected");
    expect(list.status).toBe(200);
    const rows = list.body["list"] as { id: string; signatureValid: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.signatureValid === false)).toBe(true);

    const replay = await call("POST", `/api/v1/VoiceCommunications/action/webhook-events/${rows[0]?.id ?? ""}/replay`);
    expect(replay.status).toBe(422);
  });
});

describe("contact resolution (19-VC.6)", () => {
  it("matches one contact by a formatted phone number", async () => {
    const id = await createContact(TEST_PHONE, "contact one");
    const res = await call("POST", "/api/v1/VoiceCommunications/action/resolve", { phone: TEST_PHONE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["status"]).toBe("matched");
    expect(res.body["address"]).toBe(TEST_PHONE_E164);
    const candidates = res.body["candidates"] as { id: string; entityType: string }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(id);
  });

  it("returns an ambiguous result instead of silently choosing a contact", async () => {
    await createContact("(415) 555-0100", "contact two");
    const res = await call("POST", "/api/v1/VoiceCommunications/action/resolve", { phone: "+14155550100" });
    expect(res.body["status"]).toBe("ambiguous");
    expect((res.body["candidates"] as unknown[]).length).toBe(2);
  });

  it("hides records the caller cannot read and never returns their names", async () => {
    await createTestRole(ctx, {
      id: `agent_test_voice_own_${runId}`,
      name: marker("contact own only"),
      permissions: {
        Contact: { create: "no", read: "own", edit: "no", delete: "no", stream: "no" },
        Lead: { create: "no", read: "no", edit: "no", delete: "no", stream: "no" },
        Account: { create: "no", read: "no", edit: "no", delete: "no", stream: "no" },
      },
    });
    const user = await createTestUser(ctx, {
      userName: `agent_test_voice_own_${runId}`,
      roleIds: [`agent_test_voice_own_${runId}`],
    });
    const res = await call("POST", "/api/v1/VoiceCommunications/action/resolve", { phone: TEST_PHONE }, user.token);
    expect(res.status).toBe(200);
    expect(res.body["candidates"]).toEqual([]);
    expect(res.body["hiddenMatches"]).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain("AGENT_TEST");
    await ctx.database.db.deleteFrom("users").where("user_name", "=", user.userName).execute();
    await ctx.database.db.deleteFrom("roles").where("id", "=", `agent_test_voice_own_${runId}`).execute();
  });

  it("rejects a number it cannot normalize instead of guessing", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/resolve", { phone: "not a number" });
    expect(res.body["status"]).toBe("invalid");
    expect(res.body["candidates"]).toEqual([]);
  });
});

describe("consent and channel policy (19-VC.6)", () => {
  beforeAll(async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/settings", {
      features: { sms: true },
      provider: { defaultAccountKey: accountKey },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("blocks a send without consent and allows it once consent is recorded", async () => {
    const blocked = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: TEST_PHONE_E164,
    });
    expect(blocked.body["allowed"]).toBe(false);
    expect((blocked.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("consent_required");

    const recorded = await call("POST", "/api/v1/VoiceCommunications/action/consent", {
      channel: "sms",
      address: TEST_PHONE_E164,
      purpose: "service",
      status: "granted",
      basis: "explicit_opt_in",
      source: "manual_record",
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body["status"]).toBe("granted");

    const allowed = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: TEST_PHONE_E164,
    });
    expect(allowed.body["allowed"]).toBe(true);
    expect(allowed.body["refusals"]).toEqual([]);
  });

  it("suppression wins over consent and revocation restores eligibility", async () => {
    const suppressed = await call("POST", "/api/v1/VoiceCommunications/action/suppressions", {
      channel: "sms",
      address: TEST_PHONE_E164,
      reason: "opt_out",
      source: "manual_record",
    });
    expect(suppressed.status).toBe(201);

    const blocked = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: TEST_PHONE_E164,
    });
    expect(blocked.body["allowed"]).toBe(false);
    expect((blocked.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("suppressed");

    const revoked = await call(
      "DELETE",
      `/api/v1/VoiceCommunications/action/suppressions/sms/${encodeURIComponent(TEST_PHONE_E164)}`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body["revoked"]).toBe(true);

    const allowed = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: TEST_PHONE_E164,
    });
    expect(allowed.body["allowed"]).toBe(true);
  });

  it("applies quiet hours and reports the refusal code", async () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const fmt = (total: number) => {
      const normalized = ((total % 1440) + 1440) % 1440;
      return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
    };
    await call("POST", "/api/v1/VoiceCommunications/action/settings", {
      policy: { quietHours: { enabled: true, start: fmt(minutes - 60), end: fmt(minutes + 60), timezone: "UTC" } },
    });
    const res = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: TEST_PHONE_E164,
    });
    expect((res.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("quiet_hours");
    await call("POST", "/api/v1/VoiceCommunications/action/settings", {
      policy: { quietHours: { enabled: false } },
    });
  });

  it("requires an approved template outside the WhatsApp window", async () => {
    const freeForm = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "whatsapp",
      address: TEST_PHONE_E164,
    });
    expect((freeForm.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("template_required");

    // An unknown/unapproved template is not a bypass: VC.11 refuses it instead of accepting the key.
    const templated = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "whatsapp",
      address: TEST_PHONE_E164,
      templateKey: "agent_test_template",
      templateLanguage: "en",
    });
    expect((templated.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("template_required");
    expect((templated.body["window"] as Record<string, unknown>)["requiresTemplate"]).toBe(true);
  });

  it("refuses an invalid address without throwing", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/policy/evaluate", {
      channel: "sms",
      address: "12345",
    });
    expect(res.status).toBe(200);
    expect((res.body["refusals"] as { code: string }[]).map((r) => r.code)).toContain("invalid_address");
  });
});
