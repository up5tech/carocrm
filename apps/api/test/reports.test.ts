import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportService } from '../src/reports/report.service.js';

const fields = {
  category: { type: 'enum' },
  region: { type: 'enum' },
  revenue: { type: 'currency' },
  secretValue: { type: 'currency' },
  billingRegionId: { type: 'link', entityKey: 'Region' },
};
const relatedFields = { name: { type: 'varchar' }, score: { type: 'currency' } };

function makeService(options: {
  visible?: string[];
  list?: ReturnType<typeof vi.fn>;
  aggregate?: ReturnType<typeof vi.fn>;
} = {}) {
  const registry = {
    hasEntity: (entity: string) => entity === 'Account' || entity === 'Region',
    getField: (entity: string, name: string) => entity === 'Region' ? relatedFields[name as keyof typeof relatedFields] : fields[name as keyof typeof fields],
    getFields: (entity: string) => entity === 'Region' ? relatedFields : fields,
  };
  const metadata = { ensureLoaded: vi.fn(), registry };
  const acl = {
    assertAccess: vi.fn().mockResolvedValue('all'),
    visibleFields: vi.fn().mockImplementation(async (entity: string) => options.visible ?? (entity === 'Region' ? ['id', 'name', 'score'] : ['id', 'name', 'category', 'region', 'revenue', 'billingRegionId'])),
    recordPredicate: vi.fn().mockResolvedValue({ kind: 'own', userId: 'user-1' }),
  };
  const entities = {
    list: options.list ?? vi.fn().mockResolvedValue({
      list: [{ id: 'a1', category: 'Software', revenue: 30 }, { id: 'a2', category: 'Software', revenue: 20 }],
      total: 2,
      count: 2,
      offset: 0,
    }),
    aggregate: options.aggregate ?? vi.fn().mockResolvedValue({
      total: 2,
      groups: [{ keys: ['Software'], count: 2, metrics: { revenue: 50, records: 2 } }],
    }),
  };
  const scope = { userId: 'user-1', isAdmin: false, requirePrincipal: () => ({ userId: 'user-1' }) };
  const service = new ReportService(entities as never, metadata as never, acl as never, {} as never, scope as never);
  return { service, entities, acl };
}

describe('ReportService preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs exact grouped metrics through the EntityCrudService ACL aggregate path', async () => {
    const { service, entities, acl } = makeService();
    const response = await service.preview({ definition: {
      entityType: 'Account',
      kind: 'grouped',
      filters: [{ field: 'category', operator: 'equals', value: 'Software' }],
      columns: [],
      groupBy: { field: 'category' },
      metrics: [{ name: 'revenue', operation: 'sum', field: 'revenue' }, { name: 'records', operation: 'count' }],
    } });

    expect(response.result.groups).toEqual([{ key: 'Software', count: 2, metrics: { revenue: 50, records: 2 } }]);
    expect(response.result.scanned).toBeNull();
    expect(response.result.truncated).toBe(false);
    expect(acl.assertAccess).toHaveBeenCalledWith('Account', 'read');
    expect(entities.aggregate).toHaveBeenCalledWith('Account', expect.objectContaining({
      where: [{ field: 'category', operator: 'equals', value: 'Software' }],
      dimensions: [{ field: 'category', fieldType: 'enum' }],
      metrics: [{ name: 'revenue', operation: 'sum', field: 'revenue', fieldType: 'currency' }, { name: 'records', operation: 'count' }],
      maxGroups: 100,
    }));
  });

  it('rejects fields hidden by field-level ACL even when used only by a metric', async () => {
    const { service, entities } = makeService({ visible: ['id', 'category'] });
    await expect(service.preview({ definition: {
      entityType: 'Account',
      kind: 'summary',
      filters: [],
      columns: [],
      metrics: [{ name: 'revenue', operation: 'sum', field: 'secretValue' }],
    } })).rejects.toThrow(/cannot be used in this report/);
    expect(entities.aggregate).not.toHaveBeenCalled();
  });

  it('returns exact summary metrics beyond the old row-scan budget', async () => {
    const aggregate = vi.fn().mockResolvedValue({ total: 3_000, groups: [{ keys: [], count: 3_000, metrics: { records: 3_000 } }] });
    const { service, entities } = makeService({ aggregate });
    const response = await service.preview({ definition: {
      entityType: 'Account',
      kind: 'summary',
      filters: [],
      columns: [],
      metrics: [{ name: 'records', operation: 'count' }],
    } });
    expect(response.result.scanned).toBeNull();
    expect(response.result.total).toBe(3_000);
    expect(response.result.truncated).toBe(false);
    expect(response.result.metrics).toEqual({ records: 3_000 });
    expect(entities.list).not.toHaveBeenCalled();
  });

  it('executes and labels matrix dimensions and derived metrics', async () => {
    const aggregate = vi.fn().mockResolvedValue({ total: 3, groups: [
      { keys: ['Software', 'North'], count: 2, metrics: { revenue: 50, records: 2 } },
      { keys: ['Software', 'South'], count: 1, metrics: { revenue: 20, records: 1 } },
    ] });
    const { service, entities } = makeService({ aggregate });
    const response = await service.preview({ definition: {
      entityType: 'Account',
      kind: 'matrix',
      filters: [],
      columns: [],
      matrix: { rows: { field: 'category' }, columns: { field: 'region' } },
      metrics: [{ name: 'revenue', operation: 'sum', field: 'revenue' }, { name: 'records', operation: 'count' }],
      calculatedMetrics: [{ name: 'perRecord', operation: 'divide', left: 'revenue', right: 'records' }],
    } });
    expect(response.result.matrix).toEqual({
      rowField: 'category',
      columnField: 'region',
      cells: [
        { rowKey: 'Software', columnKey: 'North', count: 2, metrics: { revenue: 50, records: 2, perRecord: 25 } },
        { rowKey: 'Software', columnKey: 'South', count: 1, metrics: { revenue: 20, records: 1, perRecord: 20 } },
      ],
    });
    expect(entities.aggregate).toHaveBeenCalledWith('Account', expect.objectContaining({
      dimensions: [{ field: 'category', fieldType: 'enum' }, { field: 'region', fieldType: 'enum' }],
    }));
  });

  it('supports one-hop related numeric measures while carrying the target ACL predicate to the store', async () => {
    const aggregate = vi.fn().mockResolvedValue({ total: 2, groups: [{ keys: ['(empty)'], count: 2, metrics: { score: 14 } }] });
    const { service, entities, acl } = makeService({ aggregate });
    const reportFields = (service as unknown as { reportFieldMap: (entity: string) => Record<string, { type: string }> }).reportFieldMap('Account');
    expect(reportFields['billingRegionId.score']?.type).toBe('currency');
    const response = await service.preview({ definition: {
      entityType: 'Account',
      kind: 'summary',
      filters: [],
      columns: [],
      metrics: [{ name: 'score', operation: 'sum', field: 'billingRegionId.score' }],
    } });
    expect(response.result.metrics).toEqual({ score: 14 });
    expect(acl.assertAccess).toHaveBeenCalledWith('Region', 'read');
    expect(entities.aggregate).toHaveBeenCalledWith('Account', expect.objectContaining({
      metrics: [expect.objectContaining({
        field: 'billingRegionId.score',
        relation: expect.objectContaining({ sourceField: 'billingRegionId', targetEntity: 'Region', targetField: 'score', acl: expect.any(Object) }),
      })],
    }));
  });

  it('rejects results beyond the group limit instead of presenting partial aggregates as exact', async () => {
    const groups = Array.from({ length: 101 }, (_, index) => ({ keys: [`Group ${String(index)}`], count: 1, metrics: { records: 1 } }));
    const { service } = makeService({ aggregate: vi.fn().mockResolvedValue({ total: 101, groups }) });
    await expect(service.preview({ definition: {
      entityType: 'Account',
      kind: 'grouped',
      filters: [],
      columns: [],
      groupBy: { field: 'category' },
      metrics: [{ name: 'records', operation: 'count' }],
    } })).rejects.toThrow(/configured cost limit/);
  });
});
