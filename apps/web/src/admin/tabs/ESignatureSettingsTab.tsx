import { useQuery } from '@tanstack/react-query';
import { Alert, App as AntApp, Card, Col, Form, Input, InputNumber, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { ESignatureSettingsView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { useModuleDocument } from '../module-document.js';
import { usePublishTabActions } from '../shell.js';

/**
 * Phase 19-ES.1 — the ESignature administration screen
 * (`PLAN_Phase_19_ESignature.md` §4.1, §11.1, §13.5, §18 `19-ES.1`).
 *
 * One validated document, edited as a draft and saved through the module's own endpoint, which
 * refuses an unknown key and refuses a **secret-shaped value** with its reason: the credential vault
 * is the only place a DocuSign client secret, refresh token or Connect HMAC secret may go, and this
 * screen has no field that could hold one (plan §4.1).
 *
 * A feature whose implementation arrives in a later sub-phase is shown with its phase and switched
 * off, so an administrator is never told that a toggle does something it cannot do yet.
 */

interface FeatureRow {
  readonly key: string;
  readonly labelKey: string;
  readonly pendingPhase: string | null;
}

/** The switch order the plan sequences them in: identity first, then documents, then the provider. */
const FEATURE_KEYS = ['requests', 'connections', 'documents', 'templates', 'send', 'webhooks', 'embeddedSigning', 'artifacts', 'approvals'] as const;

interface FeatureFlags {
  requests: boolean;
  connections: boolean;
  documents: boolean;
  templates: boolean;
  send: boolean;
  webhooks: boolean;
  embeddedSigning: boolean;
  artifacts: boolean;
  approvals: boolean;
  [key: string]: boolean;
}

/** The stored document, typed where this screen edits it and open-ended where the module adds more. */
interface FormValues {
  enabled: boolean;
  features: FeatureFlags;
  provider: { demoIntegrationKey: string; productionIntegrationKey: string };
  documents: { maxDocumentBytes: number; maxDocumentsPerRequest: number; allowedExtensions: string[] };
  signing: { defaultExpiryDays: number; remindersEnabled: boolean; resendCooldownMinutes: number; embeddedReturnHosts: string[] };
  webhooks: { endpointUrl: string; requireHmac: boolean; maxPayloadBytes: number };
  retention: { webhookPayloadDays: number; completedArtifactDays: number };
  approval: { requiredForSourceEntities: string[] };
  environmentLabel: string;
}

export function ESignatureSettingsTab() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [dirty, setDirty] = useState(false);

  // The settings document itself is edited through the shell's draft form; the extra views the
  // module returns (which phases are still pending per feature) are read beside it, never saved back.
  const meta = useQuery<ESignatureSettingsView>({
    queryKey: ['eSignature', 'settingsView'],
    queryFn: () => api.eSignatureSettings(),
    staleTime: 30_000,
  });

  const document = useModuleDocument<FormValues>({
    queryKey: ['eSignature', 'settings'],
    load: async () => {
      const view = await api.eSignatureSettings();
      return { settings: view.settings as unknown as FormValues, version: view.version, updatedAt: view.updatedAt, updatedBy: view.updatedBy, warnings: view.warnings };
    },
    persist: (patch) => api.saveESignatureSettings(patch),
    savedMessage: t('esignature.settings.saved'),
    failedMessage: t('esignature.settings.saveFailed'),
    onSaved: () => void message.success(t('esignature.settings.saved')),
  });

  useEffect(() => {
    if (document.value !== undefined) {
      form.setFieldsValue(document.value);
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
      if (document.value !== undefined) form.setFieldsValue(document.value);
      setDirty(false);
      document.discard();
    },
    onReload: () => {
      setDirty(false);
      form.resetFields();
      void document.reload();
    },
  });

  if (document.loading || document.value === undefined) {
    return <Alert type="info" showIcon message={t('web.adminShell.loading')} />;
  }

  const pending = new Map((meta.data?.pendingFeatures ?? []).map((entry) => [entry.key, entry.phase]));
  const rows: FeatureRow[] = FEATURE_KEYS.map((key) => ({
    key,
    labelKey: `esignature.features.${key}`,
    pendingPhase: pending.get(key) ?? null,
  }));

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} /> : null}
      {document.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('esignature.settings.warnings')}
          description={
            <ul className="carocrm-admin-warnings">
              {document.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 16 }} message={t('esignature.settings.noWarnings')} />
      )}

      <Typography.Text type="secondary" className="carocrm-admin-document-meta">
        {t('web.adminShell.documentName', { name: 'ESignature' })} · {t('web.adminShell.versionLabel')} {document.version}
      </Typography.Text>

      <Form
        form={form}
        layout="vertical"
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => {
          void document.save(values).then((saved) => {
            if (saved) setDirty(false);
          });
        }}
      >
        <Card
          className="carocrm-card"
          title={t('esignature.features.enabled')}
          extra={t('esignature.features.enabledHint')}
          style={{ marginBottom: 16 }}
        >
          <Form.Item name="enabled" label={t('esignature.features.enabled')} valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
          </Form.Item>
        </Card>

        <Card className="carocrm-card" title={t('esignature.features.title')} extra={t('esignature.features.hint')} style={{ marginBottom: 16 }}>
          <Row gutter={[16, 4]}>
            {rows.map((row) => (
              <Col key={row.key} xs={24} md={12} lg={8}>
                <Form.Item
                  name={['features', row.key]}
                  label={
                    <Space size={6}>
                      {t(row.labelKey)}
                      {row.pendingPhase === null ? null : <Tag>{t('esignature.features.pendingPhase', { phase: row.pendingPhase })}</Tag>}
                    </Space>
                  }
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
          <Col xs={24} lg={12}>
            <Card
              className="carocrm-card"
              title={t('esignature.settings.integrationKeys')}
              extra={t('esignature.settings.integrationKeysHint')}
              style={{ marginBottom: 16 }}
            >
              <Form.Item name={['provider', 'demoIntegrationKey']} label={t('esignature.settings.demoIntegrationKey')}>
                <Input maxLength={128} placeholder="b8f0…" autoComplete="off" spellCheck={false} />
              </Form.Item>
              <Form.Item name={['provider', 'productionIntegrationKey']} label={t('esignature.settings.productionIntegrationKey')}>
                <Input maxLength={128} autoComplete="off" spellCheck={false} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('esignature.settings.secretRefused')}
              </Typography.Text>
            </Card>

            <Card className="carocrm-card" title={t('esignature.settings.documents')} style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item name={['documents', 'maxDocumentBytes']} label={t('esignature.settings.maxDocumentBytes')}>
                    <InputNumber min={1024} max={104_857_600} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name={['documents', 'maxDocumentsPerRequest']} label={t('esignature.settings.maxDocumentsPerRequest')}>
                    <InputNumber min={1} max={25} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24}>
                  <Form.Item name={['documents', 'allowedExtensions']} label={t('esignature.settings.allowedExtensions')}>
                    <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="pdf" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card className="carocrm-card" title={t('esignature.settings.signing')} style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item name={['signing', 'defaultExpiryDays']} label={t('esignature.settings.defaultExpiryDays')}>
                    <InputNumber min={1} max={120} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name={['signing', 'remindersEnabled']} label={t('esignature.settings.remindersEnabled')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['signing', 'resendCooldownMinutes']}
                    label={t('esignature.settings.resendCooldownMinutes')}
                    extra={t('esignature.settings.resendCooldownMinutesHint')}
                  >
                    <InputNumber min={0} max={1_440} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24}>
                  <Form.Item
                    name={['signing', 'embeddedReturnHosts']}
                    label={t('esignature.settings.embeddedReturnHosts')}
                    extra={t('esignature.settings.embeddedReturnHostsHint')}
                  >
                    <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="crm.example.com" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" title={t('esignature.settings.webhooks')} style={{ marginBottom: 16 }}>
              <Form.Item name={['webhooks', 'endpointUrl']} label={t('esignature.settings.endpointUrl')}>
                <Input maxLength={500} placeholder="https://crm.example.com/api/v1/integrations/esignature/…" />
              </Form.Item>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['webhooks', 'requireHmac']}
                    label={t('esignature.settings.requireHmac')}
                    extra={t('esignature.settings.requireHmacHint')}
                    valuePropName="checked"
                  >
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name={['webhooks', 'maxPayloadBytes']} label={t('esignature.settings.maxPayloadBytes')}>
                    <InputNumber min={1024} max={2_097_152} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" title={t('esignature.settings.retention')} style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item name={['retention', 'webhookPayloadDays']} label={t('esignature.settings.webhookPayloadDays')}>
                    <InputNumber min={0} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['retention', 'completedArtifactDays']}
                    label={t('esignature.settings.completedArtifactDays')}
                    extra={t('esignature.settings.completedArtifactDaysHint')}
                  >
                    <InputNumber min={0} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" title={t('esignature.settings.approval')} style={{ marginBottom: 16 }}>
              <Form.Item name={['approval', 'requiredForSourceEntities']} label={t('esignature.settings.requiredForSourceEntities')}>
                <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="Quote" />
              </Form.Item>
              <Form.Item name="environmentLabel" label={t('esignature.settings.environmentLabel')}>
                <Input maxLength={60} />
              </Form.Item>
            </Card>
          </Col>
        </Row>
      </Form>
    </div>
  );
}
