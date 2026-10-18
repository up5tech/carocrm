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
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.9 — the queue-based delivery runtime
 * (PLAN_Phase_19_Marketing_Automation.md §5.7, §5.8, §11, §15 `19-MA.9` acceptance).
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1): no test
 * database is created, and **nothing here sends mail** — the only provider that ever becomes "live"
 * is an in-process scripted object with no socket (§15 acceptance "without sending mail during tests").
 *
 * Test records carry the `runId` marker and are removed by exact id in `afterAll`, children before
 * parents (§3.3). The settings row and `REPORT_WORKER_SECRET` are instance-wide, so both are restored.
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
const tokenIds: string[] = [];
/** `jobs` rows the queue commands leave behind: this suite's own litter, by exact id (§3.3). */
const jobIds: string[] = [];
/** The shared worker→API capability this suite configures, restored afterwards. */
const WORKER_SECRET = `mad-worker-${Date.now().toString(36)}`;
let previousWorkerSecret: string | undefined;

/** Slots are per campaign (`uq_entity_records_marketing_send_slot` on `campaignId, slot`), so this suite can safely number from 1. */
let slotCursor = 0;

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

/** A live-mode adapter with no network: it records what it was handed and never opens a socket. */
class ScriptedLiveProvider implements MarketingProviderAdapter {
  readonly info: MarketingProviderInfo = {
    key: "agent-test-delivery-provider",
    label: "Scripted delivery test provider",
    mode: "live",
    maxRecipients: 50,
    ratePerMinute: 0,
    maxConcurrency: 1,
    fromAddress: "agent-test-delivery-sender@example.test",
    reportsEvents: false,
    supportsTestSend: true,
  };
  readonly messages: MarketingProviderMessage[] = [];
  failNext: { kind: "retryable" | "permanent" | "unknown_submission"; reasonCode: string } | null = null;
  sendCount = 0;

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async verify(): Promise<void> {}

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    this.sendCount += 1;
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      const { MarketingProviderError } = await import(
        "../src/marketing-automation/marketing-automation-provider.js"
      );
      throw new MarketingProviderError(`Scripted ${failure.kind} failure.`, failure.kind, failure.reasonCode);
    }
    this.messages.push(message);
    const receiptId = `scripted-delivery-${String(this.sendCount)}`;
    return {
      key: this.info.key,
      accepted: true,
      providerMessageId: receiptId,
      receipts: message.to.map((recipient) => ({
        recipient,
        status: "accepted" as const,
        providerMessageId: receiptId,
      })),
    };
  }
}

type MarketingProviderResult = Awaited<ReturnType<MarketingProviderAdapter["send"]>>;

const scripted = new ScriptedLiveProvider();

interface DeliveryRow {
  readonly send_id: string;
  readonly slot: number;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly email_hash: string | null;
  readonly state: string;
  readonly category: string | null;
  readonly reasons: unknown;
  readonly provider_message_id: string | null;
  readonly error_code: string | null;
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  token = ctx.adminToken,
  extraHeaders: Record<string, string> = {},
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token), ...extraHeaders },
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

async function linkList(
  campaignId: string,
  listId: string,
  relation: "includedTargetLists" | "excludedTargetLists",
) {
  const res = await call("PUT", `/api/v1/Campaign/${campaignId}/${relation}/${listId}`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

async function startCampaign(campaignId: string) {
  const scheduled = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/schedule`);
  expect(scheduled.status, JSON.stringify(scheduled.body)).toBeLessThan(300);
  const started = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/start`);
  expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
}

/** A campaign that could actually send: everything the send-readiness gate requires. */
async function makeSendableCampaign(name = "delivery campaign", overrides: Record<string, unknown> = {}) {
  const templateId = await create("EmailTemplate", {
    name: marker(`template ${name}`),
    subject: `Hello ${runId} ${name} {{recipientName}}`,
    body: `A body for ${name}, {{recipientName}}.`,
    bodyHtml: `<p>A body for ${name}, {{recipientName}}.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>`,
  });
  const campaignId = await create("Campaign", {
    name: marker(name),
    type: "Newsletter",
    purpose: "Newsletter",
    templateId,
    emailAccountId: testAccountId,
    trackingOpen: false,
    trackingClick: false,
    startsAt: "2026-11-01T09:00:00.000Z",
    endsAt: "2026-11-30T17:00:00.000Z",
    ...overrides,
  });
  return campaignId;
}

async function sendAction(
  sendId: string,
  verb: string,
  payload: Record<string, unknown> = {},
  token = ctx.adminToken,
) {
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

async function addSuppression(emailHash: string, reason: "GlobalOptOut" | "Complaint" | "HardBounce") {
  const id = `AGENT_TEST_${runId}_sup_${reason}_${emailHash.slice(0, 8)}`;
  await ctx.database.db
    .insertInto("entity_records")
    .values({
      id,
      entity_type: "MarketingSuppression",
      attrs: JSON.stringify({
        name: marker(`suppression ${reason}`),
        emailHash,
        scope: "Global",
        channel: "Email",
        purpose: "Newsletter",
        reason,
        status: "Active",
        source: "AgentTest",
      }),
      created_at: new Date(),
      modified_at: new Date(),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  created.push({ entity: "MarketingSuppression", id });
}

/** Drive a send to Queued: validate → approve → schedule → queue, collecting assertions as it goes. */
async function queueSend(campaignId: string): Promise<{ sendId: string; queueBody: Record<string, unknown> }> {
  const sendId = await createSend(campaignId);
  const validated = await sendAction(sendId, "validate");
  expect(validated.status, JSON.stringify(validated.body)).toBeLessThan(300);
  const approved = await sendAction(sendId, "approve", { note: marker("delivery approval") });
  expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);
  const scheduled = await sendAction(sendId, "schedule");
  expect(scheduled.status, JSON.stringify(scheduled.body)).toBeLessThan(300);
  const queued = await sendAction(sendId, "queue");
  expect(queued.status, `queue: ${JSON.stringify(queued.body)}`).toBeLessThan(300);
  return { sendId, queueBody: queued.body };
}

async function deliveryRows(sendId: string): Promise<DeliveryRow[]> {
  const result = await sql<DeliveryRow>`
    select send_id, slot, entity_type, entity_id, email_hash, state, category,
           reasons, provider_message_id, error_code
    from marketing_recipient_deliveries
    where send_id = ${sendId}
    order by entity_id
  `.execute(ctx.database.db);
  return result.rows.map((row) => ({ ...row }));
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

async function runBatch(payload: Record<string, unknown> = {}, token = ctx.adminToken) {
  const res = await call("POST", "/api/v1/MarketingAutomation/action/delivery/run-scheduled-batch", payload, token);
  expect(res.status, `run batch: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

beforeAll(async () => {
  previousWorkerSecret = process.env.REPORT_WORKER_SECRET;
  process.env.REPORT_WORKER_SECRET = WORKER_SECRET;
  ctx = await bootApi();
  runId = `mad${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

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

  ctx.app.get(MarketingProviderRegistry).register(scripted);
  const settingsRes = await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    features: { templates: true, audience: true },
    provider: { key: "agent-test-delivery-provider" },
  });
  expect(settingsRes.status, JSON.stringify(settingsRes.body)).toBeLessThan(300);
});

afterAll(async () => {
  if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;
  await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    features: { templates: false, audience: false },
    provider: { key: "" },
  });

  // The delivery runtime mints one public token per submitted recipient: this suite's own credentials.
  const tokens = await ctx.database.db
    .selectFrom("entity_records")
    .select("id")
    .where("entity_type", "=", "MarketingPublicToken")
    .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
    .execute();
  for (const row of tokens) tokenIds.push(row.id);

  if (sendIds.length > 0) {
    await ctx.database.db.deleteFrom("marketing_recipient_deliveries").where("send_id", "in", sendIds).execute();
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
    if (entry.entity === "MarketingPublicToken") continue;
    // eslint-disable-next-line no-await-in-loop
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  if (tokenIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingPublicToken")
      .where("id", "in", tokenIds)
      .execute();
  }
  if (campaignIds.length > 0) {
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
      // eslint-disable-next-line no-await-in-loop
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
  if (jobIds.length > 0) {
    await ctx.database.db.deleteFrom("jobs").where("id", "in", jobIds).execute();
  }
  await ctx.database.db.deleteFrom("email_accounts").where("id", "=", testAccountId).execute();
  await shutdownApi();
});

describe("queueing hands work to the queue (19-MA.9 task 1)", () => {
  it("enqueues the delivery job when a send is queued", async () => {
    const campaignId = await makeSendableCampaign("enqueue campaign");
    const listId = await makeList("enqueue audience");
    const contactId = await makeContact("EnqueueRecipient", `${runId}-enqueue@example.test`);
    await addMembers(listId, [{ entityType: "Contact", entityId: contactId }]);
    await linkList(campaignId, listId, "includedTargetLists");
    await startCampaign(campaignId);
    await recordConsent(contactId, `${runId}-enqueue@example.test`, "Consented");

    const sendId = await createSend(campaignId);
    const validated = await sendAction(sendId, "validate");
    expect(validated.status, JSON.stringify(validated.body)).toBeLessThan(300);
    const approved = await sendAction(sendId, "approve", { note: marker("enqueue approval") });
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);
    const scheduled = await sendAction(sendId, "schedule");
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBeLessThan(300);

    const before = scripted.sendCount;
    const queued = await sendAction(sendId, "queue");
    expect(queued.status, `queue: ${JSON.stringify(queued.body)}`).toBeLessThan(300);
    // The transition writes state, not messages: the worker is what delivers (§5.5, §15 acceptance).
    expect(scripted.sendCount).toBe(before);

    const jobId = String(queued.body["deliveryJobId"] ?? "");
    expect(jobId, "queue enqueues the delivery job").toMatch(/^[0-9a-f-]{16,64}$/);
    jobIds.push(jobId);
    const job = await ctx.database.db
      .selectFrom("jobs")
      .select(["id", "job"])
      .where("id", "=", jobId)
      .executeTakeFirst();
    expect(job?.job).toBe("marketing.deliveryBatch");
  });
});

describe("the worker claims and submits eligible rows (19-MA.9 tasks 2–3)", () => {
  it("sends rendered, personalised mail with links and an idempotency key, then finishes the send", async () => {
    scripted.messages.length = 0;
    const address = `${runId}-delivered@example.test`;
    const campaignId = await makeSendableCampaign("delivery campaign");
    const listId = await makeList("delivery audience");
    const contactId = await makeContact("DeliveredRecipient", address);
    await addMembers(listId, [{ entityType: "Contact", entityId: contactId }]);
    await linkList(campaignId, listId, "includedTargetLists");
    await startCampaign(campaignId);
    await recordConsent(contactId, address, "Consented");

    const { sendId, queueBody } = await queueSend(campaignId);
    if (typeof queueBody["deliveryJobId"] === "string") jobIds.push(queueBody["deliveryJobId"]);

    const batch = await runBatch({ sendId }) as Record<string, unknown>;
    const first = ((batch["sends"] as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
    expect(first?.["claimed"]).toBe(1);
    expect(first?.["sent"]).toBe(1);
    expect(first?.["statusTo"]).toBe("Completed");

    const rows = await deliveryRows(sendId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("Sent");
    expect(rows[0]?.provider_message_id).toContain("scripted-delivery-");
    expect(scripted.messages).toHaveLength(1);

    const message = scripted.messages[0];
    expect(message).toBeDefined();
    // Rendered from the sealed revision for *this* recipient: personalised, and the preview sentinels
    // are gone — replaced by the recipient's own unguessable link (§5.4).
    expect(message?.subject).toContain("DeliveredRecipient");
    expect(message?.html ?? "").toContain("/marketing/preferences?token=");
    expect(message?.html ?? "").not.toContain("preview.invalid");
    expect(message?.idempotencyKey).toMatch(/^ma:/);
    expect(message?.headers?.["X-Marketing-Campaign"]).toBeTruthy();
    expect(message?.to).toEqual([address]);

    // The send finished itself: Sending → Sent → Completed, with the ledger's own counters on record.
    const attrs = await sendRow(sendId);
    expect(attrs["status"]).toBe("Completed");
    expect(Number(attrs["sentCount"] ?? 0)).toBe(1);
  });

  it("a known global unsubscribe blocks the final send step (19-MA.9 acceptance)", async () => {
    scripted.messages.length = 0;
    const address = `${runId}-optedout@example.test`;
    const campaignId = await makeSendableCampaign("suppression campaign");
    const listId = await makeList("suppression audience");
    const contactId = await makeContact("SuppressedRecipient", address);
    await addMembers(listId, [{ entityType: "Contact", entityId: contactId }]);
    await linkList(campaignId, listId, "includedTargetLists");
    await startCampaign(campaignId);
    await recordConsent(contactId, address, "Consented");

    const { sendId, queueBody } = await queueSend(campaignId);
    if (typeof queueBody["deliveryJobId"] === "string") jobIds.push(queueBody["deliveryJobId"]);

    // The snapshot was taken while consent stood; the person opts out before the worker claims.
    const ledger = await deliveryRows(sendId);
    expect(ledger[0]?.email_hash).toBeTruthy();
    await addSuppression(String(ledger[0]?.email_hash ?? ""), "GlobalOptOut");

    const batch = await runBatch({ sendId }) as Record<string, unknown>;
    const first = ((batch["sends"] as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
    expect(first?.["claimed"]).toBe(1);
    expect(first?.["sent"]).toBe(0);
    expect(first?.["blocked"]).toBe(1);

    const rows = await deliveryRows(sendId);
    expect(rows[0]?.state).toBe("Blocked");
    // The headline is severe: a global opt-out is what blocks, and nothing reached the provider.
    expect(String(rows[0]?.error_code ?? "")).toMatch(/GLOBALLY_SUPPRESSED|GlobalOptOut/i);
    expect(scripted.messages).toHaveLength(0);
  });
});

describe("limits, retries and the emergency stop (19-MA.9 tasks 4–6)", () => {
  it("a transient provider failure retries within budget and then becomes a visible dead letter", async () => {
    scripted.messages.length = 0;
    const address = `${runId}-flaky@example.test`;
    const campaignId = await makeSendableCampaign("retry campaign");
    const listId = await makeList("retry audience");
    const contactId = await makeContact("FlakyRecipient", address);
    await addMembers(listId, [{ entityType: "Contact", entityId: contactId }]);
    await linkList(campaignId, listId, "includedTargetLists");
    await startCampaign(campaignId);
    await recordConsent(contactId, address, "Consented");

    const { sendId, queueBody } = await queueSend(campaignId);
    if (typeof queueBody["deliveryJobId"] === "string") jobIds.push(queueBody["deliveryJobId"]);

    // The provider refuses transiently more times than the budget allows: the row walks Sending →
    // Failed → Queued until the budget is spent, then stays Failed with the reason named.
    scripted.failNext = { kind: "retryable", reasonCode: "PROVIDER_TEMP_FAIL" };
    let batch = await runBatch({ sendId }) as Record<string, unknown>;
    let first = ((batch["sends"] as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
    expect(first?.["retried"]).toBe(1);
    expect((await deliveryRows(sendId))[0]?.state).toBe("Queued");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      scripted.failNext = { kind: "retryable", reasonCode: "PROVIDER_TEMP_FAIL" };
      // eslint-disable-next-line no-await-in-loop
      batch = await runBatch({ sendId }) as Record<string, unknown>;
    }
    first = ((batch["sends"] as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
    void first;
    const rows = await deliveryRows(sendId);
    expect(rows[0]?.state).toBe("Failed");
    expect(rows[0]?.error_code).toBe("PROVIDER_TEMP_FAIL");
    // The send could not deliver anything at all: it finishes Failed, never silently Completed.
    expect(await sendRow(sendId).then((attrs) => attrs["status"])).toBe("Failed");
  });

  it("the §13 emergency stop refuses a batch before a single row is claimed", async () => {
    const address = `${runId}-stopped@example.test`;
    const campaignId = await makeSendableCampaign("stop campaign");
    const listId = await makeList("stop audience");
    const contactId = await makeContact("StoppedRecipient", address);
    await addMembers(listId, [{ entityType: "Contact", entityId: contactId }]);
    await linkList(campaignId, listId, "includedTargetLists");
    await startCampaign(campaignId);
    await recordConsent(contactId, address, "Consented");

    const { sendId, queueBody } = await queueSend(campaignId);
    if (typeof queueBody["deliveryJobId"] === "string") jobIds.push(queueBody["deliveryJobId"]);

    const paused = await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", { paused: true });
    expect(paused.status).toBeLessThan(300);
    try {
      const batch = await runBatch({ sendId }) as Record<string, unknown>;
      expect(batch["paused"]).toBe(true);
      expect(((batch["sends"] as Record<string, unknown>[]) ?? [])).toHaveLength(0);
      // Nothing was claimed and nothing moved: the emergency stop leaves rows untouched, audibly.
      expect((await deliveryRows(sendId))[0]?.state).toBe("Eligible");
      expect(await sendRow(sendId).then((attrs) => attrs["status"])).toBe("Queued");
    } finally {
      const resumed = await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", {
        paused: false,
      });
      expect(resumed.status).toBeLessThan(300);
    }
  });

  it("the worker capability authorises the batch endpoint; a wrong one does not", async () => {
    const denied = await call(
      "POST",
      "/api/v1/MarketingAutomation/action/delivery/run-scheduled-batch",
      {},
      ctx.adminToken,
      { "x-worker-secret": "not-the-capability" },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(denied.body)).toContain("worker capability");

    const sweep = await call(
      "POST",
      "/api/v1/MarketingAutomation/action/delivery/run-scheduled-batch",
      {},
      ctx.adminToken,
      { "x-worker-secret": WORKER_SECRET },
    );
    expect(sweep.status, JSON.stringify(sweep.body)).toBeLessThan(300);
  });
});
