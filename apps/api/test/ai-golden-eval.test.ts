import { describe, expect, it } from 'vitest';

import {
  AIAgentReportToolContribution,
  AIAgentStaleRecordsToolContribution,
} from '../src/ai-agents/ai-agent-intelligence-tools.contribution.js';
import { AIToolRegistry } from '../src/ai-agents/ai-agent-tools.js';
import {
  GOLDEN_CASES,
  GOLDEN_READ_TOOLS,
  GOLDEN_WRITE_TOOLS,
} from '../src/ai-agents/eval/ai-agent-golden-dataset.js';
import {
  goldenDatasetIssues,
  goldenRoutingCaseCount,
  runGoldenDataset,
} from '../src/ai-agents/eval/ai-agent-golden-runner.js';
import { isWriteEffect, type ToolCatalogueEntry } from '../src/ai-agents/eval/ai-agent-tool-routing.js';
import { CRMChatToolContribution } from '../src/crm-chat/crm-chat-tool-contribution.js';

/**
 * Phase 25.11 — the golden evaluation gate (plans/PLAN_Phase_25_AI_Capability_Parity.md §17).
 *
 * This suite is **DB-free and network-free** on purpose: it runs in the scheduled
 * nightly gate (`vitest.ci.config.ts`), where there is no database and no model.
 * It therefore measures the deterministic half of the contract:
 *
 *  - every golden prompt routes to the tool the dataset names, in English and in
 *    Vietnamese, with that tool's real effect class;
 *  - a read-only prompt never reaches a write tool, even when the agent holds
 *    write tools;
 *  - a **broken tool grant** is detected: the agent that no longer holds the tool
 *    its prompt needs fails its case, and the metric falls below the floor;
 *  - the dataset itself is honest: every human review names an owner and a
 *    deadline, and the advisory cases are never executed.
 *
 * The catalogue is the **live** one: the registry is built with stub services and
 * the module contributions register their tools, so a tool that disappears, is
 * renamed or changes effect class fails this suite.
 */

function buildCatalogue(): ToolCatalogueEntry[] {
  const registry = new AIToolRegistry(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  new AIAgentReportToolContribution(registry, {} as never).onModuleInit();
  new AIAgentStaleRecordsToolContribution(registry, {} as never, {} as never).onModuleInit();
  new CRMChatToolContribution(registry, {} as never).onModuleInit();
  return registry.list().map((definition) => ({
    key: definition.key,
    effectClass: definition.effectClass,
    requiresApproval: definition.requiresApproval,
  }));
}

const catalogue = buildCatalogue();

describe('the golden dataset (25.11)', () => {
  it('covers every category the plan names, in both languages', () => {
    const categories = new Set(GOLDEN_CASES.map((entry) => entry.category));
    for (const category of [
      'search',
      'summary',
      'aggregate',
      'report',
      'cross-module',
      'page-context',
      'negative',
    ]) {
      expect(categories.has(category), `category ${category}`).toBe(true);
    }
    expect(GOLDEN_CASES.some((entry) => entry.language === 'en')).toBe(true);
    expect(GOLDEN_CASES.some((entry) => entry.language === 'vi')).toBe(true);
    // Every routing case exists in both languages: the installation speaks both.
    const english = new Set(GOLDEN_CASES.filter((entry) => entry.language === 'en').map((entry) => entry.category));
    const vietnamese = new Set(GOLDEN_CASES.filter((entry) => entry.language === 'vi').map((entry) => entry.category));
    for (const category of english) {
      expect(vietnamese.has(category), `category ${category} has no Vietnamese case`).toBe(true);
    }
  });

  it('is honest about how each case is judged', () => {
    expect(goldenDatasetIssues()).toEqual([]);
    const reviews = GOLDEN_CASES.filter((entry) => entry.disposition === 'human_review');
    expect(reviews.length).toBeGreaterThan(0);
    for (const entry of reviews) {
      expect(entry.reviewOwner, entry.id).toBeTruthy();
      expect(entry.reviewDue, entry.id).toBeTruthy();
    }
    // The advisory cases stay advisory: nobody is asked to review them, and the
    // gate never runs them — a live model call would be a billable call.
    for (const entry of GOLDEN_CASES.filter((entry) => entry.disposition === 'model_review')) {
      expect(entry.reviewOwner, entry.id).toBeUndefined();
    }
  });

  it('talks only about tools the product still has', () => {
    const keys = new Set(catalogue.map((entry) => entry.key));
    for (const key of [...GOLDEN_READ_TOOLS, ...GOLDEN_WRITE_TOOLS]) {
      expect(keys.has(key), `tool ${key} is not in the catalogue`).toBe(true);
    }
    // The dataset's read/write split must match the catalogue's effect classes:
    // a tool that changed effect class would otherwise pass unnoticed.
    const byKey = new Map(catalogue.map((entry) => [entry.key, entry]));
    for (const key of GOLDEN_READ_TOOLS) {
      expect(isWriteEffect(byKey.get(key)?.effectClass ?? 'read'), `${key} is not a read tool`).toBe(false);
    }
    for (const key of GOLDEN_WRITE_TOOLS) {
      expect(isWriteEffect(byKey.get(key)?.effectClass ?? 'read'), `${key} is not a write tool`).toBe(true);
    }
  });
});

describe('tool-routing accuracy (25.11)', () => {
  it('routes every golden prompt to the tool the dataset names', () => {
    const result = runGoldenDataset(catalogue);
    const failures = result.cases.filter((entry) => entry.outcome === 'failed');
    expect(failures.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);
    expect(result.routing.total).toBe(goldenRoutingCaseCount());
    expect(result.routing.total).toBeGreaterThan(0);
    expect(result.routing.failed).toBe(0);
    expect(result.routing.accuracy).toBe(result.routing.baseline);
    expect(result.routing.ok).toBe(true);
    // The evidence snapshot: the dataset version, its hash and the measured metric, so a stored
    // result names the exact dataset that produced it.
    console.log(
      `golden dataset ${result.datasetId} v${result.datasetVersion} (${result.datasetHash}) — ` +
        `tool-routing accuracy ${String(result.routing.passed)}/${String(result.routing.total)} ` +
        `= ${result.routing.accuracy.toFixed(4)} (floor ${result.routing.threshold.toFixed(2)})`,
    );
  });

  it('never routes a read-only prompt to a write tool', () => {
    const byKey = new Map(catalogue.map((entry) => [entry.key, entry]));
    const result = runGoldenDataset(catalogue);
    for (const entry of result.cases) {
      if (entry.disposition !== 'deterministic') continue;
      const expectation = GOLDEN_CASES.find((candidate) => candidate.id === entry.id);
      if (expectation?.expectation.effect !== 'read') continue;
      const routed = entry.routedTool === null ? null : byKey.get(entry.routedTool);
      expect(routed === null || !isWriteEffect(routed.effectClass), `${entry.id} reached a write tool`).toBe(true);
    }
  });

  it('detects a deliberately broken tool grant before it reaches a release review', () => {
    const target = GOLDEN_CASES.find((entry) => entry.id === 'summary-en-1');
    expect(target).toBeDefined();
    if (target === undefined) return;
    // The agent no longer holds the tool its prompt needs.
    const broken = { ...target, grantedTools: target.grantedTools.filter((key) => key !== target.expectation.tool) };
    const result = runGoldenDataset(catalogue, [broken]);
    const caseResult = result.cases.find((entry) => entry.id === target.id);
    expect(caseResult?.outcome).toBe('failed');
    expect(caseResult?.detail).toContain('grant_missing');
    expect(result.routing.ok).toBe(false);
    expect(result.routing.accuracy).toBeLessThan(result.routing.threshold);
  });

  it('detects a tool that became a write tool', () => {
    // The same contract, seen from the catalogue side: a read tool that is
    // reclassified must not pass a read-only prompt silently.
    const tampered: ToolCatalogueEntry[] = catalogue.map((entry) =>
      entry.key === 'crm_record_summary' ? { ...entry, effectClass: 'material_write' } : entry,
    );
    const result = runGoldenDataset(tampered);
    const failures = result.cases.filter((entry) => entry.outcome === 'failed');
    expect(failures.length).toBeGreaterThan(0);
    expect(result.routing.ok).toBe(false);
    expect(failures.some((entry) => entry.detail.includes('write_on_read_prompt'))).toBe(true);
  });

  it('detects a tool that no longer exists', () => {
    const withoutSummary = catalogue.filter((entry) => entry.key !== 'crm_record_summary');
    const result = runGoldenDataset(withoutSummary);
    const failures = result.cases.filter((entry) => entry.outcome === 'failed');
    expect(failures.length).toBeGreaterThan(0);
    expect(result.routing.ok).toBe(false);
    // The dataset grants a tool that is gone, so the case cannot even be routed.
    expect(failures.some((entry) => entry.detail.includes('unknown_grant') || entry.detail.includes('unknown_tool'))).toBe(true);
  });

  it('detects a dataset case that names a tool that never existed', () => {
    const target = GOLDEN_CASES.find((entry) => entry.id === 'summary-en-1');
    expect(target).toBeDefined();
    if (target === undefined) return;
    const bogus = { ...target, expectation: { tool: 'crm_does_not_exist', effect: 'read' as const } };
    const result = runGoldenDataset(catalogue, [bogus]);
    expect(result.cases[0]?.outcome).toBe('failed');
    expect(result.cases[0]?.detail).toContain('unknown_tool');
    expect(result.routing.ok).toBe(false);
  });

  it('reports the pending reviews and the advisory cases without judging them', () => {
    const result = runGoldenDataset(catalogue);
    expect(result.pendingReviews.length).toBeGreaterThan(0);
    for (const entry of result.pendingReviews) {
      expect(entry.outcome).toBe('pending');
      expect(entry.reviewOwner).toBeTruthy();
      expect(entry.reviewDue).toBeTruthy();
    }
    expect(result.advisory.length).toBeGreaterThan(0);
    for (const entry of result.advisory) {
      expect(entry.outcome).toBe('advisory');
    }
    // A pending or advisory case never moves the metric.
    expect(result.routing.total).toBe(
      GOLDEN_CASES.filter((entry) => entry.disposition === 'deterministic').length,
    );
    expect(result.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.datasetVersion).toBe('1.0.0');
  });
});
