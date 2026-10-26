import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Modal, Segmented, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type {
  OmnichannelOperationEvent,
  OmnichannelOperationEventDetail,
  OmnichannelOperationImpact,
  OmnichannelOperationsOverview,
} from '../../api/types.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { PermissionDenied } from '../../components/PermissionDenied.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-OM.21 — operations, diagnostics and recovery (plan §14; `docs/omnichannel/runbook.md`).
 *
 * Every figure is a server answer over the records the channel owner already keeps: provider
 * accounts, `voice_webhook_events` and the outbound message state machine. There is no second
 * operational store and no locally computed health:
 *  - credential and webhook-secret presence are **booleans**, never a value or a hint;
 *  - inspection returns the receipt's redacted payload exactly as the ingress stored it;
 *  - replay states which effects are idempotent and which are refused before it is queued;
 *  - the kill switch reports its documented impact, including the sends still awaiting a
 *    provider confirmation.
 * Each control calls its own endpoint; the panel only hides what the caller cannot use, it does
 * not grant anything (AGENTS.md §5.3).
 */

type AccountRow = OmnichannelOperationsOverview['accounts'][number];

export function OperationsPanel() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(7);
  const [inspected, setInspected] = useState<OmnichannelOperationEventDetail | null>(null);
  const [lastImpact, setLastImpact] = useState<OmnichannelOperationImpact | null>(null);

  const capabilities = useQuery({
    queryKey: ['omnichannel', 'capabilities'],
    queryFn: () => api.omnichannelCapabilities(),
    staleTime: 30_000,
    retry: false,
  });
  const overview = useQuery({
    queryKey: ['omnichannel', 'operations', days],
    queryFn: () => api.omnichannelOperations(days),
    staleTime: 15_000,
    retry: false,
  });
  const events = useQuery({
    queryKey: ['omnichannel', 'operations', 'events'],
    queryFn: () => api.omnichannelOperationEvents({ limit: 25 }),
    staleTime: 15_000,
    retry: false,
  });

  const granted = new Set(
    (capabilities.data?.capabilities ?? []).filter((entry) => entry.granted).map((entry) => entry.key),
  );
  const canProbe = granted.has('connectionManage');
  const canReplay = granted.has('opsReplay');
  const canToggle = granted.has('settingsManage');

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'operations'] });
  };

  const probe = useMutation({
    mutationFn: (key: string) => api.omnichannelTestAccount(key),
    onSuccess: (result) => {
      if (result.ok) message.success(t('omnichannel.operations.probeOk'));
      else message.error(result.detail);
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (input: { key: string; enabled: boolean }) => api.omnichannelSetAccountEnabled(input.key, input.enabled),
    onSuccess: (result) => {
      setLastImpact(result);
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const replay = useMutation({
    mutationFn: (id: string) => api.omnichannelReplayEvent(id),
    onSuccess: (result) => {
      message.success(result.queued ? t('omnichannel.operations.replayQueued') : t('omnichannel.operations.replayNotQueued'));
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const inspect = useMutation({
    mutationFn: (id: string) => api.omnichannelOperationEvent(id),
    onSuccess: (result) => setInspected(result),
    onError: (error: Error) => message.error(error.message),
  });

  if (capabilities.isLoading) return <LoadingSkeleton rows={6} />;
  if (!granted.has('opsRead')) {
    return <PermissionDenied hint={t('omnichannel.operations.denied')} />;
  }
  if (overview.isLoading || events.isLoading) return <LoadingSkeleton rows={8} />;
  if (overview.isError || overview.data === undefined) {
    return <ErrorState message={t('omnichannel.operations.loadFailed')} onRetry={() => void overview.refetch()} />;
  }

  const view = overview.data;
  const accountColumns: ColumnsType<AccountRow> = [
    {
      title: t('omnichannel.operations.col.connection'),
      key: 'connection',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.label}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.key} · {row.providerKey}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('omnichannel.operations.col.state'),
      key: 'state',
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.enabled}
          disabled={!canToggle}
          loading={toggle.isPending && toggle.variables?.key === row.key}
          checkedChildren={t('omnichannel.operations.enabled')}
          unCheckedChildren={t('omnichannel.operations.disabled')}
          onChange={(enabled) => toggle.mutate({ key: row.key, enabled })}
          aria-label={`${t('omnichannel.operations.toggle')} ${row.key}`}
        />
      ),
    },
    {
      title: t('omnichannel.operations.col.secrets'),
      key: 'secrets',
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag color={row.hasCredential ? 'success' : 'error'}>
            {t('omnichannel.operations.credential')}: {row.hasCredential ? t('omnichannel.page.present') : t('omnichannel.page.missing')}
          </Tag>
          <Tag color={row.hasWebhookSecret ? 'success' : 'error'}>
            {t('omnichannel.operations.webhookSecret')}: {row.hasWebhookSecret ? t('omnichannel.page.present') : t('omnichannel.page.missing')}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('omnichannel.operations.col.health'),
      key: 'health',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={row.health.status === 'ok' ? 'success' : row.health.status === null ? 'default' : 'warning'}>
            {row.health.status ?? t('omnichannel.operations.never')}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.health.at === null ? t('omnichannel.operations.never') : new Date(row.health.at).toLocaleString()}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('omnichannel.operations.col.lastEvent'),
      key: 'lastEvent',
      render: (_, row) =>
        row.lastEventAt === null ? t('omnichannel.operations.never') : new Date(row.lastEventAt).toLocaleString(),
    },
    {
      title: t('omnichannel.operations.col.awaiting'),
      dataIndex: 'awaitingConfirmation',
      align: 'right' as const,
    },
    {
      title: '',
      key: 'actions',
      render: (_, row) => (
        <Button
          size="small"
          disabled={!canProbe}
          loading={probe.isPending && probe.variables === row.key}
          onClick={() => probe.mutate(row.key)}
        >
          {t('omnichannel.operations.probe')}
        </Button>
      ),
    },
  ];

  const eventColumns: ColumnsType<OmnichannelOperationEvent> = [
    {
      title: t('omnichannel.operations.col.received'),
      dataIndex: 'receivedAt',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    { title: t('omnichannel.operations.col.type'), dataIndex: 'eventType' },
    { title: t('omnichannel.inbox.channel'), dataIndex: 'accountKey' },
    {
      title: t('omnichannel.operations.col.status'),
      key: 'status',
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag color={row.processingStatus === 'processed' ? 'success' : row.processingStatus === 'rejected' ? 'error' : 'warning'}>
            {row.processingStatus}
          </Tag>
          {row.signatureValid ? null : <Tag color="error">{t('omnichannel.operations.badSignature')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('omnichannel.operations.col.failure'),
      key: 'failure',
      render: (_, row) =>
        row.failureCode === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{row.failureCode}</Typography.Text>
        ),
    },
    {
      title: '',
      key: 'actions',
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" loading={inspect.isPending && inspect.variables === row.id} onClick={() => inspect.mutate(row.id)}>
            {t('omnichannel.operations.inspect')}
          </Button>
          <Button
            size="small"
            disabled={!canReplay || !row.signatureValid}
            loading={replay.isPending && replay.variables === row.id}
            onClick={() => replay.mutate(row.id)}
          >
            {t('omnichannel.operations.replay')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Segmented
          size="small"
          value={days}
          onChange={(value) => setDays(Number(value))}
          options={[
            { value: 1, label: t('omnichannel.operations.days', { count: 1 }) },
            { value: 7, label: t('omnichannel.operations.days', { count: 7 }) },
            { value: 30, label: t('omnichannel.operations.days', { count: 30 }) },
            { value: 90, label: t('omnichannel.operations.days', { count: 90 }) },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void overview.refetch()}>
          {t('omnichannel.page.reload')}
        </Button>
      </Space>

      <Alert type="info" showIcon message={t('omnichannel.operations.hint')} />

      {lastImpact === null ? null : (
        <Alert
          type={lastImpact.account.enabled ? 'success' : 'warning'}
          showIcon
          message={`${t('omnichannel.operations.impact')} — ${lastImpact.account.key}: ${lastImpact.account.enabled ? t('omnichannel.operations.enabled') : t('omnichannel.operations.disabled')}`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('omnichannel.operations.impactOutbound')}: {lastImpact.impact.outbound}</li>
              <li>{t('omnichannel.operations.impactInbound')}: {lastImpact.impact.inbound}</li>
              <li>{t('omnichannel.operations.impactHistory')}: {lastImpact.impact.history}</li>
              <li>{t('omnichannel.operations.impactAwaiting', { count: lastImpact.impact.awaitingConfirmation })}</li>
            </ul>
          }
          closable
          onClose={() => setLastImpact(null)}
        />
      )}

      <Card size="small" title={t('omnichannel.operations.accounts')}>
        <Table rowKey="key" size="small" pagination={false} columns={accountColumns} dataSource={[...view.accounts]} />
      </Card>

      <Card size="small" title={t('omnichannel.operations.receipts')}>
        <Space wrap>
          {view.receipts.length === 0 ? (
            <Typography.Text type="secondary">{t('omnichannel.operations.noReceipts')}</Typography.Text>
          ) : (
            view.receipts.map((row) => (
              <Tag key={row.status} color={row.status === 'processed' ? 'success' : row.status === 'rejected' ? 'error' : 'warning'}>
                {row.status}: {row.count}
              </Tag>
            ))
          )}
        </Space>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">{t('omnichannel.operations.failures')}: </Typography.Text>
          {view.failures.length === 0 ? (
            <Typography.Text type="secondary">{t('omnichannel.operations.noFailures')}</Typography.Text>
          ) : (
            view.failures.map((row) => (
              <Tag key={row.code} color="error">
                {row.code}: {row.count}
              </Tag>
            ))
          )}
        </div>
      </Card>

      <Card size="small" title={t('omnichannel.operations.events')}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('omnichannel.operations.eventsHint')}
        </Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={eventColumns}
          dataSource={[...(events.data?.list ?? [])]}
          locale={{ emptyText: t('omnichannel.operations.noReceipts') }}
        />
      </Card>

      <Modal
        open={inspected !== null}
        title={t('omnichannel.operations.payload')}
        footer={<Button onClick={() => setInspected(null)}>{t('omnichannel.operations.close')}</Button>}
        onCancel={() => setInspected(null)}
        width={720}
      >
        {inspected === null ? null : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {inspected.eventType} · {inspected.accountKey} · {inspected.processingStatus}
            </Typography.Text>
            <pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
              {JSON.stringify(inspected.payload, null, 2)}
            </pre>
          </Space>
        )}
      </Modal>
    </Space>
  );
}
