import { PhoneOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Space, Table, Tag, Typography } from 'antd';

import { api } from '../api/client.js';
import type { VoiceProviderAccountView } from '../api/types.js';
import { t } from '../state/i18n.js';

/**
 * Phase 19-VC.2–19-VC.5 — the Voice & Communications workspace (first surface).
 *
 * One read-only diagnostics page: platform dependencies, feature flags, provider adapters, accounts
 * (credential presence only, never a value) and the webhook receipt log. The interactive surfaces —
 * click-to-call, the incoming-call panel and the unified inbox — arrive in 19-VC.8/19-VC.9/19-VC.12;
 * this page exists so the module's navigation entry is real and an operator can see why a provider is
 * not working. Every fact comes from the server's own health report; nothing is inferred here.
 */
export function VoiceCommunicationsPage() {
  const health = useQuery({
    queryKey: ['voiceCommunications', 'health'],
    queryFn: () => api.voiceCommunicationsHealth(),
    staleTime: 30_000,
  });
  const accounts = useQuery({
    queryKey: ['voiceCommunications', 'accounts'],
    queryFn: () => api.voiceCommunicationsAccounts(),
    staleTime: 30_000,
  });
  const events = useQuery({
    queryKey: ['voiceCommunications', 'webhookEvents'],
    queryFn: () => api.voiceCommunicationsWebhookEvents(25),
    staleTime: 15_000,
  });

  if (health.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (health.isError || health.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('voice.page.loadFailed')}
        description={health.error instanceof Error ? health.error.message : t('voice.page.loadFailedHint')}
        action={<Button onClick={() => void health.refetch()}>{t('voice.page.reload')}</Button>}
      />
    );
  }

  const view = health.data;
  // Columns are built inside the component so a locale change re-renders their labels.
  const accountColumns = [
    { title: t('voice.page.account'), dataIndex: 'label' },
    { title: 'Key', dataIndex: 'key' },
    { title: t('voice.page.provider'), dataIndex: 'providerKey' },
    {
      title: t('voice.page.environment'),
      dataIndex: 'environment',
      render: (environment: string) => <Tag>{environment}</Tag>,
    },
    {
      title: t('voice.page.enabled'),
      dataIndex: 'enabled',
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'default'}>
          {enabled ? t('voice.page.enabled') : t('voice.page.disabled')}
        </Tag>
      ),
    },
    {
      title: t('voice.page.credential'),
      dataIndex: 'hasCredential',
      render: (has: boolean, row: VoiceProviderAccountView) =>
        has ? (
          <Tag color="blue">{row.credentialHint ?? t('voice.page.configured')}</Tag>
        ) : (
          t('voice.page.notConfigured')
        ),
    },
    {
      title: t('voice.page.health'),
      dataIndex: 'lastHealth',
      render: (last: VoiceProviderAccountView['lastHealth']) =>
        last.status === null ? (
          t('voice.page.never')
        ) : (
          <Space direction="vertical" size={0}>
            <Tag color={last.status === 'healthy' ? 'green' : 'red'}>{last.status}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {last.detail ?? ''}
            </Typography.Text>
          </Space>
        ),
    },
  ];

  const eventColumns = [
    { title: t('voice.page.eventType'), dataIndex: 'eventType' },
    { title: t('voice.page.account'), dataIndex: 'accountKey' },
    {
      title: t('voice.page.signature'),
      dataIndex: 'signatureValid',
      render: (valid: boolean) => <Tag color={valid ? 'green' : 'red'}>{valid ? 'valid' : 'invalid'}</Tag>,
    },
    {
      title: t('voice.page.processing'),
      dataIndex: 'processingStatus',
      render: (status: string) => <Tag>{status}</Tag>,
    },
    {
      title: t('voice.page.received'),
      dataIndex: 'receivedAt',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: t('voice.page.processedAt'),
      dataIndex: 'processedAt',
      render: (value: string | null) => (value === null ? '—' : new Date(value).toLocaleString()),
    },
    {
      title: '',
      dataIndex: 'failureDetail',
      render: (detail: string | null) =>
        detail === null ? null : (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {detail}
          </Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space align="start" style={{ justifyContent: 'space-between', width: '100%' }}>
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            <PhoneOutlined /> {t('voice.page.title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('voice.page.subtitle')}</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void health.refetch()}>
          {t('voice.page.reload')}
        </Button>
      </Space>

      <Alert
        type={view.ok ? 'success' : 'warning'}
        showIcon
        message={view.ok ? t('voice.page.ok') : t('voice.page.degraded')}
        description={
          view.settings.warnings.length === 0
            ? t('voice.page.noWarnings')
            : view.settings.warnings.join(' ')
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('voice.page.dependencies')}>
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={[...view.dependencies]}
              columns={[
                { title: t('voice.page.dependencies'), dataIndex: 'label' },
                {
                  title: '',
                  dataIndex: 'present',
                  width: 120,
                  render: (present: boolean) => (
                    <Tag color={present ? 'green' : 'red'}>
                      {present ? t('voice.page.present') : t('voice.page.missing')}
                    </Tag>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('voice.page.features')}>
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={[...view.features]}
              columns={[
                { title: t('voice.page.features'), dataIndex: 'label' },
                {
                  title: '',
                  dataIndex: 'enabled',
                  width: 110,
                  render: (enabled: boolean) => (
                    <Tag color={enabled ? 'green' : 'default'}>
                      {enabled ? t('voice.page.enabled') : t('voice.page.disabled')}
                    </Tag>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title={t('voice.page.providers')}>
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={[...view.providers.available]}
          columns={[
            { title: t('voice.page.provider'), dataIndex: 'label' },
            { title: 'Key', dataIndex: 'key' },
            { title: t('voice.page.mode'), dataIndex: 'mode', render: (mode: string) => <Tag>{mode}</Tag> },
            {
              title: t('voice.page.channels'),
              dataIndex: 'channels',
              render: (channels: readonly string[]) => channels.join(', ') || '—',
            },
            { title: t('voice.page.capabilities'), dataIndex: 'capabilities', width: 120 },
          ]}
        />
      </Card>

      <Card size="small" title={t('voice.page.accounts')}>
        {accounts.data === undefined || accounts.data.list.length === 0 ? (
          <Empty description={t('voice.page.noAccounts')} />
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={[...accounts.data.list]}
            columns={accountColumns}
          />
        )}
      </Card>

      <Card size="small" title={t('voice.page.webhookInbox')}>
        {events.data === undefined || events.data.list.length === 0 ? (
          <Empty description={t('voice.page.noEvents')} />
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={[...events.data.list]}
            columns={eventColumns}
          />
        )}
      </Card>
    </Space>
  );
}

