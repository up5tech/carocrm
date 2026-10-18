import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emailIdentity } from "../src/marketing-automation/marketing-identity.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.5 — consent, preferences, suppression and the public unsubscribe path
 * (PLAN_Phase_19_Marketing_Automation.md §5.3, §5.3.1, §5.3.2, §8.3, §15 `19-MA.5` acceptance).
 *
 * Against the configured primary database through the real HTTP API (AGENTS.md §3.1); no test database, and
 * nothing here sends a message. Every record carries the `runId` marker and is removed by exact id in
 * `afterAll` (§3.3).
 *
 * The phase's four acceptance criteria are each covered by a named test: a global opt-out overrides
 * membership; a decision is re-evaluated rather than cached (the property the post-queue unsubscribe rule
 * rests on — the queue itself arrives in MA.8/MA.9); the public endpoints leak nothing and cannot be
 * enumerated; and re-consent needs affirmative evidence.
 */
let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];
const campaignIds: string[] = [];
const contactIds: string[] = [];
/** Rows this run created that no campaign owns, removed by exact id in `afterAll` (§3.3). */
const consentIds: string[] = [];
const suppressionIds: string[] = [];
const tokenIds: string[] = [];
/** Audience records this run created; the membership rows the service writes for them are not in `created`. */
const listIds: string[] = [];
/**
 * The address identities this run used, computed with the same key the booted API uses. Consent, suppression
 * and token rows are keyed by that digest and are written by services under the module identity, so they
 * never appear in `created`; the digest of a `runId`-unique address is a positive ownership marker (§3.3).
 */
const ownedHashes = new Set<string>();

/** An address only this run can own, registered for the cleanup sweep before it is used. */
function ownAddress(label: string): string {
  const address = `${label}-${runId}@example.com`;
  const hash = emailIdentity(address, ctx.config.encryptionKey)?.hash;
  if (hash !== undefined) ownedHashes.add(hash);
  return address;
}

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
  if (entity === "Contact") contactIds.push(id);
  return id;
}

async function record(input: Record<string, unknown>, token = ctx.adminToken) {
  return call("POST", "/api/v1/MarketingAutomation/action/consent", input, token);
}

async function statusOf(emailHash: string, purpose: string) {
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select(["id", "attrs"])
    .where("entity_type", "=", "MarketingConsent")
    .where(sql`attrs ->> 'emailHash'`, "=", emailHash)
    .where(sql`attrs ->> 'purpose'`, "=", purpose)
    .where("deleted_at", "is", null)
    .execute();
  const row = rows[0];
  if (row === undefined) return { consentId: null, status: null };
  consentIds.push(row.id);
  return {
    consentId: row.id,
    status: ((row.attrs as Record<string, unknown>)["status"] as string) ?? null,
  };
}

async function identityOf(address: string): Promise<string> {
  const issued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
    scope: "Preferences",
    emailAddress: address,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
  // The link response carries the path with the raw token; the identity is read back from the token row.
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select("attrs")
    .where("entity_type", "=", "MarketingPublicToken")
    .where("id", "=", String(issued.body["tokenId"]))
    .execute();
  tokenIds.push(String(issued.body["tokenId"]));
  const attrs = rows[0]?.attrs as Record<string, unknown> | undefined;
  return String(attrs?.["emailHash"] ?? "");
}

async function audiencePreview(campaignId: string) {
  const res = await call("GET", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audiencePreview`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as {
    resolved: number;
    eligible: number;
    categories: { category: string; count: number }[];
  };
}

function count(preview: { categories: { category: string; count: number }[] }, name: string): number {
  return preview.categories.find((item) => item.category === name)?.count ?? 0;
}

/** A campaign aimed at one contact through a static audience, so eligibility is observable end to end. */
async function campaignFor(contactId: string, purpose = "Newsletter"): Promise<string> {
  const listId = await create("TargetList", {
    name: marker(`list ${purpose}`),
    membershipMode: "static",
    entityTypes: "Contact,Lead",
  });
  listIds.push(listId);
  await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/members`, {
    members: [{ entityType: "Contact", entityId: contactId }],
  });
  const campaignId = await create("Campaign", {
    name: marker(`campaign ${purpose}`),
    type: "Newsletter",
    purpose,
  });
  await call("PUT", `/api/v1/Campaign/${campaignId}/includedTargetLists/${listId}`);
  return campaignId;
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `mac${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: true } });
});

afterAll(async () => {
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  const db = ctx.database.db;
  // Consent history rows are children of a consent row this run created; consent, suppression, token and
  // transition rows are removed by the exact ids recorded above — never by a broad predicate (§3.3, §3.4).
  if (consentIds.length > 0) {
    await db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingConsentEvent")
      .where(sql`attrs ->> 'consentId'`, "in", consentIds)
      .execute();
  }
  for (const [entity, ids] of [
    ["MarketingConsent", consentIds],
    ["MarketingSuppression", suppressionIds],
    ["MarketingPublicToken", tokenIds],
  ] as const) {
    if (ids.length === 0) continue;
    await db.deleteFrom("entity_records").where("entity_type", "=", entity).where("id", "in", ids).execute();
  }
  if (listIds.length > 0) {
    // Membership rows are written by the audience service under the module identity, so the API deletes
    // above cannot reach them; the list ids this run created are the ownership marker (§3.3).
    await db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "TargetListEntry")
      .where(sql`attrs ->> 'targetListId'`, "in", listIds)
      .execute();
  }
  if (ownedHashes.size > 0) {
    // Same reason for consent, its history, suppression and public tokens: they are keyed by the digest of an
    // address only this run used, which is what makes a hash-scoped sweep exact ownership rather than a broad
    // delete (§3.3, §3.4).
    const rows = await db
      .selectFrom("entity_records")
      .select(["id", "entity_type"])
      .where("entity_type", "in", [
        "MarketingConsent",
        "MarketingConsentEvent",
        "MarketingSuppression",
        "MarketingPublicToken",
      ])
      .where(sql`attrs ->> 'emailHash'`, "in", [...ownedHashes])
      .execute();
    if (rows.length > 0) {
      await db
        .deleteFrom("entity_records")
        .where("id", "in", rows.map((row) => row.id))
        .execute();
      const owned = rows.filter((row) => row.entity_type === "MarketingConsent").map((row) => row.id);
      if (owned.length > 0) {
        await db
          .deleteFrom("outbox_events")
          .where("event_type", "=", "marketingAutomation.consent.changed")
          .where(sql`payload ->> 'consentId'`, "in", owned)
          .execute();
      }
    }
  }
  if (campaignIds.length > 0 || listIds.length > 0) {
    // Relation links survive a soft delete, so this run removes the audience links it created (§3.3).
    const endpoints = [...campaignIds, ...listIds];
    for (const column of ["record_id_a", "record_id_b"] as const) {
      await db
        .deleteFrom("entity_links")
        .where("relation_name", "in", ["includedTargetLists", "excludedTargetLists"])
        .where(sql`${sql.ref(column)}::text`, "in", endpoints)
        .execute();
    }
  }
  if (campaignIds.length > 0) {
    await db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "CampaignTransition")
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await db
      .deleteFrom("outbox_events")
      .where("event_type", "like", "marketingAutomation.%")
      .where(sql`coalesce(payload ->> 'campaignId', payload ->> 'consentId')`, "in", [...campaignIds, ...consentIds])
      .execute();
  }
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: false } });
  await shutdownApi();
});

describe("consent state and its audit trail (19-MA.5 tasks 2–3, §5.3)", () => {
  it("records a decision, appends history in the same operation, and keeps one live row per identity", async () => {
    const address = ownAddress("consent");
    const hash = await identityOf(address);

    const first = await record({
      emailAddress: address,
      purpose: "Newsletter",
      to: "Consented",
      basis: "ExplicitOptIn",
      source: "WebForm",
      policyVersion: "2026-10",
      locale: "en",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ changed: true });
    const consentId = String((first.body["consent"] as Record<string, unknown>)["consentId"]);
    consentIds.push(consentId);

    const history = await call("GET", `/api/v1/MarketingAutomation/action/consent/${consentId}/history`);
    expect(history.status).toBe(200);
    const events = (history.body["list"] ?? []) as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "Unknown", toStatus: "Consented", source: "WebForm" });
    expect(events[0]?.["actorType"]).toBe("admin");

    // A second decision for the same identity+purpose updates the one live row rather than forking it.
    const second = await record({
      emailAddress: address,
      purpose: "Newsletter",
      to: "OptedOut",
      source: "UnsubscribeLink",
      reason: "Clicked the link.",
    });
    expect(second.body).toMatchObject({ changed: true });
    expect(String((second.body["consent"] as Record<string, unknown>)["consentId"])).toBe(consentId);
    const live = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "MarketingConsent")
      .where(sql`attrs ->> 'emailHash'`, "=", hash)
      .where(sql`attrs ->> 'purpose'`, "=", "Newsletter")
      .where("deleted_at", "is", null)
      .execute();
    expect(live).toHaveLength(1);

    const after = await call("GET", `/api/v1/MarketingAutomation/action/consent/${consentId}/history`);
    expect(((after.body["list"] ?? []) as unknown[])).toHaveLength(2);
  });

  it("treats a missing record as Unknown, never as consent (§5.3 invariant 5)", async () => {
    const address = ownAddress("unknown");
    const contact = await create("Contact", {
      name: marker("unknown consent"),
      lastName: "Unknown",
      emailAddress: address,
      status: "Active",
    });
    const campaignId = await campaignFor(contact);
    const preview = await audiencePreview(campaignId);
    expect(preview.resolved).toBe(1);
    expect(count(preview, "consentUnknown")).toBe(1);
    expect(preview.eligible).toBe(0);
  });

  it("is idempotent for a replayed mutation (§5.3 invariant 10)", async () => {
    const address = ownAddress("idem");
    const key = `${runId}-consent-1`;
    const body = {
      emailAddress: address,
      purpose: "EventUpdate",
      to: "Consented",
      basis: "ExplicitOptIn",
      source: "WebForm",
      idempotencyKey: key,
    };
    const first = await record(body);
    expect(first.body).toMatchObject({ changed: true, idempotent: false });
    const replay = await record(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ changed: false, idempotent: true });

    const events = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "MarketingConsentEvent")
      .where(sql`attrs ->> 'idempotencyKey'`, "=", key)
      .execute();
    expect(events).toHaveLength(1);
  });

  it("refuses an illegal transition and requires affirmative evidence to re-subscribe (§5.3.2)", async () => {
    const address = ownAddress("reconsent");
    await record({ emailAddress: address, purpose: "ProductMarketing", to: "Consented", basis: "ExplicitOptIn", source: "WebForm" });
    await record({ emailAddress: address, purpose: "ProductMarketing", to: "OptedOut", source: "PreferenceCenter" });

    // A suppressed state cannot jump straight to consented.
    const hash = await identityOf(address);
    const suppressed = await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: address,
      scope: "Global",
      reason: "ManualBlock",
      source: "ManualRecord",
      note: marker("suppress for re-consent test"),
    });
    expect(suppressed.status, JSON.stringify(suppressed.body)).toBe(200);

    const silent = await record({
      emailAddress: address,
      purpose: "ProductMarketing",
      to: "Consented",
      source: "Import",
    });
    expect(silent.status).toBe(422);
    expect(JSON.stringify(silent.body)).toMatch(/basis and a reason/);

    const affirmative = await record({
      emailAddress: address,
      purpose: "ProductMarketing",
      to: "Consented",
      basis: "DoubleOptIn",
      source: "PreferenceCenter",
      reason: "Confirmed by email click on 2026-10-17.",
    });
    expect(affirmative.status, JSON.stringify(affirmative.body)).toBe(200);
    expect(affirmative.body["changed"]).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a decision with no address, and one that is not a valid transition", async () => {
    const empty = await record({ purpose: "Newsletter", to: "Consented", source: "ManualRecord" });
    expect(empty.status).toBe(422);

    const address = ownAddress("badtransition");
    await record({ emailAddress: address, purpose: "Newsletter", to: "Suppressed", basis: "ExplicitOptIn", source: "ManualRecord" });
    const jump = await record({
      emailAddress: address,
      purpose: "Newsletter",
      to: "Consented",
      basis: "ExplicitOptIn",
      source: "ManualRecord",
      reason: "trying to skip the reviewed path",
    });
    // Suppressed can only leave through OptedOut, so this is refused even with evidence supplied.
    expect(jump.status).toBe(422);
    expect(JSON.stringify(jump.body)).toMatch(/cannot move/);
  });
});

describe("suppression and precedence (19-MA.5 task 4, §5.3, §6.3)", () => {
  it("a global suppression overrides segment membership and consent (§1.2, §15 acceptance)", async () => {
    const address = ownAddress("global");
    const contact = await create("Contact", {
      name: marker("globally suppressed"),
      lastName: "Global",
      emailAddress: address,
      status: "Active",
    });
    await record({ emailAddress: address, purpose: "Newsletter", to: "Consented", basis: "ExplicitOptIn", source: "WebForm" });
    const campaignId = await campaignFor(contact);

    const before = await audiencePreview(campaignId);
    expect(before.eligible).toBe(1);

    const blocked = await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: address,
      scope: "Global",
      reason: "GlobalOptOut",
      source: "UnsubscribeLink",
      note: marker("global block"),
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);

    const after = await audiencePreview(campaignId);
    // Still a member of the audience, still consented for the purpose — and still not sendable.
    expect(after.resolved).toBe(1);
    expect(count(after, "suppressedGlobal")).toBe(1);
    expect(after.eligible).toBe(0);
  });

  it("re-evaluates on every call rather than trusting an earlier answer (§5.3 invariants 1–2)", async () => {
    const address = ownAddress("reeval");
    const contact = await create("Contact", {
      name: marker("re-evaluated"),
      lastName: "Reeval",
      emailAddress: address,
      status: "Active",
    });
    await record({ emailAddress: address, purpose: "Newsletter", to: "Consented", basis: "ExplicitOptIn", source: "WebForm" });
    const campaignId = await campaignFor(contact);

    const first = await audiencePreview(campaignId);
    expect(first.eligible).toBe(1);

    // Something changes after the first evaluation — the equivalent of an unsubscribe arriving between
    // queueing and submission. The next evaluation sees it; nothing is cached.
    await record({ emailAddress: address, purpose: "Newsletter", to: "OptedOut", source: "UnsubscribeLink" });
    const second = await audiencePreview(campaignId);
    expect(second.eligible).toBe(0);
    expect(count(second, "optedOut")).toBe(1);
  });

  it("refuses to lift a reason that is not an operator's to lift (§5.3 invariant 8)", async () => {
    const address = ownAddress("hardbounce");
    const added = await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: address,
      scope: "Channel",
      reason: "HardBounce",
      source: "ProviderWebhook",
      note: marker("bounce block"),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const id = String((added.body["id"] ?? added.body["suppressionId"]) as string);
    suppressionIds.push(id);

    const revoke = await call("POST", `/api/v1/MarketingAutomation/action/suppression/${id}/revoke`, {
      reason: "operator thinks it is fine now",
    });
    expect(revoke.status).toBe(422);
    expect(JSON.stringify(revoke.body)).toMatch(/cannot be lifted/);
  });

  it("revokes a manual block as a recorded decision, keeping the row (§6.8)", async () => {
    const address = ownAddress("manual");
    const added = await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: address,
      scope: "Purpose",
      purpose: "EventUpdate",
      reason: "ManualBlock",
      source: "ManualRecord",
      note: marker("manual block"),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const id = String((added.body["id"] ?? added.body["suppressionId"]) as string);
    suppressionIds.push(id);

    const revoked = await call("POST", `/api/v1/MarketingAutomation/action/suppression/${id}/revoke`, {
      reason: "Raised in error; the address was a test mailbox.",
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const row = await ctx.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.deleted_at).toBeNull();
    const attrs = row?.attrs as Record<string, unknown>;
    expect(attrs["revokedAt"]).toBeTruthy();
    expect(attrs["revokedById"]).toBeTruthy();

    const list = await call("GET", `/api/v1/MarketingAutomation/action/suppression?emailAddress=${encodeURIComponent(address)}`);
    expect(list.status).toBe(200);
    expect((list.body["list"] ?? []) as unknown[]).toHaveLength(0);
  });

  it("keeps a scoped suppression from blocking an unrelated purpose", async () => {
    const address = ownAddress("scoped");
    await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: address,
      scope: "Purpose",
      purpose: "ProductMarketing",
      reason: "Complaint",
      source: "ProviderWebhook",
      note: marker("purpose block"),
    });
    const contact = await create("Contact", {
      name: marker("scoped suppression"),
      lastName: "Scoped",
      emailAddress: address,
      status: "Active",
    });
    await record({ emailAddress: address, purpose: "Newsletter", to: "Consented", basis: "ExplicitOptIn", source: "WebForm" });

    const newsletter = await audiencePreview(await campaignFor(contact, "Newsletter"));
    expect(newsletter.eligible).toBe(1);

    const marketing = await audiencePreview(await campaignFor(contact, "ProductMarketing"));
    expect(marketing.eligible).toBe(0);
    // A complaint is reported as itself, not as an unclassified block: the reason the provider gave is the
    // explanation an operator needs (§1.2 "explainable automation").
    expect(count(marketing, "suppressedComplaint")).toBe(1);
  });
});

describe("public unsubscribe and preference links (19-MA.5 tasks 5–6, §5.3.1)", () => {
  it("a GET shows the page and changes nothing; the POST is the deliberate act", async () => {
    const address = ownAddress("oneclick");
    const issued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Unsubscribe",
      emailAddress: address,
      purpose: "Newsletter",
    });
    expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
    const token = String(issued.body["token"]);

    const page = await call("GET", `/api/v1/MarketingAutomation/public/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    expect(Array.isArray(page.body["categories"])).toBe(true);
    const before = await statusOf(await identityOf(address), "Newsletter");
    expect(before.status).toBeNull();

    const done = await call("POST", `/api/v1/MarketingAutomation/public/unsubscribe/${token}`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ unsubscribed: true, scope: "purpose", applied: true });
    expect((await statusOf(await identityOf(address), "Newsletter")).status).toBe("OptedOut");

    // A second press is the same outcome, not an error and not a second history row.
    const replay = await call("POST", `/api/v1/MarketingAutomation/public/unsubscribe/${token}`, {});
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ unsubscribed: true, applied: false });
    const events = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "MarketingConsentEvent")
      .where(sql`attrs ->> 'toStatus'`, "=", "OptedOut")
      .where(sql`attrs ->> 'emailHash'`, "=", await identityOf(address))
      .execute();
    expect(events).toHaveLength(1);
  });

  it("unsubscribe-all records a global block that survives a later re-subscribe attempt by list membership", async () => {
    const address = ownAddress("all");
    await record({ emailAddress: address, purpose: "Newsletter", to: "Consented", basis: "ExplicitOptIn", source: "WebForm" });
    const issued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Unsubscribe",
      emailAddress: address,
    });
    const token = String(issued.body["token"]);
    const done = await call("POST", `/api/v1/MarketingAutomation/public/unsubscribe/${token}`, { all: true });
    expect(done.body).toMatchObject({ scope: "global" });

    const contact = await create("Contact", {
      name: marker("unsubscribed all"),
      lastName: "All",
      emailAddress: address,
      status: "Active",
    });
    const preview = await audiencePreview(await campaignFor(contact));
    expect(preview.eligible).toBe(0);
    expect(count(preview, "suppressedGlobal")).toBe(1);
  });

  it("answers every bad link the same way, so it cannot be used to probe the CRM (§15 acceptance)", async () => {
    const unknown = await call("GET", "/api/v1/MarketingAutomation/public/preferences/0000000000000000000000000000abc");
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    const tooShort = await call("GET", "/api/v1/MarketingAutomation/public/preferences/short");
    expect(tooShort.status).toBeGreaterThanOrEqual(400);

    const issued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Unsubscribe",
      emailAddress: ownAddress("probe"),
    });
    const token = String(issued.body["token"]);
    const tampered = await call("GET", `/api/v1/MarketingAutomation/public/preferences/${token}x`);
    expect(tampered.status).toBeGreaterThanOrEqual(400);

    const messages = [unknown.body, tooShort.body, tampered.body].map((body) => JSON.stringify(body));
    // One identical answer for every failure, so a caller cannot tell an absent token from a wrong one,
    // an expired one, or an address that is not in the CRM at all.
    expect(messages[0]).toBe(messages[1]);
    expect(messages[1]).toBe(messages[2]);
    expect(JSON.stringify(messages)).not.toMatch(/contact|lead|@example\.com/i);
  });

  it("keeps a link inside its own scope, so an unsubscribe link cannot grant consent", async () => {
    const address = ownAddress("scope");
    const unsubscribe = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Unsubscribe",
      emailAddress: address,
      purpose: "EventUpdate",
    });
    const token = String(unsubscribe.body["token"]);

    const wrongUse = await call("POST", `/api/v1/MarketingAutomation/public/confirm/${token}`, {});
    expect(wrongUse.status).toBeGreaterThanOrEqual(400);
    expect((await statusOf(await identityOf(address), "EventUpdate")).status).toBeNull();

    const confirmation = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "OptInConfirmation",
      emailAddress: address,
      purpose: "EventUpdate",
    });
    expect(confirmation.status, JSON.stringify(confirmation.body)).toBeLessThan(300);
    const confirmed = await call(
      "POST",
      `/api/v1/MarketingAutomation/public/confirm/${String(confirmation.body["token"])}`,
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((await statusOf(await identityOf(address), "EventUpdate")).status).toBe("Consented");
  });

  it("expires a link and revokes the previous one for the same identity", async () => {
    const address = ownAddress("expiry");
    const issued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Preferences",
      emailAddress: address,
    });
    const tokenId = String(issued.body["tokenId"]);
    const token = String(issued.body["token"]);

    await ctx.database.db
      .updateTable("entity_records")
      .set({
        attrs: sql`jsonb_set(attrs, '{expiresAt}', ${JSON.stringify("2020-01-01T00:00:00.000Z")}::jsonb)`,
      })
      .where("id", "=", tokenId)
      .execute();
    const expired = await call("GET", `/api/v1/MarketingAutomation/public/preferences/${token}`);
    expect(expired.status).toBeGreaterThanOrEqual(400);

    const reissued = await call("POST", "/api/v1/MarketingAutomation/action/publicLink", {
      scope: "Preferences",
      emailAddress: address,
    });
    const superseded = await ctx.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("id", "=", tokenId)
      .executeTakeFirst();
    expect((superseded?.attrs as Record<string, unknown>)["status"]).toBe("Revoked");
    expect(reissued.status).toBeLessThan(300);
  });

  it("requires an authorised caller to mint a link (§9.1)", async () => {
    const roleId = `r_ma_link_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `MA no consent ${runId}`,
      permissions: {
        Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" },
        MarketingConsent: { create: "no", read: "no", edit: "no", delete: "no", stream: "no" },
      },
    });
    const marketer = await createTestUser(ctx, { userName: `ma_nolink_${runId}`, roleIds: [roleId] });
    const res = await call(
      "POST",
      "/api/v1/MarketingAutomation/action/publicLink",
      { scope: "Unsubscribe", emailAddress: ownAddress("noperm") },
      marketer.token,
    );
    expect(res.status).toBe(403);
  });
});
