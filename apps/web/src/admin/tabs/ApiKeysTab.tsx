import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { ApiKeyRow, ApiKeySecret, ApiUserRow } from '../../api/types.js';
import { formatDateTime,t } from '../../state/i18n.js';
import { errorMessage, useRolesQuery } from './identity.js';

/**
 * API keys tab (PLAN_Phase_20_Settings_UX.md §4.3 row 12): API accounts, key issuance and revocation
 * against `/ApiUser` and `/ApiKey`.
 *
 * The secret is shown exactly once, in the dialog that reports the call which created it. Every other
 * view — the key list, the account list, a page refresh — can only ever show the key id, because the
 * server stores a hash and has nothing to hand back.
 */
export function ApiKeysTab() {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const roles = useRolesQuery();
  const accounts = useQuery({
    queryKey: ['identity', 'apiUsers'],
    queryFn: () => api.apiUsers(),
    staleTime: 30_000,
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<ApiKeySecret | null>(null);

  const roleNames = new Map((roles.data?.list ?? []).map((role) => [role.id, role.name]));
  const reload = () => void client.invalidateQueries({ queryKey: ['identity'] });

  const issue = async (row: ApiUserRow) => {
    try {
      setSecret(await api.issueApiKey(row.id));
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminApiKeys.issueFailed')));
    }
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminApiKeys.title')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={accounts.isFetching} onClick={reload}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('web.adminApiKeys.new')}
            </Button>
          </Space>
        }
      >
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('web.adminApiKeys.hint')} />
        <Table<ApiUserRow>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          loading={accounts.isLoading}
          dataSource={accounts.data?.list ?? []}
          locale={{ emptyText: t('web.adminApiKeys.empty') }}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (row) => <KeysPanel apiUserId={row.id} onChanged={reload} onIssued={(issued) => setSecret(issued)} />,
            rowExpandable: () => true,
          }}
          columns={[
            { title: t('web.adminUsers.userName'), dataIndex: 'userName' },
            {
              title: t('web.adminUsers.colRoles'),
              dataIndex: 'roles',
              render: (value: string[]) =>
                value.length === 0 ? (
                  <Typography.Text type="secondary">{t('web.adminApiKeys.noRoles')}</Typography.Text>
                ) : (
                  <Space size={4} wrap>
                    {value.map((id) => (
                      <Tag key={id} className="carocrm-admin-tag">
                        {roleNames.get(id) ?? id}
                      </Tag>
                    ))}
                  </Space>
                ),
            },
            { title: t('web.adminApiKeys.activeKeys'), dataIndex: 'activeKeys', width: 110, render: (value: number) => String(value) },
            {
              title: t('web.adminApiKeys.lastUsed'),
              dataIndex: 'lastUsedAt',
              width: 180,
              responsive: ['md'],
              render: (value: string | null) => (value === null ? '---' : formatDateTime(value)),
            },
            {
              title: t('web.adminApiKeys.created'),
              dataIndex: 'createdAt',
              width: 180,
              responsive: ['md'],
              render: (value: string) => formatDateTime(value),
            },
            {
              title: '',
              key: 'actions',
              width: 150,
              render: (_: unknown, row) => (
                <Button size="small" icon={<KeyOutlined />} onClick={() => void issue(row)}>
                  {t('web.adminApiKeys.issue')}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {creating ? (
        <CreateApiUserModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setSecret(created);
            reload();
          }}
        />
      ) : null}
      {secret !== null ? <SecretModal value={secret} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

/** The keys of one account. Revoking is immediate — an unused key sitting active is the risk here. */
function KeysPanel({ apiUserId, onChanged, onIssued }: { readonly apiUserId: string; readonly onChanged: () => void; readonly onIssued: (secret: ApiKeySecret) => void }) {
  const { message } = AntApp.useApp();
  const keys = useQuery({
    queryKey: ['identity', 'apiKeys', apiUserId],
    queryFn: () => api.apiKeys(apiUserId),
    staleTime: 10_000,
  });

  const revoke = async (key: ApiKeyRow) => {
    try {
      await api.revokeApiKey(key.id);
      void message.success(t('web.adminApiKeys.revoked'));
      onChanged();
      void keys.refetch();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminApiKeys.revokeFailed')));
    }
  };

  const rotate = async () => {
    try {
      onIssued(await api.issueApiKey(apiUserId));
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminApiKeys.issueFailed')));
    }
  };

  return (
    <Table<ApiKeyRow>
      size="small"
      rowKey="id"
      scroll={{ x: 'max-content' }}
      loading={keys.isLoading}
      dataSource={keys.data?.list ?? []}
      locale={{ emptyText: t('web.adminApiKeys.noKeys') }}
      pagination={false}
      columns={[
        {
          title: t('web.adminApiKeys.keyId'),
          dataIndex: 'id',
          render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text>,
        },
        { title: t('web.adminApiKeys.created'), dataIndex: 'createdAt', width: 180, render: (value: string) => formatDateTime(value) },
        {
          title: t('web.adminApiKeys.lastUsed'),
          dataIndex: 'lastUsedAt',
          width: 180,
          render: (value: string | null) => (value === null ? '---' : formatDateTime(value)),
        },
        {
          title: t('web.adminUsers.colStatus'),
          key: 'status',
          width: 120,
          render: (_: unknown, row) => (row.revokedAt === null ? <Tag color="green">{t('web.adminApiKeys.statusActive')}</Tag> : <Tag>{t('web.adminApiKeys.statusRevoked')}</Tag>),
        },
        {
          title: '',
          key: 'actions',
          width: 190,
          render: (_: unknown, row) =>
            row.revokedAt === null ? (
              <Space size={4}>
                <Button size="small" icon={<KeyOutlined />} onClick={() => void rotate()}>
                  {t('web.adminApiKeys.rotate')}
                </Button>
                <Popconfirm title={t('web.adminApiKeys.revokeConfirm')} description={t('web.adminApiKeys.revokeHint')} okText={t('web.common.remove')} onConfirm={() => void revoke(row)}>
                  <Button size="small" danger>
                    {t('web.adminApiKeys.revoke')}
                  </Button>
                </Popconfirm>
              </Space>
            ) : null,
        },
      ]}
    />
  );
}

function CreateApiUserModal({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (created: ApiKeySecret) => void }) {
  const [form] = Form.useForm<{ userName: string; assignedRoleIds: string[] }>();
  const roles = useRolesQuery();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    setSaving(true);
    setFailed(null);
    try {
      onCreated(await api.createApiUser({ userName: values.userName.trim(), assignedRoleIds: values.assignedRoleIds }));
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminApiKeys.createFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open width={520} title={t('web.adminApiKeys.createTitle')} okText={t('web.adminApiKeys.createAndShow')} confirmLoading={saving} onCancel={onClose} onOk={() => void submit()} destroyOnHidden>
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Form form={form} layout="vertical">
        <Form.Item name="userName" label={t('web.adminUsers.userName')} rules={[{ required: true, min: 2, max: 100 }]} extra={t('web.adminApiKeys.userNameHint')}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="assignedRoleIds" label={t('web.adminUsers.roles')} extra={t('web.adminApiKeys.rolesHint')}>
          <Select mode="multiple" allowClear optionFilterProp="label" options={(roles.data?.list ?? []).map((role) => ({ value: role.id, label: role.name }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The only moment the secret exists in the browser. Closing this dialog is irreversible by design. */
function SecretModal({ value, onClose }: { readonly value: ApiKeySecret; readonly onClose: () => void }) {
  const pair = `${value.keyId}:${value.secret}`;
  return (
    <Modal open width={560} title={t('web.adminApiKeys.secretTitle', { name: value.userName })} okText={t('core.common.cancel')} onCancel={onClose} onOk={onClose} maskClosable={false}>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('web.adminApiKeys.secretWarning')} />
      <Typography.Paragraph type="secondary">{t('web.adminApiKeys.secretFor')}</Typography.Paragraph>
      <Typography.Paragraph copyable={{ text: pair }} code className="carocrm-admin-secret">
        {pair}
      </Typography.Paragraph>
      <Typography.Text type="secondary">{t('web.adminApiKeys.secretUsage')}</Typography.Text>
    </Modal>
  );
}
