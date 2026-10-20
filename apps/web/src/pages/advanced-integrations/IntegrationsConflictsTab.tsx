import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Drawer, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationConflict, IntegrationConflictResolution } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp, PanelEmpty, SectionToolbar } from './shared.js';

/**
 * Phase 19-INT.15 — the conflict workbench
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.5).
 *
 * A conflict is a record that changed on **both** sides. The workbench shows the two sides side
 * by side, field by field, with the changed fields marked — and it says which rule decides the
 * winner, because "the provider wins" and "the CRM wins" are different decisions with different
 * consequences.
 *
 * Two things are deliberate:
 *
 *  - **A stale conflict cannot be resolved with the provider's value.** If the record moved again
 *    after the conflict was detected, the operator is looking at a comparison of two old states. The
 *    server refuses it; the UI says why before the operator tries.
 *  - **A resolution is a deliberate act.** The buttons are disabled with a reason, not hidden, so an
 *    operator can see *why* an action is unavailable.
 */
export function IntegrationsConflictsTab() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [openConflictId, setOpenConflictId] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['advancedIntegrations', 'connections'],
    queryFn: () => api.integrationConnections(),
    staleTime: 30_000,
  });

  const conflicts = useQuery({
    queryKey: ['advancedIntegrations', 'conflicts', connectionId],
    queryFn: () => api.integrationConflicts(connectionId ?? ''),
    enabled: connectionId !== null,
    staleTime: 10_000,
  });

  const conflict = useQuery({
    queryKey: ['advancedIntegrations', 'conflict', openConflictId],
    queryFn: () => api.integrationConflict(openConflictId ?? ''),
    enabled: openConflictId !== null,
    staleTime: 5_000,
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; resolution: IntegrationConflictResolution }) =>
      api.integrationConflictResolve(input.id, input.resolution),
    onSuccess: async () => {
      message.success(t('advancedintegrations.conflicts.resolved'));
      await queryClient.invalidateQueries({ queryKey: ['advancedIntegrations'] });
    },
  });

  const connectionList = connections.data?.list ?? [];

  return (
    <div>
      <SectionToolbar
        title={t('advancedintegrations.conflicts.title')}
        subtitle={t('advancedintegrations.conflicts.subtitle')}
        actions={
          <>
            <Select
              allowClear
              className="carocrm-int-select"
              placeholder={t('advancedintegrations.conflicts.selectConnection')}
              value={connectionId ?? undefined}
              onChange={(value) => setConnectionId(value ?? null)}
              options={connectionList.map((connection) => ({
                value: connection.id,
                label: `${connection.name} · ${connection.providerKey}`,
              }))}
            />
            <Button onClick={() => void conflicts.refetch()}>{t('core.common.refresh')}</Button>
          </>
        }
      />

      {connections.isLoading ? (
        <div className="carocrm-int-loading">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : connectionId === null ? (
        <div className="carocrm-int-state">
          <PanelEmpty text={t('advancedintegrations.conflicts.selectPrompt')} />
        </div>
      ) : conflicts.isLoading ? (
        <div className="carocrm-int-loading">
          <Skeleton active paragraph={{ rows: 5 }} />
        </div>
      ) : (conflicts.data?.list ?? []).length === 0 ? (
        <div className="carocrm-int-state">
          <PanelEmpty text={t('advancedintegrations.conflicts.empty')} />
        </div>
      ) : (
        <Table<IntegrationConflict>
          className="carocrm-int-table"
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={conflicts.data?.list ?? []}
          onRow={(row) => ({ onClick: () => setOpenConflictId(row.id) })}
          rowClassName="carocrm-clickable-row"
          columns={[
            {
              title: t('advancedintegrations.conflicts.type'),
              dataIndex: 'conflictType',
              render: (type: string) => <Tag color={type === 'duplicate' ? 'gold' : 'default'}>{type.replaceAll('_', ' ')}</Tag>,
            },
            {
              title: t('advancedintegrations.conflicts.object'),
              dataIndex: 'externalId',
              render: (externalId: string, row) => (
                <Space direction="vertical" size={0}>
                  <span className="carocrm-wire-name">{externalId}</span>
                  <span className="carocrm-wire-meta">
                    {row.objectType}
                    {row.crmEntityType === null ? '' : ` → ${row.crmEntityType}`}
                  </span>
                </Space>
              ),
            },
            {
              title: t('advancedintegrations.conflicts.fields'),
              dataIndex: 'conflictingFields',
              render: (fields: Record<string, unknown>) => (
                <span className="carocrm-wire-meta">{Object.keys(fields).join(', ') || '—'}</span>
              ),
            },
            {
              title: t('advancedintegrations.conflicts.policy'),
              dataIndex: 'policy',
              render: (policy: string) => <span className="carocrm-wire-meta">{policy.replaceAll('_', ' ')}</span>,
            },
            {
              title: t('advancedintegrations.conflicts.detected'),
              dataIndex: 'createdAt',
              render: (createdAt: string) => (
                <span className="carocrm-wire-meta">{formatTimestamp(createdAt)}</span>
              ),
            },
          ]}
        />
      )}

      <Drawer
        open={openConflictId !== null}
        onClose={() => setOpenConflictId(null)}
        width={860}
        title={t('advancedintegrations.conflicts.workbench')}
        destroyOnClose
      >
        {openConflictId === null || conflict.isLoading || conflict.data === undefined ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <ConflictWorkbench
            conflict={conflict.data}
            resolving={resolve.isPending}
            onResolve={(resolution) => resolve.mutate({ id: conflict.data.id, resolution })}
          />
        )}
      </Drawer>
    </div>
  );
}

function ConflictWorkbench({
  conflict,
  resolving,
  onResolve,
}: {
  readonly conflict: IntegrationConflict;
  readonly resolving: boolean;
  readonly onResolve: (resolution: IntegrationConflictResolution) => void;
}) {
  const fields = Object.keys(conflict.conflictingFields);

  return (
    <div>
      {conflict.stale ? (
        <Alert
          type="warning"
          showIcon
          message={t('advancedintegrations.conflicts.stale')}
          description={t('advancedintegrations.conflicts.staleHint', { side: conflict.staleSide ?? '—' })}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div className="carocrm-diff">
        <div className="carocrm-diff-side carocrm-diff-side--local">
          <div className="carocrm-label" style={{ marginBottom: 8 }}>
            {t('advancedintegrations.conflicts.local')}
          </div>
          {fields.length === 0 ? (
            <Typography.Text type="secondary" className="carocrm-quiet">
              {t('advancedintegrations.conflicts.noFields')}
            </Typography.Text>
          ) : (
            fields.map((field) => (
              <div key={field} className="carocrm-diff-field carocrm-diff-field--changed">
                <span>
                  {field}{' '}
                  {conflict.fieldAuthority[field] === undefined ? null : (
                    <Tag color="blue">{conflict.fieldAuthority[field]}</Tag>
                  )}
                </span>
                <span className="carocrm-diff-value">
                  {renderValue(conflict.conflictingFields[field]?.local)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="carocrm-diff-side carocrm-diff-side--remote">
          <div className="carocrm-label" style={{ marginBottom: 8 }}>
            {t('advancedintegrations.conflicts.remote')}
          </div>
          {fields.length === 0 ? (
            <Typography.Text type="secondary" className="carocrm-quiet">
              {t('advancedintegrations.conflicts.noFields')}
            </Typography.Text>
          ) : (
            fields.map((field) => (
              <div key={field} className="carocrm-diff-field carocrm-diff-field--changed">
                <span>{field}</span>
                <span className="carocrm-diff-value">
                  {renderValue(conflict.conflictingFields[field]?.remote)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        {t('advancedintegrations.conflicts.authorityHint')}
      </Typography.Paragraph>

      <Space wrap>
        {conflict.resolutions.map((option) => (
          <Button
            key={option.value}
            disabled={!option.enabled}
            loading={resolving}
            title={option.reason ?? undefined}
            onClick={() => onResolve(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </Space>
    </div>
  );
}

/** A value, rendered without ever assuming it is a string. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}
