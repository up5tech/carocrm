import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MarketingConsentService } from "../src/marketing-automation/marketing-consent.service.js";
import { MarketingJourneyRuntimeService } from "../src/marketing-automation/marketing-journey-runtime.service.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.12/19-MA.13 — journey versions, enrollment and step execution
 * (PLAN_Phase_19_Marketing_Automation.md §5.6, §5.7, §15 `19-MA.12`, `19-MA.13` acceptance).
 *
 * The existing `marketing-automation-journey.test.ts` proves the *graph validator* and the action/trigger
 * catalogs as pure functions. What it could not prove — and what this suite exists for — is the runtime's
 * three stated acceptance rules:
 *
 *   1. "concurrent duplicate triggers create no duplicate enrollments";
 *   2. "two workers cannot execute the same action instance concurrently";
 *   3. "global opt-out and suppression exit/block marketing actions regardless of journey graph".
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1); every row carries
 * this run's marker and is removed by exact id in `afterAll` (§3.3).
 */

let ctx: ApiContext;
let runId: string;
const journeyIds: string[] = [];
const enrollmentIds: string[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

function identity(address: string): string {
  return ctx.app.get(MarketingConsentService).identity(address) ?? "";
}

interface Graph {
  readonly start: string;
  readonly nodes: readonly Record<string, unknown>[];
}

async function call(
  method: "GET" | "POST",
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

/** A published journey version carrying `graph`, so `run-batch` can load it the way production does. */
async function makeJourney(graph: Graph): Promise<{ journeyId: string; versionId: string }> {
  const journeyId = `AGENT_TEST_${runId}_journey_${Math.random().toString(36).slice(2, 8)}`;
  const versionId = `${journeyId}_v1`;
  const now = new Date();
  await ctx.database.db
    .insertInto("entity_records")
    .values({
      id: journeyId,
      entity_type: "MarketingJourney",
      name: marker("journey"),
      attrs: JSON.stringify({ name: marker("journey"), status: "Published", currentVersion: 1, publishedVersionId: versionId }),
      created_at: now,
      modified_at: now,
    })
    .execute();
  await ctx.database.db
    .insertInto("entity_records")
    .values({
      id: versionId,
      entity_type: "MarketingJourneyVersion",
      name: marker("version"),
      attrs: JSON.stringify({
        name: "v1",
        journeyId,
        version: 1,
        graph: JSON.stringify(graph),
        graphHash: "agent-test",
        schemaVersion: 1,
        status: "Published",
      }),
      created_at: now,
      modified_at: now,
    })
    .execute();
  journeyIds.push(journeyId);
  return { journeyId, versionId };
}

async function enroll(
  journey: { journeyId: string; versionId: string },
  graph: Graph,
  overrides: Record<string, unknown> = {},
) {
  return call("POST", `/api/v1/MarketingAutomation/action/journey/${journey.journeyId}/enroll`, {
    graph,
    versionId: journey.versionId,
    version: 1,
    personType: "Contact",
    personId: `AGENT_TEST_${runId}_person`,
    source: "AgentTest",
    dedupeKey: `${runId}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  });
}

async function runBatch() {
  const res = await call("POST", "/api/v1/MarketingAutomation/action/journey/run-batch", { limit: 50 });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function enrollmentRow(id: string): Promise<Record<string, unknown>> {
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select("attrs")
    .where("entity_type", "=", "MarketingJourneyEnrollment")
    .where("id", "=", id)
    .execute();
  return (rows[0]?.attrs as Record<string, unknown>) ?? {};
}

async function enrollmentCount(journeyId: string, dedupeKey: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from entity_records
    where entity_type = 'MarketingJourneyEnrollment'
      and deleted_at is null
      and (attrs->>'journeyId') = ${journeyId}
      and (attrs->>'dedupeKey') = ${dedupeKey}
  `.execute(ctx.database.db);
  return Number(rows.rows[0]?.count ?? "0");
}

const WAIT_GRAPH: Graph = {
  start: "wait",
  nodes: [
    { id: "wait", type: "wait", seconds: 3600, next: "done" },
    { id: "done", type: "end" },
  ],
};

beforeAll(async () => {
  ctx = await bootApi();
  runId = `majr${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
});

afterAll(async () => {
  if (enrollmentIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingJourneyStepExecution")
      .where(sql`attrs ->> 'enrollmentId'`, "in", enrollmentIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingJourneyEnrollment")
      .where("id", "in", enrollmentIds)
      .execute();
  }
  if (journeyIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingJourneyEnrollment")
      .where(sql`attrs ->> 'journeyId'`, "in", journeyIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingJourneyVersion")
      .where(sql`attrs ->> 'journeyId'`, "in", journeyIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingJourney")
      .where("id", "in", journeyIds)
      .execute();
  }
  await ctx.database.db
    .deleteFrom("entity_records")
    .where("entity_type", "=", "MarketingSuppression")
    .where(sql`attrs ->> 'source'`, "=", "AgentTestJourneyRuntime")
    .execute();
  await shutdownApi();
});

describe("enrollment is idempotent (19-MA.13 acceptance)", () => {
  it("returns the existing enrollment for a repeated dedupe key", async () => {
    const journey = await makeJourney(WAIT_GRAPH);
    const dedupeKey = `${runId}-dedupe-repeat`;

    const first = await enroll(journey, WAIT_GRAPH, { dedupeKey });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const firstId = String(first.body["enrollmentId"]);
    enrollmentIds.push(firstId);
    expect(first.body["duplicate"]).toBe(false);

    const second = await enroll(journey, WAIT_GRAPH, { dedupeKey });
    expect(second.body["enrollmentId"]).toBe(firstId);
    expect(second.body["duplicate"]).toBe(true);
    expect(await enrollmentCount(journey.journeyId, dedupeKey)).toBe(1);
  });

  it("creates exactly one enrollment when three triggers race", async () => {
    const journey = await makeJourney(WAIT_GRAPH);
    const dedupeKey = `${runId}-dedupe-race`;

    const results = await Promise.all([
      enroll(journey, WAIT_GRAPH, { dedupeKey }),
      enroll(journey, WAIT_GRAPH, { dedupeKey }),
      enroll(journey, WAIT_GRAPH, { dedupeKey }),
    ]);
    const ids = new Set(results.map((result) => String(result.body["enrollmentId"])));
    expect(ids.size).toBe(1);
    expect(await enrollmentCount(journey.journeyId, dedupeKey)).toBe(1);
    for (const id of ids) enrollmentIds.push(id);
  });
});

describe("a step executes once per claim (19-MA.13 acceptance)", () => {
  it("advances a wait node once and then leaves the enrollment waiting", async () => {
    const journey = await makeJourney(WAIT_GRAPH);
    const enrolled = await enroll(journey, WAIT_GRAPH);
    const enrollmentId = String(enrolled.body["enrollmentId"]);
    enrollmentIds.push(enrollmentId);

    await runBatch();
    const afterFirst = await enrollmentRow(enrollmentId);
    expect(afterFirst["state"]).toBe("Waiting");
    const nextRunAt = String(afterFirst["nextRunAt"]);
    expect(Date.parse(nextRunAt)).toBeGreaterThan(Date.now());

    // Not due any more: a second pass cannot re-run the same step or move the schedule.
    await runBatch();
    const afterSecond = await enrollmentRow(enrollmentId);
    expect(afterSecond["nextRunAt"]).toBe(nextRunAt);
    expect(afterSecond["state"]).toBe("Waiting");

    const steps = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "MarketingJourneyStepExecution")
      .where(sql`attrs ->> 'enrollmentId'`, "=", enrollmentId)
      .execute();
    expect(steps.length).toBe(1);
  });

  it("completes an enrollment whose start node is the end", async () => {
    const graph: Graph = { start: "done", nodes: [{ id: "done", type: "end" }] };
    const journey = await makeJourney(graph);
    const enrolled = await enroll(journey, graph);
    const enrollmentId = String(enrolled.body["enrollmentId"]);
    enrollmentIds.push(enrollmentId);

    await runBatch();
    expect((await enrollmentRow(enrollmentId))["state"]).toBe("Completed");
  });

  it("lets only one of two concurrent claims win", async () => {
    const journey = await makeJourney(WAIT_GRAPH);
    const enrolled = await enroll(journey, WAIT_GRAPH);
    const enrollmentId = String(enrolled.body["enrollmentId"]);
    enrollmentIds.push(enrollmentId);

    const runtime = ctx.app.get(MarketingJourneyRuntimeService);
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([runtime.claim(enrollmentId, now), runtime.claim(enrollmentId, now)]);
    const winners = [a, b].filter((row) => row !== undefined);
    expect(winners.length).toBe(1);
  });
});

describe("suppression outranks the graph (19-MA.13 acceptance)", () => {
  it("exits the enrollment before the step runs", async () => {
    const address = `journey-blocked-${runId}@example.test`;
    const emailHash = identity(address);
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);

    await ctx.database.db
      .insertInto("entity_records")
      .values({
        id: `AGENT_TEST_${runId}_sup`,
        entity_type: "MarketingSuppression",
        name: marker("suppression"),
        attrs: JSON.stringify({
          name: marker("suppression"),
          emailHash,
          scope: "Global",
          channel: "Email",
          purpose: null,
          targetListId: null,
          reason: "GlobalOptOut",
          source: "AgentTestJourneyRuntime",
          status: "Active",
        }),
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();

    const journey = await makeJourney(WAIT_GRAPH);
    const enrolled = await enroll(journey, WAIT_GRAPH, { emailHash });
    const enrollmentId = String(enrolled.body["enrollmentId"]);
    enrollmentIds.push(enrollmentId);

    await runBatch();
    const row = await enrollmentRow(enrollmentId);
    expect(row["state"]).toBe("Exited");
    expect(row["exitReason"]).toBe("SUPPRESSED");

    const steps = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "MarketingJourneyStepExecution")
      .where(sql`attrs ->> 'enrollmentId'`, "=", enrollmentId)
      .execute();
    expect(steps.length).toBe(0);
  });
});
