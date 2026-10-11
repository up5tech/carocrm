import { Card, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { ListResult } from '../api/types.js';

interface AuditRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fieldName?: string | undefined;
  oldValue?: unknown;
  newValue?: unknown;
  username?: string | undefined;
  createdAt: string;
}

function toRow(value: unknown): AuditRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const data = (typeof record['data'] === 'object' && record['data'] !== null ? record['data'] : {}) as Record<string, unknown>;
  return {
    id: String(record['id'] ?? ''),
    entityType: String(record['entityType'] ?? ''),
    entityId: String(record['entityId'] ?? ''),
    action: String(record['action'] ?? ''),
    fieldName: typeof data['field'] === 'string' ? data['field'] : undefined,
    oldValue: data['oldValue'],
    newValue: data['newValue'],
    username: typeof record['username'] === 'string' ? record['username'] : undefined,
    createdAt: String(record['createdAt'] ?? ''),
  };
}

export function AdminAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result: ListResult = await api.auditLog({ offset, maxSize: pageSize });
      setRows(result.list.map(toRow).filter((row): row is AuditRow => row !== undefined));
      setTotal(result.total ?? result.list.length);
    } finally {
      setLoading(false);
    }
  }, [offset, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="lizant-card" title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Audit Log</Typography.Title>}>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: Math.floor(offset / pageSize) + 1,
          pageSize,
          total,
          onChange: (page, size) => {
            setPageSize(size);
            setOffset((page - 1) * size);
          },
        }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', render: (value: string) => value.slice(0, 19).replace('T', ' ') },
          { title: 'Entity', dataIndex: 'entityType' },
          { title: 'Record', dataIndex: 'entityId', render: (value: string, row: AuditRow) => <a href={`/${row.entityType}/${value}`}>{value.slice(0, 8)}</a> },
          { title: 'Action', dataIndex: 'action' },
          { title: 'Field', dataIndex: 'fieldName' },
          { title: 'Old', dataIndex: 'oldValue', render: (value: unknown) => (value === undefined ? '' : JSON.stringify(value)) },
          { title: 'New', dataIndex: 'newValue', render: (value: unknown) => (value === undefined ? '' : JSON.stringify(value)) },
          { title: 'By', dataIndex: 'username' },
        ]}
      />
    </Card>
  );
}
