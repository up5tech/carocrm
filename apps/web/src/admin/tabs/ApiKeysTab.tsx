import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { ApiKeyRow, ApiKeySecret, ApiUserRow } from '../../api/types.js';
import { formatDateTime,t } from '../../state/i18n.js';
import { errorMessage, useRolesQuery } from './identity.js';

/**
 * API keys tab (plans/PLAN_Phase_20_Settings_UX.md §4.3 row 12): API accounts, key issuance and revocation
 * against `/ApiUser` and `/ApiKey`.
 *
 * The secret is shown exactly once, in the dialog that reports the call which created it. Every other
 * view — the key list, the account list, a page refresh — can only ever show the key id, because the
 * server stores a hash and has nothing to hand back.
 */
export function ApiKeysTab() {
  const client = useQueryClient();
  const roles = useRolesQuery();
  const accounts = useQuery({
    queryKey: ['identity', 'apiUsers'],
    queryFn: () => api.apiUsers(),
    staleTime: 30_000,
  });
  const [creating, setCreating] = useState(false);
  const [issuingFor, setIssuingFor] = useState<ApiUserRow | null>(null);
  const [secret, setSecret] = useState<ApiKeySecret | null>(null);

  const roleNames = new Map((roles.data?.list ?? []).map((role) => [role.id, role.name]));
  const reload = () => void client.invalidateQueries({ queryKey: ['identity'] });

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
                <Button size="small" icon={<KeyOutlined />} onClick={() => setIssuingFor(row)}>
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
      {issuingFor !== null ? (
        <IssueKeyModal
          apiUser={issuingFor}
          onClose={() => setIssuingFor(null)}
          onIssued={(issued) => {
            setIssuingFor(null);
            setSecret(issued);
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

  // Phase 23.2: rotation replaces this key in place — the replacement inherits its scope and IP
  // restrictions and the old secret stops working the moment the call returns.
  const rotate = async (key: ApiKeyRow) => {
    try {
      onIssued(await api.rotateApiKey(key.id));
      void keys.refetch();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminApiKeys.rotateFailed')));
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
          title: t('web.adminApiKeys.restrictions'),
          key: 'restrictions',
          width: 220,
          responsive: ['md'],
          render: (_: unknown, row) => (
            <Space size={4} wrap>
              {row.scopes.length === 0 ? (
                <Tag>{t('web.adminApiKeys.unrestricted')}</Tag>
              ) : (
                row.scopes.map((scope) => (
                  <Tag key={scope} color={scope === 'write' ? 'blue' : 'default'}>
                    {scope}
                  </Tag>
                ))
              )}
              {row.allowedIps.length > 0 ? <Tag>{row.allowedIps.join(', ')}</Tag> : null}
            </Space>
          ),
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
                <Button size="small" icon={<KeyOutlined />} onClick={() => void rotate(row)}>
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

/**
 * Phase 23.2 (PLAN §17.2): an additional key may carry a scope restriction (`read`/`write`) and a
 * source-IP allowlist. Both are optional — leaving them empty keeps the unrestricted behaviour.
 */
function KeyOptionsFields() {
  return (
    <>
      <Form.Item name="scopes" label={t('web.adminApiKeys.scopes')} extra={t('web.adminApiKeys.scopesHint')}>
        <Select
          mode="multiple"
          allowClear
          placeholder={t('web.adminApiKeys.unrestricted')}
          options={[
            { value: 'read', label: t('web.adminApiKeys.scopeRead') },
            { value: 'write', label: t('web.adminApiKeys.scopeWrite') },
          ]}
        />
      </Form.Item>
      <Form.Item name="allowedIps" label={t('web.adminApiKeys.allowedIps')} extra={t('web.adminApiKeys.allowedIpsHint')}>
        <Select mode="tags" allowClear tokenSeparators={[',', ' ']} placeholder={t('web.adminApiKeys.anyAddress')} />
      </Form.Item>
    </>
  );
}

function IssueKeyModal({ apiUser, onClose, onIssued }: { readonly apiUser: ApiUserRow; readonly onClose: () => void; readonly onIssued: (secret: ApiKeySecret) => void }) {
  const [form] = Form.useForm<{ scopes?: string[]; allowedIps?: string[] }>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    setSaving(true);
    setFailed(null);
    try {
      onIssued(await api.issueApiKey(apiUser.id, { scopes: values.scopes, allowedIps: values.allowedIps }));
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminApiKeys.issueFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open width={520} title={t('web.adminApiKeys.issueTitle', { name: apiUser.userName })} okText={t('web.adminApiKeys.issue')} confirmLoading={saving} onCancel={onClose} onOk={() => void submit()} destroyOnHidden>
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Form form={form} layout="vertical">
        <KeyOptionsFields />
      </Form>
    </Modal>
  );
}

function CreateApiUserModal({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (created: ApiKeySecret) => void }) {
  const [form] = Form.useForm<{ userName: string; assignedRoleIds: string[]; scopes?: string[]; allowedIps?: string[] }>();
  const roles = useRolesQuery();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    setSaving(true);
    setFailed(null);
    try {
      onCreated(
        await api.createApiUser({
          userName: values.userName.trim(),
          assignedRoleIds: values.assignedRoleIds,
          scopes: values.scopes,
          allowedIps: values.allowedIps,
        }),
      );
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
        <KeyOptionsFields />
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
