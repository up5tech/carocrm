import { App as AntApp, Card, Col, Row, Spin, Statistic, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

interface Count { label: string; value: number; }

export function ServiceDeskDashboardPage() {
  const { message } = AntApp.useApp();
  const [counts, setCounts] = useState<Count[]>([]);
  const [recent, setRecent] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const statuses = ['New', 'Open', 'Pending Customer', 'Pending Internal', 'Escalated', 'Resolved', 'Closed', 'Cancelled'];
      const built: Count[] = [];
      let total = 0;
      for (const status of statuses) {
        const r = await api.list('Case', { where: [{ field: 'status', operator: 'equals', value: status }], maxSize: 1 });
        const n = r.total ?? r.list.length;
        total += n;
        built.push({ label: status, value: n });
      }
      built.unshift({ label: t('web.serviceDesk.dashboard.total'), value: total });

      const unassigned = await api.list('Case', { where: [{ field: 'assignedUserId', operator: 'isNull' }], maxSize: 1 });
      built.push({ label: t('web.serviceDesk.dashboard.unassigned'), value: unassigned.total ?? unassigned.list.length });

      const breached = await api.list('Case', { where: [{ field: 'slaState', operator: 'equals', value: 'Breached' }], maxSize: 1 });
      built.push({ label: t('web.serviceDesk.dashboard.breached'), value: breached.total ?? breached.list.length });

      const escalated = await api.list('Case', { where: [{ field: 'isEscalated', operator: 'equals', value: true }], maxSize: 1 });
      built.push({ label: t('web.serviceDesk.dashboard.escalated'), value: escalated.total ?? escalated.list.length });

      setCounts(built);

      const rec = await api.list('Case', { orderBy: 'modifiedAt', offset: 0, maxSize: 10 });
      setRecent(rec.list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <Typography.Title level={4}>{t('web.serviceDesk.dashboard.title')}</Typography.Title>
      {loading ? <Spin /> : (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            {counts.map((c) => (
              <Col key={c.label} xs={12} sm={8} md={6} lg={4}>
                <Card className="lizant-card" size="small">
                  <Statistic title={c.label} value={c.value} />
                </Card>
              </Col>
            ))}
          </Row>
          <Card className="lizant-card" title={t('web.serviceDesk.dashboard.recent')}>
            <Table
              rowKey={(row) => String(row['id'])}
              dataSource={recent}
              pagination={false}
              columns={[
                { title: t('web.serviceDesk.dashboard.subject'), dataIndex: 'name', render: (v, row) => <Link to={`/Case/${row['id']}`}>{String(v ?? '')}</Link> },
                { title: t('web.serviceDesk.dashboard.status'), dataIndex: 'status' },
                { title: t('web.serviceDesk.dashboard.priority'), dataIndex: 'priority' },
                { title: t('web.serviceDesk.dashboard.assignee'), dataIndex: 'assignedUserId' },
                { title: t('web.serviceDesk.dashboard.modified'), dataIndex: 'modifiedAt', render: (v) => (v ? new Date(String(v)).toLocaleString() : '') },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
