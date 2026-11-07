import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Drawer, Space, Tag, Typography } from 'antd';

import { api } from '../../api/client.js';
import type { CRMChatCapabilitiesView } from '../../api/types.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

export interface CRMChatDiagnosticsDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The already-loaded capabilities view; the drawer never refetches it. */
  readonly data: CRMChatCapabilitiesView;
}

/**
 * Phase 19-CHAT.31 — the diagnostics drawer, extracted from `CRMChatPage` unchanged.
 *
 * The capability, flag and module facts, plus the health checks. They explain *why* the assistant
 * cannot answer, so they live behind one button instead of under the thread. Health is only read
 * while the drawer is open.
 */
export function CRMChatDiagnosticsDrawer(props: CRMChatDiagnosticsDrawerProps) {
  const { open, onClose, data } = props;

  const health = useQuery({
    queryKey: ['crmChat', 'health'],
    queryFn: () => api.crmChatHealth(),
    enabled: open,
    staleTime: 15_000,
    retry: false,
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={440}
      title={t('web.crmChat.diagnosticsTitle')}
      extra={
        <Button size="small" loading={health.isFetching} onClick={() => void health.refetch()}>
          {t('core.common.refresh')}
        </Button>
      }
    >
      <div className="carocrm-chat-panel">
        {health.isLoading ? <LoadingSkeleton rows={4} /> : null}
        {health.isError ? (
          <ErrorState
            message={health.error instanceof Error ? health.error.message : undefined}
            onRetry={() => void health.refetch()}
          />
        ) : null}
        {health.data !== undefined ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {health.data.checks.map((check) => (
              <div key={check.name} className="carocrm-chat-fact">
                <div>
                  <div className="carocrm-chat-fact-title">{check.name}</div>
                  <div className="carocrm-chat-fact-desc">{check.detail}</div>
                </div>
                <Tag color={check.ok ? 'green' : 'red'}>{check.ok ? t('web.crmChat.featureOn') : t('web.crmChat.featureOff')}</Tag>
              </div>
            ))}
            {health.data.settings.warnings.map((warning) => (
              <Alert key={warning} type="warning" showIcon message={warning} />
            ))}
          </Space>
        ) : null}
      </div>

      <div className="carocrm-chat-panel">
        <h3 className="carocrm-chat-panel-title">{t('web.crmChat.capabilitiesTitle')}</h3>
        {data.capabilities.map((capability) => (
          <div key={capability.key} className="carocrm-chat-fact">
            <div>
              <div className="carocrm-chat-fact-title">{capability.label}</div>
              <div className="carocrm-chat-fact-desc">{capability.description}</div>
            </div>
            <Tag color={capability.granted ? 'blue' : 'default'}>
              {capability.granted ? t('web.crmChat.granted') : t('web.crmChat.notGranted')}
            </Tag>
          </div>
        ))}
      </div>

      <div className="carocrm-chat-panel">
        <h3 className="carocrm-chat-panel-title">{t('web.crmChat.featuresTitle')}</h3>
        {data.features.map((feature) => (
          <div key={feature.key} className="carocrm-chat-fact">
            <div>
              <div className="carocrm-chat-fact-title">{feature.label}</div>
              <div className="carocrm-chat-fact-desc">{feature.description}</div>
              <Typography.Text code style={{ fontSize: 11 }}>
                {feature.settingsPath}
              </Typography.Text>
            </div>
            <Tag color={feature.effective ? 'green' : feature.enabled ? 'gold' : 'default'}>
              {feature.effective
                ? t('web.crmChat.featureOn')
                : feature.enabled
                  ? t('web.crmChat.featureInactive')
                  : t('web.crmChat.featureOff')}
            </Tag>
          </div>
        ))}
      </div>

      <div className="carocrm-chat-panel">
        <h3 className="carocrm-chat-panel-title">{t('web.crmChat.moduleTitle')}</h3>
        <Descriptions size="small" column={1}>
          <Descriptions.Item label={t('web.crmChat.moduleVersionLabel')}>{data.module.version}</Descriptions.Item>
          <Descriptions.Item label={t('web.crmChat.moduleApiLabel')}>
            <Typography.Text code>{data.module.apiPrefix}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('web.crmChat.moduleRouteLabel')}>
            <Typography.Text code>{data.module.frontendRoute}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('web.crmChat.modulePhasesLabel')}>
            <Space size={4} wrap>
              {data.module.implementedPhases.map((phase) => (
                <Tag key={phase}>{phase}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {t('web.crmChat.roadmapHint')}
        </Typography.Text>
      </div>
    </Drawer>
  );
}
