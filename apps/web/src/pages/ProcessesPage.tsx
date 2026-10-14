import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { Metadata, ProcessInstanceView, ProcessView } from '../api/types.js';
import { t } from '../state/i18n.js';
import { useMetadata } from '../state/metadata.js';
import { useProcesses, useProcessInstances } from '../state/processes.js';
import { useSession } from '../state/session.js';

const INSTANCE_STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  waiting: 'warning',
  running: 'processing',
  cancelled: 'default',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  open: 'processing',
  overdue: 'error',
  escalated: 'orange',
  completed: 'success',
  cancelled: 'default',
};

/**
 * Process admin (PLAN §36).
 *
 * The lifecycle mirrors workflows — a draft version is edited, publishing makes it immutable, and
 * enabling lets new instances start — with one addition an approval needs: the *instances* themselves.
 * "Did the discount get approved?" is answered here, per record, with the full audit trail, so this
 * page carries both tabs an administrator needs:
 *
 * ```text
 * Definitions ── publish/enable ──▶ Instances ── each one: tasks + the event trail
 * ```
 *
 * Instances are already scoped server-side (admins see all, participants see their own), so what is
 * rendered here is exactly what the API decided this person may see.
 */
export function ProcessesPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const admin = principal?.type === 'admin';

  const processes = useProcesses(admin);
  const instances = useProcessInstances();
  const metadata = useMetadata();

  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ key: string; name: string; entityType: string }>();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['processes'] });
  };

  const create = useMutation({
    mutationFn: (values: { key: string; name: string; entityType: string }) =>
      api.createProcess({
        key: values.key,
        name: values.name,
        definition: {
          entityType: values.entityType,
          start: 'review',
          nodes: [
            {
              id: 'review',
              type: 'userTask',
              name: t('web.processEditor.defaultUserTaskName'),
              // Whoever the record points at reviews it — change the assignee in the editor.
              assignee: { type: 'recordField', value: 'assignedUserId' },
              outcomes: [
                { value: 'approved', label: t('web.processEditor.defaultApprove'), next: 'done' },
                { value: 'rejected', label: t('web.processEditor.defaultReject'), next: 'rejected' },
              ],
            },
            { id: 'done', type: 'end', name: t('web.processEditor.defaultApproved'), outcome: 'approved' },
            { id: 'rejected', type: 'end', name: t('web.processEditor.defaultRejected'), outcome: 'rejected' },
          ],
        },
      }),
    onSuccess: (process) => {
      void message.success(t('web.processes.created', { name: process.name }));
      setCreating(false);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.publishProcess(id),
    onSuccess: (process) => {
      void message.success(t('web.processes.published', { version: String(process.currentVersion) }));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setProcessEnabled(id, enabled),
    onSuccess: (process) => {
      void message.success(process.isActive ? t('web.processes.enabledNotice', { name: process.name }) : t('web.processes.disabledNotice', { name: process.name }));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProcess(id),
    onSuccess: () => {
      void message.success(t('web.processes.deleted'));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) {
    return <Alert type="error" message={t('web.admin.accessRequiredProcesses')} />;
  }

  const rows: ProcessView[] = processes.data?.list ?? [];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>{t('web.processes.title')}</Typography.Title>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={processes.isFetching || instances.isFetching}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('web.processes.new')}
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          {t('web.processes.subtitle')}
        </Typography.Paragraph>

        <Tabs
          items={[
            {
              key: 'definitions',
              label: t('web.processes.tabDefinitions', { n: String(rows.length) }),
              children: (
                <Table<ProcessView>
                  rowKey="id"
                  size="small"
                  loading={processes.isFetching}
                  dataSource={rows}
                  pagination={false}
                  locale={{ emptyText: t('web.processes.noProcesses') }}
                  columns={[
                    {
                      title: t('web.processes.process'),
                      dataIndex: 'name',
                      render: (name: string, row) => (
                        <Space direction="vertical" size={0}>
                          <Link to={`/admin/processes/${row.id}`}>{name}</Link>
                          <Typography.Text type="secondary">
                            {row.key} · {row.entityType}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: t('web.workflows.version'),
                      width: 180,
                      render: (_value: unknown, row) => (
                        <Space size={4} wrap>
                          <Tag>{t('web.workflows.draftVersion', { version: String(row.currentVersion ?? '—') })}</Tag>
                          {row.publishedVersion !== null ? (
                            <Tag color="blue">{t('web.workflows.publishedVersion', { version: String(row.publishedVersion) })}</Tag>
                          ) : (
                            <Tag>{t('web.workflows.notPublished')}</Tag>
                          )}
                        </Space>
                      ),
                    },
                    {
                      title: t('web.workflows.problems'),
                      render: (_value: unknown, row) =>
                        row.issues.length === 0 ? (
                          <Tag color="green">{t('web.workflows.valid')}</Tag>
                        ) : (
                          <Tag color="red" title={row.issues.map((issue) => issue.message).join('\n')}>
                            {t('web.workflows.issues', { issues: String(row.issues.length) })}
                          </Tag>
                        ),
                    },
                    {
                      title: t('web.workflows.enabled'),
                      width: 110,
                      render: (_value: unknown, row) => (
                        <Switch
                          size="small"
                          checked={row.isActive}
                          disabled={row.publishedVersion === null}
                          onChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                        />
                      ),
                    },
                    {
                      title: '',
                      width: 260,
                      render: (_value: unknown, row) => (
                        <Space>
                          <Link to={`/admin/processes/${row.id}`}>
                            <Button size="small" icon={<EditOutlined />}>
                              {t('web.workflows.edit')}
                            </Button>
                          </Link>
                          <Popconfirm title={t('web.processes.publishConfirm')} description={t('web.processes.publishHint')}>
                            <Button size="small" icon={<ThunderboltOutlined />} disabled={row.issues.length > 0} onClick={() => publish.mutate(row.id)}>
                              {t('web.workflows.publish')}
                            </Button>
                          </Popconfirm>
                          <Popconfirm title={t('web.processes.deleteConfirm')} description={t('web.processes.deleteHint')} >
                            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(row.id)}>
                              {t('web.common.delete')}
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'instances',
              label: t('web.processes.tabInstances', { n: String(instances.data?.total ?? 0) }),
              children: <InstanceTable instances={instances.data?.list ?? []} loading={instances.isFetching} onChanged={refresh} />,
            },
          ]}
        />
      </Card>

      <Modal
        open={creating}
        title={t('web.processes.new')}
        okText={t('web.workflows.createDraft')}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)} initialValues={{ entityType: 'Account' }}>
          <Form.Item
            name="key"
            label={t('web.processes.key')}
            rules={[
              { required: true, message: t('web.processes.keyHint') },
              { pattern: /^[a-z][a-z0-9-]{1,63}$/, message: t('web.processes.keyPattern') },
            ]}
          >
            <Input placeholder="discount-approval" />
          </Form.Item>
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, message: t('web.processes.nameRequired') }]}>
            <Input placeholder={t('web.processes.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="entityType" label={t('web.processes.recordType')} rules={[{ required: true }]}>
            <Select showSearch options={entityOptions(metadata.data)} />
          </Form.Item>
          <Typography.Text type="secondary">
            {t('web.processes.createHint')}
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}

/**
 * Instance table + audit drawer.
 *
 * Each row is a running or finished process on one record; opening it shows the full trail — the
 * tasks with their answers, and every event in order — which is the whole point of an approval
 * engine: any decision can be explained afterwards.
 */
function InstanceTable({ instances, loading, onChanged }: { instances: ProcessInstanceView[]; loading: boolean; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState<ProcessInstanceView | null>(null);

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelProcessInstance(id),
    onSuccess: (instance) => {
      void message.success(t('web.processes.cancelled'));
      setOpen(instance);
      onChanged();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  return (
    <>
      <Table<ProcessInstanceView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={instances}
        pagination={false}
        locale={{ emptyText: t('web.processes.noInstances') }}
        columns={[
          {
            title: t('web.processes.process'),
            dataIndex: 'processName',
            render: (name: string, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Link onClick={() => setOpen(row)}>{name}</Typography.Link>
                <Typography.Text type="secondary">
                  {row.entityType}/{row.entityId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('web.common.status'),
            width: 130,
            render: (_value: unknown, row) => (
              <Space direction="vertical" size={0}>
                <Tag color={INSTANCE_STATUS_COLORS[row.status] ?? 'default'}>{row.status}</Tag>
                {row.outcome !== null ? <Typography.Text type="secondary">{t('web.processes.outcome', { outcome: row.outcome })}</Typography.Text> : null}
              </Space>
            ),
          },
          {
            title: t('web.processes.tasks'),
            width: 140,
            render: (_value: unknown, row) => {
              const openTasks = row.tasks.filter((task) => task.status === 'open' || task.status === 'overdue' || task.status === 'escalated');
              return openTasks.length === 0 ? (
                <Typography.Text type="secondary">{t('web.processes.allAnswered')}</Typography.Text>
              ) : (
                <Space size={4} wrap>
                  {openTasks.map((task) => (
                    <Tag key={task.id} color={TASK_STATUS_COLORS[task.status] ?? 'default'}>
                      {task.name}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          { title: t('web.workflows.started'), width: 160, render: (_value: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' ') },
          { title: t('web.workflows.error'), dataIndex: 'error', render: (error: string | null) => error ?? '—' },
          {
            title: '',
            width: 110,
            render: (_value: unknown, row) =>
              row.status === 'running' || row.status === 'waiting' ? (
                <Popconfirm title={t('web.processes.cancelConfirm')} description={t('web.processes.cancelHint')}>
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => cancel.mutate(row.id)}>
                    {t('web.processes.cancel')}
                  </Button>
                </Popconfirm>
              ) : (
                <Button size="small" onClick={() => setOpen(row)}>
                  {t('web.processes.trail')}
                </Button>
              ),
          },
        ]}
      />

      <Modal open={open !== null} title={open === null ? '' : t('web.processes.auditTrail', { name: open.processName })} footer={null} width={720} onCancel={() => setOpen(null)}>
        {open === null ? null : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label={t('web.common.status')}>
                <Tag color={INSTANCE_STATUS_COLORS[open.status] ?? 'default'}>{open.status}</Tag>
                {open.outcome !== null ? <Tag>{open.outcome}</Tag> : null}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.adminAudit.record')}>
                <Link to={`/${open.entityType}/${open.entityId}`}>
                  {open.entityType}/{open.entityId}
                </Link>
              </Descriptions.Item>
              <Descriptions.Item label={t('web.processes.version')}>{t('web.processes.versionValue', { version: String(open.version ?? '—') })}</Descriptions.Item>
              <Descriptions.Item label={t('web.workflows.started')}>{open.startedAt.slice(0, 19).replace('T', ' ')}</Descriptions.Item>
              {open.error !== null ? (
                <Descriptions.Item label={t('web.workflows.error')} span={2}>
                  <Typography.Text type="danger">{open.error}</Typography.Text>
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              title={() => t('web.processes.tasks')}
              dataSource={open.tasks}
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
              dataSource={open.events}
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
    </>
  );
}

/** Entity names come from metadata: a process attaches to a record type, and the picker spells it. */
function entityOptions(metadata: Metadata | undefined): { value: string; label: string }[] {
  return Object.values(metadata ?? {})
    .filter((entity) => entity.isEntity !== false)
    .map((entity) => ({ value: entity.name, label: entity.label }));
}
