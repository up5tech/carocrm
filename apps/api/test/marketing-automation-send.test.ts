import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertProviderMessage,
  type MarketingProviderAdapter,
  type MarketingProviderInfo,
  type MarketingProviderMessage,
  MarketingProviderRegistry,
} from "../src/marketing-automation/marketing-automation-provider.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.8 — send definition, audience snapshot, dry run, approval and transitions
 * (PLAN_Phase_19_Marketing_Automation.md §5.5, §5.6, §8.2, §15 `19-MA.8` acceptance).
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1): no test database
 * is created, and **nothing here sends mail** — the whole lifecycle is exercised with the platform transport
 * in `memory` mode, and the only provider that ever becomes "live" is an in-process scripted object with no
 * socket (§15 acceptance "schedule/pause/cancel state transitions without sending real mail during tests").
 *
 * Each acceptance criterion has a named test: the preview explains every excluded category, one recipient has
 * one delivery record per intended send slot, nothing starts from a draft campaign or without an approval,
 * and changing content invalidates a stale approval.
 *
 * Test records carry the `runId` marker and are removed by exact id in `afterAll`, children before parents
 * (§3.3). The settings row is instance-wide, so this suite restores the feature flags and the provider key it
 * changed before it finishes.
 */

let ctx: ApiContext;
let runId: string;
let testAccountId: string;
const created: { entity: string; id: string }[] = [];
const campaignIds: string[] = [];
const contactIds: string[] = [];
const listIds: string[] = [];
const templateIds: string[] = [];
const sendIds: string[] = [];
const consentIds: string[] = [];
/** Every send this run created shares one campaign, so slots stay distinct and uniqueness stays testable. */
let slotCursor = 0;

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

/** A live-mode adapter with no network: it records what it was handed and never opens a socket. */
class ScriptedLiveProvider implements MarketingProviderAdapter {
  readonly info: MarketingProviderInfo = {
    key: "agent-test-send-provider",
    label: "Scripted send test provider",
    mode: "live",
    maxRecipients: 50,
    ratePerMinute: 0,
    maxConcurrency: 1,
    fromAddress: "agent-test-sender@example.test",
    reportsEvents: false,
    supportsTestSend: true,
  };
  readonly messages: MarketingProviderMessage[] = [];

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async verify(): Promise<void> {}

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    this.messages.push(message);
    return {
      key: this.info.key,
      accepted: true,
      providerMessageId: "scripted-send-1",
      receipts: message.to.map((recipient) => ({
        recipient,
        status: "accepted" as const,
        providerMessageId: "scripted-send-1",
      })),
    };
  }
}

type MarketingProviderResult = Awaited<ReturnType<MarketingProviderAdapter["send"]>>;

const scripted = new ScriptedLiveProvider();

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
  if (entity === "Contact") contactIds.push(id);
  if (entity === "TargetList") listIds.push(id);
  if (entity === "EmailTemplate") templateIds.push(id);
  return id;
}

async function makeContact(surname: string, emailAddress?: string): Promise<string> {
  return create("Contact", {
    name: marker(surname),
    firstName: `First ${runId}`,
    lastName: surname,
    ...(emailAddress !== undefined ? { emailAddress } : {}),
    status: "Active",
  });
}

async function makeList(name: string): Promise<string> {
  return create("TargetList", {
    name: marker(name),
    membershipMode: "static",
    entityTypes: "Contact,Lead",
    status: "Active",
  });
}

async function addMembers(listId: string, members: { entityType: string; entityId: string }[]) {
  const res = await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/members`, { members });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

async function linkList(campaignId: string, listId: string, relation: "includedTargetLists" | "excludedTargetLists") {
  const res = await call("PUT", `/api/v1/Campaign/${campaignId}/${relation}/${listId}`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/**
 * A campaign that could actually send: the sending family, a purpose, its own sealed-able template, a sender
 * account and explicit tracking choices — everything §5.1's report requires, so a refusal below is about the
 * send definition rather than an unrelated gap.
 */
async function makeSendableCampaign(name = "campaign"): Promise<string> {
  const templateId = await create("EmailTemplate", {
    name: marker(`template ${name}`),
    subject: `Hello ${runId} ${name}`,
    body: `A body for ${name}.`,
    bodyHtml: `<p>A body for ${name}.</p>`,
  });
  return create("Campaign", {
    name: marker(name),
    type: "Newsletter",
    purpose: "Newsletter",
    templateId,
    emailAccountId: testAccountId,
    trackingOpen: false,
    trackingClick: false,
    startsAt: "2026-11-01T09:00:00.000Z",
    endsAt: "2026-11-30T17:00:00.000Z",
  });
}

async function sendAction(sendId: string, verb: string, payload: Record<string, unknown> = {}, token = ctx.adminToken) {
  return call("POST", `/api/v1/MarketingAutomation/action/send/${sendId}/${verb}`, payload, token);
}

async function createSend(campaignId: string, slot?: number): Promise<string> {
  slotCursor += 1;
  const res = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sends`, {
    slot: slot ?? slotCursor,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body["id"]);
  sendIds.push(id);
  return id;
}

async function getSend(sendId: string, token = ctx.adminToken): Promise<SendView> {
  const res = await call("GET", `/api/v1/MarketingAutomation/action/send/${sendId}`, undefined, token);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as SendView;
}

async function dryRun(sendId: string, token = ctx.adminToken): Promise<DryRun> {
  const res = await sendAction(sendId, "dryRun", {}, token);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as DryRun;
}

/** Record the consent state an audience member needs; push the stored row id for an exact cleanup. */
async function recordConsent(contactId: string, emailAddress: string, to: "Consented" | "OptedOut") {
  const res = await call("POST", "/api/v1/MarketingAutomation/action/consent", {
    emailAddress,
    purpose: "Newsletter",
    to,
    basis: to === "Consented" ? "ExplicitOptIn" : undefined,
    source: "ManualRecord",
    contactId,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select("id")
    .where("entity_type", "=", "MarketingConsent")
    .where(sql`attrs ->> 'contactId'`, "=", contactId)
    .where(sql`attrs ->> 'purpose'`, "=", "Newsletter")
    .where("deleted_at", "is", null)
    .execute();
  for (const row of rows) consentIds.push(row.id);
}

async function sendRow(sendId: string): Promise<Record<string, unknown>> {
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select("attrs")
    .where("entity_type", "=", "MarketingSend")
    .where("id", "=", sendId)
    .execute();
  return (rows[0]?.attrs as Record<string, unknown>) ?? {};
}

async function deliveryRows(sendId: string): Promise<DeliveryRow[]> {
  const result = await sql<DeliveryRow>`
    select slot, entity_id, email_hash, state, category, reasons, error_code
    from marketing_recipient_deliveries
    where send_id = ${sendId}
    order by entity_type asc, entity_id asc
  `.execute(ctx.database.db);
  return result.rows;
}

async function sendTransitionCommands(sendId: string): Promise<string[]> {
  const result = await sql<{ command: string }>`
    select (attrs ->> 'command') as command
    from entity_records
    where entity_type = 'MarketingSendTransition'
      and deleted_at is null
      and (attrs ->> 'sendId') = ${sendId}
    order by created_at asc
  `.execute(ctx.database.db);
  return result.rows.map((row) => row.command);
}

interface SendView {
  id: string;
  slot: number;
  status: string;
  counts: { recipient: number; eligible: number; blocked: number; skipped: number; sent: number; failed: number };
  approval: {
    approvedById: string | null;
    approvedAt: string | null;
    approvalHash: string | null;
    current: boolean;
    note: string | null;
  };
  validation: { hash: string | null; count: number; validatedAt: string | null };
  lifecycle: { scheduledAt: string | null; cancelledAt: string | null; cancelReason: string | null; lastErrorCode: string | null };
  deliveries: { total: number; eligible: number; blocked: number; skipped: number };
  allowedCommands: string[];
  mayEdit: boolean;
  stale: boolean;
  snapshotId: string | null;
  compositionHash: string | null;
  contentHash: string | null;
  templateRevisionId: string | null;
}

interface DryRun {
  sendId: string;
  status: string;
  valid: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  campaign: { valid: boolean; blockers: { code: string; message: string }[] };
  audience: {
    snapshotId: string | null;
    compositionHash: string;
    resolved: number;
    eligible: number;
    blocked: number;
    skipped: number;
    truncated: boolean;
    categories: { category: string; count: number; reasons: string[] }[];
    sample: { entityId: string; name: string | null; category: string; reasons: string[] }[];
    notes: string[];
  };
  approval: { current: boolean; approvalHash: string | null };
  materialHash: string;
}

interface DeliveryRow {
  slot: number;
  entity_id: string;
  email_hash: string | null;
  state: string;
  category: string | null;
  reasons: string[];
  error_code: string | null;
}

function categoryOf(dry: DryRun, name: string): { count: number; reasons: string[] } {
  const found = dry.audience.categories.find((item) => item.category === name);
  return { count: found?.count ?? 0, reasons: found?.reasons ?? [] };
}

function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"] as Record<string, unknown> | undefined;
  return (error?.["details"] ?? {}) as Record<string, unknown>;
}

/** The stable reason code a domain service attached to a refusal. */
function errorCode(body: Record<string, unknown>): string | undefined {
  const code = errorDetails(body)["code"];
  return typeof code === "string" ? code : undefined;
}

/** The blocking findings a refused command carried, as codes (§8.4). */
function blockerCodes(body: Record<string, unknown>): string[] {
  const blockers = (errorDetails(body)["blockers"] ?? []) as { code: string }[];
  return blockers.map((finding) => finding.code);
}

let sharedCampaignId: string;
let includedListId: string;
let excludedListId: string;
const address = (suffix: string) => `${runId}-${suffix}@example.test`;
let oneContactId: string;
let oneAddress: string;

beforeAll(async () => {
  ctx = await bootApi();
  runId = `mas${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

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

  // Rendering a revision and resolving an audience are the `templates` and `audience` capabilities (MA.4/MA.6),
  // both off by default; this run opts in, exactly as those suites do, and restores them afterwards.
  await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    features: { templates: true, audience: true },
    // This suite starts from "no provider configured" whatever an earlier suite left behind, so the dry run
    // and the schedule path are exercised in the deployment's own default state (§1.2 "safe by default").
    provider: { key: "" },
  });
  // Registered by key on the running registry — never by making the built-in fake claim to be live (MA.7).
  ctx.app.get(MarketingProviderRegistry).register(scripted);

  // Audience: five contacts in one audience with five different outcomes, one of them also excluded by a
  // second audience so "exclusion always wins" is visible in the delivery ledger too.
  oneAddress = address("one");
  oneContactId = await makeContact("RecipientOne", oneAddress);
  await makeContact("RecipientTwo", oneAddress);
  await makeContact("RecipientNoAddress");
  await makeContact("RecipientOptedOut", address("optedout"));
  await makeContact("RecipientExcluded", address("excluded"));

  includedListId = await makeList("included");
  excludedListId = await makeList("excluded");
  await addMembers(includedListId, contactIds.map((entityId) => ({ entityType: "Contact", entityId })));
  await addMembers(excludedListId, [{ entityType: "Contact", entityId: contactIds[4] as string }]);

  await recordConsent(contactIds[0] as string, oneAddress, "Consented");
  await recordConsent(contactIds[1] as string, oneAddress, "Consented");
  await recordConsent(contactIds[3] as string, address("optedout"), "OptedOut");

  sharedCampaignId = await makeSendableCampaign("shared campaign");
  await linkList(sharedCampaignId, includedListId, "includedTargetLists");
  await linkList(sharedCampaignId, excludedListId, "excludedTargetLists");
});

afterAll(async () => {
  // Instance-wide policy: restore the feature flags and the provider key this suite changed.
  await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    features: { templates: false, audience: false },
    provider: { key: "" },
  });

  if (sendIds.length > 0) {
    // Hard-delete only the rows this run created; the FK cascade takes the recipient ledger with them.
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingSendTransition")
      .where(sql`attrs ->> 'sendId'`, "in", sendIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingSend")
      .where("id", "in", sendIds)
      .execute();
  }
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  if (campaignIds.length > 0) {
    // Module-written history, revisions, snapshots and events outlive a campaign deletion (§3.3): removed by
    // the exact ids this run made, never by a broad predicate (§3.4).
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "in", ["CampaignTransition", "MarketingTemplateRevision", "MarketingAudienceSnapshot"])
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await ctx.database.db
      .deleteFrom("outbox_events")
      .where("event_type", "like", "marketingAutomation.%")
      .where(sql`payload ->> 'campaignId'`, "in", campaignIds)
      .execute();
  }
  if (templateIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingTemplateRevision")
      .where(sql`attrs ->> 'templateId'`, "in", templateIds)
      .execute();
  }
  if (listIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "TargetListEntry")
      .where(sql`attrs ->> 'targetListId'`, "in", listIds)
      .execute();
  }
  if (campaignIds.length > 0 || listIds.length > 0) {
    const endpoints = [...campaignIds, ...listIds];
    for (const column of ["record_id_a", "record_id_b"] as const) {
      await ctx.database.db
        .deleteFrom("entity_links")
        .where("relation_name", "in", ["includedTargetLists", "excludedTargetLists"])
        .where(sql`${sql.ref(column)}::text`, "in", endpoints)
        .execute();
    }
  }
  if (consentIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingConsentEvent")
      .where(sql`attrs ->> 'consentId'`, "in", consentIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingConsent")
      .where("id", "in", consentIds)
      .execute();
  }
  await ctx.database.db.deleteFrom("email_accounts").where("id", "=", testAccountId).execute();
  await shutdownApi();
});

describe("send definition and the §5.5 dry run (19-MA.8)", () => {
  it("creates a send as a Draft with nothing decided", async () => {
    const sendId = await createSend(sharedCampaignId);
    const view = await getSend(sendId);

    expect(view.status).toBe("Draft");
    expect(view.slot).toBeGreaterThan(0);
    expect(view.counts).toEqual({ recipient: 0, eligible: 0, blocked: 0, skipped: 0, sent: 0, failed: 0 });
    expect(view.approval.approvalHash).toBeNull();
    expect(view.validation.hash).toBeNull();
    expect(view.validation.count).toBe(0);
    expect(view.snapshotId).toBeNull();
    // Nothing has been decided yet, so nothing is stale — staleness is a decision that stopped being true.
    expect(view.stale).toBe(false);
    expect(view.allowedCommands).toEqual(expect.arrayContaining(["validate", "cancel"]));
    // `fail` is the delivery runtime's outcome and never appears on a user's command list (§8.2).
    expect(view.allowedCommands).not.toContain("fail");
    expect(view.mayEdit).toBe(true);
  });

  it("refuses a second send in a taken slot and a client-authored send record", async () => {
    const campaignId = await makeSendableCampaign("slot campaign");
    const first = await createSend(campaignId, 1);

    const duplicate = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sends`, {
      slot: 1,
    });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(duplicate.body)).toBe("SEND_SLOT_TAKEN");

    // The record API refuses the entity outright: a send a client could author is a send nobody validated.
    const authored = await call("POST", "/api/v1/MarketingSend", {
      name: marker("client-authored"),
      campaignId,
      status: "Validated",
    });
    expect(authored.status).toBeGreaterThanOrEqual(400);

    const history = await call("POST", "/api/v1/MarketingSendTransition", {
      name: marker("client-authored history"),
      sendId: first,
      campaignId,
      command: "schedule",
    });
    expect(history.status).toBeGreaterThanOrEqual(400);
  });

  it("explains every excluded category and writes nothing (§5.5 acceptance)", async () => {
    const sendId = await createSend(sharedCampaignId);
    const report = await dryRun(sendId);

    // Valid, because the campaign is configured; the refusals that still stand are warnings here.
    expect(report.blockers).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.warnings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["SEND_PROVIDER_NOT_LIVE", "SEND_CAMPAIGN_NOT_LIVE"]),
    );
    expect(report.approval.current).toBe(false);
    expect(report.materialHash).toMatch(/^[0-9a-f]{32}$/);

    expect(report.audience.resolved).toBe(5);
    expect(report.audience.eligible).toBe(1);
    expect(report.audience.blocked).toBe(2);
    expect(report.audience.skipped).toBe(2);
    expect(report.audience.truncated).toBe(false);

    // "Preview shows the reasons each recipient category is excluded" (§15 acceptance).
    expect(categoryOf(report, "eligible")).toEqual({ count: 1, reasons: [] });
    expect(categoryOf(report, "duplicateAddress").count).toBe(1);
    expect(categoryOf(report, "noEmailAddress").count).toBe(1);
    expect(categoryOf(report, "optedOut").reasons).toContain("OPTED_OUT");
    expect(categoryOf(report, "excludedBySegment").reasons).toContain("EXCLUDED_BY_TARGET_LIST");

    // Samples name a record the caller may read and carry its own reasons.
    const sample = report.audience.sample.find((entry) => entry.entityId === oneContactId);
    expect(sample?.category).toBe("eligible");
    expect(sample?.name, "a readable sample names the record").toBeTruthy();
    expect(sample?.reasons).toEqual([]);
    expect(JSON.stringify(report.audience.sample)).not.toContain("@example.test");

    // The dry run wrote nothing: no ledger rows, no history, no status move, no snapshot of its own.
    expect(await deliveryRows(sendId)).toHaveLength(0);
    expect(await sendTransitionCommands(sendId)).toEqual([]);
    const row = await sendRow(sendId);
    expect(row["status"]).toBe("Draft");
    expect(row["validationHash"]).toBeUndefined();
    expect(row["snapshotId"]).toBeUndefined();
  });
});

describe("validation freezes the decision into a snapshot and a ledger (19-MA.8)", () => {
  it("seals the content, binds an audience snapshot to the send and materialises every recipient", async () => {
    const sendId = await createSend(sharedCampaignId);
    const view = await getSend(sendId);
    expect(view.status).toBe("Draft");

    const validated = await sendAction(sendId, "validate");
    expect(validated.status, JSON.stringify(validated.body)).toBeLessThan(300);
    const after = await getSend(sendId);

    expect(after.status).toBe("Validated");
    expect(after.validation.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(after.validation.count).toBe(1);
    expect(after.contentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(after.templateRevisionId).not.toBeNull();
    expect(after.snapshotId).not.toBeNull();
    expect(after.compositionHash).toMatch(/^[0-9a-f]{32}$/);
    // Validation clears any previous approval: an approval belongs to one validation, never to a later one.
    expect(after.approval.approvalHash).toBeNull();

    expect(after.counts).toEqual({ recipient: 5, eligible: 1, blocked: 2, skipped: 2, sent: 0, failed: 0 });
    expect(after.deliveries.total).toBe(5);

    const rows = await deliveryRows(sendId);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.slot === after.slot)).toBe(true);
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    expect(byCategory.get("eligible")?.state).toBe("Eligible");
    expect(byCategory.get("duplicateAddress")?.state).toBe("Skipped");
    expect(byCategory.get("noEmailAddress")?.state).toBe("Skipped");
    expect(byCategory.get("optedOut")?.state).toBe("Blocked");
    expect(byCategory.get("excludedBySegment")?.state).toBe("Blocked");
    // Reasons survive into the ledger, so the dry run's explanation is still readable at delivery time (§6.5).
    expect(byCategory.get("optedOut")?.reasons).toContain("OPTED_OUT");
    // Identity is a digest: no plaintext address is duplicated into the ledger (§6.1, §9.3).
    expect(rows.some((row) => (row.email_hash ?? "").length === 64)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("@example.test");

    const snapshot = await ctx.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "MarketingAudienceSnapshot")
      .where("id", "=", after.snapshotId ?? "")
      .execute();
    const snapshotAttrs = (snapshot[0]?.attrs ?? {}) as Record<string, unknown>;
    expect(snapshotAttrs["sendId"]).toBe(sendId);
    expect(snapshotAttrs["mode"]).toBe("final");
    expect(snapshotAttrs["status"]).toBe("Generated");
    expect(snapshotAttrs["eligibleCount"]).toBe(1);

    expect(await sendTransitionCommands(sendId)).toEqual(["validate"]);
  });

  it("keeps one delivery record per recipient per intended send slot when re-validated (§5.6)", async () => {
    const sendId = await createSend(sharedCampaignId);
    await sendAction(sendId, "validate");
    const first = await getSend(sendId);

    const again = await sendAction(sendId, "validate");
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    const second = await getSend(sendId);

    expect(second.status).toBe("Validated");
    expect(second.validation.count).toBe(2);
    // Re-deriving the forecast must not double the intent: same recipients, same slot, same states.
    expect(second.counts).toEqual(first.counts);

    const rows = await deliveryRows(sendId);
    expect(rows).toHaveLength(5);
    const distinct = new Set(rows.map((row) => `${row.slot}:${row.entity_id}`));
    expect(distinct.size).toBe(5);

    // And one *message* per address per slot: the address-unique index refuses a second row for one recipient.
    const messages = rows.filter((row) => row.state !== "Skipped");
    expect(new Set(messages.map((row) => row.email_hash)).size).toBe(messages.length);

    // A superseded snapshot is stamped, never edited: the earlier decision stays readable as history (§5.2).
    const headers = await ctx.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "MarketingAudienceSnapshot")
      .where(sql`attrs ->> 'sendId'`, "=", sendId)
      .execute();
    const statuses = headers.map((row) => (row.attrs as Record<string, unknown>)["status"]);
    expect(statuses).toContain("Generated");
    expect(statuses).toContain("Invalidated");
  });
});

describe("approval is bound to the facts it was given for (19-MA.8, §5.5)", () => {
  it("approves a current validation and refuses — and clears — a stale one", async () => {
    const campaignId = await makeSendableCampaign("approval campaign");
    await linkList(campaignId, includedListId, "includedTargetLists");
    const sendId = await createSend(campaignId);
    await sendAction(sendId, "validate");

    const approved = await sendAction(sendId, "approve", { note: marker("approved") });
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);
    const granted = await getSend(sendId);
    expect(granted.status).toBe("Validated");
    expect(granted.approval.approvalHash).toBe(granted.validation.hash);
    expect(granted.approval.current).toBe(true);
    expect(granted.stale).toBe(false);

    // Change the content the approval was given for: the approval stays *recorded*, but stops being current.
    const templateId = String(
      (await ctx.database.db
        .selectFrom("entity_records")
        .select("attrs")
        .where("entity_type", "=", "Campaign")
        .where("id", "=", campaignId)
        .execute())[0]?.attrs?.templateId ?? "",
    );
    const edited = await call("PUT", `/api/v1/EmailTemplate/${templateId}`, {
      subject: `Changed after approval ${runId}`,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);

    const staleView = await getSend(sendId);
    expect(staleView.stale).toBe(true);
    expect(staleView.approval.current).toBe(false);

    const refused = await sendAction(sendId, "approve");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(refused.body)).toBe("SEND_APPROVAL_STALE");

    const after = await getSend(sendId);
    expect(after.status).toBe("Draft");
    expect(after.approval.approvalHash).toBeNull();
    expect(after.lifecycle.lastErrorCode).toBe("SEND_APPROVAL_STALE");
    expect(await sendTransitionCommands(sendId)).toEqual(expect.arrayContaining(["validate", "approve", "invalidate"]));

    // And re-validating the new content makes it approvable again — the stale decision was replaced, not kept.
    const revalidated = await sendAction(sendId, "validate");
    expect(revalidated.status, JSON.stringify(revalidated.body)).toBeLessThan(300);
    const ready = await getSend(sendId);
    expect(ready.status).toBe("Validated");
    expect(ready.stale).toBe(false);
  });

  it("invalidates a stale approval when the target audience changes", async () => {
    const campaignId = await makeSendableCampaign("audience change campaign");
    await linkList(campaignId, includedListId, "includedTargetLists");
    const sendId = await createSend(campaignId);
    await sendAction(sendId, "validate");
    await sendAction(sendId, "approve");
    const before = await getSend(sendId);
    expect(before.approval.current).toBe(true);

    // Detach the audience: the composition the approval was given for no longer exists.
    const detached = await call(
      "DELETE",
      `/api/v1/Campaign/${campaignId}/includedTargetLists/${includedListId}`,
    );
    expect(detached.status, JSON.stringify(detached.body)).toBeLessThan(300);

    const after = await getSend(sendId);
    expect(after.stale).toBe(true);
    expect(after.approval.current).toBe(false);

    const refused = await sendAction(sendId, "schedule");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(refused.body)).toBe("SEND_APPROVAL_STALE");

    const invalidated = await getSend(sendId);
    expect(invalidated.status).toBe("Draft");
    expect(invalidated.approval.approvalHash).toBeNull();

    // Re-attach, so the shared audience is left exactly as this run found it (§3.3).
    await linkList(campaignId, includedListId, "includedTargetLists");
  });
});

describe("transitions: schedule, queue, pause, cancel — without sending mail (19-MA.8)", () => {
  let lifecycleCampaignId: string;

  beforeAll(async () => {
    lifecycleCampaignId = await makeSendableCampaign("lifecycle campaign");
    await linkList(lifecycleCampaignId, includedListId, "includedTargetLists");
    // Schedule the campaign *before* any send of its is validated: that stamp writes the campaign's time zone
    // from the deployment default, and a field no approval was given for is exactly the material change §5.5
    // refuses to let slide later.
    const campaignScheduled = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${lifecycleCampaignId}/schedule`,
    );
    expect(campaignScheduled.status, JSON.stringify(campaignScheduled.body)).toBeLessThan(300);
  });

  /** The provider key is one of the facts an approval is bound to, so it is set *before* a send is validated. */
  async function setProviderKey(key: string) {
    const res = await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key } });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  }

  /** A send taken all the way to `Scheduled`: validated, approved, then scheduled, in that order. */
  async function preparedSend(campaignId: string): Promise<string> {
    const sendId = await createSend(campaignId);
    for (const verb of ["validate", "approve", "schedule"]) {
      const res = await sendAction(sendId, verb);
      expect(res.status, `${verb}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    }
    expect((await getSend(sendId)).status).toBe("Scheduled");
    return sendId;
  }

  it("refuses to schedule an unapproved send", async () => {
    const sendId = await createSend(lifecycleCampaignId);
    await sendAction(sendId, "validate");
    const refused = await sendAction(sendId, "schedule");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(refused.body)).toBe("SEND_APPROVAL_REQUIRED");
    expect((await getSend(sendId)).status).toBe("Validated");
  });

  it("schedules with an approval, then refuses to queue without a live provider", async () => {
    // provider.key is empty in this suite, so a send may be validated, approved and scheduled — but
    // queueing, the step that would hand recipients to a provider, is refused (§1.2 "safe by default").
    const sendId = await preparedSend(lifecycleCampaignId);

    const refused = await sendAction(sendId, "queue");
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(blockerCodes(refused.body)).toContain("SEND_PROVIDER_NOT_LIVE");
    expect((await getSend(sendId)).status).toBe("Scheduled");
  });

  it("refuses to queue while the campaign itself has not started (§15 acceptance)", async () => {
    // A configured send on a *Draft* campaign: schedule is a configuration step, queue would be delivery.
    const draftCampaignId = await makeSendableCampaign("draft campaign");
    await linkList(draftCampaignId, includedListId, "includedTargetLists");
    await setProviderKey(scripted.info.key);
    const draftSendId = await preparedSend(draftCampaignId);

    const refused = await sendAction(draftSendId, "queue");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(blockerCodes(refused.body)).toContain("SEND_CAMPAIGN_NOT_LIVE");
    expect((await getSend(draftSendId)).status).toBe("Scheduled");
    await setProviderKey("");
  });

  it("refuses to queue while the global emergency stop is on (§13)", async () => {
    await setProviderKey(scripted.info.key);
    const sendId = await preparedSend(lifecycleCampaignId);

    const stopped = await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", {
      paused: true,
      reason: marker("emergency stop"),
    });
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(300);

    const refused = await sendAction(sendId, "queue");
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(blockerCodes(refused.body)).toContain("SEND_GLOBAL_SEND_PAUSED");

    await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", { paused: false });
    await setProviderKey("");
  });

  it("runs schedule → queue → pause → resume → cancel and stops the remaining recipients", async () => {
    // The campaign is Scheduled, the provider key points at the scripted in-process adapter, and this send is
    // validated and approved against exactly that state: this is the one path that would move mail in a real
    // deployment. Nothing here does — the adapter has no socket, and MA.9 owns the worker that would claim
    // these rows (§15 acceptance "without sending real mail during tests").
    await setProviderKey(scripted.info.key);
    const lifecycleSendId = await preparedSend(lifecycleCampaignId);
    scripted.messages.length = 0;

    const queued = await sendAction(lifecycleSendId, "queue");
    expect(queued.status, JSON.stringify(queued.body)).toBeLessThan(300);
    expect((await getSend(lifecycleSendId)).status).toBe("Queued");

    const paused = await sendAction(lifecycleSendId, "pause", { reason: marker("paused") });
    expect(paused.status, JSON.stringify(paused.body)).toBeLessThan(300);
    expect((await getSend(lifecycleSendId)).status).toBe("Paused");

    const resumed = await sendAction(lifecycleSendId, "resume");
    expect(resumed.status, JSON.stringify(resumed.body)).toBeLessThan(300);
    expect((await getSend(lifecycleSendId)).status).toBe("Queued");

    const noReason = await sendAction(lifecycleSendId, "cancel");
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(noReason.body)).toBe("SEND_CANCEL_REASON_REQUIRED");

    const cancelled = await sendAction(lifecycleSendId, "cancel", { reason: marker("operator stopped it") });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    const view = await getSend(lifecycleSendId);
    expect(view.status).toBe("Cancelled");
    expect(view.lifecycle.cancelReason).toContain(runId);

    // The one recipient who was eligible is now stopped, with the reason recorded; blocked rows keep their
    // own verdict — an operator stop is not a re-judgement of consent (§5.3).
    const rows = await deliveryRows(lifecycleSendId);
    const eligible = rows.find((row) => row.state === "Skipped" && row.category === "eligible");
    expect(eligible?.error_code).toBe("SEND_CANCELLED");
    expect(rows.filter((row) => row.category === "optedOut").every((row) => row.state === "Blocked")).toBe(true);

    // Terminal: the transitions a cancelled send has are none (§5.5).
    const refused = await sendAction(lifecycleSendId, "schedule");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(refused.body)).toBe("SEND_TRANSITION_NOT_ALLOWED");

    // Queueing never handed anything to a provider: the scripted adapter saw nothing.
    expect(scripted.messages).toHaveLength(0);
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: "" } });
  });
});

describe("permissions and disclosure (§9.2)", () => {
  it("gives a caller who may read the campaign the recipients their own ACL allows (§9.2, §6.1)", async () => {
    const sendId = await createSend(sharedCampaignId);
    await sendAction(sendId, "validate");

    const res = await call("GET", `/api/v1/MarketingAutomation/action/send/${sendId}/recipients`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const body = res.body as {
      total: number;
      hidden: number;
      summary: { total: number; eligible: number; blocked: number; skipped: number };
      list: { entityId: string; state: string; category: string | null; reasons: string[]; name: string | null }[];
    };
    expect(body.total).toBe(5);
    expect(body.hidden).toBe(0);
    expect(body.summary).toMatchObject({ total: 5, eligible: 1, blocked: 2, skipped: 2 });
    expect(body.list).toHaveLength(5);
    const optedOut = body.list.find((entry) => entry.category === "optedOut");
    expect(optedOut?.state).toBe("Blocked");
    expect(optedOut?.reasons).toContain("OPTED_OUT");
    // A delivery record names a record, never an address (§6.1 "minimized recipient-address snapshot fields").
    expect(JSON.stringify(body)).not.toContain("@example.test");
  });

  it("hides recipients whose records the caller may not read, and refuses their commands", async () => {
    const blindRoleId = `r_ma_send_blind_${runId}`;
    await createTestRole(ctx, {
      id: blindRoleId,
      name: `MA send blind ${runId}`,
      permissions: {
        Campaign: { create: "no", read: "all", edit: "no", delete: "no", stream: "no" },
        Contact: { create: "no", read: "no", edit: "no", delete: "no", stream: "no" },
      },
    });
    const blind = await createTestUser(ctx, { userName: `ma_send_blind_${runId}`, roleIds: [blindRoleId] });

    const sendId = await createSend(sharedCampaignId);
    await sendAction(sendId, "validate");

    const view = await getSend(sendId, blind.token);
    expect(view.mayEdit).toBe(false);
    expect(view.allowedCommands).toEqual([]);

    const recipients = await call(
      "GET",
      `/api/v1/MarketingAutomation/action/send/${sendId}/recipients`,
      undefined,
      blind.token,
    );
    expect(recipients.status, JSON.stringify(recipients.body)).toBeLessThan(300);
    const body = recipients.body as { total: number; hidden: number; list: unknown[] };
    expect(body.total).toBe(5);
    expect(body.hidden).toBe(5);
    expect(body.list).toEqual([]);

    // Reads the campaign, may not edit it: every write on the send is refused (§8.2).
    for (const verb of ["validate", "approve", "schedule"]) {
      const refused = await sendAction(sendId, verb, {}, blind.token);
      expect(refused.status, `${verb} should be refused`).toBeGreaterThanOrEqual(400);
    }
  });

  it("refuses send reads and commands to a caller outside the campaign", async () => {
    const roleId = `r_ma_send_foreign_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA send foreign ${runId}`,
      permissions: { Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" } },
    });
    const foreign = await createTestUser(ctx, { userName: `ma_send_foreign_${runId}`, roleIds: [roleId] });

    const sendId = await createSend(sharedCampaignId);
    for (const [method, url] of [
      ["GET", `/api/v1/MarketingAutomation/action/send/${sendId}`],
      ["GET", `/api/v1/MarketingAutomation/action/send/${sendId}/history`],
      ["GET", `/api/v1/MarketingAutomation/action/send/${sendId}/recipients`],
    ] as const) {
      const res = await call(method, url, undefined, foreign.token);
      expect(res.status, `${method} ${url}`).toBeGreaterThanOrEqual(400);
    }
    const dry = await sendAction(sendId, "dryRun", {}, foreign.token);
    expect(dry.status).toBeGreaterThanOrEqual(400);
    const createRefused = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${sharedCampaignId}/sends`,
      {},
      foreign.token,
    );
    expect(createRefused.status).toBeGreaterThanOrEqual(400);
  });
});
