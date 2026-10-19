import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { EmailAccountInput, EmailAccountRow, EmailTransportInfo } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { errorMessage } from './identity.js';

const SECURITY_MODES = ['none', 'starttls', 'ssl'] as const;

/**
 * Email tab (PLAN_Phase_20_Settings_UX.md §4.3 row 16): the outbound mailboxes and the transport
 * status, over the existing `/EmailAccount` and `/Email` APIs. A mailbox password is write-only —
 * the list can only say whether one is stored — so "masked" is a property of the API, not of the form.
 */
export function EmailTab() {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ['emailAccounts'], queryFn: () => api.emailAccounts(), staleTime: 30_000 });
  const transport = useQuery({ queryKey: ['emailTransport'], queryFn: () => api.emailTransport(), staleTime: 30_000 });
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [verifying, setVerifying] = useState(false);

  const reload = () => {
    void client.invalidateQueries({ queryKey: ['emailAccounts'] });
    void client.invalidateQueries({ queryKey: ['emailTransport'] });
  };

  const verifyTransport = async () => {
    setVerifying(true);
    try {
      const result = await api.verifyEmailTransport();
      if (result.verified) void message.success(t('web.adminEmail.transportVerified'));
      else void message.error(result.error ?? t('web.adminEmail.transportFailed'));
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminEmail.transportFailed')));
    } finally {
      setVerifying(false);
      reload();
    }
  };

  const verifyAccount = async (row: EmailAccountRow) => {
    try {
      const result = await api.verifyEmailAccount(row.id);
      if (result.verified) void message.success(t('web.adminEmail.accountVerified', { name: row.name }));
      else void message.error(result.error ?? t('web.adminEmail.accountFailed', { name: row.name }));
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminEmail.accountFailed', { name: row.name })));
    }
  };

  const remove = async (row: EmailAccountRow) => {
    try {
      await api.deleteEmailAccount(row.id);
      void message.success(t('web.adminEmail.deleted', { name: row.name }));
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminEmail.deleteFailed')));
    }
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminEmail.transportTitle')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={transport.isFetching} onClick={reload}>
              {t('core.common.refresh')}
            </Button>
            <Button onClick={() => void verifyTransport()} loading={verifying}>
              {t('web.adminEmail.verifyTransport')}
            </Button>
          </Space>
        }
      >
        <TransportBody transport={transport.data} />
      </Card>
      <Card
        className="carocrm-card"
        title={t('web.adminEmail.accountsTitle')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
            {t('web.adminEmail.new')}
          </Button>
        }
      >
        <Table<EmailAccountRow>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          loading={accounts.isLoading}
          dataSource={accounts.data ?? []}
          locale={{ emptyText: t('web.adminEmail.empty') }}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            {
              title: t('web.common.name'),
              dataIndex: 'name',
              render: (value: string, row) => (
                <div className="carocrm-admin-cell-stack">
                  <Typography.Text strong>
                    {value} {row.isDefault ? <Tag className="carocrm-admin-tag">{t('web.adminEmail.default')}</Tag> : null}
                  </Typography.Text>
                  <Typography.Text type="secondary">{row.emailAddress}</Typography.Text>
                </div>
              ),
            },
            { title: t('web.adminEmail.smtp'), dataIndex: 'smtpHost', render: (value: string, row) => `${value}:${row.smtpPort} (${row.smtpSecurity})` },
            {
              title: t('web.adminEmail.password'),
              dataIndex: 'hasPassword',
              width: 110,
              render: (value: boolean) => (value ? t('web.adminEmail.passwordStored') : '---'),
            },
            {
              title: t('web.adminUsers.colStatus'),
              dataIndex: 'isActive',
              width: 110,
              render: (value: boolean) => (value ? <Tag color="green">{t('web.adminApiKeys.statusActive')}</Tag> : <Tag>{t('web.adminUsers.statusInactive')}</Tag>),
            },
            {
              title: '',
              key: 'actions',
              width: 240,
              render: (_: unknown, row) => (
                <Space size={4} wrap>
                  <Button size="small" onClick={() => setEditing(row.id)}>
                    {t('web.common.edit')}
                  </Button>
                  <Button size="small" onClick={() => void verifyAccount(row)}>
                    {t('web.adminEmail.verify')}
                  </Button>
                  <Popconfirm title={t('web.adminEmail.deleteConfirm', { name: row.name })} okText={t('web.common.delete')} okButtonProps={{ danger: true }} onConfirm={() => void remove(row)}>
                    <Button size="small" danger>
                      {t('web.common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {editing !== undefined ? (
        <AccountFormModal
          accountId={editing}
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

function TransportBody({ transport }: { readonly transport: EmailTransportInfo | undefined }) {
  if (transport === undefined) return null;
  return (
    <Space wrap size={24}>
      <Typography.Text>
        {t('web.adminEmail.transportMode')}: {transport.mode === 'live' ? <Tag color="green">{t('web.adminEmail.modeLive')}</Tag> : <Tag>{t('web.adminEmail.modeDisabled')}</Tag>}
      </Typography.Text>
      <Typography.Text>
        {t('web.adminEmail.transportName')}: <Typography.Text code>{transport.name}</Typography.Text>
      </Typography.Text>
      <Typography.Text>
        {t('web.adminEmail.fromAddress')}: {transport.fromAddress ?? '---'}
      </Typography.Text>
    </Space>
  );
}

/** antd forms read back optional values, so the form keeps its own concrete shape. */
interface AccountFormValues {
  name: string;
  emailAddress: string;
  fromName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  smtpUsername: string;
  signature: string;
  isActive: boolean;
  isDefault: boolean;
  smtpPassword: string;
}

function AccountFormModal({ accountId, onClose, onSaved }: { readonly accountId: string | null; readonly onClose: () => void; readonly onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<AccountFormValues>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const existing = useQuery({
    queryKey: ['emailAccounts', accountId ?? 'new'],
    queryFn: () => api.emailAccounts().then((list) => list.find((row) => row.id === accountId) ?? null),
    enabled: accountId !== null,
  });
  const loaded = accountId === null || existing.data !== undefined;

  useEffect(() => {
    if (!loaded) return;
    const account = existing.data;
    form.setFieldsValue({
      name: account?.name ?? '',
      emailAddress: account?.emailAddress ?? '',
      fromName: account?.fromName ?? '',
      smtpHost: account?.smtpHost ?? '',
      smtpPort: account?.smtpPort ?? 587,
      smtpSecurity: account?.smtpSecurity ?? 'starttls',
      smtpUsername: account?.smtpUsername ?? '',
      signature: account?.signature ?? '',
      isActive: account?.isActive ?? true,
      isDefault: account?.isDefault ?? false,
      smtpPassword: '',
    });
  }, [loaded, existing.data, form]);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    const input: EmailAccountInput = {
      name: values.name.trim(),
      emailAddress: values.emailAddress.trim(),
      fromName: values.fromName.trim() === '' ? null : values.fromName.trim(),
      smtpHost: values.smtpHost.trim(),
      smtpPort: values.smtpPort,
      smtpSecurity: values.smtpSecurity,
      smtpUsername: values.smtpUsername.trim() === '' ? null : values.smtpUsername.trim(),
      signature: values.signature.trim() === '' ? null : values.signature,
      isActive: values.isActive,
      isDefault: values.isDefault,
      // Omitted means "keep the current one" — the API can clear a password, but the form never
      // clears by accident: leaving the field blank keeps what is stored.
      ...(values.smtpPassword === '' ? {} : { smtpPassword: values.smtpPassword }),
    };
    setSaving(true);
    setFailed(null);
    try {
      if (accountId === null) await api.createEmailAccount(input);
      else await api.updateEmailAccount(accountId, input);
      void message.success(t(accountId === null ? 'web.adminEmail.created' : 'web.adminEmail.updated', { name: values.name.trim() }));
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminEmail.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={640}
      title={accountId === null ? t('web.adminEmail.createTitle') : t('web.adminEmail.editTitle', { name: existing.data?.name ?? '' })}
      okText={t('web.common.save')}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnHidden
    >
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Form form={form} layout="vertical" disabled={!loaded}>
        <div className="carocrm-admin-form--two">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, max: 190 }]}>
            <Input maxLength={190} />
          </Form.Item>
          <Form.Item name="emailAddress" label={t('web.adminEmail.address')} rules={[{ required: true }]}>
            <Input type="email" autoComplete="off" />
          </Form.Item>
          <Form.Item name="fromName" label={t('web.adminEmail.fromName')}>
            <Input maxLength={190} />
          </Form.Item>
          <Form.Item name="smtpHost" label={t('web.adminEmail.smtpHost')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="smtpPort" label={t('web.adminEmail.smtpPort')} rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="smtpSecurity" label={t('web.adminEmail.smtpSecurity')} initialValue="starttls">
            <Select options={SECURITY_MODES.map((mode) => ({ value: mode, label: mode }))} />
          </Form.Item>
          <Form.Item name="smtpUsername" label={t('web.adminEmail.smtpUsername')}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="smtpPassword" label={t('web.adminEmail.smtpPassword')} extra={existing.data?.hasPassword === true ? t('web.adminEmail.passwordKeep') : t('web.adminEmail.passwordWriteOnly')}>
            <Input.Password autoComplete="new-password" placeholder={existing.data?.hasPassword === true ? '••••••••' : undefined} />
          </Form.Item>
        </div>
        <Form.Item name="signature" label={t('web.adminEmail.signature')}>
          <Input.TextArea rows={3} maxLength={10000} />
        </Form.Item>
        <div className="carocrm-admin-form--two">
          <Form.Item name="isActive" label={t('web.adminUsers.active')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="isDefault" label={t('web.adminEmail.isDefault')} valuePropName="checked" extra={t('web.adminEmail.isDefaultHint')}>
            <Switch />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
