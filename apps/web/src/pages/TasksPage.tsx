import { CheckOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ProcessTaskView } from '../api/types.js';
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
      void message.success(`Answer recorded — the process is now ${instance.status}.`);
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
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>My tasks</Typography.Title>}
        extra={
          <Space>
            <Select
              size="small"
              value={scope}
              style={{ width: 160 }}
              onChange={(value: 'answerable' | 'all' | 'completed') => setScope(value)}
              options={[
                { value: 'answerable', label: 'Waiting for me' },
                { value: 'completed', label: 'Answered' },
                { value: 'all', label: 'Everything' },
              ]}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={tasks.isFetching}>
              Refresh
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          Approvals assigned to you — directly, or to any role you are a member of. Answering moves the process
          forward immediately; the person who started it sees the result on the record's process trail.
        </Typography.Paragraph>

        {overdue > 0 ? (
          <Alert
            style={{ marginBottom: 12 }}
            type="warning"
            message={`${String(overdue)} task(s) are past their due time or escalated.`}
            description="Escalated tasks have been reassigned to the escalation contact; answer them to stop the escalation."
          />
        ) : null}

        <Table<ProcessTaskView>
          rowKey="id"
          size="small"
          loading={tasks.isFetching}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: 'Nothing is waiting for you.' }}
          columns={[
            {
              title: 'Task',
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
              title: 'Status',
              width: 120,
              dataIndex: 'status',
              render: (status: string, row) => (
                <Space direction="vertical" size={0}>
                  <Tag color={TASK_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>
                  {row.escalatedAt !== null ? <Typography.Text type="secondary">escalated</Typography.Text> : null}
                </Space>
              ),
            },
            {
              title: 'Due',
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
              title: 'Answer',
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
                        title={`Answer “${outcome.label}”?`}
                        description={outcome.label.toLowerCase().includes('reject') ? 'The process ends here for this record.' : 'The process continues with the next step.'}
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
        title={answering === null ? '' : `Answer: ${answering.name}`}
        okText="Record answer"
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
              Choose the answer, then add a comment if the next step needs one:
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
              placeholder="Why? (kept on the task for the audit trail)"
              onChange={(event) => setComment(event.target.value)}
            />
          </Space>
        )}
      </Modal>

      {!principal ? <Alert type="error" message="Sign in to see your tasks." /> : null}
    </Space>
  );
}
