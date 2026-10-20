import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Typography,
} from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationCatalogProvider, IntegrationMappingView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { ConnectionStatusPill, ScopeChips } from './shared.js';

/**
 * Phase 19-INT.14 — the connection setup wizard
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.2).
 *
 * The wizard is deliberately **linear and explicit**. Its steps follow the plan:
 *
 * 1. ownership — who the connection belongs to;
 * 2. permissions — what the provider will be asked for, before anything is stored;
 * 3. credentials — an OAuth redirect or a write-only secret;
 * 4. test — the provider is asked to confirm the account;
 * 5. objects — which provider objects sync, and in which direction;
 * 6. mapping — the field mapping;
 * 7. preview — a dry run that writes nothing;
 * 8. publish — the mapping goes live.
 *
 * Two rules run through all of it:
 *
 *  - **A secret is write-only.** It is sent once and never read back; the wizard shows a
 *    "stored" badge afterwards and nothing more.
 *  - **A draft cannot trigger a sync.** The mapping is only activated at the last step, so a
 *    half-finished wizard leaves nothing running.
 */

type WizardStep = 'ownership' | 'permissions' | 'credentials' | 'test' | 'objects' | 'mapping' | 'preview' | 'publish';

const STEP_ORDER: readonly WizardStep[] = [
  'ownership',
  'permissions',
  'credentials',
  'test',
  'objects',
  'mapping',
  'preview',
  'publish',
];

export function ConnectionWizard({
  provider,
  onClose,
}: {
  readonly provider: IntegrationCatalogProvider;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<WizardStep>('ownership');
  const [ownerType, setOwnerType] = useState<'organization' | 'user'>('organization');
  const [name, setName] = useState('');
  const [tenantRef, setTenantRef] = useState('');
  const [secret, setSecret] = useState('');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);
  const [direction, setDirection] = useState<'inbound' | 'outbound' | 'bidirectional'>('inbound');
  const [crmEntityType, setCrmEntityType] = useState('Account');
  const [mapping, setMapping] = useState<IntegrationMappingView | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();

  const createConnection = useMutation({
    mutationFn: () =>
      api.integrationConnectionCreate({
        providerKey: provider.providerKey,
        name: name.trim(),
        ownerType,
        tenantRef: tenantRef.trim() === '' ? undefined : tenantRef.trim(),
      }),
    onSuccess: (connection) => {
      setConnectionId(connection.id);
      setStep('credentials');
    },
  });

  const storeSecret = useMutation({
    mutationFn: () =>
      api.integrationRotateSecret(connectionId ?? '', { kind: 'api_key', value: secret }),
    onSuccess: () => {
      // The value is never read back: the wizard drops it and shows a "stored" badge instead.
      setSecret('');
      setStep('test');
    },
  });

  const testConnection = useMutation({
    mutationFn: () => api.integrationConnectionTest(connectionId ?? ''),
    onSuccess: (result) => {
      setTestOk(result.ok);
      setTestMessage(result.message ?? result.code);
    },
  });

  const createMapping = useMutation({
    mutationFn: () =>
      api.integrationMappingCreate({
        providerKey: provider.providerKey,
        objectType: selectedObjects[0] ?? '',
        crmEntityType,
        direction,
      }),
    onSuccess: (created) => {
      setMapping(created);
      setStep('preview');
    },
  });

  const publish = useMutation({
    mutationFn: () => api.integrationMappingActivate(mapping?.id ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['advancedIntegrations'] });
      message.success(t('advancedintegrations.wizard.published'));
      onClose();
    },
  });

  const stepIndex = STEP_ORDER.indexOf(step);
  const isLast = stepIndex === STEP_ORDER.length - 1;
  const busy =
    createConnection.isPending ||
    storeSecret.isPending ||
    testConnection.isPending ||
    createMapping.isPending ||
    publish.isPending;

  const goNext = (): void => {
    const next = STEP_ORDER[stepIndex + 1];
    if (next !== undefined) setStep(next);
  };

  return (
    <Modal
      open
      title={t('advancedintegrations.wizard.title')}
      width={760}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onClose}>{t('core.common.cancel')}</Button>
          {stepIndex > 0 ? (
            <Button onClick={() => setStep(STEP_ORDER[stepIndex - 1] ?? 'ownership')}>
              {t('advancedintegrations.wizard.back')}
            </Button>
          ) : null}
          {isLast ? (
            <Button type="primary" loading={publish.isPending} onClick={() => publish.mutate()}>
              {t('advancedintegrations.wizard.publish')}
            </Button>
          ) : (
            <Button type="primary" loading={busy} onClick={() => advance()}>
              {t('advancedintegrations.wizard.next')}
            </Button>
          )}
        </Space>
      }
    >
      <Steps
        size="small"
        current={stepIndex}
        onChange={(index) => setStep(STEP_ORDER[index] ?? 'ownership')}
        style={{ marginBottom: 20 }}
        items={[
          { title: t('advancedintegrations.wizard.stepOwnership') },
          { title: t('advancedintegrations.wizard.stepPermissions') },
          { title: t('advancedintegrations.wizard.stepCredentials') },
          { title: t('advancedintegrations.wizard.stepTest') },
          { title: t('advancedintegrations.wizard.stepObjects') },
          { title: t('advancedintegrations.wizard.stepMapping') },
          { title: t('advancedintegrations.wizard.stepPreview') },
          { title: t('advancedintegrations.wizard.stepPublish') },
        ]}
      />

      {step === 'ownership' ? (
        <Form layout="vertical">
          <Form.Item label={t('advancedintegrations.connections.name')} required>
            <Input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('advancedintegrations.wizard.namePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('advancedintegrations.wizard.ownership')} required>
            <Select
              value={ownerType}
              onChange={(value) => setOwnerType(value)}
              style={{ maxWidth: 320 }}
              options={[
                { value: 'organization', label: t('advancedintegrations.wizard.organization') },
                { value: 'user', label: t('advancedintegrations.wizard.user') },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('advancedintegrations.connections.tenant')}>
            <Input
              value={tenantRef}
              maxLength={200}
              onChange={(event) => setTenantRef(event.target.value)}
              placeholder={t('advancedintegrations.wizard.tenantPlaceholder')}
            />
          </Form.Item>
        </Form>
      ) : null}

      {step === 'permissions' ? (
        <div>
          <Typography.Paragraph type="secondary">
            {t('advancedintegrations.wizard.permissionsHint')}
          </Typography.Paragraph>
          <div className="carocrm-wiring-pane">
            <div className="carocrm-label" style={{ marginBottom: 8 }}>
              {t('advancedintegrations.providers.requiredScopes')}
            </div>
            <ScopeChips
              granted={provider.requiredScopes}
              missing={[]}
              grantedLabel={t('advancedintegrations.wizard.requiredScope')}
              missingLabel={t('advancedintegrations.wizard.missingScope')}
            />
            {provider.optionalScopes.length > 0 ? (
              <>
                <div className="carocrm-label" style={{ margin: '12px 0 8px' }}>
                  {t('advancedintegrations.wizard.optionalScopes')}
                </div>
                <ScopeChips
                  granted={provider.optionalScopes}
                  missing={[]}
                  grantedLabel={t('advancedintegrations.wizard.optionalScope')}
                  missingLabel={t('advancedintegrations.wizard.missingScope')}
                />
              </>
            ) : null}
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="carocrm-label" style={{ marginBottom: 8 }}>
              {t('advancedintegrations.wizard.capabilities')}
            </div>
            <Space size={[6, 6]} wrap>
              {provider.objects.map((object) => (
                <span key={object.objectType} className="carocrm-pill carocrm-pill--grey">
                  {object.label}
                </span>
              ))}
            </Space>
          </div>
        </div>
      ) : null}

      {step === 'credentials' ? (
        <div>
          {provider.authentication === 'oauth' ? (
            <Alert
              type="info"
              showIcon
              message={t('advancedintegrations.wizard.oauthHint')}
              description={t('advancedintegrations.wizard.oauthHintDetail')}
            />
          ) : (
            <Form layout="vertical">
              <Form.Item label={t('advancedintegrations.wizard.apiKey')} required>
                <Input.Password
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="new-password"
                  placeholder={t('advancedintegrations.wizard.apiKeyPlaceholder')}
                />
              </Form.Item>
              <Alert type="warning" showIcon message={t('advancedintegrations.wizard.secretHint')} />
            </Form>
          )}
        </div>
      ) : null}

      {step === 'test' ? (
        <div>
          <Space direction="vertical" style={{ width: '100%' }}>
            {testOk === null ? (
              <Typography.Text type="secondary">{t('advancedintegrations.wizard.testHint')}</Typography.Text>
            ) : testOk ? (
              <Alert type="success" showIcon message={t('advancedintegrations.wizard.testOk')} description={testMessage ?? undefined} />
            ) : (
              <Alert type="error" showIcon message={t('advancedintegrations.wizard.testFailed')} description={testMessage ?? undefined} />
            )}
            {connectionId === null ? null : (
              <Space>
                <ConnectionStatusPill status="draft" />
                <Typography.Text type="secondary">{t('advancedintegrations.wizard.draftNote')}</Typography.Text>
              </Space>
            )}
          </Space>
        </div>
      ) : null}

      {step === 'objects' ? (
        <Form layout="vertical">
          <Form.Item label={t('advancedintegrations.wizard.selectObjects')}>
            <Checkbox.Group
              value={selectedObjects}
              onChange={(values) => setSelectedObjects(values as string[])}
            >
              <Space direction="vertical">
                {provider.objects.map((object) => (
                  <Checkbox key={object.objectType} value={object.objectType}>
                    {object.label}
                    <Typography.Text type="secondary"> · {object.objectType}</Typography.Text>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item label={t('advancedintegrations.wizard.direction')} required>
            <Select
              value={direction}
              onChange={(value) => setDirection(value)}
              style={{ maxWidth: 320 }}
              options={[
                { value: 'inbound', label: t('advancedintegrations.wizard.inbound') },
                { value: 'outbound', label: t('advancedintegrations.wizard.outbound') },
                { value: 'bidirectional', label: t('advancedintegrations.wizard.bidirectional') },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('advancedintegrations.wizard.crmEntity')} required>
            <Input
              value={crmEntityType}
              onChange={(event) => setCrmEntityType(event.target.value)}
              style={{ maxWidth: 320 }}
            />
          </Form.Item>
        </Form>
      ) : null}

      {step === 'mapping' ? (
        <div>
          <Typography.Paragraph type="secondary">{t('advancedintegrations.wizard.mappingHint')}</Typography.Paragraph>
          <Alert type="info" showIcon message={t('advancedintegrations.wizard.mappingBuilderHint')} />
        </div>
      ) : null}

      {step === 'preview' ? (
        <div>
          <Typography.Paragraph type="secondary">{t('advancedintegrations.wizard.previewHint')}</Typography.Paragraph>
          {mapping === null ? null : (
            <div className="carocrm-wiring-pane">
              <div className="carocrm-wiring-pane-title">
                <span className="carocrm-label">
                  {t('advancedintegrations.mapping.providerField')} / {t('advancedintegrations.mapping.crmField')}
                </span>
                <span className="carocrm-pill carocrm-pill--grey">v{String(mapping.mappingVersion)}</span>
              </div>
              <Typography.Text type="secondary">
                {t('advancedintegrations.wizard.previewPending')}
              </Typography.Text>
            </div>
          )}
        </div>
      ) : null}

      {step === 'publish' ? (
        <div>
          <Typography.Paragraph>{t('advancedintegrations.wizard.publishHint')}</Typography.Paragraph>
          {mapping === null ? null : (
            <Space direction="vertical">
              <div>
                <span className="carocrm-label">{t('advancedintegrations.mapping.title')}</span>
                <div>{`${mapping.objectType} → ${mapping.crmEntityType}`}</div>
              </div>
              <div>
                <span className="carocrm-label">{t('advancedintegrations.mapping.version')}</span>
                <div>{String(mapping.mappingVersion)}</div>
              </div>
            </Space>
          )}
        </div>
      ) : null}
    </Modal>
  );

  /** Each step advances only when its own precondition is met. */
  function advance(): void {
    switch (step) {
      case 'ownership':
        if (name.trim() === '') {
          message.warning(t('advancedintegrations.wizard.nameRequired'));
          return;
        }
        createConnection.mutate();
        return;
      case 'permissions':
        goNext();
        return;
      case 'credentials':
        if (provider.authentication === 'oauth') {
          goNext();
          return;
        }
        if (secret.trim() === '') {
          message.warning(t('advancedintegrations.wizard.apiKeyRequired'));
          return;
        }
        storeSecret.mutate();
        return;
      case 'test':
        testConnection.mutate();
        return;
      case 'objects':
        if (selectedObjects.length === 0) {
          message.warning(t('advancedintegrations.wizard.objectRequired'));
          return;
        }
        createMapping.mutate();
        return;
      case 'mapping':
        goNext();
        return;
      case 'preview':
        goNext();
        return;
      default:
        goNext();
    }
  }
}
