import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signFakeWebhook } from "../src/voice-communications/voice-provider.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, createTestTeam, createTestUser, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-VC.7–19-VC.9 — call sessions, the Call Activity, click-to-call and caller context
 * (`PLAN_Phase_19_Voice_Communications.md` §7.1–§7.4, §15 `19-VC.7`–`19-VC.9`).
 *
 * Runs against the configured database through the real HTTP API. The only provider is the
 * simulator, whose `sandboxRecipients` allowlist contains exactly the test destination, so no real
 * number can be dialled even if the code were wrong (§15.4).
 *
 * The suite removes only the rows it created, by exact key/id (§3.3–§3.4).
 */
let ctx: ApiContext;
let runId: string;
let accountKey: string;
let webhookSecret: string;
let contactId: string | null = null;
let inboundSessionId: string | null = null;
let teamUserId: string | null = null;

const DESTINATION = "+14155550111";
const ENDPOINT = "+14155550199";
const activityIds: string[] = [];
const sessionIds: string[] = [];

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

async function callback(body: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const signature = signFakeWebhook(webhookSecret, timestamp, body);
  const accepted = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/integrations/voice-communications/fake/${accountKey}/voice-events`,
    headers: { "x-webhook-timestamp": timestamp, "x-webhook-signature": signature },
    payload: body,
  });
  expect(accepted.statusCode, accepted.body).toBe(202);
  const acceptedBody = accepted.json() as Record<string, unknown>;
  const processed = await call(
    "POST",
    "/api/v1/VoiceCommunications/action/webhook-events/process",
    { eventId: acceptedBody["eventId"] },
    { "x-worker-secret": process.env.REPORT_WORKER_SECRET ?? "" },
  );
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return acceptedBody;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? "agent-test-worker-secret";
  ctx = await bootApi();
  runId = Date.now().toString(36);
  accountKey = `agent_test_calls_${runId}`;
  webhookSecret = `whsec_agent_calls_${runId}`;

  const account = await call("POST", "/api/v1/VoiceCommunications/action/accounts", {
    key: accountKey,
    providerKey: "fake",
    label: marker("calls"),
    environment: "test",
    enabled: true,
    capabilities: [
      "voice.outboundCall",
      "voice.inboundEvents",
      "voice.callStatusCallbacks",
      "webhook.signatureValidation",
      "provider.healthCheck",
    ],
    config: { sandboxRecipients: [DESTINATION] },
    webhookSecret,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const endpoint = await call("POST", `/api/v1/VoiceCommunications/action/accounts/${accountKey}/endpoints`, {
    key: "voice-main",
    channel: "voice",
    address: ENDPOINT,
    country: "US",
    active: true,
  });
  expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);

  // VC.9 routing: the endpoint belongs to a team, and only that team's member is notified.
  const teamId = `agent_test_voice_team_${runId}`;
  await createTestTeam(ctx, teamId, marker("voice team"));
  const teamUser = await createTestUser(ctx, { userName: `agent_test_voice_team_${runId}`, teamIds: [teamId] });
  teamUserId = teamUser.id;
  await sql`update voice_endpoints set team_id = ${teamId} where account_key = ${accountKey} and key = 'voice-main'`.execute(ctx.database.db);

  const settings = await call("POST", "/api/v1/VoiceCommunications/action/settings", {
    features: { voice: true },
    provider: { defaultAccountKey: accountKey },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
});

afterAll(async () => {
  const db = ctx.database.db;
  // Children before parents, scoped to this run's account. The account key is unique to this suite,
  // so this cannot touch another run's rows (§3.3).
  await sql`delete from notifications where data->>'callSessionId' in (
    select id::text from voice_call_sessions where account_key = ${accountKey}
  )`.execute(db);
  await sql`delete from voice_call_sessions where account_key = ${accountKey}`.execute(db);
  for (const id of activityIds) {
    await db.deleteFrom("entity_records").where("id", "=", id).execute();
  }
  if (contactId !== null) await db.deleteFrom("entity_records").where("id", "=", contactId).execute();
  await sql`delete from outbox_events where payload->>'accountKey' = ${accountKey}`.execute(db);
  await sql`delete from voice_provider_accounts where key = ${accountKey}`.execute(db);
  if (teamUserId !== null) await db.deleteFrom("users").where("id", "=", teamUserId).execute();
  await db.deleteFrom("teams").where("id", "=", `agent_test_voice_team_${runId}`).execute();
  await ctx.app
    .inject({
      method: "POST",
      url: "/api/v1/VoiceCommunications/action/settings",
      headers: authHeader(ctx.adminToken),
      payload: { features: { voice: false }, provider: { defaultAccountKey: "" } },
    })
    .catch(() => undefined);
  await shutdownApi();
});

describe("click-to-call (19-VC.8)", () => {
  it("places one call, persists the session and creates a single Call Activity", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/calls/initiate", {
      to: DESTINATION,
      idempotencyKey: `click-${runId}-1`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const session = res.body["session"] as Record<string, unknown>;
    sessionIds.push(String(session["id"]));
    expect(session["state"]).toBe("initiated");
    expect(session["direction"]).toBe("outbound");
    expect(session["toNumber"]).toBe(DESTINATION);
    expect(session["providerCallId"]).toBeTruthy();

    const activityId = session["activityId"];
    expect(typeof activityId).toBe("string");
    activityIds.push(String(activityId));
    const activity = await call("GET", `/api/v1/Call/${String(activityId)}`);
    expect(activity.status).toBe(200);
    expect(activity.body["direction"]).toBe("Outbound");
    expect(activity.body["status"]).toBe("Planned");
  });

  it("reuses the same session for a repeated click", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/calls/initiate", {
      to: DESTINATION,
      idempotencyKey: `click-${runId}-1`,
    });
    expect(res.status).toBe(201);
    expect(res.body["duplicate"]).toBe(true);
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from voice_call_sessions where idempotency_key = ${`click-${runId}-1`}
    `.execute(ctx.database.db);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("refuses a destination outside the simulator allowlist", async () => {
    const res = await call("POST", "/api/v1/VoiceCommunications/action/calls/initiate", {
      to: "+14155559999",
      idempotencyKey: `click-${runId}-outside`,
    });
    expect(res.status).toBe(201);
    const session = res.body["session"] as Record<string, unknown>;
    sessionIds.push(String(session["id"]));
    expect(session["state"]).toBe("failed");
    expect(session["failureCategory"]).toBe("invalid_recipient");
    if (typeof session["activityId"] === "string") activityIds.push(session["activityId"]);
  });
});

describe("call lifecycle and the Call Activity (19-VC.7)", () => {
  it("advances one session through callbacks and completes the Activity", async () => {
    const initiated = await call("POST", "/api/v1/VoiceCommunications/action/calls/initiate", {
      to: DESTINATION,
      idempotencyKey: `lifecycle-${runId}`,
    });
    const session = initiated.body["session"] as Record<string, unknown>;
    const sessionId = String(session["id"]);
    const providerCallId = String(session["providerCallId"]);
    const activityId = String(session["activityId"]);
    sessionIds.push(sessionId);
    activityIds.push(activityId);

    for (const status of ["ringing", "in-progress", "completed"]) {
      await callback({
        eventId: `evt-${runId}-${status}`,
        type: "call.status",
        occurredAt: new Date().toISOString(),
        callId: providerCallId,
        status,
        direction: "outbound",
        from: ENDPOINT,
        to: DESTINATION,
        ...(status === "completed" ? { durationSeconds: 42 } : {}),
      });
    }

    const read = await call("GET", `/api/v1/VoiceCommunications/action/calls/${sessionId}`);
    expect(read.status).toBe(200);
    expect(read.body["state"]).toBe("completed");
    expect(read.body["durationSeconds"]).toBe(42);

    const activity = await call("GET", `/api/v1/Call/${activityId}`);
    expect(activity.body["status"]).toBe("Held");
    expect(activity.body["duration"]).toBe(42);

    const activities = await sql<{ count: number }>`
      select count(*)::int as count from entity_records
      where entity_type = 'Call' and id = ${activityId}
    `.execute(ctx.database.db);
    expect(activities.rows[0]?.count).toBe(1);
  });

  it("does not regress a completed call when an older callback is replayed", async () => {
    const read = await call("GET", `/api/v1/VoiceCommunications/action/calls/${sessionIds[sessionIds.length - 1] ?? ""}`);
    const providerCallId = String(read.body["providerCallId"]);

    await callback({
      eventId: `evt-${runId}-replay-ringing`,
      type: "call.status",
      occurredAt: new Date().toISOString(),
      callId: providerCallId,
      status: "ringing",
      direction: "outbound",
      from: ENDPOINT,
      to: DESTINATION,
    });

    const after = await call("GET", `/api/v1/VoiceCommunications/action/calls/${sessionIds[sessionIds.length - 1] ?? ""}`);
    expect(after.body["state"]).toBe("completed");
  });

  it("records an inbound missed call as Not Held and keeps one Activity", async () => {
    const providerCallId = `CA-in-${runId}`;
    await callback({
      eventId: `evt-${runId}-inbound`,
      type: "call.status",
      occurredAt: new Date().toISOString(),
      callId: providerCallId,
      status: "missed",
      direction: "inbound",
      from: DESTINATION,
      to: ENDPOINT,
    });

    const rows = await sql<{ id: string; state: string; activity_id: string | null; direction: string }>`
      select id, state, activity_id, direction from voice_call_sessions
      where account_key = ${accountKey} and provider_call_id = ${providerCallId}
    `.execute(ctx.database.db);
    const row = rows.rows[0];
    expect(row?.state).toBe("missed");
    expect(row?.direction).toBe("inbound");
    sessionIds.push(String(row?.id));
    inboundSessionId = String(row?.id);
    if (row?.activity_id !== null && row?.activity_id !== undefined) {
      activityIds.push(row.activity_id);
      const activity = await call("GET", `/api/v1/Call/${row.activity_id}`);
      expect(activity.body["direction"]).toBe("Inbound");
      expect(activity.body["status"]).toBe("Not Held");
    }

    // A second callback for the same provider call must not create a second session.
    await callback({
      eventId: `evt-${runId}-inbound-2`,
      type: "call.status",
      occurredAt: new Date().toISOString(),
      callId: providerCallId,
      status: "missed",
      direction: "inbound",
      from: DESTINATION,
      to: ENDPOINT,
    });
    const counted = await sql<{ count: number }>`
      select count(*)::int as count from voice_call_sessions
      where account_key = ${accountKey} and provider_call_id = ${providerCallId}
    `.execute(ctx.database.db);
    expect(counted.rows[0]?.count).toBe(1);
  });

  it("adds a note to the Call Activity and links the call to a Contact", async () => {
    const sessionId = sessionIds[0] ?? "";
    const note = await call("POST", `/api/v1/VoiceCommunications/action/calls/${sessionId}/note`, {
      description: marker("note: customer asked for a callback"),
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const activityId = String(note.body["activityId"]);
    const activity = await call("GET", `/api/v1/Call/${activityId}`);
    expect(String(activity.body["description"])).toContain("customer asked for a callback");

    const contact = await call("POST", "/api/v1/Contact", {
      name: marker("call contact"),
      firstName: "AGENT_TEST",
      lastName: `${runId} call`,
      phoneNumber: DESTINATION,
    });
    contactId = String(contact.body["id"]);
    const linked = await call("POST", `/api/v1/VoiceCommunications/action/calls/${sessionId}/link`, {
      entityType: "Contact",
      entityId: contactId,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body["relatedEntityType"]).toBe("Contact");
    expect(linked.body["relatedEntityId"]).toBe(contactId);
  });

  it("notifies only the endpoint team's member for a ringing inbound call, once", async () => {
    const providerCallId = `CA-ring-${runId}`;
    await callback({
      eventId: `evt-${runId}-ring`,
      type: "call.status",
      occurredAt: new Date().toISOString(),
      callId: providerCallId,
      status: "ringing",
      direction: "inbound",
      from: DESTINATION,
      to: ENDPOINT,
    });

    const rows = await sql<{ user_id: string; data: unknown }>`
      select user_id, data from notifications where data->>'callSessionId' in (
        select id from voice_call_sessions where account_key = ${accountKey} and provider_call_id = ${providerCallId}
      )
    `.execute(ctx.database.db);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.user_id).toBe(teamUserId);
    expect(JSON.stringify(rows.rows[0]?.data)).not.toContain("AGENT_TEST");

    // A replayed ringing callback is the same popup, not a second one.
    await callback({
      eventId: `evt-${runId}-ring-2`,
      type: "call.status",
      occurredAt: new Date().toISOString(),
      callId: providerCallId,
      status: "ringing",
      direction: "inbound",
      from: DESTINATION,
      to: ENDPOINT,
    });
    const again = await sql<{ count: number }>`
      select count(*)::int as count from notifications where data->>'callSessionId' in (
        select id from voice_call_sessions where account_key = ${accountKey} and provider_call_id = ${providerCallId}
      )
    `.execute(ctx.database.db);
    expect(again.rows[0]?.count).toBe(1);

    const incoming = await call("GET", "/api/v1/VoiceCommunications/action/calls/incoming");
    expect(incoming.status).toBe(200);
    const list = incoming.body["list"] as { providerCallId: string }[];
    expect(list.some((session) => session.providerCallId === providerCallId)).toBe(true);
  });

  it("returns caller context with only readable matches", async () => {
    const res = await call("GET", `/api/v1/VoiceCommunications/action/calls/${inboundSessionId ?? ""}/context`);
    expect(res.status).toBe(200);
    const matches = res.body["matches"] as { id: string }[];
    expect(matches.some((match) => match.id === contactId)).toBe(true);
    expect(res.body["hiddenMatches"]).toBe(0);
  });
});
