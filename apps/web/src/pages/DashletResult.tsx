import { Table, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';

import type { DashletRow } from '../api/client.js';
import { t } from '../state/i18n.js';

interface ProjectTaskRow {
  id: string;
  name: string | null;
  status: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  projectId: string | null;
  projectName: string | null;
  groupType: string | null;
  relation: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  'Not Started': 'default',
  Started: 'processing',
  Completed: 'success',
  Canceled: 'warning',
  Deferred: 'orange',
};

export function DashletResult({ dashlet, result }: { dashlet: DashletRow; result: Record<string, unknown> | undefined }) {
  if (!result) return <Typography.Text type="secondary">{t('web.dashboards.notRun')}</Typography.Text>;

  if (dashlet.kind === 'projectTasks') {
    const rows = (result['list'] ?? []) as ProjectTaskRow[];
    if (rows.length === 0) return <Typography.Text type="secondary">{t('web.dashboards.nothingDue')}</Typography.Text>;
    return (
      <Table
        size="small"
        rowKey={(row) => row.id}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: t('web.common.task'),
            dataIndex: 'name',
            render: (_: unknown, row) => <Link to={`/ProjectTask/${row.id}`}>{row.name ?? row.id}</Link>,
          },
          {
            title: t('web.common.project'),
            dataIndex: 'projectName',
            render: (_: unknown, row) => (row.projectId === null ? '—' : <Link to={`/Project/${row.projectId}`}>{row.projectName ?? row.projectId}</Link>),
          },
          { title: t('web.common.due'), dataIndex: 'dateEnd', render: (value: string | null) => value ?? '—' },
          {
            title: t('web.common.status'),
            dataIndex: 'status',
            render: (value: string | null) => <Tag color={STATUS_COLORS[value ?? ''] ?? 'default'}>{value ?? '—'}</Tag>,
          },
          { title: t('web.common.groupType'), dataIndex: 'groupType', render: (value: string | null) => value ?? '—' },
        ]}
      />
    );
  }
  // A grouped dashlet aggregates over a bounded scan; say so instead of showing a silent cap.
  const hint =
    result['truncated'] === true ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('web.dashboards.truncated', { scanned: String(result['scanned'] ?? '0') })}
      </Typography.Text>
    ) : null;
  if (dashlet.kind === 'kpi') {
    const value = result['value'] ?? result['count'];
    return (
      <div>
        <div className="lizant-stat-value">{typeof value === 'number' ? value.toLocaleString() : String(value ?? '—')}</div>
        {hint}
      </div>
    );
  }
  if (dashlet.kind === 'chart') {
    const groups = (result['groups'] ?? []) as { key: string; count: number }[];
    const max = Math.max(1, ...groups.map((group) => group.count));
    return (
      <div>
        {groups.map((group) => (
          <div key={group.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Typography.Text style={{ width: 140 }} ellipsis>
              {group.key}
            </Typography.Text>
            <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4 }}>
              <div style={{ width: `${String(Math.round((group.count / max) * 100))}%`, height: 10, background: '#438eff', borderRadius: 4 }} />
            </div>
            <Typography.Text>{group.count.toLocaleString()}</Typography.Text>
          </div>
        ))}
        {hint}
      </div>
    );
  }
  const list = (result['list'] ?? []) as Record<string, unknown>[];
  return (
    <div>
      <Table size="small" rowKey={(row) => String(row['id'])} dataSource={list} pagination={false} columns={[{ title: t('web.common.name'), dataIndex: 'name' }]} />
      {hint}
    </div>
  );
}
