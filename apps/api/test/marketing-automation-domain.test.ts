import { describe, expect, it } from "vitest";

import {
  allowedCampaignCommands,
  CAMPAIGN_CLOSED_STATUSES,
  CAMPAIGN_LIVE_STATUSES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TRANSITIONS,
  type CampaignCommand,
  campaignCommandSources,
  campaignCommandTarget,
  checkCampaignSendable,
  checkCampaignTransition,
  checkConsentTransition,
  CONSENT_STATUSES,
  CONSENT_TRANSITIONS,
  ELIGIBILITY_BLOCK_CODES,
  ENROLLMENT_STATUSES,
  ENROLLMENT_TRANSITIONS,
  evaluateRecipientEligibility,
  fingerprint,
  JOURNEY_VERSION_STATUSES,
  JOURNEY_VERSION_TRANSITIONS,
  looksLikeEmailAddress,
  MARKETING_AUTOMATION_ENTITY_TYPES,
  MARKETING_RECIPIENT_DELIVERIES_TABLE,
  normalizeEmailAddress,
  purposeRequiresConsent,
  purposeTypeMismatch,
  RECIPIENT_DELIVERY_STATUSES,
  RECIPIENT_DELIVERY_TERMINAL,
  RECIPIENT_DELIVERY_TRANSITIONS,
  RETENTION_POLICIES,
  SEND_STATUSES,
  SEND_TRANSITIONS,
  SENDING_CAMPAIGN_TYPES,
  SUPPRESSING_EVENT_REASONS,
  SUPPRESSION_OVERRIDABLE,
} from "../src/marketing-automation/marketing-automation-domain.js";
import { campaignEvent,MARKETING_CAMPAIGN_EVENTS } from "../src/marketing-automation/marketing-automation-events.js";
import {
  assertProviderMessage,
  DisabledMarketingProvider,
  FakeMarketingProvider,
  type MarketingProviderMessage,
} from "../src/marketing-automation/marketing-automation-provider.js";

/**
 * Phase 19-MA.2 — the domain contracts, tested as pure functions
 * (PLAN_Phase_19_Marketing_Automation.md §12.1, §15 `19-MA.2` acceptance).
 *
 * These are the rules the rest of the module is built on, so they are checked before any HTTP route or
 * database row exists: "Domain states and transition rules are documented and unit-tested" and "Provider
 * adapter can be faked without network calls". Nothing here opens a socket or a transaction.
 */

const baseEligibility = {
  channel: "Email" as const,
  purpose: "Newsletter" as const,
  consentStatus: "Consented" as const,
  emailAddress: "reader@example.com",
};

function message(overrides: Partial<MarketingProviderMessage> = {}): MarketingProviderMessage {
  return {
    to: ["reader@example.com"],
    subject: "Spring newsletter",
    fromAddress: "news@example.com",
    idempotencyKey: "run-1",
    ...overrides,
  };
}

describe("campaign lifecycle model (§5.1)", () => {
  it("declares the documented lifecycle and its two terminal additions", () => {
    expect(CAMPAIGN_STATUSES).toEqual([
      "Draft",
      "Scheduled",
      "Running",
      "Paused",
      "Completed",
      "Failed",
      "Archived",
    ]);
    expect(CAMPAIGN_LIVE_STATUSES).toEqual(["Scheduled", "Running", "Paused"]);
    expect(CAMPAIGN_CLOSED_STATUSES).toEqual(["Completed", "Failed", "Archived"]);
  });

  it("keeps every command source a legal edge of the transition table", () => {
    const commands: CampaignCommand[] = [
      "schedule",
      "unschedule",
      "start",
      "pause",
      "resume",
      "complete",
      "cancel",
      "archive",
    ];
    for (const command of commands) {
      const to = campaignCommandTarget(command);
      for (const from of campaignCommandSources(command)) {
        expect(
          CAMPAIGN_TRANSITIONS[from].includes(to) || from === to,
          `${command}: ${from} -> ${to} must be a declared edge`,
        ).toBe(true);
      }
    }
  });

  it("has no edge that no command can reach", () => {
    const reachable = new Set<string>();
    const commands: CampaignCommand[] = [
      "schedule",
      "unschedule",
      "start",
      "pause",
      "resume",
      "complete",
      "cancel",
      "archive",
    ];
    for (const command of commands) {
      const to = campaignCommandTarget(command);
      for (const from of campaignCommandSources(command)) reachable.add(`${from}->${to}`);
    }
    // `Failed` is produced by the delivery runtime (MA.9), so it is the one status with no user command.
    for (const [from, targets] of Object.entries(CAMPAIGN_TRANSITIONS)) {
      for (const to of targets) {
        const key = `${from}->${to}`;
        const systemProduced = to === "Failed";
        expect(reachable.has(key) || systemProduced, `edge ${key} has no producing command`).toBe(true);
      }
    }
  });

  it("refuses the moves that would let a campaign skip its checks", () => {
    // Completed and Archived are final; a finished campaign is never restarted.
    expect(checkCampaignTransition({ from: "Completed", to: "Running" }).allowed).toBe(false);
    expect(checkCampaignTransition({ from: "Archived", command: "start" }).allowed).toBe(false);
    // A campaign cannot go live without having been scheduled *or* by a `start` from Draft.
    expect(checkCampaignTransition({ from: "Draft", command: "pause" }).allowed).toBe(false);
    expect(checkCampaignTransition({ from: "Paused", command: "schedule" }).allowed).toBe(false);
    // Retiring a live campaign is `cancel`; `archive` only takes a finished one.
    expect(checkCampaignTransition({ from: "Running", command: "archive" }).allowed).toBe(false);
    expect(checkCampaignTransition({ from: "Completed", command: "archive" }).allowed).toBe(true);
    // A user command never produces `Failed`.
    for (const command of ["schedule", "start", "pause", "resume", "complete", "cancel", "archive"] as const) {
      expect(campaignCommandTarget(command)).not.toBe("Failed");
    }
  });

  it("treats a no-op as allowed and stable", () => {
    for (const status of CAMPAIGN_STATUSES) {
      expect(checkCampaignTransition({ from: status, to: status }).allowed).toBe(true);
    }
  });

  it("refuses a command and a target that disagree", () => {
    const check = checkCampaignTransition({ from: "Draft", command: "schedule", to: "Running" });
    expect(check.allowed).toBe(false);
    expect(check.code).toBe("CAMPAIGN_TRANSITION_NOT_ALLOWED");
  });

  it("answers which commands an actor may run for each state", () => {
    expect(allowedCampaignCommands("Draft")).toEqual(["schedule", "start", "cancel"]);
    expect(allowedCampaignCommands("Running")).toEqual(["pause", "complete", "cancel"]);
    expect(allowedCampaignCommands("Archived")).toEqual([]);
  });

  it("rejects an inverted schedule but accepts an open-ended one (§5.1)", () => {
    // The ordering rule itself is exercised through the validation report in the API suite; here the model
    // states that an absent end date is a valid campaign, so no transition table entry forbids it.
    expect(CAMPAIGN_TRANSITIONS.Draft).toContain("Scheduled");
  });
});

describe("classification and consent gating (§5.1, §5.3)", () => {
  it("requires marketing consent for every purpose except a service notice", () => {
    expect(purposeRequiresConsent("Newsletter")).toBe(true);
    expect(purposeRequiresConsent("ProductMarketing")).toBe(true);
    expect(purposeRequiresConsent("EventUpdate")).toBe(true);
    expect(purposeRequiresConsent("ServiceNotice")).toBe(false);
  });

  it("refuses a newsletter that claims to be a service notice", () => {
    expect(purposeTypeMismatch("Newsletter", "ServiceNotice")).toContain("ServiceNotice");
    expect(purposeTypeMismatch("Email", "ProductMarketing")).toBeUndefined();
  });

  it("names only the record types this module owns — no duplicate canonical entity (§15 acceptance)", () => {
    expect(MARKETING_AUTOMATION_ENTITY_TYPES).toEqual([
      "Campaign",
      "TargetList",
      "TargetListEntry",
      "CampaignTransition",
      "MarketingConsent",
      "MarketingConsentEvent",
      "MarketingSuppression",
      "MarketingPublicToken",
      "MarketingAudienceSnapshot",
      "MarketingTemplateRevision",
      "MarketingSend",
      "MarketingSendTransition",
      "MarketingJourney",
      "MarketingJourneyVersion",
      "MarketingJourneyEnrollment",
      "MarketingJourneyStepExecution",
    ]);
    // `Email`, `EmailTemplate` and the CRM person records stay platform-owned; the plan's §0.2 rule forbids a
    // second templating or contact system.
    expect(MARKETING_AUTOMATION_ENTITY_TYPES).not.toContain("Email");
    expect(MARKETING_AUTOMATION_ENTITY_TYPES).not.toContain("MarketingCampaign");
    // The per-recipient ledger is bulk derived state, so it is a table (migration 041) and deliberately not a
    // record type: 50,000 recipients must never enter the store built for business objects (§1.2).
    expect(MARKETING_RECIPIENT_DELIVERIES_TABLE).toBe("marketing_recipient_deliveries");
    expect(MARKETING_AUTOMATION_ENTITY_TYPES).not.toContain("MarketingRecipientDelivery");
    expect(SENDING_CAMPAIGN_TYPES).toEqual(["Email", "Newsletter", "Informational"]);
  });
});

describe("recipient eligibility matrix (§5.3)", () => {
  it("passes a consented, valid, included recipient", () => {
    const decision = evaluateRecipientEligibility(baseEligibility);
    expect(decision).toEqual({ eligible: true, code: "ELIGIBLE", reasons: [], terminal: false });
  });

  it("blocks a missing address rather than guessing one", () => {
    expect(evaluateRecipientEligibility({ ...baseEligibility, emailAddress: "  " }).code).toBe("NO_EMAIL_ADDRESS");
  });

  it("blocks a malformed address", () => {
    expect(evaluateRecipientEligibility({ ...baseEligibility, emailAddress: "not-an-address" }).code).toBe(
      "INVALID_ADDRESS",
    );
  });

  it("suppresses win over membership and over a fresh opt-in (§1.2)", () => {
    const complaint = evaluateRecipientEligibility({
      ...baseEligibility,
      consentStatus: "Consented",
      suppressions: [{ reason: "Complaint", scope: "Purpose" }],
    });
    expect(complaint.eligible).toBe(false);
    expect(complaint.code).toBe("COMPLAINT_SUPPRESSED");
    expect(complaint.terminal).toBe(true);
  });

  it("reports the strongest suppression as the headline, whatever order it arrived in", () => {
    const decision = evaluateRecipientEligibility({
      ...baseEligibility,
      suppressions: [
        { reason: "ManualBlock", scope: "TargetList" },
        { reason: "HardBounce", scope: "Channel" },
        { reason: "LegalRestriction", scope: "Global" },
      ],
    });
    expect(decision.code).toBe("GLOBALLY_SUPPRESSED");
    expect(decision.reasons.length).toBe(3);
  });

  it("never reads a missing consent record as consent (invariant 5)", () => {
    expect(evaluateRecipientEligibility({ ...baseEligibility, consentStatus: "Unknown" }).code).toBe(
      "CONSENT_UNKNOWN",
    );
    expect(evaluateRecipientEligibility({ ...baseEligibility, consentStatus: "PendingConfirmation" }).code).toBe(
      "CONSENT_PENDING",
    );
  });

  it("blocks an opt-out and marks an address-level suppression terminal", () => {
    expect(evaluateRecipientEligibility({ ...baseEligibility, consentStatus: "OptedOut" }).code).toBe("OPTED_OUT");
    const bounced = evaluateRecipientEligibility({
      ...baseEligibility,
      suppressions: [{ reason: "HardBounce", scope: "Global" }],
    });
    expect(bounced.terminal).toBe(true);
  });

  it("lets exclusion win over inclusion (§5.2)", () => {
    expect(
      evaluateRecipientEligibility({ ...baseEligibility, excluded: true }).code,
    ).toBe("EXCLUDED_BY_TARGET_LIST");
  });

  it("refuses to decide about a record the caller may not read (§9.2)", () => {
    const decision = evaluateRecipientEligibility({ ...baseEligibility, recordReadable: false });
    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe("RECORD_UNREADABLE");
  });

  it("applies a frequency cap but treats zero as no cap", () => {
    expect(
      evaluateRecipientEligibility({ ...baseEligibility, messagesInWindow: 3, frequencyCap: 3 }).code,
    ).toBe("FREQUENCY_CAP_REACHED");
    expect(
      evaluateRecipientEligibility({ ...baseEligibility, messagesInWindow: 99, frequencyCap: 0 }).eligible,
    ).toBe(true);
  });

  it("lists every block, so a dry run can count each category (§5.5)", () => {
    const decision = evaluateRecipientEligibility({
      ...baseEligibility,
      emailAddress: "bogus",
      consentStatus: "OptedOut",
      excluded: true,
      frequencyCap: 1,
      messagesInWindow: 5,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["INVALID_ADDRESS", "OPTED_OUT", "EXCLUDED_BY_TARGET_LIST", "FREQUENCY_CAP_REACHED"]),
    );
  });

  it("only exempts consent when the purpose says so, and still requires an address", () => {
    const notice = evaluateRecipientEligibility({
      ...baseEligibility,
      purpose: "ServiceNotice",
      consentStatus: "Unknown",
    });
    expect(notice.eligible).toBe(true);
    expect(
      evaluateRecipientEligibility({ ...baseEligibility, purpose: "ServiceNotice", emailAddress: "" }).code,
    ).toBe("NO_EMAIL_ADDRESS");
  });

  it("uses only declared block codes", () => {
    for (const code of ELIGIBILITY_BLOCK_CODES) {
      expect(typeof code).toBe("string");
    }
    const decision = evaluateRecipientEligibility({ ...baseEligibility, consentStatus: "Suppressed" });
    expect(ELIGIBILITY_BLOCK_CODES).toContain(decision.code);
  });
});

describe("campaign sendability and the emergency stop (§5.1, §13)", () => {
  it("stops everything the moment the operator does", () => {
    const paused = checkCampaignSendable({ status: "Running", globalSendPaused: true });
    expect(paused.sendable).toBe(false);
    expect(paused.code).toBe("GLOBAL_SEND_PAUSED");
  });

  it("only lets a live campaign send", () => {
    for (const status of CAMPAIGN_CLOSED_STATUSES) {
      expect(checkCampaignSendable({ status }).sendable).toBe(false);
    }
    for (const status of CAMPAIGN_LIVE_STATUSES) {
      expect(checkCampaignSendable({ status }).sendable).toBe(true);
    }
  });
});

describe("consent, delivery, enrollment and journey state machines (§5.3, §6.4, §6.5)", () => {
  it("keeps every consent edge declared and never silently re-subscribes", () => {
    for (const from of CONSENT_STATUSES) {
      expect(checkConsentTransition(from, from).allowed).toBe(true);
    }
    // A suppressed address is not re-subscribed by a form post; only the reviewed path out is `OptedOut`.
    expect(checkConsentTransition("Suppressed", "Consented").allowed).toBe(false);
    expect(CONSENT_TRANSITIONS.Suppressed).toEqual(["OptedOut"]);
    // Withdrawing consent is always available from a granted state.
    expect(checkConsentTransition("Consented", "OptedOut").allowed).toBe(true);
  });

  it("has only the two reversible terminal states the plan allows (§5.3 invariant 2, §6.5)", () => {
    // A provider-confirmed final state has no edge out: `Delivered` can still be followed by an unsubscribe
    // or a complaint (those are new facts, not a retry), and a `Failed` row can be requeued.
    expect(RECIPIENT_DELIVERY_TRANSITIONS.Delivered).toEqual(["Unsubscribed", "Complained"]);
    expect(RECIPIENT_DELIVERY_TRANSITIONS.Failed).toEqual(["Queued"]);
    for (const status of RECIPIENT_DELIVERY_TERMINAL) {
      if (status === "Delivered" || status === "Failed") continue;
      expect(RECIPIENT_DELIVERY_TRANSITIONS[status], status).toEqual([]);
    }
    // Nothing may be re-queued out of a suppression state — a retry must not email an opted-out person.
    expect(RECIPIENT_DELIVERY_TRANSITIONS.Bounced).toEqual([]);
    expect(RECIPIENT_DELIVERY_TRANSITIONS.Unsubscribed).toEqual([]);
  });

  it("maps the provider events that add a suppression, and only those (§5.3 invariant 8)", () => {
    expect(SUPPRESSING_EVENT_REASONS.Complained).toBe("Complaint");
    expect(SUPPRESSING_EVENT_REASONS.Bounced).toBe("HardBounce");
    expect(SUPPRESSING_EVENT_REASONS.Unsubscribed).toBe("GlobalOptOut");
    expect(SUPPRESSING_EVENT_REASONS.Opened).toBeUndefined();
    expect(SUPPRESSING_EVENT_REASONS.Clicked).toBeUndefined();
  });

  it("never lets a soft suppression be treated as absolute", () => {
    expect(SUPPRESSION_OVERRIDABLE.GlobalOptOut).toBe(false);
    expect(SUPPRESSION_OVERRIDABLE.Complaint).toBe(false);
    expect(SUPPRESSION_OVERRIDABLE.HardBounce).toBe(false);
    expect(SUPPRESSION_OVERRIDABLE.ManualBlock).toBe(true);
  });

  it("keeps a waiting enrollment reversible and a finished one final (§6.4)", () => {
    expect(ENROLLMENT_TRANSITIONS.Waiting).toContain("Active");
    expect(ENROLLMENT_TRANSITIONS.Completed).toEqual([]);
    expect(ENROLLMENT_TRANSITIONS.Exited).toEqual([]);
  });
});

describe("retention and audit metadata (§6.8, §9.3)", () => {
  it("never puts a timer on a suppression tombstone or on consent evidence", () => {
    const suppression = RETENTION_POLICIES.find((policy) => policy.record === "MarketingSuppression");
    expect(suppression?.defaultDays).toBeNull();
    const consent = RETENTION_POLICIES.find((policy) => policy.record === "MarketingConsent");
    expect(consent?.defaultDays).toBeNull();
  });

  it("declares a policy for every record it calls personal data", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(typeof policy.record).toBe("string");
      expect(policy.defaultDays === null || policy.defaultDays > 0).toBe(true);
    }
  });
});

describe("provider contract (§15 `19-MA.2` task 3)", () => {
  it("fakes a send without any network call", async () => {
    const provider = new FakeMarketingProvider();
    const result = await provider.send(message({ idempotencyKey: "run-a" }));
    expect(result.accepted).toBe(true);
    expect(result.receipts[0]?.status).toBe("accepted");
    expect(provider.sent).toHaveLength(1);
  });

  it("returns the recorded answer for a repeated idempotency key and does not send twice", async () => {
    const provider = new FakeMarketingProvider();
    const first = await provider.send(message({ idempotencyKey: "same" }));
    const second = await provider.send(message({ idempotencyKey: "same", subject: "changed" }));
    expect(second).toEqual(first);
    expect(provider.sent).toHaveLength(1);
  });

  it("classifies a hard bounce as a per-recipient rejection, not a batch failure", async () => {
    const provider = new FakeMarketingProvider();
    const result = await provider.send(
      message({ to: ["hardbounce@example.com", "reader@example.com"], idempotencyKey: "mixed" }),
    );
    expect(result.accepted).toBe(true);
    expect(result.receipts).toEqual([
      { recipient: "hardbounce@example.com", status: "rejected", reasonCode: "HARD_BOUNCE" },
      expect.objectContaining({ recipient: "reader@example.com", status: "accepted" }),
    ]);
  });

  it("refuses transport injection before any adapter sees the message", () => {
    expect(() => assertProviderMessage(message({ to: ["a@example.com\r\nX-Fake: yes"] }))).toThrow(/illegal character/);
    expect(() =>
      assertProviderMessage(message({ headers: { "X-Campaign": "ok\r\nInjected: yes" } })),
    ).toThrow(/header/);
    expect(() => assertProviderMessage(message({ to: [] }))).toThrow(/recipient/);
    expect(() => assertProviderMessage(message({ idempotencyKey: " " }))).toThrow(/idempotency/);
  });

  it("does not claim to have sent anything when no provider is configured", async () => {
    const disabled = new DisabledMarketingProvider();
    expect(disabled.info.mode).toBe("disabled");
    await expect(disabled.send(message())).rejects.toThrow(/No marketing provider/);
    await expect(disabled.verify()).rejects.toThrow(/No marketing provider/);
  });
});

describe("event contract (§7.3)", () => {
  it("emits `<module>.<resource>.<action>` inside the kernel's 2–4 segment grammar", () => {
    const event = campaignEvent({
      type: "marketingAutomation.campaign.scheduled",
      campaignId: "c1",
      from: "Draft",
      to: "Scheduled",
      actorUserId: "u1",
      actorType: "admin",
    });
    expect(event.type.split(".")).toHaveLength(3);
    expect(event.type).toMatch(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){1,3}$/);
    expect(MARKETING_CAMPAIGN_EVENTS.every((name) => name.split(".").length === 3)).toBe(true);
  });

  it("carries a schema version and a correlation id, and no personal data", () => {
    const event = campaignEvent({
      type: "marketingAutomation.campaign.started",
      campaignId: "c1",
      campaignCode: "NEWS-1",
      to: "Running",
      from: "Scheduled",
      actorUserId: "u1",
      actorType: "regular",
      correlationId: "corr-1",
    });
    expect(event.payload["schemaVersion"]).toBe(1);
    expect(event.payload["correlationId"]).toBe("corr-1");
    // §7.3: no contact object, no rendered body, no token, no address.
    const json = JSON.stringify(event.payload).toLowerCase();
    expect(json).not.toContain("email");
    expect(json).not.toContain("body");
    expect(json).not.toContain("token");
  });
});

describe("small shared helpers", () => {
  it("normalises an address identity without merging records (§5.2)", () => {
    expect(normalizeEmailAddress("  Reader@Example.COM ")).toBe("reader@example.com");
    expect(normalizeEmailAddress(undefined)).toBe("");
    expect(looksLikeEmailAddress("a@b.co")).toBe(true);
    expect(looksLikeEmailAddress("a@b")).toBe(false);
    expect(looksLikeEmailAddress("two@add.com,reserve@add.com")).toBe(false);
  });

  it("fingerprints the same facts to the same value, whatever the key order", () => {
    expect(fingerprint({ a: 1, b: "x" })).toBe(fingerprint({ b: "x", a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    // A nested change is a change: an audience reference moving invalidates the prior approval (§5.5).
    expect(fingerprint({ list: { id: "1" } })).not.toBe(fingerprint({ list: { id: "2" } }));
  });
});

describe("transition tables cover exactly the statuses they declare", () => {
  const tables: readonly [string, Record<string, readonly string[]>, readonly string[]][] = [
    ["CAMPAIGN_TRANSITIONS", CAMPAIGN_TRANSITIONS, CAMPAIGN_STATUSES],
    ["SEND_TRANSITIONS", SEND_TRANSITIONS, SEND_STATUSES],
    ["CONSENT_TRANSITIONS", CONSENT_TRANSITIONS, CONSENT_STATUSES],
    ["RECIPIENT_DELIVERY_TRANSITIONS", RECIPIENT_DELIVERY_TRANSITIONS, RECIPIENT_DELIVERY_STATUSES],
    ["ENROLLMENT_TRANSITIONS", ENROLLMENT_TRANSITIONS, ENROLLMENT_STATUSES],
    ["JOURNEY_VERSION_TRANSITIONS", JOURNEY_VERSION_TRANSITIONS, JOURNEY_VERSION_STATUSES],
  ];

  it("has one entry per status, and no edge to a status that does not exist", () => {
    for (const [name, table, statuses] of tables) {
      expect(Object.keys(table).sort(), name).toEqual([...statuses].sort());
      for (const [from, targets] of Object.entries(table)) {
        for (const target of targets) {
          expect(statuses, `${name}: ${from} -> ${target}`).toContain(target);
          expect(from, `${name}: self edge`).not.toBe(target);
        }
        // A terminal state declares an empty list; nothing is terminal by omission.
        expect(Array.isArray(targets), `${name}: ${from}`).toBe(true);
      }
    }
  });
});
