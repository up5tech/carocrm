import { FileSearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { api } from '../api/client.js';
import type { ESignatureCapabilityEntry, ESignatureHealthView } from '../api/types.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { t } from '../state/i18n.js';

/**
 * Phase 19-ES.1 — the ESignature module page
 * (`PLAN_Phase_19_ESignature.md` §13.1, §18 `19-ES.1`).
 *
 * ES.1 registers the module and its security contract; the request list, the send wizard and the
 * progress view arrive with ES.6 and ES.13. What this page can honestly show today is the state the
 * acceptance criteria ask about: whether the module is switched on, why the gate that stands in front
 * of every provider call is closed, and which rights the caller holds.
 *
 * Everything on screen is the server's answer. A right the caller lacks is reported by the server and
 * the matching endpoint refuses it too — rendering is never the enforcement (AGENTS.md §5.3).
 */
export function ESignaturePage() {
  const health = useQuery({
    queryKey: ['eSignature', 'health'],
    queryFn: () => api.eSignatureHealth(),
    staleTime: 30_000,
  });
  const capabilities = useQuery({
    queryKey: ['eSignature', 'capabilities'],
    queryFn: () => api.eSignatureCapabilities(),
    staleTime: 30_000,
  });

  if (health.isLoading || capabilities.isLoading) return <LoadingSkeleton rows={8} />;
  if (health.isError || health.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.page.loadFailed')} ${
          health.error instanceof Error ? health.error.message : t('esignature.page.loadFailedHint')
        }`}
        onRetry={() => void health.refetch()}
      />
    );
  }

  const view: ESignatureHealthView = health.data;
  const entries = capabilities.data?.capabilities ?? [];

  return (
    <div className="carocrm-page" style={{ maxWidth: 1080, margin: '0 auto' }}>
      <header style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          <Space size={8}>
            <FileSearchOutlined />
            {t('esignature.page.title')}
          </Space>
        </Typography.Title>
        <Typography.Text type="secondary">{t('esignature.page.subtitle')}</Typography.Text>
      </header>

      {view.gate.ready ? null : (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('esignature.page.gateClosed')}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>{gateReason(view.gate.reason)}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('esignature.page.adminNote')}
              </Typography.Text>
            </Space>
          }
          action={<Button onClick={() => void health.refetch()}>{t('core.common.reload')}</Button>}
        />
      )}

      <Card className="carocrm-card" title={t('esignature.features.title')} style={{ marginBottom: 16 }}>
        <Table<ESignatureHealthView['features'][number]>
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={[...view.features]}
          columns={featureColumns()}
        />
      </Card>

      <Card className="carocrm-card" title={t('esignature.capabilities.title')} style={{ marginBottom: 16 }}>
        {entries.length === 0 ? (
          <EmptyState title={t('esignature.capabilities.title')} description={t('esignature.page.loadFailedHint')} />
        ) : (
          <Table<ESignatureCapabilityEntry>
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={[...entries]}
            columns={capabilityColumns()}
          />
        )}
      </Card>

      <Card className="carocrm-card" title={t('esignature.provider.title')}>
        <Space size={[8, 8]} wrap>
          {Object.entries(view.providerCapabilities).map(([key, supported]) => (
            <Tag key={key} color={supported ? 'green' : 'default'}>
              {t(`esignature.provider.${key}`)}
            </Tag>
          ))}
        </Space>
      </Card>
    </div>
  );
}

function featureColumns(): ColumnsType<ESignatureHealthView['features'][number]> {
  return [
    { title: t('esignature.features.columnFeature'), dataIndex: 'key', render: (key: string) => t(`esignature.features.${key}`) },
    {
      title: t('esignature.features.columnState'),
      dataIndex: 'effective',
      render: (_effective: boolean, feature) => {
        if (feature.pendingPhase !== null) {
          return <Tag>{t('esignature.features.pendingPhase', { phase: feature.pendingPhase })}</Tag>;
        }
        return (
          <Tag color={feature.effective ? 'green' : feature.enabled ? 'orange' : 'default'}>
            {feature.effective ? t('core.common.yes') : t('core.common.no')}
          </Tag>
        );
      },
    },
    { title: t('esignature.features.columnSettingsPath'), dataIndex: 'settingsPath' },
  ];
}

function capabilityColumns(): ColumnsType<ESignatureCapabilityEntry> {
  return [
    { title: t('esignature.capabilities.columnCapability'), dataIndex: 'key', render: (key: string) => t(`esignature.capabilities.${key}`) },
    { title: t('esignature.capabilities.columnDescription'), dataIndex: 'description' },
    {
      title: t('esignature.capabilities.columnGranted'),
      dataIndex: 'granted',
      render: (granted: boolean) => <Tag color={granted ? 'green' : 'default'}>{granted ? t('core.common.yes') : t('core.common.no')}</Tag>,
    },
  ];
}

/** The gate's stable reason, translated; an unknown reason falls back to the server's own sentence. */
function gateReason(reason: string): string {
  const key = `esignature.page.gateReasons.${reason}`;
  const translated = t(key);
  return translated === key ? reason : translated;
}
