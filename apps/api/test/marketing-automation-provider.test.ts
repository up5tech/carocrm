import { RateLimitError, ValidationError } from "@carocrm/core/errors/index.js";
import type { MailTransport, SmtpSender, SmtpSendInfo, SmtpSettings } from "@carocrm/mail";
import { createSmtpTransport, MemoryTransport } from "@carocrm/mail";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { MAIL_TRANSPORT_TOKEN } from "../src/email/email.constants.js";
import type { EmailAccountsService } from "../src/email/email-accounts.service.js";
import {
  assertProviderMessage,
  type MarketingProviderAdapter,
  MarketingProviderError,
  type MarketingProviderInfo,
  type MarketingProviderMessage,
  MarketingProviderRegistry,
} from "../src/marketing-automation/marketing-automation-provider.js";
import {
  classifyMarketingProviderFailure,
  KERNEL_MAIL_PROVIDER_KEY,
  KernelMailMarketingProvider,
} from "../src/marketing-automation/marketing-provider-kernel.adapter.js";
import { MarketingProviderLimiter } from "../src/marketing-automation/marketing-provider-limiter.js";
import {
  TEST_SEND_BANNER,
  TEST_SEND_HEADER,
  TEST_SEND_SUBJECT_PREFIX,
} from "../src/marketing-automation/marketing-test-send.service.js";
import type { ApiContext } from "./support/boot-api.js";
import { authHeader, bootApi, shutdownApi } from "./support/boot-api.js";

/**
 * Phase 19-MA.7 — provider adapter, capability metadata, error classification, the rate/concurrency
 * interface and the safe test send (PLAN_Phase_19_Marketing_Automation.md §5.8, §8.2, §10.2, §10.5,
 * §15 `19-MA.7`).
 *
 * Two halves, because the phase has two different risks:
 *
 *  - the **unit** half proves the adapter and the limiter behave without a socket, a network or a database:
 *    a scripted `SmtpSender` stands in for the server, so nothing here can accidentally reach a live
 *    provider (§15 acceptance "unit/E2E tests cannot accidentally use a live provider", AGENTS.md §5.5);
 *  - the **end-to-end** half runs the real HTTP API against the configured primary database (AGENTS.md
 *    §3.1) with a scripted in-process adapter registered under its own key — the deployment's settings name
 *    that key, exactly as a real installation names `platform-mail`. No test database is created and no
 *    message leaves the process: the only "provider" is the scripted object.
 *
 * Test records carry the `runId` marker and are removed by exact id/name in `afterAll` (§3.3). The settings
 * row is instance-wide, so this suite restores the provider policy it changed before it finishes.
 */

let ctx: ApiContext;
let runId: string;
let testAccountId: string;
const created: { entity: string; id: string }[] = [];
const campaignIds: string[] = [];
const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

/** A live-mode adapter with no network: it records what the domain handed it and can be told to fail. */
class ScriptedMarketingProvider implements MarketingProviderAdapter {
  readonly info: MarketingProviderInfo = {
    key: "agent-test-provider",
    label: "Scripted test provider",
    mode: "live",
    maxRecipients: 10,
    ratePerMinute: 0,
    maxConcurrency: 1,
    fromAddress: "agent-test-sender@example.test",
    reportsEvents: false,
    supportsTestSend: true,
  };
  readonly messages: MarketingProviderMessage[] = [];
  verified = 0;
  failure: MarketingProviderError | null = null;

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async verify(): Promise<void> {
    this.verified += 1;
    if (this.failure !== null && this.failure.reasonCode === "AUTH_FAILED") throw this.failure;
  }

  async send(message: MarketingProviderMessage): Promise<Awaited<ReturnType<MarketingProviderAdapter["send"]>>> {
    this.validate(message);
    if (this.failure !== null) throw this.failure;
    this.messages.push(message);
    return {
      key: this.info.key,
      accepted: true,
      providerMessageId: "scripted-1",
      receipts: message.to.map((recipient) => ({
        recipient,
        status: "accepted" as const,
        providerMessageId: "scripted-1",
      })),
    };
  }
}

const scripted = new ScriptedMarketingProvider();
/** Every API assertion is a delta, so one test's submissions cannot mask another's silence. */
const sentCount = () => scripted.messages.length;

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

async function create(entity: string, payload: Record<string, unknown>): Promise<string> {
  const res = await call("POST", `/api/v1/${entity}`, payload);
  expect(res.status, `create ${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const id = String(res.body["id"]);
  created.push({ entity, id });
  if (entity === "Campaign") campaignIds.push(id);
  return id;
}

async function sendTest(campaignId: string, payload: Record<string, unknown>, token = ctx.adminToken) {
  return call("POST", `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sendTest`, payload, token);
}

function blockerCodesOf(body: Record<string, unknown>): string[] {
  const blockers = (body["blockers"] ?? []) as { code: string }[];
  return blockers.map((finding) => finding.code);
}

/** A Draft sending campaign with content and a sender: exactly what a test send needs to exist. */
async function makeTestableCampaign(): Promise<string> {
  const templateId = await create("EmailTemplate", {
    name: marker("template"),
    subject: "Hello {{recipientName}}",
    // Both parts, so the test proves the banner is prepended to each of them.
    body: "A body for the test send.",
    bodyHtml: "<p>A body for the test send.</p>",
  });
  return create("Campaign", {
    name: marker("campaign"),
    type: "Newsletter",
    purpose: "Newsletter",
    templateId,
    emailAccountId: testAccountId,
    trackingOpen: false,
    trackingClick: false,
  });
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `map${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
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

  // The one place a test adapter becomes reachable: registered by key on the running registry, never by
  // making the fake claim to be live.
  ctx.app.get(MarketingProviderRegistry).register(scripted);
  // Rendering is the `templates` capability (MA.6) and a test send renders the content it would carry, so
  // this run enables it — the same explicit opt-in the template suite makes. Audiences stay off by default
  // too, and one test below needs a target list to aim a campaign at.
  await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    features: { templates: true, audience: true },
  });
});

afterAll(async () => {
  // Restore the instance-wide policy this suite changed, so a later run (or a developer's database) is not
  // left pointing at a provider key that only existed in this process.
  await call("POST", "/api/v1/MarketingAutomation/action/settings", {
    provider: {
      key: "",
      limits: { ratePerMinute: 0, maxConcurrency: 1 },
      testSend: { allowedRecipients: [], requireConfirmation: true, maxRecipients: 5 },
    },
  });
  for (const entry of [...created].reverse()) {
    await call("DELETE", `/api/v1/${entry.entity}/${entry.id}`);
  }
  if (campaignIds.length > 0) {
    // Module-written history and events outlive a campaign deletion; removed by the exact ids this run made.
    await ctx.database.db
      .deleteFrom("entity_records")
      .where("entity_type", "=", "CampaignTransition")
      .where(sql`attrs ->> 'campaignId'`, "in", campaignIds)
      .execute();
    await ctx.database.db
      .deleteFrom("outbox_events")
      .where("event_type", "like", "marketingAutomation.%")
      .where(sql`payload ->> 'campaignId'`, "in", campaignIds)
      .execute();
  }
  await ctx.database.db.deleteFrom("email_accounts").where("id", "=", testAccountId).execute();
  await shutdownApi();
});

function smtpSettings(overrides: Partial<SmtpSettings> = {}): SmtpSettings {
  return {
    kind: "smtp",
    host: "127.0.0.1",
    port: 2525,
    secure: false,
    fromAddress: "marketing@example.test",
    fromName: null,
    replyToAddress: null,
    auth: { user: "user", password: "not-a-real-password" },
    poolSize: 1,
    maxMessagesPerConnection: 1,
    maxRecipients: 10,
    messageIdDomain: "example.test",
    connectionTimeoutMs: 1000,
    greetingTimeoutMs: 1000,
    socketTimeoutMs: 1000,
    strictFrom: true,
    name: "",
    ...overrides,
  };
}

function senderReplies(info: SmtpSendInfo): SmtpSender {
  return { sendMail: async () => info, verify: async () => undefined };
}

/** A scripted sender that fails the way a broken server does; never a socket. */
function failingSender(error: unknown): SmtpSender {
  return {
    sendMail: async () => {
      throw error;
    },
    verify: async () => undefined,
  };
}

const accountsStub = (resolve: (id: string) => Promise<unknown>): EmailAccountsService =>
  ({ resolveTransportConfig: resolve }) as unknown as EmailAccountsService;

function message(overrides: Partial<MarketingProviderMessage> = {}): MarketingProviderMessage {
  return {
    to: ["recipient@example.test"],
    subject: "[TEST] hello",
    text: "body",
    fromAddress: "marketing@example.test",
    idempotencyKey: "key-1",
    ...overrides,
  };
}

describe("provider failure classification (19-MA.7 task 5)", () => {
  it("returns the three documented states, and never a provider transcript", () => {
    // 4xx is worth another attempt; 5xx and rejected envelopes are not (the kernel already decided this).
    expect(classifyMarketingProviderFailure({ responseCode: 451 })).toEqual({
      kind: "retryable",
      reasonCode: "PROVIDER_FAILED",
    });
    // §5.8 names rejected authentication as non-retryable, so marketing says `permanent` even though the
    // kernel's own SMTP classifier (correctly, for a bounded job) treats it as transient.
    expect(classifyMarketingProviderFailure({ code: "EAUTH" })).toEqual({
      kind: "permanent",
      reasonCode: "AUTH_FAILED",
    });
    expect(classifyMarketingProviderFailure({ code: "EENVELOPE" })).toEqual({
      kind: "permanent",
      reasonCode: "RECIPIENT_REJECTED",
    });
    // A socket that dies mid-transaction cannot be answered locally: the state must be unambiguous.
    expect(classifyMarketingProviderFailure({ code: "ECONNRESET" })).toEqual({
      kind: "unknown_submission",
      reasonCode: "SUBMISSION_UNKNOWN",
    });
    expect(classifyMarketingProviderFailure(new ValidationError("Malformed message."))).toEqual({
      kind: "permanent",
      reasonCode: "MESSAGE_INVALID",
    });
    const own = new MarketingProviderError("Stopped.", "retryable", "RATE_LIMITED");
    expect(classifyMarketingProviderFailure(own)).toEqual({ kind: "retryable", reasonCode: "RATE_LIMITED" });
  });

  it("maps a transport rejection to per-recipient receipts instead of one batch verdict", async () => {
    const transport = createSmtpTransport(
      smtpSettings(),
      senderReplies({ messageId: "<scripted@example.test>", accepted: ["ok@example.test"], rejected: ["no@example.test"] }),
    );
    const adapter = new KernelMailMarketingProvider(transport, accountsStub(async () => ({})));
    const result = await adapter.send(message({ to: ["ok@example.test", "no@example.test"] }));
    expect(result.accepted).toBe(true);
    expect(result.receipts).toEqual([
      { recipient: "ok@example.test", status: "accepted", providerMessageId: "scripted@example.test" },
      { recipient: "no@example.test", status: "rejected", reasonCode: "PROVIDER_REJECTED" },
    ]);
  });

  it("classifies a failed submission through the adapter and names the From it resolved", async () => {
    const alive = new KernelMailMarketingProvider(
      createSmtpTransport(smtpSettings(), senderReplies({ accepted: ["recipient@example.test"] })),
      accountsStub(async () => ({})),
    );
    expect(alive.info.mode).toBe("live");
    expect(alive.info.fromAddress).toBe("marketing@example.test");

    const broken = new KernelMailMarketingProvider(
      createSmtpTransport(smtpSettings(), failingSender({ code: "ECONNRESET" })),
      accountsStub(async () => ({})),
    );
    await expect(broken.send(message())).rejects.toMatchObject({
      kind: "unknown_submission",
      reasonCode: "SUBMISSION_UNKNOWN",
    });
    // The operator-facing sentence is ours; the provider's own text never becomes the response (§9.3).
    await expect(broken.send(message())).rejects.toThrow(/state is unknown/);
  });

  it("keeps a mailbox that cannot be read a permanent, named configuration failure", async () => {
    const adapter = new KernelMailMarketingProvider(
      createSmtpTransport(smtpSettings(), senderReplies({ accepted: ["recipient@example.test"] })),
      accountsStub(async () => {
        throw new ValidationError('Email account "gone" is not active.');
      }),
    );
    await expect(adapter.send(message({ senderAccountId: "gone" }))).rejects.toMatchObject({
      kind: "permanent",
      reasonCode: "SENDER_ACCOUNT_INVALID",
    });
  });

  it("refuses header injection and a message with no resolvable sender", async () => {
    const adapter = new KernelMailMarketingProvider(
      new MemoryTransport(),
      accountsStub(async () => ({})),
    );
    expect(() => adapter.validate(message({ headers: { "X-Test": "ok\r\nInjected: yes" } }))).toThrow(
      /illegal character/,
    );
    expect(() =>
      adapter.validate(message({ to: ["recipient@example.test"], fromAddress: undefined, senderAccountId: undefined })),
    ).toThrow(/sender address or a sending account/);
    // A transport that is deliberately not delivering can never be reported as live (§1.2).
    expect(adapter.info.mode).toBe("disabled");
  });
});

describe("provider limiter (19-MA.7 task 5)", () => {
  it("enforces a per-provider message rate and releases nothing on a failed call", async () => {
    const limiter = new MarketingProviderLimiter();
    let clock = 1_000_000;
    limiter.now = () => clock;
    const limits = { messages: 1, ratePerMinute: 2, maxConcurrency: 1 };
    await limiter.run("p", limits, async () => "first");
    await limiter.run("p", limits, async () => "second");
    expect(() => limiter.check("p", limits)).toThrow(RateLimitError);
    // A different provider is unaffected: the ceiling is per key, not per process.
    expect(() => limiter.check("other", limits)).not.toThrow();
    clock += 60_001;
    expect(() => limiter.check("p", limits)).not.toThrow();
  });

  it("bounds concurrency and frees the slot even when the provider throws", async () => {
    const limiter = new MarketingProviderLimiter();
    const limits = { messages: 1, ratePerMinute: 0, maxConcurrency: 1 };
    let release: () => void = () => undefined;
    const inFlight = limiter.run("p", limits, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    expect(() => limiter.check("p", limits)).toThrow(RateLimitError);
    release();
    await inFlight;
    expect(() => limiter.check("p", limits)).not.toThrow();

    await expect(
      limiter.run("p", limits, async () => {
        throw new MarketingProviderError("nope", "permanent", "PROVIDER_FAILED");
      }),
    ).rejects.toThrow(/nope/);
    expect(() => limiter.check("p", limits)).not.toThrow();
  });
});

describe("provider registry resolves by key, fail-closed (19-MA.7 task 1)", () => {
  it("binds the kernel mail adapter in the running application, gated by the transport's own mode", () => {
    const registry = ctx.app.get(MarketingProviderRegistry);
    expect(registry.has(KERNEL_MAIL_PROVIDER_KEY)).toBe(true);
    const kernel = registry.resolve(KERNEL_MAIL_PROVIDER_KEY);
    expect(kernel.info.key).toBe(KERNEL_MAIL_PROVIDER_KEY);
    expect(kernel.info.label).toContain("Kernel mail transport");
    // The adapter may only claim `live` when the platform transport does — a `none`/`memory` deployment can
    // never produce a marketing provider that pretends a message went out (§1.2, AGENTS.md §5.5).
    const transport = ctx.app.get<MailTransport>(MAIL_TRANSPORT_TOKEN);
    expect(kernel.info.mode).toBe(transport.mode === "live" ? "live" : "disabled");
    expect(kernel.info.fromAddress).toBe(transport.info.fromAddress);
    expect(kernel.info.maxRecipients).toBe(Math.max(1, transport.info.maxRecipients));
  });

  it("does not make a live provider reachable from a mis-set key", () => {
    const registry = new MarketingProviderRegistry({ mailTransport: "none" } as AppConfig);
    expect(registry.resolve(KERNEL_MAIL_PROVIDER_KEY).info.mode).toBe("disabled");
    expect(registry.resolve("platform-mail").info.key).toBe("none");
    // The fake is reachable only where the deployment itself declares it is not attached to a mail server.
    expect(registry.resolve("fake").info.key).toBe("none");
    const memory = new MarketingProviderRegistry({ mailTransport: "memory" } as AppConfig);
    expect(memory.resolve("fake").info.key).toBe("fake");
    expect(memory.resolve("fake").info.mode).toBe("disabled");
  });
});

describe("safe test send over the API (19-MA.7 task 3, §10.2)", () => {
  it("advertises capability metadata, and refuses a provider key the deployment cannot resolve", async () => {
    const health = await call("GET", "/api/v1/MarketingAutomation/action/health");
    expect(health.status).toBe(200);
    const provider = health.body["provider"] as {
      available: { key: string; supportsTestSend: boolean }[];
    };
    // Capability metadata, not credentials: every resolvable adapter is listed with what it can do.
    expect(provider.available.map((entry) => entry.key)).toContain("agent-test-provider");
    expect(provider.available.find((entry) => entry.key === "agent-test-provider")?.supportsTestSend).toBe(true);

    const unknown = await call("POST", "/api/v1/MarketingAutomation/action/settings", {
      provider: { key: "no-such-provider" },
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(unknown.body)).toContain("no-such-provider");
  });

  it("refuses an unconfigured allowlist, a non-allowlisted recipient and a missing confirmation", async () => {
    const campaignId = await makeTestableCampaign();
    const before = sentCount();
    const emptyPolicy = await sendTest(campaignId, { recipients: ["qa@example.test"], confirm: true });
    expect(emptyPolicy.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(emptyPolicy.body)).toContain("TEST_SEND_NOT_CONFIGURED");

    const configured = await call("POST", "/api/v1/MarketingAutomation/action/settings", {
      provider: {
        key: scripted.info.key,
        limits: { ratePerMinute: 0, maxConcurrency: 1 },
        testSend: { allowedRecipients: [`qa-${runId}@example.test`, `blocked-${runId}@example.test`], maxRecipients: 2 },
      },
    });
    expect(configured.status, JSON.stringify(configured.body)).toBeLessThan(300);

    // An address nobody allowlisted is refused even though the provider is configured and live.
    const outside = await sendTest(campaignId, { recipients: ["someone-else@example.test"], confirm: true });
    expect(outside.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(outside.body)).toContain("TEST_RECIPIENT_NOT_ALLOWED");
    expect(sentCount()).toBe(before);

    // Confirmation is a server-side requirement, not a UI convention (§10.2).
    const unconfirmed = await sendTest(campaignId, { recipients: [`qa-${runId}@example.test`] });
    expect(unconfirmed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(unconfirmed.body)).toContain("TEST_SEND_CONFIRMATION_REQUIRED");

    // Too many recipients for the configured ceiling is refused before anything is submitted.
    const tooMany = await sendTest(campaignId, {
      recipients: [`qa-${runId}@example.test`, `blocked-${runId}@example.test`, `third-${runId}@example.test`],
      confirm: true,
    });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expect(sentCount()).toBe(before);
  });

  it("sends one marked test message and leaves the campaign's state and history untouched", async () => {
    const campaignId = await makeTestableCampaign();
    const sentBefore = sentCount();
    const before = await call("GET", `/api/v1/Campaign/${campaignId}`);
    expect(before.body["status"]).toBe("Draft");

    const res = await sendTest(campaignId, { recipients: [`qa-${runId}@example.test`], confirm: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["testSend"]).toBe(true);
    expect(res.body["accepted"]).toBe(true);
    expect(res.body["provider"]).toMatchObject({ key: scripted.info.key, mode: "live" });
    // The identity is resolved for the mailbox the campaign names — and the mailbox's address is not echoed
    // back to a caller who could not read it in the first place (§9.4).
    expect(JSON.stringify(res.body)).not.toContain(`agent-test-${runId}@example.com`);
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret|smtp_password|ENCRYPTION_KEY/i);

    const sent = scripted.messages.at(-1);
    expect(sent).toBeDefined();
    expect(sent?.subject.startsWith(TEST_SEND_SUBJECT_PREFIX)).toBe(true);
    expect(sent?.headers?.[TEST_SEND_HEADER]).toBe("true");
    expect(sent?.text).toContain(TEST_SEND_BANNER);
    expect(sent?.html).toContain(TEST_SEND_BANNER);
    // The message carries the campaign's mailbox as the sending account, not a platform-wide identity.
    expect(sent?.senderAccountId).toBe(testAccountId);

    // Nothing about the campaign moved: §15 acceptance "test sends are not counted as campaign sends".
    const after = await call("GET", `/api/v1/Campaign/${campaignId}`);
    expect(after.body["status"]).toBe("Draft");
    expect(after.body["startedAt"] ?? null).toBeNull();
    const transitions = await ctx.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", "CampaignTransition")
      .where(sql`attrs ->> 'campaignId'`, "=", campaignId)
      .execute();
    expect(transitions).toHaveLength(0);
    const events = await ctx.database.db
      .selectFrom("outbox_events")
      .select("id")
      .where("event_type", "like", "marketingAutomation.%")
      .where(sql`payload ->> 'campaignId'`, "=", campaignId)
      .execute();
    expect(events).toHaveLength(0);

    // The same submission twice is one message: the recorded answer comes back marked as a duplicate.
    const replay = await sendTest(campaignId, {
      recipients: [`qa-${runId}@example.test`],
      confirm: true,
      idempotencyKey: `agent-test-key-${runId}`,
    });
    expect(replay.status).toBe(200);
    const replayed = await sendTest(campaignId, {
      recipients: [`qa-${runId}@example.test`],
      confirm: true,
      idempotencyKey: `agent-test-key-${runId}`,
    });
    expect(replayed.body["duplicate"]).toBe(true);
    // Two submissions in the middle (the first send and its single replay answer) — never three.
    expect(sentCount()).toBe(sentBefore + 2);
  });

  it("still refuses a suppressed address, and reports an unknown submission instead of retrying", async () => {
    const campaignId = await makeTestableCampaign();
    const before = sentCount();
    const suppressed = await call("POST", "/api/v1/MarketingAutomation/action/suppression", {
      emailAddress: `blocked-${runId}@example.test`,
      scope: "Purpose",
      purpose: "Newsletter",
      reason: "OperatorBlock",
    });
    expect(suppressed.status, JSON.stringify(suppressed.body)).toBeLessThan(300);
    const suppressionId = String(suppressed.body["id"]);

    const blocked = await sendTest(campaignId, { recipients: [`blocked-${runId}@example.test`], confirm: true });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(blocked.body)).toContain("TEST_RECIPIENT_SUPPRESSED");
    expect(sentCount()).toBe(before);

    // A classified provider failure is a result, not an exception: the operator must see `unknown_submission`
    // to know that pressing send again is not safe (§5.8).
    scripted.failure = new MarketingProviderError(
      "The provider connection failed while the message was submitted.",
      "unknown_submission",
      "SUBMISSION_UNKNOWN",
    );
    const failed = await sendTest(campaignId, { recipients: [`qa-${runId}@example.test`], confirm: true });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body["accepted"]).toBe(false);
    expect(failed.body["errorKind"]).toBe("unknown_submission");
    scripted.failure = null;

    // The emergency stop is absolute: a test send is a send (§13).
    await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", { paused: true, reason: marker("stop") });
    const stopped = await sendTest(campaignId, { recipients: [`qa-${runId}@example.test`], confirm: true });
    expect(stopped.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(stopped.body)).toContain("GLOBAL_SEND_PAUSED");
    await call("POST", "/api/v1/MarketingAutomation/action/globalSendPause", { paused: false });

    // Only this run's suppression row is removed, by its exact id (§3.3).
    await ctx.database.db.deleteFrom("entity_records").where("id", "=", suppressionId).execute();
  });

  it("clears the send-readiness provider gate for a live adapter and restores it when none is configured", async () => {
    const campaignId = await makeTestableCampaign();
    const listId = await create("TargetList", {
      name: marker("audience"),
      membershipMode: "static",
      entityTypes: "Contact,Lead",
      status: "Active",
    });
    const linked = await call("PUT", `/api/v1/Campaign/${campaignId}/includedTargetLists/${listId}`);
    expect(linked.status).toBeLessThan(300);

    // With the deployment's provider key pointing at a live adapter, the only §5.1 blocker left is consent
    // configuration — the provider gate (MA.3's `PROVIDER_NOT_BOUND`) is satisfied, which is what MA.7 adds.
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: scripted.info.key } });
    const live = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${campaignId}/validate?as=Running`,
    );
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(blockerCodesOf(live.body)).not.toContain("PROVIDER_NOT_BOUND");

    // Unconfigured again: the gate is back, and the message names the setting rather than a later phase.
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: "" } });
    const unconfigured = await call(
      "POST",
      `/api/v1/MarketingAutomation/action/campaign/${campaignId}/validate?as=Running`,
    );
    expect(blockerCodesOf(unconfigured.body)).toContain("PROVIDER_NOT_BOUND");
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: scripted.info.key } });
  });

  it("refuses a live provider that is not bound, and a caller who may not edit the campaign", async () => {
    const campaignId = await makeTestableCampaign();
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: "" } });
    const unbound = await sendTest(campaignId, { recipients: [`qa-${runId}@example.test`], confirm: true });
    expect(unbound.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(unbound.body)).toContain("PROVIDER_NOT_BOUND");
    await call("POST", "/api/v1/MarketingAutomation/action/settings", { provider: { key: scripted.info.key } });

    // A campaign the caller cannot edit is never a test-send target, whatever the allowlist says (§9.2).
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sendTest`,
      headers: { "content-type": "application/json" },
      payload: { recipients: [`qa-${runId}@example.test`], confirm: true },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
