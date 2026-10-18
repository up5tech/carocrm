import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MarketingConsentService } from "../src/marketing-automation/marketing-consent.service.js";
import { MarketingEventIngestionService } from "../src/marketing-automation/marketing-event-ingestion.service.js";
import { MarketingSuppressionService } from "../src/marketing-automation/marketing-suppression.service.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.10 / 19-MA.14 — provider webhooks, event normalization and suppression feedback
 * (PLAN_Phase_19_Marketing_Automation.md §5.9, §11.3, §15 `19-MA.10`, `19-MA.14` acceptance).
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1): no test
 * database is created, and nothing here sends mail — a webhook is an inbound call, not a delivery.
 *
 * What this suite is for: MA.10 shipped without a test, which is exactly the phase whose acceptance is
 * "duplicate webhook events do not duplicate counters or actions" and "hard bounce and complaint policy
 * blocks subsequent marketing sends". Every assertion below is one of those sentences.
 *
 * Fixtures are this run's own rows, identified by `runId`/`campaignId`/provider key and removed by those
 * narrow predicates in `afterAll` (§3.3) — never by a broad delete.
 */

/** The shared secret this suite configures; `bootApi()` reads config once, so it must be set first. */
const WEBHOOK_SECRET = `mae-webhook-${Date.now().toString(36)}`;
/** The worker capability the trigger door compares against; also read at boot. */
const WORKER_SECRET = `mae-worker-${Date.now().toString(36)}`;
const PROVIDER = "agent-test-events";

let ctx: ApiContext;
let runId: string;
let campaignId: string;
let sendId: string;
let previousSecret: string | undefined;
let previousWorkerSecret: string | undefined;

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

/**
 * `MarketingConsentService.identity` is the canonical digest derivation; reaching for it through the
 * container keeps this suite from re-implementing the keying rule (and from passing when the rule changes).
 */
function identity(address: string): string {
  return ctx.app.get(MarketingConsentService).identity(address) ?? "";
}

async function webhook(
  payload: Record<string, unknown>,
  options: { signature?: string | null | undefined; timestamp?: string | undefined } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.signature !== undefined && options.signature !== null) {
    headers["x-webhook-signature"] = options.signature;
  }
  if (options.timestamp !== undefined) headers["x-webhook-timestamp"] = options.timestamp;
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/MarketingAutomation/webhook/${PROVIDER}`,
    headers,
    payload,
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** A signed, fresh event. Each call gets a unique provider event id unless one is supplied. */
async function event(
  type: string,
  overrides: Record<string, unknown> = {},
  options: { signature?: string | null | undefined; timestamp?: string | undefined } = {},
) {
  return webhook(
    {
      eventId: `evt-${runId}-${type}-${Math.random().toString(36).slice(2, 10)}`,
      type,
      campaignId,
      sendId,
      slot: 1,
      recipientEntityType: "Contact",
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
      ...overrides,
    },
    { signature: options.signature === undefined ? WEBHOOK_SECRET : options.signature, timestamp: options.timestamp ?? new Date().toISOString() },
  );
}

async function countEvents(): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from marketing_events where campaign_id = ${campaignId}
  `.execute(ctx.database.db);
  return Number(rows.rows[0]?.count ?? "0");
}

async function countInbox(): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from marketing_provider_webhook_inbox where provider = ${PROVIDER}
  `.execute(ctx.database.db);
  return Number(rows.rows[0]?.count ?? "0");
}

async function inboxRow(inboxId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await sql<Record<string, unknown>>`
    select processing_status, failure_reason, signature_valid
    from marketing_provider_webhook_inbox where id = ${inboxId}
  `.execute(ctx.database.db);
  return rows.rows[0];
}

async function deliveryState(entityId: string): Promise<string | undefined> {
  const rows = await sql<{ state: string }>`
    select state from marketing_recipient_deliveries
    where send_id = ${sendId} and slot = 1 and entity_id = ${entityId}
  `.execute(ctx.database.db);
  return rows.rows[0]?.state;
}

async function createJourney(status: string): Promise<string> {
  const id = `AGENT_TEST_${runId}_journey_${status}_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.database.db
    .insertInto("entity_records")
    .values({
      id,
      entity_type: "MarketingJourney",
      name: marker(`journey ${status}`),
      attrs: JSON.stringify({ name: marker(`journey ${status}`), status }),
      created_at: new Date(),
      modified_at: new Date(),
    })
    .execute();
  return id;
}

beforeAll(async () => {
  previousSecret = process.env.MARKETING_WEBHOOK_SECRET;
  previousWorkerSecret = process.env.REPORT_WORKER_SECRET;
  process.env.MARKETING_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.REPORT_WORKER_SECRET = WORKER_SECRET;
  ctx = await bootApi();
  runId = `mae${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  campaignId = `AGENT_TEST_${runId}_campaign`;
  sendId = `AGENT_TEST_${runId}_send`;

  // A send definition and two delivery rows, inserted directly: this suite exercises the *event* path, and
  // walking a campaign through validate/approve/queue would add a second concern to every assertion.
  await ctx.database.db
    .insertInto("entity_records")
    .values({
      id: sendId,
      entity_type: "MarketingSend",
      name: marker("send"),
      attrs: JSON.stringify({ name: marker("send"), campaignId, slot: 1, status: "Sent" }),
      created_at: new Date(),
      modified_at: new Date(),
    })
    .execute();

  for (const entityId of [`${runId}-contact`, `${runId}-bounce`, `${runId}-complaint`, `${runId}-unsub`, `${runId}-order`]) {
    await ctx.database.db
      .insertInto("marketing_recipient_deliveries")
      .values({
        send_id: sendId,
        slot: 1,
        entity_type: "Contact",
        entity_id: entityId,
        email_hash: null,
        state: "Sent",
      })
      .execute();
  }
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.MARKETING_WEBHOOK_SECRET;
  else process.env.MARKETING_WEBHOOK_SECRET = previousSecret;
  if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;

  await ctx.database.db.deleteFrom("marketing_recipient_deliveries").where("send_id", "=", sendId).execute();
  await ctx.database.db.deleteFrom("marketing_events").where("campaign_id", "=", campaignId).execute();
  await ctx.database.db
    .deleteFrom("marketing_provider_webhook_inbox")
    .where("provider", "=", PROVIDER)
    .execute();
  // Suppression, consent and Lead rows this run created: by the run's own identity digests and address,
  // never by reason or name alone.
  for (const address of addresses()) {
    const hash = identity(address);
    if (hash === "") continue;
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingSuppression")
      .where(sql`attrs ->> 'emailHash'`, "=", hash)
      .where(sql`attrs ->> 'source'`, "=", "ProviderWebhook")
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingConsentEvent")
      .where(sql`attrs ->> 'emailHash'`, "=", hash)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingConsent")
      .where(sql`attrs ->> 'emailHash'`, "=", hash)
      .execute();
  }
  await ctx.database.db
    .deleteFrom("entity_records")
    .where("entity_type", "=", "Lead")
    .where(sql`attrs ->> 'emailAddress'`, "=", `form-${runId}@example.test`)
    .execute();
  await ctx.database.db
    .deleteFrom("entity_records")
    .where("entity_type", "=", "MarketingJourney")
    .where("id", "like", `AGENT_TEST_${runId}_journey%`)
    .execute();
  await ctx.database.db.deleteFrom("entity_records").where("id", "=", sendId).execute();
  await shutdownApi();
});

const addresses = () => [
  `bounce-${runId}@example.test`,
  `complaint-${runId}@example.test`,
  `unsub-${runId}@example.test`,
  `form-${runId}@example.test`,
];

async function submitForm(payload: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/MarketingAutomation/public/form/submit",
    headers: { "content-type": "application/json" },
    payload,
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

describe("the webhook door verifies what it cannot trust (19-MA.10 tasks 1, 3)", () => {
  it("rejects an unsigned event without recording one", async () => {
    const before = await countEvents();
    const res = await event("delivered", {}, { signature: null });
    expect(res.status).toBe(200);
    expect(res.body["processingStatus"]).toBe("rejected");
    expect(await countEvents()).toBe(before);

    const row = await inboxRow(String(res.body["inboxId"]));
    expect(row?.["signature_valid"]).toBe(false);
    expect(row?.["failure_reason"]).toBe("INVALID_SIGNATURE");
  });

  it("rejects a forged signature", async () => {
    const before = await countEvents();
    const res = await event("delivered", {}, { signature: `${WEBHOOK_SECRET}-forged` });
    expect(res.body["processingStatus"]).toBe("rejected");
    expect(await countEvents()).toBe(before);
  });

  it("rejects a replay outside the five-minute window", async () => {
    const before = await countInbox();
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const res = await event("delivered", {}, { timestamp: stale });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Nothing is written for a request that cannot be trusted at all: no inbox row, no event.
    expect(await countInbox()).toBe(before);
  });

  it("fails closed when no secret is configured at all", async () => {
    const ingestion = ctx.app.get(MarketingEventIngestionService);
    const result = await ingestion.ingest({
      provider: `${PROVIDER}-unconfigured`,
      signature: "anything",
      timestamp: new Date().toISOString(),
      secret: undefined,
      payload: { eventId: `evt-${runId}-nosecret`, type: "delivered", campaignId },
    });
    expect(result.processingStatus).toBe("rejected");
    const row = await inboxRow(result.inboxId);
    expect(row?.["failure_reason"]).toBe("SECRET_NOT_CONFIGURED");
    await ctx.database.db
      .deleteFrom("marketing_provider_webhook_inbox")
      .where("provider", "=", `${PROVIDER}-unconfigured`)
      .execute();
  });

  it("accepts a signed event exactly once when the provider retries it", async () => {
    const before = await countEvents();
    const eventId = `evt-${runId}-dedupe`;
    const first = await event("delivered", { eventId }, {});
    expect(first.body["processingStatus"]).toBe("processed");
    expect(first.body["duplicate"]).toBe(false);

    const retry = await event("delivered", { eventId }, {});
    expect(retry.body["duplicate"]).toBe(true);
    // The counters did not move: one inbox row, one event (§15: "duplicate webhook events do not
    // duplicate counters or actions").
    expect(await countEvents()).toBe(before + 1);
  });
});

describe("normalization and delivery feedback (19-MA.10 tasks 2, 4)", () => {
  it("normalizes provider spellings onto the internal event model", async () => {
    const delivered = await event("delivery", { recipientEntityId: `${runId}-contact` });
    expect(delivered.body["normalizedType"]).toBe("delivered");

    const complaint = await event("spam_complaint", { recipientEntityId: `${runId}-contact` });
    expect(complaint.body["normalizedType"]).toBe("complaint");

    const unknown = await event("something-new", { recipientEntityId: `${runId}-contact` });
    expect(unknown.body["normalizedType"]).toBe("provider_error");
  });

  it("marks the recipient's delivery row delivered", async () => {
    await event("delivered", { recipientEntityId: `${runId}-contact` });
    expect(await deliveryState(`${runId}-contact`)).toBe("Delivered");
  });

  it("blocks the address globally on a hard bounce", async () => {
    const emailHash = identity(`bounce-${runId}@example.test`);
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
    const res = await event("hard_bounce", {
      recipientEntityId: `${runId}-bounce`,
      emailHash,
    });
    expect(res.body["processingStatus"]).toBe("processed");
    expect(await deliveryState(`${runId}-bounce`)).toBe("Bounced");

    const applied = await ctx.app.get(MarketingSuppressionService).appliedFor(emailHash, { channel: "Email" });
    expect(applied.map((item) => item.reason)).toContain("HardBounce");
    expect(applied.some((item) => item.scope === "Global")).toBe(true);
  });

  it("blocks the address globally on a complaint", async () => {
    const emailHash = identity(`complaint-${runId}@example.test`);
    await event("complaint", { recipientEntityId: `${runId}-complaint`, emailHash });
    expect(await deliveryState(`${runId}-complaint`)).toBe("Complained");

    const applied = await ctx.app.get(MarketingSuppressionService).appliedFor(emailHash, { channel: "Email" });
    expect(applied.map((item) => item.reason)).toContain("Complaint");
  });

  it("records an unsubscribe event as a global opt-out", async () => {
    const emailHash = identity(`unsub-${runId}@example.test`);
    await event("unsubscribed", { recipientEntityId: `${runId}-unsub`, emailHash });
    expect(await deliveryState(`${runId}-unsub`)).toBe("Unsubscribed");

    const applied = await ctx.app.get(MarketingSuppressionService).appliedFor(emailHash, { channel: "Email" });
    expect(applied.map((item) => item.reason)).toContain("GlobalOptOut");
  });

  it("does not let a late delivered event overwrite a bounce", async () => {
    const emailHash = identity(`order-${runId}@example.test`);
    await event("hard_bounce", { recipientEntityId: `${runId}-order`, emailHash });
    expect(await deliveryState(`${runId}-order`)).toBe("Bounced");

    await event("delivered", { recipientEntityId: `${runId}-order`, emailHash });
    // Out-of-order delivery is not an upgrade: the address bounced, and a later "delivered" is stale.
    expect(await deliveryState(`${runId}-order`)).toBe("Bounced");
  });
});

describe("the journey trigger is not a public oracle (19-MA.14)", () => {
  it("refuses an anonymous caller", async () => {
    const journeyId = await createJourney("Published");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/MarketingAutomation/action/journey/${journeyId}/trigger`,
      payload: { eventType: "entity.created" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the worker capability and refuses an event that is not whitelisted", async () => {
    const journeyId = await createJourney("Published");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/MarketingAutomation/action/journey/${journeyId}/trigger`,
      // The worker door is an *additional* capability, not a replacement for authentication: the same
      // shape `journey/run-batch` and the delivery sweep use.
      headers: { ...authHeader(ctx.adminToken), "x-worker-secret": WORKER_SECRET },
      payload: { eventType: "crm.anythingHappened" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)["reason"]).toBe("EVENT_NOT_WHITELISTED");
  });

  it("bounds the causation chain", async () => {
    const journeyId = await createJourney("Published");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/MarketingAutomation/action/journey/${journeyId}/trigger`,
      headers: authHeader(ctx.adminToken),
      payload: { eventType: "entity.created", depth: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)["reason"]).toBe("CAUSATION_DEPTH_EXCEEDED");
  });

  it("does not match a journey that is not published", async () => {
    const journeyId = await createJourney("Draft");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/MarketingAutomation/action/journey/${journeyId}/trigger`,
      headers: authHeader(ctx.adminToken),
      payload: { eventType: "entity.created" },
    });
    expect((res.json() as Record<string, unknown>)["reason"]).toBe("JOURNEY_NOT_PUBLISHED");
  });
});

describe("the public tracking endpoints are not a redirector (19-MA.10 task 6)", () => {
  it("bounces a same-origin path", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/MarketingAutomation/public/click?to=%2Fmarketing%2Fcampaigns",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/marketing/campaigns");
  });

  it("refuses a protocol-relative target and a third-party host", async () => {
    for (const target of ["//evil.example/phish", "https://evil.example/phish", "javascript:alert(1)", "/\\evil.example"]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/MarketingAutomation/public/click?to=${encodeURIComponent(target)}`,
      });
      expect(res.statusCode, `target ${target}`).toBe(400);
    }
  });

  it("answers the open beacon with a 1x1 image", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/MarketingAutomation/public/open" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/gif");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });
});

describe("the public form acknowledges without disclosing (19-MA.15)", () => {
  it("answers identically for a first submission and for a repeat of the same address", async () => {
    const email = `form-${runId}@example.test`;
    const first = await submitForm({
      firstName: "Agent",
      lastName: "Test",
      email,
      consent: true,
      idempotencyKey: `${runId}-form-1`,
    });
    const repeat = await submitForm({
      firstName: "Agent",
      lastName: "Test",
      email,
      consent: true,
      idempotencyKey: `${runId}-form-2`,
    });

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(200);
    // The second submission reuses the Lead; the caller must not be able to tell.
    expect(repeat.body).toEqual(first.body);
    expect(Object.keys(first.body)).toEqual(["accepted"]);
  });

  it("answers a honeypot hit the same way, and creates nothing", async () => {
    const before = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "Lead")
      .where(sql`attrs ->> 'emailAddress'`, "=", `honeypot-${runId}@example.test`)
      .execute();

    const res = await submitForm({
      firstName: "Bot",
      lastName: "Test",
      email: `honeypot-${runId}@example.test`,
      consent: true,
      website: "https://spam.example",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
    const after = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "Lead")
      .where(sql`attrs ->> 'emailAddress'`, "=", `honeypot-${runId}@example.test`)
      .execute();
    expect(after.length).toBe(before.length);
  });
});

describe("module diagnostics tell an operator about the webhook door (19-MA.18)", () => {
  it("reports the configured secret state without revealing it", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/MarketingAutomation/action/health",
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).toBe(200);
    const checks = (res.json() as { checks: { name: string; detail: string }[] }).checks;
    const check = checks.find((item) => item.name === "provider-webhook-secret");
    expect(check?.detail).toContain("verified");
    expect(JSON.stringify(res.json())).not.toContain(WEBHOOK_SECRET);
  });
});
