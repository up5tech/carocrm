import { useQuery } from '@tanstack/react-query';
import { Button, Empty, Input, Skeleton, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationCatalogProvider, IntegrationProviderTier } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { ConnectionWizard } from './ConnectionWizard.js';
import { type ConnectionTone,PanelEmpty, TonePill } from './shared.js';

/**
 * Phase 19-INT.14 — the connector catalog
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.1).
 *
 * The catalog is a **scannable list**, not a card grid. A CRM administrator with twenty
 * connectors does not browse; they scan for one. Each row leads with a status rail — the health of
 * that connector's wires — then the name, then the facts that decide whether it is worth
 * connecting: how many objects it carries, how it authenticates, and what it demands.
 *
 * A visible card never implies the connector is configured. The action says exactly what happens:
 * "Connect" opens the wizard.
 */

const TIER_TONES: Readonly<Record<IntegrationProviderTier, ConnectionTone>> = {
  core: 'ok',
  optional: 'idle',
  experimental: 'warn',
  deprecated: 'error',
};

export function IntegrationsCatalogTab() {
  const [search, setSearch] = useState('');
  const [wizardProvider, setWizardProvider] = useState<IntegrationCatalogProvider | null>(null);
  const catalog = useQuery({
    queryKey: ['advancedIntegrations', 'catalog'],
    queryFn: () => api.integrationCatalog(),
    staleTime: 30_000,
  });

  const providers = useMemo(() => {
    const list = catalog.data?.list ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return list;
    return list.filter(
      (provider) =>
        provider.displayName.toLowerCase().includes(needle) ||
        provider.providerKey.toLowerCase().includes(needle) ||
        provider.category.toLowerCase().includes(needle) ||
        provider.description.toLowerCase().includes(needle),
    );
  }, [catalog.data, search]);

  if (catalog.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (catalog.isError) {
    return (
      <PanelEmpty
        text={t('advancedintegrations.providers.loadFailed')}
        action={
          <Button onClick={() => void catalog.refetch()}>{t('core.common.reload')}</Button>
        }
      />
    );
  }

  const all = catalog.data?.list ?? [];
  if (all.length === 0) {
    return <PanelEmpty text={t('advancedintegrations.providers.empty')} />;
  }

  return (
    <div>
      <div className="carocrm-list-head">
        <div>
          <div className="carocrm-page-title">{t('advancedintegrations.providers.title')}</div>
          <p className="carocrm-page-sub">{t('advancedintegrations.providers.subtitle')}</p>
        </div>
        <Input.Search
          allowClear
          placeholder={t('advancedintegrations.providers.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      {providers.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('advancedintegrations.providers.noResults')} />
      ) : (
        <div className="carocrm-rail-list">
          {providers.map((provider) => (
            <CatalogRow
              key={provider.providerKey}
              provider={provider}
              onConnect={() => setWizardProvider(provider)}
            />
          ))}
        </div>
      )}

      {wizardProvider === null ? null : (
        <ConnectionWizard
          provider={wizardProvider}
          onClose={() => setWizardProvider(null)}
        />
      )}
    </div>
  );
}

function CatalogRow({
  provider,
  onConnect,
}: {
  readonly provider: IntegrationCatalogProvider;
  readonly onConnect: () => void;
}) {
  const tone: ConnectionTone = provider.executable
    ? provider.healthyCount > 0
      ? 'ok'
      : 'idle'
    : 'error';

  return (
    <div className="carocrm-rail-row carocrm-catalog-row">
      <span
        className={`carocrm-rail carocrm-rail--${tone}`}
        role="presentation"
        title={
          provider.executable
            ? t('advancedintegrations.providers.executableYes')
            : t('advancedintegrations.providers.executableNo')
        }
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="carocrm-wire-name">
          {provider.displayName}{' '}
          <TonePill tone={TIER_TONES[provider.tier]} label={provider.tier} />
        </div>
        <div className="carocrm-wire-meta">{provider.description}</div>
        <div className="carocrm-wire-meta">
          <Space size={[12, 4]} wrap>
            <span>
              {t('advancedintegrations.providers.objects')}: {String(provider.objects.length)}
            </span>
            <span>
              {t('advancedintegrations.providers.authentication')}: {provider.authentication}
            </span>
            <span>
              {t('advancedintegrations.providers.connections')}: {String(provider.connectionCount)}
              {provider.connectionCount > 0 ? ` (${String(provider.healthyCount)} ${t('advancedintegrations.providers.healthy')})` : ''}
            </span>
          </Space>
        </div>
        {provider.requiredScopes.length > 0 ? (
          <div className="carocrm-wire-meta">
            {t('advancedintegrations.providers.requiredScopes')}: {provider.requiredScopes.join(', ')}
          </div>
        ) : null}
      </div>
      <div className="carocrm-catalog-actions">
        {provider.docsUrl === null ? null : (
          <Typography.Link href={provider.docsUrl} target="_blank" rel="noreferrer">
            {t('advancedintegrations.providers.docs')}
          </Typography.Link>
        )}
        <Button
          type="primary"
          disabled={!provider.executable}
          onClick={onConnect}
        >
          {t('advancedintegrations.providers.connect')}
        </Button>
      </div>
    </div>
  );
}
