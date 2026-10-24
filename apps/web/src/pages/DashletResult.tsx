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
  if (dashlet.kind === 'esignature') {
    return <ESignatureDashletBody keyName={String(result['key'] ?? '')} data={(result['data'] ?? {}) as Record<string, unknown>} />;
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
    const numeric = typeof value === 'number' ? value : Number(value);
    // §5.7 KPI context: the server answers with the target the dashlet stores and — when it names a
    // date window — the equivalent previous window, so the card can show direction instead of a
    // bare number. Both are optional; without them the card is the number, as it always was.
    const target = typeof result['target'] === 'number' ? result['target'] : undefined;
    const previous = typeof result['previous'] === 'number' ? result['previous'] : undefined;
    const percentOfTarget = target !== undefined && target !== 0 && Number.isFinite(numeric)
      ? Math.round((numeric / target) * 100)
      : undefined;
    const delta = previous !== undefined && Number.isFinite(numeric) ? numeric - previous : undefined;
    return (
      <div>
        <div className="carocrm-stat-value">{typeof value === 'number' ? value.toLocaleString() : String(value ?? '—')}</div>
        {target !== undefined ? (
          <div className="carocrm-kpi-context">
            <Typography.Text type="secondary">
              {t('web.dashboards.kpiTarget', { target: target.toLocaleString() })}
              {percentOfTarget !== undefined ? ` · ${t('web.dashboards.kpiOfTarget', { percent: percentOfTarget })}` : ''}
            </Typography.Text>
            <div className="carocrm-kpi-bar" aria-hidden="true">
              <span
                className="carocrm-kpi-bar-fill"
                style={{ width: `${Math.max(0, Math.min(100, percentOfTarget ?? 0))}%` }}
              />
            </div>
          </div>
        ) : null}
        {delta !== undefined ? (
          <Typography.Text
            type={delta >= 0 ? 'success' : 'secondary'}
            style={{ fontSize: 12 }}
          >
            {delta >= 0 ? '+' : ''}
            {delta.toLocaleString()} {t('web.dashboards.kpiVsPrevious')}
          </Typography.Text>
        ) : null}
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

/** ES.19 — one aggregate, rendered as counts. No request detail is present in the payload to show. */
function ESignatureDashletBody({ keyName, data }: { readonly keyName: string; readonly data: Record<string, unknown> }) {
  const rows = (value: unknown): { key: string; count: number }[] =>
    Array.isArray(value) ? (value as { status?: string; sourceEntityType?: string; count: number }[]).map((row) => ({
      key: row.status ?? row.sourceEntityType ?? 'none',
      count: row.count,
    })) : [];
  const countTable = (value: unknown, label: (key: string) => string) => (
    <Table
      size="small"
      rowKey="key"
      pagination={false}
      dataSource={rows(value)}
      columns={[
        { title: t('web.dashboards.label'), dataIndex: 'key', render: (key: string) => label(key) },
        { title: t('web.dashboards.count'), dataIndex: 'count', width: 80 },
      ]}
    />
  );
  const line = (label: string, value: unknown) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Text strong>{value === null || value === undefined ? '—' : String(value)}</Typography.Text>
    </div>
  );
  const percent = (value: unknown): string =>
    typeof value === 'number' ? `${Math.round(value * 1000) / 10}%` : '—';
  const hours = (value: unknown): string => (typeof value === 'number' ? `${value}h` : '—');

  switch (keyName) {
    case 'status':
      return countTable(data['byStatus'], (key) => t(`esignature.requests.statuses.${key}`));
    case 'rates':
      return (
        <div>
          {line(t('esignature.reports.completionRate'), percent(data['completionRate']))}
          {line(t('esignature.reports.outcomes.declined'), percent(data['declineRate']))}
          {line(t('esignature.reports.outcomes.voided'), percent(data['voidRate']))}
          {line(t('esignature.reports.outcomes.expired'), percent(data['expiryRate']))}
          {line(t('esignature.reports.inFlight'), data['inFlight'])}
        </div>
      );
    case 'approvals':
      return (
        <div>
          {line(t('esignature.reports.pendingApprovals'), data['pending'])}
          {line(t('esignature.reports.olderThan24Short'), data['olderThan24Hours'])}
          {line(t('esignature.reports.oldestHours'), hours(data['oldestAgeHours']))}
        </div>
      );
    case 'waiting':
      return (
        <div>
          {line(t('esignature.reports.waitingRequests'), data['requestsWaiting'])}
          {line(t('esignature.reports.waitingRecipients'), data['recipientsWaiting'])}
          {countTable(data['byRecipientStatus'], (key) => t(`esignature.requests.recipientStatuses.${key}`))}
        </div>
      );
    case 'completionTime':
      return (
        <div>
          {line(t('esignature.reports.average'), hours(data['averageHours']))}
          {line(t('esignature.reports.median'), hours(data['medianHours']))}
          {line(t('esignature.reports.p90'), hours(data['p90Hours']))}
        </div>
      );
    case 'exceptions':
      return (
        <div>
          {line(t('esignature.reports.exceptions'), data['total'])}
          {countTable(data['byStatus'], (key) => t(`esignature.requests.statuses.${key}`))}
        </div>
      );
    case 'volume':
      return countTable(data['bySource'], (key) => (key === 'none' ? t('esignature.reports.noSource') : key));
    default:
      return <Typography.Text type="secondary">{t('web.dashboards.unknownReport')}</Typography.Text>;
  }
}
