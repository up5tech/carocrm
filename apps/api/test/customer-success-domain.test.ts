import { describe, expect, it } from 'vitest';

import {
  checkLifecycleTransition,
  checkRiskTransition,
  classifyHealth,
  computeGoalProgress,
  computeHealthScore,
  DEFAULT_HEALTH_THRESHOLDS,
  goalIsOverdue,
  healthTrend,
  isMeaningfulTouch,
  lastMeaningfulTouchAt,
  readyPlaybookSteps,
  renewalWindow,
  riskComponentScore,
  riskRequiresMitigation,
  validateHealthThresholds,
  validatePlaybookSteps,
} from '../src/customer-success/customer-success-domain.js';
import { type HealthFacts, SupportSignalProvider } from '../src/customer-success/customer-success-signals.js';

/**
 * Phase 19-CS unit tests (PLAN_Phase_19_Customer_Success.md §15.1).
 *
 * The health engine, lifecycle policy, goal progress, risk rules, playbook validation, renewal
 * windows and meaningful-touch qualification are pure functions, so they are exercised here without a
 * database. This is the lowest-cost test that proves the module's core behaviour (§19 "choose the
 * lowest-cost test that verifies the behaviour").
 */

describe('health scoring (§5.4)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('computes a deterministic weighted score and status', () => {
    const result = computeHealthScore({
      signals: [
        { key: 'engagement', weight: 50, applicability: 'applicable', score: 100 },
        { key: 'risks', weight: 50, applicability: 'applicable', score: 70 },
      ],
      now,
    });
    expect(result.score).toBe(85);
    expect(result.status).toBe('healthy');
    expect(result.coverage).toBe(1);
  });

  it('never scores a missing signal as zero — it excludes and renormalizes', () => {
    const result = computeHealthScore({
      signals: [
        { key: 'engagement', weight: 80, applicability: 'applicable', score: 90 },
        { key: 'renewal', weight: 20, applicability: 'missing', score: null },
      ],
      minimumCoverage: 0.5,
      now,
    });
    // Only the applicable signal contributes, so the score is its own value, not 90*0.8.
    expect(result.score).toBe(90);
    expect(result.coverage).toBeCloseTo(0.8, 5);
    expect(result.status).toBe('healthy');
  });

  it('returns unknown (never zero) when coverage is below the minimum', () => {
    const result = computeHealthScore({
      signals: [
        { key: 'engagement', weight: 20, applicability: 'applicable', score: 10 },
        { key: 'renewal', weight: 80, applicability: 'missing', score: null },
      ],
      minimumCoverage: 0.5,
      now,
    });
    expect(result.score).toBeNull();
    expect(result.status).toBe('unknown');
  });

  it('honours the unknownWhenIncomplete policy on any missing signal', () => {
    const result = computeHealthScore({
      signals: [
        { key: 'engagement', weight: 90, applicability: 'applicable', score: 90 },
        { key: 'risks', weight: 10, applicability: 'failed', score: null },
      ],
      minimumCoverage: 0.5,
      missingDataPolicy: 'unknownWhenIncomplete',
      now,
    });
    expect(result.score).toBeNull();
    expect(result.status).toBe('unknown');
  });

  it('treats a signal measured outside its freshness window as stale', () => {
    const result = computeHealthScore({
      signals: [
        {
          key: 'engagement',
          weight: 100,
          applicability: 'applicable',
          score: 95,
          measuredAt: '2020-01-01T00:00:00.000Z',
          freshnessWindowMs: 30 * 86_400_000,
        },
      ],
      minimumCoverage: 0.5,
      now,
    });
    expect(result.components[0]?.applicability).toBe('stale');
    expect(result.score).toBeNull();
    expect(result.status).toBe('unknown');
  });

  it('applies the configured rounding policy', () => {
    const signals = [
      { key: 'a', weight: 1, applicability: 'applicable' as const, score: 10 },
      { key: 'b', weight: 2, applicability: 'applicable' as const, score: 11 },
    ];
    // (10*1 + 11*2) / 3 = 10.666…
    expect(computeHealthScore({ signals, rounding: 'round', now }).score).toBe(11);
    expect(computeHealthScore({ signals, rounding: 'floor', now }).score).toBe(10);
    expect(computeHealthScore({ signals, rounding: 'ceil', now }).score).toBe(11);
  });

  it('classifies threshold boundaries inclusively', () => {
    expect(classifyHealth(100)).toBe('healthy');
    expect(classifyHealth(80)).toBe('healthy');
    expect(classifyHealth(79)).toBe('monitor');
    expect(classifyHealth(60)).toBe('monitor');
    expect(classifyHealth(59)).toBe('atRisk');
    expect(classifyHealth(40)).toBe('atRisk');
    expect(classifyHealth(39)).toBe('critical');
    expect(classifyHealth(0)).toBe('critical');
    expect(classifyHealth(null)).toBe('unknown');
  });

  it('accepts the default thresholds and rejects gaps or duplicates', () => {
    expect(validateHealthThresholds(DEFAULT_HEALTH_THRESHOLDS)).toEqual([]);
    expect(
      validateHealthThresholds([
        { status: 'critical', min: 0, max: 30 },
        { status: 'healthy', min: 50, max: 100 },
      ]).length,
    ).toBeGreaterThan(0);
    expect(
      validateHealthThresholds([
        { status: 'critical', min: 0, max: 50 },
        { status: 'healthy', min: 40, max: 100 },
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe('lifecycle transitions (§5.3)', () => {
  it('allows a configured edge', () => {
    expect(checkLifecycleTransition({ from: 'onboarding', to: 'adoption' }).allowed).toBe(true);
  });

  it('refuses an unconfigured edge and marks churned terminal', () => {
    expect(checkLifecycleTransition({ from: 'onboarding', to: 'mature' }).allowed).toBe(false);
    const terminal = checkLifecycleTransition({ from: 'churned', to: 'onboarding' });
    expect(terminal.allowed).toBe(false);
    expect(terminal.code).toBe('invalidTransition');
  });

  it('requires a reason for important transitions', () => {
    expect(checkLifecycleTransition({ from: 'mature', to: 'churned' }).code).toBe('reasonRequired');
    expect(checkLifecycleTransition({ from: 'mature', to: 'churned', reason: 'went to competitor' }).allowed).toBe(true);
  });
});

describe('goal progress (§5.7)', () => {
  it('computes an increase from baseline to target', () => {
    const result = computeGoalProgress({ direction: 'increase', baseline: 0, target: 100, current: 25 });
    expect(result.progress).toBe(25);
    expect(result.status).toBe('inProgress');
  });

  it('computes a decrease safely (reversed direction)', () => {
    const result = computeGoalProgress({ direction: 'decrease', baseline: 100, target: 0, current: 20 });
    expect(result.progress).toBe(80);
    const achieved = computeGoalProgress({ direction: 'decrease', baseline: 100, target: 10, current: 5 });
    expect(achieved.progress).toBe(100);
    expect(achieved.status).toBe('achieved');
  });

  it('handles a degenerate target equal to baseline without dividing by zero', () => {
    const up = computeGoalProgress({ direction: 'increase', baseline: 5, target: 5, current: 5 });
    expect(up.progress).toBe(100);
    const notYet = computeGoalProgress({ direction: 'increase', baseline: 5, target: 5, current: 4 });
    expect(notYet.progress).toBe(0);
  });

  it('uses tolerance for maintain goals', () => {
    expect(computeGoalProgress({ direction: 'maintain', target: 100, current: 98, tolerance: 5 }).progress).toBe(100);
    const drift = computeGoalProgress({ direction: 'maintain', target: 100, current: 50, tolerance: 5 });
    expect(drift.progress).toBeLessThan(100);
    expect(drift.progress).toBeGreaterThanOrEqual(0);
  });

  it('supports boolean and manual goals', () => {
    expect(computeGoalProgress({ direction: 'boolean', target: 1, current: 1, baseline: 0 }).progress).toBe(100);
    expect(computeGoalProgress({ direction: 'boolean', target: 1, current: 0, baseline: 0 }).progress).toBe(0);
    expect(computeGoalProgress({ direction: 'manual', manualProgress: 42 }).progress).toBe(42);
  });

  it('bounds progress to 0–100', () => {
    expect(computeGoalProgress({ direction: 'increase', baseline: 0, target: 10, current: 999 }).progress).toBe(100);
    expect(computeGoalProgress({ direction: 'increase', baseline: 0, target: 10, current: -999 }).progress).toBe(0);
  });

  it('marks a goal overdue only when unachieved and past its date', () => {
    expect(goalIsOverdue({ status: 'inProgress', targetDate: '2020-01-01' }, '2026-01-01')).toBe(true);
    expect(goalIsOverdue({ status: 'achieved', targetDate: '2020-01-01' }, '2026-01-01')).toBe(false);
    expect(goalIsOverdue({ status: 'inProgress', targetDate: null }, '2026-01-01')).toBe(false);
  });
});

describe('risks (§5.8)', () => {
  it('validates transitions and reopening', () => {
    expect(checkRiskTransition('open', 'mitigating').allowed).toBe(true);
    expect(checkRiskTransition('resolved', 'open').allowed).toBe(true);
    expect(checkRiskTransition('closed', 'mitigating').allowed).toBe(false);
  });

  it('requires mitigation for high or critical risks', () => {
    expect(riskRequiresMitigation('critical', {})).toBe(true);
    expect(riskRequiresMitigation('high', { nextAction: 'call the sponsor' })).toBe(false);
    expect(riskRequiresMitigation('low', {})).toBe(false);
  });

  it('drops the risk component with severity and overdue penalties', () => {
    expect(riskComponentScore([], '2026-01-01')).toBe(100);
    expect(riskComponentScore([{ severity: 'critical', status: 'open' }], '2026-01-01')).toBe(40);
    expect(
      riskComponentScore([{ severity: 'high', status: 'open', targetResolutionDate: '2020-01-01' }], '2026-01-01'),
    ).toBe(60);
    // A resolved risk does not contribute.
    expect(riskComponentScore([{ severity: 'critical', status: 'resolved' }], '2026-01-01')).toBe(100);
  });
});

describe('playbooks (§5.11)', () => {
  it('rejects duplicate keys, unknown types and dependency cycles', () => {
    expect(
      validatePlaybookSteps([
        { key: 'a', name: 'A', stepType: 'manual', order: 0 },
        { key: 'a', name: 'A again', stepType: 'manual', order: 1 },
      ]).length,
    ).toBeGreaterThan(0);
    expect(validatePlaybookSteps([{ key: 'a', name: 'A', stepType: 'runShell', order: 0 }]).length).toBeGreaterThan(0);
    expect(
      validatePlaybookSteps([
        { key: 'a', name: 'A', stepType: 'manual', order: 0, dependsOn: ['b'] },
        { key: 'b', name: 'B', stepType: 'manual', order: 1, dependsOn: ['a'] },
      ]).length,
    ).toBeGreaterThan(0);
  });

  it('returns only steps whose dependencies are satisfied', () => {
    const ready = readyPlaybookSteps([
      { key: 'a', status: 'completed' },
      { key: 'b', status: 'pending', dependsOn: ['a'] },
      { key: 'c', status: 'pending', dependsOn: ['b'] },
    ]);
    expect(ready).toEqual(['b']);
  });
});

describe('renewal windows (§5.9)', () => {
  it('returns null without a date', () => {
    expect(renewalWindow(null, '2026-01-01')).toBeNull();
    expect(renewalWindow('', '2026-01-01')).toBeNull();
  });

  it('finds the smallest entered window and flags overdue', () => {
    const inside = renewalWindow('2026-01-20', '2026-01-01', [30, 60, 90]);
    expect(inside?.windowDays).toBe(30);
    expect(inside?.daysToRenewal).toBe(19);
    expect(inside?.overdue).toBe(false);
    const outside = renewalWindow('2026-12-01', '2026-01-01', [30, 60, 90]);
    expect(outside?.windowDays).toBeNull();
    const overdue = renewalWindow('2025-12-01', '2026-01-01', [30, 60, 90]);
    expect(overdue?.overdue).toBe(true);
    expect(overdue?.windowDays).toBe(30);
  });
});

describe('meaningful touch (§5.10)', () => {
  it('qualifies only customer-facing, completed activity', () => {
    expect(isMeaningfulTouch({ entity: 'Call', status: 'Held', linkedToCustomer: true })).toBe(true);
    expect(isMeaningfulTouch({ entity: 'Call', status: 'Planned', linkedToCustomer: true })).toBe(false);
    expect(isMeaningfulTouch({ entity: 'Task', status: 'Completed', linkedToCustomer: true })).toBe(true);
    expect(isMeaningfulTouch({ entity: 'Task', status: 'Completed', linkedToCustomer: false })).toBe(false);
  });

  it('takes the most recent qualifying touch by completion then creation', () => {
    const last = lastMeaningfulTouchAt([
      { entity: 'Call', status: 'Held', linkedToCustomer: true, completedAt: '2026-01-01T00:00:00.000Z' },
      { entity: 'Meeting', status: 'Held', linkedToCustomer: true, completedAt: '2026-02-01T00:00:00.000Z' },
      { entity: 'Task', status: 'Planned', linkedToCustomer: true, completedAt: '2026-03-01T00:00:00.000Z' },
    ]);
    expect(last).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('health trend (§5.4.4)', () => {
  it('needs two points and uses the documented threshold', () => {
    expect(healthTrend(null, 80)).toBe('unknown');
    expect(healthTrend(80, null)).toBe('unknown');
    expect(healthTrend(50, 55)).toBe('improving');
    expect(healthTrend(50, 44)).toBe('declining');
    expect(healthTrend(50, 52)).toBe('stable');
  });
});

describe('support signal adapter (19-SD.16)', () => {
  const facts = (cases: Record<string, unknown>[], supportSourceAvailable = true): HealthFacts =>
    ({ cases: cases.map((data, index) => ({ id: `c${String(index)}`, entityType: 'Case', version: 1, name: null, data })), supportSourceAvailable }) as unknown as HealthFacts;
  const provider = new SupportSignalProvider();

  it('reports a missing source rather than failing when Service Desk is absent', () => {
    const result = provider.collect(facts([], false), {} as never, new Date());
    expect(result.applicability).toBe('missing');
    expect(result.explanationCode).toBe('sourceUnavailable');
  });

  it('keeps healthy support history near full score', () => {
    const result = provider.collect(facts([{ status: 'Resolved' }, { status: 'Closed' }]), {} as never, new Date());
    expect(result.applicability).toBe('applicable');
    expect(result.score).toBe(100);
    expect(result.explanationCode).toBe('supportHealthy');
  });

  it('lowers the score for open, breached and escalated cases', () => {
    const result = provider.collect(
      facts([
        { status: 'Open' },
        { status: 'Open', slaState: 'Breached' },
        { status: 'Escalated', isEscalated: true, reopenedAt: '2026-01-01T00:00:00.000Z' },
      ]),
      {} as never,
      new Date(),
    );
    expect(result.applicability).toBe('applicable');
    expect(result.explanationCode).toBe('supportBreaches');
    expect(Number(result.score)).toBeLessThan(70);
  });
});
