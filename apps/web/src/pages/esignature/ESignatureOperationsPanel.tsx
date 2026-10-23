import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Badge, Button, Card, Col, Row, Select, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../api/client.js';
import type {
  ESignatureConnectionHealth,
  ESignatureFailedJob,
  ESignatureRecoveryList,
  ESignatureRecoveryRequest,
  ESignatureWebhookDelivery,
} from '../../api/types.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.20 — the admin operations and recovery workbench
 * (`PLAN_Phase_19_ESignature.md` §13.5, §14, §16, §18 `19-ES.20`).
 *
 * The panel is a read-only diagnostic surface plus two narrowly scoped commands:
 *
 *  - **Retry an inbound delivery** — offered only when the server marks it retryable and the
 *    delivery's signature verified. It re-applies provider evidence; it never contacts DocuSign and
 *    never re-sends an envelope.
 *  - **Reconcile a request** — the existing ES.12 command, which reads the provider's answer. A
 *    definite send failure (`provider_error`) is deliberately not offered here: its only recovery is
 *    the deliberate recover→send path on the request detail, which the server also enforces.
 *
 * Every value is redacted diagnostics. No request name, recipient, document, token or URL is present
 * in the payload, so none can be rendered here.
 */
const STALE_WINDOWS = [1, 6, 24, 72, 168] as const;

export function ESignatureOperationsPanel() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [staleAfterHours, setStaleAfterHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);

  const operations = useQuery({
    queryKey: ['eSignature', 'operations', staleAfterHours],
    queryFn: () => api.eSignatureOperations({ staleAfterHours, limit: 25 }),
    staleTime: 15_000,
  });

  const reload = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['eSignature', 'operations'] });
  };

  const retryDelivery = async (deliveryId: string): Promise<void> => {
    setBusy(deliveryId);
    try {
      const result = await api.retryESignatureWebhook(deliveryId);
      message.success(t('esignature.operations.retried', { outcome: result.status }));
      await reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.operations.retryFailed'));
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async (requestId: string): Promise<void> => {
    setBusy(requestId);
    try {
      await api.reconcileESignatureRequest(requestId);
      message.success(t('esignature.operations.reconciled'));
      await Promise.all([
        reload(),
        queryClient.invalidateQueries({ queryKey: ['eSignature', 'request', requestId] }),
      ]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.operations.reconcileFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (operations.isLoading) return <LoadingSkeleton rows={8} />;
  if (operations.isError || operations.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.operations.loadFailed')} ${operations.error instanceof Error ? operations.error.message : ''}`}
        onRetry={() => void operations.refetch()}
      />
    );
  }
  const view = operations.data;
  const checks = view.checks;

  return (
    <Card
      className="carocrm-card"
      title={
        <Space size={8}>
          <WarningOutlined />
          {t('esignature.operations.title')}
        </Space>
      }
      extra={
        <Space size={8} wrap>
          <Select
            size="small"
            style={{ minWidth: 150 }}
            value={staleAfterHours}
            onChange={setStaleAfterHours}
            options={STALE_WINDOWS.map((hours) => ({ value: hours, label: t('esignature.operations.staleHours', { hours }) }))}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void operations.refetch()}>
            {t('core.common.reload')}
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {view.moduleEnabled ? null : (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('esignature.operations.moduleOff')} />
      )}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {checks.map((check) => (
          <Col xs={24} md={12} xl={8} key={check.name}>
            <Card size="small">
              <Space size={8} align="start">
                <Tag color={check.ok ? 'green' : 'red'}>{check.ok ? t('esignature.operations.checkOk') : t('esignature.operations.checkAttention')}</Tag>
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{t(`esignature.operations.checks.${check.name}`)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {check.detail}
                  </Typography.Text>
                </Space>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Card size="small" title={t('esignature.operations.connections')} style={{ marginBottom: 16 }}>
        <Table<ESignatureConnectionHealth>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...view.connections]}
          columns={connectionColumns()}
          locale={{ emptyText: t('esignature.operations.noConnections') }}
        />
      </Card>

      <Card size="small" title={t('esignature.operations.webhookTitle')} style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} md={6}>
            <Statistic title={t('esignature.operations.webhookTotal')} value={view.webhook.total} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={t('esignature.operations.webhookPending')} value={(view.webhook.countsByState['received'] ?? 0) + (view.webhook.countsByState['retryable'] ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={t('esignature.operations.webhookDeadLetter')} value={view.webhook.countsByState['dead_letter'] ?? 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={t('esignature.operations.webhookLag')} value={view.webhook.pendingLagMinutes ?? '—'} suffix={view.webhook.pendingLagMinutes === null ? '' : ' min'} />
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('esignature.operations.webhookReceived', {
            last: view.webhook.lastReceivedAt === null ? '—' : formatMoment(view.webhook.lastReceivedAt),
            invalid: String(view.webhook.signatureStatus.invalid),
          })}
        </Typography.Text>
        <Table<ESignatureWebhookDelivery>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...view.webhook.deliveries]}
          columns={deliveryColumns(view.actions.canRetryWebhook, busy, retryDelivery)}
          locale={{ emptyText: t('esignature.operations.noDeliveries') }}
        />
      </Card>

      <Card size="small" title={t('esignature.operations.queuesTitle')} style={{ marginBottom: 16 }}>
        {view.requestAccess === 'none' ? (
          <Alert type="info" showIcon message={t('esignature.operations.noRequestAccess')} />
        ) : (
          <Tabs
            items={[
              queueTab('failed', view.worklists.failed, view.actions.canReconcile, busy, reconcile),
              queueTab('stuck', view.worklists.stuck, view.actions.canReconcile, busy, reconcile),
              queueTab('sendUnknown', view.worklists.sendUnknown, view.actions.canReconcile, busy, reconcile),
              queueTab('reconciliation', view.worklists.reconciliation, view.actions.canReconcile, busy, reconcile),
            ]}
          />
        )}
      </Card>

      <Card size="small" title={t('esignature.operations.jobsTitle')}>
        <Table<ESignatureFailedJob>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...view.failedJobs.items]}
          columns={jobColumns()}
          locale={{ emptyText: t('esignature.operations.noJobs') }}
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          {t('esignature.operations.jobsHint')}{' '}
          <Link to="/admin/jobs">{t('esignature.operations.openJobs')}</Link>
        </Typography.Text>
      </Card>
    </Card>
  );
}

function connectionColumns(): ColumnsType<ESignatureConnectionHealth> {
  return [
    {
      title: t('esignature.operations.columnConnection'),
      key: 'connection',
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{row.name}</Typography.Text>
            <Tag>{row.environment}</Tag>
            {row.isActive ? null : <Tag color="red">{t('esignature.operations.inactive')}</Tag>}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.accountName ?? '—'} · {row.adapterMode}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('esignature.operations.columnHealth'),
      key: 'health',
      render: (_value, row) => (
        <Space direction="vertical" size={2}>
          <Tag color={row.health === 'ok' ? 'green' : row.health === 'attention' ? 'orange' : 'red'}>
            {t(`esignature.operations.health.${row.health}`)}
          </Tag>
          <Space size={[4, 4]} wrap>
            {row.issues.slice(0, 3).map((issue) => (
              <Tag key={issue}>{tOr(`esignature.operations.issues.${issue}`, issue)}</Tag>
            ))}
          </Space>
        </Space>
      ),
    },
    {
      title: t('esignature.operations.columnToken'),
      key: 'token',
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={row.token.state === 'valid' ? 'green' : row.token.state === 'expiring' ? 'orange' : 'red'}>
            {t(`esignature.operations.tokenStates.${row.token.state}`)}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.token.expiresAt === null ? '—' : formatMoment(row.token.expiresAt)}
            {row.token.hasRefreshToken ? '' : ` · ${t('esignature.operations.noRefresh')}`}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('esignature.operations.columnWebhook'),
      key: 'webhook',
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={row.webhook.configured ? 'green' : 'red'}>
            {row.webhook.configured ? t('esignature.operations.configured') : t('esignature.operations.notConfigured')}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('esignature.operations.webhookCounts', {
              pending: String(row.webhook.pending),
              dead: String(row.webhook.deadLetter),
            })}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('esignature.operations.columnLastApi'),
      key: 'api',
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>{row.lastSuccessfulApiAt === null ? '—' : formatMoment(row.lastSuccessfulApiAt)}</Typography.Text>
          {row.lastErrorAt === null ? null : (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {row.lastErrorCode ?? '—'} · {formatMoment(row.lastErrorAt)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
  ];
}

function deliveryColumns(
  canRetry: boolean,
  busy: string | null,
  retry: (id: string) => Promise<void>,
): ColumnsType<ESignatureWebhookDelivery> {
  return [
    { title: t('esignature.operations.columnReceived'), dataIndex: 'receivedAt', width: 180, render: (value: string) => formatMoment(value) },
    {
      title: t('esignature.operations.columnEnvelope'),
      dataIndex: 'providerEnvelopeId',
      render: (value: string | null) => <Typography.Text code>{shortId(value)}</Typography.Text>,
    },
    {
      title: t('esignature.operations.columnState'),
      dataIndex: 'state',
      render: (value: string) => <Tag color={value === 'dead_letter' ? 'red' : 'orange'}>{value}</Tag>,
    },
    {
      title: t('esignature.operations.columnSignature'),
      dataIndex: 'signatureStatus',
      render: (value: string) => <Tag color={value === 'verified' ? 'green' : value === 'invalid' ? 'red' : 'default'}>{value}</Tag>,
    },
    { title: t('esignature.operations.columnAttempts'), dataIndex: 'attemptCount', width: 90 },
    {
      title: t('esignature.operations.columnError'),
      dataIndex: 'lastErrorSafe',
      render: (value: string | null) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value ?? '—'}</Typography.Text>,
    },
    {
      title: t('esignature.operations.columnAction'),
      key: 'action',
      width: 120,
      render: (_value, row) =>
        canRetry && row.retryAllowed ? (
          <Button size="small" loading={busy === row.id} onClick={() => void retry(row.id)}>
            {t('esignature.operations.retry')}
          </Button>
        ) : (
          <Typography.Text type="secondary">{t('esignature.operations.noAction')}</Typography.Text>
        ),
    },
  ];
}

function queueTab(
  key: string,
  list: ESignatureRecoveryList,
  canReconcile: boolean,
  busy: string | null,
  reconcile: (id: string) => Promise<void>,
) {
  return {
    key,
    label: (
      <Space size={6}>
        {t(`esignature.operations.queues.${key}`)}
        <Badge count={list.count} size="small" />
      </Space>
    ),
    children: (
      <Table<ESignatureRecoveryRequest>
        size="small"
        rowKey="id"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={[...list.items]}
        locale={{ emptyText: t('esignature.operations.noRows') }}
        columns={[
          {
            title: t('esignature.operations.columnRequest'),
            dataIndex: 'id',
            render: (value: string) => (
              <Link to={`/esignature?request=${encodeURIComponent(value)}`}>
                <Typography.Text code>{shortId(value)}</Typography.Text>
              </Link>
            ),
          },
          {
            title: t('esignature.operations.columnStatus'),
            dataIndex: 'status',
            render: (value: string) => <Tag>{t(`esignature.requests.statuses.${value}`)}</Tag>,
          },
          {
            title: t('esignature.operations.columnAge'),
            dataIndex: 'ageHours',
            width: 100,
            render: (value: number) => `${String(value)} h`,
          },
          {
            title: t('esignature.operations.columnFailure'),
            dataIndex: 'failureCode',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: t('esignature.operations.columnAction'),
            key: 'action',
            width: 130,
            render: (_value, row) =>
              canReconcile && row.reconcileAllowed ? (
                <Button size="small" loading={busy === row.id} onClick={() => void reconcile(row.id)}>
                  {t('esignature.operations.reconcile')}
                </Button>
              ) : (
                <Typography.Text type="secondary">
                  {row.reconcileAllowed ? t('esignature.operations.noAction') : t('esignature.operations.sendRecoveryHint')}
                </Typography.Text>
              ),
          },
        ]}
      />
    ),
  };
}

function jobColumns(): ColumnsType<ESignatureFailedJob> {
  return [
    { title: t('esignature.operations.columnJob'), dataIndex: 'job' },
    {
      title: t('esignature.operations.columnAttempts'),
      key: 'attempts',
      width: 100,
      render: (_value, row) => `${String(row.attempt)}/${String(row.maxAttempts)}`,
    },
    {
      title: t('esignature.operations.columnFinished'),
      dataIndex: 'finishedAt',
      width: 180,
      render: (value: string | null) => (value === null ? '—' : formatMoment(value)),
    },
    {
      title: t('esignature.operations.columnError'),
      dataIndex: 'lastError',
      render: (value: string | null) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value ?? '—'}</Typography.Text>,
    },
  ];
}

function shortId(value: string | null): string {
  if (value === null || value === '') return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatMoment(value: string): string {
  return new Date(value).toLocaleString();
}

function tOr(key: string, fallback: string): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}
