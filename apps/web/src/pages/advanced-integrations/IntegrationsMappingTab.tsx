import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationMappingView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp,PanelEmpty, WarningList } from './shared.js';

/**
 * Phase 19-INT.15 — the mapping builder
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.4).
 *
 * The builder is a **two-pane view with a wire between them**: the provider's fields on the left,
 * the CRM's fields on the right, and the transformation in the middle. A mapping is a routing
 * decision, and the layout says so before any word is read.
 *
 * The warnings are the reason the pane exists. An unmapped required field, a lossy conversion and
 * a sensitive target are all things an operator should see *before* publishing, so they are listed
 * above the panes rather than discovered afterwards.
 */
export function IntegrationsMappingTab() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mappings = useQuery({
    queryKey: ['advancedIntegrations', 'mappings'],
    queryFn: () => api.integrationMappings(),
    staleTime: 15_000,
  });

  const selected = useMemo(
    () => (mappings.data?.list ?? []).find((mapping) => mapping.id === selectedId) ?? null,
    [mappings.data, selectedId],
  );

  const fields = useQuery({
    queryKey: ['advancedIntegrations', 'mapping', selectedId, 'fields'],
    queryFn: () => api.integrationMappingFields(selectedId ?? ''),
    enabled: selectedId !== null,
    staleTime: 15_000,
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.integrationMappingActivate(id),
    onSuccess: async () => {
      message.success(t('advancedintegrations.mapping.published'));
      await queryClient.invalidateQueries({ queryKey: ['advancedIntegrations'] });
    },
  });

  if (mappings.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (mappings.isError) {
    return (
      <PanelEmpty
        text={t('advancedintegrations.mapping.loadFailed')}
        action={<Button onClick={() => void mappings.refetch()}>{t('core.common.reload')}</Button>}
      />
    );
  }

  const list = mappings.data?.list ?? [];
  if (list.length === 0) {
    return <PanelEmpty text={t('advancedintegrations.mapping.empty')} />;
  }

  return (
    <div>
      <div className="carocrm-list-head">
        <div>
          <div className="carocrm-page-title">{t('advancedintegrations.mapping.title')}</div>
          <p className="carocrm-page-sub">{t('advancedintegrations.mapping.subtitle')}</p>
        </div>
        <Button onClick={() => void mappings.refetch()}>{t('core.common.refresh')}</Button>
      </div>

      <div className="carocrm-wiring" style={{ gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)' }}>
        <div className="carocrm-wiring-pane">
          <div className="carocrm-wiring-pane-title">
            <span className="carocrm-label">{t('advancedintegrations.mapping.select')}</span>
          </div>
          {list.map((mapping) => (
            <MappingChoice
              key={mapping.id}
              mapping={mapping}
              selected={mapping.id === selectedId}
              onSelect={() => setSelectedId(mapping.id)}
            />
          ))}
        </div>

        <div>
          {selected === null ? (
            <PanelEmpty text={t('advancedintegrations.mapping.selectPrompt')} />
          ) : (
            <MappingDetail
              mapping={selected}
              fields={fields.data}
              loading={fields.isLoading}
              onPublish={() => publish.mutate(selected.id)}
              publishing={publish.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MappingChoice({
  mapping,
  selected,
  onSelect,
}: {
  readonly mapping: IntegrationMappingView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: selected ? '1px solid #438eff' : '1px solid transparent',
        borderRadius: 6,
        padding: '8px 10px',
        background: selected ? '#f7faff' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div className="carocrm-wire-name" style={{ fontSize: 13 }}>
        {mapping.objectType} → {mapping.crmEntityType}
      </div>
      <div className="carocrm-wire-meta">
        {mapping.status} · v{String(mapping.mappingVersion)} · {mapping.direction}
      </div>
    </button>
  );
}

function MappingDetail({
  mapping,
  fields,
  loading,
  onPublish,
  publishing,
}: {
  readonly mapping: IntegrationMappingView;
  readonly fields: Awaited<ReturnType<typeof api.integrationMappingFields>> | undefined;
  readonly loading: boolean;
  readonly onPublish: () => void;
  readonly publishing: boolean;
}) {
  if (loading || fields === undefined) return <Skeleton active paragraph={{ rows: 5 }} />;

  return (
    <div>
      <WarningList warnings={fields.warnings} emptyText={t('advancedintegrations.mapping.noWarnings')} />

      <div className="carocrm-wiring" style={{ marginTop: 16 }}>
        <div className="carocrm-wiring-pane">
          <div className="carocrm-wiring-pane-title">
            <span className="carocrm-label">{t('advancedintegrations.mapping.providerField')}</span>
            <span className="carocrm-quiet">{fields.providerFields.length}</span>
          </div>
          {fields.providerFields.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('advancedintegrations.mapping.noProviderFields')} />
          ) : (
            <Table
              rowKey="name"
              size="small"
              pagination={false}
              showHeader={false}
              dataSource={fields.providerFields}
              columns={[
                {
                  title: t('advancedintegrations.mapping.providerField'),
                  dataIndex: 'label',
                  render: (label: string, field) => (
                    <Space direction="vertical" size={0}>
                      <span>{label}</span>
                      <span className="carocrm-wire-meta">
                        {field.name} · {field.type}
                        {field.required ? ` · ${t('advancedintegrations.mapping.required')}` : ''}
                      </span>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </div>

        <div className="carocrm-wire-link">
          <span>{t('advancedintegrations.mapping.direction')}</span>
          <strong>{mapping.direction}</strong>
          <span>{t('advancedintegrations.mapping.version')} {String(mapping.mappingVersion)}</span>
        </div>

        <div className="carocrm-wiring-pane">
          <div className="carocrm-wiring-pane-title">
            <span className="carocrm-label">{t('advancedintegrations.mapping.crmField')}</span>
            <span className="carocrm-quiet">{fields.crmFields.length}</span>
          </div>
          <Table
            rowKey="name"
            size="small"
            pagination={false}
            showHeader={false}
            dataSource={fields.crmFields}
            columns={[
              {
                title: t('advancedintegrations.mapping.crmField'),
                dataIndex: 'label',
                render: (label: string, field) => (
                  <Space direction="vertical" size={0}>
                    <span>
                      {label}{' '}
                      {field.sensitive ? (
                        <Tag color="volcano">{t('advancedintegrations.mapping.sensitive')}</Tag>
                      ) : null}
                    </span>
                    <span className="carocrm-wire-meta">
                      {field.name} · {field.type}
                      {field.required ? ` · ${t('advancedintegrations.mapping.required')}` : ''}
                    </span>
                  </Space>
                ),
              },
            ]}
          />
        </div>
      </div>

      <Space style={{ marginTop: 16 }} wrap>
        <Button
          type="primary"
          disabled={mapping.status === 'active'}
          loading={publishing}
          onClick={onPublish}
        >
          {t('advancedintegrations.mapping.publish')}
        </Button>
        <Typography.Text type="secondary" className="carocrm-quiet">
          {t('advancedintegrations.mapping.publishedAt')} {formatTimestamp(mapping.modifiedAt)}
        </Typography.Text>
      </Space>
    </div>
  );
}
