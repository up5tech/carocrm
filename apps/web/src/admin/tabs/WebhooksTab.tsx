import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { errorMessage } from './identity.js';

/** The events the webhook-integration extension publishes; the endpoint subscribes to a subset. */
const WEBHOOK_EVENTS = ['record.created', 'record.updated', 'record.deleted'] as const;

/**
 * Webhooks tab (PLAN_Phase_20_Settings_UX.md §4.3 row 19): the endpoints the `webhook-integration`
 * extension serves, with delivery history. When the extension is not installed the routes answer 404 —
 * the tab shows that as a state, not as an error toast.
 */
export function WebhooksTab() {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const endpoints = useQuery({ queryKey: ['webhookEndpoints'], queryFn: () => api.webhookEndpoints(), retry: false, staleTime: 30_000 });
  const [editing, setEditing] = useState<string | null | undefined>(undefined);

  const reload = () => void client.invalidateQueries({ queryKey: ['webhookEndpoints'] });
  const notInstalled = endpoints.isError && endpoints.error instanceof Error && endpoints.error.message.toLowerCase().includes('404');

  const toggle = async (row: WebhookEndpointRow, next: boolean) => {
    try {
      await api.updateWebhookEndpoint(row.id, { enabled: next });
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminWebhooks.updateFailed')));
    }
  };

  const remove = async (row: WebhookEndpointRow) => {
    try {
      await api.deleteWebhookEndpoint(row.id);
      void message.success(t('web.adminWebhooks.deleted', { name: row.name }));
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminWebhooks.deleteFailed')));
    }
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminWebhooks.title')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={endpoints.isFetching} onClick={reload}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
              {t('web.adminWebhooks.new')}
            </Button>
          </Space>
        }
      >
        {notInstalled ? (
          <Alert type="info" showIcon message={t('web.adminWebhooks.notInstalled')} description={t('web.adminWebhooks.notInstalledHint')} />
        ) : (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('web.adminWebhooks.hint')} />
            <Table<WebhookEndpointRow>
              rowKey="id"
              size="small"
              scroll={{ x: 'max-content' }}
              loading={endpoints.isLoading}
              dataSource={endpoints.data?.list ?? []}
              locale={{ emptyText: t('web.adminWebhooks.empty') }}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
              expandable={{
                expandedRowRender: (row) => <DeliveriesPanel endpointId={row.id} />,
                rowExpandable: () => true,
              }}
              columns={[
                {
                  title: t('web.common.name'),
                  dataIndex: 'name',
                  render: (value: string, row) => (
                    <div className="carocrm-admin-cell-stack">
                      <Typography.Text strong>{value}</Typography.Text>
                      <Typography.Text type="secondary" className="carocrm-admin-url">
                        {row.url}
                      </Typography.Text>
                    </div>
                  ),
                },
                {
                  title: t('web.adminWebhooks.events'),
                  dataIndex: 'events',
                  render: (value: string[]) =>
                    value.length === 0 ? '---' : (
                      <Space size={4} wrap>
                        {value.map((event) => (
                          <Tag key={event} className="carocrm-admin-tag">
                            {event}
                          </Tag>
                        ))}
                      </Space>
                    ),
                },
                {
                  title: t('web.adminWebhooks.secret'),
                  dataIndex: 'hasSecret',
                  width: 110,
                  render: (value: boolean) => (value ? t('web.adminEmail.passwordStored') : '---'),
                },
                {
                  title: t('web.adminUsers.colStatus'),
                  dataIndex: 'enabled',
                  width: 110,
                  render: (value: boolean, row) => <Switch size="small" checked={value} aria-label={t('web.adminWebhooks.toggleAria', { name: row.name })} onChange={(next) => void toggle(row, next)} />,
                },
                {
                  title: '',
                  key: 'actions',
                  width: 170,
                  render: (_: unknown, row) => (
                    <Space size={4}>
                      <Button size="small" onClick={() => setEditing(row.id)}>
                        {t('web.common.edit')}
                      </Button>
                      <Popconfirm title={t('web.adminWebhooks.deleteConfirm', { name: row.name })} okText={t('web.common.delete')} okButtonProps={{ danger: true }} onConfirm={() => void remove(row)}>
                        <Button size="small" danger>
                          {t('web.common.delete')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>
      {editing !== undefined ? (
        <EndpointFormModal
          endpointId={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function DeliveriesPanel({ endpointId }: { readonly endpointId: string }) {
  const deliveries = useQuery({
    queryKey: ['webhookDeliveries', endpointId],
    queryFn: () => api.webhookDeliveries(endpointId),
    staleTime: 10_000,
  });
  return (
    <Table<WebhookDeliveryRow>
      rowKey="id"
      size="small"
      scroll={{ x: 'max-content' }}
      loading={deliveries.isLoading}
      dataSource={deliveries.data?.list ?? []}
      locale={{ emptyText: t('web.adminWebhooks.noDeliveries') }}
      pagination={false}
      columns={[
        { title: t('web.adminWebhooks.event'), dataIndex: 'eventType' },
        {
          title: t('web.adminUsers.colStatus'),
          dataIndex: 'status',
          width: 110,
          render: (value: string) => (value === 'delivered' ? <Tag color="green">{value}</Tag> : <Tag>{value}</Tag>),
        },
        { title: t('web.adminWebhooks.responseCode'), dataIndex: 'responseCode', width: 120, render: (value: number | null) => (value === null ? '---' : String(value)) },
        { title: t('web.adminWebhooks.lastError'), dataIndex: 'error', render: (value: string | null) => value ?? '---' },
        {
          title: t('web.adminApiKeys.created'),
          dataIndex: 'createdAt',
          width: 180,
          render: (value: string) => new Date(value).toLocaleString(),
        },
      ]}
    />
  );
}

function EndpointFormModal({ endpointId, onClose, onSaved }: { readonly endpointId: string | null; readonly onClose: () => void; readonly onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ name: string; url: string; events: string[]; secret?: string }>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const existing = useQuery({
    queryKey: ['webhookEndpoints', endpointId ?? 'new'],
    queryFn: () => api.webhookEndpoints().then((page) => page.list.find((row) => row.id === endpointId) ?? null),
    enabled: endpointId !== null,
  });
  const loaded = endpointId === null || existing.data !== undefined;

  useEffect(() => {
    if (!loaded) return;
    form.setFieldsValue({
      name: existing.data?.name ?? '',
      url: existing.data?.url ?? '',
      events: existing.data?.events ?? [...WEBHOOK_EVENTS],
      secret: '',
    });
  }, [loaded, existing.data, form]);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    const shared = {
      name: values.name.trim(),
      url: values.url.trim(),
      events: values.events,
      ...(values.secret === undefined || values.secret === '' ? {} : { secret: values.secret }),
    };
    setSaving(true);
    setFailed(null);
    try {
      if (endpointId === null) await api.createWebhookEndpoint(shared);
      else await api.updateWebhookEndpoint(endpointId, shared);
      void message.success(t(endpointId === null ? 'web.adminWebhooks.created' : 'web.adminWebhooks.updated', { name: values.name.trim() }));
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminWebhooks.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={640}
      title={endpointId === null ? t('web.adminWebhooks.createTitle') : t('web.adminWebhooks.editTitle', { name: existing.data?.name ?? '' })}
      okText={t('web.common.save')}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnHidden
    >
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Form form={form} layout="vertical" disabled={!loaded}>
        <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
          <Input maxLength={190} />
        </Form.Item>
        <Form.Item name="url" label={t('web.adminWebhooks.url')} rules={[{ required: true }]} extra={t('web.adminWebhooks.urlHint')}>
          <Input placeholder="https://" />
        </Form.Item>
        <Form.Item name="events" label={t('web.adminWebhooks.events')}>
          <Select mode="multiple" options={WEBHOOK_EVENTS.map((event) => ({ value: event, label: event }))} />
        </Form.Item>
        <Form.Item name="secret" label={t('web.adminWebhooks.secret')} extra={existing.data?.hasSecret === true ? t('web.adminWebhooks.secretKeep') : t('web.adminWebhooks.secretHint')}>
          <Input.Password autoComplete="new-password" placeholder={existing.data?.hasSecret === true ? '••••••••' : undefined} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
