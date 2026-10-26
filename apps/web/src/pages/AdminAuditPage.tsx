import { Card, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ListResult } from '../api/types.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { formatDateTime, t } from '../state/i18n.js';

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
  // §20.22: a failed read used to leave an empty table and no message, which reads as "no audit
  // entries" — the one wrong answer this screen must never give.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result: ListResult = await api.auditLog({ offset, maxSize: pageSize });
      setRows(result.list.map(toRow).filter((row): row is AuditRow => row !== undefined));
      setTotal(result.total ?? result.list.length);
    } catch (cause) {
      setRows([]);
      setTotal(0);
      setError(cause instanceof Error ? cause.message : t('web.adminAudit.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [offset, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="carocrm-card" title={<Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{t('web.adminAudit.title')}</Typography.Title>}>
      {error === null ? null : (
        <div style={{ marginBottom: 12 }}>
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: error === null ? <EmptyState variant="no-records" /> : ' ' }}
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
          { title: t('web.adminAudit.when'), dataIndex: 'createdAt', render: (value: string) => formatDateTime(value) },
          { title: t('web.adminAudit.entity'), dataIndex: 'entityType' },
          // A router link, so opening an audited record keeps the SPA (and the list state) alive.
          { title: t('web.adminAudit.record'), dataIndex: 'entityId', render: (value: string, row: AuditRow) => <Link to={`/${row.entityType}/${value}`}>{value.slice(0, 8)}</Link> },
          { title: t('web.adminAudit.action'), dataIndex: 'action' },
          { title: t('web.adminAudit.field'), dataIndex: 'fieldName' },
          { title: t('web.adminAudit.old'), dataIndex: 'oldValue', render: (value: unknown) => (value === undefined ? '' : JSON.stringify(value)) },
          { title: t('web.adminAudit.new'), dataIndex: 'newValue', render: (value: unknown) => (value === undefined ? '' : JSON.stringify(value)) },
          { title: t('web.adminAudit.by'), dataIndex: 'username' },
        ]}
      />
    </Card>
  );
}
