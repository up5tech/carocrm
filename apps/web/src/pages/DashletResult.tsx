import { Table, Typography } from 'antd';

import type { DashletRow } from '../api/client.js';

export function DashletResult({ dashlet, result }: { dashlet: DashletRow; result: Record<string, unknown> | undefined }) {
  if (!result) return <Typography.Text type="secondary">Not run yet.</Typography.Text>;
  // A grouped dashlet aggregates over a bounded scan; say so instead of showing a silent cap.
  const hint =
    result['truncated'] === true ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Aggregated over the first {String(result['scanned'] ?? '0')} matching records; more exist.
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
      <Table size="small" rowKey={(row) => String(row['id'])} dataSource={list} pagination={false} columns={[{ title: 'Name', dataIndex: 'name' }]} />
      {hint}
    </div>
  );
}
