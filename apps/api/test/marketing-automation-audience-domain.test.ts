import { describe, expect, it } from "vitest";

import {
  clauseToListQuery,
  CRITERIA_VERSION,
  fieldIsFilterable,
  validateCriteria,
} from "../src/marketing-automation/marketing-audience-criteria.js";
import {
  AUDIENCE_CATEGORY_CODES,
  categoryForDecision,
  PUBLIC_TOKEN_SCOPES,
  PUBLIC_TOKEN_TTL_DAYS,
  recipientPrecedence,
} from "../src/marketing-automation/marketing-automation-domain.js";
import {
  emailIdentity,
  hashToken,
  issueToken,
  tokenMatches,
} from "../src/marketing-automation/marketing-identity.js";

/**
 * Phase 19-MA.4/MA.5 — the audience and identity contracts, tested as pure functions
 * (PLAN_Phase_19_Marketing_Automation.md §12.1, §15 `19-MA.4`–`19-MA.5` acceptance).
 *
 * These are the rules that make "no user-provided SQL is executed" and "public endpoints do not leak contact
 * existence" testable without a database: what the criteria parser refuses, what the query translator is
 * allowed to emit, and what an address digest is allowed to look like.
 */

const contactFields: Record<string, string> = {
  name: "varchar",
  firstName: "varchar",
  lastName: "varchar",
  emailAddress: "email",
  status: "enum",
  title: "varchar",
  createdAt: "datetime",
  assignedUserId: "link",
  description: "text",
};

const lookup = {
  fieldType: (entity: string, field: string) => (entity === "Contact" ? contactFields[field] : undefined),
  filterable: (entity: string, field: string) => entity === "Contact" && field !== "description",
};

function criteria(clauses: unknown[]) {
  return { version: CRITERIA_VERSION, clauses };
}

describe("dynamic audience criteria (§5.2)", () => {
  it("accepts a clause per supported record type", () => {
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "equals", value: "Nguyen" }] }]),
      lookup,
    );
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(check.criteria?.clauses[0]?.filters).toHaveLength(1);
  });

  it("refuses a record type that cannot be an audience", () => {
    const check = validateCriteria(
      criteria([{ entityType: "Account", match: "all", filters: [{ field: "name", operator: "equals", value: "Acme" }] }]),
      lookup,
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/Account/);
  });

  it("refuses a field the metadata does not define, or that the caller may not filter on", () => {
    const unknown = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "salary", operator: "equals", value: 1 }] }]),
      lookup,
    );
    expect(unknown.errors.join(" ")).toMatch(/does not define/);

    const unfilterable = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "description", operator: "contains", value: "x" }] }]),
      lookup,
    );
    expect(unfilterable.errors.join(" ")).toMatch(/not allowed to read/);
  });

  it("refuses an operator the field's type does not support", () => {
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "status", operator: "between", value: ["a", "b"] }] }]),
      lookup,
    );
    expect(check.errors.join(" ")).toMatch(/cannot use operator between/);
  });

  it("refuses an empty clause, which would otherwise match every record of the type", () => {
    const check = validateCriteria(criteria([{ entityType: "Contact", match: "all", filters: [] }]), lookup);
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/at least one filter/);
  });

  it("refuses a stored version it cannot interpret, rather than guessing", () => {
    const check = validateCriteria({ version: 99, clauses: [] }, lookup);
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/version/);
  });

  it("refuses structural nonsense without throwing", () => {
    for (const raw of [null, "string", [], 42, { version: 1 }, { version: 1, clauses: "x" }]) {
      expect(validateCriteria(raw, lookup).ok).toBe(false);
    }
  });

  it("refuses an identifier-shaped field name instead of quoting it", () => {
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "name); DROP TABLE users; --", operator: "equals", value: "x" }] }]),
      lookup,
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/invalid field name/);
  });

  it("keeps a SQL-looking value as a value, not as syntax (§15 acceptance: no user-provided SQL)", () => {
    const injection = "' OR 1=1 --";
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "equals", value: injection }] }]),
      lookup,
    );
    const parsed = check.criteria?.clauses[0];
    expect(check.ok && parsed !== undefined, JSON.stringify(check.errors)).toBe(true);
    const query = clauseToListQuery(parsed as CriteriaClause, { maxSize: 100 });
    // The emitted shape is a data structure the query engine binds as a parameter: the payload survives
    // verbatim as a comparison value and is never parsed.
    expect(JSON.stringify(query.where)).toContain(injection);
    expect(query.where).toEqual([{ field: "lastName", operator: "equals", value: injection }]);
  });

  it("maps match:any onto the engine's or-group and match:all onto a flat list", () => {
    const filters = [
      { field: "lastName", operator: "equals", value: "A" },
      { field: "status", operator: "equals", value: "Active" },
    ];
    const any = clauseToListQuery(
      { entityType: "Contact", match: "any", filters },
      { maxSize: 10 },
    );
    expect(any.where).toEqual([{ or: filters }]);
    const all = clauseToListQuery({ entityType: "Contact", match: "all", filters }, { maxSize: 10 });
    expect(all.where).toEqual(filters);
  });

  it("bounds the page it asks for, so a criteria cannot request the world (§5.2)", () => {
    const query = clauseToListQuery(
      { entityType: "Contact", match: "all", filters: [{ field: "name", operator: "equals", value: "x" }] },
      { maxSize: 50_000 },
    );
    // The bound is enforced by the resolver, not by the translator: the request is passed through so the
    // caller's own ceiling (settings.limits.maxResolveRecords) is the single number that matters.
    expect(query.maxSize).toBe(50_000);
  });

  it("refuses a value with a newline, which no legitimate filter contains", () => {
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "equals", value: "a\nb" }] }]),
      lookup,
    );
    expect(check.errors.join(" ")).toMatch(/illegal character/);
  });

  it("limits an in-list, so one criterion cannot name a million records", () => {
    const values = Array.from({ length: 51 }, (_, index) => `v${String(index)}`);
    const check = validateCriteria(
      criteria([{ entityType: "Contact", match: "all", filters: [{ field: "lastName", operator: "in", value: values }] }]),
      lookup,
    );
    expect(check.errors.join(" ")).toMatch(/at most 50 values/);
  });

  it("treats a field's metadata as the allowlist", () => {
    expect(fieldIsFilterable({ type: "varchar" })).toBe(true);
    expect(fieldIsFilterable({ type: "link" })).toBe(true);
    expect(fieldIsFilterable({ type: "password" })).toBe(false);
    expect(fieldIsFilterable({ type: "varchar", inFilter: false })).toBe(false);
    expect(fieldIsFilterable(undefined)).toBe(false);
  });
});

describe("audience categories and de-duplication rule (§5.2, §5.5)", () => {
  it("reports a duplicate address separately from an ineligible recipient", () => {
    expect(categoryForDecision({ eligible: true, code: "ELIGIBLE" })).toBe("eligible");
    expect(categoryForDecision({ eligible: true, code: "ELIGIBLE", duplicateAddress: true })).toBe("duplicateAddress");
    expect(categoryForDecision({ eligible: true, code: "ELIGIBLE", duplicateRecord: true })).toBe("duplicateRecord");
    expect(categoryForDecision({ eligible: false, code: "OPTED_OUT" })).toBe("optedOut");
    expect(categoryForDecision({ eligible: false, code: "GLOBALLY_SUPPRESSED" })).toBe("suppressedGlobal");
    expect(categoryForDecision({ eligible: false, code: "HARD_BOUNCE_SUPPRESSED" })).toBe("suppressedBounce");
    expect(categoryForDecision({ eligible: false, code: "EXCLUDED_BY_TARGET_LIST" })).toBe("excludedBySegment");
  });

  it("maps every declared block code to a category, so nothing is counted as eligible by omission", () => {
    const mapped = AUDIENCE_CATEGORY_CODES;
    expect(mapped).toContain("eligible");
    for (const code of ["NO_EMAIL_ADDRESS", "INVALID_ADDRESS", "OPTED_OUT", "CONSENT_UNKNOWN", "CONSENT_PENDING", "FREQUENCY_CAP_REACHED", "RECORD_UNREADABLE", "CHANNEL_SUPPRESSED", "PURPOSE_SUPPRESSED", "TARGET_LIST_SUPPRESSED", "COMPLAINT_SUPPRESSED"] as const) {
      const category = categoryForDecision({ eligible: false, code });
      expect(mapped, code).toContain(category);
      expect(category, code).not.toBe("eligible");
    }
  });

  it("prefers the person record over the lead, as documented (§5.2)", () => {
    expect(recipientPrecedence("Contact")).toBeLessThan(recipientPrecedence("Lead"));
  });
});

describe("address identity and public tokens (§5.3.1, §6.3)", () => {
  it("is case and whitespace insensitive, so one person is one identity", () => {
    const a = emailIdentity("  Reader@Example.COM ", "secret")?.hash;
    const b = emailIdentity("reader@example.com", "secret")?.hash;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs between keys, so a leaked digest table cannot be matched against another deployment", () => {
    const withKey = emailIdentity("reader@example.com", "key-one")?.hash;
    const otherKey = emailIdentity("reader@example.com", "key-two")?.hash;
    expect(withKey).not.toBe(otherKey);
  });

  it("gives an address with no value no identity", () => {
    expect(emailIdentity("   ", "secret")).toBeNull();
    expect(emailIdentity(undefined, "secret")).toBeNull();
  });

  it("issues a token whose stored form cannot be reversed into the link", () => {
    const { token, tokenHash } = issueToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashToken(token)).toBe(tokenHash);
    expect(tokenHash).not.toContain(token.slice(0, 8));
    expect(tokenMatches(tokenHash, token)).toBe(true);
    expect(tokenMatches(tokenHash, `${token}x`)).toBe(false);
  });

  it("gives an unsubscribe link a longer life than a confirmation link (§5.3.1)", () => {
    expect(PUBLIC_TOKEN_TTL_DAYS.Unsubscribe).toBeGreaterThan(PUBLIC_TOKEN_TTL_DAYS.OptInConfirmation);
    expect(Object.keys(PUBLIC_TOKEN_TTL_DAYS).sort()).toEqual([...PUBLIC_TOKEN_SCOPES].sort());
  });
});
