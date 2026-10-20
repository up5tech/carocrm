import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Descriptions, Divider, Popconfirm, Skeleton, Space, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';
import {
  ConnectionStatusPill,
  formatDuration,
  formatTimestamp,
  MaskedCredential,
  ScopeChips,
  WarningList,
} from './shared.js';

/**
 * Phase 19-INT.14 — the connection detail panel
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.3).
 *
 * Two columns. On the left, the identity and the state of the connection — provider, account,
 * owner, permissions, adapter version. On the right, **what the operator has to act on**. The
 * warnings are the anchor: the panel is quiet until something is wrong, and then it says what is
 * wrong in one line.
 *
 * The actions are deliberately explicit about what they do. A destructive one (revoke) asks for
 * confirmation; a reversible one (pause) does not.
 */
export function IntegrationDetailPanel({
  connectionId,
  onChanged,
}: {
  readonly connectionId: string;
  readonly onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [secret, setSecret] = useState('');

  const detail = useQuery({
    queryKey: ['advancedIntegrations', 'connection', connectionId],
    queryFn: () => api.integrationConnection(connectionId),
    staleTime: 10_000,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['advancedIntegrations'] });
    onChanged();
  };

  const test = useMutation({
    mutationFn: () => api.integrationConnectionTest(connectionId),
    onSuccess: async (result) => {
      if (result.ok) message.success(t('advancedintegrations.connections.testOk'));
      else message.error(t('advancedintegrations.connections.testFailed'));
      await refresh();
    },
  });

  const pause = useMutation({
    mutationFn: () => api.integrationConnectionPause(connectionId),
    onSuccess: async () => {
      message.success(t('advancedintegrations.connections.paused'));
      await refresh();
    },
  });

  const resume = useMutation({
    mutationFn: () => api.integrationConnectionResume(connectionId),
    onSuccess: async () => {
      message.success(t('advancedintegrations.connections.resumed'));
      await refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: () => api.integrationConnectionRevoke(connectionId),
    onSuccess: async () => {
      message.success(t('advancedintegrations.connections.revoked'));
      await refresh();
    },
  });

  const rotate = useMutation({
    mutationFn: () => api.integrationRotateSecret(connectionId, { kind: 'api_key', value: secret }),
    onSuccess: async () => {
      setSecret('');
      setRotateOpen(false);
      message.success(t('advancedintegrations.connections.secretRotated'));
      await refresh();
    },
  });

  const reconcile = useMutation({
    mutationFn: () => api.integrationReconcile(connectionId),
    onSuccess: async (result) => {
      message.success(t('advancedintegrations.connections.reconciled', { count: result.resetMappings }));
      await refresh();
    },
  });

  if (detail.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (detail.isError || detail.data === undefined) {
    return (
      <Typography.Text type="secondary">{t('advancedintegrations.connections.detailFailed')}</Typography.Text>
    );
  }

  const view = detail.data;
  const connection = view.connection;
  const isUsable = connection.status === 'connected' || connection.status === 'degraded';

  return (
    <div>
      <div className="carocrm-rail-row" style={{ marginBottom: 16 }}>
        <span
          className={`carocrm-rail carocrm-rail--${
            connection.status === 'connected'
              ? 'ok'
              : connection.status === 'error'
                ? 'error'
                : connection.status === 'paused' || connection.status === 'revoked'
                  ? 'idle'
                  : 'warn'
          }`}
          role="presentation"
        />
        <div>
          <div className="carocrm-wire-name">{view.provider.displayName}</div>
          <div className="carocrm-wire-meta">
            {view.provider.providerKey} · {view.provider.providerApiVersion} ·{' '}
            {t('advancedintegrations.connections.adapterVersion')} {view.provider.adapterVersion}
          </div>
        </div>
      </div>

      <div className="carocrm-diff" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
        <div>
          <Descriptions column={1} size="small" colon={false} labelStyle={{ width: 160 }}>
            <Descriptions.Item label={t('advancedintegrations.connections.status')}>
              <ConnectionStatusPill status={connection.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.tenant')}>
              {view.tenant.tenantRef ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.owner')}>
              {view.tenant.ownerType === 'organization'
                ? t('advancedintegrations.wizard.organization')
                : view.tenant.ownerId}
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.credential')}>
              <MaskedCredential
                hasCredential={connection.hasCredential}
                hint={connection.credentialHint}
                storedLabel={t('advancedintegrations.connections.hasCredential')}
                noneLabel={t('advancedintegrations.connections.noCredential')}
              />
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.scopes')}>
              <ScopeChips
                granted={connection.grantedScopes}
                missing={view.missingScopes}
                grantedLabel={t('advancedintegrations.wizard.grantedScope')}
                missingLabel={t('advancedintegrations.wizard.missingScope')}
              />
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.lastTest')}>
              {view.lastTest === null
                ? '—'
                : `${view.lastTest.ok ? t('advancedintegrations.connections.testOk') : t('advancedintegrations.connections.testFailed')} · ${formatTimestamp(view.lastTest.checkedAt)}`}
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.syncLag')}>
              {formatDuration(view.syncLagSeconds)}
            </Descriptions.Item>
            <Descriptions.Item label={t('advancedintegrations.connections.lastWebhook')}>
              {view.lastWebhook === null
                ? '—'
                : `${view.lastWebhook.eventType ?? '—'} · ${formatTimestamp(view.lastWebhook.receivedAt)}`}
            </Descriptions.Item>
          </Descriptions>

          <Divider style={{ margin: '16px 0 12px' }} />
          <Space size={[8, 8]} wrap>
            <Button loading={test.isPending} onClick={() => test.mutate()}>
              {t('advancedintegrations.connections.test')}
            </Button>
            {isUsable ? (
              <Button loading={pause.isPending} onClick={() => pause.mutate()}>
                {t('advancedintegrations.connections.pause')}
              </Button>
            ) : (
              <Button loading={resume.isPending} onClick={() => resume.mutate()}>
                {t('advancedintegrations.connections.resume')}
              </Button>
            )}
            <Button loading={reconcile.isPending} onClick={() => reconcile.mutate()}>
              {t('advancedintegrations.connections.reconcile')}
            </Button>
            <Button onClick={() => setRotateOpen((open) => !open)}>
              {t('advancedintegrations.connections.rotateSecret')}
            </Button>
            <Popconfirm
              title={t('advancedintegrations.connections.revokeConfirm')}
              description={t('advancedintegrations.connections.revokeHint')}
              okText={t('advancedintegrations.connections.revoke')}
              cancelText={t('core.common.cancel')}
              onConfirm={() => revoke.mutate()}
            >
              <Button danger loading={revoke.isPending}>
                {t('advancedintegrations.connections.revoke')}
              </Button>
            </Popconfirm>
          </Space>

          {rotateOpen ? (
            <div className="carocrm-wiring-pane" style={{ marginTop: 12 }}>
              <div className="carocrm-label" style={{ marginBottom: 8 }}>
                {t('advancedintegrations.connections.rotateSecret')}
              </div>
              <Space.Compact style={{ width: '100%' }}>
                <input
                  className="ant-input"
                  type="password"
                  value={secret}
                  autoComplete="new-password"
                  placeholder={t('advancedintegrations.wizard.apiKeyPlaceholder')}
                  onChange={(event) => setSecret(event.target.value)}
                />
                <Button
                  type="primary"
                  loading={rotate.isPending}
                  disabled={secret.trim() === ''}
                  onClick={() => rotate.mutate()}
                >
                  {t('advancedintegrations.connections.rotateSecret')}
                </Button>
              </Space.Compact>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('advancedintegrations.wizard.secretHint')}
              </Typography.Paragraph>
            </div>
          ) : null}
        </div>

        <div>
          <div className="carocrm-label" style={{ marginBottom: 8 }}>
            {t('advancedintegrations.health.warnings')}
          </div>
          <WarningList
            warnings={view.warnings}
            emptyText={t('advancedintegrations.health.noWarnings')}
          />

          <Divider style={{ margin: '16px 0 12px' }} />
          <div className="carocrm-label" style={{ marginBottom: 8 }}>
            {t('advancedintegrations.mapping.title')}
          </div>
          {view.mappings.length === 0 ? (
            <Typography.Text type="secondary" className="carocrm-quiet">
              {t('advancedintegrations.mapping.empty')}
            </Typography.Text>
          ) : (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {view.mappings.map((mapping) => (
                <div key={mapping.id} className="carocrm-diff-field">
                  <span>
                    {mapping.objectType} → {mapping.crmEntityType}
                  </span>
                  <span className="carocrm-diff-value">
                    {mapping.status} · v{String(mapping.mappingVersion)} ·{' '}
                    {String(mapping.fieldCount)} {t('advancedintegrations.mapping.fields')}
                  </span>
                </div>
              ))}
            </Space>
          )}
        </div>
      </div>
    </div>
  );
}
