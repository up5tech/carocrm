import { ApiOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentProviderCheckResult, AIAgentsHealthView, AIAgentsProviderConnection } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-AI.4 — provider connection administration
 * (PLAN_Phase_19_AI_Agents.md §6, §14.4, §20 `19-AI.4`; docs/modules/ai-agents/provider-configuration.md).
 *
 * A connection is one approved model endpoint. The form never presents a policy value as free text:
 * the adapter is chosen from the ones the server actually registered, the model list is an
 * allowlist, and the data classes are the four the module knows.
 *
 * The credential is **write-only**: it is sent once and never read back — the table reports
 * `hasApiKey` instead, and leaving the field empty on an edit keeps the stored secret. The
 * connectivity check is administrator-triggered and returns status, latency and usage only.
 */

const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;

/**
 * The server's `message` is a localized category ("Validation failed."); the explanation the
 * administrator needs travels in `details.reason` — here it is often the only thing that says
 * *why* a connection was refused (an unsafe URL, a missing encryption key, a referenced
 * version). The reason is preferred when the API supplied one.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as Error & { details?: Record<string, unknown> }).details;
    const reason = details?.['reason'];
    if (typeof reason === 'string' && reason.trim() !== '') return reason;
    return error.message;
  }
  return String(error);
}

interface ProviderFormValues {
  /** The catalog entry the administrator picked. It carries the kind and the defaults. */
  preset: string;
  /** The transport adapter, derived from the preset. */
  kind: string;
  key: string;
  label: string;
  baseUrl: string;
  models: string[];
  dataClasses: string[];
  apiKey?: string;
  allowLoopback: boolean;
  organization?: string;
  authHeader: 'bearer' | 'api-key';
  enabled: boolean;
}

type Preset = NonNullable<AIAgentsHealthView['providers']['presets'][number]>;

interface PresetGroup {
  readonly key: string;
  readonly label: string;
  readonly options: readonly Preset[];
}

/** The catalog, grouped the way the administrator looks for a provider. */
function groupPresets(presets: readonly Preset[]): PresetGroup[] {
  const order: readonly { key: string; labelKey: string }[] = [
    { key: 'hosted', labelKey: 'web.aiAgents.providerGroupHosted' },
    { key: 'self-hosted', labelKey: 'web.aiAgents.providerGroupSelfHosted' },
    { key: 'other', labelKey: 'web.aiAgents.providerGroupOther' },
  ];
  return order
    .map((group) => ({
      key: group.key,
      label: t(group.labelKey),
      options: presets.filter((preset) => preset.group === group.key),
    }))
    .filter((group) => group.options.length > 0);
}

export function AIAgentsProvidersTab() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ProviderFormValues>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AIAgentsProviderConnection | undefined>(undefined);
  const [check, setCheck] = useState<AIAgentProviderCheckResult | undefined>(undefined);

  const providers = useQuery({
    queryKey: ['aiAgents', 'providers'],
    queryFn: () => api.aiAgentsProviders(),
    retry: false,
    staleTime: 30_000,
  });
  // The catalog comes from the health endpoint, so the form can only offer an adapter the server
  // actually registered — a `fake` adapter is absent in production.
  const health = useQuery({ queryKey: ['aiAgents', 'health'], queryFn: () => api.aiAgentsHealth(), staleTime: 30_000 });
  const presets = health.data?.providers.presets ?? [];

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'providers'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'health'] });
  };

  const save = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      const config: Record<string, unknown> = {
        allowLoopback: values.allowLoopback,
        authHeader: values.authHeader,
      };
      if (values.organization !== undefined && values.organization.trim() !== '') {
        config['organization'] = values.organization.trim();
      }
      const models = values.models.map((model) => model.trim()).filter((model) => model !== '');
      if (editing === undefined) {
        return api.aiAgentsCreateProvider({
          kind: values.kind,
          key: values.key.trim(),
          label: values.label.trim(),
          baseUrl: values.baseUrl.trim(),
          models,
          dataClasses: values.dataClasses,
          config,
          enabled: values.enabled,
          ...(values.apiKey === undefined || values.apiKey === '' ? {} : { apiKey: values.apiKey }),
        });
      }
      return api.aiAgentsUpdateProvider(editing.key, {
        label: values.label.trim(),
        baseUrl: values.baseUrl.trim(),
        models,
        dataClasses: values.dataClasses,
        config,
        enabled: values.enabled,
        // Omitting the key keeps the stored credential; an empty field is not a request to clear it.
        ...(values.apiKey === undefined || values.apiKey === '' ? {} : { apiKey: values.apiKey }),
      });
    },
    onSuccess: (connection) => {
      void message.success(
        editing === undefined
          ? t('web.aiAgents.providerCreated', { label: connection.label })
          : t('web.aiAgents.providerUpdated', { label: connection.label }),
      );
      setEditorOpen(false);
      setEditing(undefined);
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error)),
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.aiAgentsDeleteProvider(key),
    onSuccess: () => {
      void message.success(t('web.aiAgents.providerDeleted'));
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error)),
  });

  const runCheck = useMutation({
    mutationFn: (key: string) => api.aiAgentsCheckProvider(key),
    onSuccess: (result) => setCheck(result),
    onError: (error: Error) => void message.error(errorText(error)),
  });

  /** The catalog entry that matches an existing connection, so the form shows what it is. */
  const presetOf = useCallback(
    (connection: AIAgentsProviderConnection): string => {
      const normalized = connection.baseUrl.replace(/\/+$/, '').toLowerCase();
      const exact = presets.find(
        (preset) => preset.baseUrl !== '' && preset.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized,
      );
      if (exact !== undefined) return exact.key;
      // A protocol with an adapter of its own is identified by that adapter.
      const byKind = presets.find((preset) => preset.kind === connection.kind && preset.kind !== 'openai-compatible');
      return byKind?.key ?? 'custom';
    },
    [presets],
  );

  useEffect(() => {
    if (!editorOpen) return;
    const presetKey = editing === undefined ? 'openai' : presetOf(editing);
    const preset = presets.find((entry) => entry.key === presetKey);
    form.setFieldsValue({
      preset: presetKey,
      kind: editing?.kind ?? preset?.kind ?? 'openai-compatible',
      key: editing?.key ?? '',
      label: editing?.label ?? '',
      baseUrl: editing?.baseUrl ?? preset?.baseUrl ?? '',
      models: editing === undefined ? [...(preset?.models ?? [])] : [...editing.models],
      dataClasses: editing === undefined ? [...DATA_CLASSES.slice(0, 2)] : [...editing.dataClasses],
      apiKey: '',
      allowLoopback: editing?.config.allowLoopback ?? (preset?.group === 'self-hosted' ? true : false),
      organization: editing?.config.organization ?? '',
      authHeader: editing?.config.authHeader ?? preset?.authHeader ?? 'bearer',
      enabled: editing?.enabled ?? true,
    });
  }, [editorOpen, editing, form, presets, presetOf]);

  /** Choosing a provider fills the endpoint, the model suggestions and the credential header. */
  const applyPreset = useCallback(
    (presetKey: string) => {
      const preset = presets.find((entry) => entry.key === presetKey);
      if (preset === undefined) return;
      form.setFieldsValue({
        preset: presetKey,
        kind: preset.kind,
        baseUrl: preset.baseUrl,
        models: [...preset.models],
        authHeader: preset.authHeader,
        ...(preset.group === 'self-hosted' ? { allowLoopback: true } : {}),
      });
    },
    [presets, form],
  );

  const presetGroups = useMemo(() => groupPresets(presets), [presets]);
  const selectedPresetKey = Form.useWatch('preset', form);
  const selectedPreset = presets.find((preset) => preset.key === selectedPresetKey);
  const presetNote = selectedPreset?.note ?? null;

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };

  const openEdit = (connection: AIAgentsProviderConnection): void => {
    setEditing(connection);
    setEditorOpen(true);
  };

  if (providers.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (providers.isError || providers.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('web.aiAgents.providersFailed')}
        description={providers.error instanceof Error ? errorText(providers.error) : undefined}
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={t('web.aiAgents.providersAdminHint')} description={t('web.aiAgents.providersAdminHintDetail')} />

      <Card
        className="carocrm-card"
        size="small"
        title={t('web.aiAgents.providersConnections')}
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('web.aiAgents.providerAdd')}
          </Button>
        }
      >
        {providers.data.list.length === 0 ? (
          <Typography.Text type="secondary">{t('web.aiAgents.noProviders')}</Typography.Text>
        ) : (
          <Table<AIAgentsProviderConnection>
            rowKey="key"
            size="small"
            pagination={false}
            scroll={{ x: 820 }}
            dataSource={[...providers.data.list]}
            columns={[
              {
                title: t('web.aiAgents.key'),
                dataIndex: 'key',
                key: 'key',
                width: 160,
                render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
              },
              { title: t('web.aiAgents.name'), dataIndex: 'label', key: 'label', width: 180 },
              { title: t('web.aiAgents.providerKind'), dataIndex: 'kind', key: 'kind', width: 150 },
              { title: t('web.aiAgents.providerBaseUrl'), dataIndex: 'baseUrl', key: 'baseUrl' },
              {
                title: t('web.aiAgents.providerModels'),
                dataIndex: 'models',
                key: 'models',
                width: 200,
                render: (value: readonly string[]) => (
                  <Space size={4} wrap>
                    {value.map((model) => (
                      <Tag key={model}>{model}</Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: t('web.aiAgents.dataClass'),
                dataIndex: 'dataClasses',
                key: 'dataClasses',
                width: 190,
                render: (value: readonly string[]) => (
                  <Space size={4} wrap>
                    {value.map((entry) => (
                      <Tag key={entry} color={entry === 'public' || entry === 'internal' ? 'blue' : 'orange'}>
                        {entry}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: t('web.aiAgents.providerCredential'),
                key: 'credential',
                width: 120,
                render: (_value, row) =>
                  row.hasApiKey ? (
                    <Tag color="green">{t('web.aiAgents.providerCredentialStored')}</Tag>
                  ) : (
                    <Tag color="default">{t('web.aiAgents.providerCredentialMissing')}</Tag>
                  ),
              },
              {
                title: t('web.aiAgents.enabled'),
                key: 'enabled',
                width: 100,
                render: (_value, row) =>
                  row.enabled ? (
                    <Tag color="green">{t('web.aiAgents.enabled')}</Tag>
                  ) : (
                    <Tag color="red">{t('web.aiAgents.disabled')}</Tag>
                  ),
              },
              {
                title: t('web.aiAgents.actions'),
                key: 'actions',
                width: 220,
                render: (_value, row) => (
                  <Space size={4}>
                    <Button size="small" icon={<ApiOutlined />} loading={runCheck.isPending} onClick={() => runCheck.mutate(row.key)}>
                      {t('web.aiAgents.providerCheck')}
                    </Button>
                    <Button size="small" onClick={() => openEdit(row)}>
                      {t('web.common.edit')}
                    </Button>
                    <Popconfirm title={t('web.aiAgents.providerDeleteConfirm')} onConfirm={() => remove.mutate(row.key)}>
                      <Button size="small" danger loading={remove.isPending}>
                        {t('web.aiAgents.delete')}
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        open={editorOpen}
        title={editing === undefined ? t('web.aiAgents.providerAdd') : t('web.aiAgents.providerEdit')}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(undefined);
        }}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText={t('core.common.save')}
        width={720}
        forceRender
        destroyOnClose={false}
      >
        <Form<ProviderFormValues> form={form} layout="vertical" onFinish={(values) => save.mutate(values)} requiredMark="optional">
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="preset" label={t('web.aiAgents.providerPreset')} extra={presetNote ?? t('web.aiAgents.providerPresetHint')}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  onChange={(value: string) => applyPreset(value)}
                  options={presetGroups.map((group) => ({
                    label: group.label,
                    options: group.options.map((preset) => ({
                      value: preset.key,
                      label: preset.label,
                    })),
                  }))}
                  placeholder={t('web.aiAgents.providerPresetPlaceholder')}
                />
              </Form.Item>
              <Form.Item name="kind" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="authHeader" hidden>
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="key" label={t('web.aiAgents.key')} rules={[{ required: true, pattern: /^[a-z][a-z0-9-]{1,63}$/, message: t('web.aiAgents.keyRule') }]}>
                <Input disabled={editing !== undefined} placeholder="primary-openai" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="label" label={t('web.aiAgents.name')} rules={[{ required: true, max: 120 }]}>
            <Input placeholder={t('web.aiAgents.providerLabelPlaceholder')} />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('web.aiAgents.providerBaseUrl')} rules={[{ required: true, max: 500 }]} extra={t('web.aiAgents.providerBaseUrlHint')}>
            <Input placeholder="https://api.example.com/v1" />
          </Form.Item>
          <Form.Item name="models" label={t('web.aiAgents.providerModels')} rules={[{ required: true, type: 'array', min: 1, message: t('web.aiAgents.providerModelsRequired') }]} extra={t('web.aiAgents.providerModelsHint')}>
            <Select mode="tags" placeholder="gpt-4o-mini" />
          </Form.Item>
          <Form.Item name="dataClasses" label={t('web.aiAgents.dataClass')} rules={[{ required: true, type: 'array', min: 1 }]} extra={t('web.aiAgents.providerDataClassesHint')}>
            <Select mode="multiple" options={DATA_CLASSES.map((entry) => ({ value: entry, label: entry }))} />
          </Form.Item>
          <Form.Item name="apiKey" label={t('web.aiAgents.providerCredential')} extra={editing === undefined ? t('web.aiAgents.providerApiKeyHint') : t('web.aiAgents.providerApiKeyKeepHint')}>
            <Input.Password autoComplete="new-password" placeholder={t('web.aiAgents.providerApiKeyPlaceholder')} />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="allowLoopback" label={t('web.aiAgents.providerAllowLoopback')} extra={t('web.aiAgents.providerAllowLoopbackHint')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="organization" label={t('web.aiAgents.providerOrganization')}>
                <Input maxLength={200} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="enabled" label={t('web.aiAgents.enabled')} valuePropName="checked">
            <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
          </Form.Item>
          {save.isError ? (
            <Alert type="error" showIcon message={save.error instanceof Error ? errorText(save.error) : String(save.error)} />
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={check !== undefined}
        title={t('web.aiAgents.providerCheckResult', { key: check?.connectionKey ?? '' })}
        onCancel={() => setCheck(undefined)}
        footer={
          <Button onClick={() => setCheck(undefined)}>
            {t('core.common.close')}
          </Button>
        }
      >
        {check === undefined ? null : (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t('web.aiAgents.providerCheckStatus')}>
              {check.ok ? (
                <Tag color="green">{t('web.aiAgents.providerCheckOk')}</Tag>
              ) : (
                <Tag color="red">{t('web.aiAgents.providerCheckFailed')}</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('web.aiAgents.model')}>{check.model}</Descriptions.Item>
            <Descriptions.Item label={t('web.aiAgents.latency')}>{check.latencyMs} ms</Descriptions.Item>
            <Descriptions.Item label={t('web.aiAgents.providerCheckCategory')}>{check.category ?? '—'}</Descriptions.Item>
            <Descriptions.Item label={t('web.aiAgents.providerCheckMessage')}>{check.message}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </Space>
  );
}
