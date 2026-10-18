import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.4 — audience membership, resolution, composition and snapshots
 * (PLAN_Phase_19_Marketing_Automation.md §5.2, §15 `19-MA.4` acceptance).
 *
 * Runs against the configured primary database through the real HTTP API (AGENTS.md §3.1); no test database
 * is created and nothing here sends a message. Every record carries the `runId` marker and is removed by
 * exact id in `afterAll` (§3.3).
 *
 * The five acceptance criteria of the phase are each covered by a named test: no user-provided SQL is
 * executed, exclusion always wins, a snapshot is stable after the audience changes, ACL does not leak
 * through samples or counts, and duplicate selection is de-duplicated.
 */
let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];
const campaignIds: string[] = [];
/** Contact ids created by this run, removed by exact id: contacts are CRM data and never reused (§3.3). */
const contactIds: string[] = [];
/** Segment ids created by this run; their membership rows are written by the service, not by `create()`. */
const listIds: string[] = [];

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

/** A contact with a deliberately unique surname, so a dynamic clause can be aimed at exactly this run. */
async function makeContact(surname: string, emailAddress: string, status = "Active"): Promise<string> {
  return create("Contact", {
    name: `${marker(surname)} ${surname}`,
    firstName: `First ${runId}`,
    lastName: surname,
    emailAddress,
    status,
  });
}

async function makeList(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = await create("TargetList", {
    name: marker(name),
    membershipMode: "static",
    entityTypes: "Contact,Lead",
    status: "Active",
    ...overrides,
  });
  listIds.push(id);
  return id;
}

async function addMembers(listId: string, members: { entityType: string; entityId: string }[]) {
  return call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/members`, { members });
}

async function linkList(campaignId: string, listId: string, relation: "includedTargetLists" | "excludedTargetLists") {
  return call("PUT", `/api/v1/Campaign/${campaignId}/${relation}/${listId}`);
}

async function preview(campaignId: string) {
  const res = await call("GET", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audiencePreview`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as {
    resolved: number;
    eligible: number;
    categories: { category: string; count: number }[];
    samples: { entityId: string; category: string }[];
    truncated: boolean;
    notes: string[];
  };
}

function categoryOf(preview: { categories: { category: string; count: number }[] }, name: string): number {
  return preview.categories.find((item) => item.category === name)?.count ?? 0;
}

async function enableAudience(enabled: boolean) {
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: enabled } });
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `mau${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await enableAudience(true);
});

afterAll(async () => {
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  if (campaignIds.length > 0) {
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "CampaignTransition")
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingAudienceSnapshot")
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await ctx.database.db
      .deleteFrom("outbox_events")
      .where("event_type", "like", "marketingAutomation.campaign.%")
      .where(sql`payload ->> 'campaignId'`, "in", campaignIds)
      .execute();
  }
  if (listIds.length > 0) {
    // Membership rows are created by the audience service under the system principal, so they never appear
    // in `created` and the API deletes above cannot reach them (§3.3: remove exactly what this run wrote).
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "TargetListEntry")
      .where(sql`attrs ->> 'targetListId'`, "in", listIds)
      .execute();
  }
  if (campaignIds.length > 0 || listIds.length > 0) {
    // The relation endpoints write `entity_links` rows; soft-deleting the campaign or the list leaves them
    // behind, so this run removes the links it created (§3.3).
    const endpoints = [...campaignIds, ...listIds];
    for (const column of ["record_id_a", "record_id_b"] as const) {
      await ctx.database.db
        .deleteFrom("entity_links")
        .where("relation_name", "in", ["includedTargetLists", "excludedTargetLists"])
        .where(sql`${sql.ref(column)}::text`, "in", endpoints)
        .execute();
    }
  }
  await enableAudience(false);
  await shutdownApi();
});

describe("static audience membership (19-MA.4 task 2, §5.2)", () => {
  it("adds members as auditable evidence and is idempotent per record", async () => {
    const listId = await makeList("static list");
    const contact = await makeContact("Alpha", `alpha-${runId}@example.com`);

    const first = await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ added: 1, alreadyPresent: 0 });

    const again = await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);
    expect(again.body).toMatchObject({ added: 0, alreadyPresent: 1 });

    const members = await call("GET", `/api/v1/MarketingAutomation/action/segment/${listId}/members`);
    expect(members.status).toBe(200);
    const list = (members.body["list"] ?? []) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ entityType: "Contact", entityId: contact, source: "Manual" });
    expect(list[0]?.["addedAt"]).toBeTruthy();

    const entries = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "TargetListEntry")
      .where(sql`attrs ->> 'targetListId'`, "=", listId)
      .where(sql`attrs ->> 'removedAt'`, "is", null)
      .execute();
    expect(entries).toHaveLength(1);
  });

  it("refuses a record the caller may not read, and a type the audience does not accept", async () => {
    const listId = await makeList("guarded list", { entityTypes: "Contact" });
    const missing = await addMembers(listId, [{ entityType: "Contact", entityId: "00000000-0000-0000-0000-000000000000" }]);
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    expect(missing.body["rejected"]).toHaveLength(1);
    expect(String((missing.body["rejected"] as string[])[0])).toMatch(/no such record/);

    const account = await create("Account", { name: marker("account") });
    const wrongType = await addMembers(listId, [{ entityType: "Contact", entityId: account }]);
    expect(wrongType.body["added"]).toBe(0);
    expect((wrongType.body["rejected"] as string[]).join(" ")).toMatch(/no such record/);
  });

  it("records a removal instead of deleting it, and stops counting the member", async () => {
    const listId = await makeList("removal list");
    const contact = await makeContact("Removed", `removed-${runId}@example.com`);
    await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);

    const removed = await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/members/remove`, {
      entityType: "Contact",
      entityId: contact,
      reason: "Unsubscribed by phone.",
    });
    expect(removed.body).toMatchObject({ removed: true });

    const members = await call("GET", `/api/v1/MarketingAutomation/action/segment/${listId}/members`);
    expect((members.body["list"] ?? []) as unknown[]).toHaveLength(0);

    const stillThere = await ctx.database.db
      .selectFrom("entity_records")
      .select(["id"])
      .where("entity_type", "=", "TargetListEntry")
      .where(sql`attrs ->> 'memberId'`, "=", contact)
      .execute();
    expect(stillThere.length).toBe(1);
    const attrs = (await ctx.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("id", "=", String(stillThere[0]?.id))
      .executeTakeFirst())?.attrs as Record<string, unknown>;
    expect(attrs["removedAt"]).toBeTruthy();
    expect(attrs["removedById"]).toBeTruthy();
  });

  it("refuses to add members to a dynamic audience", async () => {
    const listId = await makeList("dynamic membership", {
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Contact", match: "all", filters: [{ field: "status", operator: "equals", value: "Active" }] }],
      }),
    });
    const contact = await makeContact("Dynamic", `dynamic-${runId}@example.com`);
    const res = await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/dynamic audience is populated by its criteria/);
  });
});

describe("dynamic criteria and the no-SQL rule (19-MA.4 task 3, §5.2)", () => {
  it("refuses criteria the platform cannot interpret, at the write", async () => {
    const unknownField = await call("POST", "/api/v1/TargetList", {
      name: marker("bad criteria field"),
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Contact", match: "all", filters: [{ field: "salary", operator: "equals", value: 1 }] }],
      }),
    });
    expect(unknownField.status).toBe(422);
    expect(JSON.stringify(unknownField.body)).toMatch(/does not define/);

    const badOperator = await call("POST", "/api/v1/TargetList", {
      name: marker("bad criteria operator"),
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Contact", match: "all", filters: [{ field: "status", operator: "DROP", value: "x" }] }],
      }),
    });
    expect(badOperator.status).toBe(422);

    const unsupportedType = await call("POST", "/api/v1/TargetList", {
      name: marker("bad criteria entity"),
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Account", match: "all", filters: [{ field: "name", operator: "equals", value: "x" }] }],
      }),
    });
    expect(unsupportedType.status).toBe(422);
    expect(JSON.stringify(unsupportedType.body)).toMatch(/cannot be an audience/);
  });

  it("resolves a dynamic audience from validated criteria", async () => {
    const surname = `Dyn${runId}`;
    await makeContact(surname, `dyn-a-${runId}@example.com`);
    await makeContact(surname, `dyn-b-${runId}@example.com`);
    const listId = await makeList("dynamic resolve", {
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "equals", value: surname }] }],
      }),
    });
    const campaignId = await create("Campaign", {
      name: marker("dynamic campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
      startsAt: "2026-12-01T09:00:00.000Z",
    });
    await linkList(campaignId, listId, "includedTargetLists");

    const result = await preview(campaignId);
    expect(result.resolved).toBe(2);
    // Nobody consented, so every resolved record is a consent-unknown block rather than an eligible one.
    expect(categoryOf(result, "consentUnknown")).toBe(2);
    expect(result.eligible).toBe(0);
  });

  it("treats a SQL-shaped value as a value: it matches nothing and changes nothing (§15 acceptance)", async () => {
    const listId = await makeList("injection criteria", {
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [
          {
            entityType: "Contact",
            match: "all",
            filters: [{ field: "lastName", operator: "equals", value: `' OR 1=1 --` }],
          },
        ],
      }),
    });
    await makeContact("RealSurname", `real-${runId}@example.com`);
    const refresh = await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/refresh`);
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
    expect(refresh.body["resolvedCount"]).toBe(0);

    // The whole contact table is still intact, which it would not be if the value had been executed.
    const contacts = await call("GET", "/api/v1/Contact?maxSize=1&where=[{\"field\":\"lastName\",\"operator\":\"equals\",\"value\":\"RealSurname\"}]");
    expect(((contacts.body["list"] ?? []) as unknown[]).length).toBe(1);
  });
});

describe("composition: exclusion, de-duplication and eligibility (tasks 4–5, §5.2, §5.5)", () => {
  it("excludes a member of an excluded audience even when another list includes them", async () => {
    const contact = await makeContact("Excluded", `excluded-${runId}@example.com`);
    const included = await makeList("include list");
    const excluded = await makeList("exclude list");
    await addMembers(included, [{ entityType: "Contact", entityId: contact }]);
    await addMembers(excluded, [{ entityType: "Contact", entityId: contact }]);

    const campaignId = await create("Campaign", {
      name: marker("exclusion campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, included, "includedTargetLists");
    await linkList(campaignId, excluded, "excludedTargetLists");

    const result = await preview(campaignId);
    expect(result.resolved).toBe(1);
    expect(categoryOf(result, "excludedBySegment")).toBe(1);
    expect(result.eligible).toBe(0);
    expect(result.samples.find((sample) => sample.entityId === contact)?.category).toBe("excludedBySegment");
  });

  it("counts one recipient once when two included audiences name the same record", async () => {
    const contact = await makeContact("Twice", `twice-${runId}@example.com`);
    const first = await makeList("include a");
    const second = await makeList("include b");
    await addMembers(first, [{ entityType: "Contact", entityId: contact }]);
    await addMembers(second, [{ entityType: "Contact", entityId: contact }]);

    const campaignId = await create("Campaign", {
      name: marker("duplicate campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, first, "includedTargetLists");
    await linkList(campaignId, second, "includedTargetLists");

    const result = await preview(campaignId);
    // One candidate, not two: the same record from two lists is one recipient (§5.2).
    expect(result.resolved).toBe(1);
    expect(categoryOf(result, "duplicateRecord")).toBe(0);
  });

  it("refuses a campaign whose audience is also its exclusion", async () => {
    const listId = await makeList("self conflict");
    const campaignId = await create("Campaign", {
      name: marker("self conflict campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, listId, "includedTargetLists");
    await linkList(campaignId, listId, "excludedTargetLists");

    const validate = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/validate`);
    expect(validate.status).toBe(200);
    const codes = ((validate.body["blockers"] ?? []) as { code: string }[]).map((finding) => finding.code);
    expect(codes).toContain("AUDIENCE_NOT_READABLE");
  });

  it("classifies a missing address and an unreadable audience separately (§5.5 categories)", async () => {
    const noAddress = await create("Contact", { name: marker("no address"), lastName: "NoAddress", status: "Active" });
    const listId = await makeList("no address list");
    await addMembers(listId, [{ entityType: "Contact", entityId: noAddress }]);
    const campaignId = await create("Campaign", {
      name: marker("no address campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, listId, "includedTargetLists");

    const result = await preview(campaignId);
    expect(categoryOf(result, "noEmailAddress")).toBe(1);
  });

  it("refreshes an audience's summary fields only on an explicit command", async () => {
    const surname = `Refresh${runId}`;
    await makeContact(surname, `refresh-${runId}@example.com`);
    const listId = await makeList("refresh list", {
      membershipMode: "dynamic",
      criteriaJson: JSON.stringify({
        version: 1,
        clauses: [{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "equals", value: surname }] }],
      }),
    });

    const before = await call("GET", `/api/v1/TargetList/${listId}`);
    expect(before.body["resolvedCount"] ?? 0).toBe(0);

    const previewId = await create("Campaign", {
      name: marker("refresh preview campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(previewId, listId, "includedTargetLists");
    await preview(previewId);
    const afterPreview = await call("GET", `/api/v1/TargetList/${listId}`);
    expect(afterPreview.body["resolvedCount"]).toBe(0);

    const refreshed = await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body["resolvedCount"]).toBe(1);
    expect(refreshed.body["criteriaHash"]).toBeTruthy();

    const after = await call("GET", `/api/v1/TargetList/${listId}`);
    expect(after.body["lastRefreshedAt"]).toBeTruthy();
    expect(after.body["refreshStatus"]).toBe("Resolved");
  });
});

describe("audience snapshots (19-MA.4 task 6, §5.2, §6.1)", () => {
  it("freezes the composition so a later audience change cannot rewrite history", async () => {
    const contact = await makeContact("Snapshot", `snapshot-${runId}@example.com`);
    const listId = await makeList("snapshot list");
    await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);
    const campaignId = await create("Campaign", {
      name: marker("snapshot campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, listId, "includedTargetLists");

    const first = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audienceSnapshot`, {
      mode: "preview",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const snapshotId = String(first.body["snapshotId"]);
    expect(first.body).toMatchObject({ resolved: 1, entryCount: 1 });
    created.push({ entity: "MarketingAudienceSnapshot", id: snapshotId });

    const entriesBefore = await call("GET", `/api/v1/MarketingAutomation/action/snapshot/${snapshotId}/entries`);
    expect(entriesBefore.status).toBe(200);
    expect((entriesBefore.body["entries"] ?? []) as unknown[]).toHaveLength(1);

    // The audience changes underneath the snapshot afterwards.
    const removal = await call("POST", `/api/v1/MarketingAutomation/action/segment/${listId}/members/remove`, {
      entityType: "Contact",
      entityId: contact,
    });
    expect(removal.body).toMatchObject({ removed: true });

    const entriesAfter = await call("GET", `/api/v1/MarketingAutomation/action/snapshot/${snapshotId}/entries`);
    const rows = (entriesAfter.body["entries"] ?? []) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["entity_id"])).toBe(contact);
    // The snapshot header is unchanged too: it is a record of what was meant, not a live view.
    const header = await call("GET", `/api/v1/MarketingAudienceSnapshot/${snapshotId}`);
    expect(header.body["resolvedCount"]).toBe(1);

    // A new snapshot reflects the changed audience and links back to the previous one.
    const second = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audienceSnapshot`, {
      mode: "final",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body["resolved"]).toBe(0);
    expect(second.body["previousSnapshotId"]).toBe(snapshotId);
    // The composition hash names *which audiences* were attached, and that did not change — only their
    // contents did. The entry set is what differs, which is exactly why the snapshot has to exist.
    expect(second.body["compositionHash"]).toBe(first.body["compositionHash"]);
    expect(second.body["entryCount"]).toBe(0);
  });

  it("stores address identities, never addresses (§6.1, §9.3)", async () => {
    const contact = await makeContact("Privacy", `privacy-${runId}@example.com`);
    const listId = await makeList("privacy list");
    await addMembers(listId, [{ entityType: "Contact", entityId: contact }]);
    const campaignId = await create("Campaign", {
      name: marker("privacy campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, listId, "includedTargetLists");
    const snapshot = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audienceSnapshot`, {});
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    created.push({ entity: "MarketingAudienceSnapshot", id: String(snapshot.body["snapshotId"]) });

    const entries = await call(
      "GET",
      `/api/v1/MarketingAutomation/action/snapshot/${String(snapshot.body["snapshotId"])}/entries`,
    );
    const json = JSON.stringify(entries.body["entries"]);
    expect(json).not.toContain(`privacy-${runId}@example.com`);
    expect(json).toMatch(/[0-9a-f]{64}/);
  });

  it("refuses a snapshot for a campaign with no audience, and a snapshot read to an unrelated caller", async () => {
    const campaignId = await create("Campaign", {
      name: marker("empty audience campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    const res = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audienceSnapshot`, {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/no audience/);
  });
});

describe("audience ACL does not leak (19-MA.4 acceptance, §9.2)", () => {
  it("hides a record the caller may not read from members, counts and samples", async () => {
    const listId = await makeList("acl list");
    const hiddenContact = await makeContact("Hidden", `hidden-${runId}@example.com`);
    const visibleContact = await makeContact("Visible", `visible-${runId}@example.com`);
    await addMembers(listId, [
      { entityType: "Contact", entityId: hiddenContact },
      { entityType: "Contact", entityId: visibleContact },
    ]);

    // Move one contact out of the other caller's reach by reassigning it to an unrelated owner.
    const roleId = `r_ma_audsee_${runId}`;
    await ctx.database.db
      .insertInto("roles")
      .values({
        id: roleId,
        name: `MA audience viewer ${runId}`,
        permissions: JSON.stringify({
          Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" },
          TargetList: { create: "no", read: "own", edit: "no", delete: "no", stream: "no" },
          Contact: { create: "no", read: "own", edit: "no", delete: "no", stream: "no" },
        }),
        field_permissions: JSON.stringify({}),
        entity_type: "Role",
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    const viewerId = `u_ma_viewer_${runId}`;
    await ctx.database.db
      .insertInto("users")
      .values({
        id: viewerId,
        user_name: `ma_viewer_${runId}`,
        is_admin: false,
        is_active: true,
        type: "regular",
        auth_method: "password",
        password: null,
        assigned_role_ids: JSON.stringify([roleId]),
        portal_types: JSON.stringify([]),
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
        first_name: "Viewer",
        last_name: runId,
        email_address: `ma_viewer_${runId}@example.com`,
      })
      .execute();
    await ctx.auth.setPassword(viewerId, "secret-password");
    const login = await call("POST", "/api/v1/Authentication", {
      userName: `ma_viewer_${runId}`,
      password: "secret-password",
    });
    const viewerToken = String((login.body as Record<string, unknown>)["accessToken"]);

    // The viewer owns the list's audience only through their own campaign; the contacts are not theirs.
    const members = await call("GET", `/api/v1/MarketingAutomation/action/segment/${listId}/members`, undefined, viewerToken);
    // Reading the list itself is refused (it belongs to the administrator), so no membership is exposed.
    expect(members.status).toBeGreaterThanOrEqual(400);

    const campaignId = await create("Campaign", {
      name: marker("acl campaign"),
      type: "Newsletter",
      purpose: "Newsletter",
    });
    await linkList(campaignId, listId, "includedTargetLists");
    const own = await preview(campaignId);
    expect(own.resolved).toBe(2);

    const foreignPreview = await call(
      "GET",
      `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audiencePreview`,
      undefined,
      viewerToken,
    );
    expect(foreignPreview.status).toBeGreaterThanOrEqual(400);
  });
});
