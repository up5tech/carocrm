import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Drawer, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationConnection, IntegrationSyncOperation, IntegrationSyncRun } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatDuration,PanelEmpty } from './shared.js';

/**
 * Phase 19-INT.15 — the sync run history
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.5).
 *
 * A run list is only useful if an operator can get from "it failed" to "this record failed
 * because of this field". The run list shows the counts and the error; the drawer shows the
 * **operations**, and an operation that failed can be retried **on its own** — the run and the
 * checkpoint are untouched, so retrying one record never restarts the whole sync.
 */
export function IntegrationsRunsTab() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  const connections = useQuery({
    queryKey: ['advancedIntegrations', 'connections'],
    queryFn: () => api.integrationConnections(),
    staleTime: 30_000,
  });

  const runs = useQuery({
    queryKey: ['advancedIntegrations', 'runs', connectionId],
    queryFn: () => api.integrationRuns(connectionId ?? ''),
    enabled: connectionId !== null,
    staleTime: 10_000,
  });

  const operations = useQuery({
    queryKey: ['advancedIntegrations', 'run', openRunId, 'operations', statusFilter],
    queryFn: () => api.integrationRunOperations(openRunId ?? '', statusFilter ? { status: statusFilter } : {}),
    enabled: openRunId !== null,
    staleTime: 5_000,
  });

  const retry = useMutation({
    mutationFn: (operationId: string) => api.integrationOperationRetry(operationId),
    onSuccess: async () => {
      message.success(t('advancedintegrations.runs.retryQueued'));
      await queryClient.invalidateQueries({ queryKey: ['advancedIntegrations'] });
    },
  });

  const connectionList = connections.data?.list ?? [];
  const selectedConnection = useMemo(
    () => connectionList.find((connection) => connection.id === connectionId) ?? null,
    [connectionList, connectionId],
  );

  if (connections.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;

  return (
    <div>
      <div className="carocrm-list-head">
        <div>
          <div className="carocrm-page-title">{t('advancedintegrations.runs.title')}</div>
          <p className="carocrm-page-sub">{t('advancedintegrations.runs.subtitle')}</p>
        </div>
        <Space>
          <Select
            allowClear
            placeholder={t('advancedintegrations.runs.selectConnection')}
            value={connectionId ?? undefined}
            onChange={(value) => setConnectionId(value ?? null)}
            style={{ minWidth: 240 }}
            options={connectionList.map((connection: IntegrationConnection) => ({
              value: connection.id,
              label: `${connection.name} · ${connection.providerKey}`,
            }))}
          />
          <Button onClick={() => void runs.refetch()}>{t('core.common.refresh')}</Button>
        </Space>
      </div>

      {connectionId === null ? (
        <PanelEmpty text={t('advancedintegrations.runs.selectPrompt')} />
      ) : runs.isLoading ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (runs.data?.list ?? []).length === 0 ? (
        <PanelEmpty text={t('advancedintegrations.runs.empty')} />
      ) : (
        <Table<IntegrationSyncRun>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={runs.data?.list ?? []}
          onRow={(row) => ({ onClick: () => setOpenRunId(row.id) })}
          rowClassName="carocrm-clickable-row"
          columns={[
            {
              title: t('advancedintegrations.runs.status'),
              dataIndex: 'status',
              render: (status: string) => <Tag color={status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'default'}>{status}</Tag>,
            },
            { title: t('advancedintegrations.runs.type'), dataIndex: 'runType' },
            {
              title: t('advancedintegrations.runs.counts'),
              dataIndex: 'recordsScanned',
              render: (_: number, row) => (
                <span className="carocrm-wire-meta">
                  {t('advancedintegrations.runs.scanned')} {String(row.recordsScanned)} ·{' '}
                  {t('advancedintegrations.runs.applied')} {String(row.recordsApplied)} ·{' '}
                  {t('advancedintegrations.runs.skipped')} {String(row.recordsSkipped)} ·{' '}
                  {t('advancedintegrations.runs.failed')} {String(row.recordsFailed)}
                </span>
              ),
            },
            {
              title: t('advancedintegrations.runs.duration'),
              dataIndex: 'startedAt',
              render: (_: string | null, row) => (
                <span className="carocrm-wire-meta">{runDuration(row)}</span>
              ),
            },
            {
              title: t('advancedintegrations.runs.cursor'),
              dataIndex: 'cursorAfter',
              render: (cursor: string | null) => (
                <span className="carocrm-wire-meta">{cursor ?? '—'}</span>
              ),
            },
            {
              title: t('advancedintegrations.runs.version'),
              dataIndex: 'mappingVersion',
              render: (version: number) => <span className="carocrm-wire-meta">v{String(version)}</span>,
            },
            {
              title: t('advancedintegrations.runs.error'),
              dataIndex: 'lastErrorCode',
              render: (code: string | null, row) =>
                code === null ? (
                  '—'
                ) : (
                  <span className="carocrm-wire-meta">
                    {code}
                    {row.lastErrorDetail === null ? '' : ` — ${row.lastErrorDetail}`}
                  </span>
                ),
            },
          ]}
        />
      )}

      <Drawer
        open={openRunId !== null}
        onClose={() => setOpenRunId(null)}
        width={860}
        title={t('advancedintegrations.runs.operations')}
        destroyOnClose
      >
        {openRunId === null ? null : (
          <div>
            <div className="carocrm-list-head" style={{ marginBottom: 12 }}>
              <div className="carocrm-wire-meta">
                {selectedConnection === null ? '' : `${selectedConnection.name} · ${selectedConnection.providerKey}`}
              </div>
              <Select
                allowClear
                placeholder={t('advancedintegrations.runs.filterStatus')}
                value={statusFilter}
                onChange={(value) => setStatusFilter(value ?? undefined)}
                style={{ minWidth: 200 }}
                options={['pending', 'applied', 'skipped', 'failed', 'dead_letter'].map((status) => ({
                  value: status,
                  label: status,
                }))}
              />
            </div>

            {operations.isLoading ? (
              <Skeleton active paragraph={{ rows: 5 }} />
            ) : (operations.data?.list ?? []).length === 0 ? (
              <PanelEmpty text={t('advancedintegrations.runs.noOperations')} />
            ) : (
              <Table<IntegrationSyncOperation>
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={operations.data?.list ?? []}
                columns={[
                  {
                    title: t('advancedintegrations.runs.operation'),
                    dataIndex: 'operationType',
                    render: (type: string, row) => (
                      <Space direction="vertical" size={0}>
                        <span>{type}</span>
                        <span className="carocrm-wire-meta">{row.externalId ?? '—'}</span>
                      </Space>
                    ),
                  },
                  {
                    title: t('advancedintegrations.runs.status'),
                    dataIndex: 'status',
                    render: (status: string) => (
                      <Tag
                        color={
                          status === 'applied'
                            ? 'green'
                            : status === 'failed' || status === 'dead_letter'
                              ? 'red'
                              : status === 'skipped'
                                ? 'default'
                                : 'blue'
                        }
                      >
                        {status.replaceAll('_', ' ')}
                      </Tag>
                    ),
                  },
                  {
                    title: t('advancedintegrations.runs.attempts'),
                    dataIndex: 'attempts',
                    render: (attempts: number) => <span className="carocrm-wire-meta">{String(attempts)}</span>,
                  },
                  {
                    title: t('advancedintegrations.runs.error'),
                    dataIndex: 'errorCode',
                    render: (code: string | null, row) => (
                      <span className="carocrm-wire-meta">
                        {code ?? '—'}
                        {row.errorDetail === null ? '' : ` — ${row.errorDetail}`}
                      </span>
                    ),
                  },
                  {
                    title: '',
                    dataIndex: 'retryable',
                    render: (retryable: boolean, row) =>
                      retryable ? (
                        <Button size="small" loading={retry.isPending} onClick={() => retry.mutate(row.id)}>
                          {t('advancedintegrations.runs.retry')}
                        </Button>
                      ) : (
                        <Typography.Text type="secondary" className="carocrm-quiet">
                          —
                        </Typography.Text>
                      ),
                  },
                ]}
              />
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function runDuration(run: IntegrationSyncRun): string {
  if (run.startedAt === null || run.finishedAt === null) return '—';
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return '—';
  return formatDuration(Math.max(0, (finished - started) / 1000));
}
