import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd';

import { api } from '../../api/client.js';
import type { OmnichannelAnalytics } from '../../api/types.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-OM.20 — the conversation analytics panel (plan §10.1, §14 `19-OM.20`).
 *
 * Every number is the server's answer from the documented dedicated analytics path
 * (`docs/omnichannel/analytics.md`); the panel never computes a metric locally. Missing denominators
 * are shown as "—" with the server's honest `unavailable` reason, and delivery `unknown` is displayed
 * separately from failures — an unknown outcome is never presented as a failure or a success.
 */
export function ReportsPanel() {
  const analytics = useQuery({ queryKey: ['omnichannel', 'analytics'], queryFn: () => api.omnichannelAnalytics(30), staleTime: 60_000 });
  if (analytics.isLoading) return <LoadingSkeleton rows={8} />;
  if (analytics.isError || analytics.data === undefined) {
    return <ErrorState message={t('omnichannel.reports.loadFailed')} onRetry={() => void analytics.refetch()} />;
  }
  const view: OmnichannelAnalytics = analytics.data;
  const unavailable = (metric: { averageMinutes: number | null; sample: number; unavailable?: string }): string =>
    metric.averageMinutes === null ? `— (${metric.unavailable ?? t('omnichannel.reports.noData')})` : `${String(metric.averageMinutes)} min`;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('omnichannel.reports.inbound')} value={view.volume.totalInbound} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('omnichannel.reports.outbound')} value={view.volume.totalOutbound} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('omnichannel.reports.unassigned')} value={view.backlog.unassigned} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('omnichannel.reports.handoffs')} value={view.handoffs.conversationsWithCase} /></Card></Col>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('omnichannel.reports.volume')}>
            <Table
              rowKey="channel"
              size="small"
              pagination={false}
              dataSource={[...view.volume.byChannel]}
              columns={[
                { title: t('omnichannel.inbox.channel'), dataIndex: 'channel' },
                { title: t('omnichannel.reports.inbound'), dataIndex: 'inbound' },
                { title: t('omnichannel.reports.outbound'), dataIndex: 'outbound' },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('omnichannel.reports.backlog')}>
            <Space wrap>
              {view.backlog.byStatus.map((row) => (
                <Tag key={row.status}>{t(`omnichannel.inbox.statuses.${row.status}`)}: {row.count}</Tag>
              ))}
              <Tag>{t('omnichannel.reports.snoozed')}: {view.backlog.snoozed}</Tag>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('omnichannel.reports.timing')}>
            <Space direction="vertical" size={4}>
              <Typography.Text>{t('omnichannel.reports.firstResponse')}: {unavailable(view.firstResponse)} ({view.firstResponse.sample})</Typography.Text>
              <Typography.Text>{t('omnichannel.reports.replyDelay')}: {unavailable(view.replyDelay)} ({view.replyDelay.sample})</Typography.Text>
              <Typography.Text>{t('omnichannel.reports.reopenRate')}: {view.reopenRate.rate === null ? '—' : `${String(view.reopenRate.rate)}%`} ({view.reopenRate.reopened}/{view.reopenRate.closedInWindow})</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('omnichannel.reports.delivery')}>
            <Space wrap>
              <Tag color={view.delivery.failed > 0 ? 'red' : 'default'}>{t('omnichannel.reports.failed')}: {view.delivery.failed}</Tag>
              <Tag color={view.delivery.undelivered > 0 ? 'orange' : 'default'}>{t('omnichannel.reports.undelivered')}: {view.delivery.undelivered}</Tag>
              <Tag color={view.delivery.unknown > 0 ? 'gold' : 'default'}>{t('omnichannel.reports.unknown')}: {view.delivery.unknown}</Tag>
            </Space>
            <div style={{ marginTop: 8 }}>
              {view.delivery.byCategory.map((row) => (
                <Tag key={row.category}>{row.category}: {row.count}</Tag>
              ))}
            </div>
          </Card>
        </Col>
        <Col xs={24}>
          <Card size="small" title={t('omnichannel.reports.provider')}>
            {view.providerHealth.available ? (
              <Space wrap>
                {view.providerHealth.accounts.map((row) => (
                  <Tag key={row.key} color={row.status === 'ok' ? 'green' : row.status === 'unknown' ? 'default' : 'orange'}>
                    {row.key}: {row.status}
                  </Tag>
                ))}
                {view.providerHealth.webhookBacklog.map((row) => (
                  <Tag key={row.status}>{row.status}: {row.count}</Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">{view.providerHealth.reason ?? t('omnichannel.reports.unavailable')}</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
