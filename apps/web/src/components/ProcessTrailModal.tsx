import { StopOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { App as AntApp, Button, Descriptions, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ProcessInstanceView } from '../api/types.js';
import { t } from '../state/i18n.js';

/** Instance/task status colours, shared by every process surface (admin tables, panels, trail). */
export const INSTANCE_STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  waiting: 'warning',
  running: 'processing',
  cancelled: 'default',
};

export const TASK_STATUS_COLORS: Record<string, string> = {
  open: 'processing',
  overdue: 'error',
  escalated: 'orange',
  completed: 'success',
  cancelled: 'default',
};

/**
 * The audit trail of one instance: its state, the tasks with the answers they received, and every
 * event in order.
 *
 * This is the one screen that makes an approval explainable afterwards, and it is deliberately
 * shared: the administrator's instance tab, the panel on a record and the participant's own list
 * all open the same view, because "who approved this and when" must not depend on where you clicked.
 * The server decides what the caller may see; this component only renders what it was given.
 */
export function ProcessTrailModal({
  instance,
  allowCancel,
  onClose,
  onChanged,
}: {
  instance: ProcessInstanceView | null;
  allowCancel: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [view, setView] = useState<ProcessInstanceView | null>(instance);

  // The parent owns which instance is open; a refetch there has to reach this view too.
  useEffect(() => setView(instance), [instance]);

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelProcessInstance(id),
    onSuccess: (cancelled) => {
      void message.success(t('web.processes.cancelled'));
      setView(cancelled);
      onChanged?.();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const active = view !== null && (view.status === 'running' || view.status === 'waiting');

  return (
    <Modal
      open={view !== null}
      title={view === null ? '' : t('web.processes.auditTrail', { name: view.processName })}
      footer={
        active && allowCancel ? (
          <Popconfirm title={t('web.processes.cancelConfirm')} description={t('web.processes.cancelHint')}>
            <Button danger icon={<StopOutlined />} loading={cancel.isPending} onClick={() => cancel.mutate(view.id)}>
              {t('web.processes.cancel')}
            </Button>
          </Popconfirm>
        ) : null
      }
      width={720}
      onCancel={onClose}
    >
      {view === null ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label={t('web.common.status')}>
              <Tag color={INSTANCE_STATUS_COLORS[view.status] ?? 'default'}>{view.status}</Tag>
              {view.outcome !== null ? <Tag>{view.outcome}</Tag> : null}
            </Descriptions.Item>
            <Descriptions.Item label={t('web.adminAudit.record')}>
              <Link to={`/${view.entityType}/${view.entityId}`}>
                {view.entityType}/{view.entityId}
              </Link>
            </Descriptions.Item>
            <Descriptions.Item label={t('web.processes.version')}>
              {t('web.processes.versionValue', { version: String(view.version ?? '—') })}
            </Descriptions.Item>
            <Descriptions.Item label={t('web.workflows.started')}>{view.startedAt.slice(0, 19).replace('T', ' ')}</Descriptions.Item>
            {view.error !== null ? (
              <Descriptions.Item label={t('web.workflows.error')} span={2}>
                <Typography.Text type="danger">{view.error}</Typography.Text>
              </Descriptions.Item>
            ) : null}
          </Descriptions>

          <Table
            rowKey="id"
            size="small"
            pagination={false}
            title={() => t('web.processes.tasks')}
            dataSource={view.tasks}
            locale={{ emptyText: t('web.processes.noTasks') }}
            columns={[
              { title: t('web.workflowEditor.step'), dataIndex: 'name' },
              {
                title: t('web.common.status'),
                dataIndex: 'status',
                render: (status: string) => <Tag color={TASK_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
              },
              { title: t('web.processes.assignee'), render: (_value: unknown, row) => row.assigneeId ?? row.assigneeRoleId ?? '—' },
              {
                title: t('web.tasks.columnAnswer'),
                render: (_value: unknown, row) =>
                  row.outcome === null ? (
                    '—'
                  ) : (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{row.outcome}</Typography.Text>
                      {row.comment !== null ? <Typography.Text type="secondary">“{row.comment}”</Typography.Text> : null}
                    </Space>
                  ),
              },
              { title: t('web.common.due'), render: (_value: unknown, row) => (row.dueAt === null ? '—' : row.dueAt.slice(0, 19).replace('T', ' ')) },
            ]}
          />

          <Table
            rowKey="id"
            size="small"
            pagination={false}
            title={() => t('web.processes.events')}
            dataSource={view.events}
            locale={{ emptyText: t('web.processes.noEvents') }}
            columns={[
              { title: t('web.adminAudit.when'), width: 160, render: (_value: unknown, row) => row.createdAt.slice(0, 19).replace('T', ' ') },
              { title: t('web.processes.event'), dataIndex: 'type', width: 160, render: (type: string) => <Tag>{type}</Tag> },
              { title: t('web.processes.whatHappened'), dataIndex: 'message' },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
}
