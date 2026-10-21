import { CheckOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ProcessTaskView } from '../api/types.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { t } from '../state/i18n.js';
import { useProcessTasks } from '../state/processes.js';
import { useSession } from '../state/session.js';

const TASK_STATUS_COLORS: Record<string, string> = {
  open: 'processing',
  overdue: 'error',
  escalated: 'orange',
  completed: 'success',
  cancelled: 'default',
};

/**
 * My tasks (PLAN §36 "User task").
 *
 * This is the page a participant lives in: the manager approving a discount never opens the admin
 * area, never sees a definition — they see the work assigned to them, in the order it is due, and
 * answer it. A task reached through a role shows up for every member of that role; whoever answers
 * it first ends it for all of them, which is what a candidate group means.
 *
 * The answer itself is the API's business: an outcome the task does not offer, or an answer from
 * someone who no longer holds the task, is refused server-side and reported here verbatim.
 */
export function TasksPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<'answerable' | 'all' | 'completed'>('answerable');
  const [answering, setAnswering] = useState<ProcessTaskView | null>(null);
  const [comment, setComment] = useState('');

  const tasks = useProcessTasks(
    scope === 'answerable' ? {} : { status: scope === 'all' ? 'all' : 'completed' },
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['processes'] });
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

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={(
          <Space>
            <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{t('web.tasks.title')}</Typography.Title>
            <DocsLink docKey="user/activities-and-tasks" compact />
          </Space>
        )}
        extra={
          <Space>
            <Select
              value={scope}
              style={{ width: 160 }}
              onChange={(value: 'answerable' | 'all' | 'completed') => setScope(value)}
              options={[
                { value: 'answerable', label: t('web.tasks.scopeWaiting') },
                { value: 'completed', label: t('web.tasks.scopeAnswered') },
                { value: 'all', label: t('web.tasks.scopeAll') },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={tasks.isFetching}>
              {t('core.common.refresh')}
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          {t('web.tasks.subtitle')}
        </Typography.Paragraph>

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
                  {row.escalatedAt !== null ? <Typography.Text type="secondary">{t('web.tasks.escalated')}</Typography.Text> : null}
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
                  <Typography.Text type={isLate ? 'danger' : 'secondary'}>{row.dueAt.slice(0, 19).replace('T', ' ')}</Typography.Text>
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
                        description={outcome.label.toLowerCase().includes('reject') ? t('web.tasks.rejectHint') : t('web.tasks.continueHint')}
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
                          icon={outcome.label.toLowerCase().includes('approve') ? <CheckOutlined /> : outcome.label.toLowerCase().includes('reject') ? <StopOutlined /> : undefined}
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
      </Card>

      <Modal
        open={answering !== null}
        title={answering === null ? '' : t('web.tasks.answerTitle', { task: answering.name })}
        okText={t('web.tasks.recordAnswer')}
        okButtonProps={{ danger: answering !== null && answering.outcomes.some((outcome) => outcome.label.toLowerCase().includes('reject')) }}
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
            <Typography.Paragraph>
              {t('web.tasks.chooseAnswer')}
            </Typography.Paragraph>
            <Select
              style={{ width: '100%' }}
              value={answering.outcome ?? answering.outcomes[0]?.value ?? null}
              options={answering.outcomes.map((outcome) => ({ value: outcome.value, label: outcome.label }))}
              onChange={(value: string) => setAnswering({ ...answering, outcome: value })}
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

      {!principal ? <Alert type="error" message={t('web.tasks.signIn')} /> : null}
    </Space>
  );
}
