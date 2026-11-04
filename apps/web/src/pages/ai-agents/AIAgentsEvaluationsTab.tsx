import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Input, Row, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp } from './shared.js';

export function AIAgentsEvaluationsTab({ capabilities }: { readonly capabilities: Record<string, boolean> }) {
  const { message } = AntApp.useApp();
  const canRead = capabilities['use'] === true;
  const canAdmin = capabilities['evaluation'] === true;
  const queryClient = useQueryClient();
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const [selectedSuite, setSelectedSuite] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');

  const agents = useQuery({
    queryKey: ['aiAgents', 'agents', 'eval'],
    queryFn: () => api.aiAgentsAgents({ maxSize: 100 }),
    enabled: canRead,
    staleTime: 30_000,
  });
  const suites = useQuery({
    queryKey: ['aiAgents', 'evalSuites'],
    queryFn: () => api.aiAgentsEvalSuites(),
    enabled: canRead,
    staleTime: 30_000,
  });
  const runs = useQuery({
    queryKey: ['aiAgents', 'evalRuns', selectedAgent],
    queryFn: () => (selectedAgent === undefined ? Promise.resolve({ list: [] }) : api.aiAgentsEvalRuns(selectedAgent)),
    enabled: canRead && selectedAgent !== undefined,
    staleTime: 15_000,
  });

  const ensureSuite = useMutation({
    mutationFn: () => api.aiAgentsEnsureEvalSuite(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'evalSuites'] }),
  });
  const runEval = useMutation({
    mutationFn: () => {
      if (selectedAgent === undefined || selectedSuite === undefined) throw new Error('select agent and suite');
      return api.aiAgentsRunEval(selectedAgent, selectedSuite);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'evalRuns', selectedAgent] });
    },
  });

  /**
   * The built-in required suite carries one `human-review` case, so with the publication gate switched
   * on no agent publishes until a person decides it. `pending_review` is not a state the graders can
   * resolve by themselves; without this control the gate has no exit.
   */
  const decide = useMutation({
    mutationFn: async (input: { runId: string; caseKey: string; decision: 'approve' | 'reject' }) => {
      if (selectedAgent === undefined) throw new Error('Select an agent first.');
      const trimmed = note.trim();
      return api.aiAgentsDecideEval(selectedAgent, input.runId, input.caseKey, input.decision, trimmed === '' ? undefined : trimmed);
    },
    onSuccess: () => {
      setNote('');
      void message.success(t('web.aiAgents.evalDecisionRecorded'));
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'evalRuns', selectedAgent] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!canRead) return <Alert type="warning" showIcon message={t('web.aiAgents.noAccess')} />;

  const suiteOptions = (suites.data?.list ?? []).map((s) => {
    const r = s as Record<string, unknown>;
    return { value: String(r['id']), label: `${String(r['name'])} (${String(r['suiteKey'])})` };
  });
  const agentOptions = (agents.data?.list ?? []).map((a: AIAgentView) => ({ value: a.id, label: a.name ?? a.key }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title={t('web.aiAgents.evalSuites')} size="small">
        {canAdmin ? (
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" loading={ensureSuite.isPending} onClick={() => ensureSuite.mutate()}>
              {t('web.aiAgents.ensureStandardSuite')}
            </Button>
          </Space>
        ) : null}
        {suites.isLoading ? <Skeleton active /> : null}
        {suites.data?.list?.length ? (
          <Table
            size="small"
            rowKey="id"
            dataSource={suites.data.list as Record<string, unknown>[]}
            pagination={false}
            columns={[
              { title: t('web.aiAgents.name'), dataIndex: 'name' },
              { title: t('web.aiAgents.suiteKey'), dataIndex: 'suiteKey' },
              { title: t('web.aiAgents.requiredForPublish'), dataIndex: 'requiredForPublish', render: (v: boolean) => (v ? <Tag color="red">{t('core.common.yes')}</Tag> : <Tag>{t('core.common.no')}</Tag>) },
              { title: t('web.aiAgents.enabled'), dataIndex: 'enabled', render: (v: boolean) => (v ? <Tag color="green">{t('core.common.yes')}</Tag> : <Tag>{t('core.common.no')}</Tag>) },
            ]}
          />
        ) : (
          <EmptyState description={t('web.aiAgents.noSuites')} />
        )}
      </Card>

      <Card title={t('web.aiAgents.runEvaluation')} size="small">
        <Row gutter={8}>
          <Col span={10}>
            <Select
              style={{ width: '100%' }}
              placeholder={t('web.aiAgents.selectAgent')}
              value={selectedAgent}
              onChange={setSelectedAgent}
              options={agentOptions}
              allowClear
            />
          </Col>
          <Col span={10}>
            <Select
              style={{ width: '100%' }}
              placeholder={t('web.aiAgents.selectSuite')}
              value={selectedSuite}
              onChange={setSelectedSuite}
              options={suiteOptions}
              allowClear
            />
          </Col>
          <Col span={4}>
            <Button type="primary" loading={runEval.isPending} onClick={() => runEval.mutate()} disabled={selectedAgent === undefined || selectedSuite === undefined}>
              {t('web.aiAgents.run')}
            </Button>
          </Col>
        </Row>
        {runEval.isError ? <Alert type="error" showIcon message={String(runEval.error)} style={{ marginTop: 8 }} /> : null}
      </Card>

      <Card title={t('web.aiAgents.evalRuns')} size="small">
        {!selectedAgent ? <EmptyState description={t('web.aiAgents.selectAgentFirst')} /> : null}
        {selectedAgent && runs.isLoading ? <Skeleton active /> : null}
        {selectedAgent && runs.data?.list?.length ? (
          <Table
            size="small"
            rowKey="id"
            dataSource={runs.data.list as Record<string, unknown>[]}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('web.aiAgents.status'), dataIndex: 'status', render: (v: string) => <Tag>{v}</Tag> },
              { title: t('web.aiAgents.checksum'), dataIndex: 'configChecksum', render: (v: string) => <Typography.Text code>{v?.slice(0, 12)}</Typography.Text> },
              { title: t('web.aiAgents.createdAt'), dataIndex: 'createdAt', render: (v: string) => formatTimestamp(v) },
            ]}
            expandable={{
              expandedRowRender: (record: Record<string, unknown>) => (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {(((record['results'] as unknown[]) ?? [])).map((r) => {
                    const row = r as Record<string, unknown>;
                    const pendingReview = String(row['grader']) === 'human_review' && String(row['outcome']) === 'pending';
                    return (
                    <div key={String(row['caseId'])}>
                      <Typography.Text>
                        <Tag color={row['outcome'] === 'passed' ? 'green' : row['outcome'] === 'failed' ? 'red' : 'gold'}>{String(row['outcome'])}</Tag>
                        {String(row['title'])}: {String(row['detail'])}
                      </Typography.Text>
                      {pendingReview ? (
                        <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
                          <Typography.Text type="secondary">{t('web.aiAgents.reviewPendingHint')}</Typography.Text>
                          {canAdmin ? (
                            <Space>
                              <Input
                                size="small"
                                style={{ width: 260 }}
                                placeholder={t('web.aiAgents.reviewNotePlaceholder')}
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                              />
                              <Button
                                size="small"
                                type="primary"
                                loading={decide.isPending}
                                onClick={() => decide.mutate({ runId: String(record['id']), caseKey: String(row['caseKey']), decision: 'approve' })}
                              >
                                {t('web.aiAgents.approve')}
                              </Button>
                              <Button
                                size="small"
                                danger
                                loading={decide.isPending}
                                onClick={() => decide.mutate({ runId: String(record['id']), caseKey: String(row['caseKey']), decision: 'reject' })}
                              >
                                {t('web.aiAgents.reject')}
                              </Button>
                            </Space>
                          ) : null}
                        </Space>
                      ) : null}
                    </div>
                  );
                  })}
                </Space>
              ),
            }}
          />
        ) : null}
        {selectedAgent && !runs.isLoading && !runs.data?.list?.length ? <EmptyState description={t('web.aiAgents.noRuns')} /> : null}
      </Card>
    </Space>
  );
}