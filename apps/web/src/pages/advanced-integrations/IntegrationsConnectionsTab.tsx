import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Skeleton, Space, Table } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationConnection } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { IntegrationDetailPanel } from './IntegrationDetailPanel.js';
import { ConnectionStatusPill, formatTimestamp, MaskedCredential, PanelEmpty, SectionToolbar } from './shared.js';

/**
 * Phase 19-INT.14 — the connection list
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.3).
 *
 * The list is the operator's map of the wires. Each row answers, at a glance: which provider, what
 * state, who owns it, whether a credential is stored, whether the permissions it needs are all
 * there, and when it last synced. The detail panel opens on top of it — the list stays the
 * orientation, the panel holds the actions.
 */
export function IntegrationsConnectionsTab() {
  const [selected, setSelected] = useState<IntegrationConnection | null>(null);
  const connections = useQuery({
    queryKey: ['advancedIntegrations', 'connections'],
    queryFn: () => api.integrationConnections(),
    staleTime: 15_000,
  });
  const list = connections.data?.list ?? [];

  return (
    <div>
      <SectionToolbar
        title={t('advancedintegrations.connections.title')}
        subtitle={t('advancedintegrations.connections.subtitle')}
        actions={<Button onClick={() => void connections.refetch()}>{t('core.common.refresh')}</Button>}
      />

      {connections.isLoading ? (
        <div className="carocrm-int-loading">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : connections.isError ? (
        <div className="carocrm-int-state">
          <PanelEmpty
            text={t('advancedintegrations.connections.loadFailed')}
            action={<Button onClick={() => void connections.refetch()}>{t('core.common.reload')}</Button>}
          />
        </div>
      ) : list.length === 0 ? (
        <div className="carocrm-int-state">
          <PanelEmpty text={t('advancedintegrations.connections.empty')} />
        </div>
      ) : (
        <>
          <Table<IntegrationConnection>
            className="carocrm-int-table"
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={list}
            onRow={(row) => ({ onClick: () => setSelected(row) })}
            rowClassName="carocrm-clickable-row"
            columns={[
              {
                title: t('advancedintegrations.connections.name'),
                dataIndex: 'name',
                render: (name: string, row) => (
                  <Space direction="vertical" size={0}>
                    <span className="carocrm-wire-name">{name}</span>
                    <span className="carocrm-wire-meta">{row.providerKey}</span>
                  </Space>
                ),
              },
              {
                title: t('advancedintegrations.connections.status'),
                dataIndex: 'status',
                render: (status: IntegrationConnection['status']) => <ConnectionStatusPill status={status} />,
              },
              {
                title: t('advancedintegrations.connections.owner'),
                dataIndex: 'ownerType',
                render: (_: string, row) => (
                  <span className="carocrm-wire-meta">
                    {row.ownerType === 'organization'
                      ? t('advancedintegrations.wizard.organization')
                      : row.ownerId}
                  </span>
                ),
              },
              {
                title: t('advancedintegrations.connections.credential'),
                dataIndex: 'hasCredential',
                render: (_: boolean, row) => (
                  <MaskedCredential
                    hasCredential={row.hasCredential}
                    hint={row.credentialHint}
                    storedLabel={t('advancedintegrations.connections.hasCredential')}
                    noneLabel={t('advancedintegrations.connections.noCredential')}
                  />
                ),
              },
              {
                title: t('advancedintegrations.connections.missingScopes'),
                dataIndex: 'missingScopes',
                render: (missing: readonly string[]) =>
                  missing.length === 0 ? (
                    <span className="carocrm-pill carocrm-pill--green">
                      {t('advancedintegrations.connections.allScopesGranted')}
                    </span>
                  ) : (
                    <span className="carocrm-pill carocrm-pill--amber">{String(missing.length)}</span>
                  ),
              },
              {
                title: t('advancedintegrations.connections.lastSync'),
                dataIndex: 'lastSuccessfulSyncAt',
                render: (value: string | null) => (
                  <span className="carocrm-wire-meta">{formatTimestamp(value)}</span>
                ),
              },
            ]}
          />

          <Drawer
            open={selected !== null}
            onClose={() => setSelected(null)}
            width={720}
            title={selected === null ? '' : selected.name}
            destroyOnClose
          >
            {selected === null ? null : (
              <IntegrationDetailPanel
                connectionId={selected.id}
                onChanged={() => void connections.refetch()}
              />
            )}
          </Drawer>
        </>
      )}
    </div>
  );
}
