import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { Metadata, ProcessInstanceView, ProcessView } from '../api/types.js';
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
              name: 'Review',
              // Whoever the record points at reviews it — change the assignee in the editor.
              assignee: { type: 'recordField', value: 'assignedUserId' },
              outcomes: [
                { value: 'approved', label: 'Approve', next: 'done' },
                { value: 'rejected', label: 'Reject', next: 'rejected' },
              ],
            },
            { id: 'done', type: 'end', name: 'Approved', outcome: 'approved' },
            { id: 'rejected', type: 'end', name: 'Rejected', outcome: 'rejected' },
          ],
        },
      }),
    onSuccess: (process) => {
      void message.success(`Process "${process.name}" created as a draft.`);
      setCreating(false);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.publishProcess(id),
    onSuccess: (process) => {
      void message.success(`Version ${String(process.currentVersion)} published. Enable the process to let it start.`);
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setProcessEnabled(id, enabled),
    onSuccess: (process) => {
      void message.success(`${process.name} ${process.isActive ? 'enabled' : 'disabled'}.`);
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProcess(id),
    onSuccess: () => {
      void message.success('Process deleted. Its instances keep their history.');
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) {
    return <Alert type="error" message="Administrator access is required to manage processes." />;
  }

  const rows: ProcessView[] = processes.data?.list ?? [];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Processes</Typography.Title>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={processes.isFetching || instances.isFetching}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New process
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          A process is a multi-step approval: it parks at a <strong>user task</strong>, waits for a decision, then runs service
          steps and branches on conditions until it ends. Nothing starts until the definition is <strong>published</strong> and the
          process is <strong>enabled</strong>. Timers on a task mark it overdue and escalate it to someone else.
        </Typography.Paragraph>

        <Tabs
          items={[
            {
              key: 'definitions',
              label: `Definitions (${String(rows.length)})`,
              children: (
                <Table<ProcessView>
                  rowKey="id"
                  size="small"
                  loading={processes.isFetching}
                  dataSource={rows}
                  pagination={false}
                  locale={{ emptyText: 'No processes yet. Create one to add a human approval to a record flow.' }}
                  columns={[
                    {
                      title: 'Process',
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
                      title: 'Version',
                      width: 180,
                      render: (_value: unknown, row) => (
                        <Space size={4} wrap>
                          <Tag>draft v{row.currentVersion ?? '—'}</Tag>
                          {row.publishedVersion !== null ? (
                            <Tag color="blue">published v{row.publishedVersion}</Tag>
                          ) : (
                            <Tag>not published</Tag>
                          )}
                        </Space>
                      ),
                    },
                    {
                      title: 'Problems',
                      render: (_value: unknown, row) =>
                        row.issues.length === 0 ? (
                          <Tag color="green">valid</Tag>
                        ) : (
                          <Tag color="red" title={row.issues.map((issue) => issue.message).join('\n')}>
                            {String(row.issues.length)} issue(s)
                          </Tag>
                        ),
                    },
                    {
                      title: 'Enabled',
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
                              Edit
                            </Button>
                          </Link>
                          <Popconfirm title="Publish this draft?" description="The published version becomes immutable and is what new instances run against.">
                            <Button size="small" icon={<ThunderboltOutlined />} disabled={row.issues.length > 0} onClick={() => publish.mutate(row.id)}>
                              Publish
                            </Button>
                          </Popconfirm>
                          <Popconfirm title="Delete this process?" description="No new instances can start. Running instances keep their own copy of the version." >
                            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(row.id)}>
                              Delete
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
              label: `Instances (${String(instances.data?.total ?? 0)})`,
              children: <InstanceTable instances={instances.data?.list ?? []} loading={instances.isFetching} onChanged={refresh} />,
            },
          ]}
        />
      </Card>

      <Modal
        open={creating}
        title="New process"
        okText="Create draft"
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)} initialValues={{ entityType: 'Account' }}>
          <Form.Item
            name="key"
            label="Key"
            rules={[
              { required: true, message: 'The key is how instances name this process.' },
              { pattern: /^[a-z][a-z0-9-]{1,63}$/, message: 'Lowercase letters, digits and dashes, starting with a letter.' },
            ]}
          >
            <Input placeholder="discount-approval" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'A process needs a name.' }]}>
            <Input placeholder="Discount approval" />
          </Form.Item>
          <Form.Item name="entityType" label="Record type" rules={[{ required: true }]}>
            <Select showSearch options={entityOptions(metadata.data)} />
          </Form.Item>
          <Typography.Text type="secondary">
            The draft starts with one review step and two end states; the editor lets you add service steps, gateways and timers.
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
      void message.success('Process cancelled.');
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
        locale={{ emptyText: 'No process instances yet.' }}
        columns={[
          {
            title: 'Process',
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
            title: 'Status',
            width: 130,
            render: (_value: unknown, row) => (
              <Space direction="vertical" size={0}>
                <Tag color={INSTANCE_STATUS_COLORS[row.status] ?? 'default'}>{row.status}</Tag>
                {row.outcome !== null ? <Typography.Text type="secondary">outcome: {row.outcome}</Typography.Text> : null}
              </Space>
            ),
          },
          {
            title: 'Tasks',
            width: 140,
            render: (_value: unknown, row) => {
              const openTasks = row.tasks.filter((task) => task.status === 'open' || task.status === 'overdue' || task.status === 'escalated');
              return openTasks.length === 0 ? (
                <Typography.Text type="secondary">all answered</Typography.Text>
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
          { title: 'Started', width: 160, render: (_value: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' ') },
          { title: 'Error', dataIndex: 'error', render: (error: string | null) => error ?? '—' },
          {
            title: '',
            width: 110,
            render: (_value: unknown, row) =>
              row.status === 'running' || row.status === 'waiting' ? (
                <Popconfirm title="Cancel this process?" description="Open tasks are cancelled and the flow stops here.">
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => cancel.mutate(row.id)}>
                    Cancel
                  </Button>
                </Popconfirm>
              ) : (
                <Button size="small" onClick={() => setOpen(row)}>
                  Trail
                </Button>
              ),
          },
        ]}
      />

      <Modal open={open !== null} title={open === null ? '' : `${open.processName} — audit trail`} footer={null} width={720} onCancel={() => setOpen(null)}>
        {open === null ? null : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="Status">
                <Tag color={INSTANCE_STATUS_COLORS[open.status] ?? 'default'}>{open.status}</Tag>
                {open.outcome !== null ? <Tag>{open.outcome}</Tag> : null}
              </Descriptions.Item>
              <Descriptions.Item label="Record">
                <Link to={`/${open.entityType}/${open.entityId}`}>
                  {open.entityType}/{open.entityId}
                </Link>
              </Descriptions.Item>
              <Descriptions.Item label="Version">v{open.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Started">{open.startedAt.slice(0, 19).replace('T', ' ')}</Descriptions.Item>
              {open.error !== null ? (
                <Descriptions.Item label="Error" span={2}>
                  <Typography.Text type="danger">{open.error}</Typography.Text>
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              title={() => 'Tasks'}
              dataSource={open.tasks}
              locale={{ emptyText: 'No task was created.' }}
              columns={[
                { title: 'Step', dataIndex: 'name' },
                {
                  title: 'Status',
                  dataIndex: 'status',
                  render: (status: string) => <Tag color={TASK_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
                },
                { title: 'Assignee', render: (_value: unknown, row) => row.assigneeId ?? row.assigneeRoleId ?? '—' },
                {
                  title: 'Answer',
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
                { title: 'Due', render: (_value: unknown, row) => (row.dueAt === null ? '—' : row.dueAt.slice(0, 19).replace('T', ' ')) },
              ]}
            />

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              title={() => 'Events'}
              dataSource={open.events}
              locale={{ emptyText: 'No events recorded.' }}
              columns={[
                { title: 'When', width: 160, render: (_value: unknown, row) => row.createdAt.slice(0, 19).replace('T', ' ') },
                { title: 'Event', dataIndex: 'type', width: 160, render: (type: string) => <Tag>{type}</Tag> },
                { title: 'What happened', dataIndex: 'message' },
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
