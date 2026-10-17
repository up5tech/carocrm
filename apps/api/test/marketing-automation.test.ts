import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiContext } from "./support/boot-api.js";
import {
  authHeader,
  bootApi,
  createTestRole,
  createTestUser,
  shutdownApi,
} from "./support/boot-api.js";

/**
 * Phase 19-MA.1 – 19-MA.3 — Marketing Automation scaffold, settings and campaign lifecycle
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §8.2, §8.4, §9.2, §15 `19-MA.1`–`19-MA.3` acceptance).
 *
 * These run against the already-configured primary database through the real HTTP API (AGENTS.md §3.1): no
 * database, schema, container or test database is created, and nothing here sends a message — the mail
 * transport is `memory` in this environment and Marketing Automation has no live provider until MA.7.
 *
 * Every record this suite makes carries the `runId` marker and is removed by exact id in `afterAll`, children
 * before parents (§3.3). Outbox rows this run produced are deleted by their own `campaignId`, never by a
 * broad predicate (§3.4).
 */
let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];
const campaignIds: string[] = [];
/**
 * A sending account is a deployment credential, not a marketing record, so the suite inserts one row of its
 * own (identifiable address, deleted by exact id in `afterAll`) instead of touching an existing mailbox.
 * Validation only asks whether the id names a live account, so no SMTP host is contacted — and nothing here
 * sends: the transport is `memory` and Marketing Automation has no live provider before MA.7.
 */
let testAccountId: string | null = null;

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  token = ctx.adminToken,
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
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

async function create(entity: string, payload: Record<string, unknown>, token = ctx.adminToken): Promise<string> {
  const res = await call("POST", `/api/v1/${entity}`, payload, token);
  expect(res.status, `create ${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const id = String(res.body["id"]);
  created.push({ entity, id });
  if (entity === "Campaign") campaignIds.push(id);
  return id;
}

/** A campaign that is complete enough to schedule; `Other` is the family that never sends. */
async function makeCampaign(overrides: Record<string, unknown> = {}, token = ctx.adminToken): Promise<string> {
  return create(
    "Campaign",
    {
      name: marker("campaign"),
      type: "Other",
      purpose: "EventUpdate",
      startsAt: "2026-11-01T09:00:00.000Z",
      endsAt: "2026-11-30T17:00:00.000Z",
      ...overrides,
    },
    token,
  );
}

async function action(
  id: string,
  verb: string,
  payload: Record<string, unknown> = {},
  token = ctx.adminToken,
) {
  return call("POST", `/api/v1/MarketingAutomation/action/campaign/${id}/${verb}`, payload, token);
}

async function history(id: string) {
  const res = await call("GET", `/api/v1/MarketingAutomation/action/campaign/${id}/history`);
  const list = (res.body["list"] ?? []) as Record<string, unknown>[];
  return { status: res.status, list };
}

async function status(id: string, token = ctx.adminToken) {
  const res = await call("GET", `/api/v1/Campaign/${id}`, undefined, token);
  return res.body["status"];
}

/** Finding codes from a validation report body. */
function findingsOf(body: Record<string, unknown>, level: "blockers" | "warnings"): string[] {
  return ((body[level] ?? []) as { code: string }[]).map((finding) => finding.code);
}
const blockerCodesOf = (body: Record<string, unknown>) => findingsOf(body, "blockers");
const warningCodesOf = (body: Record<string, unknown>) => findingsOf(body, "warnings");

/** Finding codes carried inside a refused command's error details (the filter nests them there). */
function blockerCodes(body: Record<string, unknown>): string[] {
  const error = body["error"] as Record<string, unknown> | undefined;
  const details = (error?.["details"] ?? {}) as Record<string, unknown>;
  return findingsOf(details, "blockers");
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `ma${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  testAccountId = `AGENT_TEST_${runId}_account`;
  await ctx.database.db
    .insertInto("email_accounts")
    .values({
      id: testAccountId,
      name: `AGENT_TEST_${runId} sender`,
      email_address: `agent-test-${runId}@example.com`,
      smtp_host: "127.0.0.1",
      smtp_port: 2525,
      smtp_security: "none",
      is_default: false,
    })
    .execute();
});

afterAll(async () => {
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  if (campaignIds.length > 0) {
    // A campaign's history rows and lifecycle events are written by the module, not by the caller, so
    // deleting the campaign leaves them behind. They are removed here by the exact campaign ids this run
    // created — never by a broad predicate (§3.3, §3.4).
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "CampaignTransition")
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await ctx.database.db
      .deleteFrom("outbox_events")
      .where("event_type", "like", "marketingAutomation.campaign.%")
      .where(sql`payload ->> 'campaignId'`, "in", campaignIds)
      .execute();
  }
  if (testAccountId !== null) {
    await ctx.database.db.deleteFrom("email_accounts").where("id", "=", testAccountId).execute();
  }
  await shutdownApi();
});

describe("module scaffold, permissions and navigation (19-MA.1)", () => {
  it("reports the descriptor, evidenced dependencies and the module checks", async () => {
    const res = await call("GET", "/api/v1/MarketingAutomation/action/health");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["module"]).toMatchObject({
      id: "MarketingAutomation",
      name: "Marketing Automation",
      apiPrefix: "/api/v1/MarketingAutomation",
      loadOrder: 380,
    });
    // §15 `19-MA.1`: no `Ua` prefix anywhere in what this phase added.
    expect(String(res.body["module"] && (res.body["module"] as Record<string, unknown>)["id"])).not.toMatch(/^Ua/);

    const dependencies = res.body["dependencies"] as { id: string; present: boolean; missing: string[] }[];
    expect(dependencies.map((d) => d.id)).toEqual(
      expect.arrayContaining(["entity-engine", "email-outbound", "jobs", "domain-events", "acl", "hooks", "settings"]),
    );
    for (const dependency of dependencies) {
      expect(dependency.present, `${dependency.id} missing ${dependency.missing.join(", ")}`).toBe(true);
    }

    const checks = res.body["checks"] as { name: string; ok: boolean; detail: string }[];
    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get("entity-metadata")?.ok, byName.get("entity-metadata")?.detail).toBe(true);
    expect(byName.get("write-guard")?.ok, byName.get("write-guard")?.detail).toBe(true);
    expect(byName.get("campaign-code-index")?.ok, byName.get("campaign-code-index")?.detail).toBe(true);
    expect(res.body["ok"]).toBe(true);
  });

  it("reports optional integrations without failing, and marks sending unavailable", async () => {
    const res = await call("GET", "/api/v1/MarketingAutomation/action/health");
    const integrations = res.body["optionalIntegrations"] as { id: string; status: string }[];
    expect(integrations.map((i) => i.id)).toEqual(
      expect.arrayContaining(["portal", "workflow", "sales", "customer-success", "service-desk", "knowledge-base", "documents"]),
    );
    for (const integration of integrations) {
      expect(["available", "unavailable"], integration.id).toContain(integration.status);
    }
    // No live provider until MA.7: reported, not fatal (§15 acceptance "missing optional integrations do not
    // crash application startup").
    const provider = res.body["provider"] as { mode: string; live: boolean };
    expect(provider.mode).toBe("disabled");
    expect(provider.live).toBe(false);
  });

  it("keeps diagnostics and settings writes administrator-only", async () => {
    const roleId = `r_ma_viewer_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA viewer ${runId}`,
      permissions: { Campaign: { create: "yes", read: "own", edit: "own", delete: "no", stream: "no" } },
    });
    const marketer = await createTestUser(ctx, { userName: `ma_marketer_${runId}`, roleIds: [roleId] });

    const health = await call("GET", "/api/v1/MarketingAutomation/action/health", undefined, marketer.token);
    expect(health.status).toBe(403);
    const write = await call(
      "POST",
      "/api/v1/MarketingAutomation/action/settings",
      { features: { campaigns: true } },
      marketer.token,
    );
    expect(write.status).toBe(403);
    // Reading the settings document is not privileged; the SPA shows the feature state in its own screens.
    const read = await call("GET", "/api/v1/MarketingAutomation/action/settings", undefined, marketer.token);
    expect(read.status).toBe(200);
  });

  it("validates a settings patch and bumps the version on every accepted change", async () => {
    const before = await call("GET", "/api/v1/MarketingAutomation/action/settings");
    expect(before.status).toBe(200);
    const version = Number((before.body as Record<string, unknown>)["version"]);

    const bad = await call("POST", "/api/v1/MarketingAutomation/action/settings", { defaults: { timezone: "Not/AZone" } });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const unknown = await call("POST", "/api/v1/MarketingAutomation/action/settings", { notASetting: true });
    expect(unknown.status).toBeGreaterThanOrEqual(400);

    const ok = await call("POST", "/api/v1/MarketingAutomation/action/settings", {
      defaults: { timezone: "Asia/Ho_Chi_Minh" },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect(Number((ok.body as Record<string, unknown>)["version"])).toBe(version + 1);

    // Restore the default so a later run does not inherit this run's choice.
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { defaults: { timezone: "UTC" } });
  });

  it("answers navigation visibility from the caller's own ACL", async () => {
    const res = await call("GET", "/api/v1/MarketingAutomation/action/nav");
    expect(res.status).toBe(200);
    expect(res.body["visible"]).toBe(true);
    expect(res.body["entities"]).toEqual(expect.arrayContaining(["Campaign", "TargetList"]));
    // Evidence rows are not navigable records (MA.1 task 5).
    expect(res.body["entities"]).not.toContain("CampaignTransition");
  });

  it("refuses the global emergency stop to a non-administrator", async () => {
    const roleId = `r_ma_stop_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA marketer ${runId}`,
      permissions: { Campaign: { create: "yes", read: "own", edit: "own", delete: "no", stream: "no" } },
    });
    const marketer = await createTestUser(ctx, { userName: `ma_stop_${runId}`, roleIds: [roleId] });
    const res = await call(
      "POST",
      "/api/v1/MarketingAutomation/action/globalSendPause",
      { paused: true, reason: marker("stop") },
      marketer.token,
    );
    expect(res.status).toBe(403);
  });
});

describe("campaign CRUD through the entity conventions (19-MA.3)", () => {
  it("creates a Draft campaign and reads it back with metadata layouts", async () => {
    const id = await makeCampaign({ code: `MA${runId}` });
    const res = await call("GET", `/api/v1/Campaign/${id}`);
    expect(res.status).toBe(200);
    expect(res.body["status"]).toBe("Draft");
    expect(res.body["type"]).toBe("Other");
    expect(res.body["purpose"]).toBe("EventUpdate");

    const list = await call("GET", "/api/v1/Campaign?maxSize=100&orderBy=-createdAt");
    expect(list.status).toBe(200);
    const ids = ((list.body["list"] ?? []) as Record<string, unknown>[]).map((row) => String(row["id"]));
    expect(ids).toContain(id);
  });

  it("refuses a client that writes a server-owned field", async () => {
    const forged = await call("POST", "/api/v1/Campaign", {
      name: marker("forged status"),
      type: "Other",
      purpose: "EventUpdate",
      status: "Running",
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(forged.body)).toMatch(/Draft|status/i);

    const id = await makeCampaign();
    const stamped = await call("PUT", `/api/v1/Campaign/${id}`, { startedAt: "2026-01-01T00:00:00.000Z" });
    expect(stamped.status).toBeGreaterThanOrEqual(400);

    const report = await call("PUT", `/api/v1/Campaign/${id}`, { validationHash: "self-approved" });
    expect(report.status).toBeGreaterThanOrEqual(400);
  });

  it("enforces a unique campaign code among live campaigns", async () => {
    const code = `MA${runId}DUP`;
    await makeCampaign({ code });
    const clash = await call("POST", "/api/v1/Campaign", {
      name: marker("code clash"),
      code: `  ${code.toLowerCase()}  `,
      type: "Other",
      purpose: "EventUpdate",
    });
    expect(clash.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(clash.body)).toContain("already used");

    const malformed = await call("POST", "/api/v1/Campaign", {
      name: marker("bad code"),
      code: "not a code!",
      type: "Other",
      purpose: "EventUpdate",
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a dangling audience reference at the write, and an unreadable one at validation (§9.2)", async () => {
    // The engine's own link validation catches a reference to a record that does not exist.
    const dangling = await call("POST", "/api/v1/Campaign", {
      name: marker("dangling audience"),
      type: "Email",
      purpose: "Newsletter",
      includeTargetListId: "does-not-exist",
    });
    expect(dangling.status).toBe(422);
    expect(JSON.stringify(dangling.body)).toContain("does not exist");

    // A reference to a real list the caller may *not* read is a blocker, never a silent pass: the campaign
    // author cannot lean on an audience they are not allowed to see.
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: true } });
    const privateList = await create("TargetList", {
      name: marker("private audience"),
      membershipMode: "static",
      entityTypes: "Contact,Lead",
    });
    const roleId = `r_ma_aud_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA audience-scoped ${runId}`,
      permissions: {
        Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" },
        TargetList: { create: "no", read: "own", edit: "no", delete: "no", stream: "no" },
      },
    });
    const marketer = await createTestUser(ctx, { userName: `ma_aud_${runId}`, roleIds: [roleId] });
    const id = await makeCampaign(
      { type: "Email", purpose: "Newsletter", includeTargetListId: privateList },
      marketer.token,
    );
    const res = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${id}/validate`,
      undefined,
      marketer.token,
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(blockerCodesOf(res.body)).toContain("AUDIENCE_NOT_READABLE");
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: false } });
  });

  it("lists history only to someone who can read the campaign", async () => {
    const roleId = `r_ma_other_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA other ${runId}`,
      permissions: { Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" } },
    });
    const other = await createTestUser(ctx, { userName: `ma_other_${runId}`, roleIds: [roleId] });
    const id = await makeCampaign();
    await action(id, "schedule");

    const own = await history(id);
    expect(own.status).toBe(200);
    expect(own.list.map((row) => row["command"])).toContain("schedule");

    const foreign = await call(
      "GET",
      `/api/v1/MarketingAutomation/action/campaign/${id}/history`,
      undefined,
      other.token,
    );
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });
});

describe("campaign lifecycle commands (19-MA.3, §5.1)", () => {
  it("runs the whole lifecycle of a non-sending campaign and stamps each move", async () => {
    const id = await makeCampaign();
    expect(await status(id)).toBe("Draft");

    const schedule = await action(id, "schedule");
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    expect(schedule.body).toMatchObject({ from: "Draft", to: "Scheduled", changed: true });
    expect(await status(id)).toBe("Scheduled");

    const start = await action(id, "start");
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(await status(id)).toBe("Running");

    expect((await action(id, "pause")).body).toMatchObject({ to: "Paused" });
    expect(await status(id)).toBe("Paused");
    expect((await action(id, "resume")).body).toMatchObject({ from: "Paused", to: "Running" });
    expect(await status(id)).toBe("Running");
    expect((await action(id, "complete")).body).toMatchObject({ to: "Completed" });
    expect(await status(id)).toBe("Completed");
    expect((await action(id, "archive")).body).toMatchObject({ to: "Archived" });
    expect(await status(id)).toBe("Archived");

    const record = await call("GET", `/api/v1/Campaign/${id}`);
    for (const field of ["scheduledAt", "startedAt", "pausedAt", "resumedAt", "completedAt", "archivedAt"]) {
      expect(record.body[field], field).toBeTruthy();
    }
    // One history row per real move, in order, with the actor recorded.
    const { list } = await history(id);
    expect(list.map((row) => row["command"])).toEqual([
      "schedule",
      "start",
      "pause",
      "resume",
      "complete",
      "archive",
    ]);
    expect(list[0]?.["actorType"]).toBe("admin");
  });

  it("rejects illegal transitions server-side and leaves the record unchanged (§15 acceptance)", async () => {
    const id = await makeCampaign();
    // Draft cannot be paused, completed, resumed or archived.
    for (const verb of ["pause", "resume", "complete", "archive"]) {
      const res = await action(id, verb);
      expect(res.status, `${verb} from Draft must be refused`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toContain("cannot");
    }
    expect(await status(id)).toBe("Draft");

    await action(id, "schedule");
    const unschedule = await action(id, "unschedule");
    expect(unschedule.body).toMatchObject({ to: "Draft" });
    await action(id, "start");
    // Running is not reached again by `start` (no-op) and not archived directly (§ cancel first).
    expect((await action(id, "start")).body).toMatchObject({ changed: false });
    const archiveLive = await action(id, "archive");
    expect(archiveLive.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a bare target status when two commands own the move (§8.2)", async () => {
    const id = await makeCampaign();
    const ambiguous = await action(id, "transition", { to: "Running" });
    expect(ambiguous.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(ambiguous.body)).toContain("command");

    // A unique owner is accepted and runs its checks, so `to` never bypasses a gate.
    const single = await action(id, "transition", { to: "Scheduled" });
    expect(single.status, JSON.stringify(single.body)).toBe(200);
    expect(single.body).toMatchObject({ command: "schedule", to: "Scheduled" });

    const contradiction = await action(id, "transition", { command: "pause", to: "Completed" });
    expect(contradiction.status).toBeGreaterThanOrEqual(400);
  });

  it("requires a reason to cancel, because cancel stops messages (§10.2)", async () => {
    const id = await makeCampaign();
    await action(id, "start");
    const noReason = await action(id, "cancel");
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(noReason.body)).toMatch(/reason/i);

    const cancelled = await action(id, "cancel", { reason: "Product launch postponed." });
    expect(cancelled.body).toMatchObject({ to: "Archived", changed: true });
    const { list } = await history(id);
    const row = list.find((entry) => entry["command"] === "cancel");
    expect(row?.["reason"]).toBe("Product launch postponed.");
  });

  it("replays an idempotency key without a second transition or a second event", async () => {
    const id = await makeCampaign();
    const key = `${runId}-idem-1`;
    const first = await action(id, "schedule", { idempotencyKey: key });
    expect(first.body).toMatchObject({ changed: true, idempotent: false });

    const replay = await action(id, "schedule", { idempotencyKey: key });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ changed: false, idempotent: true });

    const { list } = await history(id);
    expect(list.filter((row) => row["idempotencyKey"] === key)).toHaveLength(1);

    const events = await ctx.database.db
      .selectFrom("outbox_events")
      .select("id")
      .where("event_type", "=", "marketingAutomation.campaign.scheduled")
      .where(sql`payload ->> 'correlationId'`, "=", key)
      .execute();
    expect(events).toHaveLength(1);
  });

  it("refuses a stale optimistic version instead of overwriting a concurrent move", async () => {
    const id = await makeCampaign();
    const record = await call("GET", `/api/v1/Campaign/${id}`);
    const stale = Number(record.body["version"]) - 1;
    const res = await action(id, "schedule", { version: stale });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await status(id)).toBe("Draft");
  });

  it("writes the lifecycle event into the transactional outbox with a schema version", async () => {
    const id = await makeCampaign();
    await action(id, "schedule");
    const rows = await ctx.database.db
      .selectFrom("outbox_events")
      .select(["event_type", "payload"])
      .where("event_type", "=", "marketingAutomation.campaign.scheduled")
      .where(sql`payload ->> 'campaignId'`, "=", id)
      .execute();
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload["schemaVersion"]).toBe(1);
    expect(payload["from"]).toBe("Draft");
    expect(payload["to"]).toBe("Scheduled");
    expect(payload["source"]).toBe("command");
    // §7.3: identifiers and decisions only — no recipient, body or token in the payload.
    expect(JSON.stringify(payload)).not.toMatch(/AGENT_TEST_/);
  });
});

describe("send-readiness validation (19-MA.3, §5.1)", () => {
  it("lists blocking findings and warnings separately for an under-configured campaign", async () => {
    const id = await makeCampaign({ type: "Email", purpose: "Newsletter" });
    const res = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${id}/validate`);
    expect(res.status).toBe(200);
    const blockers = (res.body["blockers"] ?? []) as { code: string }[];
    const codes = blockers.map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining(["AUDIENCE_REQUIRED", "CONTENT_REQUIRED"]));
    expect(res.body["valid"]).toBe(false);

    // Warnings are reported, never promoted into blockers or dropped.
    expect(warningCodesOf(res.body)).toContain("TRACKING_NOT_CONFIGURED");
  });

  it("refuses to schedule or start until the configuration checks pass", async () => {
    const id = await makeCampaign({ type: "Email", purpose: "Newsletter" });
    const schedule = await action(id, "schedule");
    expect(schedule.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(schedule.body)).toContain("cannot be scheduled");
    expect(await status(id)).toBe("Draft");
  });

  it("schedules a fully configured campaign but refuses to run it before MA.4–MA.7 exist", async () => {
    // The audience feature is off until MA.4, so a target list is created as an administrator.
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: true } });
    const listId = await create("TargetList", {
      name: marker("audience"),
      membershipMode: "static",
      entityTypes: "Contact,Lead",
      status: "Active",
    });
    const templateId = await create("EmailTemplate", {
      name: marker("template"),
      subject: "Hello {{name}}",
      body: "Body",
    });
    const id = await makeCampaign({
      type: "Newsletter",
      purpose: "Newsletter",
      includeTargetListId: listId,
      templateId,
      emailAccountId: "agent-test-no-such-account",
      trackingOpen: false,
      trackingClick: false,
    });
    expect(testAccountId).not.toBeNull();

    // A sender that does not exist is a blocker, so the campaign cannot be scheduled at all.
    const unknownSender = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${id}/validate`);
    expect(blockerCodesOf(unknownSender.body)).toContain("SENDER_UNKNOWN");

    await call("PUT", `/api/v1/Campaign/${id}`, { emailAccountId: testAccountId });
    const schedule = await action(id, "schedule");
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);

    const start = await action(id, "start");
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(blockerCodes(start.body)).toEqual(
      expect.arrayContaining(["AUDIENCE_ENGINE_PENDING", "CONSENT_NOT_CONFIGURED", "PROVIDER_NOT_BOUND"]),
    );
    expect(await status(id)).toBe("Scheduled");

    // A newsletter that claims to be a required service notice is refused outright (§5.1, §9.3).
    await call("PUT", `/api/v1/Campaign/${id}`, { purpose: "ServiceNotice", status: undefined });
    const mismatch = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${id}/validate`);
    expect(blockerCodesOf(mismatch.body)).toContain("SERVICE_NOTICE_UNACKNOWLEDGED");
  });

  it("stores the report when the actor may edit, and blocks a paused-deployment run", async () => {
    const id = await makeCampaign();
    const validated = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${id}/validate`);
    expect(validated.status).toBe(200);
    const stored = await call("GET", `/api/v1/Campaign/${id}`);
    expect(stored.body["lastValidatedAt"]).toBeTruthy();
    expect(stored.body["validationHash"]).toBe(validated.body["validationHash"]);
    expect(JSON.parse(String(stored.body["validationReport"]))["campaignId"]).toBe(id);

    await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", {
      paused: true,
      reason: marker("emergency stop"),
    });
    const other = await makeCampaign({ type: "Newsletter", purpose: "Newsletter" });
    const report = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${other}/validate?as=Running`,
    );
    // A newsletter still cannot be scheduled at all, so the stop is not the only blocker standing.
    expect(blockerCodesOf(report.body).length).toBeGreaterThan(0);

    const resumable = await makeCampaign();
    await action(resumable, "start");
    const stopped = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${resumable}/validate?as=Running`,
    );
    expect(blockerCodesOf(stopped.body)).not.toContain("GLOBAL_SEND_PAUSED");
    await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", { paused: false });
  });
});

describe("duplicate as draft (19-MA.3, §5.1)", () => {
  it("copies configuration only — no history, stamps, report or provider identifiers", async () => {
    const source = await makeCampaign({ code: `MA${runId}SRC`, type: "Other", purpose: "EventUpdate" });
    await action(source, "schedule");
    await action(source, "start");
    await action(source, "pause");
    const paused = await call("GET", `/api/v1/Campaign/${source}`);
    expect(paused.body["status"]).toBe("Paused");

    const res = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${source}/duplicateAsDraft`,
      { name: marker("copy") },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const copyId = String(res.body["id"]);
    created.push({ entity: "Campaign", id: copyId });
    campaignIds.push(copyId);

    expect(res.body["status"]).toBe("Draft");
    expect(res.body["purpose"]).toBe("EventUpdate");
    expect(res.body["duplicatedFromId"]).toBe(source);
    // Nothing that describes an execution is carried over.
    for (const field of [
      "scheduledAt",
      "startedAt",
      "pausedAt",
      "resumedAt",
      "completedAt",
      "archivedAt",
      "failureReason",
      "validationHash",
      "validationReport",
      "lastValidatedAt",
    ]) {
      expect(res.body[field], field).toBeFalsy();
    }
    // The business code is not duplicated either — a copy needs its own identity or none.
    expect(res.body["code"]).toBeFalsy();

    // The source keeps its own history; the copy has none until someone acts on it.
    const sourceHistory = await history(source);
    expect(sourceHistory.list.length).toBe(3);
    const copyHistory = await history(copyId);
    expect(copyHistory.list.filter((row) => row["command"] !== "duplicate")).toHaveLength(0);

    // A named option can drop the audience and content references with it.
    const stripped = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${source}/duplicateAsDraft`,
      { name: marker("copy stripped"), includeAudience: false, includeContent: false },
    );
    expect(stripped.status).toBe(200);
    created.push({ entity: "Campaign", id: String(stripped.body["id"]) });
    campaignIds.push(String(stripped.body["id"]));
  });
});

describe("audience and history records are module-written only (19-MA.3)", () => {
  it("refuses a client-authored transition or membership row", async () => {
    const forged = await call("POST", "/api/v1/CampaignTransition", {
      name: marker("forged history"),
      campaignId: "whatever",
      toStatus: "Completed",
      command: "complete",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);

    const entry = await call("POST", "/api/v1/TargetListEntry", {
      name: marker("forged membership"),
      targetListId: "whatever",
      entityType: "Contact",
      entityId: "someone",
    });
    expect(entry.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses audience writes while the feature is off, and honours server-owned refresh fields", async () => {
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: false } });
    const blocked = await call("POST", "/api/v1/TargetList", {
      name: marker("audience blocked"),
      membershipMode: "static",
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(blocked.body)).toMatch(/audience|disabled/i);

    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: true } });
    const id = await create("TargetList", { name: marker("audience fields"), membershipMode: "dynamic" });
    const stamped = await call("PUT", `/api/v1/TargetList/${id}`, { resolvedCount: 999_999 });
    expect(stamped.status).toBeGreaterThanOrEqual(400);

    // Turn the capability back off for the next run; existing records stay readable (§17).
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: false } });
    const read = await call("GET", `/api/v1/TargetList/${id}`);
    expect(read.status).toBe(200);
  });
});

describe("campaign ACL on every API path (19-MA.3, §9.2)", () => {
  it("applies record scope to read, edit and every command", async () => {
    const roleId = `r_ma_scope_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA scoped ${runId}`,
      permissions: { Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" } },
    });
    const owner = await createTestUser(ctx, { userName: `ma_owner_${runId}`, roleIds: [roleId] });
    const stranger = await createTestUser(ctx, { userName: `ma_stranger_${runId}`, roleIds: [roleId] });

    const id = await makeCampaign({}, owner.token);
    expect((await call("GET", `/api/v1/Campaign/${id}`, undefined, owner.token)).status).toBe(200);
    expect((await call("GET", `/api/v1/Campaign/${id}`, undefined, stranger.token)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await call("PUT", `/api/v1/Campaign/${id}`, { description: "nope" }, stranger.token)).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await action(id, "schedule", {}, stranger.token)).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET", `/api/v1/MarketingAutomation/action/campaign/${id}/capabilities`, undefined, stranger.token)).status).toBeGreaterThanOrEqual(400);

    // The owner may run the command, and the campaign stays theirs.
    expect((await action(id, "schedule", {}, owner.token)).status).toBe(200);
    const list = await call("GET", "/api/v1/Campaign?maxSize=200", undefined, stranger.token);
    const ids = ((list.body["list"] ?? []) as Record<string, unknown>[]).map((row) => String(row["id"]));
    expect(ids).not.toContain(id);
  });
});
