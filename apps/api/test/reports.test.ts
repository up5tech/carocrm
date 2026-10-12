import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportService } from '../src/reports/report.service.js';

const fields = {
  category: { type: 'enum' },
  revenue: { type: 'currency' },
  secretValue: { type: 'currency' },
};

function makeService(options: { visible?: string[]; list?: ReturnType<typeof vi.fn> } = {}) {
  const registry = {
    hasEntity: (entity: string) => entity === 'Account',
    getField: (_entity: string, name: string) => fields[name as keyof typeof fields],
    getFields: (_entity: string) => fields,
  };
  const metadata = { ensureLoaded: vi.fn(), registry };
  const acl = {
    assertAccess: vi.fn().mockResolvedValue('all'),
    visibleFields: vi.fn().mockResolvedValue(options.visible ?? ['id', 'name', 'category', 'revenue']),
  };
  const entities = { list: options.list ?? vi.fn().mockResolvedValue({
    list: [{ id: 'a1', category: 'Software', revenue: 30 }, { id: 'a2', category: 'Software', revenue: 20 }],
    total: 2,
    count: 2,
    offset: 0,
  }) };
  const scope = { userId: 'user-1', isAdmin: false, requirePrincipal: () => ({ userId: 'user-1' }) };
  const service = new ReportService(entities as never, metadata as never, acl as never, {} as never, scope as never);
  return { service, entities, acl };
}

describe('ReportService preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs bounded grouped metrics through EntityCrudService', async () => {
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
    expect(acl.assertAccess).toHaveBeenCalledWith('Account', 'read');
    expect(entities.list).toHaveBeenCalledWith('Account', expect.objectContaining({
      where: [{ field: 'category', operator: 'equals', value: 'Software' }],
      select: 'id,category,revenue',
      maxSize: 500,
      offset: 0,
      total: true,
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
    expect(entities.list).not.toHaveBeenCalled();
  });

  it('marks grouped results partial after the 2,000-row scan budget', async () => {
    const page = Array.from({ length: 500 }, (_, index) => ({ id: `row-${String(index)}`, category: 'Software', revenue: 1 }));
    const list = vi.fn().mockResolvedValue({ list: page, total: 3_000, count: 500, offset: 0 });
    const { service } = makeService({ list });
    const response = await service.preview({ definition: {
      entityType: 'Account',
      kind: 'summary',
      filters: [],
      columns: [],
      metrics: [{ name: 'records', operation: 'count' }],
    } });
    expect(response.result.scanned).toBe(2_000);
    expect(response.result.total).toBe(3_000);
    expect(response.result.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(4);
  });
});
