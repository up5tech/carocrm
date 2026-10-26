import { AuditOutlined, CarryOutOutlined, CheckOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ProcessInstanceView, ProcessTaskView } from '../api/types.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { PageHeader } from '../components/PageHeader.js';
import { INSTANCE_STATUS_COLORS, ProcessTrailModal } from '../components/ProcessTrailModal.js';
import { formatDateTime, t } from '../state/i18n.js';
import { useProcessInstances, useProcessTasks } from '../state/processes.js';
import { useSession } from '../state/session.js';

const TASK_STATUS_COLORS: Record<string, string> = {
  open: 'processing',
  overdue: 'error',
  escalated: 'orange',
  completed: 'success',
  cancelled: 'default',
};

const INSTANCE_SCOPES = ['all', 'running', 'waiting', 'completed', 'cancelled', 'failed'] as const;
type InstanceScope = (typeof INSTANCE_SCOPES)[number];

type Surface = 'tasks' | 'approvals';

/**
 * My tasks (PLAN §36 "User task") — the participant's one screen.
 *
 * It used to be two pages: "My tasks" answered *what is waiting for me*, and "My approvals" answered
 * *what did I start and where did it end up*. They are two halves of the same question and the same
 * audience, so they now share one page with a surface switch — one sidebar entry, one place to look.
 *
 * The task table is the work: a manager approving a discount never opens the admin area and never
 * sees a definition. A task reached through a role shows up for every member of that role; whoever
 * answers it first ends it for all of them, which is what a candidate group means. The approvals
 * table is the other half: instances scoped server-side to the initiator and to anyone holding a
 * task, each with its trail.
 *
 * The answer itself is the API's business: an outcome the task does not offer, or an answer from
 * someone who no longer holds the task, is refused server-side and reported here verbatim.
 */
export function TasksPage() {
  usePageDocs('user/activities-and-tasks');
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  // The surface lives in the URL so `/tasks?tab=approvals` is a shareable link and the back button
  // returns to the surface the reader was on.
  const surface: Surface = params.get('tab') === 'approvals' ? 'approvals' : 'tasks';
  const [scope, setScope] = useState<'answerable' | 'all' | 'completed'>('answerable');
  const [instanceScope, setInstanceScope] = useState<InstanceScope>('all');
  const [answering, setAnswering] = useState<ProcessTaskView | null>(null);
  const [comment, setComment] = useState('');
  const [trail, setTrail] = useState<ProcessInstanceView | null>(null);

  const tasks = useProcessTasks(
    scope === 'answerable' ? {} : { status: scope === 'all' ? 'all' : 'completed' },
  );
  // The instances list is only fetched when its surface is on screen.
  const instances = useProcessInstances(
    surface === 'approvals' && instanceScope !== 'all' ? { status: instanceScope } : {},
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['processes'] });
  };

  const changeSurface = (next: Surface): void => {
    setParams(next === 'approvals' ? { tab: 'approvals' } : {}, { replace: true });
  };

  const complete = useMutation({
    mutationFn: ({ task, outcome }: { task: ProcessTaskView; outcome: string }) =>
      api.completeProcessTask(task.id, { outcome, ...(comment.trim() === '' ? {} : { comment: comment.trim() }) }),
    onSuccess: (instance) => {
      void message.success(t('web.tasks.answered', { status: instance.status }));
      setAnswering(null);
      setComment('');
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const rows = tasks.data?.list ?? [];
  const overdue = rows.filter((task) => task.status === 'overdue' || task.status === 'escalated').length;
  const instanceRows = instances.data?.list ?? [];
  const refreshing = surface === 'tasks' ? tasks.isFetching : instances.isFetching;

  return (
    <div className="carocrm-page">
      <PageHeader
        title={t('web.tasks.title')}
        subtitle={surface === 'tasks' ? t('web.tasks.subtitle') : t('web.myProcesses.subtitle')}
        actions={
          <Space size={8} wrap>
            <div className="carocrm-surface-switch">
              <Segmented
                value={surface}
                onChange={(value) => changeSurface(value as Surface)}
                options={[
                  {
                    value: 'tasks',
                    label: (
                      <span className="carocrm-surface-switch-label">
                        <CarryOutOutlined />
                        {t('web.tasks.tabTasks')}
                      </span>
                    ),
                  },
                  {
                    value: 'approvals',
                    label: (
                      <span className="carocrm-surface-switch-label">
                        <AuditOutlined />
                        {t('web.tasks.tabApprovals')}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
            <Tooltip title={t('core.common.refresh')}>
              <Button icon={<ReloadOutlined />} aria-label={t('core.common.refresh')} loading={refreshing} onClick={refresh} />
            </Tooltip>
          </Space>
        }
      />

      <Card className="carocrm-card">
        {surface === 'tasks' ? (
          <>
            <div className="carocrm-tasks-toolbar">
              <Segmented
                value={scope}
                onChange={(value) => setScope(value as 'answerable' | 'all' | 'completed')}
                options={[
                  { value: 'answerable', label: t('web.tasks.scopeWaiting') },
                  { value: 'completed', label: t('web.tasks.scopeAnswered') },
                  { value: 'all', label: t('web.tasks.scopeAll') },
                ]}
              />
            </div>

            {overdue > 0 ? (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                message={t('web.tasks.overdue', { overdue })}
                description={t('web.tasks.overdueHint')}
              />
            ) : null}

            <Table<ProcessTaskView>
              rowKey="id"
              size="small"
              loading={tasks.isFetching}
              dataSource={rows}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              locale={{ emptyText: t('web.tasks.empty') }}
              columns={[
                {
                  title: t('web.common.task'),
                  dataIndex: 'name',
                  render: (name: string, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{name}</Typography.Text>
                      <Typography.Text type="secondary">
                        {row.processName} ·{' '}
                        <Link to={`/${row.entityType}/${row.entityId}`}>
                          {row.entityType}/{row.entityId}
                        </Link>
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t('web.common.status'),
                  width: 120,
                  dataIndex: 'status',
                  render: (status: string, row) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={TASK_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>
                      {row.escalatedAt !== null ? (
                        <Typography.Text type="secondary">{t('web.tasks.escalated')}</Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: t('web.common.due'),
                  width: 150,
                  render: (_value: unknown, row) => {
                    if (row.dueAt === null) return '—';
                    const due = new Date(row.dueAt);
                    const isLate = due.getTime() < Date.now() && (row.status === 'open' || row.status === 'overdue');
                    return (
                      <Typography.Text type={isLate ? 'danger' : 'secondary'}>
                        {formatDateTime(row.dueAt)}
                      </Typography.Text>
                    );
                  },
                },
                {
                  title: t('web.tasks.columnAnswer'),
                  width: 300,
                  render: (_value: unknown, row) =>
                    row.status === 'completed' || row.status === 'cancelled' ? (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{row.outcome ?? '—'}</Typography.Text>
                        {row.comment !== null ? <Typography.Text type="secondary">“{row.comment}”</Typography.Text> : null}
                      </Space>
                    ) : (
                      <Space size={4} wrap>
                        {row.outcomes.map((outcome) => (
                          <Popconfirm
                            key={outcome.value}
                            title={t('web.tasks.answerConfirm', { outcome: outcome.label })}
                            description={
                              outcome.label.toLowerCase().includes('reject')
                                ? t('web.tasks.rejectHint')
                                : t('web.tasks.continueHint')
                            }
                            onConfirm={() => {
                              setComment('');
                              // The clicked answer travels with the row into the modal, so the OK
                              // button records what was pressed, not the task's first outcome.
                              setAnswering({ ...row, outcome: outcome.value });
                            }}
                          >
                            <Button
                              size="small"
                              type={outcome.label.toLowerCase().includes('approve') ? 'primary' : 'default'}
                              danger={outcome.label.toLowerCase().includes('reject')}
                              icon={
                                outcome.label.toLowerCase().includes('approve') ? (
                                  <CheckOutlined />
                                ) : outcome.label.toLowerCase().includes('reject') ? (
                                  <StopOutlined />
                                ) : undefined
                              }
                            >
                              {outcome.label}
                            </Button>
                          </Popconfirm>
                        ))}
                      </Space>
                    ),
                },
              ]}
            />
          </>
        ) : (
          <>
            <div className="carocrm-tasks-toolbar">
              <Segmented
                value={instanceScope}
                onChange={(value) => setInstanceScope(value as InstanceScope)}
                options={INSTANCE_SCOPES.map((value) => ({ value, label: t(`web.myProcesses.scope.${value}`) }))}
              />
            </div>

            <Table<ProcessInstanceView>
              rowKey="id"
              size="small"
              loading={instances.isFetching}
              dataSource={instanceRows}
              pagination={false}
              locale={{ emptyText: t('web.myProcesses.empty') }}
              columns={[
                {
                  title: t('web.myProcesses.columnApproval'),
                  render: (_value: unknown, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Link onClick={() => setTrail(row)}>{row.processName}</Typography.Link>
                      <Link to={`/${row.entityType}/${row.entityId}`}>
                        <Typography.Text type="secondary">
                          {row.entityType}/{row.entityId}
                        </Typography.Text>
                      </Link>
                    </Space>
                  ),
                },
                {
                  title: t('web.common.status'),
                  width: 150,
                  render: (_value: unknown, row) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={INSTANCE_STATUS_COLORS[row.status] ?? 'default'}>{row.status}</Tag>
                      {row.outcome !== null ? (
                        <Typography.Text type="secondary">{t('web.processes.outcome', { outcome: row.outcome })}</Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: t('web.myProcesses.columnWaiting'),
                  render: (_value: unknown, row) => {
                    const waiting = row.tasks.filter(
                      (task) => task.status === 'open' || task.status === 'overdue' || task.status === 'escalated',
                    );
                    return waiting.length === 0 ? (
                      <Typography.Text type="secondary">{t('web.recordProcess.noOpenStep')}</Typography.Text>
                    ) : (
                      <Space size={4} wrap>
                        {waiting.map((task) => (
                          <Tag key={task.id}>{task.name}</Tag>
                        ))}
                      </Space>
                    );
                  },
                },
                {
                  title: t('web.workflows.started'),
                  width: 170,
                  render: (_value: unknown, row) => formatDateTime(row.startedAt),
                },
                {
                  title: '',
                  width: 90,
                  render: (_value: unknown, row) => (
                    <Button size="small" onClick={() => setTrail(row)}>
                      {t('web.processes.trail')}
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>

      <Modal
        open={answering !== null}
        title={answering === null ? '' : t('web.tasks.answerTitle', { task: answering.name })}
        okText={t('web.tasks.recordAnswer')}
        okButtonProps={{
          danger: answering !== null && answering.outcomes.some((outcome) => outcome.label.toLowerCase().includes('reject')),
        }}
        confirmLoading={complete.isPending}
        onCancel={() => setAnswering(null)}
        onOk={() => {
          if (answering === null) return;
          // The chosen answer is remembered on the row while the comment is written, so the OK
          // button records exactly what was clicked.
          complete.mutate({ task: answering, outcome: answering.outcome ?? answering.outcomes[0]?.value ?? '' });
        }}
      >
        {answering === null ? null : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {answering.processName} · {answering.entityType}/{answering.entityId}
            </Typography.Text>
            <Typography.Paragraph>{t('web.tasks.chooseAnswer')}</Typography.Paragraph>
            <Segmented
              block
              value={answering.outcome ?? answering.outcomes[0]?.value ?? ''}
              options={answering.outcomes.map((outcome) => ({ value: outcome.value, label: outcome.label }))}
              onChange={(value) => setAnswering({ ...answering, outcome: String(value) })}
            />
            <Input.TextArea
              rows={3}
              value={comment}
              placeholder={t('web.tasks.commentPlaceholder')}
              onChange={(event) => setComment(event.target.value)}
            />
          </Space>
        )}
      </Modal>

      <ProcessTrailModal
        instance={trail}
        allowCancel
        onClose={() => setTrail(null)}
        onChanged={refresh}
      />

      {!principal ? <Alert type="error" message={t('web.tasks.signIn')} /> : null}
    </div>
  );
}
