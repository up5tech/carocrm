import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Drawer,
  Empty,
  List,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentRunEventView,AIAgentRunStatus, AIAgentRunToolCallView, AIAgentRunView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp, ResultText, RunStatusTag } from './shared.js';

/**
 * Phase 19-AI.7/19-AI.8 — the run console
 * (PLAN_Phase_19_AI_Agents.md §15.4, §16.1, §20 `19-AI.7`–`19-AI.8`).
 *
 * The six outcome families are visibly distinct: success, partial, failure, blocked, canceled and
 * unknown-outcome each have their own tag and message. The timeline is the server's append-only
 * event list — the SPA does not infer progress from counters.
 *
 * Polling is bounded: it runs only while the visible run (or the list) contains an active state,
 * every four seconds, and stops as soon as the data is terminal.
 */

const ACTIVE: ReadonlySet<AIAgentRunStatus> = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'retry_wait',
  'cancel_requested',
]);

interface RunsTabProps {
  readonly capabilities: Record<string, boolean>;
  readonly focusRunId: string | undefined;
  readonly onFocusConsumed: () => void;
  readonly onOpenApprovals: () => void;
}

export function AIAgentsRunsTab({ capabilities, focusRunId, onFocusConsumed, onOpenApprovals }: RunsTabProps) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [openRunId, setOpenRunId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (focusRunId === undefined) return;
    setOpenRunId(focusRunId);
    onFocusConsumed();
  }, [focusRunId, onFocusConsumed]);

  const runs = useQuery({
    queryKey: ['aiAgents', 'runs', statusFilter, scope],
    queryFn: () =>
      api.aiAgentsRuns({
        maxSize: 50,
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        ...(scope === 'all' ? { scope: 'all' as const } : {}),
      }),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== undefined && data.list.some((run) => ACTIVE.has(run.status)) ? 4_000 : false;
    },
  });

  const detail = useQuery({
    queryKey: ['aiAgents', 'run', openRunId],
    queryFn: () => api.aiAgentsRun(openRunId ?? ''),
    enabled: openRunId !== undefined,
    refetchInterval: (query) => (query.state.data !== undefined && ACTIVE.has(query.state.data.status) ? 4_000 : false),
  });

  const events = useQuery({
    queryKey: ['aiAgents', 'runEvents', openRunId],
    queryFn: () => api.aiAgentsRunEvents(openRunId ?? ''),
    enabled: openRunId !== undefined,
    refetchInterval: detail.data !== undefined && ACTIVE.has(detail.data.status) ? 4_000 : false,
  });
  const toolCalls = useQuery({
    queryKey: ['aiAgents', 'runToolCalls', openRunId],
    queryFn: () => api.aiAgentsRunToolCalls(openRunId ?? ''),
    enabled: openRunId !== undefined,
  });
  const approvals = useQuery({
    queryKey: ['aiAgents', 'runApprovals', openRunId],
    queryFn: () => api.aiAgentsRunApprovals(openRunId ?? ''),
    enabled: openRunId !== undefined && capabilities['approval'] === true,
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runs'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'run'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runEvents'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runToolCalls'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runApprovals'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'approvals'] });
  };

  const cancel = useMutation({
    mutationFn: (id: string) => api.aiAgentsCancelRun(id),
    onSuccess: (run) => {
      void message.success(t('web.aiAgents.runNow', { status: run.status }));
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const execute = useMutation({
    mutationFn: (id: string) => api.aiAgentsExecuteRun(id),
    onSuccess: (result) => {
      void message.success(t('web.aiAgents.runNow', { status: result.run.status }));
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const active = detail.data;
  const pendingApproval = (approvals.data?.list ?? []).find((approval) => approval.status === 'pending');

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t('web.aiAgents.anyStatus')}
          style={{ width: 200 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            'queued',
            'running',
            'waiting_for_approval',
            'succeeded',
            'failed',
            'canceled',
            'blocked_by_policy',
            'outcome_unknown',
          ].map((status) => ({ value: status, label: status.replaceAll('_', ' ') }))}
        />
        {capabilities['audit'] ? (
          <Select
            style={{ width: 170 }}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: t('web.aiAgents.myRuns') },
              { value: 'all', label: t('web.aiAgents.allRuns') },
            ]}
          />
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={() => void runs.refetch()}>
          {t('core.common.reload')}
        </Button>
      </div>

      <Table<AIAgentRunView>
        rowKey="id"
        size="middle"
        loading={runs.isLoading}
        dataSource={runs.data?.list ?? []}
        scroll={{ x: 820 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={t('web.aiAgents.noRuns')} /> }}
        onRow={(run) => ({ onClick: () => setOpenRunId(run.id), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: t('web.aiAgents.status'),
            dataIndex: 'status',
            key: 'status',
            width: 170,
            render: (status: AIAgentRunStatus) => <RunStatusTag status={status} />,
          },
          {
            title: t('web.aiAgents.agent'),
            key: 'agent',
            render: (_value, run) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{run.agentName}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  v{run.agentVersion} · {run.id.slice(0, 8)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.created'),
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 170,
            render: (value: string) => formatTimestamp(value),
          },
          {
            title: t('web.aiAgents.steps'),
            key: 'steps',
            width: 150,
            render: (_value, run) => (
              <Space size={4} wrap>
                <Tag>steps {run.counters.steps}</Tag>
                <Tag>tools {run.counters.toolCalls}</Tag>
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.tokens'),
            key: 'tokens',
            width: 130,
            render: (_value, run) => `${run.counters.inputTokens + run.counters.outputTokens}`,
          },
          {
            title: t('web.aiAgents.outcome'),
            key: 'outcome',
            render: (_value, run) =>
              run.failureMessage !== null ? (
                <Typography.Text type="danger" ellipsis={{ tooltip: run.failureMessage }}>
                  {run.failureMessage}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">{run.result === null ? '—' : t('web.aiAgents.answerReady')}</Typography.Text>
              ),
          },
        ]}
      />

      <Drawer
        open={openRunId !== undefined}
        onClose={() => setOpenRunId(undefined)}
        width={Math.min(780, typeof window === 'undefined' ? 780 : window.innerWidth - 32)}
        title={
          active === undefined ? (
            t('web.aiAgents.run')
          ) : (
            <Space wrap>
              <span>{active.agentName}</span>
              <RunStatusTag status={active.status} />
              <Typography.Text type="secondary">v{active.agentVersion}</Typography.Text>
            </Space>
          )
        }
        extra={
          active === undefined ? null : (
            <Space wrap>
              {ACTIVE.has(active.status) ? (
                <Popconfirm
                  title={t('web.aiAgents.cancelConfirm')}
                  onConfirm={() => cancel.mutate(active.id)}
                  okText={t('core.common.confirm')}
                  cancelText={t('core.common.cancel')}
                >
                  <Button size="small" danger loading={cancel.isPending}>
                    {t('web.aiAgents.cancelRun')}
                  </Button>
                </Popconfirm>
              ) : null}
              {active.status === 'queued' || active.status === 'retry_wait' ? (
                <Button size="small" loading={execute.isPending} onClick={() => execute.mutate(active.id)}>
                  {t('web.aiAgents.executeNow')}
                </Button>
              ) : null}
              {pendingApproval === undefined ? null : (
                <Button size="small" type="primary" onClick={onOpenApprovals}>
                  {t('web.aiAgents.reviewApproval')}
                </Button>
              )}
            </Space>
          )
        }
      >
        {active === undefined ? (
          <Empty description={t('web.aiAgents.loadingRun')} />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {active.status === 'failed' || active.status === 'blocked_by_policy' || active.status === 'outcome_unknown' ? (
              <Alert
                type="error"
                showIcon
                message={active.status.replaceAll('_', ' ')}
                description={active.failureMessage ?? active.failureCategory ?? t('web.aiAgents.noFailureDetail')}
              />
            ) : null}
            {active.status === 'waiting_for_approval' ? (
              <Alert
                type="warning"
                showIcon
                message={t('web.aiAgents.waitingApproval')}
                description={t('web.aiAgents.waitingApprovalHint')}
              />
            ) : null}

            <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label={t('web.aiAgents.created')}>{formatTimestamp(active.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.started')}>{formatTimestamp(active.startedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.finished')}>{formatTimestamp(active.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.trigger')}>{active.trigger}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.steps')}>{active.counters.steps}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.toolCalls')}>{active.counters.toolCalls}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.modelCalls')}>{active.counters.modelCalls}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.tokens')}>
                {active.counters.inputTokens} / {active.counters.outputTokens}
              </Descriptions.Item>
            </Descriptions>

            {active.input.text === null ? null : (
              <div>
                <Typography.Title level={5}>{t('web.aiAgents.task')}</Typography.Title>
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{active.input.text}</Typography.Paragraph>
              </div>
            )}

            <div>
              <Typography.Title level={5}>{t('web.aiAgents.result')}</Typography.Title>
              {active.result === null ? (
                <Typography.Text type="secondary">{t('web.aiAgents.noResultYet')}</Typography.Text>
              ) : (
                <ResultText result={active.result} />
              )}
            </div>

            {approvals.data === undefined || approvals.data.list.length === 0 ? null : (
              <div>
                <Typography.Title level={5}>{t('web.aiAgents.approvals')}</Typography.Title>
                <List
                  size="small"
                  dataSource={[...approvals.data.list]}
                  renderItem={(approval) => (
                    <List.Item>
                      <Space wrap>
                        <Tag color={approval.status === 'pending' ? 'gold' : approval.status === 'executed' ? 'green' : 'default'}>
                          {approval.status}
                        </Tag>
                        <Typography.Text>{approval.summary}</Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            )}

            <div>
              <Typography.Title level={5}>{t('web.aiAgents.toolCalls')}</Typography.Title>
              {toolCalls.data?.list.length === 0 ? (
                <Typography.Text type="secondary">{t('web.aiAgents.noToolCalls')}</Typography.Text>
              ) : (
                <Table<AIAgentRunToolCallView>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={[...(toolCalls.data?.list ?? [])]}
                  scroll={{ x: 560 }}
                  columns={[
                    { title: t('web.aiAgents.tool'), dataIndex: 'toolKey', key: 'toolKey', width: 190 },
                    {
                      title: t('web.aiAgents.status'),
                      dataIndex: 'status',
                      key: 'status',
                      width: 120,
                      render: (status: string) => <Tag color={status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : 'default'}>{status}</Tag>,
                    },
                    { title: t('web.aiAgents.summary'), dataIndex: 'summary', key: 'summary' },
                    {
                      title: t('web.aiAgents.duration'),
                      dataIndex: 'durationMs',
                      key: 'durationMs',
                      width: 100,
                      render: (value: number | null) => (value === null ? '—' : `${String(value)} ms`),
                    },
                  ]}
                />
              )}
            </div>

            <div>
              <Typography.Title level={5}>{t('web.aiAgents.timeline')}</Typography.Title>
              {events.data === undefined || events.data.list.length === 0 ? (
                <Typography.Text type="secondary">{t('web.aiAgents.noEvents')}</Typography.Text>
              ) : (
                <Timeline
                  items={[...events.data.list].map((event: AIAgentRunEventView) => ({
                    color: toneForEvent(event.type),
                    children: (
                      <Space direction="vertical" size={0}>
                        <Space wrap>
                          <Typography.Text strong>{event.type}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {formatTimestamp(event.createdAt)}
                          </Typography.Text>
                        </Space>
                        <Typography.Text>{event.summary}</Typography.Text>
                      </Space>
                    ),
                  }))}
                />
              )}
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
}

function toneForEvent(type: string): string {
  if (type.startsWith('run.completed')) return 'green';
  if (type.includes('failed') || type.includes('unknown') || type.includes('denied')) return 'red';
  if (type.includes('approval')) return 'orange';
  if (type.includes('tool')) return 'blue';
  return 'gray';
}
