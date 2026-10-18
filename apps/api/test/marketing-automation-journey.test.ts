import { describe, expect, it } from "vitest";

import {
  ALLOWED_JOURNEY_ACTIONS,
  ALLOWED_UPDATE_FIELDS,
} from "../src/marketing-automation/marketing-journey-action.service.js";
import { MarketingJourneyDefinitionService } from "../src/marketing-automation/marketing-journey-definition.service.js";
import {
  JOURNEY_TRIGGER_EVENTS,
  MAX_CAUSATION_DEPTH,
} from "../src/marketing-automation/marketing-journey-trigger.service.js";

/**
 * Phase 19-MA.12/MA.13 — graph validation rules the runtime relies on (§15 acceptance).
 *
 * The validator is pure (no DI), so it is constructed directly; the runtime service itself is
 * exercised through the API test suites.
 */
const service = new MarketingJourneyDefinitionService(undefined as never);

const valid = {
  start: "n1",
  nodes: [
    { id: "n1", type: "start", next: "n2" },
    { id: "n2", type: "wait", seconds: 60, next: "n3" },
    { id: "n3", type: "condition", formula: "true", then: "n4" },
    { id: "n4", type: "end" },
  ],
};

describe("journey graph validation", () => {
  it("accepts a bounded graph with a reachable terminal", () => {
    const result = service.validate(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an unknown node type (never arbitrary code)", () => {
    const result = service.validate({ start: "a", nodes: [{ id: "a", type: "exec" }] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("unsupported type");
  });

  it("rejects a graph with no terminal path", () => {
    const result = service.validate({ start: "a", nodes: [{ id: "a", type: "action", action: "send", next: "a" }] });
    expect(result.valid).toBe(false);
  });

  it("rejects a cycle", () => {
    const result = service.validate({
      start: "a",
      nodes: [
        { id: "a", type: "action", action: "x", next: "b" },
        { id: "b", type: "action", action: "y", next: "a" },
        { id: "c", type: "end" },
      ],
    });
    expect(result.errors.join(" ")).toContain("cycle");
  });

  it("hashes identically shaped graphs identically", () => {
    expect(service.hash(valid)).toBe(service.hash(valid));
  });
});

describe("journey action and trigger catalogs (MA.14)", () => {
  it("allowlists journey actions and update fields — never arbitrary code", () => {
    expect([...ALLOWED_JOURNEY_ACTIONS]).toEqual(["sendEmail", "createTask", "notify", "updateField"]);
    expect(ALLOWED_UPDATE_FIELDS["Lead"]).toContain("status");
    expect(ALLOWED_UPDATE_FIELDS["Contact"]).not.toContain("status");
    expect(Object.keys(ALLOWED_UPDATE_FIELDS)).not.toContain("User");
  });

  it("whitelists CRM trigger events and bounds causation depth", () => {
    expect(JOURNEY_TRIGGER_EVENTS).toContain("entity.created");
    expect(JOURNEY_TRIGGER_EVENTS).not.toContain("*");
    expect(MAX_CAUSATION_DEPTH).toBeGreaterThan(0);
  });
});
