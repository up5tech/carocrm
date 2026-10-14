import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { Metadata, WorkflowRunStatus, WorkflowRunView, WorkflowView } from '../api/types.js';
import { t } from '../state/i18n.js';
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
              name: t('web.workflows.defaultActionName'),
              action: 'updateRecord',
              params: { fields: {} },
            },
          ],
        },
      }),
    onSuccess: (workflow) => {
      void message.success(t('web.workflows.created', { name: workflow.name }));
      setCreating(false);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.publishWorkflow(id),
    onSuccess: (workflow) => {
      void message.success(t('web.workflows.published', { version: String(workflow.currentVersion) }));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setWorkflowEnabled(id, enabled),
    onSuccess: (workflow) => {
      void message.success(workflow.isActive ? t('web.workflows.enabledNotice', { name: workflow.name }) : t('web.workflows.disabledNotice', { name: workflow.name }));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      void message.success(t('web.workflows.deleted'));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) {
    return <Alert type="error" message={t('web.admin.accessRequiredWorkflows')} />;
  }

  const rows: WorkflowView[] = workflows.data?.list ?? [];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={t('web.workflows.title')}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={workflows.isFetching}>
              {t('core.common.refresh')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
              disabled={(catalog.data?.events.length ?? 0) === 0}
            >
              {t('web.workflows.new')}
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          {t('web.workflows.subtitle')}
        </Typography.Paragraph>

        <Table<WorkflowView>
          rowKey="id"
          size="small"
          loading={workflows.isFetching}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: t('web.workflows.empty') }}
          columns={[
            {
              title: t('web.workflows.workflow'),
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
              title: t('web.workflows.version'),
              width: 180,
              render: (_value: unknown, row) => (
                <Space size={4} wrap>
                  <Tag>{t('web.workflows.draftVersion', { version: String(row.currentVersion ?? '—') })}</Tag>
                  {row.publishedVersion !== null ? <Tag color="blue">{t('web.workflows.publishedVersion', { version: String(row.publishedVersion) })}</Tag> : <Tag>{t('web.workflows.notPublished')}</Tag>}
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
                  <Link to={`/admin/workflows/${row.id}`}>
                    <Button size="small" icon={<EditOutlined />}>
                      {t('web.workflows.edit')}
                    </Button>
                  </Link>
                  <Popconfirm title={t('web.workflows.publishConfirm')} description={t('web.workflows.publishHint')}>
                    <Button size="small" icon={<ThunderboltOutlined />} disabled={row.issues.length > 0} onClick={() => publish.mutate(row.id)}>
                      {t('web.workflows.publish')}
                    </Button>
                  </Popconfirm>
                  <Popconfirm title={t('web.workflows.deleteConfirm')} description={t('web.workflows.deleteHint')}>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(row.id)}>
                      {t('web.common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('web.workflows.recentRuns')}>
        <Table<WorkflowRunView>
          rowKey="id"
          size="small"
          loading={runs.isFetching}
          dataSource={runs.data?.list ?? []}
          pagination={false}
          locale={{ emptyText: t('web.workflows.noRuns') }}
          columns={[
            { title: t('web.workflows.workflow'), dataIndex: 'workflowName' },
            {
              title: t('web.adminAudit.record'),
              render: (_value: unknown, row) => `${row.entityType}/${row.entityId}`,
            },
            {
              title: t('web.common.status'),
              dataIndex: 'status',
              render: (status: WorkflowRunStatus, row: WorkflowRunView) => (
                <Space size={4}>
                  <Tag color={RUN_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>
                  {row.attempt > 1 ? <Tag>{t('web.workflows.attempt', { attempt: String(row.attempt) })}</Tag> : null}
                </Space>
              ),
            },
            { title: t('web.workflows.started'), render: (_v: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' ') },
            { title: t('web.workflows.error'), dataIndex: 'error', render: (error: string | null) => error ?? '—' },
          ]}
        />
      </Card>

      <Modal
        open={creating}
        title={t('web.workflows.new')}
        okText={t('web.workflows.createDraft')}
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
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, message: t('web.workflows.nameRequired') }]}>
            <Input placeholder={t('web.workflows.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="eventType" label={t('web.workflows.when')} rules={[{ required: true }]}>
            <Select
              options={(catalog.data?.events ?? []).map((event) => ({
                value: event,
                label: event === 'entity.created' ? t('web.workflows.eventCreated') : event === 'entity.updated' ? t('web.workflows.eventUpdated') : event === 'entity.deleted' ? t('web.workflows.eventDeleted') : t('web.workflows.eventRestored'),
              }))}
            />
          </Form.Item>
          <Form.Item name="entityType" label={t('web.workflows.entityType')} rules={[{ required: true }]} help={t('web.workflows.entityTypeHint')}>
            <Select
              showSearch
              options={[{ value: '*', label: t('web.workflows.anyEntity') }, ...entityOptions(metadata.data)]}
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