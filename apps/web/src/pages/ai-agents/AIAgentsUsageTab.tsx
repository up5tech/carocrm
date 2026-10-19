import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentBudgetPolicyStatus, AIAgentPricingSnapshot, AIAgentUsageView } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-AI.10/19-AI.13 — usage, quotas and cost administration
 * (PLAN_Phase_19_AI_Agents.md §12, §15, §20 `19-AI.13`).
 *
 * The numbers come from the run and provider ledgers. Cost is explicitly labelled: `estimate`
 * means the figure was priced from an admin-maintained snapshot, `none` means the deployment has
 * no price data and the total is an exact zero — never an invented number (§12.1). The quota
 * section shows each policy's consumption, its soft-limit warning before the hard stop, and the
 * hard limit once reached; a soft limit never refuses work by itself (§12.3).
 */
export function AIAgentsUsageTab({ capabilities }: { readonly capabilities: Record<string, boolean> }) {
  const canRead = capabilities['usage'] === true;
  const canAdmin = capabilities['policyAdmin'] === true;
  const queryClient = useQueryClient();
  const usage = useQuery({
    queryKey: ['aiAgents', 'usage'],
    queryFn: () => api.aiAgentsUsage(),
    enabled: canRead,
    staleTime: 30_000,
  });
  const quotas = useQuery({
    queryKey: ['aiAgents', 'quotaStatus'],
    queryFn: () => api.aiAgentsQuotaStatus(),
    enabled: canRead,
    staleTime: 15_000,
  });
  const pricing = useQuery({
    queryKey: ['aiAgents', 'pricing'],
    queryFn: () => api.aiAgentsPricing(),
    enabled: canAdmin,
    staleTime: 60_000,
  });

  const [pricingForm] = Form.useForm();
  const [quotaForm] = Form.useForm();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'usage'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'quotaStatus'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'pricing'] });
  };

  const savePricing = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.aiAgentsCreatePricing({
      providerKey: String(values['providerKey']),
      model: String(values['model']),
      inputPricePerMillion: Number(values['inputPricePerMillion']),
      outputPricePerMillion: Number(values['outputPricePerMillion']),
      cachedInputPricePerMillion: Number(values['cachedInputPricePerMillion'] ?? 0),
    }),
    onSuccess: () => {
      setPricingOpen(false);
      pricingForm.resetFields();
      refresh();
    },
  });

  const removePricing = useMutation({
    mutationFn: (id: string) => api.aiAgentsDeletePricing(id),
    onSuccess: refresh,
  });

  const saveQuota = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.aiAgentsCreateQuota({
      scope: values['scope'] as 'global' | 'user' | 'team' | 'agent' | 'provider',
      period: values['period'] as 'day' | 'month',
      ...(values['scopeRef'] === undefined || values['scopeRef'] === '' ? {} : { scopeRef: String(values['scopeRef']) }),
      ...(values['maxRuns'] === null || values['maxRuns'] === undefined ? {} : { maxRuns: Number(values['maxRuns']) }),
      ...(values['maxCostUsd'] === null || values['maxCostUsd'] === undefined ? {} : { maxCostUsd: Number(values['maxCostUsd']) }),
      ...(values['maxTokens'] === null || values['maxTokens'] === undefined ? {} : { maxTokens: Number(values['maxTokens']) }),
      ...(values['maxConcurrentRuns'] === null || values['maxConcurrentRuns'] === undefined
        ? {}
        : { maxConcurrentRuns: Number(values['maxConcurrentRuns']) }),
      ...(values['warnPercent'] === null || values['warnPercent'] === undefined ? {} : { warnPercent: Number(values['warnPercent']) }),
    }),
    onSuccess: () => {
      setQuotaOpen(false);
      quotaForm.resetFields();
      refresh();
    },
  });

  const removeQuota = useMutation({
    mutationFn: (id: string) => api.aiAgentsDeleteQuota(id),
    onSuccess: refresh,
  });

  if (!canRead) {
    return <Alert type="info" showIcon message={t('web.aiAgents.usageNoAccess')} description={t('web.aiAgents.usageNoAccessHint')} />;
  }
  if (usage.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (usage.isError || usage.data === undefined) {
    return <Alert type="error" showIcon message={t('web.aiAgents.usageFailed')} description={usage.error instanceof Error ? usage.error.message : undefined} />;
  }

  const view: AIAgentUsageView = usage.data;
  const costIsEstimate = view.totals.costLabel === 'estimate';
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
            <Space size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {costIsEstimate
                  ? t('web.aiAgents.usageCostEstimate', { cost: view.totals.estimatedCostUsd.toFixed(4) })
                  : t('web.aiAgents.usageCostRecorded', { cost: view.totals.estimatedCostUsd.toFixed(4) })}
              </Typography.Text>
              <Tag color={costIsEstimate ? 'blue' : 'default'} style={{ fontSize: 11 }}>
                {costIsEstimate ? t('web.aiAgents.costEstimate') : t('web.aiAgents.costNone')}
              </Tag>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        className="carocrm-card"
        size="small"
        title={t('web.aiAgents.quotas')}
        extra={
          canAdmin ? (
            <Button size="small" type="primary" onClick={() => setQuotaOpen(true)}>
              {t('web.aiAgents.quotaAdd')}
            </Button>
          ) : null
        }
      >
        {quotas.isLoading ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : quotas.isError ? (
          <Alert type="warning" showIcon message={t('web.aiAgents.quotasFailed')} />
        ) : (quotas.data?.list.length ?? 0) === 0 ? (
          <Empty description={t('web.aiAgents.noQuotas')} />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 760 }}
            dataSource={[...(quotas.data?.list ?? [])]}
            columns={[
              {
                title: t('web.aiAgents.quotaScope'),
                key: 'scope',
                width: 190,
                render: (_value, row: AIAgentBudgetPolicyStatus) => (
                  <Space size={4} wrap>
                    <Tag>{row.scope}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {row.period}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: t('web.aiAgents.quotaTarget'),
                key: 'target',
                width: 190,
                render: (_value, row: AIAgentBudgetPolicyStatus) =>
                  row.scopeRef ?? row.providerKey ?? row.agentId ?? '—',
              },
              {
                title: t('web.aiAgents.quotaLimits'),
                key: 'limits',
                render: (_value, row: AIAgentBudgetPolicyStatus) => (
                  <Space size={4} wrap>
                    {row.maxRuns === null ? null : <Tag>{t('web.aiAgents.quotaRuns')}: {row.usage.runs}/{row.maxRuns}</Tag>}
                    {row.maxRequests === null ? null : <Tag>{t('web.aiAgents.quotaRequests')}: {row.usage.requests}/{row.maxRequests}</Tag>}
                    {row.maxTokens === null ? null : <Tag>{t('web.aiAgents.quotaTokens')}: {row.usage.tokens}/{row.maxTokens}</Tag>}
                    {row.maxCostUsd === null ? null : (
                      <Tag>${Number(row.usage.costUsd).toFixed(4)}/${Number(row.maxCostUsd).toFixed(2)}</Tag>
                    )}
                    {row.maxConcurrentRuns === null ? null : (
                      <Tag>
                        {t('web.aiAgents.quotaConcurrent')}: {row.usage.concurrentRuns}/{row.maxConcurrentRuns}
                      </Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: t('web.aiAgents.quotaState'),
                key: 'state',
                width: 130,
                render: (_value, row: AIAgentBudgetPolicyStatus) =>
                  row.exhausted ? (
                    <Tag color="red">{t('web.aiAgents.quotaExhausted')}</Tag>
                  ) : row.warning ? (
                    <Tag color="orange">{t('web.aiAgents.quotaWarning')}</Tag>
                  ) : (
                    <Tag color="green">{t('web.aiAgents.quotaOk')}</Tag>
                  ),
              },
              {
                title: t('web.aiAgents.actions'),
                key: 'actions',
                width: 90,
                render: (_value, row: AIAgentBudgetPolicyStatus) =>
                  canAdmin ? (
                    <Popconfirm
                      title={t('web.aiAgents.quotaDeleteConfirm')}
                      onConfirm={() => removeQuota.mutate(row.id)}
                    >
                      <Button size="small" danger loading={removeQuota.isPending}>
                        {t('web.aiAgents.delete')}
                      </Button>
                    </Popconfirm>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>

      {canAdmin ? (
        <Card
          className="carocrm-card"
          size="small"
          title={t('web.aiAgents.pricing')}
          extra={
            <Button size="small" type="primary" onClick={() => setPricingOpen(true)}>
              {t('web.aiAgents.pricingAdd')}
            </Button>
          }
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            {t('web.aiAgents.pricingHint')}
          </Typography.Paragraph>
          {(pricing.data?.list.length ?? 0) === 0 ? (
            <Empty description={t('web.aiAgents.noPricing')} />
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: 680 }}
              dataSource={[...(pricing.data?.list ?? [])]}
              columns={[
                { title: t('web.aiAgents.provider'), dataIndex: 'providerKey', key: 'providerKey', width: 160 },
                { title: t('web.aiAgents.model'), dataIndex: 'model', key: 'model', width: 160 },
                {
                  title: t('web.aiAgents.pricingInput'),
                  dataIndex: 'inputPricePerMillion',
                  key: 'input',
                  width: 130,
                  render: (value: number) => `${value.toFixed(2)} / 1M`,
                },
                {
                  title: t('web.aiAgents.pricingOutput'),
                  dataIndex: 'outputPricePerMillion',
                  key: 'output',
                  width: 130,
                  render: (value: number) => `${value.toFixed(2)} / 1M`,
                },
                {
                  title: t('web.aiAgents.actions'),
                  key: 'actions',
                  width: 90,
                  render: (_value, row: AIAgentPricingSnapshot) => (
                    <Popconfirm
                      title={t('web.aiAgents.pricingDeleteConfirm')}
                      onConfirm={() => removePricing.mutate(row.id)}
                    >
                      <Button size="small" danger loading={removePricing.isPending}>
                        {t('web.aiAgents.delete')}
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
        </Card>
      ) : null}

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

      <Modal
        open={pricingOpen}
        title={t('web.aiAgents.pricingAdd')}
        onCancel={() => setPricingOpen(false)}
        onOk={() => pricingForm.submit()}
        confirmLoading={savePricing.isPending}
        destroyOnClose
      >
        <Form form={pricingForm} layout="vertical" onFinish={(values) => savePricing.mutate(values)}>
          <Form.Item name="providerKey" label={t('web.aiAgents.provider')} rules={[{ required: true, max: 64 }]}>
            <Input placeholder="openai" />
          </Form.Item>
          <Form.Item name="model" label={t('web.aiAgents.model')} rules={[{ required: true, max: 200 }]} extra={t('web.aiAgents.pricingModelHint')}>
            <Input placeholder="gpt-4o-mini" />
          </Form.Item>
          <Form.Item
            name="inputPricePerMillion"
            label={t('web.aiAgents.pricingInput')}
            rules={[{ required: true }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="outputPricePerMillion"
            label={t('web.aiAgents.pricingOutput')}
            rules={[{ required: true }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="cachedInputPricePerMillion" label={t('web.aiAgents.pricingCached')} initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          {savePricing.isError ? (
            <Alert type="error" showIcon message={savePricing.error instanceof Error ? savePricing.error.message : String(savePricing.error)} />
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={quotaOpen}
        title={t('web.aiAgents.quotaAdd')}
        onCancel={() => setQuotaOpen(false)}
        onOk={() => quotaForm.submit()}
        confirmLoading={saveQuota.isPending}
        destroyOnClose
      >
        <Form form={quotaForm} layout="vertical" onFinish={(values) => saveQuota.mutate(values)} initialValues={{ scope: 'global', period: 'day' }}>
          <Form.Item name="scope" label={t('web.aiAgents.quotaScope')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'global', label: t('web.aiAgents.quotaScopeGlobal') },
                { value: 'user', label: t('web.aiAgents.quotaScopeUser') },
                { value: 'team', label: t('web.aiAgents.quotaScopeTeam') },
                { value: 'agent', label: t('web.aiAgents.quotaScopeAgent') },
                { value: 'provider', label: t('web.aiAgents.quotaScopeProvider') },
              ]}
            />
          </Form.Item>
          <Form.Item name="scopeRef" label={t('web.aiAgents.quotaTarget')} extra={t('web.aiAgents.quotaTargetHint')}>
            <Input placeholder="user / team / provider / agent id" />
          </Form.Item>
          <Form.Item name="period" label={t('web.aiAgents.quotaPeriod')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'day', label: t('web.aiAgents.quotaPeriodDay') },
                { value: 'month', label: t('web.aiAgents.quotaPeriodMonth') },
              ]}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="maxRuns" label={t('web.aiAgents.quotaRuns')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="maxCostUsd" label={t('web.aiAgents.quotaCost')}>
                <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="maxConcurrentRuns" label={t('web.aiAgents.quotaConcurrent')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="warnPercent" label={t('web.aiAgents.quotaWarn')} extra={t('web.aiAgents.quotaWarnHint')}>
            <InputNumber min={1} max={100} style={{ width: '100%' }} />
          </Form.Item>
          {saveQuota.isError ? (
            <Alert type="error" showIcon message={saveQuota.error instanceof Error ? saveQuota.error.message : String(saveQuota.error)} />
          ) : null}
        </Form>
      </Modal>
    </Space>
  );
}
