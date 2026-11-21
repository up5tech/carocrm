/**
 * Phase 25.11 — the golden runner and the tool-routing metric
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §17 task 3).
 *
 * ## The metric
 *
 * **Tool-routing accuracy** is the share of deterministic golden cases whose
 * prompt reaches the tool the dataset says it must reach — with that tool's real
 * effect class, and with only the granted tools in reach.
 *
 * The baseline was measured when the dataset was written; the threshold may only
 * go up from there, so a suite that loses accuracy fails the nightly gate even
 * though the gate itself is only scheduled (G78 stays: this is a check inside the
 * existing gate, not a second runner or a second CI provider).
 *
 * ## What a failure means
 *
 * The runner names the reason, because "accuracy dropped" is not actionable:
 *
 *  - `unknown_tool` — the dataset names a tool the product no longer has;
 *  - `unknown_grant` — the dataset grants a tool the product no longer has;
 *  - `grant_missing` — the agent does not hold the tool the prompt needs: the
 *    deliberately broken grant, and the reason the gate exists;
 *  - `effect_changed` — a tool changed effect class (a read tool that became a
 *    write, or the other way round);
 *  - `read_grant_violation` — a case that says "this agent may only read" holds
 *    a write tool;
 *  - `misrouted` — the prompt reached another tool, or none, or an ambiguous tie;
 *  - `write_on_read_prompt` — the special case the plan calls out: a read-only
 *    prompt reached a write tool.
 */

import { createHash } from 'node:crypto';

import {
  deterministicGoldenCases,
  GOLDEN_CASES,
  GOLDEN_DATASET_ID,
  GOLDEN_DATASET_VERSION,
  type GoldenCase,
  type GoldenDisposition,
  type GoldenLanguage,
} from './ai-agent-golden-dataset.js';
import { isWriteEffect, routeTool, type ToolCatalogueEntry } from './ai-agent-tool-routing.js';

/**
 * The measured accuracy when the dataset was written, and the floor the gate
 * enforces. The floor may only rise: a suite that loses accuracy is a
 * regression, not a new baseline.
 */
export const GOLDEN_ROUTING_BASELINE = 1;

/** The floor the gate enforces today. */
export const GOLDEN_ROUTING_THRESHOLD = GOLDEN_ROUTING_BASELINE;

/** What the runner decided about one case. */
export type GoldenOutcome = 'passed' | 'failed' | 'pending' | 'advisory';

export interface GoldenCaseResult {
  readonly id: string;
  readonly category: string;
  readonly language: GoldenLanguage;
  readonly disposition: GoldenDisposition;
  readonly outcome: GoldenOutcome;
  /** The tool the prompt actually routed to; `null` when nothing matched. */
  readonly routedTool: string | null;
  /** Why the case failed, or what a reviewer has to check. */
  readonly detail: string;
  /** The owner and deadline of a case a person has to judge. */
  readonly reviewOwner?: string;
  readonly reviewDue?: string;
}

export interface GoldenRoutingMetric {
  /** The deterministic cases — the denominator of the metric. */
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** The measured accuracy, 0 when there is no deterministic case at all. */
  readonly accuracy: number;
  /** The floor the gate enforces. */
  readonly threshold: number;
  /** The baseline the threshold was derived from. */
  readonly baseline: number;
  /** Whether the metric holds. */
  readonly ok: boolean;
}

export interface GoldenRunResult {
  readonly datasetId: string;
  readonly datasetVersion: string;
  /** A hash of the cases, so an evidence document can pin the exact dataset. */
  readonly datasetHash: string;
  readonly cases: readonly GoldenCaseResult[];
  readonly routing: GoldenRoutingMetric;
  /** The cases a person has to judge, with their owner and deadline. */
  readonly pendingReviews: readonly GoldenCaseResult[];
  /** The advisory cases. They are reported and never executed. */
  readonly advisory: readonly GoldenCaseResult[];
}

/** Run the dataset against a catalogue. */
export function runGoldenDataset(
  catalogue: readonly ToolCatalogueEntry[],
  cases: readonly GoldenCase[] = GOLDEN_CASES,
): GoldenRunResult {
  const byKey = new Map(catalogue.map((entry) => [entry.key, entry]));
  const results: GoldenCaseResult[] = cases.map((entry) => judgeCase(entry, byKey));
  const deterministic = results.filter((result) => result.disposition === 'deterministic');
  const passed = deterministic.filter((result) => result.outcome === 'passed').length;
  const accuracy = deterministic.length === 0 ? 0 : passed / deterministic.length;
  return {
    datasetId: GOLDEN_DATASET_ID,
    datasetVersion: GOLDEN_DATASET_VERSION,
    datasetHash: goldenDatasetHash(cases),
    cases: results,
    routing: {
      total: deterministic.length,
      passed,
      failed: deterministic.length - passed,
      accuracy,
      threshold: GOLDEN_ROUTING_THRESHOLD,
      baseline: GOLDEN_ROUTING_BASELINE,
      ok: deterministic.length > 0 && accuracy >= GOLDEN_ROUTING_THRESHOLD,
    },
    pendingReviews: results.filter((result) => result.disposition === 'human_review'),
    advisory: results.filter((result) => result.disposition === 'model_review'),
  };
}

/**
 * Judge one case.
 *
 * A `human_review` case is **pending** and a `model_review` case is
 * **advisory**: neither is judged here, and neither can move the metric. The
 * metric counts the deterministic cases only, so a case that needs a person can
 * never make the suite look better or worse than it is.
 */
function judgeCase(entry: GoldenCase, catalogue: ReadonlyMap<string, ToolCatalogueEntry>): GoldenCaseResult {
  const base = {
    id: entry.id,
    category: entry.category,
    language: entry.language,
    disposition: entry.disposition,
  };
  if (entry.disposition === 'human_review') {
    return {
      ...base,
      outcome: 'pending',
      routedTool: null,
      detail: entry.rationale,
      ...(entry.reviewOwner === undefined ? {} : { reviewOwner: entry.reviewOwner }),
      ...(entry.reviewDue === undefined ? {} : { reviewDue: entry.reviewDue }),
    };
  }
  if (entry.disposition === 'model_review') {
    return { ...base, outcome: 'advisory', routedTool: null, detail: entry.rationale };
  }

  const routing = routeTool(entry.prompt, entry.grantedTools);

  // The dataset must talk about tools the product still has.
  const unknownGrant = entry.grantedTools.find((key) => !catalogue.has(key));
  if (unknownGrant !== undefined) {
    return fail(base, routing.toolKey, `unknown_grant: the granted tool "${unknownGrant}" is not in the catalogue.`);
  }
  const expected = entry.expectation.tool;
  if (expected !== null && !catalogue.has(expected)) {
    return fail(base, routing.toolKey, `unknown_tool: the expected tool "${expected}" is not in the catalogue.`);
  }

  // The agent must actually hold the tool the prompt needs.
  if (expected !== null && !entry.grantedTools.includes(expected)) {
    return fail(base, routing.toolKey, `grant_missing: the agent does not hold "${expected}".`);
  }

  // A case that says "read only" must hold read tools only.
  if (entry.grantsAreReadOnly) {
    const writeGrant = entry.grantedTools.find((key) => isWriteEffect(catalogue.get(key)?.effectClass ?? 'read'));
    if (writeGrant !== undefined) {
      return fail(base, routing.toolKey, `read_grant_violation: "${writeGrant}" is granted to a read-only case.`);
    }
  }

  // The tool the prompt reaches must be the one the dataset names.
  if (expected !== null && routing.toolKey !== expected) {
    const reason = routing.ambiguous
      ? 'misrouted: the prompt matched several tools.'
      : `misrouted: the prompt reached "${routing.toolKey ?? 'no tool'}" instead of "${expected}".`;
    return fail(base, routing.toolKey, reason);
  }

  // And it must have the effect class the dataset expects.
  if (expected !== null) {
    const effect = catalogue.get(expected)?.effectClass ?? 'read';
    const expectedEffect = entry.expectation.effect;
    if (expectedEffect === 'read' && isWriteEffect(effect)) {
      return fail(base, routing.toolKey, `write_on_read_prompt: "${expected}" is now a ${effect} tool.`);
    }
    if (expectedEffect === 'write' && !isWriteEffect(effect)) {
      return fail(base, routing.toolKey, `effect_changed: "${expected}" is a ${effect} tool and no longer writes.`);
    }
  }
  if (entry.expectation.effect === 'none' && routing.toolKey !== null) {
    const routed = catalogue.get(routing.toolKey);
    return fail(
      base,
      routing.toolKey,
      routed !== undefined && isWriteEffect(routed.effectClass)
        ? `write_on_read_prompt: the prompt reached the write tool "${routing.toolKey}".`
        : `misrouted: the prompt reached "${routing.toolKey}" and no tool may serve it.`,
    );
  }

  return { ...base, outcome: 'passed', routedTool: routing.toolKey, detail: 'routed as expected.' };
}

function fail(
  base: { id: string; category: string; language: GoldenLanguage; disposition: GoldenDisposition },
  routedTool: string | null,
  detail: string,
): GoldenCaseResult {
  return { ...base, outcome: 'failed', routedTool, detail };
}

/**
 * The integrity of the dataset itself.
 *
 * A review without an owner is a backlog nobody reads, so a `human_review` case
 * without an owner or a deadline is a defect of the dataset, not of the product.
 */
export function goldenDatasetIssues(cases: readonly GoldenCase[] = GOLDEN_CASES): readonly string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.id)) issues.push(`duplicate case id "${entry.id}".`);
    seen.add(entry.id);
    if (entry.prompt.trim() === '') issues.push(`case "${entry.id}" has no prompt.`);
    if (entry.disposition === 'human_review') {
      if (entry.reviewOwner === undefined || entry.reviewOwner.trim() === '') {
        issues.push(`case "${entry.id}" is a human review without an owner.`);
      }
      if (entry.reviewDue === undefined || entry.reviewDue.trim() === '') {
        issues.push(`case "${entry.id}" is a human review without a deadline.`);
      }
    }
    if (entry.disposition === 'model_review' && entry.reviewOwner !== undefined) {
      issues.push(`case "${entry.id}" is advisory and must not name a review owner.`);
    }
    if (entry.disposition === 'deterministic' && entry.expectation.tool === null && entry.expectation.effect !== 'none') {
      issues.push(`case "${entry.id}" expects no tool but declares the effect "${entry.expectation.effect}".`);
    }
  }
  return issues;
}

/**
 * A hash of the cases, so an evidence document can name the exact dataset that
 * produced a number.
 */
export function goldenDatasetHash(cases: readonly GoldenCase[] = GOLDEN_CASES): string {
  const canonical = JSON.stringify(
    cases.map((entry) => ({
      id: entry.id,
      category: entry.category,
      language: entry.language,
      prompt: entry.prompt,
      disposition: entry.disposition,
      expectation: entry.expectation,
      grantedTools: entry.grantedTools,
      reviewOwner: entry.reviewOwner ?? null,
      reviewDue: entry.reviewDue ?? null,
    })),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** The number of deterministic cases — the metric's denominator. */
export function goldenRoutingCaseCount(cases: readonly GoldenCase[] = GOLDEN_CASES): number {
  return deterministicGoldenCases(cases).length;
}
