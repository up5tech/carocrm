import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Empty, Row, Skeleton, Space, Statistic, Table, Tag, Typography } from 'antd';

import { api } from '../../api/client.js';
import type { AIAgentUsageView } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-AI.10 — usage read-out (the ledger groundwork for 19-AI.13).
 *
 * Values are the recorded provider counters and the run ledger. Cost is labelled as recorded, not
 * estimated: a deployment without pricing snapshots reports an exact zero instead of inventing a
 * number (PLAN §12.1; pricing snapshots arrive with `19-AI.13`).
 */
export function AIAgentsUsageTab({ capabilities }: { readonly capabilities: Record<string, boolean> }) {
  const canRead = capabilities['usage'] === true;
  const usage = useQuery({
    queryKey: ['aiAgents', 'usage'],
    queryFn: () => api.aiAgentsUsage(),
    enabled: canRead,
    staleTime: 30_000,
  });

  if (!canRead) {
    return <Alert type="info" showIcon message={t('web.aiAgents.usageNoAccess')} description={t('web.aiAgents.usageNoAccessHint')} />;
  }
  if (usage.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (usage.isError || usage.data === undefined) {
    return <Alert type="error" showIcon message={t('web.aiAgents.usageFailed')} description={usage.error instanceof Error ? usage.error.message : undefined} />;
  }

  const view: AIAgentUsageView = usage.data;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic title={t('web.aiAgents.usageRuns')} value={view.totals.runs} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic title={t('web.aiAgents.usageModelCalls')} value={view.totals.modelCalls} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic title={t('web.aiAgents.toolCalls')} value={view.totals.toolCalls} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic
              title={t('web.aiAgents.usageTokens')}
              value={view.totals.inputTokens + view.totals.outputTokens}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.aiAgents.usageCostRecorded', { cost: view.totals.estimatedCostUsd.toFixed(4) })}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card className="carocrm-card" size="small" title={t('web.aiAgents.usageByAgent')}>
        {view.byAgent.length === 0 ? (
          <Empty description={t('web.aiAgents.noUsage')} />
        ) : (
          <Table
            rowKey="agentId"
            size="small"
            pagination={false}
            scroll={{ x: 560 }}
            dataSource={[...view.byAgent]}
            columns={[
              { title: t('web.aiAgents.agent'), dataIndex: 'agentName', key: 'agentName' },
              { title: t('web.aiAgents.usageRuns'), dataIndex: 'runs', key: 'runs', width: 100 },
              { title: t('web.aiAgents.modelCalls'), dataIndex: 'modelCalls', key: 'modelCalls', width: 120 },
              { title: t('web.aiAgents.toolCalls'), dataIndex: 'toolCalls', key: 'toolCalls', width: 110 },
              { title: t('web.aiAgents.usageTokens'), dataIndex: 'tokens', key: 'tokens', width: 120 },
            ]}
          />
        )}
      </Card>

      <Card className="carocrm-card" size="small" title={t('web.aiAgents.usageByProvider')}>
        {view.byProvider.length === 0 ? (
          <Empty description={t('web.aiAgents.noUsage')} />
        ) : (
          <Table
            rowKey={(row) => `${row.providerKey}:${row.model}`}
            size="small"
            pagination={false}
            scroll={{ x: 680 }}
            dataSource={[...view.byProvider]}
            columns={[
              { title: t('web.aiAgents.provider'), dataIndex: 'providerKey', key: 'providerKey', width: 170 },
              { title: t('web.aiAgents.model'), dataIndex: 'model', key: 'model', width: 170 },
              { title: t('web.aiAgents.requests'), dataIndex: 'requests', key: 'requests', width: 110 },
              {
                title: t('web.aiAgents.failures'),
                dataIndex: 'failures',
                key: 'failures',
                width: 100,
                render: (value: number) => (value === 0 ? <Tag color="green">0</Tag> : <Tag color="red">{value}</Tag>),
              },
              { title: t('web.aiAgents.usageTokens'), key: 'tokens', width: 140, render: (_value, row) => row.inputTokens + row.outputTokens },
              {
                title: t('web.aiAgents.latency'),
                dataIndex: 'averageLatencyMs',
                key: 'averageLatencyMs',
                width: 120,
                render: (value: number) => `${String(value)} ms`,
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
