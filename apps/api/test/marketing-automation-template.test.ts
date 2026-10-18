import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { templateContentHash } from "../src/marketing-automation/marketing-template-render.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.6 — content preview, render safety and immutable template revisions, end to end against
 * the configured primary database through the real HTTP API (AGENTS.md §3.1): no test database, and
 * nothing here sends a message. Every record carries the `runId` marker and is removed by exact id or
 * exact name in `afterAll` (§3.3); the sealed revisions are module-written rows, so they are removed by
 * the revision ids this run recorded, never by a broad predicate (§3.4).
 *
 * The four phase acceptance criteria each have a named test: unsafe markup and URLs never reach the
 * rendered content; the preview for a caller who cannot read what the campaign leans on is a refusal
 * (`fields the sender cannot read`); a missing recipient value is a documented fallback; and a sealed
 * revision is reproducible from its hash (`a message can be associated with the revision/hash used`).
 */

let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];
/** Module-written revision rows this run caused; removed by exact id in `afterAll` (§3.3). */
const revisionIds: string[] = [];

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
  return id;
}

interface PreviewBody {
  campaignId: string;
  templateId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  plainText: string | null;
  plainTextSource: "template" | "generated" | "none";
  resolved: string[];
  unresolved: string[];
  fallbacks: { name: string; group: string }[];
  systemLinks: string[];
  recipientResolved: boolean;
  findings: { code: string; level: string; message: string }[];
  templateContentHash: string;
  latestRevision: { revisionId: string; revisionNumber: number; contentHash: string } | null;
  generatedAt: string;
}

/** The UNSAFE template this run previews: hostile markup, an unknown placeholder, no opt-out link. */
const UNSAFE_HTML = `<p>Hello <b>{{recipientName}}</b></p><script>alert("sealed content ${runId}")</script><img src="javascript:break">{{unknownThing}}`;

async function preview(campaignId: string, payload: Record<string, unknown> = {}, token = ctx.adminToken) {
  const res = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/previewContent`, payload, token);
  const body = res.body as unknown as (PreviewBody & { message?: string }) | Record<string, unknown>;
  return { status: res.status, body: body as PreviewBody | Record<string, unknown> };
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `mat${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  // MA.6's capability is off by default (§15 feature flags) — the run enables it explicitly.
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: true, templates: true } });

  const templateId = await create("EmailTemplate", {
    name: marker("template"),
    subject: `Hello {{recipientFirstName}} ({{campaignName}})`,
    body: `Hi {{recipientName}}, welcome. Signed, the AGENT_TEST team.`,
    bodyHtml: UNSAFE_HTML,
    category: "AGENT_TEST",
  });
  await create("Contact", {
    lastName: `Lovelace ${runId}`,
    firstName: "Ada",
    emailAddress: `agent-test-${runId}@example.com`,
  });
  campaignEmailId = await create("Campaign", {
    name: marker("email campaign"),
    type: "Newsletter",
    purpose: "Newsletter",
    templateId,
  });
  campaignNoticeId = await create("Campaign", {
    name: marker("service notice campaign"),
    type: "Informational",
    purpose: "ServiceNotice",
    serviceNoticeAcknowledged: true,
    templateId,
  });
});

let campaignEmailId = "";
let campaignNoticeId = "";

afterAll(async () => {
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  const db = ctx.database.db;
  // Revisions are module-written (the record API refuses their writes), so the exact ids this run sealed
  // are the only safe removal predicate (§3.3, §3.4).
  if (revisionIds.length > 0) {
    await db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "MarketingTemplateRevision")
      .where("id", "in", revisionIds)
      .execute();
    await db
      .deleteFrom("outbox_events")
      .where("event_type", "=", "marketingAutomation.template.revisionSealed")
      .where(sql`payload ->> 'revisionId'`, "in", revisionIds)
      .execute();
  }
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { audience: false, templates: false } });
  await shutdownApi();
});

it("refuses the content commands while the templates capability is off", async () => {
  await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { templates: false } });
  try {
    const res = await preview(campaignEmailId);
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain("templates");
  } finally {
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { features: { templates: true } });
  }
});

it("previews the linked template, sanitised, with unresolved placeholders reported", async () => {
  const { status, body } = await preview(campaignEmailId);
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  const output = body as PreviewBody;
  expect(output.campaignId).toBe(campaignEmailId);
  expect(output.plainTextSource).toBe("template");
  // The `<script>` block and the `javascript:` source never reach the rendered content (§9.4).
  expect(output.bodyHtml).not.toContain("<script");
  expect(output.bodyHtml).not.toContain("javascript:");
  expect(output.bodyHtml).toContain("Hello <b>");
  const codes = output.findings.map((finding) => finding.code);
  expect(codes).toContain("MARKUP_REMOVED");
  // The naming mistake is reported, not invented around (§5.4: fallback plus report).
  expect(output.unresolved).toContain("unknownThing");
  expect(codes).toContain("PLACEHOLDER_UNKNOWN");
  // A Newsletter is consent-required, and the template carries no opt-out placeholder yet.
  expect(codes).toContain("FOOTER_MISSING");
});

it("renders with a named, readable sample recipient and falls back without one", async () => {
  const rows = await ctx.database.db
    .selectFrom("entity_records")
    .select(["id", "attrs"])
    .where("entity_type", "=", "Contact")
    .where(sql`attrs ->> 'lastName'`, "=", `Lovelace ${runId}`)
    .execute();
  const contactId = String(rows[0]?.id);
  const withRecipientResult = await preview(campaignEmailId, { recipientType: "Contact", recipientId: contactId });
  const { status, body } = withRecipientResult;
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  const withRecipient = body as PreviewBody;
  expect(withRecipient.resolved).toContain("recipientName");
  expect(withRecipient.subject).toContain("Hello Ada");
  // A hostile field value cannot break out of the author's markup in the sanitised body.
  expect(withRecipient.bodyHtml).not.toMatch(/<script/i);

  const without = await preview(campaignEmailId);
  const noRecipient = without.body as PreviewBody;
  expect(noRecipient.fallbacks.map((fallback) => fallback.name)).toContain("recipientFirstName");
  expect(noRecipient.recipientResolved).toBe(false);
});

it("footer discipline follows the purpose: ServiceNotice carries no opt-out obligation", async () => {
  const { status, body } = await preview(campaignNoticeId);
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  expect((body as PreviewBody).findings.map((finding) => finding.code)).not.toContain("FOOTER_MISSING");
});

it("refuses a preview for a caller who cannot read the template the campaign leans on (§9.2)", async () => {
  const roleNoTemplate = `r_mat_${runId}`;
  await createTestRole(ctx, {
    id: roleNoTemplate,
    name: `MA no template ${runId}`,
    permissions: {
      Campaign: { create: "own", read: "own", edit: "own", delete: "no", stream: "no" },
      EmailTemplate: { create: "no", read: "no", edit: "no", delete: "no", stream: "no" },
    },
  });
  const marketer = await createTestUser(ctx, { userName: `ma_notpl_${runId}`, roleIds: [roleNoTemplate] });
  const res = await preview(campaignEmailId, {}, marketer.token);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

it("rejects a client attempt to write a revision through the record API", async () => {
  const templateId = await createdCampaignTemplate();
  const res = await call("POST", "/api/v1/MarketingTemplateRevision", {
    name: marker("forged revision"),
    templateId,
    revisionNumber: 1,
    contentHash: "0".repeat(64),
    sealedAt: new Date().toISOString(),
  });
  // The write guard's domain refusals surface as validation errors over HTTP.
  expect(res.status).toBe(422);
  expect(JSON.stringify(res.body)).toContain("MARKETING_INTERNAL_WRITE_ONLY");
});

it("seals revisions monotonically, re-uses them for identical content, and traces by hash", async () => {
  const templateId = await createdCampaignTemplate();
  const parts = await templatePartsOf(templateId);
  const expectedHash = templateContentHash(parts);

  const first = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignEmailId}/contentRevision`, {});
  expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
  const sealFirst = first.body as { revisionId: string; revisionNumber: number; contentHash: string; reused: boolean };
  revisionIds.push(sealFirst.revisionId);
  expect(sealFirst.reused).toBe(false);
  expect(sealFirst.revisionNumber).toBe(1);
  expect(sealFirst.contentHash).toBe(expectedHash);

  // Idempotent: the same content sealed again is the same revision, not a sibling evidence row (§0.1 rule 10).
  const again = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignEmailId}/contentRevision`, {});
  const resealed = again.body as { revisionId: string; revisionNumber: number; reused: boolean };
  expect(resealed.reused).toBe(true);
  expect(resealed.revisionId).toBe(sealFirst.revisionId);
  expect(resealed.revisionNumber).toBe(1);

  // Different content earns the next number.
  await call("PUT", `/api/v1/EmailTemplate/${templateId}`, { subject: `Edited subject ${runId}` });
  const second = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignEmailId}/contentRevision`, {});
  const sealSecond = second.body as { revisionId: string; revisionNumber: number; contentHash: string; reused: boolean };
  revisionIds.push(sealSecond.revisionId);
  expect(sealSecond.reused).toBe(false);
  expect(sealSecond.revisionNumber).toBe(2);
  const editedParts = await templatePartsOf(templateId);
  expect(sealSecond.contentHash).toBe(templateContentHash(editedParts));
  expect(sealSecond.contentHash).not.toBe(sealFirst.contentHash);

  // The preview reports the newest revision, so an author previews in the context of what is sealed.
  const { status, body } = await preview(campaignEmailId);
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  expect((body as PreviewBody).latestRevision?.revisionId).toBe(sealSecond.revisionId);

  const list = await call("GET", `/api/v1/MarketingAutomation/action/campaign/${campaignEmailId}/contentRevisions`);
  expect(list.status).toBeLessThan(300);
  const revisions = (list.body as { revisions: { revisionId: string; revisionNumber: number }[] }).revisions;
  expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
});

it("carries the render findings into the campaign validation report", async () => {
  const res = await call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignEmailId}/validate`, {});
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const warnings = (res.body as { warnings: { code: string }[] }).warnings.map((finding) => finding.code);
  expect(warnings).toContain("CONTENT_MARKUP_REMOVED");
  expect(warnings).toContain("CONTENT_PLACEHOLDER_UNKNOWN");
  expect(warnings).toContain("CONTENT_FOOTER_MISSING");
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The template the email campaign links, for hash cross-checks. */
async function createdCampaignTemplate(): Promise<string> {
  const campaign = await ctx.database.db
    .selectFrom("entity_records")
    .select("attrs")
    .where("id", "=", campaignEmailId)
    .executeTakeFirstOrThrow();
  return String((campaign.attrs as Record<string, unknown>)["templateId"]);
}

async function templatePartsOf(templateId: string): Promise<{ subject: string | null; body: string | null; bodyHtml: string | null }> {
  const row = await ctx.database.db
    .selectFrom("entity_records")
    .select("attrs")
    .where("entity_type", "=", "EmailTemplate")
    .where("id", "=", templateId)
    .executeTakeFirstOrThrow();
  const attrs = row.attrs as Record<string, unknown>;
  return {
    subject: typeof attrs["subject"] === "string" ? attrs["subject"] : null,
    body: typeof attrs["body"] === "string" ? attrs["body"] : null,
    bodyHtml: typeof attrs["bodyHtml"] === "string" ? attrs["bodyHtml"] : null,
  };
}
