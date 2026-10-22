import { DeleteOutlined, EditOutlined, MessageOutlined, PhoneOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../api/client.js';
import type {
  VoiceCommunicationsSettings,
  VoiceEndpointInput,
  VoiceEndpointView,
  VoiceProviderAccountInput,
  VoiceProviderAccountPatch,
  VoiceProviderAccountView,
  VoiceProviderInfo,
} from '../../api/types.js';
import { timezoneOptions } from '../../components/timezones.js';
import { t } from '../../state/i18n.js';
import { useModuleDocument } from '../module-document.js';
import { usePublishTabActions } from '../shell.js';

/**
 * Phase 19-VC.18 — the Voice & Communications administration screen.
 *
 * One tab, two kinds of configuration:
 *  - the validated `voiceCommunications` document (channels, policy, webhook, media, AI), edited as
 *    a draft and saved through the module's own endpoint, which refuses an invalid value with its
 *    reason; and
 *  - provider accounts and their sender numbers, which save immediately because they are records,
 *    not part of the document.
 *
 * A credential and a webhook secret are write-only in the API, so the fields start blank and an
 * empty field means "keep the stored value". Nothing here can read a stored secret back.
 */

const FEATURE_KEYS = ['voice', 'sms', 'mms', 'whatsapp', 'recordings', 'transcripts', 'aiEnrichment'] as const;

const CAPABILITY_KEYS = [
  'voice.outboundCall',
  'voice.inboundEvents',
  'voice.callStatusCallbacks',
  'voice.callAnswer',
  'voice.callHangup',
  'voice.recordingMetadata',
  'voice.recordingDownload',
  'messaging.sms.send',
  'messaging.sms.receive',
  'messaging.mms.send',
  'messaging.mms.receive',
  'messaging.whatsapp.send',
  'messaging.whatsapp.receive',
  'messaging.deliveryStatus',
  'messaging.templates',
  'messaging.media',
  'webhook.signatureValidation',
  'provider.healthCheck',
] as const;

const CHANNEL_KEYS = ['voice', 'sms', 'mms', 'whatsapp'] as const;

interface AccountFormValues {
  key: string;
  providerKey: string;
  label: string;
  environment: 'test' | 'production';
  capabilities: string[];
  config: string;
  credential?: string;
  webhookSecret?: string;
}

interface EndpointFormValues {
  key: string;
  channel: string;
  address: string;
  active: boolean;
}

export function VoiceCommunicationsSettingsTab() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<VoiceCommunicationsSettings>();
  const [dirty, setDirty] = useState(false);

  const document = useModuleDocument<VoiceCommunicationsSettings>({
    queryKey: ['voiceCommunications', 'settings'],
    load: () => api.voiceCommunicationsSettings(),
    persist: (patch) => api.saveVoiceCommunicationsSettings(patch),
    savedMessage: t('voice.settings.saved'),
    failedMessage: t('voice.settings.saveFailed'),
    onSaved: () => void message.success(t('voice.settings.saved')),
  });

  useEffect(() => {
    if (document.value !== undefined) {
      form.setFieldsValue(document.value as Parameters<typeof form.setFieldsValue>[0]);
      setDirty(false);
    }
  }, [document.value, form]);

  usePublishTabActions({
    dirty,
    saving: document.saving,
    canSave: !document.loading,
    modifiedAt: document.modifiedAt,
    modifiedBy: document.modifiedBy,
    onSave: () => form.submit(),
    onDiscard: () => {
      if (document.value !== undefined) {
        form.setFieldsValue(document.value as Parameters<typeof form.setFieldsValue>[0]);
      }
      setDirty(false);
      document.discard();
    },
    onReload: () => {
      setDirty(false);
      form.resetFields();
      void document.reload();
    },
  });

  // The default-account select and the account table share one cache entry, so creating an account
  // here makes it selectable without a reload.
  const accounts = useQuery({
    queryKey: ['voiceCommunications', 'accounts'],
    queryFn: () => api.voiceCommunicationsAccounts(),
    staleTime: 15_000,
  });

  if (document.loading || document.value === undefined) {
    return <Alert type="info" showIcon message={t('web.adminShell.loading')} />;
  }

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={document.failed}
          description={t('voice.settings.failedHint')}
        />
      ) : null}
      {document.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('voice.page.warnings')}
          description={
            <ul className="carocrm-admin-warnings">
              {document.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <Space align="center" style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }} wrap>
        <Typography.Text type="secondary" className="carocrm-admin-document-meta">
          {t('web.adminShell.documentName', { name: 'voiceCommunications' })} ·{' '}
          {t('web.adminShell.versionLabel')} {document.version}
        </Typography.Text>
        <Space>
          <Button icon={<PhoneOutlined />} onClick={() => navigate('/voice-communications')}>
            {t('voice.settings.diagnostics')}
          </Button>
          <Button icon={<MessageOutlined />} onClick={() => navigate('/voice-inbox')}>
            {t('voice.settings.inbox')}
          </Button>
        </Space>
      </Space>

      <Form
        form={form}
        layout="vertical"
        disabled={document.value === undefined}
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => {
          void document.save(values).then((saved) => {
            if (saved) setDirty(false);
          });
        }}
      >
        <Card
          className="carocrm-card"
          title={t('voice.settings.features')}
          extra={t('voice.settings.featuresHint')}
          style={{ marginBottom: 16 }}
        >
          <Row gutter={[16, 4]}>
            {FEATURE_KEYS.map((key) => (
              <Col key={key} xs={24} md={12} lg={8}>
                <Form.Item
                  name={['features', key]}
                  label={t(`voice.settings.featureLabels.${key}`)}
                  valuePropName="checked"
                  style={{ marginBottom: 8 }}
                >
                  <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Card>

        <Row gutter={16}>
          <Col xs={24} lg={8}>
            <Card
              className="carocrm-card"
              title={t('voice.settings.provider')}
              extra={t('voice.settings.providerHint')}
              style={{ marginBottom: 16 }}
            >
              <Form.Item
                name={['provider', 'defaultAccountKey']}
                label={t('voice.settings.defaultAccount')}
                extra={t('voice.settings.defaultAccountHint')}
                normalize={(value: string | undefined) => value ?? ''}
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder={t('voice.settings.defaultAccountNone')}
                  options={(accounts.data?.list ?? []).map((account) => ({
                    value: account.key,
                    label: `${account.label} (${account.key})`,
                  }))}
                />
              </Form.Item>
            </Card>
          </Col>

          <Col xs={24} lg={16}>
            <Card
              className="carocrm-card"
              title={t('voice.settings.policy')}
              extra={t('voice.settings.policyHint')}
              style={{ marginBottom: 16 }}
            >
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['policy', 'defaultRegion']}
                    label={t('voice.settings.defaultRegion')}
                    extra={t('voice.settings.defaultRegionHint')}
                    rules={[{ len: 2, message: t('voice.settings.defaultRegionHint') }]}
                  >
                    <Input maxLength={2} placeholder="US" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['policy', 'whatsappWindowHours']}
                    label={t('voice.settings.whatsappWindowHours')}
                    extra={t('voice.settings.whatsappWindowHoursHint')}
                  >
                    <InputNumber min={1} max={168} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['policy', 'maxMessageLength']}
                    label={t('voice.settings.maxMessageLength')}
                    extra={t('voice.settings.maxMessageLengthHint')}
                  >
                    <InputNumber min={1} max={10_000} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['policy', 'maxSendsPerMinute']}
                    label={t('voice.settings.maxSendsPerMinute')}
                    extra={t('voice.settings.maxSendsPerMinuteHint')}
                  >
                    <InputNumber min={0} max={100_000} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                {(['sms', 'mms', 'whatsapp'] as const).map((channel) => (
                  <Col key={channel} xs={24} md={8}>
                    <Form.Item
                      name={['policy', 'requireConsent', channel]}
                      label={t(`voice.settings.requireConsent.${channel}`)}
                      valuePropName="checked"
                      style={{ marginBottom: 8 }}
                    >
                      <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                    </Form.Item>
                  </Col>
                ))}
              </Row>

              <Typography.Text strong>{t('voice.settings.quietHours')}</Typography.Text>
              <Row gutter={16} style={{ marginTop: 8 }}>
                <Col xs={24} md={6}>
                  <Form.Item name={['policy', 'quietHours', 'enabled']} label={t('voice.settings.quietHoursEnabled')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item name={['policy', 'quietHours', 'start']} label={t('voice.settings.quietHoursStart')}>
                    <Input placeholder="21:00" maxLength={5} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item name={['policy', 'quietHours', 'end']} label={t('voice.settings.quietHoursEnd')}>
                    <Input placeholder="08:00" maxLength={5} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item name={['policy', 'quietHours', 'timezone']} label={t('voice.settings.quietHoursTimezone')}>
                    <Select showSearch options={timezoneOptions()} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} lg={12}>
            <Card
              className="carocrm-card"
              title={t('voice.settings.webhook')}
              extra={t('voice.settings.webhookHint')}
              style={{ marginBottom: 16 }}
            >
              <Form.Item
                name={['webhook', 'replayWindowSeconds']}
                label={t('voice.settings.replayWindowSeconds')}
                extra={t('voice.settings.replayWindowSecondsHint')}
              >
                <InputNumber min={30} max={900} style={{ width: '100%' }} />
              </Form.Item>
            </Card>

            <Card
              className="carocrm-card"
              title={t('voice.settings.ai')}
              extra={t('voice.settings.aiHint')}
              style={{ marginBottom: 16 }}
            >
              <Form.Item
                name={['ai', 'connectionKey']}
                label={t('voice.settings.connectionKey')}
                extra={t('voice.settings.connectionKeyHint')}
              >
                <Input maxLength={64} />
              </Form.Item>
              <Form.Item name={['ai', 'model']} label={t('voice.settings.model')} extra={t('voice.settings.modelHint')}>
                <Input maxLength={128} />
              </Form.Item>
              <Form.Item
                name={['ai', 'maxTranscriptChars']}
                label={t('voice.settings.maxTranscriptChars')}
                extra={t('voice.settings.maxTranscriptCharsHint')}
              >
                <InputNumber min={500} max={200_000} style={{ width: '100%' }} />
              </Form.Item>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card
              className="carocrm-card"
              title={t('voice.settings.media')}
              extra={t('voice.settings.mediaHint')}
              style={{ marginBottom: 16 }}
            >
              <Form.Item name={['media', 'fetchMode']} label={t('voice.settings.fetchMode')} extra={t('voice.settings.fetchModeHint')}>
                <Select
                  options={[
                    { value: 'off', label: t('voice.settings.fetchModeOff') },
                    { value: 'privateStorage', label: t('voice.settings.fetchModePrivate') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name={['media', 'allowedHosts']}
                label={t('voice.settings.allowedHosts')}
                extra={t('voice.settings.allowedHostsHint')}
              >
                <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="media.example.com" />
              </Form.Item>
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item name={['media', 'maxBytes']} label={t('voice.settings.maxBytes')} extra={t('voice.settings.maxBytesHint')}>
                    <InputNumber min={1024} max={104_857_600} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['media', 'retentionDays']}
                    label={t('voice.settings.retentionDays')}
                    extra={t('voice.settings.retentionDaysHint')}
                  >
                    <InputNumber min={1} max={3_650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name={['media', 'allowLoopback']}
                    label={t('voice.settings.allowLoopback')}
                    extra={t('voice.settings.allowLoopbackHint')}
                    valuePropName="checked"
                  >
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item
                name={['media', 'noticeRequired']}
                label={t('voice.settings.noticeRequired')}
                extra={t('voice.settings.noticeRequiredHint')}
                valuePropName="checked"
              >
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
            </Card>
          </Col>
        </Row>
      </Form>

      <ProviderAccountsSection accounts={accounts.data?.list ?? []} loading={accounts.isLoading} />
    </div>
  );
}

/**
 * Accounts save immediately: enabling, rotating a credential and registering a sender number are
 * administrative actions with their own audit entries, not fields of the delivery policy document.
 */
function ProviderAccountsSection({ accounts, loading }: { accounts: readonly VoiceProviderAccountView[]; loading: boolean }) {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const [accountForm] = Form.useForm<AccountFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VoiceProviderAccountView | null>(null);
  const [adapterKey, setAdapterKey] = useState('');

  const catalog = useQuery({
    queryKey: ['voiceCommunications', 'providers'],
    queryFn: () => api.voiceProviderCatalog(),
    staleTime: 60_000,
  });

  const invalidateAccounts = (): void => {
    void client.invalidateQueries({ queryKey: ['voiceCommunications', 'accounts'] });
  };
  const failed = (error: unknown): void => {
    void message.error(error instanceof Error ? error.message : t('voice.settings.accountFailed'));
  };

  const saveAccount = useMutation({
    mutationFn: (values: AccountFormValues) => {
      const config = parseConfig(values.config);
      if (editing === null) {
        const input: VoiceProviderAccountInput = {
          key: values.key.trim(),
          providerKey: values.providerKey,
          label: values.label.trim(),
          environment: values.environment,
          capabilities: values.capabilities ?? [],
          config,
          ...(values.credential ? { credential: values.credential } : {}),
          ...(values.webhookSecret ? { webhookSecret: values.webhookSecret } : {}),
        };
        return api.createVoiceProviderAccount(input);
      }
      const patch: VoiceProviderAccountPatch = {
        label: values.label.trim(),
        environment: values.environment,
        capabilities: values.capabilities ?? [],
        config,
        ...(values.credential ? { credential: values.credential } : {}),
        ...(values.webhookSecret ? { webhookSecret: values.webhookSecret } : {}),
      };
      return api.updateVoiceProviderAccount(editing.key, patch);
    },
    onSuccess: () => {
      setOpen(false);
      invalidateAccounts();
      void message.success(t('voice.settings.accountSaved'));
    },
    onError: failed,
  });

  const setEnabled = useMutation({
    mutationFn: (input: { key: string; enabled: boolean }) => api.setVoiceProviderAccountEnabled(input.key, input.enabled),
    onSuccess: invalidateAccounts,
    onError: failed,
  });

  const health = useMutation({
    mutationFn: (key: string) => api.voiceProviderAccountHealth(key),
    onSuccess: (result) => {
      invalidateAccounts();
      if (result.ok) void message.success(result.detail);
      else void message.warning(result.detail);
    },
    onError: failed,
  });

  const removeAccount = useMutation({
    mutationFn: (key: string) => api.removeVoiceProviderAccount(key),
    onSuccess: () => {
      invalidateAccounts();
      void message.success(t('voice.settings.accountDeleted'));
    },
    onError: failed,
  });

  const openCreate = (): void => {
    setEditing(null);
    setAdapterKey(catalog.data?.providers.find((provider) => provider.mode !== 'disabled')?.key ?? '');
    accountForm.resetFields();
    accountForm.setFieldsValue({
      key: '',
      providerKey: '',
      label: '',
      environment: 'test',
      capabilities: [],
      config: '{}',
      credential: '',
      webhookSecret: '',
    });
    setOpen(true);
  };

  const openEdit = (account: VoiceProviderAccountView): void => {
    setEditing(account);
    setAdapterKey(account.providerKey);
    accountForm.setFieldsValue({
      key: account.key,
      providerKey: account.providerKey,
      label: account.label,
      environment: account.environment === 'production' ? 'production' : 'test',
      capabilities: [...account.capabilities],
      config: JSON.stringify(account.config ?? {}, null, 2),
      credential: '',
      webhookSecret: '',
    });
    setOpen(true);
  };

  const providers = catalog.data?.providers ?? [];
  const providerOptions = providers
    .filter((provider) => provider.mode !== 'disabled')
    .map((provider) => ({ value: provider.key, label: `${provider.label} (${provider.key})` }));
  if (editing !== null && !providerOptions.some((option) => option.value === editing.providerKey)) {
    providerOptions.push({ value: editing.providerKey, label: editing.providerKey });
  }
  const selectedProvider: VoiceProviderInfo | undefined = providers.find((provider) => provider.key === adapterKey);
  const capabilityOptions = (selectedProvider?.capabilities ?? CAPABILITY_KEYS).map((capability) => ({
    value: capability,
    label: capability,
  }));

  const columns = [
    {
      title: t('voice.settings.accountLabel'),
      dataIndex: 'label',
      render: (label: string, account: VoiceProviderAccountView) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {account.key}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('voice.page.provider'), dataIndex: 'providerKey' },
    {
      title: t('voice.page.environment'),
      dataIndex: 'environment',
      render: (environment: string) => <Tag>{environment}</Tag>,
    },
    {
      title: t('voice.page.enabled'),
      dataIndex: 'enabled',
      render: (enabled: boolean, account: VoiceProviderAccountView) => (
        <Switch
          size="small"
          checked={enabled}
          loading={setEnabled.isPending && setEnabled.variables?.key === account.key}
          onChange={(checked) => setEnabled.mutate({ key: account.key, enabled: checked })}
          aria-label={t('voice.settings.toggleAccount', { key: account.key })}
        />
      ),
    },
    {
      title: t('voice.page.capabilities'),
      dataIndex: 'effectiveCapabilities',
      render: (_value: readonly string[], account: VoiceProviderAccountView) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>
            {t('voice.settings.grantedCapabilities', {
              granted: account.effectiveCapabilities.length,
              declared: account.capabilities.length,
            })}
          </Typography.Text>
          {account.effectiveCapabilities.length < account.capabilities.length ? (
            <Tag color="orange">{t('voice.settings.capabilityGap')}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('voice.page.credential'),
      dataIndex: 'hasCredential',
      render: (hasCredential: boolean, account: VoiceProviderAccountView) => (
        <Space direction="vertical" size={0}>
          <Tag color={hasCredential ? 'blue' : 'default'}>
            {hasCredential ? t('voice.page.configured') : t('voice.page.notConfigured')}
          </Tag>
          <Tag color={account.hasWebhookSecret ? 'blue' : 'default'}>
            {t('voice.page.webhookSecret')}: {account.hasWebhookSecret ? t('voice.page.configured') : t('voice.page.notConfigured')}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('voice.page.health'),
      dataIndex: 'lastHealth',
      render: (last: VoiceProviderAccountView['lastHealth']) =>
        last.status === null ? (
          <Typography.Text type="secondary">{t('voice.page.never')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Tag color={last.status === 'healthy' ? 'green' : 'red'}>{last.status}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {last.detail ?? ''}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 150,
      render: (_value: unknown, account: VoiceProviderAccountView) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            aria-label={t('voice.settings.healthCheck')}
            loading={health.isPending && health.variables === account.key}
            onClick={() => health.mutate(account.key)}
          />
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            aria-label={t('voice.settings.editAccount')}
            onClick={() => openEdit(account)}
          />
          <Popconfirm
            title={t('voice.settings.accountDeleteConfirm', { key: account.key })}
            okText={t('voice.settings.delete')}
            cancelText={t('core.common.cancel')}
            onConfirm={() => removeAccount.mutate(account.key)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('voice.settings.delete')} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="carocrm-card"
      title={t('voice.settings.accounts')}
      extra={
        <Button icon={<PlusOutlined />} onClick={openCreate} disabled={providers.length === 0}>
          {t('voice.settings.addAccount')}
        </Button>
      }
      style={{ marginBottom: 16 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t('voice.settings.accountsHint')}
      </Typography.Paragraph>
      {accounts.length === 0 ? (
        <Typography.Text type="secondary">{t('voice.page.noAccounts')}</Typography.Text>
      ) : (
        <Table<VoiceProviderAccountView>
          size="small"
          rowKey="key"
          dataSource={[...accounts]}
          columns={columns}
          pagination={false}
          loading={loading}
          expandable={{
            expandedRowRender: (account) => <EndpointsPanel accountKey={account.key} />,
            rowExpandable: () => true,
          }}
        />
      )}

      <Modal
        open={open}
        title={editing === null ? t('voice.settings.addAccount') : t('voice.settings.editAccount')}
        okText={t('web.common.save')}
        cancelText={t('core.common.cancel')}
        confirmLoading={saveAccount.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => accountForm.submit()}
        width={640}
        forceRender
      >
        <Form form={accountForm} layout="vertical" onFinish={(values) => saveAccount.mutate(values)}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="key"
                label={t('voice.settings.accountKey')}
                rules={[
                  { required: true, message: t('web.adminSettings.fieldRequired') },
                  { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/, message: t('voice.settings.accountKeyHint') },
                ]}
              >
                <Input disabled={editing !== null} maxLength={64} placeholder="main" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="providerKey"
                label={t('voice.settings.adapter')}
                rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
              >
                <Select
                  disabled={editing !== null}
                  showSearch
                  optionFilterProp="label"
                  options={providerOptions}
                  onChange={(value: string) => setAdapterKey(value)}
                  notFoundContent={t('voice.settings.noAdapters')}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="label"
                label={t('voice.page.account')}
                rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
              >
                <Input maxLength={128} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="environment" label={t('voice.page.environment')}>
                <Select
                  options={[
                    { value: 'test', label: t('voice.settings.environmentTest') },
                    { value: 'production', label: t('voice.settings.environmentProduction') },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="capabilities"
            label={t('voice.page.capabilities')}
            extra={t('voice.settings.capabilitiesHint')}
          >
            <Select mode="multiple" allowClear optionFilterProp="label" options={capabilityOptions} />
          </Form.Item>

          <Form.Item
            name="config"
            label={t('voice.settings.config')}
            extra={t('voice.settings.configHint')}
            rules={[
              {
                validator: async (_rule, value: string) => {
                  parseConfig(value);
                },
              },
            ]}
          >
            <Input.TextArea rows={4} spellCheck={false} />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="credential"
                label={t('voice.page.credential')}
                extra={editing === null ? undefined : t('voice.settings.secretKeepHint')}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="webhookSecret"
                label={t('voice.page.webhookSecret')}
                extra={editing === null ? undefined : t('voice.settings.secretKeepHint')}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
          </Row>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('voice.settings.secretWriteOnly')}
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}

function EndpointsPanel({ accountKey }: { accountKey: string }) {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const [form] = Form.useForm<EndpointFormValues>();

  const endpoints = useQuery({
    queryKey: ['voiceCommunications', 'endpoints', accountKey],
    queryFn: () => api.voiceProviderEndpoints(accountKey),
  });

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['voiceCommunications', 'endpoints', accountKey] });
  };
  const failed = (error: unknown): void => {
    void message.error(error instanceof Error ? error.message : t('voice.settings.endpointFailed'));
  };

  const add = useMutation({
    mutationFn: (values: EndpointFormValues) => {
      const input: VoiceEndpointInput = {
        key: values.key.trim(),
        channel: values.channel,
        address: values.address.trim(),
        active: values.active ?? true,
      };
      return api.createVoiceProviderEndpoint(accountKey, input);
    },
    onSuccess: () => {
      invalidate();
      form.resetFields();
      void message.success(t('voice.settings.endpointAdded'));
    },
    onError: failed,
  });

  const toggle = useMutation({
    mutationFn: (input: { key: string; active: boolean }) =>
      api.setVoiceProviderEndpointActive(accountKey, input.key, input.active),
    onSuccess: invalidate,
    onError: failed,
  });

  const columns = [
    { title: t('voice.settings.endpointKey'), dataIndex: 'key' },
    {
      title: t('voice.settings.endpointChannel'),
      dataIndex: 'channel',
      render: (channel: string) => <Tag>{t(`voice.channel.${channel}`)}</Tag>,
    },
    {
      title: t('voice.settings.endpointAddress'),
      dataIndex: 'displayAddress',
      render: (display: string, endpoint: VoiceEndpointView) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{display}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {endpoint.address}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('voice.settings.endpointActive'),
      dataIndex: 'active',
      render: (active: boolean, endpoint: VoiceEndpointView) => (
        <Switch
          size="small"
          checked={active}
          loading={toggle.isPending && toggle.variables?.key === endpoint.key}
          onChange={(checked) => toggle.mutate({ key: endpoint.key, active: checked })}
          aria-label={t('voice.settings.toggleEndpoint', { key: endpoint.key })}
        />
      ),
    },
    {
      title: t('voice.settings.endpointTeam'),
      dataIndex: 'teamId',
      render: (teamId: string | null) => (teamId === null ? '—' : teamId),
    },
  ];

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text strong>{t('voice.settings.endpoints')}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('voice.settings.endpointsHint')}
      </Typography.Text>
      {endpoints.isLoading ? (
        <Typography.Text type="secondary">{t('web.adminShell.loading')}</Typography.Text>
      ) : (endpoints.data?.list ?? []).length === 0 ? (
        <Typography.Text type="secondary">{t('voice.settings.noEndpoints')}</Typography.Text>
      ) : (
        <Table<VoiceEndpointView>
          size="small"
          rowKey="key"
          dataSource={[...(endpoints.data?.list ?? [])]}
          columns={columns}
          pagination={false}
        />
      )}
      <Form
        form={form}
        layout="inline"
        initialValues={{ active: true, channel: 'voice' }}
        onFinish={(values) => add.mutate(values)}
      >
        <Form.Item
          name="key"
          rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
        >
          <Input
            aria-label={t('voice.settings.endpointKey')}
            placeholder={t('voice.settings.endpointKey')}
            maxLength={64}
            style={{ width: 140 }}
          />
        </Form.Item>
        <Form.Item name="channel">
          <Select
            aria-label={t('voice.settings.endpointChannel')}
            style={{ width: 130 }}
            options={CHANNEL_KEYS.map((channel) => ({ value: channel, label: t(`voice.channel.${channel}`) }))}
          />
        </Form.Item>
        <Form.Item
          name="address"
          rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
        >
          <Input
            aria-label={t('voice.settings.endpointAddress')}
            placeholder={t('voice.settings.endpointAddress')}
            maxLength={64}
            style={{ width: 200 }}
          />
        </Form.Item>
        <Form.Item name="active" valuePropName="checked">
          <Switch
            aria-label={t('voice.settings.endpointActive')}
            checkedChildren={t('voice.settings.endpointActive')}
            unCheckedChildren={t('voice.settings.endpointInactive')}
          />
        </Form.Item>
        <Button type="dashed" htmlType="submit" icon={<PlusOutlined />} loading={add.isPending}>
          {t('voice.settings.addEndpoint')}
        </Button>
      </Form>
    </Space>
  );
}

function parseConfig(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(t('voice.settings.configInvalid'));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('voice.settings.configInvalid'));
  }
  return parsed as Record<string, unknown>;
}
