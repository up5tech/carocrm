import { ValidationError } from "@carocrm/core/errors/index.js";

import {
  validateDateWindow,
  validateRatePercent,
} from "../catalog/product-rules.js";
import { parseDecimal } from "../money/decimal.js";

/**
 * Phase 19-S.5 — declarative tax rules and rates (PLAN_Phase_19_Sales.md §4.12).
 *
 * Tax selection must be deterministic and explainable, and a rule change must never alter an
 * already-issued invoice (issued documents keep their snapshot; §4.12 last bullets). Everything in
 * this file is pure: matching, priority, specificity, conflict detection and rate selection. The
 * database-backed service only loads the rows and hands them here.
 *
 * A conflicting or missing rule produces a clear error — never a silent zero tax rate. Zero tax is
 * a rate of `0` on a matching rule, which a user can see and an auditor can explain.
 */

export interface TaxRuleCriteria {
  readonly taxClassIds?: readonly string[] | undefined;
  readonly productIds?: readonly string[] | undefined;
  readonly categoryIds?: readonly string[] | undefined;
  readonly accountIds?: readonly string[] | undefined;
  readonly jurisdictions?: readonly string[] | undefined;
}

export interface TaxRuleInput {
  readonly id: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly priority: number;
  /** The tax code this rule applies; a rule without a code cannot produce a rate. */
  readonly taxCodeId: string | null;
  readonly criteria: TaxRuleCriteria;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

export interface TaxRateInput {
  readonly id: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly taxCodeId: string | null;
  /** Canonical decimal string, e.g. `"19"`, `"7.5"`, `"0"`. */
  readonly ratePercent: string;
  /** Free-form jurisdiction label the rule can match; null means "any". */
  readonly jurisdiction: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

/** What is known about a line when tax is resolved. */
export interface TaxContext {
  readonly date: string;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly accountId: string | null;
  readonly taxClassId: string | null;
  readonly jurisdiction: string | null;
}

const MAX_LIST_ENTRIES = 500;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function taxRuleIssues(input: {
  criteria: TaxRuleCriteria;
  priority: number;
  taxCodeId: string | null;
}): string[] {
  const issues: string[] = [];
  if (input.taxCodeId === null || input.taxCodeId.trim() === "") {
    issues.push("A tax rule needs a tax code.");
  }
  if (
    !Number.isInteger(input.priority) ||
    input.priority < 0 ||
    input.priority > 10_000
  ) {
    issues.push('"priority" must be an integer between 0 and 10000.');
  }
  for (const key of [
    "taxClassIds",
    "productIds",
    "categoryIds",
    "accountIds",
    "jurisdictions",
  ] as const) {
    const list = input.criteria[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_LIST_ENTRIES
    ) {
      issues.push(`"${key}" must list 1–${MAX_LIST_ENTRIES} values.`);
      continue;
    }
    if (list.some((item) => typeof item !== "string" || item.trim() === "")) {
      issues.push(`"${key}" contains an empty value.`);
    }
  }
  return issues;
}

export function validateTaxRule(input: {
  criteria: TaxRuleCriteria;
  priority: number;
  taxCodeId: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): void {
  const issues = taxRuleIssues(input);
  if (issues.length > 0)
    throw new ValidationError("Invalid tax rule.", { issues });
  validateDateWindow(input);
}

export function taxRateIssues(input: {
  ratePercent: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): string[] {
  const issues: string[] = [];
  try {
    validateRatePercent(input.ratePercent);
  } catch (error: unknown) {
    issues.push(
      error instanceof ValidationError
        ? `"ratePercent" is invalid.`
        : "ratePercent",
    );
  }
  for (const key of ["effectiveFrom", "effectiveTo"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && !DATE_ONLY.test(value))
      issues.push(`"${key}" must be a YYYY-MM-DD date.`);
  }
  if (
    input.effectiveFrom !== undefined &&
    input.effectiveTo !== undefined &&
    input.effectiveFrom !== null &&
    input.effectiveTo !== null &&
    input.effectiveFrom > input.effectiveTo
  ) {
    issues.push('"effectiveFrom" must not be after "effectiveTo".');
  }
  return issues;
}

export function validateTaxRate(input: {
  ratePercent: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): void {
  const issues = taxRateIssues(input);
  if (issues.length > 0)
    throw new ValidationError("Invalid tax rate.", { issues });
  validateDateWindow(input);
}

function withinWindow(
  from: string | null,
  to: string | null,
  date: string,
): boolean {
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

function listMatches(
  list: readonly string[] | undefined,
  value: string | null,
): boolean {
  if (list === undefined) return true;
  return value !== null && list.includes(value);
}

export function matchesTaxRule(
  rule: TaxRuleInput,
  context: TaxContext,
): boolean {
  if (!rule.active) return false;
  if (!withinWindow(rule.effectiveFrom, rule.effectiveTo, context.date))
    return false;
  const { taxClassIds, productIds, categoryIds, accountIds, jurisdictions } =
    rule.criteria;
  if (!listMatches(taxClassIds, context.taxClassId)) return false;
  if (!listMatches(productIds, context.productId)) return false;
  if (!listMatches(categoryIds, context.categoryId)) return false;
  if (!listMatches(accountIds, context.accountId)) return false;
  if (!listMatches(jurisdictions, context.jurisdiction)) return false;
  return true;
}

/** Narrower criteria win: product > category > account > tax class > jurisdiction (§4.12). */
export function taxRuleSpecificity(rule: TaxRuleInput): number {
  let score = 0;
  if (rule.criteria.productIds !== undefined) score += 16;
  if (rule.criteria.categoryIds !== undefined) score += 8;
  if (rule.criteria.accountIds !== undefined) score += 4;
  if (rule.criteria.taxClassIds !== undefined) score += 2;
  if (rule.criteria.jurisdictions !== undefined) score += 1;
  return score;
}

export interface OrderedTaxRules {
  readonly applicable: readonly TaxRuleInput[];
  /** Same priority and same specificity: an ambiguous configuration the caller must report. */
  readonly conflicts: readonly [TaxRuleInput, TaxRuleInput][];
}

/**
 * Order applicable rules: lower `priority` first, then more specific, then `id`. The first entry is
 * the winner; a conflict at the head is a configuration error rather than an arbitrary choice.
 */
export function orderTaxRules(
  rules: readonly TaxRuleInput[],
  context: TaxContext,
): OrderedTaxRules {
  const applicable = rules
    .filter((rule) => matchesTaxRule(rule, context))
    .sort((left, right) => {
      if (left.priority !== right.priority)
        return left.priority - right.priority;
      const specificity = taxRuleSpecificity(right) - taxRuleSpecificity(left);
      if (specificity !== 0) return specificity;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const conflicts: [TaxRuleInput, TaxRuleInput][] = [];
  for (let index = 1; index < applicable.length; index++) {
    const previous = applicable[index - 1];
    const current = applicable[index];
    if (previous === undefined || current === undefined) continue;
    if (
      previous.priority === current.priority &&
      taxRuleSpecificity(previous) === taxRuleSpecificity(current)
    ) {
      conflicts.push([previous, current]);
    }
  }
  return { applicable, conflicts };
}

export interface TaxRateSelection {
  readonly rate: TaxRateInput | null;
  /** Two applicable rates with the same effective date: ambiguous, reported not guessed. */
  readonly conflict: readonly [TaxRateInput, TaxRateInput] | null;
}

/**
 * Pick the rate for a tax code and context. Applicable rates are those of the code, active, inside
 * their window, and either jurisdiction-neutral or matching the context. Among them the most recent
 * `effectiveFrom` wins; a tie is a conflict (PLAN_Phase_19_Sales.md §4.12 "overlapping rules").
 */
export function selectTaxRate(
  rates: readonly TaxRateInput[],
  taxCodeId: string,
  context: TaxContext,
): TaxRateSelection {
  const applicable = rates
    .filter((rate) => rate.taxCodeId === taxCodeId && rate.active)
    .filter((rate) =>
      withinWindow(rate.effectiveFrom, rate.effectiveTo, context.date),
    )
    .filter(
      (rate) =>
        rate.jurisdiction === null ||
        rate.jurisdiction === context.jurisdiction,
    )
    .sort((left, right) => {
      const leftFrom = left.effectiveFrom ?? "";
      const rightFrom = right.effectiveFrom ?? "";
      if (leftFrom !== rightFrom) return leftFrom < rightFrom ? 1 : -1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const winner = applicable[0] ?? null;
  const runnerUp = applicable[1] ?? null;
  if (
    winner !== null &&
    runnerUp !== null &&
    (winner.effectiveFrom ?? "") === (runnerUp.effectiveFrom ?? "")
  ) {
    return { rate: winner, conflict: [winner, runnerUp] };
  }
  return { rate: winner, conflict: null };
}

/** Parse a rate that already came from a validated source; used by the totals engine. */
export function assertRatePercent(value: string): void {
  const rate = parseDecimal(value);
  validateRatePercent(value);
  if (rate.scale > 6) {
    throw new ValidationError(
      "A tax rate supports at most 6 fraction digits.",
      { ratePercent: value },
    );
  }
}
