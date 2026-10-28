import { Alert, App as AntApp, Card, Col, Row, Statistic, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ServiceDeskMetrics } from '../api/types.js';
import { formatDateTime,t } from '../state/i18n.js';

/**
 * Phase 19-SD.15 — the agent/team-lead dashboard (PLAN §13).
 *
 * One server call returns the ACL-scoped aggregate: the API applies the same record predicate as the
 * case list, so a count can never include a case the viewer cannot open. The recent list stays on the
 * generic Case API for the same reason.
 */
export function ServiceDeskDashboardPage() {
  const { message } = AntApp.useApp();
  const [metrics, setMetrics] = useState<ServiceDeskMetrics | undefined>(undefined);
  const [recent, setRecent] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aggregate, rec] = await Promise.all([
        api.serviceDeskMetrics(),
        api.list('Case', { orderBy: 'modifiedAt', offset: 0, maxSize: 10 }),
      ]);
      setMetrics(aggregate);
      setRecent(rec.list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  const cards = metrics === undefined
    ? []
    : [
        { label: t('web.serviceDesk.dashboard.total'), value: metrics.total },
        { label: t('web.serviceDesk.dashboard.active'), value: metrics.active },
        { label: t('web.serviceDesk.dashboard.unassigned'), value: metrics.unassigned },
        { label: t('web.serviceDesk.dashboard.breached'), value: metrics.breached },
        { label: t('web.serviceDesk.dashboard.escalated'), value: metrics.escalated },
        { label: t('web.serviceDesk.dashboard.reopened'), value: metrics.reopened },
        {
          label: t('web.serviceDesk.dashboard.reopenRate'),
          value: metrics.reopenRate === null ? '—' : `${(metrics.reopenRate * 100).toFixed(1)}%`,
        },
        {
          label: t('web.serviceDesk.dashboard.csat'),
          value: metrics.csat.restricted || metrics.csat.average === null ? '—' : metrics.csat.average.toFixed(2),
        },
      ];

  return (
    <div>
      <Typography.Title level={4}>{t('web.serviceDesk.dashboard.title')}</Typography.Title>
      {loading && metrics === undefined ? <Card className="carocrm-card" loading /> : (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            {cards.map((c) => (
              <Col key={c.label} xs={12} sm={8} md={6} lg={4}>
                <Card className="carocrm-card" size="small">
                  <Statistic title={c.label} value={c.value} />
                </Card>
              </Col>
            ))}
          </Row>
          {metrics !== undefined && metrics.byStatus.length > 0 ? (
            <Card className="carocrm-card" size="small" title={t('web.serviceDesk.dashboard.byStatus')} style={{ marginBottom: 16 }}>
              <Row gutter={[8, 8]}>
                {metrics.byStatus.map((bucket) => (
                  <Col key={bucket.key} xs={12} sm={8} md={6} lg={4}>
                    <Statistic title={bucket.key} value={bucket.count} />
                  </Col>
                ))}
              </Row>
            </Card>
          ) : null}
          {metrics !== undefined && metrics.csat.restricted ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={t('web.serviceDesk.dashboard.csatRestricted')}
            />
          ) : null}
          <Card className="carocrm-card" title={t('web.serviceDesk.dashboard.recent')}>
            <Table
              rowKey={(row) => String(row['id'])}
              dataSource={recent}
              pagination={false}
              columns={[
                { title: t('web.serviceDesk.dashboard.subject'), dataIndex: 'name', render: (v, row) => <Link to={`/Case/${row['id']}`}>{String(v ?? '')}</Link> },
                { title: t('web.serviceDesk.dashboard.status'), dataIndex: 'status' },
                { title: t('web.serviceDesk.dashboard.priority'), dataIndex: 'priority' },
                { title: t('web.serviceDesk.dashboard.assignee'), dataIndex: 'assignedUserId' },
                { title: t('web.serviceDesk.dashboard.modified'), dataIndex: 'modifiedAt', render: (v) => (v ? formatDateTime(String(v)) : '') },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
