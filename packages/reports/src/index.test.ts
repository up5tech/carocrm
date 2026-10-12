import { describe, expect, it } from 'vitest';

import { executeReport, ReportDefinitionSchema, validateReportDefinition } from './index.js';

const fields = {
  industry: { type: 'enum' },
  amount: { type: 'currency' },
  closedAt: { type: 'datetime' },
};

describe('report definitions', () => {
  it('validates columns, date grains, numeric metrics and calculated metric order', () => {
    const definition = validateReportDefinition({
      entityType: 'Account',
      kind: 'chart',
      groupBy: { field: 'closedAt', grain: 'month' },
      metrics: [{ name: 'revenue', operation: 'sum', field: 'amount' }, { name: 'accounts', operation: 'count' }],
      calculatedMetrics: [{ name: 'average', operation: 'divide', left: 'revenue', right: 'accounts' }],
    }, fields);
    expect(definition.version).toBe(1);
    expect(definition.calculatedMetrics[0]?.name).toBe('average');
  });

  it('rejects a date group without a grain and a non-numeric aggregate field', () => {
    expect(() => validateReportDefinition({
      entityType: 'Account', kind: 'grouped', groupBy: { field: 'closedAt' }, metrics: [{ name: 'n', operation: 'count' }],
    }, fields)).toThrow(/needs a day, month or year grain/);
    expect(() => validateReportDefinition({
      entityType: 'Account', kind: 'summary', metrics: [{ name: 'n', operation: 'sum', field: 'industry' }],
    }, fields)).toThrow(/must be numeric/);
  });

  it('rejects a calculated metric that refers forward', () => {
    const parsed = ReportDefinitionSchema.safeParse({
      entityType: 'Account',
      kind: 'summary',
      metrics: [{ name: 'total', operation: 'count' }],
      calculatedMetrics: [{ name: 'ratio', operation: 'divide', left: 'total', right: 'later' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('executeReport', () => {
  it('groups by UTC date grain and computes safe base and calculated metrics', () => {
    const definition = validateReportDefinition({
      entityType: 'Account',
      kind: 'chart',
      groupBy: { field: 'closedAt', grain: 'month' },
      metrics: [{ name: 'revenue', operation: 'sum', field: 'amount' }, { name: 'accounts', operation: 'count' }],
      calculatedMetrics: [{ name: 'average', operation: 'divide', left: 'revenue', right: 'accounts' }],
    }, fields);
    const result = executeReport(definition, [
      { id: 'a', closedAt: '2026-01-01T12:00:00.000Z', amount: 12 },
      { id: 'b', closedAt: '2026-01-29T12:00:00.000Z', amount: 8 },
      { id: 'c', closedAt: '2026-02-01T00:00:00.000Z', amount: 5 },
    ], 3);
    expect(result.groups).toEqual([
      { key: '2026-01', count: 2, metrics: { revenue: 20, accounts: 2, average: 10 } },
      { key: '2026-02', count: 1, metrics: { revenue: 5, accounts: 1, average: 5 } },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('marks capped scans as partial and never returns non-finite metric results', () => {
    const definition = validateReportDefinition({
      entityType: 'Account',
      kind: 'summary',
      metrics: [
        { name: 'count', operation: 'count' },
        { name: 'sum', operation: 'sum', field: 'amount' },
        { name: 'average', operation: 'avg', field: 'amount' },
        { name: 'minimum', operation: 'min', field: 'amount' },
        { name: 'maximum', operation: 'max', field: 'amount' },
      ],
      calculatedMetrics: [
        { name: 'zeroDivision', operation: 'divide', left: 'sum', right: 'count' },
        { name: 'percentage', operation: 'percentOf', left: 'sum', right: 'count' },
      ],
    }, fields);
    const result = executeReport(definition, [{ id: 'a', amount: '   ' }, { id: 'b', amount: 'Infinity' }], 10);
    expect(result.truncated).toBe(true);
    expect(result.metrics).toEqual({ count: 2, sum: 0, average: null, minimum: null, maximum: null, zeroDivision: 0, percentage: 0 });
    for (const value of Object.values(result.metrics ?? {})) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it('returns null rather than infinity when finite samples overflow a sum', () => {
    const definition = validateReportDefinition({
      entityType: 'Account', kind: 'summary', metrics: [{ name: 'total', operation: 'sum', field: 'amount' }],
    }, fields);
    const result = executeReport(definition, [{ amount: Number.MAX_VALUE }, { amount: Number.MAX_VALUE }], 2);
    expect(result.metrics?.['total']).toBeNull();
  });

  it('projects list columns without requiring the source id to be selected', () => {
    const definition = validateReportDefinition({ entityType: 'Account', kind: 'list', columns: ['industry'] }, fields);
    const result = executeReport(definition, [{ id: 'account-1', industry: 'Technology', amount: 3 }], 1);
    expect(result.rows).toEqual([{ __rowId: 'account-1', industry: 'Technology' }]);
  });
});
