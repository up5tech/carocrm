import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { Metadata, WorkflowRunStatus, WorkflowRunView, WorkflowView } from '../api/types.js';
import { useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';
import { useWorkflowCatalog, useWorkflowRuns, useWorkflows } from '../state/workflows.js';

const RUN_STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  waiting: 'warning',
  running: 'processing',
  cancelled: 'default',
};

/**
 * Workflows admin (PLAN §35).
 *
 * Creating a workflow is only the start of the lifecycle an administrator has to understand, so this
 * page is explicit about the three separate states a definition can be in:
 *
 * ```text
 * draft ──publish──▶ published (immutable, what runs execute)
 *   ▲                     │
 *   └───edit creates a new draft, never touching the published version
 * ```
 *
 * Enabling is separate from publishing on purpose: publishing says "this definition is correct",
 * enabling says "run it now".
 */
export function WorkflowsPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const admin = principal?.type === 'admin';
  const workflows = useWorkflows(admin);

  const runs = useWorkflowRuns(admin);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ name: string; eventType: string; entityType: string }>();
  const catalog = useWorkflowCatalog(admin);
  const metadata = useMetadata();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['workflows'] });
  };

  const create = useMutation({
    mutationFn: (values: { name: string; eventType: string; entityType: string }) =>
      api.createWorkflow({
        name: values.name,
        definition: {
          trigger: { eventType: values.eventType, entityType: values.entityType },
          start: 'start',
          nodes: [
            {
              id: 'start',
              type: 'action',
              name: 'Update the record',
              action: 'updateRecord',
              params: { fields: {} },
            },
          ],
        },
      }),
    onSuccess: (workflow) => {
      void message.success(`Workflow "${workflow.name}" created as a draft.`);
      setCreating(false);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.publishWorkflow(id),
    onSuccess: (workflow) => {
      void message.success(`Version ${String(workflow.currentVersion)} published. Enable the workflow to let it run.`);
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setWorkflowEnabled(id, enabled),
    onSuccess: (workflow) => {
      void message.success(`${workflow.name} ${workflow.isActive ? 'enabled' : 'disabled'}.`);
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      void message.success('Workflow deleted.');
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) {
    return <Alert type="error" message="Administrator access is required to manage workflows." />;
  }

  const rows: WorkflowView[] = workflows.data?.list ?? [];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="Workflows"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={workflows.isFetching}>
              Refresh
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
              disabled={(catalog.data?.events.length ?? 0) === 0}
            >
              New workflow
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          A workflow reacts to an entity event and runs a small graph of conditions and actions. Nothing runs until the
          definition is <strong>published</strong> and the workflow is <strong>enabled</strong>; editing a published workflow creates a
          new version and leaves the running one alone.
        </Typography.Paragraph>

        <Table<WorkflowView>
          rowKey="id"
          size="small"
          loading={workflows.isFetching}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: 'No workflows yet. Create one to automate a recurring process.' }}
          columns={[
            {
              title: 'Workflow',
              dataIndex: 'name',
              render: (name: string, row) => (
                <Space direction="vertical" size={0}>
                  <Link to={`/admin/workflows/${row.id}`}>{name}</Link>
                  <Typography.Text type="secondary">
                    {row.eventType} · {row.entityType}
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
                  {row.publishedVersion !== null ? <Tag color="blue">published v{row.publishedVersion}</Tag> : <Tag>not published</Tag>}
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
                  <Link to={`/admin/workflows/${row.id}`}>
                    <Button size="small" icon={<EditOutlined />}>
                      Edit
                    </Button>
                  </Link>
                  <Popconfirm title="Publish this draft?" description="The published version becomes immutable and is what runs use.">
                    <Button size="small" icon={<ThunderboltOutlined />} disabled={row.issues.length > 0} onClick={() => publish.mutate(row.id)}>
                      Publish
                    </Button>
                  </Popconfirm>
                  <Popconfirm title="Delete this workflow?" description="Its run history is removed too. This cannot be undone.">
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(row.id)}>
                      Delete
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Recent runs">
        <Table<WorkflowRunView>
          rowKey="id"
          size="small"
          loading={runs.isFetching}
          dataSource={runs.data?.list ?? []}
          pagination={false}
          locale={{ emptyText: 'No workflow has run yet.' }}
          columns={[
            { title: 'Workflow', dataIndex: 'workflowName' },
            {
              title: 'Record',
              render: (_value: unknown, row) => `${row.entityType}/${row.entityId}`,
            },
            {
              title: 'Status',
              dataIndex: 'status',
              render: (status: WorkflowRunStatus, row: WorkflowRunView) => (
                <Space size={4}>
                  <Tag color={RUN_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>
                  {row.attempt > 1 ? <Tag>attempt {row.attempt}</Tag> : null}
                </Space>
              ),
            },
            { title: 'Started', render: (_v: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' ') },
            { title: 'Error', dataIndex: 'error', render: (error: string | null) => error ?? '—' },
          ]}
        />
      </Card>

      <Modal
        open={creating}
        title="New workflow"
        okText="Create draft"
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => create.mutate(values)}
          initialValues={{ eventType: catalog.data?.events[0] ?? 'entity.created', entityType: '*' }}
        >
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'A workflow needs a name.' }]}>
            <Input placeholder="Notify owner on big deal" />
          </Form.Item>
          <Form.Item name="eventType" label="When" rules={[{ required: true }]}>
            <Select
              options={(catalog.data?.events ?? []).map((event) => ({
                value: event,
                label: event === 'entity.created' ? 'A record is created' : event === 'entity.updated' ? 'A record is updated' : event === 'entity.deleted' ? 'A record is deleted' : 'A record is restored',
              }))}
            />
          </Form.Item>
          <Form.Item name="entityType" label="Entity type" rules={[{ required: true }]} help="Use * for every entity type.">
            <Select
              showSearch
              options={[{ value: '*', label: 'Any entity' }, ...entityOptions(metadata.data)]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/**
 * Entity names come from metadata: a workflow trigger is an entity name, and offering them is the
 * difference between "know the exact spelling" and "pick it".
 */
function entityOptions(metadata: Metadata | undefined): { value: string; label: string }[] {
  return Object.values(metadata ?? {})
    .filter((entity) => entity.isEntity)
    .map((entity) => ({ value: entity.name, label: entity.label }));
}