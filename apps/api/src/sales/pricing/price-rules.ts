import { ValidationError } from "@carocrm/core/errors/index.js";

import { validateDateWindow } from "../catalog/product-rules.js";
import type { Money } from "../money/currency.js";
import { moneyDecimal } from "../money/currency.js";
import type { Decimal, RoundingMode } from "../money/decimal.js";
import {
  compare,
  divideTo,
  format,
  isNegative,
  multiply,
  parseDecimal,
  rescale,
  subtract,
} from "../money/decimal.js";

/**
 * Phase 19-S.4 — declarative price rules (PLAN_Phase_19_Sales.md §4.3).
 *
 * A price rule is **data**: a list of matching criteria and one of three named actions. There is no
 * SQL, no JavaScript, no formula string — an administrator cannot make the server execute arbitrary
 * code through pricing (plan §2.2, AGENTS.md §5.3). Matching and ordering are pure functions so the
 * "why did this price win" answer is reproducible and testable.
 */

export interface PriceRuleCriteria {
  readonly productIds?: readonly string[] | undefined;
  readonly categoryIds?: readonly string[] | undefined;
  readonly accountIds?: readonly string[] | undefined;
  /** Quantity break lower bound (inclusive), canonical decimal string. */
  readonly minQuantity?: string | undefined;
  /** Quantity break upper bound (exclusive), canonical decimal string. */
  readonly maxQuantity?: string | undefined;
}

export type PriceRuleAction =
  | { readonly type: "percentAdjustment"; readonly percent: string }
  | { readonly type: "fixedAdjustment"; readonly amount: string }
  | { readonly type: "setPrice"; readonly amount: string };

export const PRICE_RULE_ACTIONS = [
  "percentAdjustment",
  "fixedAdjustment",
  "setPrice",
] as const;

export interface PriceRuleInput {
  readonly id: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly priority: number;
  readonly criteria: PriceRuleCriteria;
  readonly action: PriceRuleAction;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

export interface PriceRuleContext {
  readonly productId: string;
  readonly categoryId: string | null;
  readonly accountId: string | null;
  readonly quantity: string;
  /** Document date, `YYYY-MM-DD`; windows are inclusive at both ends. */
  readonly date: string;
}

const MAX_LIST_ENTRIES = 500;

/** Validation issues as data, so the same list feeds a 422 response and the admin rule form. */
export function priceRuleIssues(input: {
  criteria: PriceRuleCriteria;
  action: PriceRuleAction;
}): string[] {
  const issues: string[] = [];
  for (const key of ["productIds", "categoryIds", "accountIds"] as const) {
    const list = input.criteria[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_LIST_ENTRIES
    ) {
      issues.push(`"${key}" must list 1–${MAX_LIST_ENTRIES} record ids.`);
      continue;
    }
    if (list.some((item) => typeof item !== "string" || item.trim() === "")) {
      issues.push(`"${key}" contains an empty id.`);
    }
  }
  for (const key of ["minQuantity", "maxQuantity"] as const) {
    const value = input.criteria[key];
    if (value === undefined) continue;
    try {
      const parsed = parseDecimal(value);
      if (
        isNegative(parsed) ||
        (compare(parsed, parseDecimal("0")) === 0 && key === "minQuantity")
      ) {
        issues.push(`"${key}" must be a positive decimal.`);
      }
    } catch {
      issues.push(`"${key}" must be a canonical decimal string.`);
    }
  }
  const min = input.criteria.minQuantity;
  const max = input.criteria.maxQuantity;
  if (min !== undefined && max !== undefined) {
    try {
      if (compare(parseDecimal(min), parseDecimal(max)) >= 0)
        issues.push('"minQuantity" must be less than "maxQuantity".');
    } catch {
      // Individually invalid values are already reported above.
    }
  }
  // A rule with no criteria is *book-wide*: it applies to every product the price book resolves
  // (PLAN_Phase_19_Sales.md §4.3 lists criteria as supported conditions, not a requirement).
  switch (input.action.type) {
    case "percentAdjustment": {
      try {
        const percent = parseDecimal(input.action.percent);
        if (isNegative(percent) || compare(percent, parseDecimal("100")) > 0)
          issues.push('"percent" must be between 0 and 100.');
      } catch {
        issues.push('"percent" must be a canonical decimal string.');
      }
      break;
    }
    case "fixedAdjustment":
    case "setPrice": {
      try {
        const amount = parseDecimal(input.action.amount);
        if (isNegative(amount)) issues.push('"amount" must not be negative.');
      } catch {
        issues.push('"amount" must be a canonical decimal string.');
      }
      break;
    }
    default: {
      issues.push(
        `Unknown action "${String((input.action as { type?: unknown }).type)}".`,
      );
    }
  }
  return issues;
}

export function validatePriceRule(input: {
  criteria: PriceRuleCriteria;
  action: PriceRuleAction;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): void {
  const issues = priceRuleIssues(input);
  if (issues.length > 0)
    throw new ValidationError("Invalid price rule.", { issues });
  validateDateWindow(input);
}

function withinWindow(
  effectiveFrom: string | null,
  effectiveTo: string | null,
  date: string,
): boolean {
  if (effectiveFrom !== null && date < effectiveFrom) return false;
  if (effectiveTo !== null && date > effectiveTo) return false;
  return true;
}

export function matchesPriceRule(
  rule: PriceRuleInput,
  context: PriceRuleContext,
): boolean {
  if (!rule.active) return false;
  if (!withinWindow(rule.effectiveFrom, rule.effectiveTo, context.date))
    return false;
  const { productIds, categoryIds, accountIds, minQuantity, maxQuantity } =
    rule.criteria;
  if (productIds !== undefined && !productIds.includes(context.productId))
    return false;
  if (
    categoryIds !== undefined &&
    (context.categoryId === null || !categoryIds.includes(context.categoryId))
  )
    return false;
  if (
    accountIds !== undefined &&
    (context.accountId === null || !accountIds.includes(context.accountId))
  )
    return false;
  if (
    minQuantity !== undefined &&
    compare(parseDecimal(context.quantity), parseDecimal(minQuantity)) < 0
  )
    return false;
  if (
    maxQuantity !== undefined &&
    compare(parseDecimal(context.quantity), parseDecimal(maxQuantity)) >= 0
  )
    return false;
  return true;
}

/**
 * How narrow a rule is: a product-scoped rule outranks a category-scoped one, which outranks an
 * account-only one. The count is deliberately simple — documented in `docs/modules/sales/
 * product-catalog-and-pricing.md` — because a tie-break nobody can explain is worse than a rule.
 */
export function priceRuleSpecificity(rule: PriceRuleInput): number {
  let score = 0;
  if (rule.criteria.productIds !== undefined) score += 8;
  if (rule.criteria.categoryIds !== undefined) score += 4;
  if (rule.criteria.accountIds !== undefined) score += 2;
  if (
    rule.criteria.minQuantity !== undefined ||
    rule.criteria.maxQuantity !== undefined
  )
    score += 1;
  return score;
}

export interface OrderedPriceRules {
  readonly applicable: readonly PriceRuleInput[];
  /** Rules that matched with the same priority *and* the same specificity — the winner is `id`-ordered but reported. */
  readonly ties: readonly [PriceRuleInput, PriceRuleInput][];
}

/**
 * Deterministic rule ordering (PLAN_Phase_19_Sales.md §4.3): lower `priority` first, then narrower
 * `specificity`, then `id` ascending. Applicable rules are never ordered by database row order.
 */
export function orderPriceRules(
  rules: readonly PriceRuleInput[],
  context: PriceRuleContext,
): OrderedPriceRules {
  const applicable = rules.filter((rule) => matchesPriceRule(rule, context));
  const ordered = [...applicable].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    const specificity =
      priceRuleSpecificity(right) - priceRuleSpecificity(left);
    if (specificity !== 0) return specificity;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const ties: [PriceRuleInput, PriceRuleInput][] = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    if (
      previous.priority === current.priority &&
      priceRuleSpecificity(previous) === priceRuleSpecificity(current)
    ) {
      ties.push([previous, current]);
    }
  }
  return { applicable: ordered, ties };
}

/**
 * Apply an action to a base amount, rounded once to the currency scale.
 *
 * A `fixedAdjustment` cannot drive the price below zero — that is a rule configuration error, not a
 * free product, so it is refused instead of clamped.
 */
export function applyPriceRuleAction(
  base: Money,
  action: PriceRuleAction,
  mode: RoundingMode = "half-up",
): Money {
  const scale = base.scale;
  const baseValue: Decimal = moneyDecimal(base);
  switch (action.type) {
    case "percentAdjustment": {
      // (base × (100 − percent)) / 100, rounded exactly once at the currency scale.
      const remaining = subtract(
        parseDecimal("100"),
        parseDecimal(action.percent),
      );
      const exact = multiply(baseValue, remaining);
      const adjusted = divideTo(exact, parseDecimal("100"), scale, mode);
      return {
        amount: format(adjusted, scale),
        currency: base.currency,
        scale,
      };
    }
    case "fixedAdjustment": {
      const adjusted = rescale(
        subtract(baseValue, parseDecimal(action.amount)),
        scale,
        mode,
      );
      if (isNegative(adjusted)) {
        throw new ValidationError(
          "A fixed price adjustment would make the price negative.",
          { base: base.amount, adjustment: action.amount },
        );
      }
      return {
        amount: format(adjusted, scale),
        currency: base.currency,
        scale,
      };
    }
    case "setPrice": {
      const resolved = rescale(parseDecimal(action.amount), scale, mode);
      if (isNegative(resolved)) {
        throw new ValidationError("A price cannot be negative.", {
          amount: action.amount,
        });
      }
      return {
        amount: format(resolved, scale),
        currency: base.currency,
        scale,
      };
    }
    default: {
      throw new ValidationError(
        `Unknown price action "${String((action as { type?: unknown }).type)}".`,
      );
    }
  }
}
