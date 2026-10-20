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
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentsSettings } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-AI.2 — module policy administration
 * (PLAN_Phase_19_AI_Agents.md §5.1, §8.5, §9.2, §11.4, §12, §14.4, §20 `19-AI.2`).
 *
 * This is where an administrator decides whether agents may run at all and how far they may go:
 * the feature switches, the instance ceilings, the approval classes, the retention windows, the
 * operator kill switch and the data classes an external provider may receive.
 *
 * The values are the server's own validated shape. The tab never re-implements a rule — the server
 * re-validates the merged row and answers with the version it stored, its warnings and the actor
 * that changed it. The kill switch is a switch, not a patch an operator has to compose by hand.
 */

const EFFECT_CLASSES = ['read', 'low_write', 'material_write', 'high_impact'] as const;
const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;

const FEATURE_KEYS = [
  'definitions',
  'execution',
  'memory',
  'evaluations',
  'eventTriggers',
  'scheduledTriggers',
  'portalAssistant',
] as const;

/**
 * The server's `message` is a localized category ("Validation failed."); the explanation the
 * administrator needs travels in `details.reason` — for a settings patch it is the refused field
 * or the policy that refused it. The reason is preferred when the API supplied one.
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

export function AIAgentsSettingsTab({ capabilities }: { readonly capabilities: Record<string, boolean> }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AIAgentsSettings>();
  const [dirty, setDirty] = useState(false);

  const settings = useQuery({ queryKey: ['aiAgents', 'settings'], queryFn: () => api.aiAgentsSettings(), retry: false });
  // The tool catalogue is readable with the plain `use` capability; the disabled list names real
  // tool keys rather than free text.
  const tools = useQuery({ queryKey: ['aiAgents', 'toolCatalogue'], queryFn: () => api.aiAgentsTools(), staleTime: 60_000 });
  // Listing connections needs the provider capability. A policy administrator who does not hold it
  // still names the default connection by key, so the field falls back to a plain input.
  const providers = useQuery({
    queryKey: ['aiAgents', 'providers'],
    queryFn: () => api.aiAgentsProviders(),
    enabled: capabilities['providerAdmin'] === true,
    retry: false,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: (values: AIAgentsSettings) => {
      const reason = values.safety.reason ?? '';
      const defaultKey = values.provider.defaultKey ?? '';
      return api.saveAiAgentsSettings({
        ...values,
        // An empty string is how the schema spells "no default" and "no reason". The server merges
        // the patch into the stored row, so an omitted key would keep the old value instead of
        // clearing it — the empty string is sent explicitly.
        provider: { defaultKey: defaultKey.trim() },
        safety: { ...values.safety, reason: reason.trim() === '' ? null : reason.trim() },
      } as unknown as Record<string, unknown>);
    },
    onSuccess: (view) => {
      void message.success(t('web.aiAgents.settingsSaved', { version: view.version }));
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'capabilities'] });
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'health'] });
    },
    onError: (error: Error) => void message.error(errorText(error)),
  });

  useEffect(() => {
    if (settings.data === undefined) return;
    // `reason` is nullable in the stored row but a text input holds a string; an empty string is
    // what the schema accepts for "no reason given".
    form.setFieldsValue({
      ...settings.data.settings,
      safety: { ...settings.data.settings.safety, reason: settings.data.settings.safety.reason ?? '' },
    });
    setDirty(false);
  }, [settings.data, form]);

  if (settings.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (settings.isError || settings.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('web.aiAgents.settingsFailed')}
        description={settings.error instanceof Error ? errorText(settings.error) : undefined}
      />
    );
  }

  const view = settings.data;
  const catalogue = tools.data?.tools ?? [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {view.warnings.length === 0 ? null : (
        <Alert
          type="warning"
          showIcon
          message={t('web.aiAgents.settingsWarnings')}
          description={
            <ul className="carocrm-admin-warnings">
              {view.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<AIAgentsSettings> form={form} layout="vertical" onValuesChange={() => setDirty(true)} onFinish={(values) => save.mutate(values)}>
        <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsKillSwitch')} style={{ marginBottom: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
            {t('web.aiAgents.settingsKillSwitchHint')}
          </Typography.Paragraph>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name={['safety', 'globalExecutionPaused']} label={t('web.aiAgents.settingsPaused')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name={['safety', 'reason']} label={t('web.aiAgents.settingsPauseReason')}>
                <Input maxLength={500} placeholder={t('web.aiAgents.settingsPauseReasonPlaceholder')} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsFeatures')} style={{ marginBottom: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
            {t('web.aiAgents.settingsFeaturesHint')}
          </Typography.Paragraph>
          <Row gutter={[12, 4]}>
            {FEATURE_KEYS.map((key) => (
              <Col key={key} xs={24} md={12} lg={8}>
                <Form.Item name={['features', key]} label={t(`web.aiAgents.settingsFeatureLabels.${key}`)} valuePropName="checked" style={{ marginBottom: 8 }}>
                  <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Card>

        <Row gutter={16}>
          <Col xs={24} lg={12}>
            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsLimits')} style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsLimitsHint')}
              </Typography.Paragraph>
              <Row gutter={12}>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxSteps']} label={t('web.aiAgents.maxSteps')}>
                    <InputNumber min={1} max={16} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxModelCalls']} label={t('web.aiAgents.settingsMaxModelCalls')}>
                    <InputNumber min={1} max={16} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxToolCalls']} label={t('web.aiAgents.maxToolCalls')}>
                    <InputNumber min={0} max={32} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxTokens']} label={t('web.aiAgents.maxTokens')}>
                    <InputNumber min={1} max={200_000} step={500} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxCostUsd']} label={t('web.aiAgents.settingsMaxCostUsd')}>
                    <InputNumber min={0} max={100} step={0.5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxElapsedSeconds']} label={t('web.aiAgents.maxElapsedSeconds')}>
                    <InputNumber min={1} max={600} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxRetries']} label={t('web.aiAgents.settingsMaxRetries')}>
                    <InputNumber min={0} max={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxConcurrency']} label={t('web.aiAgents.settingsMaxConcurrency')}>
                    <InputNumber min={1} max={20} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['limits', 'maxResultBytes']} label={t('web.aiAgents.settingsMaxResultBytes')}>
                    <InputNumber min={1024} max={1_048_576} step={1024} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsApproval')} style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsApprovalHint')}
              </Typography.Paragraph>
              <Form.Item name={['approval', 'requireFor']} label={t('web.aiAgents.settingsRequireFor')} extra={t('web.aiAgents.settingsRequireForHint')}>
                <Select mode="multiple" options={EFFECT_CLASSES.map((entry) => ({ value: entry, label: entry }))} />
              </Form.Item>
              <Form.Item name={['approval', 'ttlMinutes']} label={t('web.aiAgents.settingsApprovalTtl')}>
                <InputNumber min={1} max={1_440} style={{ width: '100%' }} />
              </Form.Item>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsRetention')} style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsRetentionHint')}
              </Typography.Paragraph>
              <Row gutter={12}>
                <Col xs={12} sm={8}>
                  <Form.Item name={['retention', 'runEventsDays']} label={t('web.aiAgents.settingsRetentionRunEvents')}>
                    <InputNumber min={1} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['retention', 'providerRequestsDays']} label={t('web.aiAgents.settingsRetentionProviderRequests')}>
                    <InputNumber min={1} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['retention', 'conversationsDays']} label={t('web.aiAgents.settingsRetentionConversations')}>
                    <InputNumber min={1} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item name={['retention', 'evaluationsDays']} label={t('web.aiAgents.settingsRetentionEvaluations')}>
                    <InputNumber min={1} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsDataPolicy')} style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsDataPolicyHint')}
              </Typography.Paragraph>
              <Form.Item name={['dataPolicy', 'allowedExternalDataClasses']} label={t('web.aiAgents.settingsAllowedDataClasses')}>
                <Select mode="multiple" options={DATA_CLASSES.map((entry) => ({ value: entry, label: entry }))} />
              </Form.Item>
              <Form.Item name={['dataPolicy', 'logPrompts']} label={t('web.aiAgents.settingsLogPrompts')} valuePropName="checked" extra={t('web.aiAgents.settingsLogPromptsHint')}>
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
            </Card>

            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsTools')} style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsToolsHint')}
              </Typography.Paragraph>
              <Form.Item name={['tools', 'disabled']} label={t('web.aiAgents.settingsDisabledTools')}>
                <Select
                  mode="multiple"
                  placeholder={t('web.aiAgents.settingsDisabledToolsPlaceholder')}
                  options={catalogue.map((tool) => ({
                    value: tool.key,
                    label: tool.enabled ? tool.key : `${tool.key} (${t('web.aiAgents.disabled')})`,
                  }))}
                />
              </Form.Item>
            </Card>

            <Card className="carocrm-card" size="small" title={t('web.aiAgents.settingsDefaultProvider')}>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('web.aiAgents.settingsDefaultProviderHint')}
              </Typography.Paragraph>
              <Form.Item name={['provider', 'defaultKey']} label={t('web.aiAgents.settingsDefaultProviderKey')}>
                {(providers.data?.list.length ?? 0) > 0 ? (
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder={t('web.aiAgents.settingsDefaultProviderPlaceholder')}
                    options={(providers.data?.list ?? []).map((connection) => ({
                      value: connection.key,
                      label: `${connection.label} (${connection.key})`,
                      disabled: !connection.enabled,
                    }))}
                  />
                ) : (
                  <Input maxLength={64} placeholder="primary-openai" />
                )}
              </Form.Item>
            </Card>
          </Col>
        </Row>

        <Space>
          <Button type="primary" htmlType="submit" loading={save.isPending} disabled={!dirty}>
            {t('web.common.save')}
          </Button>
          <Button onClick={() => {
            form.setFieldsValue(view.settings);
            setDirty(false);
          }} disabled={!dirty}>
            {t('web.adminShell.discard')}
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          {t('web.aiAgents.settingsVersionMeta', {
            version: view.version,
            by: view.updatedBy ?? '-',
            at: view.updatedAt === null ? t('web.aiAgents.neverUpdated') : new Date(view.updatedAt).toLocaleString(),
          })}
        </Typography.Paragraph>
      </Form>
    </Space>
  );
}
